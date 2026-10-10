# Open questions

Answer inline (replace `_unanswered_`). The **Impact** column says what each
answer changes, so prioritise accordingly.

## High impact

| # | Question | Impact | Answer |
|---|---|---|---|
| Q1 | Are the 8 services **version-coherent** (must be released together) or independently deployable? | Stack vs per-service blue/green; release unit granularity. | **Answered:** Expected to be yes: services can run at mixed versions. Verified by the mixed-version conformance test (PROPOSAL §2.4). |
| Q2 | Is **true blue/green** (instant switch-back, full-stack preview) a business requirement, or is "no downtime + fast rollback" enough? | Rolling vs blue/green; surge IPs; complexity. | **Answered:** Zero downtime is required for upgrades *and* rollbacks. Blue/green isn't required. Rolling upgrades and rollbacks chosen (PROPOSAL §5). |
| Q3 | Can we associate a **secondary CIDR** (e.g. 100.64.0.0/16) to workload VPCs? Who owns the VPCs: us, or a central network team (and, for customers, the customer)? | The best IP lever. If no, Fargate or IPv6 become more important. | **Answered:** No secondary pod CIDR. Our accounts use EKS on Fargate (PROPOSAL §3.5). |
| Q4 | Is the EKS API endpoint **private only**? What network path exists from GHES (and its runners) to each account? | Push vs pull (D2 options A/B/C). | _unanswered_ |
| Q5 | Where is **Artifactory** hosted (SaaS, on-prem, in AWS)? Can AWS accounts and customer clusters reach it privately? Does it proxy public registries? | Image pull path, CodePipeline egress, air-gap story. | **Answered:** Artifactory is on-prem. Releases are copied by digest into ECR for our AWS runtime (PROPOSAL §3.2). Customer-facing registry location is Q19. |
| Q6 | What exactly runs today? Confirm **ARC = Actions Runner Controller** and that runners run in workload clusters. Full list of add-ons per cluster. | Phase 0 baseline and the size of the win. | _unanswered_ |
| Q7 | What **stateful dependencies** exist (RDS/Postgres, Redis, queues, object storage)? Managed in our accounts, and what do customers provide? | Migration (ZDT-05), portability adapters, storage on Fargate. | **Answered:** Partial: no EBS volumes or privileged containers, so Fargate fits. Stateful services (DB, cache, queues) still to list. |
| Q8 | Do we **operate** deployments in customer environments, or do customers always self-install? | Decides where our delivery mechanism must run. | **Answered:** CI/CD runs only in our own AWS accounts. Customers host and deploy the app themselves. |
| Q18 | How do customers **obtain** releases: pull from a customer-facing registry (e.g. Artifactory with per-customer read tokens), or a signed offline bundle? | Release distribution and air-gap story (PORT-06). | **Answered:** Customers pull from a customer-facing registry we expose (PROPOSAL §2.5). |
| Q19 | Where should the **customer-facing release registry** live: exposed on-prem Artifactory (A), ECR in a distribution account (B, recommended), or a hosted registry (C)? | Customer pull experience vs on-prem exposure (PROPOSAL §2.5). | _unanswered_ |
| Q20 | Which **on-prem Kubernetes distributions** do customers run (RKE2/k3s, OpenShift, Tanzu, kubeadm…), and are any air-gapped? | Conformance target; offline bundle need. | _unanswered_ |
| Q21 | Can developer laptops (via corporate VPN/Direct Connect/TGW) **reach the dev account VPC**? If not, is SSM Session Manager port forwarding allowed? | Laptop → RDS path; whether a tunnel host is needed (+1 IP). See proposal/local-development.md §5.5. | **Answered:** Yes, laptops route to the dev VPC. Open tcp/5432 to a laptop/VPN prefix list only, per RDS SG, with TLS enforced (local-development.md §5.5). Exact CIDRs: Q27. |
| Q22 | What is the **clean data DB**: a curated or synthetic reference set, or an extract of real (customer/personal) data? Who refreshes it, and how? | Whether it may be dumped to laptops to seed a local DB; the dev-reset job. | **Answered:** Clean holds real data. Laptops may *query* it but never copy it: named IAM logins, SELECT only, audited; local data comes from a seed-generator script; nothing is copied from clean (local-development.md §5.3–5.4, DEV-08). |
| Q23 | Does our **managed Windows build** allow WSL2 (Hyper-V platform), systemd in WSL, and rootless Podman? Any endpoint-security exclusions needed? | Viability of the whole local workflow; fallback to hosted dev envs. | **Answered (believed):** Yes. Slice 1 confirms on a real managed laptop, including the VPN route inside WSL2. |
| Q24 | Do laptops need a **corporate proxy and/or internal CA** to reach Artifactory and AWS? | Bootstrap script and the `dev` image stage. | **Answered:** No proxy or internal CA needed. |
| Q25 | Is the shared dev RDS the **same database the dev EKS environment uses**, or a separate one for laptops? | Blast radius of laptop activity; reset schedule. | **Answered (believed):** Yes, shared with the dev EKS environment. |
| Q26 | Should dev be reset from a **masked/anonymised copy of clean** (needs a masking job and a data-owner sign-off), or from **synthetic fixtures** only (current proposal)? | Realism of dev data vs. a masking pipeline to build and own. | **Answered (superseded):** Dev isn't reset. It holds the dirty test data. Locally, a seed-generator script produces synthetic data; no data files are stored in the repo. |
| Q27 | What are the **laptop / VPN client CIDR ranges** (as distinct from server ranges) for the RDS security-group prefix list? Does the VPN assign stable per-user addresses? | Width of the 5432 rule (local-development.md §5.5). | **Answered:** The VPN is always on, so the source is just the VPN client pool. Take the CIDR from the network team at build time. Stable per-user addresses aren't needed: identity comes from the DB login. |
| Q28 | Does the **dirty test data on dev RDS** contain real personal or customer data? Where does it come from, and who refreshes it? | If yes, laptops connect to dev with per-person, audited logins (as clean), not the shared DML role (local-development.md §5.4). |  _unanswered_ |

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
