#!/usr/bin/env bash

# Return 0 when the exact builder is listed, 1 when it is absent, and 2 when
# builder state cannot be enumerated. Callers must handle all three states.
vh_builder_known() {
  local expected_builder="$1"
  local builder_names
  local listed_builder

  if ! builder_names="$(docker buildx ls --format '{{.Name}}')"; then
    echo "::error::Unable to enumerate Buildx builders" >&2
    return 2
  fi
  while IFS= read -r listed_builder; do
    if [ "$listed_builder" = "$expected_builder" ]; then
      return 0
    fi
  done <<< "$builder_names"
  return 1
}

vh_container_known() {
  local expected_container="$1"
  local container_names
  local listed_container

  if ! container_names="$(docker container ls --all --format '{{.Names}}')"; then
    echo "::error::Unable to enumerate Docker containers" >&2
    return 2
  fi
  while IFS= read -r listed_container; do
    if [ "$listed_container" = "$expected_container" ]; then
      return 0
    fi
  done <<< "$container_names"
  return 1
}

# This proof never bootstraps or starts the builder. The configuration marker
# is written only by the literal create path and is revalidated after bootstrap
# against the live worker GC policy by the calling workflow.
vh_builder_prebootstrap_matches() {
  local builder_name="$1"
  local builder_container="$2"
  local expected_image="$3"
  local expected_config_sha256="$4"
  local actual_image
  local actual_log_driver
  local container_env
  local env_entry
  local config_marker_found=false

  if [ -z "$expected_image" ] || [ -z "$expected_config_sha256" ]; then
    return 1
  fi
  if ! docker buildx inspect "$builder_name" >/dev/null 2>&1; then
    return 1
  fi
  if ! actual_image="$(docker inspect -f '{{.Config.Image}}' "$builder_container")"; then
    return 1
  fi
  if [ "$actual_image" != "$expected_image" ]; then
    return 1
  fi
  if ! actual_log_driver="$(docker inspect -f '{{.HostConfig.LogConfig.Type}}' "$builder_container")"; then
    return 1
  fi
  if [ "$actual_log_driver" != local ]; then
    return 1
  fi
  if ! container_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$builder_container")"; then
    return 1
  fi
  while IFS= read -r env_entry; do
    if [ "$env_entry" = "VH_BUILDKIT_CONFIG_SHA256=$expected_config_sha256" ]; then
      config_marker_found=true
    fi
  done <<< "$container_env"
  [ "$config_marker_found" = true ]
}

# Remove only the exact supplied builder and backing-container names. A failed
# removal is accepted only when fresh exact-name enumeration proves the state
# is gone.
vh_retire_builder() {
  local stale_builder="$1"
  local stale_container="${2:-buildx_buildkit_${stale_builder}0}"
  local known_status=0
  local remove_status=0
  local container_status=0
  local container_remove_status=0
  local state_found=false

  vh_builder_known "$stale_builder" || known_status=$?
  case "$known_status" in
    0) ;;
    1) ;;
    *) return "$known_status" ;;
  esac

  if [ "$known_status" -eq 0 ]; then
    state_found=true
    docker buildx rm --force "$stale_builder" || remove_status=$?
    known_status=0
    vh_builder_known "$stale_builder" || known_status=$?
    case "$known_status" in
      1) ;;
      0)
        echo "::error::BuildKit builder $stale_builder remains after exact-name cleanup (rm status $remove_status)" >&2
        return 1
        ;;
      *)
        echo "::error::Unable to prove removal of BuildKit builder $stale_builder" >&2
        return "$known_status"
        ;;
    esac
  fi

  vh_container_known "$stale_container" || container_status=$?
  case "$container_status" in
    0)
      state_found=true
      docker rm --force "$stale_container" || container_remove_status=$?
      container_status=0
      vh_container_known "$stale_container" || container_status=$?
      ;;
    1) ;;
    *) return "$container_status" ;;
  esac
  case "$container_status" in
    1)
      if [ "$state_found" = true ]; then
        echo "Retired stale BuildKit builder $stale_builder"
      fi
      return 0
      ;;
    0)
      echo "::error::BuildKit container $stale_container remains after exact-name cleanup (rm status $container_remove_status)" >&2
      return 1
      ;;
    *)
      echo "::error::Unable to prove removal of BuildKit container $stale_container" >&2
      return "$container_status"
      ;;
  esac
}

vh_retain_or_retire_rollback() {
  local rollback_builder="$1"
  local rollback_container="$2"
  local expected_image="$3"
  local expected_config_sha256="$4"
  local known_status=0

  vh_builder_known "$rollback_builder" || known_status=$?
  case "$known_status" in
    1) vh_retire_builder "$rollback_builder" "$rollback_container"; return ;;
    0) ;;
    *) return "$known_status" ;;
  esac

  if vh_builder_prebootstrap_matches \
    "$rollback_builder" \
    "$rollback_container" \
    "$expected_image" \
    "$expected_config_sha256"; then
    echo "Retaining verified rollback builder $rollback_builder"
    return 0
  fi

  echo "Retiring unverified rollback builder $rollback_builder"
  vh_retire_builder "$rollback_builder" "$rollback_container"
}
