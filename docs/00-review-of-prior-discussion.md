# Review of the prior ChatGPT discussion

This is an independent review of an earlier conversation about this problem.
It records what to keep, what to correct, and what was missing, so later
proposals don't inherit the gaps.

## Verdict

The direction is right: separate the *engineering platform* from the
*product*, deploy immutable digests, make production promotion explicit, and
drop the continuously running GitOps controller unless it earns its place.
But the conversation stayed generic exactly where this problem is specific.
It never explained where 130 IPs actually go, it skipped a factual question
about CodeDeploy, and it didn't connect the IP problem to the compute and
networking choices that would solve it.

## What holds up (keep)

| Point | Why it's right |
|---|---|
| Internal platform ≠ product | The core insight. Customers buy a runnable application, not our operating model. |
| Build once, promote the same digest | Non-negotiable for reproducibility, rollback and audit. |
| Never deploy `latest` | Mutable tags make "what is running?" unanswerable. |
| GitOps is optional in production | Correct. Continuous reconciliation matters only if drift is a real threat. Prevention (no human write access) is cheaper than correction. |
| Rolling updates may be enough | True, and often overlooked. See below for what "done right" means on ALB. |
| Zero downtime is mostly an app property | Correct. Backward-compatible DB migrations and graceful shutdown matter more than the controller. |
| Run an experiment with acceptance criteria | Correct framing. It's the basis of Phase 0/1 here. |
| GHES calls `StartPipelineExecution` explicitly | A sound trigger pattern: the *release decision* triggers deployment, not the image push. |

## What was wrong or evasive (correct)

1. **CodeDeploy cannot deploy to EKS.** You asked directly and the answer
   slid over to CodePipeline. CodeDeploy's compute platforms are EC2/on-prem,
   Lambda and ECS. Its blue/green-with-ALB feature exists for ECS, not EKS.
   On EKS, blue/green traffic shifting comes from the load balancer layer
   (AWS Load Balancer Controller weighted target groups, or Gateway API
   weighted routes) or from a rollout controller. *(verify: still true as of
   the proposal date)*
2. **"ARC" was never identified.** In a GHES context, ARC is almost certainly
   **Actions Runner Controller**: self-hosted GitHub Actions runners running
   *as pods inside EKS*. That matters a great deal. Runner pods, listener pods
   and Docker-in-Docker sidecars each consume VPC IPs, scale with CI load, and
   have no business in a production or customer workload account. Moving CI
   runners out of workload clusters may be the single largest IP win.
3. **Prefix delegation was offered as an IP fix. In small subnets it often
   makes things worse.** Prefix delegation allocates /28 blocks (16 IPs) per
   slot. It raises *pod density per node*, but it reserves IPs in chunks and
   needs contiguous free /28s, which fragmented small subnets often don't have.
   In an 80-IP account the levers that work are a **secondary non-routable
   CIDR for pods** (custom networking), **IPv6**, **tight warm-pool settings**,
   **Fargate**, and **fewer pods**.
4. **CodePipeline's EKS action was oversold as a deployment system.** It
   applies manifests or Helm charts to a cluster, including private clusters,
   which is genuinely useful. But it is not a rollout controller: no blue/green
   traffic shifting, no analysis, no automatic rollback beyond what Helm or your
   own scripts do. Artifactory is also not a native CodePipeline source, so you
   need an S3 manifest source, pipeline variables, or a pull step, plus network
   egress from AWS build compute to Artifactory.

## What was missing (add)

### The IP accounting

130 IPs for 8 containers isn't explained by "warm pools" alone. The usual
consumers are:

- **VPC CNI warm pool.** The default `WARM_ENI_TARGET=1` keeps an entire spare
  ENI's worth of IPs per node, on top of the unused ones on the current ENI
  (for example ~14 spare IPs per m5.xlarge). Three nodes can mean 30–45 idle IPs.
- **Platform pods.** Argo CD (~7 pods), kube-prometheus-stack (~6 plus
  per-node exporters), ARC (controller, listeners, runners), cert-manager (3),
  external-dns, AWS LBC (2), CoreDNS (2), metrics-server, autoscaler and so on.
  Easily 30–60 pods, against 8 for the app.
- **Non-pod ENIs.** ALBs (at least 1 per AZ, scaling up to ~8 per AZ), NLBs,
  EKS control-plane cross-account ENIs (2–4), **interface VPC endpoints**
  (1 IP per endpoint per AZ: ECR api/dkr, STS, logs, SSM and so on, which can
  be 20–30 IPs in a 3-AZ private cluster), NAT gateways, and node primary IPs.
- **Multiple clusters per account**, each paying the fixed overhead again.

`docs/03-ip-address-budget.md` turns this into a budget, and
`scripts/inventory-ip-usage.sh` measures it.

### Compute/networking options that dissolve the problem

- **Secondary CIDR (100.64.0.0/10) + VPC CNI custom networking.** Pods take
  IPs from a non-routable range; only nodes, load balancers and endpoints use
  scarce routable IPs. This is AWS's standard answer to IP exhaustion, and it
  probably fixes the 80-IP accounts outright.
- **EKS Auto Mode.** AWS runs compute, VPC CNI, load balancing, EBS CSI and
  more as managed components, with fewer in-cluster system pods and less
  upgrade toil. *(verify: pod-subnet / secondary-CIDR support in the Auto Mode
  NodeClass, and current pricing premium)*
- **Fargate.** Exactly one IP per pod, no warm pool, no DaemonSets. For 8
  stateless containers it is arguably the most IP-efficient option. Trade-offs:
  no DaemonSets, no EBS volumes, slower pod start, per-pod pricing.
- **IPv6 clusters.** These eliminate pod IP exhaustion, but depend on
  enterprise network and customer readiness.

### Zero downtime on ALB specifically

Rolling updates behind an ALB drop requests unless you handle the
target-registration race:

- AWS LBC **pod readiness gates**, so a pod isn't "Ready" until the ALB target
  is healthy.
- A `preStop` delay plus `terminationGracePeriodSeconds` that exceeds the ALB
  **deregistration delay**, so in-flight requests drain.
- `maxUnavailable: 0`, a `PodDisruptionBudget`, and readiness probes that test
  real dependencies.
- **Expand/contract** database migrations, so N and N+1 run against the same
  schema.

### Portability in 2026

- **Gateway API** is now the portable traffic API across EKS (AWS LBC has
  Gateway API support), GKE, Alibaba and on-prem (Envoy Gateway, Cilium, NGINX
  Gateway Fabric). Its `HTTPRoute` weighted `backendRefs` express blue/green
  and canary without a vendor CRD. The **ingress-nginx project has been
  retired** *(verify date and status)*, so don't build new customer-facing
  install paths on it.
- A **signed OCI Helm chart plus image digests, SBOM and provenance in
  Artifactory** is the natural customer-facing release unit, and our internal
  environments should consume exactly that (see AGENTS.md rule 4).

### Drift without a GitOps controller

GPT framed the choice as "GitOps or no drift control". There's a cheaper
middle path:

1. **Prevent drift.** Humans get read-only cluster access (EKS access entries
   and RBAC). Only the deploy identity can write. Break-glass is logged.
2. **Detect drift.** A scheduled job runs `helm diff` or a server-side dry-run
   against the recorded release and alerts on differences.
3. **Correct by redeploying** the recorded release. No controller is resident.

If after that we still want pull-based reconciliation, a minimal **Flux**
install (source-controller plus helm-controller, about 2–3 pods) reading an
**OCI artefact directly from Artifactory** needs no Git in production. It's a
far smaller footprint than the current Argo CD setup and should be on the
shortlist, not dismissed along with Argo CD.

## Where I'd push the thinking further

- **"The internal platform should be the first customer."** If dev, nonprod
  and prod install the product the same way a customer does (same chart, same
  values schema, same upgrade procedure), then the snowflake problem largely
  goes away and the customer install path is tested on every release.
- **Decide whether blue/green is a requirement or a habit.** True blue/green
  (whole-stack colours, instant switch-back) costs double capacity, and so
  double the app IPs during the switch. A well-built rolling update with
  readiness gates delivers zero downtime for most stateless services. Keep
  blue/green if the business needs *instant* rollback or pre-switch
  verification of the complete stack. That's a legitimate requirement, but it
  should be stated, not assumed. See [ZDT-*] in requirements.
- **Is the application coupled?** If the 8 containers must be version-coherent
  (service A v2 only talks to service B v2), blue/green has to work at stack
  level (namespace per colour, switch at the edge), not per service. That's a
  key open question.
- **No CI in workload accounts.** Workload accounts run workloads. CI runners
  (ARC or otherwise) live in a CI/tooling account, or on ephemeral compute
  (for example CodeBuild-hosted GitHub Actions runners, *(verify GHES support)*,
  or EC2 autoscaling runners).

## Bottom line

GPT got to "GHES → Artifactory → explicit release trigger → AWS-native
deploy → EKS, no Argo CD in prod". That's a reasonable *hypothesis*, but it is
one option among three that deserve a proper comparison (push via CodePipeline,
push via GHES Actions with OIDC, and minimal pull via Flux-OCI). And the
deployment mechanism isn't what decides the IP problem. The **compute and CNI
model plus removing platform pods** decides it. The requirements in this repo
are written so the proposal must answer both.
