# ADR-0006: Logs from Fargate's built-in router to CloudWatch Logs, class per environment

- **Status:** Proposed
- **Date:** 2026-10-11
- **Deciders:** <platform owner>; only humans set `Accepted`
- **Requirements:** [OBS-01], [OBS-02], [OBS-04], [OPS-05]; answers Q15 for logs; owner requirement O5

## Context

Every pod runs on Fargate (no nodes, no DaemonSets). The owner wants a cheap
way to keep and debug logs from these short-lived containers, with no extra
platform components.

## Options considered

Weights: cost 35, debug 25, footprint 25, ops 15 (design.md §7.1).

| Option | Score /500 |
|---|---|
| CloudWatch Logs Standard, short retention | 430 |
| CloudWatch Logs Infrequent Access | 450 |
| Firehose → S3 + Athena | 395 |
| Loki/Grafana or EFK in cluster | 245 |
| **Standard in dev/nonprod, Infrequent Access in prod** | **465** |

## Decision

Fargate's built-in Fluent Bit (the `aws-observability/aws-logging`
ConfigMap) writes container stdout to **one pre-created log group per
environment**. Dev and nonprod use Standard class with 7 and 14 days' retention
(Live Tail available). Prod uses Infrequent Access with 30 days. The router role
can write streams in that group only. Live debugging uses `kubectl logs`,
`kubectl exec` and `kubectl debug`. EKS control-plane logging is limited to
`audit` and `authenticator`.

## Consequences

- Positive: 0 pods, 0 IPs. About US$15/month per GB/day in dev/nonprod and
  US$8 in prod *(us-east-1 list prices; verify for the region)*.
- Negative: prod has no Live Tail or log metric filters (alarms come from ALB
  metrics). Changing class needs a new group. Pods started before the
  ConfigMap exists don't ship logs until restarted.
- Follow-ups: saved Logs Insights queries. Confirm ephemeral debug containers
  on Fargate (V9).

## Verification

A pod's stdout appears in the group within a minute. The router role can't
`CreateLogGroup`. `kubectl get pods -A` shows no logging pods.

## References

- https://aws.amazon.com/blogs/aws/new-amazon-cloudwatch-log-class-for-infrequent-access-logs-at-a-reduced-price (accessed 2026-10-11)
- https://docs.fluentbit.io/manual/data-pipeline/outputs/cloudwatch
