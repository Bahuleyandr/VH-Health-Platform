#!/usr/bin/env bash
set -euo pipefail

DRILL_NS="vhhealth-restore-proof"
DRILL_CLUSTER="vhhealth-pg-drill"
READER_STORE="vhhealth-pg18-reader"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/dr-restore-drill.yaml"
EXPECTED_IMAGE="ghcr.io/cloudnative-pg/postgresql:18.4-standard-bookworm@sha256:0ec6b32ab5b644aa51da58443c5ac2c1724d97de0d2a88961920d437b71b9ad8"
created_store=false
created_cluster=false
cluster_uid=""
store_uid=""
proxy_pid=""
proxy_log=""
rendered_manifest=""
restore_start_epoch=""
restore_start_time=""

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

cleanup() {
  original_status=$?
  trap - EXIT INT TERM
  cleanup_failed=false
  cluster_absent=true
  if [[ "${created_cluster}" == "true" || "${created_store}" == "true" ]]; then
    proxy_log="$(mktemp)"
    kubectl proxy --port=0 >"${proxy_log}" 2>&1 &
    proxy_pid=$!
    for _ in $(seq 1 50); do
      proxy_address="$(grep -Eo '127\.0\.0\.1:[0-9]+' "${proxy_log}" | head -1 || true)"
      [[ -n "${proxy_address}" ]] && break
      kill -0 "${proxy_pid}" 2>/dev/null || break
      sleep 0.1
    done
    if [[ -z "${proxy_address:-}" ]]; then
      log "ERROR: could not start a UID-preconditioned cleanup API proxy"
      cleanup_failed=true
      [[ "${created_cluster}" != "true" ]] || cluster_absent=false
    elif [[ "${created_cluster}" == "true" &&
      "$(kubectl get cluster "${DRILL_CLUSTER}" -n "${DRILL_NS}" \
      -o jsonpath='{.metadata.labels.vhhealth\.app/disposable-restore-proof}:{.metadata.uid}' 2>/dev/null || true)" == "true:${cluster_uid}" ]]; then
      curl --fail --silent --show-error -X DELETE \
        -H "Content-Type: application/json" \
        --data-binary "{\"apiVersion\":\"v1\",\"kind\":\"DeleteOptions\",\"preconditions\":{\"uid\":\"${cluster_uid}\"}}" \
        "http://${proxy_address}/apis/postgresql.cnpg.io/v1/namespaces/${DRILL_NS}/clusters/${DRILL_CLUSTER}" >/dev/null ||
        cleanup_failed=true
      if ! kubectl wait --for=delete "cluster/${DRILL_CLUSTER}" -n "${DRILL_NS}" --timeout=10m; then
        cleanup_failed=true
        cluster_absent=false
      fi
    elif [[ "${created_cluster}" == "true" ]]; then
      log "ERROR: refusing to delete Cluster; disposable label or created UID changed"
      cleanup_failed=true
      cluster_absent=false
    else
      cluster_absent=true
    fi
    if [[ "${created_store}" == "true" && "${cluster_absent}" != "true" ]]; then
      log "ERROR: refusing to delete ObjectStore before Cluster deletion is confirmed"
      cleanup_failed=true
    elif [[ "${created_store}" == "true" && -n "${proxy_address:-}" &&
      "$(kubectl get objectstore "${READER_STORE}" -n "${DRILL_NS}" \
      -o jsonpath='{.metadata.labels.vhhealth\.app/disposable-restore-proof}:{.metadata.uid}' 2>/dev/null || true)" == "true:${store_uid}" ]]; then
      curl --fail --silent --show-error -X DELETE \
        -H "Content-Type: application/json" \
        --data-binary "{\"apiVersion\":\"v1\",\"kind\":\"DeleteOptions\",\"preconditions\":{\"uid\":\"${store_uid}\"}}" \
        "http://${proxy_address}/apis/barmancloud.cnpg.io/v1/namespaces/${DRILL_NS}/objectstores/${READER_STORE}" >/dev/null ||
        cleanup_failed=true
    elif [[ "${created_store}" == "true" ]]; then
      log "ERROR: refusing to delete ObjectStore; disposable label or created UID changed"
      cleanup_failed=true
    fi
  fi
  [[ -z "${proxy_pid}" ]] || kill "${proxy_pid}" 2>/dev/null || true
  [[ -z "${proxy_log}" ]] || rm -f -- "${proxy_log}"
  [[ -z "${rendered_manifest}" ]] || rm -f -- "${rendered_manifest}"
  if [[ "${original_status}" -eq 0 && "${cleanup_failed}" == "true" ]]; then
    exit 1
  fi
  exit "${original_status}"
}
trap cleanup EXIT INT TERM

for cmd in kubectl curl grep head seq mktemp awk sed sha256sum date tail; do
  command -v "${cmd}" >/dev/null || fail "Required command '${cmd}' is unavailable"
done

: "${RESTORE_TARGET_TIME:?Set the approved RFC3339 restore target}"
: "${SOURCE_SAFE_POINT_TIME:?Set the source safe-point RFC3339 time}"
: "${APPROVED_TEST_TENANT_ID:?Set the approved test tenant UUID}"
: "${APPROVED_TEST_PATIENT_UID:?Set the approved test patient UUID}"
: "${EXPECTED_ACTIVE_ADMISSIONS:?Set the approved active-admission count}"
: "${EXPECTED_TIMELINE_MIN:?Set the minimum test-patient timeline count}"
: "${EXPECTED_AUDIT_MIN:?Set the minimum test-patient audit count}"
: "${EXPECTED_MIGRATION_COUNT:?Set the expected finished migration count}"
: "${EXPECTED_SCHEMA_CHECKSUM:?Set the expected schema checksum}"
: "${APPLICATION_READ_URL:?Set the disposable application clinical-read URL}"
: "${APPLICATION_READ_TOKEN:?Set its short-lived read-only token}"
: "${APPLICATION_EXPECTED_MARKER:?Set a PHI-free expected response marker}"
: "${SOURCE_COMMIT:?Set the full source commit}"
: "${LOCK_PROOF_SHA256:?Set the approved lock-proof digest}"
: "${DRILL_RUN_ID:?Set a unique run ID}"
: "${EVIDENCE_OUTPUT:?Set a protected, off-site-bound evidence output path}"

uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
rfc3339_pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
grep -Eq "${rfc3339_pattern}" <<<"${RESTORE_TARGET_TIME}" ||
  fail "RESTORE_TARGET_TIME is not RFC3339 UTC"
grep -Eq "${rfc3339_pattern}" <<<"${SOURCE_SAFE_POINT_TIME}" ||
  fail "SOURCE_SAFE_POINT_TIME is not RFC3339 UTC"
grep -Eq "${uuid_pattern}" <<<"${APPROVED_TEST_TENANT_ID}" ||
  fail "APPROVED_TEST_TENANT_ID is not a UUID"
grep -Eq "${uuid_pattern}" <<<"${APPROVED_TEST_PATIENT_UID}" ||
  fail "APPROVED_TEST_PATIENT_UID is not a UUID"
for expected_count in "${EXPECTED_ACTIVE_ADMISSIONS}" "${EXPECTED_TIMELINE_MIN}" \
  "${EXPECTED_AUDIT_MIN}" "${EXPECTED_MIGRATION_COUNT}"; do
  grep -Eq '^[0-9]+$' <<<"${expected_count}" ||
    fail "Expected counts must be non-negative integers"
done
grep -Eq '^[0-9a-f]{32}$' <<<"${EXPECTED_SCHEMA_CHECKSUM}" ||
  fail "EXPECTED_SCHEMA_CHECKSUM is invalid"
grep -Eq '^[0-9a-f]{40}$' <<<"${SOURCE_COMMIT}" ||
  fail "SOURCE_COMMIT is invalid"
grep -Eq '^[0-9a-f]{64}$' <<<"${LOCK_PROOF_SHA256}" ||
  fail "LOCK_PROOF_SHA256 is invalid"
[[ "${APPLICATION_READ_URL}" == https://* &&
  "${APPLICATION_READ_URL}" != *OWNER_INPUT* &&
  "${APPLICATION_READ_URL}" != *.invalid/* ]] ||
  fail "APPLICATION_READ_URL must be an approved HTTPS endpoint"

target_epoch="$(date -u -d "${RESTORE_TARGET_TIME}" +%s)" ||
  fail "Cannot parse RESTORE_TARGET_TIME"
source_epoch="$(date -u -d "${SOURCE_SAFE_POINT_TIME}" +%s)" ||
  fail "Cannot parse SOURCE_SAFE_POINT_TIME"
(( target_epoch <= source_epoch )) ||
  fail "Restore target cannot be later than the captured source safe point"
restore_only_rpo_seconds=$((source_epoch - target_epoch))

rendered_manifest="$(mktemp)"
sed "s|2000-01-01T00:00:00Z|${RESTORE_TARGET_TIME}|g" \
  "${MANIFEST}" >"${rendered_manifest}"

kubectl get namespace "${DRILL_NS}" >/dev/null ||
  fail "Restricted namespace ${DRILL_NS} is not installed"
kubectl get secret cnpg-dr-reader-credentials -n "${DRILL_NS}" >/dev/null ||
  fail "Read-only DR credential is not sealed in ${DRILL_NS}"
if kubectl get cluster "${DRILL_CLUSTER}" -n "${DRILL_NS}" >/dev/null 2>&1; then
  fail "Refusing to overwrite existing Cluster/${DRILL_CLUSTER}"
fi
if kubectl get objectstore "${READER_STORE}" -n "${DRILL_NS}" >/dev/null 2>&1; then
  fail "Refusing to overwrite existing ObjectStore/${READER_STORE}"
fi

restore_start_epoch="$(date -u +%s)"
restore_start_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
log "Creating reader-only ObjectStore for target-time PITR"
awk 'BEGIN { doc=0 } /^---[[:space:]]*$/ { doc++; next } doc == 1 { print }' \
  "${rendered_manifest}" | kubectl create -f -
created_store=true
store_uid="$(kubectl get objectstore "${READER_STORE}" -n "${DRILL_NS}" -o jsonpath='{.metadata.uid}')"
[[ -n "${store_uid}" ]] || fail "Created ObjectStore did not expose a stable UID"

log "Creating disposable restore Cluster"
awk 'BEGIN { doc=0 } /^---[[:space:]]*$/ { doc++; next } doc == 2 { print }' \
  "${rendered_manifest}" | kubectl create -f -
created_cluster=true
cluster_uid="$(kubectl get cluster "${DRILL_CLUSTER}" -n "${DRILL_NS}" -o jsonpath='{.metadata.uid}')"
[[ -n "${cluster_uid}" ]] || fail "Created Cluster did not expose a stable UID"

deadline=$(( $(date +%s) + 3000 ))
while (( $(date +%s) < deadline )); do
  phase="$(kubectl get cluster "${DRILL_CLUSTER}" -n "${DRILL_NS}" \
    -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  [[ "${phase}" == "Cluster in healthy state" ]] && break
  sleep 20
done
[[ "${phase:-}" == "Cluster in healthy state" ]] ||
  fail "Restore did not become healthy within 50 minutes"
database_ready_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

actual_image="$(kubectl get cluster "${DRILL_CLUSTER}" -n "${DRILL_NS}" \
  -o jsonpath='{.spec.imageName}')"
[[ "${actual_image}" == "${EXPECTED_IMAGE}" ]] ||
  fail "Restored Cluster image differs from the qualified PG18 image"
status_image="$(kubectl get cluster "${DRILL_CLUSTER}" -n "${DRILL_NS}" \
  -o jsonpath='{.status.pgDataImageInfo.image}')"
status_major="$(kubectl get cluster "${DRILL_CLUSTER}" -n "${DRILL_NS}" \
  -o jsonpath='{.status.pgDataImageInfo.majorVersion}')"
[[ "${status_image}" == "${EXPECTED_IMAGE}" && "${status_major}" == "18" ]] ||
  fail "Restored Cluster status does not report the qualified PostgreSQL 18 image"

primary="$(kubectl get pod -n "${DRILL_NS}" \
  -l "cnpg.io/cluster=${DRILL_CLUSTER},role=primary" \
  -o jsonpath='{.items[0].metadata.name}')"
run_sql() {
  kubectl exec -n "${DRILL_NS}" "${primary}" -c postgres -- \
    psql -U postgres -d vhhealth -v ON_ERROR_STOP=1 -qAtc "$1"
}

log "Checking roles, schema, migrations, checksums, and clinical invariants"
run_sql "SELECT count(*) = 4 FROM pg_roles WHERE rolname IN ('vhhealth','vhhealth_app','vhhealth_runtime','vhhealth_readonly');" | grep -qx t
schema_checksum="$(run_sql "SELECT md5(string_agg(table_schema || '.' || table_name || '.' || ordinal_position || ':' || column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default,''), ',' ORDER BY table_schema, table_name, ordinal_position)) FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema');")"
[[ "${schema_checksum}" == "${EXPECTED_SCHEMA_CHECKSUM}" ]] ||
  fail "Restored schema checksum differs from the approved baseline"
run_sql "SHOW data_checksums;" | grep -qx on
run_sql "SELECT installed_version IS NOT NULL AND installed_version = default_version FROM pg_available_extensions WHERE name='vector';" | grep -qx t
vector_distance="$(run_sql "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;")"
migration_count="$(run_sql "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
[[ "${migration_count}" == "${EXPECTED_MIGRATION_COUNT}" ]] ||
  fail "Migration ledger differs from the approved candidate release"
run_sql "SELECT set_config('app.current_tenant_id','${APPROVED_TEST_TENANT_ID}',false); SET ROLE vhhealth_runtime; SELECT current_user = 'vhhealth_runtime';" | tail -1 | grep -qx t
run_sql "SELECT set_config('app.current_tenant_id','${APPROVED_TEST_TENANT_ID}',false); SET ROLE vhhealth_runtime; SELECT count(*) = 1 FROM tenants WHERE id = '${APPROVED_TEST_TENANT_ID}'::uuid;" | tail -1 | grep -qx t
run_sql "SELECT set_config('app.current_tenant_id','${APPROVED_TEST_TENANT_ID}',false); SET ROLE vhhealth_runtime; SELECT count(*) = ${EXPECTED_ACTIVE_ADMISSIONS} FROM admissions WHERE tenant_id = '${APPROVED_TEST_TENANT_ID}'::uuid AND status IN ('admitted','transferred');" | tail -1 | grep -qx t
run_sql "SELECT set_config('app.current_tenant_id','${APPROVED_TEST_TENANT_ID}',false); SET ROLE vhhealth_runtime; SELECT count(*) >= ${EXPECTED_TIMELINE_MIN} FROM clinical_timeline_events WHERE tenant_id = '${APPROVED_TEST_TENANT_ID}'::uuid AND patient_uid = '${APPROVED_TEST_PATIENT_UID}'::uuid AND occurred_at <= TIMESTAMPTZ '${RESTORE_TARGET_TIME}';" | tail -1 | grep -qx t
run_sql "SELECT set_config('app.current_tenant_id','${APPROVED_TEST_TENANT_ID}',false); SET ROLE vhhealth_runtime; SELECT count(*) >= ${EXPECTED_AUDIT_MIN} FROM clinical_audit_events WHERE tenant_id = '${APPROVED_TEST_TENANT_ID}'::uuid AND patient_uid = '${APPROVED_TEST_PATIENT_UID}'::uuid AND occurred_at <= TIMESTAMPTZ '${RESTORE_TARGET_TIME}';" | tail -1 | grep -qx t
roles_checksum="$(run_sql "SELECT md5(string_agg(rolname || ':' || rolcanlogin::text || ':' || rolsuper::text || ':' || rolbypassrls::text, ',' ORDER BY rolname)) FROM pg_roles WHERE rolname IN ('vhhealth','vhhealth_app','vhhealth_runtime','vhhealth_readonly');")"

application_response="$(mktemp)"
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${APPLICATION_READ_TOKEN}" \
  -H "X-VH-Continuity-Drill: ${DRILL_RUN_ID}" \
  "${APPLICATION_READ_URL}" >"${application_response}"
grep -Fq "${APPLICATION_EXPECTED_MARKER}" "${application_response}" ||
  fail "Application clinical-read marker did not match"
application_response_sha256="$(sha256sum "${application_response}" | awk '{print $1}')"
rm -f -- "${application_response}"
application_ready_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
restore_only_rto_seconds=$(( $(date -u +%s) - restore_start_epoch ))
tenant_hash="$(printf '%s' "${APPROVED_TEST_TENANT_ID}" | sha256sum | awk '{print $1}')"
patient_hash="$(printf '%s' "${APPROVED_TEST_PATIENT_UID}" | sha256sum | awk '{print $1}')"

umask 077
cat >"${EVIDENCE_OUTPUT}" <<EOF
evidence_schema=c6.2-v1
drill_run_id=${DRILL_RUN_ID}
source_commit=${SOURCE_COMMIT}
lock_proof_sha256=${LOCK_PROOF_SHA256}
restore_target_time=${RESTORE_TARGET_TIME}
source_safe_point_time=${SOURCE_SAFE_POINT_TIME}
restore_start_time=${restore_start_time}
database_ready_time=${database_ready_time}
application_ready_time=${application_ready_time}
restore_only_rto_seconds=${restore_only_rto_seconds}
restore_only_rpo_seconds=${restore_only_rpo_seconds}
restore_only_decision_authority=C-D1
restore_only_ratification=PENDING_OWNER
warm_standby_target_rto=approximately_one_hour
warm_standby_target_rpo=seconds
warm_standby_measurement=NOT_RUN_PHASE_2
warm_standby_decision_authority=C-D9
schema_checksum=${schema_checksum}
roles_checksum=${roles_checksum}
migration_count=${migration_count}
vector_distance=${vector_distance}
clinical_application_read=passed
application_response_sha256=${application_response_sha256}
approved_test_tenant_sha256=${tenant_hash}
approved_test_patient_sha256=${patient_hash}
EOF
evidence_sha256="$(sha256sum "${EVIDENCE_OUTPUT}" | awk '{print $1}')"
printf 'evidence_path=%s\nevidence_sha256=%s\n' \
  "${EVIDENCE_OUTPUT}" "${evidence_sha256}"

log "Restore-only drill passed; C-D9 warm-promotion measurement remains not run"
