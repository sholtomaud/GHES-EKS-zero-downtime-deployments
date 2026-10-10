# Context and problem statement

## The product

- An application of **8 containers** (services), serving **< 10,000 users**.
- A handful of **internal customers**. **No paying external customer yet.**
- Originally planned (about 6 years ago) as multi-tenant SaaS. **That's no longer
  the strategy.** The product is something customers *run*: in our AWS
  accounts, in their own AWS accounts, or on other Kubernetes (GKE, Alibaba
  Cloud ACK, on-prem).

## The current platform (as understood, to be confirmed in Phase 0)

- **EKS** clusters in several AWS accounts.
- **Argo CD** for GitOps reconciliation.
- **ARC** (Actions Runner Controller, assumed) running GHES self-hosted runners
  as pods.
- **Prometheus stack** and a long tail of add-ons and plugins.
- Built on consultant advice premised on a SaaS future.

Observed outcome: **~130 VPC IPs consumed** for 8 application containers.
Some accounts only have **~80 usable IPs**, so the platform cannot be
deployed there at all.

## Environments

| Environment | Owner | Who deploys | Notes |
|---|---|---|---|
| dev | us | us | High change rate |
| nonprod / test / staging | us | us | Pre-prod validation |
| prod | us | us | Internal customers' production |
| customer-hosted (AWS) | customer | **customer**, with their own tooling | Their account, their rules. No CI/CD from us. |
| customer-hosted (GKE / Alibaba / on-prem K8s) | customer | **customer**, with their own tooling | No AWS services available. No CI/CD from us. |

Each of these currently drifts into its own variant. **Goal: one product,
one release artefact, a small set of documented install profiles, and
environment differences expressed only as configuration values.**

## Fixed constraints

See [ADR-0001](adr/0001-fixed-constraints.md).

1. **GHES + GitHub Actions** builds and tests.
2. **Artifactory** stores images and release artefacts.
3. **EKS** is the runtime in our accounts.

## Problem statement

> Our delivery platform costs more in IPs, components, upgrades and cognitive
> load than the product it delivers. It doesn't fit in some of our own
> accounts, it can't be handed to customers, and every environment has
> diverged. We need a delivery and reconciliation approach that is
> proportionate to 8 containers, fits in an 80-IP account with headroom,
> deploys with zero downtime, and ships the same artefact to us and to
> customers.

## Goals

1. Fit comfortably in an 80-IP account, with deployment surge included.
2. Zero-downtime releases and fast, rehearsed rollback.
3. One release artefact, used identically by internal environments and
   customers.
4. Auditable, approved promotion from dev → nonprod → prod.
5. Fewer moving parts: every in-cluster component justified by a requirement.
6. Operable by a small team without specialist platform knowledge.

## Non-goals

- Multi-tenant SaaS, a self-service internal developer platform, or a
  service mesh.
- Supporting customers who don't run Kubernetes. *(Open question: confirm.)*
- Replacing GHES, Artifactory or EKS.
- Building a custom Kubernetes controller/operator. Only if nothing else meets
  a MUST requirement, and only with an ADR.

## Glossary

| Term | Meaning here |
|---|---|
| Release | An immutable, versioned, signed bundle: chart + image digests + metadata. |
| Profile | A documented set of values for a class of environment (`minimal`, `standard`, `ha`). |
| Promotion | Recording that a specific release is approved for a specific environment. |
| Reconciliation | Making the cluster match the recorded release, by push or by pull. |
| Drift | Any difference between the cluster and the recorded release. |
| Blue/green | Two complete versions running side by side, with an atomic traffic switch. |
| Routable IP | An IP from the VPC's primary (scarce, corporate-routed) CIDR. |
