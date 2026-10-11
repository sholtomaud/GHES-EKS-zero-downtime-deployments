# Deploy repo template (GitOps desired state)

Template for the **`app-deploy` repository on GHES** that the managed Argo CD
(EKS Capability, in the tooling account) reads through AWS CodeConnections.
It lives here so the design can be reviewed in one place; copy it into its own
repo at build time. See [design.md](../docs/proposal/design.md) §5 and
[ADR-0004](../docs/adr/0004-delivery-via-eks-managed-argocd.md).

| Path | What | Changed by |
|---|---|---|
| `bootstrap/root.yaml` | App-of-apps on the hub. Applied once by hand. | Platform engineer, rarely |
| `clusters/<env>.yaml` | Registers each workload cluster by EKS ARN | IaC change (new environment) |
| `environments/<env>/app.yaml` | The application: chart from ECR + this env's values. `targetRevision` is the release. | **Only the promote workflow** (`.github/workflows/app-promote.yml`) |
| `environments/<env>/values.yaml` | Env differences, as values only [ENV-01] | Reviewed PR |
| `environments/<env>/platform.yaml` | LB controller + Fargate log router | Reviewed PR |

Rules:

- Humans never `kubectl apply` to workload clusters (read-only access) [SEC-01].
- A release reaches an environment only by a commit from the promote workflow,
  after its GHES Environment approval [DEP-02] [DEP-03].
- Rollback = promote the previous version (or `git revert` the promotion commit).
  Argo CD rolls it out as a normal rolling update [ZDT-02].
- Customers never see this repo. They install the same chart with Helm from
  ECR `release/*` [DEP-01] [PORT-01].

Values marked PLACEHOLDER, and anything marked *(verify)*, are confirmed in slice 2.
