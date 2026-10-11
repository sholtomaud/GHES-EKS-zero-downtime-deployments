# infra: CDK Terrain → OpenTofu

The AWS infrastructure for our own accounts, in [CDK Terrain](https://cdktn.io/docs)
(cdktn) TypeScript, synthesised to **OpenTofu ≥ 1.13** root modules. Design:
[docs/proposal/design.md](../docs/proposal/design.md) §9, [ADR-0005](../docs/adr/0005-iac-cdk-terrain-opentofu.md).
**Proposed**: nothing here should be applied until ADR-0004 and ADR-0005 are accepted.

## Run it

From the repo root. The Makefile uses Apple `container` on macOS and Docker on
Linux/CI. `CONTAINER=none` uses host tools instead (Node ≥ 22.18, OpenTofu ≥ 1.13,
`cdktn`, `tsgo`; check with `make CONTAINER=none doctor`).

| Command | Does |
|---|---|
| `make image` | Build the toolchain image (`Containerfile`) |
| `make deps` | `npm ci` into `infra/node_modules` |
| `make test` / `make coverage` | Unit tests (hermetic: no AWS, no network) |
| `make typecheck` | TypeScript 7 (`tsgo -p .`) |
| `make synth` | `cdktn synth` → `infra/cdktn.out/tofu/<stack>/*.tf`; fails on any cdktn `[ERROR]` |
| `make validate` | synth, then `tofu init -backend=false`, `validate` and `fmt -check` per stack |
| `make plan STACK=workload-dev` | `tofu plan` (needs AWS credentials for that account, and `TF_TOKEN_<artifactory_host>` for the state, e.g. `TF_TOKEN_artifactory_example_internal`) |
| `make ci` | Everything CI runs |

## Layout

| Path | What |
|---|---|
| `src/config.ts` | Accounts, VPCs, environments. **PLACEHOLDER IDs**: replace before planning. |
| `src/stacks/tooling-stack.ts` | Tooling account: GHES OIDC roles for the existing ECR, CodeConnections, delivery hub, managed Argo CD |
| `src/stacks/workload-stack.ts` | Each workload account: Fargate-only EKS, access, LB controller IRSA, logs, TLS |
| `src/stacks/base.ts` | Backend, provider, naming (`snake_case`, `name:qualifier`), `Group` = output file |
| `src/layout.ts` | Splits each stack into `terraform.tf`, `backend.tf`, `providers.tf`, `locals.tf`, `<group>.tf` |
| `src/ip-budget.ts` | The IP budget as a tested function [NET-01/02] |
| `test/` | Specs: requirements and layout rules |
| `cdktn.out/tofu/<stack>/` | **Generated** OpenTofu. Plan and apply here. (`cdktn.out/stacks/` is cdktn's own JSON, for its CLI.) |

## Working test-first

1. Add or change a test in `test/` that states the requirement. Cite the ID, e.g. `[SEC-01]`.
2. `make test` and watch it fail.
3. Change `src/` until it passes. Then run `make validate`.

A new resource goes in a `Group` (one output file per concern), and its
construct id becomes its Terraform name. Use `name:qualifier` when two
resources of different types share a name.

`cdktn synth` must log no `[ERROR]` lines: `scripts/synth.sh` fails the build if
it does. The cdktn CLI probes the engine with `tofu -v`, which OpenTofu rejects,
so cdktn calls `scripts/tofu-cdktn`, a 3-line shim that maps `-v` to `-version`.
