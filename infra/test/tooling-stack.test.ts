import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Testing } from "cdktn";
import { ToolingStack } from "../src/stacks/tooling-stack.ts";
import { tooling, workloads } from "../src/config.ts";
import { synth, resources, one, policy, asArray } from "./helpers.ts";

const cfg = { ...tooling, customerAccountIds: ["555555555555"] };
const s = synth(new ToolingStack(Testing.app(), "tooling", { tooling: cfg, workloads }));
const roles = resources(s, "aws_iam_role");

describe("ECR release cache and customer distribution [REL-01] [REL-02]", () => {
  const repos = resources(s, "aws_ecr_repository");

  test("internal/ and release/ repositories for every service plus the chart", () => {
    const names = repos.map((r) => r.name).sort();
    const expected = [...cfg.services, `charts/${cfg.chartName}`]
      .flatMap((n) => [`internal/${n}`, `release/${n}`])
      .sort();
    assert.deepEqual(names, expected);
  });

  test("every repository has immutable tags, so a tag can never move to a new digest", () => {
    for (const r of repos) assert.equal(r.image_tag_mutability, "IMMUTABLE", r.name);
  });

  test("every repository has a lifecycle policy that keeps the last N releases", () => {
    const lps = resources(s, "aws_ecr_lifecycle_policy");
    assert.equal(lps.length, repos.length);
    for (const lp of lps) {
      const rule = JSON.parse(lp.policy).rules[0];
      assert.equal(rule.selection.countType, "imageCountMoreThan");
      assert.equal(rule.selection.countNumber, cfg.imagesRetained);
    }
  });

  test("internal repos are readable by workload accounts only; release repos by customers only", () => {
    const rps = resources(s, "aws_ecr_repository_policy");
    assert.equal(rps.length, repos.length);
    const workloadRoots = workloads.map((w) => `arn:aws:iam::${w.accountId}:root`).sort();
    const customerRoots = cfg.customerAccountIds.map((a) => `arn:aws:iam::${a}:root`).sort();
    for (const rp of rps) {
      const stmt = policy(rp.policy).Statement;
      assert.equal(stmt.length, 1);
      const principals = asArray<string>(stmt[0].Principal.AWS).sort();
      assert.ok(!principals.includes("*"), "no public pull");
      assert.deepEqual(stmt[0].Action.sort(), ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]);
      if (rp.repository.includes("ecr_repository.internal")) assert.deepEqual(principals, workloadRoots);
      else assert.deepEqual(principals, customerRoots);
    }
  });
});

describe("GHES OIDC and promotion roles [DEP-04]", () => {
  const ghesHost = new URL(cfg.ghes.url).host;

  test("GHES is an OIDC provider for STS", () => {
    const p = one(s, "aws_iam_openid_connect_provider");
    assert.equal(p.url, `${cfg.ghes.url}/_services/token`);
    assert.deepEqual(p.client_id_list, ["sts.amazonaws.com"]);
  });

  const ghesRoles = roles.filter((r) => JSON.stringify(policy(r.assume_role_policy)).includes("_services/token"));

  test("two promotion roles: internal (dev/nonprod/prod) and GA (customer release)", () => {
    assert.deepEqual(ghesRoles.map((r) => r.name).sort(), ["ghes-promote-internal", "ghes-publish-ga"]);
  });

  test("trust is pinned to the app repo and a GHES Environment, never a wildcard repo", () => {
    for (const r of ghesRoles) {
      const st = policy(r.assume_role_policy).Statement[0];
      assert.equal(st.Action, "sts:AssumeRoleWithWebIdentity");
      assert.equal(st.Condition.StringEquals[`${ghesHost}/_services/token:aud`], "sts.amazonaws.com");
      const subs = asArray<string>(st.Condition.StringEquals[`${ghesHost}/_services/token:sub`]);
      assert.ok(subs.length > 0);
      for (const sub of subs) assert.match(sub, new RegExp(`^repo:${cfg.ghes.appRepository}:environment:[a-z]+$`));
      assert.equal(st.Condition.StringLike, undefined, "no wildcard subjects");
    }
    const ga = ghesRoles.find((r) => r.name === "ghes-publish-ga")!;
    const gaSubs = policy(ga.assume_role_policy).Statement[0].Condition.StringEquals[`${ghesHost}/_services/token:sub`];
    assert.deepEqual(asArray(gaSubs), [`repo:${cfg.ghes.appRepository}:environment:ga`]);
  });
});

describe("Managed Argo CD on a zero-pod hub cluster [DEP-03] [DEP-07] [OPS-03]", () => {
  test("one private hub cluster with access entries and no self-managed add-ons", () => {
    const c = one(s, "aws_eks_cluster");
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
    const cap = one(s, "aws_eks_capability");
    assert.equal(cap.type, "ARGOCD");
    assert.equal(cap.capability_name, "argocd");
    assert.equal(cap.delete_propagation_policy, "RETAIN");
    const argo = asArray<any>(cap.configuration)[0].argo_cd[0] ?? asArray<any>(cap.configuration)[0].argo_cd;
    assert.equal(argo.namespace, "argocd");
    assert.equal(asArray<any>(argo.aws_idc)[0].idc_instance_arn, cfg.identityCenter.instanceArn);
    const mappings = asArray<any>(argo.rbac_role_mapping);
    const byRole = Object.fromEntries(mappings.map((m) => [m.role, asArray<any>(m.identity).map((i) => [i.type, i.id])]));
    assert.deepEqual(byRole.ADMIN, [["SSO_GROUP", cfg.identityCenter.argocdAdminGroupId]]);
    assert.deepEqual(byRole.VIEWER, [["SSO_GROUP", cfg.identityCenter.argocdViewerGroupId]]);
  });

  test("the capability role is assumable only by EKS capabilities, with a deterministic name", () => {
    const role = roles.find((r) => r.name === "eks-capability-argocd")!;
    assert.ok(role);
    const st = policy(role.assume_role_policy).Statement[0];
    assert.equal(st.Principal.Service, "capabilities.eks.amazonaws.com");
    assert.deepEqual(st.Action.sort(), ["sts:AssumeRole", "sts:TagSession"]);
  });

  test("the capability role can read the deploy repo connection and internal/ charts only", () => {
    const inline = resources(s, "aws_iam_role_policy").filter((p) => p.name === "argocd-sources");
    assert.equal(inline.length, 1);
    const stmts = policy(inline[0].policy).Statement;
    const actions = stmts.flatMap((x: any) => x.Action);
    assert.ok(actions.includes("codeconnections:UseConnection"));
    assert.ok(actions.includes("ecr:BatchGetImage"));
    assert.ok(!actions.some((a: string) => a.endsWith(":*") || a === "*"), "no wildcard actions");
    const ecrStmt = stmts.find((x: any) => x.Action.includes("ecr:BatchGetImage"));
    for (const r of asArray<string>(ecrStmt.Resource)) assert.match(r, /aws_ecr_repository\.internal-/);
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
    const egress = resources(s, "aws_vpc_security_group_egress_rule");
    assert.equal(egress.length, 1);
    assert.equal(egress[0].cidr_ipv4, cfg.ghes.cidr);
    assert.equal(egress[0].from_port, 443);
    assert.equal(egress[0].to_port, 443);
    assert.equal(resources(s, "aws_vpc_security_group_ingress_rule").length, 0);
  });

  test("one connection on that host", () => {
    const c = one(s, "aws_codeconnections_connection");
    assert.match(c.host_arn, /aws_codeconnections_host\./);
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
