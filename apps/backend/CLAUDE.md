# CLAUDE.md — VHHealth Backend

## Project Overview
Node.js/Express REST API backend for the VHHealth hospital management system. Serves three clients: patient Flutter app, staff Flutter app, and Next.js admin portal.

## Deployment

Production runs on a **3-node on-prem RKE2 Kubernetes cluster** inside the
hospital. Container images are built + signed + pushed by GitHub Actions;
ArgoCD watches this repo and auto-syncs Kustomize overlays onto the cluster.
Postgres is a CloudNativePG cluster (PG17, 3 replicas); ingress is Cloudflare
Tunnel → ingress-nginx, so zero inbound ports on the hospital firewall.

See the full runbook in [`../../docs/DEPLOYMENT_GUIDE.md`](../../docs/DEPLOYMENT_GUIDE.md)
and hardware spec in [`../../docs/HARDWARE_REQUIREMENTS.md`](../../docs/HARDWARE_REQUIREMENTS.md).

## Tech Stack
- **Runtime**: Node.js 22, Express 5
- **Database**: PostgreSQL 17 native install (dev cluster at `D:\Dev\Tools\pgdata-vhhealth` on port **5433**, user `vhhealth`, db `vhhealth`). Prod runs managed Postgres; both speak the same wire protocol.
- **ORM**: Prisma is the canonical DB client — `src/lib/prisma.js` exports `prisma`, `prismaReadOnly`, `setTenant`, `circuitBreakerStatus`. Residual `$queryRaw*` call sites (~35 as of the latest migration pass) + the per-domain typed ORM migrations (batches 26–38) all run through it. `src/config/database.js` / `DatabaseManager` were **deleted in batch 31** — do not try to import them.
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
prisma/schema.prisma  # 527 models, canonical schema source (regenerated after each migration)
```

## Key Architecture Decisions
- **Prisma client is the canonical DB path.** Residual raw-SQL call sites (approximately 35, down from the original 288+) use `prisma.$queryRaw*` / `$executeRaw*` from `src/lib/prisma.js`. The singleton is hardened at the edge (circuit breaker after 5 consecutive failures, >1000ms slow-query logging in every env) — every raw-SQL call inherits that automatically. New code: use `prisma` for reads/writes, `prismaReadOnly` for analytics / dashboards / exports (falls back to primary when `DATABASE_READ_URL` unset), and `setTenant(tenantId, fn, { superAdmin })` to wrap queries under RLS tenant scope (migration 075).
- **DatabaseManager shim is gone.** `src/config/database.js` was deleted in batch 31 after every consumer (app.js root probe, bin/www.js shutdown, prometheusMiddleware, jest.teardown, tenant-rls deep test, uptimeRoutes) was ported to `prisma` directly. Do not try to re-add a shim; use `prisma.$queryRaw` / `prisma.$executeRaw` + the helpers on `src/lib/prisma.js` (setTenant, prismaReadOnly, circuitBreakerStatus).
- **Schema drift check in CI.** `apps/backend/scripts/check-schema-drift.mjs` diffs `prisma/schema.prisma` against a fresh `prisma db pull` of the test DB after migrations. Surfaces batch-18/22-class bugs (`ordered_date` vs `requested_at`) at review time. Local check: `npm --prefix apps/backend run check:schema-drift`.
- **Raw SQL migrations are the source of truth (2026-05-12).** `prisma db push` was removed from CI and `ensure-test-db.mjs` after the post-migration DB grew Postgres features (GENERATED columns, column-reference DEFAULTs, sequence-referencing defaults) that Prisma can no longer emit declaratively. The new flow: `src/migrations/000_baseline.sql` (a `pg_dump --schema-only` of a clean QA DB) bootstraps the public schema; `001+` apply the deltas; `prisma/schema.prisma` is **regenerated via `npx prisma db pull`** after any migration that touches a Prisma-modelled table. The two files commit together, and the drift check now fails CI if they ever disagree. Adding a new migration: write the `.sql`, run `node scripts/qa-reset.mjs` (or any equivalent fresh DB), `npx prisma db pull --schema=prisma/schema.prisma`, then `node scripts/check-schema-drift.mjs` to confirm. Design comments (`//`, not `///`) that `prisma db pull` strips on regeneration are preserved in `prisma/SCHEMA_NOTES.md`.
- **Migrations are tracker-driven.** Both the boot-time runner (`src/utils/migrations/runMigrations.js`) and `scripts/ci-setup-db.mjs` consult the `_migrations` table and skip any file already recorded there. Add new migrations as bare DDL files in `src/migrations/NNN_*.sql` — each applies exactly once per DB. `ci-setup-db.mjs` also auto-detects a pre-existing baseline schema (probes for `users` + `appointments` + `admissions`) and records `000_baseline.sql` without re-running its non-idempotent `CREATE FUNCTION` DDL. Re-running `node scripts/ci-setup-db.mjs` against any populated DB is safe and fast. `scripts/smoke-migration-runner.mjs` exercises fresh-apply / re-run / truncate-tracker paths against a throwaway DB.
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
- **Notification outbox**: Use `notificationOutbox.queue()` from `src/utils/notifications/notificationOutbox.js` to persist notification intent before sending. Failed notifications can be retried by background jobs.
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
- **Security webhooks**: `securityWebhook.js` sends Slack/PagerDuty alerts for critical events (ACCOUNT_LOCKED, BRUTE_FORCE_DETECTED).

## Security Architecture

### Rate Limiting
| Profile | Window | Max | Applied To |
|---------|--------|-----|------------|
| patient | 15min | 100 | /users, /appointments, /records, /feedback |
| staff | 15min | 500 | /staff/* |
| admin | 15min | 100 | /admin/*, /system/*, /logs/* |
| auth | 15min | 5 per IP+account | /auth/admin/login, /auth/staff/login, /auth/staff/quick-login |
| otp | 10min | 3 per phone | /auth/firebase-login, /auth/request-otp |
| dashboard | 1min | 10 per IP | /dashboard |
| sos | 1hr | 3 per user | POST /sos/ |

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
- Notification outbox (`src/utils/notifications/notificationOutbox.js`) persists intent before sending
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

## Route Structure
Public (API key only): `/api/v1/auth/*`, `/api/v1/health`, `/api/v1/dashboard`
Protected (API key + JWT): `/api/v1/users/*`, `/api/v1/appointments/*`, `/api/v1/staff/*`
Admin only: `/api/v1/admin/*`, `/api/v1/system/*`, `/api/v1/logs/*`

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
the manifests under `infra/kubernetes/apps/backend/`.

Public URL: `https://api.vhhealth.app` — traffic path is Cloudflare Tunnel →
ingress-nginx → `Service/vhhealth-backend` in cluster.

## Testing
```bash
# All tests
node --experimental-vm-modules node_modules/jest/bin/jest.js --forceExit

# Authorization tests only (IDOR, JWT validation, rate limiting)
node --experimental-vm-modules node_modules/jest/bin/jest.js authorization --forceExit

# Critical path tests only
node --experimental-vm-modules node_modules/jest/bin/jest.js critical-paths --forceExit
```

### Authorization Test Coverage (`src/tests/authorization.test.js`)
- Appointment IDOR (PUT/DELETE ownership checks)
- Patient record IDOR (DELETE scoped by patient_id)
- Pharmacy order authorization (RBAC gating)
- Notification authorization (role-based access)
- JWT validation (expired → `TOKEN_EXPIRED`, tampered → `TOKEN_INVALID`, missing → 401)
- Rate limiting (OTP: 3/phone/10min, SOS: 3/user/hour)

### Route Health Monitoring
- `routeLoader.js` tracks failed routes via `getFailedRoutes()`
- Health checks can report which routes failed to load

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
- **FHIR validator is informational.** Catches required-element +
  bound-value-set violations. Slicing/terminology/profile invariants
  deferred to the official IG Publisher run in CI's `fhir-conformance`
  job (non-blocking; sample bundles in `src/services/fhir/__samples__/`).
- **RLS enforcement is opt-in via `setTenant(tenantId, fn, { superAdmin })`**
  from `src/lib/prisma.js`. The callback receives a Prisma client scoped
  to a transaction with `SET LOCAL app.current_tenant_id = $1` already
  issued (via `set_config(..., true)` — auto-cleared at COMMIT/ROLLBACK,
  no pool-session leak). Plain `prisma.$queryRaw*` bypasses RLS by design
  (matches the permissive policy in migration 075 when the GUC is unset).
  Use `setTenant` for any tenant-scoped read/write on the 11 tables
  listed in `migrations/075_tenant_rls_policies.sql`; pass
  `{ superAdmin: true }` to set the GUC to `'bypass'` for
  cross-tenant admin reads. Batch 31 deleted `DatabaseManager` and
  its `db.queryAsTenant()`; `src/tests/tenant-rls.deep.test.js` now
  calls `setTenant` + a local `ownerQuery` helper directly.

## Future Directions

Use [`../../docs/ROADMAP.md`](../../docs/ROADMAP.md) (the single consolidated
list of pending work), [`../../docs/RELEASE_READINESS.md`](../../docs/RELEASE_READINESS.md),
and [`../../docs/DB_SCHEMA_GUARDRAILS.md`](../../docs/DB_SCHEMA_GUARDRAILS.md)
for current priorities and gates. [`../../AUDIT.md`](../../AUDIT.md) and
[`../../SESSION_HANDOFF.md`](../../SESSION_HANDOFF.md) are useful historical
snapshots, but verify current state before acting.
