# VH Health Platform Remediation Plan

Created: 2026-04-29

This tracker is the canonical platform-level remediation list. It focuses on release trust first: deploy health, CI, secret scanning, mobile release, formatting, and runtime safety before larger refactors or product polish.

## Current Baseline

- Local branch: `main`
- Remote tracking: `origin/main`
- Baseline commit: `32252dab9a2cea47188eea38fa8a6199509cb611`
- Strategy: finish P0 before new feature work; use P1-P3 as the backlog once release trust is restored.

## P0 - Must Fix Before Trusting Release

- [x] Add backend `/health/live` and `/health/ready`, while keeping `/health/ping` and `/health/deep`.
- [x] Update backend Docker healthcheck and Kubernetes probe comments/config to use the live/ready endpoints.
- [x] Fix backend CI DB setup to read `apps/backend/src/migrations`.
- [x] Make secret scanning clean for tracked files and keep allowlists narrow.
- [x] Add a read-only Dart format checker that avoids generated/build output.
- [x] Update mobile release workflows to require signing, base URL, and API key configuration.
- [x] Update patient Android NDK and remove stale lint baseline usage.
- [x] Cap backend cluster workers in Kubernetes and harden worker parsing in `src/cluster.js`.

## P1 - Quality Gates

- [x] Reduce backend ESLint warnings to zero by category and then fail CI on warnings.
- [x] Replace admin `next lint` usage with direct ESLint.
- [x] Fix Dart analyzer infos, especially async `BuildContext` usage.
- [x] Upgrade dependencies responsible for moderate audit findings and apply safe Flutter plugin upgrades.
- [x] Ensure CI runs backend/admin/mobile builds, gitleaks, format, tests, and manifest validation.

## P2 - Architecture Debt

- [x] Split the Clinical AI admin component into module panels with lazy loading. The legacy barrel now re-exports compatibility symbols, while the dashboard loads 33 module panels from `coreModulePanels/`.
- [x] Split the backend Clinical AI router into bounded route modules with shared validators. The mount file now delegates to overview, governance, document, core clinical, care operations, revenue cycle, diagnostics/medication, facility/risk, platform workbench, knowledge/governance, and trial/safety/operations route families.
- [x] Break `apps/admin/src/lib/api/emr.ts` into domain clients or generated OpenAPI clients. Clinical AI module calls now live in `clinicalAiModules.ts`; `emr.ts` remains as a small compatibility export for existing imports.
- [x] Reduce `prisma.$queryRawUnsafe` / `$executeRawUnsafe` usage behind typed query helpers. The touched Clinical AI admin paths use the shared raw SQL helper; broad legacy backend raw-SQL retirement remains a future module-by-module cleanup.
- [x] Clean contradictory route-health startup logs.
- [x] Gate dev-only auth routes behind explicit `ENABLE_DEV_AUTH=true`.

## P3 - Product And Docs Polish

- [ ] Update root README, admin README, deployment guide, release docs, and stale workflow comments.
- [ ] Add patient/staff/admin smoke E2E journeys for login, dashboard, booking, uploads, and Clinical AI review.
- [ ] Triage patient audit backlog: SOS nearby-services 400, profile setup recheck, investigation booking walkthrough, pull-to-refresh, medication reminder surface, and empty states.
- [ ] Add bundle/performance work for heavy admin routes, especially Clinical AI.
- [ ] Plan and execute breaking Flutter plugin migrations still blocked by major-version constraints: connectivity_plus 7, device_info_plus 13, file_picker 11, flutter_local_notifications 21, flutter_secure_storage 10, go_router 17, local_auth 3, mobile_scanner 7, pin_code_fields 9, share_plus 13, timezone 0.11, and vector_math 2.3 override cleanup.

## Owner Actions Outside Code

- [x] Configure GitHub Actions variable `VH_BASE_URL`.
- [x] Configure GitHub Actions secret `VH_API_KEY`.
- [x] Configure patient/staff Android signing secrets.
- [ ] Rotate any real secrets that appeared in local ignored `.env` or log files.
- [ ] Purge or regenerate local ignored logs and env files after secret rotation.

## Validation Checklist

- [x] Backend: `npm run lint`
- [x] Backend: `npm run swagger:validate`
- [x] Backend: `npm test`
- [x] Backend CI DB setup against disposable Postgres
- [x] Admin: `npm run lint`
- [x] Admin: `npm run type-check`
- [x] Admin: `npm test`
- [x] Admin: `npm run build`
- [x] Mobile: `dart pub get`
- [x] Mobile: `dart run melos bootstrap`
- [x] Mobile: `dart run melos run analyze`
- [x] Mobile: `dart run melos run test`
- [x] Mobile: `dart run melos run format`
- [x] Release: patient/staff release APK and AAB with real dart-defines and signing env
- [x] Security: tracked-file gitleaks check is clean
- [x] Security: `node scripts/gitleaks-scan.mjs range`
- [x] Infra: Kubernetes manifest render/offline validation
- [x] Smoke: `/health/live`, `/health/ready`, `/health/ping`, `/health/deep`

## Validation Notes - 2026-04-29

- Backend lint now passes with zero warnings and `--max-warnings=0`.
- Backend full test suite passes: 111 suites, 1561 passed, 8 skipped, 1569 total.
- Admin direct ESLint, type-check, Jest, and Next production build pass.
- Flutter format, analyze, and tests pass across patient, staff, and core.
- Disposable Postgres CI setup passes after `prisma db push --force-reset --skip-generate` plus `node scripts/ci-setup-db.mjs`; validation also confirms `appointment_status_history` from migration `106` exists.
- Kubernetes migration-job command path passes against disposable Postgres after `prisma db push --skip-generate --accept-data-loss=false` plus `node scripts/ci-setup-db.mjs`.
- Patient and staff debug APKs build.
- Patient signed release APK/AAB builds with real `VH_BASE_URL`, `VH_API_KEY`, and Android signing env.
- Staff signed release APK/AAB builds with real `VH_BASE_URL`, `VH_API_KEY`, and Android signing env.
- GitHub Actions now has `VH_BASE_URL`, `VH_API_KEY`, and patient/staff Android signing secrets configured.
- Tracked and new non-ignored files have zero gitleaks findings. Local ignored `.env` files still contain secret-shaped values and need owner rotation/purge.
- Kubernetes backend/admin base manifests and dev/staging/prod overlays render with `kustomize` and pass offline `kubeconform` validation. `kubectl apply --dry-run=client` still tries live API discovery without a cluster, so offline schema validation is the local acceptance gate.
- Backend and admin `npm audit --audit-level=moderate` pass with zero vulnerabilities after dependency overrides. Backend keeps `uuid@14` for audit cleanliness and uses a Jest-only UUID shim because Jest cannot load the transitive ESM-only UUID package through CommonJS ExcelJS internals.
- Safe Flutter dependency upgrades were applied and validated. Remaining stale Flutter packages are major-version migrations and are tracked as a separate P3 compatibility item rather than forced blindly.
- Backend tests should be run against the disposable local test database, for example by setting `DATABASE_URL=postgresql://postgres@127.0.0.1:55432/vhhealth_test` and `TEST_DATABASE_URL` to the same value. The local `.env.local` database URL points at the developer database on port `5433` and timed out during this validation pass.
- P2 architecture cleanup is complete for the planned remediation scope: Clinical AI admin panels are split into lazy module files, the Clinical AI backend route surface is decomposed into route-family modules, `emr.ts` no longer owns the Clinical AI API surface, touched Clinical AI raw SQL flows go through the shared helper, route-health logs are coherent, and dev-only auth fails closed unless explicitly enabled.
- P2 validation pass: backend route syntax checks passed for all Clinical AI route modules; backend lint passed; targeted Clinical AI Jest passed against the disposable local database; admin lint, type-check, and production build passed. `ensure-test-db.mjs` now resets the disposable test schema and reuses the tolerant CI hybrid migration setup so local targeted backend test runs do not fail on older migration seed conflicts.
