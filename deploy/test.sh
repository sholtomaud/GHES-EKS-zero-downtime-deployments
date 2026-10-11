#!/usr/bin/env bash
# Tests for deploy/package.sh. Needs helm and (for the platform bundle)
# network access to aws/eks-charts. Run by .github/workflows/deploy.yml.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pass=0
ok() { echo "ok - $1"; pass=$((pass + 1)); }
fail() { echo "not ok - $1" >&2; exit 1; }

# A stand-in for the customer chart, served from the filesystem.
mkdir -p "$tmp/app/templates"
cat > "$tmp/app/Chart.yaml" <<'EOF'
apiVersion: v2
name: app
version: 1.14.0
appVersion: "1.14.0"
EOF
cat > "$tmp/app/templates/cm.yaml" <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-profile
data:
  profile: {{ .Values.profile | quote }}
  registry: {{ .Values.global.registry | quote }}
EOF
printf 'profile: minimal\nglobal:\n  registry: ""\n' > "$tmp/app/values.yaml"

export OUT="$tmp/dist"
export APP_CHART_REPO="file://$tmp/app"
export EKS_CHARTS_REPO="${EKS_CHARTS_REPO:-https://aws.github.io/eks-charts}"

# --- app bundle -----------------------------------------------------------
tgz="$("$here/package.sh" app prod 1.0.1760000000 1.14.0)"
[[ "$tgz" == "$OUT/app-prod-1.0.1760000000.tgz" && -f "$tgz" ]] || fail "app bundle path ($tgz)"
ok "app bundle is packaged as app-<env>-<bundle>.tgz"

meta="$(helm show chart "$tgz")"
grep -q '^name: app-prod$' <<<"$meta" || fail "bundle name"
grep -q '^version: 1.0.1760000000$' <<<"$meta" || fail "bundle version"
grep -q '^appVersion: 1.14.0$' <<<"$meta" || fail "appVersion"
ok "bundle name, version and appVersion are filled in"

tar -tzf "$tgz" | grep -q '^app-prod/charts/app-1.14.0.tgz$' || fail "customer chart not vendored"
ok "the customer chart is vendored unchanged (Argo CD needs only ECR) [DEP-01]"

rendered="$(helm template x "$tgz")"
grep -q 'profile: "standard"' <<<"$rendered" || fail "prod values not applied"
grep -q 'registry: ".*internal"' <<<"$rendered" || fail "registry override not applied"
ok "the environment's values reach the customer chart"

# --- platform bundle --------------------------------------------------------
tgz="$("$here/package.sh" platform dev 1.0.1760000001)"
rendered="$(helm template x "$tgz" --namespace kube-system)"
grep -q 'log_group_name    /aws/eks/app-dev/containers' <<<"$rendered" || fail "log group"
grep -q -- '--cluster-name=app-dev' <<<"$rendered" || fail "LB controller cluster name"
grep -q 'eks.amazonaws.com/role-arn: arn:aws:iam::222222222222:role/app-dev-aws-load-balancer-controller' <<<"$rendered" || fail "IRSA annotation"
ok "platform bundle renders the log router config and the LB controller for its env"

# --- refusals ---------------------------------------------------------------
! "$here/package.sh" app qa 1.0.1 1.14.0 2>/dev/null || fail "accepted unknown env"
! "$here/package.sh" app dev 1.0 1.14.0 2>/dev/null || fail "accepted non-semver bundle"
! "$here/package.sh" app dev 1.0.1 latest 2>/dev/null || fail "accepted a non-semver app version [REL-02]"
! APP_CHART_REPO= "$here/package.sh" app dev 1.0.1 1.14.0 2>/dev/null || fail "accepted a missing chart repo"
ok "refuses unknown envs, non-semver versions and missing repositories"

echo "# $pass passed"
