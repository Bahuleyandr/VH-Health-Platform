# Release Readiness

This checklist is the release gate for patient and staff app tags. It is meant
to answer one question before a tag is pushed: can we prove the app builds,
talks to the backend, and has the required operational guardrails?

## Required Forgejo Configuration

- `VH_BASE_URL` as a Forgejo Actions variable.
- `VH_API_KEY` as a Forgejo Actions secret.
- `PATIENT_ANDROID_KEYSTORE_BASE64`
- `PATIENT_ANDROID_KEY_ALIAS`
- `PATIENT_ANDROID_KEY_PASSWORD`
- `PATIENT_ANDROID_STORE_PASSWORD`
- `STAFF_ANDROID_KEYSTORE_BASE64`
- `STAFF_ANDROID_KEY_ALIAS`
- `STAFF_ANDROID_KEY_PASSWORD`
- `STAFF_ANDROID_STORE_PASSWORD`

The release workflows validate these before building and fail before artifact
creation if any required value is missing.

Container and deploy workflows additionally require Forgejo secrets for GHCR
pushes (`GHCR_USERNAME`/`GHCR_TOKEN` or
`CONTAINER_REGISTRY_USERNAME`/`CONTAINER_REGISTRY_PASSWORD`), cosign signing
(`COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`, `COSIGN_PUBLIC_KEY`), and the
Dalekdefender path (`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`,
`DALEKDEFENDER_SSH_KEY`).

## Local CI Gate

GitHub-hosted minutes are optional for this repo. The canonical pre-merge and
pre-tag gate is the local runner:

```bash
node scripts/local-ci.mjs
```

Useful scoped runs:

```bash
node scripts/local-ci.mjs --only=security,backend
node scripts/local-ci.mjs --only=admin
node scripts/local-ci.mjs --only=flutter
node scripts/local-ci.mjs --only=infra
```

This runs the same trust checks that matter for release: secret scans, backend
Docker-backed DB/tests, admin lint/type-check/test/build/bundle guard, Flutter
format/analyze/test, and Kubernetes manifest validation.

The backend stage requires Docker to be running because it creates a disposable
`pgvector` Postgres database instead of trusting a developer database.

## Manual Pre-Tag Gate

Run these from a clean `main` checkout before creating `patient-v*` or
`staff-v*` tags:

```bash
node scripts/gitleaks-scan.mjs worktree
dart pub get
dart run melos bootstrap
dart run melos run format
dart run melos run analyze
dart run melos run test
```

```bash
cd apps/backend
npm run lint
npm run swagger:validate
npm test
```

```bash
cd apps/admin
npm run lint
npm run type-check
npm test
npm run build
npm run check:clinical-ai-bundle
```

Run the Forgejo `Smoke E2E` workflow on the target commit; the GitHub workflow
is the mirror. For local live staff desktop verification on Windows, run:

```powershell
$env:VH_BASE_URL='https://<host>/api/v1'
$env:VH_API_KEY='<release-smoke-api-key>'
.\scripts\smoke-staff-desktop.ps1
```

For role-by-role API workflow verification against the deployed backend, run:

```powershell
$env:VH_BASE_URL='https://<host>/api/v1'
$env:VH_API_KEY='<release-smoke-api-key>'
$env:VH_STAFF_TEST_PASSWORD='<seeded staff password>'
.\scripts\smoke-staff-role-workflows.ps1 -IncludeCreates
```

Attach `docs/STAFF_ROLE_WORKFLOW_SWEEP.md`, backup evidence, and one restore
drill record before approving a real production tag.

For Indian hospital production tags, also attach the completed
[`india-deployment-readiness.md`](india-deployment-readiness.md) evidence packet.
The release is not PHI-ready until the ABDM/DPDP/CERT-In, clinical UAT,
backup/DR, privacy policy, and medical-device boundary gates in that runbook are
green or formally risk-accepted.

Production database readiness is tracked in `docs/PRODUCTION_DB_HARDENING.md`.
The DB is not considered production-safe until a restore drill and alert checks
have been completed for the target environment.

## Tagging

Use separate monorepo tags so the workflows do not collide:

```bash
git tag staff-v1.2.0
git push origin staff-v1.2.0

git tag patient-v1.2.0
git push origin patient-v1.2.0
```

Do not tag if the app is only structurally translated but has not had clinical,
security, and financial wording reviewed for the release locale.
