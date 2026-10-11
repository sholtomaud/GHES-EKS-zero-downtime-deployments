# ADR-0005: Infrastructure as code in CDK Terrain, synthesised to OpenTofu ≥ 1.13, test-first, containerised

- **Status:** Proposed
- **Date:** 2026-10-11
- **Deciders:** <platform owner>; only humans set `Accepted`
- **Requirements:** [ENV-03], [ENV-04], [NET-01]–[NET-03], [OPS-01], [OPS-02]; answers Q12

## Context

Q12 (which IaC tool) was open. The owner chose CDK Terrain (cdktn), the
community successor to the deprecated HashiCorp CDKTF. It generates OpenTofu,
must use OpenTofu ≥ 1.13, and must be developed test-first. It runs from one
container image on macOS (Apple `container`) and in GitHub Actions (Docker).
The synthesised output must look like a hand-written root module, not one
1,000-line file.

## Options considered

| Option | Summary | Notes |
|---|---|---|
| **cdktn (TypeScript) → OpenTofu** | Typed constructs, unit tests on synthesised output | Owner's choice. Prebuilt `@cdktn/provider-aws`. |
| Plain OpenTofu HCL + `tofu test` | No codegen | Weaker reuse across 4 stacks; less natural test-first |
| AWS CDK / CloudFormation | — | Not OpenTofu |

## Decision

1. `infra/` is a cdktn TypeScript app. There is **one stack per AWS account**
   (`tooling`, `workload-<env>`), each with its own S3 state and native lockfile.
2. Every stack declares `required_version >= 1.13.0`. `cdktf.json` targets
   `opentofu >= 1.13.0`, so cdktn's feature validations apply.
3. `cdktn synth` also writes conventional root modules to
   `cdktn.out/tofu/<stack>/` (`terraform.tf`, `backend.tf`, `providers.tf`,
   `locals.tf`, one `<concern>.tf` per construct group, `policies/*.json`),
   `tofu fmt`-ed. Plan and apply run from there.
4. Tests come first (`node:test`). They assert requirements and the layout
   rules. `make validate` adds `tofu validate` and `fmt -check`.
5. The toolchain is a pinned `Containerfile` (Node 24, OpenTofu 1.13.1,
   cdktn-cli 0.24.0, TypeScript 7 `tsgo`), driven by `make`. `CONTAINER=none`
   runs on host tools.

## Consequences

- Positive: requirements are executable (the IP budget is a tested function).
  The output is reviewable as normal HCL. Mac and CI run identical steps.
- Negative / costs: our layout step (`src/layout.ts`, about 250 lines) works
  around the young cdktn HCL renderer and has to be kept working across cdktn
  upgrades. Its tests guard it. The prebuilt AWS provider package is large
  (~480 MB unpacked).
- Follow-ups: a plan-on-PR / apply-after-approval job (GHES OIDC role per
  account). Re-check cdktn behaviour via its docs MCP server (`.mcp.json`),
  which was blocked from the authoring environment.

## Verification

`make ci` is green locally and in `.github/workflows/infra.yml`: typecheck,
69 tests, synth, and `tofu validate` for all 4 stacks on OpenTofu 1.13.1.

## References

- cdktn 0.24.0, cdktn-cli 0.24.0, @cdktn/provider-aws 25.7.2 (hashicorp/aws 6.68.0): npm registry, 2026-10-11
- https://cdktn.io/docs (MCP: https://cdktn.io/docs/mcp)
- OpenTofu v1.13.1 release: https://github.com/opentofu/opentofu/releases/tag/v1.13.1
