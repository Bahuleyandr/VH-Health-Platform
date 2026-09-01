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
CURL="${CURL:-curl}"
# The rig's localhost bridge to the backend Service (tailscale-serve's :8444
# source — see README). The verify step curls it directly because the kubectl
# service proxy cannot send X-Forwarded-Proto (see verify_backend_version).
VERIFY_URL="${VH_DEPLOY_VERIFY_URL:-http://127.0.0.1:30090/health/version}"
ROLLOUT_TIMEOUT="${VH_DEPLOY_ROLLOUT_TIMEOUT:-300s}"

# Migration step (the rig's stand-in for the production ArgoCD PreSync hook).
# See infra/kubernetes/overlays/dalekdefender/migration-job.yaml.
MIGRATE_JOB="${VH_DEPLOY_MIGRATE_JOB:-vhhealth-backend-migrate}"
MIGRATE_TIMEOUT="${VH_DEPLOY_MIGRATE_TIMEOUT:-900}"
MIGRATE_POLL_INTERVAL="${VH_DEPLOY_MIGRATE_POLL_INTERVAL:-5}"
# Set by run_migrations. "0" means the tracker did not move and an automatic
# image rollback is still safe; any other value (including "unknown") means it
# may have, and rollback is refused. Starts at "unknown" so an early abort can
# never be mistaken for "nothing was applied".
MIGRATIONS_APPLIED="unknown"

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

# ── Migration step ─────────────────────────────────────────────────────────
#
# The production overlay gets this ordering from an ArgoCD PreSync hook
# (infra/kubernetes/apps/backend/migration-job.yaml). The rig runs no ArgoCD,
# so the guarantee lives here instead: migrations are applied with the SAME
# verified digest that is about to be pinned, and apply_refs is not reached
# unless that Job reports Complete. Without it, every deploy carrying a new
# migration was guaranteed to fail — the image's startup check
# (runMigrations.js) refuses to boot on MIGRATION_TIP_MISMATCH — and a human
# had to hand-run the Job.
#
# The manifest is embedded rather than read from the host checkout: this
# script runs as root from /usr/local/sbin and the host's git clone is neither
# a trusted nor a reliably current input.
# scripts/dalek-migration-job-manifest.test.mjs pins the embedded copy
# byte-for-byte against the overlay file so the two cannot drift.
migration_job_manifest() {
  cat <<'MIGRATION_JOB_MANIFEST'
# Dalekdefender DB migration Job — the rig's equivalent of the production
# ArgoCD PreSync hook in infra/kubernetes/apps/backend/migration-job.yaml.
#
# WHY THIS FILE IS NOT IN kustomization.yaml
#   The rig runs no ArgoCD, so there is no PreSync hook to attach to. The
#   ordering guarantee instead comes from the root-owned deploy helper
#   (vhhealth-gha-deploy.sh): it renders this manifest with the SAME verified
#   image digest it is about to pin, runs it to completion, and only then
#   sets the Deployment images. A failed Job aborts the deploy and leaves the
#   Deployments untouched, so API workers never start against a schema they
#   cannot prove.
#   The helper embeds this file verbatim (it runs as root from
#   /usr/local/sbin and must not read the host's git checkout, which can be
#   stale). scripts/dalek-migration-job-manifest.test.mjs asserts the embedded
#   copy is byte-identical to this one, so the two cannot drift.
#   `image:` below is a placeholder the helper substitutes; applying this file
#   directly with `kubectl apply -k` would create an unpullable Job, which is
#   why kustomization.yaml deliberately does not list it.
#
# DIFFERENCES FROM THE PRODUCTION JOB, AND WHY
#   * No `wait-owner-bypassrls` initContainer. That gate exists because CNPG
#     grants the owner `bypassrls` on the operator's own reconcile loop, which
#     can race a fresh cluster's PreSync Job. The rig runs a plain
#     `vhhealth-postgres-0` StatefulSet whose bootstrap role `vhhealth` is a
#     superuser from initdb (verified: rolsuper=t, rolbypassrls=t), so there is
#     no reconcile to wait for.
#   * No DATABASE_URL override. Production splits the owner DSN
#     (DATABASE_SUPERUSER_URL) from the NOBYPASSRLS runtime DSN; the rig's
#     `vhhealth-backend` Secret carries a single DATABASE_URL and it is already
#     the owner/superuser connection, so `envFrom` alone gives migrations the
#     DDL rights they need.
#   * No `vhhealth-backend-config` configMapRef — the rig has no such ConfigMap.
#   * RUNTIME_ROLE_GRANTS_OPTIONAL=true. The rig has no `vhhealth_runtime`
#     login role (verified: only vhhealth, vhhealth_app, vhhealth_readonly) and
#     no AUTH_TENANT_RLS_RUNTIME_ROLE in the Secret, which is exactly the
#     single-DSN configuration the production Job's own comment blesses this
#     knob for. It turns a configuration-absent skip into a loud exit-0 no-op;
#     an unsafe role name, a grant error, or a bad posture still fails.
#
# IDEMPOTENT AND SAFE TO RE-RUN: ci-setup-db.mjs is tracker-driven. It applies
# each file in src/migrations/*.sql exactly once per database via `_migrations`
# and is a no-op when the database is already caught up. Each migration is
# applied inside a transaction (its own, or the executor's), so a mid-file
# failure commits nothing and records no tracker row.
#
# NO SEEDS: --skip-seeds plus CI_DB_SKIP_SEEDS=1. The rig's identities are
# provisioned through the approved onboarding path (see README), and the
# synthetic seed scripts refuse to run under NODE_ENV=production anyway.
apiVersion: batch/v1
kind: Job
metadata:
  name: vhhealth-backend-migrate
  namespace: vhhealth
  labels:
    app.kubernetes.io/name: vhhealth-backend-migrate
    app.kubernetes.io/component: migration
    app.kubernetes.io/part-of: vhhealth
spec:
  # One retry, then fail the deploy. A retry rides out a Postgres pod that is
  # still coming up; a genuinely failing migration must reach the operator
  # quickly rather than burn the helper's wait budget.
  backoffLimit: 1
  # 15min hard cap — real migrations take <60s; anything longer is hung.
  activeDeadlineSeconds: 900
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: vhhealth-backend-migrate
        app.kubernetes.io/component: migration
        app.kubernetes.io/part-of: vhhealth
    spec:
      # Never, NOT OnFailure — this is a diagnosability requirement, not a
      # preference. With OnFailure the job controller DELETES the pod the
      # moment it exceeds the backoff limit ("SuccessfulDelete ... Deleted
      # pod" immediately after "BackoffLimitExceeded"), so by the time the
      # deploy helper collects diagnostics there is no pod left and the
      # operator gets the failure with NO migration output at all — exactly
      # the output that says WHICH migration broke and why. Observed on the
      # rig 2026-09-01. With Never each attempt is a fresh pod and failed pods
      # are retained, so their logs survive for the helper to print.
      restartPolicy: Never
      terminationGracePeriodSeconds: 30
      automountServiceAccountToken: false
      # The helper refreshes this Secret from the workflow token immediately
      # before running the Job, so the digest is always pullable here even on
      # the first deploy of a new image.
      imagePullSecrets:
        - name: ghcr-read
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: migrate
          image: ghcr.io/bahuleyandr/vh-health-platform-backend:0.0.0-placeholder
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh", "-c"]
          args:
            - |
              set -euo pipefail
              echo ">> db:ensure-pgvector (CREATE EXTENSION IF NOT EXISTS vector)"
              node scripts/ensure-pgvector-extension.mjs
              echo ">> ci-setup-db.mjs (apply raw src/migrations/*.sql, tracker-driven)"
              node scripts/ci-setup-db.mjs --skip-seeds
              echo ">> ensure runtime-role grants (owner-only bootstrap)"
              node scripts/ensure-runtime-role-grants.mjs
              echo ">> migrations complete"
          env:
            - name: NODE_ENV
              value: "production"
            - name: CI_DB_SKIP_SEEDS
              value: "1"
            - name: RUNTIME_ROLE_GRANTS_OPTIONAL
              value: "true"
          envFrom:
            - secretRef:
                name: vhhealth-backend
          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "1Gi"
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            runAsUser: 1000
            runAsGroup: 1000
            capabilities:
              drop:
                - ALL
          # No volume may mount over /app/node_modules/** — the image bakes the
          # generated Prisma client at /app/node_modules/.prisma and a mount
          # REPLACES that directory rather than overlaying it.
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: app-tmp
              mountPath: /app/tmp
      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: 128Mi
        - name: app-tmp
          emptyDir:
            sizeLimit: 128Mi
MIGRATION_JOB_MANIFEST
}

# Pin the manifest to the digest being deployed. Fails closed: an
# unsubstituted placeholder would create an unpullable Job whose failure looks
# like a migration failure.
render_migration_job() {
  local backend_ref="$1"
  local rendered
  rendered="$(migration_job_manifest \
    | sed "s|^\([[:space:]]*image: \).*0\.0\.0-placeholder\$|\1${backend_ref}|")"
  if printf '%s\n' "$rendered" | grep -q '0\.0\.0-placeholder'; then
    echo "::error::Migration Job manifest still carries the image placeholder; refusing to apply it." >&2
    return 1
  fi
  if ! printf '%s\n' "$rendered" | grep -qF "image: ${backend_ref}"; then
    echo "::error::Migration Job manifest was not pinned to ${backend_ref}; refusing to apply it." >&2
    return 1
  fi
  printf '%s\n' "$rendered"
}

job_condition() {
  local type="$1"
  kubectl -n "$NAMESPACE" get job "$MIGRATE_JOB" \
    -o "jsonpath={.status.conditions[?(@.type==\"${type}\")].status}" 2>/dev/null || true
}

migration_logs() {
  kubectl -n "$NAMESPACE" logs "job/${MIGRATE_JOB}" --tail=-1 2>/dev/null || true
}

diagnose_migration() {
  echo "::group::Dalekdefender migration Job diagnostics: ${MIGRATE_JOB}"
  kubectl -n "$NAMESPACE" describe job "$MIGRATE_JOB" || true

  # Select on the controller-set job-name label, not the app label: it is
  # guaranteed to match this Job's own pods and nothing else. restartPolicy
  # Never means every attempt is a distinct, RETAINED pod, so this loop is
  # what actually surfaces the failing migration's name and Postgres error.
  local pods
  pods="$(kubectl -n "$NAMESPACE" get pods \
    -l "batch.kubernetes.io/job-name=${MIGRATE_JOB}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  kubectl -n "$NAMESPACE" get pods \
    -l "batch.kubernetes.io/job-name=${MIGRATE_JOB}" -o wide || true
  while IFS= read -r pod; do
    [[ -z "$pod" ]] && continue
    echo "--- logs: ${pod}/migrate tail=400 ---"
    kubectl -n "$NAMESPACE" logs "$pod" -c migrate --tail=400 || true
  done <<< "$pods"

  kubectl -n "$NAMESPACE" get events --sort-by=.lastTimestamp | tail -40 || true
  echo "::endgroup::"
}

run_migrations() {
  local backend_ref="$1"
  local rendered logs summary deadline complete failed

  echo "Applying database migrations before the rollout (Job ${MIGRATE_JOB}, image ${backend_ref})."
  if ! rendered="$(render_migration_job "$backend_ref")"; then
    return 1
  fi

  # Foreground cascade: the previous run's pods carry the same job-name label,
  # so leaving them behind would let `kubectl logs job/...` read a stale run.
  kubectl -n "$NAMESPACE" delete job "$MIGRATE_JOB" \
    --ignore-not-found --cascade=foreground --wait=true --timeout=120s >/dev/null || true

  if ! printf '%s\n' "$rendered" | kubectl -n "$NAMESPACE" apply -f -; then
    echo "::error::Could not create migration Job ${MIGRATE_JOB}." >&2
    return 1
  fi

  deadline=$((SECONDS + MIGRATE_TIMEOUT))
  while (( SECONDS < deadline )); do
    complete="$(job_condition Complete)"
    failed="$(job_condition Failed)"

    if [[ "$complete" == "True" ]]; then
      logs="$(migration_logs)"
      printf '%s\n' "$logs"
      # ci-setup-db.mjs's own batch summary. "unknown" (no summary line) is
      # treated as "may have applied something" by the rollback gate below.
      summary="$(printf '%s\n' "$logs" \
        | sed -n 's/.*Migrations: \([0-9][0-9]*\) applied.*/\1/p' | tail -1)"
      MIGRATIONS_APPLIED="${summary:-unknown}"
      echo "Migration Job ${MIGRATE_JOB} complete (${MIGRATIONS_APPLIED} migration(s) applied)."
      return 0
    fi

    if [[ "$failed" == "True" ]]; then
      echo "::error::Migration Job ${MIGRATE_JOB} FAILED. No deployment image was changed and no migration was left half-applied (each file runs in its own transaction and records no tracker row unless it commits). Fix the migration and redeploy." >&2
      diagnose_migration
      return 1
    fi

    sleep "$MIGRATE_POLL_INTERVAL"
  done

  echo "::error::Migration Job ${MIGRATE_JOB} did not reach Complete or Failed within ${MIGRATE_TIMEOUT}s; refusing to roll the API workers." >&2
  diagnose_migration
  return 1
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
    SENTRY_TRACES_SAMPLE_RATE=0.1 \
    NODE_OPTIONS=--max-old-space-size=768 \
    TENANT_BASE_HOST=vhhealth.app
  kubectl -n "$NAMESPACE" set env deploy/vhhealth-admin \
    GIT_COMMIT="$commit" \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=dalekdefender \
    NEXT_PUBLIC_SENTRY_RELEASE="$commit"
}

wait_for_rollout() {
  local failed=0

  if ! kubectl -n "$NAMESPACE" rollout status deploy/vhhealth-backend --timeout="$ROLLOUT_TIMEOUT"; then
    failed=1
  fi
  if ! kubectl -n "$NAMESPACE" rollout status deploy/vhhealth-admin --timeout="$ROLLOUT_TIMEOUT"; then
    failed=1
  fi

  return "$failed"
}

verify_backend_version() {
  local expected_commit="$1"
  local payload compact deployed_commit

  # NOT the kubectl service proxy: with NODE_ENV=production the backend's
  # HTTPS-redirect middleware 301s any request that lacks
  # X-Forwarded-Proto: https (the k8s probes set that header in the manifest;
  # `kubectl get --raw` cannot), so the proxied read never returns the version
  # JSON and a HEALTHY rollout gets rolled back (observed 2026-08-21: pod
  # booted clean, verify failed, wrapper reverted). This script runs on the
  # rig, where the documented localhost bridge to the backend Service listens
  # on 127.0.0.1:30090 (tailscale-serve's :8444 source — see README) — curl it
  # directly with the header the middleware requires.
  if ! payload="$("$CURL" -fsS --max-time 20 -H 'X-Forwarded-Proto: https' "$VERIFY_URL")"; then
    echo "::error::Unable to read /health/version via the localhost backend bridge (${VERIFY_URL})." >&2
    return 1
  fi

  compact="$(printf '%s' "$payload" | tr -d '[:space:]')"
  deployed_commit="$(printf '%s' "$compact" | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p')"
  if [[ "$deployed_commit" != "$expected_commit" ]]; then
    deployed_commit="${deployed_commit:-missing-or-invalid}"
    echo "::error::Dalekdefender deployed commit ${deployed_commit} does not match requested commit ${expected_commit}." >&2
    return 1
  fi

  echo "Verified /health/version commit ${deployed_commit}."
}

PREV_BACKEND_REF="$(current_image vhhealth-backend)"
PREV_ADMIN_REF="$(current_image vhhealth-admin)"
PREV_COMMIT="$(current_commit)"
if [[ ! "$PREV_COMMIT" =~ $commit_re ]]; then
  PREV_COMMIT=""
fi

refresh_pull_secret

# Migrations FIRST, with the digest we are about to pin. The API workers
# fail closed unless the tracker is an exact match for their image's migration
# set, so rolling before this would be a guaranteed CrashLoopBackOff on any
# deploy carrying a new migration. A failure here aborts the deploy with the
# previous images still pinned and still serving.
if ! run_migrations "$BACKEND_REF"; then
  echo "::error::Dalekdefender migrations failed for commit ${GIT_COMMIT}; deployment images were left untouched." >&2
  exit 1
fi

apply_refs "$BACKEND_REF" "$ADMIN_REF" "$GIT_COMMIT"

if wait_for_rollout && verify_backend_version "$GIT_COMMIT"; then
  echo "Deploy complete: commit $GIT_COMMIT live on dalekdefender (digest-pinned)."
  exit 0
fi

echo "::error::Dalekdefender rollout failed for commit ${GIT_COMMIT}; collecting diagnostics." >&2
diagnose_backend "failed rollout ${GIT_COMMIT}"

# Rolling the IMAGE back cannot undo a migration. Once this deploy advanced the
# tracker, the previous image's migration directory no longer matches it: those
# rows are `unexpected` to it and runMigrations.js fails closed with
# MIGRATION_TIP_MISMATCH, so a "rollback" would replace a broken new pod with a
# previous pod that cannot boot either — and it would kill the one that is
# currently serving. Roll forward instead.
if [[ "$MIGRATIONS_APPLIED" != "0" ]]; then
  echo "::error::Refusing automatic rollback: this deploy applied ${MIGRATIONS_APPLIED} migration(s), so the database is now ahead of the previous image (${PREV_BACKEND_REF:-unknown}) and that image would fail startup with MIGRATION_TIP_MISMATCH. The new digest stays pinned; fix forward and redeploy." >&2
  exit 1
fi

if [[ "$PREV_BACKEND_REF" =~ $backend_re && "$PREV_ADMIN_REF" =~ $admin_re && "$PREV_COMMIT" =~ $commit_re ]]; then
  echo "Rolling back to previous backend/admin image digests."
  apply_refs "$PREV_BACKEND_REF" "$PREV_ADMIN_REF" "$PREV_COMMIT"
  if wait_for_rollout && verify_backend_version "$PREV_COMMIT"; then
    echo "::warning::Rollback succeeded: restored commit ${PREV_COMMIT} after failed deploy ${GIT_COMMIT}."
    exit 1
  fi
  echo "::error::Rollback failed after failed deploy ${GIT_COMMIT}; manual operator action required." >&2
  diagnose_backend "rollback failure ${PREV_COMMIT}"
else
  echo "::error::Previous image or commit evidence is incomplete; refusing an unverifiable automatic rollback." >&2
fi

exit 1
