# CareTeam ABAC — Design (PHI access scoping for clinicians)

Status: **DESIGN ONLY — not yet implemented. Human review required before any code/migration.**
Author: investigation pass, 2026-06-14. Target repo: `apps/backend`.
Scope: attribute-based access control (ABAC) that scopes clinician PHI/chart access to the
patient's **care team**, layered on the existing tenant RLS without breaking it.

> **TL;DR for reviewers.** The data model and an app-layer ABAC engine for this **already exist**
> in the codebase (migration `260`, `accessDecisionService.js`). The gap is **enforcement coverage**:
> the enforcing guard is mounted on only ~4 PHI route families; the other ~50 are audit-only
> (`phiAccessLogger`), so clinician chart access is in practice tenant-scoped, not care-team-scoped.
> This design is therefore **mostly a rollout + hardening plan for what's already built**, plus an
> optional defense-in-depth RLS layer — *not* a greenfield build. Do not re-create the tables.

---

## 1. Current state (grounded in code)

### 1.1 Tenant RLS (the layer we compose with — do NOT break)

- GUC-driven RLS. `tenant_isolation` policies are installed by migrations
  `075_tenant_rls_policies.sql`, `236_tenant_rls_phi_phase_1.sql`,
  `238_tenant_rls_phi_phase_2b.sql`, `239_tenant_rls_phi_phase_2c.sql`,
  `304_tenant_rls_policy_coverage.sql`. Each policy is identical in shape
  (`075_tenant_rls_policies.sql:55-69`):

  ```sql
  CREATE POLICY tenant_isolation ON <table>
    USING (
      current_setting('app.current_tenant_id', true) IS NULL
      OR current_setting('app.current_tenant_id', true) = ''
      OR current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = app_current_tenant_id_uuid()
    )
    WITH CHECK ( ...same... );
  ```

  Three GUC cases (`app_current_tenant_id_uuid()`, `075:21-32`): unset/empty → permissive,
  `'bypass'` → all rows (SUPER_ADMIN), `<uuid>` → tenant-scoped.

- The GUC is set **transaction-locally** by `setTenant` / `setTenantTx`
  (`src/lib/prisma.js:458-471, 505-559`) via `set_config('app.current_tenant_id', $1, true)`,
  optionally preceded by `SET LOCAL ROLE <runtime role>`. A bare `prisma.$transaction`
  is NOT tenant-scoped by design (`prisma.js:473-492`).

- Auto-wrapping. When `AUTH_ENFORCE_TENANT_RLS=true` and an AsyncLocalStorage tenant
  context is active, the Prisma proxy auto-wraps raw + model calls in `setTenant`
  (`prisma.js:195-218, 323-353`). This is the mechanism a care-team GUC would piggyback on.

- Enforcement is inert unless the effective DB role is non-SUPERUSER/non-BYPASSRLS
  (`evaluateTenantRlsPosture`, `prisma.js:619-704`; boot guard `logTenantRlsRolePosture`,
  `prisma.js:814-893`). CI/QA/dalekdefender connect as superuser and must `SET LOCAL ROLE`
  to a seeded `NOBYPASSRLS` role to make RLS real (see `cross-tenant-rls.journey.test.js:29-38`).
  **Any care-team RLS inherits this exact constraint** — it is silently inert under a bypassing role.

- `tenant_id` defaults are GUC-reading (migration `310_tenant_id_guc_default.sql`) so inserts
  under `setTenant(X)` auto-stamp the request tenant. A care-team RLS predicate must not
  interfere with this insert path.

- Regression coverage to keep green: `src/tests/tenant-rls.deep.test.js`,
  `tenant-rls-http.deep.test.js`, `tenant-rls-interactive-tx.deep.test.js`,
  `tenant-rls-phase-2.deep.test.js`, `tenant-rls-phi-routes.deep.test.js`, and the
  `cross-tenant-rls.journey.test.js` journey.

### 1.2 RBAC + roles (the layer above tenant)

- Role helpers: `src/utils/roleHelpers.js` — `CLINICAL_ROLES`, `DOCTOR_TIERS`,
  `isClinical()`, `isDoctor()`, `isAdmin()`, `isMedicalRecords()`, `canViewMedicalData()`
  (`roleHelpers.js:90-111, 200-236`). ADMIN + MEDICAL_RECORDS are the natural bypass roles.
- `jwtMiddleware` normalizes `req.user` to `{ uid, id, role, roles?, ... }`; `uid` is the UUID,
  `id` the int DB id (per `apps/backend/CLAUDE.md`). `req.tenantId` carries the authenticated tenant.
- Route gating: `requireRole(...)` + `wrapAutoRBAC` (`src/config/routeWrapper.js`,
  `src/config/rbacConfig.js`). RBAC answers "may this **role** touch this route?"; it does
  **not** answer "may this clinician touch **this patient**?" — that is the ABAC layer below.
- The role→PHI policy graph (`src/config/rolePolicyGraph.js`) assigns each role a
  `phi.access_level` (`phiAccessLevelForRole`, `rolePolicyGraph.js:1414-1439`), a
  `requires_patient_relationship` flag (`:1441-1446`), and `can_break_glass`
  (`:1389` — `SUPER_ADMIN`, `ADMIN`, `CMO`, `MEDICAL_SUPERINTENDENT` only). PHI levels:
  `none / operational_only / staff_only / basic_patient_context /
  patient_relationship_required / clinical_leadership_relationship_required /
  admin_break_glass / own_record` (`PHI_ACCESS_LEVELS`, `rolePolicyGraph.js:24-33`).

### 1.3 CareTeam data model — **ALREADY EXISTS** (migration 260)

`src/migrations/260_care_team_patient_access_lab_specimen_qc.sql` created the full model. Do not recreate:

| Table | Purpose | Key columns (file:line) |
|---|---|---|
| `care_teams` | one team per patient × encounter context | `tenant_id`, `patient_uid`, `admission_id?`, `appointment_id?`, `team_kind` (op/ip/er/icu/day_care/dialysis/perioperative/longitudinal/other), `status` (active/paused/closed/archived) (`260:107-146`) |
| `care_team_members` | staff ↔ care_team membership | `care_team_id`, `patient_uid`, `staff_uid?`, `staff_id?`, `staff_role`, `relationship_kind`, `access_scope JSONB`, **`break_glass_allowed`**, **`active_from` / `active_until`** (temporal), `status` (active/inactive/suspended/ended) (`260:148-195`) |
| `care_team_member_status_history` | membership transition audit | (`260:197-215`) |
| `care_team_status_history` | team transition audit | (`260:217-234`) |
| `patient_access_break_glass` | per-patient emergency override | `patient_uid`, `actor_uid`, `actor_role`, `reason` (≥8 chars CHECK), `status` (active/ended/expired/revoked), `started_at`, `expires_at`, `ended_at`/`ended_by` (`260:236-264`) |
| `patient_access_break_glass_status_history` | break-glass transition audit | (`260:266-285`) |
| `patient_access_audit_log` | every access decision | `patient_uid`, `actor_uid`, `actor_role`, `access_decision` (allow/deny/break_glass), `access_source` (role/care_team/clinical_authorship/appointment/admission/guardian/break_glass/system/unknown), `care_team_id?`, `break_glass_id?`, `request_id`, `route`, `action` (`260:287-328`) |

Useful indexes already present: `idx_care_team_members_patient_staff` (`260:182-184`),
`idx_care_team_members_staff_id` (`260:185-187`), `idx_break_glass_active_patient` (`260:260-262`).

**Gap vs §1.1:** none of these tables are in any `tenant_isolation` ARRAY (075/236/238/239/304),
so today they have **no RLS at all** — they rely entirely on app-layer `tenant_id = $1` filters.

### 1.4 App-layer ABAC engine — **ALREADY EXISTS** (`accessDecisionService.js`)

`src/services/security/accessDecisionService.js` is a complete relationship-based PHI authorizer:

- `authorizePatientAccessRequest(req, {policyCode, recordType, patient?, resourceContext?, shadowMode?})`
  (`:933-1100`) resolves the patient (`resolvePatientForAccess`, `:494-557`;
  `resolvePatientForResourceAccess` maps ~18 resource types → patient, `:255-492`), then
  evaluates an **ordered relationship chain**:
  1. self / guardian (`:983-994`)
  2. medical-records office role (`:998-1004`)
  3. role-owned operational access (`canUseRoleOwnedOperationalAccess`, `:188-202, 1007-1012`)
  4. active break-glass (`findActiveBreakGlass` → `patient_access_break_glass`, `:606-627, 1013-1018`)
  5. **care-team** (`findCareTeamRelationship`, `:629-658, 1032-1037`)
  6. referral (`findReferralRelationship`, `:660-716`)
  7. clinical authorship (`findClinicalAuthorshipRelationship`, `:718-764`)
  8. appointment (`findAppointmentRelationship`, `:766-820`)
  9. admission (`findAdmissionRelationship`, `:822-860`)
  - else deny (`:1072-1074`).
- Every decision is written to `patient_access_audit_log` (`writePatientAccessAudit`, `:883-931`).
- **Shadow mode** already exists: `shadowMode:true` returns `{...decision, allowed:true, shadow_denied:true}`
  for a denied decision (`:1097-1099`) and stamps `enforced:false` (`:1081`) — i.e. log-what-would-be-denied
  without blocking. This is the rollout safety valve (see §5).
- The care-team query (`:635-657`) already enforces temporal validity
  (`active_from <= NOW() AND (active_until IS NULL OR active_until >= NOW())`), team `status='active'`,
  member `status='active'`, and matches by `staff_uid` **or** `staff_id`.

Policy registry: `src/services/security/accessPolicyRegistry.js` defines policy codes
(`ACCESS_POLICY_CODES`, `:4-20`), each with `required_phi_level`, `capability_groups`,
`relationship_checks[]` (which of the chain above apply), and `break_glass_allowed`
(`policy()` factory, `:38-60`). `care_team` is in the default relationship set (`:22-31`).

### 1.5 Enforcement points — **the actual gap**

The enforcing middleware lives in `src/middleware/phiAccessMiddleware.js`:
- `patientAccessGuard(recordType, {policyCode, requirePatientContext})` (`:74-116`) — calls
  `authorizePatientAccessRequest`, returns **403** on deny.
- `patientAccessGuardForResource(recordType, {policyCode, resourceType, idParam})` (`:118-175`) —
  resolves the patient from a row id first, then authorizes (used for `/:id` mutations).
- `phiAccessLogger(recordType)` (`:195-259`) — **passive**: logs PHI access on `res.finish`,
  records denied attempts, but **does not authorize anything**.

Where they are mounted (`src/app.js`):

| Mounted with **enforcing** `patientAccessGuard` | Mounted with **only** passive `phiAccessLogger` |
|---|---|
| `/records` (`app.js:624`), `/clinical` parent (`:772,778`), 2 clinical sub-routes (`:800,808`) | `/investigations` (`:625`), `/prescriptions` (`:639`), `/pharmacy*` (`:633,638`), `/beds`+`/wards` (`:719-721`), `/emr` notes/orders/vitals/dx (`:887-910`), `/lab`+`/lab/release` (`:1063-1066`), `/radiology` (`:1008`), `/pacs` (`:845`), `/blood-bank` (`:1043`), `/theatre`+`/anesthesia` (`:1014-1016`), `/icu` (`:1037`), `/dialysis` (`:1040`), `/maternity` (`:1099`), `/discharge-summaries` (`:1108`), `/referrals` (`:1114`), `/death-certification` (`:1039`), `/med-rec` (`:841`), `/encounters` (`:780`), `/problems` (`:826`), `/allergies` (`:830`), `/bcma` (`:838`), `/nursing-assessments` (`:779`), `/microbiology` (`:1035`), `/maternity`, `/paediatric` (`:1102`), … (~50 families) |

**Conclusion.** The data model + engine for care-team ABAC exist and are correct. Because the
*enforcing* guard is mounted on only ~4 of ~50 PHI route families, a clinician with the right
**role** (which RBAC grants tenant-wide) can read most PHI for **any** patient in their tenant —
exactly the "tenant-scoped, not care-team-scoped" gap. This design closes that gap primarily by
**extending enforcement coverage** of the existing engine, with an optional DB-layer (RLS)
backstop for defense-in-depth.

---

## 2. Design goals & non-goals

**Goals**
1. Scope clinician PHI/chart reads+writes to patients on whose care team the clinician sits
   (or who they otherwise have an explicit, audited relationship with).
2. Compose strictly *below* RBAC and *below/with* tenant RLS — never widen tenant isolation.
3. Audited break-glass for emergencies, reusing the established pattern.
4. Additive, non-breaking, default-open for the single-ward pilot; tightenable per-tenant via flag.
5. Avoid PHI over-blocking (a clinician locked out of their own patient is a clinical-safety event).

**Non-goals**
- Re-implementing the data model or the relationship engine (they exist; §1.3–1.4).
- Replacing tenant RLS or RBAC.
- Consent management (separate `consentMiddleware.js` concern).
- Auto-populating care teams from every workflow on day one (phased; §7).

---

## 3. Data model

**No new tables are required for Phase 1–3.** Reuse migration 260 (`care_teams`,
`care_team_members`, break-glass, audit). The model already covers the brief's requirements:

- *which staff ↔ which patients/encounters/wards* → `care_team_members.staff_uid/staff_id`
  → `care_teams.patient_uid` (+ optional `admission_id`/`appointment_id` for encounter scoping).
- *relationship to patients/admissions/encounters* → `care_teams.{patient_uid, admission_id, appointment_id, team_kind}`.
- *tenant_id* → present and FK'd on every table (`260:109,150,238,289,…`).
- *temporal validity* → `care_team_members.active_from / active_until` (+ `status`),
  `care_teams.status`.

### 3.1 Small additive refinements (proposed, not yet present)

These are *optional* hardening DDL for later phases; none are needed to start enforcing.

1. **Ward/department-scoped membership (Phase 3+).** Today membership is per-patient
   (`care_teams.patient_uid`). For ward-level coverage ("any IP nurse on Ward 3 sees Ward-3
   inpatients") add a lightweight `care_team_ward_grants` table OR encode ward in
   `care_team_members.access_scope` JSONB (already exists, `260:164`). Recommended:
   a new table to keep the predicate index-friendly:

   ```sql
   -- LATER PHASE ONLY (sketch)
   CREATE TABLE care_team_ward_grants (
     id           SERIAL PRIMARY KEY,
     tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
     ward_id      INTEGER NOT NULL,            -- FK to wards/beds ward
     staff_uid    UUID,
     staff_id     INTEGER,
     relationship_kind VARCHAR(50) NOT NULL DEFAULT 'ward_cover',
     active_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     active_until TIMESTAMPTZ,
     status       VARCHAR(20) NOT NULL DEFAULT 'active',
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT chk_ward_grant_identity CHECK (staff_uid IS NOT NULL OR staff_id IS NOT NULL)
   );
   CREATE INDEX idx_ward_grants_staff ON care_team_ward_grants (tenant_id, staff_uid, status)
     WHERE staff_uid IS NOT NULL;
   ```

2. **Materialized membership lookup for the RLS predicate (Phase 4, only if RLS chosen).**
   A boolean SQL helper `app_actor_on_care_team(patient_uid uuid)` reading a per-request GUC
   (`app.current_actor_uid`) so the policy stays a single index probe (see §4.2). No new table —
   just a `STABLE` function + the existing `idx_care_team_members_patient_staff` index.

3. **Care-team auto-population hooks (Phase 2–3).** No schema change — service-layer writes
   into `care_team_members` at the points where a relationship is *established* (admission →
   attending/admitting doctor + ward nurses; appointment booking → consulting doctor;
   order/note authorship → author). Until those hooks exist, the engine already falls back to
   the authorship/appointment/admission relationship checks (§1.4 chain steps 6–9), so
   enforcement does not require the care-team table to be pre-populated.

---

## 4. Enforcement strategy

**Recommendation: app-layer middleware is the primary enforcement plane; RLS care-team
predicate is an opt-in Phase-4 defense-in-depth backstop, NOT the primary control.**

### 4.1 Why app-layer first (rationale)

| Factor | App-layer (`accessDecisionService`) | DB RLS care-team predicate |
|---|---|---|
| Already built? | **Yes** — full chain + audit + shadow mode (§1.4) | No — would be net-new |
| Expressiveness | Rich: 9 relationship sources, role-owned ops, referral/authorship fallbacks, policy-per-route | Poor: a policy is one boolean expr per row; encoding "authorship OR appointment OR admission OR care_team OR referral" in SQL is large + slow |
| Safe denial UX | Returns `break_glass_available`, `policy_code`, safe message (`patientAccessErrorPayload`, `:1102-1112`) | RLS just makes rows vanish → 404/empty → clinician can't tell access was denied vs data absent → over-blocking confusion + can't offer break-glass |
| Audit | Writes `patient_access_audit_log` allow/deny/break_glass with source (§1.4) | RLS can't audit a *deny* (it silently filters) |
| Break-glass | Naturally integrated (chain step 4) | Would need GUC plumbing + the engine still has to grant it |
| Fail mode | Fail-closed 403 on error (`phiAccessMiddleware.js:108-114`) | Fail-closed by hiding rows — but indistinguishable from outage |
| Inert-role risk | None (runs in Node) | **Silently inert** under SUPERUSER/owner role (§1.1) — same trap as tenant RLS |
| Performance | One-or-two indexed lookups per request, short-circuits early | A care-team subquery added to *every* row check on *every* PHI table read |

The engine's deny path is strictly more useful (auditable, explains itself, offers break-glass)
than RLS row-hiding for *clinician* access. RLS shines for **tenant** isolation (a hard,
total wall) but is a blunt instrument for the softer, relationship-rich care-team boundary.

### 4.2 How an RLS care-team predicate WOULD compose (Phase 4, defense-in-depth)

If/when a DB backstop is wanted (e.g. to protect against a missed route mount or a raw query
that bypasses the guard), add the care-team test as an **additional AND-ed clause** to the
existing `tenant_isolation` policy on PHI tables, gated by a new GUC so it is opt-in and
default-open:

```sql
-- Phase 4 SKETCH — defense in depth only. Composes WITH tenant isolation, never replaces it.

-- (a) per-request actor GUC, set alongside app.current_tenant_id inside setTenant/setTenantTx
--     SELECT set_config('app.current_actor_uid', $actorUid, true);
--     SELECT set_config('app.enforce_care_team', 'on'|'off', true);   -- default off (open)

-- (b) STABLE helper: is the current actor on an active care team for this patient?
CREATE OR REPLACE FUNCTION app_actor_on_care_team(p_patient_uid uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM care_team_members ctm
      JOIN care_teams ct ON ct.id = ctm.care_team_id
     WHERE ct.tenant_id = app_current_tenant_id_uuid()
       AND ct.patient_uid = p_patient_uid
       AND ct.status = 'active'
       AND ctm.status = 'active'
       AND ctm.active_from <= NOW()
       AND (ctm.active_until IS NULL OR ctm.active_until >= NOW())
       AND ctm.staff_uid = NULLIF(current_setting('app.current_actor_uid', true), '')::uuid
  )
  OR EXISTS (  -- break-glass escape (mirrors app-layer step 4)
    SELECT 1 FROM patient_access_break_glass bg
     WHERE bg.tenant_id = app_current_tenant_id_uuid()
       AND bg.patient_uid = p_patient_uid
       AND bg.actor_uid = NULLIF(current_setting('app.current_actor_uid', true), '')::uuid
       AND bg.status = 'active'
       AND (bg.expires_at IS NULL OR bg.expires_at > NOW())
  );
$$;

-- (c) the composed policy — note the care-team clause is GATED so it is a no-op until
--     a tenant flips app.enforce_care_team='on' (per-tenant rollout, §5).
CREATE POLICY tenant_isolation ON <phi_table>
  USING (
    ( current_setting('app.current_tenant_id', true) IS NULL
      OR current_setting('app.current_tenant_id', true) = ''
      OR current_setting('app.current_tenant_id', true) = 'bypass'
      OR tenant_id = app_current_tenant_id_uuid() )           -- UNCHANGED tenant gate
    AND
    ( current_setting('app.enforce_care_team', true) IS DISTINCT FROM 'on'  -- default OPEN
      OR current_setting('app.current_tenant_id', true) = 'bypass'          -- SUPER_ADMIN
      OR <table>.patient_uid IS NULL                                        -- non-patient rows
      OR app_actor_on_care_team(<table>.patient_uid) )                      -- care-team gate
  )
  WITH CHECK ( ...tenant clause only — writes keep current WITH CHECK so inserts/310 unaffected... );
```

Composition guarantees:
- The tenant clause is **byte-identical** to today's, AND-ed with the new gate → tenant
  isolation can only ever get *stricter*, never wider. `'bypass'` short-circuits both clauses.
- Care-team clause defaults to a **no-op** (`app.enforce_care_team` unset/≠`'on'`), so applying
  the migration changes nothing until a tenant opts in. Pilot stays open.
- `WITH CHECK` (write path) is left tenant-only so migration 310's GUC-reading insert defaults
  and all existing write tests keep passing; care-team is enforced on the **read** path
  (`USING`) where over-blocking is recoverable via break-glass, and on writes via the app layer.
- Per-table `patient_uid` column name varies (some tables use `patient_id:int`). The Phase-4
  migration must map each table to its patient linkage (the same map migration 236 used,
  `236:28-36`) — tables keyed by int `patient_id` need a join-or-subquery variant of the helper.
  This heterogeneity is a strong reason to keep RLS care-team as **defense-in-depth only**, after
  the app layer is the proven primary control.

**Caveat to surface for review:** adding `app_actor_on_care_team(...)` to the `USING` clause of
every PHI table means an `EXISTS` subquery per row-visibility check. With the existing
`idx_care_team_members_patient_staff (tenant_id, patient_uid, staff_uid, status)` index this is an
index probe, but on large result sets (e.g. ward boards listing many patients) it runs per row.
Phase-4 must benchmark; if hot, fall back to app-layer-only for list endpoints and reserve RLS
for single-patient reads.

### 4.3 The recommended primary mechanism (Phases 1–3)

Drive everything through the **existing** `patientAccessGuard` / `patientAccessGuardForResource`,
expanding their route coverage and turning shadow→enforce per tenant. No new enforcement
primitive is introduced — we finish wiring the one that exists.

---

## 5. Break-glass

**Reuse the established pattern.** Two break-glass concepts already exist:
- `clinical_ai_break_glass_sessions` — AI-governance scope, has tenant RLS (in 075 array),
  service in `clinicalAiWorkflowService.js:1799-1852` (`startBreakGlass`/`endBreakGlass`/
  `getActiveBreakGlass`, time-boxed via `expires_at`, event-published `clinical_ai.break_glass_ended`).
- `patient_access_break_glass` — **the PHI-access one we use** (migration `260:236-264`), already
  queried by the engine (`findActiveBreakGlass`, `accessDecisionService.js:606-627`).

Design:
1. **Eligibility.** Break-glass is offered when `rolePolicy.phi.can_break_glass` AND
   `policy.break_glass_allowed` (`baseDecision.break_glass_available`,
   `accessDecisionService.js:571`). Today `can_break_glass` is limited to
   `SUPER_ADMIN/ADMIN/CMO/MEDICAL_SUPERINTENDENT` (`rolePolicyGraph.js:1389`). **Open question
   (§8):** clinicians "frequently need emergency cross-team access" — so this set likely must be
   widened to front-line clinical roles (DOCTOR tiers, charge nurses) with shorter expiry +
   mandatory reason + heavier audit/alerting. This is a policy decision for clinical governance.
2. **Activation endpoint.** Add `POST /api/v1/patient-access/break-glass` (new route under an
   existing clinical-staff RBAC gate) → service writes `patient_access_break_glass`
   (status `active`, `reason` ≥8 chars per CHECK `260:254-255`, `expires_at = NOW()+interval`,
   default 2h capped 24h mirroring the AI pattern `clinicalAiWorkflowService.js:1801`), plus a
   `patient_access_break_glass_status_history` row, and emits a security event
   (Slack/PagerDuty via `securityWebhook.js`) — break-glass must be *loud*.
3. **Effect.** Once active, the engine's chain step 4 (`:1013-1018`) grants access with
   `access_source='break_glass'`, and `writePatientAccessAudit` stamps every subsequent PHI hit
   as `break_glass` with the `break_glass_id` (`:909, 916`). No code change needed beyond the
   activation endpoint + widening eligibility.
4. **Expiry / revocation.** `expires_at` enforced in the lookup (`:619`). Add a sweeper
   (`withJobLock` cron) to flip `active`→`expired` for audit cleanliness, and a
   `DELETE/PATCH …/break-glass/:id` to revoke (status `revoked`), mirroring `endBreakGlass`.
5. **RLS parity (Phase 4).** The `app_actor_on_care_team` helper (§4.2) already OR's in active
   break-glass so the DB backstop never blocks a clinician who has legitimately broken glass.

---

## 6. Enforcement points & bypass roles

### 6.1 Who is scoped
Care-team scope applies to roles whose `phi.access_level` is `patient_relationship_required` or
`clinical_leadership_relationship_required` (`requiresPatientRelationship`,
`rolePolicyGraph.js:1441-1446`) — i.e. clinicians and clinical leadership. Operational roles
(`operational_only`/`basic_patient_context`) are already constrained by the role-owned
operational-access rules (`canUseRoleOwnedOperationalAccess`, `accessDecisionService.js:188-202`)
and unchanged here.

### 6.2 Who bypasses (must NOT be care-team-scoped)
- **ADMIN / SUPER_ADMIN** — `admin_break_glass` PHI level; cross-tenant `'bypass'` GUC; needed for
  platform operations. (Still audited.)
- **MEDICAL_RECORDS** — the record-room role is explicitly allowed for record/timeline policies
  (`accessDecisionService.js:998-1004`); it is the legitimate hospital-wide chart-access function.
- **Break-glass holders** — per §5.
- **Self / guardian** — patients/guardians for their own records (chain steps 1).
- **`'bypass'` GUC paths** — SUPER_ADMIN cross-tenant reads and migrations.

### 6.3 Which endpoints enforce (target coverage)
All PHI route families currently mounted with only `phiAccessLogger` (§1.5 right column) gain the
enforcing guard, prioritized by sensitivity (chart/notes/orders/vitals/labs/meds first;
bed/ward boards later because they are list-heavy and benefit from a list-aware policy). The
guard is **idempotent** with the passive logger — keep `phiAccessLogger` for the HIPAA trail and
add `patientAccessGuard`/`patientAccessGuardForResource` ahead of it, exactly as `/records`
already does (`app.js:624`).

For `/:id` mutation routes use `patientAccessGuardForResource` with the right `resourceType`
(the resolver map already supports appointment/admission/encounter/bed/clinical_order/
clinical_note/diagnosis/problem/med_rec/canonical_encounter/radiology_order/cds_alert/mar/
handover/vitals/io — `accessDecisionService.js:262-491`). Any new resource type needs a case there.

### 6.4 Interaction with the AI module
The clinical-AI review surface filters by `module.settings.reviewRoles[]`
(`clinicalAiWorkflowService.js:624, 1518, 1526, 1643`) — that is a **role** filter on AI review
queues, orthogonal to care-team. **Design rule:** AI generation/review over a *specific patient*
must additionally pass the same `authorizePatientAccessRequest` check (the AI routes already carry
`phiAccessLogger('CLINICAL_AI')`, `app.js:952` — they should gain the enforcing guard too). The AI
break-glass (`clinical_ai_break_glass_sessions`) governs AI-governance actions and stays separate
from PHI-access break-glass (`patient_access_break_glass`); do not conflate them. Net: a reviewer
must be both in `reviewRoles` (role gate) **and** on the patient's care team / have a relationship
(ABAC gate) to act on that patient's AI output.

---

## 7. Phased implementation plan

Each phase is independently shippable and reversible. Phases 1–3 are app-layer only (no DDL,
no RLS change). Phase 4 is the optional DB backstop.

### Phase 0 — Instrumentation & per-tenant flag (foundation, safe for pilot)
- Add a per-tenant `care_team_enforcement_mode` setting: `off` | `shadow` | `enforce`
  (store in existing tenant config/settings; default **`off`** for the single-ward pilot).
- Thread it into `patientAccessGuard`/`authorizePatientAccessRequest` so `shadow` uses the
  existing `shadowMode` path (`accessDecisionService.js:1097-1099`) — logs would-be denials to
  `patient_access_audit_log` (`access_decision='deny'`, `shadow_mode=true`) without blocking.
- **Outcome:** zero behavior change; we can measure exactly who *would* be denied per tenant
  before enforcing. This is the primary guard against locking clinicians out (§Risks).

### Phase 1 — Minimal foundation (pilot-safe)
- Expand `patientAccessGuard` coverage to the **highest-sensitivity** PHI families currently
  audit-only: `/emr` (notes/orders/vitals/dx), `/lab`, `/prescriptions`, `/med-rec`, `/pacs`,
  `/radiology` — mounted in **`shadow`** mode by default (no denials in the pilot tenant).
- Care-team auto-population hook #1: on **admission create**, insert `care_team_members` for the
  admitting + attending doctor and assigned ward nurses (idempotent, status `active`). This makes
  the care-team source non-empty so shadow logs are meaningful. (The engine already falls back to
  authorship/appointment/admission so this is additive, not load-bearing yet.)
- Tests: extend `patientAccessGuard.test.js` + add a deep test asserting shadow-allows-but-audits.
- **Outcome:** real care-team data + full shadow visibility, still default-open. Pilot unaffected.

### Phase 2 — Enforce on a flagged tenant (first real tightening)
- Care-team auto-population hooks #2–3: appointment booking → consulting doctor; clinical
  note/order authorship → author (most of these relationships are *already* recognized by the
  fallback chain, so this mainly improves audit attribution to `care_team`).
- Add the break-glass activation endpoint + widen `can_break_glass` to front-line clinical roles
  with short expiry + alerting (§5, pending §8 governance sign-off).
- Flip a **non-pilot / second** tenant to `enforce`. Pilot tenant stays `off`/`shadow`.
- Tests: deny-without-relationship + break-glass-grants-access deep tests per route family.
- **Outcome:** care-team enforcement proven in production on a real tenant, with break-glass.

### Phase 3 — Broad coverage + ward grants
- Expand enforcing coverage to the remaining PHI families (`/beds`, `/wards`, `/theatre`,
  `/icu`, `/dialysis`, `/blood-bank`, `/maternity`, `/discharge-summaries`, `/referrals`, AI
  patient routes, …) — list endpoints get a list-aware policy (filter rows to authorized
  patients rather than 403 the whole call).
- Add `care_team_ward_grants` (§3.1) + a `ward` relationship check in the engine for
  ward-cover nurses.
- Default new tenants to `shadow`, graduate to `enforce` per the rollout playbook.
- **Outcome:** care-team scope is the platform default for clinician PHI access.

### Phase 4 — Optional RLS defense-in-depth
- Add `app.current_actor_uid` + `app.enforce_care_team` GUCs to `setTenant`/`setTenantTx`
  (set from `req.user.uid` + the tenant's enforcement mode).
- Ship `app_actor_on_care_team()` + the composed policy (§4.2) on single-patient PHI reads,
  gated default-OFF. Benchmark before enabling per tenant.
- Extend the `tenant-rls-phi-routes.deep.test.js` family with a care-team RLS case + a
  non-vacuous control (mirroring `cross-tenant-rls.journey.test.js`).
- **Outcome:** a DB-layer backstop catches any route that slips through the app guard, without
  changing the app-layer-primary contract.

---

## 8. Risks & open questions

**Risks**
- **PHI over-blocking (clinical-safety event).** A clinician unable to open their patient's chart
  in an emergency is worse than over-broad access. *Mitigations:* default-open pilot; mandatory
  shadow phase per tenant before enforce (Phase 0); break-glass on every deny with a clear,
  actionable 403 (`patientAccessErrorPayload`); the fallback relationship chain
  (authorship/appointment/admission/referral) so access does not depend solely on care-team
  rows being pre-populated.
- **Leakage if care teams are under-populated but enforcement is off.** Until Phase 2, the
  control is effectively the fallback chain + tenant RLS — i.e. still tenant-scoped for roles
  that have a tenant-wide PHI level. This is acceptable for the single-ward pilot (the audit's
  own stated tolerance) but must be tracked so it is not forgotten when departments scale.
- **Performance.** App-layer: 1–2 indexed lookups/request, early short-circuit — cheap. RLS
  (Phase 4): per-row `EXISTS` on list endpoints — must benchmark; reserve for single-patient
  reads if hot (§4.2 caveat).
- **Inert RLS under bypassing role.** Phase 4's policy is silently inert if the runtime DB role
  is SUPERUSER/owner — the same trap tenant RLS has (`evaluateTenantRlsPosture`). The boot guard
  (`logTenantRlsRolePosture`) already alarms on this; reuse it.
- **Audit-table growth.** `patient_access_audit_log` gets a row per PHI decision once coverage is
  broad; plan retention/partitioning (it is tenant-scoped + time-indexed already, `260:322-328`).
- **Shadow-mode false confidence.** Shadow logs only fire on routes that actually mount the guard;
  a family left as `phiAccessLogger`-only produces no shadow signal. Track coverage explicitly.

**Open questions (for human review)**
1. **Break-glass eligibility.** Which clinical roles may self-break-glass vs require a
   supervisor? Current set is leadership-only (`rolePolicyGraph.js:1389`). Front-line emergency
   access likely needs widening — clinical-governance decision.
2. **Ward-level vs patient-level default.** Should an on-shift ward nurse see *all* current
   inpatients on their ward by default (ward grant), or only patients explicitly added to a care
   team? Affects Phase 3 design and how aggressively Phase 1 auto-population must run.
3. **List endpoints.** 403-the-call vs filter-rows for list/board endpoints (bed board, worklists).
   Filtering is friendlier but requires per-endpoint query changes, not just a guard.
4. **RLS backstop scope.** Is the Phase-4 DB backstop wanted at all, or is app-layer + the
   tenant-RLS wall sufficient given the cost/heterogeneity (§4.2)? Recommend deferring until
   app-layer enforcement is proven (post Phase 3).
5. **Care-team lifecycle.** Who closes a `care_team`/membership and when (discharge auto-ends IP
   teams? appointment completion ends OP teams?) — needs a lifecycle owner to prevent stale
   active memberships granting access after the relationship ends.
6. **Cross-cover / handover.** Night-shift covering doctors: modeled as `covering_doctor`
   membership (`relationship_kind` already supports it, `260:159`) with short `active_until`, or
   via break-glass? Prefer explicit time-boxed membership over routine break-glass.

---

## 9. Summary of what to build vs reuse

| Concern | Status | Action |
|---|---|---|
| CareTeam tables, membership, temporal validity | **Exists** (migration 260) | Reuse; add `care_team_ward_grants` in Phase 3 only |
| Relationship engine (care-team/referral/authorship/appt/admission) | **Exists** (`accessDecisionService.js`) | Reuse; add `ward` check in Phase 3 |
| Enforcing guard + passive logger | **Exists** (`phiAccessMiddleware.js`) | Reuse; **expand route coverage** (the core work) |
| Shadow mode | **Exists** (`shadowMode` path) | Wire to per-tenant flag (Phase 0) |
| PHI-access break-glass table + lookup | **Exists** (260 + engine step 4) | Add activation/revoke endpoints + widen eligibility |
| Per-tenant enforcement flag (off/shadow/enforce) | **Missing** | Build (Phase 0) |
| Care-team auto-population hooks | **Missing** | Build incrementally (Phases 1–3) |
| RLS care-team predicate (defense-in-depth) | **Missing** | Optional (Phase 4), gated default-off |
| Tenant RLS (compose-with, don't break) | **Exists** (075/236/238/239/304/310) | Leave untouched; AND-compose only in Phase 4 |
