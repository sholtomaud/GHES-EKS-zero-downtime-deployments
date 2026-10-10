# IP address budget

The IP problem is a **design input**, not a tuning exercise. This doc explains
where routable VPC IPs go on EKS, gives a budget model every proposal must fill
in, and describes how to measure reality.

> Numbers marked *(verify)* come from AWS documentation as of writing and
> must be re-checked against current docs in the proposal.

## 1. Who consumes routable IPs

| Consumer | Typical consumption | Lever |
|---|---|---|
| EKS control plane cross-account ENIs | 2–4 IPs in the cluster subnets *(verify)* | Fixed per cluster. Fewer clusters. |
| Node primary IPs | 1 per node (+1 per extra ENI) | Fewer/larger nodes, or Fargate/Auto Mode. |
| Pod IPs (VPC CNI default) | 1 per non-hostNetwork pod | **Secondary CIDR (custom networking)** or **IPv6** moves these off routable space. Fewer pods. |
| VPC CNI warm pool | Default `WARM_ENI_TARGET=1` keeps a full spare ENI per node | `WARM_IP_TARGET` / `MINIMUM_IP_TARGET` (e.g. 1–2), or secondary CIDR. |
| Prefix delegation | Allocates /28 (16 IPs) at a time; needs contiguous free /28s | **Usually avoid in tiny subnets.** Fine inside a large secondary CIDR. |
| ALB | ≥ 1 per AZ/subnet, scales up; AWS advises ≥ 8 free per subnet *(verify)* | One shared ALB per env (IngressGroup / shared Gateway). |
| NLB | 1 per AZ | Avoid unless needed. |
| Interface VPC endpoints | 1 per endpoint per AZ | Centralise in a shared network account if possible; use S3 **gateway** endpoint (free of IPs). |
| NAT gateway | 1 per AZ used | Shared egress, or private NAT for secondary CIDR. |
| Fargate pod | Exactly 1 per pod, no warm pool | Strong option for ≤ ~15 pods. |
| DaemonSet pods | 1 per node each, **unless hostNetwork** | Few DaemonSets; prefer hostNetwork system agents/managed add-ons. |
| Blue/green surge | +1× app pods during switch | Rolling (`maxSurge: 1`) surges far less. |

**Pods on `hostNetwork: true`** (aws-node, kube-proxy, many node agents) use the
node IP and cost nothing extra.

## 2. Budget model (fill this in for every proposal)

Use the `minimal` profile, 2 AZs, at **steady state** and **peak surge**.
Count only **routable** IPs (primary VPC CIDR). If pods use a secondary CIDR,
count them in the separate column.

| Line | Formula | Routable | Secondary/IPv6 |
|---|---|---|---|
| A. Control-plane ENIs | per docs | | |
| B. Nodes | nodes × (1 + extra ENIs) | | |
| C. App pods steady | services × replicas | | |
| D. Platform pods | from component register | | |
| E. Warm pool | nodes × warm IPs | | |
| F. Deploy surge | rolling: Σ maxSurge; blue/green: = C | | |
| G. Load balancers | ALB IPs at min scale × AZs | | |
| H. VPC endpoints | endpoints × AZs (0 if centralised) | | |
| I. NAT / other | | | |
| **Total (peak)** | A+B+C+D+E+F+G+H+I | **≤ 50 (NET-01)** | |

### Illustrative estimate (not a measurement)

To show the scale of the levers, here's a hypothetical **minimal** profile:
2 nodes, 8 services × 1 replica, rolling deploys, 1 shared ALB, centralised
endpoints.

| Line | Default VPC CNI | Tuned warm pool | Secondary CIDR for pods |
|---|---|---|---|
| A. Control plane | 4 | 4 | 4 |
| B. Nodes | 2 | 2 | 2 (+2 ENIs in pod subnet, not routable) |
| C. App pods | 8 | 8 | 0 (8 in secondary) |
| D. Platform pods (CoreDNS 2, LBC 2, metrics 1) | 5 | 5 | 0 (5 in secondary) |
| E. Warm pool | ~18–28 | 4 | 0 |
| F. Rolling surge | 8 (worst case all at once) | 8 | 0 |
| G. ALB, 2 AZ | 2–8 | 2–8 | 2–8 |
| H. Endpoints | 0 (centralised) / ~10–14 if local | same | same |
| **Peak routable** | **~47–63 (+endpoints)** | **~33–39 (+endpoints)** | **~8–14 (+endpoints)** |

The point: **the deployment tool barely matters to the IP count. Platform pods,
warm pool, endpoints and the pod-IP strategy dominate.** Compare today's ~130.

## 3. Measuring reality (Phase 0)

Run `scripts/inventory-ip-usage.sh <vpc-id> [kube-context]` with read-only
credentials in each account. It reports:

1. Free IPs per subnet.
2. ENIs in the VPC grouped by type and owner (node, branch/pod, ELB,
   VPC endpoint, NAT, EKS control plane, Lambda and so on) with IP counts.
3. Per node: assigned vs used pod IPs (warm-pool waste).
4. Pods per namespace, excluding hostNetwork, to show platform vs app.

Save outputs to `docs/discovery/<account>-<date>.md`. The proposal must cite them.

## 4. Strategies to rank in the proposal

1. **Remove platform pods**: Argo CD, ARC runners, in-cluster Prometheus,
   cert-manager (ACM on ALB instead), external-dns (IaC-managed records).
2. **Pod IPs off routable space**: secondary CIDR (100.64.0.0/10) with custom
   networking (or Auto Mode pod subnets *(verify)*), or IPv6.
3. **Compute model**: Fargate (1 IP/pod, no warm pool) vs Auto Mode vs managed
   node groups with tuned `WARM_IP_TARGET`.
4. **Shared edge**: one ALB per environment via IngressGroup or a shared Gateway.
5. **Centralised VPC endpoints** via the network/hub account where possible.
6. **Rolling over blue/green** for the `minimal` profile, if ZDT requirements
   allow; blue/green available in `standard`/`ha`.

Strategy 2 needs the VPC owner to allow a secondary CIDR association. That's
an organisational question; see open questions.
