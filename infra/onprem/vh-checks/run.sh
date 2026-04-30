#!/bin/bash
# vh-checks/run.sh — wrapper invoked by systemd. Resolves DB credentials
# from the in-cluster Postgres Secret + the postgres pod IP, then
# invokes check.mjs.

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

# Resolve DB credentials + pod IP via kubectl (sudo -n required because
# kubeconfig is root-only on dalekdefender).
PG_PASS=$(sudo -n kubectl -n vhhealth get secret vhhealth-postgres -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
PG_IP=$(sudo -n kubectl -n vhhealth get pod vhhealth-postgres-0 -o jsonpath='{.status.podIP}')

if [ -z "$PG_PASS" ] || [ -z "$PG_IP" ]; then
  echo "FATAL: could not resolve PG credentials/IP via kubectl"
  exit 2
fi

export DATABASE_URL="postgresql://vhhealth:${PG_PASS}@${PG_IP}:5432/vhhealth"
export GITHUB_REPO="${GITHUB_REPO:-Bahuleyandr/VH-Health-Platform}"
export REPORTS_DIR="$(pwd)/reports"

# gh CLI uses the user's auth (~/.config/gh/hosts.yml). Make sure
# HOME is set so gh can find the config when running via systemd.
export HOME="${HOME:-/home/$(whoami)}"

exec node check.mjs
