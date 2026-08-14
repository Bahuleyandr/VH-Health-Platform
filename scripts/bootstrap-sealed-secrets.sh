#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: scripts/bootstrap-sealed-secrets.sh <--check|--apply>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
mode="$1"
[[ "$mode" == "--check" || "$mode" == "--apply" ]] || usage

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$repo_root/infra/kubernetes/base/sealed-secrets"
kustomize_bin="${KUSTOMIZE_BIN:-kustomize}"
kubectl_bin="${KUBECTL_BIN:-kubectl}"
node_bin="${NODE_BIN:-node}"
validator="$repo_root/scripts/validate-sealed-secrets-bootstrap.mjs"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT

"$kustomize_bin" build "$target" > "$rendered"
"$node_bin" "$validator" "$rendered"

if [[ "$mode" == "--check" ]]; then
  "$kubectl_bin" apply --dry-run=client -f "$rendered" >/dev/null
  echo "Sealed Secrets bootstrap render is valid for vhhealth-security/sealed-secrets."
  exit 0
fi

"$kubectl_bin" apply -f "$rendered"
"$kubectl_bin" -n vhhealth-security rollout status deployment/sealed-secrets --timeout=180s
echo "Sealed Secrets controller vhhealth-security/sealed-secrets is available."
