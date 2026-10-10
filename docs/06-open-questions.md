# Open questions

Answer inline (replace `_unanswered_`). The **Impact** column says what each
answer changes, so prioritise accordingly.

## High impact

| # | Question | Impact | Answer |
|---|---|---|---|
| Q1 | Are the 8 services **version-coherent** (must be released together) or independently deployable? | Stack vs per-service blue/green; release unit granularity. | _unanswered_ |
| Q2 | Is **true blue/green** (instant switch-back, full-stack preview) a business requirement, or is "no downtime + fast rollback" enough? | Rolling vs blue/green; surge IPs; complexity. | _unanswered_ |
| Q3 | Can we associate a **secondary CIDR** (e.g. 100.64.0.0/16) to workload VPCs? Who owns the VPCs: us, or a central network team (and, for customers, the customer)? | The best IP lever. If no, Fargate or IPv6 become more important. | _unanswered_ |
| Q4 | Is the EKS API endpoint **private only**? What network path exists from GHES (and its runners) to each account? | Push vs pull (D2 options A/B/C). | _unanswered_ |
| Q5 | Where is **Artifactory** hosted (SaaS, on-prem, in AWS)? Can AWS accounts and customer clusters reach it privately? Does it proxy public registries? | Image pull path, CodePipeline egress, air-gap story. | _unanswered_ |
| Q6 | What exactly runs today? Confirm **ARC = Actions Runner Controller** and that runners run in workload clusters. Full list of add-ons per cluster. | Phase 0 baseline and the size of the win. | _unanswered_ |
| Q7 | What **stateful dependencies** exist (RDS/Postgres, Redis, queues, object storage)? Managed in our accounts, and what do customers provide? | Migration (ZDT-05), portability adapters, storage on Fargate. | _unanswered_ |
| Q8 | Do we **operate** deployments in customer environments (any cloud/on-prem), or do customers always self-install? | Decides where our delivery mechanism (Flux) must run; see PROPOSAL.md R1. | _unanswered_ |

## Medium impact

| # | Question | Impact | Answer |
|---|---|---|---|
| Q9 | Which customer platforms are **committed** vs hypothetical (GKE, Alibaba ACK, on-prem distro names/versions)? Any customers without Kubernetes? | PORT-02 test matrix. | _unanswered_ |
| Q10 | Compliance regimes (e.g. ISO 27001, SOC 2, IRAP, government)? Who must approve prod releases? | DEP-02 approval design, audit retention, signing. | _unanswered_ |
| Q11 | Availability target / SLO and acceptable maintenance windows? | Profiles, multi-AZ, ZDT strictness. | _unanswered_ |
| Q12 | IaC tool in use (Terraform, OpenTofu, CDK, CloudFormation)? | ENV-04 implementation. | _unanswered_ |
| Q13 | Session/state handling in the app: sticky sessions, websockets, long-running requests? | Drain timings, blue/green switch behaviour. | _unanswered_ |
| Q14 | Is there a central **networking/hub account** with shared VPC endpoints and Route 53 resolvers? | Line H of the IP budget. | _unanswered_ |

## Low impact / later

| # | Question | Impact | Answer |
|---|---|---|---|
| Q15 | Preferred observability destination for internal envs (CloudWatch vs AMP/AMG vs existing tool)? | OBS-02 adapter choice. | _unanswered_ |
| Q16 | Team size and on-call model for the platform? | Weight of operational simplicity. | _unanswered_ |
| Q17 | Current monthly AWS cost per environment for the platform? | Before/after comparison. | _unanswered_ |
