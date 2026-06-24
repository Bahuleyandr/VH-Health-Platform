# OpenAPI Phase 3 — Admin Path-Drift Gate + Pipeline Hygiene — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Gate the admin's hand-curated API path map against the canonical spec (kill silent path drift), fix the live drift it surfaced, and make the generated-types pipeline honest — after closing a Phase-1 enumerator bug the gate work uncovered (the spec was missing the `/users/*` family).

**Architecture:** (Task 1) fix `generate-openapi.mjs`'s `wrapAsync`-wrapped-router blind spot so the spec is complete; (Task 2) a jest subset test asserts `API_ENDPOINTS` ⊆ spec `paths`; (Task 3) fix the ~31 drifted api-config entries the gate flags (incl. 3 live 404 bugs); (Task 4) pin/redirect/gitignore the generated-types pipeline + delete the dead DB-mirror.

**Tech Stack:** Node 22 ESM, jest (next/jest), openapi-typescript, GitHub Actions, lefthook. Spec `docs/superpowers/specs/2026-06-24-openapi-phase3-admin-path-gate-design.md`.

**KEY DISCOVERY (drove Task 1):** the path gate's analysis found 8 `/api/v1/users/*` paths the admin calls that are ABSENT from the spec — but they're REAL backend routes. Root cause: `apps/backend/src/routes/user/index.js` mounts sub-routers via `wrapAutoRBAC(..., { use: [['/', userRoutes]] })`, which wraps the **router** in `wrapAsync` (`routeWrapper.js:19`); the wrapper has no `.stack`, so the enumerator's `isRouter()` misses it. Only `user/index.js` uses this `use:`-pattern, so the impact is bounded to `/users/*` + `/lookup/*`. **The spec is currently incomplete — Task 1 fixes it.**

---

## File Structure

- Modify `apps/backend/src/config/routeWrapper.js` — tag `wrapAsync` output with `__wrappedFn`.
- Modify `apps/backend/scripts/generate-openapi.mjs` — unwrap `__wrappedFn` routers in the `use()` capture.
- Regenerate `apps/backend/src/docs/openapi.json` + re-sync `packages/vhhealth_core/swagger/openapi.json`.
- Create `apps/admin/src/__tests__/lib/api-config-spec-subset.test.ts` — the path-drift gate.
- Modify `apps/admin/src/lib/api-config.ts` — delete 12 dead leaves, fix ~19 drifted paths.
- Modify `apps/admin/src/lib/api/doctors.ts`, `apps/admin/src/lib/api/auth.ts` — the 3 live-404 call sites (path-value swaps are mostly call-site-safe; verify).
- Modify `apps/admin/package.json` — pin `openapi-typescript`, redirect `generate:types`.
- Modify `apps/admin/.gitignore` — ignore `src/lib/openapi.generated.ts`.
- Delete `apps/admin/src/lib/api-types.generated.ts` (dead DB-mirror, 0 importers).
- Modify `.github/workflows/_reusable-admin-ci.yml` — codegen smoke step.

---

## Task 1: Fix the enumerator's wrapAsync blind spot (Phase-1 correctness)

**Files:**
- Modify: `apps/backend/src/config/routeWrapper.js:19-26`
- Modify: `apps/backend/scripts/generate-openapi.mjs`

- [ ] **Step 1: Tag `wrapAsync` output** — in `routeWrapper.js`, replace the return (lines 23-25):

```js
  const wrapped = (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
  // Keep a reference to the wrapped fn so introspection (the OpenAPI route
  // enumerator in scripts/generate-openapi.mjs) can see through to a wrapped
  // sub-router mounted via wrapAutoRBAC/wrapRoutes `use:` maps.
  wrapped.__wrappedFn = fn;
  return wrapped;
```

- [ ] **Step 2: Unwrap in the generator's `use()` capture** — in `generate-openapi.mjs`, replace the `isRouter` helper + the `proto.use` handler-loop with an unwrap-aware version:

```js
// A router is either a function with its own .stack, OR a wrapAsync wrapper
// that tagged the underlying router on __wrappedFn (routeWrapper.js).
const asRouter = (h) => {
  if (typeof h !== 'function' || !h) return null;
  if (Array.isArray(h.stack)) return h;
  if (h.__wrappedFn && Array.isArray(h.__wrappedFn.stack)) return h.__wrappedFn;
  return null;
};
```
and in `proto.use`'s handler loop, replace the `if (isRouter(h)) {…}` body with:
```js
  for (const h of handlers) {
    const child = asRouter(h);
    if (child) {
      if (!edges.has(this)) edges.set(this, []);
      edges.get(this).push({ prefix, child });
    }
  }
```
(Delete the old `isRouter` const.)

- [ ] **Step 3: Regenerate + verify the `/users/*` family is now present**

Run:
```bash
cd apps/backend
node scripts/generate-openapi.mjs
node -e "const d=require('./src/docs/openapi.json'); for (const p of ['/api/v1/users','/api/v1/users/{identifier}','/api/v1/users/role/{role}','/api/v1/users/lookup/advanced','/api/v1/users/admin/dashboard']) console.log(p, !!d.paths[p]); console.log('paths', Object.keys(d.paths).length);"
```
Expected: every probed path prints `true`; total paths **> 2613** (the family is recovered).

- [ ] **Step 4: Verify no regression — spectral clean, drift green, 0 collisions, determinism**

Run:
```bash
cd apps/backend
npx spectral lint src/docs/openapi.json 2>&1 | tail -1                 # 0 errors
node scripts/generate-openapi.mjs 2>&1 | grep -ic collision || true     # 0 (no collision line)
node scripts/generate-openapi.mjs --out=/tmp/d1.json >/dev/null 2>&1 && node scripts/generate-openapi.mjs --out=/tmp/d2.json >/dev/null 2>&1 && diff -q /tmp/d1.json /tmp/d2.json && echo DETERMINISTIC
node scripts/check-openapi-drift.mjs; echo "drift: $?"
```
Expected: spectral `0 errors`; no collision; `DETERMINISTIC`; `drift: 0`. **If the regen surfaces NEW param-equivalent collisions in the recovered `/users/*` routes, resolve them the same way as the prior collision cleanup (param unification) before proceeding.**

- [ ] **Step 5: Re-sync the vhhealth_core copy**

Run: `cd apps/backend && npm run openapi:sync-core && node scripts/check-core-spec-sync.mjs; echo "core: $?"`
Expected: `core: 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/config/routeWrapper.js apps/backend/scripts/generate-openapi.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json
git commit -m "fix(openapi): enumerator misses wrapAsync-wrapped sub-routers (recover /users/* family)"
```

---

## Task 2: The path-drift gate (jest)

**Files:**
- Create: `apps/admin/src/__tests__/lib/api-config-spec-subset.test.ts`

- [ ] **Step 1: Write the gate test** (will FAIL initially, listing the drifted paths)

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { API_ENDPOINTS } from '@/lib/api-config';

// Real nav/mount-base prefixes (router mounts with children but no bare op) +
// non-/api/v1 infra. Allowlisted because the gate is a subset check on leaf
// operation paths, and these are legitimately not standalone operations.
const ALLOWLIST = new Set<string>([
  '/api-docs', '/ws',
  '/api/v1/admin/analytics', '/api/v1/admin/appointments', '/api/v1/admin/departments',
  '/api/v1/admin/investigations', '/api/v1/admin/pharmacy', '/api/v1/admin/records',
  '/api/v1/admin/sos', '/api/v1/admin/users', '/api/v1/staff/admin',
  '/api/v1/devices', '/api/v1/pharmacy-orders/inventory',
]);

const SENTINEL = '__P__';
const normApi = (p: string) =>
  p.split('?')[0]
    .replace(/:[A-Za-z0-9_]+/g, '{X}')
    .replace(/__P__/g, '{X}')
    .replace(/\$\{[^}]*\}/g, '{X}');
const normSpec = (p: string) => p.replace(/\{[^}]+\}/g, '{X}');

function collectLeaves(obj: unknown, keyPath: string, out: { key: string; path: string }[]) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const kp = keyPath ? `${keyPath}.${k}` : k;
    if (typeof v === 'string') out.push({ key: kp, path: v });
    else if (typeof v === 'function') {
      try { const r = (v as (x: string) => string)(SENTINEL); if (typeof r === 'string') out.push({ key: kp, path: r }); } catch { /* skip */ }
    } else if (v && typeof v === 'object') collectLeaves(v, kp, out);
  }
}

describe('api-config paths are a subset of the canonical OpenAPI spec', () => {
  it('every API_ENDPOINTS leaf path exists in apps/backend/src/docs/openapi.json', () => {
    const specPath = resolve(__dirname, '../../../../backend/src/docs/openapi.json');
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { paths: Record<string, unknown> };
    const specNorm = new Set(Object.keys(spec.paths).map(normSpec));

    const leaves: { key: string; path: string }[] = [];
    collectLeaves(API_ENDPOINTS, '', leaves);

    const missing = leaves
      .filter((l) => l.path.startsWith('/'))
      .filter((l) => !ALLOWLIST.has(l.path.split('?')[0]))
      .filter((l) => !specNorm.has(normApi(l.path)));

    const report = missing.map((m) => `  ${m.key}: ${m.path}`).join('\n');
    expect(missing, `api-config paths absent from the spec — fix the path or (only for real nav/mount bases) allowlist it:\n${report}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see the drift (expected FAIL)**

Run: `cd apps/admin && npx jest src/__tests__/lib/api-config-spec-subset.test.ts`
Expected: FAIL listing ~31 missing paths (the `toDelete` + `toFix` sets — the `/users/*` family is gone after Task 1). This is the worklist for Task 3.

- [ ] **Step 3: Commit the gate (still red — Task 3 makes it green)**

```bash
git add apps/admin/src/__tests__/lib/api-config-spec-subset.test.ts
git commit -m "test(admin): api-config path-drift gate (subset of the OpenAPI spec)"
```

---

## Task 3: Fix the drifted api-config paths (incl. 3 live 404 bugs)

**Files:**
- Modify: `apps/admin/src/lib/api-config.ts`
- Modify: `apps/admin/src/lib/api/doctors.ts`, `apps/admin/src/lib/api/auth.ts` (verify, likely no change needed — values are by key)

- [ ] **Step 1: Delete the 12 dead/junk leaves** from `api-config.ts` (and their now-unused parent keys if they become empty). Cross-check each is unreferenced (`grep -rn "API_ENDPOINTS.<key>" apps/admin/src`) before deleting; if referenced, delete the call site too:

```
staff.staffRoutes (/api/v1/staff/routes)
staff.attendanceRoutes (/api/v1/staff/attendance/routes)
staff.hrRoutes (/api/v1/staff/hr/routes)
sos.routes (/api/v1/sos/routes)
sos.adminRoutes (/api/v1/sos/admin/routes)
sos.emergencyRoutes (/api/v1/sos/emergency/routes)
infrastructure.rbac (/api/v1/rbac/routes)
investigations.routes (/api/v1/investigations/routes)
analytics.revenue (/api/v1/analytics/revenue)
auth.verify (/api/v1/verify)
pharmacy.medications.admin (/api/v1/pharmacy-orders/medications/admin)
pharmacy.medications.staff (/api/v1/pharmacy-orders/medications/staff)
```

- [ ] **Step 2: Fix the drifted paths** — change each api-config value (the KEY stays, so call sites are unaffected):

```
departments.comparison:    /api/v1/departments/comparison        -> /api/v1/departments/stats/comparison
departments.overview:      /api/v1/departments/overview          -> /api/v1/departments/admin/overview
departments.manage:        /api/v1/departments/manage            -> /api/v1/departments/admin/manage
departments.bulkOperations:/api/v1/departments/bulk-operations   -> /api/v1/departments/admin/bulk-operations
departments.stats:         /api/v1/departments/:id/stats         -> /api/v1/departments/stats/:id/stats
departments.analytics:     /api/v1/departments/:id/analytics     -> /api/v1/departments/stats/:id/analytics
departments.performance:   /api/v1/departments/:id/performance   -> /api/v1/departments/stats/:id/performance
departments.trends:        /api/v1/departments/:id/trends        -> /api/v1/departments/stats/:id/trends
records.list:              /api/v1/records                       -> /api/v1/records/records
devices.list:              /api/v1/devices                       -> /api/v1/devices/admin/list
devices.byId:              /api/v1/devices/:deviceId             -> /api/v1/devices/device/:deviceId
devices.userDevices:       /api/v1/devices/user/:userId          -> /api/v1/devices/my-devices
feedback.statistics:       /api/v1/feedback/statistics           -> /api/v1/feedback/analytics
feedback.byUser:           /api/v1/feedback/user/:userId         -> /api/v1/feedback/uid/:uid
doctors.workloadAnalysis:  /api/v1/doctors/workload-analysis     -> /api/v1/doctors/admin/workload-analysis   (LIVE 404 fix)
auth.generateOtp:          /api/v1/auth/generate-test-otp        -> /api/v1/auth/otp/request-otp              (LIVE 404 fix)
auth.verifyOtp:            /api/v1/auth/verify-test-otp          -> /api/v1/auth/otp/verify-otp               (LIVE 404 fix)
staff.search:              /api/v1/staff/search                  -> /api/v1/staff/admin/search
users.search:              /api/v1/staff/search                  -> /api/v1/users/search
```

- [ ] **Step 3: Run the gate; re-triage any straggler**

Run: `cd apps/admin && npx jest src/__tests__/lib/api-config-spec-subset.test.ts`
Expected: PASS. **If any path still fails:** it's either a real route at a slightly different path (grep `apps/backend/src/routes/**` + the spec's `paths` for the resource, fix the value) or a genuine nav/mount base (add to `ALLOWLIST` — but only if it's a prefix with children, never a real-but-wrong API path). Iterate until green.

- [ ] **Step 4: Verify the 3 live-404 call sites now resolve** (they read the fixed `API_ENDPOINTS` keys, so the value swap is enough) — confirm `apps/admin/src/lib/api/doctors.ts:76`, `apps/admin/src/lib/api/auth.ts:7,15` reference the keys (`API_ENDPOINTS...workloadAnalysis` / `auth.generateOtp` / `auth.verifyOtp`), not hard-coded paths:

Run: `cd apps/admin && grep -nE "workload-analysis|generate-test-otp|verify-test-otp" src/lib/api/*.ts`
Expected: no hard-coded stale paths (all go through `API_ENDPOINTS`); if a hard-coded path is found, repoint it to the key.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/api-config.ts apps/admin/src/lib/api
git commit -m "fix(admin): repoint 19 drifted api-config paths + drop 12 dead leaves (3 live 404s fixed)"
```

---

## Task 4: Generated-types pipeline hygiene

**Files:**
- Modify: `apps/admin/package.json`, `apps/admin/.gitignore`
- Delete: `apps/admin/src/lib/api-types.generated.ts`
- Modify: `.github/workflows/_reusable-admin-ci.yml`

- [ ] **Step 1: Pin openapi-typescript + redirect the generator** — in `apps/admin/package.json`, change the `generate:types` script and add the exact devDependency:

```
    "generate:types": "openapi-typescript ../backend/src/docs/openapi.json -o src/lib/openapi.generated.ts"
```
and under `devDependencies` add `"openapi-typescript": "7.13.0"` (exact, no caret). Then run `cd apps/admin && npm install` to write the lockfile.

- [ ] **Step 2: Gitignore the generated output** — append to `apps/admin/.gitignore`:

```
# OpenAPI-typescript output — regenerated from the canonical spec; not committed
# (path-only until Phase 5 attaches payload schemas; no consumer yet).
/src/lib/openapi.generated.ts
```

- [ ] **Step 3: Delete the dead DB-mirror** (confirm 0 importers first)

```bash
cd apps/admin && grep -rc "api-types.generated" src/ | grep -v ':0' || echo "0 importers — safe to delete"
git rm src/lib/api-types.generated.ts
```

- [ ] **Step 4: Run the generator (codegen smoke) — proves the spec is generatable**

Run: `cd apps/admin && npm run generate:types && head -3 src/lib/openapi.generated.ts && git status --short src/lib/openapi.generated.ts`
Expected: writes `src/lib/openapi.generated.ts` (~100k lines); `git status` shows nothing for it (gitignored).

- [ ] **Step 5: Wire the CI codegen smoke** — in `.github/workflows/_reusable-admin-ci.yml`, after the `- run: npm run lint` step, add:

```yaml
      - name: OpenAPI types codegen smoke (spec stays generatable)
        run: npm run generate:types
```

- [ ] **Step 6: Commit**

```bash
git add apps/admin/package.json apps/admin/package-lock.json apps/admin/.gitignore apps/admin/src/lib/api-types.generated.ts .github/workflows/_reusable-admin-ci.yml
git commit -m "chore(admin): pin openapi-typescript, redirect+gitignore generated types, drop dead DB-mirror"
```

---

## Task 5: Full verification + finish

- [ ] **Step 1: Admin gates** — all must pass:

```bash
cd apps/admin
npx jest src/__tests__/lib/api-config-spec-subset.test.ts   # gate green
npx tsc --noEmit                                            # type-check clean
npm test                                                    # full jest suite (no regressions)
npx next build                                              # production build
```

- [ ] **Step 2: Backend gates** (Task 1 touched the backend) — lint, spectral, drift, core-sync:

```bash
cd apps/backend
npm run lint 2>&1 | tail -2
npx spectral lint src/docs/openapi.json 2>&1 | tail -1
node scripts/check-openapi-drift.mjs; echo "drift: $?"
node scripts/check-core-spec-sync.mjs; echo "core: $?"
```
Expected: lint clean; spectral 0 errors; drift 0; core 0.

- [ ] **Step 3: Confirm no stray references to deleted paths/files**

Run: `cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && grep -rnE "api-types.generated|/staff/routes|/sos/routes|generate-test-otp" apps/admin/src | grep -v node_modules`
Expected: no results.

- [ ] **Step 4: Finish the branch** — merge `--no-ff` → `main`, push `origin` + `github`, delete branch. Tick ROADMAP §0 T2 #5 (Phase 3 done) + update memory (incl. the enumerator-bug fix).

---

## Self-Review

- **Spec coverage:** path-drift gate ✓ (Task 2); fix the ~41/now-31 broken paths ✓ (Task 3); pin openapi-typescript + redirect + gitignore ✓ (Task 4); delete dead DB-mirror ✓ (Task 4); CI codegen smoke ✓ (Task 4); Data-only alias correctly DEFERRED. **Added Task 1** (enumerator fix) — a spec requirement gap the gate work surfaced (the spec was incomplete); without it the gate would flag 8 real routes.
- **Placeholder scan:** none — the gate test is complete code, the api-config edits are an explicit value-mapping table, the enumerator fix is exact. Task 3 Step 3 ("re-triage stragglers") is a bounded self-correcting procedure (the gate output is the worklist), not hand-waving.
- **Consistency:** `normApi`/`normSpec`/`SENTINEL`/`ALLOWLIST` defined once in the gate test and used there; `__wrappedFn` tag (Task 1 Step 1) matches the `asRouter` unwrap (Task 1 Step 2); the `toFix` table keys match the triage.
- **Ordering safety:** Task 1 (complete the spec) precedes Task 2/3 (gate against it), so the gate never forces "fixing" the real `/users/*` routes. The generated file is gitignored (Task 4) before any commit could capture the 100k-line artifact.
- **Risk note:** Task 1 changes a backend runtime file (`routeWrapper.js`) — a 1-line tag that adds a property, no behavior change; verified by the full backend gate (Task 5 Step 2). Task 3's value-swaps keep api-config KEYS stable, so the 44 call sites are unaffected (verified by admin `tsc` + jest + build).
