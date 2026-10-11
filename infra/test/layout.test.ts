// The synthesised OpenTofu must look like a hand-written root module:
// one concern per file, conventional file names, idiomatic HCL.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Testing } from "cdktn";
import { layout, splitBlocks, unwrapInterpolations } from "../src/layout.ts";
import { ToolingStack } from "../src/stacks/tooling-stack.ts";
import { WorkloadStack } from "../src/stacks/workload-stack.ts";
import { tooling, workloads } from "../src/config.ts";

const toolingStack = new ToolingStack(Testing.app(), "tooling", { tooling, workloads });
const workloadStack = new WorkloadStack(Testing.app(), "workload-dev", {
  env: { ...workloads[0], tls: { domainName: "dev.example.com", hostedZoneId: "Z1" } },
  tooling,
});
const stacks = { tooling: layout(toolingStack, { files: toolingStack.files }), workload: layout(workloadStack, { files: workloadStack.files }) };
const tfFiles = Object.values(stacks).flatMap((files) => files.filter((f) => f.path.endsWith(".tf")));
const file = (files: { path: string; content: string }[], path: string) => files.find((f) => f.path === path)!.content;

describe("file structure", () => {
  test("tooling: standard files first, then one file per concern", () => {
    assert.deepEqual(
      stacks.tooling.map((f) => f.path),
      ["terraform.tf", "backend.tf", "providers.tf", "ghes_oidc.tf", "delivery_hub.tf", "argocd.tf"],
    );
  });

  test("workload: standard files, concerns, and the large IAM policy as a JSON file", () => {
    assert.deepEqual(
      stacks.workload.map((f) => f.path),
      [
        "terraform.tf",
        "backend.tf",
        "providers.tf",
        "locals.tf",
        "eks.tf",
        "logging.tf",
        "fargate.tf",
        "access.tf",
        "load_balancer_controller.tf",
        "tls.tf",
        "policies/aws-load-balancer-controller.json",
      ],
    );
  });

  test("no catch-all main.tf: every resource belongs to a concern", () => {
    for (const files of Object.values(stacks)) assert.ok(!files.some((f) => f.path === "main.tf"));
  });

  test("no .tf file is longer than 200 lines", () => {
    for (const f of tfFiles) assert.ok(f.content.split("\n").length <= 200, `${f.path}: ${f.content.split("\n").length} lines`);
  });

  test("every resource and data block is in exactly one file (nothing lost or duplicated)", () => {
    const blocks = (hcl: string) => splitBlocks(hcl).filter((b) => b.type === "resource" || b.type === "data").map((b) => `${b.type}.${b.labels.join(".")}`);
    for (const [stack, files] of [
      [toolingStack, stacks.tooling],
      [workloadStack, stacks.workload],
    ] as const) {
      const expected = blocks(stack.toHclTerraform().hcl).sort();
      const got = files.filter((f) => f.path.endsWith(".tf")).flatMap((f) => blocks(f.content.replace(/^#.*\n/gm, ""))).sort();
      assert.deepEqual(got, expected);
    }
  });
});

describe("terraform.tf and backend.tf", () => {
  test("terraform.tf pins OpenTofu >= 1.13.0 and the exact AWS provider", () => {
    const tf = file(stacks.tooling, "terraform.tf");
    assert.match(tf, /required_version = ">= 1\.13\.0"/);
    assert.match(tf, /source\s+= "hashicorp\/aws"\n\s+version = "\d+\.\d+\.\d+"/);
    assert.doesNotMatch(tf, /backend/);
  });

  test("backend.tf holds only the Artifactory remote backend, with workspaces as a block", () => {
    const b = file(stacks.workload, "backend.tf");
    assert.match(b, /backend "remote" \{/);
    assert.match(b, /organization = "[^"]+"/);
    assert.match(b, /workspaces \{\n\s+name = "workload-dev"\n\s+\}/);
    assert.doesNotMatch(b, /required_|token/);
  });
});

describe("idiomatic HCL", () => {
  test("names are snake_case with no hash suffixes", () => {
    for (const f of tfFiles) {
      for (const b of splitBlocks(f.content.replace(/^#.*\n/gm, ""))) {
        if (b.type === "resource" || b.type === "data") assert.match(b.labels[1], /^[a-z][a-z0-9_]*$/, `${f.path}: ${b.labels.join(".")}`);
      }
    }
  });

  test("references are bare expressions, not \"${...}\" strings", () => {
    for (const f of tfFiles) {
      for (const line of f.content.split("\n")) assert.doesNotMatch(line, /=\s*"\$\{[^"]*\}"\s*$/, `${f.path}: ${line}`);
    }
  });

  test("depends_on lists references, not strings", () => {
    for (const f of tfFiles) {
      const deps = [...f.content.matchAll(/depends_on\s*=\s*\[([^\]]*)\]/g)].map((m) => m[1]);
      for (const d of deps) assert.doesNotMatch(d, /"/, f.path);
    }
  });

  test("for_each is the first argument of its block", () => {
    for (const f of tfFiles) {
      for (const b of splitBlocks(f.content.replace(/^#.*\n/gm, ""))) {
        const lines = b.text.split("\n").map((l) => l.trim()).filter(Boolean);
        const at = lines.findIndex((l) => l.startsWith("for_each"));
        if (at >= 0) assert.equal(at, 1, `${f.path}: ${b.labels.join(".")}`);
      }
    }
  });

  test("IAM policies are aws_iam_policy_document data sources or files, never inline JSON strings", () => {
    for (const f of tfFiles) assert.doesNotMatch(f.content, /(policy|assume_role_policy)\s*=\s*"\{/, f.path);
  });

  test("every generated file says where it comes from", () => {
    for (const f of tfFiles) assert.match(f.content, /^# Generated by cdktn from infra\/src/);
  });
});

describe("HCL helpers", () => {
  test("unwrap only whole-string interpolations", () => {
    assert.equal(unwrapInterpolations('a = "${x.y}"'), "a = x.y");
    assert.equal(unwrapInterpolations('a = "pre/${x}"'), 'a = "pre/${x}"');
    assert.equal(unwrapInterpolations('a = "${replace(x, "https://", "")}"'), 'a = replace(x, "https://", "")');
    assert.equal(unwrapInterpolations('a = "${x}:sub"'), 'a = "${x}:sub"');
  });

  test("split respects braces inside strings and interpolations", () => {
    const blocks = splitBlocks('resource "a" "b" {\n  x = "}{${f("}")}"\n}\nlocals {\n  y = 1\n}\n');
    assert.deepEqual(blocks.map((b) => b.type), ["resource", "locals"]);
  });
});
