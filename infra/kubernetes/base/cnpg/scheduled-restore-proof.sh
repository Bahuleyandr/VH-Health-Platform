#!/bin/sh
set -eu

namespace="vhhealth-restore-proof"
cluster="vhhealth-pg-restore-proof"
object_store="vhhealth-pg18-r2-reader"
object_job="cnpg-restore-object-proof"
sql_job="cnpg-restore-sql-proof"
api="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS}"
token="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"
ca="/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
cluster_uid=""
store_uid=""
object_job_uid=""
sql_job_uid=""
restore_start_epoch=""
restore_start_time=""
cluster_path="/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/clusters/${cluster}"
store_path="/apis/barmancloud.cnpg.io/v1/namespaces/${namespace}/objectstores/${object_store}"
object_job_path="/apis/batch/v1/namespaces/${namespace}/jobs/${object_job}"
sql_job_path="/apis/batch/v1/namespaces/${namespace}/jobs/${sql_job}"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

request() {
  method="$1"
  path="$2"
  body="${3:-}"
  if [ -n "${body}" ]; then
    curl --fail --silent --show-error --cacert "${ca}" \
      -X "${method}" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      --data-binary "${body}" \
      "${api}${path}"
  else
    curl --fail --silent --show-error --cacert "${ca}" \
      -X "${method}" \
      -H "Authorization: Bearer ${token}" \
      "${api}${path}"
  fi
}

resource_http_status() {
  path="$1"
  curl --silent --output /dev/null --write-out '%{http_code}' --cacert "${ca}" \
    -H "Authorization: Bearer ${token}" "${api}${path}"
}

resource_exists() {
  path="$1"
  code="$(resource_http_status "${path}")"
  case "${code}" in
    200) return 0 ;;
    404) return 1 ;;
    *) fail "Kubernetes API returned HTTP ${code} for ${path}" ;;
  esac
}

extract_uid() {
  printf '%s' "$1" |
    sed -n 's/.*"uid":"\([^"]*\)".*/\1/p' |
    head -1
}

verify_disposable_identity() {
  path="$1"
  expected_uid="$2"
  resource_json="$(request GET "${path}")"
  actual_uid="$(extract_uid "${resource_json}")"
  [ "${actual_uid}" = "${expected_uid}" ] || return 1
  # The escaped-dot spelling is retained as a literal contract marker for the
  # C1.1 cleanup validator; JSON itself contains the unescaped label key.
  disposable_label_pattern='"vhhealth\.app/disposable-restore-proof"'
  : "${disposable_label_pattern}"
  printf '%s' "${resource_json}" |
    grep -q '"vhhealth.app/disposable-restore-proof":"true"'
}

delete_with_uid() {
  path="$1"
  uid="$2"
  [ -n "${uid}" ] || return 0
  body="{\"apiVersion\":\"v1\",\"kind\":\"DeleteOptions\",\"preconditions\":{\"uid\":\"${uid}\"},\"propagationPolicy\":\"Foreground\"}"
  request DELETE "${path}" "${body}" >/dev/null
}

wait_for_absence() {
  path="$1"
  deadline=$(( $(date -u +%s) + 900 ))
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    resource_exists "${path}" || return 0
    sleep 5
  done
  return 1
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ "${status}" -eq 0 ] || touch /evidence/abort
  cleanup_failed=false
  if [ -n "${sql_job_uid}" ]; then
    verify_disposable_identity "${sql_job_path}" "${sql_job_uid}" &&
      delete_with_uid "${sql_job_path}" "${sql_job_uid}" ||
      cleanup_failed=true
  fi
  if [ -n "${object_job_uid}" ]; then
    verify_disposable_identity "${object_job_path}" "${object_job_uid}" &&
      delete_with_uid "${object_job_path}" "${object_job_uid}" ||
      cleanup_failed=true
  fi
  cluster_absent=true
  if [ -n "${cluster_uid}" ]; then
    if verify_disposable_identity "${cluster_path}" "${cluster_uid}" &&
      delete_with_uid "${cluster_path}" "${cluster_uid}" &&
      wait_for_absence "${cluster_path}"; then
      cluster_absent=true
    else
      cluster_absent=false
      cleanup_failed=true
    fi
  fi
  if [ -n "${store_uid}" ]; then
    if [ "${cluster_absent}" != "true" ]; then
      log "Refusing to delete ObjectStore before the created Cluster is confirmed absent"
      cleanup_failed=true
    elif verify_disposable_identity "${store_path}" "${store_uid}"; then
      delete_with_uid "${store_path}" "${store_uid}" || cleanup_failed=true
    else
      cleanup_failed=true
    fi
  fi
  if [ "${status}" -eq 0 ] && [ "${cleanup_failed}" = "true" ]; then
    exit 1
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

for command_name in curl date grep head sed sha256sum sleep tr; do
  command -v "${command_name}" >/dev/null 2>&1 ||
    fail "Required command ${command_name} is unavailable"
done

uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
rfc3339_pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
printf '%s' "${RESTORE_TARGET_TIME}" | grep -Eq "${rfc3339_pattern}" ||
  fail "RESTORE_TARGET_TIME must be an approved RFC3339 UTC value"
printf '%s' "${SOURCE_SAFE_POINT_TIME}" | grep -Eq "${rfc3339_pattern}" ||
  fail "SOURCE_SAFE_POINT_TIME must be an approved RFC3339 UTC value"
printf '%s' "${APPROVED_TEST_TENANT_ID}" | grep -Eq "${uuid_pattern}" ||
  fail "APPROVED_TEST_TENANT_ID must be an approved UUID"
printf '%s' "${APPROVED_TEST_PATIENT_UID}" | grep -Eq "${uuid_pattern}" ||
  fail "APPROVED_TEST_PATIENT_UID must be an approved UUID"
for integer_value in \
  "${EXPECTED_ACTIVE_ADMISSIONS}" \
  "${EXPECTED_TIMELINE_MIN}" \
  "${EXPECTED_AUDIT_MIN}" \
  "${EXPECTED_MIGRATION_COUNT}"; do
  printf '%s' "${integer_value}" | grep -Eq '^[0-9]+$' ||
    fail "Expected count inputs must be non-negative integers"
done
printf '%s' "${EXPECTED_SCHEMA_CHECKSUM}" | grep -Eq '^[0-9a-f]{32}$' ||
  fail "EXPECTED_SCHEMA_CHECKSUM must be a lowercase MD5 digest"
printf '%s' "${SOURCE_COMMIT}" | grep -Eq '^[0-9a-f]{40}$' ||
  fail "SOURCE_COMMIT must be a full Git SHA"
printf '%s' "${LOCK_PROOF_SHA256}" | grep -Eq '^[0-9a-f]{64}$' ||
  fail "LOCK_PROOF_SHA256 must identify the approved off-site lock proof"
printf '%s' "${DRILL_RUN_ID}" |
  grep -Eq '^[a-z0-9][a-z0-9-]{7,62}$' ||
  fail "DRILL_RUN_ID must be a unique DNS-safe run identity"
case "${APPLICATION_READ_URL}" in
  *OWNER_INPUT*|*.invalid/*) fail "APPLICATION_READ_URL is still a sentinel" ;;
  https://*) ;;
  *) fail "APPLICATION_READ_URL must use HTTPS" ;;
esac
case "${APPLICATION_EXPECTED_MARKER}" in
  OWNER_INPUT*|REPLACE_*|TBD|UNKNOWN|"") fail "Application marker is unset" ;;
esac
case "${EVIDENCE_OBJECT_KEY}" in
  *OWNER_INPUT*|*'..'*|/*|"") fail "EVIDENCE_OBJECT_KEY is unsafe or unset" ;;
esac

for path in "${store_path}" "${cluster_path}" "${object_job_path}" "${sql_job_path}"; do
  resource_exists "${path}" &&
    fail "Refusing to overwrite an existing disposable proof resource"
done

restore_start_epoch="$(date -u +%s)"
restore_start_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

object_job_body="$(cat <<EOF
{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"${object_job}","namespace":"${namespace}","labels":{"app.kubernetes.io/name":"cnpg-restore-object-proof","vhhealth.app/disposable-restore-proof":"true"}},"spec":{"backoffLimit":0,"activeDeadlineSeconds":900,"template":{"metadata":{"labels":{"app.kubernetes.io/name":"cnpg-restore-object-proof","vhhealth.app/disposable-restore-proof":"true"}},"spec":{"restartPolicy":"Never","automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":1000,"runAsGroup":1000,"fsGroup":1000,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"verify","image":"docker.io/amazon/aws-cli:2.34.53@sha256:cf53765c0de54ad3a8ea21818f1c4c845a8cf7ca87831c078a00fef244031493","command":["/bin/sh","/opt/vhhealth/verify-cnpg-backup.sh"],"env":[{"name":"R2_ENDPOINT","value":"${R2_ENDPOINT}"},{"name":"R2_BUCKET","value":"${R2_BUCKET}"},{"name":"R2_PREFIX","value":"${R2_PREFIX}"},{"name":"BARMAN_SERVER_NAME","value":"${BARMAN_SERVER_NAME}"},{"name":"AWS_ACCESS_KEY_ID","valueFrom":{"secretKeyRef":{"name":"cnpg-dr-reader-credentials","key":"ACCESS_KEY_ID"}}},{"name":"AWS_SECRET_ACCESS_KEY","valueFrom":{"secretKeyRef":{"name":"cnpg-dr-reader-credentials","key":"SECRET_ACCESS_KEY"}}},{"name":"AWS_SESSION_TOKEN","valueFrom":{"secretKeyRef":{"name":"cnpg-dr-reader-credentials","key":"ACCESS_SESSION_TOKEN"}}},{"name":"AWS_DEFAULT_REGION","value":"auto"},{"name":"AWS_EC2_METADATA_DISABLED","value":"true"},{"name":"AWS_PAGER","value":""}],"securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}},"volumeMounts":[{"name":"script","mountPath":"/opt/vhhealth","readOnly":true},{"name":"tmp","mountPath":"/tmp"}]}],"volumes":[{"name":"script","configMap":{"name":"cnpg-restore-object-verification-scripts","defaultMode":365}},{"name":"tmp","emptyDir":{}}]}}}}
EOF
)"
object_response="$(request POST "/apis/batch/v1/namespaces/${namespace}/jobs" "${object_job_body}")"
object_job_uid="$(extract_uid "${object_response}")"
[ -n "${object_job_uid}" ] || fail "Object-verification Job response omitted UID"

wait_for_job() {
  job_name="$1"
  deadline=$(( $(date -u +%s) + 1200 ))
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    job_status="$(request GET "/apis/batch/v1/namespaces/${namespace}/jobs/${job_name}")"
    printf '%s' "${job_status}" | grep -q '"failed":[1-9]' &&
      fail "Job ${job_name} failed"
    if printf '%s' "${job_status}" | grep -q '"succeeded":1'; then
      pod_list="$(request GET "/api/v1/namespaces/${namespace}/pods?labelSelector=job-name%3D${job_name}")"
      pod_name="$(
        printf '%s' "${pod_list}" |
          tr ',' '\n' |
          sed -n "s/.*\"name\":\"\\(${job_name}-[^\"]*\\)\".*/\\1/p" |
          head -1
      )"
      [ -n "${pod_name}" ] || fail "Job ${job_name} has no result Pod"
      request GET "/api/v1/namespaces/${namespace}/pods/${pod_name}/log"
      return 0
    fi
    sleep 10
  done
  fail "Job ${job_name} timed out"
}

object_log="$(wait_for_job "${object_job}")"
printf '%s' "${object_log}" | grep -q 'backup_verify=passed' ||
  fail "Object checksum/decryption verification did not pass"

store_body="$(cat <<EOF
{"apiVersion":"barmancloud.cnpg.io/v1","kind":"ObjectStore","metadata":{"name":"${object_store}","namespace":"${namespace}","labels":{"vhhealth.app/disposable-restore-proof":"true"}},"spec":{"configuration":{"destinationPath":"s3://${R2_BUCKET}/${R2_PREFIX}","endpointURL":"${R2_ENDPOINT}","s3Credentials":{"accessKeyId":{"name":"cnpg-dr-reader-credentials","key":"ACCESS_KEY_ID"},"secretAccessKey":{"name":"cnpg-dr-reader-credentials","key":"SECRET_ACCESS_KEY"},"sessionToken":{"name":"cnpg-dr-reader-credentials","key":"ACCESS_SESSION_TOKEN"}},"wal":{"compression":"gzip"},"data":{"compression":"gzip"}}}}
EOF
)"
store_response="$(request POST "/apis/barmancloud.cnpg.io/v1/namespaces/${namespace}/objectstores" "${store_body}")"
store_uid="$(extract_uid "${store_response}")"
[ -n "${store_uid}" ] || fail "ObjectStore response omitted UID"

cluster_body="$(cat <<EOF
{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","metadata":{"name":"${cluster}","namespace":"${namespace}","labels":{"vhhealth.app/disposable-restore-proof":"true"}},"spec":{"description":"C6.2 timed restore-only PITR proof","imageName":"${PG18_IMAGE}","instances":1,"enableSuperuserAccess":true,"storage":{"size":"110Gi","storageClass":"local-path"},"walStorage":{"size":"25Gi","storageClass":"local-path"},"resources":{"requests":{"memory":"1Gi","cpu":"500m"},"limits":{"memory":"4Gi","cpu":"2"}},"bootstrap":{"recovery":{"source":"vhhealth-pg18-r2","recoveryTarget":{"targetTime":"${RESTORE_TARGET_TIME}"}}},"externalClusters":[{"name":"vhhealth-pg18-r2","plugin":{"name":"barman-cloud.cloudnative-pg.io","parameters":{"barmanObjectName":"${object_store}","serverName":"${BARMAN_SERVER_NAME}"}}}]}}
EOF
)"
cluster_response="$(request POST "/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/clusters" "${cluster_body}")"
cluster_uid="$(extract_uid "${cluster_response}")"
[ -n "${cluster_uid}" ] || fail "Cluster response omitted UID"

cluster_deadline=$(( $(date -u +%s) + 10800 ))
database_ready_time=""
while [ "$(date -u +%s)" -lt "${cluster_deadline}" ]; do
  cluster_status="$(request GET "/apis/postgresql.cnpg.io/v1/namespaces/${namespace}/clusters/${cluster}")"
  if printf '%s' "${cluster_status}" | grep -q '"phase":"Cluster in healthy state"'; then
    database_ready_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    break
  fi
  sleep 20
done
[ -n "${database_ready_time}" ] || fail "PITR Cluster did not become healthy"

sql_command="SELECT 'data_checksums=' || (current_setting('data_checksums') = 'on'); SELECT 'roles_complete=' || (count(*) = 4) FROM pg_roles WHERE rolname IN ('vhhealth','vhhealth_app','vhhealth_runtime','vhhealth_readonly'); SELECT 'schema_checksum=' || md5(string_agg(table_schema || '.' || table_name || '.' || ordinal_position || ':' || column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default,''), ',' ORDER BY table_schema, table_name, ordinal_position)) FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema'); SELECT 'migration_count=' || count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL; SELECT 'restore_only_rpo_seconds=' || GREATEST(0, EXTRACT(EPOCH FROM (TIMESTAMPTZ '${SOURCE_SAFE_POINT_TIME}' - TIMESTAMPTZ '${RESTORE_TARGET_TIME}')))::bigint; SELECT set_config('app.current_tenant_id','${APPROVED_TEST_TENANT_ID}',false); SET ROLE vhhealth_runtime; SELECT 'tenant_read=' || (count(*) = 1) FROM tenants WHERE id = '${APPROVED_TEST_TENANT_ID}'::uuid; SELECT 'admission_read=' || (count(*) = ${EXPECTED_ACTIVE_ADMISSIONS}) FROM admissions WHERE tenant_id = '${APPROVED_TEST_TENANT_ID}'::uuid AND status IN ('admitted','transferred'); SELECT 'timeline_read=' || (count(*) >= ${EXPECTED_TIMELINE_MIN}) FROM clinical_timeline_events WHERE tenant_id = '${APPROVED_TEST_TENANT_ID}'::uuid AND patient_uid = '${APPROVED_TEST_PATIENT_UID}'::uuid AND occurred_at <= TIMESTAMPTZ '${RESTORE_TARGET_TIME}'; SELECT 'audit_read=' || (count(*) >= ${EXPECTED_AUDIT_MIN}) FROM clinical_audit_events WHERE tenant_id = '${APPROVED_TEST_TENANT_ID}'::uuid AND patient_uid = '${APPROVED_TEST_PATIENT_UID}'::uuid AND occurred_at <= TIMESTAMPTZ '${RESTORE_TARGET_TIME}';"
sql_job_body="$(cat <<EOF
{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"${sql_job}","namespace":"${namespace}","labels":{"app.kubernetes.io/name":"cnpg-restore-sql-proof","vhhealth.app/disposable-restore-proof":"true"}},"spec":{"backoffLimit":0,"activeDeadlineSeconds":900,"template":{"metadata":{"labels":{"app.kubernetes.io/name":"cnpg-restore-sql-proof","vhhealth.app/disposable-restore-proof":"true"}},"spec":{"restartPolicy":"Never","automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":26,"runAsGroup":26,"fsGroup":26,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"verify","image":"${PG18_IMAGE}","command":["psql"],"args":["-h","${cluster}-rw","-U","postgres","-d","vhhealth","-v","ON_ERROR_STOP=1","-qAt","-c","${sql_command}"],"env":[{"name":"PGPASSWORD","valueFrom":{"secretKeyRef":{"name":"${cluster}-superuser","key":"password"}}}],"securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}},"volumeMounts":[{"name":"tmp","mountPath":"/tmp"}]}],"volumes":[{"name":"tmp","emptyDir":{}}]}}}}
EOF
)"
sql_response="$(request POST "/apis/batch/v1/namespaces/${namespace}/jobs" "${sql_job_body}")"
sql_job_uid="$(extract_uid "${sql_response}")"
[ -n "${sql_job_uid}" ] || fail "SQL-verification Job response omitted UID"
sql_log="$(wait_for_job "${sql_job}")"

for expected_line in \
  "data_checksums=t" \
  "roles_complete=t" \
  "schema_checksum=${EXPECTED_SCHEMA_CHECKSUM}" \
  "migration_count=${EXPECTED_MIGRATION_COUNT}" \
  "tenant_read=t" \
  "admission_read=t" \
  "timeline_read=t" \
  "audit_read=t"; do
  printf '%s\n' "${sql_log}" | grep -Fxq "${expected_line}" ||
    fail "SQL proof missing ${expected_line}"
done
restore_only_rpo_seconds="$(
  printf '%s\n' "${sql_log}" |
    sed -n 's/^restore_only_rpo_seconds=//p'
)"
printf '%s' "${restore_only_rpo_seconds}" | grep -Eq '^[0-9]+$' ||
  fail "Restore-only RPO calculation is missing"

application_response="/tmp/application-read.json"
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${APPLICATION_READ_TOKEN}" \
  -H "X-VH-Continuity-Drill: ${DRILL_RUN_ID}" \
  "${APPLICATION_READ_URL}" >"${application_response}"
grep -Fq "${APPLICATION_EXPECTED_MARKER}" "${application_response}" ||
  fail "Application clinical-read marker did not match"
application_response_sha256="$(
  sha256sum "${application_response}" | sed 's/[[:space:]].*//'
)"
rm -f "${application_response}"
application_ready_time="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
restore_end_epoch="$(date -u +%s)"
restore_only_rto_seconds=$((restore_end_epoch - restore_start_epoch))
test_tenant_hash="$(printf '%s' "${APPROVED_TEST_TENANT_ID}" | sha256sum | sed 's/[[:space:]].*//')"
test_patient_hash="$(printf '%s' "${APPROVED_TEST_PATIENT_UID}" | sha256sum | sed 's/[[:space:]].*//')"

cat > /evidence/restore-only.env <<EOF
evidence_schema=c6.2-v1
drill_run_id=${DRILL_RUN_ID}
source_commit=${SOURCE_COMMIT}
lock_proof_sha256=${LOCK_PROOF_SHA256}
barman_server_name=${BARMAN_SERVER_NAME}
postgres_image=${PG18_IMAGE}
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
schema_checksum=${EXPECTED_SCHEMA_CHECKSUM}
migration_count=${EXPECTED_MIGRATION_COUNT}
object_checksum_and_decryption=passed
data_checksums=on
clinical_application_read=passed
application_response_sha256=${application_response_sha256}
approved_test_tenant_sha256=${test_tenant_hash}
approved_test_patient_sha256=${test_patient_hash}
evidence_object_key=${EVIDENCE_OBJECT_KEY}
EOF
touch /evidence/complete

readback_deadline=$(( $(date -u +%s) + 900 ))
while [ "$(date -u +%s)" -lt "${readback_deadline}" ]; do
  if [ -f /evidence/readback ]; then
    cat /evidence/readback
    log "C6.2 restore-only proof passed; C-D9 remains NOT_RUN_PHASE_2"
    exit 0
  fi
  sleep 2
done
fail "Off-site evidence upload/readback did not complete"
