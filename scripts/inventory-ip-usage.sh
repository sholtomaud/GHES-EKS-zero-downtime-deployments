#!/usr/bin/env bash
# Phase 0: break down VPC IP consumption for an EKS environment. Read-only.
#
# Usage: scripts/inventory-ip-usage.sh <vpc-id> [kube-context]
# Needs: aws CLI v2 (ec2:Describe* permissions), jq; kubectl if a context is given.
# Output is Markdown on stdout; redirect to docs/discovery/<account>-<date>.md
set -euo pipefail

VPC_ID="${1:?usage: $0 <vpc-id> [kube-context]}"
KCTX="${2:-}"

for bin in aws jq; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region || echo "${AWS_REGION:-unknown}")

echo "# IP inventory: account ${ACCOUNT}, ${REGION}, ${VPC_ID}"
echo
echo "_Generated $(date -u +%Y-%m-%dT%H:%MZ)_"
echo

echo "## Subnets"
echo
echo "| Subnet | AZ | CIDR | Free IPs | Name |"
echo "|---|---|---|---|---|"
aws ec2 describe-subnets --filters "Name=vpc-id,Values=${VPC_ID}" --output json |
  jq -r '.Subnets[] | [.SubnetId, .AvailabilityZone, .CidrBlock, .AvailableIpAddressCount,
         ((.Tags // []) | map(select(.Key=="Name")) | .[0].Value // "")] | "| " + join(" | ") + " |"'
echo

ENIS=$(aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=${VPC_ID}" --output json)

# Classify each ENI. A /28 prefix (prefix delegation) counts as 16 IPs.
CLASSIFIED=$(jq '[.NetworkInterfaces[] | {
    id: .NetworkInterfaceId,
    subnet: .SubnetId,
    instance: (.Attachment.InstanceId // ""),
    ips: ((.PrivateIpAddresses | length) + 16 * ((.Ipv4Prefixes // []) | length)),
    class: (
      if   .InterfaceType == "vpc_endpoint"                         then "VPC endpoint"
      elif .InterfaceType == "nat_gateway"                          then "NAT gateway"
      elif .InterfaceType == "network_load_balancer"                then "NLB"
      elif (.Description // "" | startswith("ELB app/"))            then "ALB"
      elif (.Description // "" | startswith("ELB net/"))            then "NLB"
      elif (.Description // "" | startswith("Amazon EKS"))          then "EKS control plane"
      elif .InterfaceType == "branch"                               then "Pod (security-group branch ENI)"
      elif (.Description // "" | test("fargate"; "i"))              then "Fargate pod"
      elif (.Description // "" | startswith("aws-K8S-"))            then "Node (secondary CNI ENI)"
      elif .InterfaceType == "lambda"                               then "Lambda"
      elif (.Attachment.InstanceId // "") != ""                     then "Node (primary ENI)"
      else "Other: " + (.InterfaceType // "interface") + " / " + ((.Description // "")[0:40])
      end)
  }]' <<<"$ENIS")

echo "## ENIs by consumer"
echo
echo "| Consumer | ENIs | IPs |"
echo "|---|---|---|"
jq -r 'group_by(.class) | map({class: .[0].class, enis: length, ips: (map(.ips) | add)})
       | sort_by(-.ips)[] | "| \(.class) | \(.enis) | \(.ips) |"' <<<"$CLASSIFIED"
echo "| **Total** | $(jq length <<<"$CLASSIFIED") | **$(jq 'map(.ips) | add // 0' <<<"$CLASSIFIED")** |"
echo

if [[ -z "$KCTX" ]]; then
  echo "_No kube context given: skipping pod and warm-pool analysis._"
  exit 0
fi
command -v kubectl >/dev/null || { echo "missing: kubectl" >&2; exit 1; }

PODS=$(kubectl --context "$KCTX" get pods -A -o json)
NODES=$(kubectl --context "$KCTX" get nodes -o json)

echo "## Pods consuming a pod IP (non-hostNetwork, running/pending), by namespace"
echo
echo "| Namespace | Pods |"
echo "|---|---|"
jq -r '[.items[] | select((.spec.hostNetwork // false) | not)
        | select(.status.phase == "Running" or .status.phase == "Pending")
        | .metadata.namespace] | group_by(.) | map({ns: .[0], n: length}) | sort_by(-.n)[]
        | "| \(.ns) | \(.n) |"' <<<"$PODS"
echo "| **Total** | **$(jq '[.items[] | select((.spec.hostNetwork // false) | not)
        | select(.status.phase == "Running" or .status.phase == "Pending")] | length' <<<"$PODS")** |"
echo

echo "## Warm pool per node (IPs held on node ENIs vs pods using them)"
echo
echo "| Node | Instance | IPs on ENIs | Pod IPs used | Idle (warm) |"
echo "|---|---|---|---|---|"
jq -r '.items[] | [.metadata.name, (.spec.providerID // "" | split("/") | last)] | @tsv' <<<"$NODES" |
while IFS=$'\t' read -r node inst; do
  [[ "$inst" == i-* ]] || continue   # Fargate/virtual nodes have no EC2 instance
  held=$(jq --arg i "$inst" '[.[] | select(.instance == $i) | .ips] | add // 0' <<<"$CLASSIFIED")
  enis=$(jq --arg i "$inst" '[.[] | select(.instance == $i)] | length' <<<"$CLASSIFIED")
  used=$(jq --arg n "$node" '[.items[] | select(.spec.nodeName == $n)
          | select((.spec.hostNetwork // false) | not) | select(.status.phase == "Running")] | length' <<<"$PODS")
  # Each ENI's primary IP is not usable by pods.
  idle=$(( held - enis - used ))
  (( idle < 0 )) && idle=0
  echo "| $node | $inst | $held | $used | $idle |"
done
echo
echo "_Pods on custom-networking/secondary-CIDR ENIs show up under the subnets they use;
check the Subnets table to see whether they are routable._"
