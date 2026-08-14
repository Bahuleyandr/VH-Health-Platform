#!/bin/sh
set -eu

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vh-redis-ha.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT HUP INT TERM
SOURCE_DIR="$(CDPATH= cd "$(dirname "$0")/../config" && pwd)"
FAKE_BIN="$ROOT/bin"
DATA_PASSWORD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SENTINEL_PASSWORD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
DATA_PASSWORD_PREVIOUS=cccccccccccccccccccccccccccccccc
SENTINEL_PASSWORD_PREVIOUS=dddddddddddddddddddddddddddddddd
CONTROL_PASSWORD=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
METRICS_PASSWORD=ffffffffffffffffffffffffffffffff
SENTINEL_CONTROL_PASSWORD=11111111111111111111111111111111
CONTROL_PASSWORD_PREVIOUS=22222222222222222222222222222222
METRICS_PASSWORD_PREVIOUS=33333333333333333333333333333333
SENTINEL_CONTROL_PASSWORD_PREVIOUS=44444444444444444444444444444444
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/redis-cli" <<'EOF'
#!/bin/sh
host=local
previous=
for argument in "$@"; do
  if [ "$previous" = "-h" ]; then host="$argument"; fi
  previous="$argument"
done
command_line="$*"

case "$command_line" in
  *"SENTINEL get-master-addr-by-name"*)
    case "$host" in
      *redis-0*) master="${FAKE_MASTER_0:-}" ;;
      *redis-1*) master="${FAKE_MASTER_1:-}" ;;
      *redis-2*) master="${FAKE_MASTER_2:-}" ;;
      *) master="${FAKE_LOCAL_SENTINEL_MASTER:-}" ;;
    esac
    [ -n "$master" ] || exit 1
    printf '%s\n6379\n' "$master"
    ;;
  *"SENTINEL ckquorum"*) echo "OK 3 usable Sentinels. Quorum and failover authorization can be reached" ;;
  *"INFO replication"*)
    printf 'role:%s\r\nconnected_slaves:%s\r\nmaster_host:%s\r\nmaster_link_status:%s\r\n' \
      "${FAKE_LOCAL_ROLE:-slave}" "${FAKE_CONNECTED_SLAVES:-1}" \
      "${FAKE_LOCAL_MASTER:-}" "${FAKE_MASTER_LINK_STATUS:-up}"
    ;;
  *"CONFIG GET min-replicas-to-write"*) printf 'min-replicas-to-write\n1\n' ;;
  *"ROLE"*) printf '%s\n' "${FAKE_LOCAL_ROLE:-slave}" ;;
  *"ping"*|*"PING"*) echo PONG ;;
  *) exit 1 ;;
esac
EOF

cat > "$FAKE_BIN/redis-server" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" > "$FAKE_EXEC_LOG"
EOF

cat > "$FAKE_BIN/redis-sentinel" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" > "$FAKE_EXEC_LOG"
EOF
chmod +x "$FAKE_BIN/redis-cli" "$FAKE_BIN/redis-server" "$FAKE_BIN/redis-sentinel"

assert_contains() {
  grep -Fq "$2" "$1" || {
    echo "expected $1 to contain: $2" >&2
    exit 1
  }
}

assert_not_contains() {
  if grep -Fq "$2" "$1"; then
    echo "expected $1 not to contain: $2" >&2
    exit 1
  fi
}

assert_user_denied() {
  user_line="$(grep -F "user $2 " "$1")"
  case "$user_line" in
    *"$3"*)
      echo "expected $2 ACL not to contain: $3" >&2
      exit 1
      ;;
  esac
}

new_case() {
  CASE_ROOT="$ROOT/$1"
  DATA_DIR="$CASE_ROOT/data"
  RUNTIME_DIR="$CASE_ROOT/runtime"
  EXEC_LOG="$CASE_ROOT/exec.log"
  mkdir -p "$DATA_DIR" "$RUNTIME_DIR"
}

run_redis() {
  env \
    PATH="$FAKE_BIN:$PATH" \
    HOSTNAME="${TEST_HOSTNAME:-redis-0}" \
    REDIS_PASSWORD="$DATA_PASSWORD" \
    REDIS_CONTROL_PASSWORD="$CONTROL_PASSWORD" \
    REDIS_METRICS_PASSWORD="$METRICS_PASSWORD" \
    REDIS_SENTINEL_PASSWORD="$SENTINEL_PASSWORD" \
    REDIS_PASSWORD_PREVIOUS="${DATA_PREVIOUS:-}" \
    REDIS_CONTROL_PASSWORD_PREVIOUS="${CONTROL_PREVIOUS:-}" \
    REDIS_METRICS_PASSWORD_PREVIOUS="${METRICS_PREVIOUS:-}" \
    REDIS_SENTINEL_PASSWORD_PREVIOUS="${SENTINEL_PREVIOUS:-}" \
    REDIS_ALLOW_FIRST_CLUSTER_BOOTSTRAP="${BOOTSTRAP_ALLOWED:-false}" \
    REDIS_DISCOVERY_ATTEMPTS=1 \
    REDIS_DATA_DIR="$DATA_DIR" \
    REDIS_CONFIG_SOURCE_DIR="$SOURCE_DIR" \
    REDIS_CONFIG_RUNTIME_DIR="$RUNTIME_DIR" \
    REDIS_CLI_BIN="$FAKE_BIN/redis-cli" \
    REDIS_SERVER_BIN="$FAKE_BIN/redis-server" \
    FAKE_EXEC_LOG="$EXEC_LOG" \
    FAKE_MASTER_0="${MASTER_0:-}" \
    FAKE_MASTER_1="${MASTER_1:-}" \
    FAKE_MASTER_2="${MASTER_2:-}" \
    sh "$SOURCE_DIR/start-redis.sh"
}

run_sentinel() {
  env \
    PATH="$FAKE_BIN:$PATH" \
    HOSTNAME="${TEST_HOSTNAME:-redis-0}" \
    REDIS_CONTROL_PASSWORD="$CONTROL_PASSWORD" \
    REDIS_SENTINEL_PASSWORD="$SENTINEL_PASSWORD" \
    REDIS_SENTINEL_CONTROL_PASSWORD="$SENTINEL_CONTROL_PASSWORD" \
    REDIS_SENTINEL_PASSWORD_PREVIOUS="${SENTINEL_PREVIOUS:-}" \
    REDIS_SENTINEL_CONTROL_PASSWORD_PREVIOUS="${SENTINEL_CONTROL_PREVIOUS:-}" \
    REDIS_ALLOW_FIRST_CLUSTER_BOOTSTRAP="${BOOTSTRAP_ALLOWED:-false}" \
    REDIS_DISCOVERY_ATTEMPTS=1 \
    REDIS_DATA_DIR="$DATA_DIR" \
    REDIS_CONFIG_SOURCE_DIR="$SOURCE_DIR" \
    REDIS_CONFIG_RUNTIME_DIR="$RUNTIME_DIR" \
    REDIS_CLI_BIN="$FAKE_BIN/redis-cli" \
    REDIS_SENTINEL_BIN="$FAKE_BIN/redis-sentinel" \
    FAKE_EXEC_LOG="$EXEC_LOG" \
    FAKE_MASTER_0="${MASTER_0:-}" \
    FAKE_MASTER_1="${MASTER_1:-}" \
    FAKE_MASTER_2="${MASTER_2:-}" \
    sh "$SOURCE_DIR/start-sentinel.sh"
}

# No quorum + committed closed gate: even empty ordinal 0 must not self-elect.
new_case closed-gate
if BOOTSTRAP_ALLOWED=false run_redis >/dev/null 2>&1; then
  echo "closed first-bootstrap gate unexpectedly started Redis" >&2
  exit 1
fi
[ ! -e "$EXEC_LOG" ]

# Explicit first-install gate + empty ordinal 0: exactly this case may bootstrap.
new_case first-bootstrap
BOOTSTRAP_ALLOWED=true TEST_HOSTNAME=redis-0 run_redis
assert_not_contains "$RUNTIME_DIR/redis.conf" "replicaof "
assert_contains "$RUNTIME_DIR/redis.conf" "min-replicas-to-write 1"
assert_contains "$RUNTIME_DIR/users.acl" "user default off"
assert_contains "$RUNTIME_DIR/users.acl" "user vhhealth-backend on >$DATA_PASSWORD"
assert_contains "$RUNTIME_DIR/users.acl" "user vhhealth-control on >$CONTROL_PASSWORD"
assert_contains "$RUNTIME_DIR/users.acl" "user vhhealth-metrics on >$METRICS_PASSWORD"
assert_user_denied "$RUNTIME_DIR/users.acl" vhhealth-backend "+@all"
assert_user_denied "$RUNTIME_DIR/users.acl" vhhealth-backend "+config"
assert_user_denied "$RUNTIME_DIR/users.acl" vhhealth-backend "+replicaof"
assert_contains "$RUNTIME_DIR/redis.conf" "masteruser vhhealth-control"
assert_contains "$RUNTIME_DIR/redis.conf" "masterauth $CONTROL_PASSWORD"
assert_contains "$EXEC_LOG" "$RUNTIME_DIR/redis.conf"
[ -f "$DATA_DIR/.vhhealth-cluster-initialized" ]

# The co-located Sentinel may start after Redis has written both bootstrap
# markers; it can still join the one-time first-cluster formation.
BOOTSTRAP_ALLOWED=true TEST_HOSTNAME=redis-0 run_sentinel
assert_contains "$RUNTIME_DIR/sentinel.conf" \
  "sentinel monitor vhhealth-primary redis-0.redis-headless.vhhealth-platform.svc.cluster.local 6379 2"

# Once readiness removes the one-time marker, the escape hatch cannot reopen
# even if no persistence file has appeared yet and the transient flag lingers.
rm -f "$DATA_DIR/.vhhealth-first-bootstrap"
if BOOTSTRAP_ALLOWED=true TEST_HOSTNAME=redis-0 run_redis >/dev/null 2>&1; then
  echo "completed bootstrap marker unexpectedly reopened" >&2
  exit 1
fi

# Existing persistence can never reuse the first-install escape hatch.
new_case existing-no-quorum
mkdir -p "$DATA_DIR/appendonlydir"
: > "$DATA_DIR/appendonlydir/appendonly.aof.1.incr.aof"
if BOOTSTRAP_ALLOWED=true TEST_HOSTNAME=redis-0 run_redis >/dev/null 2>&1; then
  echo "existing ordinal 0 unexpectedly self-elected without quorum" >&2
  exit 1
fi

# A restarted former primary follows two agreeing Sentinels and becomes replica.
new_case former-primary
mkdir -p "$DATA_DIR/appendonlydir"
: > "$DATA_DIR/appendonlydir/appendonly.aof.1.incr.aof"
elected="redis-1.redis-headless.vhhealth-platform.svc.cluster.local"
MASTER_0="$elected" MASTER_1="$elected" \
  DATA_PREVIOUS="$DATA_PASSWORD_PREVIOUS" \
  CONTROL_PREVIOUS="$CONTROL_PASSWORD_PREVIOUS" \
  METRICS_PREVIOUS="$METRICS_PASSWORD_PREVIOUS" \
  TEST_HOSTNAME=redis-0 run_redis
assert_contains "$RUNTIME_DIR/redis.conf" "replicaof $elected 6379"
assert_contains "$RUNTIME_DIR/users.acl" "user vhhealth-backend on >$DATA_PASSWORD >$DATA_PASSWORD_PREVIOUS"
assert_contains "$RUNTIME_DIR/users.acl" "user vhhealth-control on >$CONTROL_PASSWORD >$CONTROL_PASSWORD_PREVIOUS"
assert_contains "$RUNTIME_DIR/users.acl" "user vhhealth-metrics on >$METRICS_PASSWORD >$METRICS_PASSWORD_PREVIOUS"

# A quorum-selected node starts as primary without an ordinal shortcut.
new_case elected-primary
mkdir -p "$DATA_DIR/appendonlydir"
: > "$DATA_DIR/appendonlydir/appendonly.aof.1.incr.aof"
MASTER_0="$elected" MASTER_2="$elected" TEST_HOSTNAME=redis-1 run_redis
assert_not_contains "$RUNTIME_DIR/redis.conf" "replicaof "

# One Sentinel vote is insufficient for existing state.
new_case minority-vote
mkdir -p "$DATA_DIR/appendonlydir"
: > "$DATA_DIR/appendonlydir/appendonly.aof.1.incr.aof"
if MASTER_0="$elected" TEST_HOSTNAME=redis-0 run_redis >/dev/null 2>&1; then
  echo "minority Sentinel vote unexpectedly started existing Redis" >&2
  exit 1
fi

# A restarted Sentinel follows quorum state and authenticates control + data planes.
new_case sentinel-follow
mkdir -p "$DATA_DIR/appendonlydir"
: > "$DATA_DIR/appendonlydir/appendonly.aof.1.incr.aof"
sentinel_master="redis-2.redis-headless.vhhealth-platform.svc.cluster.local"
MASTER_0="$sentinel_master" MASTER_1="$sentinel_master" \
  SENTINEL_PREVIOUS="$SENTINEL_PASSWORD_PREVIOUS" \
  SENTINEL_CONTROL_PREVIOUS="$SENTINEL_CONTROL_PASSWORD_PREVIOUS" \
  TEST_HOSTNAME=redis-0 run_sentinel
assert_contains "$RUNTIME_DIR/sentinel.conf" "sentinel sentinel-user vhhealth-sentinel-peer"
assert_contains "$RUNTIME_DIR/sentinel.conf" "sentinel sentinel-pass $SENTINEL_CONTROL_PASSWORD"
assert_contains "$RUNTIME_DIR/sentinel.conf" "sentinel monitor vhhealth-primary $sentinel_master 6379 2"
assert_contains "$RUNTIME_DIR/sentinel.conf" "sentinel auth-user vhhealth-primary vhhealth-control"
assert_contains "$RUNTIME_DIR/sentinel.conf" "sentinel auth-pass vhhealth-primary $CONTROL_PASSWORD"
assert_contains "$RUNTIME_DIR/sentinel-users.acl" "user default off"
assert_contains "$RUNTIME_DIR/sentinel-users.acl" "user vhhealth-discovery on >$SENTINEL_PASSWORD >$SENTINEL_PASSWORD_PREVIOUS"
assert_contains "$RUNTIME_DIR/sentinel-users.acl" "user vhhealth-sentinel-peer on >$SENTINEL_CONTROL_PASSWORD >$SENTINEL_CONTROL_PASSWORD_PREVIOUS"
assert_user_denied "$RUNTIME_DIR/sentinel-users.acl" vhhealth-discovery "+@all"
assert_user_denied "$RUNTIME_DIR/sentinel-users.acl" vhhealth-discovery "+sentinel|failover"

# Readiness rejects a writable former primary even when it still answers PING.
new_case stale-readiness
if env \
  HOSTNAME=redis-0 \
  REDIS_CONTROL_PASSWORD="$CONTROL_PASSWORD" \
  REDIS_SENTINEL_PASSWORD="$SENTINEL_PASSWORD" \
  REDIS_DATA_DIR="$DATA_DIR" \
  REDIS_CONFIG_SOURCE_DIR="$SOURCE_DIR" \
  REDIS_CLI_BIN="$FAKE_BIN/redis-cli" \
  FAKE_MASTER_0="$elected" \
  FAKE_MASTER_1="$elected" \
  FAKE_LOCAL_ROLE=master \
  sh "$SOURCE_DIR/redis-readiness.sh" >/dev/null 2>&1; then
  echo "readiness accepted a stale writable former primary" >&2
  exit 1
fi

env \
  HOSTNAME=redis-0 \
  REDIS_CONTROL_PASSWORD="$CONTROL_PASSWORD" \
  REDIS_SENTINEL_PASSWORD="$SENTINEL_PASSWORD" \
  REDIS_DATA_DIR="$DATA_DIR" \
  REDIS_CONFIG_SOURCE_DIR="$SOURCE_DIR" \
  REDIS_CLI_BIN="$FAKE_BIN/redis-cli" \
  FAKE_MASTER_0="$elected" \
  FAKE_MASTER_1="$elected" \
  FAKE_LOCAL_ROLE=slave \
  FAKE_LOCAL_MASTER="$elected" \
  FAKE_MASTER_LINK_STATUS=up \
  sh "$SOURCE_DIR/redis-readiness.sh"

echo "Redis HA deterministic harness passed (10 scenarios)."
