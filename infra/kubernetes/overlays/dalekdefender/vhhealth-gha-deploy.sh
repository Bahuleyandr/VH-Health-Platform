#!/usr/bin/env bash
set -euo pipefail

# Root-owned deploy helper for the Dalekdefender k3s test rig.
#
# stdin contract, one value per line:
#   1. backend image digest ref
#   2. admin image digest ref
#   3. git commit SHA
#   4. optional GHCR username
#   5. optional GHCR token/password
#
# Install as:
#   sudo install -o root -g root -m 0755 \
#     infra/kubernetes/overlays/dalekdefender/vhhealth-gha-deploy.sh \
#     /usr/local/sbin/vhhealth-gha-deploy

NAMESPACE="${VH_DEPLOY_NAMESPACE:-vhhealth}"
KUBECTL="${KUBECTL:-/usr/local/bin/kubectl}"
ROLLOUT_TIMEOUT="${VH_DEPLOY_ROLLOUT_TIMEOUT:-300s}"

read -r BACKEND_REF
read -r ADMIN_REF
read -r GIT_COMMIT
GHCR_USERNAME=""
GHCR_TOKEN=""
IFS= read -r GHCR_USERNAME || true
IFS= read -r GHCR_TOKEN || true

backend_re='^ghcr[.]io/bahuleyandr/vh-health-platform-backend@sha256:[0-9a-f]{64}$'
admin_re='^ghcr[.]io/bahuleyandr/vh-health-platform-adminportal@sha256:[0-9a-f]{64}$'
commit_re='^[0-9a-f]{40}$'
username_re='^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'

require_match() {
  local value="$1"
  local regex="$2"
  local label="$3"
  if [[ ! "$value" =~ $regex ]]; then
    echo "Invalid ${label}" >&2
    exit 2
  fi
}

require_match "$BACKEND_REF" "$backend_re" "backend image ref"
require_match "$ADMIN_REF" "$admin_re" "admin image ref"
require_match "$GIT_COMMIT" "$commit_re" "git commit"

if { [[ -n "$GHCR_USERNAME" ]] && [[ -z "$GHCR_TOKEN" ]]; } ||
   { [[ -z "$GHCR_USERNAME" ]] && [[ -n "$GHCR_TOKEN" ]]; }; then
  echo "GHCR username and token must be provided together" >&2
  exit 2
fi
if [[ -n "$GHCR_USERNAME" ]]; then
  require_match "$GHCR_USERNAME" "$username_re" "GHCR username"
fi
if [[ -n "$GHCR_TOKEN" ]] && { [[ ${#GHCR_TOKEN} -lt 20 ]] || [[ ${#GHCR_TOKEN} -gt 512 ]]; }; then
  echo "Invalid GHCR token length" >&2
  exit 2
fi

kubectl() {
  "$KUBECTL" "$@"
}

current_image() {
  local deploy="$1"
  kubectl -n "$NAMESPACE" get "deploy/${deploy}" \
    -o jsonpath='{.spec.template.spec.containers[0].image}'
}

current_commit() {
  kubectl -n "$NAMESPACE" get deploy/vhhealth-backend \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="GIT_COMMIT")].value}' 2>/dev/null || true
}

refresh_pull_secret() {
  if [[ -z "$GHCR_TOKEN" ]]; then
    return
  fi

  local auth_b64 docker_config docker_config_b64
  auth_b64="$(printf '%s:%s' "$GHCR_USERNAME" "$GHCR_TOKEN" | base64 | tr -d '\n')"
  docker_config="$(printf '{"auths":{"ghcr.io":{"auth":"%s"}}}' "$auth_b64")"
  docker_config_b64="$(printf '%s' "$docker_config" | base64 | tr -d '\n')"

  cat <<YAML | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: ghcr-read
  namespace: ${NAMESPACE}
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: ${docker_config_b64}
YAML

  kubectl -n "$NAMESPACE" patch serviceaccount default --type=merge \
    -p '{"imagePullSecrets":[{"name":"ghcr-read"}]}'
  for deploy in vhhealth-backend vhhealth-admin; do
    kubectl -n "$NAMESPACE" patch deploy "$deploy" --type=merge \
      -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"ghcr-read"}]}}}}'
  done
  echo "Refreshed GHCR image-pull secret for private image pull."
}

diagnose_backend() {
  local title="$1"
  echo "::group::Dalekdefender backend diagnostics: ${title}"
  kubectl -n "$NAMESPACE" get deploy,rs,pods \
    -l app.kubernetes.io/name=vhhealth-backend -o wide || true
  kubectl -n "$NAMESPACE" describe deploy/vhhealth-backend || true
  kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp | tail -80 || true

  local pods
  pods="$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=vhhealth-backend \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  while IFS= read -r pod; do
    [[ -z "$pod" ]] && continue
    echo "--- logs: ${pod}/backend tail=200 ---"
    kubectl -n "$NAMESPACE" logs "$pod" -c backend --tail=200 --timestamps || true
    echo "--- previous logs: ${pod}/backend tail=120 ---"
    kubectl -n "$NAMESPACE" logs "$pod" -c backend --previous --tail=120 --timestamps || true
  done <<< "$pods"
  echo "::endgroup::"
}

apply_refs() {
  local backend_ref="$1"
  local admin_ref="$2"
  local commit="$3"

  kubectl -n "$NAMESPACE" set image deploy/vhhealth-backend backend="$backend_ref"
  kubectl -n "$NAMESPACE" set image deploy/vhhealth-admin admin="$admin_ref"
  kubectl -n "$NAMESPACE" set env deploy/vhhealth-backend \
    GIT_COMMIT="$commit" \
    SENTRY_ENVIRONMENT=dalekdefender \
    SENTRY_TRACES_SAMPLE_RATE=0.1
  kubectl -n "$NAMESPACE" set env deploy/vhhealth-admin \
    GIT_COMMIT="$commit" \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=dalekdefender \
    NEXT_PUBLIC_SENTRY_RELEASE="$commit"
}

wait_for_rollout() {
  kubectl -n "$NAMESPACE" rollout status deploy/vhhealth-backend --timeout="$ROLLOUT_TIMEOUT"
  kubectl -n "$NAMESPACE" rollout status deploy/vhhealth-admin --timeout="$ROLLOUT_TIMEOUT"
}

PREV_BACKEND_REF="$(current_image vhhealth-backend)"
PREV_ADMIN_REF="$(current_image vhhealth-admin)"
PREV_COMMIT="$(current_commit)"
if [[ ! "$PREV_COMMIT" =~ $commit_re ]]; then
  PREV_COMMIT="$GIT_COMMIT"
fi

refresh_pull_secret
apply_refs "$BACKEND_REF" "$ADMIN_REF" "$GIT_COMMIT"

if wait_for_rollout; then
  echo "Deploy complete: commit $GIT_COMMIT live on dalekdefender (digest-pinned)."
  exit 0
fi

echo "::error::Dalekdefender rollout failed for commit ${GIT_COMMIT}; collecting diagnostics and rolling back." >&2
diagnose_backend "failed rollout ${GIT_COMMIT}"

if [[ "$PREV_BACKEND_REF" =~ $backend_re && "$PREV_ADMIN_REF" =~ $admin_re ]]; then
  echo "Rolling back to previous backend/admin image digests."
  apply_refs "$PREV_BACKEND_REF" "$PREV_ADMIN_REF" "$PREV_COMMIT"
  if wait_for_rollout; then
    echo "::warning::Rollback succeeded: restored commit ${PREV_COMMIT} after failed deploy ${GIT_COMMIT}."
    exit 1
  fi
  echo "::error::Rollback failed after failed deploy ${GIT_COMMIT}; manual operator action required." >&2
  diagnose_backend "rollback failure ${PREV_COMMIT}"
fi

exit 1
