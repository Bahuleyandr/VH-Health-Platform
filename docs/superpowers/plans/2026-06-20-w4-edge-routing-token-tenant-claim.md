# W4 Edge Routing & Token Tenant Claim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify the tenant from the request subdomain (Host), carry it in every token, trust the Host/token never a raw client header, and reject a token used on the wrong tenant's subdomain.

**Architecture:** Trust-by-topology — zero inbound ports + Cloudflare tunnel + per-tenant TLS make the Host unspoofable to another tenant, so the backend derives the tenant from `req.hostname`'s leftmost subdomain label and ignores client `x-tenant-*` (except the audited SUPER_ADMIN override). A bare host (no subdomain) resolves to the default tenant → single-tenant is byte-identical. Most token plumbing already exists from W3 (`issueAccessTokenAndClaimSession` injects `tenant_id`; `jwtMiddleware` reads it; `tenantContextMiddleware` prefers it); W4 adds Host derivation + the cross-check + plugs the login paths that bypass the helper.

**Tech Stack:** Node 22 + Express 5, Jest, JWT (jsonwebtoken).

**Spec:** `docs/superpowers/specs/2026-06-20-w4-edge-routing-token-tenant-claim-design.md`

**Status:** ✅ COMPLETE (2026-06-21). All tasks C1–C5 implemented + committed (`f2e8875a`, `626989d9`, `87b4189a`, `20bbfbd8`, `577aa5ad`, fix `6b7778d4`); full chunked-as-postgres gate GREEN ("All chunks passed", 87 chunks). HOLD (not pushed). Residual: `npx prisma generate` to refresh the local `admins` client (`tenant_id` is in schema.prisma but the generated client was stale; W4 code uses raw-SQL resolvers so it's unaffected; CI regenerates on install).

---

## Conventions (apply to every task)

- **NO-OP invariant:** every change is behaviour-identical when the request Host is the bare base host (no per-tenant subdomain) → default tenant. The existing auth/tenant suites under the default host are the regression check.
- **Per-task gate:** `DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test" PGPASSWORD=postgres node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit`. Commit only when green. (Unit tests that mock prisma need no DB.)
- **Final gate:** `DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test" PGPASSWORD=postgres node apps/backend/scripts/run-ci-jest.mjs` on a rebuilt DB → "All chunks passed". **Requires the QA cluster healthy (a machine reboot clears the desktop-heap exhaustion that downed it).**
- **TDD:** failing test first, watch it fail, implement minimally, watch it pass, commit. Tests go under `src/tests/*.deep.test.js` (integration) or `src/tests/unit/*.test.js` (pure).
- Paths are relative to `apps/backend/` unless absolute. No migration in W4 (admins.tenant_id already exists from mig 334).

---

## Task 1 — C1: `tenantFromHost(req)` + `TENANT_BASE_HOST` config

**Files:**
- Modify: `src/services/tenant/tenantService.js` (add `tenantFromHost`, export it)
- Modify: `src/scripts/testing/jest.setup.cjs` (set a test `TENANT_BASE_HOST`)
- Test: `src/tests/unit/tenantFromHost.test.js`

- [ ] **Step 1: Write the failing unit test**

```javascript
// src/tests/unit/tenantFromHost.test.js
import { jest } from '@jest/globals';
const getTenantBySlug = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({})); // placeholder
// NOTE: tenantFromHost calls getTenantBySlug internally; test via the real module with a mocked DB.
```
Because `tenantFromHost` calls `getTenantBySlug` (same module), test it as a **pure host-parse** first by extracting a `parseTenantSlug(host, baseHosts)` helper, then the DB resolve. Concretely:

```javascript
import { __testing__ } from '../../services/tenant/tenantService.js';
const { parseTenantSlug } = __testing__;

describe('parseTenantSlug', () => {
  const BASES = ['api.vhhealth.app', 'localhost'];
  it('bare base host → null (default tenant)', () => {
    expect(parseTenantSlug('api.vhhealth.app', BASES)).toBeNull();
    expect(parseTenantSlug('localhost', BASES)).toBeNull();
  });
  it('one subdomain label → slug', () => {
    expect(parseTenantSlug('apollo.api.vhhealth.app', BASES)).toBe('apollo');
    expect(parseTenantSlug('apollo.localhost', BASES)).toBe('apollo');
  });
  it('host not under any base → null (not our domain; default)', () => {
    expect(parseTenantSlug('evil.com', BASES)).toBeNull();
  });
  it('case-insensitive + strips port', () => {
    expect(parseTenantSlug('Apollo.LOCALHOST:5000', BASES)).toBe('apollo');
  });
});
```

- [ ] **Step 2: Run, verify it fails** (no `__testing__.parseTenantSlug`).

- [ ] **Step 3: Implement** in `tenantService.js`:
```javascript
// Base hosts the per-tenant subdomains sit under (comma list for prod/staging/dev).
function tenantBaseHosts() {
  return String(process.env.TENANT_BASE_HOST || 'localhost')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}
// Pure: extract the tenant slug (leftmost label) from a Host, or null for the bare base host.
export function parseTenantSlug(host, baseHosts = tenantBaseHosts()) {
  const h = String(host || '').toLowerCase().split(':')[0].trim();
  for (const base of baseHosts) {
    if (h === base) return null;                 // bare base host → default tenant
    if (h.endsWith('.' + base)) {
      const prefix = h.slice(0, -(base.length + 1));
      const label = prefix.split('.').pop();     // leftmost-of-the-prefix
      return label || null;
    }
  }
  return null;                                   // not our domain → default
}
// Resolve the tenant a request belongs to from its Host subdomain. Bare host /
// unknown domain → default tenant; a configured subdomain → that tenant (reject
// unknown/inactive, mirroring resolveTenantForRequest).
export async function tenantFromHost(req) {
  const slug = parseTenantSlug(req?.hostname || req?.headers?.host);
  if (!slug) return DEFAULT_TENANT_ID;
  const tenant = await getTenantBySlug(slug);
  if (!tenant || tenant.status !== 'active') {
    throw AppError.badRequest('Unknown or inactive tenant');
  }
  return tenant.id;
}
```
Add `parseTenantSlug` to the existing `__testing__` export (or create one); export `tenantFromHost`.

- [ ] **Step 4: Set test base host** — in `jest.setup.cjs`: `if (!process.env.TENANT_BASE_HOST) process.env.TENANT_BASE_HOST = 'localhost,api.vhhealth.app';`
- [ ] **Step 5: Run, verify PASS. Commit** — `git commit -m "feat(multi-tenancy): W4 C1 — tenantFromHost(req) subdomain resolution + TENANT_BASE_HOST"`

---

## Task 2 — C2: pre-auth resolution becomes Host-first

**Files:**
- Modify: `src/services/tenant/tenantService.js` (`resolveTenantForRequest`)
- Test: `src/tests/unit/resolveTenantForRequest.test.js` (new or extend)

- [ ] **Step 1: Write the failing test** — assert `resolveTenantForRequest(req)` resolves from the Host, and IGNORES client `x-tenant-id`/`x-tenant-slug`.

```javascript
// resolves from Host subdomain; client x-tenant-* ignored
const req = { hostname: 'apollo.localhost', headers: { 'x-tenant-id': SOME_OTHER_UUID, 'x-tenant-slug': 'evil' } };
expect(await resolveTenantForRequest(req)).toBe(APOLLO_TENANT_ID);   // from Host, not the headers
const bare = { hostname: 'localhost', headers: {} };
expect(await resolveTenantForRequest(bare)).toBe(DEFAULT_TENANT_ID); // bare → default
```
(Mock `getTenantBySlug` to map `apollo` → APOLLO_TENANT_ID active.)

- [ ] **Step 2: Run, verify fail** (current impl reads the headers).
- [ ] **Step 3: Implement** — replace `resolveTenantForRequest`'s body so it delegates to `tenantFromHost(req)` (drop the `x-tenant-id` / `x-tenant-slug` header branches). Keep the same return contract (always a valid tenant id; throws on unknown subdomain).
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Run the existing Firebase-login suite** (`jest firebaseAuthService --forceExit`) — it calls `resolveTenantForRequest`; under the default host it must still resolve to default (NO-OP). Fix any test that passed an `x-tenant-id` header expecting it to be honored — switch it to a Host (`req.hostname`).
- [ ] **Step 6: Commit** — `git commit -m "feat(multi-tenancy): W4 C2 — resolveTenantForRequest is Host-first; client x-tenant-* no longer trusted pre-auth"`

---

## Task 3 — C3: assert no path trusts a client tenant header (outside the SUPER_ADMIN override)

**Files:**
- Test: `src/tests/auth-tenant-header-trust.deep.test.js`
- (Likely no new code — C2 removed the pre-auth trust; this LOCKS it in.)

- [ ] **Step 1: Write the failing/guard test** — for a NON-SUPER_ADMIN authenticated request on tenant A's host carrying `x-tenant-id: B`, assert the resolved `req.tenantId` is A (header ignored), and that a Firebase login on A's host with `x-tenant-slug: B` mints an A-scoped token.
- [ ] **Step 2: Run** — should already pass if C2 is correct; if any path still honors the header, fix that path (grep `x-tenant-slug`, `x-tenant-id` across `src/` and confirm each read is either the SUPER_ADMIN override in `tenantContextMiddleware` or removed).
- [ ] **Step 3: Commit** — `git commit -m "test(multi-tenancy): W4 C3 — lock in: client x-tenant-* ignored outside the audited SUPER_ADMIN override"`

---

## Task 4 — C4: post-auth Host↔token cross-check (`tenantContextMiddleware`)

**Files:**
- Modify: `src/middleware/tenantContextMiddleware.js`
- Test: `src/tests/tenant-host-token-crosscheck.deep.test.js`

- [ ] **Step 1: Write the failing deep test** — seed tenants A+B (slugs `a-<sfx>`, `b-<sfx>`). With a valid tenant-A token (tenant_id=A) on host `b-<sfx>.localhost` → expect **403 `TENANT_HOST_TOKEN_MISMATCH`**. Same token on host `a-<sfx>.localhost` → allowed. On bare `localhost` → allowed (no cross-check). A SUPER_ADMIN token (platform, tenant_id null) on `b-<sfx>.localhost` → allowed (exempt).

```javascript
// driven through the middleware directly: set req.user (post-jwt) + req.hostname, run mw, assert.
```

- [ ] **Step 2: Run, verify fail** (no cross-check today).
- [ ] **Step 3: Implement** — after the JWT-claim tenant is resolved (and BEFORE returning `next()`), add:
```javascript
// W4 C4: a token minted for tenant X must not be used on tenant Y's subdomain.
if (!isSuperAdmin(req.user) && !req.tenantOverrideUsed) {
  let hostTenantId = null;
  try { hostTenantId = parseTenantSlug(req.hostname) ? await tenantFromHost(req) : null; }
  catch { hostTenantId = null; } // unknown subdomain handled elsewhere; don't 500 here
  if (hostTenantId && req.tenantId && String(hostTenantId) !== String(req.tenantId)) {
    return error(res, 'Tenant host/token mismatch', 403, { code: 'TENANT_HOST_TOKEN_MISMATCH' });
  }
}
```
Import `parseTenantSlug`, `tenantFromHost`. Only cross-checks when the Host carries a real subdomain (bare host → skip).

- [ ] **Step 4: Run, verify PASS.** Run the existing `tenant-override-audit` + `cross-tenant-rls.journey` suites — must stay green (SUPER_ADMIN + override exempt; default host skips).
- [ ] **Step 5: Commit** — `git commit -m "feat(multi-tenancy): W4 C4 — reject a token used on another tenant's subdomain (SUPER_ADMIN/override exempt)"`

---

## Task 5 — C5: every login path mints the right `tenant_id`

`issueAccessTokenAndClaimSession` already injects `tenant_id` (`tokenPayload.tenant_id ?? tokenPayload.tenantId ?? resolveTenantIdForUid(uid)`). The gaps: paths using bare `generateToken`, and admins (not in `users` → `resolveTenantIdForUid` mis-defaults).

**Files:**
- Modify: `src/services/auth/authService.js` (patient OTP login mint; admin login mint)
- Modify: `src/routes/.../devAuthRoutes.js` (dev login mint)
- Modify: `src/services/auth/loginSessionHelper.js` (optional: teach `resolveTenantIdForUid` to fall back to the `admins` table) OR pass `tenant_id` explicitly from admin login
- Test: `src/tests/login-tenant-claim.deep.test.js`

- [ ] **Step 1: Write the failing deep test** — seed tenant A (slug) + a patient (phone), a staff (employeeId), an admin (username, `admins.tenant_id=A`). For each login path executed on host `a.<base>`, decode the minted access token and assert `tenant_id === A`. Today: OTP/dev → no claim; admin → default (≠ A) → these FAIL.

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3a (patient OTP + dev):** replace the bare `generateToken(...)` mint with `issueAccessTokenAndClaimSession({ userUid: uid, tokenPayload: { uid, id, phone, role }, req, deviceType })` so the helper injects `tenant_id` from the user row (or pass `tenant_id: await resolveTenantForRequest(req)` explicitly for the Host tenant).
- [ ] **Step 3b (admin):** in `adminLogin`, pass `tenant_id: admin.tenant_id` into the `tokenPayload` (admins carry `tenant_id` since mig 334) so the helper uses it directly instead of the `users`-keyed lookup. Do the same in the refresh re-mint for admin tokens.
- [ ] **Step 3c (staff):** pre-resolve the Host tenant (`resolveTenantForRequest(req)`), scope the employee lookup to it, and pass `tenant_id` into the token payload.
- [ ] **Step 4: Run, verify PASS** (every path's token carries A). Run the existing auth suites (`authService`, `firebaseAuthService`, `staff`-login, `c9`/refresh) — green under default host.
- [ ] **Step 5: Commit** — `git commit -m "feat(multi-tenancy): W4 C5 — every login path (OTP/dev/admin/staff/refresh) mints the correct tenant_id"`

---

## Final gate & closeout

- [ ] **Rebuild the QA DB** (extensions-first recipe: drop+template0 → 6 extensions → ci-setup-db → qa-cluster-up) — see the program memory's cluster recipe. (Needs the cluster healthy post-reboot.)
- [ ] **Run the deferred W3-fix gate + this W4 gate together:** full chunked-as-postgres gate → "All chunks passed".
- [ ] **Guards:** lint (incl. `check:no-default-tenant-fallback`, `lint:raw-params`); no schema change so no drift/phi-guard delta expected.
- [ ] **Closeout:** update the W4 spec Status line + program-design Wave 4 status + the program memory (W4 DONE, on to W5). Branch stays on `feat/multi-tenancy-program` (HOLD); no ff main.

---

## Self-review notes (author)

- **Spec coverage:** C1↔Task1 (tenantFromHost); C2↔Task2 (Host-first pre-auth); C3↔Task3 (no client-header trust, locked by test); C4↔Task4 (Host↔token cross-check + SUPER_ADMIN/override exempt); C5↔Task5 (every token path). Wildcard DNS/TLS = HELD (closeout note), not a task. All spec components covered.
- **NO-OP invariant:** every task verified against the default-host path (bare host → default tenant) + the existing auth suites.
- **Naming consistency:** `parseTenantSlug(host, baseHosts)` (pure, `__testing__` + exported) and `tenantFromHost(req)` (async, exported) defined in Task 1 and reused by Tasks 2 + 4; `TENANT_HOST_TOKEN_MISMATCH` is the single cross-check error code.
- **Exact current code confirmed:** `issueAccessTokenAndClaimSession` injects `tenant_id` (loginSessionHelper.js:130-143); `resolveTenantIdForUid` queries `users` (mis-defaults admins) — Task 5b passes `admin.tenant_id` explicitly. The OTP/dev bare-`generateToken` sites are confirmed by the W4 exploration (authService patient OTP; devAuthRoutes) — verify exact line at implementation time before editing.
