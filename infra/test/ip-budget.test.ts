// [NET-01] [NET-02] [NET-03]: the IP budget is a tested function, not a spreadsheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { budget, fitsAccount, NET_01_LIMIT } from "../src/ip-budget.ts";

test("minimal profile: 19 routable IPs steady, 33 at peak surge", () => {
  const b = budget("minimal");
  assert.equal(b.steady, 19);
  assert.equal(b.peak, 33);
});

test("ha profile: 28 steady, 42 at peak surge", () => {
  const b = budget("ha");
  assert.equal(b.steady, 28);
  assert.equal(b.peak, 42);
});

test("NET-01: minimal peak is within 50 routable IPs", () => {
  assert.ok(budget("minimal").peak <= NET_01_LIMIT);
});

test("NET-02: every profile leaves >= 30% headroom in an 80-IP account", () => {
  for (const p of ["minimal", "standard", "ha"] as const) {
    assert.ok(fitsAccount(budget(p), 80, 0.3), `${p} does not fit`);
  }
});

test("no nodes, no warm pool, no in-cluster delivery pods", () => {
  const lines = budget("minimal").lines;
  assert.equal(lines.nodes.peak, 0);
  assert.equal(lines.warmPool.peak, 0);
  assert.equal(lines.delivery.peak, 0, "managed Argo CD runs in AWS-owned infrastructure [DEP-07]");
});

test("a design that needs 57 IPs at peak fails an 80-IP account with 30% headroom", () => {
  assert.equal(fitsAccount({ steady: 40, peak: 57, lines: {} as never }, 80, 0.3), false);
});
