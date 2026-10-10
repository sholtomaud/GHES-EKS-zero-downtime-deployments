# Requirements

Keywords MUST, SHOULD and MAY follow RFC 2119. Every requirement has a
**verification** column: how we prove it in Phase 2. A proposal must state, for
each MUST, which component satisfies it and how it will be verified.

Priorities: **MUST** = reject the design without it. **SHOULD** = needs a
written reason to omit. **MAY** = nice to have; don't build it unless it's free.

---

## REL: Release artefact

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| REL-01 | Every service image is built once by GHES Actions and published to Artifactory. Promotion never rebuilds. | MUST | Digest in prod equals the digest built in CI (provenance check). |
| REL-02 | Deployments reference images **by digest**, never by mutable tag. | MUST | Admission or pre-deploy lint rejects tag-only refs. |
| REL-03 | A release is a single versioned unit: an OCI Helm chart (or equivalent) that pins all 8 image digests, published to Artifactory. | MUST | One version string identifies the full stack. |
| REL-04 | The release carries an SBOM and build provenance (SLSA-style), and is signed (cosign or Notation). | SHOULD | Signature and attestation verify in the deploy step. |
| REL-05 | The values schema (`values.schema.json` or equivalent) is versioned and validated. Breaking changes need a major version bump. | MUST | Schema validation in CI; semver policy documented. |
| REL-06 | Release notes state migration steps, compatibility with N-1, and rollback limits. | MUST | Template enforced in the release workflow. |

## DEP: Deployment and promotion

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| DEP-01 | Internal environments (dev, nonprod, prod) install the **same release artefact via the same documented interface** as customers. Automation may wrap that interface but must not bypass it. | MUST | Conformance test runs the customer install procedure verbatim. |
| DEP-02 | Promotion dev → nonprod → prod is explicit, recorded (who, what version, when, why) and approval-gated for prod. | MUST | Audit query returns the full promotion history of a release. |
| DEP-03 | A deployment is triggered by a **release decision** (promotion record), not by an image push. | MUST | Pushing an image alone changes nothing in any cluster. |
| DEP-04 | Dev and prod deploy identities are separate, least-privilege and short-lived (OIDC / role assumption; no long-lived keys). | MUST | IAM review; no static credentials in GHES or clusters. |
| DEP-05 | No inbound network path from GHES to production clusters is required, unless explicitly approved. | SHOULD | Network review. |
| DEP-06 | Deployments to the same environment are serialized (no concurrent deploys). | MUST | Concurrency test. |
| DEP-07 | The deploy mechanism adds **≤ 3 resident pods** per cluster (0 preferred). | SHOULD | Pod count. |
| DEP-08 | Time from prod approval to traffic fully on the new version is ≤ 15 minutes for the `standard` profile. | SHOULD | Timed release rehearsal. |
| DEP-09 | The current deployed release per environment is queryable from one place without cluster access. | SHOULD | Dashboard, API or S3/Artifactory query. |

## ZDT: Zero downtime and rollback

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| ZDT-01 | A normal release causes **zero failed user requests** (5xx or connection errors attributable to the release). | MUST | Load test at representative RPS during release; error count = 0. |
| ZDT-02 | Rollback to the previous release has **zero downtime**, completes in ≤ 5 minutes, and is a single, rehearsed command or approval. | MUST | Timed rollback drill under load each quarter: 0 failed requests. |
| ZDT-03 | A failed health check during release aborts automatically and leaves (or returns) traffic on the previous version. | MUST | Fault-injection test with a deliberately broken release. |
| ZDT-04 | The proposal decides **rolling vs blue/green** explicitly, with reasons. If blue/green, it states whether the switch is **per service or whole stack**, based on how coupled the services are (see open questions). | MUST | ADR. |
| ZDT-05 | Database/schema changes follow expand/contract. Release N must run against schema N-1 and N+1 against N. | MUST | Migration CI test: old app on new schema. |
| ZDT-06 | Services shut down gracefully: readiness drops first, in-flight requests drain, and `terminationGracePeriodSeconds` > LB deregistration delay + preStop. | MUST | Chart lint plus release load test. |
| ZDT-07 | On EKS behind an AWS LB, target health is coupled to pod readiness (LBC pod readiness gates or equivalent). | MUST | Chart/namespace config check. |
| ZDT-08 | The new version can be smoke-tested on a non-production route before taking user traffic. | SHOULD | Preview route exists during release. |

## NET: IP and network footprint

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| NET-01 | The `minimal` profile, including EKS control-plane ENIs, nodes, load balancers, VPC endpoints, platform pods, app pods **and peak deployment surge**, consumes **≤ 50 routable VPC IPs**. | MUST | `scripts/inventory-ip-usage.sh` at steady state and mid-release. |
| NET-02 | It must deploy successfully into an account whose VPC has **~80 usable routable IPs** across its subnets, leaving ≥ 30% headroom. | MUST | Deployment into a constrained test VPC. |
| NET-03 | The design states its CNI/IP strategy (e.g. secondary CIDR custom networking, IPv6, Fargate, warm-pool tuning) and quantifies it with the budget model in `03-ip-address-budget.md`. | MUST | Proposal includes the filled budget. |
| NET-04 | No CI runners or build workloads run in workload (dev/nonprod/prod/customer) clusters. | MUST | Pod inventory. |
| NET-05 | Interface VPC endpoints are shared/centralised where the network topology allows, rather than duplicated per cluster. | SHOULD | Network review. |
| NET-06 | One EKS cluster per account/environment unless a requirement forces more. | SHOULD | Inventory. |

## ENV: Environments and profiles

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| ENV-01 | Environment differences are expressed **only** as values (profile + env overrides). No forked manifests per environment. | MUST | Repo structure review; diff between envs is values only. |
| ENV-02 | At least three install profiles: `minimal` (single replica, smallest footprint), `standard`, `ha` (multi-AZ, PDBs, ≥ 2 replicas). | MUST | Each profile passes the conformance suite. |
| ENV-03 | A new internal environment can be stood up from IaC plus one release install in ≤ 1 day by one engineer. | SHOULD | Timed exercise. |
| ENV-04 | Infrastructure (VPC wiring, EKS, IAM, LB, DNS, certificates) is in IaC, separate from the application release. | MUST | IaC repo. Plan/apply in CI. |

## PORT: Customer portability

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| PORT-01 | The release installs on upstream-conformant Kubernetes **without** any of our internal tooling (no Argo CD, Flux, CodePipeline, our Git repos or our AWS accounts). | MUST | Install on kind/k3d in CI with only `helm`/`kubectl`. |
| PORT-02 | Supported targets are verified by CI: EKS plus at least one non-AWS conformant distribution. GKE/ACK/on-prem are documented as supported once tested. | MUST | Conformance matrix. |
| PORT-03 | Cloud-specific integrations (ALB, IAM/Pod Identity, Secrets Manager, ACM, Route 53) are **optional adapters** selected by values. The app itself depends only on Kubernetes primitives and standard protocols. | MUST | Install with all AWS adapters disabled. |
| PORT-04 | Traffic exposure supports Gateway API, with a plain `Service`/Ingress fallback documented. | SHOULD | Conformance on ≥ 2 Gateway implementations. |
| PORT-05 | Customer install and upgrade docs, prerequisites (K8s versions, CPU/mem/storage, network) and a compatibility matrix ship with every release. | MUST | Docs generated/checked in the release workflow. |
| PORT-06 | Air-gapped/private-registry install is possible (images and chart can be mirrored; registry is configurable). | SHOULD | Install from a mirrored registry. |
| PORT-07 | The application has **no hard dependency on any cloud's managed services**. Every such integration (load balancer, certificates, secrets store, telemetry backend, database) is an optional adapter selected by values. | MUST | Install and upgrade with all AWS adapters disabled. |
| PORT-08 | A customer's plain `helm upgrade` (or their own GitOps tool) performs a **zero-downtime rolling upgrade** on any conformant Kubernetes, with no tooling from us. The zero-downtime behaviour lives in the chart and app, not in our pipeline. | MUST | Conformance: load test during `helm upgrade` on kind and a non-AWS distro; 0 failed requests. |

## SEC: Security and compliance

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| SEC-01 | Humans have **read-only** access to workload clusters by default. Write access is break-glass, time-bound and logged. | MUST | EKS access entries/RBAC review; CloudTrail. |
| SEC-02 | Secrets never live in Git or in the release artefact. The app consumes secrets as K8s Secrets/files/env. How they get there is an environment adapter. | MUST | Secret scanning; chart review. |
| SEC-03 | Pods run as non-root with read-only root FS, dropped capabilities and `restricted` Pod Security Standard where feasible. | SHOULD | PSS enforce label on namespace. |
| SEC-04 | Release signature/provenance is verified before deploy in internal environments. | SHOULD | Deploy step fails on an unsigned artefact. |
| SEC-05 | Workload AWS access uses EKS Pod Identity or IRSA. No node-role privilege sprawl. | MUST | IAM review. |

## OBS: Observability

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| OBS-01 | The app emits standard telemetry: Prometheus-format metrics and/or OTLP, structured JSON logs to stdout, health endpoints. Sinks are environment choices. | MUST | Contract test. |
| OBS-02 | Each environment ships telemetry to the backend its platform already provides (e.g. CloudWatch/AMP on AWS, Cloud Logging/GMP on GCP, SLS/ARMS on Alibaba, the customer's stack on-prem) in preference to a self-hosted in-cluster stack. The app and chart are backend-agnostic (OTLP, PromQL-compatible metrics, stdout logs). | SHOULD | Pod inventory; adapter config per platform. |
| OBS-03 | Release health signals (error rate, latency, readiness) are available to the deploy gate in ZDT-03. | MUST | Gate reads them. |
| OBS-04 | In-cluster observability footprint is ≤ 1 DaemonSet + ≤ 2 Deployments, or 0 on Fargate. | SHOULD | Pod inventory. |

## OPS: Operability and lifecycle

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| OPS-01 | Every in-cluster component is listed in a **component register** with its justifying requirement IDs, owner, upgrade cadence and pod/IP cost. | MUST | `docs/component-register.md` in proposal and kept current. |
| OPS-02 | EKS version upgrades follow a documented, rehearsed runbook and stay within standard support (no extended-support fees). | MUST | Runbook; upgrade drill in nonprod. |
| OPS-03 | Drift is prevented (SEC-01) and **detected** (scheduled diff or a reconciler). Detection alerts within 24 h. | MUST | Inject drift and observe the alert. |
| OPS-04 | A single engineer unfamiliar with the platform can perform a release and a rollback from the runbook alone. | SHOULD | Run it with a new team member. |
| OPS-05 | Platform cost (EKS control plane, compute, LBs, endpoints, NAT, observability) per environment is estimated in the proposal and measured after build. | SHOULD | Cost Explorer tags. |

## MIG: Migration

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| MIG-01 | Migration is environment by environment (dev first), with the old platform able to resume each env until decommission. | MUST | Migration plan with rollback per step. |
| MIG-02 | Prod cutover is zero-downtime (DNS/LB-level switch with tested rollback). | MUST | Cutover rehearsal in nonprod. |
| MIG-03 | The old platform's components are fully removed after acceptance, with IP/cost savings measured. | MUST | Before/after inventory. |

## DEV: Local development (proposed)

> **Proposed with [ADR-0003](adr/0003-local-development-workflow.md); not part of
> the contract until a human accepts that ADR.** See
> [proposal/local-development.md](proposal/local-development.md).

| ID | Requirement | Pri | Verification |
|---|---|---|---|
| DEV-01 | A developer starts the local stack (`api`, `agent`, `frontend`) with **one documented, editor-neutral command**. IDE integrations call that command; they don't duplicate it. | MUST | New starter succeeds from the README alone. |
| DEV-02 | Local containers build from the **same Dockerfiles** as released images. Services not being edited run from released images **by digest**. | MUST | CI builds `dev` and `runtime` stages from one file; lint rejects mutable tags in compose. |
| DEV-03 | The shared **dev** database is the default local target. Other targets require an explicit choice, and the active target is always displayed. | MUST | `make dev` with no config connects to dev and prints the target. |
| DEV-04 | Laptop credentials cannot run DDL against shared RDS databases (dev, clean). Clean is read-only from laptops. Schema migrations run locally only against an ephemeral database. | MUST | `CREATE TABLE` as the laptop role fails on dev and clean. |
| DEV-05 | On a managed Windows laptop, clone to running stack takes ≤ 1 hour. | SHOULD | Timed onboarding with a new team member. |
| DEV-06 | No database credentials in Git or images. Human DB access is short-lived and attributable to a person. | MUST | Secret scanning; IAM/DB role review. |
| DEV-07 | The local workflow needs no paid container-desktop licence. | SHOULD | Onboarding doc lists no paid tool. |

---

## Acceptance criteria for the whole programme

The new platform is accepted when, in nonprod and then prod:

1. NET-01 and NET-02 are demonstrated with measured numbers.
2. A release under load completes with zero failed requests (ZDT-01).
3. A deliberately broken release auto-aborts (ZDT-03) and a rollback completes in ≤ 5 min (ZDT-02).
4. The same release installs on kind/k3d and a second distribution with only `helm`/`kubectl` (PORT-01/02).
5. The component register shows no component without a requirement (OPS-01).
6. Before/after comparison of IPs, pod count, monthly cost, deploy time and recovery time is published (MIG-03, OPS-05).
