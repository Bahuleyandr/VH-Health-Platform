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
  if [[ "${original_status}" -eq 0 && "${cleanup_failed}" == "true" ]]; then
    exit 1
  fi
  exit "${original_status}"
}
trap cleanup EXIT INT TERM

for cmd in kubectl curl grep head seq mktemp awk; do
  command -v "${cmd}" >/dev/null || fail "Required command '${cmd}' is unavailable"
done

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

log "Creating reader-only ObjectStore"
awk 'BEGIN { doc=0 } /^---[[:space:]]*$/ { doc++; next } doc == 1 { print }' \
  "${MANIFEST}" | kubectl create -f -
created_store=true
store_uid="$(kubectl get objectstore "${READER_STORE}" -n "${DRILL_NS}" -o jsonpath='{.metadata.uid}')"
[[ -n "${store_uid}" ]] || fail "Created ObjectStore did not expose a stable UID"

log "Creating disposable restore Cluster"
awk 'BEGIN { doc=0 } /^---[[:space:]]*$/ { doc++; next } doc == 2 { print }' \
  "${MANIFEST}" | kubectl create -f -
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

log "Checking roles, schema, checksums, and pgvector after recovery"
run_sql "SELECT count(*) = 4 FROM pg_roles WHERE rolname IN ('vhhealth','vhhealth_app','vhhealth_runtime','vhhealth_readonly');" | grep -qx t
schema_checksum="$(run_sql "SELECT md5(string_agg(table_schema || '.' || table_name || '.' || ordinal_position || ':' || column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default,''), ',' ORDER BY table_schema, table_name, ordinal_position)) FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema');")"
[[ -n "${schema_checksum}" ]] || fail "Restored schema checksum is empty"
run_sql "SHOW data_checksums;" | grep -qx on
run_sql "SELECT installed_version IS NOT NULL AND installed_version = default_version FROM pg_available_extensions WHERE name='vector';" | grep -qx t
vector_distance="$(run_sql "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;")"
run_sql "SET ROLE vhhealth_runtime; SELECT current_user = 'vhhealth_runtime';" | grep -qx t
application_read="$(run_sql "SET ROLE vhhealth_runtime; ${APPLICATION_READ_SQL:-SELECT count(*) FROM users;}")"
roles_checksum="$(run_sql "SELECT md5(string_agg(rolname || ':' || rolcanlogin::text || ':' || rolsuper::text || ':' || rolbypassrls::text, ',' ORDER BY rolname)) FROM pg_roles WHERE rolname IN ('vhhealth','vhhealth_app','vhhealth_runtime','vhhealth_readonly');")"
printf 'schema_checksum=%s\nroles_checksum=%s\nvector_distance=%s\napplication_read=%s\n' \
  "${schema_checksum}" "${roles_checksum}" "${vector_distance}" "${application_read}"

log "DR restore drill passed; cleanup will remove only labeled disposable resources"
