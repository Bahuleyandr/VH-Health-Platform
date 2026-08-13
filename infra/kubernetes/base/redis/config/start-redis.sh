#!/bin/sh
set -eu
umask 077
REDIS_CONFIG_SOURCE_DIR="${REDIS_CONFIG_SOURCE_DIR:-/config}"
REDIS_CONFIG_RUNTIME_DIR="${REDIS_CONFIG_RUNTIME_DIR:-/etc/redis}"
. "$REDIS_CONFIG_SOURCE_DIR/sentinel-discovery.sh"

require_secret REDIS_PASSWORD
require_secret REDIS_SENTINEL_PASSWORD

pod_index="${HOSTNAME##*-}"
local_host="$(self_host)"
master_host=""
master_port="6379"

if consensus="$(wait_for_sentinel_consensus)"; then
  master_host="$(printf '%s\n' "$consensus" | awk '{ print $2 }')"
  master_port="$(printf '%s\n' "$consensus" | awk '{ print $3 }')"
  touch "$REDIS_CLUSTER_MARKER"
  rm -f "$REDIS_BOOTSTRAP_MARKER"
elif [ "$pod_index" = "0" ] && first_cluster_bootstrap_allowed; then
  # The only automatic no-quorum path is the first start of a genuinely empty
  # ordinal-0 PVC while the operator's one-time bootstrap gate is explicit.
  # Existing data or any nonzero ordinal must wait for two Sentinels, preventing
  # an old primary from resurrecting itself writable.
  master_host="$local_host"
  touch "$REDIS_CLUSTER_MARKER" "$REDIS_BOOTSTRAP_MARKER"
  echo "redis-ha: first-cluster bootstrap on $local_host" >&2
else
  fail "no 2-of-3 Sentinel master consensus; refusing Redis start (one-time bootstrap gate is closed or state is not empty ordinal 0)"
  exit 1
fi

mkdir -p "$REDIS_CONFIG_RUNTIME_DIR"
config_tmp="$REDIS_CONFIG_RUNTIME_DIR/redis.conf.$$"
cp "$REDIS_CONFIG_SOURCE_DIR/redis-base.conf" "$config_tmp"
write_default_user_acl \
  "$REDIS_CONFIG_RUNTIME_DIR/users.acl" \
  "$REDIS_PASSWORD" \
  "${REDIS_PASSWORD_PREVIOUS:-}"
{
  echo "bind 0.0.0.0"
  echo "port 6379"
  echo "dir $REDIS_DATA_DIR"
  echo "aclfile $REDIS_CONFIG_RUNTIME_DIR/users.acl"
  echo "masteruser default"
  echo "masterauth $REDIS_PASSWORD"
  echo "replica-announce-ip $local_host"
  echo "replica-announce-port 6379"
  if [ "$master_host" != "$local_host" ]; then
    echo "replicaof $master_host $master_port"
  fi
} >> "$config_tmp"
mv "$config_tmp" "$REDIS_CONFIG_RUNTIME_DIR/redis.conf"

exec "${REDIS_SERVER_BIN:-redis-server}" "$REDIS_CONFIG_RUNTIME_DIR/redis.conf"
