import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Testing } from "cdktn";
import { WorkloadStack } from "../src/stacks/workload-stack.ts";
import { tooling, workloads, argocdCapabilityRoleArn, names } from "../src/config.ts";
import { synth, byName, resources, one, statements, condition, asArray } from "./helpers.ts";

const dev = { ...workloads[0], tls: { domainName: "dev.app.example.com", hostedZoneId: "Z0000000000000" } };
const prod = workloads.find((w) => w.name === "prod")!;
const devStack = new WorkloadStack(Testing.app(), "workload-dev", { env: dev, tooling });
const s = synth(devStack);
const sProd = synth(new WorkloadStack(Testing.app(), "workload-prod", { env: prod, tooling }));
const roles = byName(s, "aws_iam_role");

const ADMIN = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy";
const VIEW = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy";

describe("cluster [NET-06] [DEP-05] [OPS-02]", () => {
  const c = one(s, "aws_eks_cluster");

  test("exactly one cluster per environment, private endpoint only", () => {
    assert.equal(c.name, "app-dev");
    assert.equal(c.version, dev.kubernetesVersion);
    assert.equal(c.vpc_config.endpoint_public_access, false);
    assert.equal(c.vpc_config.endpoint_private_access, true);
    assert.deepEqual(c.vpc_config.subnet_ids, dev.privateSubnetIds);
  });

  test("access entries only (no aws-auth ConfigMap), and the creator is not silently admin", () => {
    assert.equal(c.access_config.authentication_mode, "API");
    assert.equal(c.access_config.bootstrap_cluster_creator_admin_permissions, false);
  });

  test("standard support only: no extended-support fees [OPS-02]", () => {
    assert.equal(c.upgrade_policy.support_type, "STANDARD");
  });

  test("control-plane logs limited to audit and authenticator (cost)", () => {
    assert.deepEqual([...c.enabled_cluster_log_types].sort(), ["audit", "authenticator"]);
  });
});

describe("compute: every pod on Fargate [NET-01] [NET-03]", () => {
  test("no nodes of any kind, and no VPC CNI / kube-proxy DaemonSets", () => {
    for (const t of ["aws_eks_node_group", "aws_launch_template", "aws_autoscaling_group"]) {
      assert.equal(resources(s, t).length, 0, t);
    }
    assert.equal(one(s, "aws_eks_cluster").bootstrap_self_managed_addons, false);
    assert.deepEqual(resources(s, "aws_eks_addon").map((a) => a.addon_name), ["coredns"]);
  });

  test("Fargate profiles cover kube-system and the app namespace, in private subnets", () => {
    const profiles = resources(s, "aws_eks_fargate_profile");
    const ns = profiles.flatMap((p) => asArray<any>(p.selector).map((x) => x.namespace)).sort();
    assert.deepEqual(ns, ["app", "kube-system"]);
    for (const p of profiles) assert.deepEqual(p.subnet_ids, dev.privateSubnetIds);
  });

  test("CoreDNS is the managed add-on, scheduled on Fargate", () => {
    const a = one(s, "aws_eks_addon");
    assert.equal(a.configuration_values, '${jsonencode({"computeType" = "Fargate"})}');
    assert.ok(asArray<string>(a.depends_on).some((d) => d.startsWith("aws_eks_fargate_profile.")));
  });

  test("pod execution role is confused-deputy safe (SourceArn scoped to this cluster's profiles)", () => {
    const [st] = statements(s, roles.fargate_pod_execution.assume_role_policy);
    assert.deepEqual(asArray<any>(st.principals)[0].identifiers, ["eks-fargate-pods.amazonaws.com"]);
    assert.match(condition(st, "ArnLike", "aws:SourceArn")![0], /:fargateprofile\/app-dev\/\*$/);
  });
});

describe("delivery: managed Argo CD from the tooling account [DEP-03] [DEP-04] [SEC-01]", () => {
  const principals = s.locals!.access_principals as Record<string, { principal_arn: string; policy_arn: string }>;

  test("access entries and policy associations iterate over one principals map", () => {
    assert.equal(byName(s, "aws_eks_access_entry").principals.for_each, "${local.access_principals}");
    assert.equal(byName(s, "aws_eks_access_policy_association").principals.for_each, "${local.access_principals}");
  });

  test("the Argo CD capability role from the tooling account is cluster admin", () => {
    assert.deepEqual(principals.argocd, { principal_arn: argocdCapabilityRoleArn(tooling), policy_arn: ADMIN });
  });

  test("humans are read-only; only Argo CD and break-glass can write", () => {
    const admins = Object.values(principals).filter((p) => p.policy_arn === ADMIN).map((p) => p.principal_arn).sort();
    assert.deepEqual(admins, [argocdCapabilityRoleArn(tooling), dev.access.breakGlassRoleArn].sort());
    for (const ro of dev.access.readOnlyRoleArns) {
      assert.ok(Object.values(principals).some((p) => p.principal_arn === ro && p.policy_arn === VIEW));
    }
  });
});

describe("AWS Load Balancer Controller identity [SEC-05] [ZDT-07]", () => {
  test("IRSA: cluster OIDC provider plus a role bound to kube-system/aws-load-balancer-controller", () => {
    assert.equal(one(s, "aws_iam_openid_connect_provider").url, "${aws_eks_cluster.this.identity[0].oidc[0].issuer}");
    const [st] = statements(s, roles.load_balancer_controller.assume_role_policy);
    assert.deepEqual(st.actions, ["sts:AssumeRoleWithWebIdentity"]);
    assert.deepEqual(condition(st, "StringEquals", "${local.oidc_issuer_host}:sub"), ["system:serviceaccount:kube-system:aws-load-balancer-controller"]);
    assert.deepEqual(condition(st, "StringEquals", "${local.oidc_issuer_host}:aud"), ["sts.amazonaws.com"]);
  });

  test("controller policy is the pinned upstream policy shipped as a file, not AdministratorAccess", () => {
    const p = byName(s, "aws_iam_policy").load_balancer_controller;
    assert.equal(p.policy, '${file("${path.module}/policies/aws-load-balancer-controller.json")}');
    const doc = JSON.parse(devStack.files.get("policies/aws-load-balancer-controller.json")!);
    assert.ok(doc.Statement.length > 5);
    assert.ok(!resources(s, "aws_iam_role_policy_attachment").some((a) => /AdministratorAccess/.test(a.policy_arn)));
  });
});

describe("logging and debugging [OBS-01] [OBS-02] [OBS-04]", () => {
  test("one pre-created container log group with the environment's class and retention", () => {
    const g = byName(s, "aws_cloudwatch_log_group").containers;
    assert.equal(g.name, names.logGroup("dev"));
    assert.equal(g.retention_in_days, 7);
    assert.equal(g.log_group_class, "STANDARD");
    const gp = byName(sProd, "aws_cloudwatch_log_group").containers;
    assert.equal(gp.log_group_class, "INFREQUENT_ACCESS");
    assert.equal(gp.retention_in_days, 30);
  });

  test("every log group has a bounded retention (no never-expire storage cost)", () => {
    for (const g of resources(s, "aws_cloudwatch_log_group")) assert.ok(g.retention_in_days > 0 && g.retention_in_days <= 30, g.name);
  });

  test("the Fargate log router can write only to that log group, and cannot create groups", () => {
    const st = statements(s, byName(s, "aws_iam_role_policy").fargate_log_router.policy);
    assert.deepEqual(st.flatMap((x) => x.actions).sort(), ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"]);
    for (const x of st) for (const r of x.resources) assert.match(r, /aws_cloudwatch_log_group\.containers\.arn/);
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
  test("state lives in Artifactory's Terraform backend repository, in this stack's own workspace", () => {
    assert.deepEqual(Object.keys(s.terraform!.backend), ["remote"]);
    const b = s.terraform!.backend.remote;
    assert.equal(b.hostname, dev.state.hostname);
    assert.equal(b.organization, dev.state.repository);
    assert.deepEqual(b.workspaces, { name: "workload-dev" });
    assert.equal(b.token, undefined);
  });

  test("provider is pinned to the workload account and tags everything", () => {
    const p = s.provider!.aws[0];
    assert.deepEqual(p.allowed_account_ids, [dev.accountId]);
    assert.equal(p.default_tags[0].tags.environment, "dev");
    assert.equal(p.default_tags[0].tags["managed-by"], "cdktn");
  });
});
