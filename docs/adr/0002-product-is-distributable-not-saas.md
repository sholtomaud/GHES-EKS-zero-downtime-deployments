# ADR-0002: The product is a distributable application, not SaaS

- **Status:** Accepted
- **Date:** 2026-10-10
- **Deciders:** Product/platform owner
- **Requirements:** DEP-01, PORT-01..06, OPS-01

## Context

The current platform was designed around a multi-tenant SaaS future that the
business no longer pursues. Customers want to run the application in their own
environments (EKS, other Kubernetes, other clouds, on-prem). The SaaS-oriented
platform (Argo CD, ARC, in-cluster Prometheus stack, many add-ons) is a
superset of what the product needs, and it doesn't fit in IP-constrained
accounts.

## Decision

1. The **release artefact** (versioned, signed, digest-pinned) is the product.
2. Our own environments are treated as **the first customer**: they install the
   same artefact through the same documented interface (DEP-01).
3. Internal delivery tooling is an **automation of** that interface. It is never
   a runtime dependency of the application and never shipped to customers.
4. Every in-cluster component must be justified by a requirement and recorded
   in the component register (OPS-01).

## Consequences

- Customer install and upgrade are tested on every release, not just at sales time.
- Environment drift becomes a values diff, not a manifests fork.
- Some current conveniences (Argo CD UI, in-cluster dashboards) go away unless
  a requirement brings them back.
