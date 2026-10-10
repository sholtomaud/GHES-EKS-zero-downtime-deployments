# Open questions

Answer inline (replace `_unanswered_`). The **Impact** column says what each
answer changes, so prioritise accordingly.

## High impact

| # | Question | Impact | Answer |
|---|---|---|---|
| Q1 | Are the 8 services **version-coherent** (must be released together) or independently deployable? | Stack vs per-service blue/green; release unit granularity. | **Answered:** Expected to be yes: services can run at mixed versions. Verified by the mixed-version conformance test (PROPOSAL §2.4). |
| Q2 | Is **true blue/green** (instant switch-back, full-stack preview) a business requirement, or is "no downtime + fast rollback" enough? | Rolling vs blue/green; surge IPs; complexity. | **Answered:** Zero downtime is required for upgrades *and* rollbacks. Blue/green isn't required. Rolling upgrades and rollbacks chosen (PROPOSAL §5). |
| Q3 | Can we associate a **secondary CIDR** (e.g. 100.64.0.0/16) to workload VPCs? Who owns the VPCs: us, or a central network team (and, for customers, the customer)? | The best IP lever. If no, Fargate or IPv6 become more important. | **Answered:** No secondary pod CIDR. Our accounts use EKS on Fargate (PROPOSAL §3.5). |
| Q4 | Is the EKS API endpoint **private only**? What network path exists from GHES (and its runners) to each account? | Push vs pull (D2 options A/B/C). | **Partly answered:** GHES runners are in AWS, so they assume per-account IAM roles to start pipelines. Still to confirm: EKS endpoint private-only (assumed yes). |
| Q5 | Where is **Artifactory** hosted (SaaS, on-prem, in AWS)? Can AWS accounts and customer clusters reach it privately? Does it proxy public registries? | Image pull path, CodePipeline egress, air-gap story. | **Answered:** GHES and Artifactory are self-maintained in AWS (tooling account). Releases are copied by digest into ECR so Artifactory isn't a runtime dependency (PROPOSAL §3.2, recommended). Customer-facing registry location is Q19. |
| Q6 | What exactly runs today? Confirm **ARC = Actions Runner Controller** and that runners run in workload clusters. Full list of add-ons per cluster. | Phase 0 baseline and the size of the win. | _unanswered_ |
| Q7 | What **stateful dependencies** exist (RDS/Postgres, Redis, queues, object storage)? Managed in our accounts, and what do customers provide? | Migration (ZDT-05), portability adapters, storage on Fargate. | **Answered:** Partial: no EBS volumes or privileged containers, so Fargate fits. Stateful services (DB, cache, queues) still to list. |
| Q8 | Do we **operate** deployments in customer environments, or do customers always self-install? | Decides where our delivery mechanism must run. | **Answered:** CI/CD runs only in our own AWS accounts. Customers host and deploy the app themselves. |
| Q18 | How do customers **obtain** releases: pull from a customer-facing registry (e.g. Artifactory with per-customer read tokens), or a signed offline bundle? | Release distribution and air-gap story (PORT-06). | **Answered:** Customers pull from a customer-facing registry we expose (PROPOSAL §2.5). |
| Q19 | Where should the **customer-facing release registry** live: exposed Artifactory (A), ECR in a distribution account (B, recommended), or a hosted registry (C)? | Customer pull experience vs on-prem exposure (PROPOSAL §2.5). | _unanswered_ |
| Q20 | Which **on-prem Kubernetes distributions** do customers run (RKE2/k3s, OpenShift, Tanzu, kubeadm…), and are any air-gapped? | Conformance target; offline bundle need. | _unanswered_ |

## Medium impact

| # | Question | Impact | Answer |
|---|---|---|---|
| Q9 | Which customer platforms are **committed** vs hypothetical (GKE, Alibaba ACK, on-prem distro names/versions)? Any customers without Kubernetes? | PORT-02 test matrix. | **Answered:** On-prem Kubernetes is the customer platform that matters today. Distributions still to confirm (Q20). |
| Q10 | Compliance regimes (e.g. ISO 27001, SOC 2, IRAP, government)? Who must approve prod releases? | DEP-02 approval design, audit retention, signing. | _unanswered_ |
| Q11 | Availability target / SLO and acceptable maintenance windows? | Profiles, multi-AZ, ZDT strictness. | _unanswered_ |
| Q12 | IaC tool in use (Terraform, OpenTofu, CDK, CloudFormation)? | ENV-04 implementation. | _unanswered_ |
| Q13 | Session/state handling in the app: sticky sessions, websockets, long-running requests? | Drain timings, blue/green switch behaviour. | _unanswered_ |
| Q14 | Is there a central **networking/hub account** with shared VPC endpoints and Route 53 resolvers? | Line H of the IP budget. | **Answered:** Not a constraint: VPC NAT/endpoints don't need budgeting. |

## Low impact / later

| # | Question | Impact | Answer |
|---|---|---|---|
| Q15 | Preferred observability destination for internal envs (CloudWatch vs AMP/AMG vs existing tool)? | OBS-02 adapter choice. | _unanswered_ |
| Q16 | Team size and on-call model for the platform? | Weight of operational simplicity. | _unanswered_ |
| Q17 | Current monthly AWS cost per environment for the platform? | Before/after comparison. | _unanswered_ |
