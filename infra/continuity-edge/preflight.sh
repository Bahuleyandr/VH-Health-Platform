#!/usr/bin/env bash
set -euo pipefail

findmnt_bin="${VHEDGE_FINDMNT_BIN:-findmnt}"
lsblk_bin="${VHEDGE_LSBLK_BIN:-lsblk}"
cryptsetup_bin="${VHEDGE_CRYPTSETUP_BIN:-cryptsetup}"
timedatectl_bin="${VHEDGE_TIMEDATECTL_BIN:-timedatectl}"

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required" >&2
    exit 1
  fi
}

require_file() {
  local file="$1"
  local label="$2"
  if [[ ! -f "${file}" || -L "${file}" ]]; then
    echo "${label} must be a regular non-symlink file" >&2
    exit 1
  fi
  local mode owner
  mode="$(stat -c '%a' "${file}")"
  owner="$(stat -c '%u:%g' "${file}")"
  if (( 10#${mode} % 100 != 0 )) || [[ "${owner}" != "10001:10001" ]]; then
    echo "${label} must be owned by 10001:10001 without group/world access" >&2
    exit 1
  fi
}

require_private_directory() {
  local directory="$1"
  local label="$2"
  if [[ ! -d "${directory}" || -L "${directory}" ]]; then
    echo "${label} must be a regular non-symlink directory" >&2
    exit 1
  fi
  local mode owner
  mode="$(stat -c '%a' "${directory}")"
  owner="$(stat -c '%u:%g' "${directory}")"
  if (( 10#${mode} % 100 != 0 )) || [[ "${owner}" != "10001:10001" ]]; then
    echo "${label} must be owned by 10001:10001 without group/world access" >&2
    exit 1
  fi
}

require_luks2_mount() {
  local mount="$1"
  local label="$2"
  if [[ ! -d "${mount}" || -L "${mount}" ]]; then
    echo "${label} mount is missing or symlinked" >&2
    exit 1
  fi
  local target source fs_type options device_type status
  target="$("${findmnt_bin}" -n -o TARGET --target "${mount}")"
  source="$("${findmnt_bin}" -n -o SOURCE --target "${mount}")"
  fs_type="$("${findmnt_bin}" -n -o FSTYPE --target "${mount}")"
  options="$("${findmnt_bin}" -n -o OPTIONS --target "${mount}")"
  if [[ "${target%/}" != "${mount%/}" ]]; then
    echo "${label} must be its own mount point" >&2
    exit 1
  fi
  if [[ "${source}" != /dev/mapper/* || -z "${fs_type}" ]]; then
    echo "${label} is not mounted from a dm-crypt mapper" >&2
    exit 1
  fi
  device_type="$("${lsblk_bin}" -ndo TYPE "${source}")"
  status="$("${cryptsetup_bin}" status "${source}")"
  if [[ "${device_type}" != "crypt" || ! "${status}" =~ type:[[:space:]]+LUKS2 ]]; then
    echo "${label} is not a verified LUKS2 mapping" >&2
    exit 1
  fi
  for required_option in rw nodev nosuid noexec; do
    if [[ ",${options}," != *",${required_option},"* ]]; then
      echo "${label} lacks required mount option ${required_option}" >&2
      exit 1
    fi
  done
  printf '%s\n' "${source}"
}

for name in \
  VHEDGE_ACTIVATION_APPROVED \
  VHEDGE_ACTIVATION_RECEIPT_PATH \
  VHEDGE_TENANT_ID \
  VHEDGE_FACILITY_ID \
  VHEDGE_DATA_ROOT \
  VHEDGE_LOG_ROOT \
  VHEDGE_CADDY_IMAGE \
  VHEDGE_CADDYFILE \
  VHEDGE_GATEWAY_IMAGE \
  VHEDGE_TRUSTED_KEYS_PATH \
  VHEDGE_POLICY_RECEIPT_PATH \
  VHEDGE_FLOORS_PATH \
  VHEDGE_BOOTSTRAP_FLOORS_PATH \
  VHEDGE_PROMETHEUS_TEXTFILE_PATH \
  VHEDGE_RCLONE_CONFIG \
  VHEDGE_SOURCE_PULL_IDENTITY_PATH \
  VHEDGE_SOURCE_KNOWN_HOSTS_PATH \
  VHEDGE_DROP_UPLOAD_IDENTITY_PATH \
  VHEDGE_DROP_KNOWN_HOSTS_PATH \
  VHEDGE_TLS_PRIVATE_KEY_PATH \
  VHEDGE_TLS_CERTIFICATE_PATH \
  VHEDGE_CLIENT_CA_PATH \
  VHEDGE_LOGGING_IDENTITIES_PATH; do
  require_var "${name}"
done

if [[ "${VHEDGE_ACTIVATION_APPROVED}" != "true" ]]; then
  echo "edge activation is held; VHEDGE_ACTIVATION_APPROVED is not true" >&2
  exit 1
fi

digest_pattern='^[a-z0-9]+([._/-][a-z0-9]+)*(:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?@sha256:[0-9a-f]{64}$'
if [[ ! "${VHEDGE_CADDY_IMAGE}" =~ ${digest_pattern} || ! "${VHEDGE_GATEWAY_IMAGE}" =~ ${digest_pattern} ]]; then
  echo "Caddy and gateway images must be digest-pinned" >&2
  exit 1
fi
if [[ "${VHEDGE_CADDY_IMAGE}" == *"sha256:$(printf '0%.0s' {1..64})" || "${VHEDGE_GATEWAY_IMAGE}" == *"sha256:$(printf '0%.0s' {1..64})" ]]; then
  echo "all-zero image digests are activation placeholders" >&2
  exit 1
fi

data_device="$(require_luks2_mount "${VHEDGE_DATA_ROOT}" "data")"
log_device="$(require_luks2_mount "${VHEDGE_LOG_ROOT}" "log")"
if [[ "${data_device}" == "${log_device}" && "${VHEDGE_ALLOW_SHARED_ENCRYPTED_DEVICE:-false}" != "true" ]]; then
  echo "data and log mounts must use distinct encrypted devices" >&2
  exit 1
fi

require_private_directory "${VHEDGE_DATA_ROOT}" "data root"
require_private_directory "${VHEDGE_LOG_ROOT}" "log root"
require_private_directory "$(dirname "${VHEDGE_FLOORS_PATH}")" "floor state directory"
require_private_directory "$(dirname "${VHEDGE_PROMETHEUS_TEXTFILE_PATH}")" "metrics directory"

for item in \
  "${VHEDGE_ACTIVATION_RECEIPT_PATH}:activation receipt" \
  "${VHEDGE_CADDYFILE}:Caddy configuration" \
  "${VHEDGE_TRUSTED_KEYS_PATH}:trusted keys" \
  "${VHEDGE_POLICY_RECEIPT_PATH}:signed policy receipt" \
  "${VHEDGE_BOOTSTRAP_FLOORS_PATH}:bootstrap floors" \
  "${VHEDGE_RCLONE_CONFIG}:rclone source config" \
  "${VHEDGE_SOURCE_PULL_IDENTITY_PATH}:source pull identity" \
  "${VHEDGE_SOURCE_KNOWN_HOSTS_PATH}:source known hosts" \
  "${VHEDGE_DROP_UPLOAD_IDENTITY_PATH}:drop upload identity" \
  "${VHEDGE_DROP_KNOWN_HOSTS_PATH}:drop known hosts" \
  "${VHEDGE_TLS_PRIVATE_KEY_PATH}:gateway TLS key" \
  "${VHEDGE_TLS_CERTIFICATE_PATH}:gateway TLS certificate" \
  "${VHEDGE_CLIENT_CA_PATH}:client CA" \
  "${VHEDGE_LOGGING_IDENTITIES_PATH}:logging identities"; do
  require_file "${item%%:*}" "${item#*:}"
done

command -v podman >/dev/null
/usr/bin/podman image exists "${VHEDGE_GATEWAY_IMAGE}"
/usr/bin/podman run --rm \
  --read-only \
  --cap-drop=all \
  --security-opt=no-new-privileges \
  --env-file=/etc/vhhealth/continuity-edge/edge.env \
  --volume="/etc/vhhealth/continuity-edge:/etc/vhhealth/continuity-edge:ro" \
  "${VHEDGE_GATEWAY_IMAGE}" \
  /opt/vhhealth-continuity-edge/bin/validate-config.mjs

declare -A key_hashes=()
for key_file in \
  "${VHEDGE_SOURCE_PULL_IDENTITY_PATH}" \
  "${VHEDGE_DROP_UPLOAD_IDENTITY_PATH}" \
  "${VHEDGE_TLS_PRIVATE_KEY_PATH}"; do
  key_hash="$(sha256sum "${key_file}" | awk '{print $1}')"
  if [[ -n "${key_hashes[${key_hash}]:-}" ]]; then
    echo "pull, upload, and TLS private keys must be distinct" >&2
    exit 1
  fi
  key_hashes["${key_hash}"]="${key_file}"
done

if [[ "$("${timedatectl_bin}" show -p NTPSynchronized --value)" != "yes" ]]; then
  echo "trusted clock preflight failed: NTP is not synchronized" >&2
  exit 1
fi

echo "continuity-edge preflight passed: LUKS2 data/log mounts, distinct machine and location-logger credentials, digest pins, receipts, and trusted clock verified"
