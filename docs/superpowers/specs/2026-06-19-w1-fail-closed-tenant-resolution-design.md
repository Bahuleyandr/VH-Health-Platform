# W1 — Backend Fail-Closed Tenant Resolution (design)

- **Date:** 2026-06-19 · **Wave:** 1 of the [multi-tenancy program](2026-06-19-multi-tenancy-program-design.md) (foundation).
- **Status:** Design — awaiting approval before implementation.
- **Branch:** `feat/multi-tenancy-program`.

## Objective

Exactly **one** tenant is resolved per authenticated request through **one** audited code path, and a request that *should* have a tenant but doesn't **fails closed** (403) instead of silently acting as the default tenant. The literal default is permitted **only** behind a new `ALLOW_DEFAULT_TENANT` flag for single-tenant installs. Current single-hospital prod is **untouched** (it sets `ALLOW_DEFAULT_TENANT=true`).

## Why this is the foundation

Every later wave assumes `req.tenantId` is trustworthy. Today resolution fails *open*: the middleware floors to `DEFAULT_TENANT_ID` (`tenantContextMiddleware.js:184` + catch `:212`), and ~237 files re-default with `|| DEFAULT_TENANT_ID`. The existing fail-closed gate (`:175-182`) only fires when `AUTH_ENFORCE_TENANT_RLS=true` — i.e. resolution policy is wrongly coupled to *DB-RLS posture*. W1 decouples them and makes honest resolution the default.

## Design

### 1. New flag — `ALLOW_DEFAULT_TENANT` (decoupled from `AUTH_ENFORCE_TENANT_RLS`)

Add to `src/config/tenantRlsConfig.js`:

```js
// Resolution policy: may a request with no resolvable tenant fall back to the
// literal DEFAULT_TENANT_ID (single-tenant installs), or must it fail closed?
// Default: NOT allowed (fail closed). Single-tenant prod opts in explicitly.
export function isDefaultTenantAllowed(env = process.env) {
  return String(env.ALLOW_DEFAULT_TENANT ?? '').toLowerCase() === 'true';
}
```

- **Independent of `AUTH_ENFORCE_TENANT_RLS`** (which stays the DB-RLS-enforcement switch). Resolution can be fail-closed even where DB RLS is permissive, and vice-versa.
- **Default = fail-closed.** `infra/.../configmap.yaml` sets `ALLOW_DEFAULT_TENANT: "true"` for the current single-hospital deploy (no behavior change); the flag flips to `false` at the multi-tenant cutover (W7).
- Test env keeps the legacy default-tenant convenience by setting `ALLOW_DEFAULT_TENANT=true` in `jest.setup.cjs`, except the W1 fail-closed test suite which sets it `false` explicitly.

### 2. `tenantContextMiddleware` — the single fail-closed gate

Rewrite the floor (lines 175–219) so resolution policy keys on `isDefaultTenantAllowed()`, not `enforceTenantRls`:

```
const allowDefault = isDefaultTenantAllowed();
// ...resolve via JWT claim → SUPER_ADMIN x-tenant-id override → resolveTenantForUser(uid)...

if (!tenantId && req.user) {                       // authenticated, unresolved
  if (!allowDefault) return next(AppError.forbidden(
    'Authenticated request has no tenant context', 'TENANT_CONTEXT_REQUIRED'));
  tenantId = DEFAULT_TENANT_ID;                     // single-tenant escape
}
if (!tenantId && !req.user) {                       // public / pre-auth route
  if (allowDefault) tenantId = DEFAULT_TENANT_ID;   // legacy behavior
  // else: leave req.tenantId = null — a public route that never touches a
  // tenant table proceeds; pre-auth tenant-aware login is W4.
}
if (tenantId) { /* getTenantById + status check + buildTenantContext as today */ }
req.tenantId = tenantId;                            // real UUID, or null on public routes when fail-closed
```

- `resolveTenantForUser(uid, { failClosed: !allowDefault })` — thread the same policy into the service so a lookup miss throws rather than returns the default.
- **catch block:** in fail-closed mode (`!allowDefault`) propagate the `AppError`/`TENANT_CONTEXT_UNAVAILABLE`; only default when `allowDefault`.
- **SUPER_ADMIN override + status checks unchanged.** The audited `x-tenant-id` path (`:140-169`) is preserved.

### 3. `resolveTenantOrThrow(req)` — explicit helper

In `src/services/tenant/tenantService.js` (or a small `tenantResolver.js`):

```js
export function resolveTenantOrThrow(req) {
  if (req?.tenantId) return req.tenantId;            // set by tenantContextMiddleware
  if (isDefaultTenantAllowed()) return DEFAULT_TENANT_ID;
  throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
}
```

The middleware already guarantees `req.tenantId` for authenticated routes, so this is the explicit, greppable replacement for the scattered `req.tenantId || … || DEFAULT_TENANT_ID` resolvers — and the single fallback site the lint rule allows.

### 4. The sweep (incremental, each phase gated)

- **1a — flag + helper + middleware + tests.** Land `isDefaultTenantAllowed`, `resolveTenantOrThrow`, the middleware rewrite, `resolveTenantForUser` policy, and the fail-closed test matrix. Set `ALLOW_DEFAULT_TENANT=true` in configmap + jest.setup. **Prod behavior identical.** Gate.
- **1b — request-path resolvers (~27).** Replace the per-controller/route `req.tenantId || … || DEFAULT_TENANT_ID` with `resolveTenantOrThrow(req)` (or bare `req.tenantId`, since the middleware guarantees it). Delete the per-file `DEFAULT_TENANT_ID` consts. Gate.
- **1c — service resolver helpers (~50–70).** `scopedTx`/`tenantOr`/`tenantOf` (`billingService.js:21`, `admissionService.js:113`, `problemListService.js:141`, `medicationReconciliationService.js:297`, …): a falsy tenant **throws** (behind `allowDefault`) instead of silently scoping to the default. Thread the resolved tenant from callers. Ensure the crons that call these helpers pass an explicit tenant or run under `runWithSuperAdmin`/`runInTenantContext` (so they don't break when the helper stops defaulting — full per-tenant cron fan-out is W3). Gate.
- **1d — hardening.** Stop destructuring `tenant_id` from `req.body`/`data` in service signatures (accept tenant only as an explicit scoping arg); replace hand-rolled `COALESCE(tenant_id, DEFAULT)` SQL filters (`sosController.js`, `feedbackService.js`, `searchService.js`) with GUC/RLS scoping; make `logTenantRlsRolePosture` **fatal** in prod when RLS is bypassed; add the lint rule (below). Gate.

### 5. Lint rule — `no-default-tenant-fallback`

A `scripts/check-no-default-tenant-fallback.mjs` wired into `npm run lint` (mirrors `check-phi-tenant-id`): fail CI on any **new** `|| DEFAULT_TENANT_ID`, `?? DEFAULT_TENANT_ID`, or hardcoded `'00000000-0000-4000-8000-000000000001'` outside an allowlist (`tenantService.js`, `tenantContextMiddleware.js`, `resolveTenantOrThrow`, the configmap). Seeds the allowlist with any residual sites a phase consciously defers, shrinking to empty by 1d.

## Test matrix (the gate for W1)

New `src/tests/.../tenantResolutionFailClosed.test.js` (+ a `tenant-isolation` deep seed reused by later waves):

| Case | `ALLOW_DEFAULT_TENANT` | Expect |
|---|---|---|
| Authenticated, tenant resolvable (claim/lookup) | either | `req.tenantId` = that tenant; 200 |
| Authenticated, **no** resolvable tenant | `false` | **403 `TENANT_CONTEXT_REQUIRED`** |
| Authenticated, no resolvable tenant | `true` | `req.tenantId` = `DEFAULT_TENANT_ID`; 200 (legacy) |
| Public/pre-auth route (no `req.user`) | `false` | proceeds; `req.tenantId` = null; no 403 |
| SUPER_ADMIN `x-tenant-id` + reason | either | acts as target tenant; `TENANT_OVERRIDE_USED` audited |
| SUPER_ADMIN `x-tenant-id` no reason | either | 400 `TENANT_OVERRIDE_REASON_REQUIRED` (unchanged) |
| Service helper called with falsy tenant | `false` | **throws** (no silent default) |
| `resolveTenantOrThrow(req)` with no tenant | `false` | throws `TENANT_CONTEXT_REQUIRED` |
| 2-tenant isolation seed (A+B) | `false` | tenant-A session cannot read tenant-B rows |

Authoritative gate per phase: `node apps/backend/scripts/run-ci-jest.mjs` as postgres ("All chunks passed") + `npm run lint` (incl. the new rule) + drift clean. **Crucial regression check:** the full suite green with `ALLOW_DEFAULT_TENANT=true` proves prod behavior is unchanged.

## Risks & mitigations

- **Blast radius (~237 files).** → Central helper + flag means most edits are mechanical (`|| DEFAULT_TENANT_ID` → `resolveTenantOrThrow`); landed in 4 gated phases, not one commit; `ALLOW_DEFAULT_TENANT=true` keeps prod identical throughout.
- **Public/pre-auth routes 403'ing.** → The gate fires only for *authenticated* requests with no tenant; public routes proceed with `req.tenantId=null`. Pre-auth tenant-aware login is explicitly W4.
- **Crons breaking when service helpers stop defaulting.** → 1c audits the cron callers; each passes an explicit tenant or runs under `runWithSuperAdmin`. (The 5 default-tenant crons' *fan-out* is W3; 1c only ensures they don't throw.)
- **Test-env churn.** → `jest.setup.cjs` sets `ALLOW_DEFAULT_TENANT=true` so existing deep tests are unaffected; the fail-closed suite opts out explicitly.

## Done-criteria

1. `ALLOW_DEFAULT_TENANT` flag + `resolveTenantOrThrow` + fail-closed middleware shipped; prod configmap sets it `true`.
2. All request-path + service resolver fallbacks routed through the helper or fail-closed; no silent `|| DEFAULT_TENANT_ID` outside the allowlist (lint-enforced).
3. Test matrix green; full chunked-as-postgres suite green both with the flag on (prod parity) and with the fail-closed suite's flag off.
4. ff `main` (local, HOLD); memory + program-spec wave status updated.

## Out of scope (later waves)

Per-tenant subdomain edge routing + token tenant claim on every login path (W4); the new untenanted-table migrations (W2); per-tenant cron fan-out + secrets (W3).
