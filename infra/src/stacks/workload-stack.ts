// One workload account (dev, nonprod or prod): an EKS cluster with every pod on
// Fargate, deployed into by the managed Argo CD in the tooling account.
// In-cluster objects (LB controller chart, aws-observability ConfigMap, the app)
// are Argo CD Applications in the deploy repo, not IaC. See design.md §4.
import { Fn, TerraformIterator, TerraformLocal } from "cdktn";
import type { Construct } from "constructs";
import { EksCluster } from "@cdktn/provider-aws/lib/eks-cluster/index.js";
import { EksFargateProfile } from "@cdktn/provider-aws/lib/eks-fargate-profile/index.js";
import { EksAddon } from "@cdktn/provider-aws/lib/eks-addon/index.js";
import { EksAccessEntry } from "@cdktn/provider-aws/lib/eks-access-entry/index.js";
import { EksAccessPolicyAssociation } from "@cdktn/provider-aws/lib/eks-access-policy-association/index.js";
import { IamRole } from "@cdktn/provider-aws/lib/iam-role/index.js";
import { IamRolePolicy } from "@cdktn/provider-aws/lib/iam-role-policy/index.js";
import { IamRolePolicyAttachment } from "@cdktn/provider-aws/lib/iam-role-policy-attachment/index.js";
import { IamPolicy } from "@cdktn/provider-aws/lib/iam-policy/index.js";
import { IamOpenidConnectProvider } from "@cdktn/provider-aws/lib/iam-openid-connect-provider/index.js";
import { CloudwatchLogGroup } from "@cdktn/provider-aws/lib/cloudwatch-log-group/index.js";
import { AcmCertificate } from "@cdktn/provider-aws/lib/acm-certificate/index.js";
import { AcmCertificateValidation } from "@cdktn/provider-aws/lib/acm-certificate-validation/index.js";
import { Route53Record } from "@cdktn/provider-aws/lib/route53-record/index.js";
import { BaseStack, iamDoc } from "./base.ts";
import { argocdCapabilityRoleArn, names, type ToolingConfig, type WorkloadConfig } from "../config.ts";
import lbcPolicy from "../policies/aws-load-balancer-controller-v2.17.1.json" with { type: "json" };

export interface WorkloadStackProps {
  env: WorkloadConfig;
  tooling: Pick<ToolingConfig, "accountId">;
}

const ACCESS_POLICY = {
  admin: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
  view: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy",
};

export class WorkloadStack extends BaseStack {
  constructor(scope: Construct, id: string, { env, tooling }: WorkloadStackProps) {
    super(scope, id, { accountId: env.accountId, region: env.region, state: env.state, tags: { environment: env.name } });
    const clusterName = names.workloadCluster(env.name);

    // --- Cluster -------------------------------------------------------------
    const clusterRole = new IamRole(this, "cluster-role", {
      name: `${clusterName}-cluster`,
      assumeRolePolicy: iamDoc({
        Effect: "Allow",
        Principal: { Service: "eks.amazonaws.com" },
        Action: ["sts:AssumeRole", "sts:TagSession"],
      }),
    });
    new IamRolePolicyAttachment(this, "cluster-policy", {
      role: clusterRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    });
    const cluster = new EksCluster(this, "cluster", {
      name: clusterName,
      version: env.kubernetesVersion,
      roleArn: clusterRole.arn,
      // No VPC CNI or kube-proxy DaemonSets: nothing runs on nodes because there are none.
      bootstrapSelfManagedAddons: false,
      accessConfig: { authenticationMode: "API", bootstrapClusterCreatorAdminPermissions: false },
      upgradePolicy: { supportType: "STANDARD" },
      vpcConfig: { subnetIds: env.privateSubnetIds, endpointPrivateAccess: true, endpointPublicAccess: false },
      enabledClusterLogTypes: ["audit", "authenticator"],
      dependsOn: [clusterRole],
    });

    // --- Fargate: one IP per pod, no warm pool, no nodes ---------------------
    const logGroup = new CloudwatchLogGroup(this, "container-logs", {
      name: names.logGroup(env.name),
      retentionInDays: env.logs.retentionDays,
      logGroupClass: env.logs.logClass,
    });

    const podExecRole = new IamRole(this, "pod-execution-role", {
      name: `${clusterName}-fargate-pod-execution`,
      assumeRolePolicy: iamDoc({
        Effect: "Allow",
        Principal: { Service: "eks-fargate-pods.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: {
          ArnLike: { "aws:SourceArn": `arn:aws:eks:${env.region}:${env.accountId}:fargateprofile/${clusterName}/*` },
        },
      }),
    });
    // Includes ECR pull; the tooling account's repository policy allows this account.
    new IamRolePolicyAttachment(this, "pod-execution-policy", {
      role: podExecRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonEKSFargatePodExecutionRolePolicy",
    });
    // Fargate's built-in Fluent Bit log router writes as this role [OBS-04: 0 pods].
    new IamRolePolicy(this, "fargate-log-router", {
      name: "fargate-log-router",
      role: podExecRole.id,
      policy: iamDoc({
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"],
        Resource: [logGroup.arn, `${logGroup.arn}:log-stream:*`],
      }),
    });

    const profiles = [
      { id: "system", namespace: "kube-system" },
      { id: "app", namespace: env.appNamespace },
    ].map(
      (p) =>
        new EksFargateProfile(this, `fargate-${p.id}`, {
          clusterName: cluster.name,
          fargateProfileName: p.id,
          podExecutionRoleArn: podExecRole.arn,
          subnetIds: env.privateSubnetIds,
          selector: [{ namespace: p.namespace }],
        }),
    );

    new EksAddon(this, "coredns", {
      clusterName: cluster.name,
      addonName: "coredns",
      configurationValues: JSON.stringify({ computeType: "Fargate" }),
      resolveConflictsOnCreate: "OVERWRITE",
      resolveConflictsOnUpdate: "OVERWRITE",
      dependsOn: profiles,
    });

    // --- Access: Argo CD writes, humans read, break-glass is alarmed ---------
    const grant = (cid: string, principalArn: string, policyArn: string) => {
      const entry = new EksAccessEntry(this, `${cid}-entry`, { clusterName: cluster.name, principalArn, type: "STANDARD" });
      new EksAccessPolicyAssociation(this, `${cid}-policy`, {
        clusterName: cluster.name,
        principalArn,
        policyArn,
        accessScope: { type: "cluster" },
        dependsOn: [entry],
      });
    };
    grant("argocd", argocdCapabilityRoleArn(tooling), ACCESS_POLICY.admin);
    grant("break-glass", env.access.breakGlassRoleArn, ACCESS_POLICY.admin);
    env.access.readOnlyRoleArns.forEach((arn, i) => grant(`read-only-${i}`, arn, ACCESS_POLICY.view));

    // --- AWS Load Balancer Controller identity (IRSA; Pod Identity's agent is a DaemonSet) ---
    const issuer = cluster.identity.get(0).oidc.get(0).issuer;
    // A local keeps quotes out of the IAM JSON string.
    const issuerHost = new TerraformLocal(this, "oidc_issuer_host", Fn.replace(issuer, "https://", "")).asString;
    const oidc = new IamOpenidConnectProvider(this, "cluster-oidc", {
      url: issuer,
      clientIdList: ["sts.amazonaws.com"],
    });
    const lbcRole = new IamRole(this, "lbc-role", {
      name: `${clusterName}-aws-load-balancer-controller`,
      assumeRolePolicy: iamDoc({
        Effect: "Allow",
        Principal: { Federated: oidc.arn },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            [`${issuerHost}:sub`]: "system:serviceaccount:kube-system:aws-load-balancer-controller",
            [`${issuerHost}:aud`]: "sts.amazonaws.com",
          },
        },
      }),
    });
    const lbcIamPolicy = new IamPolicy(this, "lbc-policy", {
      name: `${clusterName}-aws-load-balancer-controller`,
      policy: JSON.stringify(lbcPolicy),
    });
    new IamRolePolicyAttachment(this, "lbc-policy-attachment", { role: lbcRole.name, policyArn: lbcIamPolicy.arn });

    // --- TLS -----------------------------------------------------------------
    const cert = new AcmCertificate(this, "certificate", {
      domainName: env.tls.domainName,
      validationMethod: "DNS",
      lifecycle: { createBeforeDestroy: true },
    });
    if (env.tls.hostedZoneId) {
      const dvo = TerraformIterator.fromComplexList(cert.domainValidationOptions, "domain_name");
      const record = new Route53Record(this, "certificate-validation-record", {
        forEach: dvo,
        zoneId: env.tls.hostedZoneId,
        name: dvo.getString("resource_record_name"),
        type: dvo.getString("resource_record_type"),
        records: [dvo.getString("resource_record_value")],
        ttl: 60,
        allowOverwrite: true,
      });
      new AcmCertificateValidation(this, "certificate-validation", {
        certificateArn: cert.arn,
        validationRecordFqdns: TerraformIterator.fromResources(record).pluckProperty("fqdn") as unknown as string[],
      });
    }
  }
}
