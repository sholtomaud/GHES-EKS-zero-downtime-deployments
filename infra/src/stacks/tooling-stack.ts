// Tooling account: ECR release cache + customer distribution, GHES OIDC trust,
// and the delivery hub (a zero-pod EKS cluster that hosts the managed Argo CD
// capability). See docs/proposal/design.md and ADR-0004.
//
// Each Group below synthesises to its own file: ecr.tf, ghes_oidc.tf,
// codeconnections.tf, delivery_hub.tf, argocd.tf.
import { Fn, TerraformIterator } from "cdktn";
import type { Construct } from "constructs";
import { EcrRepository } from "@cdktn/provider-aws/lib/ecr-repository/index.js";
import { EcrLifecyclePolicy } from "@cdktn/provider-aws/lib/ecr-lifecycle-policy/index.js";
import { EcrRepositoryPolicy } from "@cdktn/provider-aws/lib/ecr-repository-policy/index.js";
import { IamOpenidConnectProvider } from "@cdktn/provider-aws/lib/iam-openid-connect-provider/index.js";
import { IamRole } from "@cdktn/provider-aws/lib/iam-role/index.js";
import { IamRolePolicy } from "@cdktn/provider-aws/lib/iam-role-policy/index.js";
import { IamRolePolicyAttachment } from "@cdktn/provider-aws/lib/iam-role-policy-attachment/index.js";
import { EksCluster } from "@cdktn/provider-aws/lib/eks-cluster/index.js";
import { EksCapability } from "@cdktn/provider-aws/lib/eks-capability/index.js";
import { EksAccessEntry } from "@cdktn/provider-aws/lib/eks-access-entry/index.js";
import { EksAccessPolicyAssociation } from "@cdktn/provider-aws/lib/eks-access-policy-association/index.js";
import { CodeconnectionsHost } from "@cdktn/provider-aws/lib/codeconnections-host/index.js";
import { CodeconnectionsConnection } from "@cdktn/provider-aws/lib/codeconnections-connection/index.js";
import { SecurityGroup } from "@cdktn/provider-aws/lib/security-group/index.js";
import { VpcSecurityGroupEgressRule } from "@cdktn/provider-aws/lib/vpc-security-group-egress-rule/index.js";
import { BaseStack, Group, iamPolicy } from "./base.ts";
import { names, type ToolingConfig, type WorkloadConfig } from "../config.ts";

export interface ToolingStackProps {
  tooling: ToolingConfig;
  workloads: WorkloadConfig[];
}

const PULL_ACTIONS = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"];
const PUSH_ACTIONS = [...PULL_ACTIONS, "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"];

export class ToolingStack extends BaseStack {
  constructor(scope: Construct, id: string, { tooling: t, workloads }: ToolingStackProps) {
    super(scope, id, { accountId: t.accountId, region: t.region, state: t.state, tags: {} });
    const repoArn = (prefix: string) => `arn:aws:ecr:${t.region}:${t.accountId}:repository/${prefix}/*`;

    // --- ecr.tf: internal/* (our envs) and release/* (GA, customers) -------
    // Artifactory stays the system of record; GHES copies releases here by digest.
    const ecr = new Group(this, "ecr");
    const repoNames = [...t.services, `charts/${t.chartName}`];
    const tiers = {
      internal: workloads.map((w) => `arn:aws:iam::${w.accountId}:root`),
      release: t.customerAccountIds.map((a) => `arn:aws:iam::${a}:root`),
    };
    for (const tier of Object.keys(tiers) as (keyof typeof tiers)[]) {
      const each = TerraformIterator.fromList(repoNames);
      const repos = new EcrRepository(ecr, tier, {
        forEach: each,
        name: `${tier}/${each.value}`,
        imageTagMutability: "IMMUTABLE",
        encryptionConfiguration: [{ encryptionType: "AES256" }],
        // Vulnerability scanning is JFrog Xray's job, before promotion.
        imageScanningConfiguration: { scanOnPush: false },
      });

      const repo = TerraformIterator.fromResources(repos);
      new EcrLifecyclePolicy(ecr, `${tier}:lifecycle`, {
        forEach: repo,
        repository: repo.getString("name"),
        policy: Fn.jsonencode({
          rules: [
            {
              rulePriority: 1,
              description: `Keep the last ${t.imagesRetained} images so rollback never needs Artifactory`,
              selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: t.imagesRetained },
              action: { type: "expire" },
            },
          ],
        }),
      });

      // An empty principal list is invalid IAM: no customers yet means no pull policy.
      if (tiers[tier].length === 0) continue;
      const pull = iamPolicy(ecr, `${tier}_pull`, [
        { sid: "CrossAccountPull", effect: "Allow", actions: PULL_ACTIONS, principals: [{ type: "AWS", identifiers: tiers[tier] }] },
      ]);
      const policyRepo = TerraformIterator.fromResources(repos);
      new EcrRepositoryPolicy(ecr, `${tier}:policy`, {
        forEach: policyRepo,
        repository: policyRepo.getString("name"),
        policy: pull.json,
      });
    }

    // --- ghes_oidc.tf: the promote workflow pushes by digest -----------------
    const ghes = new Group(this, "ghes_oidc");
    const issuer = `${new URL(t.ghes.url).host}/_services/token`;
    const oidc = new IamOpenidConnectProvider(ghes, "ghes", {
      url: `${t.ghes.url}/_services/token`,
      clientIdList: ["sts.amazonaws.com"],
    });
    const ghesRole = (name: string, environments: string[], repoPrefix: string) => {
      const trust = iamPolicy(ghes, `${name}_trust`, [
        {
          effect: "Allow",
          actions: ["sts:AssumeRoleWithWebIdentity"],
          principals: [{ type: "Federated", identifiers: [oidc.arn] }],
          condition: [
            { test: "StringEquals", variable: `${issuer}:aud`, values: ["sts.amazonaws.com"] },
            { test: "StringEquals", variable: `${issuer}:sub`, values: environments.map((e) => `repo:${t.ghes.appRepository}:environment:${e}`) },
          ],
        },
      ]);
      const push = iamPolicy(ghes, `${name}_ecr_push`, [
        { effect: "Allow", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] },
        { effect: "Allow", actions: PUSH_ACTIONS, resources: [repoArn(repoPrefix)] },
      ]);
      const role = new IamRole(ghes, name, { name: name.replace(/_/g, "-"), maxSessionDuration: 3600, assumeRolePolicy: trust.json });
      new IamRolePolicy(ghes, `${name}:ecr_push`, { name: "ecr-push", role: role.id, policy: push.json });
    };
    ghesRole("ghes_promote_internal", workloads.map((w) => w.name), "internal");
    ghesRole("ghes_publish_ga", ["ga"], "release");

    // --- codeconnections.tf: managed Argo CD reaches the private GHES --------
    const cc = new Group(this, "codeconnections");
    const sg = new SecurityGroup(cc, "codeconnections", {
      name: "codeconnections-ghes",
      description: "CodeConnections host ENIs: HTTPS to GHES only",
      vpcId: t.vpcId,
      revokeRulesOnDelete: true,
    });
    new VpcSecurityGroupEgressRule(cc, "ghes_https", {
      securityGroupId: sg.id,
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      cidrIpv4: t.ghes.cidr,
      description: "GHES HTTPS",
    });
    const host = new CodeconnectionsHost(cc, "ghes", {
      name: "ghes",
      providerType: "GitHubEnterpriseServer",
      providerEndpoint: t.ghes.url,
      vpcConfiguration: [
        { vpcId: t.vpcId, subnetIds: t.privateSubnetIds, securityGroupIds: [sg.id], tlsCertificate: t.ghes.tlsCertificate },
      ],
    });
    // Created PENDING; a GHES admin completes the handshake once in the console.
    const connection = new CodeconnectionsConnection(cc, "deploy_repo", { name: "ghes-deploy-repo", hostArn: host.arn });

    // --- delivery_hub.tf: EKS control plane only, no pods -------------------
    const hubGroup = new Group(this, "delivery_hub");
    const eksTrust = iamPolicy(hubGroup, "eks_cluster_trust", [
      { effect: "Allow", actions: ["sts:AssumeRole", "sts:TagSession"], principals: [{ type: "Service", identifiers: ["eks.amazonaws.com"] }] },
    ]);
    const clusterRole = new IamRole(hubGroup, "delivery_hub_cluster", {
      name: `${names.hubCluster}-cluster`,
      assumeRolePolicy: eksTrust.json,
    });
    const clusterPolicy = new IamRolePolicyAttachment(hubGroup, "delivery_hub_cluster:policy", {
      role: clusterRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    });
    const hub = new EksCluster(hubGroup, "delivery_hub", {
      name: names.hubCluster,
      version: t.kubernetesVersion,
      roleArn: clusterRole.arn,
      bootstrapSelfManagedAddons: false,
      accessConfig: { authenticationMode: "API", bootstrapClusterCreatorAdminPermissions: false },
      upgradePolicy: { supportType: "STANDARD" },
      vpcConfig: { subnetIds: t.privateSubnetIds, endpointPrivateAccess: true, endpointPublicAccess: false },
      enabledClusterLogTypes: ["audit", "authenticator"],
      // The cluster role must have its policy before EKS uses it (and on destroy, after).
      dependsOn: [clusterPolicy],
    });

    // --- argocd.tf: managed Argo CD capability -------------------------------
    const argo = new Group(this, "argocd");
    const capabilityTrust = iamPolicy(argo, "argocd_capability_trust", [
      {
        effect: "Allow",
        actions: ["sts:AssumeRole", "sts:TagSession"],
        // (verify) service principal for EKS Capabilities
        principals: [{ type: "Service", identifiers: ["capabilities.eks.amazonaws.com"] }],
      },
    ]);
    const sources = iamPolicy(argo, "argocd_sources", [
      { sid: "DeployRepo", effect: "Allow", actions: ["codeconnections:UseConnection", "codeconnections:GetConnection"], resources: [connection.arn] },
      { sid: "EcrAuth", effect: "Allow", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] },
      { sid: "InternalCharts", effect: "Allow", actions: PULL_ACTIONS, resources: [repoArn("internal")] },
    ]);
    const capabilityRole = new IamRole(argo, "argocd_capability", {
      name: names.argocdCapabilityRole,
      assumeRolePolicy: capabilityTrust.json,
    });
    new IamRolePolicy(argo, "argocd_sources:policy", { name: "argocd-sources", role: capabilityRole.id, policy: sources.json });

    // Applications and cluster Secrets live on the hub; the capability does not
    // register its own cluster, so grant it explicitly. (verify) narrower scope.
    const hubEntry = new EksAccessEntry(argo, "argocd_hub", {
      clusterName: hub.name,
      principalArn: capabilityRole.arn,
      type: "STANDARD",
    });
    new EksAccessPolicyAssociation(argo, "argocd_hub:association", {
      clusterName: hub.name,
      principalArn: capabilityRole.arn,
      policyArn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
      accessScope: { type: "cluster" },
      dependsOn: [hubEntry],
    });

    new EksCapability(argo, "argocd", {
      capabilityName: names.argocdCapability,
      clusterName: hub.name,
      type: "ARGOCD",
      roleArn: capabilityRole.arn,
      // Deleting the capability must never delete what it deployed.
      deletePropagationPolicy: "RETAIN",
      configuration: [
        {
          argoCd: [
            {
              namespace: names.argocdNamespace,
              awsIdc: [{ idcInstanceArn: t.identityCenter.instanceArn, idcRegion: t.identityCenter.region }],
              rbacRoleMapping: [
                { role: "ADMIN", identity: [{ id: t.identityCenter.argocdAdminGroupId, type: "SSO_GROUP" }] },
                { role: "VIEWER", identity: [{ id: t.identityCenter.argocdViewerGroupId, type: "SSO_GROUP" }] },
              ],
            },
          ],
        },
      ],
    });
  }
}
