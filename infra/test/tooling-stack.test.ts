import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Testing } from "cdktn";
import { ToolingStack } from "../src/stacks/tooling-stack.ts";
import { tooling, workloads } from "../src/config.ts";
import { synth, byName, resources, one, statements, condition, asArray } from "./helpers.ts";

const cfg = tooling;
const s = synth(new ToolingStack(Testing.app(), "tooling", { tooling: cfg, workloads }));
const ecrArn = (prefix: string) => `arn:aws:ecr:${cfg.ecr.region}:${cfg.ecr.accountId}:repository/${prefix}/*`;
const roles = byName(s, "aws_iam_role");

describe("ECR already exists: this stack only references it [REL-01] [REL-02]", () => {
  test("no ECR resources are created or managed here", () => {
    for (const type of Object.keys(s.resource ?? {})) assert.ok(!type.startsWith("aws_ecr_"), type);
  });

  test("the ECR the stacks point at is configuration, with separate internal and release prefixes", () => {
    assert.match(cfg.ecr.accountId, /^\d{12}$/);
    assert.notEqual(cfg.ecr.internalPrefix, cfg.ecr.releasePrefix);
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
    assert.deepEqual(scope("ghes_promote_internal"), [ecrArn(cfg.ecr.internalPrefix)]);
    assert.deepEqual(scope("ghes_publish_ga"), [ecrArn(cfg.ecr.releasePrefix)]);
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

  test("the capability can manage Applications on the hub itself via an access entry", () => {
    const entry = byName(s, "aws_eks_access_entry").argocd_hub;
    assert.equal(entry.cluster_name, "${aws_eks_cluster.delivery_hub.name}");
    assert.equal(entry.principal_arn, "${aws_iam_role.argocd_capability.arn}");
    const assoc = byName(s, "aws_eks_access_policy_association").argocd_hub;
    assert.equal(assoc.policy_arn, "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy");
    assert.deepEqual(asArray<any>(assoc.depends_on), ["aws_eks_access_entry.argocd_hub"]);
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
    assert.deepEqual(ecr.resources, [ecrArn(cfg.ecr.internalPrefix)]);
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
  test("state lives in Artifactory's Terraform backend repository, one workspace per stack", () => {
    assert.deepEqual(Object.keys(s.terraform!.backend), ["remote"]);
    const b = s.terraform!.backend.remote;
    assert.equal(b.hostname, cfg.state.hostname);
    assert.equal(b.organization, cfg.state.repository);
    assert.deepEqual(b.workspaces, { name: "tooling" });
    assert.equal(b.token, undefined, "no token in config: TF_TOKEN_<host> or tofu login");
  });

  test("provider applies default tags to every resource", () => {
    const tags = s.provider!.aws[0].default_tags[0].tags;
    assert.equal(tags["managed-by"], "cdktn");
    assert.equal(tags.stack, "tooling");
  });
});
