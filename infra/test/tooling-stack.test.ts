import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Testing } from "cdktn";
import { ToolingStack } from "../src/stacks/tooling-stack.ts";
import { tooling, workloads } from "../src/config.ts";
import { synth, byName, resources, one, statements, condition, asArray } from "./helpers.ts";

const cfg = { ...tooling, customerAccountIds: ["555555555555"] };
const s = synth(new ToolingStack(Testing.app(), "tooling", { tooling: cfg, workloads }));
const noCustomers = synth(new ToolingStack(Testing.app(), "tooling", { tooling: { ...tooling, customerAccountIds: [] }, workloads }));
const roles = byName(s, "aws_iam_role");

describe("ECR release cache and customer distribution [REL-01] [REL-02]", () => {
  const repos = byName(s, "aws_ecr_repository");
  const expected = [...cfg.services, `charts/${cfg.chartName}`];

  test("internal and release repositories for every service plus the chart, via for_each", () => {
    assert.deepEqual(Object.keys(repos).sort(), ["internal", "release"]);
    for (const tier of ["internal", "release"]) {
      assert.match(repos[tier].for_each, /^\$\{toset\(\[/);
      for (const name of expected) assert.ok(repos[tier].for_each.includes(`"${name}"`), `${tier}/${name}`);
      assert.equal(repos[tier].name, `${tier}/\${each.value}`);
    }
  });

  test("every repository has immutable tags, so a tag can never move to a new digest", () => {
    for (const r of Object.values(repos)) assert.equal(r.image_tag_mutability, "IMMUTABLE");
  });

  test("every repository has a lifecycle policy that keeps the last N releases", () => {
    const lps = byName(s, "aws_ecr_lifecycle_policy");
    for (const tier of ["internal", "release"]) {
      assert.equal(lps[tier].for_each, `\${aws_ecr_repository.${tier}}`);
      assert.match(lps[tier].policy, /^\$\{jsonencode\(/);
      assert.ok(lps[tier].policy.includes(`"countNumber" = ${cfg.imagesRetained}`));
      assert.ok(lps[tier].policy.includes(`"countType" = "imageCountMoreThan"`));
    }
  });

  test("internal repos are readable by workload accounts only; release repos by customers only", () => {
    const rps = byName(s, "aws_ecr_repository_policy");
    const expectPrincipals = {
      internal: workloads.map((w) => `arn:aws:iam::${w.accountId}:root`),
      release: cfg.customerAccountIds.map((a) => `arn:aws:iam::${a}:root`),
    };
    for (const tier of ["internal", "release"] as const) {
      assert.equal(rps[tier].for_each, `\${aws_ecr_repository.${tier}}`);
      const [st] = statements(s, rps[tier].policy);
      const p = asArray<any>(st.principals)[0];
      assert.equal(p.type, "AWS");
      assert.deepEqual(p.identifiers.sort(), expectPrincipals[tier].sort());
      assert.ok(!p.identifiers.includes("*"), "no public pull");
      assert.deepEqual(st.actions.sort(), ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]);
    }
  });

  test("with no customers yet, release repos get no pull policy (an empty principal list is invalid)", () => {
    assert.deepEqual(Object.keys(byName(noCustomers, "aws_ecr_repository_policy")), ["internal"]);
  });
});

describe("GHES OIDC and promotion roles [DEP-04]", () => {
  const issuer = `${new URL(cfg.ghes.url).host}/_services/token`;

  test("GHES is an OIDC provider for STS", () => {
    const p = one(s, "aws_iam_openid_connect_provider");
    assert.equal(p.url, `${cfg.ghes.url}/_services/token`);
    assert.deepEqual(p.client_id_list, ["sts.amazonaws.com"]);
  });

  test("two promotion roles: internal (dev/nonprod/prod) and GA (customer release)", () => {
    assert.equal(roles.ghes_promote_internal.name, "ghes-promote-internal");
    assert.equal(roles.ghes_publish_ga.name, "ghes-publish-ga");
  });

  test("trust is pinned to the app repo and a GHES Environment, never a wildcard", () => {
    for (const [name, envs] of [
      ["ghes_promote_internal", workloads.map((w) => w.name)],
      ["ghes_publish_ga", ["ga"]],
    ] as const) {
      const [st] = statements(s, roles[name].assume_role_policy);
      assert.deepEqual(st.actions, ["sts:AssumeRoleWithWebIdentity"]);
      assert.deepEqual(condition(st, "StringEquals", `${issuer}:aud`), ["sts.amazonaws.com"]);
      assert.deepEqual(condition(st, "StringEquals", `${issuer}:sub`), envs.map((e) => `repo:${cfg.ghes.appRepository}:environment:${e}`));
      assert.ok(!asArray<any>(st.condition).some((c) => c.test === "StringLike"), "no wildcard subjects");
    }
  });

  test("internal role pushes to internal/* only; GA role to release/* only", () => {
    const pushes = byName(s, "aws_iam_role_policy");
    const scope = (name: string) => statements(s, pushes[name].policy).find((x) => x.actions.includes("ecr:PutImage")).resources;
    assert.deepEqual(scope("ghes_promote_internal"), [`arn:aws:ecr:${cfg.region}:${cfg.accountId}:repository/internal/*`]);
    assert.deepEqual(scope("ghes_publish_ga"), [`arn:aws:ecr:${cfg.region}:${cfg.accountId}:repository/release/*`]);
  });
});

describe("Managed Argo CD on a zero-pod hub cluster [DEP-03] [DEP-07] [OPS-03]", () => {
  test("one private hub cluster with access entries and no self-managed add-ons", () => {
    const c = byName(s, "aws_eks_cluster").delivery_hub;
    assert.equal(c.name, "delivery-hub");
    assert.equal(c.vpc_config.endpoint_public_access, false);
    assert.equal(c.vpc_config.endpoint_private_access, true);
    assert.equal(c.access_config.authentication_mode, "API");
    assert.equal(c.bootstrap_self_managed_addons, false);
  });

  test("the hub runs no pods: no node groups, Fargate profiles or add-ons", () => {
    for (const t of ["aws_eks_node_group", "aws_eks_fargate_profile", "aws_eks_addon", "aws_autoscaling_group"]) {
      assert.equal(resources(s, t).length, 0, t);
    }
  });

  test("the Argo CD capability is managed, retains Applications on delete, and uses Identity Center", () => {
    const cap = byName(s, "aws_eks_capability").argocd;
    assert.equal(cap.type, "ARGOCD");
    assert.equal(cap.capability_name, "argocd");
    assert.equal(cap.delete_propagation_policy, "RETAIN");
    const argo = asArray<any>(asArray<any>(cap.configuration)[0].argo_cd)[0];
    assert.equal(argo.namespace, "argocd");
    assert.equal(asArray<any>(argo.aws_idc)[0].idc_instance_arn, cfg.identityCenter.instanceArn);
    const byRole = Object.fromEntries(asArray<any>(argo.rbac_role_mapping).map((m) => [m.role, asArray<any>(m.identity).map((i) => [i.type, i.id])]));
    assert.deepEqual(byRole.ADMIN, [["SSO_GROUP", cfg.identityCenter.argocdAdminGroupId]]);
    assert.deepEqual(byRole.VIEWER, [["SSO_GROUP", cfg.identityCenter.argocdViewerGroupId]]);
  });

  test("the capability role is assumable only by EKS capabilities, with a deterministic name", () => {
    const role = roles.argocd_capability;
    assert.equal(role.name, "eks-capability-argocd");
    const [st] = statements(s, role.assume_role_policy);
    assert.deepEqual(asArray<any>(st.principals)[0], { type: "Service", identifiers: ["capabilities.eks.amazonaws.com"] });
    assert.deepEqual(st.actions.sort(), ["sts:AssumeRole", "sts:TagSession"]);
  });

  test("the capability role can read the deploy repo connection and internal/ charts only", () => {
    const stmts = statements(s, byName(s, "aws_iam_role_policy").argocd_sources.policy);
    const actions = stmts.flatMap((x) => x.actions);
    assert.ok(actions.includes("codeconnections:UseConnection"));
    assert.ok(!actions.some((a: string) => a.endsWith(":*") || a === "*"), "no wildcard actions");
    const ecr = stmts.find((x) => x.actions.includes("ecr:BatchGetImage"));
    assert.deepEqual(ecr.resources, [`arn:aws:ecr:${cfg.region}:${cfg.accountId}:repository/internal/*`]);
    const cc = stmts.find((x) => x.actions.includes("codeconnections:UseConnection"));
    assert.deepEqual(cc.resources, ["${aws_codeconnections_connection.deploy_repo.arn}"]);
  });
});

describe("CodeConnections host for the private GHES", () => {
  test("host is GitHub Enterprise Server, inside the tooling VPC", () => {
    const h = one(s, "aws_codeconnections_host");
    assert.equal(h.provider_type, "GitHubEnterpriseServer");
    assert.equal(h.provider_endpoint, cfg.ghes.url);
    const vpc = asArray<any>(h.vpc_configuration)[0];
    assert.equal(vpc.vpc_id, cfg.vpcId);
    assert.deepEqual(vpc.subnet_ids, cfg.privateSubnetIds);
  });

  test("the host's security group can only reach GHES on 443", () => {
    const egress = one(s, "aws_vpc_security_group_egress_rule");
    assert.equal(egress.cidr_ipv4, cfg.ghes.cidr);
    assert.equal(egress.from_port, 443);
    assert.equal(egress.to_port, 443);
    assert.equal(resources(s, "aws_vpc_security_group_ingress_rule").length, 0);
  });

  test("one connection on that host", () => {
    assert.equal(one(s, "aws_codeconnections_connection").host_arn, "${aws_codeconnections_host.ghes.arn}");
  });
});

describe("state and tagging", () => {
  test("S3 backend with encryption and native lockfile", () => {
    const b = s.terraform!.backend.s3;
    assert.equal(b.bucket, cfg.state.bucket);
    assert.equal(b.encrypt, true);
    assert.equal(b.use_lockfile, true);
  });

  test("provider applies default tags to every resource", () => {
    const tags = s.provider!.aws[0].default_tags[0].tags;
    assert.equal(tags["managed-by"], "cdktn");
    assert.equal(tags.stack, "tooling");
  });
});
