#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${REHEARSAL_NAMESPACE:-vhhealth-restore-proof}"
CLUSTER="${REHEARSAL_CLUSTER:-vhhealth-pg18-upgrade-rehearsal}"
PHASE="${REHEARSAL_PHASE:-upgrade}"
EVIDENCE_FILE="${REHEARSAL_EVIDENCE_FILE:-/tmp/vhhealth-pg18-rehearsal.env}"
TARGET_IMAGE="ghcr.io/cloudnative-pg/postgresql:18.4-standard-bookworm@sha256:0ec6b32ab5b644aa51da58443c5ac2c1724d97de0d2a88961920d437b71b9ad8"
EXPECTED_OPERATOR_IMAGE="ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb"
EXPECTED_PLUGIN_IMAGE="ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.13.0@sha256:71589dbac582333442812b07b31f7ea4d00324a8358aac7ca507dabf9f4b6c96"
EXPECTED_SIDECAR_IMAGE="ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.13.0@sha256:990361af3319f9e23aafa0f6d7981f99bf1f69b4e6a85cf1bc7d71d6f09bb288"
APPLICATION_ROLES="'vhhealth','vhhealth_app','vhhealth_readonly','vhhealth_runtime'"
APPLICATION_READ_SQL="${APPLICATION_READ_SQL:-SELECT count(*) FROM synthetic_vector_proof;}"
FIXTURE_CHECKSUM_SQL="${FIXTURE_CHECKSUM_SQL:-SELECT md5(string_agg(id || ':' || embedding::text, ',' ORDER BY id)) FROM synthetic_vector_proof;}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require_file() { [[ -s "$1" ]] || fail "Missing evidence file: $1"; }

for cmd in kubectl grep jq sort comm sed tr date; do
  command -v "${cmd}" >/dev/null || fail "Required command '${cmd}' is unavailable"
done

primary_pod() {
  kubectl get pod -n "${NAMESPACE}" \
    -l "cnpg.io/cluster=$1,role=primary" \
    -o jsonpath='{.items[0].metadata.name}'
}

run_sql() {
  local target_cluster="$1"
  local sql="$2"
  kubectl exec -n "${NAMESPACE}" "$(primary_pod "${target_cluster}")" -c postgres -- \
    psql -U postgres -d vhhealth -v ON_ERROR_STOP=1 -qAtc "${sql}"
}

run_application_read() {
  local target_cluster="$1"
  run_sql "${target_cluster}" \
    "SET ROLE vhhealth_runtime; SELECT current_user = 'vhhealth_runtime';" | grep -qx t ||
    fail "Could not establish vhhealth_runtime as the effective application-read role"
  run_sql "${target_cluster}" "SET ROLE vhhealth_runtime; ${APPLICATION_READ_SQL}"
}

prove_pgvector_files() {
  kubectl exec -n "${NAMESPACE}" "$(primary_pod "$1")" -c postgres -- sh -eu -c \
    'test -f "$(pg_config --sharedir)/extension/vector.control"; test -f "$(pg_config --pkglibdir)/vector.so"'
}

assert_application_roles() {
  run_sql "$1" \
    "SELECT count(*) = 4 FROM pg_roles WHERE rolname IN (${APPLICATION_ROLES});" | grep -qx t ||
    fail "One or more explicit VH Health application roles are missing"
}

application_role_checksum() {
  run_sql "$1" "WITH app_roles AS (
    SELECT oid, rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole,
           rolcreatedb, rolreplication, rolbypassrls, rolconnlimit
    FROM pg_roles WHERE rolname IN (${APPLICATION_ROLES})
  ), role_rows AS (
    SELECT 'attr:' || rolname || ':' || rolcanlogin::text || ':' ||
           rolsuper::text || ':' || rolinherit::text || ':' ||
           rolcreaterole::text || ':' || rolcreatedb::text || ':' ||
           rolreplication::text || ':' || rolbypassrls::text || ':' ||
           rolconnlimit::text AS item
    FROM app_roles
  ), membership_rows AS (
    SELECT 'membership:' || member.rolname || '->' || granted.rolname || ':' ||
           membership.admin_option::text || ':' ||
           membership.inherit_option::text || ':' ||
           membership.set_option::text AS item
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    WHERE member.rolname IN (${APPLICATION_ROLES})
       OR granted.rolname IN (${APPLICATION_ROLES})
  ), combined AS (
    SELECT item FROM role_rows UNION ALL SELECT item FROM membership_rows
  )
  SELECT md5(COALESCE(string_agg(item, ',' ORDER BY item), 'none')) FROM combined;"
}

application_ownership_checksum() {
  run_sql "$1" "WITH owned AS (
    SELECT 'database:' || database.datname || ':' || owner.rolname AS item
    FROM pg_database database JOIN pg_roles owner ON owner.oid = database.datdba
    WHERE owner.rolname IN (${APPLICATION_ROLES})
    UNION ALL
    SELECT 'schema:' || namespace.nspname || ':' || owner.rolname
    FROM pg_namespace namespace JOIN pg_roles owner ON owner.oid = namespace.nspowner
    WHERE owner.rolname IN (${APPLICATION_ROLES})
    UNION ALL
    SELECT 'relation:' || namespace.nspname || '.' || relation.relname || ':' ||
           relation.relkind || ':' || owner.rolname
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner ON owner.oid = relation.relowner
    WHERE owner.rolname IN (${APPLICATION_ROLES})
    UNION ALL
    SELECT 'routine:' || namespace.nspname || '.' || routine.proname || '(' ||
           pg_get_function_identity_arguments(routine.oid) || '):' || owner.rolname
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_roles owner ON owner.oid = routine.proowner
    WHERE owner.rolname IN (${APPLICATION_ROLES})
    UNION ALL
    SELECT 'type:' || namespace.nspname || '.' || type.typname || ':' ||
           type.typtype || ':' || owner.rolname
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    JOIN pg_roles owner ON owner.oid = type.typowner
    WHERE owner.rolname IN (${APPLICATION_ROLES})
  )
  SELECT md5(COALESCE(string_agg(item, ',' ORDER BY item), 'none')) FROM owned;"
}

predefined_role_inventory() {
  run_sql "$1" \
    "SELECT COALESCE(string_agg(rolname, ',' ORDER BY rolname), '') FROM pg_roles WHERE left(rolname, 3) = 'pg_';"
}

csv_delta() {
  local option="$1"
  local before="$2"
  local after="$3"
  comm "${option}" \
    <(printf '%s' "${before}" | tr ',' '\n' | sort) \
    <(printf '%s' "${after}" | tr ',' '\n' | sort) |
    tr '\n' ',' | sed 's/,$//'
}

schema_checksum() {
  run_sql "$1" "SELECT md5(string_agg(table_schema || '.' || table_name || '.' || ordinal_position || ':' || column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default,''), ',' ORDER BY table_schema, table_name, ordinal_position)) FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema');"
}

vector_checksum() {
  run_sql "$1" "SELECT md5(string_agg(id || ':' || embedding::text, ',' ORDER BY id)) FROM synthetic_vector_proof;"
}

evidence_file_value() {
  local file="$1"
  local key="$2"
  local count
  local line
  count="$(grep -c "^${key}=" "${file}" || true)"
  [[ "${count}" == "1" ]] || fail "Evidence ${file} must contain exactly one ${key}= entry"
  line="$(grep "^${key}=" "${file}")"
  [[ -n "${line#*=}" ]] || fail "Evidence ${file} contains an empty ${key}= entry"
  printf '%s' "${line#*=}"
}

evidence_value() {
  evidence_file_value "${EVIDENCE_FILE}" "$1"
}

require_recent_evidence() {
  local file="$1"
  local format="$2"
  local timestamp_key="$3"
  local timestamp
  local timestamp_epoch
  local now_epoch
  require_file "${file}"
  [[ "$(evidence_file_value "${file}" evidence_format)" == "${format}" ]] ||
    fail "Unexpected evidence format in ${file}"
  timestamp="$(evidence_file_value "${file}" "${timestamp_key}")"
  timestamp_epoch="$(date -u -d "${timestamp}" +%s 2>/dev/null)" ||
    fail "Evidence ${file} has an invalid ${timestamp_key}"
  now_epoch="$(date -u +%s)"
  (( timestamp_epoch <= now_epoch + 300 && now_epoch - timestamp_epoch <= 86400 )) ||
    fail "Evidence ${file} is not fresh (must be captured within 24 hours)"
}

require_ladder_evidence() {
  local file="$1"
  local expected
  local actual
  local gate
  require_recent_evidence "${file}" "c1-1-cnpg-ladder-v1" "completed_at"
  expected="$(cat <<'EOF'
operator=1.24.1 kubernetes=1.31 result=passed
operator=1.24.4 kubernetes=1.31 result=passed
operator=1.25.4 kubernetes=1.31 result=passed
operator=1.26.3 kubernetes=1.31 result=passed
operator=1.27.4 kubernetes=1.31 result=passed
kubernetes_transition=1.31->1.32 operator=1.27.4 result=passed
operator=1.27.4 kubernetes=1.32 result=passed
operator=1.28.4 kubernetes=1.32 result=passed
kubernetes_transition=1.32->1.33 operator=1.28.4 result=passed
operator=1.28.4 kubernetes=1.33 result=passed
operator=1.29.2 kubernetes=1.33 result=passed
kubernetes_transition=1.33->1.34 operator=1.29.2 result=passed
operator=1.29.2 kubernetes=1.34 result=passed
operator=1.30.0 kubernetes=1.34 result=passed
EOF
)"
  actual="$(grep -E '^(operator|kubernetes_transition)=' "${file}" || true)"
  [[ "${actual}" == "${expected}" ]] ||
    fail "Operator/Kubernetes ladder evidence is incomplete, duplicated, or out of order"
  for gate in \
    "operator_gate=1.24.1@1.31" "operator_gate=1.24.4@1.31" \
    "operator_gate=1.25.4@1.31" "operator_gate=1.26.3@1.31" \
    "operator_gate=1.27.4@1.31" "transition_gate=1.31->1.32@1.27.4" \
    "operator_gate=1.27.4@1.32" "operator_gate=1.28.4@1.32" \
    "transition_gate=1.32->1.33@1.28.4" "operator_gate=1.28.4@1.33" \
    "operator_gate=1.29.2@1.33" "transition_gate=1.33->1.34@1.29.2" \
    "operator_gate=1.29.2@1.34" "operator_gate=1.30.0@1.34"; do
    grep -Fxq "${gate} cluster_health=passed wal_archiving=passed backup=passed application_read=passed" "${file}" ||
      fail "Operator ladder evidence lacks full health/backup/application proof for ${gate}"
  done
}

assert_live_platform_versions() {
  local version_json
  local server_major
  local server_minor_raw
  local server_minor
  local operator_json
  local plugin_json
  local operator_image
  local plugin_image
  local sidecar_secret
  local sidecar_image
  local target_pod_json

  version_json="$(kubectl version -o json)"
  server_major="$(jq -r '.serverVersion.major' <<<"${version_json}")"
  server_minor_raw="$(jq -r '.serverVersion.minor' <<<"${version_json}")"
  server_minor="${server_minor_raw%%[!0-9]*}"
  [[ "${server_major}" == "1" && "${server_minor}" =~ ^[0-9]+$ && 10#${server_minor} -ge 34 ]] ||
    fail "Live Kubernetes server must be 1.34 or newer before PG18 mutation"

  operator_json="$(kubectl get deployment cnpg-controller-manager -n cnpg-system -o json)"
  operator_image="$(jq -r '.spec.template.spec.containers[] | select(.name == "manager") | .image' <<<"${operator_json}")"
  [[ "${operator_image}" == "${EXPECTED_OPERATOR_IMAGE}" ]] ||
    fail "Live CNPG operator image is not the exact 1.30.0 pin"
  jq -e '((.spec.replicas // 1) > 0) and
    (.status.observedGeneration == .metadata.generation) and
    ((.status.availableReplicas // 0) == (.spec.replicas // 1)) and
    ((.status.readyReplicas // 0) == (.spec.replicas // 1)) and
    ((.status.updatedReplicas // 0) == (.spec.replicas // 1))' \
    <<<"${operator_json}" >/dev/null ||
    fail "Live CNPG operator Deployment is not fully available"

  plugin_json="$(kubectl get deployment barman-cloud -n cnpg-system -o json)"
  plugin_image="$(jq -r '.spec.template.spec.containers[] | select(.name == "barman-cloud") | .image' <<<"${plugin_json}")"
  [[ "${plugin_image}" == "${EXPECTED_PLUGIN_IMAGE}" ]] ||
    fail "Live Barman controller image is not the exact 0.13.0 pin"
  jq -e '((.spec.replicas // 1) > 0) and
    (.status.observedGeneration == .metadata.generation) and
    ((.status.availableReplicas // 0) == (.spec.replicas // 1)) and
    ((.status.readyReplicas // 0) == (.spec.replicas // 1)) and
    ((.status.updatedReplicas // 0) == (.spec.replicas // 1))' \
    <<<"${plugin_json}" >/dev/null ||
    fail "Live Barman Plugin Deployment is not fully available"
  sidecar_secret="$(jq -r '.spec.template.spec.containers[] |
    select(.name == "barman-cloud") | .env[] |
    select(.name == "SIDECAR_IMAGE") | .valueFrom.secretKeyRef.name' <<<"${plugin_json}")"
  [[ -n "${sidecar_secret}" && "${sidecar_secret}" != "null" ]] ||
    fail "Live Barman Deployment does not declare its injected sidecar image Secret"
  sidecar_image="$(kubectl get secret "${sidecar_secret}" -n cnpg-system -o json |
    jq -r '.data.SIDECAR_IMAGE | @base64d')"
  [[ "${sidecar_image}" == "${EXPECTED_SIDECAR_IMAGE}" ]] ||
    fail "Live Barman injected sidecar image is not the exact 0.13.0 pin"
  target_pod_json="$(kubectl get pod "$(primary_pod "${CLUSTER}")" -n "${NAMESPACE}" -o json)"
  jq -e --arg image "${EXPECTED_SIDECAR_IMAGE}" '
    ([.spec.containers[]?, .spec.initContainers[]?] |
      any(.image == $image)) and
    ([.status.containerStatuses[]?, .status.initContainerStatuses[]?] |
      any(.image == $image and .ready == true))' <<<"${target_pod_json}" >/dev/null ||
    fail "Target CNPG primary is not actually running the exact Barman sidecar pin"
  kubectl get crd objectstores.barmancloud.cnpg.io -o json |
    jq -e 'any(.status.conditions[]?; .type == "Established" and .status == "True")' >/dev/null ||
    fail "Barman ObjectStore CRD is not established"
}

assert_live_source_image() {
  local cluster_json
  local pod_json
  cluster_json="$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" -o json)"
  jq -e --arg image "${PG17_SOURCE_IMAGE}" '
    .spec.imageName == $image and
    .status.phase == "Cluster in healthy state" and
    .status.pgDataImageInfo.image == $image and
    (.status.pgDataImageInfo.majorVersion | tostring) == "17"' \
    <<<"${cluster_json}" >/dev/null ||
    fail "Live PG17 Cluster spec/status is not healthy on the exact inventoried image"
  pod_json="$(kubectl get pod "$(primary_pod "${CLUSTER}")" -n "${NAMESPACE}" -o json)"
  jq -e --arg image "${PG17_SOURCE_IMAGE}" '
    any(.spec.containers[]?; .name == "postgres" and .image == $image) and
    any(.status.containerStatuses[]?;
      .name == "postgres" and .image == $image and .ready == true)' \
    <<<"${pod_json}" >/dev/null ||
    fail "Live PG17 primary postgres container is not ready on the exact inventoried image"
}

assert_extensions_current() {
  run_sql "$1" \
    "SELECT bool_and(installed_version = default_version) FROM pg_available_extensions WHERE installed_version IS NOT NULL;" |
    grep -qx t || fail "An installed extension is not at its PG18 image default version"
  run_sql "$1" \
    "SELECT installed_version IS NOT NULL AND installed_version = default_version FROM pg_available_extensions WHERE name = 'vector';" |
    grep -qx t || fail "vector installed_version does not equal its PG18 image default_version"
}

apply_cnpg_extension_updates() {
  local target_cluster="$1"
  local pod
  local data_directory
  local update_file
  pod="$(primary_pod "${target_cluster}")"
  data_directory="$(run_sql "${target_cluster}" "SHOW data_directory;")"
  update_file="${data_directory}/update_extensions.sql"
  if kubectl exec -n "${NAMESPACE}" "${pod}" -c postgres -- test -f "${update_file}"; then
    kubectl exec -n "${NAMESPACE}" "${pod}" -c postgres -- \
      psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f "${update_file}" >/dev/null
    printf 'applied'
  else
    printf 'not-emitted'
  fi
}

reject_production_destination() {
  local destination="$1"
  [[ "${destination}" != "s3://vhhealth-db-backups" &&
     "${destination}" != "s3://vhhealth-db-backups/"* ]] ||
    fail "Synthetic rehearsal must reject the entire production bucket prefix"
}

: "${REHEARSAL_RUN_ID:?Set a unique lowercase run ID for this synthetic rehearsal}"
[[ "${REHEARSAL_RUN_ID}" =~ ^[a-z0-9][a-z0-9-]{7,62}$ ]] ||
  fail "REHEARSAL_RUN_ID must be 8-63 lowercase letters, digits, or hyphens"
[[ "${REHEARSAL_RUN_ID}" != "run-id-required" ]] ||
  fail "Replace the template's static run-id-required marker"
PG18_ARCHIVE_IDENTITY="vhhealth-pg18-rehearsal-${REHEARSAL_RUN_ID}"

if [[ "${PHASE}" == "upgrade" ]]; then
  : "${PG17_SECURE_MINOR:?Set the current secure PG17 minor re-derived at execution}"
  : "${PG17_MINOR_DERIVATION_EVIDENCE:?Set fresh structured secure-minor derivation evidence}"
  : "${PG17_SOURCE_IMAGE:?Set the execution-time secure PG17 digest}"
  : "${PG17_SOURCE_INVENTORY:?Set the source-image inventory evidence path}"
  : "${PG17_RESTORE_EVIDENCE:?Set the successful pre-upgrade PG17 restore evidence path}"
  : "${PG17_RESTORE_READER_SECRET:?Set the synthetic read-only Secret used by the PG17 restore proof}"
  : "${OPERATOR_LADDER_EVIDENCE:?Set the interleaved operator/Kubernetes ladder evidence path}"
  : "${PG18_REHEARSAL_PRODUCER_OBJECTSTORE:?Set the same-namespace synthetic-QA producer ObjectStore name}"
  : "${PG18_REHEARSAL_PRODUCER_SECRET:?Set its synthetic-QA producer credential Secret name}"
  : "${ALLOW_OFFLINE_PG18_UPGRADE:?Set to YES only inside the synthetic QA environment}"
  [[ "${ALLOW_OFFLINE_PG18_UPGRADE}" == "YES" ]] ||
    fail "Offline upgrade was not explicitly authorized for the synthetic clone"
  [[ "${PG17_SECURE_MINOR}" =~ ^17\.[0-9]+$ ]] ||
    fail "PG17_SECURE_MINOR must match 17.<minor>"
  pg17_patch="${PG17_SECURE_MINOR#17.}"
  (( 10#${pg17_patch} >= 10 )) ||
    fail "PG17 secure minor cannot be below the clearance floor 17.10"
  require_recent_evidence "${PG17_MINOR_DERIVATION_EVIDENCE}" \
    "c1-1-pg17-secure-minor-v1" "derived_at"
  [[ "$(evidence_file_value "${PG17_MINOR_DERIVATION_EVIDENCE}" pg17_secure_minor)" == "${PG17_SECURE_MINOR}" ]] ||
    fail "Secure-minor evidence does not match PG17_SECURE_MINOR"
  [[ "$(evidence_file_value "${PG17_MINOR_DERIVATION_EVIDENCE}" result)" == "passed" ]] ||
    fail "Secure-minor derivation evidence is not passing"
  evidence_file_value "${PG17_MINOR_DERIVATION_EVIDENCE}" source >/dev/null

  [[ "${PG17_SOURCE_IMAGE}" == *":${PG17_SECURE_MINOR}-"*"@sha256:"* ]] ||
    fail "PG17 source image must match ${PG17_SECURE_MINOR} and be digest-pinned"
  [[ "${PG17_SOURCE_IMAGE}" =~ @sha256:[0-9a-f]{64}$ ]] ||
    fail "PG17 source image digest must be exactly 64 lowercase hexadecimal characters"
  require_recent_evidence "${PG17_SOURCE_INVENTORY}" \
    "c1-1-pg17-source-inventory-v1" "captured_at"
  [[ "$(evidence_file_value "${PG17_SOURCE_INVENTORY}" source_image)" == "${PG17_SOURCE_IMAGE}" ]] ||
    fail "Source inventory does not contain the exact PG17 image"
  [[ "$(evidence_file_value "${PG17_SOURCE_INVENTORY}" os_family)" == "bookworm" ]] ||
    fail "Physical pg_upgrade requires proven Bookworm alignment; use a logical path otherwise"
  [[ "$(evidence_file_value "${PG17_SOURCE_INVENTORY}" pg17_secure_minor)" == "${PG17_SECURE_MINOR}" ]] ||
    fail "Source inventory secure minor does not match the re-derived floor"
  require_recent_evidence "${PG17_RESTORE_EVIDENCE}" \
    "c1-1-pg17-restore-v1" "completed_at"
  [[ "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" result)" == "passed" ]] ||
    fail "Pre-upgrade PG17 restore evidence is not passing"
  [[ "${PG17_RESTORE_READER_SECRET}" != "cnpg-dr-reader-credentials" &&
     "${PG17_RESTORE_READER_SECRET}" != "cnpg-backup-producer-credentials" &&
     "${PG17_RESTORE_READER_SECRET}" != "${PG18_REHEARSAL_PRODUCER_SECRET}" ]] ||
    fail "Pre-upgrade PG17 restore requires a separate synthetic reader identity"
  [[ "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" reader_identity)" == "${PG17_RESTORE_READER_SECRET}" ]] ||
    fail "Pre-upgrade PG17 restore evidence does not match its synthetic reader identity"
  [[ "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" reader_secret_synthetic_only)" == "true" &&
     "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" reader_secret_access)" == "read-only" ]] ||
    fail "Pre-upgrade PG17 restore evidence does not mark its Secret synthetic-only and read-only"
  [[ "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" data_classification)" == "synthetic" ]] ||
    fail "Pre-upgrade PG17 restore evidence is not explicitly classified as synthetic"
  pg17_restore_destination="$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" source_destination)"
  reject_production_destination "${pg17_restore_destination}"
  [[ "${pg17_restore_destination%/}" == "s3://vhhealth-synthetic-qa-only/pg18-rehearsal/${REHEARSAL_RUN_ID}" ]] ||
    fail "Pre-upgrade PG17 restore evidence does not use this run's exact synthetic source destination"
  [[ "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" source_image)" == "${PG17_SOURCE_IMAGE}" ]] ||
    fail "Pre-upgrade restore evidence is not bound to the exact PG17 source image"
  [[ "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" application_role)" == "vhhealth_runtime" ]] ||
    fail "Pre-upgrade restore evidence does not prove a vhhealth_runtime application read"
  [[ "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" data_checksums)" == "on" ]] ||
    fail "Pre-upgrade restore evidence does not prove data checksums"
  for required_key in application_roles_checksum application_ownership_checksum \
    schema_checksum fixture_checksum vector_checksum application_read archive_identity; do
    evidence_file_value "${PG17_RESTORE_EVIDENCE}" "${required_key}" >/dev/null
  done
  require_ladder_evidence "${OPERATOR_LADDER_EVIDENCE}"

  [[ "$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.labels.vhhealth\.app/synthetic-only}')" == "true" ]] ||
    fail "Refusing to touch a Cluster not labeled synthetic-only=true"
  [[ "$(kubectl get secret "${PG17_RESTORE_READER_SECRET}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.labels.vhhealth\.app/synthetic-only}')" == "true" &&
     "$(kubectl get secret "${PG17_RESTORE_READER_SECRET}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.labels.vhhealth\.app/credential-access}')" == "read-only" ]] ||
    fail "PG17 restore reader Secret must be positively labeled synthetic-only and read-only"
  [[ "$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" -o jsonpath='{.spec.imageName}')" == "${PG17_SOURCE_IMAGE}" ]] ||
    fail "Live synthetic clone does not use the inventoried PG17 source image"

  plugin_name="$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" -o jsonpath='{.spec.plugins[0].name}')"
  plugin_store="$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" -o jsonpath='{.spec.plugins[0].parameters.barmanObjectName}')"
  pg17_archive_identity="$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" -o jsonpath='{.spec.plugins[0].parameters.serverName}')"
  wal_archiver="$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" -o jsonpath='{.spec.plugins[0].isWALArchiver}')"
  [[ "${plugin_name}" == "barman-cloud.cloudnative-pg.io" && "${wal_archiver}" == "true" ]] ||
    fail "Synthetic source must have the Barman plugin as its first WAL-archiver plugin"
  [[ "${plugin_store}" == "${PG18_REHEARSAL_PRODUCER_OBJECTSTORE}" ]] ||
    fail "Synthetic source does not reference the declared producer ObjectStore"
  [[ "${PG18_REHEARSAL_PRODUCER_OBJECTSTORE}" != "vhhealth-pg18-producer" ]] ||
    fail "Synthetic rehearsal must not use the production producer ObjectStore"
  [[ -n "${pg17_archive_identity}" && "${pg17_archive_identity}" != "${PG18_ARCHIVE_IDENTITY}" ]] ||
    fail "PG17 source needs an explicit archive identity distinct from this run's PG18 identity"
  [[ "${PG18_REHEARSAL_PRODUCER_SECRET}" != "cnpg-dr-reader-credentials" &&
     "${PG18_REHEARSAL_PRODUCER_SECRET}" != "cnpg-backup-producer-credentials" ]] ||
    fail "The rehearsal requires a synthetic-only producer identity"
  [[ "$(kubectl get objectstore "${PG18_REHEARSAL_PRODUCER_OBJECTSTORE}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.labels.vhhealth\.app/synthetic-only}')" == "true" ]] ||
    fail "Rehearsal producer ObjectStore must be labeled synthetic-only=true"
  [[ "$(kubectl get secret "${PG18_REHEARSAL_PRODUCER_SECRET}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.labels.vhhealth\.app/synthetic-only}')" == "true" ]] ||
    fail "Rehearsal producer Secret must be positively labeled synthetic-only=true"
  producer_destination="$(kubectl get objectstore "${PG18_REHEARSAL_PRODUCER_OBJECTSTORE}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.configuration.destinationPath}')"
  reject_production_destination "${producer_destination}"
  [[ "${producer_destination%/}" == "s3://vhhealth-synthetic-qa-only/pg18-rehearsal/${REHEARSAL_RUN_ID}" ]] ||
    fail "Synthetic producer destination must be the exact run-unique QA path"
  [[ "${producer_destination%/}" == "${pg17_restore_destination%/}" ]] ||
    fail "Live synthetic ObjectStore destination differs from the PG17 restore evidence"
  [[ "$(kubectl get objectstore "${PG18_REHEARSAL_PRODUCER_OBJECTSTORE}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.configuration.s3Credentials.accessKeyId.name}')" == "${PG18_REHEARSAL_PRODUCER_SECRET}" ]] ||
    fail "Synthetic producer ObjectStore access-key selector does not match its producer identity"
  [[ "$(kubectl get objectstore "${PG18_REHEARSAL_PRODUCER_OBJECTSTORE}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.configuration.s3Credentials.secretAccessKey.name}')" == "${PG18_REHEARSAL_PRODUCER_SECRET}" ]] ||
    fail "Synthetic producer ObjectStore secret-key selector does not match its producer identity"

  assert_live_platform_versions
  source_os="$(kubectl exec -n "${NAMESPACE}" "$(primary_pod "${CLUSTER}")" -c postgres -- \
    sh -eu -c '. /etc/os-release; printf "%s:%s:%s" "${ID}" "${VERSION_CODENAME}" "${VERSION_ID}"')"
  [[ "${source_os}" == "debian:bookworm:12" || "${source_os}" == "debian:bookworm:12."* ]] ||
    fail "Live PG17 source container is not Debian 12 Bookworm; use a logical upgrade path"
  prove_pgvector_files "${CLUSTER}"
  run_sql "${CLUSTER}" "SELECT current_setting('server_version') LIKE '${PG17_SECURE_MINOR}%';" | grep -qx t
  run_sql "${CLUSTER}" "SELECT default_version IS NOT NULL FROM pg_available_extensions WHERE name='vector';" | grep -qx t
  run_sql "${CLUSTER}" "CREATE EXTENSION IF NOT EXISTS vector; SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;" >/dev/null
  run_sql "${CLUSTER}" "SHOW data_checksums;" | grep -qx on
  assert_application_roles "${CLUSTER}"

  application_roles_before="$(application_role_checksum "${CLUSTER}")"
  ownership_before="$(application_ownership_checksum "${CLUSTER}")"
  predefined_before="$(predefined_role_inventory "${CLUSTER}")"
  schema_before="$(schema_checksum "${CLUSTER}")"
  fixture_before="$(run_sql "${CLUSTER}" "${FIXTURE_CHECKSUM_SQL}")"
  vector_before="$(vector_checksum "${CLUSTER}")"
  application_before="$(run_application_read "${CLUSTER}")"
  [[ "${application_roles_before}" == "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" application_roles_checksum)" ]] ||
    fail "Live application-role state does not match the fresh PG17 restore evidence"
  [[ "${ownership_before}" == "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" application_ownership_checksum)" ]] ||
    fail "Live application ownership does not match the fresh PG17 restore evidence"
  [[ "${schema_before}" == "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" schema_checksum)" ]] ||
    fail "Live schema does not match the fresh PG17 restore evidence"
  [[ "${fixture_before}" == "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" fixture_checksum)" ]] ||
    fail "Live fixture checksum does not match the fresh PG17 restore evidence"
  [[ "${vector_before}" == "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" vector_checksum)" ]] ||
    fail "Live pgvector checksum does not match the fresh PG17 restore evidence"
  [[ "${application_before}" == "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" application_read)" ]] ||
    fail "Live runtime application read does not match the fresh PG17 restore evidence"
  [[ "${pg17_archive_identity}" == "$(evidence_file_value "${PG17_RESTORE_EVIDENCE}" archive_identity)" ]] ||
    fail "Live PG17 archive identity does not match the fresh restore evidence"
  upgrade_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Re-read live versions immediately before the only mutating API call.
  assert_live_source_image
  assert_live_platform_versions
  kubectl patch cluster "${CLUSTER}" -n "${NAMESPACE}" --type json \
    -p "[{\"op\":\"test\",\"path\":\"/spec/plugins/0/name\",\"value\":\"barman-cloud.cloudnative-pg.io\"},{\"op\":\"test\",\"path\":\"/spec/plugins/0/parameters/serverName\",\"value\":\"${pg17_archive_identity}\"},{\"op\":\"replace\",\"path\":\"/spec/plugins/0/parameters/serverName\",\"value\":\"${PG18_ARCHIVE_IDENTITY}\"},{\"op\":\"replace\",\"path\":\"/spec/imageName\",\"value\":\"${TARGET_IMAGE}\"}]"

  deadline=$(( $(date +%s) + 3600 ))
  while (( $(date +%s) < deadline )); do
    phase="$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    image="$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.pgDataImageInfo.image}' 2>/dev/null || true)"
    major="$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.pgDataImageInfo.majorVersion}' 2>/dev/null || true)"
    [[ "${phase}" == "Cluster in healthy state" && "${image}" == "${TARGET_IMAGE}" && "${major}" == "18" ]] && break
    sleep 20
  done
  [[ "${phase:-}" == "Cluster in healthy state" && "${image:-}" == "${TARGET_IMAGE}" && "${major:-}" == "18" ]] ||
    fail "PG18 conversion did not reach the exact qualified image in a healthy state"
  [[ "$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.plugins[0].parameters.serverName}')" == "${PG18_ARCHIVE_IDENTITY}" ]] ||
    fail "PG18 Cluster did not retain the run-unique PG18 archive identity"
  [[ "$(kubectl get cluster "${CLUSTER}" -n "${NAMESPACE}" \
    -o jsonpath='{.spec.plugins[0].parameters.barmanObjectName}')" == "${PG18_REHEARSAL_PRODUCER_OBJECTSTORE}" ]] ||
    fail "PG18 Cluster did not retain the synthetic producer ObjectStore"

  extension_update="$(apply_cnpg_extension_updates "${CLUSTER}")"
  prove_pgvector_files "${CLUSTER}"
  run_sql "${CLUSTER}" "SELECT current_setting('server_version') LIKE '18.4%';" | grep -qx t
  assert_extensions_current "${CLUSTER}"
  run_sql "${CLUSTER}" "ANALYZE;"
  assert_application_roles "${CLUSTER}"
  [[ "$(application_role_checksum "${CLUSTER}")" == "${application_roles_before}" ]] ||
    fail "VH Health application-role attributes or memberships changed"
  [[ "$(application_ownership_checksum "${CLUSTER}")" == "${ownership_before}" ]] ||
    fail "VH Health application-object ownership changed"
  predefined_after="$(predefined_role_inventory "${CLUSTER}")"
  predefined_added="$(csv_delta -13 "${predefined_before}" "${predefined_after}")"
  predefined_removed="$(csv_delta -23 "${predefined_before}" "${predefined_after}")"
  [[ "${predefined_added}" == "pg_signal_autovacuum_worker" && -z "${predefined_removed}" ]] ||
    fail "Predefined-role delta is not the documented PG18-only addition"
  [[ "$(schema_checksum "${CLUSTER}")" == "${schema_before}" ]] || fail "Schema checksum changed"
  [[ "$(run_sql "${CLUSTER}" "${FIXTURE_CHECKSUM_SQL}")" == "${fixture_before}" ]] ||
    fail "Synthetic fixture checksum changed"
  [[ "$(vector_checksum "${CLUSTER}")" == "${vector_before}" ]] || fail "pgvector data checksum changed"
  run_sql "${CLUSTER}" "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;" >/dev/null
  [[ "$(run_application_read "${CLUSTER}")" == "${application_before}" ]] ||
    fail "Representative vhhealth_runtime application read changed"
  upgrade_completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  {
    printf 'evidence_format=c1-1-pg18-upgrade-v1\n'
    printf 'run_id=%s\n' "${REHEARSAL_RUN_ID}"
    printf 'upgrade_started_at=%s\n' "${upgrade_started_at}"
    printf 'upgrade_completed_at=%s\n' "${upgrade_completed_at}"
    printf 'target_image=%s\n' "${TARGET_IMAGE}"
    printf 'archive_identity=%s\n' "${PG18_ARCHIVE_IDENTITY}"
    printf 'producer_destination=%s\n' "${producer_destination}"
    printf 'producer_secret=%s\n' "${PG18_REHEARSAL_PRODUCER_SECRET}"
    printf 'extension_update=%s\n' "${extension_update}"
    printf 'application_roles_checksum=%s\n' "${application_roles_before}"
    printf 'application_ownership_checksum=%s\n' "${ownership_before}"
    printf 'predefined_roles_before=%s\n' "${predefined_before}"
    printf 'predefined_roles_after=%s\n' "${predefined_after}"
    printf 'predefined_roles_added=%s\n' "${predefined_added}"
    printf 'predefined_roles_removed=none\n'
    printf 'schema_checksum=%s\n' "${schema_before}"
    printf 'fixture_checksum=%s\n' "${fixture_before}"
    printf 'vector_checksum=%s\n' "${vector_before}"
    printf 'application_read=%s\n' "${application_before}"
    printf 'data_checksums=on\n'
  } > "${EVIDENCE_FILE}"
  printf 'Offline upgrade passed. Preserve %s, create a new plugin Backup, then restore its exact status.backupId with the synthetic reader and REHEARSAL_PHASE=verify-restore.\n' "${EVIDENCE_FILE}"
  exit 0
fi

[[ "${PHASE}" == "verify-restore" ]] || fail "REHEARSAL_PHASE must be upgrade or verify-restore"
: "${PG18_RESTORED_CLUSTER:?Set the separately provisioned fresh reader-only PG18 restore Cluster name}"
: "${PG18_FRESH_BACKUP_NAME:?Set the fresh post-upgrade plugin Backup CR name}"
: "${PG18_REHEARSAL_READER_OBJECTSTORE:?Set the synthetic-QA reader ObjectStore name}"
: "${PG18_REHEARSAL_READER_SECRET:?Set its synthetic-QA reader credential Secret name}"
require_file "${EVIDENCE_FILE}"
[[ "$(evidence_value evidence_format)" == "c1-1-pg18-upgrade-v1" ]] ||
  fail "Upgrade evidence has an unexpected format"
[[ "$(evidence_value run_id)" == "${REHEARSAL_RUN_ID}" ]] ||
  fail "Restore run ID does not match the upgrade evidence"
[[ "${PG18_RESTORED_CLUSTER}" != "${CLUSTER}" ]] ||
  fail "Fresh restore must be a separately provisioned Cluster"
[[ "${PG18_REHEARSAL_READER_SECRET}" != "$(evidence_value producer_secret)" &&
   "${PG18_REHEARSAL_READER_SECRET}" != "cnpg-dr-reader-credentials" &&
   "${PG18_REHEARSAL_READER_SECRET}" != "cnpg-backup-producer-credentials" ]] ||
  fail "Fresh restore requires a separate synthetic reader identity"

assert_live_platform_versions
backup_json="$(kubectl get backup "${PG18_FRESH_BACKUP_NAME}" -n "${NAMESPACE}" -o json)"
[[ "$(jq -r '.spec.cluster.name' <<<"${backup_json}")" == "${CLUSTER}" ]] ||
  fail "Fresh Backup CR does not target the upgraded synthetic Cluster"
[[ "$(jq -r '.spec.method' <<<"${backup_json}")" == "plugin" &&
   "$(jq -r '.spec.pluginConfiguration.name' <<<"${backup_json}")" == "barman-cloud.cloudnative-pg.io" ]] ||
  fail "Fresh Backup CR does not use the Barman plugin"
[[ "$(jq -r '.status.phase' <<<"${backup_json}")" == "completed" ]] ||
  fail "Fresh PG18 Backup CR is not completed"
backup_id="$(jq -r '.status.backupId // empty' <<<"${backup_json}")"
[[ -n "${backup_id}" ]] || fail "Fresh Backup CR has no status.backupId"
backup_created_at="$(jq -r '.metadata.creationTimestamp' <<<"${backup_json}")"
backup_stopped_at="$(jq -r '.status.stoppedAt // empty' <<<"${backup_json}")"
upgrade_completed_at="$(evidence_value upgrade_completed_at)"
[[ "${backup_created_at}" > "${upgrade_completed_at}" &&
   -n "${backup_stopped_at}" && "${backup_stopped_at}" > "${upgrade_completed_at}" ]] ||
  fail "Named Backup was not freshly created and completed after this upgrade"
[[ "$(jq -r '.status.serverName // empty' <<<"${backup_json}")" == "$(evidence_value archive_identity)" ]] ||
  fail "Fresh Backup CR does not report this run's archive identity"

[[ "$(kubectl get objectstore "${PG18_REHEARSAL_READER_OBJECTSTORE}" -n "${NAMESPACE}" \
  -o jsonpath='{.metadata.labels.vhhealth\.app/synthetic-only}')" == "true" ]] ||
  fail "Synthetic reader ObjectStore is not labeled synthetic-only=true"
[[ "$(kubectl get secret "${PG18_REHEARSAL_READER_SECRET}" -n "${NAMESPACE}" \
  -o jsonpath='{.metadata.labels.vhhealth\.app/synthetic-only}')" == "true" &&
   "$(kubectl get secret "${PG18_REHEARSAL_READER_SECRET}" -n "${NAMESPACE}" \
  -o jsonpath='{.metadata.labels.vhhealth\.app/credential-access}')" == "read-only" ]] ||
  fail "Synthetic reader Secret must be positively labeled synthetic-only and read-only"
reader_destination="$(kubectl get objectstore "${PG18_REHEARSAL_READER_OBJECTSTORE}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.configuration.destinationPath}')"
reject_production_destination "${reader_destination}"
[[ "${reader_destination%/}" == "$(evidence_value producer_destination | sed 's:/*$::')" ]] ||
  fail "Synthetic reader does not target the exact producer destination from this run"
[[ "$(kubectl get objectstore "${PG18_REHEARSAL_READER_OBJECTSTORE}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.configuration.s3Credentials.accessKeyId.name}')" == "${PG18_REHEARSAL_READER_SECRET}" &&
   "$(kubectl get objectstore "${PG18_REHEARSAL_READER_OBJECTSTORE}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.configuration.s3Credentials.secretAccessKey.name}')" == "${PG18_REHEARSAL_READER_SECRET}" ]] ||
  fail "Synthetic reader ObjectStore does not use its declared reader identity"

restore_json="$(kubectl get cluster "${PG18_RESTORED_CLUSTER}" -n "${NAMESPACE}" -o json)"
jq -e '.metadata.labels["vhhealth.app/synthetic-only"] == "true" and
  .metadata.labels["vhhealth.app/disposable-restore-proof"] == "true"' \
  <<<"${restore_json}" >/dev/null ||
  fail "Fresh restore Cluster lacks both synthetic-only and disposable labels"
[[ "$(jq -r '.spec.imageName' <<<"${restore_json}")" == "${TARGET_IMAGE}" &&
   "$(jq -r '.status.phase' <<<"${restore_json}")" == "Cluster in healthy state" &&
   "$(jq -r '.status.pgDataImageInfo.image' <<<"${restore_json}")" == "${TARGET_IMAGE}" ]] ||
  fail "Fresh restore is not healthy on the exact qualified image"
restore_source="$(jq -r '.spec.bootstrap.recovery.source' <<<"${restore_json}")"
[[ "$(jq -r '.spec.bootstrap.recovery.recoveryTarget.backupID // empty' <<<"${restore_json}")" == "${backup_id}" ]] ||
  fail "Fresh restore recoveryTarget.backupID does not match the named Backup CR"
[[ "$(jq -r --arg source "${restore_source}" '.spec.externalClusters[] |
  select(.name == $source) | .plugin.parameters.barmanObjectName' <<<"${restore_json}")" == "${PG18_REHEARSAL_READER_OBJECTSTORE}" ]] ||
  fail "Fresh restore does not use the declared synthetic reader ObjectStore"
[[ "$(jq -r --arg source "${restore_source}" '.spec.externalClusters[] |
  select(.name == $source) | .plugin.parameters.serverName' <<<"${restore_json}")" == "$(evidence_value archive_identity)" ]] ||
  fail "Fresh restore did not use this run's PG18 archive identity"

prove_pgvector_files "${PG18_RESTORED_CLUSTER}"
run_sql "${PG18_RESTORED_CLUSTER}" "SELECT current_setting('server_version') LIKE '18.4%';" | grep -qx t
run_sql "${PG18_RESTORED_CLUSTER}" "SHOW data_checksums;" | grep -qx on
assert_extensions_current "${PG18_RESTORED_CLUSTER}"
assert_application_roles "${PG18_RESTORED_CLUSTER}"
[[ "$(application_role_checksum "${PG18_RESTORED_CLUSTER}")" == "$(evidence_value application_roles_checksum)" ]] ||
  fail "Restored application-role attributes or memberships differ"
[[ "$(application_ownership_checksum "${PG18_RESTORED_CLUSTER}")" == "$(evidence_value application_ownership_checksum)" ]] ||
  fail "Restored application-object ownership differs"
[[ "$(predefined_role_inventory "${PG18_RESTORED_CLUSTER}")" == "$(evidence_value predefined_roles_after)" ]] ||
  fail "Restored predefined-role inventory differs from the upgraded source"
[[ "$(schema_checksum "${PG18_RESTORED_CLUSTER}")" == "$(evidence_value schema_checksum)" ]] ||
  fail "Restored schema checksum differs from the upgraded source"
[[ "$(run_sql "${PG18_RESTORED_CLUSTER}" "${FIXTURE_CHECKSUM_SQL}")" == "$(evidence_value fixture_checksum)" ]] ||
  fail "Restored fixture checksum differs from the upgraded source"
[[ "$(vector_checksum "${PG18_RESTORED_CLUSTER}")" == "$(evidence_value vector_checksum)" ]] ||
  fail "Restored pgvector data checksum differs from the upgraded source"
run_sql "${PG18_RESTORED_CLUSTER}" "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector;" >/dev/null
[[ "$(run_application_read "${PG18_RESTORED_CLUSTER}")" == "$(evidence_value application_read)" ]] ||
  fail "Restored vhhealth_runtime application read differs from the upgraded source"

printf 'Fresh PG18 backup/reader-only restore passed: backup=%s backup_id=%s image=%s archive_identity=%s\n' \
  "${PG18_FRESH_BACKUP_NAME}" "${backup_id}" "${TARGET_IMAGE}" "$(evidence_value archive_identity)"
