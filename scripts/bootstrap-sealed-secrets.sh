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
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT

"$kustomize_bin" build "$target" > "$rendered"

python_bin="${PYTHON_BIN:-python3}"
"$python_bin" - "$rendered" <<'PY'
import pathlib
import re
import sys

rendered = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
documents = [item.strip() for item in re.split(r"^---\s*$", rendered, flags=re.MULTILINE) if item.strip()]
deployments = [
    item for item in documents
    if re.search(r"^kind:\s*Deployment\s*$", item, flags=re.MULTILINE)
    and re.search(r"^\s{2}name:\s*sealed-secrets\s*$", item, flags=re.MULTILINE)
    and re.search(r"^\s{2}namespace:\s*vhhealth-security\s*$", item, flags=re.MULTILINE)
]
if len(deployments) != 1:
    raise SystemExit(
        "sealed-secrets bootstrap must render exactly one "
        "Deployment vhhealth-security/sealed-secrets"
    )
PY

if [[ "$mode" == "--check" ]]; then
  "$kubectl_bin" apply --dry-run=client -f "$rendered" >/dev/null
  echo "Sealed Secrets bootstrap render is valid for vhhealth-security/sealed-secrets."
  exit 0
fi

"$kubectl_bin" apply -k "$target"
"$kubectl_bin" -n vhhealth-security rollout status deployment/sealed-secrets --timeout=180s
echo "Sealed Secrets controller vhhealth-security/sealed-secrets is available."
