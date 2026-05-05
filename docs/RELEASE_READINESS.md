# Release Readiness

This checklist is the release gate for patient and staff app tags. It is meant
to answer one question before a tag is pushed: can we prove the app builds,
talks to the backend, and has the required operational guardrails?

## Required GitHub Configuration

- `VH_BASE_URL` as a GitHub Actions variable.
- `VH_API_KEY` as a GitHub Actions secret.
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

Run the `Smoke E2E` GitHub workflow on the target commit. For local live staff
desktop verification on Windows, run:

```powershell
$env:VH_BASE_URL='https://<host>/api/v1'
$env:VH_API_KEY='<release-smoke-api-key>'
.\scripts\smoke-staff-desktop.ps1
```

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
