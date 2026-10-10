# GHES → Artifactory → EKS: lean, zero-downtime delivery

This repository is the **requirements and decision pack** for replacing our
current deployment platform (Argo CD + Actions Runner Controller + in-cluster
Prometheus stack + many add-ons) with something proportionate to what we
actually run: **8 application containers, < 10,000 users, a handful of
internal customers, and no SaaS obligation.**

It is written so that a human *or* an LLM coding agent can pick it up cold,
propose a solution, and, after approval, build it.

## The problem in one paragraph

The current stack consumes ~130 VPC IP addresses to run 8 application
containers. Some of our AWS accounts only have ~80 usable IPs, so the platform
literally does not fit. We also deploy the same product into dev, nonprod, prod
and several customer-controlled environments, each one a slightly different
snowflake. The platform was designed six years ago on the assumption that the
product would become multi-tenant SaaS. It won't. Customers want to **run the
application**, not adopt our GitOps platform.

## What is fixed and what is open

| Fixed (do not re-litigate) | Open (the design space) |
|---|---|
| GitHub Enterprise Server (GHES) + GitHub Actions for build and test | How releases get from Artifactory into clusters |
| JFrog Artifactory as the artefact and image registry | How clusters are reconciled and how drift is handled |
| Amazon EKS as the runtime in *our* AWS accounts | Blue/green vs rolling, and the traffic-switch mechanism |
| | Node/compute model, CNI and IP strategy |
| | Observability, secrets, TLS and DNS approach |
| | What we hand to customers and how they install it |

See [ADR-0001](docs/adr/0001-fixed-constraints.md).

## How to read this repo

| Doc | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | Operating instructions for an LLM agent working here. Read first if you are one. |
| [docs/00-review-of-prior-discussion.md](docs/00-review-of-prior-discussion.md) | Review of the earlier ChatGPT conversation: what holds up, what was wrong or missing. |
| [docs/01-context-and-problem.md](docs/01-context-and-problem.md) | Current state, environments, stakeholders, problem statement, non-goals. |
| [docs/02-requirements.md](docs/02-requirements.md) | Numbered, testable requirements (RFC 2119). **The contract.** |
| [docs/03-ip-address-budget.md](docs/03-ip-address-budget.md) | Where VPC IPs really go on EKS, the budget model, and how to measure. |
| [docs/04-solution-space.md](docs/04-solution-space.md) | Candidate options per decision, with known trade-offs. Not decisions. |
| [docs/05-proposal-brief.md](docs/05-proposal-brief.md) | Exactly what the proposal must contain, and its template. |
| [docs/06-open-questions.md](docs/06-open-questions.md) | Facts we still need from humans. |
| [docs/adr/](docs/adr/) | Architecture Decision Records: accepted and proposed decisions. |
| [scripts/inventory-ip-usage.sh](scripts/inventory-ip-usage.sh) | Phase 0 tool: break down IP consumption in an existing VPC/cluster. |

## Delivery phases

```
Phase 0  Discover   measure today's platform (IPs, pods, cost, deploy flow)     → docs/discovery/
Phase 1  Propose    design doc + ADRs + IP budget + scored options               → docs/proposal/
   ── human approval gate ──
Phase 2  Build      release artefact, deploy mechanism, envs, conformance tests → this repo
Phase 3  Migrate    parallel run, cut over env by env, decommission old stack
```

Nothing past Phase 1 starts without a recorded approval (an ADR moved to
`Accepted`).
