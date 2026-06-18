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
- [x] **M9** Admin CSP: per-request nonce + `strict-dynamic` from middleware; `'unsafe-inline'` dropped. **Made effective 2026-06-17 (#19):** the nonce CSP was previously inert in prod — (a) admin pages were statically prerendered, so Next never stamped the per-request nonce onto their scripts, and (b) `infra/kubernetes/apps/admin/ingress.yaml` set a `more_set_headers "Content-Security-Policy: …'unsafe-inline'…"` that *replaced* the pod's nonce header at the edge. Fixed by `export const dynamic = 'force-dynamic'` in `apps/admin/src/app/layout.tsx` (every route renders per-request → all inline + chunk scripts carry the nonce; verified against a prod `next build`/`next start`: `script-src 'self' 'nonce-…' 'strict-dynamic' 'unsafe-eval'`, 21/21 scripts nonced, login renders) + removing the ingress CSP override (other ingress security headers retained). **Stage 2 open:** remove `'unsafe-eval'` once Sentry/workbox eval usage is eliminated. *(operator: the `force-dynamic` admin image and the ingress CSP removal must deploy TOGETHER — both are in commit `dc0446f8`. Never apply the ingress change to a cluster still running a pre-`force-dynamic` admin image: static pods emit the strict nonce CSP but their scripts carry no nonce, so all scripts get blocked. Expect a brief rolling-update window where draining old pods serve un-nonced scripts; it clears when the rollout completes. Smoke-test the portal post-deploy.)*
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

## External re-audit pass — 2026-06-18

An independent 6-agent re-audit raised 12 findings. Each was verified against
`main` BEFORE any fix (live single-tenant-exploitable vs latent multi-tenant vs
stale/false). Eight confirmed-live items were fixed, verified, and merged to
both remotes; the rest were deferred or refuted with evidence.

### Fixed (live)

- [x] **#6 — admin login/MFA cookie-only regression.** A prior token-leak fix
  made `/api/login`(+mfa) strip `token`/`accessToken`/`refreshToken` from the
  body (cookie-only), but `apps/admin/src/lib/api-client.ts` still threw "No
  token received", breaking admin+staff login and both MFA flows. Client now
  treats `200 + admin/staff profile` as success; the masking unit test was
  rewritten (red→green). Merge `9e349dd3`.
- [x] **#3c — clinical note ↔ appointment patient mismatch.** `createNote`
  bound a note to an appointment via `appointment_id` without checking the
  note's `patient_uid` matched the appointment's patient (cross-patient
  chart/timeline write by an authorized clinician). Added the consistency guard
  (`NOTE_APPOINTMENT_PATIENT_MISMATCH`) + real-PG deep test. Merge `1bab07e1`.
- [x] **#7a — unguarded patient-report explainer.** `/patient-report-explanations`
  was the only explainer route with no access guard and persisted a
  caller-asserted `patient_uid`/`admission_id` with format-validation only.
  Added the direct `patientAccessGuard` (shadow→GO_LIVE) + a load-bearing
  tenant-scoped existence/consistency check before persist + deep test. Merge
  `501bfd06`.
- [x] **#8 — bearer JWT in WebSocket URL.** Core `RealtimeClient` and the staff
  `WebSocketService` sent the JWT as `/ws?token=…` (leaks to proxy/ingress
  access logs). Both now send `{action:'auth',token}` as the first message
  frame (the handshake `wsServer.js` already supports and the patient WS already
  used). Merge `26727836`.
- [x] **#9 — realtime not torn down on logout.** Patient logout / idle-timeout /
  401 never disconnected the `RealtimeClient` singleton, leaving authenticated
  PHI channels live for the prior user on shared devices. All teardown paths now
  route through `LogoutService.logout()` (which disconnects both realtime
  clients). Merge `26727836`.
- [x] **#10 — non-idempotent mutating retries.** `VHHttpClient._sendWithRetry`
  retried POST/PUT/PATCH with no `Idempotency-Key` (lost-2xx double-write); the
  patient `MutationQueue` was also keyless on replay. Now auto-mints a stable
  key reused across retries/401, threads it through the `ApiClient` facade, and
  the queue mints once per logical write (reused across online attempt +
  replay). http_client_test 16/16 incl. 2 new. Merge `76835ce1`.
- [x] **#12a — downloads bypassed SPKI pinning.** `document_opener` +
  `cache_file_utils` used raw `package:http` `http.get` (with a hand-attached
  bearer) for PHI downloads. Backend-host URLs now route through the pinned
  `VHHttpClient.getBytes`; genuinely off-host (e.g. pre-signed R2) URLs stay on
  a plain GET. Merge `a1b24a4e`.
- [x] **#12b — cache key ignored acting-as profile.** `ApiCacheManager`
  derived the on-disk key from the path only, so a dependent's PHI (fetched
  under a guardian's delegated session) could collide with / be served back on
  the guardian's profile. `_keyForPath` now namespaces by
  `VHHttpClient.actingAsUidProvider` (null = legacy key, no regression). Merge
  `a1b24a4e`.

### Deferred / not-real

- [ ] **#2 ABDM, #3a/#3b clinical-note phone+downtime, #4 payroll, #5 doctors —
  LATENT multi-tenant.** Real `tenant_id`/scoping omissions, but not exploitable
  in single-tenant today (RBAC on payroll/doctors verified solid). Fold into the
  multi-tenant data-layer cutover; ensure payroll/doctors tables are on that
  migration checklist.
- **#1 expired-token refresh — FALSE.** `ignoreExpiration` is refresh-only,
  signature-checked, and the old jti is blacklisted on rotation. No fix.
- **#7b lab explainer "uid as patient_uid" — FALSE.** `investigations.uid` IS
  the patient uid in this schema; the mapping is correct.
- **#11 deploy blockers — working as designed.** All-zeros image digests +
  `FILL_ME` admin CIDR are intentional fail-closed placeholders; Kyverno-Enforce
  is GO_LIVE-gated. *(operator: confirm Kyverno's image-verify identity matches
  whatever signs the Forgejo-built images.)*

### Deeper re-scan (2026-06-18, same day) — additional fixes

A second, deeper read of the same `main` raised 7 more items; each verified
before fixing. Five were live and are fixed + merged:

- [x] **#4 — prescription-PDF IDOR (HIGH, patient-exploitable).** `GET
  /prescriptions/pdf/:id` (`downloadPrescriptionPDF`) returned a signed PDF URL
  by bare SERIAL id with NO ownership check while the route admits PATIENT — any
  patient could enumerate the id and fetch any other patient's prescription PDF.
  Extracted a shared `callerMayAccessPrescription` predicate (patient sees own,
  listed staff see any) and applied it to the PDF route + `getPrescription` +
  `getPrescriptionByAppointment` so they can't drift again. Deep test 5/5. Merge
  `b830f04d`.
- [x] **#7 — virtual-ward check-in staff IDOR.** `submitCheckIn` locked PATIENT
  callers to self but applied no check to staff — any in-scope staff role could
  fabricate vitals/symptoms (→ escalations) for any enrolled patient. Now a
  non-patient caller must be the enrollment's `care_manager_uid` or an admin
  (403 `VIRTUAL_WARD_NOT_CARE_MANAGER`). Deep test 4/4. Merge `996d12ff`.
- [x] **#2-clinical — EHR-query patient guard + tenant scoping.** The
  clinical-plane `POST /ehr-query` (sibling of the #7a fix) had only a passive
  logger and `answerEhrQuery` loaded the timeline + admission packet
  tenant-unscoped/access-unchecked (the lone `collectAdmissionClinicalContext`
  caller omitting tenantId). Added `patientAccessGuard` (+ parity guard on the
  clinical-plane report explainer) and threaded `tenantId` into both loads. Merge
  `b97259fe`. *(Tier E patient-engagement loads have the same tenant-predicate-less
  SELECTs but are admin/IP-allowlisted control-plane — lower-priority follow-up.)*
- [x] **#1-ABDM — consent-scope clamp.** `handleDataRequest` passed the HI
  request's `hiTypes`/`dateRange` straight through (grant was only a fallback),
  allowing over-disclosure beyond the consented scope. Now intersects HI types +
  clamps the date window to the grant before persist/process. Deep test 1/1.
  Merge `553ab612`.
- [x] **#6 — local security gate unblocked.** gitleaks false-positive on a
  throwaway localhost Postgres URL annotated; **51 committed DB-dump files under
  `apps/backend/backups/` untracked** (`git rm --cached`; already gitignored —
  they remain in git HISTORY, a separate destructive scrub decision); semgrep's
  Windows `cp1252` `UnicodeDecodeError` fixed by setting `PYTHONUTF8` in
  `scripts/local-ci.mjs`. `--only=security,infra` now green. Merge `5fac23eb`.

Re-confirmed not-actionable now: prescription/pharmacy **lifecycle** routes are
staff-only by hard RBAC (no patient-IDOR); care-team ABAC shadow mode, admin/ops
tenant isolation, HL7 global secret, FHIR per-patient, and the admin
x-forwarded-for allowlist remain latent multi-tenant or GO_LIVE-gated by design.
The eight prior fixes were all confirmed present.
