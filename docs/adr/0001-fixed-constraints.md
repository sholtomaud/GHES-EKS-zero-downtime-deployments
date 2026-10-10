# ADR-0001: GHES, Artifactory and EKS are fixed constraints

- **Status:** Accepted
- **Date:** 2026-10-10
- **Deciders:** Product/platform owner
- **Requirements:** all

## Context

The deployment and reconciliation process is being redesigned. To keep the
redesign bounded, some parts of the toolchain are deliberately out of scope.

## Decision

1. **GitHub Enterprise Server + GitHub Actions** remains the source control,
   build and test system.
2. **JFrog Artifactory** remains the registry for container images and release
   artefacts (including OCI Helm charts).
3. **Amazon EKS** remains the Kubernetes runtime in our own AWS accounts.

Everything between "artefact in Artifactory" and "traffic served by the new
version", plus the in-cluster platform components, is open for redesign.

## Consequences

- Proposals must not replace these (no ECS, ECR-as-primary, GitLab and so on).
  ECR pull-through caches *of* Artifactory MAY be considered as an adapter if
  justified.
- Customer environments aren't bound by the EKS constraint. See ADR-0002.
