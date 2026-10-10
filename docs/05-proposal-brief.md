# Proposal brief (Phase 1)

This is the task specification for whoever (human or LLM) writes the
solution proposal. Produce everything under `docs/proposal/` plus ADRs in
`docs/adr/` with status `Proposed`. **No implementation code in Phase 1.**

## Inputs

- `docs/01`–`04`, the ADRs, and `docs/discovery/*` (Phase 0 measurements).
- Answers recorded in `docs/06-open-questions.md`. Where unanswered, state the
  assumption and the impact if it's wrong.

## Required deliverables

| File | Contents |
|---|---|
| `docs/proposal/README.md` | Executive summary (≤ 1 page): recommended architecture, why, IP/cost/complexity before vs after, key risks. |
| `docs/proposal/architecture.md` | Diagrams (Mermaid): build → release → promote → deploy → traffic; account/network topology; runtime view of one environment. |
| `docs/proposal/decisions.md` | For each decision D1–D8 in `04-solution-space.md`: options, **weighted scoring table**, choice and link to its ADR. |
| `docs/proposal/ip-budget.md` | Filled budget model (`03-ip-address-budget.md` §2) for `minimal` and `ha`, steady and peak, routable and secondary. |
| `docs/proposal/component-register.md` | Every in-cluster and AWS component: purpose, requirement IDs, pods, IPs, owner, upgrade cadence. |
| `docs/proposal/traceability.md` | Every MUST/SHOULD requirement → component(s) → verification method. Flag any SHOULD not met and why. |
| `docs/proposal/release-flow.md` | Step by step: commit → image → release → dev → nonprod → prod approval → rollout → gate → done/abort/rollback. Who/what holds which credentials at each step. |
| `docs/proposal/customer-install.md` | Draft customer install and upgrade guide for the release artefact, proving DEP-01/PORT-01. |
| `docs/proposal/repo-layout.md` | Proposed repos/directories for app, chart, IaC and pipelines, and which GHES workflows live where. |
| `docs/proposal/migration.md` | Env-by-env migration and cutover plan with rollback at each step (MIG-*). |
| `docs/proposal/build-plan.md` | Phase 2 work breakdown in thin vertical slices, each independently demoable, with acceptance tests. |
| `docs/proposal/risks.md` | Risks, assumptions, unverified claims (with doc links), and what would change the recommendation. |
| `docs/adr/NNNN-*.md` | One ADR per decision, status `Proposed`. |

## Scoring weights (default; humans may adjust)

| Criterion | Weight | Tied to |
|---|---|---|
| Fits IP budget with headroom | 25 | NET-* |
| Zero downtime and rollback quality | 20 | ZDT-* |
| Operational simplicity (components, pods, upgrades, skills) | 20 | OPS-*, DEP-07 |
| Same artefact/interface for customers | 15 | DEP-01, PORT-* |
| Security and audit | 10 | SEC-*, DEP-02/04 |
| Cost | 5 | OPS-05 |
| Maturity / support in 2026 | 5 | — |

Score 1–5 per criterion, show the arithmetic, and do a sensitivity check: does
the winner change if simplicity and IP weights swap with ZDT?

## Quality bar

- Each claim about an AWS/K8s feature that the design depends on has a link to
  current official docs, or is listed in `risks.md` as unverified.
- No component appears without a requirement ID.
- The design is explainable on one diagram to a new engineer.
- Prefer deleting things to adding things.

## Phase 2 preview (for planning only)

The build plan should aim for these slices, in order:

1. **Release artefact:** chart + digests + schema + signing, published from
   GHES to Artifactory. Installs on kind in CI (PORT-01).
2. **Conformance suite:** install, upgrade N-1→N, broken-release abort,
   rollback, zero-failed-requests load check. Runs on kind and EKS.
3. **Dev environment:** IaC + chosen delivery mechanism + IP measurement.
4. **Rollout/traffic switch** with health gate (ZDT-*).
5. **Promotion and audit** across dev → nonprod → prod (DEP-02/03).
6. **Observability adapters** (OBS-*), drift detection (OPS-03).
7. **Constrained-VPC proof** in an ~80-IP account (NET-02).
8. **Migration** of nonprod, then prod. Decommission the old stack (MIG-*).
