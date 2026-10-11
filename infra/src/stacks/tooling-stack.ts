// Tooling account: ECR release cache + customer distribution, GHES OIDC trust,
// and the delivery hub (a zero-pod EKS cluster that hosts the managed Argo CD
// capability). See docs/proposal/design.md §4 and ADR-0004.
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
import { CodeconnectionsHost } from "@cdktn/provider-aws/lib/codeconnections-host/index.js";
import { CodeconnectionsConnection } from "@cdktn/provider-aws/lib/codeconnections-connection/index.js";
import { SecurityGroup } from "@cdktn/provider-aws/lib/security-group/index.js";
import { VpcSecurityGroupEgressRule } from "@cdktn/provider-aws/lib/vpc-security-group-egress-rule/index.js";
import { BaseStack, iamDoc } from "./base.ts";
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

    // --- ECR: internal/* (our envs) and release/* (GA, customers) --------------
    // Artifactory stays the system of record; GHES copies releases here by digest.
    const repoNames = [...t.services, `charts/${t.chartName}`];
    const tiers = {
      internal: workloads.map((w) => `arn:aws:iam::${w.accountId}:root`),
      release: t.customerAccountIds.map((a) => `arn:aws:iam::${a}:root`),
    };
    const repos: Record<keyof typeof tiers, EcrRepository[]> = { internal: [], release: [] };

    for (const tier of Object.keys(tiers) as (keyof typeof tiers)[]) {
      for (const name of repoNames) {
        const cid = `${tier}-${name.replace(/\//g, "-")}`;
        const repo = new EcrRepository(this, cid, {
          name: `${tier}/${name}`,
          imageTagMutability: "IMMUTABLE",
          encryptionConfiguration: [{ encryptionType: "AES256" }],
          // Vulnerability scanning is JFrog Xray's job before promotion.
          imageScanningConfiguration: { scanOnPush: false },
        });
        repos[tier].push(repo);

        new EcrLifecyclePolicy(this, `${cid}-lifecycle`, {
          repository: repo.name,
          policy: JSON.stringify({
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
        new EcrRepositoryPolicy(this, `${cid}-policy`, {
          repository: repo.name,
          policy: iamDoc({ Sid: "CrossAccountPull", Effect: "Allow", Principal: { AWS: tiers[tier] }, Action: PULL_ACTIONS }),
        });
      }
    }

    // --- GHES OIDC: promote workflow pushes by digest ------------------------
    const ghesHost = new URL(t.ghes.url).host;
    const issuer = `${ghesHost}/_services/token`;
    const oidc = new IamOpenidConnectProvider(this, "ghes-oidc", {
      url: `${t.ghes.url}/_services/token`,
      clientIdList: ["sts.amazonaws.com"],
    });

    const ghesRole = (name: string, environments: string[], repoArns: string[]) => {
      const role = new IamRole(this, name, {
        name,
        maxSessionDuration: 3600,
        assumeRolePolicy: iamDoc({
          Effect: "Allow",
          Principal: { Federated: oidc.arn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              [`${issuer}:aud`]: "sts.amazonaws.com",
              [`${issuer}:sub`]: environments.map((e) => `repo:${t.ghes.appRepository}:environment:${e}`),
            },
          },
        }),
      });
      new IamRolePolicy(this, `${name}-ecr`, {
        name: "ecr-push",
        role: role.id,
        policy: iamDoc(
          { Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*" },
          { Effect: "Allow", Action: PUSH_ACTIONS, Resource: repoArns },
        ),
      });
      return role;
    };
    ghesRole("ghes-promote-internal", workloads.map((w) => w.name), repos.internal.map((r) => r.arn));
    ghesRole("ghes-publish-ga", ["ga"], repos.release.map((r) => r.arn));

    // --- CodeConnections: managed Argo CD reaches the private GHES -----------
    const hostSg = new SecurityGroup(this, "codeconnections-sg", {
      name: "codeconnections-ghes",
      description: "CodeConnections host ENIs: HTTPS to GHES only",
      vpcId: t.vpcId,
      revokeRulesOnDelete: true,
    });
    new VpcSecurityGroupEgressRule(this, "codeconnections-to-ghes", {
      securityGroupId: hostSg.id,
      ipProtocol: "tcp",
      fromPort: 443,
      toPort: 443,
      cidrIpv4: t.ghes.cidr,
      description: "GHES HTTPS",
    });
    const host = new CodeconnectionsHost(this, "ghes-host", {
      name: "ghes",
      providerType: "GitHubEnterpriseServer",
      providerEndpoint: t.ghes.url,
      vpcConfiguration: [
        {
          vpcId: t.vpcId,
          subnetIds: t.privateSubnetIds,
          securityGroupIds: [hostSg.id],
          tlsCertificate: t.ghes.tlsCertificate,
        },
      ],
    });
    // Created PENDING; a GHES admin completes the handshake once in the console.
    const connection = new CodeconnectionsConnection(this, "ghes-connection", {
      name: "ghes-deploy-repo",
      hostArn: host.arn,
    });

    // --- Delivery hub: EKS control plane only, no pods -----------------------
    const clusterRole = new IamRole(this, "hub-cluster-role", {
      name: `${names.hubCluster}-cluster`,
      assumeRolePolicy: iamDoc({
        Effect: "Allow",
        Principal: { Service: "eks.amazonaws.com" },
        Action: ["sts:AssumeRole", "sts:TagSession"],
      }),
    });
    new IamRolePolicyAttachment(this, "hub-cluster-policy", {
      role: clusterRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    });
    const hub = new EksCluster(this, "hub", {
      name: names.hubCluster,
      version: t.kubernetesVersion,
      roleArn: clusterRole.arn,
      bootstrapSelfManagedAddons: false,
      accessConfig: { authenticationMode: "API", bootstrapClusterCreatorAdminPermissions: false },
      upgradePolicy: { supportType: "STANDARD" },
      vpcConfig: { subnetIds: t.privateSubnetIds, endpointPrivateAccess: true, endpointPublicAccess: false },
      enabledClusterLogTypes: ["audit", "authenticator"],
      dependsOn: [clusterRole],
    });

    // --- Managed Argo CD capability -----------------------------------------
    const capabilityRole = new IamRole(this, "argocd-capability-role", {
      name: names.argocdCapabilityRole,
      assumeRolePolicy: iamDoc({
        Effect: "Allow",
        // (verify) service principal for EKS Capabilities
        Principal: { Service: "capabilities.eks.amazonaws.com" },
        Action: ["sts:AssumeRole", "sts:TagSession"],
      }),
    });
    new IamRolePolicy(this, "argocd-sources", {
      name: "argocd-sources",
      role: capabilityRole.id,
      policy: iamDoc(
        {
          Sid: "DeployRepo",
          Effect: "Allow",
          Action: ["codeconnections:UseConnection", "codeconnections:GetConnection"],
          Resource: connection.arn,
        },
        { Sid: "EcrAuth", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
        { Sid: "InternalCharts", Effect: "Allow", Action: PULL_ACTIONS, Resource: repos.internal.map((r) => r.arn) },
      ),
    });

    new EksCapability(this, "argocd", {
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
