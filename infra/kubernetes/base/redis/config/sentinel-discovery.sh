#!/bin/sh

REDIS_MASTER_NAME="${REDIS_MASTER_NAME:-vhhealth-primary}"
REDIS_HEADLESS_SERVICE="${REDIS_HEADLESS_SERVICE:-redis-headless}"
POD_NAMESPACE="${POD_NAMESPACE:-vhhealth-platform}"
REDIS_SENTINEL_HOSTS="${REDIS_SENTINEL_HOSTS:-redis-0.redis-headless.vhhealth-platform.svc.cluster.local:26379 redis-1.redis-headless.vhhealth-platform.svc.cluster.local:26379 redis-2.redis-headless.vhhealth-platform.svc.cluster.local:26379}"
REDIS_SENTINEL_QUORUM=2
REDIS_ALLOW_FIRST_CLUSTER_BOOTSTRAP="${REDIS_ALLOW_FIRST_CLUSTER_BOOTSTRAP:-false}"
REDIS_DATA_DIR="${REDIS_DATA_DIR:-/data}"
REDIS_CLI_BIN="${REDIS_CLI_BIN:-redis-cli}"
REDIS_CLUSTER_MARKER="$REDIS_DATA_DIR/.vhhealth-cluster-initialized"
REDIS_BOOTSTRAP_MARKER="$REDIS_DATA_DIR/.vhhealth-first-bootstrap"

fail() {
  echo "redis-ha: $*" >&2
  return 1
}

require_secret() {
  secret_name="$1"
  eval "secret_value=\${$secret_name:-}"
  [ -n "$secret_value" ] || fail "$secret_name is required"
}

validate_acl_secret() {
  acl_secret="$1"
  acl_name="$2"
  [ "${#acl_secret}" -ge 32 ] || fail "$acl_name must be at least 32 hexadecimal characters"
  case "$acl_secret" in
    *[!0-9a-fA-F]*) fail "$acl_name must be hexadecimal for safe Redis ACL rendering" ;;
  esac
}

write_default_user_acl() {
  acl_path="$1"
  acl_current="$2"
  acl_previous="${3:-}"
  validate_acl_secret "$acl_current" current_credential || return 1
  if [ -n "$acl_previous" ]; then
    validate_acl_secret "$acl_previous" previous_credential || return 1
  fi
  {
    printf 'user default on >%s' "$acl_current"
    if [ -n "$acl_previous" ] && [ "$acl_previous" != "$acl_current" ]; then
      printf ' >%s' "$acl_previous"
    fi
    printf ' ~* &* +@all\n'
  } > "$acl_path"
}

self_host() {
  printf '%s.%s.%s.svc.cluster.local\n' "$HOSTNAME" "$REDIS_HEADLESS_SERVICE" "$POD_NAMESPACE"
}

is_approved_redis_host() {
  redis_suffix=".$REDIS_HEADLESS_SERVICE.$POD_NAMESPACE.svc.cluster.local"
  case "$1" in
    "redis-0$redis_suffix"|"redis-1$redis_suffix"|"redis-2$redis_suffix") return 0 ;;
    *) return 1 ;;
  esac
}

redis_persistence_exists() {
  find "$REDIS_DATA_DIR" -maxdepth 3 -type f \
    \( -name 'dump.rdb' -o -name 'appendonly.aof' -o -path '*/appendonlydir/*' \) \
    -print -quit 2>/dev/null | grep -q .
}

first_cluster_bootstrap_allowed() {
  [ "$REDIS_ALLOW_FIRST_CLUSTER_BOOTSTRAP" = "true" ] \
    && ! redis_persistence_exists \
    && { [ ! -e "$REDIS_CLUSTER_MARKER" ] || [ -e "$REDIS_BOOTSTRAP_MARKER" ]; }
}

sentinel_master_consensus() {
  require_secret REDIS_SENTINEL_PASSWORD || return 1
  votes="${TMPDIR:-/tmp}/redis-sentinel-votes.$$"
  : > "$votes"
  seen_endpoints=" "

  for endpoint in $REDIS_SENTINEL_HOSTS; do
    case "$seen_endpoints" in
      *" $endpoint "*) continue ;;
    esac
    seen_endpoints="$seen_endpoints$endpoint "
    sentinel_host="${endpoint%:*}"
    sentinel_port="${endpoint##*:}"
    quorum_state="$(
      REDISCLI_AUTH="$REDIS_SENTINEL_PASSWORD" "$REDIS_CLI_BIN" --no-auth-warning --raw \
        -h "$sentinel_host" -p "$sentinel_port" \
        SENTINEL ckquorum "$REDIS_MASTER_NAME" 2>/dev/null || true
    )"
    case "$quorum_state" in
      OK\ *) ;;
      *) continue ;;
    esac
    response="$(
      REDISCLI_AUTH="$REDIS_SENTINEL_PASSWORD" "$REDIS_CLI_BIN" --no-auth-warning --raw \
        -h "$sentinel_host" -p "$sentinel_port" \
        SENTINEL get-master-addr-by-name "$REDIS_MASTER_NAME" 2>/dev/null || true
    )"
    master_host="$(printf '%s\n' "$response" | sed -n '1p')"
    master_port="$(printf '%s\n' "$response" | sed -n '2p')"
    if is_approved_redis_host "$master_host" && [ "$master_port" = "6379" ]; then
      printf '%s %s\n' "$master_host" "$master_port" >> "$votes"
    fi
  done

  consensus="$(
    awk '{ count[$1 " " $2] += 1 } END { for (key in count) print count[key], key }' "$votes" \
      | sort -rn | head -n 1
  )"
  rm -f "$votes"
  vote_count="$(printf '%s\n' "$consensus" | awk '{ print $1 }')"
  case "$vote_count" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$vote_count" -ge "$REDIS_SENTINEL_QUORUM" ] || return 1
  printf '%s\n' "$consensus"
}

wait_for_sentinel_consensus() {
  attempts="${REDIS_DISCOVERY_ATTEMPTS:-30}"
  while [ "$attempts" -gt 0 ]; do
    if consensus="$(sentinel_master_consensus)"; then
      printf '%s\n' "$consensus"
      return 0
    fi
    attempts=$((attempts - 1))
    [ "$attempts" -gt 0 ] && sleep 2
  done
  return 1
}
