# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-fixed-constraints.md) | GHES, Artifactory and EKS are fixed constraints | Accepted |
| [0002](0002-product-is-distributable-not-saas.md) | The product is a distributable application, not SaaS | Accepted |
| [0003](0003-local-development-workflow.md) | Local development: one `make dev` across the three repos, generated data by default | Proposed |
| [0004](0004-delivery-via-eks-managed-argocd.md) | Deliver to our EKS accounts with the EKS managed Argo CD capability on a zero-pod hub | Proposed |
| [0005](0005-iac-cdk-terrain-opentofu.md) | IaC in CDK Terrain, synthesised to OpenTofu ≥ 1.13, test-first, containerised | Proposed |
| [0006](0006-fargate-logging-and-debugging.md) | Logs from Fargate's built-in router to CloudWatch Logs, class per environment | Proposed |
| [0007](0007-customer-distribution-via-ecr.md) | Customers pull GA releases from ECR `release/*` | Proposed |

New ADRs use [template.md](template.md). Agents may create ADRs with status
`Proposed`. Only humans move an ADR to `Accepted`.
