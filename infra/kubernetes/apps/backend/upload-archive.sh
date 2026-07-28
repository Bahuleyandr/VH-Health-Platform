#!/bin/sh
set -eu
if (set -o pipefail) 2>/dev/null; then
  set -o pipefail
fi

umask 077
export LC_ALL=C

ARCHIVE_FORMAT="vhhealth-minio-archive-v1"
ARCHIVE_ENCRYPTION="aes-256-cbc-pbkdf2-sha256"
work_dir="${BACKUP_WORK_DIR:-/work}"
source_dir="${work_dir}/source"
archive_path="${work_dir}/archive.tar.enc"

require_vars() {
  for var_name in "$@"; do
    eval "var_value=\${${var_name}:-}"
    if [ -z "${var_value}" ]; then
      printf '[backup-upload] ERROR: %s must be set\n' "${var_name}" >&2
      exit 1
    fi
  done
}

minio_aws() {
  AWS_ACCESS_KEY_ID="${MINIO_ACCESS_KEY_ID}" \
  AWS_SECRET_ACCESS_KEY="${MINIO_SECRET_ACCESS_KEY}" \
  AWS_EC2_METADATA_DISABLED=true \
    aws \
      --endpoint-url "${MINIO_ENDPOINT}" \
      --region us-east-1 \
      --ca-bundle "${MINIO_CA_BUNDLE}" \
      "$@"
}

fetch_source() {
  require_vars \
    MINIO_ENDPOINT \
    MINIO_BUCKET \
    MINIO_ACCESS_KEY_ID \
    MINIO_SECRET_ACCESS_KEY \
    MINIO_CA_BUNDLE \
    BACKUP_WORK_LIMIT_BYTES

  case "${BACKUP_WORK_LIMIT_BYTES}" in
    ''|*[!0-9]*)
      printf '[backup-upload] ERROR: BACKUP_WORK_LIMIT_BYTES must be a positive integer\n' >&2
      exit 1
      ;;
  esac
  if [ "${BACKUP_WORK_LIMIT_BYTES}" -le 0 ]; then
    printf '[backup-upload] ERROR: BACKUP_WORK_LIMIT_BYTES must be a positive integer\n' >&2
    exit 1
  fi

  # AWS CLI auto-pagination may emit one aggregate row or one row per page
  # depending on output handling. Summing both columns makes either shape safe.
  inventory_rows="$(
    minio_aws s3api list-objects-v2 \
      --bucket "${MINIO_BUCKET}" \
      --query '[length(Contents), sum(Contents[].Size)]' \
      --output text
  )"
  inventory_object_count="$(
    printf '%s\n' "${inventory_rows}" |
      awk '{ count += $1 } END { printf "%.0f\n", count + 0 }'
  )"
  inventory_source_bytes="$(
    printf '%s\n' "${inventory_rows}" |
      awk '{ bytes += $2 } END { printf "%.0f\n", bytes + 0 }'
  )"
  case "${inventory_object_count}:${inventory_source_bytes}" in
    *[!0-9:]*|:*|*:)
      printf '[backup-upload] ERROR: MinIO inventory returned malformed count/size data\n' >&2
      exit 1
      ;;
  esac
  if [ "${inventory_object_count}" -le 0 ]; then
    printf '[backup-upload] ERROR: MinIO source bucket is empty\n' >&2
    exit 1
  fi

  capacity_margin_bytes=134217728
  per_object_overhead_bytes=8192
  inventory_projected_bytes=$((inventory_source_bytes * 2 + capacity_margin_bytes))
  inventory_projected_bytes=$((
    inventory_projected_bytes +
    inventory_object_count * per_object_overhead_bytes
  ))
  if [ "${inventory_projected_bytes}" -gt "${BACKUP_WORK_LIMIT_BYTES}" ]; then
    printf \
      '[backup-upload] ERROR: pre-download projection %s bytes for %s objects exceeds staged limit %s; source was not downloaded\n' \
      "${inventory_projected_bytes}" \
      "${inventory_object_count}" \
      "${BACKUP_WORK_LIMIT_BYTES}" >&2
    exit 1
  fi

  printf \
    '[backup-upload] Pre-download capacity gate passed: source=%s objects=%s projected=%s limit=%s\n' \
    "${inventory_source_bytes}" \
    "${inventory_object_count}" \
    "${inventory_projected_bytes}" \
    "${BACKUP_WORK_LIMIT_BYTES}"

  mkdir -p "${source_dir}"

  printf '[backup-upload] Reading MinIO bucket %s\n' "${MINIO_BUCKET}"
  minio_aws s3 sync \
    "s3://${MINIO_BUCKET}/" "${source_dir}/" \
    --only-show-errors

  first_source_file="$(find "${source_dir}" -type f -print -quit)"
  if [ -z "${first_source_file}" ]; then
    printf '[backup-upload] ERROR: MinIO source bucket produced an empty archive\n' >&2
    exit 1
  fi

  # The staged source and encrypted tar share one bounded emptyDir. Refuse to
  # start encryption unless both copies plus a fixed tar/filesystem margin fit.
  source_kib="$(du -sk "${source_dir}" | awk '{print $1}')"
  source_bytes=$((source_kib * 1024))
  capacity_margin_bytes=134217728
  projected_work_bytes=$((source_bytes * 2 + capacity_margin_bytes))
  if [ "${projected_work_bytes}" -gt "${BACKUP_WORK_LIMIT_BYTES}" ]; then
    printf \
      '[backup-upload] ERROR: projected work bytes %s exceed the staged limit %s; no archive was uploaded\n' \
      "${projected_work_bytes}" "${BACKUP_WORK_LIMIT_BYTES}" >&2
    exit 1
  fi

  filesystem_available_kib="$(df -Pk "${work_dir}" | awk 'NR == 2 {print $4}')"
  filesystem_available_bytes=$((filesystem_available_kib * 1024))
  additional_bytes=$((source_bytes + capacity_margin_bytes))
  if [ "${additional_bytes}" -gt "${filesystem_available_bytes}" ]; then
    printf \
      '[backup-upload] ERROR: filesystem has %s bytes free but encryption needs %s additional bytes; no archive was uploaded\n' \
      "${filesystem_available_bytes}" "${additional_bytes}" >&2
    exit 1
  fi

  printf '[backup-upload] Capacity preflight passed: source=%s projected=%s limit=%s\n' \
    "${source_bytes}" "${projected_work_bytes}" "${BACKUP_WORK_LIMIT_BYTES}"
}

seal_archive() {
  require_vars \
    MINIO_BUCKET \
    R2_PREFIX \
    BACKUP_ENCRYPTION_KEY \
    BACKUP_HMAC_KEY

  if [ "${BACKUP_HMAC_KEY}" = "${BACKUP_ENCRYPTION_KEY}" ]; then
    printf '[backup-upload] ERROR: BACKUP_HMAC_KEY must differ from BACKUP_ENCRYPTION_KEY\n' >&2
    exit 1
  fi

  first_source_file="$(find "${source_dir}" -type f -print -quit)"
  if [ -z "${first_source_file}" ]; then
    printf '[backup-upload] ERROR: staged MinIO source is empty\n' >&2
    exit 1
  fi

  created_at="${BACKUP_CREATED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  created_epoch="${BACKUP_CREATED_EPOCH:-$(date -u +%s)}"
  archive_stamp="${BACKUP_ARCHIVE_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
  archive_name="vhhealth-minio-records-${archive_stamp}.tar.enc"
  archive_key="${R2_PREFIX%/}/${archive_name}"
  source_object_count="$(
    find "${source_dir}" -type f -print |
      wc -l |
      tr -d '[:space:]'
  )"

  printf '[backup-upload] Encrypting %s source objects\n' "${source_object_count}"
  tar -C "${source_dir}" -cf - . |
    openssl enc -aes-256-cbc -salt -pbkdf2 -iter 600000 -md sha256 \
      -pass env:BACKUP_ENCRYPTION_KEY \
      -out "${archive_path}"

  archive_sha256="$(sha256sum "${archive_path}" | awk '{print $1}')"
  archive_bytes="$(wc -c < "${archive_path}" | tr -d '[:space:]')"
  archive_hmac_sha256="$(
    {
      printf '%s\n' \
        "${ARCHIVE_FORMAT}" \
        "${archive_sha256}" \
        "${created_at}" \
        "${created_epoch}" \
        "${MINIO_BUCKET}" \
        "${source_object_count}" \
        "${ARCHIVE_ENCRYPTION}" \
        "${archive_bytes}" \
        "${archive_key}"
      cat "${archive_path}"
    } |
      openssl dgst -sha256 -hmac "${BACKUP_HMAC_KEY}" -r |
      awk '{print $1}'
  )"
  if ! printf '%s\n' "${archive_hmac_sha256}" |
     grep -Eq '^[0-9a-f]{64}$'; then
    printf '[backup-upload] ERROR: archive HMAC generation failed\n' >&2
    exit 1
  fi
  metadata="$(
    printf \
      'format=%s,sha256=%s,hmac_sha256=%s,created_at=%s,created_epoch=%s,source_bucket=%s,object_count=%s,encryption=%s' \
      "${ARCHIVE_FORMAT}" \
      "${archive_sha256}" \
      "${archive_hmac_sha256}" \
      "${created_at}" \
      "${created_epoch}" \
      "${MINIO_BUCKET}" \
      "${source_object_count}" \
      "${ARCHIVE_ENCRYPTION}"
  )"

  printf '%s\n' "${archive_key}" > "${work_dir}/archive-key"
  printf '%s\n' "${metadata}" > "${work_dir}/archive-metadata"
  printf '%s\n' "${archive_sha256}" > "${work_dir}/archive-sha256"
  printf '%s\n' "${archive_bytes}" > "${work_dir}/archive-bytes"

  # The write-capable R2 phase must never inherit readable plaintext. Init
  # container sequencing prevents it from starting unless this deletion
  # succeeds after every encrypted handoff artifact is durable.
  rm -rf -- "${source_dir}"
}

upload_archive() {
  require_vars R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

  for required_file in \
    "${archive_path}" \
    "${work_dir}/archive-key" \
    "${work_dir}/archive-metadata" \
    "${work_dir}/archive-sha256" \
    "${work_dir}/archive-bytes"; do
    if [ ! -s "${required_file}" ]; then
      printf '[backup-upload] ERROR: sealed archive handoff is incomplete: %s\n' \
        "${required_file}" >&2
      exit 1
    fi
  done

  archive_key="$(cat "${work_dir}/archive-key")"
  metadata="$(cat "${work_dir}/archive-metadata")"
  archive_sha256="$(cat "${work_dir}/archive-sha256")"
  archive_bytes="$(cat "${work_dir}/archive-bytes")"

  printf '[backup-upload] Uploading encrypted archive to s3://%s/%s\n' \
    "${R2_BUCKET}" "${archive_key}"
  AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
  AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
  AWS_EC2_METADATA_DISABLED=true \
    aws --endpoint-url "${R2_ENDPOINT}" --region auto s3 cp \
      "${archive_path}" "s3://${R2_BUCKET}/${archive_key}" \
      --metadata "${metadata}" \
      --only-show-errors

  # Verification deliberately belongs to the read-only verifier. The producer
  # does not list or HEAD the destination with its write-capable identity.
  printf '[backup-upload] Uploaded %s bytes with sha256=%s\n' \
    "${archive_bytes}" "${archive_sha256}"

  rm -rf -- \
    "${archive_path}" \
    "${work_dir}/archive-key" \
    "${work_dir}/archive-metadata" \
    "${work_dir}/archive-sha256" \
    "${work_dir}/archive-bytes"
}

case "${1:-}" in
  fetch)
    fetch_source
    ;;
  seal)
    seal_archive
    ;;
  upload)
    upload_archive
    ;;
  *)
    printf 'usage: %s {fetch|seal|upload}\n' "$0" >&2
    exit 64
    ;;
esac
