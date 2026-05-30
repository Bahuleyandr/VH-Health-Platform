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
```

Stages:

- `security`: whitespace check, service-account secret scan, gitleaks worktree
  and commit-range scans.
- `backend`: backend audit/lint/OpenAPI/DB guardrails/Jest via `npm run ci`.
- `fhir`: FHIR R4 sample validation, with golden samples treated as strict.
- `admin`: admin audit/lint/type-check/test/build/Clinical AI bundle check.
- `flutter`: workspace `dart pub get`, Melos bootstrap, format, analyze, test.
- `infra`: Kubernetes manifest validation.
- `smoke`: local QA orchestrator with role and desktop smoke coverage.

Provider wrappers:

- `.forgejo/workflows/ci.yml`
- `.github/workflows/ci.yml`

Those wrappers should stay thin: prepare the runner, then call this orchestrator.
GitHub remains an optional mirror; Forgejo is the canonical CI target.
