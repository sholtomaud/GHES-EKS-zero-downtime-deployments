#!/usr/bin/env bash
# Package one environment's desired state as a Helm chart (a "bundle").
#
#   deploy/package.sh app      <env> <bundle-version> <app-version>
#   deploy/package.sh platform <env> <bundle-version>
#
# Env:
#   APP_CHART_REPO   repository of the customer chart, e.g. oci://<artifactory>/<helm-repo>
#   EKS_CHARTS_REPO  repository of aws/eks-charts (an Artifactory remote), platform only
#   OUT              output directory (default: dist)
#
# Prints the path of the packaged chart: <OUT>/<component>-<env>-<bundle-version>.tgz.
# Dependencies are vendored into the bundle, so Argo CD needs nothing but ECR.
set -euo pipefail

component="${1:?component: app|platform}"
env="${2:?environment}"
bundle="${3:?bundle version}"
app_version="${4:-}"
here="$(cd "$(dirname "$0")" && pwd)"
out="${OUT:-dist}"

[[ "$component" =~ ^(app|platform)$ ]] || { echo "unknown component '$component'" >&2; exit 2; }
[[ "$env" =~ ^(dev|nonprod|prod)$ ]] || { echo "unknown environment '$env'" >&2; exit 2; }
[[ "$bundle" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bundle version must be semver, got '$bundle'" >&2; exit 2; }
values="$here/environments/$env/$component-values.yaml"
[[ -f "$values" ]] || { echo "missing $values" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chart="$work/$component-$env"
cp -R "$here/charts/$component-env" "$chart"
cp "$values" "$chart/values.yaml"

# Fill the marked placeholders in Chart.yaml (see the x-* comments there).
sed -i.bak -E \
  -e "s|^name: .*# x-bundle-name$|name: $component-$env|" \
  -e "s|^version: .*# x-bundle-version$|version: $bundle|" \
  "$chart/Chart.yaml"
if [[ "$component" == app ]]; then
  [[ "$app_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "app version must be semver, got '$app_version'" >&2; exit 2; }
  : "${APP_CHART_REPO:?APP_CHART_REPO is required for the app bundle}"
  sed -i.bak -E \
    -e "s|^(appVersion: ).*# x-app-version$|\1\"$app_version\"|" \
    -e "s|^( +version: ).*# x-app-version$|\1\"$app_version\"|" \
    -e "s|^( +repository: ).*# x-app-repository$|\1$APP_CHART_REPO|" \
    "$chart/Chart.yaml"
else
  : "${EKS_CHARTS_REPO:?EKS_CHARTS_REPO is required for the platform bundle}"
  sed -i.bak -E -e "s|^( +repository: ).*# x-eks-charts-repository$|\1$EKS_CHARTS_REPO|" "$chart/Chart.yaml"
fi
rm -f "$chart/Chart.yaml.bak"
if grep -qE 'x-(bundle|app|eks)-|ARTIFACTORY_' "$chart/Chart.yaml"; then
  grep -nE 'x-(bundle|app|eks)-|ARTIFACTORY_' "$chart/Chart.yaml" >&2
  echo "unfilled placeholder in Chart.yaml" >&2
  exit 1
fi

helm dependency build "$chart" >&2
helm lint --strict "$chart" >&2
mkdir -p "$out"
helm package "$chart" -d "$out" >&2
echo "$out/$component-$env-$bundle.tgz"
