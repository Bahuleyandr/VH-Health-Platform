# CLAUDE.md — VHHealth Backend

## Project Overview
Node.js/Express REST API backend for the VHHealth hospital management system. Serves three clients: patient Flutter app, staff Flutter app, and Next.js admin portal.

## Deployment

Production runs on a **3-node on-prem RKE2 Kubernetes cluster** inside the
hospital. Container images are built + signed + pushed by the `release-images.yml`
workflow, which exists in both `.forgejo/workflows/` (canonical) and
`.github/workflows/` (mirror). ArgoCD watches this repo, but **prod sync is
manual** — no Application sets `syncPolicy.automated`, so a merge to `main`
stays inert until an operator syncs.
Postgres is a CloudNativePG cluster (PG17, 3 replicas); ingress is Cloudflare
Tunnel → ingress-nginx, so zero inbound ports on the hospital firewall.

See the full runbook in [`../../docs/DEPLOYMENT_GUIDE.md`](../../docs/DEPLOYMENT_GUIDE.md)
and hardware spec in [`../../docs/HARDWARE_REQUIREMENTS.md`](../../docs/HARDWARE_REQUIREMENTS.md).

## Tech Stack
- **Runtime**: Node.js 26.5.0, Express 5. The version is a hard pin, not a floor: `engines` is `>=26.5.0 <27`, every workflow sets `node-version: 26.5.0`, and the `Dockerfile` `NODE_IMAGE` is a digest-pinned `node:26.5.0-alpine`. **Running this corpus on an older Node produces FALSE test failures** — results that do not reproduce on 26.5.0 and are not defects in the code. Confirm `node --version` prints `v26.5.0` before you treat any red jest run as signal; on the Windows dev box the pinned toolchain is `D:\Dev\Tools\node-26.5.0`.
- **Database**: PostgreSQL 17 native install (dev cluster at `D:\Dev\Tools\pgdata-vhhealth` on port **5433**, user `vhhealth`, db `vhhealth`). Prod runs managed Postgres; both speak the same wire protocol.
- **ORM**: Prisma is the canonical DB client — `src/lib/prisma.js` exports `prisma`, `prismaReadOnly`, `setTenant`, `circuitBreakerStatus`. Raw `$queryRaw*` / `$executeRaw*` call sites (~5.7k across ~565 non-test files) + the per-domain typed ORM migrations (batches 26–38) all run through it. `src/config/database.js` / `DatabaseManager` were **deleted in batch 31** — do not try to import them.
- **Auth**: JWT (jsonwebtoken) + Firebase Admin SDK + bcrypt
- **Storage**: Cloudflare R2 (vh-health-records bucket)
- **Logging**: Winston (`src/logging/logger.js`)
- **Monitoring**: Sentry
- **Testing**: Jest + supertest

## Repository Layout
```
src/
  app.js              # Express app setup, route mounting, middleware chain
  bin/www.js          # HTTP server entrypoint (port 5000), graceful shutdown
  config/             # Database, rate limits, RBAC, validation schemas, upload config
  controllers/        # Thin controllers grouped by domain
  middleware/          # Auth, CORS, rate limiting, RBAC, audit, sanitization, file validation
  routes/             # Express routers grouped by domain
  services/           # Business logic layer
  utils/              # Helpers (JWT, phone, R2, sanitization)
  validators/         # express-validator chains
  tests/              # Jest integration tests (authorization, critical paths)
  logging/            # Winston logger config
prisma/schema.prisma  # canonical schema source, 863 models (regenerated after each migration)
```

## Key Architecture Decisions
- **Prisma client is the canonical DB path, but raw SQL is still the dominant idiom — not a residue.** `prisma.$queryRaw*` / `$executeRaw*` from `src/lib/prisma.js` appear at roughly **5,700 call sites across ~565 non-test files**; the batches 26–38 typed-ORM migration covered specific domains, not the whole tree. Read the raw-SQL rules under "Phase 0.5 conventions" before touching any of them. The singleton is hardened at the edge (circuit breaker after 5 consecutive failures, >1000ms slow-query logging in every env) — every raw-SQL call inherits that automatically. New code: use `prisma` for reads/writes, `prismaReadOnly` for analytics / dashboards / exports (falls back to primary when `DATABASE_READ_URL` unset), and `setTenant(tenantId, fn, { superAdmin })` to wrap queries under RLS tenant scope (migration 075).
- **DatabaseManager shim is gone.** `src/config/database.js` was deleted in batch 31 after every consumer (app.js root probe, bin/www.js shutdown, prometheusMiddleware, jest.teardown, tenant-rls deep test, uptimeRoutes) was ported to `prisma` directly. Do not try to re-add a shim; use `prisma.$queryRaw` / `prisma.$executeRaw` + the helpers on `src/lib/prisma.js` (setTenant, prismaReadOnly, circuitBreakerStatus).
- **Schema drift check in CI.** `apps/backend/scripts/check-schema-drift.mjs` diffs `prisma/schema.prisma` against a fresh `prisma db pull` of the test DB after migrations. Surfaces batch-18/22-class bugs (`ordered_date` vs `requested_at`) at review time. Local check: `npm --prefix apps/backend run check:schema-drift`.
- **Raw SQL migrations are the source of truth (2026-05-12).** `prisma db push` was removed from CI and `ensure-test-db.mjs` after the post-migration DB grew Postgres features (GENERATED columns, column-reference DEFAULTs, sequence-referencing defaults) that Prisma can no longer emit declaratively. The new flow: `src/migrations/000_baseline.sql` (a `pg_dump --schema-only` of a clean QA DB) bootstraps the public schema; `001+` apply the deltas; `prisma/schema.prisma` is **regenerated via `npx prisma db pull`** after any migration that touches a Prisma-modelled table. The two files commit together, and the drift check now fails CI if they ever disagree. Adding a new migration: write the `.sql`, then regenerate against an **isolated throwaway database**, not the shared `vhhealth_test` one — `qa-cluster-up.mjs` is idempotent and a no-op against a healthy cluster, so it hands you the long-lived shared DB rather than a fresh one, and a `db pull` from it bakes whatever that DB has accumulated into the canonical schema. Build the scratch DB with the documented recipe (`CREATE DATABASE` → `ensure-pgvector-extension.mjs` → `ci-setup-db.mjs`; see the Database Access section), point `DATABASE_URL` at it, run `npx prisma db pull --schema=prisma/schema.prisma`, confirm with `node scripts/check-schema-drift.mjs`, and drop the scratch DB when done (`scripts/qa-scratch-db.mjs`). Design comments (`//`, not `///`) that `prisma db pull` strips on regeneration are preserved in `prisma/SCHEMA_NOTES.md`.
- **Migrations are tracker-driven.** Both the boot-time runner (`src/utils/migrations/runMigrations.js`) and `scripts/ci-setup-db.mjs` consult the `_migrations` table and skip any file already recorded there. Add new migrations as bare DDL files in `src/migrations/NNN_*.sql` — each applies exactly once per DB. `ci-setup-db.mjs` also auto-detects a pre-existing baseline schema (probes for `users` + `appointments` + `admissions`) and records `000_baseline.sql` without re-running its non-idempotent `CREATE FUNCTION` DDL. Production execution requires both `--skip-seeds` and `CI_DB_SKIP_SEEDS=1`; synthetic seed entrypoints refuse `NODE_ENV=production`. Re-running the seed-free command against a populated production DB is safe and fast. `scripts/smoke-migration-runner.mjs` exercises fresh-apply / re-run / truncate-tracker paths against a throwaway DB.
- **★★★ An applied migration is IMMUTABLE. Never edit or delete a `src/migrations/*.sql` file that already exists on main — add a new one.** A migration that has run against a database cannot be un-run; editing the file only desynchronises it from the `_migrations` row that recorded its sha256, and `reconcileMigrationChecksums` (`src/utils/migrations/runMigrations.js`) then refuses to boot with `MIGRATION_CHECKSUM_DRIFT`. That check is deliberately not bypassable. **This is invisible to every DB-backed gate**: CI provisions fresh databases, so their tracker rows seed from whatever bytes are on disk and the checksums always agree — an in-place edit goes green all the way to main and detonates on the first long-lived database it meets. That is exactly what happened to `566_cath_consumables_billing_hook.sql` (shipped 2026-07-12 in #558, edited 2026-08-30 by `03db4c44f` to add an idempotency guard that was semantically harmless and still moved the checksum), which stopped the dalekdefender rig booting. Retrofitting idempotency into an applied migration is never necessary — a recorded migration does not run again. The guard is `scripts/ci/check-migration-immutability.mjs`, wired into the unconditional `security` stage and both backend tiers; run it locally with `npm run check:migration-immutability`. The reviewable opt-out for a genuine emergency correction is `scripts/ci/migration-amendment-allowlist.json`, which authorises one checksum transition and still leaves every already-migrated database needing operator reconciliation.
- **Phase 0 / 1 / 1.5 / 2 transaction boundary rule (2026-05-12).** Pre-flight lookups (admission state, readiness probes, FK existence checks) belong **outside** `prisma.$transaction`. A try/catch swallowing a Prisma error inside a `$transaction` callback aborts the underlying Postgres tx silently; the next `tx.*` call then fails with `current transaction is aborted, commands ignored until end of transaction block` and surfaces as a generic 500. The pattern that works in this codebase: **Phase 0** = pre-flight on plain `prisma` (P2025 → `AppError.notFound`, never a 500); **Phase 1** = atomic state mutations + audit log inside `prisma.$transaction`, with NO best-effort calls inside (every `tx.*` must succeed); **Phase 1.5** = post-commit best-effort on plain `prisma`, each in its own try/catch — TPA placeholder, housekeeping ticket, downstream alerts (failure is logged, never blocks Phase 1); **Phase 2** = slow/external (LLM, PDF, external API) — failure is recoverable via a separate endpoint. Applied across `markForDischarge` (`f9bbecba`), `markDischargeDrugsDispensed` (`d032f6d0`), `dischargePatient` (`1c2dfe8a` + `80e0ec5f`), `collectAdvanceDeposit` (`bfbb3d76`). When writing any new service method that mutates more than one row + has a best-effort downstream, default to this shape.
- **Domain grouping**: Controllers, routes, services, validators are grouped by domain (auth/, appointment/, staff/, etc.)
- **wrapAutoRBAC**: Routes use `wrapAutoRBAC(router, configKey, routeMap)` from `src/config/routeWrapper.js` for role-based access control.
- **Response format**: All responses use `success(res, data, message, status, meta)` or `error(res, message, statusCode, details)` from `src/utils/responseHelper.js`. Envelope: `{ success: true, message: "...", data: {...}, requestId: "..." }`. Optional `meta` param for pagination.
- **Unified req.user shape**: `jwtMiddleware` (the sole JWT auth layer) normalizes to `{ uid, role, roles?, phone?, email? }`. `uid` is the string UID. Use `String()` comparison for IDOR checks.
- **AppError class**: Services throw `AppError` (from `src/utils/AppError.js`) with `statusCode`, `code`, and `details`. Factory methods: `AppError.badRequest()`, `.notFound()`, `.forbidden()`, `.unauthorized()`, `.invalidTransition(from, to, allowed)`. The global error handler recognizes these and returns structured responses.
- **Role helpers**: Use `isStaff()`, `isClinical()`, `isAdmin()`, `isDoctor()` from `src/utils/roleHelpers.js` — never inline role arrays like `['ADMIN','DOCTOR','NURSE']`.
- **Security config**: All security constants (lockout, OTP limits, JWT expiry, device trust) live in `src/config/securityConfig.js` — not hardcoded in services.
- **Input sanitization**: All user-facing text fields go through `stripHtml()` from `src/utils/sanitize.js` via middleware in `src/middleware/sanitizeMiddleware.js`.
- **File upload validation**: Multer + magic bytes verification (`validateFileContent`) + patient-specific restrictions (`validatePatientUpload`) in `src/middleware/uploadMiddleware.js`.
- **Consent signatures are immutable**: `POST /consent/:id/signatures` writes versioned `consent_signatures` evidence through the validated upload/R2 path and refreshes the signed consent PDF record; do not update signature rows in place.
- **Front-desk registration guardrails**: `POST /patients` accepts JSON or multipart profile-photo registration. Near matches return `PATIENT_DUPLICATE_REVIEW_REQUIRED`; create-anyway requires an audited override reason. `tenantSettingsService.getFrontDeskBiometricCaptureSettings()` is a disabled-by-default biometric seam only, not a device SDK integration.
- **Notification outbox is a send-permission ledger, not a fire-and-forget queue (migration 609).** `notificationOutbox.queue()` from `src/utils/notifications/notificationOutbox.js` persists an immutable rendered intent, deduplicated on `ux_notification_outbox_delivery_intent` (609:112-120). Statuses are `PENDING → CLAIMED → SENT | FAILED | RECONCILIATION_REQUIRED`, plus `SUPPRESSED` — enforced by the `notification_outbox_transition_guard` trigger (609:522-589), **not** by a CHECK constraint, so do not go looking for one on `status`. The load-bearing rule: `SENT` is impossible without an `acknowledged` row in `notification_provider_receipts` (`chk_notification_outbox_sent_provider_acceptance`, 609:562-575) — a successful send call is not delivery. The `notification-outbox-drain` cron (every 2 min, `src/utils/scheduler.js:604`) retries only `PENDING`/`FAILED` rows with `retry_count < 3` after a 5-minute backoff, in strict per-tenant/channel cursor order (`notificationOutbox.js:214-245`). `RECONCILIATION_REQUIRED` rows are never re-sent in place — but the `notification-outbox-auto-replay` cron (every 15 min, kill switch `NOTIFICATION_OUTBOX_AUTO_REPLAY_ENABLED`, default on) now requeues them **as new intents** via the audited operator requeue mechanism (`notificationOutboxAdminService.autoReplayReconciliationRequiredRows`): bounded to 2 `replay_generation`s per chain (migration 690), ≥30-min backoff, 24-h age ceiling, fail-closed provider-uncertainty reason allowlist; each requeue stamps the original `operator_replay_superseded` (the exact string the ordering predicates hardcode) and records accepted duplicate-delivery risk in `audit_logs`. Chains past the bound are stamped `auto_replay_exhausted` once and alert as terminal (`notification_outbox_terminal_dead_letter_rows`, canary `notification_dead_letters_terminal` critical) — operator endpoints only. `SUPPRESSED` is terminal-by-design and never retried by anything: every production suppression is a deliberate payroll supersede/cancellation, and the state machine has no transition out of it; visibility is the `notification_outbox_suppressed_rows` gauge.
- **API versioning**: `apiVersionMiddleware` reads `Accept-Version` header, sets `req.apiVersion`. Currently informational — future response helpers can adapt per version.
- **Insurance claim tables are deliberately split.** `insurance_claims` and `tpa_claims` are **distinct concepts**, not duplicates. Do not consolidate them.
  - `insurance_claims` (legacy, billing-driven) — generic insurance claim with `parent_claim_id` for enhancement chains; back-referenced by `clinical_ai_appeal_letters`, `clinical_ai_payer_variance_reviews`, `insurance_claim_caps`. Lives behind `/api/v1/billing/insurance/claim*` and is the canonical surface for `billingService`. Has `tenant_id uuid NOT NULL` (added in migration 239 alongside the `tenant_isolation` RLS policy); see `src/migrations/239_tenant_rls_phi_phase_2c.sql`.
  - `tpa_claims` (Sprint 5 / migration 153) — TPA cashless+reimbursement workflow; required FKs to `insurance_policies` and (optional) `insurance_preauth`; carries `claim_type` (`cashless`|`reimbursement`), `tenant_id`, and a `prepared/submitted/queried/approved/partially_approved/denied/paid/closed/cancelled` status enum. Lives behind `/api/v1/insurance/*` and `claimsService.js`. Mid-stay enhancements use `insurance_preauth.parent_preauth_id` + `request_type='enhancement'` — **not** a child row in `tpa_claims`, and **not** a billing-side `insurance_claims` enhancement. Patient self-service surface is `/api/v1/portal/tpa/claims`.
  - Both tables use `SERIAL` ids starting at 1, so a given id may exist in both tables pointing at unrelated patients. Service code that takes a claim id from one workflow must not silently fall through to the other table (`billingService.createEnhancementClaim` guards this — see the `TPA_CLAIM_USE_PREAUTH_ENHANCEMENT` branch).
  - **Exception — claim caps** (migration 197, batch-4 wrong-table-tpa fix). `insurance_claim_caps` carries a nullable FK on *each* side (`claim_id` → `insurance_claims`, `tpa_claim_id` → `tpa_claims`) with a CHECK enforcing exactly one is set, and partial unique indexes on each `(parent_id, category)`. The caps semantics (per-category max amount) are identical across both parents, so `claimCapsService.resolveClaimTarget` probes both tables for a given id and writes to the matching column — preferring `tpa_claims` when both match, because the only route that consumes it (`/api/v1/insurance/claims/:id/caps`) is the TPA workflow surface.
- **NL-3 P1 teleconsultation provisioning is backend-only and flag-gated.** `src/services/telemedicine/teleconsultProvisioningService.js` wraps the migration-117 telemedicine tables for ordinary `appointments.visit_type='TELE'` rows, provisions exactly one `teleconsultations` row plus one `video_sessions.provider='livekit'` room binding, records patient telehealth consent, and mints LiveKit JWTs only when `LIVEKIT_ENABLED=true`. Patient self routes live under `/api/v1/portal/teleconsult/*`; staff routes live under `/api/v1/teleconsult/*` behind clinical staff RBAC and PHI logging. Recording stays off: no Egress/recorder deploy, no recording grants, and `recording_status='disabled'`. Consultation documentation stays in the existing appointment-bound OP note flow; do not add teleconsult note types or widen `patientPortalService` note visibility. P1 includes only held LiveKit manifests and manual smoke tools; P2 owns patient Flutter join/device checks and P3 owns the staff consult surface.

## Auth Architecture
- **Patient login**: Firebase OTP → `POST /api/v1/auth/firebase/firebase-login` (idToken) → JWT
- **Staff login**: Employee ID + password → `POST /api/v1/auth/staff/login` → accessToken + refreshToken
- **Admin login**: Username + password → `POST /api/v1/auth/admin/login` → JWT
- **Admin OIDC SSO (NL-1 P1)**: `GET /api/v1/auth/admin/sso/oidc/:provider/start` and callback broker live in `src/services/auth/adminOidcSsoService.js`. Provider config is tenant-scoped under `/api/v1/admin/identity/sso/oidc/*`; secrets are write-only/encrypted. SSO links only to existing `admins` rows, never creates admins, and emits append-only `identity_audit_events`.
- **SSO token boundary**: IdP `id_token` values are accepted only by the OIDC callback broker. `jwtMiddleware.js` remains the sole REST bearer verifier and accepts only VH Health HS256 tokens. SUPER_ADMIN SSO tokens intentionally do not carry `mfa: true`; `requireSuperAdminStepUp` still requires local TOTP step-up on sensitive admin namespaces.
- **SCIM provisioning (NL-1 P3)**: `/api/v1/scim/v2/:tenantSlug/:providerKey/*` is mounted before `validateApiKey`/`jwtMiddleware` because SCIM bearer tokens are provisioning credentials, not VH user JWTs. Tenant/provider is resolved first, SCIM bearer hashes are checked in constant time from tenant IdP config, and mutations audit to `identity_audit_events`. `active=false` deactivates the local admin/staff identity, revokes sessions, disables staff PIN/quick-login/device-bound login state, and excludes named break-glass accounts. Local edits to SCIM-owned employment fields require an explicit audited override.
- **Middleware chain**: `requestIdMiddleware` → `apiVersionMiddleware` → `validateApiKey` (timing-safe, per-client keys) → `jwtAuth` (JWT + blacklist check + normalized req.user) → `requireRole()` (per-route RBAC)
- **Single auth middleware**: `jwtMiddleware.js` is the sole JWT verification layer. `auth.js` and `authMiddleware.js` have been removed.
- **Admin lockout**: 5 failed attempts → 15min lockout (configurable via `SECURITY_CONFIG`)
- **Staff lockout**: Centralized `_checkStaffLockout()` checks across password, PIN, and quick-login — 5 failed attempts → 15min lockout
- **JWT**: HS256 signed with `jti` (JWT ID) for revocation. Role-specific expiry: patient 7d, staff 8h, admin 4h. Crashes on startup if `JWT_SECRET` missing. Error codes: `TOKEN_EXPIRED`, `TOKEN_INVALID`, `TOKEN_REVOKED`.
- **Token blacklist**: Redis fast-path + DB persistent fallback (`invalidated_tokens` table). Tokens blacklisted on logout + refresh rotation. `revokeAllUserTokens()` for force-logout.
- **Token rotation**: On refresh, old token is blacklisted before issuing new one. Prevents token replay.
- **OTP hashing**: OTPs hashed with bcrypt before storage. Timing-safe comparison via `bcrypt.compare()`. Backwards-compatible with legacy plaintext.
- **API keys**: Per-client keys via `API_KEY_PATIENT`, `API_KEY_STAFF`, `API_KEY_ADMIN` env vars. Shared `API_KEY` as fallback. `req.apiClient` set for audit trail.
- **Anomaly detection**: `loginAnomalyDetector.js` tracks credential stuffing (10+ accounts from same IP). IP threat level assessment for adaptive rate limiting.
- **Security webhooks**: `securityWebhook.js` pages external channels for critical events (ACCOUNT_LOCKED, BRUTE_FORCE_DETECTED) — but ONLY when `SECURITY_WEBHOOKS_ENABLED=true` and `SECURITY_WEBHOOK_URL` are set (ConfigMap flag + sealed secret; canonical names live in validateEnv). When disabled, `vhhealth_security_webhook_events_total{outcome="disabled"}` counts every page that would have fired, and the `security-events` Prometheus rules page independently of the webhook.

## Security Architecture

### Rate Limiting
| Profile | Window | Max | Applied To |
|---------|--------|-----|------------|
| patient | 15min | 100 | /users, /appointments, /records, /feedback |
| staff | 15min | 500 | **No mount applies this.** Neither `/api/v1/staff` mount carries a limiter; staff reads are unlimited. The profile is reached only via `dynamicRoleRateLimiter`, which `wrapAutoRBAC` attaches to write methods (POST/PUT/PATCH/DELETE) on wrapped routers — a staff-role JWT then buckets under this profile. The `/api/v1/*` 404 fallback limiter only meters unmatched paths. |
| admin | 15min | 100 | /admin/*, /system/*, /logs/* |
| auth | 15min | 5 per IP+account | /auth/admin/login, /auth/staff/login, /auth/staff/quick-login |
| otp | 10min | 3 per phone | /auth/firebase-login, /auth/request-otp |
| dashboard | 1min | 10 per IP | /dashboard |
| sos | 1hr | 3 per user | POST /sos/ |
| probe | 1min | 120 per **pod** per caller | `GET /`, `HEAD /`, `/metrics` |

★ **`probe` is the one profile whose bucket is keyed per instance, and that is
load-bearing.** It is mounted `instanceScoped: true` (app.js), which prefixes
the pod identity (`POD_NAME`, downward API) onto the key. Prometheus sends one
static Bearer for every scrape of every replica and the mount sits ahead of
auth, so without that prefix every scrape in the fleet derives the same key and
the shared Redis store collapses the whole deployment into one bucket — making
the effective quota `max / replicas`, i.e. tightest exactly when the HPA scales
up during an incident. Prometheus scrapes pod endpoints directly, so a pod
always sees its own constant scrape rate; keying per pod is what makes a static
number correct under an autoscaler. Do not "simplify" this back to a
fleet-wide key, do not point the probe surfaces at `default` (its
`RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX` knobs are 900000/100 in prod — 100
requests per 15 minutes for all probe traffic combined), and do not exempt
`/metrics` (the root probe runs a real `SELECT 1` per hit and the exemption
would reopen an unmetered DB amplifier). The sizing derivation is in
`src/config/rateLimitProfiles.js` and is pinned against the live infra
manifests by `src/tests/unit/probeRateLimitProfile.test.js`.

### IDOR Protection
All patient-facing mutation endpoints verify resource ownership:
- `PUT /appointments/:id` — `checkAppointmentPermission()` with `String()` comparison
- `PATCH /appointments/:id/reschedule` — same ownership check plus slot conflict guards
- `DELETE /appointments/:id` — same
- `DELETE /appointments/patient/records/:id` — `WHERE patient_id=$2` scoped query
- Pharmacy legacy endpoints — phone ownership check for PATIENT role

### Input Sanitization
Applied via middleware from `src/middleware/sanitizeMiddleware.js`:
- Profile: name, address, allergies, emergency_contact
- Feedback: comment, question
- Pharmacy: order_note, delivery_address, delivery_landmark
- Investigation: notes, custom_test_names, collection_address
- Appointment: reason, notes
- SOS: notes, description, address

### File Upload Security
1. **Multer filter**: MIME type allowlist from `uploadConfig.js`
2. **Magic bytes**: `validateFileContent()` checks file header bytes match claimed MIME
3. **Patient restrictions**: `validatePatientUpload()` — JPEG/PNG/PDF only, 10MB images / 25MB PDFs
4. **Filename sanitization**: Dangerous character patterns rejected
5. **NL-4 evidence/photo paths**: consent signature PNGs and front-desk profile photos must stay on the same validated upload path; never accept raw base64 evidence in JSON.

### Phone-in-URL Mitigation
Prefer `/my` endpoints that derive phone from JWT:
- `GET /notifications/my` instead of `GET /notifications/:phone`
- `PATCH /notifications/my/mark-all-read`
- `GET /records/health-records/my`

### Request ID Correlation
- `requestIdMiddleware` generates UUID per request (or reuses `X-Request-Id` header)
- Available as `req.id` in all middleware/controllers
- Echoed back in `X-Request-Id` response header for client-side correlation

### Graceful Shutdown
- `SIGTERM` and `SIGINT` handlers in `bin/www.js`
- `uncaughtException` and `unhandledRejection` handlers trigger graceful shutdown
- Closes HTTP server, drains DB pool, force-exits after 10s timeout
- Migrations block startup — app exits on migration failure

### Error Handling
- Global error handler in `src/middleware/errorHandlerMiddleware.js` with Sentry integration
- `AppError` instances return structured `{ success, message, code, details }` responses
- **Never expose `err.message` to clients** — log server-side, return generic message
- Stack traces only in development mode
- Unimplemented endpoints return `501 Not Implemented` (not `200`)
- No empty `.catch(() => {})` — always log with context
- No fake success in catch blocks — return `error()`, not `success()` with zeros

### Async Error Safety
- `wrapAsync()` in `src/config/routeWrapper.js` wraps ALL async route handlers
- Catches unhandled promise rejections and forwards to Express error handler
- Prevents process crash from any async middleware or controller error
- Applied automatically via `wrapAutoRBAC` and `wrapRoutesWithValidation`

### Database Resilience
- `statement_timeout` on all queries — 60s, enforced by the CNPG cluster (`infra/kubernetes/base/cnpg/cluster.yaml`). `STATEMENT_TIMEOUT_MS=30000` is present in the backend configmap but is not read by the app layer; the CNPG cluster value governs. (prevents connection pool exhaustion)
- **Circuit breaker**: after 5 consecutive query failures, rejects immediately for 30s. Auto-resets (half-open) on recovery.
- Pool error events logged (prevents silent connection loss)
- `circuitBreakerStatus()` from `src/lib/prisma.js` reports breaker state (open/consecutiveFailures/openedAt/resetInMs); scraped by `/health/metrics`.
- `prismaReadOnly` from `src/lib/prisma.js` routes to `DATABASE_READ_URL` when configured, falls back to primary otherwise. Use it for analytics / dashboards / exports. **Note:** `DATABASE_READ_URL` is a placeholder in the current prod Sealed Secret; the CNPG RO pooler endpoint (`infra/kubernetes/base/cnpg/poolers.yaml`) exists but is not yet wired — reads currently fall back to primary.
- For test mocking, import and stub the `prisma` singleton directly (the old `setDatabaseInstance` shim was deleted with DatabaseManager in batch 31).
- Slow query logging: queries >1000ms logged as warnings with duration and truncated SQL

### External Service Resilience
- R2 storage: 30s request timeout + retry with exponential backoff (2 retries)
- R2 graceful degradation: app starts even if R2 env vars missing — file ops fail at call time, not import time
- FCM notifications: retry on transient errors (2 retries with backoff)
- Invalid FCM tokens automatically deactivated in database
- Notification outbox (`src/utils/notifications/notificationOutbox.js`) persists immutable intent before sending and records append-only provider attempts and receipts (`notification_delivery_attempts`, `notification_provider_receipts`); delivery counts as complete only on a positive provider acknowledgement — see the outbox bullet under Key Architecture Decisions
- Firebase mock fallback: if Firebase credentials missing, rejects auth calls with clear error instead of crashing

### Audit Log Resilience
- Fire-and-forget with capped queue (max 1000 pending)
- File fallback via Winston when DB unavailable — audit entries never lost

### State Machine Validation
- Pharmacy orders: `VALID_TRANSITIONS` map prevents invalid status jumps (e.g., DELIVERED → PENDING)
- Appointment status changes wrapped in transactions with `FOR UPDATE` row locking
- Token number generation is atomic (prevents race condition duplicates)

### HIPAA Compliance
- **Route-level PHI logging**: `phiAccessLogger(recordType)` middleware from `src/middleware/phiAccessMiddleware.js` auto-logs all PHI access at the route level. Applied to: appointments, records, investigations, prescriptions, pharmacy-orders, EMR (clinical notes, vitals, diagnoses, admissions, orders, CDS), clinical workflows, documents, radiology, dietary, theatre, blood-bank, referrals.
- **Controller-level PHI logging**: `logPhiAccess()` from `src/utils/hipaaAudit.js` for granular per-controller tracking
- Records: who accessed, which patient, what record type, action (VIEW/CREATE/UPDATE/DELETE), IP, request ID, timestamp
- File fallback via Winston when DB unavailable — HIPAA audit entries never lost
- Only logs successful accesses (2xx/3xx) — auth failures don't generate PHI audit entries

### Clinical Safety
- **Vital sign anomaly detection**: `src/utils/clinical/vitalSignMonitor.js`
  - `checkVitalAnomalies(patientId, vitals)` compares against clinical reference ranges
  - Generates CRITICAL alerts (e.g., O2 <85%, HR >180) and WARNING alerts (e.g., BP >160)
  - Persists alerts to `clinical_alerts` table for staff review
- **Prescription safety checker**: `src/utils/clinical/prescriptionSafetyCheck.js`
  - `validatePrescriptionSafety(patientId, medications)` checks patient allergies + active meds
  - Returns `{ safe, warnings, blockers }` — blockers prevent prescription save
  - Catches allergy conflicts (severity-aware) and duplicate active prescriptions
- **PII masking**: `src/utils/piiMask.js` — `maskPhone()`, `maskEmail()`, `maskName()` for safe logging

### Self-Healing Infrastructure
- **DB health monitor**: the legacy `src/utils/dbHealthMonitor.js` was deleted in batch 31 (the pool it polled was retired in batch 28). `/health/metrics` in `src/routes/health/uptimeRoutes.js` now exposes `circuitBreakerStatus()` + a `SELECT 1` probe as the primary ops signal.
- **Canary health checks**: `src/utils/canaryHealthCheck.js` — every 5 minutes tests DB read/write, stuck notifications, unacknowledged critical alerts
- **Schema drift detection**: `src/utils/schemaDriftDetector.js` — compares expected vs actual DB tables at startup, warns on mismatches
- **Scheduler job locking**: `withJobLock()` prevents overlapping cron executions

### Observability
- Sentry: 10% trace sampling in production, release tracking via `GIT_COMMIT`
- Compression middleware: gzip responses >1KB
- Explicit JSON body size limit: 1MB (default; `express.json`/`urlencoded` read `HTTP_BODY_LIMIT`, default `1mb`). Kept small on purpose — JSON parsing is a CPU-bound DoS surface and file uploads go through **multer** (capped 10MB image / 25MB PDF via `validatePatientUpload`), not `express.json`.
- Root health check (`GET /`) verifies DB connectivity, returns 503 if unhealthy
- HTTPS redirect enforced in production via `x-forwarded-proto` check
- Strict Helmet config: HSTS 1yr with preload, CSP directives, no framing

### Environment Validation
- `src/utils/validateEnv.js` validates all critical env vars at startup via Joi
- App crashes if `JWT_SECRET`, `DATABASE_URL`, or `API_KEY` missing
- Warns (but continues) if `R2_*`, `FIREBASE_PROJECT_ID`, `SENTRY_DSN` are missing

## Clinical service continuity + external-interface recovery

Migrations 600–616 added the substrate for running the hospital through an
external-interface outage and reconciling afterwards. **Almost all of it is
inert.** The tables, constraints, and triggers exist and the database enforces
them, but no request path activates most of it. Twelve of the seventeen say so
in their own header — 600:5-6, 601:5-6, 602:5-7, 604:5-8, 606:3-5, 611:2 and
612–615:2 use the word *inert*, while 603:2-3 and 607:2 state that no worker,
interface or adapter is activated. The other five (605, 608, 609, 610, 616)
document effect fences and state-plane separation instead, so a header without
an inertness note is **not** evidence that its path is live — check the callers.
Design authority is [`docs/continuity/`](../../docs/continuity/); start
at `activation-readiness-tracker.md`, then `c0-4-owner-decision-dossier.md`
(the SQL pins to it by name). What follows is only the backend contract you
must not break.

### The activation gate is a compile-time constant

`CLINICAL_CONTINUITY_C_D14_APPROVED = false` in
[`src/config/downtimeConfig.js:37-39`](src/config/downtimeConfig.js) — with the
comment "deliberately cannot be changed by deployment configuration."
`clinicalContinuityFacilityContextEnabled()` ANDs it, and replay receipts +
paper reconciliation inherit the `false` transitively. Setting an env var will
not turn any of this on. The action-registry middleware *is* mounted globally
(`app.js:719`) but returns `next()` immediately when its flag is unset and only
engages on an explicit `x-vh-continuity-action-id` header. Do not describe this
subsystem as live.

### The recovery catalog is the inventory, and it cannot drift

[`src/config/externalInterfaceRecoveryCatalog.js`](src/config/externalInterfaceRecoveryCatalog.js)
enumerates **30 external interface families, `I01`–`I30`** — the C6.1 census of
the platform's *external* ingress and egress boundaries. Internal app-to-backend
APIs, Postgres/Redis and the app's own WebSocket fabric are deliberately out of
scope, and `I07`/`I08` are requested domains for which the census found no
connector at all. Each declares a disposition: `hwm_required`
(replayable stream, needs a high-water mark), `not_applicable_no_replayable_stream`,
or `mixed` (splits by subpath — only `I06` PACS and `I15` FHIR/SMART, and
`resolveExternalInterfaceDisposition` **throws** rather than guessing when the
subpath is missing or unknown).

Nine are implemented: `I01 I02 I04 I05 I06 I09 I10 I15 I17`. That list is
pinned in both directions — `src/tests/unit/externalInterfaceRecoveryCatalog.test.js:19-26`
asserts set equality between the catalog's `implemented` flags and the live
adapter dispatch table `EXTERNAL_INTERFACE_RECOVERY_ADAPTERS`
(`src/services/integrations/externalInterfaceRecoveryService.js:539-553`).
Flagging a letter implemented without registering an adapter fails CI, and so
does the reverse. **Add a new letter to both files in the same commit.**

### Migration 603 — the canonical substrate

603 creates no tables. It re-shapes two tables from migration 578 so they can
carry external-interface work alongside their original pathway-projector role:

- `event_consumer_offsets` gains `scope_kind` — exactly two values, `'pathway_registry'` and `'external_interface'` (603:52-53) — plus `chk_event_consumer_offsets_row_shape` (603:75-127), which makes the two row shapes mutually exclusive. A pathway row must leave every external column NULL and keep its backfill cursors; an external row must carry a real tenant (never the default tenant, 603:105), a `facility_scope` of `tenant` or `facility`, and NULL backfill cursors.
- `pathway_projector_inbox` gains the same discriminator plus sequencing (`source_position`, `source_token`, `predecessor_token`, `duplicate_key`), the three-clock triple `occurred_at` / `received_at` / `recorded_at`, `arrival_class`, `effect_disposition`, and `pending_task_id` (603:339-362).

603 also puts `event_consumer_offsets` under `ENABLE` + **`FORCE ROW LEVEL
SECURITY`** (603:152-153), and its restrictive policy admits `pathway_registry`
rows only to the table owner (603:177-184). App roles therefore cannot reach the
control plane through the table at all. Five `SECURITY DEFINER` accessors are
the only path — `pathway_projector_offset_get` / `_offsets_list` / `_register` /
`_retire` / `_advance` (603:211-332) — and each hard-codes
`scope_kind = 'pathway_registry'` so definer privilege can never be turned on a
tenant's external rows. Callers are in `src/services/events/pathwayProjectorService.js`.

### `late_pending_only` — the late-effect fence

Work that arrives after the fact (`arrival_class = 'recovery_backlog'`) is
recorded with `effect_disposition = 'late_pending_only'`. The evidence and the
domain fact land; **every live clinical or operational side effect is
forbidden.** Three independent mechanisms enforce that:

1. **The interlock CHECK.** A late external inbox row cannot reach `status='handled'` without a `pending_task_id` (603:390-396) — suppressed effect is always replaced by human follow-up work.
2. **A transaction-local GUC plus a trigger family.** `externalInterfaceRecoveryService.js:656` issues `set_config('app.external_recovery_effect_disposition', …, true)`; `assert_external_recovery_effect_allowed()` (603:785-806) then raises SQLSTATE `23514` on any INSERT or UPDATE to a guarded table while that GUC reads `late_pending_only`. Guarded: `workflow_sla_instances`, `care_pathway_transition_events`, `notification_outbox` (603:808-818), then `news2_scores`, `clinical_alerts`, and the triage columns on `emergency_visits` / `appointments` / `vitals_chart` (607:79-114).
3. **The projector never calls the handler.** It terminates the row `ignored` with `outcome_code='late_pending_only_pathway_suppressed'` (`pathwayProjectorService.js:522-547`).

Two traps. The raise labels itself `CONSTRAINT = 'chk_external_recovery_late_effect_guard'`,
but **no constraint by that name exists** — it is a synthetic label for client
pattern-matching, so a `pg_constraint` lookup will not find it. And the fence
covers INSERT and UPDATE only; there is no DELETE-side guard.

### The interop state-plane law

Migration 610's header states the invariant for **I04** (610:1-7): **transport
evidence, parsed acknowledgement, permission to send, and cursor position are
four separate state planes** — four columns, not one status.

★ **I04 is the only interface that carries all four.** What the family shares is
the *principle* — evidence never implies permission, and a cursor advances only
on a positive acknowledgement — not the columns. 609's header names three planes
(609:3-4), folding acknowledgement into `notification_provider_receipts.outcome`
and leaving permission-to-send on `notification_outbox`; it has no
`send_authority` and no `transport_state`. 611 adds `send_authority` alone
(611:105), and spells it `('held','live_authorized','owner_authorized')`
(611:144) against 610's `('authorized','held_owner_reconciliation','revoked')`
(610:81). 616 is deliberately cursor-free (616:3) and tracks a single
`receipt_status` (616:33). Even recurring columns diverge — 609's
`receipt_source` carries four values to 610's two. **The table below is I04
vocabulary; do not port these names or values to another letter.**

| Plane | Where | Values |
|---|---|---|
| transport | `hl7_outbound_messages.transport_state` | `not_attempted`, `http_response`, `transport_failure`, `lease_expiry_unknown`, `legacy_unknown` |
| acknowledgement | `.acknowledgement_state` | `pending`, `aa`, `ae`, `ar`, `missing`, `invalid`, `control_id_mismatch`, `legacy_unknown` |
| send authority | `.send_authority` | `authorized`, `held_owner_reconciliation`, `revoked` |
| cursor | `hl7_outbound_delivery_cursors.state` | `ready`, `delivering`, `paused_rejected`, `paused_uncertain` |

Each rule is enforced twice — once in the service, once by a database trigger:

- **Transport success is evidence, never delivery.** `deliverOne` returns transport facts with no verdict (`hl7OutboundService.js:392-402`); the status decision reads only the parsed ACK (`hl7OutboundDeliveryLedgerService.js:441`). Trigger `hl7_outbound_message_transition_guard` (610:619), via `validate_hl7_outbound_message_transition()` (610:508), rejects `status='sent'` unless a correlated `AA` evidence row physically exists (guard block 610:596-614) — forging `acknowledgement_state='aa'` on the row is not enough. Its raise labels itself `CONSTRAINT = 'chk_hl7_outbound_sent_positive_ack'`, another synthetic label with no matching `pg_constraint` row. This cuts both ways: `httpStatus` is never consulted here, so an HTTP 500 carrying a correlated `MSA|AA` *does* mark the message sent. (The I05 interface-engine path additionally gates on `response.ok` — `interfaceEngineService.js:1111-1113`.)
- **Acceptance requires exactly one `MSA` segment, `MSA-1 ∈ {AA, AE, AR}`, and `MSA-2` equal to the original `MSH-10`** (`hl7OutboundDeliveryLedgerService.js:62-89`). Two MSA segments is `invalid`, not "take the first". Correlation failure does not downgrade the code — it replaces it with `control_id_mismatch`, which can never move anything *forward*. It still transitions state backward: the message falls to `status='reconciliation_required'` with `send_authority='held_owner_reconciliation'` (`:441-467`) and the cursor pauses `paused_uncertain` blocked on it (`:348-360`). A mismatch is also the only outcome that persists an acknowledgement row with `correlation_matches=false` — `missing`/`invalid` are dropped for want of an MSA code (`:269`) — which is exactly why both guards test `correlation_matches`, not `msa_code` alone.
- **A correlated `AA` advances the cursor but never grants send authority.** Advance is `:331-345` plus trigger `hl7_outbound_cursor_validate` (610:504), whose raise carries the synthetic label `chk_hl7_outbound_cursor_positive_ack` (610:483-499). Advance also has an unstated precondition — with an earlier un-acked message the cursor goes to `paused_uncertain` instead (`:319-329`). Owner reconciliation records a positive `AA` and reaches `status='sent'` while authority stays `held_owner_reconciliation` — a hardcoded literal at `:674-691`, pinned by `hl7-outbound-recovery.deep.test.js:183-191`.
- **Authority is granted only by a named actor with a recorded reason** (`authorizeOwnerRetryTx`, `:560-622`; trigger `hl7_outbound_message_transition_guard`, owner-release branch 610:570-583 raising the label `chk_hl7_outbound_owner_release_required`), and never for something already acknowledged (`:582-587`).

**Held work has no automated release path.** I04 requires an operator command.
I05 has no executor at all: migration 611 declares
`send_authority IN ('held','live_authorized','owner_authorized')` but
`owner_authorized` is **never written by any code in the repo** — it is a
reserved schema slot. Replay batches deliberately do not release; they write
skip evidence and leave the row held (`interfaceEngineService.js:1369-1418`).
The interim procedure is
[`docs/continuity/c6-1-i05-held-message-operator-procedure.md`](../../docs/continuity/c6-1-i05-held-message-operator-procedure.md);
the release executor is a future extension of the C5.2 workbench (migration
≥617), never a parallel mechanism.

### Per-letter adapters

| Migration | Letter | Adds |
|---|---|---|
| 603 | I10 cold-chain sensor stream | The substrate itself, landed with the first adapter |
| 607 | I09 device-vitals gateway, I15 FHIR write | Recovery back-references on `vitals_chart` + `lab_interface_messages` |
| 608 | I01 LIS ORU, I02 ASTM analyzer | Recovery columns + completeness triggers on the lab ingest tables |
| 609 | I17 notification delivery | `notification_delivery_attempts`, `notification_provider_receipts`, `notification_delivery_cursors`, claim-lease fencing |
| 610 | I04 HL7 outbound | Transport / acknowledgement / cursor evidence tables |
| 611–615 | I05 integration-engine streams | `interop_backend_delivery_receipts`; 612–615 each widen the protocol CHECK by one adapter (`csv`, `json`, `fhir_json`, `other`) |
| 616 | I06 PACS study links | `imaging_study_link_recovery_receipts` |

There is **no shared table-naming convention** — only 616 uses a
`*_recovery_receipts` suffix. What *is* universal is the provenance **pair**
(`recovery_inbox_id`, `recovery_interface_family`) and the composite FK back to
the canonical inbox (608:48-51, 609:301-306, 610:125-130, 611:113-116,
616:56-59):

```sql
FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
```

The fuller provenance quartet — that pair plus `owner_actor_uid` /
`owner_reason` — together with `evidence JSONB` lives on the dedicated
receipt/acknowledgement tables, **not** on the domain rows:
`notification_provider_receipts` (609:287-292), `hl7_outbound_acknowledgements`
(610:237-242), `interop_backend_delivery_receipts` (611:189-193),
`imaging_study_link_recovery_receipts` (616:29-36). In 609 and 616 that is the
same table the FK above sits on; in 610 and 611 it is a *different* table, each
carrying its own copy of that FK (610:262-267, 611:214-217) while the domain
rows carry only the pair. Two traps: 610 spells its owner columns
`owner_release_actor_uid` / `owner_release_reason` (610:35-36), and 608 creates
no table at all — it adds `recovery_inbox_id`, `recovery_interface_family` and
`recovery_pending_task_id` to the existing lab ingest tables (608:13-16) and has
no owner or evidence columns anywhere.

Distinguish the two paths when reading this code. The **steady-state** ledgers
(`hl7_outbound_*`, `interop_backend_delivery_receipts`, `notification_delivery_*`)
are written by the normal HL7 / interop / notification code. The **late-recovery**
insert path into them has no production trigger: `processNextItemTx` has exactly
three non-test callers — `fhirRoutes.js:1165` (I15), `deviceVitalsService.js:619`
(I09), and `externalLabRecoveryService.js:964` (I01/I02) — so nothing supplies
I04, I05, I06, or I17.

### The replay-receipt spine and reconciliation layer

Migration 605 adds three tables — `clinical_continuity_replay_receipts`,
`clinical_continuity_replay_effect_evidence`, `clinical_continuity_replay_attempts`
— for atomically claiming and finalizing an offline-queued clinical write.
`source_kind` is deliberately an **open, regex-validated string**
(`CHECK (source_kind ~ '^[a-z][a-z0-9_]{0,63}$')`, 605:123) rather than a closed
enum, so a new capture source inherits the spine without replacing the receipt
model (605:3-5). Migration 606 exercised exactly that path, adding
`'paper_back_entry'` alongside `'electronic_queue'` without touching the
constraint.

606 then adds **16 `clinical_continuity_*` tables** for the C5.2 incident /
paper-capture / reconciliation workbench, and rewrites 605's effect-evidence
table so the two sources diverge: an electronic replay may produce only a
private draft and is forbidden from emitting timeline, audit, SLA, notification,
or outbox effects, while a paper fact **must** land on the canonical timeline
and audit trail with `effect_disposition = 'late_pending_only'` (606:653-671).

**RLS here is not the migration-075 pattern — it inverts it.** Both 605 and 606
apply `ENABLE` + `FORCE ROW LEVEL SECURITY` and layer *two* policies per table:
a permissive `tenant_isolation` that grants visibility, and a **restrictive**
explicit-context policy that requires `app.current_tenant_id` to be present,
non-empty, and not `'bypass'` (605:282-302).
Where 075 is fail-open — its four-way `OR` makes an unset GUC show every row —
these tables are fail-closed: an absent, empty, `bypass`, or wrong-tenant
context returns **zero rows** and blocks writes, and `FORCE` removes the owner
exemption so the guarantee survives even for the migration role.

★ **606's workbench needs a facility GUC too, unconditionally.** Its loop
(606:1027-1077) creates `cc_explicit_tenant_facility`, which adds two further
conjuncts to both `USING` and `WITH CHECK` on **all 16** of its own tables:
`app.current_facility_id` must match `^[1-9][0-9]*$` and equal the row's
`facility_id`. A valid tenant GUC alone still returns zero rows across the whole
workbench. The receipts table from 605 is *not* in that 16 — it keeps its
tenant-only restrictive policy and separately gains a third policy
(606:1009-1025) applying the facility match to paper rows while exempting
`source_kind = 'electronic_queue'`.

The layering across tables is **not** done with parent-row subqueries — no
policy in either migration contains one. Parent containment is structural
instead: child FKs carry `(tenant_id, facility_id, incident_id)` into the
parent's unique key, so a child row cannot exist outside its parent's scope, and
the shared policy then hides parent and child together.

## Route Structure
Public (API key only): `/api/v1/auth/*`, `/api/v1/health`, `/api/v1/dashboard`
Protected (API key + JWT): `/api/v1/users/*`, `/api/v1/appointments/*`, `/api/v1/staff/*`
Admin only: `/api/v1/admin/*`, `/api/v1/system/*`, `/api/v1/logs/*`

## OpenAPI contract pipeline

`src/docs/openapi.json` is **generated, never hand-edited** —
`scripts/generate-openapi.mjs` boots the app, captures routes at registration
time, and writes the spec deterministically. It is byte-compared in CI, so a
manual edit always fails. The whole chain is blocking in `npm run ci`
(`package.json:38`): `openapi:check` (spec drift vs. real routes) →
`openapi:check-core` (Dart client copy in sync) → `npx spectral lint` →
`openapi:lint-budget`.

**Standing rule: run `npm run openapi:generate` after any route change, then
`npm run openapi:check` and `npm run openapi:lint-budget` before you push.**
Adding, removing, renaming, or re-mounting a route changes the spec; a stale
committed spec is the single most common way this subsystem goes red.

### The tag registry is a gate, not a list

Every operation carries exactly one primary tag. `OPENAPI_TAG_REGISTRY` in
[`scripts/openapi/base.mjs`](scripts/openapi/base.mjs) declares the **155**
permitted slugs, and `buildOpenApiDocument` **throws** if an operation resolves
to an undeclared one (`scripts/openapi/buildSpec.mjs:324-340`, the block
labelled `// THE REGISTRY GATE.`). The error prints paste-ready
`{ slug: '…' },` lines. This is what makes tag inference safe: renaming a route
module stops the build instead of silently republishing the taxonomy under a new
name.

Tag resolution precedence (`buildSpec.mjs:112-118`): explicit overlay
`ov.tags`/`ov.tag` → an explicit `markRouterDomain` declaration → the route
module's filename (bootstrap only) → the URL path with audience prefixes
skipped → `unclassified`.

★ **`markRouterDomain` inherits DOWN — never mark a barrel router.**
`composeRoutes` resolves `domainOf(router) ?? inheritedDomain`
(`buildSpec.mjs:219`) and passes the result to every mount child, so marking a
router that mounts N sub-routers collapses all N sub-domains into one tag. A
child's own declaration overrides what it was mounted under (nearest ancestor
wins). To fix a barrel, split its direct routes into per-domain sub-routers and
mark each one. `markRouterDomain` lives in
[`src/config/openapiDomain.js:42-58`](src/config/openapiDomain.js) — note that
the docblock at `buildSpec.mjs:105` points at a `scripts/openapi/routerDomain.mjs`
that does not exist.

`UNCLASSIFIED_TAG_BUDGET` (`base.mjs:167`) is pinned at **2** and generation
fails above it (`buildSpec.mjs:342-353`). **It only ratchets down.** The two
survivors are `GET /` and `HEAD /`, which belong to no subsystem by
construction, and `src/tests/unit/openapiTagInvariants.test.js:83` asserts that
list *exactly* — so the test must be edited whenever the budget moves. That
suite also pins one-tag-per-operation, the ban on `admin`/`staff`/`portal` as a
primary tag, and the rule that no slug may be published alongside its own plural
(singular is house style).

### The Spectral baseline is a fingerprint manifest

`.spectral-baseline.txt` (3,599 lines — 3,574 findings, all
`operation-description` warnings, exactly the operations with no description)
is pinned by [`scripts/check-openapi-lint-budget.mjs`](scripts/check-openapi-lint-budget.mjs).

★ **It is not a per-rule count.** A count gate was measured and rejected: delete
one description while adding another and the count is unchanged, so the gate
exits 0 while a brand-new warning exists (`check-openapi-lint-budget.mjs:19-27`).
Each entry's identity is the tuple `{severity, code, path, message}`, compared
as a sorted **multiset**. `range`, `source`, and `documentationUrl` are excluded
from identity on purpose — they move without the finding changing, and dropping
`range` is what makes the file immune to CRLF (`:29-34`).

Both directions fail: a new finding is printed by name, and a *resolved* entry
also fails, because a stale line would let the same finding return at the same
path and hide behind it. Prune with `npm run openapi:lint-budget -- --write`.
**Errors are never baselined** — any severity-0 result exits 1, and that check
sits above the `--write` branch (`:194-211`) so it cannot be laundered into the
manifest. The baseline only ever shrinks.

## Running

### First-time setup (every clone)
```bash
npm install               # node_modules/ is gitignored; must run after fresh clone
cp .env.example .env      # fill in JWT_SECRET, DATABASE_URL, API_KEY at minimum
```

> **Note (post-2026-04-18):** `node_modules/` was previously checked into this
> repo and was untracked in PR #45. Existing clones keep their working-copy
> `node_modules/` (unaffected by the untrack), but any `git clean -fd` or
> fresh clone will need `npm install` to repopulate it. Fresh Jest/test runs
> also need deps installed.

### Running
```bash
npm run dev               # Development with nodemon on :5000
lefthook install          # one-time; wires the pre-commit/pre-push hooks this repo ships
```

Production is Kubernetes-managed; see [`../../docs/DEPLOYMENT_GUIDE.md`](../../docs/DEPLOYMENT_GUIDE.md).
Local dev still uses `npm run dev` (nodemon). Images are built by GitHub
Actions and pulled by a `Deployment` in namespace `vhhealth`; ArgoCD reconciles
the manifests under `infra/kubernetes/apps/backend/` once an operator syncs.

Public URL: `https://api.vhhealth.app` — traffic path is Cloudflare Tunnel →
ingress-nginx → `Service/vhhealth-backend` in cluster.

## Testing

Run jest on **Node 26.5.0** — see the Runtime bullet above. An older interpreter
fabricates failures in this corpus.

```bash
# All tests
node --experimental-vm-modules node_modules/jest/bin/jest.js --forceExit

# Authorization tests only (IDOR, JWT validation, rate limiting)
node --experimental-vm-modules node_modules/jest/bin/jest.js authorization --forceExit

# Critical path tests only
node --experimental-vm-modules node_modules/jest/bin/jest.js critical-paths --forceExit
```

### Authorization Test Coverage

The IDOR contract is split across two files, and the split is the point: one
proves nobody else gets in, the other proves the owner still does. Reading only
the first and concluding "IDOR is covered" is how a broken allow-path ships.

**`src/tests/authorization.test.js` — the DENIAL half.** Seeds nothing; each
IDOR case targets an id that does not exist (asserting the exact 404) or an RBAC
gate that fires before any lookup.
- Appointment IDOR (PUT/DELETE — cross-user request never returns 200)
- Patient record IDOR (DELETE scoped by `patient_id`)
- Pharmacy order authorization (RBAC gating)
- Notification authorization (role-based access)
- JWT validation (expired → `TOKEN_EXPIRED`, tampered → `TOKEN_INVALID`, missing → 401)
- Rate limiting (OTP: 3/phone/10min, SOS: 3/user/hour)

**`src/tests/appointment-record-owner-access.deep.test.js` — the ALLOW half.**
Seeds its own tenant, an owning patient, a stranger patient and a doctor, then
asserts both halves against the *same* rows: the owner gets 200 on
`PUT /appointments/:id`, `DELETE /appointments/:id` and
`DELETE /appointments/patient/records/:id`, and the stranger does not — so a
denial there is provably "not yours" rather than "does not exist". Needs
Postgres; self-skips when `DATABASE_URL`/`TEST_DATABASE_URL` are unset.

These three owner cases previously sat in `authorization.test.js` as bodiless
`it.skip` stubs labelled "requires test DB". The database was never the blocker
— the exact-404 assertions in that file already query a real Postgres — the
missing fixture ownership was. Do not re-introduce bodiless placeholders: a
skipped empty test reads as coverage and is not. `scripts/jest-skip-floor.json`
is the audited register of every remaining skip.

## Database Access

Two native Postgres 17 clusters cohabit this dev box (the Windows
service on `:5432` is the default install — leave it alone, it owns
nothing of ours):

| Cluster | Port | DB / Role | PGDATA | Purpose |
|---|---|---|---|---|
| Dev | 5433 | `vhhealth` / `vhhealth` | `D:/Dev/Tools/pgdata-vhhealth` | `npm run dev`, drift check, day-to-day |
| QA | 55432 | `vhhealth_test` / `qa_writer` | `D:/Dev/Tools/vhhealth-test-postgres-data` | jest deep suites (`jest.setup.cjs` default), per-session scratch DBs |

### Dev cluster

```bash
# Start once per Windows boot:
"C:/Program Files/PostgreSQL/17/bin/pg_ctl" \
  -D "D:/Dev/Tools/pgdata-vhhealth" \
  -o "-p 5433" \
  -l "D:/Dev/Tools/pgdata-vhhealth/logfile" \
  start
psql -h localhost -p 5433 -U vhhealth -d vhhealth
```

### QA cluster

The QA cluster is what `jest.setup.cjs` defaults `DATABASE_URL` to
(`127.0.0.1:55432`), and where sessions build isolated throwaway
databases (`CREATE DATABASE` → pgvector → `ci-setup-db.mjs`) for
CI-faithful verification. (The `qa-orchestrator.mjs` / `qa-reset.mjs`
scripts referenced here historically no longer exist.) Bring it up
with the idempotent script:

```bash
node apps/backend/scripts/qa-cluster-up.mjs
# → QA cluster ready at postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test
```

The script starts postgres if it isn't already up, creates the
`vhhealth_test` DB + `qa_writer` role + grants if missing, applies
pending `src/migrations/*.sql` via `ci-setup-db.mjs`, and verifies a
Windows-side `qa_writer` connect. Re-running against a healthy
cluster is a fast no-op.

**Scratch-database hygiene.** Sessions that build throwaway databases
on this cluster must drop them when done. Left behind, they compound:
by 2026-07-28 the cluster had accumulated 155 databases and its
post-crash `syncing data directory (fsync)` pass took 10–20+ minutes
before accepting connections. Sweep with:

```bash
node apps/backend/scripts/qa-scratch-db.mjs list
node apps/backend/scripts/qa-scratch-db.mjs prune          # dry run
node apps/backend/scripts/qa-scratch-db.mjs prune --yes    # drop for real
```

`prune` never touches `postgres`, `vhhealth_test`, or templates, skips
databases with live connections (unless `--include-active`) and anything
written to in the last 3 days (`--max-age-days`), and is a dry run
without `--yes`. Selection policy is pinned by
`src/tests/unit/qaScratchDbPrune.test.js`. Point it at a non-default
port with `--url` / `QA_ADMIN_DATABASE_URL` when WinNAT has stolen
55432 and the cluster is running on a low port.

**IPv6 bind caveat (Trenzalore, 2026-05-13).** On this host postgres
fails to bind `::1:55432` with `Permission denied` even though .NET
and Node bind the same address fine. Some WFP / Hyper-V / WinNAT
component holds an invisible IPv6 reservation that `netsh int ipv6
show excludedportrange` does not list. Adjacent ports (5433, 55430,
55433, 56432, 5435) and the dev cluster bind both families with no
trouble — only port 55432 specifically. We work around it two ways:
the QA cluster's `postgresql.conf` is pinned to `listen_addresses =
'127.0.0.1'`, and `qa-cluster-up.mjs` also passes `-o "-p 55432 -h
127.0.0.1"` to `pg_ctl` so any manual restart still binds IPv4-only.
Do **not** revert the conf or drop the `-h 127.0.0.1`; the failure
mode is silent (cluster comes partway up then exits, refuses
connections, no other diagnostic beyond the log line `could not bind
IPv6 address "::1": Permission denied`).

**WinNAT dynamic exclusion ranges (2026-07-01, recurred 2026-07-28).**
Distinct from the IPv6 caveat: after a WinNAT service restart or a
reboot, Windows reserves random high-port TCP ranges (inspect with
`netsh int ipv4 show excludedportrange protocol=tcp`) and 55432 can
land inside one — `pg_ctl` then fails with `could not bind IPv4
address "127.0.0.1": Permission denied` with nothing listening.
`qa-cluster-up.mjs` pre-flights this (plus "a postmaster from this
PGDATA is already running on another port" and "cluster is mid
crash-recovery") via `scripts/lib/qaPortDiagnostics.mjs` and prints
the exact remediation: elevated `net stop winnat && net start winnat`,
reboot, or the no-admin low-port fallback
`VHHEALTH_TEST_DB_PORT=15432 node apps/backend/scripts/qa-cluster-up.mjs`
(ports below 47001 stay outside the dynamic pool; point jest at the
same port via `DATABASE_URL`/`TEST_DATABASE_URL`). A slow first start
after an unclean shutdown is a real fsync/redo pass — progress, not a
hang; `VHHEALTH_TEST_DB_START_TIMEOUT_S` (default 300) bounds the
wait. Classification behaviour is pinned by
`src/tests/unit/qaPortDiagnostics.test.js`.

## Sibling apps (same monorepo)

See the [root `CLAUDE.md`](../../CLAUDE.md) for the cross-stack layout. Other apps in the same repo:

- `apps/patient` — Flutter patient app
- `apps/staff` — Flutter staff app
- `apps/admin` — Next.js admin portal
- `packages/vhhealth_core` — shared Dart package

The five separate source repos these were merged from are archived on GitHub as of 2026-04-18.

## Conventions
- Use `logger.info/warn/error()` (Winston), never `console.log` in production code
- Use `success(res, data, message)` / `error(res, message, statusCode)` for ALL API responses — no raw `res.json()`
- Use `normalizePhone()` from `src/utils/phoneUtils.js` for all phone inputs
- Always use explicit column names in SELECT (no `SELECT *`) — never return `pwd`, `pin_hash` to clients
- Add `@@index` to Prisma schema when adding new query patterns
- Controllers are thin — business logic goes in services. No inline handlers in route files.
- Validate inputs with express-validator in `src/validators/`
- Sanitize user text inputs with `sanitizeBody()` / domain-specific middleware before DB writes
- Use `String()` comparison for ID equality checks (DB int vs JWT string)
- Use parameterized queries (`$1, $2`) — never template literals in SQL
- Never expose `err.message` to clients — log it server-side, return generic message
- All environment secrets must be set — app crashes on missing `JWT_SECRET`
- Request IDs propagated via `X-Request-Id` header for log correlation
- Throw `AppError` (from `src/utils/AppError.js`) instead of generic `Error` in services — includes statusCode, code, details
- Use role helpers from `src/utils/roleHelpers.js` (e.g. `isStaff()`, `isClinical()`) — never inline role arrays
- Security constants live in `src/config/securityConfig.js` — not hardcoded in services
- Use `prismaReadOnly` from `src/lib/prisma.js` for analytics/dashboards/exports (routes to read replica when configured)
- Never return fake success data in catch blocks — if the DB fails, return `error()` not `success()` with zeros
- Use `checkVitalAnomalies()` after recording vitals — generates clinical alerts for abnormal values
- Use `validatePrescriptionSafety()` before saving prescriptions — checks allergies and duplicates
- Use `maskPhone()`/`maskName()` from `src/utils/piiMask.js` when logging user data — never log raw PII
- All cron jobs must use `withJobLock()` wrapper and `await` all async calls
- External services (R2, Firebase) must degrade gracefully — never crash at import time

## Security Checklist (for PRs)
- [ ] No `SELECT *` — explicit columns only, never return `pwd`/`pin_hash`/`encrypted_password`
- [ ] No `err.message` in API responses — use `AppError` (not raw `new Error()`), generic messages in production
- [ ] IDOR check on any endpoint that mutates a specific resource — use `String()` comparison
- [ ] Input sanitization on any user-provided text field — use `sanitizeBody()` middleware
- [ ] File uploads validated with `validateFileContent` + `validatePatientUpload`
- [ ] Rate limiting on any endpoint that triggers external actions (OTP, SOS, email)
- [ ] Parameterized queries (`$1, $2`) — never template literals in SQL (including `INTERVAL`)
- [ ] New env vars added to `validateEnv.js`
- [ ] All API responses use `success()`/`error()` helpers — no raw `res.json()` or `res.status().json()`
- [ ] No `console.log` — use Winston `logger.info/warn/error()`
- [ ] API key compared with `crypto.timingSafeEqual()` — no `===`/`!==`
- [ ] No hardcoded secrets or OTPs — crash on missing env vars, never fallback
- [ ] PHI endpoints must have `phiAccessLogger()` middleware or explicit `logPhiAccess()` call
- [ ] Auth failures must call `logSecurityEvent()` — use `SecurityEvents.*` convenience methods
- [ ] New login paths must include `_checkStaffLockout()` or equivalent lockout check
- [ ] Tokens must include `jti` claim (automatic via `generateToken()`)
- [ ] Logout must blacklist the token (automatic via `authService.logout()`)
- [ ] Security constants in `src/config/securityConfig.js` — never hardcoded in services


## Phase 0.5 conventions (added 2026-04-15)

Locked-in patterns from the drift-fix pass. Read first when touching raw
SQL, JWT auth, or test infrastructure:

- **Raw Prisma calls take SPREAD args, never an array.**
  `prisma.$queryRawUnsafe(sql, ...params)` — passing `[a, b, c]` as the
  second arg makes the array a single bound value and every `$2+`
  placeholder goes unbound. ESLint rule + `npm run lint:raw-params` block
  the regression. Codemod at `scripts/fix-raw-params.mjs` if you ever
  need to migrate new code.
  **Lint blind spot (2026-05-12):** the lint rule catches inline literals
  `(sql, [a, b])` but not the variable form `(sql, params)` where
  `params` is an array. That form passes lint and silently binds the
  whole array as `$1`. Wave 1.5 found 8 such sites in
  `appointmentAdminRoutes.js` that had survived multiple lint runs
  (commit `d27d79b9`). On any raw-SQL change, grep for `(sql, \w+\)`
  and verify the variable is spread at the call site or the function
  signature already spreads it.
- **Params inside `jsonb_build_object` / `jsonb_build_array` need explicit
  `::type` casts.** A bare `$N` used as a VALUE in these builders has no
  inferable type (the signature is `VARIADIC "any"`), so the query fails at
  PARSE time with `42P08 could not determine data type of parameter $N`.
  Postgres names the LOWEST-numbered unresolved param, so a 42P08 on `$2` can
  actually require casting `$2`/`$4`/`$5`… When the call is best-effort /
  swallowed the request still returns 2xx, but the Prisma error listener in
  `src/lib/prisma.js` logs it centrally as `Prisma[primary] error` — so it can
  masquerade as an unrelated path's failure (to pinpoint, temporarily log
  `args[0]` + `new Error().stack` in the `wrapWithCircuitBreaker` catch, then
  revert). Tagged-template `` $queryRaw`…` `` is safe (Prisma sends typed
  values); only the `…Unsafe` forms are at risk. A param already cast elsewhere
  in the same query (e.g. `$2::int` in a WHERE) resolves once and is fine.
  `npm run lint:raw-params` catches this class too (added 2026-06-13). Reference
  fix: `transitionEncounter` in
  `services/clinical/canonicalClinicalPlatformService.js` — `status` is
  `VARCHAR(30)`, so `$2`/`$4`/`$5` became `::text`.
- **`req.user.id` is the int DB id**, surfaced by `jwtMiddleware` when the
  token carries `id`/`userId`/`user_id`. `req.user.uid` is the uuid.
  IDOR checks against integer FK columns (`appointments.patient_id`,
  `pharmacy_orders.patient_id`, etc.) should `String(req.user.id)`. Falls
  back to a uid→id DB lookup when the token is uid-only.
- **Schema is the source of truth, NOT the Prisma schema** — `prisma db
  push` only creates 69 of the ~170 tables tests need. The rest live in
  raw `migrations/*.sql`. CI applies them via `scripts/ci-setup-db.mjs`;
  do the same locally if you ever wipe the DB.
- **Postgres timezone matters.** Test data inserted via `NOW()` lands in
  the server's tz (IST in dev). When a test queries by date, fetch
  `current_date::text` from Postgres rather than computing JS UTC date —
  the two diverge at midnight UTC.
- **Tests assert exactly, never `[200, 500]`.** All shallow tests deleted
  2026-04-14. New tests go under `src/tests/*-deep.test.js` (integration)
  or `src/tests/unit/*.test.js` (pure functions).
- **HL7v2 escape decoding** lives in `services/hl7/hl7Parser.js#decodeHL7Escapes`.
  Apply to text fields (PID name, MSH names, addresses); skip date/code fields.
- **LOINC validation** via `services/hl7/loincValidator.js`. Strict mode =
  allowlist-only; non-strict = structural regex only.
- **Adherence ML** is heuristic by default. ONNX model loads from
  `models/adherence-risk.onnx` if present (training pipeline at
  `scripts/ml/`). Production response includes `source: 'heuristic' | 'onnx'`
  so callers can tell.
- **FHIR validator is two-tier.** Catches required-element +
  bound-value-set violations. CI's `fhir-conformance` job validates
  root-level samples in `src/services/fhir/__samples__/` informationally,
  and golden fixtures in `__samples__/golden/` strictly — golden failures
  (or a missing/empty `golden/` directory) fail CI. Slicing/terminology/
  profile invariants remain deferred to an official IG Publisher run.
- **RLS enforcement centres on `setTenant(tenantId, fn, { superAdmin })`**
  from `src/lib/prisma.js`. The callback receives a Prisma client scoped
  to a transaction with `SET LOCAL app.current_tenant_id = $1` already
  issued (via `set_config(..., true)` — auto-cleared at COMMIT/ROLLBACK,
  no pool-session leak).
  Use `setTenant` for any tenant-scoped read/write on the 11 tables
  listed in `migrations/075_tenant_rls_policies.sql`; pass
  `{ superAdmin: true }` to set the GUC to `'bypass'` for
  cross-tenant admin reads.
  - **On the continuity / external-interface-recovery tables, `setTenant` is
    mandatory rather than advisory, and `{ superAdmin: true }` does not help.**
    Migrations 600, 601, 603–606, 609–611 and 616 pair their permissive
    `tenant_isolation` policy with an `AS RESTRICTIVE` explicit-context policy
    and apply `FORCE ROW LEVEL SECURITY`. Restrictive policies AND together, and
    theirs requires `app.current_tenant_id` to be present, non-empty, **and not
    `'bypass'`** — so an unset context returns zero rows and fails writes
    instead of showing everything, and the owner exemption 075 relies on is
    gone. 606 stacks a further `app.current_facility_id` requirement. Reach for
    the migration-609 block (609:637-704) as the current template when adding a
    new tenant-scoped table; do **not** edit `075_tenant_rls_policies.sql` — it
    is already recorded in `_migrations` and will never re-run. Batch 31 deleted `DatabaseManager` and
  its `db.queryAsTenant()`; `src/tests/tenant-rls.deep.test.js` now
  calls `setTenant` + a local `ownerQuery` helper directly.
  - **Calling it yourself is no longer the only way it fires** (corrected
    2026-08-02 — this bullet previously read "Plain `prisma.$queryRaw*` bypasses
    RLS by design", which was batch-31-era wording and is wrong for production).
    `maybeRunUnderTenant` / `shouldTenantWrap` in `src/lib/prisma.js` auto-wrap
    the raw-SQL methods (`$queryRaw`, `$queryRawUnsafe`, `$executeRaw`,
    `$executeRawUnsafe`) **and** model-delegate calls
    (`prisma.appointments.findMany(...)`) in `setTenant` when **all** of:
    `isTenantRlsEnforcementEnabled()` is true (`src/config/tenantRlsConfig.js`
    — `AUTH_ENFORCE_TENANT_RLS` when explicitly set, else
    `NODE_ENV === 'production'`; prod sets it `"true"` in
    `infra/kubernetes/apps/backend/configmap.yaml`); an AsyncLocalStorage tenant
    context is active (seeded per request by `tenantRlsMiddleware`; cron and
    bootstrap code must opt in via `runInTenantContext()` / `runWithSuperAdmin()`
    from `src/lib/tenantContext.js`); that context carries a `tenantId` or
    `superAdmin`; and the call is not already inside a `setTenant` transaction.
    Everything else passes through unwrapped — including calls on the `tx`
    client inside a plain `prisma.$transaction(async (tx) => ...)`, which cannot
    nest another transaction.
  - **Dev, QA and CI leave the flag off**, so their queries are unwrapped, the
    GUC stays unset, and 075's policy hits its permissive branch — no scoping at
    all. Rate an unscoped query accordingly: it is neither automatically a live
    prod leak nor safe locally. Check the flag first (mis-reading this bullet
    overstated the severity in the PR #684 brief).
  - **An explicit `AND tenant_id = $1::uuid` predicate remains the house
    pattern** wherever scoping has to be *provable* (PR #684). It holds in every
    environment and a test can observe it, whereas adding `setTenant` to a
    request-path call changes nothing in prod (the proxy already wrapped it) and
    is inert in dev/QA/CI — flag off, plus 075 deliberately omits `FORCE ROW
    LEVEL SECURITY`, so the table owner is exempt and CI connects as `vhhealth`,
    which both owns the tables and is the service container's superuser.

## Future Directions

Use [`../../docs/ROADMAP.md`](../../docs/ROADMAP.md) (the single consolidated
list of pending work), [`../../docs/RELEASE_READINESS.md`](../../docs/RELEASE_READINESS.md),
and [`../../docs/DB_SCHEMA_GUARDRAILS.md`](../../docs/DB_SCHEMA_GUARDRAILS.md)
for current priorities and gates. [`../../AUDIT.md`](../../AUDIT.md) and
[`../../SESSION_HANDOFF.md`](../../SESSION_HANDOFF.md) are useful historical
snapshots, but verify current state before acting.
