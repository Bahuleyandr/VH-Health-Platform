#!/bin/sh
set -eu
if (set -o pipefail) 2>/dev/null; then
  set -o pipefail
fi

umask 077
export LC_ALL=C

EXPECTED_FORMAT="vhhealth-minio-archive-v1"
EXPECTED_ENCRYPTION="aes-256-cbc-pbkdf2-sha256"
work_dir="${BACKUP_WORK_DIR:-/work}"
archive_path="${work_dir}/archive.tar.enc"
metadata_path="${work_dir}/archive-metadata.tsv"

require_vars() {
  for var_name in "$@"; do
    eval "var_value=\${${var_name}:-}"
    if [ -z "${var_value}" ]; then
      printf '[backup-verify] ERROR: %s must be set\n' "${var_name}" >&2
      exit 1
    fi
  done
}

r2_aws() {
  AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
  AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
  AWS_EC2_METADATA_DISABLED=true \
    aws --endpoint-url "${R2_ENDPOINT}" --region auto "$@"
}

fetch_archive() {
  require_vars \
    R2_ENDPOINT \
    R2_BUCKET \
    R2_PREFIX \
    R2_ACCESS_KEY_ID \
    R2_SECRET_ACCESS_KEY \
    BACKUP_WORK_LIMIT_BYTES

  case "${BACKUP_WORK_LIMIT_BYTES}" in
    ''|*[!0-9]*)
      printf '[backup-verify] ERROR: BACKUP_WORK_LIMIT_BYTES must be a positive integer\n' >&2
      exit 1
      ;;
  esac
  if [ "${BACKUP_WORK_LIMIT_BYTES}" -le 0 ]; then
    printf '[backup-verify] ERROR: BACKUP_WORK_LIMIT_BYTES must be a positive integer\n' >&2
    exit 1
  fi

  prefix="${R2_PREFIX%/}/"
  latest_key="$(
    r2_aws s3api list-objects-v2 \
      --bucket "${R2_BUCKET}" \
      --prefix "${prefix}" \
      --query "Contents[?ends_with(Key, '.tar.enc')].Key" \
      --output text |
      tr '\t' '\n' |
      sort |
      tail -n 1
  )"

  if [ -z "${latest_key}" ] || [ "${latest_key}" = "None" ]; then
    printf '[backup-verify] ERROR: no encrypted archive exists under s3://%s/%s\n' \
      "${R2_BUCKET}" "${prefix}" >&2
    exit 1
  fi

  r2_aws s3api head-object \
    --bucket "${R2_BUCKET}" \
    --key "${latest_key}" \
    --query \
      '[Metadata.format,Metadata.sha256,Metadata.hmac_sha256,Metadata.created_at,Metadata.created_epoch,Metadata.source_bucket,Metadata.object_count,Metadata.encryption,ContentLength]' \
    --output text > "${metadata_path}"

  expected_bytes="$(awk -F '\t' '{print $NF}' "${metadata_path}")"
  case "${expected_bytes}" in
    ''|*[!0-9]*)
      printf '[backup-verify] ERROR: archive content length is missing or malformed\n' >&2
      exit 1
      ;;
  esac
  capacity_margin_bytes=134217728
  projected_work_bytes=$((expected_bytes + capacity_margin_bytes))
  if [ "${projected_work_bytes}" -gt "${BACKUP_WORK_LIMIT_BYTES}" ]; then
    printf \
      '[backup-verify] ERROR: archive plus margin requires %s bytes, above staged limit %s\n' \
      "${projected_work_bytes}" "${BACKUP_WORK_LIMIT_BYTES}" >&2
    exit 1
  fi

  filesystem_available_kib="$(df -Pk "${work_dir}" | awk 'NR == 2 {print $4}')"
  filesystem_available_bytes=$((filesystem_available_kib * 1024))
  if [ "${projected_work_bytes}" -gt "${filesystem_available_bytes}" ]; then
    printf \
      '[backup-verify] ERROR: filesystem has %s bytes free but verification needs %s\n' \
      "${filesystem_available_bytes}" "${projected_work_bytes}" >&2
    exit 1
  fi

  r2_aws s3 cp "s3://${R2_BUCKET}/${latest_key}" "${archive_path}" \
    --only-show-errors
  printf '%s\n' "${latest_key}" > "${work_dir}/archive-key"
}

verify_archive() {
  require_vars \
    BACKUP_ENCRYPTION_KEY \
    BACKUP_HMAC_KEY \
    EXPECTED_SOURCE_BUCKET \
    BACKUP_MAX_AGE_SECONDS

  if [ "${BACKUP_HMAC_KEY}" = "${BACKUP_ENCRYPTION_KEY}" ]; then
    printf '[backup-verify] ERROR: BACKUP_HMAC_KEY must differ from BACKUP_ENCRYPTION_KEY\n' >&2
    exit 1
  fi

  if ! printf '%s\n' "${BACKUP_MAX_AGE_SECONDS}" | grep -Eq '^[0-9]+$' ||
     [ "${BACKUP_MAX_AGE_SECONDS}" -le 0 ]; then
    printf '[backup-verify] ERROR: BACKUP_MAX_AGE_SECONDS must be a positive integer\n' >&2
    exit 1
  fi

  for required_file in \
    "${archive_path}" \
    "${metadata_path}" \
    "${work_dir}/archive-key"; do
    if [ ! -s "${required_file}" ]; then
      printf '[backup-verify] ERROR: reader handoff is incomplete: %s\n' \
        "${required_file}" >&2
      exit 1
    fi
  done

  tab="$(printf '\t')"
  IFS="${tab}" read -r \
    archive_format \
    expected_sha256 \
    expected_hmac_sha256 \
    created_at \
    created_epoch \
    source_bucket \
    source_object_count \
    archive_encryption \
    expected_bytes < "${metadata_path}"

  if [ "${archive_format}" != "${EXPECTED_FORMAT}" ]; then
    printf '[backup-verify] ERROR: unexpected or missing archive format metadata\n' >&2
    exit 1
  fi
  if ! printf '%s\n' "${expected_sha256}" | grep -Eq '^[0-9a-f]{64}$'; then
    printf '[backup-verify] ERROR: archive sha256 metadata is missing or malformed\n' >&2
    exit 1
  fi
  if ! printf '%s\n' "${expected_hmac_sha256}" |
     grep -Eq '^[0-9a-f]{64}$'; then
    printf '[backup-verify] ERROR: archive HMAC metadata is missing or malformed\n' >&2
    exit 1
  fi
  if ! printf '%s\n' "${created_at}" |
     grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    printf '[backup-verify] ERROR: archive created_at metadata is malformed\n' >&2
    exit 1
  fi
  if ! printf '%s\n' "${created_epoch}" | grep -Eq '^[0-9]+$'; then
    printf '[backup-verify] ERROR: archive created_epoch metadata is missing or malformed\n' >&2
    exit 1
  fi
  if [ "${source_bucket}" != "${EXPECTED_SOURCE_BUCKET}" ]; then
    printf '[backup-verify] ERROR: archive source bucket metadata does not match\n' >&2
    exit 1
  fi
  if ! printf '%s\n' "${source_object_count}" | grep -Eq '^[0-9]+$' ||
     [ "${source_object_count}" -le 0 ]; then
    printf '[backup-verify] ERROR: archive object-count metadata is missing or empty\n' >&2
    exit 1
  fi
  if [ "${archive_encryption}" != "${EXPECTED_ENCRYPTION}" ]; then
    printf '[backup-verify] ERROR: archive encryption metadata does not match\n' >&2
    exit 1
  fi
  if ! printf '%s\n' "${expected_bytes}" | grep -Eq '^[0-9]+$' ||
     [ "${expected_bytes}" -le 0 ]; then
    printf '[backup-verify] ERROR: archive content length is missing or empty\n' >&2
    exit 1
  fi

  now_epoch="${BACKUP_VERIFY_NOW_EPOCH:-$(date -u +%s)}"
  if ! printf '%s\n' "${now_epoch}" | grep -Eq '^[0-9]+$'; then
    printf '[backup-verify] ERROR: current verification time is invalid\n' >&2
    exit 1
  fi

  age_seconds=$((now_epoch - created_epoch))
  if [ "${age_seconds}" -lt 0 ] ||
     [ "${age_seconds}" -gt "${BACKUP_MAX_AGE_SECONDS}" ]; then
    printf '[backup-verify] ERROR: archive age %ss is outside the allowed 0..%ss window\n' \
      "${age_seconds}" "${BACKUP_MAX_AGE_SECONDS}" >&2
    exit 1
  fi

  actual_bytes="$(wc -c < "${archive_path}" | tr -d '[:space:]')"
  if [ "${actual_bytes}" != "${expected_bytes}" ]; then
    printf '[backup-verify] ERROR: downloaded archive size does not match object metadata\n' >&2
    exit 1
  fi

  actual_sha256="$(sha256sum "${archive_path}" | awk '{print $1}')"
  if [ "${actual_sha256}" != "${expected_sha256}" ]; then
    printf '[backup-verify] ERROR: downloaded archive checksum does not match metadata\n' >&2
    exit 1
  fi

  archive_key="$(cat "${work_dir}/archive-key")"
  case "${archive_key}" in
    ''|*[!A-Za-z0-9._/-]*)
      printf '[backup-verify] ERROR: archive key contains invalid characters\n' >&2
      exit 1
      ;;
  esac
  if ! printf '%s\n' "${archive_key}" |
     grep -Eq '/vhhealth-minio-records-[0-9]{8}T[0-9]{6}Z\.tar\.enc$'; then
    printf '[backup-verify] ERROR: archive key does not match the producer format\n' >&2
    exit 1
  fi

  actual_hmac_sha256="$(
    {
      printf '%s\n' \
        "${archive_format}" \
        "${expected_sha256}" \
        "${created_at}" \
        "${created_epoch}" \
        "${source_bucket}" \
        "${source_object_count}" \
        "${archive_encryption}" \
        "${expected_bytes}" \
        "${archive_key}"
      cat "${archive_path}"
    } |
      openssl dgst -sha256 -hmac "${BACKUP_HMAC_KEY}" -r |
      awk '{print $1}'
  )"
  if ! printf '%s\n' "${actual_hmac_sha256}" |
     grep -Eq '^[0-9a-f]{64}$'; then
    printf '[backup-verify] ERROR: archive HMAC calculation failed\n' >&2
    exit 1
  fi
  if [ "${actual_hmac_sha256}" != "${expected_hmac_sha256}" ]; then
    printf '[backup-verify] ERROR: archive HMAC does not authenticate metadata and ciphertext\n' >&2
    exit 1
  fi

  archive_listing="${work_dir}/archive.list"
  if ! openssl enc -aes-256-cbc -d -pbkdf2 -iter 600000 -md sha256 \
       -pass env:BACKUP_ENCRYPTION_KEY \
       -in "${archive_path}" |
     tar -tf - > "${archive_listing}"; then
    printf '[backup-verify] ERROR: archive decryption or tar validation failed\n' >&2
    exit 1
  fi

  if [ ! -s "${archive_listing}" ]; then
    printf '[backup-verify] ERROR: decrypted archive contains no entries\n' >&2
    exit 1
  fi

  decrypted_object_count="$(
    awk 'substr($0, length($0), 1) != "/" { count += 1 } END { print count + 0 }' \
      "${archive_listing}"
  )"
  if [ "${decrypted_object_count}" != "${source_object_count}" ]; then
    printf '[backup-verify] ERROR: decrypted object count does not match metadata\n' >&2
    exit 1
  fi

  printf '[backup-verify] OK key=%s age=%ss bytes=%s sha256=%s objects=%s\n' \
    "${archive_key}" \
    "${age_seconds}" \
    "${actual_bytes}" \
    "${actual_sha256}" \
    "${decrypted_object_count}"

  rm -f -- "${archive_path}" "${metadata_path}" "${archive_listing}" \
    "${work_dir}/archive-key"
}

case "${1:-}" in
  fetch)
    fetch_archive
    ;;
  verify)
    verify_archive
    ;;
  *)
    printf 'usage: %s {fetch|verify}\n' "$0" >&2
    exit 64
    ;;
esac
