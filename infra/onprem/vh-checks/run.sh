#!/bin/bash
# vh-checks/run.sh — wrapper invoked by systemd.
#
# Resolves the Postgres password from the in-cluster Secret, opens a
# kubectl port-forward to the headless `vhhealth-postgres` Service, and
# invokes check.mjs against 127.0.0.1:15432. Port-forward (rather than
# direct pod-IP-from-host) so the script survives pod restarts and CNI
# changes without scraping kubectl status each run.

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

# Resolve PG password from the in-cluster Secret. kubeconfig is root-only
# on dalekdefender, so sudo -n is required.
PG_PASS=$(sudo -n kubectl -n vhhealth get secret vhhealth-postgres -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
if [ -z "$PG_PASS" ]; then
  echo "FATAL: could not resolve PG password from k8s Secret" >&2
  exit 2
fi

# Open the port-forward in the background and ensure it's torn down
# whichever way this script exits.
LOCAL_PORT=15432
sudo -n kubectl -n vhhealth port-forward svc/vhhealth-postgres "${LOCAL_PORT}:5432" \
  > /tmp/vh-checks-pf.log 2>&1 &
PF_PID=$!
trap 'sudo -n kill "$PF_PID" 2>/dev/null || true; wait "$PF_PID" 2>/dev/null || true' EXIT

# Wait for the forward to come up (up to ~10s).
ready=0
for _ in $(seq 1 20); do
  if (echo > "/dev/tcp/127.0.0.1/${LOCAL_PORT}") 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "FATAL: port-forward did not come up; tail of log:" >&2
  tail -n 20 /tmp/vh-checks-pf.log >&2 || true
  exit 2
fi

export DATABASE_URL="postgresql://vhhealth:${PG_PASS}@127.0.0.1:${LOCAL_PORT}/vhhealth"
export GITHUB_REPO="${GITHUB_REPO:-Bahuleyandr/VH-Health-Platform}"
export REPORTS_DIR="$(pwd)/reports"
export HOME="${HOME:-/home/$(whoami)}"

# `gh` reads its auth from $HOME/.config/gh/hosts.yml, so HOME must be
# preserved (systemd User= keeps it, but be explicit for ad-hoc invokes).

exec node check.mjs
