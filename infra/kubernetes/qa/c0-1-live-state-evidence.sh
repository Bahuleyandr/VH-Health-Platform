#!/usr/bin/env bash
set -uo pipefail

# C0.1 LIVE-STATE EVIDENCE COLLECTOR — OPERATOR-EXECUTED, READ-ONLY.
#
# ABSOLUTE SAFETY RULES:
# 1. READ-ONLY. This collector never creates, applies, patches, deletes, scales,
#    annotates, labels, cordons, drains, synchronizes, or otherwise changes a
#    live resource. It never runs Ansible against a host and never writes R2.
#    A check that cannot be performed read-only remains manual and unknown.
# 2. NEVER PRINT SECRET VALUES. Secret objects are never requested in a
#    structured output format. No command reads Secret .data or .stringData.
#    Optional API credentials are consumed only from environment variables and
#    never placed in the command ledger or written to an artifact.
# 3. NEVER TOUCH PHI. The only database statements are fixed catalog,
#    extension, replication, RLS-summary, and migration-high-water queries.
#    No clinical or application row is selected.
# 4. DEGRADE, DON'T CRASH. Missing tools, permissions, tokens, APIs, or
#    unreachable components produce explicit unknown evidence and collection
#    continues. Only unsafe arguments or an unusable local output path stop it.
# 5. RECORD EVERY INTERROGATION COMMAND. Each command, capture timestamp, exit
#    status, and artifact path is retained in index.tsv and commands.log.
#
# The existing c1-2-ha-evidence.sh collector remains authoritative for the
# fields it already covers. This script calls it and does not duplicate its
# control-plane, etcd, CNPG replication, pod/PVC placement, or Longhorn probes.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd)"
REPORTER="${SCRIPT_DIR}/c0-1-live-state-report.mjs"
FIXTURE_SOURCE=""

usage() {
  cat <<'EOF'
Usage:
  c0-1-live-state-evidence.sh OUTPUT_DIRECTORY [--fixture FIXTURE_DIRECTORY]

OUTPUT_DIRECTORY must be outside the repository. The collector creates:
  c0-1-live-state-<UTC timestamp>/
    full-report.md             Full local report; never commit
    redacted-summary.md        Automatically redacted commit-suitable summary
    manual-checklist.md        Operator-completed manual evidence
    index.tsv                  Machine-readable command/capture ledger
    commands.log               Human-readable command ledger
    captures/                  Per-command output and exit status
    raw/c1-2/                  Reused C1.2 HA evidence pack
    SHA256SUMS                 Artifact integrity manifest
    SHA256SUMS.minisig         Optional signature when configured

Fixture mode performs no live commands and proves the parser/emitter locally.

Optional environment:
  KUBECTL_CONTEXT
  CNPG_NAMESPACE                  default: vhhealth-platform
  CNPG_CLUSTER                    default: vhhealth-pg
  CNPG_DATABASE                   default: vhhealth
  C0_1_DNS_NAMES                 comma-separated hostnames
  C0_1_INSIDE_DNS_SERVER         clinical-VLAN resolver address
  C0_1_TLS_ENDPOINTS             comma-separated host:port endpoints
  C0_1_TIME_SSH_TARGETS          comma-separated stable-name=SSH-target pairs
  CF_API_TOKEN                   read-only Cloudflare API token
  CF_ACCOUNT_ID
  CF_TUNNEL_ID
  C0_1_R2_ENDPOINT               S3-compatible R2 endpoint URL
  C0_1_R2_BUCKET
  C0_1_MINISIGN_SECRET_KEY_FILE  optional operator-held signing key path

The C1_2_* variables accepted by c1-2-ha-evidence.sh are also passed through.
EOF
}

fail_local() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 2
}

[[ "$#" -ge 1 ]] || {
  usage >&2
  exit 2
}

EVIDENCE_ROOT="$1"
shift
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --fixture)
      [[ "$#" -ge 2 ]] || fail_local "--fixture requires a directory"
      FIXTURE_SOURCE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail_local "Unknown argument: $1"
      ;;
  esac
done

[[ -n "${EVIDENCE_ROOT}" ]] || fail_local "Output directory must not be empty"

canonical_path() {
  if command -v realpath >/dev/null 2>&1; then
    realpath -m -- "$1"
  else
    (
      mkdir -p -- "$1" &&
        cd -- "$1" &&
        pwd
    )
  fi
}

REPO_CANONICAL="$(canonical_path "${REPO_ROOT}")" ||
  fail_local "Cannot resolve repository path"
EVIDENCE_CANONICAL="$(canonical_path "${EVIDENCE_ROOT}")" ||
  fail_local "Cannot resolve output path"
case "${EVIDENCE_CANONICAL}/" in
  "${REPO_CANONICAL}/"*)
    fail_local "Output directory must be outside the repository"
    ;;
esac

umask 077
mkdir -p -- "${EVIDENCE_CANONICAL}" ||
  fail_local "Cannot create output root: ${EVIDENCE_CANONICAL}"

RUN_ID="$(date -u '+%Y%m%dT%H%M%SZ')"
OUTPUT_DIR="${EVIDENCE_CANONICAL%/}/c0-1-live-state-${RUN_ID}"
[[ ! -e "${OUTPUT_DIR}" ]] ||
  fail_local "Refusing to overwrite evidence directory: ${OUTPUT_DIR}"
mkdir -p -- "${OUTPUT_DIR}/captures" "${OUTPUT_DIR}/raw/c1-2" ||
  fail_local "Cannot create evidence directory"
chmod 700 -- "${OUTPUT_DIR}"

INDEX_FILE="${OUTPUT_DIR}/index.tsv"
COMMAND_LOG="${OUTPUT_DIR}/commands.log"
FULL_REPORT="${OUTPUT_DIR}/full-report.md"
REDACTED_REPORT="${OUTPUT_DIR}/redacted-summary.md"
printf 'id\tsection\tlabel\tfile\texit_status\tcommand\n' >"${INDEX_FILE}"
printf 'collector=c0-1-live-state-evidence\nstarted_at=%s\nrepository=%s\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${REPO_ROOT}" >"${COMMAND_LOG}"

write_fallback_reports() {
  local report
  local title
  for report in "${FULL_REPORT}" "${REDACTED_REPORT}"; do
    if [[ "${report}" == "${FULL_REPORT}" ]]; then
      title="C0.1 Live-State Evidence Report (Full Local Copy)"
    else
      title="C0.1 Live-State Evidence Summary (Redacted)"
    fi
    {
      printf '# %s\n\n' "${title}"
      cat <<'EOF'
The structured emitter has not completed. This degradable fallback preserves
one explicit **unknown** row per required fact. It proves only which commands
were attempted; it does not close C0.1.

| Section | Fact | State |
|---|---|---|
| Release and images | Repository and deployed release/digests | **unknown** |
| Kubernetes, database, and storage | Kubernetes/RKE2 version | **unknown** |
| Kubernetes, database, and storage | CNPG operator and PostgreSQL versions | **unknown** |
| Kubernetes, database, and storage | pgvector, migration high-water mark, and RLS posture | **unknown** |
| Kubernetes, database, and storage | StorageClasses and PVC/pod placement | **unknown** |
| Kubernetes, database, and storage | Longhorn presence, version, and health | **unknown** |
| Ingress, edge, DNS, and certificates | Ingress controllers, classes, and held-route darkness | **unknown** |
| Ingress, edge, DNS, and certificates | Services and Service types | **unknown** |
| Ingress, edge, DNS, and certificates | Cloudflare tunnel workload/control-plane state | **unknown** |
| Ingress, edge, DNS, and certificates | DNS outside and inside the clinical VLAN | **unknown** |
| Ingress, edge, DNS, and certificates | Certificate issuer, expiry, rotation, and SPKI | **unknown** |
| Control plane and etcd | API endpoint, VIP owner, members, and leader | **unknown** |
| Monitoring and alerting | Prometheus targets, loaded rules, and Watchdog | **unknown** |
| Monitoring and alerting | Alertmanager posture and Watchdog receipt | **unknown** |
| Backups and restore | CNPG schedule and latest successful backup | **unknown** |
| Backups and restore | R2 target, retention, and bucket lock | **unknown** |
| Backups and restore | Latest successful restore evidence | **unknown** |
| Time and clock trust | Node NTP/chrony and clinical device clock posture | **unknown** |
| Manual operator attestations | UPS/generator, switch, ISP, physical zones, and Cloudflare edge controls | **unknown** |

Safety boundary: read-only collection, no production state change, no Secret
values, and no PHI.
EOF
    } >"${report}"
  done
  cat >"${OUTPUT_DIR}/manual-checklist.md" <<'EOF'
# C0.1 Manual Operator Checklist

The structured emitter was unavailable. Record UPS/generator, switch, ISP,
physical node zone, Cloudflare WAF/bot/rate-limit, and device clock evidence
manually without credentials or PHI. Until signed by the named owners, every
manual fact is **unknown**.
EOF
}
write_fallback_reports

shell_quote_command() {
  local rendered=""
  local argument
  for argument in "$@"; do
    printf -v argument '%q' "${argument}"
    rendered+="${rendered:+ }${argument}"
  done
  printf '%s' "${rendered}"
}

auditable_command() {
  local first="${1:-}"
  case "${first}" in
    cloudflare_tunnel_api_probe)
      printf 'curl --request GET --config - https://api.cloudflare.com/client/v4/accounts/%q/cfd_tunnel/%q # bearer header supplied through non-persisted stdin' \
        "${CF_ACCOUNT_ID:-<unset>}" "${CF_TUNNEL_ID:-<unset>}"
      ;;
    prometheus_targets_probe)
      printf '%s | jq <safe target-health projection>' \
        "$(shell_quote_command "${KUBECTL[@]}" get --raw "${PROMETHEUS_TARGETS_PATH}")"
      ;;
    prometheus_rules_probe)
      printf '%s | jq <safe loaded-rule projection>' \
        "$(shell_quote_command "${KUBECTL[@]}" get --raw "${PROMETHEUS_RULES_PATH}")"
      ;;
    prometheus_watchdog_probe)
      printf '%s | jq <safe Watchdog projection>' \
        "$(shell_quote_command "${KUBECTL[@]}" get --raw "${PROMETHEUS_WATCHDOG_PATH}")"
      ;;
    alertmanager_watchdog_probe)
      printf '%s | jq <safe Watchdog alert projection>' \
        "$(shell_quote_command "${KUBECTL[@]}" get --raw "${ALERTMANAGER_WATCHDOG_PATH}")"
      ;;
    tls_endpoint_probe)
      printf 'openssl s_client -connect %q -servername <host> | openssl x509 <metadata>; openssl x509 -pubkey | openssl pkey -pubin -outform DER | sha256sum' \
        "${2:-<unset>}"
      ;;
    *)
      shell_quote_command "$@"
      ;;
  esac
}

assert_safe_command() {
  local first="${1:-}"
  local joined
  joined="$(shell_quote_command "$@")"

  case "${first}" in
    cloudflare_tunnel_api_probe|tls_endpoint_probe|unavailable_probe|prometheus_targets_probe|prometheus_rules_probe|prometheus_watchdog_probe|alertmanager_watchdog_probe)
      return 0
      ;;
  esac

  if [[ "${joined}" =~ (^|[[:space:]])(argocd|ansible|ansible-playbook|rclone|wrangler)([[:space:]]|$) ]]; then
    printf 'SAFETY REFUSAL: prohibited control tool in command: %s\n' "${joined}" >&2
    return 97
  fi
  if [[ "${joined}" =~ kubectl.*[[:space:]](apply|create|patch|delete|scale|annotate|label|cordon|drain|replace|edit|rollout|taint|set)([[:space:]]|$) ]]; then
    printf 'SAFETY REFUSAL: mutating kubectl verb in command: %s\n' "${joined}" >&2
    return 97
  fi
  if [[ "${joined}" =~ kubectl.*[[:space:]]get[[:space:]](secret|secrets)([[:space:]]|$) ]]; then
    if [[ ! "${joined}" =~ (-o|--output)(=|[[:space:]])name([[:space:]]|$) ]]; then
      printf 'SAFETY REFUSAL: Secret reads may request names only\n' >&2
      return 97
    fi
  fi
  if [[ "${joined}" =~ kubectl.*[[:space:]]exec[[:space:]] ]]; then
    if [[ ! "${joined}" =~ [[:space:]]--[[:space:]](psql|getent|date)([[:space:]]|$) ]]; then
      printf 'SAFETY REFUSAL: kubectl exec command is not allowlisted\n' >&2
      return 97
    fi
  fi
  if [[ "${joined}" =~ aws.*[[:space:]]s3[[:space:]] ]]; then
    printf 'SAFETY REFUSAL: high-level aws s3 command is prohibited\n' >&2
    return 97
  fi
  if [[ "${joined}" =~ aws.*[[:space:]]s3api[[:space:]] ]] &&
    [[ ! "${joined}" =~ [[:space:]](get-object-lock-configuration|get-bucket-versioning)([[:space:]]|$) ]]; then
    printf 'SAFETY REFUSAL: aws s3api operation is not read-only allowlisted\n' >&2
    return 97
  fi
  if [[ "${joined}" =~ curl.*(--data|-d|--form|-F|--upload-file|-T) ]]; then
    printf 'SAFETY REFUSAL: curl command could write remote state\n' >&2
    return 97
  fi
  return 0
}

capture() {
  local id="$1"
  local section="$2"
  local label="$3"
  shift 3
  local output_relative="captures/${id}.txt"
  local output_file="${OUTPUT_DIR}/${output_relative}"
  local rendered
  local status=0
  local command_name="${1:-}"

  [[ "${id}" =~ ^[a-z0-9_]+$ ]] ||
    fail_local "Unsafe capture ID: ${id}"
  rendered="$(auditable_command "$@")"

  {
    printf 'captured_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'command=%s\n---\n' "${rendered}"
    assert_safe_command "$@"
    status=$?
    if [[ "${status}" -ne 0 ]]; then
      printf 'Command rejected by the read-only safety guard.\n'
    elif [[ -z "${command_name}" ]]; then
      status=127
      printf 'No command was supplied.\n'
    elif ! declare -F "${command_name}" >/dev/null 2>&1 &&
      ! command -v "${command_name}" >/dev/null 2>&1; then
      status=127
      printf "Required tool '%s' is unavailable; fact remains unknown.\n" \
        "${command_name}"
    else
      "$@"
      status=$?
    fi
    printf '\n---\nexit_status=%s\n' "${status}"
  } >"${output_file}" 2>&1

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${id}" "${section}" "${label}" "${output_relative}" "${status}" \
    "${rendered//$'\t'/ }" >>"${INDEX_FILE}"
  printf '%s id=%s exit_status=%s command=%s artifact=%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${id}" "${status}" "${rendered}" \
    "${output_relative}" >>"${COMMAND_LOG}"
  return 0
}

KUBECTL=(kubectl)
if [[ -n "${KUBECTL_CONTEXT:-}" ]]; then
  KUBECTL+=(--context "${KUBECTL_CONTEXT}")
fi

CNPG_NAMESPACE="${CNPG_NAMESPACE:-vhhealth-platform}"
CNPG_CLUSTER="${CNPG_CLUSTER:-vhhealth-pg}"
CNPG_DATABASE="${CNPG_DATABASE:-vhhealth}"
PROMETHEUS_TARGETS_PATH="${C0_1_PROMETHEUS_TARGETS_PATH:-/api/v1/namespaces/vhhealth-monitoring/services/http:vhhealth-kube-prometheus-prometheus:9090/proxy/api/v1/targets}"
PROMETHEUS_RULES_PATH="${C0_1_PROMETHEUS_RULES_PATH:-/api/v1/namespaces/vhhealth-monitoring/services/http:vhhealth-kube-prometheus-prometheus:9090/proxy/api/v1/rules}"
PROMETHEUS_WATCHDOG_PATH="${C0_1_PROMETHEUS_WATCHDOG_PATH:-/api/v1/namespaces/vhhealth-monitoring/services/http:vhhealth-kube-prometheus-prometheus:9090/proxy/api/v1/query?query=ALERTS%7Balertname%3D%22Watchdog%22%7D}"
ALERTMANAGER_WATCHDOG_PATH="${C0_1_ALERTMANAGER_WATCHDOG_PATH:-/api/v1/namespaces/vhhealth-monitoring/services/http:vhhealth-kube-prometheus-alertmanager:9093/proxy/api/v2/alerts?filter=alertname%3DWatchdog}"

cloudflare_tunnel_api_probe() {
  if [[ -z "${CF_API_TOKEN:-}" || -z "${CF_ACCOUNT_ID:-}" ||
    -z "${CF_TUNNEL_ID:-}" ]]; then
    printf 'CF_API_TOKEN, CF_ACCOUNT_ID, and CF_TUNNEL_ID were not all supplied.\n'
    return 78
  fi
  command -v curl >/dev/null 2>&1 || {
    printf 'curl is unavailable.\n'
    return 127
  }

  # The bearer value is sent to curl through stdin configuration. It is never
  # part of argv, the command ledger, stdout, or a persisted temporary file.
  printf 'header = "Authorization: Bearer %s"\nrequest = "GET"\nurl = "https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s"\n' \
    "${CF_API_TOKEN}" "${CF_ACCOUNT_ID}" "${CF_TUNNEL_ID}" |
    curl --silent --show-error --fail-with-body --config -
}

unavailable_probe() {
  printf '%s\n' "$1"
  return 78
}

require_kubectl_and_jq() {
  local tool
  for tool in kubectl jq; do
    command -v "${tool}" >/dev/null 2>&1 || {
      printf "Required monitoring probe tool '%s' is unavailable.\n" "${tool}"
      return 127
    }
  done
}

prometheus_targets_probe() {
  require_kubectl_and_jq || return $?
  "${KUBECTL[@]}" get --raw "${PROMETHEUS_TARGETS_PATH}" |
    jq '{
      status,
      activeTargets: [
        .data.activeTargets[]? | {
          scrapePool,
          health,
          lastError,
          lastScrape,
          labels: {
            job: .labels.job,
            namespace: .labels.namespace,
            service: .labels.service,
            pod: .labels.pod,
            container: .labels.container,
            endpoint: .labels.endpoint
          }
        }
      ],
      droppedTargetCount: (.data.droppedTargets // [] | length)
    }'
}

prometheus_rules_probe() {
  require_kubectl_and_jq || return $?
  "${KUBECTL[@]}" get --raw "${PROMETHEUS_RULES_PATH}" |
    jq '{
      status,
      groups: [
        .data.groups[]? | {
          name,
          file,
          interval,
          evaluationTime,
          lastEvaluation,
          rules: [
            .rules[]? | {
              name,
              type,
              state,
              health,
              lastError,
              query
            }
          ]
        }
      ]
    }'
}

prometheus_watchdog_probe() {
  require_kubectl_and_jq || return $?
  "${KUBECTL[@]}" get --raw "${PROMETHEUS_WATCHDOG_PATH}" |
    jq '{
      status,
      data: {
        resultType: .data.resultType,
        result: [
          .data.result[]? | {
            metric: {
              alertname: .metric.alertname,
              alertstate: .metric.alertstate,
              severity: .metric.severity
            },
            value
          }
        ]
      }
    }'
}

alertmanager_watchdog_probe() {
  require_kubectl_and_jq || return $?
  "${KUBECTL[@]}" get --raw "${ALERTMANAGER_WATCHDOG_PATH}" |
    jq '[
      .[]? | {
        labels: {
          alertname: .labels.alertname,
          severity: .labels.severity
        },
        status: {
          state: .status.state,
          silencedBy: (.status.silencedBy // [] | length),
          inhibitedBy: (.status.inhibitedBy // [] | length)
        },
        startsAt,
        endsAt,
        updatedAt
      }
    ]'
}

tls_endpoint_probe() {
  local endpoint="$1"
  local host="${endpoint%:*}"
  local port="${endpoint##*:}"
  local cert_file="${OUTPUT_DIR}/raw/tls-${host//[^A-Za-z0-9_.-]/_}-${port}.pem"

  [[ "${host}" =~ ^[A-Za-z0-9.-]+$ ]] || {
    printf 'Invalid TLS hostname.\n'
    return 2
  }
  [[ "${port}" =~ ^[0-9]{1,5}$ ]] || {
    printf 'Invalid TLS port.\n'
    return 2
  }
  for tool in timeout openssl sha256sum; do
    command -v "${tool}" >/dev/null 2>&1 || {
      printf "Required TLS probe tool '%s' is unavailable.\n" "${tool}"
      return 127
    }
  done

  if ! timeout 15 openssl s_client -connect "${host}:${port}" \
    -servername "${host}" -showcerts </dev/null 2>/dev/null |
    openssl x509 -outform PEM >"${cert_file}"; then
    printf 'TLS handshake or certificate extraction failed.\n'
    return 1
  fi

  printf 'endpoint=%s\n' "${endpoint}"
  openssl x509 -in "${cert_file}" -noout \
    -subject -issuer -serial -startdate -enddate -fingerprint -sha256
  printf 'spki_sha256='
  openssl x509 -in "${cert_file}" -pubkey -noout |
    openssl pkey -pubin -outform DER |
    sha256sum |
    awk '{print $1}'
}

if [[ -n "${FIXTURE_SOURCE}" ]]; then
  FIXTURE_CANONICAL="$(canonical_path "${FIXTURE_SOURCE}")" ||
    fail_local "Cannot resolve fixture path"
  [[ -f "${FIXTURE_CANONICAL}/index.tsv" ]] ||
    fail_local "Fixture directory must contain index.tsv"
  cp -R -- "${FIXTURE_CANONICAL}/." "${OUTPUT_DIR}/" ||
    fail_local "Cannot copy fixture evidence"
  printf '%s fixture_source=%s live_commands=0\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${FIXTURE_CANONICAL}" >>"${COMMAND_LOG}"
else
  capture c1_2 "Control plane and etcd" \
    "Reuse the complete C1.2 HA evidence collector" \
    bash "${SCRIPT_DIR}/c1-2-ha-evidence.sh" "${OUTPUT_DIR}/raw/c1-2"

  capture release_images "Release and images" \
    "Running container image references and resolved image IDs" \
    "${KUBECTL[@]}" get pods -A \
    -o 'custom-columns=NAMESPACE:.metadata.namespace,POD:.metadata.name,CONTAINERS:.spec.containers[*].name,REQUESTED_IMAGES:.spec.containers[*].image,RUNNING_IMAGE_IDS:.status.containerStatuses[*].imageID,READY:.status.containerStatuses[*].ready'

  capture argocd_apps "Release and images" \
    "Argo CD target revisions and live sync revisions" \
    "${KUBECTL[@]}" -n argocd get applications.argoproj.io \
    -o 'custom-columns=NAME:.metadata.name,REPOSITORY:.spec.source.repoURL,TARGET:.spec.source.targetRevision,SYNC_REVISION:.status.sync.revision,SYNC:.status.sync.status,HEALTH:.status.health.status'

  capture rke2_nodes "Kubernetes, database, and storage" \
    "RKE2/Kubernetes versions reported by every node" \
    "${KUBECTL[@]}" get nodes \
    -o 'custom-columns=NODE:.metadata.name,KUBELET:.status.nodeInfo.kubeletVersion,RUNTIME:.status.nodeInfo.containerRuntimeVersion,OS:.status.nodeInfo.osImage,READY:.status.conditions[?(@.type=="Ready")].status'

  capture cnpg_operator "Kubernetes, database, and storage" \
    "CloudNativePG operator deployment image and readiness" \
    "${KUBECTL[@]}" -n cnpg-system get deployment cnpg-controller-manager \
    -o 'custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[*].image,READY:.status.readyReplicas,AVAILABLE:.status.availableReplicas,OBSERVED_GENERATION:.status.observedGeneration'

  capture cnpg_clusters "Kubernetes, database, and storage" \
    "CloudNativePG cluster image, version, instances, and phase" \
    "${KUBECTL[@]}" -n "${CNPG_NAMESPACE}" get \
    "clusters.postgresql.cnpg.io/${CNPG_CLUSTER}" \
    -o 'custom-columns=NAME:.metadata.name,IMAGE:.spec.imageName,INSTANCES:.spec.instances,CURRENT_PRIMARY:.status.currentPrimary,READY_INSTANCES:.status.readyInstances,PHASE:.status.phase'

  capture cnpg_primary "Kubernetes, database, and storage" \
    "Current CloudNativePG primary pod name" \
    "${KUBECTL[@]}" -n "${CNPG_NAMESPACE}" get \
    "clusters.postgresql.cnpg.io/${CNPG_CLUSTER}" \
    -o 'jsonpath={.status.currentPrimary}'
  cnpg_primary_pod="$(
    awk '
      /^---$/ { marker += 1; next }
      marker == 1 { printf "%s", $0 }
    ' "${OUTPUT_DIR}/captures/cnpg_primary.txt"
  )"
  if [[ ! "${cnpg_primary_pod}" =~ ^[A-Za-z0-9.-]+$ ]]; then
    cnpg_primary_pod="${CNPG_CLUSTER}-1"
  fi

  database_sql=$(
    cat <<'SQL'
SELECT version() AS postgres_version;
SELECT extname, extversion FROM pg_extension ORDER BY extname;
SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'vector';
SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name;
SELECT migration_name, finished_at FROM public._prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1;
SELECT n.nspname AS schema_name, count(*) FILTER (WHERE c.relrowsecurity) AS rls_enabled, count(*) FILTER (WHERE c.relforcerowsecurity) AS rls_forced, count(*) AS table_count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') GROUP BY n.nspname ORDER BY n.nspname;
SQL
  )
  capture database_catalog "Kubernetes, database, and storage" \
    "Fixed PHI-free database catalog and posture queries" \
    "${KUBECTL[@]}" -n "${CNPG_NAMESPACE}" exec \
    "${cnpg_primary_pod}" -c postgres -- \
    psql -U postgres -d "${CNPG_DATABASE}" -X -v ON_ERROR_STOP=0 \
    -P pager=off -c "${database_sql}"
  unset database_sql
  unset cnpg_primary_pod

  capture ingress_classes "Ingress, edge, DNS, and certificates" \
    "IngressClasses and controller claims" \
    "${KUBECTL[@]}" get ingressclasses.networking.k8s.io \
    -o 'custom-columns=NAME:.metadata.name,CONTROLLER:.spec.controller,DEFAULT:.metadata.annotations.ingressclass\.kubernetes\.io/is-default-class'

  capture ingress_controllers "Ingress, edge, DNS, and certificates" \
    "Ingress controller DaemonSets and Deployments" \
    "${KUBECTL[@]}" -n vhhealth-ingress get daemonsets,deployments \
    -l app.kubernetes.io/component=controller \
    -o 'custom-columns=KIND:.kind,NAME:.metadata.name,IMAGE:.spec.template.spec.containers[*].image,DESIRED:.status.desiredNumberScheduled,READY:.status.numberReady,AVAILABLE:.status.availableReplicas'

  capture ingress_routes "Ingress, edge, DNS, and certificates" \
    "Ingress route classes, hosts, TLS Secrets by name, and live addresses" \
    "${KUBECTL[@]}" get ingress.networking.k8s.io -A \
    -o 'custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,CLASS:.spec.ingressClassName,HOSTS:.spec.rules[*].host,TLS_SECRET_NAMES:.spec.tls[*].secretName,ADDRESSES:.status.loadBalancer.ingress[*].ip'

  capture services "Ingress, edge, DNS, and certificates" \
    "Services and their types/addresses" \
    "${KUBECTL[@]}" get services -A \
    -o 'custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,TYPE:.spec.type,CLUSTER_IP:.spec.clusterIP,EXTERNAL_IPS:.spec.externalIPs[*],LOAD_BALANCER:.status.loadBalancer.ingress[*].ip,PORTS:.spec.ports[*].port'

  capture cloudflared "Ingress, edge, DNS, and certificates" \
    "cloudflared workload image, readiness, and placement" \
    "${KUBECTL[@]}" -n vhhealth-ingress get pods \
    -l app.kubernetes.io/name=cloudflared \
    -o 'custom-columns=POD:.metadata.name,NODE:.spec.nodeName,IMAGE:.spec.containers[*].image,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,PHASE:.status.phase'

  capture cloudflare_api "Ingress, edge, DNS, and certificates" \
    "Cloudflare control-plane tunnel state without token disclosure" \
    cloudflare_tunnel_api_probe

  IFS=',' read -r -a dns_names <<<"${C0_1_DNS_NAMES:-api.vhhealth.app,admin.vhhealth.app}"
  dns_index=0
  for dns_name in "${dns_names[@]}"; do
    dns_name="${dns_name//[[:space:]]/}"
    [[ "${dns_name}" =~ ^[A-Za-z0-9.-]+$ ]] || continue
    dns_index=$((dns_index + 1))
    capture "dns_outside_${dns_index}" "Ingress, edge, DNS, and certificates" \
      "Public resolver view for ${dns_name}" \
      dig +time=5 +tries=1 @1.1.1.1 "${dns_name}" A
    if [[ -n "${C0_1_INSIDE_DNS_SERVER:-}" ]]; then
      capture "dns_inside_${dns_index}" "Ingress, edge, DNS, and certificates" \
        "Clinical-VLAN resolver view for ${dns_name}" \
        dig +time=5 +tries=1 "@${C0_1_INSIDE_DNS_SERVER}" "${dns_name}" A
    fi
  done
  if [[ -z "${C0_1_INSIDE_DNS_SERVER:-}" ]]; then
    capture dns_inside_unavailable "Ingress, edge, DNS, and certificates" \
      "Clinical-VLAN DNS probe was not configured" \
      unavailable_probe \
      "C0_1_INSIDE_DNS_SERVER was not supplied; clinical-VLAN DNS remains unknown."
  fi

  capture certificates "Ingress, edge, DNS, and certificates" \
    "Certificate resource issuer, readiness, renewal, and expiry" \
    "${KUBECTL[@]}" get certificates.cert-manager.io -A \
    -o 'custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,SECRET_NAME:.spec.secretName,ISSUER_KIND:.spec.issuerRef.kind,ISSUER_NAME:.spec.issuerRef.name,READY:.status.conditions[?(@.type=="Ready")].status,NOT_BEFORE:.status.notBefore,NOT_AFTER:.status.notAfter,RENEWAL:.status.renewalTime'

  IFS=',' read -r -a tls_endpoints <<<"${C0_1_TLS_ENDPOINTS:-api.vhhealth.app:443,admin.vhhealth.app:443}"
  tls_index=0
  for tls_endpoint in "${tls_endpoints[@]}"; do
    tls_endpoint="${tls_endpoint//[[:space:]]/}"
    [[ -n "${tls_endpoint}" ]] || continue
    tls_index=$((tls_index + 1))
    capture "tls_endpoints_${tls_index}" "Ingress, edge, DNS, and certificates" \
      "Certificate handshake and SPKI for ${tls_endpoint}" \
      tls_endpoint_probe "${tls_endpoint}"
  done

  capture prometheus_resources "Monitoring and alerting" \
    "Prometheus, ServiceMonitor, PodMonitor, and PrometheusRule resources" \
    "${KUBECTL[@]}" get \
    prometheuses.monitoring.coreos.com,servicemonitors.monitoring.coreos.com,podmonitors.monitoring.coreos.com,prometheusrules.monitoring.coreos.com \
    -A \
    -o 'custom-columns=KIND:.kind,NAMESPACE:.metadata.namespace,NAME:.metadata.name,REPLICAS:.spec.replicas,VERSION:.spec.version,AVAILABLE:.status.availableReplicas'

  capture prometheus_targets "Monitoring and alerting" \
    "Prometheus active scrape-target API" \
    prometheus_targets_probe

  capture prometheus_rules "Monitoring and alerting" \
    "Prometheus loaded-rules API" \
    prometheus_rules_probe

  capture prometheus_watchdog "Monitoring and alerting" \
    "Prometheus Watchdog query" \
    prometheus_watchdog_probe

  capture alertmanager_resources "Monitoring and alerting" \
    "Alertmanager resource version and replica posture" \
    "${KUBECTL[@]}" get alertmanagers.monitoring.coreos.com -A \
    -o 'custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,VERSION:.spec.version,REPLICAS:.spec.replicas,AVAILABLE:.status.availableReplicas,CONFIG_SECRET_NAME:.spec.configSecret'

  capture alertmanager_watchdog "Monitoring and alerting" \
    "Watchdog alert visible through Alertmanager API" \
    alertmanager_watchdog_probe

  capture scheduled_backups "Backups and restore" \
    "CNPG ScheduledBackup schedule and last schedule time" \
    "${KUBECTL[@]}" get scheduledbackups.postgresql.cnpg.io -A \
    -o 'custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,SCHEDULE:.spec.schedule,METHOD:.spec.method,CLUSTER:.spec.cluster.name,LAST_SCHEDULE:.status.lastScheduleTime'

  capture cnpg_backups "Backups and restore" \
    "Successful CNPG Backup start and completion timestamps" \
    "${KUBECTL[@]}" get backups.postgresql.cnpg.io -A \
    --sort-by=.status.stoppedAt \
    -o 'jsonpath={range .items[?(@.status.phase=="completed")]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.cluster.name}{"\t"}{.status.phase}{"\t"}{.status.startedAt}{"\t"}{.status.stoppedAt}{"\n"}{end}'

  capture backup_jobs_schedules "Backups and restore" \
    "Backup/verification CronJob schedules" \
    "${KUBECTL[@]}" -n vhhealth get cronjobs \
    vhhealth-backend-r2-sync backup-verification \
    -o 'custom-columns=KIND:.kind,NAMESPACE:.metadata.namespace,NAME:.metadata.name,SCHEDULE:.spec.schedule,LAST_SCHEDULE:.status.lastScheduleTime,START:.status.startTime,COMPLETION:.status.completionTime,SUCCEEDED:.status.succeeded,FAILED:.status.failed'
  capture backup_jobs_producer "Backups and restore" \
    "Archive producer Job history" \
    "${KUBECTL[@]}" -n vhhealth get jobs \
    -l batch.kubernetes.io/cronjob-name=vhhealth-backend-r2-sync \
    --sort-by=.status.startTime \
    -o 'custom-columns=NAME:.metadata.name,START:.status.startTime,COMPLETION:.status.completionTime,SUCCEEDED:.status.succeeded,FAILED:.status.failed'
  capture backup_jobs_verifier "Backups and restore" \
    "Archive verifier Job history" \
    "${KUBECTL[@]}" -n vhhealth get jobs \
    -l batch.kubernetes.io/cronjob-name=backup-verification \
    --sort-by=.status.startTime \
    -o 'custom-columns=NAME:.metadata.name,START:.status.startTime,COMPLETION:.status.completionTime,SUCCEEDED:.status.succeeded,FAILED:.status.failed'
  capture backup_jobs_cnpg_verifier_schedule "Backups and restore" \
    "CNPG backup-verification CronJob schedule" \
    "${KUBECTL[@]}" -n vhhealth-platform get cronjob cnpg-backup-verify \
    -o 'custom-columns=NAME:.metadata.name,SCHEDULE:.spec.schedule,LAST_SCHEDULE:.status.lastScheduleTime'
  capture backup_jobs_cnpg_verifier "Backups and restore" \
    "CNPG backup-verification Job history" \
    "${KUBECTL[@]}" -n vhhealth-platform get jobs \
    -l batch.kubernetes.io/cronjob-name=cnpg-backup-verify \
    --sort-by=.status.startTime \
    -o 'custom-columns=NAME:.metadata.name,START:.status.startTime,COMPLETION:.status.completionTime,SUCCEEDED:.status.succeeded,FAILED:.status.failed'

  capture r2_target_application "Backups and restore" \
    "Non-secret live R2 endpoint and bucket target" \
    "${KUBECTL[@]}" -n vhhealth get configmap vhhealth-backend-config \
    -o 'custom-columns=NAME:.metadata.name,R2_ENDPOINT:.data.R2_ENDPOINT,CF_R2_BUCKET:.data.CF_R2_BUCKET,MINIO_BACKUP_BUCKET:.data.MINIO_BACKUP_BUCKET'
  capture r2_target_cnpg "Backups and restore" \
    "Non-secret CNPG ObjectStore destination and retention target" \
    "${KUBECTL[@]}" -n vhhealth-platform get \
    objectstores.barmancloud.cnpg.io \
    -o 'custom-columns=NAME:.metadata.name,DESTINATION:.spec.configuration.destinationPath,ENDPOINT:.spec.configuration.endpointURL,RETENTION:.spec.retentionPolicy'

  if [[ -n "${C0_1_R2_ENDPOINT:-}" && -n "${C0_1_R2_BUCKET:-}" ]]; then
    capture r2_retention_lock "Backups and restore" \
      "R2 object-lock configuration" \
      aws --endpoint-url "${C0_1_R2_ENDPOINT}" s3api \
      get-object-lock-configuration --bucket "${C0_1_R2_BUCKET}"
    capture r2_retention_versioning "Backups and restore" \
      "R2 bucket versioning state" \
      aws --endpoint-url "${C0_1_R2_ENDPOINT}" s3api \
      get-bucket-versioning --bucket "${C0_1_R2_BUCKET}"
  else
    capture r2_retention_unavailable "Backups and restore" \
      "R2 retention probe was not configured" \
      unavailable_probe \
      "C0_1_R2_ENDPOINT and C0_1_R2_BUCKET were not both supplied; retention remains unknown."
  fi

  capture restore_evidence_clusters "Backups and restore" \
    "CNPG recovery clusters in the dedicated restore-proof namespace" \
    "${KUBECTL[@]}" -n vhhealth-restore-proof get \
    clusters.postgresql.cnpg.io \
    -o 'custom-columns=NAME:.metadata.name,RECOVERY_SOURCE:.spec.bootstrap.recovery.source,PHASE:.status.phase,READY_INSTANCES:.status.readyInstances'
  capture restore_evidence_schedule "Backups and restore" \
    "Governed restore-proof schedule posture" \
    "${KUBECTL[@]}" -n vhhealth-restore-proof get cronjob \
    cnpg-scheduled-restore-proof \
    -o 'custom-columns=NAME:.metadata.name,SCHEDULE:.spec.schedule,SUSPENDED:.spec.suspend,LAST_SCHEDULE:.status.lastScheduleTime'
  capture restore_evidence_jobs "Backups and restore" \
    "Successful governed restore-proof Job timestamps" \
    "${KUBECTL[@]}" -n vhhealth-restore-proof get jobs \
    -l batch.kubernetes.io/cronjob-name=cnpg-scheduled-restore-proof \
    --sort-by=.status.startTime \
    -o 'jsonpath={range .items[?(@.status.succeeded>0)]}{.metadata.name}{"\t"}{.status.startTime}{"\t"}{.status.completionTime}{"\t"}{.status.succeeded}{"\n"}{end}'

  if [[ -n "${C0_1_TIME_SSH_TARGETS:-}" ]]; then
    IFS=',' read -r -a time_targets <<<"${C0_1_TIME_SSH_TARGETS}"
    time_index=0
    for time_target_spec in "${time_targets[@]}"; do
      time_name="${time_target_spec%%=*}"
      time_target="${time_target_spec#*=}"
      if [[ ! "${time_name}" =~ ^[A-Za-z0-9_.-]+$ ||
        ! "${time_target}" =~ ^[A-Za-z0-9_.@:-]+$ ||
        "${time_name}" == "${time_target}" || "${time_target}" == -* ]]; then
        continue
      fi
      time_index=$((time_index + 1))
      capture "time_nodes_${time_index}_tracking" "Time and clock trust" \
        "chrony tracking for ${time_name}" \
        ssh -n -o BatchMode=yes -o ConnectTimeout=5 "${time_target}" -- \
        chronyc tracking
      capture "time_nodes_${time_index}_sources" "Time and clock trust" \
        "chrony source selection for ${time_name}" \
        ssh -n -o BatchMode=yes -o ConnectTimeout=5 "${time_target}" -- \
        chronyc sources -v
    done
  else
    capture time_nodes_unavailable "Time and clock trust" \
      "Node chrony probe targets were not configured" \
      unavailable_probe \
      "C0_1_TIME_SSH_TARGETS was not supplied; live node clock state remains unknown."
  fi
fi

REPOSITORY_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || true)"
printf '%s local_command=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  "C0_1_REPOSITORY_SHA=<sha> node c0-1-live-state-report.mjs --input <evidence> --full <full> --redacted <redacted>" \
  >>"${COMMAND_LOG}"

if command -v node >/dev/null 2>&1; then
  if C0_1_REPOSITORY_SHA="${REPOSITORY_SHA}" node "${REPORTER}" \
    --input "${OUTPUT_DIR}" \
    --full "${FULL_REPORT}" \
    --redacted "${REDACTED_REPORT}" \
    --repo-root "${REPO_ROOT}" >>"${COMMAND_LOG}" 2>&1; then
    printf 'report_emitter_status=0\n' >>"${COMMAND_LOG}"
  else
    printf 'report_emitter_status=failed; fallback reports retained\n' >>"${COMMAND_LOG}"
  fi
else
  printf 'report_emitter_status=unknown; node unavailable; fallback reports retained\n' \
    >>"${COMMAND_LOG}"
fi

if [[ -n "${C0_1_MINISIGN_SECRET_KEY_FILE:-}" ]]; then
  printf '%s local_command=minisign-sign-SHA256SUMS\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"${COMMAND_LOG}"
  printf 'signature_requested=true\n' >>"${COMMAND_LOG}"
else
  printf 'signature_requested=false; operator signing key not supplied\n' \
    >>"${COMMAND_LOG}"
fi

printf 'finished_at=%s\nfull_report=%s\nredacted_summary=%s\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${FULL_REPORT}" \
  "${REDACTED_REPORT}" >>"${COMMAND_LOG}"

printf '%s local_command=find+sort+sha256sum\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"${COMMAND_LOG}"
if command -v sha256sum >/dev/null 2>&1; then
  (
    cd -- "${OUTPUT_DIR}" || exit 1
    find . -type f \
      ! -name SHA256SUMS \
      ! -name SHA256SUMS.minisig \
      -print0 |
      sort -z |
      while IFS= read -r -d '' evidence_file; do
        sha256sum -- "${evidence_file}"
      done
  ) >"${OUTPUT_DIR}/SHA256SUMS"
else
  printf 'unknown: sha256sum unavailable\n' >"${OUTPUT_DIR}/SHA256SUMS"
fi

SIGNATURE_STATUS="not requested"
if [[ -n "${C0_1_MINISIGN_SECRET_KEY_FILE:-}" ]]; then
  if command -v minisign >/dev/null 2>&1 &&
    [[ -f "${C0_1_MINISIGN_SECRET_KEY_FILE}" ]]; then
    if minisign -S \
      -s "${C0_1_MINISIGN_SECRET_KEY_FILE}" \
      -m "${OUTPUT_DIR}/SHA256SUMS" \
      -x "${OUTPUT_DIR}/SHA256SUMS.minisig"; then
      SIGNATURE_STATUS="created"
    else
      SIGNATURE_STATUS="unknown (minisign failed)"
    fi
  else
    SIGNATURE_STATUS="unknown (minisign or key unavailable)"
  fi
fi

chmod -R go-rwx -- "${OUTPUT_DIR}"
printf 'C0.1 evidence collection completed with degradable unknowns allowed.\n'
printf 'Full local report: %s\n' "${FULL_REPORT}"
printf 'Redacted summary: %s\n' "${REDACTED_REPORT}"
printf 'Manual checklist: %s\n' "${OUTPUT_DIR}/manual-checklist.md"
printf 'Integrity manifest: %s\n' "${OUTPUT_DIR}/SHA256SUMS"
printf 'Detached signature: %s\n' "${SIGNATURE_STATUS}"
