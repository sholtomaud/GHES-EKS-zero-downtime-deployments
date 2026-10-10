# Instructions for LLM agents

You are helping replace an over-built deployment platform with a lean one.
Read `README.md`, then everything in `docs/` in numeric order, before you
produce anything.

## Your role, by phase

| Phase | You may | You must not |
|---|---|---|
| 0 Discover | Run read-only commands the humans hand you output from; write findings to `docs/discovery/`. | Invent measurements. Missing data goes in `docs/06-open-questions.md`. |
| 1 Propose | Write `docs/proposal/` and `docs/adr/NNNN-*.md` with status `Proposed`. | Write implementation code, Terraform, charts, workflows. |
| 2 Build | Implement only what accepted ADRs and the approved proposal describe. | Add components that no requirement asks for. |
| 3 Migrate | Write runbooks and cutover plans, and execute them only when a human tells you to. | Touch production without an explicit human go-ahead for that step. |

The gate between phases 1 and 2 is a human changing ADR status to `Accepted`.
Do not change that status yourself.

## Ground rules

1. **Requirements are the contract.** Every component you propose must trace to
   one or more requirement IDs in `docs/02-requirements.md`. If you want
   something no requirement justifies, say so explicitly and argue for it, or
   leave it out. The current platform failed precisely because components were
   added "because best practice".
2. **Fixed constraints are fixed.** GHES, Artifactory and EKS are not up for
   debate (ADR-0001). Do not propose ECS, App Runner, GitLab, ECR-as-primary, etc.
3. **Count IPs.** Every proposal must include a filled-in IP budget using the
   model in `docs/03-ip-address-budget.md`, for the `minimal` profile at steady
   state *and* at peak deployment surge. A design that doesn't fit an 80-IP
   account is rejected, however elegant it is.
4. **The customer artefact is the product.** Internal environments must deploy
   the *same* artefact customers get, through the same documented interface.
   Internal tooling may automate that interface, but it must not replace it.
5. **Prefer managed and boring over clever.** Each in-cluster controller is a
   cost: pods, IPs, CRDs, upgrades, CVEs, on-call knowledge. A managed AWS
   feature or a 50-line script beats a controller unless the controller
   demonstrably earns its keep.
6. **Verify against current docs.** AWS, EKS and Kubernetes features move fast.
   Anything marked *(verify)* in these docs, and any feature you rely on that
   GA'd after 2023, must be checked against current official documentation.
   Cite the doc URL in the proposal. If you cannot verify something, label it
   an assumption.
7. **No `latest`.** Deploy by immutable digest. Always.
8. **Ask, don't assume,** on anything in `docs/06-open-questions.md` that changes
   the design. Make your assumption explicit and show how the design changes if
   it's wrong.

## Output conventions

- Markdown, one topic per file, Mermaid for diagrams.
- ADRs use `docs/adr/template.md`. Number sequentially and never renumber.
- Requirement references look like `[DEP-03]`.
- When you score options, show the scoring table and the weights. Don't just
  announce a winner.
- Keep prose plain and short. Tables over paragraphs where it helps.
