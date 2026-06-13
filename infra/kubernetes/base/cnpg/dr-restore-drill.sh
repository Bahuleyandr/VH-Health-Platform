#!/usr/bin/env bash
# dr-restore-drill.sh — Executable DR restore drill (REL-2 / B2.2)
#
# Restores the latest CNPG backup from Cloudflare R2 into a scratch namespace,
# verifies clinical invariants, measures RPO and RTO, records results, and
# tears down. EVERY step is copy-pasteable or automated.
#
# Usage:
#   export CF_R2_ACCOUNT_ID=<your-r2-account-id>
#   export DRILL_DATE=$(date +%Y-%m-%d)
#   bash infra/kubernetes/base/cnpg/dr-restore-drill.sh
#
# The script is safe to run on the real ops workstation (it uses a scratch
# namespace and never touches the production cluster or its namespace).
# It creates PHI-containing data in vhhealth-drill — tear-down is automated
# and enforced.
#
# Targets:
#   RPO: ≤ 5 minutes (WAL archiving lag from last WAL segment to R2)
#   RTO: ≤ 60 minutes (from decision to declare DR to service restored)
#
# Prerequisites:
#   - kubectl in PATH, authenticated to the prod cluster (read-only for drill)
#   - kubectl cnpg plugin: https://cloudnative-pg.io/documentation/
#   - cnpg-backup-credentials secret accessible in vhhealth-platform
#   - CF_R2_ACCOUNT_ID environment variable set
#   - envsubst (gettext-base package) in PATH
#   - jq in PATH (for result parsing)
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
DRILL_NS="vhhealth-drill"
DRILL_CLUSTER="vhhealth-pg-drill"
PROD_NS="vhhealth-platform"
PROD_CLUSTER="vhhealth-pg"
DRILL_DATE="${DRILL_DATE:-$(date +%Y-%m-%d)}"
RESULTS_DIR="docs/qa-findings"
RESULTS_FILE="${RESULTS_DIR}/${DRILL_DATE}-dr-drill.md"

# RPO/RTO targets (seconds)
RPO_TARGET_SECONDS=300    # 5 minutes
RTO_TARGET_SECONDS=3600   # 60 minutes

# ── Timing ────────────────────────────────────────────────────────────────────
DRILL_START=$(date +%s)
DRILL_START_HM=$(date '+%Y-%m-%dT%H:%M:%S%z')

log() { echo "[$(date '+%H:%M:%S')] $*"; }
err() { echo "[$(date '+%H:%M:%S')] ERROR: $*" >&2; }

# ── Preflight checks ─────────────────────────────────────────────────────────
log "=== VH Health DR Restore Drill — ${DRILL_DATE} ==="
log "Pre-flight checks..."

if [[ -z "${CF_R2_ACCOUNT_ID:-}" ]]; then
  err "CF_R2_ACCOUNT_ID is not set. Export it before running this script."
  exit 1
fi

for cmd in kubectl envsubst jq; do
  if ! command -v "${cmd}" &>/dev/null; then
    err "Required command '${cmd}' not found in PATH."
    exit 1
  fi
done

if ! kubectl cnpg version &>/dev/null; then
  err "kubectl cnpg plugin not found. Install: https://cloudnative-pg.io/documentation/"
  exit 1
fi

log "Pre-flight OK."

# ── Determine recovery target time (T) ───────────────────────────────────────
# Default: 10 minutes ago (tests WAL replay + PITR accuracy).
# For a real incident, set RECOVERY_TARGET_TIME explicitly before calling.
if [[ -z "${RECOVERY_TARGET_TIME:-}" ]]; then
  RECOVERY_TARGET_TIME=$(date -u -d "10 minutes ago" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || date -u -v-10M '+%Y-%m-%dT%H:%M:%SZ')  # macOS fallback
  log "Recovery target time (auto): ${RECOVERY_TARGET_TIME}"
else
  log "Recovery target time (manual): ${RECOVERY_TARGET_TIME}"
fi

# Get current max(clinical_timeline_events.created_at) from PROD for RPO calc.
log "Sampling production DB for RPO baseline..."
PROD_PRIMARY=$(kubectl get pods -n "${PROD_NS}" \
  -l postgresql="${PROD_CLUSTER}",role=primary \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

PROD_MAX_EVENT=""
if [[ -n "${PROD_PRIMARY}" ]]; then
  PROD_MAX_EVENT=$(kubectl exec -n "${PROD_NS}" "${PROD_PRIMARY}" \
    -c postgres -- psql -U postgres vhhealth -tAc \
    "SELECT max(created_at) FROM clinical_timeline_events;" 2>/dev/null || echo "UNAVAILABLE")
  log "Prod max(clinical_timeline_events.created_at): ${PROD_MAX_EVENT}"
else
  log "WARNING: Could not reach production primary — RPO calc will be approximate."
fi

# ── Prepare scratch namespace ─────────────────────────────────────────────────
log "Creating scratch namespace ${DRILL_NS}..."
kubectl create namespace "${DRILL_NS}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Ensure namespace is labeled for auditing.
kubectl label namespace "${DRILL_NS}" \
  vhhealth.app/purpose=dr-drill \
  vhhealth.app/phi-present=true \
  vhhealth.app/created-by=dr-restore-drill.sh \
  vhhealth.app/drill-date="${DRILL_DATE}" \
  --overwrite

log "Copying backup credentials to ${DRILL_NS}..."
kubectl get secret cnpg-backup-credentials -n "${PROD_NS}" -o yaml \
  | sed "s/namespace: ${PROD_NS}/namespace: ${DRILL_NS}/" \
  | kubectl apply -f -

# ── Apply drill cluster ───────────────────────────────────────────────────────
log "Rendering drill cluster manifest..."
RECOVERY_START=$(date +%s)

export CF_R2_ACCOUNT_ID RECOVERY_TARGET_TIME DRILL_DATE
envsubst < "$(dirname "$0")/dr-restore-drill.yaml" > /tmp/drill-cluster.yaml

log "Applying drill cluster..."
kubectl apply -f /tmp/drill-cluster.yaml
rm -f /tmp/drill-cluster.yaml

# ── Wait for cluster to become healthy ───────────────────────────────────────
log "Waiting for drill cluster to reach Ready state (max 50 min)..."
WAIT_DEADLINE=$(( $(date +%s) + 3000 ))  # 50 minutes

while true; do
  NOW=$(date +%s)
  if (( NOW > WAIT_DEADLINE )); then
    err "Timed out waiting for drill cluster after 50 minutes."
    err "Cluster status:"
    kubectl get cluster "${DRILL_CLUSTER}" -n "${DRILL_NS}" -o wide || true
    kubectl get pods -n "${DRILL_NS}" || true
    log "Tearing down (timeout) to avoid PHI leak..."
    kubectl delete namespace "${DRILL_NS}" --wait=false 2>/dev/null || true
    exit 1
  fi

  PHASE=$(kubectl get cluster "${DRILL_CLUSTER}" -n "${DRILL_NS}" \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
  log "Cluster phase: ${PHASE} (elapsed: $(( NOW - RECOVERY_START ))s)"

  if [[ "${PHASE}" == "Cluster in healthy state" ]]; then
    break
  fi
  sleep 20
done

RECOVERY_END=$(date +%s)
RECOVERY_ELAPSED=$(( RECOVERY_END - RECOVERY_START ))
log "Cluster Ready in ${RECOVERY_ELAPSED}s."

# ── Verify clinical invariants ────────────────────────────────────────────────
log "=== Clinical Invariant Verification ==="

DRILL_PRIMARY=$(kubectl get pods -n "${DRILL_NS}" \
  -l postgresql="${DRILL_CLUSTER}",role=primary \
  -o jsonpath='{.items[0].metadata.name}')

run_sql() {
  kubectl exec -n "${DRILL_NS}" "${DRILL_PRIMARY}" \
    -c postgres -- psql -U postgres vhhealth -tAc "$1" 2>&1
}

log "INV-1: admissions count (status='admitted')..."
ADMISSIONS=$(run_sql "SELECT count(*) FROM admissions WHERE status = 'admitted';")
log "  admissions (admitted): ${ADMISSIONS}"

log "INV-2: max(clinical_timeline_events.created_at)..."
MAX_EVENT=$(run_sql "SELECT max(created_at) FROM clinical_timeline_events;")
log "  max(clinical_timeline_events.created_at): ${MAX_EVENT}"

log "INV-3: migration count..."
MIGRATION_COUNT=$(run_sql "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" 2>/dev/null \
  || run_sql "SELECT count(*) FROM _migrations;" 2>/dev/null \
  || echo "UNKNOWN")
log "  migration count: ${MIGRATION_COUNT}"

log "INV-4: users count..."
USERS_COUNT=$(run_sql "SELECT count(*) FROM users;")
log "  users count: ${USERS_COUNT}"

log "INV-5: tenants present..."
TENANTS=$(run_sql "SELECT count(*) FROM tenants;" 2>/dev/null || echo "N/A")
log "  tenants: ${TENANTS}"

# ── RPO calculation ───────────────────────────────────────────────────────────
RPO_SECONDS="UNKNOWN"
if [[ "${PROD_MAX_EVENT}" != "UNAVAILABLE" && "${MAX_EVENT}" != "" ]]; then
  PROD_TS=$(date -d "${PROD_MAX_EVENT}" +%s 2>/dev/null || echo 0)
  DRILL_TS=$(date -d "${MAX_EVENT}" +%s 2>/dev/null || echo 0)
  if (( PROD_TS > 0 && DRILL_TS > 0 )); then
    RPO_SECONDS=$(( PROD_TS - DRILL_TS ))
    log "RPO: ${RPO_SECONDS}s (target ≤ ${RPO_TARGET_SECONDS}s)"
  fi
fi

DRILL_END=$(date +%s)
RTO_SECONDS=$(( DRILL_END - DRILL_START ))
log "RTO so far: ${RTO_SECONDS}s (target ≤ ${RTO_TARGET_SECONDS}s)"

# ── Results assessment ────────────────────────────────────────────────────────
RPO_STATUS="UNKNOWN"
RTO_STATUS="UNKNOWN"

if [[ "${RPO_SECONDS}" != "UNKNOWN" ]]; then
  if (( RPO_SECONDS <= RPO_TARGET_SECONDS )); then
    RPO_STATUS="PASS"
  else
    RPO_STATUS="FAIL"
  fi
fi

if (( RTO_SECONDS <= RTO_TARGET_SECONDS )); then
  RTO_STATUS="PASS"
else
  RTO_STATUS="FAIL"
fi

# ── Write results file ────────────────────────────────────────────────────────
mkdir -p "${RESULTS_DIR}"
cat > "${RESULTS_FILE}" <<EOF
# DR Restore Drill Results — ${DRILL_DATE}

> Automated by \`infra/kubernetes/base/cnpg/dr-restore-drill.sh\`

## Drill metadata

| Field | Value |
|---|---|
| Drill date | ${DRILL_DATE} |
| Drill start | ${DRILL_START_HM} |
| Recovery target time | ${RECOVERY_TARGET_TIME} |
| Operator | <!-- fill in --> |
| Drill cluster namespace | ${DRILL_NS} |

## Timing

| Metric | Measured | Target | Status |
|---|---|---|---|
| Cluster ready (recovery elapsed) | ${RECOVERY_ELAPSED}s ($(( RECOVERY_ELAPSED / 60 ))m) | N/A | — |
| RPO (max event lag) | ${RPO_SECONDS}s | ≤ ${RPO_TARGET_SECONDS}s (5m) | **${RPO_STATUS}** |
| RTO (total drill time) | ${RTO_SECONDS}s ($(( RTO_SECONDS / 60 ))m) | ≤ ${RTO_TARGET_SECONDS}s (60m) | **${RTO_STATUS}** |

## Clinical invariants

| Check | Value | Assessment |
|---|---|---|
| admissions (admitted) | ${ADMISSIONS} | <!-- PASS/FAIL/note --> |
| max(clinical_timeline_events.created_at) | ${MAX_EVENT} | <!-- close to T? --> |
| migration count | ${MIGRATION_COUNT} | <!-- matches prod? --> |
| users count | ${USERS_COUNT} | <!-- plausible? --> |
| tenants | ${TENANTS} | <!-- expected? --> |

## Backend smoke test

<!-- Operator: point a local backend at the drill cluster and record: -->
- [ ] \`GET /health/deep\` → 200
- [ ] One chart read (e.g. GET /api/patients/{id}/timeline) → data matches T
- [ ] OPD admission count endpoint → matches invariant above

## Findings

<!-- Any deviations, issues, or observations. -->
<!-- RTO/RPO breach → high-severity finding. Log it here and file a ticket. -->

## Actions

<!-- Next steps, ticket references, runbook updates. -->

## Teardown confirmation

<!-- Operator: confirm the drill namespace was deleted after the drill. -->
- [ ] \`kubectl delete namespace ${DRILL_NS}\` completed
- [ ] No drill pods remain: \`kubectl get pods -n ${DRILL_NS}\` → 0 results
EOF

log "Results written to: ${RESULTS_FILE}"

# ── Tear down ─────────────────────────────────────────────────────────────────
log "=== Tearing down drill namespace (PHI data) ==="
kubectl delete namespace "${DRILL_NS}" --wait=true
log "Namespace ${DRILL_NS} deleted."

# ── Summary ───────────────────────────────────────────────────────────────────
log ""
log "=== DR DRILL SUMMARY ==="
log "  RPO: ${RPO_SECONDS}s — ${RPO_STATUS} (target ≤ ${RPO_TARGET_SECONDS}s)"
log "  RTO: ${RTO_SECONDS}s — ${RTO_STATUS} (target ≤ ${RTO_TARGET_SECONDS}s)"
log "  Clinical invariants: see ${RESULTS_FILE}"
log ""

if [[ "${RTO_STATUS}" == "FAIL" || "${RPO_STATUS}" == "FAIL" ]]; then
  err "TARGET BREACH DETECTED. File a high-severity finding and update this runbook."
  exit 1
fi

log "Drill complete. Results at ${RESULTS_FILE}."
log "Commit the results file: git add ${RESULTS_FILE} && git commit -m 'ops: DR drill ${DRILL_DATE} results'"
