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
