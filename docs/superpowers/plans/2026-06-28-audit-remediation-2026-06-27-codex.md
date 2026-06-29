# VH Health — 2026-06-27 Codex Audit Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **For the human reviewer (Codex re-review):** Every code block is a concrete proposed change. Where a block says *"confirm current lines"* the exact line numbers must be re-verified against HEAD before patching (the fix intent and location are precise; only line drift is uncertain). Verdicts and evidence come from the delta re-verification of the 57-finding Codex scan; line anchors re-confirmed against HEAD `a4580cdd` on `main` — every patch-target file is unchanged since the `09f2c5f1` recheck. **This plan file is untracked** — re-check anchors if HEAD advances again before patching.

## Revision log

- **2026-06-28 (Codex re-review):** Applied 6 amendments — (1) re-anchored to `a4580cdd`/`main`; (2) Task 1.1 fails closed (no body-phone fallback, prefer uid binding); (3) Task 1.2 splits self-service from directory routers (whole user router shares one RBAC key, so a flat role removal would break `/profile` + `/me`); (4) Task 1.6 corrected to the verified empty-`routeMap` no-op (affects `doctorRoutes`/`doctorStatsRoutes` too) + a provable startup guardrail; (5) Task 3.2 HL7 uses a tenant-scoped lookup query, not read-then-compare; (6) Task 2.1 lists explicit finding IDs. Codex separately confirmed the ABDM `dataPushUrl` outbound guard already exists, so Phase 3.1 narrowing to callback-tenant equality is correct.

**Goal:** Remediate the confirmed, live findings from the 2026-06-27 Codex security scan, recalibrated against the actual deployment posture, without regressing legitimate clinical workflows.

**Architecture:** Three independent fix tracks. (1) Intra-tenant authz/integrity bugs that are live *now* in the single-tenant deployment — fixed directly. (2) The care-team patient-relationship program — mount the missing guards, then flip enforcement from `shadow` to `enforce` in a staged, telemetry-gated way. (3) Cross-tenant isolation gaps that are *latent* in single-tenant but must close before the multi-tenant cutover.

**Tech Stack:** Node 22 / Express 5, PostgreSQL 17 (Prisma + raw SQL via `src/lib/prisma.js`), Jest + supertest, Next.js admin. Tenant isolation via RLS auto-wrapper (`AUTH_ENFORCE_TENANT_RLS=true`) + `setTenant()`. Patient-relationship ABAC via `patientAccessGuard` + `careTeamEnforcement` (`care_team_enforcement_mode`, default `shadow`).

---

## Deployment posture (the lens — confirm before sign-off)

From `infra/kubernetes/apps/backend/configmap.yaml`:
- `AUTH_ENFORCE_TENANT_RLS: "true"` → RLS auto-scopes raw **and** Prisma-model calls (`src/lib/prisma.js:223-370`). Exceptions: queries inside interactive `prisma.$transaction(tx => …)` callbacks are **not** auto-scoped; tables without a `tenant_isolation` RLS policy get no filtering.
- `ALLOW_DEFAULT_TENANT: "true"` → **single-tenant today.** All *cross-tenant* findings are latent until the multi-tenant cutover (Phase 3 is the cutover gate).
- `CARE_TEAM_ENFORCEMENT_MODE` unset → defaults to `shadow` (`src/services/security/careTeamEnforcement.js:44`) → `careTeamModeGoverned` guards **log but never block.** This is why every patient-relationship bypass is live *intra-tenant now*.

**Guard mechanic (load-bearing for Phase 2):** `src/middleware/phiAccessMiddleware.js:92-98` — a `patientAccessGuard(TYPE)` mounted **without** `careTeamModeGoverned` ALWAYS enforces (real 403). Only `careTeamModeGoverned: true` sites obey the shadow default.

---

## Phase 0 — DO NOT TOUCH (verified fixed / false-positive / overstated)

These were in the Codex report but the recheck cleared them. Implementers must **not** "fix" them; reviewers should confirm the reasoning.

- [ ] **VH-R05-CAN-027 (safeFetch SSRF redirect) — FALSE POSITIVE.** `src/utils/ssrfGuard.js:206-225` `makePinnedLookup` pins every hop's DNS to the originally-validated public IPs and re-runs `isBlockedAddress`, so a 307/308 to an internal host cannot resolve there. Only residual: the IP-literal-host branch (`ssrfGuard.js:253-257`) does a plain fetch — optional hardening only (operator-provisioned endpoints).
- [ ] **VH-R04-CAN-024 (admin structural JWT) — FIXED (ADM-2).** `apps/admin/src/middleware.ts:27-51` does full `jose.jwtVerify` and fails closed in production; structural parse is dev-only.
- [ ] **VH-R01-CAN-008 (ABDM consent cross-tenant insert) — effectively safe.** `abdmService.js:302-325` rejects multi-tenant ABHA matches; insert is `setTenant`-scoped. *(Phase 3.1 still adds a callback-tenant equality assert as defense-in-depth.)*
- [ ] **VH-R08-CAN-041 (ABDM consent lifecycle) — effectively safe.** `_getConsentForPatient` enforces a `patient_uid` IDOR check (`abdmService.js:1031-1033`) + RLS auto-scope. Optional: add explicit `AND tenant_id=$N` to the lifecycle UPDATEs.

---

## Phase 1 — Critical + intra-tenant quick wins (live NOW, independent, low-risk)

### Task 1.1: Critical — stop caller-supplied role minting and cross-profile overwrite (CAN-001 + CAN-002)

**Files:**
- Modify: `apps/backend/src/services/user/userService.js` (`createOrUpdateProfile`, ~163-209)
- Modify: `apps/backend/src/controllers/user/userController.js:21-24`
- Test: `apps/backend/src/tests/user-profile-authz.deep.test.js` (create)

**Current (confirmed live):** create branch sets `role: data.role || USER_CONFIG.ROLES.PATIENT` straight from the body (`userService.js:198`); `userValidation` never declares `role` and express-validator does not strip undeclared fields (`userValidator.js:70`); the lookup keys on `body.phone` with no tie to the authenticated subject (`userService.js:170-184`). Route allows `PATIENT` (`rbacConfig.js:76`). A PATIENT can mint an ADMIN row for any phone and receive an ADMIN JWT on next Firebase login (`firebaseAuthService.js:142`).

- [ ] **Step 1 — failing test:**

```js
// apps/backend/src/tests/user-profile-authz.deep.test.js
// Seed a PATIENT (patientA) and a victim PATIENT (patientB) in the same tenant.
test('PATIENT cannot self-elevate role via /users/profile create', async () => {
  const res = await request(app)
    .post('/api/v1/users/profile')
    .set(patientAAuthHeaders)             // PATIENT JWT + api-key
    .send({ phone: newUnusedPhone, name: 'X', role: 'ADMIN' });
  expect(res.status).toBeLessThan(300);
  const row = await prisma.users.findFirst({ where: { phone: normalizePhone(newUnusedPhone) }, select: { role: true } });
  expect(row.role).toBe('PATIENT');       // role from body MUST be ignored
});

test('PATIENT cannot overwrite another patient profile by body phone', async () => {
  const res = await request(app)
    .post('/api/v1/users/profile')
    .set(patientAAuthHeaders)
    .send({ phone: patientB.phone, name: 'HACKED', blood_group: 'AB-' });
  expect([403, 404]).toContain(res.status);
  const victim = await prisma.users.findFirst({ where: { uid: patientB.uid }, select: { name: true } });
  expect(victim.name).not.toBe('HACKED');
});
```

- [ ] **Step 2 — run, expect FAIL** (`role` becomes ADMIN; victim overwritten).
- [ ] **Step 3 — fix the service.** Pass the authenticated caller in, force PATIENT on self-service create, and bind the self-service lookup to the caller. Change the controller call:

```js
// userController.js:21-24
const result = await UserService.createOrUpdateProfile(
  req.body,
  req.user?.uid || 'system',
  { callerRole: req.user?.role, callerUid: req.user?.uid, callerPhone: req.user?.phone }
);
```

In `userService.createOrUpdateProfile(data, createdBy, caller = {})` — self-service binds to the authenticated subject and **fails closed** (never falls back to body phone):

```js
const isPrivilegedActor = caller.callerRole === USER_CONFIG.ROLES.ADMIN
  || caller.callerRole === 'SUPER_ADMIN';

let existingUser;
let phone;
if (isPrivilegedActor) {
  // Admin/registration flow may target another user by body phone (existing behavior).
  phone = normalizePhone(data.phone || data.phoneNumber);
  existingUser = await prisma.users.findFirst({ where: { phone }, select: { uid: true, role: true } });
} else {
  // Self-service: identity comes ONLY from the token. Prefer uid; FAIL CLOSED if absent.
  if (!caller.callerUid && !caller.callerPhone) {
    throw AppError.forbidden('Authenticated identity required for profile self-service', 'PROFILE_NO_IDENTITY');
  }
  existingUser = caller.callerUid
    ? await prisma.users.findFirst({ where: { uid: caller.callerUid }, select: { uid: true, role: true } })
    : await prisma.users.findFirst({ where: { phone: normalizePhone(caller.callerPhone) }, select: { uid: true, role: true } });
  // CAN-002: refuse if the body names a phone other than the caller's own.
  const bodyPhone = (data.phone || data.phoneNumber) ? normalizePhone(data.phone || data.phoneNumber) : null;
  if (bodyPhone && caller.callerPhone && bodyPhone !== normalizePhone(caller.callerPhone)) {
    throw AppError.forbidden('You can only edit your own profile', 'PROFILE_NOT_OWNER');
  }
  phone = caller.callerPhone ? normalizePhone(caller.callerPhone) : null; // token phone only; may be null if uid-only
}
// ... existing update-by-uid (existingUser) / create branch continues with `phone` ...
```

On the **create** branch (`userService.js:194-203`) force the role for self-service and only honour `data.role` for privileged actors:

```js
role: isPrivilegedActor ? (data.role || USER_CONFIG.ROLES.PATIENT) : USER_CONFIG.ROLES.PATIENT,
```

For a self-service **create** the row's `phone` must come from `caller.callerPhone` (token), never the body; if a self-service caller is uid-only with no token phone and no existing row, reject (`PROFILE_NO_IDENTITY`) rather than inventing one. Privileged role assignment otherwise belongs to the dedicated admin user-management endpoints, not `/profile`.

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `fix(security): force PATIENT role + owner binding on self-service /users/profile (CAN-001, CAN-002)`

> **Reviewer note:** confirm no current flow relies on `/users/profile` to create non-PATIENT users (staff are created via `/staff/*` + `adminUserRoutes`/`bulk-import`). If one does, route it through an admin-gated endpoint instead of re-opening `role`.

### Task 1.2: Split self-service from the user directory, then de-PATIENT the directory (CAN-055)

**Files:** `apps/backend/src/routes/user/userRoutes.js` (split); create `apps/backend/src/routes/user/userSelfRoutes.js`; `apps/backend/src/routes/user/index.js:24-28` (two mounts); `apps/backend/src/config/rbacConfig.js` (new keys); `apps/backend/src/services/user/userService.js` (`listUsers` ~316-357, `getUsersByRole` ~542-551); test `apps/backend/src/tests/user-directory-authz.deep.test.js`.

**Current (confirmed):** the WHOLE `userRoutes` router (`/profile`, `/me`, `/`, `/:identifier`, `/role/:role`, `/search`, `/department`) is mounted under ONE RBAC key via `wrapAutoRBAC(router, 'userRoutes', { use: [['/', userRoutes]] })` (`index.js:24-28`). So flatly removing `PATIENT` from the `userRoutes` key would **also block `/profile` and `/me`**. Separately, `listUsers` returns unmasked `phone`/`address`/`email`, and `getUsersByRole` calls `listUsers` with a hardcoded ADMIN role, bypassing masking.

- [ ] **Test first:** PATIENT `GET /api/v1/users/` and `/users/role/DOCTOR` → `403`; PATIENT `GET /users/me` and `POST /users/profile` → still work; an authorized non-admin staff `GET /users/` sees masked phone + stripped address.
- [ ] **Fix (router split):**
  - Create `userSelfRoutes.js` holding the self-service verbs: `POST /profile` and `GET /me`.
  - Leave directory/admin verbs in `userRoutes.js`: `GET /`, `GET /:identifier`, `GET /role/:role`, `GET /department/:department`, `GET /search`, `POST /bulk-import`, `PUT /:identifier`, status, delete.
  - In `rbacConfig.js` add `userSelfRoutes: [PATIENT, GENERAL_STAFF, …staff…]` and tighten `userRoutes` (directory) to staff/admin only (**no PATIENT**).
  - In `index.js`, mount self routes **first** (so `/me`/`/profile` resolve before the directory `/:identifier`):

```js
wrapAutoRBAC(router, 'userSelfRoutes', { use: [['/', userSelfRoutes]] });
wrapAutoRBAC(router, 'userRoutes',     { use: [['/', userRoutes]] });
```

  - Apply the `searchUsers` masking path to `listUsers`, and fix `getUsersByRole` to pass the caller's real role instead of a hardcoded ADMIN.
- [ ] **Commit:** `fix(security): split self-service from user directory + mask listUsers (CAN-055)`

> **Reviewer note:** confirm no patient-app screen calls `GET /users/...` for non-self data; if it does, point it at a purpose-scoped endpoint before tightening the directory key.

### Task 1.3: Lookup OR-predicate enumeration bug (CAN-056)

**Files:** `apps/backend/src/services/user/lookupService.js:69-91`; test `apps/backend/src/tests/lookup-authz.deep.test.js`.

**Current:** the `role != 'ADMIN'` guard is pushed into the same `conditions[]` array that is then joined with **OR** (`lookupService.js:87-91`), so a non-matching `phone=` lookup degrades to `WHERE phone=X OR role != 'ADMIN'` → returns the whole non-admin directory.

- [ ] **Test first:**

```js
test('non-admin lookup with a nonexistent phone returns zero users', async () => {
  const res = await request(app).get('/api/v1/users/lookup?phone=0000000000')
    .set(generalStaffAuthHeaders);
  expect(res.body.data?.length ?? res.body.data?.results?.length ?? 0).toBe(0);
});
```

- [ ] **Fix:** group the search predicates with OR, then AND the role guard:

```js
// replace lines 69-91
const searchConditions = [];
if (phone) searchConditions.push(Prisma.sql`phone = ${normalizePhone(phone)}`);
if (uid) searchConditions.push(Prisma.sql`uid = ${uid}::uuid`);
if (name) searchConditions.push(Prisma.sql`LOWER(name) LIKE ${`%${name.toLowerCase()}%`}`);
if (email && ['ADMIN', 'DOCTOR'].includes(userRole)) {
  searchConditions.push(Prisma.sql`LOWER(email) LIKE ${`%${email.toLowerCase()}%`}`);
}
const whereParts = [Prisma.sql`(${Prisma.join(searchConditions, ' OR ')})`];
if (userRole !== USER_CONFIG.ROLES.ADMIN) {
  whereParts.push(Prisma.sql`role != 'ADMIN'`);
}
const whereClause = Prisma.sql`WHERE ${Prisma.join(whereParts, ' AND ')}`;
```

- [ ] **Commit:** `fix(security): AND the non-admin lookup role guard instead of OR (CAN-056)`

### Task 1.4: Lookup admin-only handlers (CAN-057)

**Files:** `apps/backend/src/routes/user/lookupRoutes.js:16-22`; `apps/backend/src/controllers/user/lookupController.js:96-170`.

- [ ] **Test first:** GENERAL_STAFF/HOUSEKEEPING/MAINTENANCE `→ /users/lookup/stats|/activity` and `POST /bulk-search` expect `403`; ADMIN `200`.
- [ ] **Fix:** point `/stats`, `/activity`, `/bulk-search` at the `enhanced*` controller methods that already enforce ADMIN/medical-staff, **or** add an `isAdmin(req.user.role)` guard at the top of each legacy handler; tighten `lookupRoutes` RBAC so only admin-class roles reach these verbs.
- [ ] **Commit:** `fix(security): admin-gate lookup stats/activity/bulk-search (CAN-057)`

### Task 1.5: E2E public-key directory — RBAC + uniform 404 (CAN-038)

**Files:** `apps/backend/src/routes/user/index.js:19-28`; `apps/backend/src/routes/user/publicKeyRoutes.js:26-61`.

- [ ] **Test first:** authenticated user requests another user's `/:id/public-key` with no messaging relationship → `404` identical to a non-existent id (no oracle).
- [ ] **Fix:** mount `publicKeyRoutes` *after* the `wrapAutoRBAC(router, "userRoutes", …)` wrapper (or give it its own auth scope), and return a uniform `404` for both "no such user" and "no key". Keep the per-tenant scope (RLS already applies post-tenant-middleware).
- [ ] **Commit:** `fix(security): scope + de-oracle e2e public-key directory (CAN-038)`

### Task 1.6: wrapAutoRBAC empty-routeMap no-op → doctor routers unguarded (CAN-003)

**Files:** `apps/backend/src/routes/doctor/index.js:11-50`; `apps/backend/src/config/routeWrapper.js:147-169` (guardrail).

**Root cause (verified):** `applyWrappers` only attaches `rbac(roles)` while iterating `routeMap` entries (`routeWrapper.js:48,83-85`). An **empty** `routeMap` (`{}`) makes that loop a NO-OP — no role check, no audit, no rate-limit. `doctor/index.js` calls `wrapAutoRBAC(adminDoctorRoutes, 'adminDoctorRoutes', {}, …)` and mounts it raw at `:50` with no parent guard (`/api/v1/doctors` parent is public-cache only). **The same empty-`{}` form is also used for `doctorRoutes` and `doctorStatsRoutes` (`:11-34`)** — so those are unguarded by these calls too (verify whether they carry inline `requireRole`). The working RBAC form is the `{ use: [['/', router]] }` entry used in `user/index.js:24`.

- [ ] **Test first:** PATIENT/GENERAL_STAFF/DOCTOR `→ POST /api/v1/doctors/admin/*` mutations `403`; ADMIN succeeds. Add equivalent assertions for the regular `/doctors` verbs if they have no inline guard.
- [ ] **Fix (mounts):** replace the three empty-`{}` calls with real RBAC; guard `/admin` explicitly:

```js
import { requireRole } from '../../middleware/rbacMiddleware.js'; // confirm canonical ADMIN constant in this file set
wrapAutoRBAC(router, 'doctorRoutes', { use: [['/', doctorRoutes]] });
wrapAutoRBAC(router, 'doctorRoutes', { use: [['/stats', doctorStatsRoutes]] });
router.use('/admin', requireRole('ADMIN'), adminDoctorRoutes); // adminDoctorRoutes still declares validators only
```

- [ ] **Fix (guardrail, stricter per Codex):** after the existing checks in `wrapAutoRBAC` (`routeWrapper.js:147-166`), throw when `routeMap` is empty for a non-`skipRBAC` key — an empty map protects nothing and this is provable without inferring a parent guard:

```js
if (!options.skipRBAC && !routeMapHasEntries(routeMap)) {
  throw new Error(`[routeWrapper] wrapAutoRBAC('${configKey}') called with an empty routeMap — no RBAC applied. Use { use: [['/', router]] }, or pass { skipRBAC: true } intentionally.`);
}
```

Run the suite/boot once; every other empty-map site this surfaces must be converted to the `use` form or marked `skipRBAC: true` with justification.

- [ ] **Commit:** `fix(security): guard doctor routers + make empty-routeMap wrapAutoRBAC throw (CAN-003)`

### Task 1.7: SUPER_ADMIN step-up on the control plane (CAN-043)

**Files:** `apps/backend/src/app.js` (clinical-AI control/forecast mounts ~990-1051; tenant-admin/tenant-context mounts); `apps/backend/src/middleware/rbacMiddleware.js:105-150`.

**Current:** `requireRole` lets SUPER_ADMIN bypass; clinical-AI governance/forecast + tenant-admin mounts use `requireRole` only while `/admin`,`/system`,`/logs` use `requireSuperAdminStepUp`.

- [ ] **Test first:** a SUPER_ADMIN JWT with `mfa:false` → governance/tenant-admin mutations expect `403`; with valid step-up claim → success.
- [ ] **Fix:** add `requireSuperAdminStepUp` after `requireRole(...)` on `admin/clinical-ai`, `clinical-ai/control`, `admin/forecast`, `admin/tenants`, `admin/tenant-context` mounts (confirm exact mount lines).
- [ ] **Commit:** `fix(security): require SUPER_ADMIN step-up on clinical-AI + tenant control plane (CAN-043)`

### Task 1.8: Internal docs/stats behind auth (CAN-044)

**Files:** `apps/backend/src/app.js:471-475`; `apps/backend/src/routes/internalRoutes.js:17-37`.

- [ ] **Test first:** each non-admin API-key class with no JWT → `/api/v1/internal/docs|stats` expect `401/403`.
- [ ] **Fix:** mount `/api/v1/internal` behind `jwtAuth` + `requireRole(ADMIN/IT_ADMIN)` (or the `requireProductionMonitoringAccess` token gate used by `/metrics`); drop the static-env-key fallback for introspection.
- [ ] **Commit:** `fix(security): gate internal docs/stats behind admin auth (CAN-044)`

### Task 1.9: CSV formula-injection — route all exporters through the safe helper (CAN-005)

**Files (all use a local CSV builder; replace with `utils/csv.js` `rowsToCsv`/`escapeCsvField`):** `controllers/infrastructure/rbacController.js:374-431`; `controllers/logs/logController.js:242-309`; `controllers/department/adminDepartmentController.js:238-251`; `controllers/staff/staffAdminOperationsController.js:143-407`; `controllers/staff/payrollController.js:1205-1334`; `services/research/researchRegistryService.js:667-772`; `services/staff/hr/reportingService.js:295-310`.

- [ ] **Test first (one per family):** a field beginning with `=`,`+`,`-`,`@`,tab,CR is neutralized (prefixed) and quotes/newlines escaped in the exported CSV.
- [ ] **Fix:** replace each manual builder with `rowsToCsv({ columns, rows })` from `apps/backend/src/utils/csv.js`.
- [ ] **Commit:** `fix(security): neutralize CSV formula injection across all exporters (CAN-005)`

### Task 1.10: Upload scan-bypass header (CAN-022)

**Files:** `apps/backend/src/controllers/upload/uploadController.js:20-27,50-66,111-120`; test `apps/backend/src/tests/unit/uploadController.test.js:143-158` (update expectation).

- [ ] **Test first:** ADMIN token + client `x-vh-internal-download` header against a `scan_status=failed|pending` file → expect `423`/`403` (NOT `200` + signed URL). Update the existing unit test that currently asserts 200.
- [ ] **Fix:** remove the request-header trust; only a server-side service identity (or a dedicated `DATA_PROTECTION_OFFICER` break-glass route that audit-logs the override + `scan_status`) may fetch non-clean files.
- [ ] **Commit:** `fix(security): drop client-controlled scan-bypass header on upload by-key (CAN-022)`

### Task 1.11: PHI audit logging on quality routes (CAN-035)

**Files:** `apps/backend/src/app.js:1203-1204` (quality mount).

- [ ] **Test first:** `GET /api/v1/quality/incidents` and `/quality/infection-control/surveillance` as an authorized role write a patient-attributed PHI audit row.
- [ ] **Fix:** add `phiAccessLogger('QUALITY_INCIDENT')` / `phiAccessLogger('INFECTION_CONTROL')` to the quality mount (mirror referrals/discharge mounts).
- [ ] **Commit:** `fix(hipaa): patient-attributed PHI logging on quality + infection-control (CAN-035)`

### Task 1.12: Monthly reward issuance hardening (CAN-034)

**Files:** `apps/backend/src/app.js:681-682`; `apps/backend/src/routes/steps/stepRewardsRoutes.js:319-406`.

- [ ] **Test first:** `POST /rewards/issue-monthly` is unavailable on the patient surface; admin route requires ADMIN + admin middleware and writes a batch-audit row.
- [ ] **Fix:** move issuance under an admin router with `adminRateLimiter` + `requireRole('ADMIN','SUPER_ADMIN')` (drop the inline check), add a batch-audit log entry (actor uid, month, count), keep per-winner idempotency. Leave patient rewards routes read/self-service.
- [ ] **Commit:** `fix(security): move monthly reward issuance to hardened admin route (CAN-034)`

### Task 1.13: Clinical-role gate on adherence-risk (CAN-052) + health-stats scoping (CAN-053)

**Files:** `apps/backend/src/routes/gamification/gamificationRoutes.js:14-32`; `apps/backend/src/routes/health/protectedRoutes.js:86-87`; `apps/backend/src/services/health/healthStatsService.js:7-31`.

- [ ] **CAN-052 test+fix:** non-clinical caller (incl. PATIENT) → adherence-risk endpoint `403`; add `requireRole(...clinical roles)` / `isClinical` gate so clinician-facing risk scoring/escalation is not patient-reachable.
- [ ] **CAN-053 test+fix:** restrict `/health/stats/overview` to admin/clinical analytics roles (remove PATIENT) and scope the `health_records` COUNTs by `req.tenantId` (or mount tenant/RLS middleware on this router — see Task 2.7).
- [ ] **Commit:** `fix(security): gate clinical risk + tenant-scope health stats (CAN-052, CAN-053)`

### Task 1.14: Downtime PHI packs — dedicated token / break-glass (CAN-054)

**Files:** `apps/backend/src/app.js:532-552`; `apps/backend/src/routes/downtime/staticDowntimeRoutes.js:1-142`.

- [ ] **Test first:** the generic monitoring token alone → ward-pack PHI `403`; a dedicated downtime token (or break-glass identity) → `200` + audit row.
- [ ] **Fix:** issue a separately-rotated downtime-access token distinct from the metrics token, restrict to clinical-ops, and write a centralized PHI audit (not just the local file) on access.
- [ ] **Commit:** `fix(security): separate downtime-pack auth from monitoring token + central PHI audit (CAN-054)`

---

## Phase 2 — Care-team patient-relationship program (staged)

> **Why staged:** flipping `care_team_enforcement_mode` to `enforce` globally risks over-blocking legitimate access where care-team/relationship data is incomplete (the documented reason the rollout shipped `shadow`). The safe sequence is: **(A) mount the missing guards** so telemetry covers every PHI route → **(B) review would-be-denials** → **(C) flip enforce per-tenant.** Two sub-classes get fixed immediately instead of via the flip: (1) routes with a *structural* bug independent of mode, and (2) specialty modules with **no** guard at all, where a non-governed (always-enforce) guard is appropriate if their relationship model is sound.

### Task 2.1: Specialty clinical modules — mount enforcing patient guards (CAN-046, CAN-047, CAN-048, CAN-049, CAN-050, CAN-051)

> Module→ID map: oncology = CAN-046, dental = CAN-047, ophthalmology = CAN-048, research registry = CAN-049, dietary = CAN-050, PCPNDT Form-F = CAN-051.

**Files:** `apps/backend/src/app.js` mounts — oncology `:933-935`, dental `:937-938`, ophthalmology `:940-941`, research `:929-931`, dietary `:1101-1102`, pcpndt `:1127-1128`.

**Current:** each has role RBAC + `phiAccessLogger` but **no** `patientAccessGuard`, so any in-role staff reads/mutates arbitrary patients.

- [ ] **Test first (per module):** an in-role clinician with no relationship to patient B → read/mutate B `403`; an assigned clinician → success.
- [ ] **Fix:** mount `patientAccessGuard('<ONCOLOGY|DENTAL|OPHTHALMOLOGY|DIETARY>')` on each (these resolve patient from `patient_uid`/path param — verify each route's id source). For research (CAN-049), add a registry-membership/study-role check in `listEnrollments`/export rather than a generic patient guard. For PCPNDT (CAN-051), restrict Form-F detail/list to the recording sonologist/case-assigned staff.
  - **Decision for review:** mount these *governed* (`careTeamModeGoverned: true`, fixed at flip) for consistency, **or** *non-governed* (immediate enforce). Recommendation: **non-governed for dental/ophthalmology/oncology/dietary** (clear treating-clinician model, low over-block risk), governed for research/pcpndt pending telemetry. Reviewer to confirm per module.
- [ ] **Commit (per module):** `fix(security): require patient relationship on <module> PHI routes (CAN-0xx)`

### Task 2.2: Clinical-AI + OP-AI patient guards (CAN-009, CAN-010)

**Files:** `apps/backend/src/routes/admin/clinicalAi/clinicalUseRoutes.js:184-203` (admission-ai-draft), `:491-585` (OP `/op/*`).

- [ ] **Test first:** clinical-AI role with no relationship to the admission/patient → `admission-ai-draft` and each `/op/*` route `403`, no `clinical_ai_generations` row.
- [ ] **Fix:** add `patientAccessGuardForResource('ADMISSION', { idSelector: req => req.body.admission_id, careTeamModeGoverned: true })` to `admission-ai-draft` (mirror `guardComposeAdmission` at `:84-99`); add `patientAccessGuard`/`patientAccessGuardForResource` resolving `patient_uid`/`appointment_id` to each `/op/*` route. Add an explicit `tenant_id` predicate to the `diagnoses` query in `opdClinicalAssistService.js` (defense-in-depth).
- [ ] **Commit:** `fix(security): patient-relationship guard on clinical-AI admission draft + OP assist (CAN-009, CAN-010)`

### Task 2.3: Staff messaging patient context (CAN-013, CAN-014)

**Files:** `apps/backend/src/routes/messaging/messagingRoutes.js:85-143,524-538`; `apps/backend/src/services/messaging/messagingService.js:209-223,565-607,754-807,1451-1464`.

- [ ] **Test first:** unrelated staff `GET /messaging/patient/:patientUid` → `403/404`; `POST /send|/broadcast` with a victim `patient_uid` they have no relationship to → rejected, no thread/message rows.
- [ ] **Fix:** for the read (CAN-013), restrict to threads the caller participates in (join `staff_message_thread_participants`) or add a relationship guard. For send/broadcast (CAN-014), validate `patient_uid` resolves to a tenant patient AND the sender has a care relationship before creating a `patient_context` thread.
- [ ] **Commit:** `fix(security): scope patient-linked staff messaging to participants/care-team (CAN-013, CAN-014)`

### Task 2.4: Referral patient-list guard (CAN-020)

**Files:** `apps/backend/src/routes/referral/referralRoutes.js:348-362`; `apps/backend/src/services/referral/referralService.js:1038-1058`; mount `apps/backend/src/app.js:1206-1207`.

**Current:** parent mount guard runs before the child `:uid` exists (`no_patient_context` allowed); broad `isClinical` roles list any patient's referrals.

- [ ] **Test first:** unrelated clinical user `GET /referrals/patient/:uid` → `403`; referring/receiving clinician → success.
- [ ] **Fix:** move the guard to the child `/patient/:uid` route (so the param is bound) or set `requirePatientContext: true`; add a referring/receiving/care-team relationship check in `getPatientReferrals`.
- [ ] **Commit:** `fix(security): enforce relationship on referral patient list (CAN-020)`

### Task 2.5: Records-by-uid/phone child-route guard (CAN-039)

**Files:** mount `apps/backend/src/app.js:648`; `apps/backend/src/routes/record/patientRoutes.js:22-38`; `apps/backend/src/services/record/recordService.js:54-148`.

- [ ] **Test first:** unrelated staff `GET /records/uid/:uid` and `/records/health-records/:phone` for a victim → `403/404`; assigned care-team → success.
- [ ] **Fix:** move `patientAccessGuard` onto each child `/uid/:uid` / `/:phone` route (params bound), or add path-aware patient-context extraction; push a relationship check into `recordService.getRecordsByUID`/`getHealthRecordsByPhone` so PHI is not returned by identifier+privacy alone.
- [ ] **Commit:** `fix(security): relationship check on records-by-identifier (CAN-039)`

### Task 2.6: FHIR + investigation list require patient context (CAN-030, CAN-031, CAN-017)

**Files:** `apps/backend/src/app.js:780-795` (FHIR), `:649` (investigation); `apps/backend/src/middleware/fhirPatientContext.js:46-74`; `apps/backend/src/controllers/investigation/bookingController.js:300-656`.

- [ ] **CAN-030 test+fix:** FHIR resource searches with no `patient`/`subject` → `403` for non-privileged roles; set `requirePatientContext` (or reject absent-patient search) and reserve unfiltered search for an explicit export role.
- [ ] **CAN-031 test+fix:** `GET /investigations/list` with no patient filter for a non-privileged clinical role → scoped/`403`, not the full tenant list; gate the unfiltered operational queue to lab/admin roles.
- [ ] **CAN-017 test+fix:** booking-by-id workflow handlers → add an intra-tenant patient/booking relationship check (or move the guard to the child route so the booking id is resolvable).
- [ ] **Commit:** `fix(security): require patient context on FHIR/investigation list + booking workflow (CAN-030, CAN-031, CAN-017)`

### Task 2.7: Health vitals router — tenant context + relationship + remove default-tenant (CAN-028, CAN-029, CAN-045)

**Files:** `apps/backend/src/app.js:519` (health mount, before tenant middleware); `apps/backend/src/routes/health/index.js:35-41`; `apps/backend/src/controllers/health/patientHealthController.js:287-396,456-537,564-654`; `apps/backend/src/routes/emr/deviceVitalsRoutes.js:32-64`; `apps/backend/src/services/emr/deviceVitalsService.js:25,55-188`.

- [ ] **Test first:** a nurse with no relationship to patient B → read/create/correct B vitals `403`; device-vitals ingest with no tenant context → fails (does not default-tenant).
- [ ] **Fix:** mount `tenantContextMiddleware` + `tenantRlsMiddleware` (or `setTenant`) on the protected health sub-router (it currently sits before global tenant middleware); add a `patientAccessGuard`/relationship check to vitals read + `recordStaffVitals`/`updateStaffVitals`; in `deviceVitalsService` remove the hardcoded `DEFAULT_TENANT` fallback and require `req.tenantId`, scoping list/verify/audit explicitly.
- [ ] **Commit:** `fix(security): tenant context + relationship guards on health/device vitals (CAN-028, CAN-029, CAN-045)`

### Task 2.8: Telemetry review + staged enforce flip (CAN-011)

**Files:** `infra/kubernetes/apps/backend/configmap.yaml`; per-tenant `tenants.settings.care_team_enforcement_mode`.

- [ ] **Step 1:** with all guards from 2.1-2.7 mounted (governed sites), run shadow for a defined window and query `patient_access_audit_log` for would-be-denials; classify legitimate-but-denied patterns (missing care-team rows, break-glass needs).
- [ ] **Step 2:** remediate the legitimate gaps (populate care-team links / add break-glass), re-confirm telemetry is clean.
- [ ] **Step 3:** flip `enforce` per-tenant via `tenants.settings.care_team_enforcement_mode='enforce'` (then deployment-wide `CARE_TEAM_ENFORCEMENT_MODE=enforce`). **Heed the enforce-oracle hazard** (unresolved-ref 200 vs no-relationship 403) — use the in-route-403-both precedent (CDS/documents) so enforce does not become a patient-existence oracle.
- [ ] **Step 4:** add a deep test asserting an unrelated clinician is denied on a representative governed route under `enforce`.
- [ ] **Commit:** `chore(security): flip care-team ABAC to enforce after shadow telemetry (CAN-011)`

---

## Phase 3 — Cross-tenant hardening (latent now; GATE for multi-tenant cutover)

> Do these **before** flipping `ALLOW_DEFAULT_TENANT=false`. In single-tenant they are inert; at cutover they become live.

### Task 3.1: ABDM callback tenant-equality (CAN-007, + CAN-008 defense)

**Files:** `apps/backend/src/routes/abdm/abdmRoutes.js:176-197`; `apps/backend/src/services/abdm/abdmService.js` (`handleDataRequest` ~639-661, `handleConsentRequest` ~381-460).

**Current:** `handleDataRequest` derives `tenantId` from `consent.tenant_id` and never compares it to the HMAC-authenticated callback tenant (`req.tenantId`); `dataPushUrl` is request-body-supplied. A holder of tenant-A's callback secret naming a tenant-B `consent_id` exports tenant-B PHI.

- [ ] **Test first (two-tenant):** tenant-A-authenticated `/health-info/on-request` naming a tenant-B `GRANTED` consent → `403` (`ABDM_CONSENT_TENANT_MISMATCH`), no data push. Tenant-matching callback still succeeds.
- [ ] **Fix:** thread the authenticated tenant in and assert equality:

```js
// abdmRoutes.js:187
const result = await abdmService.handleDataRequest(dataRequest, req.tenantId);
```
```js
// abdmService.handleDataRequest(dataRequest, callbackTenantId) — after line 656
const tenantId = consent.tenant_id;
if (!tenantId) throw AppError.forbidden('Consent has no tenant binding', 'ABDM_CONSENT_NO_TENANT');
if (callbackTenantId && String(tenantId) !== String(callbackTenantId)) {
  throw AppError.forbidden('Consent tenant does not match authenticated callback', 'ABDM_CONSENT_TENANT_MISMATCH');
}
```
Apply the same `callbackTenantId === resolvedTenant` assertion in `handleConsentRequest` (CAN-008 defense-in-depth).

- [ ] **Commit:** `fix(security): assert ABDM callback tenant == consent/patient tenant (CAN-007, CAN-008)`

### Task 3.2: HL7 inbound patient tenant-equality (CAN-021)

**Files:** `apps/backend/src/routes/hl7/hl7Routes.js:98-108` (`loadHl7Patient`) + call sites `:171,221,253`.

**Current:** `loadHl7Patient` looks the patient up globally and writes under `patientRow.tenant_id` with no check against the authenticated receiving-facility tenant (`req.tenantId`).

- [ ] **Test first (two-tenant):** tenant-A-authenticated ADT/ORM/ORU naming a tenant-B patient UID → `AE` ACK "not registered at this facility", no rows written to tenant B.
- [ ] **Fix:** make the lookup itself tenant-scoped (a true scoped query, not read-then-compare — cleaner and removes the global read entirely):

```js
async function loadHl7Patient(patientUid, authenticatedTenantId) {
  if (!authenticatedTenantId) return null; // no authenticated tenant → refuse
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, tenant_id::text AS tenant_id, phone
       FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid AND is_active = true
      LIMIT 1`,
    patientUid, authenticatedTenantId);
  return rows[0] || null; // a patient in another tenant is simply not found
}
```
Update the three call sites to `loadHl7Patient(patient.uid, req.tenantId)` (and `patientUid` for ORU). A cross-tenant patient now falls through the existing `if (!patientRow) … 404 "not registered at this facility"` path.

- [ ] **Commit:** `fix(security): refuse HL7 writes to patients outside the authenticated facility tenant (CAN-021)`

### Task 3.3: Infrastructure RBAC routes — tenant context (CAN-004)

**Files:** `apps/backend/src/app.js:549-588,610-620`; `apps/backend/src/services/infrastructure/rbacService.js:100-170,243-278`; `apps/backend/src/controllers/infrastructure/rbacController.js:374-434`.

- [ ] **Test first (two-tenant):** tenant-A admin + infra API key `→ /rbac/users|/admin/export` returns only tenant-A rows.
- [ ] **Fix:** either move the infrastructure RBAC mount below `tenantContextMiddleware` + `tenantRlsMiddleware` (so the auto-wrapper scopes its reads), or wrap the user/analytics/export queries in `setTenant(req.tenantId, …)` / add explicit `tenant_id` predicates. Reserve any genuine cross-tenant view for an audited SUPER_ADMIN path.
- [ ] **Commit:** `fix(security): tenant-scope infrastructure RBAC reads/exports (CAN-004)`

### Task 3.4: RLS posture fail-closed at boot (CAN-040)

**Files:** `apps/backend/src/lib/prisma.js:861-940` (`logTenantRlsRolePosture`).

- [ ] **Test first:** boot in production mode with `AUTH_ENFORCE_TENANT_RLS=false` (or a mocked BYPASSRLS/superuser role) → process exits / readiness fails before serving.
- [ ] **Fix:** when `NODE_ENV==='production'` and posture is not enforced/ok, `throw`/`process.exit(1)` (or fail readiness) instead of only logging; gate an explicit audited override env for single-tenant maintenance.
- [ ] **Commit:** `fix(security): fail closed when production tenant RLS is off/inert (CAN-040)`

### Task 3.5: Defense-in-depth explicit tenant predicates (RLS-mitigated set)

> Uniform change: add `AND tenant_id = $tenant` (and thread `req.tenantId` where the service lacks it) so correctness survives an RLS misconfig and the `$transaction`-callback gap. Each is its own test (two-tenant, with RLS toggled on AND off in the harness) + commit. **Worked example then table.**

- [ ] **Worked example — CAN-006 (SOS report):** `apps/backend/src/controllers/sosController.js:389-405` — append `AND ${SOS_TENANT_FILTER}` (with `tenantOf(req)`) to the performance-report query, matching the sibling SOS queries at `:323-360`. Test: responded SOS alerts seeded in two tenants → tenant-A report excludes tenant B with RLS on and off.

| Finding | File:lines | Change |
|---|---|---|
| CAN-015 | `routes/analyticsRoutes.js:43-145,338-545`, `routes/admin/services/statsService.js`, `activityService.js` | add `tenant_id` predicates to admin dashboard/analytics/active-users raw queries (or `setTenant`) |
| CAN-016 | `controllers/staff/payrollController.js:260-512`, `salaryRevisionController.js:245-311` | add `tenant_id` to payroll/salary selects + updates |
| CAN-018 | `controllers/appointment/appointmentListController.js:10-110`, `services/appointment/appointmentQueryService.js:412-526` | seed `tenant_id` into the where clause + completed-picker raw SQL |
| CAN-023 | `controllers/upload/uploadController.js:93-125,168-175` | add `AND tenant_id=$2` to by-key lookup + explicit tenant on insert; replace blanket internal-admin bypass with owner/relationship check |
| CAN-032 | `controllers/investigation/bookingController.js:11-62,116-158` | pass `req.tenantId` into patient resolution + `investigation_bookings` insert |
| CAN-033 | `services/pharmacy/orderService.js:57-87` | scope phone lookup + `pharmacy_orders` insert by `tenant_id` |
| CAN-036 | `controllers/compliance/indicatorsController.js:21-60` | add `tenant_id` to the four compliance-indicator counts |
| CAN-042 | `controllers/admin/auditQueryController.js:8-142,225-337` | add `tenant_id` to list/search/export/summary; project `al.tenant_id` (not NULL) in the request-audit branch |
| CAN-019 | `services/gamification/pointService.js:44-127,398-419`, `controllers/dashboard/dashboardController.js:31-101` | thread `tenant_id` into every phone/uid lookup (post mig-333 per-tenant phone) |
| CAN-037 | `services/gamification/adherenceRiskService.js:61-99` | accept `tenantId`, add `tenant_id` to each read |
| CAN-012 | `services/gamification/pointService.js:10-29,329-354,495-517`, `routes/gamification/adminGamificationRoutes.js:120-160` | `tenant_id` on ledger/voucher reads + admin voucher redeem; treat self-reported step rows as reward-ineligible without attestation |

- [ ] **Commit (per finding or grouped):** `fix(security): explicit tenant predicate on <area> (CAN-0xx)`

### Task 3.6: ABDM artefact verification + ABHA binding (CAN-026, CAN-025)

**Files:** `apps/backend/src/utils/validateEnv.js:242-252`; `apps/backend/src/services/abdm/abdmService.js:177-239,327-334`.

- [ ] **CAN-026 test+fix:** when `ABDM_ENABLED=true`, make `ABDM_VERIFY_CONSENT_ARTEFACT=true` + `ABDM_CM_PUBLIC_KEY` **required at boot** (Joi in `validateEnv.js`), so prod cannot run with CM-artefact verification off. Test: boot with ABDM enabled + flag unset → startup fails.
- [ ] **CAN-025 test+fix:** add a `verification_status` to the ABHA binding; when `verifyABHA` throws (gateway down) mark `unverified` rather than binding as verified, and require `verified` before any ABDM data exchange uses the link. Test: mock `verifyABHA` to throw → row stored `unverified`, not used for exchange.
- [ ] **Commit:** `fix(security): require ABDM artefact verification at boot + unverified ABHA gating (CAN-026, CAN-025)`

---

## Phase 4 — Delta findings (new code since the scan)

### Task 4.1: Idempotency fail-closed for required clinical routes (DELTA-001) — HIGH

**Files:** `apps/backend/src/middleware/idempotencyMiddleware.js:58-92`; readiness in `apps/backend/src/routes/health/uptimeRoutes.js`; test `apps/backend/src/tests/cpoe-order-idempotency.deep.test.js`.

**Current:** claim exception (`:67-71`) and `schemaMissing` (`:92`) both `return next()` even for `required:true` routes → duplicate medication orders on offline retry during an idempotency-store fault.

- [ ] **Test first:** mock `claimIdempotencyKey` to throw, and to return `{ schemaMissing: true }`; `POST /api/v1/emr/orders` (required mount) → non-2xx, zero new `clinical_orders` rows.
- [ ] **Fix:**

```js
// :67-71 catch
} catch (err) {
  logger.error('Idempotency claim failed:', { error: err.message, scope });
  if (required) return error(res, 'Idempotency store unavailable; request rejected', 503, { scope });
  return next();
}
// replace :92
if (claim.schemaMissing) {
  if (required) return error(res, 'Idempotency store not available; request rejected', 503, { scope });
  return next();
}
if (!claim.id) return next();
```
Add a readiness probe that fails if migration `130_idempotency_keys` is absent.

- [ ] **Commit:** `fix(safety): fail closed on idempotency-store faults for required routes (DELTA-001)`

### Task 4.2: ED realtime channel/role alignment (DELTA-002) — MEDIUM (reliability)

**Files:** `apps/admin/src/lib/routePolicy.ts:165`; `apps/admin/src/app/(with-auth)/dashboard/ed-tracker/page.tsx:112`; `apps/backend/src/utils/websocket/channelAuth.js:40-87`; backend ED emit (`utils/websocket/realtimeEmitter.js`).

**Current:** ED board reachable at `minRank: STAFF` but subscribes to admin-only `admin:ed-board` → non-admin staff WS subscribe denied, silent polling fallback.

- [ ] **Test first:** backend channel-auth test — an ED clinical role can subscribe to the chosen channel; page/hook test — a `denied` subscription stays on fallback polling AND surfaces an explicit degraded-realtime indicator.
- [ ] **Fix (pick one, reviewer decides):** (a) rename the channel to `staff:ed-board`, authorize it for ED/clinical roles in `channelAuth.js` + `CHANNEL_CATALOG`, and emit on that channel; OR (b) make the ED board admin-only in `routePolicy.ts`. Either way, destructure and display the `denied` state from `useRealtimeInvalidation`.
- [ ] **Commit:** `fix(realtime): align ED board channel scope with page access + show degraded state (DELTA-002)`

---

## Self-review (completed by author)

- **Spec coverage:** all 57 scan findings accounted for — Phase 1 (15 intra-tenant), Phase 2 (care-team cluster: CAN-009/010/011/013/014/017/020/028/029/030/031/039/045/046/047/048/049/050/051), Phase 3 (cross-tenant CAN-004/006/007/008/012/015/016/018/019/021/023/025/026/032/033/036/037/040/042 + 041 optional), Phase 0 (CAN-008/024/027/041 not-to-touch), Phase 4 (DELTA-001/002). CAN-002/038/043/044/052/053/054/055/056/057/005/022/034/035 in Phase 1.
- **Placeholder scan:** code blocks are concrete; remaining "confirm current lines" notes are line-drift flags, not logic placeholders.
- **Type/name consistency:** `loadHl7Patient(uid, authenticatedTenantId)`, `handleDataRequest(dataRequest, callbackTenantId)`, `careTeamModeGoverned`, `patientAccessGuard`/`patientAccessGuardForResource` used consistently.

## Sequencing & risk

1. **Phase 1** — ship now (independent, low-regression). CAN-001 first.
2. **Phase 2** — guards first (2.1-2.7), then telemetry, then the enforce flip (2.8). The flip is the highest-regression step; gate on clean telemetry + the enforce-oracle precedent.
3. **Phase 3** — complete before `ALLOW_DEFAULT_TENANT=false`.
4. **Phase 4** — DELTA-001 alongside Phase 1 (clinical safety); DELTA-002 anytime.

Authoritative gate: chunked `run-ci-jest.mjs` as the `postgres` role; add the two-tenant deep tests for Phase 3.
