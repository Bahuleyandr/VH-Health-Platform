# VH Health Platform Remediation Plan

Created: 2026-04-29

This tracker is the canonical platform-level remediation list. It focuses on release trust first: deploy health, CI, secret scanning, mobile release, formatting, and runtime safety before larger refactors or product polish.

> **Status note (2026-06-17):** The P0–P3 code remediation is complete. The
> residual unchecked items here are operator/runtime tasks (e.g. Phase-0 runtime
> verification, H3 make `tenant_id` explicit, secret rotation, DR drill). These
> are now owned by the active successor docs —
> [`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md) and
> [`S_TIER_ROADMAP.md`](S_TIER_ROADMAP.md). This tracker is kept as the
> historical record; track live status there.

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
- [x] Add `node scripts/local-ci.mjs` as the canonical local fallback when GitHub-hosted Actions minutes are unavailable.

## P2 - Architecture Debt

- [x] Split the Clinical AI admin component into module panels with lazy loading. The legacy barrel now re-exports compatibility symbols, while the dashboard loads 33 module panels from `coreModulePanels/`.
- [x] Split the backend Clinical AI router into bounded route modules with shared validators. The mount file now delegates to overview, governance, document, core clinical, care operations, revenue cycle, diagnostics/medication, facility/risk, platform workbench, knowledge/governance, and trial/safety/operations route families.
- [x] Break `apps/admin/src/lib/api/emr.ts` into domain clients or generated OpenAPI clients. Clinical AI module calls now live in `clinicalAiModules.ts`; `emr.ts` remains as a small compatibility export for existing imports.
- [x] Reduce `prisma.$queryRawUnsafe` / `$executeRawUnsafe` usage behind typed query helpers. The touched Clinical AI admin paths use the shared raw SQL helper; broad legacy backend raw-SQL retirement remains a future module-by-module cleanup.
- [x] Clean contradictory route-health startup logs.
- [x] Gate dev-only auth routes behind explicit `ENABLE_DEV_AUTH=true`.

## P3 - Product And Docs Polish

- [x] Update root README, admin README, deployment guide, release docs, and stale workflow comments.
- [x] Add patient/staff/admin smoke E2E journeys for login, dashboard, booking, uploads, and Clinical AI review.
- [x] Promote admin/patient/staff smoke coverage into a repeatable `Smoke E2E` GitHub workflow and add a local staff desktop smoke wrapper.
- [x] Triage patient audit backlog: SOS nearby-services 400, profile setup recheck, investigation booking walkthrough, pull-to-refresh, medication reminder surface, and empty states.
- [x] Add bundle/performance work for heavy admin routes, especially Clinical AI.
- [x] Plan and execute resolvable breaking Flutter plugin migrations; document remaining resolver-blocked majors for device_info_plus 13, share_plus 13, vector_math 2.3, and platform override cleanup.
- [x] Add release-readiness and translation human-review trackers for the next production cut.

## Owner Actions Outside Code

- [x] Configure Forgejo Actions variable `VH_BASE_URL`.
- [x] Configure Forgejo Actions secret `VH_API_KEY`.
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
- [x] Admin: `npm run check:clinical-ai-bundle`
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
- Backend full test suite passes: 112 suites, 1564 passed, 8 skipped, 1572 total.
- Admin direct ESLint, type-check, Jest, Next production build, and Clinical AI bundle guard pass.
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
- P3 product/docs pass updated the root/admin README, deployment guide, April release notes, smoke journey documentation, Flutter plugin migration notes, and stale admin Playwright CI comments.
- P3 smoke coverage now includes patient SOS `lat/lng` compatibility, staff stats/investigation queue/SLA routes, admin Clinical AI status/modules/reviews/audit routes, and browser-level admin uploads/Clinical AI journeys.
- P3 patient backlog triage found the concrete SOS nearby-services alias bug and fixed it. Profile setup, investigation booking, dashboard refresh, and medication reminders already had working surfaces; remaining empty-state refinement is product polish, not a release blocker.
- P3 Clinical AI performance guard adds `npm run check:clinical-ai-bundle` and wires it into admin CI after `next build`.
- P3 Flutter plugin pass upgraded all resolver-accepted major packages and migrated affected APIs. `device_info_plus` 13, `share_plus` 13, `vector_math` 2.3, and secure-storage platform override cleanup remain documented follow-up constraints rather than forced dependency overrides.

## Security Remediation — 2026-06-10 audit (executed 2026-06-10/11)

Source: `docs/PLATFORM_SECURITY_AUDIT_2026-06-10.md` +
`docs/REMEDIATION_WORK_ORDER_2026-06-10.md`. Operator/runtime items live in
`docs/PHASE0_OPERATOR_ACTIONS_2026-06-10.md` — items marked *(operator)* are
"code/manifest ready, awaiting operator verification", NOT closed.

### Phase 0 — emergency

- [x] **H1** Patient dashboard behind jwtAuth + `requireRole('PATIENT')`; phone derived from the token (caller `?phone=` only accepted if own); all queries tenant-scoped. Regression tests `src/tests/dashboard-h1-authz.test.js`.
- [x] **H2** Appointment router RBAC: mount-level `requireRole(...APPOINTMENT_ROUTE_ROLES)`; dead `wrapAutoRBAC` deleted; missing `appointmentAdminRoutes` rbacConfig key added; staff gates on `/pending` + `/completed/recent`; ADMIN gates on `/admin/*`. Tests `appointment-h2-rbac.test.js`.
- [x] **H4** SSRF guard (`src/utils/ssrfGuard.js`) on HL7 outbound feeds — loopback/RFC-1918/link-local/metadata/ULA blocked, fail-closed DNS, re-checked before EVERY delivery, optional `HL7_FEED_HOST_ALLOWLIST`. Tests `hl7-ssrf-guard.test.js`. createSubscription confirmed restricted to integration admins (no severity escalation).
- [x] **H10** CNPG manifest: `vhhealth_readonly` created NOLOGIN at initdb; CNPG `managed.roles` + `passwordSecret` (SealedSecret example added). *(operator: rotate on running clusters)*
- [x] **H12** dalekdefender deploy: runner-side build → blocking Trivy → keyless cosign sign → **verify** → digest-pinned `kubectl set image` only; no on-host git/build/secret patching. *(operator: GHCR pull creds, sudoers narrowing, Tailscale ACL, PHI policy check)*
- [ ] Phase-0 runtime verification *(operator — NODE_ENV / AUTH_ENFORCE_TENANT_RLS / CNPG role posture / prisma boot guard)*

### Phase 1 — high

- [x] **H6/M8** Admin portal default-deny route policy (`src/lib/routePolicy.ts`) + CI coverage test (`route-policy-coverage.test.ts`) that fails when a dashboard page lacks a policy entry. Backend role gates on `/api/v1/admin/*`, `/users`, `/records` verified.
- [x] **H7/H8/L8** Mobile pinning fixed (SPKI base64, verified against the openssl pipeline byte-for-byte) and WIRED (pinned `IOClient` default in `VHHttpClient`, host-restricted, no platform roots); `verifyOrWarn()` at startup in both apps; `<certificates src="user"/>` removed from both netsec configs; placeholder domain replaced.
- [x] **H9/M10** Staff manifest: `allowBackup=false`, `fullBackupContent=false`, exclude-all `dataExtractionRules`, `usesCleartextTraffic=false`; recent-patients cache moved to secure storage with plaintext purge-on-upgrade.
- [x] **H5** `utils/logMasking.js` maskers applied at ~37 logger call sites + Winston-level PHI redaction format on every transport; regression test includes a grep-sweep gate (`log-redaction.test.js`).
- [x] **H11** Digest pinning: `images:` block in `infra/kubernetes/apps/kustomization.yaml` (the tree ArgoCD actually syncs — NOT overlays/prod, which doesn't contain the app deployments) with fail-closed all-zero placeholders + `scripts/update-prod-digests.mjs` + Forgejo `release-images.yml`/`release-pin-digests.yml` GitOps write-back. *(operator: bootstrap real digests before next sync)*

### Phase 2 — medium

- [x] **M1** `{ algorithms: ['HS256'] }` on all backend `jwt.verify` callers + admin `jose` verify.
- [x] **M2** Token revocation fails closed (`RevocationCheckUnavailableError` → 503) when no store can answer; clean Redis miss stays authoritative. Tests `unit/tokenBlacklistFailClosed.test.js`.
- [x] **M3** Access-guard skip restricted to verified SQLSTATE 42P01 + non-production (`services/security/schemaMissingGuard.js`); message-regex matching removed from the two security decision services; skips alert at error level. Tests `unit/schemaMissingGuard.test.js`.
- [x] **M4** `requireConsent`: tenant-scoped query + PATIENT-self ownership check.
- [x] **M5** Staff PIN login device-bound (`staff_devices` token required) + per-device/IP lockout + account-wide distributed backstop; staff app sends stored device token.
- [x] **M6** Payslips: random per-document password (12 chars, unambiguous alphabet) delivered via in-app notification; DOB-derived password + hardcoded owner fallback removed.
- [x] **M7** `sanitize-html`-based sanitizer + `deepSanitizeStrings` middleware on 15 clinical free-text mounts.
- [x] **M9** Admin CSP: per-request nonce + `strict-dynamic` from middleware; `'unsafe-inline'` dropped. **Stage 2 open:** remove `'unsafe-eval'` once Sentry/workbox eval usage is eliminated. *(operator: smoke-test portal post-deploy)*
- [x] **M11** Patient biometric gate fails closed.
- [x] **M12** Unwired `MessageCrypto` deleted (false E2E assurance). Product owner may revive from git history with a real key-distribution design.
- [x] **M13** `barmanObjectStore.encryption: AES256`; DR docs reconciled (no `pgbackrest-cipher` ever existed). *(operator: verify first backup vs R2)*
- [x] **M14** vh-mcp-postgres: NodePort→ClusterIP + deny-all NetworkPolicy; ≥32-char token enforced at boot; timing-safe compare. *(operator: repoint funnel, rotate token)*
- [x] **M15** Forgejo pipelines: Trivy image scans and filesystem vulnerability/secret scans now block (`--exit-code 1`); filesystem misconfiguration findings and OSV stay advisory while the existing backlog is triaged. Scanner images are digest-pinned where images are used; installer refs are version-pinned for direct binary installs. Forgejo now owns CI plus staging deploys, signed Android releases, container image releases, digest pinning, Dalekdefender deploy, standalone secret scan, dependency-risk, smoke E2E, full-stack sweep, and warehouse/dbt gates.
- [x] **M16** Kyverno `verifyImages` ClusterPolicy keyed to release-workflow OIDC identity (`base/image-policy/`); ArgoCD `signatureKeys` documented as GPG-commit-only. *(operator: install Kyverno, enable, flip to Enforce)*
- [x] **M17** dalekdefender: PSS labels (enforce baseline, warn/audit restricted) + restricted securityContexts on backend/admin + `vhhealth_runtime` non-superuser connection role SQL. *(operator: run SQL, repoint DATABASE_URL)*
- [x] **M18** Orthanc: credentials via `orthanc-users` SealedSecret (env override), non-root securityContext, default-deny NetworkPolicy with modality-VLAN placeholder. *(operator: real CIDR + seal secret before enabling)*

### Phase 3 — hardening (started; remainder is backlog)

- [x] **CI coverage test (backend)** `src/tests/route-role-coverage.test.js` — fails when any post-jwtAuth `/api/v1/*` mount lacks `requireRole` and isn't consciously exempted (exemptions documented inline). The admin twin landed in Phase 1.
- [x] **L1** Access-token TTL defaults: patient 7d→1h, staff 8h→1h (env-overridable). *(operator: expect one-time re-login wave)*
- [x] **L3** Storage signed-URL secret separated: `STORAGE_TOKEN_SECRET` env or HMAC-derived sub-key of JWT_SECRET (domain-separated).
- [x] **L11** MinIO metrics auth `public`→`jwt`; `vhhealth-records` objectLock:true for new installs. *(operator: scrape token + bucket migration on existing cluster)*
- [x] Dependency-review gate (`.github/workflows/dependency-review.yml`, blocking on high severity).
- [ ] **H3** Make `tenant_id` explicit in application queries (RLS as defense-in-depth, not sole control) + query-scoping lint. Large module-by-module migration — dashboard + consent paths done in this pass.
- [ ] **M9 stage 2** Drop `'unsafe-eval'` from admin CSP (Sentry/workbox eval audit).
- [ ] Mount-level `requireRole` for `/api/v1/quality` and `/api/v1/referrals` (currently controller-level checks; exempted with note in route-role-coverage test).
- [ ] Semgrep → blocking after initial backlog triage; Firebase App Check + GCP API key restriction; cloudflared→ingress TLS (L10); WS ticket out of URL query (L6); CNI NetworkPolicy enforcement check; DR restore drill + R2 object-lock execution.
- [ ] Pre-existing functional bugs found while testing H2 (admin appointment endpoints 500 for every caller): BigInt serialization in `getStatusAuditTrail` + `getAllDocumentsAdmin`; `/admin/analytics` queries dropped column `consultation_duration_minutes`.
- [ ] Pre-existing test failure (NOT introduced by this remediation — verified identical on a clean stash): `infection-control.deep.test.js` › "antibiogram aggregates susceptibility" — `organisms['D5TEST E. coli']` undefined. Needs an owner look at the antibiogram aggregation or the micro_isolates seed.

### Validation — 2026-06-11

- Backend: full lint gate green (eslint --max-warnings=0, raw-params, phi-tenant-id, clinical-ai regions, secrets scan). FULL sharded test suite (58 chunks via `npm run test:ci` against the disposable :55432 DB) green except the ONE pre-existing `infection-control.deep` antibiogram failure listed above (verified identical on a clean stash). Two suites needed updating for intentional behavior changes: `hl7-outbound.deep` (delivers to 127.0.0.1 — now uses the non-production-only `HL7_FEED_ALLOW_PRIVATE_TARGETS` escape hatch, itself covered by a prod-refusal test) and `unit/r2Storage` (token helper updated for the L3 domain-separated secret).
- Admin: eslint green, `tsc --noEmit` green, full Jest 392/392 green (middleware suite rewritten for default-deny + nonce-CSP), `next build` green.
- Flutter: `melos run analyze` green; FULL `melos run test` green (patient + staff + core).
- Infra: `kubectl kustomize` renders prod / apps / dalekdefender overlays; all changed YAML parses; new workflows YAML-validated.
- NOTE on full `npm test` (single process): OOMs on this workstation at default heap regardless of these changes — use `npm run test:ci` (chunked) locally, as CI does.
