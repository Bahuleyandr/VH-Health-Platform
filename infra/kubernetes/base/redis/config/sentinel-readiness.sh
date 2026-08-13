#!/bin/sh
set -eu
REDIS_CONFIG_SOURCE_DIR="${REDIS_CONFIG_SOURCE_DIR:-/config}"
. "$REDIS_CONFIG_SOURCE_DIR/sentinel-discovery.sh"

require_secret REDIS_SENTINEL_PASSWORD
REDISCLI_AUTH="$REDIS_SENTINEL_PASSWORD" "$REDIS_CLI_BIN" --no-auth-warning \
  --user "$REDIS_SENTINEL_USERNAME" -p 26379 ping | grep -qx PONG
consensus="$(sentinel_master_consensus)"
consensus_host="$(printf '%s\n' "$consensus" | awk '{ print $2 }')"
local_master="$(
  REDISCLI_AUTH="$REDIS_SENTINEL_PASSWORD" "$REDIS_CLI_BIN" --no-auth-warning --raw -p 26379 \
    --user "$REDIS_SENTINEL_USERNAME" \
    SENTINEL get-master-addr-by-name "$REDIS_MASTER_NAME"
)"
[ "$(printf '%s\n' "$local_master" | sed -n '1p')" = "$consensus_host" ]
REDISCLI_AUTH="$REDIS_SENTINEL_PASSWORD" "$REDIS_CLI_BIN" --no-auth-warning --raw -p 26379 \
  --user "$REDIS_SENTINEL_USERNAME" \
  SENTINEL ckquorum "$REDIS_MASTER_NAME" | grep -q '^OK '
