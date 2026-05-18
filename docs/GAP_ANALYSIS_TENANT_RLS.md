# Tenant RLS Gap Analysis

**Status:** Phases 0, 1, and 2 substrate landed 2026-05-18. Phase 2 enforcement
is opt-in via `AUTH_ENFORCE_TENANT_RLS=true` (default off — every legacy call
site keeps working). Remaining work is the production cutover decision and
auditing the long tail of PHI tables (Phase 2b, listed below).

**Severity in swarm:** medium (does not gate the [`GOAL_2026-06-16`](GOAL_2026-06-16.md)
milestone, which targets 0 critical/high in-flight only).

**Source finding:** `2026-05-17-cross-tenant-rls-receptionist-e1904f2e` — the
cross-tenant-rls swarm journey.

---

## TL;DR

Multi-tenant infrastructure is half-built. The `tenant_id` column exists on
~250 tables and `tenantContextMiddleware` resolves a tenant context per
request, but the **operational PHI tables that staff actually write to do not
carry `tenant_id`**, and the staff JWT does not issue a `tenant_id` claim. A
SUPER_ADMIN can pass `x-tenant-id` to act as any tenant, but there is no
column to filter against on the surfaces that matter.

The first pilot site brought up against this build will share a single
`appointments` / `admissions` / `clinical_notes` / `prescriptions` namespace
with every other pilot site. There is no enforcement boundary to test RLS
against, because the column doesn't exist.

This is a structural gap that must be resolved before pilot #2.

---

## Current state (verified 2026-05-18)

### What exists
- `tenants` table + `users.tenant_id` (`@default(dbgenerated("'00000000-0000-4000-8000-000000000001'::uuid"))`)
- `tenantContextMiddleware` (`src/middleware/tenantContextMiddleware.js`) resolves `req.tenantId` via:
  1. JWT claim → 2. `x-tenant-id` header (SUPER_ADMIN only) → 3. `users.tenant_id` lookup → 4. `DEFAULT_TENANT_ID`.
- `setTenant(tenantId, fn, { superAdmin })` in `src/lib/prisma.js` — wraps a callback in a Postgres transaction with `SET LOCAL app.current_tenant_id = $1`.
- Migration 075 added RLS policies on 11 tables.
- Most non-PHI tables (~250) declare a `tenant_id` column with a hardcoded default UUID.

### What's missing
- The five operational PHI tables receptionist + clinical staff write to have **no `tenant_id` column**:
  - `appointments`
  - `admissions`
  - `clinical_notes`
  - `prescriptions`
  - `lab_orders`
  - (likely also: `encounters`, `vitals`, `emergency_visits`, `er_orders`)
- The staff JWT payload has **no `tenant_id` / `tenantId` claim**. The middleware comment at `jwtMiddleware.js:171–173` already acknowledges this (`tenant_id is optional in the token`).
- `tenantContextMiddleware:54` silently falls back to `DEFAULT_TENANT_ID` — the gap is invisible at runtime today.
- The SUPER_ADMIN `x-tenant-id` override is unaudited (no logged justification, no second factor). Becomes an audit hole once a second tenant exists.
- 288+ `prisma.$queryRaw*` call sites do not consistently use `setTenant()`, even on the 11 tables that already have RLS — RLS bypass is permissive when the GUC is unset (matches the migration 075 policy intentionally; same data path serves single-tenant today).

### Why this isn't already broken in prod
The platform is genuinely single-tenant in production. Only `DEFAULT_TENANT_ID`
exists. Every write lands in the same tenant by silent fallback. The
half-wired multi-tenant scaffolding never has to make a real decision.

---

## Two coherent paths

The swarm finding called these (a) and (b). Pick **one** before pilot #2.

### Path A — Honestly single-tenant

Remove the half-wired multi-tenant scaffolding so no future operator (or
auditor) sees `tenantContextMiddleware` + `x-tenant-id` and assumes a boundary
that isn't there.

**Changes:**
- Delete `tenantContextMiddleware` (or replace it with a stub that asserts
  `DEFAULT_TENANT_ID` and refuses any other tenant).
- Remove the `x-tenant-id` SUPER_ADMIN override.
- Drop `tenant_id` columns + `tenants` table + migration 075's RLS policies
  (with a `DROP POLICY` migration; keep `tenants` if it's worth retaining
  hospital-metadata semantics, but with a hard CHECK that
  `id = '00000000-0000-4000-8000-000000000001'`).
- Document in `docs/SYSTEM-ARCHITECTURE.md` that the platform is
  single-tenant by design; multi-tenant is out of scope until a real
  product driver appears.

**Effort:** ~1 week (mostly removal + a migration + tests).

**When to choose this:** if multi-tenant SaaS is not a real near-term roadmap
item and the hospital deployment will stay one-tenant-per-cluster.

### Path B — Real multi-tenant with RLS

Make the half-built scaffolding real by adding `tenant_id` to every PHI table,
issuing it in the JWT, and enforcing RLS on every write path.

**Changes (rough sequence):**
1. **Migration:** `ALTER TABLE` for ~10 PHI tables to add `tenant_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid`. Foreign-key to `tenants(id)`. Backfill from the linked `users.tenant_id` row where it exists.
2. **RLS policies** on each of those tables, following the migration 075 pattern:
   ```sql
   CREATE POLICY tenant_isolation ON appointments
     USING (tenant_id::text = current_setting('app.current_tenant_id', true)
            OR current_setting('app.current_tenant_id', true) = 'bypass'
            OR current_setting('app.current_tenant_id', true) IS NULL
            OR current_setting('app.current_tenant_id', true) = '');
   ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
   ```
3. **JWT:** add `tenant_id` claim at every issue site (staff login, admin login, refresh-token rotation, dev-auth, Firebase OTP path). `loginSessionHelper.issueAccessTokenAndClaimSession` is the single chokepoint; thread `tenantId` through it.
4. **Middleware:** remove the silent `DEFAULT_TENANT_ID` fallback in `tenantContextMiddleware`. Fail-closed with a clear 403 when no tenant can be resolved.
5. **Query call sites:** audit the 288+ `prisma.$queryRaw*` sites and wrap PHI-table writes/reads in `setTenant(req.tenantId, async (tx) => { … })`. This is the bulk of the work.
6. **SUPER_ADMIN x-tenant-id override:** require a `reason` body field + log every override to `audit_logs` with the original + target tenant.
7. **Tests:** seed two tenants in `vhhealth_test`, write deep tests that assert tenant-A SUPER_ADMIN cannot read tenant-B PHI without a logged override.

**Effort:** 4–6 weeks at one engineer's pace. Most of it is auditing call
sites and migrating them to `setTenant`. The migration itself is small.

**Risk areas:**
- Reporting / analytics queries that span tenants (admin dashboards) need the `{ superAdmin: true }` bypass — easy to forget and break the dashboard for normal admins.
- Cron / scheduled jobs (`scheduler.js`, `backgroundJobs.js`) currently have no tenant context — they need a per-tenant loop or a `superAdmin` bypass.
- The patient app's `/api/v1/portal/*` surface assumes single-tenant; needs review.
- Postgres GUC propagation across the Prisma connection pool can be subtle — `setTenant` uses `SET LOCAL` inside a transaction, which is the safe pattern; outside that the GUC is process-wide and dangerous.

**When to choose this:** if multi-region SaaS is on the roadmap (per
`docs/PER_TENANT_ROLLOUT_PLAYBOOK.md` and the deployment memory), and the
gap between scaffolding and reality is small enough that finishing wins
over removing.

---

## Recommended (current progress in brackets)

**Path B**, staged:

1. **Phase 0** ✅ **shipped** — `apps/backend/scripts/check-phi-tenant-id.mjs`
   wired into `npm run lint`. Baselines 40 pre-existing PHI gaps in its
   allowlist; new PHI-shaped tables added without `tenant_id` fail CI.
2. **Phase 1** ✅ **shipped** — migration `236_tenant_rls_phi_phase_1.sql`
   adds `tenant_id` + RLS policy to 8 PHI tables (`appointments`,
   `admissions`, `clinical_notes`, `prescriptions`, `e_prescriptions`,
   `investigations`, `vitals_chart`, `emergency_visits`). JWT carries
   `tenant_id` claim from `loginSessionHelper.issueAccessTokenAndClaimSession`.
   2-tenant deep test proves cross-tenant blocks work.
3. **Phase 2 substrate** ✅ **shipped** — `src/lib/tenantContext.js`
   (AsyncLocalStorage) + `src/middleware/tenantRlsMiddleware.js` seed
   a per-request tenant context. The prisma proxy at `src/lib/prisma.js`
   auto-wraps every `$queryRaw*` / `$executeRaw*` call in `setTenant()`
   when `AUTH_ENFORCE_TENANT_RLS=true` AND the context is set. Recursion
   broken by the `inSetTenant` marker. 7-case deep test covers the
   matrix (flag off, flag on + per-tenant context, SUPER_ADMIN bypass,
   cron-shaped no-context path, WRITE rejection by WITH CHECK).
4. **Phase 2 cutover** ⏳ **pending** — flip `AUTH_ENFORCE_TENANT_RLS=true`
   in staging (dalekdefender), let the swarm shake the surface for a
   week, then flip in prod. Cron jobs that touch PHI need explicit
   `runInTenantContext()` or `runWithSuperAdmin()` from
   `src/lib/tenantContext.js` (audit listed below).
5. **Phase 2b** ⏳ **pending** — convert the 40 allow-listed PHI tables
   (`apps/backend/scripts/check-phi-tenant-id.mjs::ALLOWLIST`) to carry
   `tenant_id` + RLS. Each migration removes one entry from the
   allowlist.
6. **Phase 3** ⏳ **pending** — SUPER_ADMIN `x-tenant-id` override
   hardening (require `reason` field + log every override to
   `audit_logs` with original + target tenant). Remove silent
   `DEFAULT_TENANT_ID` fallback in `tenantContextMiddleware` once
   every login path is verified to issue the `tenant_id` claim.

After Phase 3, the platform is honestly multi-tenant for PHI; the residual
weak spots (analytics, scheduled jobs) are visible in the audit log
instead of silently sharing data.

### Cron / scheduled-job audit (Phase 2 cutover prerequisite)

The following jobs run outside the Express request scope and therefore
won't pick up an AsyncLocalStorage tenant context. Each must either
loop per tenant (`for tenant of tenants: runInTenantContext(tenant.id, fn)`)
or wrap in `runWithSuperAdmin(fn)` for cross-tenant aggregators.
Inventory before flipping `AUTH_ENFORCE_TENANT_RLS=true`:

- `src/utils/scheduler.js` (master cron registry)
- `src/schedulers/appointmentReminderScheduler.js`
- `src/utils/notifications/appointmentReminderJob.js`
- `src/utils/notifications/stuckOrderEscalation.js`
- `src/utils/canaryHealthCheck.js`
- `src/scripts/sendAppointmentReminders.js`
- `src/services/appointment/appointmentReaperService.js`
- Migration runner (`src/utils/migrations/runMigrations.js`) — must
  stay bypass since it runs as DB owner pre-RLS.

### Phase-2 activation runbook

```bash
# 1. Roll out the substrate (flag default off — no behaviour change).
kubectl -n vhhealth set env deploy/vhhealth-backend AUTH_ENFORCE_TENANT_RLS=false
# 2. Verify legacy behaviour is preserved (run swarm 1-2 ticks).
# 3. Flip on staging:
kubectl -n vhhealth set env deploy/vhhealth-backend AUTH_ENFORCE_TENANT_RLS=true
# 4. Watch for 42501 (RLS violation) errors in logs; fix any cron paths.
# 5. Repeat for prod cluster.
```

---

## Out of scope for this doc

- Tenant-aware billing / pricing
- Per-tenant Cloudflare R2 buckets (currently one bucket shared by
  prefix `tenant/<uuid>/…`)
- Per-tenant Firebase project (currently one project)
- Tenant deletion / data export (separate compliance workstream)

Re-evaluate the chosen path before pilot site #2.

---

## Related

- [`PER_TENANT_ROLLOUT_PLAYBOOK.md`](PER_TENANT_ROLLOUT_PLAYBOOK.md) — assumes multi-tenant is live; today it isn't.
- [`PRODUCTION_DB_HARDENING.md`](PRODUCTION_DB_HARDENING.md) — overlapping concerns on RLS posture.
- [`SYSTEM-ARCHITECTURE.md`](SYSTEM-ARCHITECTURE.md) — system-level architecture, no current mention of the tenant gap.
- `apps/backend/CLAUDE.md` — "RLS enforcement is opt-in via `setTenant(...)`" — captures the current opt-in semantics.
- `src/middleware/tenantContextMiddleware.js` — the silent-fallback site.
- `src/lib/prisma.js::setTenant` — the right-shaped helper that callers should standardise on.
