import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Testing } from "cdktn";
import { WorkloadStack } from "../src/stacks/workload-stack.ts";
import { tooling, workloads, argocdCapabilityRoleArn, names } from "../src/config.ts";
import { synth, resources, one, policy, asArray } from "./helpers.ts";

const dev = { ...workloads[0], tls: { domainName: "dev.app.example.com", hostedZoneId: "Z0000000000000" } };
const prod = workloads.find((w) => w.name === "prod")!;
const s = synth(new WorkloadStack(Testing.app(), "workload-dev", { env: dev, tooling }));
const sProd = synth(new WorkloadStack(Testing.app(), "workload-prod", { env: prod, tooling }));

const ADMIN = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy";
const VIEW = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy";

describe("cluster [NET-06] [DEP-05] [OPS-02]", () => {
  test("exactly one cluster per environment, private endpoint only", () => {
    const c = one(s, "aws_eks_cluster");
    assert.equal(c.name, "app-dev");
    assert.equal(c.version, dev.kubernetesVersion);
    assert.equal(c.vpc_config.endpoint_public_access, false);
    assert.equal(c.vpc_config.endpoint_private_access, true);
    assert.deepEqual(c.vpc_config.subnet_ids, dev.privateSubnetIds);
  });

  test("access entries only (no aws-auth ConfigMap), and the creator is not silently admin", () => {
    const c = one(s, "aws_eks_cluster");
    assert.equal(c.access_config.authentication_mode, "API");
    assert.equal(c.access_config.bootstrap_cluster_creator_admin_permissions, false);
  });

  test("standard support only: no extended-support fees [OPS-02]", () => {
    assert.equal(one(s, "aws_eks_cluster").upgrade_policy.support_type, "STANDARD");
  });

  test("control-plane logs limited to audit and authenticator (cost)", () => {
    assert.deepEqual(one(s, "aws_eks_cluster").enabled_cluster_log_types.sort(), ["audit", "authenticator"]);
  });
});

describe("compute: every pod on Fargate [NET-01] [NET-03]", () => {
  test("no nodes of any kind, and no VPC CNI / kube-proxy DaemonSets", () => {
    for (const t of ["aws_eks_node_group", "aws_launch_template", "aws_autoscaling_group"]) {
      assert.equal(resources(s, t).length, 0, t);
    }
    assert.equal(one(s, "aws_eks_cluster").bootstrap_self_managed_addons, false);
    const addons = resources(s, "aws_eks_addon").map((a) => a.addon_name);
    assert.deepEqual(addons, ["coredns"]);
  });

  test("Fargate profiles cover kube-system and the app namespace, in private subnets", () => {
    const profiles = resources(s, "aws_eks_fargate_profile");
    const ns = profiles.flatMap((p) => asArray<any>(p.selector).map((x) => x.namespace)).sort();
    assert.deepEqual(ns, ["app", "kube-system"]);
    for (const p of profiles) assert.deepEqual(p.subnet_ids, dev.privateSubnetIds);
  });

  test("CoreDNS is the managed add-on, scheduled on Fargate", () => {
    const a = one(s, "aws_eks_addon");
    assert.deepEqual(JSON.parse(a.configuration_values), { computeType: "Fargate" });
    assert.ok(asArray<string>(a.depends_on).some((d) => d.startsWith("aws_eks_fargate_profile.")));
  });

  test("pod execution role is confused-deputy safe (SourceArn scoped to this cluster's profiles)", () => {
    const role = resources(s, "aws_iam_role").find((r) => r.name === "app-dev-fargate-pod-execution")!;
    const st = policy(role.assume_role_policy).Statement[0];
    assert.equal(st.Principal.Service, "eks-fargate-pods.amazonaws.com");
    assert.match(st.Condition.ArnLike["aws:SourceArn"], /:fargateprofile\/app-dev\/\*$/);
  });
});

describe("delivery: managed Argo CD from the tooling account [DEP-03] [DEP-04] [SEC-01]", () => {
  const entries = resources(s, "aws_eks_access_entry");
  const assoc = resources(s, "aws_eks_access_policy_association");

  test("the Argo CD capability role is granted cluster access via an access entry", () => {
    const arn = argocdCapabilityRoleArn(tooling);
    assert.ok(entries.some((e) => e.principal_arn === arn));
    assert.ok(assoc.some((a) => a.principal_arn === arn && a.policy_arn === ADMIN));
  });

  test("humans are read-only; only Argo CD and break-glass can write", () => {
    const admins = assoc.filter((a) => a.policy_arn === ADMIN).map((a) => a.principal_arn).sort();
    assert.deepEqual(admins, [argocdCapabilityRoleArn(tooling), dev.access.breakGlassRoleArn].sort());
    for (const ro of dev.access.readOnlyRoleArns) {
      assert.ok(assoc.some((a) => a.principal_arn === ro && a.policy_arn === VIEW));
    }
  });
});

describe("AWS Load Balancer Controller identity [SEC-05] [ZDT-07]", () => {
  test("IRSA: cluster OIDC provider plus a role bound to kube-system/aws-load-balancer-controller", () => {
    one(s, "aws_iam_openid_connect_provider");
    const role = resources(s, "aws_iam_role").find((r) => r.name === "app-dev-aws-load-balancer-controller")!;
    const st = policy(role.assume_role_policy).Statement[0];
    assert.equal(st.Action, "sts:AssumeRoleWithWebIdentity");
    const eq = st.Condition.StringEquals;
    const subKey = Object.keys(eq).find((k) => k.endsWith(":sub"))!;
    assert.equal(eq[subKey], "system:serviceaccount:kube-system:aws-load-balancer-controller");
    assert.equal(eq[subKey.replace(/:sub$/, ":aud")], "sts.amazonaws.com");
  });

  test("controller policy is the pinned upstream policy, not AdministratorAccess", () => {
    const p = resources(s, "aws_iam_policy").find((x) => x.name === "app-dev-aws-load-balancer-controller")!;
    assert.ok(policy(p.policy).Statement.length > 5);
    const attached = resources(s, "aws_iam_role_policy_attachment").map((a) => a.policy_arn);
    assert.ok(!attached.some((a) => /AdministratorAccess/.test(a)));
  });
});

describe("logging and debugging [OBS-01] [OBS-02] [OBS-04]", () => {
  test("one pre-created container log group with the environment's class and retention", () => {
    const g = resources(s, "aws_cloudwatch_log_group").find((x) => x.name === names.logGroup("dev"))!;
    assert.equal(g.retention_in_days, 7);
    assert.equal(g.log_group_class, "STANDARD");
    const gp = resources(sProd, "aws_cloudwatch_log_group").find((x) => x.name === names.logGroup("prod"))!;
    assert.equal(gp.log_group_class, "INFREQUENT_ACCESS");
    assert.equal(gp.retention_in_days, 30);
  });

  test("every log group has a bounded retention (no never-expire storage cost)", () => {
    for (const g of resources(s, "aws_cloudwatch_log_group")) assert.ok(g.retention_in_days > 0 && g.retention_in_days <= 30, g.name);
  });

  test("the Fargate log router can write only to that log group, and cannot create groups", () => {
    const p = resources(s, "aws_iam_role_policy").find((x) => x.name === "fargate-log-router")!;
    const st = policy(p.policy).Statement;
    const actions = st.flatMap((x: any) => x.Action).sort();
    assert.deepEqual(actions, ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"]);
    for (const x of st) for (const r of asArray<string>(x.Resource)) assert.match(r, /aws_cloudwatch_log_group\./);
  });

  test("no in-cluster observability stack is provisioned", () => {
    const addons = resources(s, "aws_eks_addon").map((a) => a.addon_name);
    for (const banned of ["amazon-cloudwatch-observability", "adot", "aws-guardduty-agent"]) assert.ok(!addons.includes(banned));
  });
});

describe("TLS [ENV-04]", () => {
  test("ACM certificate with DNS validation in Route 53 when a zone is given", () => {
    const c = one(s, "aws_acm_certificate");
    assert.equal(c.domain_name, "dev.app.example.com");
    assert.equal(c.validation_method, "DNS");
    assert.equal(resources(s, "aws_acm_certificate_validation").length, 1);
    assert.equal(resources(s, "aws_route53_record").length, 1);
  });

  test("without a zone the certificate is created but validated out of band", () => {
    assert.equal(resources(sProd, "aws_route53_record").length, 0);
    assert.equal(resources(sProd, "aws_acm_certificate_validation").length, 0);
  });
});

describe("state and tagging", () => {
  test("S3 backend in the workload account's own bucket, encrypted, native lockfile", () => {
    const b = s.terraform!.backend.s3;
    assert.equal(b.bucket, dev.state.bucket);
    assert.equal(b.key, "workload-dev/terraform.tfstate");
    assert.equal(b.encrypt, true);
    assert.equal(b.use_lockfile, true);
  });

  test("provider is pinned to the workload account and tags everything", () => {
    const p = s.provider!.aws[0];
    assert.deepEqual(p.allowed_account_ids, [dev.accountId]);
    assert.equal(p.default_tags[0].tags.environment, "dev");
    assert.equal(p.default_tags[0].tags["managed-by"], "cdktn");
  });
});
