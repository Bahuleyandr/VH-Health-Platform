#!/usr/bin/env bash
set -euo pipefail

# Read-only C1.2 evidence collector. Cluster calls are limited to discovery,
# get/config/version, and hard-coded diagnostic exec commands. SSH, when used
# to identify the keepalived holder, runs only `ip -o -4 address show`.
# This script never injects a fault or invokes apply, patch, delete, scale,
# cordon, drain, rollout, label, annotate, or any other mutating operation.

CONTROL_PLANE_VIP="${C1_2_VIP_ADDRESS:-10.10.0.10}"
CONTROL_PLANE_VIP_PREFIX_LENGTH="${C1_2_VIP_PREFIX_LENGTH:-24}"
VIP_SSH_TARGETS="${C1_2_VIP_SSH_TARGETS:-}"
SSH_USER="${C1_2_SSH_USER:-}"
KUBECTL_CONTEXT="${KUBECTL_CONTEXT:-}"
CNPG_NAMESPACE="${CNPG_NAMESPACE:-vhhealth-platform}"
CNPG_CLUSTER="${CNPG_CLUSTER:-vhhealth-pg}"

usage() {
  cat <<'EOF'
Usage:
  c1-2-ha-evidence.sh OUTPUT_DIRECTORY

Environment:
  C1_2_VIP_ADDRESS                Control-plane VIP (default: 10.10.0.10)
  C1_2_VIP_PREFIX_LENGTH          VIP prefix length (default: 24)
  KUBECTL_CONTEXT                 Optional kubeconfig context
  C1_2_SSH_USER                   Optional SSH user for derived peer IPs
  C1_2_VIP_SSH_TARGETS            Optional comma-separated name=ssh-target list
  CNPG_NAMESPACE                  CNPG namespace (default: vhhealth-platform)
  CNPG_CLUSTER                    CNPG Cluster name (default: vhhealth-pg)

C1_2_VIP_SSH_TARGETS overrides peer discovery, for example:
  C1_2_VIP_SSH_TARGETS='cp-1=ops@10.10.0.11,cp-2=ops@10.10.0.12,cp-3=ops@10.10.0.13'

The collector creates a UTC-timestamped subdirectory beneath OUTPUT_DIRECTORY.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$#" -eq 1 ]] || {
  usage >&2
  exit 2
}

EVIDENCE_ROOT="$1"
[[ -n "${EVIDENCE_ROOT}" ]] || fail "Output directory must not be empty"
[[ "${CONTROL_PLANE_VIP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "CONTROL_PLANE_VIP must be an IPv4 address"
[[ "${CONTROL_PLANE_VIP_PREFIX_LENGTH}" =~ ^([0-9]|[12][0-9]|3[0-2])$ ]] ||
  fail "CONTROL_PLANE_VIP_PREFIX_LENGTH must be between 0 and 32"

for command_name in kubectl jq ssh timeout; do
  command -v "${command_name}" >/dev/null ||
    fail "Required command '${command_name}' is unavailable"
done

umask 077
if [[ -e "${EVIDENCE_ROOT}" ]]; then
  [[ -d "${EVIDENCE_ROOT}" ]] ||
    fail "Output path is not a directory: ${EVIDENCE_ROOT}"
else
  mkdir -p -- "${EVIDENCE_ROOT}"
fi
RUN_ID="$(date -u '+%Y%m%dT%H%M%SZ')"
OUTPUT_DIR="${EVIDENCE_ROOT%/}/c1-2-ha-evidence-${RUN_ID}"
[[ ! -e "${OUTPUT_DIR}" ]] ||
  fail "Refusing to overwrite existing evidence directory: ${OUTPUT_DIR}"
mkdir -- "${OUTPUT_DIR}"
chmod 700 -- "${OUTPUT_DIR}"

KUBECTL=(kubectl)
if [[ -n "${KUBECTL_CONTEXT}" ]]; then
  KUBECTL+=(--context "${KUBECTL_CONTEXT}")
fi

SUMMARY_FILE="${OUTPUT_DIR}/00-summary.txt"
FAILURE_COUNT=0
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

printf 'collector=c1-2-ha-evidence\nstarted_at=%s\ncontrol_plane_vip=%s/%s\n' \
  "${STARTED_AT}" "${CONTROL_PLANE_VIP}" "${CONTROL_PLANE_VIP_PREFIX_LENGTH}" \
  >"${SUMMARY_FILE}"

capture() {
  local requirement="$1"
  local output_name="$2"
  shift 2
  local output_file="${OUTPUT_DIR}/${output_name}"
  local status=0

  {
    printf 'captured_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'command='
    printf ' %q' "$@"
    printf '\n---\n'
    if "$@"; then
      status=0
    else
      status=$?
    fi
    printf '\n---\nexit_status=%s\n' "${status}"
  } >"${output_file}" 2>&1

  printf '%s=%s\n' "${output_name}" "${status}" >>"${SUMMARY_FILE}"
  if [[ "${status}" -ne 0 && "${requirement}" == "required" ]]; then
    FAILURE_COUNT=$((FAILURE_COUNT + 1))
  fi
}

api_endpoint() {
  "${KUBECTL[@]}" config view --minify --raw \
    -o jsonpath='{.clusters[0].cluster.server}'
  printf '\n'
}

vip_api_readiness() {
  "${KUBECTL[@]}" --server="https://${CONTROL_PLANE_VIP}:6443" \
    get --raw='/readyz?verbose'
  printf '\n'
}

vip_registration_reachability() {
  timeout 3 bash -c "exec 3<>/dev/tcp/${CONTROL_PLANE_VIP}/9345"
  printf 'tcp_9345=reachable\n'
}

node_inventory() {
  "${KUBECTL[@]}" get nodes -o json
}

control_plane_targets() {
  if [[ -n "${VIP_SSH_TARGETS}" ]]; then
    local -a target_specs=()
    local target_spec
    local target_name
    local target_address
    IFS=',' read -r -a target_specs <<<"${VIP_SSH_TARGETS}"
    for target_spec in "${target_specs[@]}"; do
      target_name="${target_spec%%=*}"
      target_address="${target_spec#*=}"
      [[ -n "${target_name}" && -n "${target_address}" &&
        "${target_name}" != "${target_address}" ]] ||
        return 1
      [[ "${target_name}" =~ ^[A-Za-z0-9_.-]+$ &&
        "${target_address}" =~ ^[A-Za-z0-9_.@:-]+$ &&
        "${target_address}" != -* ]] ||
        return 1
      printf '%s\t%s\n' "${target_name}" "${target_address}"
    done
    return 0
  fi

  "${KUBECTL[@]}" get nodes -o json | jq -r '
    .items[]
    | select(
        .metadata.labels["node-role.kubernetes.io/control-plane"] != null
        or .metadata.labels["node-role.kubernetes.io/master"] != null
        or .metadata.labels["node-role.kubernetes.io/etcd"] != null
      )
    | [
        .metadata.name,
        (
          .status.addresses
          | map(select(.type == "InternalIP"))
          | first
          | .address
        )
      ]
    | @tsv
  '
}

vip_owner_inventory() {
  local holders=0
  local target_name
  local target_address
  local ssh_target
  local peer_output
  local peer_status
  local target_count=0

  printf 'vip=%s/%s\n' \
    "${CONTROL_PLANE_VIP}" "${CONTROL_PLANE_VIP_PREFIX_LENGTH}"
  while IFS=$'\t' read -r target_name target_address; do
    [[ -n "${target_name}" && -n "${target_address}" ]] || continue
    target_count=$((target_count + 1))
    ssh_target="${target_address}"
    if [[ -n "${SSH_USER}" && "${target_address}" != *@* ]]; then
      ssh_target="${SSH_USER}@${target_address}"
    fi

    printf '\npeer=%s target=%s\n' "${target_name}" "${ssh_target}"
    if peer_output="$(
      ssh -n -o BatchMode=yes -o ConnectTimeout=5 "${ssh_target}" \
        ip -o -4 address show 2>&1
    )"; then
      peer_status=0
    else
      peer_status=$?
    fi
    printf '%s\nssh_status=%s\n' "${peer_output}" "${peer_status}"
    if [[ "${peer_status}" -eq 0 ]] &&
      awk -v address="${CONTROL_PLANE_VIP}/${CONTROL_PLANE_VIP_PREFIX_LENGTH}" \
        '$4 == address { found = 1 } END { exit !found }' <<<"${peer_output}"; then
      printf 'vip_holder=true\n'
      holders=$((holders + 1))
      printf 'vip_owner=%s\n' "${target_name}" >>"${SUMMARY_FILE}"
    else
      printf 'vip_holder=false\n'
    fi
  done < <(control_plane_targets)

  printf '\npeer_count=%s\nvip_holder_count=%s\n' "${target_count}" "${holders}"
  [[ "${target_count}" -gt 0 && "${holders}" -eq 1 ]]
}

etcd_inventory() {
  local etcd_pod
  etcd_pod="$(
    "${KUBECTL[@]}" -n kube-system get pods -l component=etcd \
      -o jsonpath='{.items[0].metadata.name}'
  )"
  [[ -n "${etcd_pod}" ]] || {
    printf 'No component=etcd pod was found.\n' >&2
    return 1
  }

  printf 'source_pod=%s\n--- member list ---\n' "${etcd_pod}"
  "${KUBECTL[@]}" -n kube-system exec "${etcd_pod}" -c etcd -- \
    etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/var/lib/rancher/rke2/server/tls/etcd/server-ca.crt \
    --cert=/var/lib/rancher/rke2/server/tls/etcd/server-client.crt \
    --key=/var/lib/rancher/rke2/server/tls/etcd/server-client.key \
    member list --write-out=json
  printf '\n--- endpoint status and leader ---\n'
  "${KUBECTL[@]}" -n kube-system exec "${etcd_pod}" -c etcd -- \
    etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/var/lib/rancher/rke2/server/tls/etcd/server-ca.crt \
    --cert=/var/lib/rancher/rke2/server/tls/etcd/server-client.crt \
    --key=/var/lib/rancher/rke2/server/tls/etcd/server-client.key \
    endpoint status --cluster --write-out=json
}

cnpg_status() {
  "${KUBECTL[@]}" -n "${CNPG_NAMESPACE}" get \
    "clusters.postgresql.cnpg.io/${CNPG_CLUSTER}" -o yaml
  printf '\n--- CNPG pods ---\n'
  "${KUBECTL[@]}" -n "${CNPG_NAMESPACE}" get pods \
    -l "cnpg.io/cluster=${CNPG_CLUSTER}" -o wide --show-labels
  if "${KUBECTL[@]}" cnpg status --help >/dev/null 2>&1; then
    printf '\n--- kubectl cnpg status ---\n'
    "${KUBECTL[@]}" cnpg status "${CNPG_CLUSTER}" \
      -n "${CNPG_NAMESPACE}" --verbose
  fi
}

cnpg_replication() {
  local primary_pod
  primary_pod="$(
    "${KUBECTL[@]}" -n "${CNPG_NAMESPACE}" get pods \
      -l "cnpg.io/cluster=${CNPG_CLUSTER},role=primary" \
      -o jsonpath='{.items[0].metadata.name}'
  )"
  [[ -n "${primary_pod}" ]] || {
    printf 'No CNPG primary pod was found.\n' >&2
    return 1
  }

  printf 'primary_pod=%s\n' "${primary_pod}"
  "${KUBECTL[@]}" -n "${CNPG_NAMESPACE}" exec "${primary_pod}" \
    -c postgres -- psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -P pager=off -c \
    "SELECT application_name, client_addr, state, sync_state, write_lag, flush_lag, replay_lag FROM pg_stat_replication ORDER BY application_name;"
}

longhorn_state() {
  if ! "${KUBECTL[@]}" get crd volumes.longhorn.io >/dev/null 2>&1; then
    printf 'longhorn_installed=false\n'
    return 0
  fi

  printf 'longhorn_installed=true\n--- nodes ---\n'
  "${KUBECTL[@]}" -n longhorn-system get nodes.longhorn.io -o wide
  printf '\n--- volumes ---\n'
  "${KUBECTL[@]}" -n longhorn-system get volumes.longhorn.io -o wide
  printf '\n--- replicas ---\n'
  "${KUBECTL[@]}" -n longhorn-system get replicas.longhorn.io -o wide
  printf '\n--- engines ---\n'
  "${KUBECTL[@]}" -n longhorn-system get engines.longhorn.io -o wide
}

capture required 01-kubernetes-release.txt "${KUBECTL[@]}" version -o yaml
capture required 02-nodes.txt node_inventory
capture required 03-nodes-placement.txt \
  "${KUBECTL[@]}" get nodes -o wide --show-labels
capture required 04-api-endpoint.txt api_endpoint
capture required 05-vip-readyz.txt vip_api_readiness
capture required 06-vip-9345-tcp.txt vip_registration_reachability
capture required 07-vip-owner.txt vip_owner_inventory
capture required 08-etcd-pods.txt \
  "${KUBECTL[@]}" -n kube-system get pods -l component=etcd -o wide --show-labels
capture required 09-etcd-members-leader.txt etcd_inventory
capture required 10-pod-placement.txt \
  "${KUBECTL[@]}" get pods -A -o wide --sort-by=.spec.nodeName
capture required 11-cnpg-status.txt cnpg_status
capture required 12-cnpg-replication.txt cnpg_replication
capture required 13-storageclasses.yaml \
  "${KUBECTL[@]}" get storageclasses.storage.k8s.io -o yaml
capture required 14-persistent-volumes.txt \
  "${KUBECTL[@]}" get persistentvolumes -o wide
capture required 15-persistent-volume-claims.txt \
  "${KUBECTL[@]}" get persistentvolumeclaims -A -o wide
capture optional 16-argocd-applications.txt \
  "${KUBECTL[@]}" -n argocd get applications.argoproj.io -o wide
capture optional 17-helm-releases.txt helm list -A
capture optional 18-longhorn-state.txt longhorn_state

FINISHED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf 'finished_at=%s\nrequired_failure_count=%s\n' \
  "${FINISHED_AT}" "${FAILURE_COUNT}" >>"${SUMMARY_FILE}"

if [[ "${FAILURE_COUNT}" -ne 0 ]]; then
  printf 'Evidence collection completed with %s required section failure(s): %s\n' \
    "${FAILURE_COUNT}" "${OUTPUT_DIR}" >&2
  exit 1
fi

printf 'Evidence collection completed: %s\n' "${OUTPUT_DIR}"
