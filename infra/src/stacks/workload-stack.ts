// One workload account (dev, nonprod or prod): an EKS cluster with every pod on
// Fargate, deployed into by the managed Argo CD in the tooling account.
// In-cluster objects (LB controller chart, aws-observability ConfigMap, the app)
// are Argo CD Applications in the deploy repo, not IaC. See design.md.
//
// Groups synthesise to: eks.tf, fargate.tf, access.tf,
// load_balancer_controller.tf, logging.tf, tls.tf.
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
import { BaseStack, Group, iamPolicy } from "./base.ts";
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

    // --- eks.tf --------------------------------------------------------------
    const eks = new Group(this, "eks");
    const eksTrust = iamPolicy(eks, "eks_cluster_trust", [
      { effect: "Allow", actions: ["sts:AssumeRole", "sts:TagSession"], principals: [{ type: "Service", identifiers: ["eks.amazonaws.com"] }] },
    ]);
    const clusterRole = new IamRole(eks, "cluster", { name: `${clusterName}-cluster`, assumeRolePolicy: eksTrust.json });
    const clusterPolicy = new IamRolePolicyAttachment(eks, "cluster:policy", {
      role: clusterRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    });
    const cluster = new EksCluster(eks, "this", {
      name: clusterName,
      version: env.kubernetesVersion,
      roleArn: clusterRole.arn,
      // No VPC CNI or kube-proxy DaemonSets: there are no nodes for them to run on.
      bootstrapSelfManagedAddons: false,
      accessConfig: { authenticationMode: "API", bootstrapClusterCreatorAdminPermissions: false },
      upgradePolicy: { supportType: "STANDARD" },
      vpcConfig: { subnetIds: env.privateSubnetIds, endpointPrivateAccess: true, endpointPublicAccess: false },
      enabledClusterLogTypes: ["audit", "authenticator"],
      // The cluster role must have its policy before EKS uses it (and on destroy, after).
      dependsOn: [clusterPolicy],
    });
    // IRSA (Pod Identity's agent is a DaemonSet, so it can't run on Fargate).
    const oidc = new IamOpenidConnectProvider(eks, "cluster:oidc", {
      url: cluster.identity.get(0).oidc.get(0).issuer,
      clientIdList: ["sts.amazonaws.com"],
    });
    const issuerHost = new TerraformLocal(eks, "oidc_issuer_host", Fn.replace(cluster.identity.get(0).oidc.get(0).issuer, "https://", "")).asString;

    // --- logging.tf: Fargate's built-in log router → one log group -----------
    const logging = new Group(this, "logging");
    const logGroup = new CloudwatchLogGroup(logging, "containers", {
      name: names.logGroup(env.name),
      retentionInDays: env.logs.retentionDays,
      logGroupClass: env.logs.logClass,
    });
    const logWrite = iamPolicy(logging, "fargate_log_router", [
      {
        effect: "Allow",
        actions: ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"],
        resources: [logGroup.arn, `${logGroup.arn}:log-stream:*`],
      },
    ]);

    // --- fargate.tf: one IP per pod, no warm pool, no nodes ------------------
    const fargate = new Group(this, "fargate");
    const podTrust = iamPolicy(fargate, "fargate_pod_execution_trust", [
      {
        effect: "Allow",
        actions: ["sts:AssumeRole"],
        principals: [{ type: "Service", identifiers: ["eks-fargate-pods.amazonaws.com"] }],
        condition: [
          { test: "ArnLike", variable: "aws:SourceArn", values: [`arn:aws:eks:${env.region}:${env.accountId}:fargateprofile/${clusterName}/*`] },
        ],
      },
    ]);
    const podExecRole = new IamRole(fargate, "fargate_pod_execution", {
      name: `${clusterName}-fargate-pod-execution`,
      assumeRolePolicy: podTrust.json,
    });
    // Includes ECR pull; the tooling account's repository policy allows this account.
    new IamRolePolicyAttachment(fargate, "fargate_pod_execution:managed", {
      role: podExecRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonEKSFargatePodExecutionRolePolicy",
    });
    new IamRolePolicy(fargate, "fargate_log_router:policy", { name: "fargate-log-router", role: podExecRole.id, policy: logWrite.json });

    const profiles = [
      { id: "system", namespace: "kube-system" },
      { id: "app", namespace: env.appNamespace },
    ].map(
      (p) =>
        new EksFargateProfile(fargate, p.id, {
          clusterName: cluster.name,
          fargateProfileName: p.id,
          podExecutionRoleArn: podExecRole.arn,
          subnetIds: env.privateSubnetIds,
          selector: [{ namespace: p.namespace }],
        }),
    );
    new EksAddon(fargate, "coredns", {
      clusterName: cluster.name,
      addonName: "coredns",
      configurationValues: Fn.jsonencode({ computeType: "Fargate" }),
      resolveConflictsOnCreate: "OVERWRITE",
      resolveConflictsOnUpdate: "OVERWRITE",
      dependsOn: profiles,
    });

    // --- access.tf: Argo CD writes, humans read, break-glass is alarmed -------
    const access = new Group(this, "access");
    const principals: Record<string, { principal_arn: string; policy_arn: string }> = {
      argocd: { principal_arn: argocdCapabilityRoleArn(tooling), policy_arn: ACCESS_POLICY.admin },
      break_glass: { principal_arn: env.access.breakGlassRoleArn, policy_arn: ACCESS_POLICY.admin },
      ...Object.fromEntries(env.access.readOnlyRoleArns.map((arn, i) => [`read_only_${i}`, { principal_arn: arn, policy_arn: ACCESS_POLICY.view }])),
    };
    const principalsLocal = new TerraformLocal(access, "access_principals", principals);
    const p = TerraformIterator.fromMap(principalsLocal.asAnyMap);
    const entries = new EksAccessEntry(access, "principals", {
      forEach: p,
      clusterName: cluster.name,
      principalArn: p.getString("principal_arn"),
      type: "STANDARD",
    });
    const e = TerraformIterator.fromMap(principalsLocal.asAnyMap);
    new EksAccessPolicyAssociation(access, "principals:association", {
      forEach: e,
      clusterName: cluster.name,
      principalArn: e.getString("principal_arn"),
      policyArn: e.getString("policy_arn"),
      accessScope: { type: "cluster" },
      dependsOn: [entries],
    });

    // --- load_balancer_controller.tf ------------------------------------------
    const lbc = new Group(this, "load_balancer_controller");
    const lbcTrust = iamPolicy(lbc, "load_balancer_controller_trust", [
      {
        effect: "Allow",
        actions: ["sts:AssumeRoleWithWebIdentity"],
        principals: [{ type: "Federated", identifiers: [oidc.arn] }],
        condition: [
          { test: "StringEquals", variable: `${issuerHost}:sub`, values: ["system:serviceaccount:kube-system:aws-load-balancer-controller"] },
          { test: "StringEquals", variable: `${issuerHost}:aud`, values: ["sts.amazonaws.com"] },
        ],
      },
    ]);
    const lbcRole = new IamRole(lbc, "load_balancer_controller", {
      name: `${clusterName}-aws-load-balancer-controller`,
      assumeRolePolicy: lbcTrust.json,
    });
    // Pinned upstream policy for the chart version we deploy (v2.17.1).
    const lbcIamPolicy = new IamPolicy(lbc, "load_balancer_controller:policy", {
      name: `${clusterName}-aws-load-balancer-controller`,
      policy: this.policyFile("aws-load-balancer-controller", lbcPolicy),
    });
    new IamRolePolicyAttachment(lbc, "load_balancer_controller:attachment", { role: lbcRole.name, policyArn: lbcIamPolicy.arn });

    // --- tls.tf --------------------------------------------------------------
    const tls = new Group(this, "tls");
    const cert = new AcmCertificate(tls, "this", {
      domainName: env.tls.domainName,
      validationMethod: "DNS",
      lifecycle: { createBeforeDestroy: true },
    });
    if (env.tls.hostedZoneId) {
      const dvo = TerraformIterator.fromComplexList(cert.domainValidationOptions, "domain_name");
      const record = new Route53Record(tls, "certificate_validation", {
        forEach: dvo,
        zoneId: env.tls.hostedZoneId,
        name: dvo.getString("resource_record_name"),
        type: dvo.getString("resource_record_type"),
        records: [dvo.getString("resource_record_value")],
        ttl: 60,
        allowOverwrite: true,
      });
      new AcmCertificateValidation(tls, "this:validation", {
        certificateArn: cert.arn,
        validationRecordFqdns: TerraformIterator.fromResources(record).pluckProperty("fqdn") as unknown as string[],
      });
    }
  }
}
