# ADR-0003: Local development via compose, `make`, and a Dev Container, against the shared dev database

- **Status:** Proposed
- **Date:** 2026-10-10
- **Deciders:** <engineering lead, platform owner, a representative developer>; only humans set `Accepted`
- **Requirements:** [DEV-01]–[DEV-07] (proposed), [ZDT-05], [SEC-02], [NET-01]

## Context

Developers work on Windows laptops and need to run the `api`, `agent` and
`frontend` containers locally in VS Code. There are two Postgres databases on
RDS in the dev account: a shared **dev** database and a **clean** reference
database. We want developers to use dev by default. Docker Desktop needs a paid
licence at our size. No existing requirement covers local development, so
DEV-01..07 are proposed alongside this ADR.

Full analysis: [docs/proposal/local-development.md](../proposal/local-development.md).

## Options considered

Weights: parity 20, WSL friction 20, editor-neutral 15, onboarding 15,
reproducibility 15, maintenance 10, licence 5 (total /500).

| Option | Summary | Score |
|---|---|---|
| A | Makefile + compose; toolchain installed in WSL | 375 |
| B | Dev Container only | 360 |
| C | VS Code tasks only | 255 |
| D | Local Kubernetes (kind + Tilt/Skaffold) | 335 |
| **E** | **Hybrid: `compose.yaml` single definition, `make` entry point, Dev Container built on the same compose, tasks wrap `make`** | **420** |
| F | Hosted dev environments (Coder/Gitpod) | 390 |

## Decision

1. Developers use **WSL2 (Ubuntu 24.04) with rootless Podman**, VS Code on
   Windows, and source in the WSL filesystem.
2. **`compose.yaml` is the only runtime definition.** `make dev` is the
   canonical entry point. A Dev Container built from the same compose file
   supplies the pinned toolchain. VS Code tasks only call `make` targets.
3. Local stacks connect to the **dev RDS by default** using a DML-only role.
   They connect to **clean read-only**. They run **migrations only against an
   ephemeral local Postgres**. Laptops reach RDS over an existing corporate
   route or SSM port forwarding, never a public endpoint.

## Consequences

- Positive: one way to run the stack, in any editor or in CI. No paid desktop
  licence. Shared dev can't be broken by a branch migration. Expand/contract
  violations show up on the laptop.
- Negative / costs: Podman + Dev Containers on Windows is less trodden than
  Docker Desktop, and needs a laptop spike first (slice 1). There are 2–3 extra
  IPs in the dev account (two RDS instances, optional tunnel host). Someone owns
  the dev-reset job.
- Follow-ups: add RDS ENIs to the main IP budget (PROPOSAL.md §3.6). Answer
  Q21–Q25. Move DEV-* from proposed to the contract on acceptance.

## Verification

See the traceability table in the proposal §7. Key checks: a new starter
reaches a running stack in < 1 h on a managed Windows laptop, and `CREATE TABLE`
as the laptop role fails on dev and clean.

## References

Accessed 2026-10-10. Direct fetches of vendor docs were blocked from the
authoring environment, so these come from search results. Re-verify in slice 1.

- RDS IAM database authentication (15-minute token, < 200 new connections/s guidance): https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html
- Session Manager port forwarding to a remote host: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html
- Docker Desktop licence (paid above 250 employees or US$10M revenue): https://docs.docker.com/subscription/desktop-license/
- VS Code Dev Containers, alternate engines (Podman): https://code.visualstudio.com/remote/advancedcontainers/docker-options *(verify)*
