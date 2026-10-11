// Hermetic unit tests: no network, no AWS credentials, no tofu binary.
// `make validate` runs `tofu init -backend=false && tofu validate` on the synthesised output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Testing } from "cdktn";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/app.ts";

// Same context the cdktn CLI passes, so stack validations see the real targets.
const project = JSON.parse(readFileSync(new URL("../cdktf.json", import.meta.url), "utf8"));
const app = buildApp(Testing.app({ context: { targetVersions: project.targetVersions } }));
const stacks = app.node.children;
const synthOf = (stack: unknown) => JSON.parse(Testing.synth(stack as never));

test("the app synthesises one tooling stack and one stack per workload environment", () => {
  const ids = stacks.map((c) => c.node.id).sort();
  assert.deepEqual(ids, ["tooling", "workload-dev", "workload-nonprod", "workload-prod"]);
});

test("the project targets OpenTofu >= 1.13.0 only", () => {
  assert.deepEqual(project.targetVersions, { opentofu: ">=1.13.0" });
});

test("every stack passes cdktn's own validations (feature/version support)", () => {
  for (const stack of stacks) assert.deepEqual((stack as never as { runAllValidations(): void }).runAllValidations(), undefined, stack.node.id);
});

test("every stack requires OpenTofu >= 1.13.0", () => {
  for (const stack of stacks) {
    assert.equal(synthOf(stack).terraform.required_version, ">= 1.13.0", stack.node.id);
  }
});

test("every stack pins the AWS provider to an exact version", () => {
  for (const stack of stacks) {
    const aws = synthOf(stack).terraform.required_providers.aws;
    assert.match(aws.version, /^\d+\.\d+\.\d+$/, stack.node.id);
  }
});

test("each stack's state lives in its own Artifactory workspace", () => {
  const keys = stacks.map((s) => synthOf(s).terraform.backend.remote.workspaces.name);
  assert.equal(new Set(keys).size, keys.length);
});

test("no image reference anywhere uses a mutable 'latest' tag [REL-02]", () => {
  for (const stack of stacks) assert.doesNotMatch(Testing.synth(stack as never), /:latest\b/, stack.node.id);
});
