# ADR-0004: Deliver to our EKS accounts with the EKS managed Argo CD capability on a zero-pod hub

- **Status:** Proposed
- **Date:** 2026-10-11
- **Deciders:** <platform owner, engineering lead>; only humans set `Accepted`
- **Requirements:** [DEP-01]–[DEP-09], [ZDT-02], [ZDT-03], [NET-01], [OPS-03], [SEC-01], owner requirements O1/O2 ([design.md](../proposal/design.md) intro)
- **Supersedes (if accepted):** the CodePipeline + CodeBuild choice in PROPOSAL.md §3.3

## Context

The owner now requires AWS managed Argo CD and AWS-managed DevOps/GitOps
wherever possible. The EKS Capability for Argo CD runs in AWS-owned
infrastructure, so it costs 0 pods and 0 workload-VPC IPs. It reaches private
clusters by EKS access entry. It has no route into our VPC, so it can read
neither the private GHES nor the private Artifactory; its private sources are
ECR, CodeCommit and CodeConnections.
Customers don't use any of this (ADR-0007).

## Options considered

Weights from docs/05-proposal-brief.md; full table in design.md §3.2.

| Option | Summary | Score /500 |
|---|---|---|
| **A** | **One managed Argo CD on a zero-pod `delivery-hub` cluster in the tooling account, managing dev/nonprod/prod by ARN** | **420** |
| B | A managed Argo CD capability on each workload cluster | 360 |
| C | CodePipeline + in-VPC CodeBuild running `helm upgrade` (PROPOSAL v5) | 425 |

C edges A only because it already has a scripted metric gate. A is
simpler, corrects drift continuously, and is the only option that meets O1/O2.

## Decision

Use **option A**. The managed Argo CD has **no Git source**. Each
environment's desired state is a Helm bundle (`deploy/`): the customer chart,
vendored unchanged, plus that environment's values. After a GHES Environment
approval, the promote workflow packages the bundle, stores it in Artifactory
with build-info (system of record), and copies it by digest to the **private
ECR** under `internal/deploy/`. Argo CD reads only that private ECR copy, by
IAM, tracking the highest bundle version, and deploys to Fargate-only workload
clusters through access entries. GHES and Artifactory stay private, so
CodeConnections isn't needed (owner decision, 2026-10-11).

## Consequences

- Positive: 0 delivery pods or IPs in workload accounts [DEP-07]. Continuous
  drift correction [OPS-03]. Argo CD UI via SSO. No pipelines or rollback
  scripts to own.
- Negative / costs: a `delivery-hub` EKS control plane (~US$73/month) plus
  capability charges *(rates to verify)*. The hub's role is admin on every
  workload cluster. Env-value history lives in Git, but the deployed-state
  history lives in Artifactory builds and ECR tags, not in a deploy repo.
  Argo CD renders with `helm template`, not `helm upgrade`
  (design.md §5.3). There's no automatic metric rollback until the slice-3 gate.
- Follow-ups: verify V1, V3–V5 and V11 (design.md §11). Build the post-sync metric gate
  (Q29). Narrow the hub's access policies.

## Verification

Promote to dev, then confirm: the app is Healthy, `inventory-ip-usage.sh`
shows 0 delivery pods, injected drift is reverted, and re-promoting the
previous version rolls back in < 5 minutes with 0 failed requests under load.

## References

Accessed 2026-10-11, via search results (direct fetch blocked):
- https://docs.aws.amazon.com/eks/latest/userguide/argocd.html
- https://docs.aws.amazon.com/eks/latest/userguide/argocd-considerations.html
- https://docs.aws.amazon.com/eks/latest/userguide/argocd-configure-repositories.html
- https://docs.aws.amazon.com/eks/latest/userguide/argocd-permissions.html
- https://aws.amazon.com/blogs/containers/accessing-private-git-repositories-from-amazon-eks-capability-for-argo-cd/
- https://aws.amazon.com/eks/pricing/
