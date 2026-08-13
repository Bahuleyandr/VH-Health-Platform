#!/bin/sh
set -eu
umask 077
REDIS_CONFIG_SOURCE_DIR="${REDIS_CONFIG_SOURCE_DIR:-/config}"
REDIS_CONFIG_RUNTIME_DIR="${REDIS_CONFIG_RUNTIME_DIR:-/etc/redis}"
. "$REDIS_CONFIG_SOURCE_DIR/sentinel-discovery.sh"

require_secret REDIS_SENTINEL_PASSWORD
require_secret REDIS_PASSWORD
local_host="$(self_host)"
master_host=""
master_port="6379"

if consensus="$(wait_for_sentinel_consensus)"; then
  master_host="$(printf '%s\n' "$consensus" | awk '{ print $2 }')"
  master_port="$(printf '%s\n' "$consensus" | awk '{ print $3 }')"
elif first_cluster_bootstrap_allowed; then
  # Fresh Sentinels may form the first quorum around the sole permitted
  # bootstrap target. An initialized PVC never takes this branch.
  master_host="redis-0.$REDIS_HEADLESS_SERVICE.$POD_NAMESPACE.svc.cluster.local"
else
  fail "no 2-of-3 Sentinel master consensus; refusing to recreate Sentinel state from ordinal 0"
  exit 1
fi

mkdir -p "$REDIS_DATA_DIR/sentinel" "$REDIS_CONFIG_RUNTIME_DIR"
config_tmp="$REDIS_CONFIG_RUNTIME_DIR/sentinel.conf.$$"
cp "$REDIS_CONFIG_SOURCE_DIR/sentinel-base.conf" "$config_tmp"
write_default_user_acl \
  "$REDIS_CONFIG_RUNTIME_DIR/sentinel-users.acl" \
  "$REDIS_SENTINEL_PASSWORD" \
  "${REDIS_SENTINEL_PASSWORD_PREVIOUS:-}"
{
  echo "aclfile $REDIS_CONFIG_RUNTIME_DIR/sentinel-users.acl"
  echo "dir $REDIS_DATA_DIR/sentinel"
  echo "sentinel sentinel-user default"
  echo "sentinel sentinel-pass $REDIS_SENTINEL_PASSWORD"
  echo "sentinel monitor $REDIS_MASTER_NAME $master_host $master_port 2"
  echo "sentinel auth-user $REDIS_MASTER_NAME default"
  echo "sentinel auth-pass $REDIS_MASTER_NAME $REDIS_PASSWORD"
  echo "sentinel announce-ip $local_host"
  echo "sentinel announce-port 26379"
} >> "$config_tmp"
mv "$config_tmp" "$REDIS_CONFIG_RUNTIME_DIR/sentinel.conf"

exec "${REDIS_SENTINEL_BIN:-redis-sentinel}" "$REDIS_CONFIG_RUNTIME_DIR/sentinel.conf"
