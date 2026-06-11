# VH Health Platform — System Architecture

> Single entry-point document for engineers joining the VH Health
> monorepo. The goal: read this ONE file end-to-end and you will know
> what runs where, how a request flows from phone to database, which
> guarantees are enforced at which layer, and which file to open when
> you need to change something.
>
> This document is a **pointer**, not a replacement. Every section ends
> with links to the per-app `CLAUDE.md`, runbook, or source file that
> carries the full detail.

---

## Table of contents

1. [Overview](#1-overview)
2. [Repository layout](#2-repository-layout)
3. [Runtime topology](#3-runtime-topology)
4. [Request lifecycle — backend](#4-request-lifecycle--backend)
5. [Authentication + authorization](#5-authentication--authorization)
6. [Multi-tenancy](#6-multi-tenancy)
7. [Data layer](#7-data-layer)
8. [Canonical clinical timeline](#8-canonical-clinical-timeline)
9. [Clinical-AI subsystem](#9-clinical-ai-subsystem)
10. [Deployment architecture](#10-deployment-architecture)
11. [CI/CD + supply chain](#11-cicd--supply-chain)
12. [Observability + ops](#12-observability--ops)
13. [Where to look when…](#13-where-to-look-when)

---

## 1. Overview

VH Health is a hospital management platform for Venkataeswara Hospital
(Chennai). It is **five codebases in one monorepo** — a Node/Express
REST API, a Next.js admin portal, two Flutter mobile apps (patient +
staff), and the shared Dart package they consume. The five source
repos were merged via `git subtree add` on 2026-04-18; full
pre-monorepo history is preserved. See [`CLAUDE.md`](../CLAUDE.md) for
the merge record and tag convention.

The platform has three distinct user populations:

- **Patients** — mobile app ([`apps/patient`](../apps/patient)). Firebase OTP login, 7-day JWT. Books appointments, views records, orders pharmacy, triggers SOS.
- **Staff** — mobile app ([`apps/staff`](../apps/staff)). Employee ID + password/PIN login, 8-hour JWT + 30-day refresh. Attendance, leave, appointment confirmation, investigation uploads, pharmacy order management.
- **Admins / super-admins** — web portal ([`apps/admin`](../apps/admin)). Username + password login, 4-hour JWT in an httpOnly cookie. Manages tenants, staff, departments, pharmacy, reporting, and the full clinical-AI review queue. MFA (TOTP) is mandatory for `SUPER_ADMIN` in production.

Production runs on a **3-node on-prem RKE2 Kubernetes cluster** inside
the hospital, with **CloudNativePG** running a PostgreSQL 17 cluster
(3 replicas, synchronous replication). Deploys are **GitOps via
ArgoCD**: GitHub Actions builds, signs, and pushes container images to
GHCR; ArgoCD watches this repo and auto-syncs Kustomize overlays. All
external traffic arrives via **Cloudflare Tunnel → ingress-nginx →
Service**, so the hospital firewall has zero inbound ports open. Full
runbook: [`docs/DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md).

---

## 2. Repository layout

From root [`CLAUDE.md`](../CLAUDE.md):

| Path | Stack | Role |
|---|---|---|
| [`apps/backend`](../apps/backend) | Node.js 22 + Express 5 + PostgreSQL 17 (raw `pg`) | REST API consumed by every client |
| [`apps/admin`](../apps/admin) | Next.js 15 + React 19 + TypeScript | Admin/super-admin web portal |
| [`apps/patient`](../apps/patient) | Flutter 3.41 + Firebase OTP | Patient mobile app |
| [`apps/staff`](../apps/staff) | Flutter 3.41 + staff JWT | Staff/clinical mobile app |
| [`packages/vhhealth_core`](../packages/vhhealth_core) | Dart shared package | API client, auth, theme, HTTP client |

### Subtree merge history (2026-04-18)

Four subtree merges landed on 2026-04-18 — the earlier Flutter-side
migration (three repos, old monorepo) followed by a same-day
backend + admin merge that produced this full-stack monorepo:

```
packages/vhhealth_core   ← Bahuleyandr/vhhealth-core
apps/patient             ← Bahuleyandr/VH-health
apps/staff               ← Bahuleyandr/VHhealth-staff
apps/backend             ← Bahuleyandr/VH-health-backend
apps/admin               ← Bahuleyandr/VH-Health-Adminportal
```

All five source repos are archived on GitHub. Pre-monorepo history is
walkable via `git log apps/<path>/`. Current engineering work should use only
the monorepo paths under `apps/` and `packages/`.

### Per-app documentation

Each app keeps its own `CLAUDE.md`:

- [`apps/backend/CLAUDE.md`](../apps/backend/CLAUDE.md) — API structure, auth, security, raw-`pg` DB patterns, HIPAA/PHI logging
- [`apps/admin/CLAUDE.md`](../apps/admin/CLAUDE.md) — Next.js routing, httpOnly-cookie auth, `fetchAdminAPI`, god-page refactor pattern
- [`apps/patient/CLAUDE.md`](../apps/patient/CLAUDE.md) — routes, Firebase OTP flow, status enums, endpoint map
- [`apps/staff/CLAUDE.md`](../apps/staff/CLAUDE.md) — staff auth, offline queue, role config
- [`packages/vhhealth_core/CLAUDE.md`](../packages/vhhealth_core/CLAUDE.md) — shared contracts

---

## 3. Runtime topology

### External → internal traffic path

```
                    [Cloudflare Edge]
                           |
                           | 443 outbound only (tunnel)
                           |  no inbound ports on hospital firewall
       +-------------------+-------------------+
       |                                       |
  patient app (Flutter)                   admin web (Next.js SSR in-cluster)
  staff app (Flutter)                          |
       |                                       |
       v                                       v
  +----------------------------------------------------------+
  |   cloudflared Deployment (pods — 4 replicas in prod)     |
  |   vhhealth-ingress namespace                             |
  +----------------------------------------------------------+
                              |
                              v
  +----------------------------------------------------------+
  |   ingress-nginx DaemonSet (runs on all 3 nodes)          |
  |   ingress-nginx namespace                                |
  |   TLS terminated at Cloudflare; internal 443 (self-cert) |
  +----------------------------------------------------------+
             |                                   |
             v                                   v
  +--------------------------+       +-------------------------+
  | Service/vhhealth-backend |       | Service/vhhealth-admin  |
  |   :5000  Node/Express    |       |   :3001  Next.js        |
  |   namespace: vhhealth    |       |   namespace: vhhealth   |
  +--------------------------+       +-------------------------+
         |        |        \                    |
         |        |         \                   | (server-side proxy
         |        |          \                  |  /api/proxy/* with
         |        |           \                 |   BACKEND_API_KEY)
         |        |            \                |
         v        v             \--------------->
  +----------------+  +------------------+  +-------------------+
  | CNPG Postgres  |  | Redis Sentinel   |  | Cloudflare R2     |
  | vhhealth-pg-rw |  | redis-sentinel   |  | (S3-compatible)   |
  |  primary + 2   |  | (blacklist/rate  |  | bucket:           |
  |  streaming     |  |  limit cache)    |  |   vh-health-      |
  |  replicas      |  |                  |  |   records         |
  | pg17 / sync    |  |                  |  |                   |
  | namespace:     |  | namespace:       |  | offsite; primary  |
  | vhhealth-      |  | vhhealth-        |  | object store +    |
  | platform       |  | platform         |  | backup target     |
  +----------------+  +------------------+  +-------------------+
```

Notes:

- **No inbound ports.** Cloudflared dials out to Cloudflare's edge;
  tunnel ingress proxies back through the same outbound session.
- **Admin portal is server-rendered**: the browser hits Next.js
  (`admin.vhhealth.app`), which does server-side proxying of API calls
  via `/api/proxy/*`. The backend API key never reaches the browser —
  it lives in the `BACKEND_API_KEY` env var the Next.js server reads
  at request time. See [`apps/admin/CLAUDE.md`](../apps/admin/CLAUDE.md).
- **Internal DNS**: `vhhealth-pg-rw.vhhealth-platform.svc.cluster.local`
  (primary, writes), `vhhealth-pg-ro.vhhealth-platform.svc.cluster.local`
  (replicas, reads). Set in
  [`infra/kubernetes/overlays/prod/kustomization.yaml`](../infra/kubernetes/overlays/prod/kustomization.yaml).
- **MinIO** lives in-cluster (`vhhealth-platform` namespace) as the
  CNPG backup sink; R2 is the offsite replica. CNPG snapshots land in
  both.
- **Backup flow**: CNPG → pgBackRest → MinIO (in-cluster, AES-256
  encrypted) → R2 (offsite, Asia-Pac region pinned).

The `/` and `/health` endpoints on the backend are public (genericly
rate-limited); everything else requires API key + JWT unless noted in
the middleware chain below.

---

## 4. Request lifecycle — backend

All HTTP traffic to the API terminates in [`apps/backend/src/app.js`](../apps/backend/src/app.js).
The middleware chain from that file, in order (lines 223–367 are the
load-bearing section to read):

| # | Middleware | File | What it does |
|---|---|---|---|
| 1 | `helmet` | app.js:227 | CSP, HSTS 1yr preload, no-frame. |
| 2 | HTTPS redirect (prod only) | app.js:249 | `x-forwarded-proto` check; 301 → https. |
| 3 | `compression` | app.js:258 | gzip responses > 1KB. |
| 4 | `requestIdMiddleware` | [`src/middleware/requestIdMiddleware.js`](../apps/backend/src/middleware/requestIdMiddleware.js) | Sets `req.id` (uuid or `X-Request-Id` echo); propagates on response header. |
| 5 | `sentryScopeMiddleware` | sentry | Attaches request scope for tracing. |
| 6 | `apiVersionMiddleware` | [`src/middleware/apiVersionMiddleware.js`](../apps/backend/src/middleware/apiVersionMiddleware.js) | Reads `Accept-Version`, sets `req.apiVersion`. |
| 7 | `express.json` / `urlencoded` | app.js:262 | Body parsing, 1 MB limit. |
| 8 | `corsMiddleware` | [`src/middleware/corsMiddleware.js`](../apps/backend/src/middleware/corsMiddleware.js) | Origin allowlist. |
| 9 | `loggingMiddleware` + `morganMiddleware` | [`src/logging/logger.js`](../apps/backend/src/logging/logger.js) | Winston + morgan. |
| 10 | `attachUserContext` | [`src/middleware/attachUserContext.js`](../apps/backend/src/middleware/attachUserContext.js) | Pre-JWT stub for audit correlation. |
| 11 | `auditLogMiddleware` | [`src/middleware/auditLog.js`](../apps/backend/src/middleware/auditLog.js) | Fire-and-forget universal audit capture; capped queue 1000; file fallback via Winston. |
| 12 | `selfHealingMiddleware` + `prometheusMiddleware` | ops | Pool pressure + metric counters. |
| 13 | `validateApiKey` | [`src/middleware/validateApiKey.js`](../apps/backend/src/middleware/validateApiKey.js) | Timing-safe per-client key compare; sets `req.apiClient` for audit. |
| 14 | `jwtAuth` | [`src/middleware/jwtMiddleware.js`](../apps/backend/src/middleware/jwtMiddleware.js) | Verifies signature/expiry, checks blacklist, checks force-logout revocation, normalizes role (SUPER_ADMIN→ADMIN, NURSE→NURSING_STAFF), sets `req.user = { uid, id, role, rawRole, roles?, phone?, email?, tenant_id, scope }`. |
| 15 | `enforceFullScope` | [`src/middleware/jwtMiddleware.js:179`](../apps/backend/src/middleware/jwtMiddleware.js) | Rejects tokens with `scope !== 'full'` (i.e. narrow-scope `mfa_setup` tokens). Returns 403 `INSUFFICIENT_SCOPE`. |
| 16 | `tenantContextMiddleware` | [`src/middleware/tenantContextMiddleware.js`](../apps/backend/src/middleware/tenantContextMiddleware.js) | Resolves `req.tenantId` (JWT claim → `x-tenant-id` header for SUPER_ADMIN → `users.tenant_id` lookup → `DEFAULT_TENANT_ID`). Blocks non-SUPER_ADMIN if tenant is not `active`. |
| 17 | `normalizeIdentityFields` | [`src/middleware/normalizeIdentityFields.js`](../apps/backend/src/middleware/normalizeIdentityFields.js) | Post-JWT uid/id normalization for int-FK comparisons. |
| 18 | Per-route rate limiter | [`src/middleware/rateLimitMiddleware.js`](../apps/backend/src/middleware/rateLimitMiddleware.js) | `patientRateLimiter`, `adminRateLimiter`, `authRateLimiter`, `otpRateLimiter`, `dashboardRateLimiter`, `sosRateLimiter`. |
| 19 | Per-domain sanitize middleware | [`src/middleware/sanitizeMiddleware.js`](../apps/backend/src/middleware/sanitizeMiddleware.js) | `stripHtml()` on user-facing text fields (profile, feedback, pharmacy, investigation, appointment, SOS). |
| 20 | RBAC — `requireRole(...)` or via `wrapAutoRBAC` | [`src/middleware/rbacMiddleware.js`](../apps/backend/src/middleware/rbacMiddleware.js), [`src/config/routeWrapper.js`](../apps/backend/src/config/routeWrapper.js) | Role-based access control. Double-guards on scope (narrow-scope tokens fail closed here too). SUPER_ADMIN bypasses role checks. |
| 21 | PHI access logger | [`src/middleware/phiAccessMiddleware.js`](../apps/backend/src/middleware/phiAccessMiddleware.js) | Auto-logs PHI access (who, patient, record type, action, IP, requestId). Fires only on 2xx/3xx. |
| 22 | Route handler (thin) → service → validator → DB | [`src/routes/`](../apps/backend/src/routes/), [`src/services/`](../apps/backend/src/services/) | Controllers are thin; business logic in services; validation via express-validator. |
| 23 | `corsErrorHandler` + `errorHandlerMiddleware` | [`src/middleware/errorHandlerMiddleware.js`](../apps/backend/src/middleware/errorHandlerMiddleware.js) | Global error handler; `AppError` structured responses; Sentry report; never leak `err.message` in production. |

### The MFA-setup exception

Two routes sit **before** the app-level `jwtAuth` call (line 360) and
run their own per-route auth:

- `POST /api/v1/auth/admin/mfa/setup-enroll`
- `POST /api/v1/auth/admin/mfa/setup-confirm`

Both are defined in
[`src/routes/auth/adminAuthRoutes.js:102-119`](../apps/backend/src/routes/auth/adminAuthRoutes.js).
They carry their own `jwtAuth` + `requireSetupScope` guards. These are
the ONLY endpoints that accept a `scope: 'mfa_setup'` token. The rest
of the app's `enforceFullScope` middleware (mounted immediately after
the global `jwtAuth`) rejects any narrow-scope token, so a setup-scope
token leaking past the enrollment flow is contained. The `rbacMiddleware`
also rechecks scope as defence in depth
([`rbacMiddleware.js:24-42`](../apps/backend/src/middleware/rbacMiddleware.js)).

Read lines 300–400 of [`app.js`](../apps/backend/src/app.js) carefully —
the ordering between the public API-key-only routes (dashboard, config,
HL7 `/receive`), the global `jwtAuth + enforceFullScope +
tenantContextMiddleware` mount, and the downstream role-gated routes
is what makes this whole model work.

---

## 5. Authentication + authorization

### Login flows by client

| Client | Identity | Endpoint | Access token | Refresh token | Storage |
|---|---|---|---|---|---|
| Patient | Firebase OTP | `POST /api/v1/auth/firebase/firebase-login` | JWT, 7 days | n/a (stateless rotation on request) | `flutter_secure_storage` key `jwt` |
| Staff | Employee ID + password / PIN | `POST /api/v1/auth/staff/login` or `/login-pin` | JWT, 8 hours | opaque, 30 days | `flutter_secure_storage` key `staff_jwt` |
| Admin | Username + password | `POST /api/v1/auth/admin/login` | JWT, 4 hours | opaque, rotated in httpOnly cookie | **httpOnly `auth_token` cookie** (server-only, `Secure`, `SameSite=Strict`, 4 h) |

Source of truth: [`apps/backend/src/services/auth/authService.js`](../apps/backend/src/services/auth/authService.js).
Per-client behaviour is documented in each app's `CLAUDE.md`.

### Mandatory MFA for SUPER_ADMIN

In production the env flag `REQUIRE_MFA_FOR_SUPER_ADMIN !== 'false'`
is the default. The first-login branch in
[`authService.js:245-273`](../apps/backend/src/services/auth/authService.js)
detects `SUPER_ADMIN && !totp_enabled` and, instead of issuing a full
JWT, returns a **setup-scoped token**:

```
{
  requiresMfaSetup: true,
  setupToken: "<10-minute JWT, scope='mfa_setup'>",
  expiresIn: 600,
  admin: { uid, username }
}
```

The admin-portal `LoginClient` detects the `mfa_setup_required`
branch and renders a first-time enrollment panel:

1. QR code (for Google Authenticator / Authy / 1Password / Bitwarden).
2. 10 single-use backup codes — **shown exactly once**; only recovery path.
3. 6-digit authenticator code to finalise.

The client then exchanges the setup token at `/mfa/setup-enroll` (which
returns `encryptedSecret` + `backupCodes`), then `/mfa/setup-confirm`
(which persists the TOTP secret and issues the full JWT cookie). The
setup token is gated by `requireSetupScope` so it literally cannot
reach any other endpoint.

Subsequent logins with TOTP enabled take the normal two-step path:
password → `challengeToken` → `/auth/admin/totp/verify` → full JWT.

### Token scopes

Only two scopes exist today (`full`, `mfa_setup`) and they are load-bearing in three middleware:

| Guard | File | Behaviour |
|---|---|---|
| `jwtAuth` | [`jwtMiddleware.js:132`](../apps/backend/src/middleware/jwtMiddleware.js) | Sets `req.user.scope = decoded.scope === 'mfa_setup' ? 'mfa_setup' : 'full'`. |
| `enforceFullScope` | [`jwtMiddleware.js:179`](../apps/backend/src/middleware/jwtMiddleware.js) | Mounted **globally** right after `jwtAuth` (app.js:365). Rejects `scope !== 'full'` with 403 `INSUFFICIENT_SCOPE`. |
| `requireSetupScope` | [`jwtMiddleware.js:159`](../apps/backend/src/middleware/jwtMiddleware.js) | Mounted **only** on the two setup-enroll/confirm routes. Rejects anything other than `scope === 'mfa_setup'`. |
| `rbacMiddleware` | [`rbacMiddleware.js:24-42`](../apps/backend/src/middleware/rbacMiddleware.js) | Secondary scope check before role check — belt and braces. |

### JWT mechanics

- Signed HS256 with `JWT_SECRET` (Joi-required at startup, min 32 chars; `validateEnv.js` crashes otherwise).
- Every token carries `jti` (JWT ID) used for revocation; blacklist is Redis fast-path + DB (`invalidated_tokens`) fallback.
- Token rotation: on refresh the old `jti` is blacklisted before the new token issues.
- Force-logout: `revokeAllUserTokens(uid)` stamps a cutoff; `jwtMiddleware` rejects any token with `iat < cutoff` (`TOKEN_REVOKED`).
- Error codes returned to clients: `TOKEN_EXPIRED` / `TOKEN_INVALID` / `TOKEN_REVOKED` / `SETUP_SCOPE_REQUIRED` / `INSUFFICIENT_SCOPE`.

### API keys

Per-client keys via env: `API_KEY_PATIENT`, `API_KEY_STAFF`, `API_KEY_ADMIN`; shared `API_KEY` as fallback. Compared with `crypto.timingSafeEqual()` in [`validateApiKey.js`](../apps/backend/src/middleware/validateApiKey.js). The matched client is persisted on `req.apiClient` and used as an audit dimension — you can tell which front-end a call came from even when JWT is stripped.

### Rate-limit profiles

From [`apps/backend/src/middleware/rateLimitMiddleware.js`](../apps/backend/src/middleware/rateLimitMiddleware.js):

| Profile | Window | Max | Applied to |
|---|---|---|---|
| `patient` | 15 min | 100 | /users, /appointments, /records, /feedback |
| `staff` | 15 min | 500 | /staff/\* |
| `admin` | 15 min | 100 | /admin/\*, /system/\*, /logs/\* |
| `auth` | 15 min | 5 / (IP+account) | admin/staff login, quick-login |
| `otp` | 10 min | 3 / phone | firebase-login, request-otp |
| `dashboard` | 1 min | 10 / IP | /dashboard |
| `sos` | 1 hr | 3 / user | POST /sos/ |

Anomaly detection lives in [`src/utils/loginAnomalyDetector.js`](../apps/backend/src/utils/loginAnomalyDetector.js) — credential-stuffing (10+ accounts/IP), IP threat level, adaptive rate limiting. Critical events (ACCOUNT_LOCKED, BRUTE_FORCE_DETECTED) fire Slack/PagerDuty via [`securityWebhook.js`](../apps/backend/src/utils/securityWebhook.js).

---

## 6. Multi-tenancy

VH Health was built single-tenant and is mid-rollout to multi-tenant.
The current state is: **tenant_id columns + per-request tenant context
+ Postgres RLS at the policy layer, permissive when unset**. Full
migration of existing query sites to `queryAsTenant()` is deferred.

### Scope of RLS-enabled tables

Migration [`075_tenant_rls_policies.sql`](../apps/backend/src/migrations/075_tenant_rls_policies.sql)
enables row-level security on 11 tables:

```
users
clinical_ai_tenant_modules
clinical_ai_generations
clinical_ai_prompts
clinical_ai_reviews
clinical_ai_approvals
clinical_ai_context_snapshots
clinical_ai_safety_reviews
clinical_ai_break_glass_sessions
clinical_ai_bed_forecasts
clinical_ai_pharmacy_forecasts
```

Every row on those tables carries a `tenant_id uuid` column with
`DEFAULT_TENANT_ID` as the backstop for pre-multi-tenant rows (see
[`users_tenant_default.sql`](../apps/backend/src/migrations/030_user_tenant_default.sql)).

### RLS policy design — permissive when unset

The policy [`tenant_isolation`](../apps/backend/src/migrations/075_tenant_rls_policies.sql:55-69)
is intentionally permissive when `app.current_tenant_id` is NULL /
empty / `'bypass'`:

```sql
USING (
  current_setting('app.current_tenant_id', true) IS NULL
  OR current_setting('app.current_tenant_id', true) = ''
  OR current_setting('app.current_tenant_id', true) = 'bypass'
  OR tenant_id = app_current_tenant_id_uuid()
)
```

This is **opt-in defence-in-depth**: plain `prisma.$queryRaw*` calls
without tenant context continue to work (every row visible); modern
`setTenant(tenantId, fn, { superAdmin })` from
[`apps/backend/src/lib/prisma.js`](../apps/backend/src/lib/prisma.js)
wraps `fn(tx)` in a Prisma `$transaction` and issues `SELECT
set_config('app.current_tenant_id', $tenantId, true)` so only rows
matching that tenant are returned. SUPER_ADMIN cross-tenant reads
pass `{ superAdmin: true }`, which sets the GUC to `'bypass'` (the
third permissive branch).

The migration deliberately avoids `ALTER TABLE ... FORCE ROW LEVEL SECURITY`
so the DB-owner connection (used for future migrations) stays
exempt from its own policies.

### Request → tenant context resolution

[`tenantContextMiddleware.js:34-76`](../apps/backend/src/middleware/tenantContextMiddleware.js)
resolves `req.tenantId` in priority order:

1. **JWT claim** (`decoded.tenant_id` / `decoded.tenantId`) — set at token-issue time for new logins.
2. **`x-tenant-id` header**, but only if `req.user.role === 'SUPER_ADMIN'`. Lets platform operators debug cross-tenant without switching accounts.
3. **`users.tenant_id` lookup** keyed by `req.user.uid`.
4. **`DEFAULT_TENANT_ID`** — the single-tenant backwards-compatibility floor.

It also checks tenant status: if `tenant.status !== 'active'` and the
caller is not SUPER_ADMIN, the request fails closed. Resolved context
is exposed as `req.tenantId`, `req.tenant`, `req.user.tenantId`,
`req.user.tenantRegion`, `req.user.complianceProfile` downstream.

### `setTenant()` — opt-in usage

Per [`apps/backend/CLAUDE.md`](../apps/backend/CLAUDE.md) ("Phase 0.5 conventions"):

- Plain `prisma.$queryRaw*` **bypasses RLS** by design (permissive
  policy when the GUC is unset).
- New tenant-scoped reads/writes on the 11 RLS tables SHOULD use
  `setTenant(req.tenantId, (tx) => tx.$queryRaw`…`)` from
  `src/lib/prisma.js`.
- SUPER_ADMIN bypass: `{ superAdmin: true }` as 3rd arg.
- Full migration of existing query sites is planned in a follow-up batch.

POC sites already on `setTenant`: the clinical-AI admin surfaces under
[`apps/backend/src/routes/admin/clinicalAi/`](../apps/backend/src/routes/admin)
and the tenant module-toggle service. Everything else is on plain
`prisma.$queryRaw*` and relies on application-layer RBAC + tenant-id
WHERE clauses.

(The legacy `db.queryAsTenant()` shim on the `DatabaseManager` class
was deleted along with the shim in batch 31 — callers that used it
now call `setTenant` directly.)

---

## 7. Data layer

### Driver + query contract

All DB access flows through the hardened Prisma client at
[`apps/backend/src/lib/prisma.js`](../apps/backend/src/lib/prisma.js).
The earlier `DatabaseManager` / `src/config/database.js` pg.Pool wrapper
was retired in batches 28–31:

- Batch 23 hardened Prisma at the edge (circuit breaker, slow-query
  logs, prismaReadOnly).
- Batches 26–38 migrated domain writes + SELECT+JOIN reads from
  `$queryRaw` to typed Prisma ORM (`.upsert`, `.findMany` with
  `include`, `$transaction`).
- Batch 28 retired the pg.Pool; batch 31 deleted the whole
  `DatabaseManager` shim + `dbHealthMonitor`.

[`apps/backend/prisma/schema.prisma`](../apps/backend/prisma/schema.prisma)
is the **canonical** schema with 219 models (regen'd from the live
DB in batch 24). `prisma db pull` is the authoritative refresh path;
`apps/backend/scripts/check-schema-drift.mjs` fails CI if the
committed schema drifts from the DB.

Exports from `src/lib/prisma.js`:

| Export | Use |
|---|---|
| `prisma` | Write-path primary. Full Prisma client with circuit breaker + slow-log wrapped around every call. |
| `prismaReadOnly` | Analytics / exports / dashboards; routes to `DATABASE_READ_URL` when set, falls back to primary. |
| `setTenant(tenantId, fn, { superAdmin })` | Tenant-scoped writes/reads on RLS tables; runs `fn(tx)` in a `$transaction` with `app.current_tenant_id` set. |
| `circuitBreakerStatus()` | Ops probe; scraped by `/health/metrics`. |

### Resilience

- **30s `statement_timeout`** on every query (prevents pool exhaustion from runaway queries).
- **Circuit breaker**: after 5 consecutive failures, new queries reject immediately for 30s, then auto-resets half-open.
- **Slow-query logging**: queries > 1000 ms logged as warnings with duration + truncated SQL.
- **Pool error events** are logged (silent connection loss is noisy).
- **Read replica** via `prismaReadOnly` with primary fallback when `DATABASE_READ_URL` is unset.

### Schema + migrations

Raw SQL migrations live in [`apps/backend/src/migrations/`](../apps/backend/src/migrations/), numbered with a three-digit prefix (`001_`, `002_`, … currently through `075_`+). This is the **authoritative** migrations tree.

Older docs may mention a pre-merge `apps/backend/migrations/` directory. That
directory is no longer part of the current checkout; use `src/migrations/`.

CI runs [`scripts/ci-setup-db.mjs`](../apps/backend/scripts/ci-setup-db.mjs) after `prisma db push` to apply the raw migrations, because the Prisma schema only represents ~69 of the ~170 tables tests need. The remainder exist only as raw SQL.

### Test-DB sync — the RLS drop step

[`scripts/ensure-test-db.mjs`](../apps/backend/scripts/ensure-test-db.mjs)
is the local test-DB rebuild helper. The RLS migration enables a
policy that `prisma db push --accept-data-loss` then tries to drop as
part of its own policy reconciliation — which conflicts. The script
preemptively drops the 11 tenant_isolation policies (line 548+) before
calling `prisma db push`. If you wipe your local DB and see a "policy
already exists" or "cannot drop policy in current transaction" error
on schema-sync, start here.

### Production DB: CloudNativePG

Prod runs a **CloudNativePG (CNPG) Cluster** of PostgreSQL 17, 3
replicas, **synchronous streaming replication**, in the
`vhhealth-platform` namespace. See
[`infra/kubernetes/base/cnpg/`](../infra/kubernetes/base/cnpg/) for the
`Cluster` CRD manifest. Prod overlay bumps resource requests — 2 CPU,
4 Gi memory — per
[`infra/kubernetes/overlays/prod/kustomization.yaml:19-41`](../infra/kubernetes/overlays/prod/kustomization.yaml).

Backup is handled by CNPG's pgBackRest integration: AES-256 encrypted
archives to MinIO (in-cluster) with an offsite replica to Cloudflare
R2. Point-in-time recovery (PITR) is targetable via
`kubectl cnpg restore`. Runbook:
[`apps/backend/docs/RUNBOOKS/db-restore.md`](../apps/backend/docs/RUNBOOKS/db-restore.md).

Dev is a native Postgres 17 install at
`D:\Dev\Tools\pgdata-vhhealth` on port **5433**, user `vhhealth`, db
`vhhealth`. Tests run against a throwaway Postgres 16 service container
in CI.

---

## 8. Canonical clinical timeline

The canonical patient timeline is now a platform invariant. Feature/detail
tables still exist, but new OP/IP clinical workflows must also emit canonical
timeline and clinical audit events in the same transaction.

Durable implementation note:
[`docs/CANONICAL_CLINICAL_TIMELINE.md`](CANONICAL_CLINICAL_TIMELINE.md).

Core tables:

- `patient_encounters`
- `clinical_timeline_events`
- `clinical_audit_events`
- `workflow_sla_rules`
- `workflow_sla_instances`
- `medication_safety_reviews`

Core migration:
[`269_canonical_clinical_platform.sql`](../apps/backend/src/migrations/269_canonical_clinical_platform.sql).

Future changes to OP Workspace, Patient Command Board, Bed Board,
prescriptions, investigations, referrals, vitals, I/O, MAR, discharge,
housekeeping, and clinical audit must respect this model. The rendered timeline
is not a permission bypass; PHI access still depends on RBAC plus the access
decision service/care-team/appointment/admission/referral/break-glass context.

---

## 9. Clinical-AI subsystem

The "40 future-proofing AI features" are all shipped at v1, and the
current Clinical AI registry contains 92 governed modules. See
[`apps/backend/docs/AI_FEATURE_TRACKER.md`](../apps/backend/docs/AI_FEATURE_TRACKER.md)
for the per-module status matrix — every row is `Implemented v1` as of
batch 15 (2026-04-23), with a live admin panel under
[`apps/admin/src/app/(with-auth)/dashboard/clinical-ai/`](../apps/admin/src/app/%28with-auth%29/dashboard/clinical-ai/).

Architectural contract, consistent across all modules:

- **Review-only**. No module auto-administers, auto-orders, auto-releases, or auto-appeals. Every recommendation lands in a review queue for a clinician / billing coordinator / pharmacist / security officer.
- **Tenant-isolated**. Clinical AI tables are tenant-scoped and guarded by the RLS/middleware pattern. `tenant_id` is required for new rows. Per-tenant module enablement lives in `clinical_ai_tenant_modules`.
- **Cited**. Every recommendation persists the evidence/context it drew from (`clinical_ai_context_snapshots`) so the reviewer can audit provenance.
- **Loud about fallback**. Generated output carries `generation_mode`, `fallback_reason`, `readiness_reason`, and `provider_status`; admin surfaces badge AI output separately from template fallback, blocked output, and schema-unavailable states.
- **Governed enablement**. High-risk enablement and risky runtime changes require two-person approval and accepted eval evidence for the effective module/provider/model tuple.

Admin UI: simple modules use the shared `ClinicalAIReviewQueue`
component; bespoke panels exist for two-tier and three-tier modules
(e.g. radiology QA, contract variance). Module toggle + guardrail
config lives under Settings.

Do not enumerate individual modules here — the tracker is the source
of truth and is kept up to date per feature.

---

## 10. Deployment architecture

### Cluster

- **3-node on-prem RKE2 HA**. All three nodes are control-plane + etcd
  + worker. Embedded etcd quorum tolerates 1 node loss.
- **Ubuntu 24.04 LTS** on each node. CIS Kubernetes Benchmark
  `profile: cis` enabled. Hardened sshd, auditd, AIDE, fail2ban,
  nftables.
- **Ansible-bootstrapped**. [`infra/ansible/`](../infra/ansible/) turns
  three bare Ubuntu boxes into a healthy RKE2 cluster with the
  platform operators pre-installed. See
  [`infra/ansible/README.md`](../infra/ansible/README.md) for the
  opinionated hardening list and
  [`docs/DEPLOYMENT_GUIDE.md` section 3](DEPLOYMENT_GUIDE.md)
  for the runbook.

### Kustomize structure

Bases under [`infra/kubernetes/base/`](../infra/kubernetes/base/):

| Base | Role |
|---|---|
| `_common` | Shared labels, namespaces, RBAC. |
| `sealed-secrets` | Bitnami sealed-secrets controller for GitOps-safe secrets. |
| `cert-manager` | Internal TLS issuance (tunnel trusts Cloudflare layer above). |
| `step-ca` | Step-CA for service-mesh client certs. |
| `vault` | HashiCorp Vault (break-glass + secondary secret store). |
| `cnpg` | CloudNativePG operator + `Cluster` CRD (PG17, 3 replicas). |
| `redis` | Redis Sentinel HA (rate-limit + token blacklist cache). |
| `minio` | S3-compatible object store (CNPG backup sink; artefact cache). |
| `harbor` | In-cluster container registry, pull-through to GHCR (bandwidth save). |
| `ingress-nginx` | DaemonSet on all three nodes. |
| `cloudflare-tunnel` | `cloudflared` Deployment (4 replicas in prod). |
| `monitoring` | Prometheus + Alertmanager + Grafana + Loki. |
| `falco` | Kubernetes runtime-security anomaly detector. |
| `kured` | Coordinated node reboot after kernel updates. |
| `argocd` | ArgoCD HA installation (itself GitOps-managed). |

Overlays at [`infra/kubernetes/overlays/`](../infra/kubernetes/overlays/):

| Overlay | Tunes |
|---|---|
| `dev` | Lowest replica counts, debug log level, loose ingress hostnames, `ENVIRONMENT=dev`. |
| `staging` | 2-replica services, info log level, staging hosts, tracks `main-<sha>` image tags for automatic rollout. |
| `prod` | Base taken as-is (3 replicas); DB bumped to 2 CPU / 4 Gi; 4 cloudflared replicas; `ENVIRONMENT=production`, `LOG_LEVEL=info`, `data-residency: in`. Pins to semver-tagged images (`backend-v*`, `admin-v*`). See [`overlays/prod/kustomization.yaml`](../infra/kubernetes/overlays/prod/kustomization.yaml). |

### ArgoCD wiring

Batch 17 introduced two top-level ArgoCD Applications:

| Application | Source path | Target namespace | File |
|---|---|---|---|
| `vhhealth-platform` | `infra/kubernetes/overlays/prod/` | `argocd` (mixed destinations) | [`base/argocd/applications/platform.yaml`](../infra/kubernetes/base/argocd/applications/platform.yaml) |
| `vhhealth-apps` | `infra/kubernetes/apps/` | `vhhealth` | [`base/argocd/applications/apps.yaml`](../infra/kubernetes/base/argocd/applications/apps.yaml) |

Both have `syncPolicy.automated: { prune: true, selfHeal: true }` +
`ServerSideApply=true` + `PrunePropagationPolicy=foreground`, and
retry with exponential backoff (10s → 3m cap, 5 attempts).

ArgoCD itself is deployed in HA (ApplicationSet + 2× `argocd-server` +
Redis HA). The ArgoCD `AppProject` is [`project.yaml`](../infra/kubernetes/base/argocd/project.yaml).

### GitOps flow

```
release tag / manual dispatch
  └─> GHA: release-images.yml (build + cosign keyless + SBOM + trivy scan)
       └─> push to ghcr.io/<owner>/vh-health-platform-{backend,adminportal}:<tag>
             └─> ArgoCD poll (3 min default)
                  └─> auto-sync Kustomize overlays
                       └─> rolling update in vhhealth namespace
                            └─> zero-downtime cutover
```

Prod pins to semver tags (`backend-v1.5.2`, `admin-v1.5.2`). Bumping
is either a `kustomize edit set image ...` + commit (manual) or via
the planned ArgoCD image updater. Staging can track manually published
`main-<sha>` images. Tag convention is documented in root
[`CLAUDE.md`](../CLAUDE.md).

### Ingress — zero inbound ports

External → hospital firewall traffic is exclusively:

```
client → Cloudflare edge (443) → [cloudflared dials out, 443 outbound only]
                               → ingress-nginx DaemonSet (internal cluster IP)
                               → Service/vhhealth-backend or vhhealth-admin
```

The hospital firewall rule is literally: **allow outbound 443 to
Cloudflare; no inbound**. Public hostnames (`api.vhhealth.app`,
`admin.vhhealth.app`) CNAME to `<tunnel-id>.cfargotunnel.com`
(proxied). See
[`docs/DEPLOYMENT_GUIDE.md` section 7](DEPLOYMENT_GUIDE.md).

### Secrets

Every Secret lives in-repo as a **Sealed Secret** (`*.sealed-secret.yaml`).
Plain forms are never committed. The sealed-secrets controller decrypts at
apply-time. `kubeseal` is the workflow tool; see
[`docs/DEPLOYMENT_GUIDE.md` section 5](DEPLOYMENT_GUIDE.md).

Minimum backend-required secrets: `vhhealth-jwt`, `vhhealth-api-keys`,
`vhhealth-db-url`, `vhhealth-firebase`, `vhhealth-r2`,
`pgbackrest-cipher`, `cloudflared-token`.

### Backup + DR

- **CNPG pgBackRest** → MinIO (in-cluster, AES-256) → R2 (offsite, Asia-Pac pinned).
- Etcd snapshots every 6 hours → R2.
- PITR: targetable per CNPG docs; runbook at [`apps/backend/docs/DISASTER-RECOVERY.md`](../apps/backend/docs/DISASTER-RECOVERY.md).
- Offsite DR cluster: deferred (batch 17 item in `docs/DEPLOYMENT_GUIDE.md` section 10).

Full end-to-end runbook: **[`docs/DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md)**.

---

## 11. CI/CD + supply chain

### Workflow catalogue

Forgejo is the canonical hosted CI target. GitHub Actions remain useful mirrors
for GitHub-native release/deploy surfaces and external visibility.

Root [`.forgejo/workflows/`](../.forgejo/workflows/):

| Workflow | Fires on | What it runs |
|---|---|---|
| [`ci.yml`](../.forgejo/workflows/ci.yml) | push + PR + manual | Matrix over repo-owned `security`, `backend`, `fhir`, `admin`, `flutter`, `infra` stages. |
| [`full-stack-sweep.yml`](../.forgejo/workflows/full-stack-sweep.yml) | manual + weekdays | Scheduled full-stack sweep of the same six repo-owned stages. |
| [`secret-scan.yml`](../.forgejo/workflows/secret-scan.yml) | main push + PR + manual | Service-account scanner, `gitleaks`, and optional GitGuardian parity. |
| [`dependency-review.yml`](../.forgejo/workflows/dependency-review.yml) | dependency PRs + manual | Provider-neutral high-severity npm dependency audit. |
| [`security-sweep.yml`](../.forgejo/workflows/security-sweep.yml) | main push + PR + weekly + manual | Repo security stage, `npm audit`, OSV/Semgrep reports, blocking Trivy vuln/secret filesystem scan, and advisory misconfiguration reporting. |
| [`container-supply-chain.yml`](../.forgejo/workflows/container-supply-chain.yml) | app/container paths | Build backend/admin/staff-web images, SBOM, blocking Trivy image scan, optional push/sign. |
| [`smoke-e2e.yml`](../.forgejo/workflows/smoke-e2e.yml) | backend/admin smoke paths + manual | Local backend/admin/API smoke coverage and Clinical AI rollout preflight. |
| [`ci-warehouse.yml`](../.forgejo/workflows/ci-warehouse.yml) | warehouse paths + manual | Migration-built Postgres, `dbt build`, and analytics-warehouse kustomize render. |
| [`openapi-client-drift.yml`](../.forgejo/workflows/openapi-client-drift.yml) | API/client paths | OpenAPI regeneration/validation and generated-client smoke. |
| [`schema-policy-drift.yml`](../.forgejo/workflows/schema-policy-drift.yml) | backend/policy paths | DB schema drift, PHI tenant guardrails, and role-policy graph tests. |
| [`post-deploy-smoke.yml`](../.forgejo/workflows/post-deploy-smoke.yml) | main push + manual | Deployed API/admin/Sentry smoke when `VH_TRIAL_API_ORIGIN` and `VH_TRIAL_ADMIN_ORIGIN` are configured. |
| [`renovate.yml`](../.forgejo/workflows/renovate.yml) | weekly + manual | Forgejo Renovate dependency updates. |
| [`staff-windows-build.yml`](../.forgejo/workflows/staff-windows-build.yml) | manual | Windows build readiness until a Windows runner is registered. |
| [`trial-readiness-smoke.yml`](../.forgejo/workflows/trial-readiness-smoke.yml) | manual | Deployed staff role workflow sweep. |

Root [`.github/workflows/`](../.github/workflows/) mirrors and release surfaces:

| Workflow | Fires on | What it runs |
|---|---|---|
| [`all.yml`](../.github/workflows/all.yml) | `workflow_dispatch` + weekdays 01:30 UTC | Full-stack sweep (Flutter + backend + admin + FHIR). |
| [`ci-flutter.yml`](../.github/workflows/ci-flutter.yml) | patient/staff/core paths | Melos bootstrap → analyze → test → format. |
| [`ci-backend.yml`](../.github/workflows/ci-backend.yml) | backend paths | Lint + swagger + prisma + tests (Postgres 16 service) + CodeQL + FHIR conformance. |
| [`ci-admin.yml`](../.github/workflows/ci-admin.yml) | admin paths | Lint + type-check + jest + next build. |
| [`deploy-patient-staging.yml`](../.github/workflows/deploy-patient-staging.yml) | main push touching patient | Firebase App Distribution. |
| [`deploy-staff-staging.yml`](../.github/workflows/deploy-staff-staging.yml) | main push touching staff | Firebase App Distribution. |
| [`release-patient.yml`](../.github/workflows/release-patient.yml) | tag `patient-v*` | Signed APK + AAB → GitHub Release. |
| [`release-staff.yml`](../.github/workflows/release-staff.yml) | tag `staff-v*` | Signed APK + AAB → GitHub Release. |
| [`release-images.yml`](../.github/workflows/release-images.yml) | main push, `backend-v*`, `admin-v*`, manual | Build + sign + SBOM + Trivy scan → GHCR. |
| [`secret-scan.yml`](../.github/workflows/secret-scan.yml) | main push + PR + manual | Service-account scanner, `gitleaks`, and optional GitGuardian scan. |
| [`smoke-e2e.yml`](../.github/workflows/smoke-e2e.yml) | PR + manual | Mirror of the local backend/admin/API smoke coverage. |
| [`ci-warehouse.yml`](../.github/workflows/ci-warehouse.yml) | warehouse paths | Mirror of the analytics warehouse dbt/kustomize gate. |

Shared job definitions live in reusable workflows:

- [`_reusable-backend-lint-test.yml`](../.github/workflows/_reusable-backend-lint-test.yml)
- [`_reusable-admin-ci.yml`](../.github/workflows/_reusable-admin-ci.yml)
- [`_reusable-backend-fhir.yml`](../.github/workflows/_reusable-backend-fhir.yml)
- [`_reusable-flutter-workspace.yml`](../.github/workflows/_reusable-flutter-workspace.yml)

This keeps path-filtered CI and the scheduled sweep in lockstep.

### Vulnerability gates

| Gate | Where | Behaviour |
|---|---|---|
| `npm audit --audit-level=high` | `_reusable-backend-lint-test.yml:66`, `_reusable-admin-ci.yml:52` | Fails CI on any high-severity advisory. |
| `audit-ci --critical` | backend reusable | Second pass, fails on critical only. |
| Trivy **filesystem** scan | Forgejo `security-sweep.yml` and GitHub reusables | Forgejo blocks on CRITICAL/HIGH vulnerabilities and secrets while emitting advisory misconfiguration SARIF; GitHub reusables block CRITICAL/HIGH source-tree scans. |
| Trivy **image** scan | `release-images.yml:130-147`, `:285-302` | Scans the built container at its digest; SARIF upload to GitHub Security; `exit-code: 1` CRITICAL,HIGH, `ignore-unfixed: true`. |
| Cosign keyless sign | `release-images.yml:162-177`, `:317-331` | Every tag at digest signed via GitHub OIDC. Verifiable with `cosign verify --certificate-identity-regexp ...`. |
| SPDX SBOM | `release-images.yml:121-128`, `:276-283` | `anchore/sbom-action` uploads SBOM artefact per image. |

### Dependabot

[`.github/dependabot.yml`](../.github/dependabot.yml) covers:

- `pub` (Dart): `/apps/patient`, `/apps/staff`, `/packages/vhhealth_core`
- `npm`: `/apps/backend`, `/apps/admin`
- `github-actions`: `/` (workflow `uses:` refs)
- `docker`: `/infra/kubernetes/apps/{backend,admin}` (image refs)

All weekly, grouped (minor + patch into one PR), major-version bumps
ignored (manual review). Helm chart bumps under
`infra/kubernetes/base/*` are **not** Dependabot-tracked; a manual
record lives at
[`infra/kubernetes/base/CHART_UPDATES.md`](../infra/kubernetes/base/CHART_UPDATES.md).

### CODEOWNERS

No `CODEOWNERS` file is committed at `/.github/CODEOWNERS` or
repository root today — reviewer routing is informal. Add one when the
team grows past two reviewers.

---

## 12. Observability + ops

### Logging

- **Winston** centralized logger at [`apps/backend/src/logging/logger.js`](../apps/backend/src/logging/logger.js). `logger.info/warn/error` are the only sanctioned log APIs — no `console.log` in production code.
- **Morgan** HTTP access logs via `logger.morganMiddleware`.
- **Request ID correlation**: `requestIdMiddleware` sets `req.id` (or reuses `X-Request-Id` header); echoed on response. All audit + PHI logs carry the id.
- **PII masking**: [`src/utils/piiMask.js`](../apps/backend/src/utils/piiMask.js) — `maskPhone()`, `maskEmail()`, `maskName()`. Required when logging any user-identified field.

### Audit + PHI access

- **Universal audit log**: [`src/middleware/auditLog.js`](../apps/backend/src/middleware/auditLog.js). Fire-and-forget, capped queue 1000, Winston file fallback. Writes to `audit_log` table.
- **PHI access log**: [`src/middleware/phiAccessMiddleware.js`](../apps/backend/src/middleware/phiAccessMiddleware.js) — `phiAccessLogger('RECORD_TYPE')` mounted on every PHI-touching router (appointments, records, investigations, prescriptions, pharmacy-orders, EMR, clinical workflows, documents, radiology, dietary, theatre, blood-bank, referrals). Records who / which patient / what record / action / IP / requestId / timestamp. Only fires on 2xx/3xx.

### Sentry

- Backend: `SENTRY_DSN` activates reporting outside tests. `SENTRY_ENVIRONMENT`,
  `SENTRY_TRACES_SAMPLE_RATE`, and `GIT_COMMIT`/`RENDER_GIT_COMMIT` control
  environment, trace sampling, and release. `beforeSend`/transaction hooks strip
  request bodies, cookies, query strings, tokens, phone/email/patient IDs, and
  dynamic route IDs.
- Admin: `NEXT_PUBLIC_SENTRY_DSN` activates the admin portal. Replay defaults
  to disabled (`NEXT_PUBLIC_SENTRY_REPLAY_*_SAMPLE_RATE=0`) and, when enabled,
  masks all text and blocks media. Admin events use the shared Sentry scrubber
  before send.
- Staff: Windows/web builds accept `SENTRY_DSN` or `VH_SENTRY_DSN` plus
  `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, and `SENTRY_TRACES_SAMPLE_RATE`.
  Staff disables screenshot/view-hierarchy capture and user-interaction
  breadcrumbs/tracing so clinical screen content is not captured.

### Clinical safety monitors

- **Vital-sign monitor**: [`src/utils/clinical/vitalSignMonitor.js`](../apps/backend/src/utils/clinical/vitalSignMonitor.js) — `checkVitalAnomalies(patientId, vitals)` generates CRITICAL alerts (e.g. O2 < 85%, HR > 180) and WARNINGs (e.g. BP > 160) into the `clinical_alerts` table.
- **Prescription safety**: [`src/utils/clinical/prescriptionSafetyCheck.js`](../apps/backend/src/utils/clinical/prescriptionSafetyCheck.js) — `validatePrescriptionSafety(patientId, medications)` returns `{ safe, warnings, blockers }`. Blockers prevent save (allergy conflicts with severity awareness, duplicate active prescriptions).

### Self-healing

- **Circuit breaker**: `circuitBreakerStatus()` from `src/lib/prisma.js` is scraped by `/health/metrics`. The legacy `dbHealthMonitor.js` that polled pool stats every 30s was deleted in batch 31 (the pg.Pool it polled is gone).
- **Canary health checks**: [`src/utils/canaryHealthCheck.js`](../apps/backend/src/utils/canaryHealthCheck.js) — every 5 minutes, tests DB read/write, stuck-notification detection, unacknowledged critical alerts.
- **Schema drift detector**: [`src/utils/schemaDriftDetector.js`](../apps/backend/src/utils/schemaDriftDetector.js) — compares expected vs actual DB tables at startup; warns on mismatches (non-fatal).
- **Scheduler job locking**: `withJobLock()` prevents overlapping cron executions.

### Cluster observability

- **Prometheus + Alertmanager** in the `monitoring` namespace. Backend exposes `/metrics` via `prometheusMiddleware`.
- **Grafana** dashboards for node health, CNPG cluster, ingress throughput, Sentry crash rate.
- **Loki** for log aggregation (30-day retention).
- **Falco** for runtime anomaly detection (unexpected `exec` into containers, privilege escalation attempts).

---

## 13. Where to look when…

Cheatsheet for common changes. All paths relative to repo root.

| You want to… | Start here |
|---|---|
| Add an API route | [`apps/backend/src/routes/<domain>/`](../apps/backend/src/routes/) + thin controller in [`controllers/<domain>/`](../apps/backend/src/controllers/) + service in [`services/<domain>/`](../apps/backend/src/services/) + validator in [`validators/<domain>/`](../apps/backend/src/validators/). Wrap with `wrapRoutesWithValidation` + `wrapAutoRBAC` from [`config/routeWrapper.js`](../apps/backend/src/config/routeWrapper.js). |
| Require a role | `requireRole('ADMIN', 'DOCTOR')` from [`middleware/rbacMiddleware.js`](../apps/backend/src/middleware/rbacMiddleware.js), mounted before the router; OR add a `roles:` entry to the route map passed to `wrapAutoRBAC(router, configKey, routeMap)`. |
| Add a tenant-scoped query | Use `setTenant(req.tenantId, (tx) => tx.$queryRaw`…`)` from [`src/lib/prisma.js`](../apps/backend/src/lib/prisma.js). If the table isn't one of the 11 in migration 075, add it there AND add a `tenant_id uuid NOT NULL DEFAULT DEFAULT_TENANT_ID` column in a new migration. |
| Add an env var | (1) [`src/utils/validateEnv.js`](../apps/backend/src/utils/validateEnv.js) — Joi rule + required vs optional. (2) [`.env.example`](../apps/backend/.env.example). (3) For prod: create a Sealed Secret via `kubeseal` — see [`docs/DEPLOYMENT_GUIDE.md` section 5](DEPLOYMENT_GUIDE.md). (4) For admin: [`apps/admin/.env.example`](../apps/admin/.env.example). |
| Add a k8s workload | New Kustomize base under [`infra/kubernetes/apps/<name>/`](../infra/kubernetes/apps/) with `deployment.yaml` + `service.yaml` + `kustomization.yaml`. Reference it from [`infra/kubernetes/apps/kustomization.yaml`](../infra/kubernetes/apps/kustomization.yaml). Image tag pinned in the overlay at [`overlays/prod/kustomization.yaml`](../infra/kubernetes/overlays/prod/kustomization.yaml). ArgoCD's `vhhealth-apps` Application will pick it up. |
| Add a DB migration | `apps/backend/src/migrations/NNN_description.sql` with the next sequential 3-digit number (currently `075` is the last; `076_` next). Raw SQL, no Prisma. The file is applied by [`scripts/ci-setup-db.mjs`](../apps/backend/scripts/ci-setup-db.mjs) and — if it adds a new RLS-scoped table — must also be handled in [`scripts/ensure-test-db.mjs`](../apps/backend/scripts/ensure-test-db.mjs). |
| Debug test-DB schema-sync failure | [`apps/backend/scripts/ensure-test-db.mjs`](../apps/backend/scripts/ensure-test-db.mjs), especially the "drop RLS policies" block starting around line 548. Prisma's `db push --accept-data-loss` conflicts with the live `tenant_isolation` policies; the script drops them, runs push, lets migration 075 recreate them. |
| Rotate a JWT / API key / encryption key | [`apps/backend/docs/RUNBOOKS/cert-rotation.md`](../apps/backend/docs/RUNBOOKS/cert-rotation.md) + [`credential-incident-response.md`](../apps/backend/docs/RUNBOOKS/credential-incident-response.md). The flow is: update the plain Secret → `kubeseal` → commit → ArgoCD reconciles → `rollout restart deployment/vhhealth-backend`. |
| Add a clinical-AI module | Service in [`apps/backend/src/services/ai/`](../apps/backend/src/services/ai/) + raw-SQL migration for the tables + admin route in [`apps/backend/src/routes/admin/clinicalAi/`](../apps/backend/src/routes/admin/clinicalAi/) + tracker update at [`apps/backend/docs/AI_FEATURE_TRACKER.md`](../apps/backend/docs/AI_FEATURE_TRACKER.md) + admin UI at [`apps/admin/src/app/(with-auth)/dashboard/clinical-ai/`](../apps/admin/src/app/%28with-auth%29/dashboard/clinical-ai/). |
| Change the admin auth flow | [`apps/admin/src/lib/api-client.ts`](../apps/admin/src/lib/api-client.ts) for login/logout, [`middleware.ts`](../apps/admin/src/middleware.ts) for SSR guard, [`contexts/AuthContext.tsx`](../apps/admin/src/contexts/AuthContext.tsx) for client-side state. Backend side: [`apps/backend/src/services/auth/authService.js`](../apps/backend/src/services/auth/authService.js). |
| Add a patient-facing screen | [`apps/patient/lib/features/<feature>/`](../apps/patient/lib/features/) + register in [`lib/core/navigation/app_router.dart`](../apps/patient/lib/core/navigation/app_router.dart). All API calls via `ApiClient`. |
| Investigate a prod incident | Entry runbook: [`docs/DEPLOYMENT_GUIDE.md` section 9](DEPLOYMENT_GUIDE.md#9-day-2-operations). Per-scenario: [`apps/backend/docs/DISASTER-RECOVERY.md`](../apps/backend/docs/DISASTER-RECOVERY.md) and the runbooks tree at [`apps/backend/docs/RUNBOOKS/`](../apps/backend/docs/RUNBOOKS/). |

---

*Last refreshed: reflects the codebase as of the commit at the time of
generation. When something in this doc goes stale, open the linked
source file — that is the authority. This file is an index, not a
replacement.*
