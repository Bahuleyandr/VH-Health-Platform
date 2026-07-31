#!/bin/sh
set -eu

fail() {
  printf 'retention_removal=failed reason=%s\n' "$1" >&2
  exit 1
}

for command_name in aws awk date grep sed sha256sum; do
  command -v "${command_name}" >/dev/null 2>&1 ||
    fail "missing_${command_name}"
done

: "${R2_ENDPOINT:?R2_ENDPOINT is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${R2_PREFIX:?R2_PREFIX is required}"
: "${DATABASE_RETENTION_DAYS:?DATABASE_RETENTION_DAYS is required}"
: "${APPROVAL_RECORD:?APPROVAL_RECORD is required}"

[ "${DATABASE_RETENTION_DAYS}" = "30" ] ||
  fail "database_retention_boundary_must_remain_30d"
[ -f "${APPROVAL_RECORD}" ] || fail "approval_record_missing"

required_headers="
approval-id
approved-at
approved-by-backup
approved-by-security
approved-by-legal
legal-hold-state
lock-proof-sha256
replacement-backup-id
catalogue-proof-sha256
"
for header in ${required_headers}; do
  value="$(sed -n "s/^# ${header}=//p" "${APPROVAL_RECORD}")"
  [ -n "${value}" ] || fail "approval_header_${header}_missing"
  case "${value}" in
    OWNER_INPUT*|REPLACE_*|TBD|UNKNOWN) fail "approval_header_${header}_is_sentinel" ;;
  esac
done

[ "$(sed -n 's/^# legal-hold-state=//p' "${APPROVAL_RECORD}")" = "clear" ] ||
  fail "legal_hold_not_clear"

lock_proof="$(sed -n 's/^# lock-proof-sha256=//p' "${APPROVAL_RECORD}")"
catalogue_proof="$(sed -n 's/^# catalogue-proof-sha256=//p' "${APPROVAL_RECORD}")"
for proof_digest in "${lock_proof}" "${catalogue_proof}"; do
  printf '%s' "${proof_digest}" | grep -Eq '^[0-9a-f]{64}$' ||
    fail "proof_digest_invalid"
done

row_count="$(awk -F '\t' '
  $0 !~ /^#/ && NF > 0 {
    if (NF != 4) exit 2
    count++
  }
  END { print count + 0 }
' "${APPROVAL_RECORD}")" || fail "approval_rows_invalid"
[ "${row_count}" -gt 0 ] || fail "approval_rows_empty"

if [ "${EXECUTE_RETENTION_REMOVAL:-false}" != "true" ]; then
  printf 'retention_removal=held rows=%s boundary_days=%s\n' \
    "${row_count}" "${DATABASE_RETENTION_DAYS}"
  exit 78
fi

: "${CHANGE_WINDOW_ID:?CHANGE_WINDOW_ID is required when execution is enabled}"
case "${CHANGE_WINDOW_ID}" in
  OWNER_INPUT*|REPLACE_*|TBD|UNKNOWN|"") fail "change_window_is_sentinel" ;;
esac

now_epoch="$(date -u +%s)"
deleted=0
while IFS="$(printf '\t')" read -r bucket key expected_etag not_before_epoch; do
  case "${bucket}" in \#*|"") continue ;; esac
  [ "${bucket}" = "${R2_BUCKET}" ] || fail "row_bucket_mismatch"
  case "${key}" in
    "${R2_PREFIX}"*) ;;
    *) fail "row_outside_archive_prefix" ;;
  esac
  case "${key}" in *'*'*|*'?'*|*'['*|*']'*) fail "wildcard_key_forbidden" ;; esac
  printf '%s' "${not_before_epoch}" | grep -Eq '^[0-9]{10,}$' ||
    fail "not_before_epoch_invalid"
  [ "${now_epoch}" -ge "${not_before_epoch}" ] ||
    fail "object_not_yet_eligible"

  head_fields="$(
    aws --endpoint-url "${R2_ENDPOINT}" s3api head-object \
      --bucket "${bucket}" --key "${key}" \
      --query '[ETag,LastModified]' --output text
  )"
  actual_etag="$(printf '%s' "${head_fields}" | awk '{print $1}')"
  last_modified="$(printf '%s' "${head_fields}" | awk '{print $2}')"
  [ "${actual_etag}" = "${expected_etag}" ] ||
    fail "etag_changed_since_approval"
  last_modified_epoch="$(date -u -d "${last_modified}" +%s)" ||
    fail "last_modified_unparseable"
  eligible_epoch=$((last_modified_epoch + DATABASE_RETENTION_DAYS * 24 * 60 * 60))
  [ "${now_epoch}" -ge "${eligible_epoch}" ] ||
    fail "object_inside_database_retention_boundary"

  aws --endpoint-url "${R2_ENDPOINT}" s3api delete-object \
    --bucket "${bucket}" --key "${key}" >/dev/null
  deleted=$((deleted + 1))
done <"${APPROVAL_RECORD}"

printf 'retention_removal=passed deleted=%s approval_id=%s change_window=%s\n' \
  "${deleted}" \
  "$(sed -n 's/^# approval-id=//p' "${APPROVAL_RECORD}")" \
  "${CHANGE_WINDOW_ID}"
