// Typed configuration for every stack. Values marked PLACEHOLDER must be
// replaced with real IDs before `tofu plan`; nothing here is a secret.

export type EnvironmentName = "dev" | "nonprod" | "prod";
export type InstallProfile = "minimal" | "standard" | "ha";
export type LogClass = "STANDARD" | "INFREQUENT_ACCESS";

/**
 * Remote state in Artifactory's Terraform Backend repository (`remote` backend
 * protocol, with locking and state history). One workspace per stack. The token
 * is never in config: `tofu login <hostname>` locally, TF_TOKEN_<host> in CI.
 */
export interface StateConfig {
  /** JFrog Platform domain, e.g. artifactory.example.internal */
  hostname: string;
  /** Key of the Terraform Backend repository in Artifactory. */
  repository: string;
}

/**
 * The ECR that already exists (owned outside this repo). We only grant access
 * to it. Its owner keeps tags immutable, lifecycle rules and the cross-account
 * pull policy for the workload and customer accounts (design.md §8).
 */
export interface EcrConfig {
  accountId: string;
  region: string;
  /** Prefix for releases our environments run, e.g. internal/<service>. */
  internalPrefix: string;
  /** Prefix for GA releases customers pull, e.g. release/<service>. */
  releasePrefix: string;
}

export interface ToolingConfig {
  accountId: string;
  region: string;
  state: StateConfig;
  /** Existing tooling VPC where GHES and Artifactory already run on EC2. */
  vpcId: string;
  privateSubnetIds: string[];
  kubernetesVersion: string;
  ghes: {
    /** e.g. https://ghes.example.internal */
    url: string;
    /** owner/repo of the application repo whose promote workflow pushes to ECR. */
    appRepository: string;
  };
  identityCenter: {
    instanceArn: string;
    region: string;
    argocdAdminGroupId: string;
    argocdViewerGroupId: string;
  };
  ecr: EcrConfig;
}

export interface WorkloadConfig {
  name: EnvironmentName;
  accountId: string;
  region: string;
  state: StateConfig;
  profile: InstallProfile;
  /** Existing VPC: we don't own VPCs and have no secondary CIDR (Q3). */
  vpcId: string;
  privateSubnetIds: string[];
  kubernetesVersion: string;
  /** Namespace the application chart installs into. */
  appNamespace: string;
  logs: {
    retentionDays: number;
    logClass: LogClass;
  };
  tls: {
    domainName: string;
    /** Route 53 zone for DNS validation; omit to validate out of band. */
    hostedZoneId?: string;
  };
  access: {
    /** SSO permission-set roles that get read-only cluster access [SEC-01]. */
    readOnlyRoleArns: string[];
    /** Time-bound, alarmed break-glass role [SEC-01]. */
    breakGlassRoleArn: string;
  };
}

/** Names are deterministic so stacks in different accounts can refer to each other without shared state. */
export const names = {
  hubCluster: "delivery-hub",
  argocdCapability: "argocd",
  argocdCapabilityRole: "eks-capability-argocd",
  argocdNamespace: "argocd",
  workloadCluster: (env: EnvironmentName) => `app-${env}`,
  logGroup: (env: EnvironmentName) => `/aws/eks/app-${env}/containers`,
};

export function argocdCapabilityRoleArn(tooling: Pick<ToolingConfig, "accountId">): string {
  return `arn:aws:iam::${tooling.accountId}:role/${names.argocdCapabilityRole}`;
}

// --- Environment values (PLACEHOLDER IDs) ------------------------------------

const region = "ap-southeast-2";
// (verify) pick a version in EKS standard support at build time [OPS-02].
const kubernetesVersion = "1.35";
const state: StateConfig = { hostname: "artifactory.example.internal", repository: "tofu-state" };

export const tooling: ToolingConfig = {
  accountId: "111111111111",
  region,
  state,
  vpcId: "vpc-0tooling00000000",
  privateSubnetIds: ["subnet-0toolinga0000000", "subnet-0toolingb0000000"],
  kubernetesVersion,
  ghes: {
    url: "https://ghes.example.internal",
    appRepository: "platform/app",
  },
  identityCenter: {
    instanceArn: "arn:aws:sso:::instance/ssoins-0000000000000000",
    region,
    argocdAdminGroupId: "00000000-0000-0000-0000-000000000001",
    argocdViewerGroupId: "00000000-0000-0000-0000-000000000002",
  },
  ecr: { accountId: "111111111111", region, internalPrefix: "internal", releasePrefix: "release" },
};

function workload(
  name: EnvironmentName,
  accountId: string,
  profile: InstallProfile,
  logs: WorkloadConfig["logs"],
): WorkloadConfig {
  return {
    name,
    accountId,
    region,
    state,
    profile,
    vpcId: `vpc-0${name}0000000000`,
    privateSubnetIds: [`subnet-0${name}a000000`, `subnet-0${name}b000000`],
    kubernetesVersion,
    appNamespace: "app",
    logs,
    tls: { domainName: `${name}.app.example.com` },
    access: {
      readOnlyRoleArns: [`arn:aws:iam::${accountId}:role/AWSReservedSSO_ReadOnly_0000000000000000`],
      breakGlassRoleArn: `arn:aws:iam::${accountId}:role/break-glass`,
    },
  };
}

// Dev and nonprod use STANDARD logs so engineers get Live Tail while debugging;
// prod uses INFREQUENT_ACCESS (half the ingestion price) and Logs Insights. See ADR-0006.
export const workloads: WorkloadConfig[] = [
  workload("dev", "222222222222", "minimal", { retentionDays: 7, logClass: "STANDARD" }),
  workload("nonprod", "333333333333", "minimal", { retentionDays: 14, logClass: "STANDARD" }),
  workload("prod", "444444444444", "standard", { retentionDays: 30, logClass: "INFREQUENT_ACCESS" }),
];
