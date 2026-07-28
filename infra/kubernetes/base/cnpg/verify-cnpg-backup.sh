#!/usr/bin/env sh
set -eu

: "${R2_ENDPOINT:?R2_ENDPOINT is required}"
: "${R2_BUCKET:?R2_BUCKET is required}"
: "${R2_PREFIX:?R2_PREFIX is required}"
: "${BARMAN_SERVER_NAME:?BARMAN_SERVER_NAME is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"

archive_prefix="${R2_PREFIX%/}/${BARMAN_SERVER_NAME}"
base_prefix="${archive_prefix}/base/"
wal_prefix="${archive_prefix}/wals/"
evidence="/tmp/cnpg-backup-evidence.txt"

latest_key() {
  aws s3api list-objects-v2 \
    --endpoint-url "${R2_ENDPOINT}" \
    --bucket "${R2_BUCKET}" \
    --prefix "$1" \
    --query 'sort_by(Contents,&LastModified)[-1].Key' \
    --output text
}

base_key="$(latest_key "${base_prefix}")"
wal_key="$(latest_key "${wal_prefix}")"

if [ -z "${base_key}" ] || [ "${base_key}" = "None" ]; then
  echo "No PG18 base-backup object found under ${base_prefix}" >&2
  exit 1
fi
if [ -z "${wal_key}" ] || [ "${wal_key}" = "None" ]; then
  echo "No PG18 WAL object found under ${wal_prefix}" >&2
  exit 1
fi

sample_index=0
for key in "${base_key}" "${wal_key}"; do
  metadata="$(aws s3api head-object \
    --endpoint-url "${R2_ENDPOINT}" \
    --bucket "${R2_BUCKET}" \
    --key "${key}" \
    --query '{ContentLength:ContentLength,ETag:ETag,ChecksumSHA256:ChecksumSHA256,ServerSideEncryption:ServerSideEncryption,LastModified:LastModified}' \
    --output json)"
  printf '%s %s\n' "${key}" "${metadata}" >> "${evidence}"
  printf '%s' "${metadata}" | grep -q '"ContentLength": [1-9]'
  sample="/tmp/cnpg-object-sample-${sample_index}"
  aws s3api get-object \
    --endpoint-url "${R2_ENDPOINT}" \
    --bucket "${R2_BUCKET}" \
    --key "${key}" \
    --range "bytes=0-65535" \
    "${sample}" >/dev/null
  test -s "${sample}"
  sample_checksum="$(sha256sum "${sample}" | awk '{print $1}')"
  printf '%s sample_sha256=%s\n' "${key}" "${sample_checksum}" >> "${evidence}"
  rm -f "${sample}"
  sample_index=$((sample_index + 1))
done

# The evidence checksum makes the exact object metadata set independently
# reproducible. HEAD records provider checksum/SSE metadata when R2 exposes it;
# bounded GETs prove the reader can retrieve provider-decrypted object content
# and record repeatable sample checksums without downloading whole backups.
evidence_checksum="$(sha256sum "${evidence}" | awk '{print $1}')"
printf 'archive=%s\nbase=%s\nwal=%s\nevidence_sha256=%s\n' \
  "${BARMAN_SERVER_NAME}" "${base_key}" "${wal_key}" "${evidence_checksum}"
