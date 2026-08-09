# Provider-neutral CI

CI behavior lives in this directory so Forgejo, GitHub, and local development all
run the same checks.

Use the orchestrator:

```powershell
node scripts/ci/run.mjs
node scripts/ci/run.mjs --only=security,backend
node scripts/ci/run.mjs --skip=flutter
node scripts/ci/run.mjs --install
node scripts/ci/run.mjs --install --include-smoke
node scripts/ci/run.mjs --install --changed-on-branch-push
```

Stages:

- `security`: whitespace check, service-account secret scan, gitleaks worktree
  and commit-range scans.
- `contracts`: cross-stack contract checks that belong to no single app. Today
  that is `check-client-paths.mjs`, which asserts every API path the clients
  call resolves to an operation the backend actually serves. Dependency-free and
  a couple of seconds, so it runs before the multi-minute stages.
- `backend`: backend audit/lint/OpenAPI/DB guardrails/Jest via `npm run ci`.
- `fhir`: FHIR R4 sample validation, with golden samples treated as strict.
- `admin`: admin audit/lint/type-check/test/build/Clinical AI bundle check.
- `flutter`: workspace `dart pub get`, Melos bootstrap, format, analyze, test.
- `infra`: Kubernetes manifest validation + Kyverno Enforce readiness contract
  + prod image-digest pin guard (`scripts/check-kyverno-enforce-readiness.mjs`,
  `scripts/check-prod-digests-pinned.mjs`, fails on `main` if any
  `infra/kubernetes/apps/kustomization.yaml` digest is the all-zeros
  placeholder; no-op off-main).
- `smoke`: local QA orchestrator with role and desktop smoke coverage.

## Client API path contract

`check-client-paths.mjs` closes the direction the OpenAPI pipeline never
covered. `generate-openapi.mjs` boots the live app, so the spec is a faithful
census of what the server serves — but nothing asserted that clients only call
paths in it. The 2026-08-09 audit found nine admin-portal calls to operations
present in neither the spec nor Express; they 404 in production, and one was
pinned by a jest test asserting the same wrong path.

```powershell
node scripts/ci/check-client-paths.mjs            # gate
node scripts/ci/check-client-paths.mjs --verbose  # + per-source breakdown
node scripts/ci/check-client-paths.mjs --json     # machine-readable
node --test scripts/ci/check-client-paths.test.mjs
```

It extracts literal paths from `apps/admin/src`, `apps/{patient,staff}/lib`,
`packages/vhhealth_core/lib`, and `apps/device-gateway/src`, resolves them the
way each runtime does, and set-differences them against
`apps/backend/src/docs/openapi.json`.

Three things about it are load-bearing:

- **It is method-aware.** Three of the audit's nine call a path that exists in
  the spec but only for a different verb. Express 404s an unserved method
  exactly as it 404s an unknown path, so a path-only gate waves them through —
  as the pre-existing `api-config-spec-subset.test.ts` does.
- **Each client stack resolves paths differently.** Admin sends a path that
  `toApiV1Endpoint` rewrites and then prefixes (`/admin/users` is served as
  `/api/v1/users`); the mirror of that rewrite table is pinned against
  `apps/admin/src/lib/api/core.ts` by a test, so the two cannot drift silently.
  Dart sends a bare suffix, because `ApiConfig.baseUrl` already ends in
  `/api/v1`.
- **Dart extraction is anchored on the call site, never on literal shape.**
  GoRouter route names are syntactically identical to API suffixes, so a
  shape-based scan would report navigation as broken API calls.

Non-API strings are excluded by rule, not by allowlist: Next.js local routes
live under `/api/<not v1>`, plus `/ws`, `/api-docs`, static assets, page routes,
and policy globs. Declaration-only router mount bases pass by rule, but an
actual call with a known method must resolve to an operation. Rewrite-backed
runtime aliases are mapped to their canonical spec operations so their exact
path and method are still checked. `client-path-allowlist.json` is reserved for
exact, method-scoped operations the backend genuinely serves but the spec omits
(currently the flag-gated dev-auth route), and every entry must name the mount
that serves it.

Provider wrappers:

- `.forgejo/workflows/ci.yml`
- `.forgejo/workflows/full-stack-sweep.yml`
- `.forgejo/workflows/secret-scan.yml`
- `.forgejo/workflows/dependency-review.yml`
- `.forgejo/workflows/smoke-e2e.yml`
- `.forgejo/workflows/ci-warehouse.yml`
- `.github/workflows/ci.yml`

Those wrappers should stay thin: prepare the runner, then call this orchestrator
or the same first-party scripts used locally. GitHub remains an optional mirror;
Forgejo is the canonical CI/CD target.

Forgejo specialty gates:

- `secret-scan.yml`: standalone service-account scan, gitleaks, and optional
  GitGuardian parity for the GitHub secret-scan workflow.
- `dependency-review.yml`: provider-neutral blocking npm audit for high+
  advisories on dependency PRs; OSV/Semgrep/Trivy reporting stays in
  `security-sweep.yml`.
- `smoke-e2e.yml`: local backend/admin/API smoke coverage matching the GitHub
  Smoke E2E workflow.
- `ci-warehouse.yml`: migration-built analytics warehouse dbt build and
  optional-module kustomize render.

Forgejo CD surfaces:

- `deploy-patient-staging.yml` / `deploy-staff-staging.yml`: build debug APKs,
  upload Forgejo artifacts, and distribute through Firebase CLI when Firebase
  secrets are configured.
- `release-patient.yml` / `release-staff.yml`: build signed APK/AAB artifacts
  for `patient-v*` and `staff-v*` tags, then publish them to Forgejo releases.
- `release-images.yml`: build, push, SBOM, Trivy-scan, cosign-sign, verify,
  and GitOps-pin backend/admin/staff-web release images for `backend-v*`,
  `admin-v*`, and `staff-web-v*` tags.
- `release-pin-digests.yml`: manual verified digest-pin repair path for
  operators.
- `deploy-dalekdefender.yml`: build, scan, sign, verify, and deploy backend/admin
  images to the Dalekdefender test rig by digest.

Forgejo CD prerequisite checks live in
`scripts/ci/forgejo-deploy-preflight.mjs` so local operators and workflows use
the same secret contract. The deploy path is intentionally strict: image
release and Dalekdefender deploy require registry auth plus
`COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`, and `COSIGN_PUBLIC_KEY`; the remote
pin step additionally requires `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, and
`DALEKDEFENDER_SSH_KEY`. Post-deploy smoke can still be configured as a
soft-skip gate with `--allow-skip`, but a first-class Forgejo deployment should
set `VH_TRIAL_API_ORIGIN` and `VH_TRIAL_ADMIN_ORIGIN`.

Branch-push optimization:

- Pull requests, `main`, and manual dispatches run the full default stage set.
- Non-main branch pushes may pass `--changed-on-branch-push`; the orchestrator
  then maps changed files to the smallest safe stage set.
- `security` always runs in changed-file mode.
- CI/workflow changes, unknown risky paths, or an empty diff fall back to the
  full default gate.

Forgejo cache optimization:

- If `VH_CI_CACHE_DIR` is set, the orchestrator uses it for npm, pub, gitleaks,
  FHIR validator, and Kubernetes validator caches.
- The Forgejo runner should mount that directory into job containers as
  `/cache/vh-health-platform` so routine branch runs avoid repeated downloads.
- The Forgejo `ubuntu-latest` runner image is expected to preinstall Java 17
  from `infra/forgejo/ci-image/Dockerfile`; `scripts/ci/fhir.mjs` keeps a Linux
  install fallback for runner rebuilds or fresh hosts.
- FHIR validation runs with local terminology mode (`-tx n/a`) so branch CI does
  not block on `tx.fhir.org` latency or outages.
