#!/bin/sh
set -eu
REDIS_CONFIG_SOURCE_DIR="${REDIS_CONFIG_SOURCE_DIR:-/config}"
. "$REDIS_CONFIG_SOURCE_DIR/sentinel-discovery.sh"

require_secret REDIS_PASSWORD
require_secret REDIS_SENTINEL_PASSWORD
REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_CLI_BIN" --no-auth-warning ping | grep -qx PONG
write_fence="$(
  REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_CLI_BIN" --no-auth-warning --raw \
    CONFIG GET min-replicas-to-write | sed -n '2p'
)"
[ "$write_fence" = "1" ]

consensus="$(sentinel_master_consensus)"
master_host="$(printf '%s\n' "$consensus" | awk '{ print $2 }')"
local_host="$(self_host)"
role="$(REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_CLI_BIN" --no-auth-warning --raw ROLE | sed -n '1p')"

if [ "$master_host" = "$local_host" ]; then
  [ "$role" = "master" ]
  replication="$(REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_CLI_BIN" --no-auth-warning --raw INFO replication)"
  connected_replicas="$(printf '%s\n' "$replication" | tr -d '\r' | sed -n 's/^connected_slaves://p')"
  case "$connected_replicas" in
    ''|*[!0-9]*) exit 1 ;;
  esac
  [ "$connected_replicas" -ge 1 ]
else
  [ "$role" = "slave" ]
  replication="$(REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_CLI_BIN" --no-auth-warning --raw INFO replication)"
  printf '%s\n' "$replication" | tr -d '\r' | grep -qx "master_host:$master_host"
  printf '%s\n' "$replication" | tr -d '\r' | grep -qx 'master_link_status:up'
fi

rm -f "$REDIS_BOOTSTRAP_MARKER"
