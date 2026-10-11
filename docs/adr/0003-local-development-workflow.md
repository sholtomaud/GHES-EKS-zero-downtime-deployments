# ADR-0003: Local development: one `make dev` across the three repos, generated data by default

- **Status:** Proposed
- **Date:** 2026-10-10
- **Deciders:** <engineering lead, platform owner, a representative developer>; only humans set `Accepted`
- **Requirements:** [DEV-01]–[DEV-08] (proposed), [ZDT-05], [SEC-02], [NET-01]

## Context

Developers work on Windows laptops and need to run the `api`, `agent` and
`frontend` containers locally in VS Code. There are two Postgres databases on
RDS in the dev account: a shared **dev** database and a **clean** reference
database. Docker Desktop needs a paid
licence at our size. No existing requirement covers local development, so
DEV-01..08 are proposed alongside this ADR.

Laptops are on an always-on VPN that routes to the dev VPC. The dev database
holds "dirty" test data: samples of actual data, no PII. Clean holds real data.
GHES and Artifactory run on EC2 in our tooling account.

Full analysis: [docs/proposal/local-development.md](../proposal/local-development.md).

## Options considered

Weights: parity 20, WSL friction 20, editor-neutral 15, onboarding 15,
reproducibility 15, maintenance 10, licence 5 (total /500).

| Option | Summary | Score |
|---|---|---|
| A | Compose per service repo, others as pinned images | 375 |
| B | Dev Container | 340 |
| C | VS Code tasks only | 255 |
| D | Local Kubernetes (kind + Tilt/Skaffold) | 335 |
| **E** | **Shared stack in `api`: one `compose.yaml` builds all three repos from source; `make dev` from any repo; VS Code multi-root workspace + tasks** | **440** |
| F | Hosted dev environments (Coder/Gitpod) | 390 |

## Decision

1. Developers use **WSL2 (Ubuntu 24.04) with rootless Podman**, VS Code on
   Windows, and source in the WSL filesystem.
2. **One `make dev` runs all three services from source.** The `api`, `agent`
   and `frontend` repos stay separate, cloned side by side. `api` holds the
   stack (`compose.yaml`, `Makefile`, `app.code-workspace`, scripts) and builds
   each repo's `dev` Dockerfile stage from the sibling checkouts, with hot
   reload and watch-rebuild. `agent` and `frontend` forward `make dev` to it.
   VS Code opens the three repos as one multi-root workspace, and its tasks
   call `make`. There's no Dev Container.
3. Local stacks run against a **local Postgres populated by a deterministic
   seed-generator script by default**, configured by a gitignored
   `./.env.local` that holds local-database settings only. No data files are kept in the repo.
   That's the only place local code runs migrations.
   **`make dev DB=dev`** runs a script that uses the developer's AWS login to
   fetch the URL and password from Secrets Manager. It passes them straight
   into the `api`/`agent` containers' environment, with nothing written to disk,
   and connects them to the **shared dev RDS with the dirty test data** using a
   DML-only role. Dev holds no PII but does hold samples of actual data (Q28),
   so it's used in place and never copied off. Every start prints the target.
4. **Clean (real data) is query-only from laptops.** Access is by named people
   with IAM-only logins and a SELECT-only role, audited with pgaudit. App
   containers never target it, and no tooling dumps it. Nothing is ever copied
   from clean.
5. Laptops reach RDS **directly on tcp/5432** over the always-on VPN. Each
   RDS security group allows only the VPN client pool. TLS is enforced.
   RDS is never publicly accessible.

## Consequences

- Positive: one way to run the stack, in any editor or in CI. No paid desktop
  licence. Shared dev can't be broken by a branch migration. Expand/contract
  violations show up on the laptop.
- Negative / costs: rootless Podman + compose watch under WSL is less trodden
  than Docker Desktop, and needs a laptop spike first (slice 1). All three
  services build in dev mode on every laptop. There are 2 extra
  IPs in the dev account (two RDS instances). The DB port is reachable from
  the VPN pool, so authentication and grants carry the access control. Someone owns
  the seed generator and keeps it in step with migrations.
- Follow-ups: get the VPN client pool CIDR from the network team at build time. Move DEV-* from proposed to the contract on acceptance.

## Verification

See the traceability table in the proposal §7. Key checks: a new starter
reaches a running stack in < 1 h on a managed Windows laptop, and `CREATE TABLE`
as each laptop role fails on dev and clean, a password login to clean fails, and
a `SELECT` on clean appears in the audit log under a person's name.

## References

Accessed 2026-10-10. Direct fetches of vendor docs were blocked from the
authoring environment, so these come from search results. Re-verify in slice 1.

- RDS IAM database authentication (15-minute token, < 200 new connections/s guidance): https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html
- Docker Desktop licence (paid above 250 employees or US$10M revenue): https://docs.docker.com/subscription/desktop-license/
