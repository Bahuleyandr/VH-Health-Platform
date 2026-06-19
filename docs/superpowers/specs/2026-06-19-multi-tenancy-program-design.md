# Multi-Tenancy Program — Full SaaS-Grade Completion

- **Date:** 2026-06-19
- **Status:** Design — program spec (umbrella). Each wave gets its own `spec → plan → implement` cycle.
- **Decision (confirmed):** Approach **A** — foundation-first, flag-gated, wave-by-wave. Target = **full SaaS-grade**, **fail-closed** tenant resolution, **all four layers** (backend, admin, Flutter, infra).
- **Supersedes / extends:** [`docs/GAP_ANALYSIS_TENANT_RLS.md`](../../GAP_ANALYSIS_TENANT_RLS.md) (Path B, Phases 0–3 shipped) and operationalises [`docs/PER_TENANT_ROLLOUT_PLAYBOOK.md`](../../PER_TENANT_ROLLOUT_PLAYBOOK.md). This program is "Path B, Phases 4+ → full SaaS."

---

## 1. Current state — RLS-substrate-complete, operationally single-tenant

The platform uses **pooled multi-tenancy**: one shared PostgreSQL database, Postgres Row-Level Security (RLS) keyed on a `tenant_id` column, with the active tenant supplied per request via a GUC (`app.current_tenant_id`) set by `setTenant`/`setTenantTx` in `src/lib/prisma.js`. A prisma proxy auto-wraps `$queryRaw*`/`$executeRaw*` and model calls in `setTenant()` when enforcement is on and an AsyncLocalStorage tenant context is active (`tenantRlsMiddleware`).

**What is already done** (per `GAP_ANALYSIS_TENANT_RLS.md`, Phases 0–3, verified by the 2026-06-19 audit):

- **383 of ~537 application tables** carry `tenant_id` + a `tenant_isolation` policy; ~36 also `FORCE ROW LEVEL SECURITY`. Migration `304` was a 283-table catch-all sweep; PHI phases `236/238/239` closed the operational PHI tables.
- **GUC-reading `tenant_id` DEFAULT** on every policied table (migration `310`) — an INSERT under `setTenant(X)` auto-stamps `tenant_id = X`.
- **Tenant-resolution middleware** chain: `jwtMiddleware` → `tenantContextMiddleware` → `tenantRlsMiddleware` → prisma proxy. SUPER_ADMIN `x-tenant-id` override is reason-required + audited.
- **Runtime-role guard** (`evaluateTenantRlsPosture` in `prisma.js`, surfaced at `/health/metrics`) alarms when enforcement is on but the DB role bypasses RLS.

**Why it is nonetheless operationally single-tenant** (the gaps this program closes):

1. **Resolution fails *open*, not closed.** ~237 source files fall back to a hardcoded `DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001'` (~430 fallback lines; ~27 request-path resolvers; ~50–70 service resolver helpers). Enforcement only "bites" when `AUTH_ENFORCE_TENANT_RLS=true` (prod default) **and** a non-superuser DB role is used; everywhere else every request silently resolves to the default tenant.
2. **~40 tenant-owned tables still have no `tenant_id`** — including the legacy money table `payment_transactions`, the payroll/salary cluster, top-level PHI `consultations`/`health_records`/`sos_alerts`, and `staff`/`doctors`/`departments`/`wards`.
3. **~37 UNIQUE constraints are global** where they must be per-tenant (`invoices.invoice_number`, `appointments.visit_no`, `*.claim_number`, …) — these throw `23505` on tenant #2's first document.
4. **Every secret is one global value** — inbound ABDM/HL7 HMAC secrets, API keys (the per-tenant `api_keys` table exists but is dormant), field-encryption KEK, JWT secret.
5. **Shared in-process state isn't tenant/replica-safe** — rate limiting on a per-process `MemoryStore` (limits multiply by replica count), a dormant response cache keyed without tenant, uid-keyed caches.
6. **Nothing distinguishes tenants at the edge** — one host per app, no per-tenant JWT claim on most token paths, no subdomain/header routing.
7. **Clients are tenant-blind** — admin portal has no tenant identity/switcher (and its tenant-admin screen is orphaned from nav); Flutter apps send no tenant and their offline caches aren't tenant-keyed (a silent cross-tenant PHI-bleed vector on a shared device).
8. **Infra/onboarding is single-tenant-shaped** — one DB/Redis/R2 bucket/tunnel/secret-set; no tenant-onboarding automation beyond the `createTenant` data-row API.

---

## 2. Target architecture

Pooled multi-tenancy, completed and made fail-closed end to end:

- **One tenant resolved per request, fail-closed.** A single `resolveTenantOrThrow(req)` helper returns the token/edge-derived tenant or throws `403 TENANT_CONTEXT_REQUIRED`. The literal default is permitted **only** when `ALLOW_DEFAULT_TENANT=true` (single-tenant deployments). RLS is the enforcement backstop; resolution is the gate.
- **Every tenant-owned row carries `tenant_id` + RLS**; every human-facing identifier is unique **per tenant**.
- **Per-tenant secrets** for anything that varies by hospital identity (ABDM/HL7 inbound, API keys, optionally field-encryption KEK, JWT signing) via an encrypted `tenant_secrets`/`tenant_interop_secrets` store, reusing the existing `fieldEncryption` + `teleconsult_provider_configs`/`api_keys` patterns. Non-secret per-tenant config via the existing `tenants.settings jsonb`.
- **Edge identifies the tenant** (subdomain → `x-tenant-slug` injected by ingress) and the token carries a `tenant_id` claim on every issue path; the backend trusts the edge/token, never a raw client header (except the audited SUPER_ADMIN override).
- **Clients are tenant-aware**: tokens carry tenant; the admin portal has a tenant switcher + tenant-driven branding; Flutter caches/queues are tenant-keyed.
- **Shared infra is tenant/replica-safe**: Redis-backed rate-limit with optional per-tenant quotas; tenant onboarding is a single orchestrated flow.
- **Pooled is the default; silo (separate cluster) is the documented exception** for data-residency/hard-isolation tenants — not built now (YAGNI), but the path is noted.

---

## 3. Guiding principles

- **Flag-gated, no prod disruption.** The current single-hospital prod keeps `ALLOW_DEFAULT_TENANT=true` throughout; fail-closed becomes the *default* but is opt-out for single-tenant installs. Every wave is independently shippable and reversible.
- **The gate is authoritative.** Every wave is validated by the chunked-as-postgres runner (`node apps/backend/scripts/run-ci-jest.mjs` as the postgres superuser) plus a growing **2-tenant isolation test suite** (seed tenant A + B, assert no cross-tenant read/write without an audited override). Lint (`check-phi-tenant-id`, raw-params, a new `no-default-tenant-fallback` rule) gates schema/code regressions.
- **Reuse existing patterns, don't invent.** `setTenantTx`, `fieldEncryption`/envelope KEK, `api_keys`, `teleconsult_provider_configs`, `tenants.settings`, `runRevenueCycleSweepAllTenants` (the per-tenant cron template), `resolveTenantForRequest` (the pre-auth edge seam) are all already in the repo.
- **TDD per wave** (superpowers): RED → GREEN → REFACTOR; per-domain commits; ff `main` per wave once gated.
- **Each wave gets its own `docs/superpowers/specs/…-design.md` + implementation plan** when started; this umbrella doc defines scope, sequence, and done-criteria.

---

## 4. Gap inventory (synthesized from the 2026-06-19 six-layer audit)

Severity = impact once a 2nd tenant exists. `B`=blocker, `H`=high, `M`=medium, `L`=low.

### 4.1 DB schema (`apps/backend/src/migrations`, `prisma/schema.prisma`)
- **B** `payment_transactions` — legacy money table, **no `tenant_id`/RLS** (`000_baseline.sql:14008`). (Newer `billing_payments` is isolated.)
- **B** Global unique → per-tenant: `invoices.invoice_number`, `billing_invoices.invoice_number`, `appointments.visit_no` (`217:18`) — throw `23505` on tenant #2.
- **H** No `tenant_id`: payroll/salary cluster (`payslips`, `payroll_runs`, `staff_salary`, `salary_*`, `full_final_settlements`, `annual_tax_summaries`, `investment_declarations`, `billing_invoice_items`, `billing_advance_settlements`); top-level PHI `consultations` (`:7422`), `health_records` (`:9502`), `sos_alerts` (`:16225`); `staff` (`:16268`), `doctors` (`:8287`), `departments` (`:7704`), `wards` (`:18188`).
- **H** ~34 more document-number global uniques → `(tenant_id, …)`: `*.claim_number`, `case_number`, `preauth_number`, `referral_number`, `booking_number`, `order_number`, `indent_number`, `report_number`, `incident_number`, `grievance_number`, `receipt_number`, barcodes, per-tenant config `code`s; `departments.name`, `payroll_runs(month,year)`. Add a real unique on `staff.employee_id`.
- **M** HR/staff-ops cluster (attendance/shifts/roster/leave/overtime/geofence), housekeeping cluster, config (`investigation_templates`, `pharmacy_catalog`, `notification_templates`), `staff_devices`/`staff_auth_sessions`, child tables reaching tenant only via parent FK (Group C; `chemo_protocol_drugs` RLS explicitly skipped).
- **M (decision)** Audit/activity-log tables with no `tenant_id` (`medical_activity_logs`, `pharmacy_activity_logs`, `file_access_logs`, `file_metadata`, `notification_outbox` [holds `recipient_phone`+payload]) — tenant-scope the PHI-access ones or document as a deliberate global sink.
- **Legitimately global (do not scope):** `tenants`, terminology/ICD catalogs, drug KB, `clinical_ai_modules` catalog, global auth (`admins`, `totp_challenges`, `invalidated_tokens`, OTP/session), `_migrations`, `interop_replay_guard`, `feature_flags`.

### 4.2 Tenant resolution & query scoping (backend)
- **B** Invert resolution to **fail-closed** behind `ALLOW_DEFAULT_TENANT`; today `tenantContextMiddleware.js:184` floors to `DEFAULT_TENANT_ID`, and the only fail-closed gate (`:175-182`) fires solely when `AUTH_ENFORCE_TENANT_RLS` is true.
- **B** Centralize the ~27 request-path resolvers + the `tenantContextMiddleware` floor into one `resolveTenantOrThrow`.
- **H** ~50–70 service resolver helpers (`scopedTx`/`tenantOr`/`tenantOf`) do `tenantId || DEFAULT_TENANT_ID` then `setTenantTx` — a falsy tenant silently scopes a money/clinical write to the default tenant. Key: `billingService.js:21`, `admissionService.js:113`, `problemListService.js:141`, `medicationReconciliationService.js:297`.
- **H** Stop trusting body/param-supplied `tenant_id` in service signatures (`dietaryService`, `clinicalNotesService`, `diagnosisService`) — accept tenant only as an explicit scoping arg from the resolver. (No active hole today; header path is SUPER_ADMIN-gated, the one query-param path is cross-checked.)
- **H** 5 crons run default-tenant-only — fan out per the `runRevenueCycleSweepAllTenants` pattern: `credential-expiry-radar`, `roster-deadline-escalation`, `monthly-payroll`, `annual-salary-review`, `operational-alert-sweep`.
- **M** Replace hand-rolled `COALESCE(tenant_id, DEFAULT)` SQL filters (`sosController.js`, `feedbackService.js`, `searchService.js`); guard the import pipeline (`patientDataImport.js`) to require an explicit tenant; make `logTenantRlsRolePosture` fatal in prod; add a `no-default-tenant-fallback` lint rule.
- **Issue per-tenant `tenant_id` JWT claim on *every* token path** — admin tokens currently omit it (`adminAuthController.js` uses `generateToken` without `tenant_id`); `loginSessionHelper` (staff) sets it. (Lands in W4.)

### 4.3 Global state, secrets, caching (backend)
- **B (SaaS)** Per-tenant field-encryption KEK (`FIELD_ENCRYPTION_KEY`) — one key decrypts all tenants' PHI; envelope structure already supports a pluggable `getKekProvider()`.
- **H** Per-tenant inbound interop secrets (ABDM `ABDM_CALLBACK_SECRET`+`ABDM_HIP_ID`, HL7 `HL7_INBOUND_SHARED_SECRET`) — resolve tenant *before* HMAC verify (ABDM `x-hip-id` is already an input); store in an encrypted `tenant_interop_secrets`; tenant-qualify the replay namespace.
- **H** Wire the dormant per-tenant `api_keys` table (`000_baseline.sql:1242` + `apiClientService.js`) into `validateApiKey` (currently env-only; no per-tenant issue/revoke/rotate).
- **H** Rate limiter on per-process `MemoryStore` (`rateLimitMiddleware.js`) — add `rate-limit-redis` + `RedisStore` (Redis is deployed; `REDIS_URL` must be wired), optional per-tenant quotas from `tenants.settings`, tenant-prefix keys.
- **M** `cacheMiddleware.js:34` cache key omits tenant (DORMANT — fix before mounting); uid-keyed caches (`jwtMiddleware.js:18`, `loginSessionHelper.js:38`) assume globally-unique uid; per-tenant JWT signing (HKDF from master); `TOTP_ENCRYPTION_KEY` + branding (SMS sender/email From/logo) per tenant via `tenants.settings`.
- **L** `STORAGE_TOKEN_SECRET`, per-tenant Sentry project, per-tenant R2 bucket/prefix-IAM, tenant-qualify the login-anomaly IP key.
- **Already correct:** idempotency (tenant+replica safe), `assertSharedReplayOnce` (Redis→DB fail-closed), `withDbAdvisoryLock` crons, token-blacklist DB fallback.

### 4.4 Admin portal (`apps/admin`)
- **B** No SUPER_ADMIN tenant switcher / acting-tenant context (no `TenantContext`); the only cross-tenant path is the audited "override" (logs every request).
- **B** No end-to-end tenant identity on the client (admin JWT has no tenant claim; `AdminUser` schema has no tenant field).
- **H** Tenant-admin screen `/dashboard/tenants` is orphaned from nav (both nav arrays omit it; backend CRUD is SUPER_ADMIN-gated + works).
- **H** Proxy (`api/proxy/[...path]/route.ts`) blanket-forwards client headers — own/whitelist `x-tenant-id` before a switcher introduces it.
- **M** Hardcoded single-hospital branding (header/sidebar/login/footer); no tenant-aware routing; dead `AdminNav.tsx`.

### 4.5 Flutter apps (`apps/patient`, `apps/staff`, `packages/vhhealth_core`)
- **B** No tenant context in client auth or requests (login bodies, all headers, WebSocket); the app can't disambiguate a phone/employeeId that exists in >1 tenant. Add a `tenantProvider` seam on `VHHttpClient._headers` (mirrors `deviceTypeProvider`).
- **B** No hospital/tenant selection (needs a backend "which tenants can this credential reach" endpoint + a login-time picker).
- **B (decision)** Single shared Firebase project for both apps (one identity pool) — confirm shared-Firebase-with-backend-disambiguation vs per-tenant Firebase.
- **H** Caches not tenant-keyed → cross-tenant PHI bleed on any tenant switch (patient API/record/mutation caches, staff recent-patients, core `pending_writes` queue). **Client-only fix; do early** (the patient `as_{uid}__` namespacing is the template).
- **M** Single base URL / `x-api-key`; hardcoded Venkataeswara branding/contacts/geo/theme; patient `mutation_queue` is a single global blob.
- **L** iOS bundle id `com.example.vhhealth` placeholder.

### 4.6 Infra / deployment (`infra/kubernetes`)
- **A (first tenant)** Verify `REDIS_URL` is wired in the prod sealed secret (sentinel URL form) — else rate-limit + anomaly + HMAC-replay degrade to per-replica/DB-only.
- **A** Edge tenant routing: Cloudflare wildcard host + tunnel rule + wildcard TLS (cert-manager DNS-01 token exists) + ingress rule injecting `x-tenant-slug` from subdomain.
- **A** Per-tenant secret store (DB-envelope now; Vault path exists but operator-gated).
- **A** Tenant-onboarding orchestrator (wrap `createTenant` + seed settings/reference-data/bootstrap-admin/R2-prefix + run `check-clinical-ai-tenant-preflight`).
- **A** Per-tenant CORS/branding via `tenants.settings` instead of global `ALLOWED_ORIGINS`/`PUBLIC_BASE_URL`.
- **A (precondition)** Pass GO_LIVE Phase E runtime RLS verification before a 2nd tenant shares the DB.
- **B (scale)** Per-tenant metrics/quotas/alert-routing; per-tenant logical backup/export/erase (DPDP/GDPR); PgBouncer session-mode connection budget; residency silo path; per-tenant R2 isolation; activate Vault/Kyverno-Enforce/Longhorn.

---

## 5. The seven waves

Each wave: **objective · scope · approach · code/infra · risk · gate & done-criteria · depends-on.** Concrete line-level work is deferred to each wave's own plan.

### Wave 1 — Backend fail-closed tenant resolution *(foundation)*
- **Objective:** exactly one resolved tenant per request, fail-closed, with a single audited code path.
- **Scope:** `resolveTenantOrThrow(req)` helper; invert `tenantContextMiddleware` to fail-closed (`403 TENANT_CONTEXT_REQUIRED`) unless `ALLOW_DEFAULT_TENANT=true`; replace ~27 request-path resolvers; collapse ~50–70 service resolver helpers to thread the resolved tenant (falsy → throw, not default); stop destructuring `tenant_id` from request bodies; replace `COALESCE(tenant_id, DEFAULT)` SQL filters; `no-default-tenant-fallback` lint rule; make `logTenantRlsRolePosture` fatal in prod.
- **Code/Infra:** Code only.
- **Risk:** Highest blast radius (~237 files) — mitigated by the central helper + `ALLOW_DEFAULT_TENANT=true` keeping current prod behavior identical; landed incrementally (request-path first, then service helpers).
- **Gate/done:** chunked-as-postgres green with `ALLOW_DEFAULT_TENANT=true` (no behavior change) AND a new test matrix proving that with the flag **off**, a request with no resolved tenant 403s and a resolved request still works. Lint rule active.
- **Depends-on:** —.

### Wave 2 — DB schema completeness
- **Objective:** every tenant-owned row carries `tenant_id`+RLS; every human-facing identifier is unique per tenant.
- **Scope:** migrations adding `tenant_id`+RLS+FORCE+GUC-default to `payment_transactions`, payroll/salary cluster, `consultations`/`health_records`/`sos_alerts`, `staff`/`doctors`/`departments`/`wards`, then the HR/housekeeping/config clusters; convert ~37 global uniques to `(tenant_id, …)`; backfill from linked `users.tenant_id`/parent; audit-log-table scoping decision. `prisma db pull` + `check-schema-drift` per migration.
- **Code/Infra:** Code (raw SQL migrations).
- **Risk:** Backfill correctness on existing data; FORCE-RLS on tables joined by parent; unique-constraint swaps must be online-safe.
- **Gate/done:** drift clean; `check-phi-tenant-id` allowlist stays empty; 2-tenant deep tests prove isolation + that tenant #2 can create an invoice/visit/claim (no `23505`).
- **Depends-on:** — (parallel to W1; W1 makes the new columns *enforced*).

### Wave 3 — Per-tenant secrets & shared state
- **Objective:** anything that varies by hospital identity is per-tenant; shared state is tenant/replica-safe.
- **Scope:** `tenant_interop_secrets` (ABDM/HL7) + resolve-tenant-before-HMAC; wire `api_keys` into `validateApiKey`; per-tenant field-encryption KEK via `getKekProvider()`; Redis-backed rate-limit (+ optional per-tenant quota); tenant-key `cacheMiddleware` + uid caches; fan out the 5 default-tenant crons; per-tenant branding/keys via `tenants.settings`.
- **Code/Infra:** Code + Infra (Redis wired; secret store; KEK provider).
- **Risk:** KEK migration (re-wrap), backward-compat for existing global secrets (grandfather), Redis availability.
- **Gate/done:** per-tenant secret resolution tested (tenant A's ABDM secret cannot verify tenant B's callback); rate-limit shared-store test; KEK rotation/rewrap test; cron fan-out deep tests.
- **Depends-on:** W1 (need a reliable resolved tenant to pick the right secret).

### Wave 4 — Edge routing & token tenant claim
- **Objective:** the tenant is identified at the edge and carried in every token; backend trusts edge/token, not raw client headers.
- **Scope:** issue `tenant_id` claim on **every** token path (admin/staff/patient/refresh/dev); wildcard subdomain → `x-tenant-slug` injection at ingress (Cloudflare wildcard DNS + tunnel + wildcard TLS); backend trusts edge tenant at the authenticated boundary; pre-auth tenant hint via existing `resolveTenantForRequest` (`x-tenant-slug`/`x-tenant-id`).
- **Code/Infra:** Code + Infra.
- **Risk:** Edge↔backend trust composition (never trust a raw client header without edge authority); login flows that pre-date a known tenant.
- **Gate/done:** a request to `tenant-a.<host>` resolves tenant A end-to-end; token minted at login carries the right `tenant_id`; isolation tests pass with edge routing.
- **Depends-on:** W1.

### Wave 5 — Admin portal multi-tenancy
- **Objective:** admins operate with explicit tenant identity; SUPER_ADMINs can switch tenants.
- **Scope:** tenant claim on admin token + `AdminUser.tenant_id`; `TenantContext` + header-based tenant switcher (decision: routine acting-tenant vs audited override); un-orphan `/dashboard/tenants` (nav entry + a "Platform" section); proxy `x-tenant-id` whitelist; tenant-driven branding.
- **Code/Infra:** Code (admin) + small backend contract (token tenant claim, acting-tenant semantics).
- **Risk:** override-vs-routine semantics (don't log every legitimate action as an override).
- **Gate/done:** admin jest + a switcher e2e; super-admin can view tenant A then B; branding renders from tenant settings.
- **Depends-on:** W4.

### Wave 6 — Flutter apps multi-tenancy
- **Objective:** clients are tenant-aware and cannot bleed PHI across tenants.
- **Scope:** **tenant-key all offline caches/queues first** (patient API/record/mutation, staff recent-patients, core `pending_writes`); `tenantProvider` → `X-Tenant-Id` on `VHHttpClient` (+ Chopper + WebSocket); login tenant hint + hospital picker (needs backend "reachable tenants" endpoint); per-tenant branding/base-URL/Firebase decision.
- **Code/Infra:** Code (client) + backend endpoint; infra/product for Firebase decision.
- **Risk:** Firebase identity model (shared vs per-tenant) is a product decision that gates the picker.
- **Gate/done:** `melos analyze`+tests; a tenant-switch (or re-login) clears/segregates caches; requests carry tenant.
- **Depends-on:** W4. **(The cache-keying sub-task may be pulled forward independently as a safety fix.)**

### Wave 7 — Infra & tenant onboarding
- **Objective:** stand up and operate additional tenants repeatably.
- **Scope (first tenant):** verify `REDIS_URL` wired; wildcard ingress/DNS/TLS (shared with W4); per-tenant secret store delivery; tenant-onboarding orchestrator; per-tenant CORS/branding; GO_LIVE Phase E runtime RLS verification. **(scale):** per-tenant metrics/quotas/alert-routing; per-tenant logical backup/export/erase; connection-budget; residency silo; per-tenant R2 isolation; activate Vault/Kyverno-Enforce/Longhorn.
- **Code/Infra:** Infra-led.
- **Risk:** Operator/cluster access required; some items (Vault, residency silo) are larger sub-projects.
- **Gate/done:** a documented, repeatable onboarding that produces a working isolated tenant on the shared cluster; Phase E green.
- **Depends-on:** W3 (secrets), W4 (routing).

---

## 6. Sequencing & dependency graph

```
W1 (fail-closed resolution) ─┬─> W3 (secrets/state) ─┐
                             ├─> W4 (edge + token claim) ─┬─> W5 (admin)
W2 (schema completeness) ────┘                           ├─> W6 (flutter)
                                          W3 + W4 ────────┴─> W7 (infra/onboarding)
```

- **W1 first** (foundation; everything assumes a reliable resolved tenant). **W2 in parallel** (independent migrations; W1 makes the new columns enforced).
- Then **W3** and **W4** (W4 unblocks the clients). **W5 + W6 in parallel** after W4. **W7** lands the routing/secrets infra (overlaps W4/W3) and the onboarding flow.
- **Safety pull-forward:** W6's cache-keying is the only silent PHI-bleed vector and is client-only — it can be done any time independent of the rest.

---

## 7. Cross-cutting testing & gating

- **2-tenant isolation suite** (grows each wave): seed tenant A + B in `vhhealth_test`; assert (a) tenant-A session cannot read/write tenant-B rows on every isolated table, (b) cross-tenant access requires an audited SUPER_ADMIN override, (c) the fail-closed path 403s with no resolved tenant, (d) per-tenant uniqueness lets B create documents A already has.
- **Authoritative gate:** `node apps/backend/scripts/run-ci-jest.mjs` as the postgres superuser ("All chunks passed") + `npm run lint` (incl. `check-phi-tenant-id`, raw-params, new `no-default-tenant-fallback`) + `check-schema-drift` + admin jest + `melos analyze`/tests.
- **Per wave:** TDD (RED→GREEN), per-domain commits, ff `main`, **not pushed until the user lifts HOLD**.

---

## 8. Open product / architecture decisions

These are genuine forks surfaced by the audit; each is resolved at the start of the wave that needs it (flagged), not now:

1. **Patient identity namespace** — one global patient (`users.uid` globally unique, shared across tenants) vs per-tenant patients. Affects unique constraints, Firebase, caches. *(W2/W6)*
2. **Routine multi-tenant admin** — reuse the audited "override" path (every action logged as override) vs a first-class "acting tenant" mechanism. *(W5)*
3. **Firebase model** — one shared project + backend disambiguation vs per-tenant project. *(W6)*
4. **Audit/activity-log tables** — tenant-scope the PHI-access logs vs keep a deliberate global immutable sink. *(W2)*
5. **Field-encryption KEK** — external KMS vs HKDF-per-tenant from a master KEK. *(W3)*
6. **Data residency** — pooled-only (India) now; silo (separate cluster) for EU/isolation-exception tenants later. *(W7)*

---

## 9. Flag / config strategy

- `ALLOW_DEFAULT_TENANT` (new) — when `true`, resolution may fall back to `DEFAULT_TENANT_ID` (single-tenant installs). Default flips to **false** (fail-closed) as W1 lands; current prod sets it `true` until cutover.
- `AUTH_ENFORCE_TENANT_RLS` (exists) — keep `true` in prod; it gates DB-level RLS enforcement (needs the non-superuser role).
- `REDIS_URL` (exists) — must be wired for W3's shared rate-limit/anomaly store.
- Per-tenant config/secrets via `tenants.settings jsonb` + `tenant_secrets`/`tenant_interop_secrets` (new) + `api_keys` (exists, to be wired).

---

## 10. References

- [`docs/GAP_ANALYSIS_TENANT_RLS.md`](../../GAP_ANALYSIS_TENANT_RLS.md) — predecessor (Path B, Phases 0–3 shipped). This program is Phases 4+.
- [`docs/PER_TENANT_ROLLOUT_PLAYBOOK.md`](../../PER_TENANT_ROLLOUT_PLAYBOOK.md) — per-tenant clinical-AI enablement ops (assumes multi-tenant live).
- [`docs/GO_LIVE_ACTIVATION_CHECKLIST.md`](../../GO_LIVE_ACTIVATION_CHECKLIST.md) — Phase E runtime RLS verification (W7 precondition); B6 SUPER_ADMIN 2FA step-up.
- Key code seams: `src/lib/prisma.js` (`setTenant`/`evaluateTenantRlsPosture`), `src/middleware/tenantContextMiddleware.js` (the floor to replace), `src/services/tenant/tenantService.js` (`resolveTenantForRequest`, `DEFAULT_TENANT_ID`), `src/utils/scheduler.js` + `revenueCycleTrackerService.js` (`runRevenueCycleSweepAllTenants` cron template), `src/utils/signedRequest.js` (HMAC verify/replay), `packages/vhhealth_core/lib/services/http_client.dart` (client header seam), `infra/kubernetes/base/cloudflare-tunnel/cloudflared.yaml` + `apps/backend/src/services/tenant/tenantService.js` (edge routing seam).
