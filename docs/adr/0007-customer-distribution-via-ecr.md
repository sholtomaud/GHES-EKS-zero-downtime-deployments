# ADR-0007: Customers pull GA releases from ECR `release/*`, copied from Artifactory by digest

- **Status:** Proposed
- **Date:** 2026-10-11
- **Deciders:** <product/platform owner, security>; only humans set `Accepted`
- **Requirements:** [PORT-01], [PORT-06], [REL-01], [REL-02]; answers Q19 (PROPOSAL §2.5 option B)

## Context

The owner stated that customers who host the application won't run GitOps:
they deploy from "our Artifactory → ECR repository". PROPOSAL §2.5 recommended
option B (ECR) over exposing Artifactory.

## Options considered

As PROPOSAL §2.5: A, expose Artifactory; **B, ECR**; C, a hosted registry.

## Decision

Option B. The GHES promote workflow copies each **GA** release (8 images and
the chart) from Artifactory into the **existing ECR** under `release/*`,
by digest and with referrers (`oras cp -r`), after the `ga` GHES Environment
approval. Customer AWS accounts get read-only pull through the repository
policy, which the ECR owner maintains (this repo doesn't create or manage
the ECR). Internal releases go to `internal/*`, which customers can't see.
Tags must be immutable (ECR owner, Q34).

## Consequences

- Positive: Artifactory stays private. Distribution is managed, highly available and audited (CloudTrail).
- Negative: ECR auth needs an AWS principal, and tokens last 12 h. Customers
  without AWS accounts need another route (Q32), or a mirror that refreshes
  ECR credentials.
- Follow-ups: a per-customer onboarding runbook (the ECR owner adds the customer account to the `release/*` pull policy).

## Verification

A customer test account can `helm pull oci://<ecr>/release/charts/app`, and
can't pull `internal/*`.

## References

PROPOSAL.md §2.5; push roles in `infra/src/stacks/tooling-stack.ts` (ghes_oidc.tf).
