# Reprocessable Devices Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One department-agnostic reprocessable-device register, policy shape, state machine, serology gate and CSSD queue serving dialysis and OT — dialysers minted at first capture and dedicated to one patient with a derived cycle count and a TCV discard rule; instrument sets enrolled at issue with load-driven cycle evidence and exposure holds; the dialysis reuse path and the isolation-machine rule consuming the Phase 1 isolation resolver live (the derivation of `dialysis_patients.*_status` itself is the Phase 1 lane's — spec §3.3); isolation machines modelled warn-only with a recorded override; the Phase 2 census that gates the eventual column DROP. Cath's register is untouched.

**Architecture:** Five new tables (`reprocessing_domain_settings`, `reprocessing_domain_policies`, `reprocessable_devices`, `reprocessable_device_usages`, `reprocessable_device_dialysis_links`) plus `dialysis_machines`, columns on `dialysis_sessions` / `dialyzer_reuse_register` / `surgical_implants`, and six `(tenant_id, id)` backing uniques — one forward migration, **`NNN`** (the next free number at push time; **767 is the Phase 1 lane's**). `dialysis_patients` and `patient_bloodborne_markers` are not touched by this lane. A pure rules module (`reprocessableDeviceRules.js`) carries 765's state machine, a generalised disposition function with a `quarantine` rule, the isolation-warning rule over a Phase 1 `Decision` and the TCV verdict; `reprocessableDeviceService.js` owns the register, transitions (including the `uncapture` release for cases cancelled before use), history and the platform exposure handler; `dialysisIsolationAdapter.js` is the one binding to the Phase 1 resolver (`resolveDialysisIsolation`, spec §3.3) and fails closed without it; `dialysisReuseService.js` owns capture, the un-capture on cancel, the one-command reprocessing record and machines, reading every dialysis decision live through the adapter; `dialysisIsolationCensus.js` and its script are the Phase 2 gate; `cssdReuseHooks.js` runs inside `cssdService`'s four existing transactions (issue, return, cancel, load). Routes: dialysis additions, a `/reprocessable-devices` sub-tree on CSSD, one theatre read, and a new `/api/v1/reprocessing` governance mount. Staff gets a dialysis feature from zero and a theatre sets panel; Admin gets a domain filter on the CSSD Devices tab, a reprocessing-policies page, and dialysis machine/dialyser panels.

**Tech Stack:** Node 26 ESM backend (Express, raw SQL via `setTenantTx`, Postgres 17 RLS), jest ESM, OpenAPI overlays; Flutter Staff app (`AppStrings` five-locale map, `ApiClient`, `IdempotencyAttemptRegistry`); Next.js Admin (`@tanstack/react-query`, `core.ts` typed helpers, `useIdempotencyKey`).

**Spec:** `docs/superpowers/specs/2026-09-05-reprocessable-devices-platform-design.md`. **Depends on Plans 1–3 merged** (`bloodborneMarkerService.js`, `cathDeviceReuseService.js`, `cathLabReadinessProjection.js`, the canary) — all on `github/main` at `b27a730d3`. **The dialysis arm (Task 4) DEPENDS ON Phase 1** — the dialysis isolation derivation lane (**dev-1b**, the merge-authority session, formerly signing as dev-ea; migration 767; `resolveDialysisIsolation`) being on `main`; Task 4 Step 0b gates it, and Task 9 merges nothing before it. Tasks 1–3 and 5–8 are unblocked. **Owner decisions of 2026-09-06 that this plan is written to:** **D11 = NO** — `dialysis_machines.isolation_group` is the routing key, the class → group mapping lives in `reprocessing_domain_settings.isolation_groups`, `required_group` is the live warning key and `required_class` is retired (spec §2, §3.4); and **Q1 = a legacy non-reactive `'negative'` declaration MEANS `clear`**, which unblocks Phase 1's migration 767 (spec §7.3, §9). Throughout this plan **dev-1b** is the merge-authority session that owns Phase 1 and 767.

**Base:** `github/main`, branch `feat/reprocessable-devices-platform`.

---

## Conventions

- All of Plan 1's conventions apply verbatim: tenant transactions (`setTenantTx`), raw SQL, `AppError`, npm-run jest, immutable migrations, schema drift mirror, scratch DB, commit trailer, `[full-ci]` last commit, draft PR, no merge.
- **Never edit `168_*`, `418_*`, `421_*`–`423_*`, `565_*`, `764_*`–`766_*`, nor `767_*` (Phase 1's).** Every schema change is in `NNN_reprocessable_devices_platform.sql`.
- **`cath_reprocessable_devices` and the two 753 plpgsql functions are not touched.** The new tables are on neither assert's table list; `NNN` re-declares no plpgsql body.
- **Baseline-owned tables (`dialysis_sessions`, `ot_schedules`, `surgical_implants`, `clinical_ai_biomed_devices`) are altered only with `ALTER TABLE … ADD COLUMN / ADD CONSTRAINT` and `CREATE UNIQUE INDEX`.** An inline re-declaration trips the census gate. The manifest and `expectedAbsentCount` (411) do not change. `dialysis_patients` and `patient_bloodborne_markers` are **not altered** by this lane.
- **Nothing in this lane writes `dialysis_patients.hbsag_status / hcv_status / hiv_status`** — no sync, no latch, no union read, no enrol guard, no `recordSerology` change, no backfill. All of that is the Phase 1 lane's (spec §3.3); `dialysisSerologyWriters.test.js` pins it.
- **Every dialysis decision reads a live `Decision` through `dialysisIsolationAdapter.js`** — never the frozen `reuse_screen` / `post_use_screen`, never `resolveReuseStatus`, never the columns. `includeMarkers` is forwarded by no caller in this lane. `includeIsolationClass` is forwarded by exactly **one** server-side path — `assessIsolationTx` (and therefore `evaluateIsolationForSessionTx`, which wraps it) for machine routing, where the class is mapped to the tenant's routing group and never leaves the frame. It is forwarded by **no read surface** and, since D11 = NO, **not by `recordDialyserReprocessing` either**: the dialysis `exposure_markers` stamp is the flag alone, so the post-use path has no consumer for a class (spec §3.3, §2 D11(e)/(g)). Without the Phase 1 module the adapter fails closed (`RPD_ISOLATION_RESOLVER_UNAVAILABLE`, 503); no stub is ever reachable from product code.
- **Nothing anywhere carries an isolation class — D11 = NO (spec §2, §3.4).** The API's `isolation` payload is `{ codes, isolation_warnings: [{ code, machine_id, severity, required_group }], warn_only, enforcement_enabled, override }`. `required_group` is a tenant label for a bay and is published to every dialysis role; **`required_class` is retired** — `computeIsolationWarnings` returns `{ codes, required_group, blocked }`, the marker class survives only as an unnamed local inside that function (where it indexes `settings.isolation_groups`), and no audit row, no error detail and no response carries it. The frozen `reuse_screen` / `post_use_screen` carry no class either — they are published raw inside `usage`, and `snapshotOf` has no `keepClass` form. The canary pins the value, not the key, and a marker-class value under `isolation_class` / `required_class` is now an unambiguous defect rather than a pending question.
- **Every FK is a tenant-pinned composite; every composite `SET NULL` carries its column list; only the two patient-keyed FKs are `DEFERRABLE INITIALLY DEFERRED`.**
- **No relation fields in `schema.prisma` for the new FKs** — scalars, `@@unique`, `@@index` only (`check:prisma-relations` budget).
- **Every new role gate is an intersection with the mount audience and asserted as a subset in a test** (prefix-mount lockout class). `REPROCESSING_POLICY_ROUTE_ROLES` is an alias of `CATH_REPROCESSING_POLICY_ROUTE_ROLES`, applied at the mount in `app.js`.
- **Guard before claim** on every mutation: param guards, patient guards and the `:domain` guard run before `requireIdempotencyKey`.
- **Every raw-SQL parameter that appears more than once carries the same explicit cast at every site** (765's parse-time trap, 42P08 "inconsistent types deduced for parameter": Prisma sends params untyped and Postgres deduces `character varying` from `SET status = $3` and `text` from `$3 = 'in_case'`; the same for `SET discard_reason = $9` against `$9 IN (...)`, and for a `NUMERIC` insert value reused in `CASE WHEN $5 IS NULL`). Before committing any task with raw SQL, grep its statements for a `$n` that appears twice and confirm both sites are cast.
- **Staff strings:** every new key in all FIVE locale maps of `apps/staff/lib/l10n/app_strings.dart` (`'en': {` ≈3731, `'hi': {` ≈11563, `'ta': {` ≈19899, `'te': {` ≈28910, `'ml': {` ≈37845); every non-English rendering preceded by `// REVIEW: engineering placeholder pending OPEN-21 linguistic review`.
- **Commits use pathspecs**, never `git add -A`: subagents mutate a live worktree, and a pathspec commit cannot pick up a neighbour's stray file.
- **Migration number `NNN`** = the next free number against `github/main` and every open branch at push time (Task 0; re-checked at Task 9). **767 is the Phase 1 lane's**; this plan takes the number after it (768 if nothing else lands first). `check:migration-numbers` (`check-migration-number-collisions.mjs`) checks collisions, not contiguity, so Plan 4 may carry 768 on a branch before 767 has merged — but Task 9 merges nothing until Phase 1 is on `main`. Every `NNN` in this plan (file name, comments, commit messages) is resolved once at Task 0 Step 2.

---

## File structure

| File | Responsibility |
|---|---|
| Create `apps/backend/src/migrations/NNN_reprocessable_devices_platform.sql` | Six backing uniques, five new tables, `dialysis_machines`, `dialysis_sessions` / `dialyzer_reuse_register` / `surgical_implants` changes, RLS, GRANT block. (`dialysis_patients` and `patient_bloodborne_markers`: not touched — Phase 1.) |
| Modify `apps/backend/prisma/schema.prisma`, `src/lib/prisma.js`, `src/tests/unit/prismaCoverage.test.js`, `scripts/seed-comprehensive-test-data.mjs` | Mirror; runtime-grant lists; pins; seeder overrides. |
| Create `src/services/clinical/reprocessableDeviceRules.js` + `src/tests/unit/reprocessableDeviceRules.test.js` | Pure rules. |
| Create `src/services/clinical/reprocessableDeviceService.js` | Settings, policies, register, transitions, CSSD actions, capture/return tx helpers, history + PHI trail, label, exposure handler. |
| Create `src/services/clinical/reprocessableDeviceProjection.js` + test | Role projection for dialysis roster and serology rows, and the `Decision`'s `isolation_class` blanked for a non-audience role (no projection of the `isolation` envelope, which carries no class — spec §3.5). |
| Create `src/services/clinical/dialysisIsolationAdapter.js` + test | The one binding to the Phase 1 resolver (`resolveDialysisIsolation`): batch + single-uid, `includeMarkers` **and `includeIsolationClass`** default off, `snapshotOf` strips markers **and the class unconditionally** (no `keepClass` form under D11 = NO), the class asserted only when asked for, fails closed (503) without Phase 1; named stub for unit tests. |
| Create `src/services/clinical/dialysisReuseService.js`; modify `dialysisService.js` (`scheduleSession`, `startSession`, `cancelSession`, `recordReuseRegister`, `validateReuseRegisterInput`), `routes/clinical/dialysisRoutes.js` | Capture (freezes the `Decision` as the evidence snapshot), un-capture on cancel, reprocessing record (re-resolves live), isolation (assessed before the schedule insert, live), machines. **DEPENDS ON Phase 1.** `enrolPatient` / `recordSerology` untouched. |
| Create `src/services/clinical/dialysisIsolationCensus.js`, `scripts/dialysis-isolation-census.mjs` + deep test | The Phase 2 gate: per-tenant orphan `patient_uid` count and un-backfilled legacy-positive count (`bool_or` over the roster). No Phase 1 dependency. |
| Modify `src/services/clinical/dialysisMachineService.js` (pre-flight, separate commit, only if `main` has not) | Tenant predicate on the machine-ingest session match. |
| Create `src/services/cssd/cssdReuseHooks.js`; modify `cssdService.js`, `routes/cssd/cssdRoutes.js`, `routes/theatre/theatreRoutes.js` | OT hooks (issue, return, cancel, load), `/reprocessable-devices` sub-tree, `/issues` claim, theatre sets read. |
| Create `src/routes/clinical/reprocessingPolicyRoutes.js`; modify `config/routeRolePolicy.js`, `app.js` | Governance mount. |
| Create `src/tests/unit/reprocessableDeviceRouteWiring.test.js`, `dialysisSerologyWriters.test.js` (no lane module writes the roster columns), `dialysisReuseHookCallSites.test.js`, `cssdReuseHookCallSites.test.js`, `dialysisMachineIngestTenantScope.test.js`; modify `serologyDisclosureCanary.test.js` + fixture | Wiring census, call-site pins (six write paths), no-roster-write pin, ingest tenant pin, canary mounts. |
| Create `src/tests/reprocessable-devices-dialysis.deep.test.js` (DEPENDS ON Phase 1; skipped by name without it), `reprocessable-devices-ot.deep.test.js`, `dialysis-isolation-census.deep.test.js` | Deep suites. |
| Create `scripts/openapi/schemas/reprocessableDevices.mjs`; modify `scripts/generate-openapi.mjs`; regenerate `src/docs/openapi.json`, sync core | Contracts (`bloodborneMarkers.mjs` unchanged — the surveillance source is Phase 1's). |
| Modify `src/config/rolePolicyGraph.js`; regenerate `apps/staff/lib/core/config/staff_role_contract.g.dart` | `dialysis` Staff feature. |
| Staff: create `lib/features/dialysis/**`, `lib/core/widgets/reuse_restriction_strip.dart`, `lib/features/theatre/widgets/theatre_sets_panel.dart`; modify `role_config.dart`, `app_router.dart`, `staff_route_policy.dart`, `theatre_screen.dart`, `theatre_api_service.dart`, `app_strings.dart`; tests | Dialysis feature, theatre sets panel, strings. |
| Admin: create `src/lib/api/reprocessableDevices.ts`, `dashboard/cssd/components/ReprocessableDeviceActions.tsx`, `dashboard/quality/reprocessing/page.tsx` + `components/DomainPolicyPanel.tsx`, `dashboard/dialysis/components/MachinesTab.tsx`, `DialyserPanel.tsx`; modify `DevicesTab.tsx`, `SessionTab.tsx`, `RosterTab.tsx`, `TodayBoardTab.tsx`, `lib/api/cssd.ts`, `IssueActions.tsx`, `navConfig.ts`, `app/api/proxy/[...path]/route.ts`; tests | Domain filter, policies page, dialysis panels. |

---

## Task 0: Branch, worktree, migration number

- [ ] **Step 1: Cut the branch in a scratchpad worktree**

```bash
cd "/d/Dev/Projects/VH Health/VH-Health-Platform"
git fetch github '+refs/heads/*:refs/remotes/github/*'
git worktree add "$SCRATCH/wt/rpd-impl" -b feat/reprocessable-devices-platform github/main
cd "$SCRATCH/wt/rpd-impl/apps/backend" && npm ci
```

- [ ] **Step 2: Compute the migration number against main and every open branch**

```bash
cd "$SCRATCH/wt/rpd-impl"
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do
  git ls-tree --name-only "$ref" apps/backend/src/migrations/ 2>/dev/null
done | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | uniq | tail -3
```

Expected tail once Phase 1 has landed: `765`, `766`, `767`. **767 is the Phase 1 lane's** (dialysis isolation derivation, dev-ea); this plan takes the next free number — `NNN` = 768 unless another branch has claimed it, in which case the next after that. Resolve `NNN` here, once, and substitute it in the migration file name, the SQL header, the `prisma.js` / `prismaCoverage` comments, the seeder comments and the commit messages (`grep -rn "NNN" apps/backend docs/superpowers/plans/2026-09-05-reprocessable-devices-platform.md` finds every site). Re-run immediately before the final push (Task 9 Step 1). If Phase 1 has NOT landed yet the tail still ends `766` — the number is still 768 (767 is reserved, and the collisions gate does not require contiguity), and Task 9 waits.

- [ ] **Step 3: Scratch database**

```bash
createdb -h 127.0.0.1 -p 55432 vh_rpd_<initials>
export DATABASE_URL="postgres://<user>:<pass>@127.0.0.1:55432/vh_rpd_<initials>"
```

---

## Task 1: Migration `NNN`, mirror, runtime grants, pins, seeder overrides

**Files:**
- Create: `apps/backend/src/migrations/NNN_reprocessable_devices_platform.sql`
- Modify: `apps/backend/prisma/schema.prisma`, `apps/backend/src/lib/prisma.js` (≈1293 and ≈1315), `apps/backend/src/tests/unit/prismaCoverage.test.js` (≈1369–1382), `apps/backend/scripts/seed-comprehensive-test-data.mjs` (`TABLE_COLUMN_SEED_OVERRIDES`, after the `cath_case_lab_readiness_items` entry)

Facts confirmed against the tree before writing (re-verify; do not assume):

- `ux_facilities_tenant_id (tenant_id, id)` exists (598) and `ux_users_tenant_uid_for_pathways (tenant_id, uid)` exists (580). No `(tenant_id, id)` unique exists on `dialysis_sessions`, `ot_schedules`, `instrument_sets`, `sterilization_loads`, `set_issue_log` or `clinical_ai_biomed_devices` — `NNN` creates all six.
- `dialysis_patients.hbsag_status` etc. and their CHECKs exist (baseline lines 7938–7963; census entries `enforced: true`). `isolation_required` is a stored generated column. **`NNN` does not touch `dialysis_patients`** — the default flip and every other change to the three columns is Phase 1's (767). `dialysis_patients` and `dialysis_sessions` have **no FK from `tenant_id` to `tenants`** (168 declared none) — `NNN` does not add one; the composite uniques are enough for the child FKs.
- **`NNN` does not touch `patient_bloodborne_markers`** — the `dialysis_surveillance` source and the lab-link CHECK widening are Phase 1's. If 767 has already landed when this runs, its CHECKs are simply there; this migration must not re-declare them.
- `medication_safety_reviews.review_type` is `VARCHAR(80)` with no CHECK (269:196): no migration for the new `review_type` value.

- [ ] **Step 1: Write the migration**

```sql
-- NNN_reprocessable_devices_platform.sql   (NNN = the next free number at push
-- time; 767 belongs to the dialysis isolation derivation lane, which this
-- platform CONSUMES and does not duplicate - see the spec, section 3.3)
--
-- Department-agnostic reprocessable-device platform, first consumers dialysis
-- and OT (spec docs/superpowers/specs/2026-09-05-reprocessable-devices-platform-design.md).
-- Before this migration the platform held four reprocessing loops with four
-- identity models: cath (765, system-minted tag, full serology gate), dialysis
-- (418, operator-typed serial, per-session mutable row, typed cycle count, no
-- serology gate), OT/CSSD (421-423, set barcode, no cycle count, no exposure
-- flag) and linen (473-474, quantity only). This migration converges dialysis
-- and OT onto one register, one policy shape and one state machine. The cath
-- register (cath_reprocessable_devices) and the two 753 plpgsql functions are
-- NOT touched: none of the tables below is on either assert's list, and no
-- plpgsql body is re-declared here.
--
-- Owner decisions the schema is shaped by (2026-09-05), stated inline so this
-- file reads without the spec:
--   D1  owner references on usage rows are nullable per-domain FKs
--       (dialysis_session_id, ot_schedule_id) + CHECK num_nonnulls(...) = 1,
--       the surgical_implants pattern (565); every arm a tenant-pinned composite.
--   D1b cath stays in cath_reprocessable_devices; 'cath' is reserved in the
--       domain enum and admitted by no CHECK here.
--   D2  the register is patient-blind; per-patient dialyser dedication lives on
--       reprocessable_device_dialysis_links, never on reprocessable_devices.
--   D2b domain is a fixed enum ('dialysis', 'ot'); per-domain rules are code.
--   D3  dialysis machines do not enter the register; a minimal dialysis_machines
--       carries the tenant's ROUTING GROUP (isolation_group, nullable = general);
--       enforcement is warn-only with a recorded override
--       (dialysis_sessions.isolation_*), switchable to block per tenant.
--   D11 NO (owner, 2026-09-06): a routing role learns THAT a patient is isolated,
--       never WHICH marker. isolation_group replaces isolation_class on the
--       machine; the marker-class -> group map is reprocessing_domain_settings
--       .isolation_groups, edited by infection control / admin only.
--   D5  OT scope is instrument sets + the sterilisation-load evidence FK on
--       surgical_implants; implant reuse is out of scope.
--   D6  dialyzer_reuse_register stays as the statutory log and gains device_id
--       (+ device_usage_id); reuse_cycle_count becomes DERIVED from the device.
--   D7  sterilisation evidence is load-driven for OT (last_sterilization_load_id,
--       usages.sterilization_load_id), not for dialysis (chemical reprocessing).
--   D8  billing unchanged. D9 manufacturer_serial / hospital_asset_id accepted
--       beside the minted device_tag (prefix 'RD', never 'RP').
--
-- Decisions taken within those:
--   * TWO policy tables: reprocessing_domain_settings (tenant x domain: the
--     serology rule, needed before a category is known) and
--     reprocessing_domain_policies (tenant x domain x category).
--   * reactive_patient_rule gains 'quarantine' (OT default): a reactive
--     patient's set is held for infection control, not retired. No column
--     default on that column - the honest default differs per domain and is
--     supplied by the service read path, so "no row" and "row with defaults"
--     cannot disagree.
--   * max_cycles is OPTIONAL (instrument sets have no meaningful ceiling), so
--     max_cycles_snapshot is nullable and the bound CHECK tolerates NULL - the
--     one place this register's CHECKs differ from 765's.
--   * facility_id is NULLABLE: neither dialysis_sessions nor instrument_sets
--     carries a facility today; the upstream backfill is a separate decision.
--   * dialysis_patients and patient_bloodborne_markers are deliberately NOT
--     touched here. The three roster serology columns, their defaults, the
--     read-time isolation resolver that weighs them beside the marker record,
--     the dialysis_surveillance marker source and the legacy backfill are the
--     Phase 1 lane's (migration 767). This platform reads that lane's
--     resolver for every dialysis decision and writes nothing to the roster.
--
-- Baseline-owned tables touched (dialysis_sessions, ot_schedules,
-- surgical_implants, clinical_ai_biomed_devices) are altered only with
-- ALTER TABLE / CREATE UNIQUE INDEX; the inline-check census manifest is
-- unchanged. Every CHECK is named. Every FK is a tenant-pinned composite;
-- composite SET NULL actions carry the column list; the two patient-keyed FKs
-- are DEFERRABLE INITIALLY DEFERRED for the patient-merge sweep.
--
-- Deploy note: the six backing uniques are non-concurrent index builds inside
-- this transaction (the 765/766 note for lab_results); ot_schedules is the
-- largest.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ---------------------------------------------------------------------------
-- 1. Composite-FK backing uniques on the tables the new rows point at
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX ux_dialysis_sessions_tenant_id ON dialysis_sessions (tenant_id, id);
CREATE UNIQUE INDEX ux_ot_schedules_tenant_id ON ot_schedules (tenant_id, id);
CREATE UNIQUE INDEX ux_instrument_sets_tenant_id ON instrument_sets (tenant_id, id);
CREATE UNIQUE INDEX ux_sterilization_loads_tenant_id ON sterilization_loads (tenant_id, id);
CREATE UNIQUE INDEX ux_set_issue_log_tenant_id ON set_issue_log (tenant_id, id);
CREATE UNIQUE INDEX ux_clinical_ai_biomed_devices_tenant_id ON clinical_ai_biomed_devices (tenant_id, id);

-- ---------------------------------------------------------------------------
-- 2. Domain settings (tenant x domain)
-- ---------------------------------------------------------------------------
CREATE TABLE reprocessing_domain_settings (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL,
  reactive_patient_rule VARCHAR(24) NOT NULL,
  unknown_serology_rule VARCHAR(24) NOT NULL DEFAULT 'warn',
  serology_validity_days INTEGER NOT NULL DEFAULT 90,
  isolation_enforcement VARCHAR(8) NOT NULL DEFAULT 'warn',
  -- D11 = NO: the tenant's marker-class -> routing-group map, e.g.
  -- {"hbsag":"Bay 1","hcv":"Bay 2","hiv":"Bay 2","isolation_mixed":"Bay 3"}.
  -- Values are the tenant's own dialysis_machines.isolation_group labels and
  -- carry no clinical meaning; the KEYS are pinned by CHECK so nothing else can
  -- be smuggled into this object.
  isolation_groups JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ(6),
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT reprocessing_domain_settings_pkey PRIMARY KEY (tenant_id, domain),
  CONSTRAINT reprocessing_domain_settings_domain_check
    CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT reprocessing_domain_settings_reactive_rule_check
    CHECK (reactive_patient_rule IN ('discard', 'quarantine', 'override_allowed')),
  CONSTRAINT reprocessing_domain_settings_unknown_rule_check
    CHECK (unknown_serology_rule IN ('warn', 'block_return')),
  CONSTRAINT reprocessing_domain_settings_validity_check
    CHECK (serology_validity_days BETWEEN 1 AND 365),
  CONSTRAINT reprocessing_domain_settings_isolation_enforcement_check
    CHECK (isolation_enforcement IN ('warn', 'block')),
  CONSTRAINT reprocessing_domain_settings_isolation_domain_check
    CHECK (domain = 'dialysis' OR isolation_enforcement = 'warn'),
  CONSTRAINT reprocessing_domain_settings_isolation_groups_shape_check
    CHECK (jsonb_typeof(isolation_groups) = 'object'),
  CONSTRAINT reprocessing_domain_settings_isolation_groups_keys_check
    CHECK (isolation_groups - ARRAY['hbsag', 'hcv', 'hiv', 'isolation_mixed'] = '{}'::jsonb),
  CONSTRAINT reprocessing_domain_settings_isolation_groups_domain_check
    CHECK (domain = 'dialysis' OR isolation_groups = '{}'::jsonb)
);

-- ---------------------------------------------------------------------------
-- 3. Domain policies (tenant x domain x category)
-- ---------------------------------------------------------------------------
CREATE TABLE reprocessing_domain_policies (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL,
  category VARCHAR(40) NOT NULL,
  reprocessable BOOLEAN NOT NULL DEFAULT FALSE,
  max_cycles INTEGER,
  allowed_cycle_types TEXT[] NOT NULL DEFAULT '{}'::text[],
  function_check_required BOOLEAN NOT NULL DEFAULT FALSE,
  tcv_min_pct INTEGER,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT reprocessing_domain_policies_pkey PRIMARY KEY (tenant_id, domain, category),
  CONSTRAINT reprocessing_domain_policies_domain_check
    CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT reprocessing_domain_policies_category_check
    CHECK (
      (domain = 'dialysis' AND category IN ('dialyser', 'bloodline', 'other'))
      OR (domain = 'ot' AND category IN ('instrument_set', 'tray', 'implant_set', 'procedure_pack', 'other'))
    ),
  CONSTRAINT reprocessing_domain_policies_max_cycles_check
    CHECK (max_cycles IS NULL OR max_cycles BETWEEN 1 AND 100),
  CONSTRAINT reprocessing_domain_policies_cycle_types_check
    CHECK (allowed_cycle_types <@ ARRAY['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other']::text[]),
  CONSTRAINT reprocessing_domain_policies_dialysis_cycle_type_check
    CHECK (domain <> 'dialysis' OR allowed_cycle_types <@ ARRAY['chemical', 'other']::text[]),
  CONSTRAINT reprocessing_domain_policies_ot_function_check_check
    CHECK (domain <> 'ot' OR function_check_required = FALSE),
  CONSTRAINT reprocessing_domain_policies_tcv_check
    CHECK (tcv_min_pct IS NULL OR (domain = 'dialysis' AND tcv_min_pct BETWEEN 50 AND 100)),
  CONSTRAINT reprocessing_domain_policies_complete_check
    CHECK (reprocessable = FALSE OR cardinality(allowed_cycle_types) >= 1)
);

-- ---------------------------------------------------------------------------
-- 4. The register (no patient identity)
-- ---------------------------------------------------------------------------
CREATE TABLE reprocessable_devices (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL,
  category VARCHAR(40) NOT NULL,
  facility_id INTEGER,
  -- 'RD', never 'RP': a tag can never resolve against the cath register. Width
  -- floor grows with id (the 765 as-built lesson: fixed lpad truncates).
  device_tag VARCHAR(24) GENERATED ALWAYS AS ('RD' || lpad(id::text, GREATEST(8, length(id::text)), '0')) STORED,
  manufacturer_serial VARCHAR(120),
  hospital_asset_id VARCHAR(120),
  manufacturer VARCHAR(120),
  model_name VARCHAR(120),
  instrument_set_id BIGINT,
  enrolled_via VARCHAR(24) NOT NULL,
  cycle_count INTEGER NOT NULL DEFAULT 0,
  max_cycles_snapshot INTEGER,
  status VARCHAR(32) NOT NULL DEFAULT 'available',
  current_usage_id BIGINT,
  exposure_flag BOOLEAN NOT NULL DEFAULT FALSE,
  exposure_markers TEXT[] NOT NULL DEFAULT '{}'::text[],
  last_reprocessed_at TIMESTAMPTZ(6),
  last_reprocessed_by UUID,
  last_cycle_type VARCHAR(20),
  last_function_check VARCHAR(16),
  last_sterilization_load_id BIGINT,
  quarantine_reason TEXT,
  quarantined_at TIMESTAMPTZ(6),
  discard_reason VARCHAR(40),
  discard_note TEXT,
  discarded_at TIMESTAMPTZ(6),
  discarded_by UUID,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT fk_reprocessable_devices_facility
    FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities (tenant_id, id),
  CONSTRAINT fk_reprocessable_devices_instrument_set
    FOREIGN KEY (tenant_id, instrument_set_id) REFERENCES instrument_sets (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_devices_last_load
    FOREIGN KEY (tenant_id, last_sterilization_load_id) REFERENCES sterilization_loads (tenant_id, id)
    ON DELETE SET NULL (last_sterilization_load_id),
  CONSTRAINT reprocessable_devices_domain_check
    CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT reprocessable_devices_category_check
    CHECK (
      (domain = 'dialysis' AND category IN ('dialyser', 'bloodline', 'other'))
      OR (domain = 'ot' AND category IN ('instrument_set', 'tray', 'implant_set', 'procedure_pack', 'other'))
    ),
  CONSTRAINT reprocessable_devices_identity_check
    CHECK (((domain = 'ot') = (instrument_set_id IS NOT NULL))
           AND (domain <> 'dialysis' OR manufacturer_serial IS NOT NULL)),
  CONSTRAINT reprocessable_devices_enrolled_via_check
    CHECK (enrolled_via IN ('session_capture', 'set_issue', 'console')),
  CONSTRAINT reprocessable_devices_cycle_check CHECK (cycle_count >= 0),
  CONSTRAINT reprocessable_devices_max_cycles_check CHECK (max_cycles_snapshot IS NULL OR max_cycles_snapshot >= 1),
  CONSTRAINT reprocessable_devices_cycle_bound_check
    CHECK (max_cycles_snapshot IS NULL OR cycle_count <= max_cycles_snapshot),
  CONSTRAINT reprocessable_devices_status_check
    CHECK (status IN ('awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded')),
  CONSTRAINT reprocessable_devices_in_case_check
    CHECK ((status = 'in_case') = (current_usage_id IS NOT NULL)),
  CONSTRAINT reprocessable_devices_exposure_check
    CHECK (exposure_flag OR cardinality(exposure_markers) = 0),
  CONSTRAINT reprocessable_devices_cycle_type_check
    CHECK (last_cycle_type IS NULL OR last_cycle_type IN ('steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other')),
  CONSTRAINT reprocessable_devices_function_check_check
    CHECK (last_function_check IS NULL OR last_function_check IN ('not_required', 'pass', 'fail')),
  CONSTRAINT reprocessable_devices_load_domain_check
    CHECK (domain = 'ot' OR last_sterilization_load_id IS NULL),
  CONSTRAINT reprocessable_devices_discard_reason_check
    CHECK (discard_reason IS NULL OR discard_reason IN (
      'max_cycles_reached', 'bloodborne_exposure', 'late_reactive_marker', 'function_check_failed',
      'sterilization_failed', 'damaged', 'wasted', 'policy_change', 'other',
      'tcv_below_threshold', 'integrity_test_failed', 'set_retired')),
  CONSTRAINT reprocessable_devices_discarded_check
    CHECK (status <> 'discarded' OR (discard_reason IS NOT NULL AND discarded_at IS NOT NULL))
);
-- 15 CHECKs above (domain, category, identity, enrolled_via, cycle, max_cycles,
-- cycle_bound, status, in_case, exposure, cycle_type, function_check,
-- load_domain, discard_reason, discarded); none inline on a column.

CREATE UNIQUE INDEX ux_reprocessable_devices_tag ON reprocessable_devices (tenant_id, device_tag);
CREATE UNIQUE INDEX ux_reprocessable_devices_tenant_id ON reprocessable_devices (tenant_id, id);
-- Target for the three-column child FKs that pin a child's domain to its device's.
CREATE UNIQUE INDEX ux_reprocessable_devices_tenant_id_domain ON reprocessable_devices (tenant_id, id, domain);
CREATE UNIQUE INDEX ux_reprocessable_devices_serial ON reprocessable_devices (tenant_id, domain, manufacturer_serial)
  WHERE manufacturer_serial IS NOT NULL;
CREATE UNIQUE INDEX ux_reprocessable_devices_asset ON reprocessable_devices (tenant_id, domain, hospital_asset_id)
  WHERE hospital_asset_id IS NOT NULL;
CREATE UNIQUE INDEX ux_reprocessable_devices_set ON reprocessable_devices (tenant_id, instrument_set_id)
  WHERE instrument_set_id IS NOT NULL;
CREATE INDEX idx_reprocessable_devices_domain_status ON reprocessable_devices (tenant_id, domain, status);
CREATE INDEX idx_reprocessable_devices_facility ON reprocessable_devices (tenant_id, facility_id, status)
  WHERE facility_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Usage rows (patient linkage; typed owner pair, D1)
-- ---------------------------------------------------------------------------
CREATE TABLE reprocessable_device_usages (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL,
  device_id BIGINT NOT NULL,
  patient_uid UUID NOT NULL,
  dialysis_session_id INTEGER,
  ot_schedule_id INTEGER,
  set_issue_log_id BIGINT,
  sterilization_load_id BIGINT,
  reuse_cycle INTEGER NOT NULL,
  captured_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  captured_by UUID NOT NULL,
  capture_source VARCHAR(24) NOT NULL,
  reuse_screen JSONB,
  post_use_screen JSONB,
  post_use_disposition VARCHAR(40),
  returned_at TIMESTAMPTZ(6),
  returned_by UUID,
  acknowledgement_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_reprocessable_device_usages_device
    FOREIGN KEY (tenant_id, device_id, domain) REFERENCES reprocessable_devices (tenant_id, id, domain) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_usages_patient
    FOREIGN KEY (tenant_id, patient_uid) REFERENCES users (tenant_id, uid) ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_reprocessable_device_usages_captured_by
    FOREIGN KEY (tenant_id, captured_by) REFERENCES users (tenant_id, uid) ON DELETE NO ACTION,
  CONSTRAINT fk_reprocessable_device_usages_dialysis_session
    FOREIGN KEY (tenant_id, dialysis_session_id) REFERENCES dialysis_sessions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_usages_ot_schedule
    FOREIGN KEY (tenant_id, ot_schedule_id) REFERENCES ot_schedules (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_reprocessable_device_usages_set_issue
    FOREIGN KEY (tenant_id, set_issue_log_id) REFERENCES set_issue_log (tenant_id, id)
    ON DELETE SET NULL (set_issue_log_id),
  CONSTRAINT fk_reprocessable_device_usages_load
    FOREIGN KEY (tenant_id, sterilization_load_id) REFERENCES sterilization_loads (tenant_id, id)
    ON DELETE SET NULL (sterilization_load_id),
  CONSTRAINT reprocessable_device_usages_domain_check
    CHECK (domain IN ('dialysis', 'ot')),
  CONSTRAINT reprocessable_device_usages_owner_check
    CHECK (num_nonnulls(dialysis_session_id, ot_schedule_id) = 1),
  CONSTRAINT reprocessable_device_usages_owner_domain_check
    CHECK (((domain = 'dialysis') = (dialysis_session_id IS NOT NULL))
           AND ((domain = 'ot') = (ot_schedule_id IS NOT NULL))),
  CONSTRAINT reprocessable_device_usages_ot_links_check
    CHECK (domain = 'ot' OR (set_issue_log_id IS NULL AND sterilization_load_id IS NULL)),
  CONSTRAINT reprocessable_device_usages_reuse_cycle_check CHECK (reuse_cycle >= 0),
  CONSTRAINT reprocessable_device_usages_capture_source_check
    CHECK (capture_source IN ('staff_app', 'admin_console', 'cssd_issue', 'system')),
  -- 'cancelled_before_use': the case was cancelled before use and the device
  -- was RELEASED (in_case -> available, no cycle, no reprocessing record).
  -- returned_at is the table's one close timestamp and is written then too.
  CONSTRAINT reprocessable_device_usages_post_use_check
    CHECK (post_use_disposition IS NULL OR post_use_disposition IN (
      'sent_for_reprocessing', 'quarantined_bloodborne_exposure', 'discarded_bloodborne_exposure',
      'discarded_max_cycles', 'discarded_integrity_failed', 'discarded_tcv_below_threshold', 'discarded_other',
      'cancelled_before_use')),
  CONSTRAINT reprocessable_device_usages_returned_check
    CHECK ((post_use_disposition IS NULL) = (returned_at IS NULL))
);

CREATE UNIQUE INDEX ux_reprocessable_device_usages_tenant_id ON reprocessable_device_usages (tenant_id, id);
-- Each cycle is used at most once - EXCEPT that a usage cancelled before use
-- does not consume its cycle: the device's cycle_count is unchanged, so the
-- next capture writes the same reuse_cycle and must be legal.
CREATE UNIQUE INDEX ux_reprocessable_device_usages_cycle ON reprocessable_device_usages (tenant_id, device_id, reuse_cycle)
  WHERE post_use_disposition IS DISTINCT FROM 'cancelled_before_use';
CREATE UNIQUE INDEX ux_reprocessable_device_usages_open ON reprocessable_device_usages (tenant_id, device_id)
  WHERE returned_at IS NULL;
CREATE UNIQUE INDEX ux_reprocessable_device_usages_session ON reprocessable_device_usages (tenant_id, dialysis_session_id)
  WHERE dialysis_session_id IS NOT NULL;
CREATE UNIQUE INDEX ux_reprocessable_device_usages_issue ON reprocessable_device_usages (tenant_id, set_issue_log_id)
  WHERE set_issue_log_id IS NOT NULL;
CREATE INDEX idx_reprocessable_device_usages_patient ON reprocessable_device_usages (tenant_id, patient_uid, captured_at DESC);
CREATE INDEX idx_reprocessable_device_usages_schedule ON reprocessable_device_usages (tenant_id, ot_schedule_id)
  WHERE ot_schedule_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. The register's pointer at its open usage (circular FK, added after 5)
-- ---------------------------------------------------------------------------
ALTER TABLE reprocessable_devices
  ADD CONSTRAINT fk_reprocessable_devices_current_usage
    FOREIGN KEY (tenant_id, current_usage_id) REFERENCES reprocessable_device_usages (tenant_id, id)
    ON DELETE SET NULL (current_usage_id);

-- ---------------------------------------------------------------------------
-- 7. Dialysis link row (dedication + baseline TCV; D2)
-- ---------------------------------------------------------------------------
CREATE TABLE reprocessable_device_dialysis_links (
  device_id BIGINT PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  domain VARCHAR(16) NOT NULL DEFAULT 'dialysis',
  dedicated_patient_uid UUID NOT NULL,
  dedicated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  dedicated_by UUID NOT NULL,
  baseline_tcv_ml NUMERIC(6, 1),
  baseline_tcv_measured_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_reprocessable_device_dialysis_links_device
    FOREIGN KEY (tenant_id, device_id, domain) REFERENCES reprocessable_devices (tenant_id, id, domain) ON DELETE CASCADE,
  CONSTRAINT fk_reprocessable_device_dialysis_links_patient
    FOREIGN KEY (tenant_id, dedicated_patient_uid) REFERENCES users (tenant_id, uid) ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT reprocessable_device_dialysis_links_domain_check CHECK (domain = 'dialysis'),
  CONSTRAINT reprocessable_device_dialysis_links_baseline_tcv_check
    CHECK (baseline_tcv_ml IS NULL OR baseline_tcv_ml > 0)
);

CREATE INDEX idx_reprocessable_device_dialysis_links_patient
  ON reprocessable_device_dialysis_links (tenant_id, dedicated_patient_uid);

-- ---------------------------------------------------------------------------
-- 8. Dialysis machines (minimal; D3). Not a device: no cycles, no queue.
-- ---------------------------------------------------------------------------
CREATE TABLE dialysis_machines (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id INTEGER,
  machine_no VARCHAR(40) NOT NULL,
  display_name VARCHAR(120),
  biomed_device_id INTEGER,
  -- D11 = NO: the tenant's own routing label ("Bay 1", "Red side"). NULLABLE,
  -- and NULL means a general machine. No enum CHECK: the vocabulary is the
  -- tenant's, not the platform's, and it names no marker.
  isolation_group VARCHAR(40),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  notes TEXT,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_dialysis_machines_facility
    FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities (tenant_id, id),
  CONSTRAINT fk_dialysis_machines_biomed_device
    FOREIGN KEY (tenant_id, biomed_device_id) REFERENCES clinical_ai_biomed_devices (tenant_id, id)
    ON DELETE SET NULL (biomed_device_id),
  CONSTRAINT dialysis_machines_isolation_group_check
    CHECK (isolation_group IS NULL OR btrim(isolation_group) <> ''),
  CONSTRAINT dialysis_machines_status_check
    CHECK (status IN ('active', 'out_of_service', 'retired')),
  CONSTRAINT ux_dialysis_machines_machine_no UNIQUE (tenant_id, machine_no)
);

CREATE INDEX idx_dialysis_machines_group ON dialysis_machines (tenant_id, isolation_group, status);

-- ---------------------------------------------------------------------------
-- 9. dialysis_sessions: isolation evaluation (mirrors 423's warn_only /
--    enforcement_enabled pair). Baseline-owned: ALTER only.
-- ---------------------------------------------------------------------------
ALTER TABLE dialysis_sessions
  ADD COLUMN isolation_warning_codes TEXT[] NOT NULL DEFAULT '{}'::text[],
  -- D11 = NO: the routing GROUP the evaluation decided, persisted beside the
  -- codes so the session read can re-serialise the warning without asking the
  -- resolver for a marker class. A bay label, publishable to every dialysis
  -- role; there is deliberately no isolation_required_class column.
  ADD COLUMN isolation_required_group VARCHAR(40),
  ADD COLUMN isolation_warn_only BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN isolation_enforcement_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN isolation_override_reason TEXT,
  ADD COLUMN isolation_override_by UUID,
  ADD COLUMN isolation_override_at TIMESTAMPTZ(6),
  ADD COLUMN isolation_evaluated_at TIMESTAMPTZ(6);

ALTER TABLE dialysis_sessions
  ADD CONSTRAINT dialysis_sessions_isolation_override_check
    CHECK (num_nonnulls(isolation_override_reason, isolation_override_by, isolation_override_at) IN (0, 3));

-- ---------------------------------------------------------------------------
-- 10. dialyzer_reuse_register (418): the statutory log gains identity (D6) and
--     the fields the common Indian forms carry. Existing columns, CHECKs and
--     the per-session unique are untouched.
-- ---------------------------------------------------------------------------
ALTER TABLE dialyzer_reuse_register
  ADD COLUMN device_id BIGINT,
  ADD COLUMN device_usage_id BIGINT,
  ADD COLUMN measured_tcv_ml NUMERIC(6, 1),
  ADD COLUMN tcv_pct_of_baseline NUMERIC(5, 1),
  ADD COLUMN reprocessing_agent VARCHAR(24),
  ADD COLUMN disinfectant_contact_minutes INTEGER,
  ADD COLUMN disinfectant_concentration_pct NUMERIC(5, 2);

ALTER TABLE dialyzer_reuse_register
  ADD CONSTRAINT fk_dialyzer_reuse_register_device
    FOREIGN KEY (tenant_id, device_id) REFERENCES reprocessable_devices (tenant_id, id)
    ON DELETE SET NULL (device_id),
  ADD CONSTRAINT fk_dialyzer_reuse_register_device_usage
    FOREIGN KEY (tenant_id, device_usage_id) REFERENCES reprocessable_device_usages (tenant_id, id)
    ON DELETE SET NULL (device_usage_id),
  ADD CONSTRAINT chk_dialyzer_reuse_device_pair
    CHECK ((device_id IS NULL) = (device_usage_id IS NULL)),
  ADD CONSTRAINT chk_dialyzer_reuse_agent
    CHECK (reprocessing_agent IS NULL OR reprocessing_agent IN ('peracetic_acid', 'formaldehyde', 'glutaraldehyde', 'renalin', 'other')),
  ADD CONSTRAINT chk_dialyzer_reuse_contact_minutes
    CHECK (disinfectant_contact_minutes IS NULL OR disinfectant_contact_minutes BETWEEN 0 AND 1440),
  ADD CONSTRAINT chk_dialyzer_reuse_measured_tcv
    CHECK (measured_tcv_ml IS NULL OR measured_tcv_ml > 0),
  ADD CONSTRAINT chk_dialyzer_reuse_tcv_pct
    CHECK (tcv_pct_of_baseline IS NULL OR tcv_pct_of_baseline BETWEEN 0 AND 200);

CREATE INDEX idx_dialyzer_reuse_register_device ON dialyzer_reuse_register (tenant_id, device_id)
  WHERE device_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 11. surgical_implants: the sterilisation-load evidence FK it lacked (D5).
--     Baseline-owned: ALTER only. sterilization_lot (free text) stays.
-- ---------------------------------------------------------------------------
ALTER TABLE surgical_implants
  ADD COLUMN sterilization_load_id BIGINT;

ALTER TABLE surgical_implants
  ADD CONSTRAINT fk_surgical_implants_sterilization_load
    FOREIGN KEY (tenant_id, sterilization_load_id) REFERENCES sterilization_loads (tenant_id, id)
    ON DELETE SET NULL (sterilization_load_id);

-- (No step touches patient_bloodborne_markers or dialysis_patients: the
--  dialysis_surveillance source, the 764 CHECK-pair widening and the roster
--  column defaults are migration 767's - the Phase 1 lane.)

-- ---------------------------------------------------------------------------
-- 12. RLS on the five new tables and dialysis_machines
-- ---------------------------------------------------------------------------
ALTER TABLE reprocessing_domain_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reprocessing_domain_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON reprocessing_domain_settings;
CREATE POLICY tenant_isolation ON reprocessing_domain_settings
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE reprocessing_domain_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE reprocessing_domain_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON reprocessing_domain_policies;
CREATE POLICY tenant_isolation ON reprocessing_domain_policies
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE reprocessable_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE reprocessable_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON reprocessable_devices;
CREATE POLICY tenant_isolation ON reprocessable_devices
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE reprocessable_device_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE reprocessable_device_usages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON reprocessable_device_usages;
CREATE POLICY tenant_isolation ON reprocessable_device_usages
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE reprocessable_device_dialysis_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE reprocessable_device_dialysis_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON reprocessable_device_dialysis_links;
CREATE POLICY tenant_isolation ON reprocessable_device_dialysis_links
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

ALTER TABLE dialysis_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE dialysis_machines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dialysis_machines;
CREATE POLICY tenant_isolation ON dialysis_machines
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = app_current_tenant_id_uuid()
  );

-- ---------------------------------------------------------------------------
-- 13. Runtime-role grants. Same to_regrole-guarded shape as 764/765: skip a
--     role the deployment never provisioned. All six tables are updated in
--     place (a policy edit, a cycle count, a dedication, a machine class) so the
--     contract is SELECT + INSERT + UPDATE; DELETE and TRUNCATE stay revoked -
--     a register that can be deleted is not a register.
--
--     This block runs once per database. src/lib/prisma.js
--     (ensureTenantRlsRuntimeRoleGrants) re-narrows the runtime role on EVERY
--     boot and silently leaves a table it does not know about on its broad
--     fallback grants (the to_regclass guard skips a stale name without error),
--     so all six tables are registered in its runtime_mutable_no_delete_relations
--     list and the three sequences in runtime_nextval_sequences.
-- ---------------------------------------------------------------------------
DO $reprocessable_devices_runtime_grants$
DECLARE
  role_name TEXT;
  table_name TEXT;
  sequence_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(role_name) IS NOT NULL THEN
      FOREACH table_name IN ARRAY ARRAY[
        'reprocessing_domain_settings',
        'reprocessing_domain_policies',
        'reprocessable_devices',
        'reprocessable_device_usages',
        'reprocessable_device_dialysis_links',
        'dialysis_machines'
      ]::TEXT[] LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I', table_name, role_name);
        EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE %I FROM %I', table_name, role_name);
      END LOOP;
      FOREACH sequence_name IN ARRAY ARRAY[
        'reprocessable_devices_id_seq',
        'reprocessable_device_usages_id_seq',
        'dialysis_machines_id_seq'
      ]::TEXT[] LOOP
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO %I', sequence_name, role_name);
        EXECUTE format('REVOKE UPDATE ON SEQUENCE %I FROM %I', sequence_name, role_name);
      END LOOP;
    END IF;
  END LOOP;
END
$reprocessable_devices_runtime_grants$;

COMMIT;
```

- [ ] **Step 2: Apply and verify the shape**

```bash
cd apps/backend
node scripts/ci-setup-db.mjs
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_constraint WHERE conrelid = 'reprocessable_devices'::regclass AND contype = 'c';"
psql "$DATABASE_URL" -c "SELECT conname FROM pg_constraint WHERE conrelid = 'reprocessable_device_usages'::regclass AND contype = 'f' ORDER BY 1;"
psql "$DATABASE_URL" -c "SELECT indexname FROM pg_indexes WHERE indexname IN ('ux_dialysis_sessions_tenant_id','ux_ot_schedules_tenant_id','ux_instrument_sets_tenant_id','ux_sterilization_loads_tenant_id','ux_set_issue_log_tenant_id','ux_clinical_ai_biomed_devices_tenant_id') ORDER BY 1;"
git diff --stat -- apps/backend/prisma/schema.prisma | tail -1
```

Expected: `15` CHECKs on the register; **eight** `contype = 'f'` rows on usages, in `ORDER BY 1`: `fk_reprocessable_device_usages_captured_by`, `…_device`, `…_dialysis_session`, `…_load`, `…_ot_schedule`, `…_patient`, `…_set_issue`, then `reprocessable_device_usages_tenant_id_fkey` — the table's own `tenant_id REFERENCES tenants(id)` is a foreign key like the seven named ones and the count query does not distinguish it; six index names. The `schema.prisma` diff (after Step 3) must show **no** change on the `dialysis_patients` or `patient_bloodborne_markers` models — if it does, this migration touched a Phase 1 table.

- [ ] **Step 3: Mirror in `schema.prisma`**

Run `npx prisma db pull --print --url "$DATABASE_URL"` and copy the emitted `reprocessing_domain_settings`, `reprocessing_domain_policies`, `reprocessable_devices`, `reprocessable_device_usages`, `reprocessable_device_dialysis_links`, `dialysis_machines` models and the new fields on `dialysis_sessions`, `dialyzer_reuse_register`, `surgical_implants` — **scalars, `@@id`/`@@unique`/`@@index` only. Delete every relation field and every back-relation the pull emits** (the `check:prisma-relations` budget lists the permitted relations; a new one fails `db:generate`). `device_tag` mirrors as `String? @default(dbgenerated("('RD'::text || lpad((id)::text, GREATEST(8, length((id)::text)), '0'::text))")) @db.VarChar(24)`. The partial cycle unique mirrors as `@@unique([tenant_id, device_id, reuse_cycle], map: "ux_reprocessable_device_usages_cycle")` only if the pull emits it — Prisma drops partial indexes from `db pull`, and `check-schema-drift.mjs` diffs against a full pull, so mirror exactly what the pull prints, no more.

**Do not touch the `dialysis_patients` mirror** (`prisma/schema.prisma:9107-9109`, `@default("negative")` today). Its defaults move to `'unknown'` in Phase 1's migration 767, and Phase 1 moves the mirror with them; if 767 is already on `main` the lines already read `"unknown"` and this lane leaves them so. `check-schema-drift.mjs` diffs a full `prisma db pull`, so a mirror line this lane changed without a matching DDL change of its own would fail the drift check — which is the right outcome. Then:

```bash
node scripts/check-schema-drift.mjs
npm run db:generate
npm run check:migration-numbers && npm run check:migration-session-guc
node ../../scripts/ci/check-inline-check-census.mjs
node ../../scripts/ci/check-inline-check-census.mjs --verify-db
node ../../scripts/ci/check-migration-immutability.mjs
```

Expected: all exit 0; the census prints an unchanged manifest (`expectedAbsentCount` 411).

- [ ] **Step 4: Register the tables in `prisma.js` and pin them**

In `apps/backend/src/lib/prisma.js`, after `'cath_case_lab_readiness_items'` in `runtime_mutable_no_delete_relations` (≈1313) add:

```js
    'reprocessing_domain_settings',
    'reprocessing_domain_policies',
    'reprocessable_devices',
    'reprocessable_device_usages',
    'reprocessable_device_dialysis_links',
    'dialysis_machines'
```

and after `'cath_case_lab_readiness_items_id_seq'` in `runtime_nextval_sequences` (≈1327):

```js
    'reprocessable_devices_id_seq',
    'reprocessable_device_usages_id_seq',
    'dialysis_machines_id_seq'
```

(mind the trailing comma on the previous last element). In `apps/backend/src/tests/unit/prismaCoverage.test.js`, after the `cath_case_lab_readiness_items` expectation (≈1376) add:

```js
      // Migration NNN (reprocessable devices platform), same once-per-database reach: settings and policies are
      // edited in place, a device's cycle count and status move, a dedication
      // and a machine class are corrected - none is ever deleted.
      for (const table of [
        'reprocessing_domain_settings', 'reprocessing_domain_policies', 'reprocessable_devices',
        'reprocessable_device_usages', 'reprocessable_device_dialysis_links', 'dialysis_machines',
      ]) expect(mutableNoDelete[1]).toContain(`'${table}'`);
```

and after the `cath_case_lab_readiness_items_id_seq` expectation:

```js
      for (const sequence of ['reprocessable_devices_id_seq', 'reprocessable_device_usages_id_seq', 'dialysis_machines_id_seq']) {
        expect(nextvalSequences[1]).toContain(`'${sequence}'`);
      }
```

Run: `npm test -- --testPathPatterns unit/prismaCoverage` — Expected: PASS.

- [ ] **Step 5: Seeder overrides**

In `apps/backend/scripts/seed-comprehensive-test-data.mjs`, inside `TABLE_COLUMN_SEED_OVERRIDES` after the `cath_case_lab_readiness_items` entry:

```js
  // mig NNN: one honest, inert settings row. reactive_patient_rule has no column
  // default on purpose (the honest default differs per domain), so the walker
  // must be told 'discard' for the dialysis row it seeds.
  reprocessing_domain_settings: {
    tenant_id: ctx => ctx.tenantId,
    domain: 'dialysis',
    reactive_patient_rule: 'discard',
    // D11 = NO: seeded EMPTY on purpose. A mapping is a tenant's clinical
    // configuration, not test data, and an unmapped tenant routes by "any
    // isolation machine" (spec 3.4) - which is the honest day-one state.
    isolation_groups: {}
  },
  // mig NNN: the one policy shape that permits nothing (mirrors the 765
  // 'catheter' row). The domain/category CHECK is a two-column disjunction the
  // walker cannot derive on its own.
  reprocessing_domain_policies: {
    tenant_id: ctx => ctx.tenantId,
    domain: 'dialysis',
    category: 'dialyser',
    reprocessable: false,
    max_cycles: null,
    allowed_cycle_types: [],
    function_check_required: false,
    tcv_min_pct: null
  },
  // mig NNN: a dialysis device is a real row on its own (a serial is its
  // identity), unlike 765's register which needs a first-use clinical event.
  reprocessable_devices: {
    tenant_id: ctx => ctx.tenantId,
    domain: 'dialysis',
    category: 'dialyser',
    facility_id: null,
    manufacturer_serial: 'SEED-DLZ-0001',
    hospital_asset_id: null,
    manufacturer: 'Seed Medical',
    model_name: 'F60',
    instrument_set_id: null,
    enrolled_via: 'console',
    cycle_count: 1,
    max_cycles_snapshot: null,
    status: 'available',
    current_usage_id: null,
    exposure_flag: false,
    exposure_markers: [],
    last_reprocessed_at: null,
    last_reprocessed_by: null,
    last_cycle_type: null,
    last_function_check: null,
    last_sterilization_load_id: null,
    quarantine_reason: null,
    quarantined_at: null,
    discard_reason: null,
    discard_note: null,
    discarded_at: null,
    discarded_by: null,
    created_by: ctx => ctx.doctor.uid
  },
  // mig NNN: a CLOSED usage (returned, dispositioned) so the seeded device can
  // sit 'available' with no open pointer; the owner pair is the dialysis arm.
  // dialysis_sessions sorts before this table; users always exists.
  reprocessable_device_usages: {
    tenant_id: ctx => ctx.tenantId,
    domain: 'dialysis',
    device_id: async () => firstTenantValue('reprocessable_devices', 'id'),
    patient_uid: ctx => ctx.patient.uid,
    dialysis_session_id: async () => firstTenantValue('dialysis_sessions', 'id'),
    ot_schedule_id: null,
    set_issue_log_id: null,
    sterilization_load_id: null,
    reuse_cycle: 0,
    captured_by: ctx => ctx.doctor.uid,
    capture_source: 'system',
    reuse_screen: null,
    post_use_screen: null,
    post_use_disposition: 'sent_for_reprocessing',
    returned_at: () => new Date().toISOString(),
    returned_by: ctx => ctx.doctor.uid,
    acknowledgement_reason: null
  },
  reprocessable_device_dialysis_links: {
    tenant_id: ctx => ctx.tenantId,
    device_id: async () => firstTenantValue('reprocessable_devices', 'id'),
    domain: 'dialysis',
    dedicated_patient_uid: ctx => ctx.patient.uid,
    dedicated_by: ctx => ctx.doctor.uid,
    baseline_tcv_ml: 100.0,
    baseline_tcv_measured_at: () => new Date().toISOString()
  },
  dialysis_machines: {
    tenant_id: ctx => ctx.tenantId,
    facility_id: null,
    machine_no: 'HD-01',
    display_name: 'Station 1',
    biomed_device_id: null,
    isolation_group: null,
    status: 'active',
    created_by: ctx => ctx.doctor.uid,
    updated_by: null
  },
```

Confirm `ctx.patient.uid` exists in the seeder's context (`grep -n "patient: {" scripts/seed-comprehensive-test-data.mjs`); if the context names it differently, use that name. Then:

```bash
npm run seed:test-data && npm run seed:test-data && npm run db:contracts:seeded
psql "$DATABASE_URL" -c "SELECT (SELECT count(*) FROM reprocessable_devices) AS devices, (SELECT count(*) FROM reprocessable_device_usages) AS usages, (SELECT count(*) FROM reprocessable_device_dialysis_links) AS links, (SELECT count(*) FROM dialysis_machines) AS machines;"
```

Expected: second seed run reports 0 new rows; contracts green; `1 | 1 | 1 | 1`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/migrations/NNN_reprocessable_devices_platform.sql apps/backend/prisma/schema.prisma apps/backend/src/lib/prisma.js apps/backend/src/tests/unit/prismaCoverage.test.js apps/backend/scripts/seed-comprehensive-test-data.mjs
git commit -m "feat(db): reprocessable devices platform register, policies, dialysis machines, 418/implant changes (mig NNN)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: `reprocessableDeviceRules.js` — pure rules (TDD)

**Files:**
- Create: `apps/backend/src/services/clinical/reprocessableDeviceRules.js`
- Test: `apps/backend/src/tests/unit/reprocessableDeviceRules.test.js`

- [ ] **Step 1: Write the failing unit tests**

```js
// apps/backend/src/tests/unit/reprocessableDeviceRules.test.js
import { computePostUseOptions } from '../../services/clinical/cathDeviceReuseService.js';
import {
  DEVICE_ACTIONS,
  DOMAINS,
  computeDispositionOptions,
  computeIsolationWarnings,
  deviceTransition,
  dialysisExposureStamp,
  normalizeDeviceTag,
  settingsDefaultsFor,
  tcvVerdict,
  validatePolicyInput,
} from '../../services/clinical/reprocessableDeviceRules.js';

const policy = { reprocessable: true, max_cycles: 6, allowed_cycle_types: ['chemical'], function_check_required: false, tcv_min_pct: 80 };
const dialysisSettings = { reactive_patient_rule: 'discard', unknown_serology_rule: 'warn', serology_validity_days: 90, isolation_enforcement: 'warn' };
const otSettings = { reactive_patient_rule: 'quarantine', unknown_serology_rule: 'warn', serology_validity_days: 90, isolation_enforcement: 'warn' };
// The cath/OT resolveReuseStatus shape (computeDispositionOptions reads only .status, so the dialysis Decision drives it the same way).
const clear = { status: 'clear', reasons: ['HIV, HBsAg and HCV non-reactive within window'], markers: [] };
const restricted = { status: 'restricted', reasons: ['HBsAg reactive 2026-08-12'], markers: [{ marker: 'hbsag', result: 'reactive' }] };
const unknown = { status: 'unknown', reasons: ['HCV not on record'], markers: [] };
// The Phase 1 Decision shape (spec §3.3) the isolation rule reads.
const dec = (status, isolation_class = null, evidence = 'marker') => ({ status, asOf: '2026-09-05T00:00:00.000Z', reasons: [], evidence, isolation_class });
const usage = { id: 1, post_use_disposition: null };
const device = (over = {}) => ({ id: 9, cycle_count: 1, max_cycles_snapshot: 6, status: 'in_case', exposure_flag: false, ...over });

describe('DOMAINS and transitions', () => {
  test('domains are exactly dialysis and ot (cath reserved, not admitted)', () => {
    expect(DOMAINS).toEqual(['dialysis', 'ot']);
  });
  test.each([
    ['available', 'capture', 'in_case'],
    ['in_case', 'return', 'awaiting_reprocessing'],
    ['awaiting_reprocessing', 'receive', 'in_cssd'],
    ['awaiting_reprocessing', 'reprocessed', 'available'],
    ['in_cssd', 'reprocessed', 'available'],
    ['available', 'quarantine', 'quarantined'],
    ['quarantined', 'release', 'awaiting_reprocessing'],
    ['in_case', 'discard', 'discarded'],
    ['in_case', 'uncapture', 'available'],
  ])('%s --%s--> %s', (from, action, to) => {
    expect(deviceTransition(from, action)).toEqual({ ok: true, to, allowedFrom: DEVICE_ACTIONS[action].from });
  });
  test.each([['discarded', 'receive'], ['available', 'release'], ['in_case', 'reprocessed'], ['quarantined', 'capture'], ['discarded', 'discard'], ['available', 'uncapture'], ['available', 'nonsense']])(
    '%s --%s--> refused', (from, action) => { expect(deviceTransition(from, action).ok).toBe(false); },
  );
  test('uncapture is the only action besides capture that touches in_case, and it leaves from in_case only', () => {
    expect(DEVICE_ACTIONS.uncapture).toEqual({ from: ['in_case'], to: 'available' });
    expect(Object.keys(DEVICE_ACTIONS).sort()).toEqual(['capture', 'discard', 'quarantine', 'receive', 'release', 'reprocessed', 'return', 'uncapture']);
  });
});

describe('normalizeDeviceTag', () => {
  test('accepts RD + 8..19 digits in any case', () => { expect(normalizeDeviceTag(' rd00000042 ')).toBe('RD00000042'); });
  test.each(['RP00000042', 'RD42', '', null, 'RD0000004A'])('rejects %p', (value) => {
    expect(() => normalizeDeviceTag(value)).toThrow(/device tag/);
  });
});

describe('settingsDefaultsFor', () => {
  test('dialysis discards, OT quarantines, both warn on unknown with a 90-day window', () => {
    expect(settingsDefaultsFor('dialysis')).toEqual({ reactive_patient_rule: 'discard', unknown_serology_rule: 'warn', serology_validity_days: 90, isolation_enforcement: 'warn' });
    expect(settingsDefaultsFor('ot')).toEqual({ reactive_patient_rule: 'quarantine', unknown_serology_rule: 'warn', serology_validity_days: 90, isolation_enforcement: 'warn' });
  });
  test('an unknown domain throws RPD_DOMAIN_INVALID', () => {
    expect(() => settingsDefaultsFor('cath')).toThrow(expect.objectContaining({ code: 'RPD_DOMAIN_INVALID' }));
  });
});

describe('computeDispositionOptions', () => {
  const run = (over = {}) => computeDispositionOptions({ domain: 'dialysis', usage, policy, settings: dialysisSettings, restriction: clear, device: device(), ...over });
  test('already dispositioned rows offer nothing', () => {
    expect(run({ usage: { ...usage, post_use_disposition: 'sent_for_reprocessing' } })).toMatchObject({ dispositions: [], reason_codes: ['already_recorded'] });
  });
  test('no policy or a non-reprocessable policy offers nothing', () => {
    expect(run({ policy: null }).reason_codes).toEqual(['not_reprocessable']);
    expect(run({ policy: { ...policy, reprocessable: false } }).reason_codes).toEqual(['not_reprocessable']);
  });
  test('clear: reprocess and discard, one unit, no acknowledgement', () => {
    expect(run()).toEqual({ dispositions: ['reprocess', 'discard'], requires_acknowledgement: false, exposure: false, discard_reason: null, quarantine_reason: null, blocked_code: null, reason_codes: [], units_max: 1 });
  });
  test('the device flag is checked BEFORE the ceiling: a flagged device at max cycles is retired for exposure, not end-of-life', () => {
    const out = run({ device: device({ exposure_flag: true, cycle_count: 6 }) });
    expect(out).toMatchObject({ dispositions: ['discard'], discard_reason: 'bloodborne_exposure', reason_codes: ['device_exposure_flagged'] });
  });
  test('at the ceiling on a clear patient: discard only, max_cycles_reached', () => {
    expect(run({ device: device({ cycle_count: 6 }) })).toMatchObject({ dispositions: ['discard'], discard_reason: 'max_cycles_reached' });
  });
  test('no ceiling (max_cycles_snapshot null) never reaches max_cycles_reached', () => {
    expect(run({ device: device({ cycle_count: 400, max_cycles_snapshot: null }) }).dispositions).toEqual(['reprocess', 'discard']);
  });
  test('restricted + discard: discard only', () => {
    expect(run({ restriction: restricted })).toMatchObject({ dispositions: ['discard'], discard_reason: 'bloodborne_exposure', reason_codes: ['bloodborne_restricted'] });
  });
  test('restricted + quarantine (the OT default): quarantine or discard, no acknowledgement', () => {
    expect(run({ domain: 'ot', settings: otSettings, restriction: restricted })).toMatchObject({ dispositions: ['quarantine', 'discard'], quarantine_reason: 'bloodborne_exposure', requires_acknowledgement: false, reason_codes: ['bloodborne_restricted_quarantine'] });
  });
  test('a flagged device under quarantine also quarantines', () => {
    expect(run({ domain: 'ot', settings: otSettings, device: device({ exposure_flag: true }) })).toMatchObject({ dispositions: ['quarantine', 'discard'], reason_codes: ['device_exposure_flagged'] });
  });
  test('restricted + override_allowed: reprocess with acknowledgement, exposure flagged', () => {
    expect(run({ settings: { ...dialysisSettings, reactive_patient_rule: 'override_allowed' }, restriction: restricted })).toMatchObject({ dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, exposure: true });
  });
  test('unknown + warn: reprocess with acknowledgement; unknown + block_return: discard only with the blocking code', () => {
    expect(run({ restriction: unknown })).toMatchObject({ dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, reason_codes: ['serology_unknown'] });
    expect(run({ restriction: unknown, settings: { ...dialysisSettings, unknown_serology_rule: 'block_return' } })).toMatchObject({ dispositions: ['discard'], blocked_code: 'RPD_SEROLOGY_REQUIRED' });
  });
  test('PARITY with cath: without a quarantine rule the two decision trees answer identically', () => {
    const cathPolicy = { reprocessable: true, max_cycles: 6, allowed_cycle_types: ['eto'], function_check_required: false };
    for (const rule of ['discard', 'override_allowed']) {
      for (const unknownRule of ['warn', 'block_return']) {
        for (const restriction of [clear, restricted, unknown]) {
          for (const dev of [device(), device({ exposure_flag: true }), device({ cycle_count: 6 })]) {
            const settings = { reactive_patient_rule: rule, unknown_serology_rule: unknownRule, serology_validity_days: 90 };
            const cath = computePostUseOptions({ usage: { ...usage, wasted: false, quantity: '1.0000', device_id: dev.id, reuse_cycle: 1 }, category: 'catheter', isImplant: false, policy: cathPolicy, settings, restriction, device: dev });
            const ours = computeDispositionOptions({ domain: 'dialysis', usage, policy: { ...policy, allowed_cycle_types: ['chemical'] }, settings, restriction, device: dev });
            const cathCode = cath.blocked_code === 'CATH_REPROCESSING_SEROLOGY_REQUIRED' ? 'RPD_SEROLOGY_REQUIRED' : cath.blocked_code;
            expect(ours).toEqual({ ...cath, blocked_code: cathCode, quarantine_reason: null, units_max: 1 });
          }
        }
      }
    }
  });
});

describe('computeIsolationWarnings (over a Phase 1 Decision + the tenant group map, spec §3.3 / §3.4)', () => {
  // D11 = NO: the machine's routing key is a tenant LABEL, nullable, and NULL is
  // a general machine. The marker class never leaves this function.
  const machine = (isolation_group) => ({ machine_no: 'HD-01', isolation_group, status: 'active' });
  const groups = { hbsag: 'Bay 1', hcv: 'Bay 2', hiv: 'Bay 2', isolation_mixed: 'Bay 3' };
  const warn = (decision, m, isolationGroups = groups, enforcement = 'warn') => computeIsolationWarnings({ decision, machine: m, isolationGroups, enforcement });
  test('clear patient on an unregistered machine: silence', () => {
    expect(warn(dec('clear'), null)).toEqual({ codes: [], required_group: null, blocked: false });
  });
  test('restricted patient on an unregistered machine warns; required_group is the tenant label, never the class', () => {
    const out = warn(dec('restricted', 'hbsag'), null);
    expect(out).toEqual({ codes: ['DIALYSIS_MACHINE_UNREGISTERED'], required_group: 'Bay 1', blocked: false });
    expect(JSON.stringify(out)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);   // no marker class in the output, ever
  });
  test('restricted patient on a general machine (isolation_group NULL): mismatch, warn-only', () => {
    expect(warn(dec('restricted', 'hbsag'), machine(null))).toEqual({ codes: ['DIALYSIS_ISOLATION_MACHINE_MISMATCH'], required_group: 'Bay 1', blocked: false });
  });
  test('restricted patient on a general machine under block: blocked', () => {
    expect(warn(dec('restricted', 'hbsag'), machine(null), groups, 'block').blocked).toBe(true);
  });
  test('restricted patient in the mapped bay: silence; two classes may share one bay', () => {
    expect(warn(dec('restricted', 'hbsag'), machine('Bay 1'), groups, 'block').codes).toEqual([]);
    expect(warn(dec('restricted', 'hcv'), machine('Bay 2'), groups, 'block').codes).toEqual([]);
    expect(warn(dec('restricted', 'hiv'), machine('Bay 2'), groups, 'block').codes).toEqual([]);   // one label, two classes (spec §4.1)
  });
  test('restricted patient in the WRONG bay: mismatch', () => {
    expect(warn(dec('restricted', 'hbsag'), machine('Bay 2'))).toMatchObject({ codes: ['DIALYSIS_ISOLATION_MACHINE_MISMATCH'], required_group: 'Bay 1' });
  });
  test('an UNMAPPED class: required_group is null, any non-null group satisfies, a general machine still mismatches', () => {
    expect(warn(dec('restricted', 'isolation_mixed'), machine('Bay 9'), {})).toEqual({ codes: [], required_group: null, blocked: false });
    expect(warn(dec('restricted', 'isolation_mixed'), machine(null), {}, 'block')).toEqual({ codes: ['DIALYSIS_ISOLATION_MACHINE_MISMATCH'], required_group: null, blocked: true });
    // A restricted Decision with NO class is read as isolation_mixed (the safe reading).
    expect(warn(dec('restricted', null), machine('Bay 3'))).toEqual({ codes: [], required_group: 'Bay 3', blocked: false });
  });
  test('UNKNOWN never isolates and never blocks: no code on any machine under warn or block (spec §3.3)', () => {
    for (const enforcement of ['warn', 'block']) {
      for (const m of [null, machine(null), machine('Bay 1'), machine('Bay 3')]) {
        expect(warn(dec('unknown', null, 'none'), m, groups, enforcement)).toEqual({ codes: [], required_group: null, blocked: false });
      }
    }
    expect(warn(null, machine(null), groups, 'block')).toEqual({ codes: [], required_group: null, blocked: false });
  });
  test('a clear patient in an isolation bay warns (general-patient code); a clear Decision from a legacy declaration counts as clear', () => {
    expect(warn(dec('clear'), machine('Bay 2')).codes).toEqual(['DIALYSIS_GENERAL_PATIENT_ON_ISOLATION_MACHINE']);
    expect(warn(dec('clear', null, 'legacy_declaration'), machine(null), groups, 'block').codes).toEqual([]);
  });
});

describe('dialysisExposureStamp (D11 = NO: the flag alone)', () => {
  test('the flag follows status and the marker list is ALWAYS empty - including for a Decision that still carries a class', () => {
    expect(dialysisExposureStamp(dec('restricted', 'hbsag'))).toEqual({ exposure_flag: true, exposure_markers: [] });
    expect(dialysisExposureStamp(dec('restricted', 'isolation_mixed'))).toEqual({ exposure_flag: true, exposure_markers: [] });
    expect(dialysisExposureStamp(dec('restricted', null))).toEqual({ exposure_flag: true, exposure_markers: [] });
    for (const d of [dec('clear'), dec('unknown', null, 'none'), null, undefined, {}]) {
      expect(dialysisExposureStamp(d)).toEqual({ exposure_flag: false, exposure_markers: [] });
    }
  });
  test('the module exports no class -> marker map at all', async () => {
    const mod = await import('../../services/clinical/reprocessableDeviceRules.js');
    expect(Object.keys(mod)).not.toContain('exposureMarkersForIsolationClass');
    expect(JSON.stringify(mod.default)).not.toMatch(/exposureMarkersForIsolationClass/);
  });
});

describe('tcvVerdict', () => {
  test('exactly the threshold passes; below fails; a missing baseline passes with a null percentage', () => {
    expect(tcvVerdict({ baseline: 100, measured: 80, minPct: 80 })).toEqual({ ok: true, pct: 80 });
    expect(tcvVerdict({ baseline: 100, measured: 79.9, minPct: 80 })).toEqual({ ok: false, pct: 79.9 });
    expect(tcvVerdict({ baseline: null, measured: 79.9, minPct: 80 })).toEqual({ ok: true, pct: null });
    expect(tcvVerdict({ baseline: 100, measured: null, minPct: 80 })).toEqual({ ok: true, pct: null });
  });
});

describe('validatePolicyInput', () => {
  test('dialysis refuses autoclave cycle types; OT refuses a function check; tcv_min_pct outside dialysis is refused', () => {
    expect(() => validatePolicyInput('dialysis', { category: 'dialyser', reprocessable: true, allowed_cycle_types: ['steam'] })).toThrow(expect.objectContaining({ code: 'RPD_CYCLE_TYPE_NOT_ALLOWED' }));
    expect(() => validatePolicyInput('ot', { category: 'tray', reprocessable: true, allowed_cycle_types: ['steam'], function_check_required: true })).toThrow(expect.objectContaining({ code: 'RPD_POLICY_INVALID' }));
    expect(() => validatePolicyInput('ot', { category: 'tray', reprocessable: false, tcv_min_pct: 80 })).toThrow(expect.objectContaining({ code: 'RPD_POLICY_INVALID' }));
    expect(validatePolicyInput('dialysis', { category: 'dialyser', reprocessable: true, allowed_cycle_types: ['chemical'], max_cycles: 8 })).toMatchObject({ category: 'dialyser', reprocessable: true, max_cycles: 8, tcv_min_pct: 80 });
    expect(validatePolicyInput('ot', { category: 'instrument_set', reprocessable: true, allowed_cycle_types: ['steam'] })).toMatchObject({ max_cycles: null, tcv_min_pct: null });
  });
});

```

(There is deliberately no legacy-column mapper in this module: the derivation of `dialysis_patients.*_status` is the Phase 1 lane's, spec §3.3.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --testPathPatterns unit/reprocessableDeviceRules`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the rules module**

```js
// apps/backend/src/services/clinical/reprocessableDeviceRules.js
//
// Pure rules for the department-agnostic reprocessable-device platform
// (dialysis, OT). No prisma, no clock beyond what a caller passes, so unit
// tests import this without a database. reprocessableDeviceService.js
// re-exports everything here and adds persistence.
//
// Spec: docs/superpowers/specs/2026-09-05-reprocessable-devices-platform-design.md
// (§2 decisions, §3.4 isolation rule, §5.3 shared disposition rule).
//
// The state machine, the discard vocabulary and the disposition tree are
// cathDeviceReuseService's (765) with three deliberate differences, each
// pinned by a unit test: a `quarantine` reactive-patient rule, an OPTIONAL
// cycle ceiling, and a fixed units_max of 1. A parity test proves that with
// no quarantine rule in play this tree answers exactly what cath's does.

import { AppError } from '../../utils/AppError.js';

export const DOMAINS = Object.freeze(['dialysis', 'ot']);
export const CATEGORIES_BY_DOMAIN = Object.freeze({
  dialysis: Object.freeze(['dialyser', 'bloodline', 'other']),
  ot: Object.freeze(['instrument_set', 'tray', 'implant_set', 'procedure_pack', 'other']),
});
export const DEVICE_STATUSES = Object.freeze(['awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded']);
export const CYCLE_TYPES = Object.freeze(['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other']);
export const DIALYSIS_CYCLE_TYPES = Object.freeze(['chemical', 'other']);
export const FUNCTION_CHECK_RESULTS = Object.freeze(['not_required', 'pass', 'fail']);
export const DISCARD_REASONS = Object.freeze([
  'max_cycles_reached', 'bloodborne_exposure', 'late_reactive_marker', 'function_check_failed',
  'sterilization_failed', 'damaged', 'wasted', 'policy_change', 'other',
  'tcv_below_threshold', 'integrity_test_failed', 'set_retired',
]);
export const POST_USE_DISPOSITIONS = Object.freeze([
  'sent_for_reprocessing', 'quarantined_bloodborne_exposure', 'discarded_bloodborne_exposure',
  'discarded_max_cycles', 'discarded_integrity_failed', 'discarded_tcv_below_threshold', 'discarded_other',
  // The case was cancelled before use: the usage is closed and the device
  // released without a cycle (uncapture). Never chosen by an operator.
  'cancelled_before_use',
]);
export const REACTIVE_PATIENT_RULES = Object.freeze(['discard', 'quarantine', 'override_allowed']);
export const UNKNOWN_SEROLOGY_RULES = Object.freeze(['warn', 'block_return']);
export const ISOLATION_ENFORCEMENT = Object.freeze(['warn', 'block']);
// D11 = NO: these are the MARKER CLASSES the Phase 1 Decision speaks and the
// keys of the tenant's isolation_groups map. 'general' is gone with the machine
// column it labelled - a general machine is one with isolation_group IS NULL.
export const ISOLATION_CLASSES = Object.freeze(['hbsag', 'hcv', 'hiv', 'isolation_mixed']);
// The dialysis_machines.isolation_group column width; the settings validator
// refuses a longer label rather than letting the INSERT truncate or fail.
export const ISOLATION_GROUP_MAX_LEN = 40;
export const ENROLLED_VIA = Object.freeze(['session_capture', 'set_issue', 'console']);
export const CAPTURE_SOURCES = Object.freeze(['staff_app', 'admin_console', 'cssd_issue', 'system']);
export const REPROCESSING_AGENTS = Object.freeze(['peracetic_acid', 'formaldehyde', 'glutaraldehyde', 'renalin', 'other']);
export const DEFAULT_TCV_MIN_PCT = 80;
// RD + at least 8 digits: reprocessable_devices.device_tag is generated as
// 'RD' || lpad(id, GREATEST(8, length(id)), '0'); open to 19 (bigint max).
export const DEVICE_TAG_PATTERN = /^RD[0-9]{8,19}$/;

export const DEVICE_ACTIONS = Object.freeze({
  receive: Object.freeze({ from: Object.freeze(['awaiting_reprocessing']), to: 'in_cssd' }),
  reprocessed: Object.freeze({ from: Object.freeze(['awaiting_reprocessing', 'in_cssd']), to: 'available' }),
  quarantine: Object.freeze({ from: Object.freeze(['awaiting_reprocessing', 'in_cssd', 'available']), to: 'quarantined' }),
  release: Object.freeze({ from: Object.freeze(['quarantined']), to: 'awaiting_reprocessing' }),
  discard: Object.freeze({ from: Object.freeze(['awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined']), to: 'discarded' }),
  capture: Object.freeze({ from: Object.freeze(['available']), to: 'in_case' }),
  return: Object.freeze({ from: Object.freeze(['in_case']), to: 'awaiting_reprocessing' }),
  // 767 only: the case was cancelled BEFORE use, so the device goes straight
  // back to available - no cycle, no reprocessing record (spec §5.1 Cancel,
  // §5.2). Two actions now land on 'available'; applyDeviceTransitionTx keys
  // the cycle increment on the ACTION 'reprocessed', never on the state.
  uncapture: Object.freeze({ from: Object.freeze(['in_case']), to: 'available' }),
});

export function requireDomain(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!DOMAINS.includes(text)) throw AppError.badRequest(`domain must be one of ${DOMAINS.join(', ')}`, 'RPD_DOMAIN_INVALID');
  return text;
}

export function deviceTransition(status, action) {
  const rule = DEVICE_ACTIONS[action];
  if (!rule) return { ok: false, to: null, allowedFrom: [] };
  return { ok: rule.from.includes(status), to: rule.to, allowedFrom: rule.from };
}

export function normalizeDeviceTag(value) {
  const tag = String(value ?? '').trim().toUpperCase();
  if (!DEVICE_TAG_PATTERN.test(tag)) throw AppError.badRequest('device tag must look like RD00000042', 'RPD_TAG_INVALID');
  return tag;
}

// The honest default differs per domain, which is why the settings table has
// no column default on reactive_patient_rule: a dialyser is a consumable and is
// retired after a reactive patient; an instrument set is held for infection
// control. Read paths return these when no row exists.
const SETTINGS_DEFAULTS = Object.freeze({
  dialysis: Object.freeze({ reactive_patient_rule: 'discard', unknown_serology_rule: 'warn', serology_validity_days: 90, isolation_enforcement: 'warn' }),
  ot: Object.freeze({ reactive_patient_rule: 'quarantine', unknown_serology_rule: 'warn', serology_validity_days: 90, isolation_enforcement: 'warn' }),
});

export function settingsDefaultsFor(domain) {
  return { ...SETTINGS_DEFAULTS[requireDomain(domain)] };
}

function oneOf(value, allowed, label, code) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(text)) throw AppError.badRequest(`${label} must be one of ${allowed.join(', ')}`, code);
  return text;
}

function boundedInt(value, label, min, max, code) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) throw AppError.badRequest(`${label} must be an integer between ${min} and ${max}`, code);
  const n = Number(text);
  if (n < min || n > max) throw AppError.badRequest(`${label} must be an integer between ${min} and ${max}`, code);
  return n;
}

// One policy entry for one domain, normalised for the upsert. Everything the
// table's CHECKs would refuse with a 23514 is refused here with a 400 that
// names the field.
export function validatePolicyInput(domain, entry = {}) {
  const dom = requireDomain(domain);
  const category = oneOf(entry.category, CATEGORIES_BY_DOMAIN[dom], 'category', 'RPD_POLICY_INVALID');
  const reprocessable = entry.reprocessable === true || entry.reprocessable === 'true';
  const allowedTypes = dom === 'dialysis' ? DIALYSIS_CYCLE_TYPES : CYCLE_TYPES;
  const cycleTypes = Array.isArray(entry.allowed_cycle_types)
    ? [...new Set(entry.allowed_cycle_types.map((t) => {
      const type = oneOf(t, CYCLE_TYPES, 'allowed_cycle_types', 'RPD_CYCLE_TYPE_INVALID');
      if (!allowedTypes.includes(type)) throw AppError.conflict(`${type} is not a permitted cycle type for ${dom}`, 'RPD_CYCLE_TYPE_NOT_ALLOWED', { allowed: [...allowedTypes] });
      return type;
    }))]
    : [];
  if (reprocessable && cycleTypes.length === 0) throw AppError.badRequest('a reprocessable category needs at least one allowed cycle type', 'RPD_POLICY_INVALID');
  const maxCycles = boundedInt(entry.max_cycles, 'max_cycles', 1, 100, 'RPD_POLICY_INVALID');
  const functionCheck = entry.function_check_required === true || entry.function_check_required === 'true';
  if (dom === 'ot' && functionCheck) throw AppError.badRequest('OT policies carry no per-set function check; the load release is the check', 'RPD_POLICY_INVALID');
  let tcvMinPct = boundedInt(entry.tcv_min_pct, 'tcv_min_pct', 50, 100, 'RPD_POLICY_INVALID');
  if (dom !== 'dialysis' && tcvMinPct !== null) throw AppError.badRequest('tcv_min_pct applies to dialysis only', 'RPD_POLICY_INVALID');
  if (dom === 'dialysis' && category === 'dialyser' && reprocessable && tcvMinPct === null) tcvMinPct = DEFAULT_TCV_MIN_PCT;
  return { domain: dom, category, reprocessable, max_cycles: maxCycles, allowed_cycle_types: cycleTypes, function_check_required: functionCheck, tcv_min_pct: tcvMinPct };
}

// 765's computePostUseOptions, generalised. Order (as built in 765): the
// device's own flag, then the ceiling, then the patient's screen. The order
// cannot change what an operator may do - every branch that fires here settles
// on discard/quarantine only - but it decides which reason the device is
// retired under, and that reason is what an infection-control lookback reads.
export function computeDispositionOptions({ domain, usage, policy, settings, restriction, device = null }) {
  requireDomain(domain);
  const base = { dispositions: [], requires_acknowledgement: false, exposure: false, discard_reason: null, quarantine_reason: null, blocked_code: null, reason_codes: [], units_max: 1 };
  if (usage?.post_use_disposition) return { ...base, reason_codes: ['already_recorded'] };
  if (!policy || policy.reprocessable !== true) return { ...base, reason_codes: ['not_reprocessable'] };
  const rule = settings?.reactive_patient_rule;
  if (device?.exposure_flag === true && rule === 'discard') {
    return { ...base, dispositions: ['discard'], discard_reason: 'bloodborne_exposure', reason_codes: ['device_exposure_flagged'] };
  }
  if (device?.exposure_flag === true && rule === 'quarantine') {
    return { ...base, dispositions: ['quarantine', 'discard'], quarantine_reason: 'bloodborne_exposure', reason_codes: ['device_exposure_flagged'] };
  }
  const ceiling = device?.max_cycles_snapshot == null ? null : Number(device.max_cycles_snapshot);
  if (device && ceiling !== null && Number(device.cycle_count) >= ceiling) {
    return { ...base, dispositions: ['discard'], discard_reason: 'max_cycles_reached', reason_codes: ['max_cycles_reached'] };
  }
  const status = restriction?.status === 'clear' || restriction?.status === 'restricted' ? restriction.status : 'unknown';
  if (status === 'restricted') {
    if (rule === 'override_allowed') return { ...base, dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, exposure: true, reason_codes: ['bloodborne_restricted_override'] };
    if (rule === 'quarantine') return { ...base, dispositions: ['quarantine', 'discard'], quarantine_reason: 'bloodborne_exposure', reason_codes: ['bloodborne_restricted_quarantine'] };
    return { ...base, dispositions: ['discard'], discard_reason: 'bloodborne_exposure', reason_codes: ['bloodborne_restricted'] };
  }
  if (status === 'unknown') {
    if (settings?.unknown_serology_rule === 'block_return') return { ...base, dispositions: ['discard'], blocked_code: 'RPD_SEROLOGY_REQUIRED', reason_codes: ['serology_required'] };
    return { ...base, dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, reason_codes: ['serology_unknown'] };
  }
  return { ...base, dispositions: ['reprocess', 'discard'] };
}

// The Phase 1 Decision (spec §3.3): status is the one field; isolation_class is
// the routing instruction Phase 1 computes (one core marker -> its class, two
// or more -> isolation_mixed). This module never derives a class from markers.
export const DECISION_STATUSES = Object.freeze(['restricted', 'unknown', 'clear']);

// D11 = NO (spec §2, §3.3): a dialysis device is stamped with the exposure FLAG
// and nothing else. There is deliberately no class -> marker map here any more -
// this helper reads `status` and could not name a marker if it wanted to, which
// is the point: the CSSD queue acts on the flag under universal precautions and
// never learns what isolated the patient. (The OT arm is unchanged and still
// derives its markers from resolveReuseStatus - see returnDeviceTx, Task 3.)
export function dialysisExposureStamp(decision) {
  return { exposure_flag: decision?.status === 'restricted', exposure_markers: [] };
}

// §3.4 over a live Decision. A clear patient on an unregistered machine produces
// NOTHING: otherwise every session warns on day one and a warning nobody reads
// is not a warning. An UNKNOWN patient produces nothing either, and is never
// blocked (spec §3.3: zero markers exist cluster-wide; unknown-isolates would
// isolate every patient on day one; the amber state is Phase 1's roster chip).
// D11 = NO: `isolationGroups` is the tenant's class -> group map, supplied by the
// caller from reprocessing_domain_settings. The marker class is an INTERNAL
// INTERMEDIATE - the local `cls` below - used only to index that map. It is not a
// key of the return value, and there is no other way to build the verdict, so a
// future caller cannot leak it by forgetting something.
export function computeIsolationWarnings({ decision, machine, isolationGroups = {}, enforcement = 'warn' }) {
  const codes = [];
  const status = DECISION_STATUSES.includes(decision?.status) ? decision.status : 'unknown';
  // A restricted Decision always carries a class by Phase 1's rule; if one ever
  // arrives without, the safe reading is "needs the most restrictive machine".
  const cls = status === 'restricted' ? (decision.isolation_class || 'isolation_mixed') : null;
  const requiredGroup = cls ? (isolationGroups?.[cls] ?? null) : null;
  const group = machine ? (machine.isolation_group ?? null) : null;
  let blocked = false;
  if (status === 'restricted') {
    if (!machine) {
      codes.push('DIALYSIS_MACHINE_UNREGISTERED');
    } else if (group === null || (requiredGroup !== null && group !== requiredGroup)) {
      // A general machine (isolation_group IS NULL) never satisfies a restricted
      // patient. When the tenant has NOT mapped this class (requiredGroup null -
      // the day-one state) any non-null group satisfies: the patient is at least
      // in an isolation bay, and the platform must not invent a label.
      codes.push('DIALYSIS_ISOLATION_MACHINE_MISMATCH');
      blocked = enforcement === 'block';
    }
  } else if (status === 'clear' && machine && group !== null) {
    codes.push('DIALYSIS_GENERAL_PATIENT_ON_ISOLATION_MACHINE');
  }
  return { codes, required_group: requiredGroup, blocked };
}

// The dialyser discard rule: measured TCV must be at least minPct of the
// baseline. When either number is missing the rule cannot fire (pct null).
export function tcvVerdict({ baseline, measured, minPct = DEFAULT_TCV_MIN_PCT }) {
  const b = baseline == null ? null : Number(baseline);
  const m = measured == null ? null : Number(measured);
  if (!Number.isFinite(b) || b <= 0 || !Number.isFinite(m) || m <= 0) return { ok: true, pct: null };
  const pct = Math.round((m / b) * 1000) / 10;
  return { ok: pct >= Number(minPct), pct };
}

export default {
  DOMAINS, CATEGORIES_BY_DOMAIN, DEVICE_STATUSES, CYCLE_TYPES, DIALYSIS_CYCLE_TYPES, FUNCTION_CHECK_RESULTS,
  DISCARD_REASONS, POST_USE_DISPOSITIONS, REACTIVE_PATIENT_RULES, UNKNOWN_SEROLOGY_RULES, ISOLATION_ENFORCEMENT,
  ISOLATION_CLASSES, ISOLATION_GROUP_MAX_LEN, ENROLLED_VIA, CAPTURE_SOURCES, REPROCESSING_AGENTS, DEFAULT_TCV_MIN_PCT, DEVICE_TAG_PATTERN,
  DEVICE_ACTIONS, DECISION_STATUSES, requireDomain, deviceTransition, normalizeDeviceTag, settingsDefaultsFor, validatePolicyInput,
  computeDispositionOptions, computeIsolationWarnings, dialysisExposureStamp, tcvVerdict,
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- --testPathPatterns unit/reprocessableDeviceRules`
Expected: PASS, 51 tests (1 domains + 9 allowed + 7 refused + 1 uncapture shape + 6 tag + 2 defaults + 12 disposition + 9 isolation + 1 tcv + 1 policy + 2 exposure-stamp). If the parity test fails on `reason_codes` for the max-cycles device under `override_allowed`, read both functions side by side — the order is flag, ceiling, screen in both, and the fix is in the new module, never in cath's.

- [ ] **Step 5: Mutation checks** — swap the flag and ceiling branches in `computeDispositionOptions`, run, confirm the "device flag is checked BEFORE the ceiling" test and the parity test go red; restore. Add `else if (status === 'unknown') codes.push('DIALYSIS_SEROLOGY_UNKNOWN');` to `computeIsolationWarnings`, run, confirm the "UNKNOWN never isolates" test goes red; restore. Then add `required_class: cls` to `computeIsolationWarnings`' return object, run, and confirm the "required_group is the tenant label, never the class" test goes red on the `JSON.stringify` assertion; restore. Then make `dialysisExposureStamp` return `[decision.isolation_class]` when the class is a marker, run, and confirm both exposure-stamp tests go red; restore. These two are the D11 = NO guards inside the pure module, upstream of the canary.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/services/clinical/reprocessableDeviceRules.js apps/backend/src/tests/unit/reprocessableDeviceRules.test.js
git commit -m "feat(reprocessing): pure rules for the reprocessable devices platform

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: `reprocessableDeviceService.js` — settings, policies, register, transitions, history, label, exposure handler

**Files:**
- Create: `apps/backend/src/services/clinical/reprocessableDeviceService.js`
- Create: `apps/backend/src/services/clinical/reprocessableDeviceProjection.js`, `apps/backend/src/tests/unit/reprocessableDeviceProjection.test.js`

The deep coverage for this module lands with the two domain suites (Tasks 4 and 5), which exercise every function below through real flows; this task ships the module and the pure projection test.

- [ ] **Step 1: Write the service**

```js
// apps/backend/src/services/clinical/reprocessableDeviceService.js
//
// The department-agnostic reprocessable-device register (dialysis, OT):
// per-domain settings and category policies, the register, 765's state
// machine, the CSSD queue actions, the capture/return transaction helpers the
// two domain services call, the device history with its per-patient PHI trail,
// the label, and the platform exposure handler.
//
// Spec: docs/superpowers/specs/2026-09-05-reprocessable-devices-platform-design.md
//
// Boundaries: dialysisReuseService.js and cssd/cssdReuseHooks.js call
// captureDeviceTx / returnDeviceTx / applyDeviceTransitionTx inside THEIR
// transactions; nothing here knows a session or an OT schedule by name beyond
// the usage row's owner pair. The register carries no patient identity - the
// usage rows and the dialysis link row do - so the CSSD routes read it without
// a PHI logger.

import { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { code39Svg } from '../../utils/barcode/code39.js';
import { logPhiAccess, logPhiAccessBatch } from '../../utils/hipaaAudit.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { persistCdsAlert } from '../emr/cdsEngine.js';
import { requireTenantId } from '../tenant/tenantService.js';
// D11 = NO: the one list that may write the class -> group mapping. Imported
// from the route policy, never re-declared here (spec §4.1).
import { ISOLATION_GROUP_ADMIN_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { MARKERS, registerExposureHandler, resolveReuseStatus } from './bloodborneMarkerService.js';
import { recordMedicationSafetyReviews } from './canonicalClinicalPlatformService.js';
import {
  CAPTURE_SOURCES, CATEGORIES_BY_DOMAIN, CYCLE_TYPES, DEVICE_STATUSES, DIALYSIS_CYCLE_TYPES, DISCARD_REASONS, ENROLLED_VIA,
  FUNCTION_CHECK_RESULTS, ISOLATION_CLASSES, ISOLATION_ENFORCEMENT, ISOLATION_GROUP_MAX_LEN, REACTIVE_PATIENT_RULES, UNKNOWN_SEROLOGY_RULES,
  deviceTransition, normalizeDeviceTag, requireDomain, settingsDefaultsFor, validatePolicyInput,
} from './reprocessableDeviceRules.js';

export * from './reprocessableDeviceRules.js';

// ---------------------------------------------------------------------------
// Input helpers (local copies: cathDeviceReuseService exports none of these)
// ---------------------------------------------------------------------------
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function cleanText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}
export function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_PATTERN.test(text)) throw AppError.badRequest(`${label} must be a UUID`, 'RPD_BAD_UUID');
  return text.toLowerCase();
}
// Decimal digits only (765's lesson: Number() accepts '7e2', '0x10', '+7').
export function positiveInt(value, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) throw AppError.badRequest(`${label} must be a positive integer`, 'RPD_BAD_ID');
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) throw AppError.badRequest(`${label} must be a positive integer`, 'RPD_BAD_ID');
  return n;
}
// 0..max, same digit discipline. For counts that may legitimately be zero
// (initial_cycle_count, disinfectant_contact_minutes). The earlier
// `positiveInt(x || 1) - (x ? 0 : 1)` trick mis-handled the string '0' (truthy,
// so it reached positiveInt and threw); this does not.
export function nonNegativeInt(value, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) throw AppError.badRequest(`${label} must be an integer from 0 to ${max}`, 'RPD_BAD_ID');
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n > max) throw AppError.badRequest(`${label} must be an integer from 0 to ${max}`, 'RPD_BAD_ID');
  return n;
}
export function oneOf(value, allowed, label, code = 'RPD_BAD_ENUM') {
  const text = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(text)) throw AppError.badRequest(`${label} must be one of ${allowed.join(', ')}`, code);
  return text;
}
export function num(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  return value;
}
const tenantOr = (value) => requireTenantId(value);
function withTenant(tenantId, db, fn) { return db ? fn(db) : setTenant(tenantId, fn); }

async function recordAudit(tx, { tenantId, action, resource, resourceId, context = {}, metadata = {} }) {
  // audit_logs (plural): uid + actor_uid + role; the append-only trigger
  // rejects later edits, so write it once, correctly. role is VARCHAR(50).
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`,
    tenantId, context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null, cleanText(context.actorRole, 50),
    action, resource, String(resourceId), JSON.stringify(metadata),
  );
}

// ---------------------------------------------------------------------------
// Settings (tenant x domain)
// ---------------------------------------------------------------------------
const SETTINGS_SELECT = `tenant_id, domain, reactive_patient_rule, unknown_serology_rule, serology_validity_days, isolation_enforcement, isolation_groups, reviewed_by, reviewed_at, updated_by, created_at, updated_at`;
// D11 = NO (spec §4.1): the class -> group map may be WRITTEN only by infection
// control / admin. The list is `ISOLATION_GROUP_ADMIN_ROUTE_ROLES` from
// config/routeRolePolicy.js (an intersection with the governance mount audience,
// so the gate can never be dead); QUALITY_OFFICER reads the settings and cannot
// change the map, and DIALYSIS_TECHNICIAN never reaches the mount at all.
// Imported, never re-declared: two lists would drift.

export async function getDomainSettings({ tenantId, domain, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const dom = requireDomain(domain);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(
    `SELECT ${SETTINGS_SELECT} FROM reprocessing_domain_settings WHERE tenant_id = $1::uuid AND domain = $2`, tid, dom,
  ));
  if (rows[0]) return { ...rows[0], serology_validity_days: num(rows[0].serology_validity_days), isolation_groups: rows[0].isolation_groups || {}, configured: true };
  // No row: an EMPTY map, never an invented one. computeIsolationWarnings reads
  // that as "any isolation machine satisfies a restricted patient" (spec §3.4).
  return { tenant_id: tid, domain: dom, ...settingsDefaultsFor(dom), isolation_groups: {}, reviewed_by: null, reviewed_at: null, updated_by: null, created_at: null, updated_at: null, configured: false };
}

export async function upsertDomainSettings({ tenantId, domain, ...input } = {}, context = {}) {
  const tid = tenantOr(tenantId);
  const dom = requireDomain(domain);
  const actor = requireUuid(context.actorUid, 'actorUid');
  const current = await getDomainSettings({ tenantId: tid, domain: dom });
  const reactive = oneOf(input.reactive_patient_rule ?? current.reactive_patient_rule, REACTIVE_PATIENT_RULES, 'reactive_patient_rule');
  const unknownRule = oneOf(input.unknown_serology_rule ?? current.unknown_serology_rule, UNKNOWN_SEROLOGY_RULES, 'unknown_serology_rule');
  const days = positiveInt(input.serology_validity_days ?? current.serology_validity_days, 'serology_validity_days', { max: 365 });
  const enforcement = oneOf(input.isolation_enforcement ?? current.isolation_enforcement, ISOLATION_ENFORCEMENT, 'isolation_enforcement');
  if (dom !== 'dialysis' && enforcement !== 'warn') throw AppError.badRequest('isolation_enforcement applies to dialysis only', 'RPD_POLICY_INVALID');
  // ---- D11 = NO: the class -> group map (spec §4.1) ----------------------
  // Role gate FIRST, so a role that may not write it cannot learn from a
  // validation error whether its value would have been accepted.
  const wantsGroups = Object.prototype.hasOwnProperty.call(input, 'isolation_groups');
  if (wantsGroups && !ISOLATION_GROUP_ADMIN_ROUTE_ROLES.includes(String(context.actorRole || '').toUpperCase())) {
    throw AppError.forbidden('isolation_groups may be changed only by infection control or an administrator', 'RPD_ISOLATION_GROUPS_FORBIDDEN');
  }
  let groups = current.isolation_groups || {};
  if (wantsGroups) {
    const raw = input.isolation_groups;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw AppError.badRequest('isolation_groups must be an object', 'RPD_ISOLATION_GROUPS_INVALID');
    if (dom !== 'dialysis' && Object.keys(raw).length) throw AppError.badRequest('isolation_groups applies to dialysis only', 'RPD_ISOLATION_GROUPS_INVALID');
    groups = {};
    for (const [cls, label] of Object.entries(raw)) {
      if (!ISOLATION_CLASSES.includes(cls)) throw AppError.badRequest(`isolation_groups key ${cls} is not a marker class`, 'RPD_ISOLATION_GROUPS_INVALID');
      if (label === null || label === '') continue;                       // an unmapped class is an ABSENT key, not a null value
      const text = cleanText(label, ISOLATION_GROUP_MAX_LEN);
      if (!text) throw AppError.badRequest(`isolation_groups.${cls} must be a non-empty label of at most ${ISOLATION_GROUP_MAX_LEN} characters`, 'RPD_ISOLATION_GROUPS_INVALID');
      groups[cls] = text;
    }
  }
  // ADVISORY, never a refusal (spec §4.1): a unit may map its bays before it
  // tags the machines. The warning is returned beside the saved row.
  const warnings = [];
  if (wantsGroups && Object.keys(groups).length) {
    const named = [...new Set(Object.values(groups))];
    const present = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT DISTINCT isolation_group FROM dialysis_machines WHERE tenant_id = $1::uuid AND status <> 'retired' AND isolation_group = ANY($2::text[])`, tid, named,
    ));
    const have = new Set(present.map((r) => r.isolation_group));
    for (const label of named) if (!have.has(label)) warnings.push(`isolation_group "${label}" is on no registered machine`);
  }
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO reprocessing_domain_settings
         (tenant_id, domain, reactive_patient_rule, unknown_serology_rule, serology_validity_days, isolation_enforcement, isolation_groups, reviewed_by, reviewed_at, updated_by)
       VALUES ($1::uuid, $2, $3, $4, $5::int, $6, $7::jsonb, $8::uuid, NOW(), $8::uuid)
       ON CONFLICT (tenant_id, domain) DO UPDATE SET
         reactive_patient_rule = EXCLUDED.reactive_patient_rule,
         unknown_serology_rule = EXCLUDED.unknown_serology_rule,
         serology_validity_days = EXCLUDED.serology_validity_days,
         isolation_enforcement = EXCLUDED.isolation_enforcement,
         isolation_groups = EXCLUDED.isolation_groups,
         reviewed_by = EXCLUDED.reviewed_by, reviewed_at = NOW(), updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING ${SETTINGS_SELECT}`,
      tid, dom, reactive, unknownRule, days, enforcement, JSON.stringify(groups), actor,
    );
    // The audit names the GROUPS, which are equipment labels; it never names a
    // marker class as a patient fact (the map's KEYS are the vocabulary, not a
    // patient's status) - spec §7.2, D11 = NO.
    await recordAudit(tx, { tenantId: tid, action: 'rpd.settings.updated', resource: 'reprocessing_domain_settings', resourceId: `${tid}:${dom}`, context, metadata: { domain: dom, reactive_patient_rule: reactive, unknown_serology_rule: unknownRule, serology_validity_days: days, isolation_enforcement: enforcement, isolation_groups: groups, idempotency_key: context.idempotencyKey ?? null } });
    return { ...rows[0], serology_validity_days: num(rows[0].serology_validity_days), isolation_groups: rows[0].isolation_groups || {}, warnings, configured: true };
  });
}

// ---------------------------------------------------------------------------
// Category policies (tenant x domain x category); dark by default
// ---------------------------------------------------------------------------
const POLICY_SELECT = `tenant_id, domain, category, reprocessable, max_cycles, allowed_cycle_types, function_check_required, tcv_min_pct, updated_by, created_at, updated_at`;
const normalizePolicy = (row) => ({ ...row, max_cycles: row.max_cycles == null ? null : num(row.max_cycles), tcv_min_pct: row.tcv_min_pct == null ? null : num(row.tcv_min_pct), allowed_cycle_types: Array.isArray(row.allowed_cycle_types) ? row.allowed_cycle_types : [] });
const defaultPolicy = (tenantId, domain, category) => ({ tenant_id: tenantId, domain, category, reprocessable: false, max_cycles: null, allowed_cycle_types: [], function_check_required: false, tcv_min_pct: null, updated_by: null, created_at: null, updated_at: null });

export async function listDomainPolicies({ tenantId, domain, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const dom = requireDomain(domain);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(
    `SELECT ${POLICY_SELECT} FROM reprocessing_domain_policies WHERE tenant_id = $1::uuid AND domain = $2`, tid, dom,
  ));
  const byCategory = new Map(rows.map((row) => [row.category, normalizePolicy(row)]));
  return CATEGORIES_BY_DOMAIN[dom].map((category) => byCategory.get(category) || defaultPolicy(tid, dom, category));
}

export async function categoryPolicyTx(tx, tenantId, domain, category) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${POLICY_SELECT} FROM reprocessing_domain_policies WHERE tenant_id = $1::uuid AND domain = $2 AND category = $3`, tenantId, domain, category,
  );
  return rows[0] ? normalizePolicy(rows[0]) : null;
}

export async function upsertDomainPolicies({ tenantId, domain, policies = [] } = {}, context = {}) {
  const tid = tenantOr(tenantId);
  const dom = requireDomain(domain);
  const actor = requireUuid(context.actorUid, 'actorUid');
  if (!Array.isArray(policies) || policies.length === 0 || policies.length > CATEGORIES_BY_DOMAIN[dom].length) {
    throw AppError.badRequest(`policies must list 1..${CATEGORIES_BY_DOMAIN[dom].length} categories`, 'RPD_POLICY_INVALID');
  }
  const entries = policies.map((entry) => validatePolicyInput(dom, entry));
  if (new Set(entries.map((e) => e.category)).size !== entries.length) throw AppError.badRequest('a category may appear at most once', 'RPD_POLICY_DUPLICATE');
  return setTenantTx(tid, async (tx) => {
    for (const entry of entries) {
      await tx.$executeRawUnsafe(
        `INSERT INTO reprocessing_domain_policies
           (tenant_id, domain, category, reprocessable, max_cycles, allowed_cycle_types, function_check_required, tcv_min_pct, updated_by)
         VALUES ($1::uuid, $2, $3, $4::boolean, $5::int, $6::text[], $7::boolean, $8::int, $9::uuid)
         ON CONFLICT (tenant_id, domain, category) DO UPDATE SET
           reprocessable = EXCLUDED.reprocessable, max_cycles = EXCLUDED.max_cycles,
           allowed_cycle_types = EXCLUDED.allowed_cycle_types, function_check_required = EXCLUDED.function_check_required,
           tcv_min_pct = EXCLUDED.tcv_min_pct, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        tid, dom, entry.category, entry.reprocessable, entry.max_cycles, entry.allowed_cycle_types, entry.function_check_required, entry.tcv_min_pct, actor,
      );
    }
    await recordAudit(tx, { tenantId: tid, action: 'rpd.policy.updated', resource: 'reprocessing_domain_policies', resourceId: `${tid}:${dom}`, context, metadata: { domain: dom, categories: entries.map((e) => e.category), idempotency_key: context.idempotencyKey ?? null } });
    return listDomainPolicies({ tenantId: tid, domain: dom, db: tx });
  });
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------
const DEVICE_SELECT = `d.id, d.tenant_id, d.domain, d.category, d.facility_id, d.device_tag, d.manufacturer_serial, d.hospital_asset_id,
  d.manufacturer, d.model_name, d.instrument_set_id, d.enrolled_via, d.cycle_count, d.max_cycles_snapshot, d.status, d.current_usage_id,
  d.exposure_flag, d.exposure_markers, d.last_reprocessed_at, d.last_reprocessed_by, d.last_cycle_type, d.last_function_check,
  d.last_sterilization_load_id, d.quarantine_reason, d.quarantined_at, d.discard_reason, d.discard_note, d.discarded_at, d.discarded_by,
  d.created_by, d.created_at, d.updated_at, d.metadata,
  s.set_code, s.display_name AS set_display_name, s.status AS set_status`;
const DEVICE_FROM = `FROM reprocessable_devices d LEFT JOIN instrument_sets s ON s.id = d.instrument_set_id AND s.tenant_id = d.tenant_id`;

export function normalizeDevice(row) {
  if (!row) return null;
  return {
    ...row,
    id: num(row.id), facility_id: row.facility_id == null ? null : num(row.facility_id), instrument_set_id: row.instrument_set_id == null ? null : num(row.instrument_set_id),
    cycle_count: num(row.cycle_count), max_cycles_snapshot: row.max_cycles_snapshot == null ? null : num(row.max_cycles_snapshot),
    current_usage_id: row.current_usage_id == null ? null : num(row.current_usage_id), last_sterilization_load_id: row.last_sterilization_load_id == null ? null : num(row.last_sterilization_load_id),
    exposure_markers: Array.isArray(row.exposure_markers) ? row.exposure_markers : [],
    item_name: row.model_name || row.set_display_name || row.set_code || row.manufacturer_serial || row.hospital_asset_id || null,
  };
}

export async function listDevices({ tenantId, domain = null, status = null, facilityId = null, limit = 100, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const conds = ['d.tenant_id = $1::uuid'];
  const args = [tid];
  if (domain) { args.push(requireDomain(domain)); conds.push(`d.domain = $${args.length}`); }
  if (status) { args.push(oneOf(status, [...DEVICE_STATUSES], 'status')); conds.push(`d.status = $${args.length}`); }
  if (facilityId) { args.push(positiveInt(facilityId, 'facility_id')); conds.push(`d.facility_id = $${args.length}::int`); }
  const lim = Math.min(positiveInt(limit ?? 100, 'limit', { max: 500 }), 500);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(
    `SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE ${conds.join(' AND ')} ORDER BY d.updated_at DESC, d.id DESC LIMIT ${lim}`, ...args,
  ));
  return rows.map(normalizeDevice);
}

export async function lockDeviceTx(tx, tenantId, deviceId) {
  const rows = await tx.$queryRawUnsafe(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint FOR UPDATE OF d`, tenantId, positiveInt(deviceId, 'device_id'));
  if (!rows[0]) throw AppError.notFound('Reprocessable device not found', 'RPD_DEVICE_NOT_FOUND');
  return normalizeDevice(rows[0]);
}
export async function lockDeviceByTagTx(tx, tenantId, tag) {
  const rows = await tx.$queryRawUnsafe(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.device_tag = $2 FOR UPDATE OF d`, tenantId, normalizeDeviceTag(tag));
  if (!rows[0]) throw AppError.notFound('Reprocessable device not found', 'RPD_DEVICE_NOT_FOUND');
  return normalizeDevice(rows[0]);
}
export async function lockDeviceBySerialTx(tx, tenantId, domain, serial) {
  const rows = await tx.$queryRawUnsafe(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.domain = $2 AND d.manufacturer_serial = $3 FOR UPDATE OF d`, tenantId, requireDomain(domain), cleanText(serial, 120));
  return rows[0] ? normalizeDevice(rows[0]) : null;
}
export async function lockDeviceBySetTx(tx, tenantId, instrumentSetId) {
  const rows = await tx.$queryRawUnsafe(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.instrument_set_id = $2::bigint FOR UPDATE OF d`, tenantId, positiveInt(instrumentSetId, 'instrument_set_id'));
  return rows[0] ? normalizeDevice(rows[0]) : null;
}
export async function deviceById({ tenantId, deviceId, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint`, tid, positiveInt(deviceId, 'device_id')));
  return normalizeDevice(rows[0] || null);
}

// Mint a register row. Status defaults to 'available': a dialyser is new from
// the manufacturer, a set is enrolled from a sterile state at issue.
export async function mintDeviceTx(tx, { tenantId, domain, category, enrolledVia, manufacturerSerial = null, hospitalAssetId = null, manufacturer = null, modelName = null, instrumentSetId = null, facilityId = null, initialCycleCount = 0, maxCycles = null, metadata = {}, context = {} }) {
  const tid = tenantOr(tenantId);
  const dom = requireDomain(domain);
  const cat = oneOf(category, CATEGORIES_BY_DOMAIN[dom], 'category');
  const via = oneOf(enrolledVia, ENROLLED_VIA, 'enrolled_via');
  const actor = requireUuid(context.actorUid, 'actorUid');
  const cycles = initialCycleCount == null || initialCycleCount === '' ? 0 : nonNegativeInt(initialCycleCount, 'initial_cycle_count', { max: 100 });
  if (maxCycles != null && cycles > Number(maxCycles)) throw AppError.conflict('initial cycle count exceeds the policy ceiling', 'RPD_MAX_CYCLES_REACHED');
  let rows;
  try {
    rows = await tx.$queryRawUnsafe(
      `INSERT INTO reprocessable_devices
         (tenant_id, domain, category, facility_id, manufacturer_serial, hospital_asset_id, manufacturer, model_name, instrument_set_id,
          enrolled_via, cycle_count, max_cycles_snapshot, status, created_by, metadata)
       VALUES ($1::uuid, $2, $3, $4::int, $5, $6, $7, $8, $9::bigint, $10, $11::int, $12::int, 'available', $13::uuid, $14::jsonb)
       RETURNING id`,
      tid, dom, cat, facilityId == null ? null : positiveInt(facilityId, 'facility_id'), cleanText(manufacturerSerial, 120), cleanText(hospitalAssetId, 120),
      cleanText(manufacturer, 120), cleanText(modelName, 120), instrumentSetId == null ? null : positiveInt(instrumentSetId, 'instrument_set_id'),
      via, cycles, maxCycles == null ? null : Number(maxCycles), actor, JSON.stringify({ ...metadata, ...(cycles > 0 ? { enrolled_mid_life: true } : {}) }),
    );
  } catch (err) {
    if (err?.code === 'P2010' && /ux_reprocessable_devices_(serial|asset|set)/.test(err?.message || '')) {
      throw AppError.conflict('This serial, asset id or set is already registered in the domain', 'RPD_EXTERNAL_REF_TAKEN');
    }
    throw err;
  }
  const device = await lockDeviceTx(tx, tid, rows[0].id);
  await recordAudit(tx, { tenantId: tid, action: 'rpd.device.minted', resource: 'reprocessable_devices', resourceId: device.id, context, metadata: { device_tag: device.device_tag, domain: dom, category: cat, enrolled_via: via, cycle_count: cycles, idempotency_key: context.idempotencyKey ?? null } });
  return device;
}

function assertTransition(device, action) {
  const verdict = deviceTransition(device.status, action);
  if (!verdict.ok) throw AppError.conflict(`Device ${device.device_tag} is ${device.status}; ${action} requires ${verdict.allowedFrom.join(' or ')}`, 'RPD_INVALID_TRANSITION', { status: device.status, action, allowed_from: verdict.allowedFrom });
  return verdict.to;
}

const AUDIT_EVENT_BY_ACTION = Object.freeze({
  capture: 'captured', uncapture: 'uncaptured', return: 'returned', receive: 'received',
  reprocessed: 'reprocessed', quarantine: 'quarantined', release: 'released', discard: 'discarded',
});

// Every transition, every caller. Shape guards are 400s here rather than 23514s
// from the table.
//
// Parameter casts (the 42P08 class, "inconsistent types deduced for parameter"):
// a parameter Postgres sees in two positions must carry the SAME explicit cast
// at BOTH. $3 (status) is assigned; $15 (action) is compared many times; $9
// (discard reason) is both `IN (...)`-compared and assigned to a varchar
// column, which without the casts deduces text at one site and varchar at the
// other. Every parameter below is cast at every site, including the ones used
// once, so a later edit that reuses one cannot regress this.
//
// Cycle and reprocessing columns key on the ACTION ($15), never on the target
// state: `uncapture` also lands on 'available' and must count nothing.
export async function applyDeviceTransitionTx(tx, device, action, patch = {}, context = {}) {
  const to = assertTransition(device, action);
  if (to === 'in_case' && patch.usageId == null) throw AppError.badRequest('usage_id is required to place a device in a case', 'RPD_USAGE_REQUIRED');
  if (to === 'discarded' && !patch.discardReason) throw AppError.badRequest('discard reason is required', 'RPD_REASON_REQUIRED');
  if (to === 'quarantined' && !cleanText(patch.quarantineReason, 500)) throw AppError.badRequest('quarantine reason is required', 'RPD_REASON_REQUIRED');
  const discardReason = patch.discardReason == null ? null : oneOf(patch.discardReason, DISCARD_REASONS, 'discard_reason', 'RPD_DISCARD_REASON_INVALID');
  const cycleType = patch.cycleType == null ? null : oneOf(patch.cycleType, CYCLE_TYPES, 'cycle_type', 'RPD_CYCLE_TYPE_INVALID');
  if (action === 'reprocessed' && device.domain === 'dialysis' && cycleType && !DIALYSIS_CYCLE_TYPES.includes(cycleType)) throw AppError.conflict('a dialyser is reprocessed chemically', 'RPD_CYCLE_TYPE_NOT_ALLOWED', { allowed: [...DIALYSIS_CYCLE_TYPES] });
  const functionCheck = patch.functionCheck == null ? null : oneOf(patch.functionCheck, FUNCTION_CHECK_RESULTS, 'function_check_result', 'RPD_FUNCTION_CHECK_INVALID');
  const exposureMarkers = Array.isArray(patch.exposureMarkers) && patch.exposureMarkers.length
    ? [...new Set(patch.exposureMarkers.map((m) => oneOf(m, MARKERS, 'exposure_markers', 'RPD_EXPOSURE_MARKER_INVALID')))] : null;
  const actor = context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null; // null only for the system sweep
  const exposureFlag = Boolean(patch.exposureFlag) || exposureMarkers !== null;
  const loadId = patch.sterilizationLoadId == null ? null : positiveInt(patch.sterilizationLoadId, 'sterilization_load_id');
  const quarantineReason = cleanText(patch.quarantineReason, 500);
  const discardNote = cleanText(patch.discardNote, 2000);
  const rows = await tx.$queryRawUnsafe(
    `UPDATE reprocessable_devices d
        SET status = $3::text,
            current_usage_id = CASE WHEN $15::text = 'capture' THEN $4::bigint
                                    WHEN $15::text IN ('return', 'uncapture', 'discard') THEN NULL
                                    ELSE current_usage_id END,
            cycle_count = CASE WHEN $15::text = 'reprocessed' THEN cycle_count + 1 ELSE cycle_count END,
            last_reprocessed_at = CASE WHEN $15::text = 'reprocessed' THEN NOW() ELSE last_reprocessed_at END,
            last_reprocessed_by = CASE WHEN $15::text = 'reprocessed' THEN $5::uuid ELSE last_reprocessed_by END,
            last_cycle_type = CASE WHEN $15::text = 'reprocessed' THEN $6::text ELSE last_cycle_type END,
            last_function_check = CASE WHEN $15::text = 'reprocessed'
                                         OR $9::text IN ('function_check_failed', 'integrity_test_failed', 'tcv_below_threshold')
                                       THEN $7::text ELSE last_function_check END,
            last_sterilization_load_id = CASE WHEN $15::text = 'reprocessed' AND $14::bigint IS NOT NULL THEN $14::bigint ELSE last_sterilization_load_id END,
            quarantine_reason = CASE WHEN $15::text = 'quarantine' THEN $8::text WHEN $15::text IN ('release', 'reprocessed') THEN NULL ELSE quarantine_reason END,
            quarantined_at = CASE WHEN $15::text = 'quarantine' THEN NOW() WHEN $15::text IN ('release', 'reprocessed') THEN NULL ELSE quarantined_at END,
            discard_reason = CASE WHEN $15::text = 'discard' THEN $9::text ELSE discard_reason END,
            discard_note = CASE WHEN $15::text = 'discard' THEN $10::text ELSE discard_note END,
            discarded_at = CASE WHEN $15::text = 'discard' THEN NOW() ELSE discarded_at END,
            discarded_by = CASE WHEN $15::text = 'discard' THEN $5::uuid ELSE discarded_by END,
            exposure_flag = exposure_flag OR $11::boolean,
            exposure_markers = CASE WHEN $12::text[] IS NULL THEN exposure_markers ELSE ARRAY(SELECT DISTINCT m FROM unnest(exposure_markers || $12::text[]) AS m ORDER BY m) END,
            metadata = metadata || $13::jsonb,
            updated_at = NOW()
      WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint
      RETURNING d.id`,
    device.tenant_id, device.id, to, patch.usageId == null ? null : positiveInt(patch.usageId, 'usage_id'), actor, cycleType, functionCheck,
    quarantineReason, discardReason, discardNote, exposureFlag, exposureMarkers, JSON.stringify(patch.metadata || {}), loadId, action,
  );
  if (!rows[0]) throw AppError.internal('Device transition did not persist', 'RPD_TRANSITION_FAILED');
  // Discarding an OT device retires its set - the one place the register writes the set's status.
  if (to === 'discarded' && device.domain === 'ot' && device.instrument_set_id) {
    await tx.$executeRawUnsafe(
      `UPDATE instrument_sets SET status = 'retired', usable = false, retired_at = NOW(), retired_by = $3::uuid, retirement_reason = $4::text, updated_at = NOW(), updated_by = $3::uuid
        WHERE tenant_id = $1::uuid AND id = $2::bigint AND status <> 'retired'`,
      device.tenant_id, device.instrument_set_id, actor, cleanText(patch.discardNote, 500) || discardReason,
    );
  }
  await recordAudit(tx, { tenantId: device.tenant_id, action: `rpd.device.${AUDIT_EVENT_BY_ACTION[action]}`, resource: 'reprocessable_devices', resourceId: device.id, context,
    metadata: { device_tag: device.device_tag, domain: device.domain, from: device.status, to, action, cycle_count_before: device.cycle_count, discard_reason: discardReason, quarantine_reason: quarantineReason, note: cleanText(patch.discardNote ?? patch.note, 500), sterilization_load_id: loadId, idempotency_key: context.idempotencyKey ?? null } });
  return lockDeviceTx(tx, device.tenant_id, device.id);
}

// ---------------------------------------------------------------------------
// CSSD queue actions (the same five as 765, domain-agnostic)
// ---------------------------------------------------------------------------
export async function receiveDevice(deviceId, context = {}) {
  const tid = tenantOr(context.tenantId); requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'receive', {}, context));
}
export async function markDeviceReprocessed(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId); requireUuid(context.actorUid, 'actorUid');
  const cycleType = oneOf(input.cycle_type ?? input.cycleType, CYCLE_TYPES, 'cycle_type', 'RPD_CYCLE_TYPE_INVALID');
  return setTenantTx(tid, async (tx) => {
    const device = await lockDeviceTx(tx, tid, deviceId);
    assertTransition(device, 'reprocessed');
    const policy = await categoryPolicyTx(tx, tid, device.domain, device.category);
    if (!policy?.reprocessable) throw AppError.conflict('No reprocessable policy for this category', 'RPD_POLICY_NOT_REPROCESSABLE');
    if (!policy.allowed_cycle_types.includes(cycleType)) throw AppError.conflict(`${cycleType} is not permitted for ${device.category}`, 'RPD_CYCLE_TYPE_NOT_ALLOWED', { allowed: policy.allowed_cycle_types });
    if (device.max_cycles_snapshot != null && device.cycle_count >= device.max_cycles_snapshot) {
      return applyDeviceTransitionTx(tx, device, 'discard', { discardReason: 'max_cycles_reached', discardNote: 'cycle ceiling reached at reprocessing' }, context);
    }
    let loadId = null;
    if (input.sterilization_load_id != null) {
      if (device.domain !== 'ot') throw AppError.badRequest('sterilization loads apply to OT devices', 'RPD_POLICY_INVALID');
      const load = (await tx.$queryRawUnsafe(`SELECT id, status, cycle_type FROM sterilization_loads WHERE tenant_id = $1::uuid AND id = $2::bigint`, tid, positiveInt(input.sterilization_load_id, 'sterilization_load_id')))[0];
      if (!load) throw AppError.notFound('Sterilization load not found', 'RPD_LOAD_NOT_FOUND');
      if (load.status !== 'passed') throw AppError.conflict('Sterilization load has not passed', 'RPD_LOAD_NOT_PASSED', { status: load.status });
      loadId = num(load.id);
    }
    const functionCheck = policy.function_check_required ? oneOf(input.function_check_result ?? input.functionCheck, ['pass', 'fail'], 'function_check_result', 'RPD_FUNCTION_CHECK_INVALID') : 'not_required';
    if (functionCheck === 'fail') return applyDeviceTransitionTx(tx, device, 'discard', { discardReason: 'function_check_failed', functionCheck: 'fail', discardNote: cleanText(input.note, 2000) }, context);
    const settled = await applyDeviceTransitionTx(tx, device, 'reprocessed', { cycleType, functionCheck, sterilizationLoadId: loadId, note: input.note }, context);
    if (loadId) await stampUsageLoadTx(tx, tid, device.id, loadId);
    return settled;
  });
}
export async function quarantineDevice(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId); requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'quarantine', { quarantineReason: input.reason }, context));
}
export async function releaseDevice(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId); requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'release', { note: input.note, metadata: { release_note: cleanText(input.note, 500) } }, context));
}
export async function discardDevice(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId); requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'discard', { discardReason: input.reason, discardNote: input.note }, context));
}

// The most recent returned usage of a device gets the load that reprocessed it (D7).
export async function stampUsageLoadTx(tx, tenantId, deviceId, loadId) {
  await tx.$executeRawUnsafe(
    `UPDATE reprocessable_device_usages u SET sterilization_load_id = $3::bigint, updated_at = NOW()
      WHERE u.tenant_id = $1::uuid AND u.id = (
        SELECT id FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND device_id = $2::bigint AND returned_at IS NOT NULL AND sterilization_load_id IS NULL
         ORDER BY returned_at DESC, id DESC LIMIT 1)`,
    tenantId, deviceId, loadId,
  );
}

// ---------------------------------------------------------------------------
// Capture / return helpers used by the domain services (inside THEIR tx)
// ---------------------------------------------------------------------------
const USAGE_SELECT = `id, tenant_id, domain, device_id, patient_uid, dialysis_session_id, ot_schedule_id, set_issue_log_id, sterilization_load_id, reuse_cycle, captured_at, captured_by, capture_source, reuse_screen, post_use_screen, post_use_disposition, returned_at, returned_by, acknowledgement_reason, metadata, created_at, updated_at`;
export const normalizeUsage = (row) => (row ? { ...row, id: num(row.id), device_id: num(row.device_id), reuse_cycle: num(row.reuse_cycle), set_issue_log_id: row.set_issue_log_id == null ? null : num(row.set_issue_log_id), sterilization_load_id: row.sterilization_load_id == null ? null : num(row.sterilization_load_id) } : null);

export async function openUsageForDeviceTx(tx, tenantId, deviceId) {
  const rows = await tx.$queryRawUnsafe(`SELECT ${USAGE_SELECT} FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND device_id = $2::bigint AND returned_at IS NULL FOR UPDATE`, tenantId, deviceId);
  return normalizeUsage(rows[0] || null);
}

export async function screenPatientTx(tx, { tenantId, patientUid, settings }) {
  return resolveReuseStatus({ tenantId, patientUid, validityDays: settings.serology_validity_days, db: tx });
}

// Places an AVAILABLE device in a case: usage row + capture transition. Exposure
// and dedication decisions are the caller's (they differ per domain); this
// helper only refuses what is domain-free.
export async function captureDeviceTx(tx, { device, patientUid, owner, captureSource, reuseScreen, acknowledgementReason = null, metadata = {}, context }) {
  const tid = device.tenant_id;
  if (device.status !== 'available') throw AppError.conflict(`Device ${device.device_tag} is ${device.status}`, 'RPD_DEVICE_NOT_AVAILABLE', { status: device.status });
  if (device.max_cycles_snapshot != null && device.cycle_count >= device.max_cycles_snapshot) throw AppError.conflict('Device has reached its cycle ceiling', 'RPD_MAX_CYCLES_REACHED');
  const source = oneOf(captureSource, CAPTURE_SOURCES, 'capture_source');
  const actor = requireUuid(context.actorUid, 'actorUid');
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO reprocessable_device_usages
       (tenant_id, domain, device_id, patient_uid, dialysis_session_id, ot_schedule_id, set_issue_log_id, reuse_cycle, captured_by, capture_source, reuse_screen, acknowledgement_reason, metadata)
     VALUES ($1::uuid, $2, $3::bigint, $4::uuid, $5::int, $6::int, $7::bigint, $8::int, $9::uuid, $10, $11::jsonb, $12, $13::jsonb)
     RETURNING ${USAGE_SELECT}`,
    tid, device.domain, device.id, requireUuid(patientUid, 'patientUid'), owner.dialysisSessionId ?? null, owner.otScheduleId ?? null, owner.setIssueLogId ?? null,
    device.cycle_count, actor, source, reuseScreen ? JSON.stringify(reuseScreen) : null, cleanText(acknowledgementReason, 2000), JSON.stringify(metadata || {}),
  );
  const usage = normalizeUsage(rows[0]);
  const settled = await applyDeviceTransitionTx(tx, device, 'capture', { usageId: usage.id }, context);
  return { usage, device: settled };
}

// Settles the open usage of a device: disposition, post_use_screen, return
// transition, then quarantine/discard when the disposition says so.
// exposureMarkers: OT leaves it null and the markers come from the screen
// (resolveReuseStatus carries them) - UNCHANGED by D11. Dialysis passes an EMPTY
// list: under D11 = NO a dialysis device is stamped with the exposure FLAG alone
// and nothing on it names a marker (spec §3.3, §2 D11(e)).
// deviceMetadata rides on the return transition; dialysis passes {} - the old
// exposure_isolation_class stamp is retired with the class.
export async function returnDeviceTx(tx, { device, usage, disposition, postUseScreen, options, discardReason = null, discardNote = null, acknowledgementReason = null, exposureMarkers = null, deviceMetadata = {}, context }) {
  const tid = device.tenant_id;
  if (!usage || usage.device_id !== device.id || usage.returned_at) throw AppError.conflict('No open usage for this device', 'RPD_USAGE_NOT_OPEN');
  if (!options.dispositions.includes(disposition)) throw AppError.conflict(`Disposition ${disposition} is not permitted`, 'RPD_DISPOSITION_NOT_ALLOWED', { allowed: options.dispositions, discard_reason: options.discard_reason, quarantine_reason: options.quarantine_reason, blocked_code: options.blocked_code });
  if (disposition === 'reprocess' && options.requires_acknowledgement && !cleanText(acknowledgementReason, 2000)) throw AppError.badRequest('acknowledgement.reason is required', 'RPD_ACKNOWLEDGEMENT_REQUIRED');
  const actor = context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null;
  const dispositionCode = disposition === 'reprocess' ? 'sent_for_reprocessing'
    : disposition === 'quarantine' ? 'quarantined_bloodborne_exposure'
      : (discardReason || options.discard_reason) === 'bloodborne_exposure' ? 'discarded_bloodborne_exposure'
        : (discardReason || options.discard_reason) === 'max_cycles_reached' ? 'discarded_max_cycles'
          : (discardReason || options.discard_reason) === 'integrity_test_failed' ? 'discarded_integrity_failed'
            : (discardReason || options.discard_reason) === 'tcv_below_threshold' ? 'discarded_tcv_below_threshold' : 'discarded_other';
  await tx.$executeRawUnsafe(
    `UPDATE reprocessable_device_usages SET post_use_screen = $3::jsonb, post_use_disposition = $4, returned_at = NOW(), returned_by = $5::uuid,
            acknowledgement_reason = COALESCE($6, acknowledgement_reason), updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    tid, usage.id, postUseScreen ? JSON.stringify(postUseScreen) : null, dispositionCode, actor, cleanText(acknowledgementReason, 2000),
  );
  const markers = Array.isArray(exposureMarkers) ? exposureMarkers : (postUseScreen?.markers || []).filter((m) => m.result === 'reactive').map((m) => m.marker);
  let settled = await applyDeviceTransitionTx(tx, device, 'return', { exposureFlag: options.exposure, exposureMarkers: options.exposure && markers.length ? markers : null, metadata: deviceMetadata }, context);
  if (disposition === 'quarantine') settled = await applyDeviceTransitionTx(tx, settled, 'quarantine', { quarantineReason: options.quarantine_reason || 'bloodborne_exposure', exposureFlag: true, exposureMarkers: markers.length ? markers : null }, context);
  if (disposition === 'discard') settled = await applyDeviceTransitionTx(tx, settled, 'discard', { discardReason: discardReason || options.discard_reason || 'other', discardNote, exposureFlag: (discardReason || options.discard_reason) === 'bloodborne_exposure', exposureMarkers: markers.length && (discardReason || options.discard_reason) === 'bloodborne_exposure' ? markers : null }, context);
  return { device: settled, disposition: dispositionCode };
}

// Releases a device whose case was cancelled BEFORE use (spec §5.1 Cancel,
// §5.2): the usage closes as 'cancelled_before_use', the device goes in_case ->
// available with no cycle change and no reprocessing field, and the cycle
// number stays free for the next capture (the cycle unique is partial). The
// CALLER decides "before use" - a session that never started, a pack never
// opened - and passes partialUse; this helper refuses what is domain-free.
// A refusal here must fail the caller's cancel. No best-effort: a cancel that
// succeeds while the device stays in_case is the defect this exists to close.
export async function uncaptureDeviceTx(tx, { device, usage, partialUse = false, cancelTarget = 'cancelled', metadata = {}, context }) {
  const tid = device.tenant_id;
  if (!usage || usage.device_id !== device.id) throw AppError.conflict('No usage for this device on the cancelled case', 'RPD_USAGE_NOT_OPEN');
  // Use was recorded: the usage is closed, or a statutory row names it. Such a
  // case is completed / returned, never cancelled - the register says the
  // device was used there.
  if (usage.returned_at || usage.post_use_disposition) {
    throw AppError.conflict('Use of this device was already recorded on this case; it cannot be released by cancelling', 'RPD_USAGE_NOT_CANCELLABLE', { usage_id: usage.id, post_use_disposition: usage.post_use_disposition });
  }
  const recorded = await tx.$queryRawUnsafe(`SELECT id FROM dialyzer_reuse_register WHERE tenant_id = $1::uuid AND device_usage_id = $2::bigint LIMIT 1`, tid, usage.id);
  if (recorded[0]) throw AppError.conflict('A reprocessing record exists for this use; it cannot be released by cancelling', 'RPD_USAGE_NOT_CANCELLABLE', { usage_id: usage.id, reuse_register_id: num(recorded[0].id) });
  // Patient contact happened or cannot be ruled out: reprocess, never release.
  if (partialUse) {
    throw AppError.conflict('This device may have had patient contact; return it for reprocessing before cancelling', 'RPD_RETURN_REQUIRED', { usage_id: usage.id, device_tag: device.device_tag });
  }
  const actor = context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null;
  const closed = await tx.$queryRawUnsafe(
    `UPDATE reprocessable_device_usages
        SET post_use_disposition = 'cancelled_before_use', returned_at = NOW(), returned_by = $3::uuid,
            metadata = metadata || $4::jsonb, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint AND returned_at IS NULL
      RETURNING ${USAGE_SELECT}`,
    tid, usage.id, actor, JSON.stringify({ ...metadata, cancel_target: cancelTarget }),
  );
  if (!closed[0]) throw AppError.conflict('The usage closed under us', 'RPD_USAGE_NOT_CANCELLABLE', { usage_id: usage.id });
  const settled = await applyDeviceTransitionTx(tx, device, 'uncapture', { metadata: { last_cancelled_usage_id: usage.id, cancel_target: cancelTarget } }, context);
  return { usage: normalizeUsage(closed[0]), device: settled };
}

// Same call shape as cathDeviceReuseService.recordReuseSafetyReview (≈707): the
// blocker `type` is the review_type the timeline shows; the domain rides on it.
export async function recordReuseSafetyReview(tx, { tenantId, patientUid, domain, findingCode, message, reason, actorUid, payload = {} }) {
  const rows = await recordMedicationSafetyReviews({
    tenantId, patientUid, encounterId: null,
    safety: { safe: false, blockers: [{ type: 'reprocessable_device_reuse', code: findingCode, severity: 'high', message, domain, ...payload }], warnings: [] },
    override: { reason, approvedBy: actorUid },
    actorUid,
  }, { db: tx });
  if (!rows.length) throw AppError.internal('Reprocessable device safety review did not persist', 'RPD_SAFETY_REVIEW_FAILED');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Role projection helpers shared with the domain services. The predicate is
// cath's (spec §3.5: the SAME predicate, deliberately not a second list) and
// the restriction projection lives in reprocessableDeviceProjection.js so its
// unit test needs no database; both are re-exported here for the routes.
// ---------------------------------------------------------------------------
export { projectReuseRestrictionForRole, roleSeesSerologyDetail } from './reprocessableDeviceProjection.js';

// ---------------------------------------------------------------------------
// History (PHI with no single subject) + label
// ---------------------------------------------------------------------------
export async function deviceHistory({ tenantId, deviceId } = {}) {
  const tid = tenantOr(tenantId);
  const device = await deviceById({ tenantId: tid, deviceId });
  if (!device) throw AppError.notFound('Reprocessable device not found', 'RPD_DEVICE_NOT_FOUND');
  const uses = await setTenant(tid, (tx) => tx.$queryRawUnsafe(`SELECT ${USAGE_SELECT} FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND device_id = $2::bigint ORDER BY captured_at ASC, id ASC`, tid, device.id));
  const transitions = await setTenant(tid, (tx) => tx.$queryRawUnsafe(`SELECT action, actor_uid, metadata, created_at FROM audit_logs WHERE tenant_id = $1::uuid AND resource = 'reprocessable_devices' AND resource_id = $2 ORDER BY created_at ASC, id ASC`, tid, String(device.id)));
  return { device, uses: uses.map(normalizeUsage), transitions };
}

export const DEVICE_HISTORY_PHI_BATCH_CAP = 25;
const RECORD_TYPE_BY_DOMAIN = Object.freeze({ dialysis: 'DIALYSIS', ot: 'OPERATING_THEATRE' });

export async function logDeviceHistoryAccess({ tenantId, deviceId, history, actor = {} } = {}) {
  const tid = tenantOr(tenantId);
  const uses = Array.isArray(history?.uses) ? history.uses : [];
  const patientUids = [...new Set(uses.map((u) => u?.patient_uid).filter(Boolean).map(String))];
  if (!patientUids.length) return { logged: 0 };
  const token = `rpd_device:${deviceId}`;
  const room = 80 - token.length - 1;
  const prefix = actor.requestId ? String(actor.requestId).slice(0, Math.max(0, room)) : '';
  const requestId = prefix ? `${prefix} ${token}` : token;
  const recordType = RECORD_TYPE_BY_DOMAIN[history?.device?.domain] || 'DIALYSIS';
  let logged = 0;
  for (let i = 0; i < patientUids.length; i += DEVICE_HISTORY_PHI_BATCH_CAP) {
    const entries = patientUids.slice(i, i + DEVICE_HISTORY_PHI_BATCH_CAP).map((patientUid) => ({ userId: actor.actorUid || null, userRole: actor.actorRole || null, patientId: patientUid, recordType, action: 'VIEW', ip: actor.ipAddress || null, requestId, tenantId: tid }));
    try { await setTenant(tid, (db) => logPhiAccessBatch(entries, { db })); } catch (err) {
      logger.error(`Reprocessable device history PHI access batch failed: ${err?.message}`, { tenantId: tid, deviceId, sliceStart: i });
      for (const entry of entries) logPhiAccess(entry);
    }
    logged += entries.length;
  }
  return { logged };
}

// Same shape as cssdService.getInstrumentSetLabel so the admin print path renders both.
export async function getDeviceLabel(deviceId, context = {}) {
  const tid = tenantOr(context.tenantId);
  const device = await deviceById({ tenantId: tid, deviceId });
  if (!device) throw AppError.notFound('Reprocessable device not found', 'RPD_DEVICE_NOT_FOUND');
  await setTenantTx(tid, async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE reprocessable_devices SET metadata = metadata || $3::jsonb, updated_at = NOW() WHERE tenant_id = $1::uuid AND id = $2::bigint`, tid, device.id, JSON.stringify({ label_printed_at: new Date().toISOString(), label_printed_by: context.actorUid || null }));
    await recordAudit(tx, { tenantId: tid, action: 'rpd.device.label_printed', resource: 'reprocessable_devices', resourceId: device.id, context, metadata: { device_tag: device.device_tag } });
  });
  return { device_id: device.id, device_tag: device.device_tag, external_ref: device.manufacturer_serial || device.hospital_asset_id || null, domain: device.domain, item_name: device.item_name, cycle_count: device.cycle_count, barcode: device.device_tag, barcode_symbology: 'code39', svg: code39Svg(device.device_tag, { module: 2, height: 44 }), generated_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// The platform exposure handler (§3.2): both domain arms, each device in its
// own transaction, the alert raised for whatever subset settled.
// ---------------------------------------------------------------------------
export async function quarantineDevicesExposedToPatient(event) {
  const tid = tenantOr(event.tenantId);
  const marker = oneOf(event.marker, MARKERS, 'marker', 'RPD_EXPOSURE_MARKER_INVALID');
  const patientUid = requireUuid(event.patientUid, 'patientUid');
  const otSettings = await getDomainSettings({ tenantId: tid, domain: 'ot' });
  const lookbackDays = marker === 'cjd_suspected' ? 36500 : otSettings.serology_validity_days;
  const context = { actorUid: null, actorRole: 'SYSTEM' };
  const candidates = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT DISTINCT d.id, d.domain
       FROM reprocessable_devices d
       LEFT JOIN reprocessable_device_dialysis_links l ON l.tenant_id = d.tenant_id AND l.device_id = d.id
       LEFT JOIN reprocessable_device_usages u ON u.tenant_id = d.tenant_id AND u.device_id = d.id
      WHERE d.tenant_id = $1::uuid AND d.status <> 'discarded'
        AND (
          l.dedicated_patient_uid = $2::uuid
          OR (u.patient_uid = $2::uuid AND (d.domain = 'dialysis' AND u.returned_at IS NULL))
          OR (u.patient_uid = $2::uuid AND d.domain = 'ot'
              AND u.captured_at >= (($3::date - ($4::int * INTERVAL '1 day'))::timestamp AT TIME ZONE 'Asia/Kolkata'))
        )
      ORDER BY d.id`,
    tid, patientUid, event.testedOn, lookbackDays,
  ));
  const affected = []; const failed = [];
  for (const { id } of candidates) {
    try {
      const settled = await setTenantTx(tid, async (tx) => {
        const device = await lockDeviceTx(tx, tid, id);
        if (device.status === 'discarded') return null;
        if (device.status === 'in_case' || device.status === 'quarantined') {
          await tx.$executeRawUnsafe(`UPDATE reprocessable_devices SET exposure_flag = TRUE, exposure_markers = ARRAY(SELECT DISTINCT m FROM unnest(exposure_markers || $3::text[]) AS m ORDER BY m), metadata = metadata || $4::jsonb, updated_at = NOW() WHERE tenant_id = $1::uuid AND id = $2::bigint`, tid, device.id, [marker], JSON.stringify({ late_reactive_marker_row_id: event.markerRowId }));
          await recordAudit(tx, { tenantId: tid, action: 'rpd.device.exposure_flagged', resource: 'reprocessable_devices', resourceId: device.id, context, metadata: { marker, tested_on: event.testedOn, status: device.status, domain: device.domain } });
          return lockDeviceTx(tx, tid, id);
        }
        return applyDeviceTransitionTx(tx, device, 'quarantine', { exposureFlag: true, exposureMarkers: [marker], quarantineReason: `Late reactive ${marker} result dated ${event.testedOn}`, metadata: { late_reactive_marker_row_id: event.markerRowId } }, context);
      });
      if (settled) affected.push(settled);
    } catch (err) {
      failed.push({ device_id: num(id), error: err?.message || String(err) });
      logger.error(`Late-reactive reprocessable device sweep failed for device ${num(id)}: ${err?.message}`, { tenantId: tid, deviceId: num(id), marker });
    }
  }
  // Nothing is written to dialysis_patients here: the roster derives its state
  // at read time through the Phase 1 resolver (spec §3.3). No sync step.
  if (!affected.length) return { affected: [], failed };
  const tags = affected.map((d) => `${d.device_tag} (${d.domain})`).join(', ');
  try {
    await persistCdsAlert({ patientUid, encounterId: null, alertType: 'bloodborne_reuse_exposure', severity: 'high', title: 'Reprocessable devices exposed to a reactive blood-borne marker', description: `Devices ${tags} were used on this patient and are now quarantined or flagged after a reactive ${marker} result dated ${event.testedOn}.`, sourceData: { marker, tested_on: event.testedOn, device_ids: affected.map((d) => d.id), marker_row_id: event.markerRowId, domains: [...new Set(affected.map((d) => d.domain))] } });
  } catch (err) { logger.error(`CDS alert for reprocessable device exposure failed: ${err?.message}`, { tenantId: tid }); }
  try {
    const officers = await setTenant(tid, (tx) => tx.$queryRawUnsafe(`SELECT id, uid FROM users WHERE tenant_id = $1::uuid AND role = 'INFECTION_CONTROL_OFFICER' AND is_active = TRUE AND status = 'active' AND COALESCE(is_deleted, FALSE) = FALSE`, tid));
    for (const officer of officers) {
      const domain = affected[0].domain;
      await notificationOutbox.queue({ tenantId: tid, type: 'bloodborne_reuse_exposure', channel: 'inapp', recipientId: officer.id, recipientPhone: null, title: 'Reprocessable devices quarantined after a reactive result', body: `Devices ${tags}: reactive ${marker} result dated ${event.testedOn}. Review the CSSD device queue.`, sourceEventKey: `bloodborne-reuse-exposure:rpd:${event.markerRowId}:${officer.uid}`, templateVersion: 'bloodborne-reuse-exposure.v1', data: { kind: 'bloodborne_reuse_exposure', marker, tested_on: event.testedOn, device_ids: affected.map((d) => d.id), deep_link: `/dashboard/cssd?tab=devices&domain=${domain}` } }, { strict: false });
    }
  } catch (err) { logger.error(`Infection-control notification for reprocessable device exposure failed: ${err?.message}`, { tenantId: tid }); }
  return { affected, failed };
}

registerExposureHandler(quarantineDevicesExposedToPatient);
```

`recordReuseSafetyReview` above mirrors `cathDeviceReuseService.recordReuseSafetyReview` (≈707) call for call; if that function has moved, re-read it and keep the two identical.

- [ ] **Step 2: Projection module and test**

```js
// apps/backend/src/services/clinical/reprocessableDeviceProjection.js
//
// Role projection for the read surfaces this lane changes (§3.5). Same
// predicate as the cath projections (roleSeesSerologyDetail), never a second
// list. Keys are BLANKED, never dropped: the admin and staff clients parse
// fixed shapes.
import { roleSeesSerologyDetail } from './cathDeviceReuseService.js';

export { roleSeesSerologyDetail };
export const DIALYSIS_PATIENT_SEROLOGY_KEYS = Object.freeze(['hbsag_status', 'hcv_status', 'hiv_status']);
export const DIALYSIS_SEROLOGY_ROW_KEYS = Object.freeze(['hbsag', 'hbs_titre', 'anti_hcv', 'hcv_pcr', 'hiv']);

// Two restriction shapes cross this seam and both are projected the same way -
// status-level fields survive, reasons and markers do not:
//   * the cath/OT resolveReuseStatus object { status, validity_days, evaluated_at, reasons, markers }
//   * the dialysis Phase 1 Decision { status, asOf, evidence, reasons, isolation_class?, markers? }
//     (spec §3.3), told apart by `evidence`.
// isolation_class is BLANKED, not carried: a value of 'hiv' is serology whatever
// the caller calls it (the reason dev-1b refused it as an unconditional field),
// and D11 = NO settled that no routing role reads it at all (§2).
// Belt and braces: no read surface in this lane asks for the class, so the key
// is normally absent - this makes a future forwarding route fail closed.
export function projectReuseRestrictionForRole(restriction, role) {
  if (!restriction || typeof restriction !== 'object') return restriction;
  if (roleSeesSerologyDetail(role)) return restriction;
  if ('evidence' in restriction) return { status: restriction.status, asOf: restriction.asOf ?? null, evidence: restriction.evidence, isolation_class: null, reasons: [] };
  return { status: restriction.status, validity_days: restriction.validity_days, evaluated_at: restriction.evaluated_at, reasons: [], markers: [] };
}

function blank(row, keys) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = { ...row };
  for (const key of keys) if (key in out) out[key] = null;
  return out;
}
export function projectDialysisPatientForRole(row, role) {
  if (roleSeesSerologyDetail(role)) return row;
  return blank(row, DIALYSIS_PATIENT_SEROLOGY_KEYS); // isolation_required survives: the advisory
}
export function projectDialysisPatientsForRole(rows, role) {
  return Array.isArray(rows) && !roleSeesSerologyDetail(role) ? rows.map((r) => projectDialysisPatientForRole(r, role)) : rows;
}
export function projectDialysisSerologyRowsForRole(rows, role) {
  if (!Array.isArray(rows) || roleSeesSerologyDetail(role)) return rows;
  return rows.map((r) => ({ ...blank(r, DIALYSIS_SEROLOGY_ROW_KEYS), ...('is_seroconversion' in (r || {}) ? { is_seroconversion: false } : {}) }));
}
// There is deliberately NO projection of the `isolation` envelope (spec §3.5) -
// because there is nothing in it to project. The codes, the machine the warning
// is about, its severity and the required_group are what whoever puts the
// patient on a machine must read, and a group is a tenant's label for a BAY, not
// a clinical value (D11 = NO). The class never enters the payload at all (spec
// §3.4). The marker VALUES above and the Decision's class stay blanked.
export default { projectReuseRestrictionForRole, projectDialysisPatientForRole, projectDialysisPatientsForRole, projectDialysisSerologyRowsForRole };
```

```js
// apps/backend/src/tests/unit/reprocessableDeviceProjection.test.js
import projection, { projectDialysisPatientForRole, projectDialysisSerologyRowsForRole, projectReuseRestrictionForRole } from '../../services/clinical/reprocessableDeviceProjection.js';

const patient = { id: 1, hbsag_status: 'positive', hcv_status: 'negative', hiv_status: 'unknown', isolation_required: true };
describe('restriction projection - both shapes', () => {
  const cathShape = { status: 'restricted', validity_days: 90, evaluated_at: '2026-09-05T00:00:00.000Z', reasons: ['HBsAg reactive 2026-08-12'], markers: [{ marker: 'hbsag', result: 'reactive' }] };
  const decision = { status: 'restricted', asOf: '2026-09-05T00:00:00.000Z', reasons: ['HBsAg reactive 2026-08-12'], evidence: 'marker', isolation_class: 'hbsag', markers: [{ marker: 'hbsag', result: 'reactive' }] };
  test('a non-audience role keeps the status fields and loses reasons/markers - cath/OT shape', () => {
    expect(projectReuseRestrictionForRole(cathShape, 'DIALYSIS_TECHNICIAN')).toEqual({ status: 'restricted', validity_days: 90, evaluated_at: cathShape.evaluated_at, reasons: [], markers: [] });
  });
  test('a non-audience role keeps status / asOf / evidence, BLANKS isolation_class and loses reasons and any markers - Decision shape', () => {
    const out = projectReuseRestrictionForRole(decision, 'BLOOD_BANK_STAFF');
    expect(out).toEqual({ status: 'restricted', asOf: decision.asOf, evidence: 'marker', isolation_class: null, reasons: [] });
    expect('markers' in out).toBe(false);
    expect('isolation_class' in out).toBe(true);          // blanked, never dropped
  });
  test('a Decision that never carried a class (every read surface) still projects with the key blanked', () => {
    const { isolation_class: _omit, markers: _drop, ...classless } = decision; // eslint-disable-line no-unused-vars
    expect(projectReuseRestrictionForRole(classless, 'DIALYSIS_TECHNICIAN')).toEqual({ status: 'restricted', asOf: decision.asOf, evidence: 'marker', isolation_class: null, reasons: [] });
  });
  test('an audience role reads either shape unchanged', () => {
    expect(projectReuseRestrictionForRole(cathShape, 'DOCTOR')).toBe(cathShape);
    expect(projectReuseRestrictionForRole(decision, 'DOCTOR')).toBe(decision);
  });
});
describe('dialysis serology projection', () => {
  test('a non-audience role sees the advisory and none of the markers; keys stay', () => {
    const out = projectDialysisPatientForRole(patient, 'DIALYSIS_TECHNICIAN');
    expect(out).toEqual({ id: 1, hbsag_status: null, hcv_status: null, hiv_status: null, isolation_required: true });
    expect(Object.keys(out)).toEqual(Object.keys(patient));
  });
  test('an audience role reads the row unchanged', () => { expect(projectDialysisPatientForRole(patient, 'DOCTOR')).toBe(patient); });
  test('serology rows: values blanked, seroconversion forced false, test_date kept', () => {
    expect(projectDialysisSerologyRowsForRole([{ test_date: '2026-08-01', hbsag: 'positive', hbs_titre: '12', anti_hcv: 'negative', hcv_pcr: null, hiv: 'negative', is_seroconversion: true }], 'BLOOD_BANK_STAFF'))
      .toEqual([{ test_date: '2026-08-01', hbsag: null, hbs_titre: null, anti_hcv: null, hcv_pcr: null, hiv: null, is_seroconversion: false }]);
  });
  test('no isolation projection exists: the required machine class is routing, not disclosure (spec §3.5)', () => {
    expect(Object.keys(projection).sort()).toEqual(['projectDialysisPatientForRole', 'projectDialysisPatientsForRole', 'projectDialysisSerologyRowsForRole', 'projectReuseRestrictionForRole']);
  });
});
```

Run: `npm test -- --testPathPatterns "unit/reprocessableDeviceProjection|unit/reprocessableDeviceRules"` — Expected: PASS.

- [ ] **Step 3: Lint and commit**

```bash
cd apps/backend && npx eslint src/services/clinical/reprocessableDeviceService.js src/services/clinical/reprocessableDeviceProjection.js --max-warnings=0
git add apps/backend/src/services/clinical/reprocessableDeviceService.js apps/backend/src/services/clinical/reprocessableDeviceProjection.js apps/backend/src/tests/unit/reprocessableDeviceProjection.test.js
git commit -m "feat(reprocessing): platform device service - register, transitions, queue actions, history, label, exposure handler

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: Dialysis — capture, one-command reprocessing record, isolation, machines (consumes the Phase 1 resolver)

**DEPENDS ON Phase 1.** Every dialysis *decision* in this task — the frozen capture snapshot, the isolation rule at schedule / start / reassign, the post-use disposition — reads `resolveDialysisIsolation` from the dialysis isolation derivation lane (dev-1b, migration 767; spec §3.3). Step 0b checks that the resolver is on `github/main` before any of it is written. Until it is: Steps 1 (adapter + named stub), 4 (census), 5 (pins) and every unit test can land; Step 2's service compiles against the adapter; the dialysis deep suite is *skipped by name*. Nothing in this task falls back to a stub or to the roster columns at runtime — with a dialyser policy on and no resolver importable, the dialysis paths fail closed with `RPD_ISOLATION_RESOLVER_UNAVAILABLE` (503). This lane writes **nothing** to `dialysis_patients.hbsag_status / hcv_status / hiv_status`: no sync, no latch, no union read, no enrol guard, no `recordSerology` change, no backfill — all Phase 1's (spec §3.3, hand-over notes there).

**Files:**
- Create: `apps/backend/src/services/clinical/dialysisIsolationAdapter.js`, `apps/backend/src/services/clinical/dialysisReuseService.js`, `apps/backend/src/services/clinical/dialysisIsolationCensus.js`, `apps/backend/scripts/dialysis-isolation-census.mjs`
- Modify: `apps/backend/src/services/clinical/dialysisService.js` (`validateReuseRegisterInput` :33, `scheduleSession` :440, `startSession` :493, `cancelSession` :625, `recordReuseRegister` :928 — **not** `enrolPatient` and **not** `recordSerology`, which are Phase 1's)
- Modify (pre-flight, separate commit, only if `main` has not): `apps/backend/src/services/clinical/dialysisMachineService.js` (:74–80 and the `logObservation` call ≈100)
- Modify: `apps/backend/src/routes/clinical/dialysisRoutes.js`, `apps/backend/src/config/routeRolePolicy.js`
- Create: `apps/backend/src/tests/unit/dialysisIsolationAdapter.test.js`, `dialysisSerologyWriters.test.js`, `dialysisReuseHookCallSites.test.js`, `dialysisMachineIngestTenantScope.test.js`, `apps/backend/src/tests/reprocessable-devices-dialysis.deep.test.js`, `apps/backend/src/tests/dialysis-isolation-census.deep.test.js`

- [ ] **Step 0: Pre-flight — the machine-ingest tenant predicate (adjacent defect owned by another session)**

`POST /machines/ingest` (`routes/clinical/dialysisRoutes.js:330`) → `dialysisMachineService.ingestMachineObservations` matches the in-progress session by `machine_no` alone (`dialysisMachineService.js:74-80`: `WHERE machine_no = $1 AND status = 'in_progress'`) and calls `logObservation` without a tenant (≈:100; `logObservation({ tenantId, session_id, … })` at `dialysisService.js:673` accepts one). With this lane's per-tenant machine master, identical `machine_no` values across tenants become the norm, so a payload for tenant A can land device observations on tenant B's session. Another session owns the defect; check `main` before touching it:

```bash
git fetch github main
git show github/main:apps/backend/src/services/clinical/dialysisMachineService.js | grep -c "tenant_id = \$2::uuid AND machine_no = \$1"
git show github/main:apps/backend/src/services/clinical/dialysisMachineService.js | grep -c "tenantId: safeTenant"
```

Expected if `main` already carries the fix: `1` and `1` — skip the rest of this step. If either prints `0`, land the fix in-lane as its **own commit** before Step 1 (it is a bug fix in a file this lane does not otherwise touch, so it must be separable):

In `ingestMachineObservations`, hoist the tenant once above the inbox insert — `const safeTenant = requireTenantId(tenantId);` — and use it in the inbox `INSERT` (replacing the inline `requireTenantId(tenantId)`), in the session match:

```js
    // 2. Match the machine to its in-progress session (latest wins) - IN THIS
    //    TENANT. machine_no is a per-tenant label (NNN's dialysis_machines is
    //    unique on (tenant_id, machine_no)), so the same number exists in
    //    several tenants and a tenant-blind match lands observations on the
    //    wrong patient.
    const sessRows = await prisma.$queryRawUnsafe(
      `SELECT id, dialysis_patient_id FROM dialysis_sessions
       WHERE tenant_id = $2::uuid AND machine_no = $1 AND status = 'in_progress'
       ORDER BY actual_start_at DESC NULLS LAST
       LIMIT 1`,
      machineNo, safeTenant,
    );
```

and in the observation write:

```js
      const row = await logObservation({
        tenantId: safeTenant,
        session_id: session.id,
        recorded_by: context.actorUid || null,
        recorded_at: obs?.recorded_at || null,
        source: 'device',
        source_device: machineNo,
        ...cleaned,
      });
```

With the pin:

```js
// apps/backend/src/tests/unit/dialysisMachineIngestTenantScope.test.js
// The machine-ingest path matches a session by machine_no, a label that is
// unique per TENANT (NNN: dialysis_machines (tenant_id, machine_no)). Textual
// pin that the match and the observation write both carry the tenant.
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../services/clinical/dialysisMachineService.js', import.meta.url), 'utf8');

test('the in-progress session match is tenant-scoped', () => {
  const match = source.match(/SELECT id, dialysis_patient_id FROM dialysis_sessions[\s\S]{0,240}?LIMIT 1/);
  expect(match).not.toBeNull();
  expect(match[0]).toMatch(/tenant_id = \$\d::uuid/);
  expect(match[0]).toMatch(/status = 'in_progress'/);
});
test('observations land with the tenant', () => {
  const call = source.slice(source.indexOf('await logObservation({'), source.indexOf('await logObservation({') + 240);
  expect(call).toMatch(/tenantId:\s*safeTenant/);
});
```

```bash
cd apps/backend && npm test -- --testPathPatterns "unit/dialysisMachineIngestTenantScope|dialysisMachine"
git add apps/backend/src/services/clinical/dialysisMachineService.js apps/backend/src/tests/unit/dialysisMachineIngestTenantScope.test.js
git commit -m "fix(dialysis): scope machine ingest by tenant

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected: PASS (the new pin plus any existing `dialysisMachine*` suite; if an existing suite stubs `prisma.$queryRawUnsafe` with positional expectations, update its expected argument list to `[machineNo, tenantId]`). Name this commit in the PR body's follow-ups whether or not it was needed.

- [ ] **Step 0b: Pre-flight — is Phase 1 on `main`?**

```bash
git fetch github main
git ls-tree --name-only github/main apps/backend/src/migrations/ | grep -c '/767_'
git show github/main:apps/backend/src/services/clinical/dialysisIsolationResolver.js 2>/dev/null | grep -c 'export async function resolveDialysisIsolation'
git show github/main:apps/backend/src/services/clinical/dialysisIsolationResolver.js 2>/dev/null | grep -n -E "isolation_class|includeMarkers|includeIsolationClass|evidence" | head
```

Expected once Phase 1 has landed: `1`, `1`, and lines naming `evidence`, `includeMarkers`, `includeIsolationClass` and `isolation_class`. Record the module path (the constant `PHASE1_RESOLVER_MODULE` in Step 1 is the only line to change if dev-1b named it differently) and confirm that `isolation_class` is gated on `includeIsolationClass` (spec §3.3: agreed with dev-1b as **opt-in**, present only when asked for and `null` unless `status === 'restricted'` — Plan 4's original ask for an unconditional fifth field was rejected and this is the agreed counter-proposal). If the resolver returns the class **unconditionally**, that is a Phase 1 defect, not a convenience: stop and raise it, because an unrequested class would reach the read surfaces the projection has to blank. If `includeIsolationClass` is absent altogether, stop and raise it too — do not derive a class from marker detail here. If the first two print `0`: write Steps 1, 4 and 5 now, write Step 2 against the adapter, leave Step 7's dialysis suite behind its guard, and name the dependency in the PR body. Do not invent a resolver; do not read the columns; do not change `describeIfPhase1` into `describe`.

- [ ] **Step 1: The resolver adapter and its named stub**

```js
// apps/backend/src/services/clinical/dialysisIsolationAdapter.js
//
// The ONE place this lane touches the Phase 1 dialysis isolation resolver
// (spec §3.3). Everything dialysis-side - the frozen capture snapshot, the
// isolation rule at schedule/start/reassign, the post-use disposition - reads
// a Decision through here, LIVE, inside the caller's transaction.
//
// Contract consumed (agreed with dev-1b in full, 2026-09-05; unchanged by D11):
//   resolveDialysisIsolation({ tenantId, patientUids, db,
//                              includeMarkers = false, includeIsolationClass = false })
//     -> Map<patientUid, Decision>
//   Decision = { status: 'restricted'|'unknown'|'clear', asOf, reasons: [],
//                evidence: 'marker'|'legacy_declaration'|'none',
//                isolation_class?: 'hbsag'|'hcv'|'hiv'|'isolation_mixed'|null,
//                          /* ONLY when includeIsolationClass; null unless restricted */
//                markers?: [...] /* ONLY when includeMarkers */ }
//
// Rules this adapter enforces on our side of the seam:
//   * includeMarkers defaults to false and is forwarded ONLY when a caller says
//     so. No caller in THIS lane passes it (the roster / patient-detail surface
//     that may is Phase 1's); the flag exists here so that surface has one seam.
//   * includeIsolationClass defaults to false on the same footing. Plan 4 asked
//     for the class as an unconditional fifth field; dev-1b refused, because a
//     value of 'hiv' IS serology whatever the caller calls it - "it's a routing
//     instruction" is the reframing that produced two earlier disclosures. Since
//     owner decision D11 = NO, exactly ONE server-side path passes it:
//     assessIsolationTx (machine routing, Step 2), which maps the class to the
//     tenant's routing GROUP and drops it in the same frame. The post-use path
//     no longer asks - its two consumers (the exposure_markers stamp and the
//     exposure_isolation_class metadata) are retired. No read surface passes it,
//     so no read surface can leak it.
//   * snapshotOf() strips `markers` AND `isolation_class`, ALWAYS. There is no
//     { keepClass } form: under D11 = NO nothing downstream of the resolver call
//     may hold a class, and the frozen reuse_screen / post_use_screen are
//     returned raw inside `usage` by GET /sessions/:id/dialyser. The one
//     consumer that needs the class reads it off the LIVE Decision before the
//     freeze, inside assessIsolationTx.
//   * A missing resolver is a 503, never a fallback: with a dialyser policy on
//     and no Phase 1 module, capture / reprocess / schedule / start fail closed
//     (RPD_ISOLATION_RESOLVER_UNAVAILABLE). The roster columns are not read.
//   * A Decision outside the three statuses is refused
//     (RPD_ISOLATION_DECISION_INVALID) - a wrong shape must not route a patient.
//     The class is checked ONLY against what was asked for: absent when the
//     caller asked for it, or a value outside the four, is refused; absent when
//     the caller did not ask is VALID. Asserting presence unconditionally would
//     re-create the rejected contract inside our own code.
//   * Phase 1's own single-uid wrapper is NOT imported: one binding, not two.
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

// Confirmed at Task 4 Step 0b against github/main; the only line to touch on a
// Phase 1 rename.
let PHASE1_RESOLVER_MODULE = './dialysisIsolationResolver.js';
export const DECISION_STATUSES = Object.freeze(['restricted', 'unknown', 'clear']);
export const DECISION_ISOLATION_CLASSES = Object.freeze(['hbsag', 'hcv', 'hiv', 'isolation_mixed']);

let resolverPromise = null;
let stub = null;

async function loadResolver() {
  if (stub) return stub;
  if (!resolverPromise) {
    resolverPromise = import(PHASE1_RESOLVER_MODULE)
      .then((m) => {
        if (typeof m.resolveDialysisIsolation !== 'function') throw new Error('resolveDialysisIsolation export missing');
        return m.resolveDialysisIsolation;
      })
      .catch((err) => {
        resolverPromise = null;
        throw AppError.serviceUnavailable('Dialysis isolation resolver is not available on this build', 'RPD_ISOLATION_RESOLVER_UNAVAILABLE', { cause: err?.message || String(err) });
      });
  }
  return resolverPromise;
}

// `askedForClass` is what the caller passed, NOT what came back: the class is
// an invariant only when we asked for it (spec §3.3, §7.1).
export function assertDecision(decision, patientUid, askedForClass = false) {
  if (!decision || !DECISION_STATUSES.includes(decision.status)) {
    throw AppError.internal(`Isolation resolver returned no usable decision for ${patientUid}`, 'RPD_ISOLATION_DECISION_INVALID');
  }
  if (askedForClass && !('isolation_class' in decision)) {
    throw AppError.internal(`Isolation resolver omitted isolation_class for ${patientUid} although it was requested`, 'RPD_ISOLATION_DECISION_INVALID');
  }
  if (decision.isolation_class != null && !DECISION_ISOLATION_CLASSES.includes(decision.isolation_class)) {
    throw AppError.internal(`Isolation resolver returned an unknown isolation_class for ${patientUid}`, 'RPD_ISOLATION_DECISION_INVALID');
  }
  return decision;
}

// Batch: Map<patientUid, Decision>. Always pass the caller's tx client.
export async function isolationDecisionsTx(tx, { tenantId, patientUids, includeMarkers = false, includeIsolationClass = false }) {
  const tid = requireTenantId(tenantId);
  const uids = [...new Set((patientUids || []).map((u) => String(u)))];
  if (!uids.length) return new Map();
  const resolve = await loadResolver();
  const askedForClass = includeIsolationClass === true;
  const out = await resolve({ tenantId: tid, patientUids: uids, db: tx, includeMarkers: includeMarkers === true, includeIsolationClass: askedForClass });
  for (const uid of uids) assertDecision(out?.get?.(uid), uid, askedForClass);
  return out;
}

// Single uid: the per-session paths (schedule, start, reassign, capture, reprocess, session read).
// includeIsolationClass is passed by assessIsolationTx ONLY (D11 = NO, spec §3.3).
export async function isolationDecisionTx(tx, { tenantId, patientUid, includeMarkers = false, includeIsolationClass = false }) {
  const map = await isolationDecisionsTx(tx, { tenantId, patientUids: [patientUid], includeMarkers, includeIsolationClass });
  return map.get(String(patientUid));
}

// What gets FROZEN on a usage row (spec §3.3): the Decision minus marker detail
// AND minus the isolation class, unconditionally. A frozen screen is returned
// raw inside `usage` by GET /sessions/:id/dialyser, so a class left on it would
// publish a marker name to every dialysis role. D11 = NO removed the last
// in-process consumer of a frozen class (the exposure stamp), so there is no
// opt-out here and no argument to add one back: assessIsolationTx reads the
// class off the LIVE Decision and never stores it.
export function snapshotOf(decision) {
  if (!decision) return null;
  const { markers, isolation_class: cls, ...rest } = decision; // eslint-disable-line no-unused-vars
  return { ...rest, reasons: Array.isArray(rest.reasons) ? [...rest.reasons] : [] };
}

// Test seams. Unit tests install a named stub or point the module path at a
// missing file; the deep suite NEVER does either (it is skipped without Phase 1).
export function __stubDialysisIsolationResolver(fn) { stub = typeof fn === 'function' ? fn : null; resolverPromise = null; }
export function __setPhase1ResolverModuleForTests(path) { PHASE1_RESOLVER_MODULE = path; resolverPromise = null; }
export function __clearDialysisIsolationStubForTests() { stub = null; resolverPromise = null; PHASE1_RESOLVER_MODULE = './dialysisIsolationResolver.js'; }
```

```js
// apps/backend/src/tests/unit/dialysisIsolationAdapter.test.js
import { jest } from '@jest/globals';
import {
  __clearDialysisIsolationStubForTests, __setPhase1ResolverModuleForTests, __stubDialysisIsolationResolver,
  isolationDecisionTx, isolationDecisionsTx, snapshotOf,
} from '../../services/clinical/dialysisIsolationAdapter.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const A = '00000000-0000-4000-8000-00000000000a';
const decision = (over = {}) => ({ status: 'restricted', asOf: '2026-09-05T00:00:00.000Z', reasons: ['HBsAg reactive 2026-08-12'], evidence: 'marker', isolation_class: 'hbsag', ...over });
afterEach(() => __clearDialysisIsolationStubForTests());

test('calls the resolver with the tx client, the tenant and the uids; both opt-in flags are false unless told', async () => {
  const resolve = jest.fn(async ({ patientUids }) => new Map(patientUids.map((u) => [u, decision()])));
  __stubDialysisIsolationResolver(resolve);
  const tx = { tag: 'tx' };
  const out = await isolationDecisionTx(tx, { tenantId: TENANT, patientUid: A });
  expect(out.status).toBe('restricted');
  expect(resolve).toHaveBeenCalledWith({ tenantId: TENANT, patientUids: [A], db: tx, includeMarkers: false, includeIsolationClass: false });
  await isolationDecisionsTx(tx, { tenantId: TENANT, patientUids: [A, A], includeMarkers: true });
  expect(resolve).toHaveBeenLastCalledWith({ tenantId: TENANT, patientUids: [A], db: tx, includeMarkers: true, includeIsolationClass: false });
  await isolationDecisionTx(tx, { tenantId: TENANT, patientUid: A, includeIsolationClass: true });
  expect(resolve).toHaveBeenLastCalledWith({ tenantId: TENANT, patientUids: [A], db: tx, includeMarkers: false, includeIsolationClass: true });
});
// The contract dev-ea agreed (spec §3.3): the class is present only when asked
// for. A Decision without one is the NORMAL shape for every read surface, and
// asserting it into existence would re-create the rejected unconditional field.
test('with includeIsolationClass off, a Decision carrying no isolation_class is valid', async () => {
  const { isolation_class: _omit, ...classless } = decision(); // eslint-disable-line no-unused-vars
  __stubDialysisIsolationResolver(async () => new Map([[A, classless]]));
  const out = await isolationDecisionTx({}, { tenantId: TENANT, patientUid: A });
  expect(out.status).toBe('restricted');
  expect('isolation_class' in out).toBe(false);
});
test('with includeIsolationClass on, an absent isolation_class is refused', async () => {
  const { isolation_class: _omit, ...classless } = decision(); // eslint-disable-line no-unused-vars
  __stubDialysisIsolationResolver(async () => new Map([[A, classless]]));
  await expect(isolationDecisionTx({}, { tenantId: TENANT, patientUid: A, includeIsolationClass: true }))
    .rejects.toMatchObject({ code: 'RPD_ISOLATION_DECISION_INVALID' });
  // ...and an explicit null for a NON-restricted patient is fine when asked for.
  __stubDialysisIsolationResolver(async () => new Map([[A, decision({ status: 'clear', isolation_class: null })]]));
  expect((await isolationDecisionTx({}, { tenantId: TENANT, patientUid: A, includeIsolationClass: true })).isolation_class).toBeNull();
});
test('the frozen snapshot carries neither marker detail nor the isolation class, and copies reasons', () => {
  const d = decision({ markers: [{ marker: 'hbsag', result: 'reactive' }] });
  const snap = snapshotOf(d);
  expect(snap).toEqual({ status: 'restricted', asOf: d.asOf, reasons: d.reasons, evidence: 'marker' });
  expect('markers' in snap).toBe(false);
  expect('isolation_class' in snap).toBe(false);   // a frozen screen is published raw inside `usage` (§3.3)
  expect(snap.reasons).not.toBe(d.reasons);
  // D11 = NO: there is no opt-out. snapshotOf takes ONE argument and always
  // strips the class - a second argument must not resurrect it.
  expect(snapshotOf.length).toBe(1);
  expect('isolation_class' in snapshotOf(d, { keepClass: true })).toBe(false);
  expect(snapshotOf(null)).toBeNull();
});
test('a decision outside the three statuses, with an unknown class, or missing for a uid is refused', async () => {
  __stubDialysisIsolationResolver(async () => new Map([[A, decision({ status: 'isolated' })]]));
  await expect(isolationDecisionTx({}, { tenantId: TENANT, patientUid: A })).rejects.toMatchObject({ code: 'RPD_ISOLATION_DECISION_INVALID' });
  __stubDialysisIsolationResolver(async () => new Map([[A, decision({ isolation_class: 'hbv' })]]));
  await expect(isolationDecisionTx({}, { tenantId: TENANT, patientUid: A })).rejects.toMatchObject({ code: 'RPD_ISOLATION_DECISION_INVALID' });
  __stubDialysisIsolationResolver(async () => new Map());
  await expect(isolationDecisionTx({}, { tenantId: TENANT, patientUid: A })).rejects.toMatchObject({ code: 'RPD_ISOLATION_DECISION_INVALID' });
});
test('an empty uid list resolves to an empty map without calling the resolver', async () => {
  const resolve = jest.fn();
  __stubDialysisIsolationResolver(resolve);
  expect((await isolationDecisionsTx({}, { tenantId: TENANT, patientUids: [] })).size).toBe(0);
  expect(resolve).not.toHaveBeenCalled();
});
test('with no Phase 1 module the adapter fails closed (503 RPD_ISOLATION_RESOLVER_UNAVAILABLE), never answers', async () => {
  __setPhase1ResolverModuleForTests('./__no_such_resolver__.js');
  await expect(isolationDecisionTx({}, { tenantId: TENANT, patientUid: A })).rejects.toMatchObject({ code: 'RPD_ISOLATION_RESOLVER_UNAVAILABLE', statusCode: 503 });
});
```

Run: `npm test -- --testPathPatterns unit/dialysisIsolationAdapter` — Expected: PASS, 7 tests, no database, with or without Phase 1 on the checkout.

- [ ] **Step 2: Write `dialysisReuseService.js`**

```js
// apps/backend/src/services/clinical/dialysisReuseService.js
//
// Dialysis consumer of the reprocessable-device platform: dialyser capture with
// per-patient dedication, the un-capture on cancel, the ONE-command
// reprocessing record (post-use + reprocess, written onto the 418 statutory
// row), the isolation-machine warn rule, and the machine master.
//
// Spec: docs/superpowers/specs/2026-09-05-reprocessable-devices-platform-design.md §3.3, §3.4, §5.1.
//
// THIS MODULE WRITES NOTHING TO dialysis_patients.hbsag_status / hcv_status /
// hiv_status (pinned by tests/unit/dialysisSerologyWriters.test.js): the
// derivation is the Phase 1 lane's. Every dialysis decision here reads a LIVE
// Decision through dialysisIsolationAdapter - never the frozen reuse_screen,
// never resolveReuseStatus, never the columns.

import { setTenant, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { isolationDecisionTx, snapshotOf } from './dialysisIsolationAdapter.js';
import {
  ISOLATION_GROUP_MAX_LEN, REPROCESSING_AGENTS, applyDeviceTransitionTx, captureDeviceTx, categoryPolicyTx, cleanText,
  computeDispositionOptions, computeIsolationWarnings, dialysisExposureStamp, getDomainSettings,
  lockDeviceBySerialTx, lockDeviceByTagTx, lockDeviceTx, mintDeviceTx, nonNegativeInt, normalizeUsage, num, oneOf,
  positiveInt, recordReuseSafetyReview, requireUuid, returnDeviceTx, tcvVerdict, uncaptureDeviceTx,
} from './reprocessableDeviceService.js';

const tenantOr = (v) => requireTenantId(v);
const DOMAIN = 'dialysis';

async function auditTx(tx, { tenantId, action, resource, resourceId, context = {}, metadata = {} }) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`,
    tenantId, context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null, cleanText(context.actorRole, 50), action, resource, String(resourceId), JSON.stringify(metadata),
  );
}

// ---------------------------------------------------------------------------
// Machines (D3) and the isolation rule (§3.4)
// ---------------------------------------------------------------------------
const MACHINE_SELECT = `id, tenant_id, facility_id, machine_no, display_name, biomed_device_id, isolation_group, status, notes, created_by, updated_by, created_at, updated_at`;
// D11 = NO: a machine's routing key is the tenant's own label. NULL is a general
// machine; the platform validates the shape and never the vocabulary.
const machineGroup = (value) => { const text = cleanText(value, ISOLATION_GROUP_MAX_LEN); return text || null; };
export async function listMachines({ tenantId, status = null } = {}) {
  const tid = tenantOr(tenantId);
  const args = [tid]; const conds = ['tenant_id = $1::uuid'];
  if (status) { args.push(oneOf(status, ['active', 'out_of_service', 'retired'], 'status')); conds.push(`status = $${args.length}`); }
  return setTenant(tid, (tx) => tx.$queryRawUnsafe(`SELECT ${MACHINE_SELECT} FROM dialysis_machines WHERE ${conds.join(' AND ')} ORDER BY machine_no`, ...args));
}
export async function createMachine({ tenantId, ...body }, context = {}) {
  const tid = tenantOr(tenantId); const actor = requireUuid(context.actorUid, 'actorUid');
  const machineNo = cleanText(body.machine_no, 40); if (!machineNo) throw AppError.badRequest('machine_no is required', 'DIALYSIS_MACHINE_INVALID');
  const isolationGroup = machineGroup(body.isolation_group);
  return setTenantTx(tid, async (tx) => {
    const exists = await tx.$queryRawUnsafe(`SELECT id FROM dialysis_machines WHERE tenant_id = $1::uuid AND machine_no = $2`, tid, machineNo);
    if (exists[0]) throw AppError.conflict('machine_no already registered', 'DIALYSIS_MACHINE_NO_TAKEN');
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO dialysis_machines (tenant_id, facility_id, machine_no, display_name, biomed_device_id, isolation_group, status, notes, created_by, updated_by)
       VALUES ($1::uuid, $2::int, $3, $4, $5::int, $6, 'active', $7, $8::uuid, $8::uuid) RETURNING ${MACHINE_SELECT}`,
      tid, body.facility_id == null ? null : positiveInt(body.facility_id, 'facility_id'), machineNo, cleanText(body.display_name, 120), body.biomed_device_id == null ? null : positiveInt(body.biomed_device_id, 'biomed_device_id'), isolationGroup, cleanText(body.notes, 2000), actor,
    );
    await auditTx(tx, { tenantId: tid, action: 'dialysis.machine.created', resource: 'dialysis_machines', resourceId: rows[0].id, context, metadata: { machine_no: machineNo, isolation_group: isolationGroup, idempotency_key: context.idempotencyKey ?? null } });
    return rows[0];
  });
}
export async function updateMachine({ tenantId, id, ...body }, context = {}) {
  const tid = tenantOr(tenantId); const actor = requireUuid(context.actorUid, 'actorUid'); const machineId = positiveInt(id, 'id');
  return setTenantTx(tid, async (tx) => {
    const current = (await tx.$queryRawUnsafe(`SELECT ${MACHINE_SELECT} FROM dialysis_machines WHERE tenant_id = $1::uuid AND id = $2::int FOR UPDATE`, tid, machineId))[0];
    if (!current) throw AppError.notFound('Dialysis machine not found', 'DIALYSIS_MACHINE_NOT_FOUND');
    // `isolation_group: null` in the body means "make this a general machine";
    // an ABSENT key leaves the current label alone.
    const isolationGroup = Object.prototype.hasOwnProperty.call(body, 'isolation_group') ? machineGroup(body.isolation_group) : (current.isolation_group ?? null);
    const status = oneOf(body.status ?? current.status, ['active', 'out_of_service', 'retired'], 'status', 'DIALYSIS_MACHINE_INVALID');
    const rows = await tx.$queryRawUnsafe(
      `UPDATE dialysis_machines SET display_name = COALESCE($3, display_name), isolation_group = $4, status = $5, notes = COALESCE($6, notes), facility_id = COALESCE($7::int, facility_id), biomed_device_id = COALESCE($8::int, biomed_device_id), updated_by = $9::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int RETURNING ${MACHINE_SELECT}`,
      tid, machineId, cleanText(body.display_name, 120), isolationGroup, status, cleanText(body.notes, 2000), body.facility_id == null ? null : positiveInt(body.facility_id, 'facility_id'), body.biomed_device_id == null ? null : positiveInt(body.biomed_device_id, 'biomed_device_id'), actor,
    );
    await auditTx(tx, { tenantId: tid, action: 'dialysis.machine.updated', resource: 'dialysis_machines', resourceId: machineId, context, metadata: { from: { isolation_group: current.isolation_group, status: current.status }, to: { isolation_group: isolationGroup, status }, idempotency_key: context.idempotencyKey ?? null } });
    return rows[0];
  });
}

// The isolation read + rule with its two refusals, and NOTHING written. Reads a
// LIVE Decision (never a frozen snapshot: a marker recorded between capture and
// start must reach the machine assignment - spec §3.3). Used BEFORE
// scheduleSession's INSERT (so a block leaves no orphan scheduled row - today's
// scheduleSession inserts with the bare client outside any tx,
// dialysisService.js:466-481) and by evaluateIsolationForSessionTx for start and
// reassign, where the session row already exists.
// This is THE routing read and, since D11 = NO, the ONLY place in Plan 4 that
// passes includeIsolationClass: true (spec §3.3). The class is read, mapped to
// the tenant's routing GROUP through settings.isolation_groups, and dropped in
// this frame: the snapshot below strips it, the audit names the group, and what
// leaves the API is isolationPayload(), which has no class key at all (§3.4).
export async function assessIsolationTx(tx, { tenantId, patientUid, machineNo, overrideReason = null, requireReasonWhenWarned = false, context = {} }) {
  const tid = tenantOr(tenantId);
  const settings = await getDomainSettings({ tenantId: tid, domain: DOMAIN, db: tx });
  const decision = await isolationDecisionTx(tx, { tenantId: tid, patientUid, includeIsolationClass: true });
  const machine = machineNo ? (await tx.$queryRawUnsafe(`SELECT ${MACHINE_SELECT} FROM dialysis_machines WHERE tenant_id = $1::uuid AND machine_no = $2 AND status <> 'retired'`, tid, cleanText(machineNo, 40)))[0] || null : null;
  const verdict = computeIsolationWarnings({ decision, machine, isolationGroups: settings.isolation_groups, enforcement: settings.isolation_enforcement });
  const reason = cleanText(overrideReason, 2000);
  const actor = context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null;
  // The refusal names the GROUP, never the class or the marker: a routing role
  // learns THAT the machine is wrong and WHICH BAY to move to (D11 = NO, §2).
  if (verdict.blocked) {
    throw AppError.conflict(
      verdict.required_group ? `This patient must be dialysed on a machine in isolation group ${verdict.required_group}` : 'This patient must be dialysed on an isolation machine',
      'DIALYSIS_ISOLATION_MACHINE_BLOCKED', { codes: verdict.codes, required_group: verdict.required_group },
    );
  }
  if (requireReasonWhenWarned && verdict.codes.length && !reason) throw AppError.badRequest('isolation_override_reason is required when isolation warnings are present', 'DIALYSIS_ISOLATION_OVERRIDE_REQUIRED', { codes: verdict.codes });
  const overridden = verdict.codes.length > 0 && Boolean(reason);
  // dialysis_sessions_isolation_override_check: reason, by and at are
  // all-or-nothing, so an override without a named actor cannot be stored.
  if (overridden && !actor) throw AppError.badRequest('isolation_override_reason must be recorded by a named actor', 'DIALYSIS_ISOLATION_OVERRIDE_REQUIRED', { codes: verdict.codes });
  return {
    codes: verdict.codes, required_group: verdict.required_group, blocked: false,   // the GROUP is publishable; there is no class field to leak
    machine_id: machine?.id ?? null, enforcement: settings.isolation_enforcement,
    warn_only: settings.isolation_enforcement === 'warn', enforcement_enabled: settings.isolation_enforcement === 'block',
    override: overridden ? { reason, by: actor } : null, decision: snapshotOf(decision), machine_no: machineNo || null,
  };
}

// The ONE serialiser for everything this lane returns under `isolation` (spec
// §3.4, D11 = NO). Each warning carries the tenant's required GROUP - a bay
// label every dialysis role may read - and there is no other way to build the
// payload, so a future caller cannot forget and cannot invent a class key: the
// internal object has none to copy.
export function isolationPayload(isolation, { severityFor = (code) => (code === 'DIALYSIS_ISOLATION_MACHINE_MISMATCH' && isolation.enforcement_enabled ? 'block' : 'warn') } = {}) {
  const codes = isolation?.codes || [];
  const requiredGroup = isolation?.required_group ?? null;
  return {
    codes,
    isolation_warnings: codes.map((code) => ({
      code,
      machine_id: code === 'DIALYSIS_MACHINE_UNREGISTERED' ? null : (isolation.machine_id ?? null),
      severity: severityFor(code),
      // null on DIALYSIS_GENERAL_PATIENT_ON_ISOLATION_MACHINE (a clear patient
      // needs no bay) and whenever the tenant has not mapped the class.
      required_group: code === 'DIALYSIS_GENERAL_PATIENT_ON_ISOLATION_MACHINE' ? null : requiredGroup,
    })),
    warn_only: isolation.warn_only, enforcement_enabled: isolation.enforcement_enabled, override: isolation.override ?? null,
  };
}

export async function recordIsolationAuditTx(tx, { tenantId, session, isolation, context = {} }) {
  // The Decision's status / evidence / asOf are audited beside the required
  // GROUP; its reasons, its markers and the marker CLASS never are (spec §7.2,
  // D11 = NO - the class is written nowhere, audit_logs included). `isolation
  // .decision` is a snapshotOf() result and carries no class to write by
  // accident, which is why this reads three named fields and not a spread.
  const d = isolation.decision || {};
  await auditTx(tx, { tenantId: tenantOr(tenantId), action: isolation.override ? 'dialysis.session.isolation_overridden' : 'dialysis.session.isolation_evaluated', resource: 'dialysis_sessions', resourceId: session.id, context, metadata: { codes: isolation.codes, required_group: isolation.required_group, machine_no: isolation.machine_no, enforcement: isolation.enforcement, decision: { status: d.status ?? null, evidence: d.evidence ?? null, as_of: d.asOf ?? null }, override_reason: isolation.override?.reason ?? null } });
}

// Called by startSession / PATCH /sessions/:id/machine inside THEIR transaction
// with the session row locked: assess, then persist codes + mode pair onto the
// existing row. Requires the override reason when warnings exist at START;
// blocks under 'block'. (scheduleSession calls assessIsolationTx directly and
// writes the result in its INSERT - Step 3(a).)
//
// This is the machine-routing path, and its assessIsolationTx call is the ONE
// place in Plan 4 that asks the Phase 1 resolver for isolation_class (D11 = NO).
// It returns the INTERNAL isolation object; every route serialises it through
// isolationPayload() before it reaches a client (spec §3.4).
export async function evaluateIsolationForSessionTx(tx, { tenantId, session, patientUid, machineNo, overrideReason = null, requireReasonWhenWarned = false, context = {} }) {
  const tid = tenantOr(tenantId);
  const isolation = await assessIsolationTx(tx, { tenantId: tid, patientUid, machineNo, overrideReason, requireReasonWhenWarned, context });
  await tx.$executeRawUnsafe(
    `UPDATE dialysis_sessions SET isolation_warning_codes = $3::text[], isolation_warn_only = $4::boolean, isolation_enforcement_enabled = $5::boolean,
            isolation_required_group = $8::varchar,
            isolation_override_reason = CASE WHEN $6::text IS NULL THEN isolation_override_reason ELSE $6::text END,
            isolation_override_by = CASE WHEN $6::text IS NULL THEN isolation_override_by ELSE $7::uuid END,
            isolation_override_at = CASE WHEN $6::text IS NULL THEN isolation_override_at ELSE NOW() END,
            isolation_evaluated_at = NOW(), updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    tid, session.id, isolation.codes, isolation.warn_only, isolation.enforcement_enabled, isolation.override?.reason ?? null, isolation.override?.by ?? null, isolation.required_group ?? null,
  );
  await recordIsolationAuditTx(tx, { tenantId: tid, session, isolation, context });
  return isolation;
}

// ---------------------------------------------------------------------------
// Capture (§5.1)
// ---------------------------------------------------------------------------
async function lockSessionTx(tx, tenantId, sessionId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT s.id, s.status, s.machine_no, s.dialyser, s.reuse_count, s.dialysis_patient_id, s.actual_start_at, p.patient_uid
       FROM dialysis_sessions s JOIN dialysis_patients p ON p.id = s.dialysis_patient_id AND p.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1::uuid AND s.id = $2::int FOR UPDATE OF s`, tenantId, positiveInt(sessionId, 'session_id'));
  if (!rows[0]) throw AppError.notFound('Session not found', 'DIALYSIS_SESSION_NOT_FOUND');
  return rows[0];
}
// THE session's usage - one row per session (partial unique), returned open OR
// closed; callers read returned_at. A cancelled session keeps its closed
// 'cancelled_before_use' row, which is what blocks a second capture on it.
async function usageForSessionTx(tx, tenantId, sessionId) {
  const rows = await tx.$queryRawUnsafe(`SELECT * FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND dialysis_session_id = $2::int FOR UPDATE`, tenantId, sessionId);
  return normalizeUsage(rows[0] || null);
}
async function linkForDeviceTx(tx, tenantId, deviceId) {
  return (await tx.$queryRawUnsafe(`SELECT device_id, dedicated_patient_uid, dedicated_at, dedicated_by, baseline_tcv_ml, baseline_tcv_measured_at FROM reprocessable_device_dialysis_links WHERE tenant_id = $1::uuid AND device_id = $2::bigint FOR UPDATE`, tenantId, deviceId))[0] || null;
}

async function captureTx(tx, { tid, session, body, captureSource, context }) {
  const policy = await categoryPolicyTx(tx, tid, DOMAIN, 'dialyser');
  if (!policy?.reprocessable) throw AppError.conflict('Dialyser reuse is not enabled for this tenant', 'RPD_POLICY_NOT_REPROCESSABLE');
  if (!['scheduled', 'in_progress'].includes(session.status)) throw AppError.conflict(`Session is ${session.status}`, 'DIALYSIS_SESSION_NOT_OPEN');
  if (await usageForSessionTx(tx, tid, session.id)) throw AppError.conflict('This session already has a dialyser captured', 'DIALYSER_ALREADY_CAPTURED');
  const settings = await getDomainSettings({ tenantId: tid, domain: DOMAIN, db: tx });
  const serial = cleanText(body.manufacturer_serial, 120);
  const tag = cleanText(body.device_tag, 24);
  if ((serial && tag) || (!serial && !tag)) throw AppError.badRequest('exactly one of manufacturer_serial or device_tag is required', 'RPD_IDENTITY_REQUIRED');
  const baseline = body.baseline_tcv_ml == null || body.baseline_tcv_ml === '' ? null : Number(body.baseline_tcv_ml);
  if (baseline !== null && (!Number.isFinite(baseline) || baseline <= 0)) throw AppError.badRequest('baseline_tcv_ml must be a positive number', 'DIALYSER_TCV_INVALID');
  let device = tag ? await lockDeviceByTagTx(tx, tid, tag) : await lockDeviceBySerialTx(tx, tid, DOMAIN, serial);
  if (device && device.domain !== DOMAIN) throw AppError.conflict('That tag belongs to another department', 'RPD_DOMAIN_MISMATCH');
  let link = device ? await linkForDeviceTx(tx, tid, device.id) : null;
  if (!device) {
    device = await mintDeviceTx(tx, { tenantId: tid, domain: DOMAIN, category: 'dialyser', enrolledVia: 'session_capture', manufacturerSerial: serial, hospitalAssetId: cleanText(body.hospital_asset_id, 120), manufacturer: cleanText(body.manufacturer, 120), modelName: cleanText(body.model_name, 120), initialCycleCount: body.initial_cycle_count ?? 0, maxCycles: policy.max_cycles, context });
  }
  if (!link) {
    // $5 appears twice (the NUMERIC value and the NULL test): cast at both sites.
    await tx.$executeRawUnsafe(`INSERT INTO reprocessable_device_dialysis_links (tenant_id, device_id, dedicated_patient_uid, dedicated_by, baseline_tcv_ml, baseline_tcv_measured_at) VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid, $5::numeric, CASE WHEN $5::numeric IS NULL THEN NULL ELSE NOW() END)`, tid, device.id, session.patient_uid, requireUuid(context.actorUid, 'actorUid'), baseline);
    link = await linkForDeviceTx(tx, tid, device.id);
  } else if (link.dedicated_patient_uid !== session.patient_uid) {
    throw AppError.conflict('This dialyser is dedicated to another patient', 'DIALYSER_DEDICATED_TO_ANOTHER_PATIENT');
  } else if (baseline !== null && link.baseline_tcv_ml == null) {
    await tx.$executeRawUnsafe(`UPDATE reprocessable_device_dialysis_links SET baseline_tcv_ml = $3::numeric, baseline_tcv_measured_at = NOW(), updated_at = NOW() WHERE tenant_id = $1::uuid AND device_id = $2::bigint`, tid, device.id, baseline);
  }
  // The EVIDENCE SNAPSHOT (spec §3.3): what the capturing user saw, frozen once
  // as reuse_screen. It is never re-read for a decision - the reprocessing
  // record and the isolation rule re-resolve live.
  const screen = snapshotOf(await isolationDecisionTx(tx, { tenantId: tid, patientUid: session.patient_uid }));
  const samePatient = link.dedicated_patient_uid === session.patient_uid;
  let acknowledgement = null;
  if (device.exposure_flag && !samePatient) {
    if (settings.reactive_patient_rule !== 'override_allowed') throw AppError.conflict('Device carries a blood-borne exposure flag', 'RPD_EXPOSURE_BLOCKED', { exposure_markers: device.exposure_markers });
    acknowledgement = cleanText(body.exposure_acknowledgement?.reason, 2000);
    if (!acknowledgement) throw AppError.badRequest('exposure_acknowledgement.reason is required', 'RPD_ACKNOWLEDGEMENT_REQUIRED');
    await recordReuseSafetyReview(tx, { tenantId: tid, patientUid: session.patient_uid, domain: DOMAIN, findingCode: 'EXPOSED_DEVICE_REUSED', message: `Exposed dialyser ${device.device_tag} captured`, reason: acknowledgement, actorUid: context.actorUid, payload: { device_id: device.id } });
  }
  const { usage, device: settled } = await captureDeviceTx(tx, { device, patientUid: session.patient_uid, owner: { dialysisSessionId: session.id }, captureSource, reuseScreen: screen, acknowledgementReason: acknowledgement, metadata: device.exposure_flag && samePatient ? { exposure_same_patient: true } : {}, context });
  await tx.$executeRawUnsafe(`UPDATE dialysis_sessions SET dialyser = $3, reuse_count = $4::int, updated_at = NOW() WHERE tenant_id = $1::uuid AND id = $2::int`, tid, session.id, settled.model_name || settled.manufacturer_serial, usage.reuse_cycle);
  return { usage, device: settled, link, restriction: screen, settings, policy };
}

export async function captureDialyser({ tenantId, sessionId, ...body }, context = {}) {
  const tid = tenantOr(tenantId); requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const session = await lockSessionTx(tx, tid, sessionId);
    const out = await captureTx(tx, { tid, session, body, captureSource: context.captureSource || 'staff_app', context });
    return { usage: out.usage, device: out.device, link: out.link, reuse_restriction: out.restriction };
  });
}

// ---------------------------------------------------------------------------
// Cancel (§5.1 Cancel): a SCHEDULED session that is cancelled or marked no-show
// releases its captured dialyser; anything else refuses, and the refusal fails
// the cancel. Called by dialysisService.cancelSession inside ITS transaction
// with the session row locked, BEFORE the status UPDATE (Step 3(d)). Needs no
// resolver: releasing a never-used device is not a serology decision.
// ---------------------------------------------------------------------------
export async function onSessionCancelledTx(tx, { tenantId, session, target, context = {} }) {
  const tid = tenantOr(tenantId);
  const usage = await usageForSessionTx(tx, tid, session.id);
  if (!usage) return null;                                  // nothing captured, or the feature is dark
  const device = await lockDeviceTx(tx, tid, usage.device_id);
  // in_progress (actual_start_at set) = blood contact happened or cannot be
  // ruled out. The usage table has no contact-time column - 418's
  // disinfectant_contact_minutes is reprocessing time, not patient contact - so
  // the session's own state is the contact signal. uncaptureDeviceTx refuses
  // a closed usage / a 418 row (RPD_USAGE_NOT_CANCELLABLE) before it looks at
  // partialUse (RPD_RETURN_REQUIRED); only a never-started session releases.
  const partialUse = session.status === 'in_progress' || session.actual_start_at != null;
  const released = await uncaptureDeviceTx(tx, { device, usage, partialUse, cancelTarget: target, metadata: { dialysis_session_id: num(session.id) }, context });
  // reuse_count claimed a cycle that never ran. The dialyser text is left:
  // nothing reads it on a cancelled session.
  await tx.$executeRawUnsafe(`UPDATE dialysis_sessions SET reuse_count = NULL, updated_at = NOW() WHERE tenant_id = $1::uuid AND id = $2::int`, tid, session.id);
  return released;
}

export async function getSessionDialyser({ tenantId, sessionId }) {
  const tid = tenantOr(tenantId);
  return setTenant(tid, async (tx) => {
    const session = (await tx.$queryRawUnsafe(`SELECT s.id, s.status, s.machine_no, s.isolation_warning_codes, s.isolation_required_group, s.isolation_warn_only, s.isolation_enforcement_enabled, s.isolation_override_reason, s.isolation_override_by, s.isolation_override_at, p.patient_uid FROM dialysis_sessions s JOIN dialysis_patients p ON p.id = s.dialysis_patient_id AND p.tenant_id = s.tenant_id WHERE s.tenant_id = $1::uuid AND s.id = $2::int`, tid, positiveInt(sessionId, 'session_id')))[0];
    if (!session) throw AppError.notFound('Session not found', 'DIALYSIS_SESSION_NOT_FOUND');
    const settings = await getDomainSettings({ tenantId: tid, domain: DOMAIN, db: tx });
    const policy = await categoryPolicyTx(tx, tid, DOMAIN, 'dialyser');
    // LIVE decision for the read (spec §3.3); the usage row's reuse_screen is
    // history and is returned inside `usage`, not here. This is a READ surface:
    // it passes NEITHER includeMarkers NOR includeIsolationClass, so the
    // Decision it publishes has no class key to leak in the first place.
    const decision = snapshotOf(await isolationDecisionTx(tx, { tenantId: tid, patientUid: session.patient_uid }));
    const usage = normalizeUsage((await tx.$queryRawUnsafe(`SELECT * FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND dialysis_session_id = $2::int`, tid, session.id))[0] || null);
    const device = usage ? await lockDeviceTx(tx, tid, usage.device_id).catch(() => null) : null;
    const link = device ? (await tx.$queryRawUnsafe(`SELECT dedicated_patient_uid, baseline_tcv_ml FROM reprocessable_device_dialysis_links WHERE tenant_id = $1::uuid AND device_id = $2::bigint`, tid, device.id))[0] || null : null;
    const options = usage && device ? computeDispositionOptions({ domain: DOMAIN, usage, policy, settings, restriction: decision, device }) : null;
    // The warnings are read back from the session row, where the routing path
    // persisted them; this read does not re-run the rule and carries no class
    // (spec §3.4). machine_id and the machine's own isolation_group come from the
    // session's machine_no; both are null when the machine is not registered.
    // The required_group is re-derived from the tenant map and the LIVE decision
    // WITHOUT asking for a class: the decision here has none, so the read falls
    // back to the machine's own group, which is equipment data (D11 = NO).
    const machine = session.machine_no ? (await tx.$queryRawUnsafe(`SELECT id, isolation_group FROM dialysis_machines WHERE tenant_id = $1::uuid AND machine_no = $2 AND status <> 'retired'`, tid, session.machine_no))[0] || null : null;
    const isolation = isolationPayload({
      codes: session.isolation_warning_codes || [], machine_id: machine?.id ?? null, required_group: session.isolation_required_group ?? null,
      warn_only: session.isolation_warn_only, enforcement_enabled: session.isolation_enforcement_enabled,
      override: session.isolation_override_reason ? { reason: session.isolation_override_reason, by: session.isolation_override_by, at: session.isolation_override_at } : null,
    });
    return { usage, device, link, reuse_restriction: decision, allowed_dispositions: options, isolation, policy_enabled: Boolean(policy?.reprocessable) };
  });
}

// ---------------------------------------------------------------------------
// The one-command reprocessing record (§5.1) - called by dialysisService.recordReuseRegister
// ---------------------------------------------------------------------------
const INTEGRITY = ['pending', 'pass', 'fail', 'not_done'];
export async function recordDialyserReprocessing({ tenantId, sessionId, body, normalized, context, legacyWrite }) {
  const tid = tenantOr(tenantId);
  return setTenantTx(tid, async (tx) => {
    const policy = await categoryPolicyTx(tx, tid, DOMAIN, 'dialyser');
    const session = await lockSessionTx(tx, tid, sessionId);
    if (!policy?.reprocessable) return legacyWrite(tx, session);            // dark: byte-for-byte 418 behaviour, no resolver touched
    let usage = await usageForSessionTx(tx, tid, session.id);
    let device = usage ? await lockDeviceTx(tx, tid, usage.device_id) : null;
    if (!usage) {
      if (!body.dialyzer_serial) throw AppError.badRequest('dialyzer_serial required', 'DIALYSER_SERIAL_REQUIRED');
      const captured = await captureTx(tx, { tid, session, body: { manufacturer_serial: body.dialyzer_serial, model_name: session.dialyser, baseline_tcv_ml: body.baseline_tcv_ml }, captureSource: 'system', context });
      usage = captured.usage; device = captured.device;
    }
    // normalized.reuseCycleCount is null when the body omitted the count
    // (validateReuseRegisterInput ran with requireCycleCount: false, Step 3(c));
    // a typed count must equal the device's, or the write is refused.
    if (normalized.reuseCycleCount !== null && normalized.reuseCycleCount !== usage.reuse_cycle) throw AppError.conflict('reuse_cycle_count is derived from the device', 'DIALYZER_REUSE_CYCLE_DERIVED', { device_cycle: usage.reuse_cycle, typed: normalized.reuseCycleCount });
    const existing = (await tx.$queryRawUnsafe(`SELECT * FROM dialyzer_reuse_register WHERE tenant_id = $1::uuid AND session_id = $2::int FOR UPDATE`, tid, session.id))[0] || null;
    if (usage.returned_at) {
      // Settled: notes may still be edited; anything else is a second, different write.
      const same = existing && existing.status === normalized.status && existing.integrity_test_result === normalized.integrity && String(existing.discard_reason || '') === String(normalized.discardReason || '');
      if (!same) throw AppError.conflict('The reuse register for this session is settled', 'DIALYZER_REUSE_REGISTER_SETTLED', { status: existing?.status || null });
      const rows = await tx.$queryRawUnsafe(`UPDATE dialyzer_reuse_register SET notes = COALESCE($3, notes), updated_at = NOW() WHERE tenant_id = $1::uuid AND session_id = $2::int RETURNING *`, tid, session.id, cleanText(body.notes, 2000));
      return rows[0];
    }
    const settings = await getDomainSettings({ tenantId: tid, domain: DOMAIN, db: tx });
    // RE-RESOLVE, live (spec §3.3). The frozen usage.reuse_screen is NOT the
    // input here: a marker recorded between capture and this command must
    // change the disposition. What we act on is frozen afterwards as
    // post_use_screen. This path asks for NO class (D11 = NO): its two former
    // consumers - the exposure_markers stamp and the exposure_isolation_class
    // metadata - are retired, computeDispositionOptions reads only
    // restriction.status, and dedication is keyed on dedicated_patient_uid. One
    // asker remains in the lane, assessIsolationTx, and the textual pin in Step
    // 5 counts it.
    const decision = snapshotOf(await isolationDecisionTx(tx, { tenantId: tid, patientUid: session.patient_uid }));
    const options = computeDispositionOptions({ domain: DOMAIN, usage, policy, settings, restriction: decision, device });
    const disposition = normalized.status === 'in_use' ? 'reprocess' : normalized.status === 'quarantined' ? 'quarantine' : 'discard';
    const acknowledgement = cleanText(body.acknowledgement?.reason, 2000);
    if (disposition === 'reprocess' && options.blocked_code) throw AppError.conflict('Serology must be on record before this dialyser is reprocessed', options.blocked_code, { allowed: options.dispositions });
    // Integrity + TCV verdicts decide what "reprocess" lands on.
    const link = await linkForDeviceTx(tx, tid, device.id);
    const agent = body.reprocessing_agent == null ? null : oneOf(body.reprocessing_agent, REPROCESSING_AGENTS, 'reprocessing_agent', 'DIALYZER_REUSE_AGENT_INVALID');
    const measured = body.measured_tcv_ml == null || body.measured_tcv_ml === '' ? null : Number(body.measured_tcv_ml);
    if (measured !== null && (!Number.isFinite(measured) || measured <= 0)) throw AppError.badRequest('measured_tcv_ml must be a positive number', 'DIALYSER_TCV_INVALID');
    const contact = body.disinfectant_contact_minutes == null || body.disinfectant_contact_minutes === '' ? null : nonNegativeInt(body.disinfectant_contact_minutes, 'disinfectant_contact_minutes', { max: 1440 });
    const tcv = tcvVerdict({ baseline: link?.baseline_tcv_ml, measured, minPct: policy.tcv_min_pct ?? 80 });
    let discardReason = normalized.discardReason ? 'other' : null;
    let finalDisposition = disposition;
    let integrity = oneOf(normalized.integrity, INTEGRITY, 'integrity_test_result', 'DIALYZER_REUSE_INTEGRITY_INVALID');
    if (disposition === 'reprocess' && integrity === 'fail') { finalDisposition = 'discard'; discardReason = 'integrity_test_failed'; }
    else if (disposition === 'reprocess' && !tcv.ok) { finalDisposition = 'discard'; discardReason = 'tcv_below_threshold'; }
    if (finalDisposition === 'discard' && !discardReason) discardReason = options.discard_reason || 'other';
    if (finalDisposition === 'reprocess' && options.requires_acknowledgement) {
      if (!acknowledgement) throw AppError.badRequest('acknowledgement.reason is required', 'RPD_ACKNOWLEDGEMENT_REQUIRED', { reason_codes: options.reason_codes });
      await recordReuseSafetyReview(tx, { tenantId: tid, patientUid: session.patient_uid, domain: DOMAIN, findingCode: options.exposure ? 'BLOODBORNE_RESTRICTED_OVERRIDE' : 'SEROLOGY_UNKNOWN_ACKNOWLEDGED', message: `Dialyser ${device.device_tag} reprocessed under acknowledgement`, reason: acknowledgement, actorUid: context.actorUid, payload: { device_id: device.id, usage_id: usage.id } });
    }
    const allowed = finalDisposition === 'discard' && !options.dispositions.includes('discard') ? [...options.dispositions, 'discard'] : options.dispositions;
    // D11 = NO: the dialysis stamp is the FLAG alone. The empty list is passed
    // explicitly rather than left null, because returnDeviceTx's null branch
    // falls back to deriving markers from the screen - which is right for OT and
    // would be a marker name on a dialysis device (spec §3.3, §2 D11(e)).
    const { exposure_markers: exposureMarkers } = dialysisExposureStamp(decision);
    const deviceMetadata = {};
    const returned = await returnDeviceTx(tx, { device, usage, disposition: finalDisposition, postUseScreen: snapshotOf(decision), options: { ...options, dispositions: allowed }, discardReason, discardNote: cleanText(normalized.discardReason || body.notes, 2000), acknowledgementReason: acknowledgement, exposureMarkers, deviceMetadata, context });
    let settled = returned.device;
    if (finalDisposition === 'reprocess') settled = await applyDeviceTransitionTx(tx, settled, 'reprocessed', { cycleType: 'chemical', functionCheck: 'pass', note: body.notes }, context);
    const registerStatus = finalDisposition === 'reprocess' ? 'in_use' : finalDisposition === 'quarantine' ? 'quarantined' : 'discarded';
    const registerDiscard = finalDisposition === 'discard' ? (normalized.discardReason || discardReason) : null;
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO dialyzer_reuse_register
         (tenant_id, session_id, dialysis_patient_id, patient_uid, dialyzer_serial, reuse_cycle_count, session_reuse_count, integrity_test_result, integrity_test_method,
          disinfectant, processed_by, status, discard_reason, notes, device_id, device_usage_id, measured_tcv_ml, tcv_pct_of_baseline, reprocessing_agent, disinfectant_contact_minutes, disinfectant_concentration_pct)
       VALUES ($1::uuid, $2::int, $3::int, $4::uuid, $5, $6::int, $6::int, $7, $8, $9, $10::uuid, $11, $12, $13, $14::bigint, $15::bigint, $16, $17, $18, $19::int, $20)
       ON CONFLICT (tenant_id, session_id) DO UPDATE SET
         dialyzer_serial = EXCLUDED.dialyzer_serial, reuse_cycle_count = EXCLUDED.reuse_cycle_count, session_reuse_count = EXCLUDED.session_reuse_count,
         integrity_test_result = EXCLUDED.integrity_test_result, integrity_test_method = EXCLUDED.integrity_test_method, disinfectant = EXCLUDED.disinfectant,
         processed_by = EXCLUDED.processed_by, processed_at = NOW(), status = EXCLUDED.status, discard_reason = EXCLUDED.discard_reason, notes = EXCLUDED.notes,
         device_id = EXCLUDED.device_id, device_usage_id = EXCLUDED.device_usage_id, measured_tcv_ml = EXCLUDED.measured_tcv_ml, tcv_pct_of_baseline = EXCLUDED.tcv_pct_of_baseline,
         reprocessing_agent = EXCLUDED.reprocessing_agent, disinfectant_contact_minutes = EXCLUDED.disinfectant_contact_minutes, disinfectant_concentration_pct = EXCLUDED.disinfectant_concentration_pct, updated_at = NOW()
       RETURNING *`,
      tid, session.id, session.dialysis_patient_id, session.patient_uid, settled.manufacturer_serial, usage.reuse_cycle, integrity, cleanText(body.integrity_test_method, 120),
      cleanText(body.disinfectant, 80), context.actorUid, registerStatus, registerDiscard, cleanText(body.notes, 2000), settled.id, usage.id, measured, tcv.pct, agent, contact,
      body.disinfectant_concentration_pct == null || body.disinfectant_concentration_pct === '' ? null : Number(body.disinfectant_concentration_pct),
    );
    await auditTx(tx, { tenantId: tid, action: 'dialysis.reuse_register.recorded', resource: 'dialyzer_reuse_register', resourceId: rows[0].id, context, metadata: { session_id: session.id, device_tag: settled.device_tag, disposition: returned.disposition, tcv_pct: tcv.pct, integrity, decision_status: decision.status, idempotency_key: context.idempotencyKey ?? null } });
    return { ...rows[0], device: settled, disposition: returned.disposition };
  });
}
```

(`$6` appears twice in the register INSERT — cast `::int` at both; the same discipline as Task 3.) `returnDeviceTx` takes the two new optional fields `exposureMarkers` / `deviceMetadata` — Task 3's signature note names them; when absent it derives the markers from the screen exactly as before, which is what OT still does.

- [ ] **Step 3: Wire `dialysisService.js`**

(a) `scheduleSession` (:440–481): the reads above the INSERT (`getDialysisPatientInTenant`, the active access, the active prescription) stay as they are. From `const sql = \`INSERT INTO dialysis_sessions` to the end of the function, replace with — the isolation rule is assessed **before** the insert inside one transaction, and the INSERT carries the result, so a `block` refusal leaves no orphan row:

```js
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    // NNN: assess BEFORE the insert (a block must leave no orphan scheduled
    // row); nothing to assess without a machine. Live Decision (spec §3.3).
    const isolation = body.machine_no
      ? await assessIsolationTx(tx, { tenantId, patientUid: patient.patient_uid, machineNo: body.machine_no, overrideReason: body.isolation_override_reason, requireReasonWhenWarned: false, context: { actorUid: body.actorUid || body.conducted_by || null, actorRole: body.actorRole || null } })
      : null;
    const sql = `
      INSERT INTO dialysis_sessions
        (dialysis_patient_id, vascular_access_id, session_date,
         machine_no, station_no, modality, dialyser, reuse_count,
         scheduled_start_at, prescribed_uf_l, anticoag,
         anticoag_initial_dose, anticoag_maintenance,
         status, conducted_by, supervised_by, prescription_id, tenant_id,
         isolation_warning_codes, isolation_warn_only, isolation_enforcement_enabled,
         isolation_override_reason, isolation_override_by, isolation_override_at, isolation_evaluated_at,
         isolation_required_group)
      VALUES ($1, $2, $3::date,
              $4, $5, $6, $7, $8,
              $9::timestamptz, $10, $11, $12, $13,
              'scheduled', $14, $15, $16, $17,
              $18::text[], $19::boolean, $20::boolean,
              $21::text, $22::uuid, CASE WHEN $21::text IS NULL THEN NULL ELSE NOW() END,
              CASE WHEN $23::boolean THEN NOW() ELSE NULL END,
              $24::varchar)
      RETURNING *`;
    const rows = await tx.$queryRawUnsafe(sql,
      patient.id, accessId,
      body.session_date, body.machine_no || null, body.station_no || null,
      body.modality || rx?.modality || 'hd',
      body.dialyser || rx?.dialyser || null, body.reuse_count || null,
      body.scheduled_start_at || null,
      body.prescribed_uf_l ?? (rx?.max_uf_ml_per_session ? rx.max_uf_ml_per_session / 1000 : null),
      body.anticoag || rx?.anticoag || null,
      body.anticoag_initial_dose || rx?.anticoag_loading || null,
      body.anticoag_maintenance || rx?.anticoag_maintenance || null,
      body.conducted_by || null, body.supervised_by || null,
      rx?.id || null,
      tenantOr(tenantId),
      isolation?.codes ?? [], isolation ? isolation.warn_only : true, isolation ? isolation.enforcement_enabled : false,
      isolation?.override?.reason ?? null, isolation?.override?.by ?? null, Boolean(isolation), isolation?.required_group ?? null);
    const row = unwrap(rows);
    if (isolation) await recordIsolationAuditTx(tx, { tenantId, session: row, isolation, context: { actorUid: body.actorUid || body.conducted_by || null, actorRole: body.actorRole || null } });
    // isolationPayload() is what leaves the process. The internal object carries
    // required_group - a bay label, publishable - and no class at all: under
    // D11 = NO nothing anywhere may name a marker class (spec §2, §3.4).
    return { ...row, isolation: isolation ? isolationPayload(isolation) : null };
  });
```

(`$21` appears twice, cast at both; `assessIsolationTx` / `recordIsolationAuditTx` / `isolationPayload` imported from `./dialysisReuseService.js`.) **Behaviour on a build without Phase 1:** with `machine_no` present this path now calls the resolver and fails closed with `RPD_ISOLATION_RESOLVER_UNAVAILABLE` — which is why Step 0b gates this step, and why the plan's Task 9 merges nothing until Phase 1 is on `main`.

(b) `startSession` becomes a `setTenantTx` that locks the session with its patient, runs the status transition UPDATE as today, then `await evaluateIsolationForSessionTx(tx, { tenantId, session: row, patientUid: sess.patient_uid, machineNo: body.machine_no ?? row.machine_no, overrideReason: body.isolation_override_reason, requireReasonWhenWarned: true, context })` where `context` is `{ actorUid: body.started_by || null, actorRole: body.actorRole || null }` (the route passes `started_by: req.user?.uid, actorRole: req.user?.role`). The returned row carries `isolation: isolationPayload(isolation)` — never the internal object, which additionally holds the `Decision` snapshot and the enforcement mode for the audit. The same applies to `PATCH /sessions/:id/machine` (§6.1).

(c) `validateReuseRegisterInput` (:33) gains an option — the count is required on the legacy path and optional when a dialyser policy exists (the device derives it; every deep call below omits it):

```js
export function validateReuseRegisterInput(body = {}, { requireCycleCount = true } = {}) {
  const rawCount = body.reuse_cycle_count ?? body.cycle_count;
  const countAbsent = rawCount === undefined || rawCount === null || rawCount === '';
  const reuseCycleCount = countAbsent ? null : intOrNull(rawCount);
  if ((countAbsent && requireCycleCount)
      || (!countAbsent && (!Number.isInteger(reuseCycleCount) || reuseCycleCount < 0 || reuseCycleCount > 100))) {
    throw AppError.badRequest('reuse_cycle_count must be an integer from 0 to 100', 'DIALYZER_REUSE_CYCLE_INVALID');
  }
  // ... integrity / status / discardReason / failed-in-use checks unchanged ...
  return { reuseCycleCount, integrity, status, discardReason };
}
```

(the default keeps today's behaviour for every existing caller and test). Then `recordReuseRegister({ tenantId, session_id, processed_by, ...body })` — keep the export name; its body becomes:

```js
export async function recordReuseRegister({ tenantId, session_id, processed_by, ...body }) {
  if (!session_id) throw AppError.badRequest('session_id required');
  // NNN: the cycle count is DERIVED when a dialyser policy exists, so it is
  // optional here; the legacy path re-validates with the count required.
  const normalized = validateReuseRegisterInput(body, { requireCycleCount: false });

  // The pre-NNN behaviour, byte for byte, run by recordDialyserReprocessing
  // when no reprocessable dialyser policy exists. `sess` is the row it locked.
  const legacyWrite = async (tx, sess) => {
    if (!body.dialyzer_serial) throw AppError.badRequest('dialyzer_serial required');
    const legacy = validateReuseRegisterInput(body, { requireCycleCount: true });
    if (sess.reuse_count != null && Number(sess.reuse_count) !== legacy.reuseCycleCount) {
      throw AppError.badRequest(
        'reuse_cycle_count must match the session reuse_count',
        'DIALYZER_REUSE_SESSION_MISMATCH',
        { session_reuse_count: Number(sess.reuse_count), reuse_cycle_count: legacy.reuseCycleCount },
      );
    }
    if (sess.reuse_count == null) {
      await tx.$executeRawUnsafe(
        `UPDATE dialysis_sessions
            SET reuse_count = $1::int, updated_at = NOW()
          WHERE id = $2::int AND tenant_id = $3::uuid`,
        legacy.reuseCycleCount, sess.id, tenantOr(tenantId),
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO dialyzer_reuse_register
         (tenant_id, session_id, dialysis_patient_id, patient_uid, dialyzer_serial,
          reuse_cycle_count, session_reuse_count, integrity_test_result,
          integrity_test_method, disinfectant, processed_by, status, discard_reason, notes)
       VALUES ($1::uuid, $2::int, $3::int, $4::uuid, $5, $6::int, $7::int, $8,
               $9, $10, $11::uuid, $12, $13, $14)
       ON CONFLICT (tenant_id, session_id) DO UPDATE SET
          dialyzer_serial = EXCLUDED.dialyzer_serial,
          reuse_cycle_count = EXCLUDED.reuse_cycle_count,
          session_reuse_count = EXCLUDED.session_reuse_count,
          integrity_test_result = EXCLUDED.integrity_test_result,
          integrity_test_method = EXCLUDED.integrity_test_method,
          disinfectant = EXCLUDED.disinfectant,
          processed_by = EXCLUDED.processed_by,
          processed_at = NOW(),
          status = EXCLUDED.status,
          discard_reason = EXCLUDED.discard_reason,
          notes = EXCLUDED.notes,
          updated_at = NOW()
       RETURNING *`,
      tenantOr(tenantId),
      sess.id,
      sess.dialysis_patient_id,
      sess.patient_uid,
      String(body.dialyzer_serial).trim(),
      legacy.reuseCycleCount,
      legacy.reuseCycleCount,
      legacy.integrity,
      body.integrity_test_method || null,
      body.disinfectant || null,
      processed_by || null,
      legacy.status,
      legacy.discardReason,
      body.notes || null,
    );
    return unwrap(rows);
  };

  return recordDialyserReprocessing({ tenantId, sessionId: session_id, body, normalized, legacyWrite, context: { actorUid: processed_by || null, actorRole: body.actorRole || null, idempotencyKey: body.idempotencyKey || null } });
}
```

(`lockSessionTx` in `dialysisReuseService.js` selects `s.id, s.status, s.machine_no, s.dialyser, s.reuse_count, s.dialysis_patient_id, s.actual_start_at, p.patient_uid` — everything `legacyWrite` reads from `sess`.)

(d) `cancelSession` (:625) moves from the bare client into `setTenantTx` with the row locked, and runs the un-capture hook **before** its status UPDATE (spec §5.1 Cancel). A refusal from the hook (`RPD_RETURN_REQUIRED`, `RPD_USAGE_NOT_CANCELLABLE`) fails the cancel — no best-effort. The hook needs no resolver, so this path is Phase 1-independent:

```js
export async function cancelSession({ tenantId, id, reason, mark_no_show, actorUid = null, actorRole = null }) {
  const target = mark_no_show ? 'no_show' : 'cancelled';
  const tid = tenantOr(tenantId);
  return setTenantTx(tid, async (tx) => {
    const sessRows = await tx.$queryRawUnsafe(
      `SELECT id, status, actual_start_at FROM dialysis_sessions WHERE id = $1::int AND tenant_id = $2::uuid FOR UPDATE`,
      parseInt(id, 10), tid);
    const sess = unwrap(sessRows);
    if (!sess) throw AppError.notFound('Session not found');
    if (!SESSION_TRANSITIONS[sess.status]?.includes(target)) {
      throw AppError.invalidTransition(sess.status, target, SESSION_TRANSITIONS[sess.status] || []);
    }
    // NNN: release a captured dialyser BEFORE the status moves. The hook
    // refuses (and so fails this cancel) when use was recorded or the session
    // had started; a scheduled session with a captured dialyser releases it.
    const released = await onSessionCancelledTx(tx, { tenantId: tid, session: sess, target, context: { actorUid, actorRole } });
    const note = reason ? `\n[${target}] ${reason}` : null;
    const rows = await tx.$queryRawUnsafe(
      `UPDATE dialysis_sessions
          SET status = $1, notes = COALESCE(notes, '') || COALESCE($2, ''), updated_at = NOW()
        WHERE id = $3::int AND tenant_id = $4::uuid
        RETURNING *`,
      target, note, parseInt(id, 10), tid);
    return { ...unwrap(rows), released_device: released?.device ?? null };
  });
}
```

(`onSessionCancelledTx` imported from `./dialysisReuseService.js`; the route passes `actorUid: req.user?.uid, actorRole: req.user?.role` — Step 6.)

**Not touched in this file:** `enrolPatient` (its `'negative'` default and any body guard are Phase 1's) and `recordSerology` (its promotion of the three columns, the `dialysis_surveillance` source and the `'reactive'`/`'positive'` disjointness at :1115–1117 / :1135 are Phase 1's — spec §3.3). If either has changed on `main` by the time this task runs, that is Phase 1 having landed; merge and carry on.

- [ ] **Step 4: The Phase 2 census — service and script (no Phase 1 dependency)**

```js
// apps/backend/src/services/clinical/dialysisIsolationCensus.js
//
// The Phase 2 gate (spec §3.3, §7.6): before any migration drops
// dialysis_patients.hbsag_status / hcv_status / hiv_status, both counts below
// must read ZERO in every production tenant. Read-only. Reads the columns and
// the marker table directly - it needs neither the Phase 1 resolver nor a
// dialyser policy, and it is deliberately NOT the union read (that is Phase 1's;
// this only counts what the union read could never see or has not yet absorbed).
import { setTenant } from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';

const CORE = Object.freeze(['hbsag', 'hcv', 'hiv']);

export async function runDialysisIsolationCensus({ tenantId, db = null } = {}) {
  const tid = requireTenantId(tenantId);
  const run = (fn) => (db ? fn(db) : setTenant(tid, fn));
  // 1. Orphans: roster rows whose (tenant_id, patient_uid) has no users row.
  //    168_dialysis_unit.sql:30 declares patient_uid with NO FK; 764:69 requires
  //    one on the marker table - so an orphan row can never hold a marker.
  const [orphans] = await run((c) => c.$queryRawUnsafe(
    `SELECT count(*)::int AS rows, count(DISTINCT p.patient_uid)::int AS uids,
            COALESCE(array_agg(DISTINCT p.patient_uid::text) FILTER (WHERE p.patient_uid IS NOT NULL), '{}') AS uid_list
       FROM dialysis_patients p
       LEFT JOIN users u ON u.tenant_id = p.tenant_id AND u.uid = p.patient_uid
      WHERE p.tenant_id = $1::uuid AND u.uid IS NULL`, tid));
  // 2. Un-backfilled positives: bool_or over EVERY roster row of the patient
  //    (a re-enrolled patient has more than one; the older row's 'positive'
  //    counts), minus patients with a non-voided reactive marker for that marker.
  const perMarker = await run((c) => c.$queryRawUnsafe(
    `WITH legacy AS (
       SELECT p.patient_uid,
              bool_or(p.hbsag_status = 'positive') AS hbsag,
              bool_or(p.hcv_status = 'positive')   AS hcv,
              bool_or(p.hiv_status = 'positive')   AS hiv
         FROM dialysis_patients p WHERE p.tenant_id = $1::uuid GROUP BY p.patient_uid),
     flat AS (
       SELECT patient_uid, m.marker
         FROM legacy, LATERAL (VALUES ('hbsag', hbsag), ('hcv', hcv), ('hiv', hiv)) AS m(marker, positive)
        WHERE m.positive)
     SELECT f.marker, count(*)::int AS n, array_agg(f.patient_uid::text ORDER BY f.patient_uid) AS patient_uids
       FROM flat f
      WHERE NOT EXISTS (
        SELECT 1 FROM patient_bloodborne_markers b
         WHERE b.tenant_id = $1::uuid AND b.patient_uid = f.patient_uid AND b.marker = f.marker
           AND b.result = 'reactive' AND b.voided_at IS NULL)
      GROUP BY f.marker ORDER BY f.marker`, tid));
  const [denominators] = await run((c) => c.$queryRawUnsafe(
    `SELECT count(*)::int AS roster_rows, count(*) FILTER (WHERE status = 'active')::int AS active_roster_rows FROM dialysis_patients WHERE tenant_id = $1::uuid`, tid));
  const byMarker = Object.fromEntries(CORE.map((m) => [m, 0]));
  const patients = new Set();
  for (const row of perMarker) { byMarker[row.marker] = row.n; for (const uid of row.patient_uids || []) patients.add(uid); }
  const columns = CORE.reduce((sum, m) => sum + byMarker[m], 0);
  return {
    tenant_id: tid,
    roster_rows: denominators.roster_rows, active_roster_rows: denominators.active_roster_rows,
    orphan_patient_uid_rows: orphans.rows, orphan_patient_uids: orphans.uid_list,
    unbackfilled_positive_patients: patients.size, unbackfilled_positive_columns: columns, unbackfilled_by_marker: byMarker,
    gate_clear: orphans.rows === 0 && columns === 0,
  };
}
```

```js
#!/usr/bin/env node
// apps/backend/scripts/dialysis-isolation-census.mjs
//
// The Phase 2 gate (spec §7.6): per tenant, the orphan patient_uid count and the
// un-backfilled legacy-positive count. Both must be zero in every production
// tenant before the DROP migration is written. Read-only; safe at any hour.
//   node scripts/dialysis-isolation-census.mjs --tenant <uuid> [--json]
//   node scripts/dialysis-isolation-census.mjs --all-tenants [--json]
import prisma from '../src/lib/prisma.js';
import { runDialysisIsolationCensus } from '../src/services/clinical/dialysisIsolationCensus.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : process.argv[i + 1]; };
const tenantArg = arg('tenant'); const all = process.argv.includes('--all-tenants'); const json = process.argv.includes('--json');
if (!tenantArg && !all) { console.error('usage: --tenant <uuid> | --all-tenants [--json]'); process.exit(2); }
const tenants = all ? (await prisma.$queryRawUnsafe(`SELECT id::text AS id, name FROM tenants ORDER BY name`)) : [{ id: tenantArg, name: null }];
const results = [];
for (const t of tenants) results.push({ tenant_name: t.name, ...(await runDialysisIsolationCensus({ tenantId: t.id })) });
if (json) console.log(JSON.stringify(results, null, 2));
else for (const r of results) console.log(`${r.tenant_name || r.tenant_id}: orphan rows ${r.orphan_patient_uid_rows} (${r.orphan_patient_uids.length} uids), un-backfilled positives ${r.unbackfilled_positive_patients} patients / ${r.unbackfilled_positive_columns} columns [hbsag ${r.unbackfilled_by_marker.hbsag} hcv ${r.unbackfilled_by_marker.hcv} hiv ${r.unbackfilled_by_marker.hiv}] of ${r.roster_rows} roster rows -> gate ${r.gate_clear ? 'CLEAR' : 'NOT CLEAR'}`);
await prisma.$disconnect();
process.exit(results.every((r) => r.gate_clear) ? 0 : 1);
```

```js
// apps/backend/src/tests/dialysis-isolation-census.deep.test.js
// The Phase 2 gate against a real database, own tenant (…d1a2). No Phase 1
// dependency: it reads the columns and the marker table.
import prisma, { setTenantTx } from '../lib/prisma.js';
import { recordMarkers, voidMarker } from '../services/clinical/bloodborneMarkerService.js';
import { clinicalDate } from '../services/clinical/bloodborneMarkerRules.js';
import { runDialysisIsolationCensus } from '../services/clinical/dialysisIsolationCensus.js';

const describeIfDb = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL ? describe : describe.skip;
const TENANT = '00000000-0000-4000-8000-0000000d1a20';
const P1 = 'd1a20000-0000-4000-8000-000000000001'; // real user, legacy positive on the OLDER of two rows
const P2 = 'd1a20000-0000-4000-8000-000000000002'; // real user, legacy positive backed by a marker
const ORPHAN = 'd1a20000-0000-4000-8000-00000000dead'; // no users row - inserts because 168 declares no FK
const ACTOR = 'd1a20000-0000-4000-8000-0000000000ac';
const sql = (t, ...a) => prisma.$queryRawUnsafe(t, ...a);

describeIfDb('dialysis isolation census (Phase 2 gate)', () => {
  beforeAll(async () => {
    await sql(`INSERT INTO tenants (id, name, slug) VALUES ($1::uuid, 'RPD Census', 'rpd-census') ON CONFLICT (id) DO NOTHING`, TENANT);
    for (const [uid, role] of [[P1, 'PATIENT'], [P2, 'PATIENT'], [ACTOR, 'NURSING_STAFF']]) {
      await sql(`INSERT INTO users (uid, tenant_id, email, role, name, status, is_active) VALUES ($1::uuid, $2::uuid, $3, $4, $3, 'active', true) ON CONFLICT (uid) DO NOTHING`, uid, TENANT, `${uid}@rpd.test`, role);
    }
    // Written with raw SQL on purpose: enrolPatient's defaults are Phase 1's business and this suite must not depend on them.
    await setTenantTx(TENANT, async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, hcv_status, status) VALUES ($1::uuid, $2::uuid, 'hd', 'positive', 'inactive')`, TENANT, P1); // older row
      await tx.$executeRawUnsafe(`INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, hcv_status, status) VALUES ($1::uuid, $2::uuid, 'hd', 'negative', 'active')`, TENANT, P1); // newer row
      await tx.$executeRawUnsafe(`INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, hbsag_status, status) VALUES ($1::uuid, $2::uuid, 'hd', 'positive', 'active')`, TENANT, P2);
      await tx.$executeRawUnsafe(`INSERT INTO dialysis_patients (tenant_id, patient_uid, modality, hiv_status, status) VALUES ($1::uuid, $2::uuid, 'hd', 'positive', 'active')`, TENANT, ORPHAN);
    });
    await recordMarkers({ tenantId: TENANT, patientUid: P2, actorUid: ACTOR, entries: [{ marker: 'hbsag', result: 'reactive', tested_on: clinicalDate(new Date()), source: 'clinical_declaration' }] });
  }, 30000);

  test('counts the orphan row, the older-row positive (bool_or) and the orphan positive; a marker-backed positive counts zero', async () => {
    const out = await runDialysisIsolationCensus({ tenantId: TENANT });
    expect(out).toMatchObject({ orphan_patient_uid_rows: 1, orphan_patient_uids: [ORPHAN], roster_rows: 4, gate_clear: false });
    // P1 (hcv, on the OLDER row) and ORPHAN (hiv) are un-backfilled; P2 (hbsag) has its marker.
    expect(out.unbackfilled_by_marker).toEqual({ hbsag: 0, hcv: 1, hiv: 1 });
    expect(out).toMatchObject({ unbackfilled_positive_patients: 2, unbackfilled_positive_columns: 2 });
  });

  test('a voided reactive marker does not back a positive', async () => {
    const [row] = await sql(`SELECT id FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND marker = 'hbsag' AND voided_at IS NULL`, TENANT, P2);
    await voidMarker({ tenantId: TENANT, patientUid: P2, markerId: Number(row.id), actorUid: ACTOR, reason: 'entered on the wrong patient' });
    expect((await runDialysisIsolationCensus({ tenantId: TENANT })).unbackfilled_by_marker.hbsag).toBe(1);
  });

  test('a clean tenant reads 0 / 0 and the gate is clear', async () => {
    const CLEAN = '00000000-0000-4000-8000-0000000d1a21';
    await sql(`INSERT INTO tenants (id, name, slug) VALUES ($1::uuid, 'RPD Census clean', 'rpd-census-clean') ON CONFLICT (id) DO NOTHING`, CLEAN);
    expect(await runDialysisIsolationCensus({ tenantId: CLEAN })).toMatchObject({ orphan_patient_uid_rows: 0, unbackfilled_positive_patients: 0, unbackfilled_positive_columns: 0, gate_clear: true });
  });
});
```

Run: `npm test -- --testPathPatterns dialysis-isolation-census.deep` — Expected: PASS, 3 tests, twice on a fresh database. If `dialysis_patients` carries a NOT NULL column the raw INSERTs above do not name, add it with its baseline default — do not switch to `enrolPatient`. Mutation check: replace `bool_or(...)` with a `DISTINCT ON (patient_uid) … ORDER BY id DESC` read and confirm the first test goes red on `hcv: 0`.

- [ ] **Step 5: Pins**

```js
// apps/backend/src/tests/unit/dialysisSerologyWriters.test.js
// STRUCTURAL PIN: dialysis_patients.hbsag_status / hcv_status / hiv_status are
// the Phase 1 lane's (spec §3.3). NO module this lane creates may write them.
// Textual on purpose (the labExternalResultCallSites pattern). Phase 1's own
// writers live in files this list does not name; this pin is not theirs.
import { readFileSync } from 'node:fs';

const LANE_MODULES = [
  'services/clinical/dialysisReuseService.js',
  'services/clinical/dialysisIsolationAdapter.js',
  'services/clinical/dialysisIsolationCensus.js',
  'services/clinical/reprocessableDeviceService.js',
  'services/cssd/cssdReuseHooks.js',
];
const WRITE = /(UPDATE\s+dialysis_patients[\s\S]{0,400}?SET[\s\S]{0,400}?(hbsag_status|hcv_status|hiv_status)\s*=)|(INSERT\s+INTO\s+dialysis_patients[\s\S]{0,600}?(hbsag_status|hcv_status|hiv_status))/i;

test('no module this lane creates writes the roster serology columns', () => {
  const offenders = LANE_MODULES.filter((rel) => WRITE.test(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')));
  expect(offenders).toEqual([]);
});
test('the adapter is the only lane module that names the Phase 1 resolver', () => {
  const importers = LANE_MODULES.filter((rel) => /resolveDialysisIsolation|dialysisIsolationResolver/.test(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')));
  expect(importers).toEqual(['services/clinical/dialysisIsolationAdapter.js']);
});
```

Run: `npm test -- --testPathPatterns unit/dialysisSerologyWriters` — Expected: PASS. (Mutation: add `UPDATE dialysis_patients SET hbsag_status = 'x'` to `dialysisReuseService.js`, confirm red, remove.)

The second pin — the dialysis half of the six pinned write paths (the OT four are in Task 5 Step 3):

```js
// apps/backend/src/tests/unit/dialysisReuseHookCallSites.test.js
// The register's dialysis state is kept coherent with dialysis_sessions by
// hooks INSIDE dialysisService's transactions. A cancel that forgets the hook
// leaves a device in_case forever; a schedule that inserts before it assesses
// leaves an orphan row on a block. Textual on purpose.
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../services/clinical/dialysisService.js', import.meta.url), 'utf8');
const fn = (name) => { const start = source.indexOf(`async function ${name}(`); expect(start).toBeGreaterThan(-1); const rest = source.slice(start); return rest.slice(0, rest.indexOf('\n}\n')); };

test('cancelSession runs inside setTenantTx and calls onSessionCancelledTx BEFORE its status UPDATE', () => {
  const body = fn('cancelSession');
  expect(body).toMatch(/setTenantTx\(/);
  const hook = body.indexOf('onSessionCancelledTx(');
  const update = body.indexOf('UPDATE dialysis_sessions');
  expect(hook).toBeGreaterThan(-1);
  expect(update).toBeGreaterThan(-1);
  expect(hook).toBeLessThan(update);
  expect(body).not.toMatch(/prisma\.\$queryRawUnsafe/); // no bare-client write left
});
test('scheduleSession assesses isolation BEFORE its INSERT, inside setTenantTx', () => {
  const body = fn('scheduleSession');
  const assess = body.indexOf('assessIsolationTx(');
  const insert = body.indexOf('INSERT INTO dialysis_sessions');
  expect(assess).toBeGreaterThan(-1);
  expect(assess).toBeLessThan(insert);
  expect(body.indexOf('setTenantTx(')).toBeLessThan(insert);
});
test('startSession evaluates isolation inside its transaction', () => {
  const body = fn('startSession');
  expect(body).toMatch(/setTenantTx\(/);
  expect(body).toMatch(/evaluateIsolationForSessionTx\(/);
});
test('dialysisReuseService never reads a frozen reuse_screen as a decision input', () => {
  const reuse = readFileSync(new URL('../../services/clinical/dialysisReuseService.js', import.meta.url), 'utf8');
  // The snapshot is written (reuseScreen: screen) and returned inside `usage`;
  // no decision path reads usage.reuse_screen or usage.post_use_screen.
  expect(reuse).not.toMatch(/usage\.reuse_screen|usage\.post_use_screen/);
  // Every decision path re-resolves.
  for (const fnName of ['assessIsolationTx', 'captureTx', 'getSessionDialyser', 'recordDialyserReprocessing']) {
    const start = reuse.indexOf(`function ${fnName}(`); expect(start).toBeGreaterThan(-1);
    expect(reuse.slice(start, reuse.indexOf('\n}\n', start))).toMatch(/isolationDecisionTx\(/);
  }
});
// The opt-in class (spec §3.3): since D11 = NO, exactly ONE server-side path
// asks for it and NOTHING anywhere names a class. A textual pin, because the
// leak this guards is a one-word edit in a file nobody re-reads.
test('only the routing path requests isolation_class, and no payload or audit names a class', () => {
  const reuse = readFileSync(new URL('../../services/clinical/dialysisReuseService.js', import.meta.url), 'utf8');
  const asking = [...reuse.matchAll(/includeIsolationClass:\s*true/g)].length;
  expect(asking).toBe(1);
  const start = reuse.indexOf('function assessIsolationTx(');
  expect(reuse.slice(start, reuse.indexOf('\n}\n', start))).toMatch(/includeIsolationClass:\s*true/);
  // The post-use path is now on this list: D11 = NO retired its two consumers.
  for (const fnName of ['captureTx', 'getSessionDialyser', 'recordDialyserReprocessing']) {
    const at = reuse.indexOf(`function ${fnName}(`);
    expect(reuse.slice(at, reuse.indexOf('\n}\n', at))).not.toMatch(/includeIsolationClass/);
  }
  // required_class exists NOWHERE in the module, and required_group never
  // reaches the audit metadata under a class name. isolationPayload() is the one
  // serialiser and it emits the group.
  expect(reuse).not.toMatch(/required_class/);
  expect(reuse).not.toMatch(/exposure_isolation_class/);
  const payload = reuse.slice(reuse.indexOf('function isolationPayload('), reuse.indexOf('\n}\n', reuse.indexOf('function isolationPayload(')));
  expect(payload).toMatch(/required_group/);
  expect(payload).toMatch(/isolation_warnings/);
  // The audit metadata names the group and no class (spec §7.2).
  const audit = reuse.slice(reuse.indexOf('function recordIsolationAuditTx('), reuse.indexOf('\n}\n', reuse.indexOf('function recordIsolationAuditTx(')));
  expect(audit).toMatch(/required_group/);
  expect(audit).not.toMatch(/isolation_class/);
});
```

Run: `npm test -- --testPathPatterns unit/dialysisReuseHookCallSites` — Expected: PASS after Step 3; before it, the first three FAIL (the mutation check for this pin).

- [ ] **Step 6: Dialysis routes**

In `apps/backend/src/routes/clinical/dialysisRoutes.js` add to the imports:

```js
import { DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { projectReuseRestrictionForRole } from '../../services/clinical/reprocessableDeviceService.js';
import { projectDialysisPatientForRole, projectDialysisPatientsForRole, projectDialysisSerologyRowsForRole } from '../../services/clinical/reprocessableDeviceProjection.js';
import * as reuse from '../../services/clinical/dialysisReuseService.js';
```

and in `config/routeRolePolicy.js`, after `DIALYSIS_ROUTE_ROLES`:

```js
// Machine master writes: the unit's in-charges and platform admin. An
// INTERSECTION with the mount list so the gate can never name a role the
// mount already refuses (the prefix-mount lockout class).
const DIALYSIS_MACHINE_ADMIN_CANDIDATES = rolesFrom(['NURSING_INCHARGE', 'IP_INCHARGE', 'ICU_INCHARGE', 'ADMIN', 'SUPER_ADMIN']);
export const DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES = DIALYSIS_ROUTE_ROLES.filter((role) => DIALYSIS_MACHINE_ADMIN_CANDIDATES.includes(role));
```

`POST /patients` is **not** changed by this lane (the enrol default and any body guard are Phase 1's). Project the existing reads: `GET /patients` → `projectDialysisPatientsForRole(rows, req.user?.role)`; `GET /patients/:id` → project the row and its `serology` array (this lane adds no resolver call to that route: a resolver-backed roster/patient-detail surface is Phase 1's, and an existing read must not start answering 503 on a build without Phase 1); `GET /today` rows carry only `isolation_required` and need no projection. Actors onto the three session writes: `POST /sessions` (:209) passes `actorUid: req.user?.uid, actorRole: req.user?.role` beside the existing `conducted_by`; `POST /sessions/:id/start` (:230) passes `started_by: req.user?.uid, actorRole: req.user?.role`; `POST /sessions/:id/cancel` (:269) passes `actorUid: req.user?.uid, actorRole: req.user?.role` beside `reason` / `mark_no_show` (the un-capture audit names the actor, and an override needs one). Then, after the existing `GET /sessions/:id/reuse-register` route, add:

```js
// ---------------------------------------------------------------------------
// Reprocessable dialysers (spec 2026-09-05 §5.1). Guard BEFORE claim on every write.
// ---------------------------------------------------------------------------
const dialyserContext = (req) => ({
  tenantId: tenantOf(req), actorUid: req.user?.uid || null, actorRole: req.user?.role || null,
  idempotencyKey: req.idempotencyClaim?.requestKey || null, captureSource: 'staff_app',
});

router.post('/sessions/:id/dialyser', requireStaffOrAdmin, guardDialysisSessionParam,
  requireIdempotencyKey({ required: true, scope: 'dialysis_dialyser_capture' }), wrap(async (req) => {
    const tenantId = tenantOf(req);
    const out = await reuse.captureDialyser({ tenantId, sessionId: req.params.id, ...req.body }, dialyserContext(req));
    emitDialysisEvent('dialyser-captured', { tenantId });
    return { ...out, reuse_restriction: projectReuseRestrictionForRole(out.reuse_restriction, req.user?.role) };
  }));

// reuse_restriction (the live Decision) is projected; isolation is NOT, because
// it carries no class to project (spec §3.4 interim payload, §3.5): the codes,
// the machine each is about and its severity are what every dialysis role must
// read. The service already built it through isolationPayload().
router.get('/sessions/:id/dialyser', requireStaffOrAdmin, guardDialysisSessionParam, wrap(async (req) => {
  const out = await reuse.getSessionDialyser({ tenantId: tenantOf(req), sessionId: req.params.id });
  return { ...out, reuse_restriction: projectReuseRestrictionForRole(out.reuse_restriction, req.user?.role) };
}));

router.patch('/sessions/:id/machine', requireStaffOrAdmin, guardDialysisSessionParam,
  requireIdempotencyKey({ required: true, scope: 'dialysis_session_machine' }), wrap(async (req) => {
    const tenantId = tenantOf(req);
    const out = await svc.reassignMachine({ tenantId, id: req.params.id, machine_no: req.body.machine_no, isolation_override_reason: req.body.isolation_override_reason, actorUid: req.user?.uid, actorRole: req.user?.role });
    emitDialysisEvent('session-machine-changed', { tenantId });
    return out;
  }));

router.get('/machines', requireStaffOrAdmin, wrap((req) => reuse.listMachines({ tenantId: tenantOf(req), status: req.query.status })));
router.post('/machines', requireRole(...DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES),
  requireIdempotencyKey({ required: true, scope: 'dialysis_machine' }), wrap((req) =>
    reuse.createMachine({ tenantId: tenantOf(req), ...req.body }, dialyserContext(req))));
router.patch('/machines/:id', requireRole(...DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES),
  requireIdempotencyKey({ required: true, scope: 'dialysis_machine' }), wrap((req) =>
    reuse.updateMachine({ tenantId: tenantOf(req), id: req.params.id, ...req.body }, dialyserContext(req))));
```

`svc.reassignMachine` is a small new export in `dialysisService.js`: lock the session, refuse unless status ∈ {`scheduled`, `in_progress`}, `UPDATE dialysis_sessions SET machine_no = $3`, then `evaluateIsolationForSessionTx(... requireReasonWhenWarned: true ...)` and return `{ ...row, isolation: isolationPayload(isolation) }` — the internal object never leaves the service (spec §3.4).

Replace the existing `POST /sessions/:id/reuse-register` route with one that claims a key **after** the guard and forwards it:

```js
router.post('/sessions/:id/reuse-register', requireStaffOrAdmin, guardDialysisSessionParam,
  // retainOnServerError: a per-session upsert has no self-blocking from-list, so
  // a retry after a post-commit 5xx would otherwise run the command twice.
  requireIdempotencyKey({ required: true, scope: 'dialysis_reuse_register', retainOnServerError: true }), wrap(async (req) => {
    const tenantId = tenantOf(req);
    const row = await svc.recordReuseRegister({ ...req.body, tenantId, session_id: req.params.id, processed_by: req.user?.uid, actorRole: req.user?.role, idempotencyKey: req.idempotencyClaim?.requestKey || null });
    emitDialysisEvent('reuse-register-updated', { tenantId });
    return row;
  }));
```

- [ ] **Step 7: Deep suite — DEPENDS ON Phase 1, skipped by name without it**

```js
// apps/backend/src/tests/reprocessable-devices-dialysis.deep.test.js
//
// Dialysis consumer of the reprocessable-device platform against a real
// database, own tenant (…d1a1). Spec 2026-09-05 §3.3, §3.4, §5.1, §8.
//
// DEPENDS ON Phase 1: every decision below reads the real resolver. Without it
// on this checkout the suite is SKIPPED BY NAME (never run against a stub, never
// against the columns). The census suite next door has no such dependency.
import { existsSync } from 'node:fs';
import prisma, { ensureTenantRlsRuntimeRoleGrants, setTenantTx } from '../lib/prisma.js';
import { recordMarkers } from '../services/clinical/bloodborneMarkerService.js';
import { cancelSession, enrolPatient, recordReuseRegister, scheduleSession, startSession } from '../services/clinical/dialysisService.js';
import { captureDialyser, createMachine, getSessionDialyser } from '../services/clinical/dialysisReuseService.js';
import { quarantineDevicesExposedToPatient, upsertDomainPolicies, upsertDomainSettings } from '../services/clinical/reprocessableDeviceService.js';
import { clinicalDate } from '../services/clinical/bloodborneMarkerRules.js';

const hasDb = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const PHASE1_RESOLVER = new URL('../services/clinical/dialysisIsolationResolver.js', import.meta.url);
const hasPhase1 = existsSync(PHASE1_RESOLVER);
const describeIfPhase1 = hasDb && hasPhase1 ? describe : describe.skip;
if (hasDb && !hasPhase1) console.warn('SKIPPED reprocessable-devices-dialysis.deep: Phase 1 resolver (dialysisIsolationResolver.js) is not on this checkout - spec §3.3');

const TENANT = '00000000-0000-4000-8000-0000000d1a10';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000d1a11';
const PATIENT_A = 'd1a10000-0000-4000-8000-00000000000a';
const PATIENT_B = 'd1a10000-0000-4000-8000-00000000000b';
const ACTOR = 'd1a10000-0000-4000-8000-0000000000ac';
const ctx = { actorUid: ACTOR, actorRole: 'NURSING_STAFF', tenantId: TENANT, requestId: 'rpd-dialysis-deep' };
const today = () => clinicalDate(new Date());
// The six NNN tables the runtime role may SELECT / INSERT / UPDATE and never DELETE.
const RPD_TABLES = ['reprocessing_domain_settings', 'reprocessing_domain_policies', 'reprocessable_devices', 'reprocessable_device_usages', 'reprocessable_device_dialysis_links', 'dialysis_machines'];
const RUNTIME_ROLES = ['vhhealth_app', 'vhhealth_runtime'];
const RLS_ROLE = 'vhhealth_runtime';
const runtimeRoleProvisioning = new Map();

async function sql(text, ...args) { return prisma.$queryRawUnsafe(text, ...args); }
const deviceRow = async (id) => (await sql(`SELECT status, cycle_count, current_usage_id, exposure_flag, exposure_markers FROM reprocessable_devices WHERE id = $1::bigint`, id))[0];
const usageRow = async (sessionId) => (await sql(`SELECT post_use_disposition, returned_at, reuse_cycle, reuse_screen, post_use_screen FROM reprocessable_device_usages WHERE dialysis_session_id = $1::int`, sessionId))[0];

describeIfPhase1('reprocessable devices - dialysis', () => {
  let rosterA; let rosterB; let sessionA1; let sessionA2; let sessionB; let sessionC2;
  let deviceA1; let deviceA4;
  beforeAll(async () => {
    // Provision the runtime roles the way boot does (bloodborne-markers.deep
    // does the same), so the grant probe asserts instead of skipping.
    const previous = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    try {
      for (const role of RUNTIME_ROLES) { process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = role; runtimeRoleProvisioning.set(role, await ensureTenantRlsRuntimeRoleGrants()); }
    } finally {
      if (previous === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE; else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previous;
    }
    // Tenants, users (patients + actor), roster rows, sessions. Mirror the fixture
    // shape cath-device-reuse.deep.test.js uses for tenants/users, re-keyed.
    // PATIENT_A carries NO markers on purpose and the fixture neutralises the
    // three roster columns below, so this patient is `unknown` under Phase 1's
    // rule whatever enrolment wrote. Q1 is DECIDED (a legacy non-reactive
    // 'negative' MEANS clear, spec §9) - the neutralisation stays because this
    // suite pins its own fixture and must not depend on enrolment defaults, not
    // because the question is open.
    await sql(`INSERT INTO tenants (id, name, slug) VALUES ($1::uuid, 'RPD Dialysis', 'rpd-dialysis'), ($2::uuid, 'RPD Other', 'rpd-other') ON CONFLICT (id) DO NOTHING`, TENANT, OTHER_TENANT);
    for (const [uid, role] of [[PATIENT_A, 'PATIENT'], [PATIENT_B, 'PATIENT'], [ACTOR, 'NURSING_STAFF']]) {
      await sql(`INSERT INTO users (uid, tenant_id, email, role, name, status, is_active) VALUES ($1::uuid, $2::uuid, $3, $4, $3, 'active', true) ON CONFLICT (uid) DO NOTHING`, uid, TENANT, `${uid}@rpd.test`, role);
    }
    await upsertDomainSettings({ tenantId: TENANT, domain: 'dialysis', reactive_patient_rule: 'discard', unknown_serology_rule: 'warn', serology_validity_days: 90, isolation_enforcement: 'warn' }, ctx);
    await upsertDomainPolicies({ tenantId: TENANT, domain: 'dialysis', policies: [{ category: 'dialyser', reprocessable: true, max_cycles: 3, allowed_cycle_types: ['chemical'], tcv_min_pct: 80 }] }, ctx);
    rosterA = await enrolPatient({ tenantId: TENANT, patient_uid: PATIENT_A, modality: 'hd' });
    rosterB = await enrolPatient({ tenantId: TENANT, patient_uid: PATIENT_B, modality: 'hd' });
    // Whatever enrolPatient wrote into the three columns is Phase 1's: this
    // suite never asserts or writes them. Neutralise the fixture so Q1's
    // answer cannot change these tests: nothing declared, no marker.
    await setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(`UPDATE dialysis_patients SET hbsag_status = 'unknown', hcv_status = 'unknown', hiv_status = 'unknown' WHERE tenant_id = $1::uuid AND id IN ($2, $3)`, TENANT, rosterA.id, rosterB.id));
    sessionA1 = await scheduleSession({ tenantId: TENANT, dialysis_patient_id: rosterA.id, session_date: today(), machine_no: 'HD-01', actorUid: ACTOR });
    sessionA2 = await scheduleSession({ tenantId: TENANT, dialysis_patient_id: rosterA.id, session_date: today(), machine_no: 'HD-01', actorUid: ACTOR });
    sessionB = await scheduleSession({ tenantId: TENANT, dialysis_patient_id: rosterB.id, session_date: today(), machine_no: 'HD-02', actorUid: ACTOR });
  }, 30000);

  test('capture mints, dedicates, freezes the Decision as reuse_screen (no markers key), and writes the legacy session columns', async () => {
    const out = await captureDialyser({ tenantId: TENANT, sessionId: sessionA1.id, manufacturer_serial: 'DLZ-A-001', model_name: 'F60', baseline_tcv_ml: 100 }, ctx);
    expect(out.device.device_tag).toMatch(/^RD[0-9]{8,19}$/);
    expect(out.device.status).toBe('in_case');
    expect(out.usage.reuse_cycle).toBe(0);
    expect(out.link.dedicated_patient_uid).toBe(PATIENT_A);
    expect(out.reuse_restriction).toMatchObject({ status: 'unknown', evidence: 'none' });
    expect(out.reuse_restriction).not.toHaveProperty('markers');
    expect(out.reuse_restriction.isolation_class ?? null).toBeNull();   // capture never asks for the class (§3.3)
    const [s] = await sql(`SELECT dialyser, reuse_count FROM dialysis_sessions WHERE id = $1`, sessionA1.id);
    expect(s).toEqual({ dialyser: 'F60', reuse_count: 0 });
    expect((await usageRow(sessionA1.id)).reuse_screen).toMatchObject({ status: 'unknown' });
    deviceA1 = out.device.id;
  });

  test('a second capture on the same session is refused', async () => {
    await expect(captureDialyser({ tenantId: TENANT, sessionId: sessionA1.id, manufacturer_serial: 'DLZ-A-002' }, ctx)).rejects.toMatchObject({ code: 'DIALYSER_ALREADY_CAPTURED' });
  });

  test('no serology on record: reprocessing needs an acknowledgement (unknown + warn) and records the safety review; pass + TCV 85% then releases and increments', async () => {
    const base = { tenantId: TENANT, session_id: sessionA1.id, processed_by: ACTOR, integrity_test_result: 'pass', status: 'in_use', measured_tcv_ml: 85, reprocessing_agent: 'peracetic_acid', disinfectant_contact_minutes: 660 };
    await expect(recordReuseRegister(base)).rejects.toMatchObject({ code: 'RPD_ACKNOWLEDGEMENT_REQUIRED' });
    expect((await deviceRow(deviceA1)).status).toBe('in_case');                 // the refusal wrote nothing
    const row = await recordReuseRegister({ ...base, acknowledgement: { reason: 'serology sent; unit protocol permits one cycle pending the result' } });
    expect(row.device.status).toBe('available');
    expect(row.device.cycle_count).toBe(1);
    expect(row.reuse_cycle_count).toBe(0);                                          // derived: the body carried no count
    expect(Number(row.tcv_pct_of_baseline)).toBe(85);
    expect(row.device_id).toBe(row.device.id);
    expect((await usageRow(sessionA1.id)).post_use_screen).toMatchObject({ status: 'unknown' });
    const [review] = await sql(`SELECT finding_code, status FROM medication_safety_reviews WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND review_type = 'reprocessable_device_reuse' ORDER BY id DESC LIMIT 1`, TENANT, PATIENT_A);
    expect(review).toMatchObject({ finding_code: 'SEROLOGY_UNKNOWN_ACKNOWLEDGED', status: 'overridden' });
  });

  test('a typed cycle count that disagrees with the device is refused; a settled row refuses a different write', async () => {
    await expect(recordReuseRegister({ tenantId: TENANT, session_id: sessionA1.id, processed_by: ACTOR, integrity_test_result: 'pass', status: 'in_use', reuse_cycle_count: 7 })).rejects.toMatchObject({ code: 'DIALYZER_REUSE_CYCLE_DERIVED' });
    await expect(recordReuseRegister({ tenantId: TENANT, session_id: sessionA1.id, processed_by: ACTOR, integrity_test_result: 'fail', status: 'discarded', discard_reason: 'x' })).rejects.toMatchObject({ code: 'DIALYZER_REUSE_REGISTER_SETTLED' });
  });

  test('the same dialyser is reused on the same patient at cycle 1 and refused for another patient', async () => {
    const again = await captureDialyser({ tenantId: TENANT, sessionId: sessionA2.id, manufacturer_serial: 'DLZ-A-001' }, ctx);
    expect(again.usage.reuse_cycle).toBe(1);
    await expect(captureDialyser({ tenantId: TENANT, sessionId: sessionB.id, manufacturer_serial: 'DLZ-A-001' }, ctx)).rejects.toMatchObject({ code: 'DIALYSER_DEDICATED_TO_ANOTHER_PATIENT' });
  });

  test('TCV 70% discards with the right reason on device, usage and 418 row (no acknowledgement: the verdict is a discard)', async () => {
    const row = await recordReuseRegister({ tenantId: TENANT, session_id: sessionA2.id, processed_by: ACTOR, integrity_test_result: 'pass', status: 'in_use', measured_tcv_ml: 70 });
    expect(row.device.status).toBe('discarded');
    expect(row.device.discard_reason).toBe('tcv_below_threshold');
    expect(row.status).toBe('discarded');
    expect((await usageRow(sessionA2.id)).post_use_disposition).toBe('discarded_tcv_below_threshold');
  });

  test('a restricted patient under discard offers discard only; the register records it and the device carries the FLAG and no marker name (D11 = NO)', async () => {
    await recordMarkers({ tenantId: TENANT, patientUid: PATIENT_B, actorUid: ACTOR, entries: [{ marker: 'hbsag', result: 'reactive', tested_on: today(), source: 'clinical_declaration' }] });
    const cap = await captureDialyser({ tenantId: TENANT, sessionId: sessionB.id, manufacturer_serial: 'DLZ-B-001' }, ctx);
    expect(cap.reuse_restriction).toMatchObject({ status: 'restricted', evidence: 'marker' });
    expect(cap.reuse_restriction.isolation_class ?? null).toBeNull();              // capture never asks for the class (§3.3)
    const view = await getSessionDialyser({ tenantId: TENANT, sessionId: sessionB.id });
    expect(view.allowed_dispositions.dispositions).toEqual(['discard']);
    expect(view.isolation).not.toHaveProperty('required_class');                   // retired by D11 = NO (§3.4)
    expect(Object.keys(view.isolation).sort()).toEqual(['codes', 'enforcement_enabled', 'isolation_warnings', 'override', 'warn_only']);
    for (const w of view.isolation.isolation_warnings) expect(Object.keys(w).sort()).toEqual(['code', 'machine_id', 'required_group', 'severity']);
    expect(JSON.stringify({ i: view.isolation, r: view.reuse_restriction })).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);   // no marker class reaches the caller
    await expect(recordReuseRegister({ tenantId: TENANT, session_id: sessionB.id, processed_by: ACTOR, integrity_test_result: 'pass', status: 'in_use' })).rejects.toMatchObject({ code: 'RPD_DISPOSITION_NOT_ALLOWED' });
    const row = await recordReuseRegister({ tenantId: TENANT, session_id: sessionB.id, processed_by: ACTOR, integrity_test_result: 'not_done', status: 'discarded', discard_reason: 'HBsAg reactive' });
    expect(row.device.discard_reason).toBe('bloodborne_exposure');
    expect(row.device.exposure_flag).toBe(true);                                   // the FLAG is the truth (D11 = NO)
    expect(row.device.exposure_markers ?? []).toEqual([]);                         // and nothing on the device names a marker
    expect(row.device.metadata ?? {}).not.toHaveProperty('exposure_isolation_class');
  });

  test('snapshot vs decision: a marker recorded AFTER capture reaches the machine assignment at start and the disposition at the record; the frozen reuse_screen is unchanged', async () => {
    const s = await scheduleSession({ tenantId: TENANT, dialysis_patient_id: rosterA.id, session_date: today(), machine_no: 'HD-01', actorUid: ACTOR });
    expect(s.isolation.codes).toEqual([]);                                          // unknown: silent per session (§3.4)
    const cap = await captureDialyser({ tenantId: TENANT, sessionId: s.id, manufacturer_serial: 'DLZ-A-003', baseline_tcv_ml: 100 }, ctx);
    expect(cap.reuse_restriction.status).toBe('unknown');
    await recordMarkers({ tenantId: TENANT, patientUid: PATIENT_A, actorUid: ACTOR, entries: [{ marker: 'hcv', result: 'reactive', tested_on: today(), source: 'clinical_declaration' }] });
    // The exposure handler flagged the in_case dialyser; the register did not move it.
    expect(await deviceRow(cap.device.id)).toMatchObject({ status: 'in_case', exposure_flag: true, exposure_markers: ['hcv'] });
    // Start re-resolves: unregistered machine + now-restricted patient warns and needs a reason.
    await expect(startSession({ tenantId: TENANT, id: s.id, started_by: ACTOR })).rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_OVERRIDE_REQUIRED' });
    const started = await startSession({ tenantId: TENANT, id: s.id, started_by: ACTOR, isolation_override_reason: 'isolation bay full; machine cleaned per protocol' });
    // HD-01 is unregistered, so there is no group to compare and required_group
    // is the tenant's label for the hcv class - which this tenant has not mapped.
    expect(started.isolation).toMatchObject({ codes: ['DIALYSIS_MACHINE_UNREGISTERED'], isolation_warnings: [{ code: 'DIALYSIS_MACHINE_UNREGISTERED', machine_id: null, severity: 'warn', required_group: null }] });
    expect(started.isolation).not.toHaveProperty('required_class');                 // routing used the class in-process; nothing carries it (§3.4)
    // ...and the audit row names the GROUP, never the class (D11 = NO, §7.2).
    const [audit] = await sql(`SELECT metadata FROM audit_logs WHERE tenant_id = $1::uuid AND resource = 'dialysis_sessions' AND resource_id = $2 AND action = 'dialysis.session.isolation_overridden' ORDER BY id DESC LIMIT 1`, TENANT, String(s.id));
    expect(audit.metadata).toHaveProperty('required_group');
    expect(JSON.stringify(audit.metadata)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed|isolation_class/);
    // The record re-resolves too: A is restricted under discard, so reprocess is not on offer...
    await expect(recordReuseRegister({ tenantId: TENANT, session_id: s.id, processed_by: ACTOR, integrity_test_result: 'pass', status: 'in_use', measured_tcv_ml: 90 })).rejects.toMatchObject({ code: 'RPD_DISPOSITION_NOT_ALLOWED' });
    // ...while the frozen capture snapshot still says what the capturing user saw.
    const u = await usageRow(s.id);
    expect(u.reuse_screen).toMatchObject({ status: 'unknown' });
    expect(u.post_use_screen).toBeNull();
  });

  test('isolation: mismatch under block refuses at start AND at scheduling with no orphan row; an unknown patient is never blocked and raises no code, even under block on an isolation machine', async () => {
    // A general machine is one with NO isolation_group (D11 = NO), and the
    // tenant maps hbsag -> 'Bay 1' so the mismatch has a group to name.
    await createMachine({ tenantId: TENANT, machine_no: 'HD-10', isolation_group: null }, ctx);
    await upsertDomainSettings({ tenantId: TENANT, domain: 'dialysis', isolation_groups: { hbsag: 'Bay 1' } }, { ...ctx, actorRole: 'INFECTION_CONTROL_OFFICER' });
    // Schedule B (restricted, hbsag) on the general machine while enforcement is still warn (a mismatch WARNS)...
    const s2 = await scheduleSession({ tenantId: TENANT, dialysis_patient_id: rosterB.id, session_date: today(), machine_no: 'HD-10', actorUid: ACTOR });
    expect(s2.isolation.codes).toEqual(['DIALYSIS_ISOLATION_MACHINE_MISMATCH']);
    expect(s2.isolation.isolation_warnings[0].required_group).toBe('Bay 1');       // the BAY, never the marker
    expect(JSON.stringify(s2.isolation)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed/);
    // ...then flip to block: start refuses regardless of reason...
    await upsertDomainSettings({ tenantId: TENANT, domain: 'dialysis', isolation_enforcement: 'block' }, ctx);
    await expect(startSession({ tenantId: TENANT, id: s2.id, started_by: ACTOR, isolation_override_reason: 'x' })).rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_MACHINE_BLOCKED' });
    // ...and scheduling refuses BEFORE inserting: no orphan scheduled row.
    const [before] = await sql(`SELECT count(*)::int AS n FROM dialysis_sessions WHERE dialysis_patient_id = $1 AND machine_no = 'HD-10'`, rosterB.id);
    await expect(scheduleSession({ tenantId: TENANT, dialysis_patient_id: rosterB.id, session_date: today(), machine_no: 'HD-10', actorUid: ACTOR })).rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_MACHINE_BLOCKED' });
    const [after] = await sql(`SELECT count(*)::int AS n FROM dialysis_sessions WHERE dialysis_patient_id = $1 AND machine_no = 'HD-10'`, rosterB.id);
    expect(after.n).toBe(before.n);
    await upsertDomainSettings({ tenantId: TENANT, domain: 'dialysis', isolation_enforcement: 'warn' }, ctx);
    // An UNKNOWN patient is never blocked and raises no unknown code, even under block, on any machine.
    await createMachine({ tenantId: TENANT, machine_no: 'HD-11', isolation_group: 'Bay 2' }, ctx);
    const PATIENT_U = 'd1a10000-0000-4000-8000-00000000000c';
    await sql(`INSERT INTO users (uid, tenant_id, email, role, name, status, is_active) VALUES ($1::uuid, $2::uuid, $3, 'PATIENT', $3, 'active', true) ON CONFLICT (uid) DO NOTHING`, PATIENT_U, TENANT, `${PATIENT_U}@rpd.test`);
    const rosterU = await enrolPatient({ tenantId: TENANT, patient_uid: PATIENT_U, modality: 'hd' });
    await setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(`UPDATE dialysis_patients SET hbsag_status = 'unknown', hcv_status = 'unknown', hiv_status = 'unknown' WHERE tenant_id = $1::uuid AND id = $2`, TENANT, rosterU.id));
    await upsertDomainSettings({ tenantId: TENANT, domain: 'dialysis', isolation_enforcement: 'block' }, ctx);
    const sU = await scheduleSession({ tenantId: TENANT, dialysis_patient_id: rosterU.id, session_date: today(), machine_no: 'HD-11', actorUid: ACTOR });
    expect(sU.isolation.codes).toEqual([]);                                         // unknown on an isolation machine: not "general patient" either - unknown is not clear
    expect(sU.isolation.codes).not.toContain('DIALYSIS_SEROLOGY_UNKNOWN');
    await upsertDomainSettings({ tenantId: TENANT, domain: 'dialysis', isolation_enforcement: 'warn' }, ctx);
  });

  test('cancel: a scheduled session releases its captured dialyser (available, cycle unchanged, usage cancelled_before_use, reuse_count nulled) and the same dialyser captures again at the same cycle', async () => {
    const sC1 = await scheduleSession({ tenantId: TENANT, dialysis_patient_id: rosterA.id, session_date: today(), machine_no: 'HD-01', actorUid: ACTOR });
    const cap = await captureDialyser({ tenantId: TENANT, sessionId: sC1.id, manufacturer_serial: 'DLZ-A-004', baseline_tcv_ml: 100 }, ctx);
    expect(cap.device.status).toBe('in_case');
    deviceA4 = cap.device.id;
    const cancelled = await cancelSession({ tenantId: TENANT, id: sC1.id, reason: 'patient admitted elsewhere', actorUid: ACTOR });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.reuse_count).toBeNull();
    expect(cancelled.released_device).toMatchObject({ id: deviceA4, status: 'available', cycle_count: 0, current_usage_id: null });
    const u = await usageRow(sC1.id);
    expect(u).toMatchObject({ post_use_disposition: 'cancelled_before_use', reuse_cycle: 0 });
    expect(u.returned_at).not.toBeNull();
    const [audit] = await sql(`SELECT action FROM audit_logs WHERE tenant_id = $1::uuid AND resource = 'reprocessable_devices' AND resource_id = $2 ORDER BY id DESC LIMIT 1`, TENANT, String(deviceA4));
    expect(audit.action).toBe('rpd.device.uncaptured');
    // The cycle number was not consumed: the next capture writes reuse_cycle 0 again (partial unique).
    sessionC2 = await scheduleSession({ tenantId: TENANT, dialysis_patient_id: rosterA.id, session_date: today(), machine_no: 'HD-01', actorUid: ACTOR });
    const again = await captureDialyser({ tenantId: TENANT, sessionId: sessionC2.id, manufacturer_serial: 'DLZ-A-004' }, ctx);
    expect(again.device.id).toBe(deviceA4);
    expect(again.usage.reuse_cycle).toBe(0);
  });

  test('cancel: an in_progress session refuses (RPD_RETURN_REQUIRED); once reprocessing is recorded the session cannot be cancelled (RPD_USAGE_NOT_CANCELLABLE) and stays as it was', async () => {
    const started = await startSession({ tenantId: TENANT, id: sessionC2.id, started_by: ACTOR, isolation_override_reason: 'isolation bay full; machine cleaned per protocol' });
    expect(started.status).toBe('in_progress');
    await expect(cancelSession({ tenantId: TENANT, id: sessionC2.id, reason: 'patient unwell', actorUid: ACTOR })).rejects.toMatchObject({ code: 'RPD_RETURN_REQUIRED' });
    let [s] = await sql(`SELECT status FROM dialysis_sessions WHERE id = $1`, sessionC2.id);
    expect(s.status).toBe('in_progress');                                          // the refusal failed the cancel atomically
    expect((await deviceRow(deviceA4)).status).toBe('in_case');
    // Record the use (A is restricted under discard, so the record is a discard).
    const row = await recordReuseRegister({ tenantId: TENANT, session_id: sessionC2.id, processed_by: ACTOR, integrity_test_result: 'not_done', status: 'discarded', discard_reason: 'HCV reactive; single use' });
    expect(row.device.status).toBe('discarded');
    await expect(cancelSession({ tenantId: TENANT, id: sessionC2.id, reason: 'patient unwell', actorUid: ACTOR })).rejects.toMatchObject({ code: 'RPD_USAGE_NOT_CANCELLABLE' });
    [s] = await sql(`SELECT status FROM dialysis_sessions WHERE id = $1`, sessionC2.id);
    expect(s.status).toBe('in_progress');
  });

  test('cancel: a session with nothing captured cancels as before (the hook is inert)', async () => {
    const s = await scheduleSession({ tenantId: TENANT, dialysis_patient_id: rosterB.id, session_date: today(), machine_no: 'HD-02', actorUid: ACTOR });
    const out = await cancelSession({ tenantId: TENANT, id: s.id, reason: 'transport failed', mark_no_show: true, actorUid: ACTOR });
    expect(out.status).toBe('no_show');
    expect(out.released_device).toBeNull();
  });

  test('the platform exposure handler flags an in_case dialyser and quarantines an available one; it writes nothing to dialysis_patients', async () => {
    const [before] = await sql(`SELECT hbsag_status, hcv_status, hiv_status, updated_at FROM dialysis_patients WHERE id = $1`, rosterB.id);
    const res = await quarantineDevicesExposedToPatient({ tenantId: TENANT, patientUid: PATIENT_B, marker: 'hiv', testedOn: today(), markerRowId: 1 });
    expect(Array.isArray(res.affected)).toBe(true);
    const [after] = await sql(`SELECT hbsag_status, hcv_status, hiv_status, updated_at FROM dialysis_patients WHERE id = $1`, rosterB.id);
    expect(after).toEqual(before);                                                  // no sync in this lane (spec §3.3)
  });

  test('RLS: another tenant reads no device, link or machine; the runtime role may SELECT/INSERT/UPDATE and never DELETE on all six NNN tables', async () => {
    const rows = await setTenantTx(OTHER_TENANT, (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM reprocessable_devices WHERE manufacturer_serial LIKE 'DLZ-%'`));
    expect(rows[0].n).toBe(0);
    const links = await setTenantTx(OTHER_TENANT, (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM reprocessable_device_dialysis_links`));
    expect(links[0].n).toBe(0);
    const machines = await setTenantTx(OTHER_TENANT, (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM dialysis_machines WHERE machine_no = 'HD-10'`));
    expect(machines[0].n).toBe(0);
    // Grant regression: the migration's GRANT block and prisma.js's boot-time
    // re-narrowing must agree. A table missing from runtime_mutable_no_delete_relations
    // silently falls back to the broad grants; this is the DB-backed check.
    const provisioned = runtimeRoleProvisioning.get(RLS_ROLE);
    if (provisioned?.skipped === true) { console.warn(`Skipping grant probe: ${RLS_ROLE} provisioning skipped (${provisioned.reason})`); return; }
    const probe = await sql(
      `SELECT t.name,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1::name) AS role_exists,
              COALESCE((SELECT has_table_privilege($1::name, 'public.' || t.name, 'SELECT') FROM pg_roles WHERE rolname = $1::name), false) AS can_select,
              COALESCE((SELECT has_table_privilege($1::name, 'public.' || t.name, 'INSERT') FROM pg_roles WHERE rolname = $1::name), false) AS can_insert,
              COALESCE((SELECT has_table_privilege($1::name, 'public.' || t.name, 'UPDATE') FROM pg_roles WHERE rolname = $1::name), false) AS can_update,
              COALESCE((SELECT has_table_privilege($1::name, 'public.' || t.name, 'DELETE') FROM pg_roles WHERE rolname = $1::name), false) AS can_delete
         FROM unnest($2::text[]) AS t(name) ORDER BY t.name`,
      RLS_ROLE, RPD_TABLES,
    );
    expect(probe.map((r) => r.name)).toEqual([...RPD_TABLES].sort());
    for (const row of probe) {
      expect(row.role_exists).toBe(true);
      expect(row).toMatchObject({ can_select: true, can_insert: true, can_update: true, can_delete: false });
    }
  });
});
```

Run twice on a fresh database with Phase 1 on the checkout: `npm test -- --testPathPatterns reprocessable-devices-dialysis.deep` — Expected: PASS, 14 tests, under 30 s. Without Phase 1: `1 skipped` with the SKIPPED line printed — and the PR body says so. Read the summary's `Suites failed` line separately from `Tests passed` (a hook failure shows as a failed suite with passing tests). The fixture's `tenants` / `users` column lists must match what `cath-device-reuse.deep.test.js` inserts; copy its INSERTs if these differ. The two `UPDATE dialysis_patients SET … 'unknown'` statements are **fixture neutralisation in a test file**, not a lane write — the writers pin scans lane modules, not tests — and they exist so what enrolment writes cannot move these assertions. (Q1 is decided — a legacy non-reactive `'negative'` MEANS `clear`, spec §9 — which is exactly why a suite that wants an `unknown` patient must say so explicitly rather than rely on a default.)

- [ ] **Step 8: Mutation checks and commit**

Delete the `link.dedicated_patient_uid !== session.patient_uid` refusal in `captureTx`, run the deep suite, confirm the dedication test goes red, restore. In `recordDialyserReprocessing`, replace the live `isolationDecisionTx(...)` with `usage.reuse_screen`, run the deep suite, confirm the "snapshot vs decision" test goes red on `RPD_DISPOSITION_NOT_ALLOWED` (and the call-site pin's fourth test goes red), restore. Delete the `onSessionCancelledTx(` call in `cancelSession`, run the deep suite and the call-site pin, confirm the "cancelling a scheduled session releases" test and the pin go red, restore. Replace `partialUse` with `false` in `onSessionCancelledTx`, run the deep suite, confirm the `RPD_RETURN_REQUIRED` test goes red, restore. In `computeIsolationWarnings` push `'DIALYSIS_SEROLOGY_UNKNOWN'` for `unknown`, run the rules suite and the deep suite, confirm the silence tests go red, restore.

```bash
git add apps/backend/src/services/clinical/dialysisIsolationAdapter.js apps/backend/src/services/clinical/dialysisReuseService.js apps/backend/src/services/clinical/dialysisIsolationCensus.js apps/backend/scripts/dialysis-isolation-census.mjs apps/backend/src/services/clinical/dialysisService.js apps/backend/src/routes/clinical/dialysisRoutes.js apps/backend/src/config/routeRolePolicy.js apps/backend/src/tests/unit/dialysisIsolationAdapter.test.js apps/backend/src/tests/unit/dialysisSerologyWriters.test.js apps/backend/src/tests/unit/dialysisReuseHookCallSites.test.js apps/backend/src/tests/reprocessable-devices-dialysis.deep.test.js apps/backend/src/tests/dialysis-isolation-census.deep.test.js
git commit -m "feat(dialysis): dialyser capture with dedication, un-capture on cancel, one-command reprocessing record, isolation warn rule via the Phase 1 resolver, machines, Phase 2 census

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: OT — CSSD hooks, `/reprocessable-devices` sub-tree, issue claim, theatre sets read

**Files:**
- Create: `apps/backend/src/services/cssd/cssdReuseHooks.js`
- Modify: `apps/backend/src/services/cssd/cssdService.js` (`issueSet` ≈731, `transitionIssue` ≈812, `transitionSterilizationLoad` ≈588)
- Modify: `apps/backend/src/routes/cssd/cssdRoutes.js`, `apps/backend/src/routes/theatre/theatreRoutes.js`
- Create: `apps/backend/src/tests/unit/cssdReuseHookCallSites.test.js`, `apps/backend/src/tests/reprocessable-devices-ot.deep.test.js`

- [ ] **Step 1: The hooks**

```js
// apps/backend/src/services/cssd/cssdReuseHooks.js
//
// OT consumer of the reprocessable-device platform: four hooks that run INSIDE
// cssdService's existing transactions (issue, return, cancel, load transition). Dark
// without a reprocessing_domain_policies row for the set's set_type: every hook
// returns null and cssdService behaves exactly as before 767.
//
// Spec: docs/superpowers/specs/2026-09-05-reprocessable-devices-platform-design.md §5.2.
// tests/unit/cssdReuseHookCallSites.test.js pins that every set_issue_log write
// path and both load outcomes in cssdService.js call the matching hook.

import { AppError } from '../../utils/AppError.js';
import {
  applyDeviceTransitionTx, captureDeviceTx, categoryPolicyTx, cleanText, computeDispositionOptions, getDomainSettings,
  lockDeviceBySetTx, mintDeviceTx, normalizeUsage, num, openUsageForDeviceTx, recordReuseSafetyReview, returnDeviceTx,
  screenPatientTx, stampUsageLoadTx, uncaptureDeviceTx,
} from '../clinical/reprocessableDeviceService.js';

const DOMAIN = 'ot';

// issueSet: after the set is locked and cssd's own refusals ran; before the
// set_issue_log INSERT commits. Returns { device, usage } or null (dark).
export async function onSetIssuedTx(tx, { tenantId, set, issue, otSchedule, acknowledgementReason = null, context }) {
  const policy = await categoryPolicyTx(tx, tenantId, DOMAIN, set.set_type);
  if (!policy?.reprocessable) return null;
  const settings = await getDomainSettings({ tenantId, domain: DOMAIN, db: tx });
  let device = await lockDeviceBySetTx(tx, tenantId, set.id);
  if (!device) {
    device = await mintDeviceTx(tx, { tenantId, domain: DOMAIN, category: set.set_type, enrolledVia: 'set_issue', hospitalAssetId: set.barcode, modelName: set.display_name, instrumentSetId: set.id, maxCycles: policy.max_cycles, metadata: { enrolled_from_existing_set: true, set_code: set.set_code }, context });
  }
  if (device.status === 'quarantined') throw AppError.conflict(`Set ${set.set_code} is quarantined: ${device.quarantine_reason}`, 'CSSD_SET_QUARANTINED', { quarantine_reason: device.quarantine_reason });
  let acknowledgement = null;
  if (device.exposure_flag) {
    if (settings.reactive_patient_rule !== 'override_allowed') throw AppError.conflict(`Set ${set.set_code} carries a blood-borne exposure flag`, 'CSSD_SET_EXPOSURE_BLOCKED', { exposure_markers: device.exposure_markers });
    acknowledgement = cleanText(acknowledgementReason, 2000);
    if (!acknowledgement) throw AppError.badRequest('acknowledgement.reason is required to issue an exposed set', 'CSSD_SET_ACKNOWLEDGEMENT_REQUIRED');
    await recordReuseSafetyReview(tx, { tenantId, patientUid: otSchedule.patient_uid, domain: DOMAIN, findingCode: 'EXPOSED_DEVICE_REUSED', message: `Exposed set ${set.set_code} issued`, reason: acknowledgement, actorUid: context.actorUid, payload: { device_id: device.id, ot_schedule_id: num(otSchedule.id) } });
  }
  const screen = await screenPatientTx(tx, { tenantId, patientUid: otSchedule.patient_uid, settings });
  return captureDeviceTx(tx, { device, patientUid: otSchedule.patient_uid, owner: { otScheduleId: num(otSchedule.id), setIssueLogId: num(issue.id) }, captureSource: 'cssd_issue', reuseScreen: screen, acknowledgementReason: acknowledgement, context });
}

// transitionIssue -> 'returned': the RULE decides (nobody chooses at return).
export async function onSetReturnedTx(tx, { tenantId, issue, returnCondition = null, context }) {
  const device = await lockDeviceBySetTx(tx, tenantId, issue.instrument_set_id);
  if (!device) return null;
  const usage = await openUsageForDeviceTx(tx, tenantId, device.id);
  if (!usage || usage.set_issue_log_id !== num(issue.id)) return null;
  const policy = await categoryPolicyTx(tx, tenantId, DOMAIN, device.category);
  const settings = await getDomainSettings({ tenantId, domain: DOMAIN, db: tx });
  const screen = await screenPatientTx(tx, { tenantId, patientUid: usage.patient_uid, settings });
  const options = computeDispositionOptions({ domain: DOMAIN, usage, policy, settings, restriction: screen, device });
  let disposition;
  if (options.blocked_code) disposition = 'quarantine';                                     // unknown + block_return: cannot stay in theatre
  else if (options.dispositions.includes('reprocess')) disposition = 'reprocess';           // clear, unknown+warn, restricted+override_allowed
  else if (options.dispositions.includes('quarantine')) disposition = 'quarantine';         // restricted/flagged under quarantine
  else disposition = 'discard';                                                             // restricted/flagged under discard, or the ceiling
  const forced = { ...options, dispositions: [...new Set([...options.dispositions, disposition])], requires_acknowledgement: false, quarantine_reason: options.quarantine_reason || (options.blocked_code ? 'serology_required' : null) };
  const returned = await returnDeviceTx(tx, { device, usage, disposition, postUseScreen: screen, options: forced, discardReason: options.discard_reason, context });
  if (returnCondition) await tx.$executeRawUnsafe(`UPDATE reprocessable_device_usages SET metadata = metadata || $3::jsonb WHERE tenant_id = $1::uuid AND id = $2::bigint`, tenantId, usage.id, JSON.stringify({ return_condition: returnCondition }));
  if (disposition === 'discard') {
    await tx.$executeRawUnsafe(`UPDATE instrument_sets SET usable = false, requires_reprocessing = true, updated_at = NOW() WHERE tenant_id = $1::uuid AND id = $2::bigint`, tenantId, device.instrument_set_id);
  }
  return returned;
}

// transitionIssue -> 'cancelled' (cssdService.js:908; reachable only from
// 'issued' - ISSUE_TRANSITIONS.in_theatre does not admit it). Runs BEFORE the
// shared set_issue_log UPDATE. Returns { usage, device } or null (dark, or the
// set was issued before a policy existed). A refusal here fails the cancel -
// never best-effort: a cancel that leaves the device in_case is the defect.
export async function onIssueCancelledTx(tx, { tenantId, issue, patch = {}, context }) {
  const device = await lockDeviceBySetTx(tx, tenantId, issue.instrument_set_id);
  if (!device) return null;
  const usage = normalizeUsage((await tx.$queryRawUnsafe(`SELECT * FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND set_issue_log_id = $2::bigint FOR UPDATE`, tenantId, num(issue.id)))[0] || null);
  if (!usage) return null;
  // Patient contact happened or cannot be ruled out: the set went to theatre
  // (theatre_use_started_at; cssd's own table already refuses a cancel from
  // in_theatre - this is its defensive twin for a later widening), or the
  // operator declares the pack was opened at the trolley. Either way the set
  // is RETURNED and the return rule decides; it is never released. The
  // closed-usage / 418 guards run first inside uncaptureDeviceTx.
  const packOpened = patch.pack_opened === true || patch.pack_opened === 'true' || patch.packOpened === true;
  const partialUse = issue.theatre_use_started_at != null || issue.status !== 'issued' || packOpened;
  return uncaptureDeviceTx(tx, { device, usage, partialUse, cancelTarget: 'cancelled', metadata: { set_issue_log_id: num(issue.id), pack_opened: packOpened }, context });
}

// transitionSterilizationLoad: passed increments and stamps evidence; failed quarantines.
export async function onLoadTransitionedTx(tx, { tenantId, load, status, setIds, context }) {
  const affected = [];
  if (!['passed', 'failed'].includes(status) || !setIds.length) return affected;
  for (const setId of setIds) {
    const device = await lockDeviceBySetTx(tx, tenantId, setId);
    if (!device || device.status === 'discarded' || device.status === 'in_case') continue;
    if (status === 'failed') {
      if (device.status !== 'quarantined') affected.push({ device_id: device.id, outcome: 'quarantined', reason: 'sterilization_failed', device: await applyDeviceTransitionTx(tx, device, 'quarantine', { quarantineReason: `Sterilization load ${load.load_code} failed`, metadata: { failed_load_id: num(load.id) } }, context) });
      continue;
    }
    // A passed load never clears a hold - exposure OR sterilization_failed (spec
    // §5.2): CSSD's `release` is the human acknowledgement, then the next load runs.
    if (device.status === 'quarantined') { affected.push({ device_id: device.id, outcome: 'held', reason: device.quarantine_reason }); continue; }
    const policy = await categoryPolicyTx(tx, tenantId, DOMAIN, device.category);
    if (!policy?.allowed_cycle_types.includes(load.cycle_type)) {
      affected.push({ device_id: device.id, outcome: 'quarantined', reason: `cycle_type_not_allowed:${load.cycle_type}`, device: await applyDeviceTransitionTx(tx, device, 'quarantine', { quarantineReason: `Cycle type ${load.cycle_type} is not permitted for ${device.category}`, metadata: { load_id: num(load.id) } }, context) });
      continue;
    }
    if (device.max_cycles_snapshot != null && device.cycle_count >= device.max_cycles_snapshot) {
      affected.push({ device_id: device.id, outcome: 'discarded', reason: 'max_cycles_reached', device: await applyDeviceTransitionTx(tx, device, 'discard', { discardReason: 'max_cycles_reached', discardNote: `ceiling reached at load ${load.load_code}` }, context) });
      continue;
    }
    const settled = await applyDeviceTransitionTx(tx, device, 'reprocessed', { cycleType: load.cycle_type, functionCheck: 'not_required', sterilizationLoadId: num(load.id) }, context);
    await stampUsageLoadTx(tx, tenantId, device.id, num(load.id));
    affected.push({ device_id: device.id, outcome: 'released', cycle_count: settled.cycle_count, device: settled });
  }
  return affected;
}
```

- [ ] **Step 2: Wire the hooks into `cssdService.js`**

In `issueSet` (≈731): `assertOtSchedule(prisma, tenantId, scheduleId)` runs before the transaction — change it to return the schedule row (it must select `id, patient_uid`; extend the SELECT if it does not) and keep it in `const otSchedule`. Inside the transaction, after `const issue = unwrap(rows);` and the `instrument_sets` UPDATE, add:

```js
    const reuse = await onSetIssuedTx(tx, { tenantId, set, issue, otSchedule, acknowledgementReason: data.acknowledgement?.reason ?? data.acknowledgement_reason ?? null, context: { ...context, tenantId } });
```

and carry `device_id: reuse?.device?.id ?? null, usage_id: reuse?.usage?.id ?? null` into the `recordAudit` metadata and `reprocessable_device: reuse?.device ?? null` onto the returned object. Import `onIssueCancelledTx, onSetIssuedTx, onSetReturnedTx, onLoadTransitionedTx` from `./cssdReuseHooks.js`.

In `transitionIssue`, immediately after the transition check (the `throw AppError.invalidTransition(issue.status, nextStatus, allowed)` block, :825) and **before** the shared `set_issue_log` UPDATE (:847), add:

```js
    // 767: a cancelled issue releases its register device BEFORE anything is
    // written. The hook's refusals (RPD_RETURN_REQUIRED for a pack that went to
    // theatre or is declared opened; RPD_USAGE_NOT_CANCELLABLE for a recorded
    // use) fail the cancel. Inert for every other status and for sets with no
    // policy. `patch` carries the route body, so `pack_opened` needs no wiring.
    const released = nextStatus === 'cancelled'
      ? await onIssueCancelledTx(tx, { tenantId, issue, patch, context: { ...context, tenantId } })
      : null;
```

and change the function's final `return updated;` to `return released ? { ...updated, released_device: released.device } : updated;` so every other transition's response shape is unchanged. Then, immediately after the `else if (nextStatus === 'returned') { … instrument_sets UPDATE … }` block's UPDATE, add inside that branch:

```js
      await onSetReturnedTx(tx, { tenantId, issue, returnCondition, context: { ...context, tenantId } });
```

In `transitionSterilizationLoad`, after the `if (setIds.length && status === 'passed') {…} else if (setIds.length && status === 'failed') {…}` block and before `recordAudit`, add:

```js
    const affectedDevices = await onLoadTransitionedTx(tx, { tenantId, load, status, setIds, context: { ...context, tenantId } });
```

and return `{ ...load, affected_set_ids: setIds, affected_devices: affectedDevices.map(({ device, ...rest }) => ({ ...rest, device_tag: device?.device_tag ?? null, status: device?.status ?? null })) }`.

- [ ] **Step 3: Call-site pin**

```js
// apps/backend/src/tests/unit/cssdReuseHookCallSites.test.js
// The register's OT state is kept coherent with instrument_sets / set_issue_log
// by four hooks INSIDE cssdService's transactions. A new set_issue_log write
// path or load outcome that forgets the hook drifts the two silently; this pin
// makes it fail here instead. Textual on purpose.
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../services/cssd/cssdService.js', import.meta.url), 'utf8');
const fn = (name) => { const start = source.indexOf(`async function ${name}(`); const rest = source.slice(start); const end = rest.indexOf('\n}\n'); return rest.slice(0, end); };

test('issueSet calls onSetIssuedTx after inserting the issue row', () => {
  const body = fn('issueSet');
  expect(body.indexOf('INSERT INTO set_issue_log')).toBeGreaterThan(-1);
  expect(body.indexOf('onSetIssuedTx(')).toBeGreaterThan(body.indexOf('INSERT INTO set_issue_log'));
});
test('the returned branch of transitionIssue calls onSetReturnedTx', () => {
  const body = fn('transitionIssue');
  const returned = body.indexOf("nextStatus === 'returned'");
  expect(returned).toBeGreaterThan(-1);
  expect(body.indexOf('onSetReturnedTx(', returned)).toBeGreaterThan(returned);
});
test('the cancelled branch of transitionIssue calls onIssueCancelledTx BEFORE the shared set_issue_log UPDATE', () => {
  const body = fn('transitionIssue');
  const hook = body.indexOf('onIssueCancelledTx(');
  const update = body.indexOf('UPDATE set_issue_log');
  expect(hook).toBeGreaterThan(-1);
  expect(update).toBeGreaterThan(-1);
  expect(hook).toBeLessThan(update);
  expect(body.slice(0, hook)).toMatch(/nextStatus === 'cancelled'/);
});
test('transitionSterilizationLoad calls onLoadTransitionedTx before its audit row', () => {
  const body = fn('transitionSterilizationLoad');
  expect(body.indexOf('onLoadTransitionedTx(')).toBeGreaterThan(-1);
  expect(body.indexOf('onLoadTransitionedTx(')).toBeLessThan(body.lastIndexOf('recordAudit('));
});
test('no other function writes set_issue_log', () => {
  const writers = [...source.matchAll(/(INSERT INTO|UPDATE)\s+set_issue_log/g)].length;
  // Four STATEMENTS: issueSet's INSERT, transitionIssue's ONE shared UPDATE
  // (the returned and cancelled branches both flow through it - the two branch
  // pins above cover them), the two load-outcome UPDATEs. Together with
  // dialysisService.cancelSession (pinned in dialysisReuseHookCallSites) these
  // are the six pinned write PATHS. A fifth statement here is a new path that
  // must name its hook and raise this number deliberately.
  expect(writers).toBe(4);
});
```

- [ ] **Step 4: CSSD routes**

In `apps/backend/src/routes/cssd/cssdRoutes.js` add to the imports:

```js
import * as rpd from '../../services/clinical/reprocessableDeviceService.js';
```

Replace `router.post('/issues', wrap((req) => cssd.issueSet(req.body, contextOf(req)), …))` with:

```js
// issueSet now also captures a register device (767); the response of a lost
// reply must be replayable, and a set whose issue row was written is NOT
// self-blocking on retry in the way a device transition is - hence retain.
router.post('/issues', requireIdempotencyKey({ required: true, scope: 'cssd_set_issue', retainOnServerError: true }), wrap((req) =>
  cssd.issueSet(req.body, { ...contextOf(req), idempotencyKey: req.idempotencyClaim?.requestKey || null }), { status: 201, message: 'Instrument set issued' }));
```

After the cath `/devices` block add the platform sub-tree:

```js
// The department-agnostic register (dialysis, OT; spec 2026-09-05 §6.2). Same
// role narrowing as the cath /devices sub-tree - sterile processing, the wards,
// infection control, quality, platform admin - and its OWN idempotency scope,
// so a client key can never replay one register's stored response against the
// other. No patient identity in any payload here.
router.use('/reprocessable-devices', requireRole(...CSSD_DEVICE_ROUTE_ROLES));
const rpdIdempotency = requireIdempotencyKey({ required: true, scope: 'cssd_reprocessable_device_transition' });

router.get('/reprocessable-devices', wrap((req) =>
  rpd.listDevices({ tenantId: contextOf(req).tenantId, domain: req.query.domain, status: req.query.status, facilityId: req.query.facility_id, limit: req.query.limit })));
router.get('/reprocessable-devices/:id/label', wrap((req) => rpd.getDeviceLabel(req.params.id, contextOf(req))));
router.post('/reprocessable-devices/:id/receive', rpdIdempotency, wrap((req) => rpd.receiveDevice(req.params.id, deviceContext(req)), { message: 'Device received in CSSD' }));
router.post('/reprocessable-devices/:id/reprocessed', rpdIdempotency, wrap((req) => rpd.markDeviceReprocessed(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device reprocessed' }));
router.post('/reprocessable-devices/:id/quarantine', rpdIdempotency, wrap((req) => rpd.quarantineDevice(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device quarantined' }));
router.post('/reprocessable-devices/:id/release', rpdIdempotency, wrap((req) => rpd.releaseDevice(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device released for reprocessing' }));
router.post('/reprocessable-devices/:id/discard', rpdIdempotency, wrap((req) => rpd.discardDevice(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device discarded' }));
```

`POST /issues/:id/cancel` (:157, `cssd.cancelIssue(req.params.id, req.body, contextOf(req))`) needs no route change: `req.body` reaches `transitionIssue` as `patch`, which the cancel hook reads for `pack_opened`. Document the field in the OpenAPI overlay (Task 6 Step 5).

- [ ] **Step 5: Theatre sets read**

In `theatreRoutes.js`, after `router.put('/:id/checklist', …)`:

```js
import { projectReuseRestrictionForRole } from '../../services/clinical/reprocessableDeviceService.js';
import { theatreReprocessableSets } from '../../services/theatre/theatreReuseReadService.js';

// The WHO sign-in strip's data (spec 2026-09-05 §6.3): the case's set issues
// with their register rows and load evidence, plus the patient's projected
// restriction. THEATRE_ROUTE_ROLES sits inside the serology audience today; the
// projection is applied anyway so a later widening cannot leak.
router.get('/:id/reprocessable-sets', paramId(), validate, guardTheatreCase, async (req, res) => {
  try {
    const out = await theatreReprocessableSets({ tenantId: tenantOf(req), otScheduleId: req.params.id });
    return success(res, { ...out, reuse_restriction: projectReuseRestrictionForRole(out.reuse_restriction, req.user?.role) }, 'Theatre reprocessable sets');
  } catch (err) { return relayAppError(res, err, 'Failed to load theatre sets'); }
});
```

```js
// apps/backend/src/services/theatre/theatreReuseReadService.js
import { setTenant } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { resolveReuseStatus } from '../clinical/bloodborneMarkerService.js';
import { getDomainSettings, normalizeUsage, positiveInt } from '../clinical/reprocessableDeviceService.js';

export async function theatreReprocessableSets({ tenantId, otScheduleId }) {
  const tid = requireTenantId(tenantId);
  const scheduleId = positiveInt(otScheduleId, 'ot_schedule_id');
  return setTenant(tid, async (tx) => {
    const schedule = (await tx.$queryRawUnsafe(`SELECT id, patient_uid FROM ot_schedules WHERE tenant_id = $1::uuid AND id = $2::int`, tid, scheduleId))[0];
    if (!schedule) throw AppError.notFound('OT schedule not found', 'OT_SCHEDULE_NOT_FOUND');
    const settings = await getDomainSettings({ tenantId: tid, domain: 'ot', db: tx });
    const restriction = await resolveReuseStatus({ tenantId: tid, patientUid: schedule.patient_uid, validityDays: settings.serology_validity_days, db: tx });
    const rows = await tx.$queryRawUnsafe(
      `SELECT i.id AS issue_id, i.issue_code, i.status AS issue_status, i.issued_at, i.returned_at, i.return_condition, i.issue_warning_codes,
              s.id AS instrument_set_id, s.set_code, s.display_name, s.set_type, s.status AS set_status,
              d.id AS device_id, d.device_tag, d.cycle_count, d.max_cycles_snapshot, d.status AS device_status, d.exposure_flag,
              l.id AS load_id, l.load_code, l.cycle_type, l.status AS load_status, l.biological_indicator_result, l.chemical_indicator_result, l.mechanical_indicator_result, l.released_at,
              u.id AS usage_id, u.reuse_cycle, u.post_use_disposition
         FROM set_issue_log i
         JOIN instrument_sets s ON s.id = i.instrument_set_id AND s.tenant_id = i.tenant_id
         LEFT JOIN reprocessable_devices d ON d.instrument_set_id = s.id AND d.tenant_id = s.tenant_id
         LEFT JOIN sterilization_loads l ON l.id = COALESCE(i.sterilization_load_id, s.last_passed_load_id) AND l.tenant_id = i.tenant_id
         LEFT JOIN reprocessable_device_usages u ON u.set_issue_log_id = i.id AND u.tenant_id = i.tenant_id
        WHERE i.tenant_id = $1::uuid AND i.ot_schedule_id = $2::int
        ORDER BY i.issued_at DESC, i.id DESC`, tid, scheduleId);
    return { ot_schedule_id: scheduleId, sets: rows.map((r) => ({ ...r, usage: r.usage_id ? normalizeUsage({ id: r.usage_id, device_id: r.device_id, reuse_cycle: r.reuse_cycle, post_use_disposition: r.post_use_disposition }) : null })), reuse_restriction: restriction, policy_enabled: true };
  });
}
```

- [ ] **Step 6: Deep suite**

```js
// apps/backend/src/tests/reprocessable-devices-ot.deep.test.js
// OT consumer against a real database, own tenant (…0700). Spec §5.2, §8.
import prisma, { ensureTenantRlsRuntimeRoleGrants, setTenantTx } from '../lib/prisma.js';
import { recordMarkers } from '../services/clinical/bloodborneMarkerService.js';
import { clinicalDate } from '../services/clinical/bloodborneMarkerRules.js';
import { deviceById, quarantineDevicesExposedToPatient, releaseDevice, discardDevice, upsertDomainPolicies, upsertDomainSettings } from '../services/clinical/reprocessableDeviceService.js';
import * as cssd from '../services/cssd/cssdService.js';

const describeIfDb = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL ? describe : describe.skip;
const TENANT = '00000000-0000-4000-8000-000000000700';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000701';
const PATIENT = '07000000-0000-4000-8000-000000000001';
const PATIENT_R = '07000000-0000-4000-8000-000000000002';
const SURGEON = '07000000-0000-4000-8000-0000000000aa';
// The other tenant's own patient and surgeon, so the cross-tenant implant test
// can fail on exactly ONE constraint (the load FK) rather than on whichever of
// patient / schedule / load Postgres checks first.
const PATIENT_O = '07010000-0000-4000-8000-000000000001';
const SURGEON_O = '07010000-0000-4000-8000-0000000000aa';
const ctx = { tenantId: TENANT, actorUid: SURGEON, actorRole: 'OT_NURSE' };
const sql = (t, ...a) => prisma.$queryRawUnsafe(t, ...a);
const today = () => clinicalDate(new Date());
const RPD_TABLES = ['reprocessing_domain_settings', 'reprocessing_domain_policies', 'reprocessable_devices', 'reprocessable_device_usages', 'reprocessable_device_dialysis_links', 'dialysis_machines'];
const RUNTIME_ROLES = ['vhhealth_app', 'vhhealth_runtime'];
const RLS_ROLE = 'vhhealth_runtime';
const runtimeRoleProvisioning = new Map();
const passedLoad = async (code) => {
  const load = await cssd.createSterilizationLoad({ tenantId: TENANT, load_code: code, cycle_type: 'steam', set_ids: [setA.id] }, ctx);
  return cssd.transitionSterilizationLoad(load.id, { status: 'passed', biological_indicator_result: 'passed', chemical_indicator_result: 'passed', mechanical_indicator_result: 'passed' }, ctx);
};

describeIfDb('reprocessable devices - OT', () => {
  let setA; let setDark; let caseClear; let caseReactive; let caseOther;
  beforeAll(async () => {
    const previous = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    try {
      for (const role of RUNTIME_ROLES) { process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = role; runtimeRoleProvisioning.set(role, await ensureTenantRlsRuntimeRoleGrants()); }
    } finally {
      if (previous === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE; else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previous;
    }
    await sql(`INSERT INTO tenants (id, name, slug) VALUES ($1::uuid, 'RPD OT', 'rpd-ot'), ($2::uuid, 'RPD OT other', 'rpd-ot-other') ON CONFLICT (id) DO NOTHING`, TENANT, OTHER_TENANT);
    for (const [uid, role] of [[PATIENT, 'PATIENT'], [PATIENT_R, 'PATIENT'], [SURGEON, 'DOCTOR']]) {
      await sql(`INSERT INTO users (uid, tenant_id, email, role, name, status, is_active) VALUES ($1::uuid, $2::uuid, $3, $4, $3, 'active', true) ON CONFLICT (uid) DO NOTHING`, uid, TENANT, `${uid}@rpd.test`, role);
    }
    for (const [uid, role] of [[PATIENT_O, 'PATIENT'], [SURGEON_O, 'DOCTOR']]) {
      await sql(`INSERT INTO users (uid, tenant_id, email, role, name, status, is_active) VALUES ($1::uuid, $2::uuid, $3, $4, $3, 'active', true) ON CONFLICT (uid) DO NOTHING`, uid, OTHER_TENANT, `${uid}@rpd.test`, role);
    }
    [caseOther] = await sql(`INSERT INTO ot_schedules (tenant_id, patient_uid, surgeon, procedure_name, scheduled_date, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Other tenant case', CURRENT_DATE, 'scheduled') RETURNING id, patient_uid`, OTHER_TENANT, PATIENT_O, SURGEON_O);
    await upsertDomainSettings({ tenantId: TENANT, domain: 'ot', reactive_patient_rule: 'quarantine' }, ctx);
    await upsertDomainPolicies({ tenantId: TENANT, domain: 'ot', policies: [{ category: 'instrument_set', reprocessable: true, allowed_cycle_types: ['steam'] }] }, ctx);
    setA = await cssd.createInstrumentSet({ tenantId: TENANT, set_code: 'RPD-SET-A', display_name: 'Basic laparotomy', set_type: 'instrument_set', contents: [] }, ctx);
    setDark = await cssd.createInstrumentSet({ tenantId: TENANT, set_code: 'RPD-TRAY-D', display_name: 'Dark tray', set_type: 'tray', contents: [] }, ctx);
    [caseClear] = await sql(`INSERT INTO ot_schedules (tenant_id, patient_uid, surgeon, procedure_name, scheduled_date, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Lap chole', CURRENT_DATE, 'scheduled') RETURNING id, patient_uid`, TENANT, PATIENT, SURGEON);
    [caseReactive] = await sql(`INSERT INTO ot_schedules (tenant_id, patient_uid, surgeon, procedure_name, scheduled_date, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Hernia', CURRENT_DATE, 'scheduled') RETURNING id, patient_uid`, TENANT, PATIENT_R, SURGEON);
    await recordMarkers({ tenantId: TENANT, patientUid: PATIENT, actorUid: SURGEON, entries: ['hiv', 'hbsag', 'hcv'].map((marker) => ({ marker, result: 'non_reactive', tested_on: today(), source: 'clinical_declaration' })) });
    await recordMarkers({ tenantId: TENANT, patientUid: PATIENT_R, actorUid: SURGEON, entries: [{ marker: 'hcv', result: 'reactive', tested_on: today(), source: 'clinical_declaration' }] });
  }, 30000);

  test('issue under a policy mints from the set and captures; a tray with no policy stays dark', async () => {
    const issue = await cssd.issueSet({ tenantId: TENANT, instrument_set_id: setA.id, ot_schedule_id: caseClear.id }, ctx);
    expect(issue.reprocessable_device.status).toBe('in_case');
    expect(issue.reprocessable_device.hospital_asset_id).toBe(setA.barcode);
    const dark = await cssd.issueSet({ tenantId: TENANT, instrument_set_id: setDark.id, ot_schedule_id: caseClear.id }, ctx);
    expect(dark.reprocessable_device).toBeNull();
    const [n] = await sql(`SELECT count(*)::int AS n FROM reprocessable_devices WHERE tenant_id = $1::uuid AND instrument_set_id = $2::bigint`, TENANT, setDark.id);
    expect(n.n).toBe(0);
    setA.issue = issue;
  });

  test('return on a clear patient -> awaiting; a passed load increments and stamps the usage; a forbidden cycle type quarantines', async () => {
    await cssd.returnIssuedSet(setA.issue.id, { return_condition: 'intact' }, ctx);
    expect((await deviceById({ tenantId: TENANT, deviceId: setA.issue.reprocessable_device.id })).status).toBe('awaiting_reprocessing');
    await cssd.markDecontaminated(setA.issue.id, {}, ctx);
    const load = await cssd.createSterilizationLoad({ tenantId: TENANT, load_code: 'RPD-L1', cycle_type: 'steam', set_ids: [setA.id] }, ctx);
    const passed = await cssd.transitionSterilizationLoad(load.id, { status: 'passed', biological_indicator_result: 'passed', chemical_indicator_result: 'passed', mechanical_indicator_result: 'passed' }, ctx);
    expect(passed.affected_devices).toEqual([expect.objectContaining({ outcome: 'released', cycle_count: 1 })]);
    const [u] = await sql(`SELECT sterilization_load_id FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND set_issue_log_id = $2::bigint`, TENANT, setA.issue.id);
    expect(Number(u.sterilization_load_id)).toBe(Number(load.id));
    const issue2 = await cssd.issueSet({ tenantId: TENANT, instrument_set_id: setA.id, ot_schedule_id: caseClear.id }, ctx);
    await cssd.returnIssuedSet(issue2.id, {}, ctx); await cssd.markDecontaminated(issue2.id, {}, ctx);
    const eto = await cssd.createSterilizationLoad({ tenantId: TENANT, load_code: 'RPD-L2', cycle_type: 'eto', set_ids: [setA.id] }, ctx);
    const out = await cssd.transitionSterilizationLoad(eto.id, { status: 'passed', biological_indicator_result: 'passed', chemical_indicator_result: 'passed', mechanical_indicator_result: 'passed' }, ctx);
    expect(out.affected_devices[0]).toMatchObject({ outcome: 'quarantined', reason: 'cycle_type_not_allowed:eto' });
    await releaseDevice(setA.issue.reprocessable_device.id, { note: 'wrong cycle; re-run steam' }, ctx);
    const steam = await cssd.createSterilizationLoad({ tenantId: TENANT, load_code: 'RPD-L3', cycle_type: 'steam', set_ids: [setA.id] }, ctx);
    await cssd.transitionSterilizationLoad(steam.id, { status: 'passed', biological_indicator_result: 'passed', chemical_indicator_result: 'passed', mechanical_indicator_result: 'passed' }, ctx);
    expect((await deviceById({ tenantId: TENANT, deviceId: setA.issue.reprocessable_device.id })).cycle_count).toBe(2);
  });

  test('a restricted patient under quarantine: return quarantines; the set is not re-issuable until released', async () => {
    const issue = await cssd.issueSet({ tenantId: TENANT, instrument_set_id: setA.id, ot_schedule_id: caseReactive.id }, ctx);
    await cssd.returnIssuedSet(issue.id, {}, ctx);
    const device = await deviceById({ tenantId: TENANT, deviceId: issue.reprocessable_device.id });
    expect(device).toMatchObject({ status: 'quarantined', exposure_flag: true, exposure_markers: ['hcv'] });
    await cssd.markDecontaminated(issue.id, {}, ctx);
    const load = await cssd.createSterilizationLoad({ tenantId: TENANT, load_code: 'RPD-L4', cycle_type: 'steam', set_ids: [setA.id] }, ctx);
    const out = await cssd.transitionSterilizationLoad(load.id, { status: 'passed', biological_indicator_result: 'passed', chemical_indicator_result: 'passed', mechanical_indicator_result: 'passed' }, ctx);
    expect(out.affected_devices[0].outcome).toBe('held');
    await expect(cssd.issueSet({ tenantId: TENANT, instrument_set_id: setA.id, ot_schedule_id: caseClear.id }, ctx)).rejects.toMatchObject({ code: 'CSSD_SET_QUARANTINED' });
    await releaseDevice(device.id, { note: 'ICO reviewed' }, ctx);
    const load2 = await cssd.createSterilizationLoad({ tenantId: TENANT, load_code: 'RPD-L5', cycle_type: 'steam', set_ids: [setA.id] }, ctx);
    await cssd.transitionSterilizationLoad(load2.id, { status: 'passed', biological_indicator_result: 'passed', chemical_indicator_result: 'passed', mechanical_indicator_result: 'passed' }, ctx);
    expect((await deviceById({ tenantId: TENANT, deviceId: device.id })).status).toBe('available');
  });

  test('cancel: an issued set is released (available, cycle unchanged, usage cancelled_before_use, set back to sterilized) and re-issues at the same reuse_cycle', async () => {
    const before = await deviceById({ tenantId: TENANT, deviceId: setA.issue.reprocessable_device.id });
    expect(before.status).toBe('available');                                        // after the release + passed load above
    const issue = await cssd.issueSet({ tenantId: TENANT, instrument_set_id: setA.id, ot_schedule_id: caseClear.id }, ctx);
    expect(issue.reprocessable_device.status).toBe('in_case');
    const cancelled = await cssd.cancelIssue(issue.id, { reason: 'case postponed' }, ctx);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.released_device).toMatchObject({ id: before.id, status: 'available', cycle_count: before.cycle_count, current_usage_id: null });
    const [u] = await sql(`SELECT post_use_disposition, returned_at, reuse_cycle FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND set_issue_log_id = $2::bigint`, TENANT, issue.id);
    expect(u).toMatchObject({ post_use_disposition: 'cancelled_before_use', reuse_cycle: before.cycle_count });
    expect(u.returned_at).not.toBeNull();
    const [s] = await sql(`SELECT status, usable FROM instrument_sets WHERE id = $1::bigint`, setA.id);
    expect(s).toEqual({ status: 'sterilized', usable: true });                      // cssd's own cancel branch, unchanged
    // The cycle number was not consumed: the partial unique admits the same reuse_cycle again.
    const again = await cssd.issueSet({ tenantId: TENANT, instrument_set_id: setA.id, ot_schedule_id: caseClear.id }, ctx);
    const [u2] = await sql(`SELECT reuse_cycle FROM reprocessable_device_usages WHERE tenant_id = $1::uuid AND set_issue_log_id = $2::bigint`, TENANT, again.id);
    expect(u2.reuse_cycle).toBe(before.cycle_count);
    setA.reissue = again;
  });

  test('cancel: a pack declared opened refuses (RPD_RETURN_REQUIRED) and the set stays in_case; an in_theatre issue is refused by cssd\'s table before the hook; a closed usage under an issued row refuses (RPD_USAGE_NOT_CANCELLABLE)', async () => {
    const issue = setA.reissue;
    const deviceId = issue.reprocessable_device.id;
    await expect(cssd.cancelIssue(issue.id, { reason: 'postponed', pack_opened: true }, ctx)).rejects.toMatchObject({ code: 'RPD_RETURN_REQUIRED' });
    expect((await deviceById({ tenantId: TENANT, deviceId })).status).toBe('in_case');
    expect((await sql(`SELECT status FROM set_issue_log WHERE id = $1::bigint`, issue.id))[0].status).toBe('issued'); // the refusal failed the cancel atomically
    await cssd.markTheatreUse(issue.id, {}, ctx);
    await expect(cssd.cancelIssue(issue.id, { reason: 'postponed' }, ctx)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' }); // ISSUE_TRANSITIONS.in_theatre, not the hook
    // Return it properly (clear patient -> awaiting), reprocess, back to available.
    await cssd.returnIssuedSet(issue.id, {}, ctx); await cssd.markDecontaminated(issue.id, {}, ctx);
    await passedLoad('RPD-L5B');
    // The closed-usage guard is unreachable through ISSUE_TRANSITIONS today
    // (returned -> cancelled is not admitted). Simulate the path a later
    // widening of that table would open - put a RETURNED issue's status back to
    // 'issued' and cancel it - so the platform is shown to refuse on the usage
    // rather than lean on cssd's table.
    const issue3 = await cssd.issueSet({ tenantId: TENANT, instrument_set_id: setA.id, ot_schedule_id: caseClear.id }, ctx);
    await cssd.returnIssuedSet(issue3.id, {}, ctx);
    await setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(`UPDATE set_issue_log SET status = 'issued' WHERE tenant_id = $1::uuid AND id = $2::bigint`, TENANT, issue3.id));
    await expect(cssd.cancelIssue(issue3.id, { reason: 'simulated' }, ctx)).rejects.toMatchObject({ code: 'RPD_USAGE_NOT_CANCELLABLE' });
    await setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(`UPDATE set_issue_log SET status = 'returned' WHERE tenant_id = $1::uuid AND id = $2::bigint`, TENANT, issue3.id));
    await cssd.markDecontaminated(issue3.id, {}, ctx);
    await passedLoad('RPD-L5C');
    expect((await deviceById({ tenantId: TENANT, deviceId })).status).toBe('available');
  });

  test('a failed load quarantines; a late reactive marker flags within the window; discard retires the set', async () => {
    const issue = await cssd.issueSet({ tenantId: TENANT, instrument_set_id: setA.id, ot_schedule_id: caseClear.id }, ctx);
    await cssd.returnIssuedSet(issue.id, {}, ctx); await cssd.markDecontaminated(issue.id, {}, ctx);
    const load = await cssd.createSterilizationLoad({ tenantId: TENANT, load_code: 'RPD-L6', cycle_type: 'steam', set_ids: [setA.id] }, ctx);
    const failed = await cssd.transitionSterilizationLoad(load.id, { status: 'failed', biological_indicator_result: 'failed', failure_reason: 'BI positive' }, ctx);
    expect(failed.affected_devices[0]).toMatchObject({ outcome: 'quarantined', reason: 'sterilization_failed' });
    const res = await quarantineDevicesExposedToPatient({ tenantId: TENANT, patientUid: PATIENT, marker: 'hbsag', testedOn: today(), markerRowId: 2 });
    expect(res.affected.map((d) => d.id)).toContain(issue.reprocessable_device.id);
    await discardDevice(issue.reprocessable_device.id, { reason: 'damaged', note: 'hinge cracked' }, ctx);
    const [s] = await sql(`SELECT status, retired_at FROM instrument_sets WHERE id = $1::bigint`, setA.id);
    expect(s.status).toBe('retired'); expect(s.retired_at).not.toBeNull();
  });

  test('surgical_implants.sterilization_load_id accepts a tenant load and refuses another tenant\'s with the load FK by name', async () => {
    const [load] = await sql(`SELECT id FROM sterilization_loads WHERE tenant_id = $1::uuid AND load_code = 'RPD-L1'`, TENANT);
    await setTenantTx(TENANT, (tx) => tx.$executeRawUnsafe(`INSERT INTO surgical_implants (tenant_id, patient_uid, ot_schedule_id, implant_type, sterilization_load_id) VALUES ($1::uuid, $2::uuid, $3::int, 'mesh', $4::bigint)`, TENANT, PATIENT, caseClear.id, load.id));
    // Own patient, own case, the OTHER tenant's load: the only constraint that
    // can fail is fk_surgical_implants_sterilization_load (composite on
    // tenant_id). FK checks bypass RLS, so the load row IS seen - and refused
    // because (OTHER_TENANT, load.id) matches no (tenant_id, id).
    await expect(setTenantTx(OTHER_TENANT, (tx) => tx.$executeRawUnsafe(`INSERT INTO surgical_implants (tenant_id, patient_uid, ot_schedule_id, implant_type, sterilization_load_id) VALUES ($1::uuid, $2::uuid, $3::int, 'mesh', $4::bigint)`, OTHER_TENANT, PATIENT_O, caseOther.id, load.id)))
      .rejects.toMatchObject({ code: 'P2010', message: expect.stringMatching(/23503[\s\S]*fk_surgical_implants_sterilization_load/) });
  });

  test('RLS: another tenant sees no OT device or usage; the runtime role may SELECT/INSERT/UPDATE and never DELETE on all six 767 tables', async () => {
    const [n] = await setTenantTx(OTHER_TENANT, (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM reprocessable_devices WHERE domain = 'ot'`));
    expect(n.n).toBe(0);
    const [u] = await setTenantTx(OTHER_TENANT, (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM reprocessable_device_usages WHERE domain = 'ot'`));
    expect(u.n).toBe(0);
    const provisioned = runtimeRoleProvisioning.get(RLS_ROLE);
    if (provisioned?.skipped === true) { console.warn(`Skipping grant probe: ${RLS_ROLE} provisioning skipped (${provisioned.reason})`); return; }
    const probe = await sql(
      `SELECT t.name,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1::name) AS role_exists,
              COALESCE((SELECT has_table_privilege($1::name, 'public.' || t.name, 'SELECT') FROM pg_roles WHERE rolname = $1::name), false) AS can_select,
              COALESCE((SELECT has_table_privilege($1::name, 'public.' || t.name, 'INSERT') FROM pg_roles WHERE rolname = $1::name), false) AS can_insert,
              COALESCE((SELECT has_table_privilege($1::name, 'public.' || t.name, 'UPDATE') FROM pg_roles WHERE rolname = $1::name), false) AS can_update,
              COALESCE((SELECT has_table_privilege($1::name, 'public.' || t.name, 'DELETE') FROM pg_roles WHERE rolname = $1::name), false) AS can_delete
         FROM unnest($2::text[]) AS t(name) ORDER BY t.name`,
      RLS_ROLE, RPD_TABLES,
    );
    expect(probe.map((r) => r.name)).toEqual([...RPD_TABLES].sort());
    for (const row of probe) {
      expect(row.role_exists).toBe(true);
      expect(row).toMatchObject({ can_select: true, can_insert: true, can_update: true, can_delete: false });
    }
  });
});
```

Run twice on a fresh database: `npm test -- --testPathPatterns "reprocessable-devices-ot.deep|unit/cssdReuseHookCallSites"` — Expected: PASS, 8 deep + 5 unit. If `createInstrumentSet` / `issueSet` need fields this fixture does not pass (e.g. `barcode`), read their validators and add them; do not weaken the hooks. The `P2010` message match assumes Prisma's raw-query error wraps the SQLSTATE and the constraint name (it does for every FK violation `mintDeviceTx` already relies on); if the driver surfaces `23503` under `meta.code` instead, match `meta.code` and `meta.message` — the constraint name is the assertion, never a bare `toThrow()`.

- [ ] **Step 7: Mutation check and commit**

Delete the `onSetReturnedTx` call from `transitionIssue`, run the call-site pin, confirm red, restore. Delete the `onIssueCancelledTx(` call, run the pin and the deep suite, confirm the cancelled-branch pin and the "issued set is released" test go red, restore. Replace `partialUse` with `false` in `onIssueCancelledTx`, run the deep suite, confirm the `RPD_RETURN_REQUIRED` test goes red, restore.

```bash
git add apps/backend/src/services/cssd/cssdReuseHooks.js apps/backend/src/services/cssd/cssdService.js apps/backend/src/services/theatre/theatreReuseReadService.js apps/backend/src/routes/cssd/cssdRoutes.js apps/backend/src/routes/theatre/theatreRoutes.js apps/backend/src/tests/unit/cssdReuseHookCallSites.test.js apps/backend/src/tests/reprocessable-devices-ot.deep.test.js
git commit -m "feat(cssd): OT sets on the reprocessable device register - issue/return/load hooks, queue sub-tree, theatre sets read

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: Governance mount, route wiring census, canary, OpenAPI

**Files:**
- Create: `apps/backend/src/routes/clinical/reprocessingPolicyRoutes.js`, `apps/backend/src/routes/clinical/reprocessableDeviceHistoryHandler.js`
- Modify: `apps/backend/src/config/routeRolePolicy.js` (after `CATH_REPROCESSING_POLICY_ROUTE_ROLES` ≈93), `apps/backend/src/app.js` (beside line ≈1220), `apps/admin/src/app/api/proxy/[...path]/route.ts` (`ALLOWED_PATH_PREFIXES`, after `"api/v1/cath-reprocessing"`)
- Create: `apps/backend/src/tests/unit/reprocessableDeviceRouteWiring.test.js`
- Modify: `apps/backend/src/tests/unit/serologyDisclosureCanary.test.js`, regenerate `apps/backend/src/tests/fixtures/serologyDisclosureCanary.reachable.json`
- Create: `apps/backend/scripts/openapi/schemas/reprocessableDevices.mjs`; modify `apps/backend/scripts/generate-openapi.mjs` (`SCHEMA_MODULES`); regenerate `apps/backend/src/docs/openapi.json`, sync `packages/vhhealth_core/swagger/openapi.json`. (`bloodborneMarkers.mjs` is **not** changed by this lane — the `dialysis_surveillance` source is Phase 1's; the census script lives in Task 4 Step 4.)

- [ ] **Step 1: Role alias and mount**

In `config/routeRolePolicy.js`, directly after `CATH_REPROCESSING_POLICY_ROUTE_ROLES`:

```js
// The department-agnostic reprocessing governance mount (/api/v1/reprocessing)
// has the SAME audience as the cath one - the officers who own reprocessing
// policy own it for every department. An alias, not a copy: two lists would
// drift, and the canary pins the audience by predicate, not by name.
export const REPROCESSING_POLICY_ROUTE_ROLES = CATH_REPROCESSING_POLICY_ROUTE_ROLES;

// D11 = NO (spec §4.1): the marker-class -> routing-group mapping on the dialysis
// settings row is the one field on this mount that INFECTION CONTROL owns.
// QUALITY_OFFICER reads the settings and may not rewrite the mapping; a
// technician never reaches the mount at all. An INTERSECTION, so the gate can
// never be dead, and a strict subset asserted in the wiring test.
export const ISOLATION_GROUP_ADMIN_CANDIDATES = ['INFECTION_CONTROL_OFFICER', 'ADMIN', 'SUPER_ADMIN'];
export const ISOLATION_GROUP_ADMIN_ROUTE_ROLES = REPROCESSING_POLICY_ROUTE_ROLES.filter((role) => ISOLATION_GROUP_ADMIN_CANDIDATES.includes(role));
```

In `app.js`, immediately after the `/api/v1/cath-reprocessing` mount (≈1220):

```js
// Department-agnostic reprocessing governance (spec 2026-09-05 §6.4): domain
// settings and category policies for dialysis and OT, plus the device history
// lookback (the one PHI read; it writes its own per-patient access rows).
// Clinical-mount posture like /api/v1/cath-reprocessing: no step-up, IP
// allowlist or admin rate limiter.
app.use('/api/v1/reprocessing', requireRole(...REPROCESSING_POLICY_ROUTE_ROLES), sanitizeAllBodyStrings, reprocessingPolicyRoutes);
```

with the import `import reprocessingPolicyRoutes from './routes/clinical/reprocessingPolicyRoutes.js';` beside the cath one and `REPROCESSING_POLICY_ROUTE_ROLES` added to the `routeRolePolicy.js` import list. In the admin proxy allowlist add `"api/v1/reprocessing",` after `"api/v1/cath-reprocessing"`.

- [ ] **Step 2: The router**

```js
// apps/backend/src/routes/clinical/reprocessableDeviceHistoryHandler.js
// GET .../devices/:deviceId/history - PHI with no single subject (every patient
// the device touched). Writes one hipaa_access_log row per distinct patient
// BEFORE responding, record_type by domain. Same shape as
// cathDeviceHistoryHandler.js, kept separate because the two registers differ.
import { deviceHistory, logDeviceHistoryAccess } from '../../services/clinical/reprocessableDeviceService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { relayAppError, success } from '../../utils/responseHelper.js';

export default async function reprocessableDeviceHistoryHandler(req, res) {
  try {
    const tenantId = resolveTenantOrThrow(req);
    const history = await deviceHistory({ tenantId, deviceId: req.params.deviceId });
    await logDeviceHistoryAccess({ tenantId, deviceId: req.params.deviceId, history, actor: { actorUid: req.user?.uid || null, actorRole: req.user?.role || req.user?.rawRole || null, ipAddress: req.ip || null, requestId: req.id || null } });
    return success(res, history, 'Reprocessable device history');
  } catch (err) {
    return relayAppError(res, err, 'Failed to load device history');
  }
}
```

```js
// apps/backend/src/routes/clinical/reprocessingPolicyRoutes.js
//
// /api/v1/reprocessing - department-agnostic reprocessing GOVERNANCE (dialysis,
// OT). Mounted in app.js behind REPROCESSING_POLICY_ROUTE_ROLES (an alias of the
// cath governance audience). :domain is validated BEFORE any key is claimed.
import { Router } from 'express';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { getDomainSettings, listDomainPolicies, requireDomain, upsertDomainPolicies, upsertDomainSettings } from '../../services/clinical/reprocessableDeviceService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { relayAppError, success } from '../../utils/responseHelper.js';
import reprocessableDeviceHistoryHandler from './reprocessableDeviceHistoryHandler.js';

const router = Router();
const tenantOf = (req) => resolveTenantOrThrow(req);
const contextOf = (req) => ({ actorUid: req.user?.uid || null, actorRole: req.user?.role || req.user?.rawRole || null, requestId: req.id || null, idempotencyKey: req.idempotencyClaim?.requestKey || null });

// Guard before claim: an unknown domain must not burn a key.
function requireDomainParam(req, res, next) {
  try { req.domain = requireDomain(req.params.domain); return next(); } catch (err) { return relayAppError(res, err, 'Invalid domain'); }
}
const policyIdempotency = requireIdempotencyKey({ required: true, scope: 'reprocessing_domain_policy' });

router.get('/domains/:domain/settings', requireDomainParam, async (req, res) => {
  try { return success(res, { settings: await getDomainSettings({ tenantId: tenantOf(req), domain: req.domain }) }, 'Reprocessing domain settings'); } catch (err) { return relayAppError(res, err, 'Failed to get reprocessing settings'); }
});
router.put('/domains/:domain/settings', requireDomainParam, policyIdempotency, async (req, res) => {
  try { return success(res, { settings: await upsertDomainSettings({ ...(req.body || {}), tenantId: tenantOf(req), domain: req.domain }, contextOf(req)) }, 'Reprocessing domain settings saved'); } catch (err) { return relayAppError(res, err, 'Failed to save reprocessing settings'); }
});
router.get('/domains/:domain/policies', requireDomainParam, async (req, res) => {
  try { const policies = await listDomainPolicies({ tenantId: tenantOf(req), domain: req.domain }); return success(res, { policies, count: policies.length }, 'Reprocessing domain policies'); } catch (err) { return relayAppError(res, err, 'Failed to list reprocessing policies'); }
});
router.put('/domains/:domain/policies', requireDomainParam, policyIdempotency, async (req, res) => {
  try { const policies = await upsertDomainPolicies({ tenantId: tenantOf(req), domain: req.domain, policies: req.body?.policies }, contextOf(req)); return success(res, { policies, count: policies.length }, 'Reprocessing domain policies saved'); } catch (err) { return relayAppError(res, err, 'Failed to save reprocessing policies'); }
});
router.get('/devices/:deviceId/history', reprocessableDeviceHistoryHandler);

export default router;
```

- [ ] **Step 3: Route wiring census (the prefix-mount lockout class, pinned)**

Model it on `cathDeviceReuseRouteWiring.test.js` (same mocks for `idempotencyMiddleware`, `phiAccessMiddleware`, `prisma`; walk the real routers). Assertions:

```js
// apps/backend/src/tests/unit/reprocessableDeviceRouteWiring.test.js (assertion section)
describe('role gates are intersections with their mount (prefix-mount lockout class)', () => {
  it('ISOLATION_GROUP_ADMIN_ROUTE_ROLES ⊂ REPROCESSING_POLICY_ROUTE_ROLES, and no dialysis role is on it (D11 = NO, spec §4.1)', () => {
    for (const role of ISOLATION_GROUP_ADMIN_ROUTE_ROLES) expect(REPROCESSING_POLICY_ROUTE_ROLES).toContain(role);
    expect(ISOLATION_GROUP_ADMIN_ROUTE_ROLES.length).toBeGreaterThan(0);                       // an intersection that empties is a dead gate
    expect(ISOLATION_GROUP_ADMIN_ROUTE_ROLES.length).toBeLessThan(REPROCESSING_POLICY_ROUTE_ROLES.length);   // QUALITY_OFFICER reads, cannot write
    expect(ISOLATION_GROUP_ADMIN_ROUTE_ROLES).toContain('INFECTION_CONTROL_OFFICER');
    expect(ISOLATION_GROUP_ADMIN_ROUTE_ROLES).not.toContain('QUALITY_OFFICER');
    expect(REPROCESSING_POLICY_ROUTE_ROLES).not.toContain('DIALYSIS_TECHNICIAN');              // the mount itself refuses first
  });
  it('DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES ⊂ DIALYSIS_ROUTE_ROLES', () => {
    for (const role of DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES) expect(DIALYSIS_ROUTE_ROLES).toContain(role);
    expect(DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES.length).toBeLessThan(DIALYSIS_ROUTE_ROLES.length);
    expect(DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES).toEqual(expect.arrayContaining(['NURSING_INCHARGE', 'IP_INCHARGE', 'ADMIN', 'SUPER_ADMIN']));
  });
  it('the CSSD /reprocessable-devices sub-tree reuses CSSD_DEVICE_ROUTE_ROLES ⊂ CSSD_ROUTE_ROLES', () => {
    for (const role of CSSD_DEVICE_ROUTE_ROLES) expect(CSSD_ROUTE_ROLES).toContain(role);
    const gate = cssdRouter.stack.find((l) => !l.route && l.regexp.test('/reprocessable-devices'));
    expect(gate).toBeDefined();
  });
  it('REPROCESSING_POLICY_ROUTE_ROLES is the cath governance audience, applied at the MOUNT in app.js', () => {
    expect(REPROCESSING_POLICY_ROUTE_ROLES).toBe(CATH_REPROCESSING_POLICY_ROUTE_ROLES);
    expect(APP_SOURCE).toMatch(/app\.use\('\/api\/v1\/reprocessing',\s*requireRole\(\.\.\.REPROCESSING_POLICY_ROUTE_ROLES\)/);
    expect(APP_SOURCE).not.toMatch(/app\.use\('\/api\/v1\/admin\/reprocessing/);
  });
});
describe('every command claims a key with its scope; every read does not; guards run BEFORE the claim', () => {
  it.each([
    ['POST /sessions/:id/dialyser', 'dialysis_dialyser_capture', 'guardDialysisSessionParam'],
    ['POST /sessions/:id/reuse-register', 'dialysis_reuse_register', 'guardDialysisSessionParam'],
    ['PATCH /sessions/:id/machine', 'dialysis_session_machine', 'guardDialysisSessionParam'],
    ['POST /machines', 'dialysis_machine', null],
    ['PATCH /machines/:id', 'dialysis_machine', null],
  ])('dialysis %s claims %s after its guard', (key, scope, guardName) => {
    const entry = DIALYSIS.get(key); expect(entry).toBeDefined();
    const claim = claimInstanceFor(scope); expect(claim).not.toBeNull();
    const claimIndex = entry.handles.indexOf(claim.instance); expect(claimIndex).toBeGreaterThan(-1);
    if (guardName) expect(entry.names.indexOf(guardName)).toBeLessThan(claimIndex);
  });
  it('dialysis_reuse_register and cssd_set_issue retain on server error; device transitions do not', () => {
    expect(optionsFor('dialysis_reuse_register').retainOnServerError).toBe(true);
    expect(optionsFor('cssd_set_issue').retainOnServerError).toBe(true);
    expect(optionsFor('cssd_reprocessable_device_transition').retainOnServerError).toBeFalsy();
  });
  it.each(['receive', 'reprocessed', 'quarantine', 'release', 'discard'])('POST /reprocessable-devices/:id/%s claims cssd_reprocessable_device_transition', (action) => {
    const entry = CSSD.get(`POST /reprocessable-devices/:id/${action}`); expect(entry).toBeDefined();
    expect(entry.handles).toContain(claimInstanceFor('cssd_reprocessable_device_transition').instance);
  });
  it('GET /reprocessable-devices, GET .../label and GET /sessions/:id/dialyser claim nothing', () => {
    for (const key of [['CSSD', 'GET /reprocessable-devices'], ['CSSD', 'GET /reprocessable-devices/:id/label'], ['DIALYSIS', 'GET /sessions/:id/dialyser']]) {
      const entry = (key[0] === 'CSSD' ? CSSD : DIALYSIS).get(key[1]); expect(entry.names).not.toContain(IDEMPOTENCY_NAME);
    }
  });
  it('the governance PUTs validate :domain BEFORE the claim; the GETs claim nothing', () => {
    for (const key of ['PUT /domains/:domain/settings', 'PUT /domains/:domain/policies']) {
      const entry = POLICY.get(key); expect(entry.names.indexOf('requireDomainParam')).toBeLessThan(entry.handles.indexOf(claimInstanceFor('reprocessing_domain_policy').instance));
    }
    for (const key of ['GET /domains/:domain/settings', 'GET /domains/:domain/policies', 'GET /devices/:deviceId/history']) expect(POLICY.get(key).names).not.toContain(IDEMPOTENCY_NAME);
  });
  it('the enrol route is untouched by this lane (its guard, if any, is Phase 1\'s)', () => {
    const entry = DIALYSIS.get('POST /patients');
    expect(entry).toBeDefined();
    expect(entry.names).not.toContain(IDEMPOTENCY_NAME);
    expect(entry.names.some((n) => /reprocess|dialyser|rpd/i.test(n))).toBe(false);
  });
  it('every role these gates decide on is a real role', async () => {
    const { ALL_ROLES } = await import('../../utils/roles.js');
    for (const role of [...DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES, ...REPROCESSING_POLICY_ROUTE_ROLES]) expect(ALL_ROLES).toContain(role);
  });
});
```

`optionsFor(scope)` returns the options object the spied `requireIdempotencyKey` factory was called with for that scope; `DIALYSIS`, `CSSD`, `POLICY` are `routeTable(...)` maps built exactly as the cath wiring test builds them (mock `dialysisService.js`, `dialysisReuseService.js`, `cssdService.js`, `reprocessableDeviceService.js` with `jest.fn()` exports before importing the routers). Run: `npm test -- --testPathPatterns unit/reprocessableDeviceRouteWiring` — Expected: PASS.

- [ ] **Step 4: The canary gains three mounts**

In `serologyDisclosureCanary.test.js`:

(a) Imports: `dialysisRoutes`, `cssdRoutes`, `reprocessingPolicyRoutes`, and `DIALYSIS_ROUTE_ROLES`, `CSSD_ROUTE_ROLES`, `REPROCESSING_POLICY_ROUTE_ROLES`. Extend the module mocks so the dialysis and CSSD routers can answer: mock `dialysisService.js` (every export → a stub returning the poisoned roster row / session / today rows), `dialysisReuseService.js` (`getSessionDialyser` → `{ usage: null, device: null, link: null, reuse_restriction: POISONED_DECISION, allowed_dispositions: null, isolation: POISONED_ISOLATION, policy_enabled: true }`, `captureDialyser` → the same object, `listMachines` → `[]`; the dialysis mock never touches `dialysisIsolationAdapter.js`, so the canary runs with or without Phase 1 on the checkout), `cssdService.js` (list functions → `[]`, `getCssdBoard` → `{}`), `reprocessableDeviceService.js` (`listDevices` → one device row with **no** patient keys, `getDomainSettings`/`listDomainPolicies` → defaults, `deviceHistory` → `{ device, uses: [{ patient_uid: PATIENT }], transitions: [] }`, `logDeviceHistoryAccess` → `{ logged: 1 }`), `dialysisMachineService.js` (`ingestMachineObservations` → `{}`). `POISONED_RESTRICTION` (the cath/OT shape, used by the theatre read) = `{ status: 'restricted', reasons: [\`HBsAg reactive ${SENTINEL}\`], markers: [{ marker: 'hbsag', result: 'reactive', tested_on: '2026-08-12' }], validity_days: 90, evaluated_at: new Date().toISOString() }`; `POISONED_DECISION` (the Phase 1 shape, used by the dialysis mocks) = `{ status: 'restricted', asOf: new Date().toISOString(), reasons: [\`HBsAg reactive ${SENTINEL}\`], evidence: 'marker', isolation_class: 'hbsag', markers: [{ marker: 'hbsag', result: 'reactive', tested_on: '2026-08-12' }] }` — the `markers` key **and** the `isolation_class` are poisoned on purpose: a route that forwards an unprojected Decision fails on the markers, and one that forwards a class it never asked for fails on the D11 sentinel below. `POISONED_ISOLATION` (the warning envelope) = `{ codes: ['DIALYSIS_ISOLATION_MACHINE_MISMATCH'], isolation_warnings: [{ code: 'DIALYSIS_ISOLATION_MACHINE_MISMATCH', machine_id: 7, severity: 'warn', required_group: 'Bay 1' }], warn_only: true, enforcement_enabled: false, override: null }` — the live shape of spec §3.4 under D11 = NO, carrying the tenant's bay label and **no** `required_class`. The resting `required_group: 'Bay 1'` is itself a standing assertion: it must stay **green** for every reader, because a bay label is not a marker class. The mutation check below is what proves the sentinel would catch a class in the same slot. The poisoned roster row: `{ id: 1, patient_uid: PATIENT, hbsag_status: SENTINEL, hcv_status: 'negative', hiv_status: 'negative', isolation_required: true }`; poisoned serology row `{ test_date: '2026-08-01', hbsag: SENTINEL, anti_hcv: 'negative', hiv: 'negative', is_seroconversion: true }` inside `getPatient`'s `serology`.

(b) `MOUNTS` gains:

```js
  { prefix: '/api/v1/dialysis', router: dialysisRoutes, roles: DIALYSIS_ROUTE_ROLES },
  { prefix: '/api/v1/cssd', router: cssdRoutes, roles: CSSD_ROUTE_ROLES },
  { prefix: '/api/v1/reprocessing', router: reprocessingPolicyRoutes, roles: REPROCESSING_POLICY_ROUTE_ROLES },
```

(c) The disclosure predicate (`disclosures(body)`) gains, inside the `walkJson` loop after the existing checks:

```js
    for (const key of ['hbsag_status', 'hcv_status', 'hiv_status', 'hbsag', 'anti_hcv', 'hiv', 'hbs_titre', 'hcv_pcr']) {
      if (key in node && node[key] != null) leaks.push(`${path}.${key} = ${JSON.stringify(node[key])}`);
    }
    if (node.is_seroconversion === true) leaks.push(`${path}.is_seroconversion === true`);
    for (const key of ['reuse_restriction', 'restriction']) {
      const r = node[key];
      if (r && typeof r === 'object' && ((Array.isArray(r.reasons) && r.reasons.length) || (Array.isArray(r.markers) && r.markers.length))) leaks.push(`${path}.${key} carries reasons/markers`);
    }
    leaks.push(...isolationClassLeaks(node, path));
```

and, beside `serologyItemLeaks` and mirroring it exactly — a **VALUE** test against a named set, on a node identified by its own shape, which is how `critical_items` is already checked:

```js
// D11 = NO (spec §2): a PATIENT's isolation class must not reach a non-entitled
// role in any shape - and since the owner decided NO, a hit here is no longer an
// open question parked in a test but an unambiguous DEFECT: `required_class` is
// retired, nothing in the lane computes one, so a marker-class value under
// either key means a regression put it back. The key may be absent or null -
// only a marker-class STRING fails, which is why this reads values and not keys.
// `isolation_mixed` counts: it still says a marker isolates this patient.
// `required_group` is NOT in the set and must never be added: it is a tenant's
// label for a bay, published to every dialysis role by design.
// A node carrying `machine_no` is a dialysis_machines row; its own
// isolation_group is EQUIPMENT data that GET /machines publishes, a bay label
// and not a marker class, so it is not in the value set and could not trip this
// even without the guard. The guard STAYS anyway, so that a future machine
// column - or a fixture that revives isolation_class on a machine row - cannot
// be read as a patient's class.
const ISOLATION_CLASS_VALUES = new Set([...SEROLOGY_CODES, 'isolation_mixed']);
// Population counters for the liveness test below: a VALUE walk over zero
// matching nodes passes vacuously, so the suite must prove the poisoned
// envelope and the poisoned Decision were actually visited.
const d11Population = { warningNodes: 0, decisionNodes: 0 };
function isolationClassLeaks(node, where) {
  const leaks = [];
  if (node.machine_no != null) return leaks;
  if (typeof node.code === 'string' && 'machine_id' in node && 'severity' in node) d11Population.warningNodes += 1;
  if (typeof node.status === 'string' && 'evidence' in node && 'asOf' in node) d11Population.decisionNodes += 1;
  for (const key of ['isolation_class', 'required_class']) {
    if (node[key] != null && ISOLATION_CLASS_VALUES.has(String(node[key]))) {
      leaks.push(`${where}.${key} = ${JSON.stringify(node[key])} (a patient's isolation class - D11)`);
    }
  }
  return leaks;
}
```

(c2) **Population (liveness) assertion - the walk must have something to check.** Under the interim payload (spec §3.4) no response legitimately carries a patient's class, so the value sweep in (c) has a population of **zero by design** and can only ever prove absence; on its own it would also pass over a fixture that never reached a body (an unmounted route, a mock that stopped returning `POISONED_ISOLATION`, a walker that skipped arrays). Add one test that runs AFTER the non-entitled sweep and fails as an inert fixture rather than passing over nothing:

```js
test('the D11 sentinel walk has a population: the poisoned isolation envelope and Decision were visited, and the poison is still armed', async () => {
  // Two SHAPE counters (the walker ran) and one POSITIVE CONTROL (the fixture is
  // still poison). Shape counting cannot tell a poisoned entry from a benign one -
  // the isolation envelope carries nothing poisonous at rest, by design (D11 =
  // NO) - so the positive control reads fixture-distinctive values through a REAL
  // entitled body: the Decision's sentinel-bearing reasons and the envelope's
  // fixture machine_id (7). The message names the class of failure so the next
  // reader does not have to reconstruct it from a bare number.
  const inert = [];
  if (d11Population.warningNodes === 0) inert.push('no isolation_warnings entries (code + machine_id + severity) were visited');
  if (d11Population.decisionNodes === 0) inert.push('no Decision-shaped nodes (status + evidence + asOf) were visited');
  const entitled = ENTITLED_ALLOW_LIST[0]; // any serology-audience role that DIALYSIS_ROUTE_ROLES admits
  const res = await request(app).get('/api/v1/dialysis/sessions/1/dialyser').set(roleHeaders(entitled));
  const body = res.body?.data ?? res.body;
  const reasons = body?.reuse_restriction?.reasons ?? [];
  if (!reasons.some((r) => String(r).includes(SENTINEL))) inert.push(`entitled role ${entitled} did not receive the poisoned reuse_restriction.reasons sentinel (status ${res.status})`);
  if (body?.isolation?.isolation_warnings?.[0]?.machine_id !== 7) inert.push('the fixture isolation envelope (machine_id 7) did not reach the entitled body');
  if (inert.length) {
    throw new Error(`INERT FIXTURE: the D11 value walk had nothing to check - ${inert.join('; ')}. `
      + `Either POISONED_ISOLATION / POISONED_DECISION stopped reaching a body, a dialysis mount is missing, `
      + `or the walker skipped arrays. ${JSON.stringify(d11Population)}`);
  }
});
```

**What each assertion proves live - keep them attributed, because they are NOT one guarantee:**

| Assertion | Proves | Does NOT prove |
|---|---|---|
| `warningNodes > 0` | the walker reached `isolation_warnings[]` entries of the right SHAPE | that the entry came from `POISONED_ISOLATION` (a benign entry satisfies it) |
| `decisionNodes > 0` | the walker reached Decision-shaped nodes | that the Decision was the poisoned one |
| entitled body carries the `reasons` sentinel | the `POISONED_DECISION` stub still flows through a real body (Decision fixture live) | anything about the isolation envelope - untouched by any change to `POISONED_ISOLATION` |
| entitled body carries `isolation_warnings[0].machine_id === 7` | the `POISONED_ISOLATION` envelope still flows through a real body (isolation fixture live, in-suite) | that a class VALUE on that entry would be caught |
| mutation (12) (`required_class: 'hbsag'` added -> red) | the value sentinel fires on the exact entry the walker scans | (manual; not an in-suite guarantee) |

Deleting any row because another "already covers it" is how the canary goes quiet: (12) is the only proof the value sentinel bites on that entry; the `machine_id` control is the only IN-SUITE proof the isolation fixture reached a body; the `reasons` pin covers the Decision fixture and nothing else.

Reset both counters in the sweep's `beforeAll` so the numbers describe this run. The positive control is IN the code above, not beside it: an **entitled** role's body over `GET /sessions/:id/dialyser` must carry the poisoned `reuse_restriction.reasons` sentinel (the existing entitled-sees pattern) and the fixture's envelope (`machine_id: 7`, a value nothing benign would produce). Shape counting proves the WALKER ran; only sentinel-bearing bodies prove the FIXTURE is still armed - a benign warning entry satisfies the shape test and would leave both shape counters and the value sentinel green with the fixture inert, which is the state (c2) exists to make impossible (mutation (15)).

(d) Regenerate the snapshot deliberately and read the diff:

```bash
CANARY_WRITE_SNAPSHOT=1 node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --testPathPatterns serologyDisclosureCanary
git diff --stat apps/backend/src/tests/fixtures/serologyDisclosureCanary.reachable.json
npm test -- --testPathPatterns serologyDisclosureCanary
```

Expected: the first run rewrites the fixture and FAILS on purpose; the diff shows only ADDED routes under the three new prefixes (no existing line changed — a changed existing line means a mount role set moved and must be explained); the second run PASSES with the coverage floor met and `CATH_LAB_STAFF` still reading the sentinel. If a dialysis GET leaks for `DIALYSIS_TECHNICIAN` / `BLOOD_BANK_STAFF` / `BLOOD_BANK_TECHNICIAN`, the projection in Task 4 Step 6 is missing on that route — fix the route, never the predicate.

(e) **Mutation check on the new sentinel** (a test that cannot fail proves nothing — the PR #973 lesson). Add `required_class: 'hbsag'` to `POISONED_ISOLATION`'s warning entry, **beside** its resting `required_group: 'Bay 1'` (a list payload, the exact regression D11 = NO guards), and re-run:

```bash
npm test -- --testPathPatterns serologyDisclosureCanary
```

Expected: **RED — one failure per non-entitled reader of every dialysis route that returns the object, three today** (`DIALYSIS_TECHNICIAN`, `BLOOD_BANK_TECHNICIAN`, `BLOOD_BANK_STAFF` — the three §3.5 names in `DIALYSIS_ROUTE_ROLES` and outside `ENTITLED`), each naming `…isolation_warnings[0].required_class = "hbsag"`. Restore — the entry goes back to `required_group: 'Bay 1'` alone, which must be **green** (the un-mutated suite already asserts it, and that is the second half of this check: a bay label in the same slot is not a leak). Two notes for whoever runs it: the count is `reachable − ENTITLED` per route, so it rises with every new dialysis GET that carries the object and falls to **zero** if D10 widens the audience to those three roles — a D10 = YES makes this particular mutation vacuous, which is precisely why D10 and D11 were answered separately (spec §3.5); and `'general'` in that slot is meaningless now that the machine column is `isolation_group` — the green arm of this mutation is the group label, not a retired enum member.

- [ ] **Step 5: OpenAPI overlay**

```js
// apps/backend/scripts/openapi/schemas/reprocessableDevices.mjs
// Department-agnostic reprocessable devices (dialysis, OT).
// Spec: docs/superpowers/specs/2026-09-05-reprocessable-devices-platform-design.md
import { envelope, listEnvelope } from './_helpers.mjs';

const DOMAINS = ['dialysis', 'ot'];
const DEVICE_STATUSES = ['awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded'];
const CYCLE_TYPES = ['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other'];
const DISCARD_REASONS = ['max_cycles_reached', 'bloodborne_exposure', 'late_reactive_marker', 'function_check_failed', 'sterilization_failed', 'damaged', 'wasted', 'policy_change', 'other', 'tcv_below_threshold', 'integrity_test_failed', 'set_retired'];
const DISPOSITIONS = ['sent_for_reprocessing', 'quarantined_bloodborne_exposure', 'discarded_bloodborne_exposure', 'discarded_max_cycles', 'discarded_integrity_failed', 'discarded_tcv_below_threshold', 'discarded_other'];
// D11 = NO: the MARKER classes (the Decision's vocabulary and the keys of the
// tenant's isolation_groups map). A machine's routing key is a free-text group,
// not a member of this list.
const ISOLATION_CLASSES = ['hbsag', 'hcv', 'hiv', 'isolation_mixed'];
const ISOLATION_WARNING_CODES = ['DIALYSIS_MACHINE_UNREGISTERED', 'DIALYSIS_ISOLATION_MACHINE_MISMATCH', 'DIALYSIS_GENERAL_PATIENT_ON_ISOLATION_MACHINE'];
const AGENTS = ['peracetic_acid', 'formaldehyde', 'glutaraldehyde', 'renalin', 'other'];
const ns = { type: 'string', nullable: true }; const ni = { type: 'integer', nullable: true }; const nd = { type: 'string', format: 'date-time', nullable: true }; const nn = { type: 'number', nullable: true };
const BIGINT_WIRE = { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9][0-9]*$' }] };
const idem = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_\\-:.]+$' } };
const q = (name, schema) => ({ name, in: 'query', required: false, schema });

export const ENUMS = { ReprocessingDomain: DOMAINS, ReprocessableDeviceStatus: DEVICE_STATUSES, ReprocessableDeviceDiscardReason: DISCARD_REASONS, DialysisIsolationClass: ISOLATION_CLASSES, DialysisReprocessingAgent: AGENTS };

export const schemas = {
  ReprocessableDevice: { type: 'object', additionalProperties: false, required: ['id', 'tenant_id', 'domain', 'category', 'facility_id', 'device_tag', 'manufacturer_serial', 'hospital_asset_id', 'manufacturer', 'model_name', 'instrument_set_id', 'enrolled_via', 'cycle_count', 'max_cycles_snapshot', 'status', 'current_usage_id', 'exposure_flag', 'exposure_markers', 'last_reprocessed_at', 'last_reprocessed_by', 'last_cycle_type', 'last_function_check', 'last_sterilization_load_id', 'quarantine_reason', 'quarantined_at', 'discard_reason', 'discard_note', 'discarded_at', 'discarded_by', 'created_by', 'created_at', 'updated_at', 'metadata', 'set_code', 'set_display_name', 'set_status', 'item_name'],
    properties: { id: { type: 'integer' }, tenant_id: { type: 'string', format: 'uuid' }, domain: { type: 'string', enum: DOMAINS }, category: { type: 'string' }, facility_id: ni, device_tag: { type: 'string', pattern: '^RD[0-9]{8,19}$' }, manufacturer_serial: ns, hospital_asset_id: ns, manufacturer: ns, model_name: ns, instrument_set_id: ni, enrolled_via: { type: 'string', enum: ['session_capture', 'set_issue', 'console'] }, cycle_count: { type: 'integer' }, max_cycles_snapshot: ni, status: { type: 'string', enum: DEVICE_STATUSES }, current_usage_id: ni, exposure_flag: { type: 'boolean' }, exposure_markers: { type: 'array', items: { type: 'string' } }, last_reprocessed_at: nd, last_reprocessed_by: { ...ns, format: 'uuid' }, last_cycle_type: { ...ns, enum: [...CYCLE_TYPES, null] }, last_function_check: { ...ns, enum: ['not_required', 'pass', 'fail', null] }, last_sterilization_load_id: ni, quarantine_reason: ns, quarantined_at: nd, discard_reason: { ...ns, enum: [...DISCARD_REASONS, null] }, discard_note: ns, discarded_at: nd, discarded_by: { ...ns, format: 'uuid' }, created_by: { type: 'string', format: 'uuid' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' }, metadata: { type: 'object', additionalProperties: true }, set_code: ns, set_display_name: ns, set_status: ns, item_name: ns } },
  ReprocessableDeviceUsage: { type: 'object', additionalProperties: true, required: ['id', 'domain', 'device_id', 'patient_uid', 'reuse_cycle', 'captured_at', 'capture_source', 'post_use_disposition', 'returned_at'],
    properties: { id: { type: 'integer' }, domain: { type: 'string', enum: DOMAINS }, device_id: { type: 'integer' }, patient_uid: { type: 'string', format: 'uuid' }, dialysis_session_id: ni, ot_schedule_id: ni, set_issue_log_id: ni, sterilization_load_id: ni, reuse_cycle: { type: 'integer' }, captured_at: { type: 'string', format: 'date-time' }, capture_source: { type: 'string', enum: ['staff_app', 'admin_console', 'cssd_issue', 'system'] }, post_use_disposition: { ...ns, enum: [...DISPOSITIONS, null] }, returned_at: nd } },
  ReprocessableDeviceLabel: { type: 'object', additionalProperties: false, required: ['device_id', 'device_tag', 'external_ref', 'domain', 'item_name', 'cycle_count', 'barcode', 'barcode_symbology', 'svg', 'generated_at'],
    properties: { device_id: { type: 'integer' }, device_tag: { type: 'string' }, external_ref: ns, domain: { type: 'string', enum: DOMAINS }, item_name: ns, cycle_count: { type: 'integer' }, barcode: { type: 'string' }, barcode_symbology: { type: 'string', enum: ['code39'] }, svg: { type: 'string' }, generated_at: { type: 'string', format: 'date-time' } } },
  // isolation_groups (D11 = NO): keys are the four MARKER CLASSES, values the
  // tenant's bay labels. `warnings` is advisory - a group on no machine is saved
  // and reported, never refused (spec §4.1).
  ReprocessingDomainSettings: { type: 'object', additionalProperties: true, required: ['domain', 'reactive_patient_rule', 'unknown_serology_rule', 'serology_validity_days', 'isolation_enforcement', 'isolation_groups', 'configured'],
    properties: { domain: { type: 'string', enum: DOMAINS }, reactive_patient_rule: { type: 'string', enum: ['discard', 'quarantine', 'override_allowed'] }, unknown_serology_rule: { type: 'string', enum: ['warn', 'block_return'] }, serology_validity_days: { type: 'integer', minimum: 1, maximum: 365 }, isolation_enforcement: { type: 'string', enum: ['warn', 'block'] }, isolation_groups: { type: 'object', additionalProperties: false, properties: Object.fromEntries(ISOLATION_CLASSES.map((c) => [c, { type: 'string', maxLength: 40 }])) }, warnings: { type: 'array', items: { type: 'string' } }, configured: { type: 'boolean' }, reviewed_at: nd } },
  ReprocessingDomainSettingsUpdateRequest: { type: 'object', additionalProperties: false, properties: { reactive_patient_rule: { type: 'string', enum: ['discard', 'quarantine', 'override_allowed'] }, unknown_serology_rule: { type: 'string', enum: ['warn', 'block_return'] }, serology_validity_days: { type: 'integer', minimum: 1, maximum: 365 }, isolation_enforcement: { type: 'string', enum: ['warn', 'block'] }, isolation_groups: { type: 'object', additionalProperties: false, properties: Object.fromEntries(ISOLATION_CLASSES.map((c) => [c, { ...ns, maxLength: 40 }])) } } },
  ReprocessingDomainPolicy: { type: 'object', additionalProperties: true, required: ['domain', 'category', 'reprocessable', 'max_cycles', 'allowed_cycle_types', 'function_check_required', 'tcv_min_pct'],
    properties: { domain: { type: 'string', enum: DOMAINS }, category: { type: 'string' }, reprocessable: { type: 'boolean' }, max_cycles: ni, allowed_cycle_types: { type: 'array', items: { type: 'string', enum: CYCLE_TYPES } }, function_check_required: { type: 'boolean' }, tcv_min_pct: ni } },
  ReprocessingDomainPoliciesUpdateRequest: { type: 'object', additionalProperties: false, required: ['policies'], properties: { policies: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['category', 'reprocessable'], properties: { category: { type: 'string' }, reprocessable: { type: 'boolean' }, max_cycles: ni, allowed_cycle_types: { type: 'array', items: { type: 'string', enum: CYCLE_TYPES } }, function_check_required: { type: 'boolean' }, tcv_min_pct: ni } } } } },
  // D11 = NO: isolation_group is a tenant label, nullable (NULL = a general
  // machine), with NO enum - the vocabulary is the tenant's and names no marker.
  DialysisMachine: { type: 'object', additionalProperties: true, required: ['id', 'machine_no', 'isolation_group', 'status'], properties: { id: { type: 'integer' }, facility_id: ni, machine_no: { type: 'string' }, display_name: ns, biomed_device_id: ni, isolation_group: { ...ns, maxLength: 40 }, status: { type: 'string', enum: ['active', 'out_of_service', 'retired'] }, notes: ns } },
  DialysisMachineRequest: { type: 'object', additionalProperties: false, properties: { machine_no: { type: 'string', maxLength: 40 }, display_name: { type: 'string', maxLength: 120 }, facility_id: ni, biomed_device_id: ni, isolation_group: { ...ns, maxLength: 40 }, status: { type: 'string', enum: ['active', 'out_of_service', 'retired'] }, notes: { type: 'string', maxLength: 2000 } } },
  // Three codes: `unknown` raises nothing per session (spec §3.3 / §3.4).
  // D11 = NO: each warning carries the tenant's `required_group` - a bay label -
  // and NEVER a marker class. `additionalProperties: false` on both the envelope
  // and the warning item means a payload that starts carrying `required_class`
  // fails openapi:check before a reviewer sees it (spec §3.4). The shape is
  // enforced, not merely documented.
  DialysisIsolation: { type: 'object', additionalProperties: false, required: ['codes', 'isolation_warnings', 'warn_only', 'enforcement_enabled', 'override'], properties: { codes: { type: 'array', items: { type: 'string', enum: ISOLATION_WARNING_CODES } }, isolation_warnings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'machine_id', 'severity', 'required_group'], properties: { code: { type: 'string', enum: ISOLATION_WARNING_CODES }, machine_id: ni, severity: { type: 'string', enum: ['warn', 'block'] }, required_group: { ...ns, maxLength: 40 } } } }, warn_only: { type: 'boolean' }, enforcement_enabled: { type: 'boolean' }, override: { type: 'object', nullable: true, additionalProperties: true } } },
  // The Phase 1 resolver's Decision as this lane returns it (spec §3.3): projected by role
  // (reasons emptied for non-audience roles); `markers` is never present on these surfaces.
  // isolation_class is OPTIONAL and, on every surface this overlay describes,
  // always null: the class is opt-in on the resolver (spec §3.3), no read
  // surface asks for it, and the projection blanks it. It stays in `properties`
  // so the key is documented as blanked rather than silently dropped.
  DialysisIsolationDecision: { type: 'object', additionalProperties: false, required: ['status', 'asOf', 'reasons', 'evidence'], properties: { status: { type: 'string', enum: ['restricted', 'unknown', 'clear'] }, asOf: nd, reasons: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string', enum: ['marker', 'legacy_declaration', 'none'] }, isolation_class: { ...ns, enum: [...ISOLATION_CLASSES, null] } } },
  DispositionOptions: { type: 'object', additionalProperties: false, required: ['dispositions', 'requires_acknowledgement', 'exposure', 'discard_reason', 'quarantine_reason', 'blocked_code', 'reason_codes', 'units_max'], properties: { dispositions: { type: 'array', items: { type: 'string', enum: ['reprocess', 'quarantine', 'discard'] } }, requires_acknowledgement: { type: 'boolean' }, exposure: { type: 'boolean' }, discard_reason: ns, quarantine_reason: ns, blocked_code: ns, reason_codes: { type: 'array', items: { type: 'string' } }, units_max: { type: 'integer' } } },
  DialysisSessionDialyser: { type: 'object', additionalProperties: false, required: ['usage', 'device', 'link', 'reuse_restriction', 'allowed_dispositions', 'isolation', 'policy_enabled'], properties: { usage: { allOf: [{ $ref: '#/components/schemas/ReprocessableDeviceUsage' }], nullable: true }, device: { allOf: [{ $ref: '#/components/schemas/ReprocessableDevice' }], nullable: true }, link: { type: 'object', nullable: true, additionalProperties: true }, reuse_restriction: { $ref: '#/components/schemas/DialysisIsolationDecision' }, allowed_dispositions: { allOf: [{ $ref: '#/components/schemas/DispositionOptions' }], nullable: true }, isolation: { $ref: '#/components/schemas/DialysisIsolation' }, policy_enabled: { type: 'boolean' } } },
  DialyserCaptureRequest: { type: 'object', additionalProperties: false, properties: { manufacturer_serial: { type: 'string', maxLength: 120 }, device_tag: { type: 'string', pattern: '^[Rr][Dd][0-9]{8,19}$' }, model_name: { type: 'string', maxLength: 120 }, manufacturer: { type: 'string', maxLength: 120 }, hospital_asset_id: { type: 'string', maxLength: 120 }, baseline_tcv_ml: nn, initial_cycle_count: { type: 'integer', minimum: 0, maximum: 100 }, exposure_acknowledgement: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', maxLength: 2000 } } } } },
  DialyserReuseRegisterRequest: { type: 'object', additionalProperties: true, properties: { dialyzer_serial: { type: 'string', maxLength: 80 }, reuse_cycle_count: { type: 'integer', minimum: 0, maximum: 100, description: 'Derived from the device when one is captured; a disagreeing value is refused (DIALYZER_REUSE_CYCLE_DERIVED).' }, integrity_test_result: { type: 'string', enum: ['pending', 'pass', 'fail', 'not_done'] }, integrity_test_method: { type: 'string', maxLength: 120 }, disinfectant: { type: 'string', maxLength: 80 }, status: { type: 'string', enum: ['in_use', 'discarded', 'quarantined'] }, discard_reason: { type: 'string', maxLength: 255 }, notes: { type: 'string', maxLength: 2000 }, measured_tcv_ml: nn, reprocessing_agent: { type: 'string', enum: AGENTS }, disinfectant_contact_minutes: { type: 'integer', minimum: 0, maximum: 1440 }, disinfectant_concentration_pct: nn, acknowledgement: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', maxLength: 2000 } } } } },
  DialysisSessionMachineRequest: { type: 'object', additionalProperties: false, required: ['machine_no'], properties: { machine_no: { type: 'string', maxLength: 40 }, isolation_override_reason: { type: 'string', maxLength: 2000 } } },
  TheatreReprocessableSets: { type: 'object', additionalProperties: false, required: ['ot_schedule_id', 'sets', 'reuse_restriction', 'policy_enabled'], properties: { ot_schedule_id: { type: 'integer' }, sets: { type: 'array', items: { type: 'object', additionalProperties: true } }, reuse_restriction: { $ref: '#/components/schemas/BloodborneReuseStatus' }, policy_enabled: { type: 'boolean' } } },
  CssdReprocessableDeviceReprocessedRequest: { type: 'object', additionalProperties: false, required: ['cycle_type'], properties: { cycle_type: { type: 'string', enum: CYCLE_TYPES }, function_check_result: { type: 'string', enum: ['pass', 'fail'] }, sterilization_load_id: BIGINT_WIRE, note: { type: 'string', maxLength: 2000 } } },
  CssdReprocessableDeviceReasonRequest: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', maxLength: 500 }, note: { type: 'string', maxLength: 2000 } } },
  CssdReprocessableDeviceNoteRequest: { type: 'object', additionalProperties: false, properties: { note: { type: 'string', maxLength: 2000 } } },
  CssdReprocessableDeviceDiscardRequest: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', enum: DISCARD_REASONS }, note: { type: 'string', maxLength: 2000 } } },
  ReprocessableDeviceResponse: envelope('ReprocessableDevice'),
  ReprocessableDeviceListResponse: listEnvelope('ReprocessableDevice'),
  ReprocessableDeviceLabelResponse: envelope('ReprocessableDeviceLabel'),
  ReprocessingDomainSettingsResponse: { ...envelope('ReprocessingDomainSettingsEnvelope') },
  ReprocessingDomainSettingsEnvelope: { type: 'object', additionalProperties: false, required: ['settings'], properties: { settings: { $ref: '#/components/schemas/ReprocessingDomainSettings' } } },
  ReprocessingDomainPoliciesEnvelope: { type: 'object', additionalProperties: false, required: ['policies', 'count'], properties: { policies: { type: 'array', items: { $ref: '#/components/schemas/ReprocessingDomainPolicy' } }, count: { type: 'integer' } } },
  ReprocessingDomainPoliciesResponse: envelope('ReprocessingDomainPoliciesEnvelope'),
  DialysisMachineListResponse: listEnvelope('DialysisMachine'),
  DialysisMachineResponse: envelope('DialysisMachine'),
  DialysisSessionDialyserResponse: envelope('DialysisSessionDialyser'),
  TheatreReprocessableSetsResponse: envelope('TheatreReprocessableSets'),
  ReprocessableDeviceHistoryResponse: envelope('ReprocessableDeviceHistory'),
  ReprocessableDeviceHistory: { type: 'object', additionalProperties: false, required: ['device', 'uses', 'transitions'], properties: { device: { $ref: '#/components/schemas/ReprocessableDevice' }, uses: { type: 'array', items: { $ref: '#/components/schemas/ReprocessableDeviceUsage' } }, transitions: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
};

const domainParam = { name: 'domain', in: 'path', required: true, schema: { type: 'string', enum: DOMAINS } };
const gov = 'Mounted at /api/v1/reprocessing for QUALITY_OFFICER, INFECTION_CONTROL_OFFICER, ADMIN and SUPER_ADMIN.';
const cssdAud = 'Narrowed to CSSD_DEVICE_ROUTE_ROLES. Requires Idempotency-Key (scope cssd_reprocessable_device_transition).';

export const operations = {
  'GET /api/v1/cssd/reprocessable-devices': { description: 'The department-agnostic device queue (dialysis, OT). No patient identity in any row. Narrowed to CSSD_DEVICE_ROUTE_ROLES.', parameters: [q('domain', { type: 'string', enum: DOMAINS }), q('status', { type: 'string', enum: DEVICE_STATUSES }), q('facility_id', { type: 'integer' }), q('limit', { type: 'integer', minimum: 1, maximum: 500 })], response: 'ReprocessableDeviceListResponse' },
  'GET /api/v1/cssd/reprocessable-devices/{id}/label': { description: 'Label payload (code39 SVG of the device tag) - the same shape as GET /cssd/sets/{id}/label.', pathParameters: { id: BIGINT_WIRE }, response: 'ReprocessableDeviceLabelResponse' },
  'POST /api/v1/cssd/reprocessable-devices/{id}/receive': { description: `awaiting_reprocessing -> in_cssd. ${cssdAud}`, pathParameters: { id: BIGINT_WIRE }, parameters: [idem], response: 'ReprocessableDeviceResponse' },
  'POST /api/v1/cssd/reprocessable-devices/{id}/reprocessed': { description: `awaiting_reprocessing|in_cssd -> available; cycle_count + 1. Dialysis devices accept chemical/other only (RPD_CYCLE_TYPE_NOT_ALLOWED). OT devices may name a passed sterilization_load_id (RPD_LOAD_NOT_FOUND / RPD_LOAD_NOT_PASSED). ${cssdAud}`, pathParameters: { id: BIGINT_WIRE }, parameters: [idem], request: 'CssdReprocessableDeviceReprocessedRequest', response: 'ReprocessableDeviceResponse' },
  'POST /api/v1/cssd/reprocessable-devices/{id}/quarantine': { description: `-> quarantined with a reason. ${cssdAud}`, pathParameters: { id: BIGINT_WIRE }, parameters: [idem], request: 'CssdReprocessableDeviceReasonRequest', response: 'ReprocessableDeviceResponse' },
  'POST /api/v1/cssd/reprocessable-devices/{id}/release': { description: `quarantined -> awaiting_reprocessing (never straight to available). ${cssdAud}`, pathParameters: { id: BIGINT_WIRE }, parameters: [idem], request: 'CssdReprocessableDeviceNoteRequest', response: 'ReprocessableDeviceResponse' },
  'POST /api/v1/cssd/reprocessable-devices/{id}/discard': { description: `-> discarded with a reason from the register vocabulary; an OT device's set is retired. ${cssdAud}`, pathParameters: { id: BIGINT_WIRE }, parameters: [idem], request: 'CssdReprocessableDeviceDiscardRequest', response: 'ReprocessableDeviceResponse' },
  'GET /api/v1/reprocessing/domains/{domain}/settings': { description: `Per-tenant, per-domain reuse rules; defaults when no row (dialysis discard / OT quarantine, warn, 90 days, warn). ${gov}`, parameters: [domainParam], response: 'ReprocessingDomainSettingsResponse' },
  'PUT /api/v1/reprocessing/domains/{domain}/settings': { description: `Saves the domain rules. RPD_DOMAIN_INVALID before any key is claimed. ${gov} Requires Idempotency-Key (scope reprocessing_domain_policy).`, parameters: [domainParam, idem], request: 'ReprocessingDomainSettingsUpdateRequest', response: 'ReprocessingDomainSettingsResponse' },
  'GET /api/v1/reprocessing/domains/{domain}/policies': { description: `One policy per category of the domain, defaulted to not reprocessable. ${gov}`, parameters: [domainParam], response: 'ReprocessingDomainPoliciesResponse' },
  'PUT /api/v1/reprocessing/domains/{domain}/policies': { description: `Upserts category policies. Dialysis refuses autoclave cycle types, OT refuses a function check, tcv_min_pct is dialysis-only, a category appears at most once (RPD_POLICY_INVALID, RPD_POLICY_DUPLICATE, RPD_CYCLE_TYPE_NOT_ALLOWED). ${gov} Requires Idempotency-Key (scope reprocessing_domain_policy).`, parameters: [domainParam, idem], request: 'ReprocessingDomainPoliciesUpdateRequest', response: 'ReprocessingDomainPoliciesResponse' },
  'GET /api/v1/reprocessing/devices/{deviceId}/history': { description: `Every use (patient, case anchor, cycle, disposition) and transition of a device. PHI: writes one hipaa_access_log row per distinct patient (record_type DIALYSIS or OPERATING_THEATRE). ${gov}`, pathParameters: { deviceId: BIGINT_WIRE }, response: 'ReprocessableDeviceHistoryResponse' },
  'POST /api/v1/dialysis/sessions/{id}/dialyser': { description: 'Captures a dialyser onto a session: mints on first sight of a serial, dedicates it to the patient (DIALYSER_DEDICATED_TO_ANOTHER_PATIENT has no override), refuses a second capture (DIALYSER_ALREADY_CAPTURED), refuses without a reprocessable dialyser policy (RPD_POLICY_NOT_REPROCESSABLE). reuse_restriction is projected by role. Requires Idempotency-Key (scope dialysis_dialyser_capture).', pathParameters: { id: { type: 'integer' } }, parameters: [idem], request: 'DialyserCaptureRequest', response: 'DialysisSessionDialyserResponse' },
  'GET /api/v1/dialysis/sessions/{id}/dialyser': { description: 'The captured dialyser, its dedication, the projected restriction, the allowed dispositions for the reprocessing record, and the isolation evaluation (not projected: the required machine class is a routing instruction, spec §3.5).', pathParameters: { id: { type: 'integer' } }, response: 'DialysisSessionDialyserResponse' },
  'POST /api/v1/dialysis/sessions/{id}/reuse-register': { description: 'The ONE-command reprocessing record on the statutory row: post-use + reprocess/quarantine/discard by status, integrity and TCV verdicts (tcv_below_threshold / integrity_test_failed discard), agent and contact time. Legacy behaviour when no dialyser policy exists. DIALYZER_REUSE_CYCLE_DERIVED, DIALYZER_REUSE_REGISTER_SETTLED, RPD_DISPOSITION_NOT_ALLOWED, RPD_ACKNOWLEDGEMENT_REQUIRED. Requires Idempotency-Key (scope dialysis_reuse_register).', pathParameters: { id: { type: 'integer' } }, parameters: [idem], request: 'DialyserReuseRegisterRequest', response: 'Success' },
  'PATCH /api/v1/dialysis/sessions/{id}/machine': { description: 'Reassigns the machine and re-evaluates the isolation rule (DIALYSIS_ISOLATION_OVERRIDE_REQUIRED, DIALYSIS_ISOLATION_MACHINE_BLOCKED). Requires Idempotency-Key (scope dialysis_session_machine).', pathParameters: { id: { type: 'integer' } }, parameters: [idem], request: 'DialysisSessionMachineRequest', response: 'Success' },
  'GET /api/v1/dialysis/machines': { description: 'Dialysis machine master with isolation class.', parameters: [q('status', { type: 'string', enum: ['active', 'out_of_service', 'retired'] })], response: 'DialysisMachineListResponse' },
  'POST /api/v1/dialysis/machines': { description: 'Registers a machine (DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES). isolation_group is the tenant\u2019s routing label; null or absent registers a general machine (D11 = NO). DIALYSIS_MACHINE_NO_TAKEN. Requires Idempotency-Key (scope dialysis_machine).', parameters: [idem], request: 'DialysisMachineRequest', response: 'DialysisMachineResponse' },
  'PATCH /api/v1/dialysis/machines/{id}': { description: 'Edits a machine (DIALYSIS_MACHINE_ADMIN_ROUTE_ROLES). isolation_group: null makes it a general machine; an absent key leaves the label alone. Requires Idempotency-Key (scope dialysis_machine).', pathParameters: { id: { type: 'integer' } }, parameters: [idem], request: 'DialysisMachineRequest', response: 'DialysisMachineResponse' },
  'GET /api/v1/theatre/{id}/reprocessable-sets': { description: "The case's set issues with register rows and load evidence, plus the projected restriction (the WHO sign-in strip's data).", pathParameters: { id: { type: 'integer' } }, response: 'TheatreReprocessableSetsResponse' },
};
```

Register `reprocessableDevices` in `SCHEMA_MODULES` in `scripts/generate-openapi.mjs` (import beside `cathDeviceReuse`). Do **not** touch `bloodborneMarkers.mjs` (the `dialysis_surveillance` source is Phase 1's; if 767 has landed, its overlay change is already there). Extend `cathDeviceReuse.mjs`'s `POST /api/v1/cssd/issues` entry if one exists (else the `cssd` paths are base-generated): add the `Idempotency-Key` parameter and an `acknowledgement` body property. Then:

```bash
cd apps/backend
npm run openapi:generate && npm run openapi:check && npm run openapi:sync-core && npm run openapi:check-core && npm run openapi:lint-budget
```

Expected: all exit 0; the lint budget reports `0 new` findings. If a documented path is not served (`openapi:check` names it), the route is missing, not the doc.

- [ ] **Step 6: Commit** (the operator script for this lane is the Phase 2 census, committed with Task 4; the legacy-marker backfill is Phase 1's — spec §3.3 hand-over notes)

```bash
git add apps/backend/src/routes/clinical/reprocessingPolicyRoutes.js apps/backend/src/routes/clinical/reprocessableDeviceHistoryHandler.js apps/backend/src/config/routeRolePolicy.js apps/backend/src/app.js apps/admin/src/app/api/proxy apps/backend/src/tests/unit/reprocessableDeviceRouteWiring.test.js apps/backend/src/tests/unit/serologyDisclosureCanary.test.js apps/backend/src/tests/fixtures/serologyDisclosureCanary.reachable.json apps/backend/scripts/openapi/schemas/reprocessableDevices.mjs apps/backend/scripts/openapi/schemas/cathDeviceReuse.mjs apps/backend/scripts/generate-openapi.mjs apps/backend/src/docs/openapi.json packages/vhhealth_core/swagger/openapi.json
git commit -m "feat(reprocessing): governance mount, route wiring census, canary mounts, OpenAPI overlay

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

**Removed from this task (carve-out, 2026-09-05):** the former Step 6, `scripts/backfill-dialysis-markers.mjs`, is the Phase 1 lane's with the rest of the derivation. The one-paragraph pointer and the hand-over notes dev-ea needs (a legacy `'positive'` becomes a `clinical_declaration` marker under a named actor; `tested_on` is NULL for a legacy row, never `updated_at::date`; `recordMarkers` fires the exposure handlers post-commit so a one-shot backfill quarantines every legacy-positive patient's dedicated dialyser in one burst and the dry run must print the device count; `bool_or` over every roster row; the `dialysis_serology` `'reactive'`/`'positive'` disjointness at `dialysisService.js:1115-1117` / `:1135`) live in spec §3.3. This lane's operator script is the Phase 2 census (Task 4 Step 4).

---

## Task 7: Staff app — dialysis feature from zero, theatre sets panel, five-locale strings

**Files:**
- Modify (backend tree, CI-routed with the backend): `apps/backend/src/config/rolePolicyGraph.js` (`STAFF_FEATURE_CATALOG` ≈1112, `UI_ROLE_FEATURE_GRANTS` ≈1066); regenerate `apps/staff/lib/core/config/staff_role_contract.g.dart`
- Create: `apps/staff/lib/core/widgets/reuse_restriction_strip.dart`, `apps/staff/lib/features/dialysis/models/dialysis_reuse_models.dart`, `services/dialysis_api_service.dart`, `screens/dialysis_today_screen.dart`, `widgets/dialyser_capture_sheet.dart`, `widgets/dialyser_reprocessing_sheet.dart`, `widgets/isolation_warning_strip.dart`, `apps/staff/lib/features/theatre/widgets/theatre_sets_panel.dart`
- Modify: `apps/staff/lib/core/config/role_config.dart`, `lib/core/navigation/app_router.dart`, `lib/core/navigation/staff_route_policy.dart`, `lib/features/theatre/screens/theatre_screen.dart`, `lib/core/services/theatre_api_service.dart`, `lib/features/cath_lab/widgets/cath_reuse_restriction_strip.dart` (becomes a thin re-export), `lib/l10n/app_strings.dart`
- Tests: `apps/staff/test/features/dialysis/dialysis_reuse_models_test.dart`, `dialyser_capture_sheet_test.dart`, `dialyser_reprocessing_sheet_test.dart`, `apps/staff/test/features/theatre/theatre_sets_panel_test.dart`

- [ ] **Step 1: The `dialysis` Staff feature in the role graph, and the contract**

In `rolePolicyGraph.js` `STAFF_FEATURE_CATALOG`, after the `cath_lab` entry:

```js
  { id: 'dialysis', title: 'Dialysis Unit', sidebar_label: 'Dialysis', sidebar_order: 156, capability_group: 'specialty_services' },
```

In `UI_ROLE_FEATURE_GRANTS` append `'dialysis'` to `NURSING_STAFF`, `IP_STAFF_NURSE`, `NURSING_INCHARGE`, `IP_INCHARGE`, `DOCTOR`, `DUTY_DOCTOR`, `CONSULTANT`, `DIALYSIS_TECHNICIAN` (add the `DIALYSIS_TECHNICIAN: ['dialysis', 'handover']` row if the role has none — it has none today). Then:

```bash
cd "$SCRATCH/wt/rpd-impl"
node scripts/generate-staff-role-contract.mjs
node scripts/generate-staff-role-contract.mjs --check
cd apps/backend && npm test -- --testPathPatterns "rolePolicy|routeRolePolicy|staffRoleContract"
```

Expected: `Generated apps/staff/lib/core/config/staff_role_contract.g.dart`, then `Staff role contract matches the backend role and route policies.`, then PASS. The generated file gains `'dialysis': {…}` in its feature map; `git diff --stat` must show only that file changed besides `rolePolicyGraph.js`.

- [ ] **Step 2: Feature registration**

`role_config.dart` — after `_cathLab`:

```dart
  static const DashboardFeature _dialysis = DashboardFeature(
    id: 'dialysis',
    titleKey: 'role.feature.dialysis',
    icon: Icons.water_drop_outlined,
    route: '/dialysis',
    color: Color(0xFF00695C),
  );
```

and add `_dialysis` wherever `_cathLab` is listed in the feature registries of that file (`grep -n "_cathLab" lib/core/config/role_config.dart` names each list). `app_router.dart`, after the `/cath-lab` GoRoute:

```dart
        GoRoute(
          path: '/dialysis',
          name: 'dialysis',
          pageBuilder: (context, state) =>
              const NoTransitionPage(child: DialysisTodayScreen()),
        ),
```

with `import '../../features/dialysis/screens/dialysis_today_screen.dart';`. `staff_route_policy.dart`, after `/cath-lab`: `StaffRouteMetadata('/dialysis', anyFeatureIds: {'dialysis'}),`.

- [ ] **Step 3: Shared restriction strip**

Move `cath_reuse_restriction_strip.dart`'s widget to `lib/core/widgets/reuse_restriction_strip.dart` as `ReuseRestrictionStrip` taking `({required String status, required List<String> reasons, required String restrictedKey, required String unknownKey, required String moreKey})`, and leave `CathReuseRestrictionStrip` as a two-line wrapper that passes the cath keys — the cath tests keep passing unchanged. The dialysis and theatre panels pass `s4.lib.reuse.restriction_restricted` / `s4.lib.reuse.restriction_unknown` / `s4.dynamic.reuse.more_reasons`.

- [ ] **Step 4: Models and API service**

```dart
// apps/staff/lib/features/dialysis/models/dialysis_reuse_models.dart
/// Two wire shapes, one model: the cath/OT `reuse_restriction`
/// (`status`, `reasons`, `validity_days`, `evaluated_at`) and the dialysis
/// Phase 1 Decision (`status`, `reasons`, `asOf`, `evidence`, `isolation_class`;
/// spec §3.3). Both are projected by role: `reasons` may be empty.
class ReuseRestriction {
  const ReuseRestriction({required this.status, required this.reasons, this.validityDays, this.evidence, this.isolationClass});
  final String status; // restricted | unknown | clear
  final List<String> reasons;
  final int? validityDays; // cath/OT shape only
  final String? evidence; // Decision shape only: marker | legacy_declaration | none
  final String? isolationClass; // Decision shape only: hbsag | hcv | hiv | isolation_mixed
  bool get isRestricted => status == 'restricted';
  bool get isClear => status == 'clear';
  bool get isDecision => evidence != null;
  factory ReuseRestriction.fromJson(Map<String, dynamic> json) => ReuseRestriction(
        status: (json['status'] ?? 'unknown').toString(),
        reasons: json['reasons'] is List ? (json['reasons'] as List).map((e) => e.toString()).where((e) => e.isNotEmpty).toList() : const [],
        validityDays: int.tryParse('${json['validity_days']}'),
        evidence: json['evidence']?.toString(),
        isolationClass: json['isolation_class']?.toString(),
      );
}

class DispositionOptions {
  const DispositionOptions({required this.dispositions, required this.requiresAcknowledgement, this.discardReason, this.blockedCode, this.reasonCodes = const []});
  final List<String> dispositions; // reprocess | quarantine | discard
  final bool requiresAcknowledgement;
  final String? discardReason;
  final String? blockedCode;
  final List<String> reasonCodes;
  bool get canReprocess => dispositions.contains('reprocess');
  bool get canQuarantine => dispositions.contains('quarantine');
  bool get canDiscard => dispositions.contains('discard');
  factory DispositionOptions.fromJson(Map<String, dynamic> json) => DispositionOptions(
        dispositions: json['dispositions'] is List ? (json['dispositions'] as List).map((e) => e.toString()).toList() : const [],
        requiresAcknowledgement: json['requires_acknowledgement'] == true,
        discardReason: json['discard_reason']?.toString(),
        blockedCode: json['blocked_code']?.toString(),
        reasonCodes: json['reason_codes'] is List ? (json['reason_codes'] as List).map((e) => e.toString()).toList() : const [],
      );
}

class ReprocessableDevice {
  const ReprocessableDevice({required this.id, required this.deviceTag, required this.status, required this.cycleCount, this.maxCycles, this.manufacturerSerial, this.modelName, this.exposureFlag = false});
  final int id; final String deviceTag; final String status; final int cycleCount; final int? maxCycles;
  final String? manufacturerSerial; final String? modelName; final bool exposureFlag;
  factory ReprocessableDevice.fromJson(Map<String, dynamic> json) => ReprocessableDevice(
        id: int.tryParse('${json['id']}') ?? 0, deviceTag: (json['device_tag'] ?? '').toString(), status: (json['status'] ?? '').toString(),
        cycleCount: int.tryParse('${json['cycle_count']}') ?? 0, maxCycles: int.tryParse('${json['max_cycles_snapshot']}'),
        manufacturerSerial: json['manufacturer_serial']?.toString(), modelName: json['model_name']?.toString(), exposureFlag: json['exposure_flag'] == true);
}

/// The wire shape (spec §3.4, D11 = NO) is
/// `{ codes, isolation_warnings: [{code, machine_id, severity, required_group}],
/// warn_only, enforcement_enabled, override }` — a bay label per warning and
/// **no class key anywhere**. There is deliberately no `requiredClass` field on
/// this model: the server cannot send one, so parsing for one would only invite
/// a future widget to render it.
class IsolationWarning {
  const IsolationWarning({required this.code, this.machineId, required this.severity, this.requiredGroup});
  final String code; final int? machineId; final String severity; final String? requiredGroup;
  bool get isBlocking => severity == 'block';
  factory IsolationWarning.fromJson(Map<String, dynamic> json) => IsolationWarning(
        code: (json['code'] ?? '').toString(), machineId: int.tryParse('${json['machine_id']}'),
        severity: (json['severity'] ?? 'warn').toString(), requiredGroup: json['required_group']?.toString());
}

class IsolationState {
  const IsolationState({required this.codes, required this.warnings, required this.warnOnly, required this.enforcementEnabled, this.overrideReason});
  final List<String> codes; final List<IsolationWarning> warnings; final bool warnOnly; final bool enforcementEnabled; final String? overrideReason;
  bool get hasWarnings => codes.isNotEmpty;
  /// The first bay label the server named, or null when it named none.
  String? get requiredGroup { for (final w in warnings) { if (w.requiredGroup != null) return w.requiredGroup; } return null; }
  factory IsolationState.fromJson(Map<String, dynamic> json) => IsolationState(
        codes: json['codes'] is List ? (json['codes'] as List).map((e) => e.toString()).toList() : const [],
        warnings: json['isolation_warnings'] is List
            ? (json['isolation_warnings'] as List).whereType<Map>().map((e) => IsolationWarning.fromJson(Map<String, dynamic>.from(e))).toList()
            : const [],
        warnOnly: json['warn_only'] != false, enforcementEnabled: json['enforcement_enabled'] == true,
        overrideReason: json['override'] is Map ? (json['override'] as Map)['reason']?.toString() : null);
}

class SessionDialyser {
  const SessionDialyser({this.device, this.reuseCycle, this.baselineTcvMl, required this.restriction, this.options, required this.isolation, required this.policyEnabled});
  final ReprocessableDevice? device; final int? reuseCycle; final double? baselineTcvMl; final ReuseRestriction restriction;
  final DispositionOptions? options; final IsolationState isolation; final bool policyEnabled;
  bool get captured => device != null;
  factory SessionDialyser.fromJson(Map<String, dynamic> json) => SessionDialyser(
        device: json['device'] is Map ? ReprocessableDevice.fromJson(Map<String, dynamic>.from(json['device'] as Map)) : null,
        reuseCycle: json['usage'] is Map ? int.tryParse('${(json['usage'] as Map)['reuse_cycle']}') : null,
        baselineTcvMl: json['link'] is Map ? double.tryParse('${(json['link'] as Map)['baseline_tcv_ml']}') : null,
        restriction: ReuseRestriction.fromJson(Map<String, dynamic>.from((json['reuse_restriction'] ?? const {}) as Map)),
        options: json['allowed_dispositions'] is Map ? DispositionOptions.fromJson(Map<String, dynamic>.from(json['allowed_dispositions'] as Map)) : null,
        isolation: IsolationState.fromJson(Map<String, dynamic>.from((json['isolation'] ?? const {}) as Map)),
        policyEnabled: json['policy_enabled'] == true);
}

class DialyserCaptureDraft {
  const DialyserCaptureDraft({this.manufacturerSerial, this.deviceTag, this.modelName, this.baselineTcvMl, this.acknowledgementReason});
  final String? manufacturerSerial; final String? deviceTag; final String? modelName; final double? baselineTcvMl; final String? acknowledgementReason;
  Map<String, dynamic> toJson() => {
        if (manufacturerSerial != null && manufacturerSerial!.isNotEmpty) 'manufacturer_serial': manufacturerSerial,
        if (deviceTag != null && deviceTag!.isNotEmpty) 'device_tag': deviceTag,
        if (modelName != null && modelName!.isNotEmpty) 'model_name': modelName,
        if (baselineTcvMl != null) 'baseline_tcv_ml': baselineTcvMl,
        if (acknowledgementReason != null && acknowledgementReason!.isNotEmpty) 'exposure_acknowledgement': {'reason': acknowledgementReason},
      };
}

class DialyserReprocessingDraft {
  const DialyserReprocessingDraft({required this.status, required this.integrityTestResult, this.measuredTcvMl, this.reprocessingAgent, this.contactMinutes, this.concentrationPct, this.discardReason, this.notes, this.acknowledgementReason});
  final String status; // in_use | quarantined | discarded
  final String integrityTestResult; // pending | pass | fail | not_done
  final double? measuredTcvMl; final String? reprocessingAgent; final int? contactMinutes; final double? concentrationPct;
  final String? discardReason; final String? notes; final String? acknowledgementReason;
  Map<String, dynamic> toJson() => {
        'status': status, 'integrity_test_result': integrityTestResult,
        if (measuredTcvMl != null) 'measured_tcv_ml': measuredTcvMl,
        if (reprocessingAgent != null) 'reprocessing_agent': reprocessingAgent,
        if (contactMinutes != null) 'disinfectant_contact_minutes': contactMinutes,
        if (concentrationPct != null) 'disinfectant_concentration_pct': concentrationPct,
        if (discardReason != null && discardReason!.isNotEmpty) 'discard_reason': discardReason,
        if (notes != null && notes!.isNotEmpty) 'notes': notes,
        if (acknowledgementReason != null && acknowledgementReason!.isNotEmpty) 'acknowledgement': {'reason': acknowledgementReason},
      };
}
```

```dart
// apps/staff/lib/features/dialysis/services/dialysis_api_service.dart
import '../../../core/services/api_client.dart';
import '../models/dialysis_reuse_models.dart';

class DialysisApiService {
  static Map<String, dynamic> _data(ApiResponse response, String failure) {
    if (!response.success || response.data is! Map) throw ApiException(response.code ?? 'ERROR', response.message ?? failure);
    return Map<String, dynamic>.from(response.data as Map);
  }

  /// GET /dialysis/today
  static Future<List<Map<String, dynamic>>> today() async {
    final response = await ApiClient.get('/dialysis/today');
    final data = response.data;
    return data is List ? data.map((e) => Map<String, dynamic>.from(e as Map)).toList() : const [];
  }

  /// GET /dialysis/sessions/:id/dialyser
  static Future<SessionDialyser> sessionDialyser(int sessionId) async {
    final response = await ApiClient.get('/dialysis/sessions/$sessionId/dialyser');
    return SessionDialyser.fromJson(_data(response, 'Failed to load dialyser'));
  }

  /// POST /dialysis/sessions/:id/dialyser (scope dialysis_dialyser_capture) - key REQUIRED.
  static Future<SessionDialyser> captureDialyser(int sessionId, DialyserCaptureDraft draft, {required String idempotencyKey}) async {
    final response = await ApiClient.post('/dialysis/sessions/$sessionId/dialyser', body: draft.toJson(), idempotencyKey: idempotencyKey);
    return SessionDialyser.fromJson(_data(response, 'Failed to capture dialyser'));
  }

  /// POST /dialysis/sessions/:id/reuse-register (scope dialysis_reuse_register) - key REQUIRED.
  static Future<Map<String, dynamic>> recordReprocessing(int sessionId, DialyserReprocessingDraft draft, {required String idempotencyKey}) async {
    final response = await ApiClient.post('/dialysis/sessions/$sessionId/reuse-register', body: draft.toJson(), idempotencyKey: idempotencyKey);
    return _data(response, 'Failed to record reprocessing');
  }

  /// POST /dialysis/sessions/:id/start with the isolation override reason.
  static Future<Map<String, dynamic>> startSession(int sessionId, {String? isolationOverrideReason, Map<String, dynamic> vitals = const {}}) async {
    final response = await ApiClient.post('/dialysis/sessions/$sessionId/start', body: {...vitals, if (isolationOverrideReason != null) 'isolation_override_reason': isolationOverrideReason});
    return _data(response, 'Failed to start session');
  }
}
```

`ApiException` and `ApiResponse.code` are the platform's existing types (`lib/core/services/api_client.dart`); if `ApiException` is named differently there, use that name — do not add a new exception type.

- [ ] **Step 5: Screens and sheets**

`DialysisTodayScreen`: a `StatefulWidget` that loads `DialysisApiService.today()`, renders one `Card` per session (patient uid short form, station, machine, status chip, an amber `isolation_required` badge, and a trailing **Dialyser** button opening `DialyserSheet(sessionId)`); reload on pull-to-refresh and after any sheet returns `true`. `DialyserSheet` loads `sessionDialyser`, shows `ReuseRestrictionStrip`, `IsolationWarningStrip(isolation)`, and either `DialyserCaptureSheet` (not captured) or the device card (tag, serial, cycle `k of max`, exposure badge) with a **Record reprocessing** button opening `DialyserReprocessingSheet(options)`. When `policyEnabled` is false the sheet shows `s4.lib.dialysis.policy_disabled` and no capture form.

```dart
// apps/staff/lib/features/dialysis/widgets/dialyser_capture_sheet.dart (essentials)
class DialyserCaptureSheet extends StatefulWidget {
  const DialyserCaptureSheet({super.key, required this.sessionId, required this.restriction, this.capture = DialysisApiService.captureDialyser});
  final int sessionId; final ReuseRestriction restriction;
  final Future<SessionDialyser> Function(int, DialyserCaptureDraft, {required String idempotencyKey}) capture;
  @override State<DialyserCaptureSheet> createState() => _DialyserCaptureSheetState();
}
class _DialyserCaptureSheetState extends State<DialyserCaptureSheet> {
  final _registry = IdempotencyAttemptRegistry();
  final _serial = TextEditingController(); final _tag = TextEditingController(); final _model = TextEditingController(); final _tcv = TextEditingController();
  String? _error; bool _busy = false;
  @override void dispose() { _serial.dispose(); _tag.dispose(); _model.dispose(); _tcv.dispose(); _registry.clear(); super.dispose(); }

  Future<void> _submit({String? acknowledgement}) async {
    final s = AppStrings.of(context);
    if ((_serial.text.trim().isEmpty) == (_tag.text.trim().isEmpty)) { setState(() => _error = s.lookup('s4.lib.dialysis.capture.identity_required')); return; }
    final draft = DialyserCaptureDraft(manufacturerSerial: _serial.text.trim(), deviceTag: _tag.text.trim(), modelName: _model.text.trim(), baselineTcvMl: double.tryParse(_tcv.text.trim()), acknowledgementReason: acknowledgement);
    setState(() { _busy = true; _error = null; });
    try {
      final scope = 'dialysis-dialyser-capture:${widget.sessionId}';
      await _registry.execute<SessionDialyser>(scope: scope, body: draft.toJson(), send: (key, _) => widget.capture(widget.sessionId, draft, idempotencyKey: key), isSuccess: (r) => r.captured);
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.code == 'RPD_ACKNOWLEDGEMENT_REQUIRED') { final reason = await _askReason(s.lookup('s4.lib.dialysis.capture.exposure_ack_title')); if (reason != null) return _submit(acknowledgement: reason); }
      setState(() => _error = switch (e.code) {
        'DIALYSER_DEDICATED_TO_ANOTHER_PATIENT' => s.lookup('s4.lib.dialysis.capture.dedicated_other_patient'),
        'DIALYSER_ALREADY_CAPTURED' => s.lookup('s4.lib.dialysis.capture.already_captured'),
        'RPD_POLICY_NOT_REPROCESSABLE' => s.lookup('s4.lib.dialysis.policy_disabled'),
        'RPD_EXPOSURE_BLOCKED' => s.lookup('s4.lib.dialysis.capture.exposure_blocked'),
        'RPD_MAX_CYCLES_REACHED' => s.lookup('s4.lib.dialysis.capture.max_cycles'),
        _ => e.message,
      });
    } finally { if (mounted) setState(() => _busy = false); }
  }
  // build(): ReuseRestrictionStrip(status/reasons), serial field (key 'dialyser-serial'), tag field, model, baseline TCV (numeric),
  // the error Text (key 'dialyser-capture-error'), and a FilledButton (key 'dialyser-capture-submit') disabled while _busy.
}
```

`DialyserReprocessingSheet` renders only the dispositions in `options.dispositions` as a segmented control (`reprocess` → status `in_use`, `quarantine`, `discard`); integrity result dropdown; measured TCV with a live `% of baseline` line when `baselineTcvMl` is known and red text below `tcv_min_pct` is not known client-side — the server decides, the sheet only shows the percentage; agent dropdown (five values); contact minutes; concentration; discard reason (required when `discard`); notes; asks for the acknowledgement reason when `options.requiresAcknowledgement` and the disposition is `reprocess`; submits through `IdempotencyAttemptRegistry` scope `dialysis-reuse-register:<session>`; maps `RPD_DISPOSITION_NOT_ALLOWED`, `DIALYZER_REUSE_REGISTER_SETTLED`, `DIALYZER_REUSE_CYCLE_DERIVED`, `RPD_ACKNOWLEDGEMENT_REQUIRED` to strings. `IsolationWarningStrip` maps each code to `s4.lib.dialysis.isolation.<code lower-cased>`; the start-session confirm dialog carries the override reason field (required when `hasWarnings`). **It appends the bay line and never a class** (spec §3.4, D11 = NO): for each `IsolationWarning` whose `requiredGroup` is non-null it appends `s.format('s4.dynamic.dialysis.isolation.required_group', {'group': w.requiredGroup})` beneath the code line, and there is no `required_class` string to render because the key is retired on both sides of the wire. `IsolationState` carries no `requiredClass` field: the server cannot send one, so parsing for it would only invite a future widget to render it.

- [ ] **Step 6: Theatre sets panel**

`theatre_api_service.dart` gains `static Future<Map<String, dynamic>> reprocessableSets(int scheduleId) => _get('/theatre/$scheduleId/reprocessable-sets');` and `static Future<Map<String, dynamic>> issueSet({required int scheduleId, required String setCode, String? acknowledgementReason, required String idempotencyKey}) async { final resp = await ApiClient.post('/cssd/issues', body: {'ot_schedule_id': scheduleId, 'set_code': setCode, if (acknowledgementReason != null) 'acknowledgement': {'reason': acknowledgementReason}}, idempotencyKey: idempotencyKey); return _handle(resp); }` (`_handle` is the file's existing response unwrapper; `issueSet` on the backend resolves `set_code` to `instrument_set_id` — add that lookup in `cssdService.issueSet` if it accepts only ids: `set_code` → `loadSetByCode`). `TheatreSetsPanel(scheduleId)` sits inside the schedule card's expansion in `theatre_screen.dart` below the WHO safety row: loads `reprocessableSets`, renders `ReuseRestrictionStrip`, one row per set (set code, `last load: <load_code> · BI <result>`, cycle, exposure badge, issue status), and an **Issue set** action (text field or scanner → `issueSet` through `IdempotencyAttemptRegistry` scope `theatre-issue-set:<schedule>`; on `CSSD_SET_ACKNOWLEDGEMENT_REQUIRED` asks for a reason and retries; on `CSSD_SET_QUARANTINED` / `CSSD_SET_EXPOSURE_BLOCKED` shows the mapped string).

- [ ] **Step 7: Strings (65 keys × 5 locales = 325 lines; 260 non-English)**

Add to every locale map; in `hi`, `ta`, `te`, `ml` precede each block with `// REVIEW: engineering placeholder pending OPEN-21 linguistic review`. This list is authoritative; the spec's §6.8 breakdown (strip 3, today 8, policy banner 1, capture 14, device card 3, isolation **7**, reprocessing 18, theatre sets 9, feature/nav 2) must sum to it — **65**. The isolation block carries `required_group` and **no** `required_class`: D11 = NO retired the class key, so the string that would have rendered it is not written in any locale (spec §2, §6.8). The i18n guard checks parity across locales, not that every key is referenced. There is no `dialysis_serology_unknown` isolation string: `unknown` raises no per-session code (spec §3.4). Keys (English shown; the four other renderings are the implementer's best rendering, never a copy of the English):

```
role.feature.dialysis: "Dialysis Unit"            role.nav.dialysis: "Dialysis"
s4.lib.reuse.restriction_restricted: "Blood-borne restriction: this patient's devices must not be reprocessed under the default policy"
s4.lib.reuse.restriction_unknown: "Serology not on record within the validity window"
s4.dynamic.reuse.more_reasons: "+{count} more"
s4.lib.dialysis.today.title: "Dialysis today"      s4.lib.dialysis.today.empty: "No sessions scheduled today"
s4.lib.dialysis.today.station: "Station"           s4.lib.dialysis.today.machine: "Machine"
s4.lib.dialysis.today.isolation: "Isolation"       s4.lib.dialysis.today.dialyser: "Dialyser"
s4.lib.dialysis.today.refresh: "Refresh"           s4.lib.dialysis.today.load_failed: "Could not load today's sessions"
s4.lib.dialysis.policy_disabled: "Dialyser reuse is not enabled for this unit"
s4.lib.dialysis.capture.title: "Capture dialyser"  s4.lib.dialysis.capture.serial: "Manufacturer serial"
s4.lib.dialysis.capture.tag: "Device tag (RD…)"     s4.lib.dialysis.capture.model: "Model"
s4.lib.dialysis.capture.baseline_tcv: "Baseline TCV (ml)"   s4.lib.dialysis.capture.submit: "Capture"
s4.lib.dialysis.capture.identity_required: "Enter either the manufacturer serial or the device tag"
s4.lib.dialysis.capture.dedicated_other_patient: "This dialyser is dedicated to another patient and cannot be used here"
s4.lib.dialysis.capture.already_captured: "A dialyser is already captured for this session"
s4.lib.dialysis.capture.exposure_blocked: "This dialyser carries a blood-borne exposure flag and cannot be used"
s4.lib.dialysis.capture.exposure_same_patient_note: "Exposure flag from this patient's own history"
s4.lib.dialysis.capture.max_cycles: "This dialyser has reached its cycle limit"
s4.lib.dialysis.capture.exposure_ack_title: "Acknowledge exposed dialyser"
s4.lib.dialysis.capture.ack_reason: "Reason"        s4.dynamic.dialysis.device.cycle: "Cycle {cycle} of {max}"
s4.lib.dialysis.device.cycle_unbounded: "No cycle limit"   s4.lib.dialysis.device.exposure: "Exposure flagged"
s4.lib.dialysis.isolation.dialysis_machine_unregistered: "Machine is not registered; this patient needs an isolation machine"
s4.lib.dialysis.isolation.dialysis_isolation_machine_mismatch: "This machine's isolation class does not match the patient"
s4.lib.dialysis.isolation.dialysis_general_patient_on_isolation_machine: "A non-isolation patient is on an isolation machine"
s4.dynamic.dialysis.isolation.required_group: "Required machine group: {group}"   // D11 = NO: the live key, rendered whenever the server sends one
s4.lib.dialysis.isolation.override_reason: "Override reason"   s4.lib.dialysis.isolation.override_required: "A reason is required to start with isolation warnings"
s4.lib.dialysis.isolation.blocked: "This unit blocks a mismatched isolation machine"
s4.lib.dialysis.reprocess.title: "Record reprocessing"   s4.lib.dialysis.reprocess.disposition: "Outcome"
s4.lib.dialysis.reprocess.reprocess: "Reprocess"   s4.lib.dialysis.reprocess.quarantine: "Quarantine"   s4.lib.dialysis.reprocess.discard: "Discard"
s4.lib.dialysis.reprocess.integrity: "Integrity test"   s4.lib.dialysis.reprocess.measured_tcv: "Measured TCV (ml)"
s4.dynamic.dialysis.reprocess.tcv_pct: "{pct}% of baseline"   s4.lib.dialysis.reprocess.agent: "Reprocessing agent"
s4.lib.dialysis.reprocess.contact_minutes: "Contact time (min)"   s4.lib.dialysis.reprocess.concentration: "Concentration (%)"
s4.lib.dialysis.reprocess.discard_reason: "Discard reason"   s4.lib.dialysis.reprocess.notes: "Notes"   s4.lib.dialysis.reprocess.submit: "Save"
s4.lib.dialysis.reprocess.not_allowed: "That outcome is not permitted for this dialyser"
s4.lib.dialysis.reprocess.settled: "The reprocessing record for this session is already settled"
s4.lib.dialysis.reprocess.cycle_derived: "The cycle count is derived from the device"
s4.lib.dialysis.reprocess.ack_required: "An acknowledgement reason is required to reprocess"
s4.lib.theatre.sets.title: "Instrument sets"   s4.lib.theatre.sets.empty: "No sets issued to this case"
s4.lib.theatre.sets.issue: "Issue set"   s4.lib.theatre.sets.set_code: "Set code or barcode"
s4.dynamic.theatre.sets.last_load: "Last load {code} · BI {bi}"   s4.lib.theatre.sets.no_load: "No load evidence"
s4.lib.theatre.sets.quarantined: "This set is quarantined and cannot be issued"
s4.lib.theatre.sets.exposure_blocked: "This set carries a blood-borne exposure flag and cannot be issued"
s4.lib.theatre.sets.ack_title: "Acknowledge exposed set"
```

- [ ] **Step 8: Tests, analyzer, parity, commit**

Tests: models parse every wire shape above (incl. both restriction shapes — the OT one with `validity_days` and the dialysis Decision with `evidence`, a **null** `isolation_class` and no `markers` — and the `isolation` envelope, which carries `isolation_warnings: [{ code, machine_id, severity, required_group }]` and **no `required_class` key at all**: `IsolationState.warnings` must parse the four fields, a `null` `required_group` must not throw, the strip must render the code line alone when the group is null and code + bay line when it is not, and a hand-written envelope carrying `required_class` must be ignored because the model has nowhere to put it); the capture sheet refuses when both or neither identity field is filled, sends `exposure_acknowledgement` on retry after `RPD_ACKNOWLEDGEMENT_REQUIRED`, renders the dedicated-other-patient string verbatim for that code, and reuses one idempotency key across a retry; the reprocessing sheet renders only the dispositions the server allows and requires a discard reason for `discard`; the theatre panel renders the restriction strip and the load line. Then:

```bash
cd apps/staff
flutter analyze lib/features/dialysis lib/features/theatre lib/core/widgets/reuse_restriction_strip.dart
flutter test test/features/dialysis test/features/theatre test/features/cath_lab test/i18n_guard_test.dart
dart format --set-exit-if-changed lib/features/dialysis lib/features/theatre lib/core/widgets/reuse_restriction_strip.dart
```

Expected: analyzer clean; all suites PASS including the five-locale parity / i18n guard (`test/i18n_guard_test.dart` — there is no `test/l10n` directory) and the cath strip tests (unchanged). Commit with pathspecs:

```bash
git add apps/backend/src/config/rolePolicyGraph.js apps/staff/lib/core/config/staff_role_contract.g.dart apps/staff/lib/core/config/role_config.dart apps/staff/lib/core/navigation/app_router.dart apps/staff/lib/core/navigation/staff_route_policy.dart apps/staff/lib/core/widgets/reuse_restriction_strip.dart apps/staff/lib/features/dialysis apps/staff/lib/features/theatre apps/staff/lib/features/cath_lab/widgets/cath_reuse_restriction_strip.dart apps/staff/lib/core/services/theatre_api_service.dart apps/staff/lib/l10n/app_strings.dart apps/staff/test/features/dialysis apps/staff/test/features/theatre
git commit -m "feat(staff): dialysis unit feature (dialyser capture, reprocessing record, isolation strip) and theatre sets panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8: Admin — Devices tab domain filter, reprocessing policies page, dialysis machines and dialyser panels

**Files:**
- Create: `apps/admin/src/lib/api/reprocessableDevices.ts`, `apps/admin/src/app/(with-auth)/dashboard/cssd/components/ReprocessableDeviceActions.tsx`, `apps/admin/src/app/(with-auth)/dashboard/quality/reprocessing/page.tsx`, `.../quality/reprocessing/components/DomainPolicyPanel.tsx`, `.../dashboard/dialysis/components/MachinesTab.tsx`, `.../dialysis/components/DialyserPanel.tsx`
- Modify: `.../cssd/components/DevicesTab.tsx`, `.../dialysis/page.tsx`, `SessionTab.tsx`, `RosterTab.tsx`, `TodayBoardTab.tsx`, `types.ts`, `apps/admin/src/lib/api/cssd.ts`, `.../cssd/components/IssueActions.tsx`, `apps/admin/src/lib/navConfig.ts`
- Tests: `apps/admin/src/__tests__/dashboard/cssd/router-coverage.test.ts` (scan the new module), `cssd/reprocessable-devices.test.tsx`, `quality/reprocessing.test.tsx`, `dialysis/machines.test.tsx`, `dialysis/dialyser-panel.test.tsx`

- [ ] **Step 1: API module**

```ts
// apps/admin/src/lib/api/reprocessableDevices.ts
//
// The department-agnostic register (dialysis, OT) - a SIBLING of api/cathDevices.ts,
// not a replacement: the cath queue keeps its own endpoints and ids. Two mounts:
//   * /api/v1/cssd/reprocessable-devices/*  - the queue; every transition claims
//     scope cssd_reprocessable_device_transition (distinct from the cath scope so
//     a key can never replay one register's response against the other).
//   * /api/v1/reprocessing/domains/{domain}/* - governance; scope reprocessing_domain_policy.
//   * /api/v1/dialysis/machines - the machine master; scope dialysis_machine.
// All through core.ts (fetchAdminAPI carries no headers). Keys are minted by the
// React layer (useIdempotencyKey + payloadIdentity), never module-level.
import type { ApiBody, ApiData } from "@/lib/openapi-data";
import { assertIdempotencyKey } from "../idempotencyKey";
import { getJSON, postJSON, putJSON } from "./core";

export const RPD_QUEUE_PATH = "/api/v1/cssd/reprocessable-devices" as const;
export const RPD_DOMAINS = ["dialysis", "ot"] as const;
export type ReprocessingDomain = (typeof RPD_DOMAINS)[number];
export type ReprocessableDevice = ApiData<typeof RPD_QUEUE_PATH, "get">[number];
export type ReprocessableDeviceStatus = ReprocessableDevice["status"];
export type ReprocessableDeviceLabel = ApiData<"/api/v1/cssd/reprocessable-devices/{id}/label", "get">;
export type ReprocessingDomainSettings = ApiData<"/api/v1/reprocessing/domains/{domain}/settings", "get">["settings"];
export type ReprocessingDomainSettingsInput = ApiBody<"/api/v1/reprocessing/domains/{domain}/settings", "put">;
export type ReprocessingDomainPolicy = ApiData<"/api/v1/reprocessing/domains/{domain}/policies", "get">["policies"][number];
export type ReprocessingDomainPolicyInput = ApiBody<"/api/v1/reprocessing/domains/{domain}/policies", "put">["policies"][number];
export type DialysisMachine = ApiData<"/api/v1/dialysis/machines", "get">[number];
export type DialysisMachineInput = ApiBody<"/api/v1/dialysis/machines", "post">;

export const RPD_STATUSES = ["awaiting_reprocessing", "in_cssd", "available", "in_case", "quarantined", "discarded"] as const satisfies readonly ReprocessableDeviceStatus[];
export const RPD_CYCLE_TYPES = ["steam", "eto", "plasma", "dry_heat", "chemical", "other"] as const;
export const RPD_DISCARD_REASONS = ["max_cycles_reached", "bloodborne_exposure", "late_reactive_marker", "function_check_failed", "sterilization_failed", "damaged", "wasted", "policy_change", "other", "tcv_below_threshold", "integrity_test_failed", "set_retired"] as const;
export const RPD_CATEGORIES: Record<ReprocessingDomain, readonly string[]> = { dialysis: ["dialyser", "bloodline", "other"], ot: ["instrument_set", "tray", "implant_set", "procedure_pack", "other"] };
// D11 = NO: the MARKER classes are the keys of the tenant's isolation_groups
// map on the reprocessing settings form. A machine's routing key is a free-text
// `isolation_group` label, not a member of this list.
export const ISOLATION_CLASSES = ["hbsag", "hcv", "hiv", "isolation_mixed"] as const;
export const RPD_LIST_LIMIT = 200;

const keyHeader = (key: string) => ({ "Idempotency-Key": assertIdempotencyKey(key) });

export function listReprocessableDevices(params: { domain?: ReprocessingDomain; status?: ReprocessableDeviceStatus; limit?: number }) {
  return getJSON<ReprocessableDevice[]>(RPD_QUEUE_PATH, { domain: params.domain, status: params.status, limit: params.limit ?? RPD_LIST_LIMIT });
}
export function getReprocessableDeviceLabel(id: number) { return getJSON<ReprocessableDeviceLabel>(`${RPD_QUEUE_PATH}/${id}/label`); }
export function receiveReprocessableDevice(id: number, key: string) { return postJSON<ReprocessableDevice>(`${RPD_QUEUE_PATH}/${id}/receive`, {}, true, keyHeader(key)); }
export function markReprocessableDeviceReprocessed(id: number, body: { cycle_type: string; function_check_result?: "pass" | "fail"; sterilization_load_id?: number; note?: string }, key: string) { return postJSON<ReprocessableDevice>(`${RPD_QUEUE_PATH}/${id}/reprocessed`, body, true, keyHeader(key)); }
export function quarantineReprocessableDevice(id: number, body: { reason: string }, key: string) { return postJSON<ReprocessableDevice>(`${RPD_QUEUE_PATH}/${id}/quarantine`, body, true, keyHeader(key)); }
export function releaseReprocessableDevice(id: number, body: { note?: string }, key: string) { return postJSON<ReprocessableDevice>(`${RPD_QUEUE_PATH}/${id}/release`, body, true, keyHeader(key)); }
export function discardReprocessableDevice(id: number, body: { reason: string; note?: string }, key: string) { return postJSON<ReprocessableDevice>(`${RPD_QUEUE_PATH}/${id}/discard`, body, true, keyHeader(key)); }

export function getDomainSettings(domain: ReprocessingDomain) { return getJSON<{ settings: ReprocessingDomainSettings }>(`/api/v1/reprocessing/domains/${domain}/settings`); }
export function updateDomainSettings(domain: ReprocessingDomain, body: ReprocessingDomainSettingsInput, key: string) { return putJSON<{ settings: ReprocessingDomainSettings }>(`/api/v1/reprocessing/domains/${domain}/settings`, body, true, keyHeader(key)); }
export function getDomainPolicies(domain: ReprocessingDomain) { return getJSON<{ policies: ReprocessingDomainPolicy[]; count: number }>(`/api/v1/reprocessing/domains/${domain}/policies`); }
export function updateDomainPolicies(domain: ReprocessingDomain, policies: ReprocessingDomainPolicyInput[], key: string) { return putJSON<{ policies: ReprocessingDomainPolicy[]; count: number }>(`/api/v1/reprocessing/domains/${domain}/policies`, { policies }, true, keyHeader(key)); }

export function listDialysisMachines() { return getJSON<DialysisMachine[]>("/api/v1/dialysis/machines"); }
export function createDialysisMachine(body: DialysisMachineInput, key: string) { return postJSON<DialysisMachine>("/api/v1/dialysis/machines", body, true, keyHeader(key)); }
export function updateDialysisMachine(id: number, body: DialysisMachineInput, key: string) { return fetchPatch<DialysisMachine>(`/api/v1/dialysis/machines/${id}`, body, key); }
export function getSessionDialyser(sessionId: number) { return getJSON<Record<string, unknown>>(`/api/v1/dialysis/sessions/${sessionId}/dialyser`); }
export function captureSessionDialyser(sessionId: number, body: Record<string, unknown>, key: string) { return postJSON<Record<string, unknown>>(`/api/v1/dialysis/sessions/${sessionId}/dialyser`, body, true, keyHeader(key)); }
export function recordDialyserReprocessing(sessionId: number, body: Record<string, unknown>, key: string) { return postJSON<Record<string, unknown>>(`/api/v1/dialysis/sessions/${sessionId}/reuse-register`, body, true, keyHeader(key)); }

// core.ts has no patchJSON; the one PATCH here goes through requestJSON with the
// same envelope handling. If core.ts gains patchJSON, use it and delete this.
async function fetchPatch<T>(endpoint: string, body: unknown, key: string) {
  const { requestJSON } = await import("./core");
  return requestJSON<T>(endpoint, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...keyHeader(key) } });
}
```

If `core.ts` does not export `requestJSON`, export it (it is the private function `getJSON` / `postJSON` call) — a one-line change; do not duplicate the envelope handling.

- [ ] **Step 2: CSSD Devices tab — domain filter and platform actions**

`DevicesTab.tsx` gains a **Domain** select (`aria-label="Device domain"`, options `Cath | Dialysis | OT`, default `cath` so the existing view and tests are unchanged). For `cath` the tab renders exactly what it renders today. For `dialysis` / `ot` it queries `listReprocessableDevices({ domain, status })`, renders the same columns plus **Identity** (`manufacturer_serial` / `set_code` + `hospital_asset_id`) and an **Evidence** column (`last_sterilization_load_id` for OT), and uses `ReprocessableDeviceActions` — a copy of `DeviceActions.tsx` bound to the platform API functions, `useIdempotencyKey("cssd-reprocessable-device")`, the twelve-value discard list, a `sterilization_load_id` field on the reprocessed dialog for OT, `chemical`/`other` only for dialysis, and a **Print label** action (`getReprocessableDeviceLabel` → the same print path `SetActions` uses for set labels). `ACTIONS_BY_STATUS` is the same table as the cath tab; `in_case` and `discarded` offer nothing. The `EmptyState` description for the two new domains: "Dialysers arrive here when a unit captures them; instrument sets when CSSD issues them under a reprocessing policy."

- [ ] **Step 3: Reprocessing policies page**

`dashboard/quality/reprocessing/page.tsx`: header "Reprocessing policies", a domain switch (`Dialysis | OT`, `aria-label="Reprocessing domain"`), and `DomainPolicyPanel domain={domain}`. The panel: a settings form (`reactive_patient_rule` radio — three values with one line of muted text each: "Discard — the device is retired after a reactive patient", "Quarantine — held for infection control to release or discard", "Override allowed — reprocessed with a recorded acknowledgement"; `unknown_serology_rule`; `serology_validity_days` 1–365 enforced client-side, with muted helper text on the dialysis panel "Not applied to dialysis: the isolation resolver uses no validity window" (spec §4.1); `isolation_enforcement` shown for dialysis only; and, for dialysis, the **class → group mapping** — four rows keyed `hbsag` / `hcv` / `hiv` / `isolation_mixed`, each a free-text bay label with a `datalist` of the groups already on registered machines and an empty value meaning "not mapped", rendered **read-only** unless the signed-in role is `INFECTION_CONTROL_OFFICER` / `ADMIN` / `SUPER_ADMIN` (the server refuses anyone else with `RPD_ISOLATION_GROUPS_FORBIDDEN`, spec §4.1), with the save response's `warnings[]` rendered inline as amber text under the mapping and **not** as an error) and the per-category policy rows (`reprocessable`, `max_cycles` optional with placeholder "no limit", `allowed_cycle_types` chips — dialysis shows `chemical` / `other` only, `tcv_min_pct` 50–100 for the dialysis `dialyser` row). Both saves: `useIdempotencyKey("reprocessing-domain-policy")`, and **`setQueryData` before `invalidateQueries`** (the Plan 3 save-revert lesson). Copy the layout and class names of `ReprocessingPolicyTab.tsx`. `navConfig.ts`: add `{ name: "Reprocessing Policies", href: "/dashboard/quality/reprocessing", minRole: "STAFF" }` after the "Cath Lab Quality" entry (the `quality` routePolicy segment already covers the path).

- [ ] **Step 4: Dialysis console**

- `types.ts`: `SessionRow` gains `isolation_warning_codes: string[]`, `isolation_required_group: string | null`, `isolation_override_reason: string | null`; `DialysisPatient`'s three status fields become `string | null`.
- `SessionTab.tsx`: `ReuseRegisterModal` moves to `recordDialyserReprocessing` (core.ts, `useIdempotencyKey("dialysis-reuse-register")`); when `getSessionDialyser(session.id)` returns a device, the serial and cycle-count fields render read-only from the device and the form adds Outcome (only the server's `allowed_dispositions`), measured TCV (with `% of baseline` when the link carries one), agent, contact minutes, concentration, and an acknowledgement box when `requires_acknowledgement`; `DIALYZER_REUSE_CYCLE_DERIVED` / `DIALYZER_REUSE_REGISTER_SETTLED` / `RPD_DISPOSITION_NOT_ALLOWED` render as inline errors. A new `DialyserPanel` above it: capture by serial (with model and baseline TCV), the dedication refusal verbatim, the restriction strip (`reasons` may be empty for a non-audience role — render the headline only), the isolation warning badge with codes.
- `MachinesTab.tsx` (new tab "Machines" in `page.tsx`): table of machines with an inline edit of `isolation_group` / `status`, and an add form; `isolation_group` is a free-text field (max 40) with a `datalist` of the groups already in use and an explicit "General machine" choice that sends `null` — there is no isolation-class select (D11 = NO, spec §4.6); `useIdempotencyKey("dialysis-machine")`.
- `RosterTab.tsx`: the enrol form is **not** changed by this lane (its serology selects, the `'unknown'` default and any server-side guard are Phase 1's — spec §3.3); the roster's `SerologyChip` renders "—" for `null` (projected) values; the serology-recording form is unchanged.
- `TodayBoardTab.tsx`: an amber "Isolation warning" badge when the session row's `isolation_warning_codes` is non-empty (the today board query must select the session's codes — extend `todayBoard` in the backend to `LEFT JOIN dialysis_sessions` for `isolation_warning_codes` if the view does not carry them; the spec defers changing the view itself).

- [ ] **Step 5: `POST /cssd/issues` now needs a key**

`lib/api/cssd.ts`: `createCssdIssue(body, key)` moves to `postJSON("/api/v1/cssd/issues", body, true, { "Idempotency-Key": assertIdempotencyKey(key) })`; `IssueActions.tsx` mints it with `useIdempotencyKey("cssd-set-issue")` and resets on success only; the issue dialog gains an acknowledgement box that appears when the server answers `CSSD_SET_ACKNOWLEDGEMENT_REQUIRED` and shows `CSSD_SET_QUARANTINED` / `CSSD_SET_EXPOSURE_BLOCKED` verbatim.

- [ ] **Step 6: Router coverage and tests**

`router-coverage.test.ts`: add `apps/admin/src/lib/api/reprocessableDevices.ts` to the scanned modules so the seven new CSSD routes need a caller. Tests: the Devices tab's domain select switches the API called and offers the twelve discard reasons and the load field for OT; the policies page enforces 1–365 and 50–100 and calls `updateDomainPolicies` with the domain; the machines tab posts with a key; the dialyser panel renders the dedication refusal; the issue dialog sends a key. Then:

```bash
cd apps/admin && npm run type-check && npm run lint && npm run format:check && npm test -- --testPathPattern "cssd|quality/reprocessing|dialysis"
git add apps/admin/src/lib/api/reprocessableDevices.ts apps/admin/src/lib/api/cssd.ts apps/admin/src/lib/navConfig.ts "apps/admin/src/app/(with-auth)/dashboard/cssd" "apps/admin/src/app/(with-auth)/dashboard/quality/reprocessing" "apps/admin/src/app/(with-auth)/dashboard/dialysis" apps/admin/src/__tests__/dashboard/cssd apps/admin/src/__tests__/dashboard/quality apps/admin/src/__tests__/dashboard/dialysis
git commit -m "feat(admin): CSSD devices domain filter, reprocessing policies page, dialysis machines and dialyser panels

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 9: Gates and hand-back

Modelled on Plan 3's Task 7 and Plan 2's Task 8. Nothing here is optional, and nothing is claimed green without its output in front of you.

- [ ] **Step 1: Bring `main` in and re-check the migration number**

```bash
cd "$SCRATCH/wt/rpd-impl"
git fetch github main && git merge --no-edit github/main
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do git ls-tree --name-only "$ref" apps/backend/src/migrations/ 2>/dev/null; done | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | uniq | tail -3
```

Expected: **767 is on `main`** (Phase 1 has landed — a hard gate for this step: Task 4's dialysis arm reads its resolver, and the dialysis deep suite must have RUN, not been skipped, before hand-back) and the tail ends `767`, `NNN` with no other branch carrying `NNN`. If another branch claimed `NNN` meanwhile, renumber the file and every reference (`grep -rn "<NNN>" apps/backend/src/migrations/<NNN>_* apps/backend/src/lib/prisma.js apps/backend/src/tests/unit/prismaCoverage.test.js apps/backend/scripts/seed-comprehensive-test-data.mjs`) in one commit. If 767 is **not** on `main` yet: push the branch and open the draft PR anyway (Steps 5–6), state in the body that the dialysis deep suite was skipped by its Phase 1 guard, and do not ask for merge.

- [ ] **Step 2: Backend gates on a fresh scratch database**

```bash
dropdb -h 127.0.0.1 -p 55432 vh_rpd_<initials> && createdb -h 127.0.0.1 -p 55432 vh_rpd_<initials>
cd apps/backend
node scripts/ci-setup-db.mjs
npm run lint
npm run check:migration-numbers && npm run check:migration-immutability && npm run check:migration-session-guc
npm run check:prisma-relations && node scripts/check-schema-drift.mjs
node ../../scripts/ci/check-inline-check-census.mjs && node ../../scripts/ci/check-inline-check-census.mjs --verify-db
npm run seed:test-data && npm run seed:test-data && npm run db:contracts:seeded
npm run openapi:check && npm run openapi:check-core && npm run openapi:lint-budget
npm test -- --testPathPatterns unit/
npm test -- --testPathPatterns "reprocessable-devices-dialysis.deep|reprocessable-devices-ot.deep|dialysis-isolation-census.deep|cath-device-reuse.deep|cath-lab-readiness.deep|bloodborne-markers.deep|cssd"
npm test -- --testPathPatterns "reprocessable-devices-dialysis.deep|reprocessable-devices-ot.deep|dialysis-isolation-census.deep"
node scripts/dialysis-isolation-census.mjs --all-tenants
cd ../.. && node scripts/ci/security.mjs
```

Expected: every command exits 0; the second seeder run reports 0 new rows; `db:contracts:seeded` green; the census `--verify-db` passes with an unchanged manifest; the lint budget reports 0 new findings; the deep suites pass twice (the second run proves the fixture tears down) — and the dialysis suite's summary line must read **tests passed, not skipped** (its Phase 1 guard skips it by name when `dialysisIsolationResolver.js` is absent; a skipped dialysis suite is not a green dialysis arm). The census script on the scratch database prints the fixture tenants as NOT CLEAR (the census test seeds an orphan and a legacy positive on purpose) and exits 1 — that is the script working, not failing; on a clean database it exits 0. Read the jest summary's `Suites failed` line separately from `Tests passed`. The **full unit corpus** runs, not the new suites alone — Plan 3's gate sweep found a route-suite load failure only that way.

- [ ] **Step 3: Staff and Admin gates**

```bash
cd apps/staff && flutter analyze && flutter test && dart format --set-exit-if-changed lib test
cd ../admin && npm run type-check && npm run lint && npm run format:check && npm test
cd ../.. && node scripts/generate-staff-role-contract.mjs --check
```

Expected: analyzer clean, every suite PASS (including the five-locale parity guard and the i18n guard), the role contract in sync.

- [ ] **Step 4: Mutation checks, all restored before commit**

Run each, confirm the named test goes red, restore: (1) dedication refusal in `captureTx` → dialysis deep "refused for another patient"; (2) flag/ceiling order in `computeDispositionOptions` → rules "checked BEFORE the ceiling" and the parity test; (3) the live `isolationDecisionTx` in `recordDialyserReprocessing` replaced by `usage.reuse_screen` → dialysis deep "snapshot vs decision" and the fourth `dialysisReuseHookCallSites` test; (4) `codes.push('DIALYSIS_SEROLOGY_UNKNOWN')` for `unknown` in `computeIsolationWarnings` → rules "UNKNOWN never isolates" and dialysis deep "an unknown patient is never blocked"; (5) the `onSessionCancelledTx(` call in `cancelSession` → dialysis deep "a scheduled session releases its captured dialyser" and `dialysisReuseHookCallSites`; (6) `partialUse` forced to `false` in `onSessionCancelledTx` and in `onIssueCancelledTx` → the `RPD_RETURN_REQUIRED` tests in both deep suites; (7) the `onSetReturnedTx` call in `transitionIssue` → the call-site pin; (8) the `onIssueCancelledTx(` call → the cancelled-branch pin and OT deep "an issued set is released"; (9) the `retainOnServerError: true` on the reuse-register claim → the wiring test; (10) `bool_or` → `DISTINCT ON … ORDER BY id DESC` in the census → census deep "older-row positive"; (11) a `UPDATE dialysis_patients SET hbsag_status` added to `dialysisReuseService.js` → `dialysisSerologyWriters`; (12) **`required_class: 'hbsag'` added to `POISONED_ISOLATION`'s warning entry, beside its resting `required_group: 'Bay 1'`** → the canary goes red for the three non-entitled dialysis readers, naming `isolation_warnings[0].required_class` (Task 6 Step 4(e); D11 = NO, spec §2) — and the resting `required_group: 'Bay 1'` must stay **green**, because a tenant's bay label is not a marker class; both arms are the check, and reporting only the red one leaves the green half unproven; (13) **`includeIsolationClass: true` added to `getSessionDialyser`'s resolver call** → `dialysisReuseHookCallSites`'s opt-in pin goes red on the count (the expected count is **1** since D11 = NO, not 2); and the same flag added back to `recordDialyserReprocessing` must go red on the same assertion — run both arms, because the second is the one that pins the asker this decision removed. (13b) **`dialysisExposureStamp` replaced by a class → marker map** → the two rules exposure-stamp tests and the dialysis deep suite's `exposure_markers` assertion go red. (14) **`isolation: POISONED_ISOLATION` removed from the `getSessionDialyser` mock (or `isolation_warnings` set to `[]`)** → the canary's population test goes red with `INERT FIXTURE … warningNodes: 0` (Task 6 Step 4(c2)) **and every value-sentinel test stays GREEN**. (14) is satisfied only by that exact pattern — ONE red, the population test. If a value-sentinel test goes red under this mutation, the fixture was carrying a class somewhere it should not and the population check has become decorative; if nothing goes red, the population check is not wired to the walk. Report the failing test NAME, not just "red": the two reds must be distinguishable in the output. (15) **Two arms, each ONE red and it must be the positive control:** (15a) `POISONED_DECISION.reasons` replaced by a benign string (`['HBsAg reactive']`, no sentinel) → the population test goes red with `INERT FIXTURE … did not receive the poisoned reuse_restriction.reasons sentinel`, while both shape counters and every value-sentinel test stay green; (15b) `POISONED_ISOLATION`'s warning entry swapped for a benign one (`machine_id: 1`) → red with `… fixture isolation envelope (machine_id 7) did not reach the entitled body`, shape counters still `> 0` (the benign entry satisfies the shape), value sentinel green. A shape-only population check passes both arms, which is why they exist. (There is still no `isolation` projection to mutate — the payload carries no class to blank, spec §3.4/§3.5 — so no check names one; there is no legacy-column mapper or enrol guard in this lane to mutate either.)

- [ ] **Step 5: Push and open the DRAFT PR**

```bash
git commit --allow-empty -m "chore(ci): [full-ci] reprocessable devices platform

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u github feat/reprocessable-devices-platform
gh pr create --repo Bahuleyandr/VH-Health-Platform --draft --base main --head feat/reprocessable-devices-platform --title "feat: reprocessable devices platform — dialysis and OT on one register (Plan 4, mig NNN)" --body-file <body>
```

The PR body states, in this order:

1. Spec path and that the owner decisions D1–D9 are honoured (list them in one line each).
2. Migration `NNN`: the five new tables, `dialysis_machines`, the six backing uniques, the `dialysis_sessions` / `dialyzer_reuse_register` / `surgical_implants` columns; that `dialysis_patients` and `patient_bloodborne_markers` are **not** touched (Phase 1's, migration 767); that `cath_reprocessable_devices` and the 753 plpgsql functions are untouched; that `NNN` is free on `github/main` and no remote branch carries it (re-checked at hand-back); the census manifest unchanged; the deploy note on the six index builds.
3. **The Phase 1 dependency (spec §3.3):** this lane consumes `resolveDialysisIsolation` for every dialysis decision through one adapter, live, with the frozen `reuse_screen` an evidence snapshot only; whether 767 was on `main` at hand-back and whether the dialysis deep suite RAN or was skipped by its guard; **the contract is closed** — `isolation_class` is **opt-in** behind `includeIsolationClass`, `null` unless `restricted`, after dev-1b rejected the unconditional fifth field (a value of `'hiv'` is serology whatever the caller calls it); the **one** server-side path that passes the flag (`assessIsolationTx`) and the fact that no read surface and no post-use path does; the adapter's fail-closed check keying on the **ask**, not on presence; that `snapshotOf` has no `keepClass` form; the Phase 2 census output per tenant.
4. **The owner decisions of 2026-09-06 and the decisions taken within them.** **D11 = NO** (spec §2): `dialysis_machines.isolation_group` (a nullable tenant label; `NULL` = a general machine) replaces `isolation_class` in the migration, the machine service, the OpenAPI schema and both consoles; the class → group map is `reprocessing_domain_settings.isolation_groups`, writable only under `ISOLATION_GROUP_ADMIN_ROUTE_ROLES`; the isolation payload is `{ codes, isolation_warnings: [{ code, machine_id, severity, required_group }], warn_only, enforcement_enabled, override }` with `DialysisIsolation` pinned `additionalProperties: false` so a class fails `openapi:check`; `required_class` is retired from the rules module, the audit metadata, the refusal details, the Staff strings and the wire; the dialysis `exposure_markers` stamp is the **flag alone** and the OT arm is unchanged; and the second asker of `includeIsolationClass` is **dropped**, leaving one. **Q1 = a legacy non-reactive `'negative'` MEANS `clear`** (spec §7.3): no blanket day-one acknowledgement, day-one amber expected low, `serology_validity_days` still inert for dialysis, migration 767 unblocked. Review round 1's Fix-6 ("do not blank `required_class`") is **superseded**. Then the decisions taken within the owner's: two policy tables; the `quarantine` rule and per-domain defaults; optional `max_cycles`; nullable `facility_id`; the one-command reprocessing record; the dialysis same-patient exposure exception; OT set discard retiring the set; `POST /cssd/issues` and `POST .../reuse-register` now claiming keys (behaviour changes) and `DIALYZER_REUSE_CYCLE_DERIVED` / `DIALYZER_REUSE_REGISTER_SETTLED`; `unknown` raising no per-session isolation code.
5. Verification: every gate above by name with its result; the deep suite counts twice on a fresh database (dialysis: 14 passed, never "skipped"); the seeder twice + `db:contracts:seeded`; the OpenAPI chain; the security stage; the canary's regenerated snapshot with the GROWTH-only diff described; Staff and Admin suite counts; the mutation checks listed.
6. Follow-ups: the spec's §9 **still-pending** owner decisions (DIALYSIS_TECHNICIAN assignability and the D10 audience widening; the implant lane; cath convergence; the statutory form; `facility_id` upstream; the lane pick, working assumption carve; Q2 and Q3) — note explicitly that **D11 and Q1 are DECIDED (2026-09-06) and are not follow-ups** — and the spec's §10 deferred list including the review-round-1 and carve-out follow-ups; whether the `fix(dialysis): scope machine ingest by tenant` commit was needed (Task 4 Step 0); OPEN-21 on the 260 new non-English lines (65 keys × 4 locales; the `required_group` string is rendered, and no `required_class` string was written); the census script and that the DROP is a future migration.
7. `Merge Gate` / `Full Merge Gate` by name with the head SHA once the canonical run lands.
8. End with: "Draft; merge authority stays with the coordinating session (dev-1b). Not mergeable before the Phase 1 lane (mig 767) is on `main`." and `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

Do not mark the PR ready. Do not merge. Report the head SHA, the PR number and the gate results to the coordinating session.

- [ ] **Step 6: Drop the scratch DB** — `dropdb -h 127.0.0.1 -p 55432 vh_rpd_<initials>`.

---

## Self-review against the spec

- §2 decisions: D1 typed owner pair + `num_nonnulls` CHECK (Task 1 §5); D1b cath untouched (Task 1 header, no plpgsql re-declared); D2 patient-blind register, dedication on the link row (Task 1 §4/§7, Task 4 `captureTx`); D2b fixed enum, `cath` admitted by no CHECK (Task 1, Task 2 `DOMAINS`); D3 `dialysis_machines` + warn-only with recorded override (Task 1 §8/§9, Task 4 `evaluateIsolationForSessionTx`); D5 sets + implant load FK (Task 1 §12, Task 5); D6 418 keeps its grain and gains `device_id` / `device_usage_id`, cycle derived (Task 1 §11, Task 4 `recordDialyserReprocessing`); D7 load-driven for OT only (Task 5 `onLoadTransitionedTx`, `load_domain_check`); D8 no billing file touched; D9 serial + asset id beside the `RD` tag (Task 1 §4, Task 3 `mintDeviceTx`). Two policy tables, the `quarantine` rule, optional `max_cycles`, nullable `facility_id`: Task 1 + Task 2.
- §3.1 one resolver per record shape: OT → `screenPatientTx` → `resolveReuseStatus` (Task 3); dialysis → the Phase 1 `Decision` through `dialysisIsolationAdapter.js` only (Task 4 Step 1). §3.2 one handler, two arms, per-device transactions, alert for the settled subset, **no roster write**: Task 3 `quarantineDevicesExposedToPatient`. §3.3 the carve-out: no sync / latch / union read / enrol guard / `recordSerology` change / backfill anywhere in this plan (writers pin, Task 4 Step 5); the adapter's contract (batch-first, `includeMarkers` default off and forwarded by no caller, `includeIsolationClass` default off and forwarded by exactly **one** server-side path — `assessIsolationTx`, pinned textually in `dialysisReuseHookCallSites`, the post-use asker dropped by D11 = NO — `snapshotOf` with no `keepClass` form, fail-closed 503, and `RPD_ISOLATION_DECISION_INVALID` keyed on the **ask**; the contract confirmed at Step 0b); snapshot vs decision (capture freezes, `getSessionDialyser` / `assessIsolationTx` / `recordDialyserReprocessing` re-resolve — pinned by the fourth `dialysisReuseHookCallSites` test and the deep "snapshot vs decision" test); `exposure_markers` on a dialysis device = the **flag alone** under D11 = NO (Task 2 `dialysisExposureStamp`, Task 3 `returnDeviceTx.exposureMarkers` fed an empty list; the OT arm still derives markers from `resolveReuseStatus`); the Phase 2 census (Task 4 Step 4) with its `bool_or` and orphan reads; DEPENDS ON Phase 1 marked on Task 4, Step 0b and the deep suite's `describeIfPhase1`. §3.4 the **three** codes, silence for clear-on-unregistered AND for `unknown`, `block`, the group-satisfaction rule (a `NULL` group never satisfies; an unmapped class accepts any non-null group) and the payload keyed on **`required_group` with no class key** through the single serialiser `isolationPayload`: Task 2 `computeIsolationWarnings` + Task 4 Step 2 and Step 3(a)/(b), with `dialysis_sessions.isolation_required_group` persisted so the session read re-serialises without asking for a class. §3.5 projection on every new read, both restriction shapes through one helper with cath's predicate, the `Decision`'s `isolation_class` blanked: Task 3 projection module, Task 4 Step 6, Task 5 theatre read. §3.6 three canary mounts + predicate + snapshot, the Decision poisoned with a `markers` key **and a class**, plus the D11 value sentinel and its mutation check: Task 6 Step 4. **D11 is DECIDED — NO** (spec §2, §9): the NO branch is implemented here, not held as an option — `dialysis_machines.isolation_group`, `reprocessing_domain_settings.isolation_groups`, `required_group` on every warning, `required_class` retired everywhere, the exposure stamp reduced to the flag and the second class-asker dropped. The resolver contract (spec §3.3) is untouched, so Phase 1 is unaffected. **Q1 is DECIDED** — a legacy non-reactive `'negative'` MEANS `clear`, which is Phase 1's rule and unblocks 767; this plan's only trace of it is the deep fixture's explicit neutralisation, which no longer depends on an open question.
- §4 data model: Task 1 SQL column for column, constraint for constraint (15 CHECKs on the register; eight `contype = 'f'` rows on usages — seven named composites plus the table's own `tenant_id` FK; the partial uniques including the cycle unique partial on `cancelled_before_use`; the three-column domain-pinning FKs; the two deferrable patient FKs; composite `SET NULL` column lists); `dialysis_patients` and `patient_bloodborne_markers` untouched (§4.7, §4.10). §4.11 order (13 steps) and the 753/758 assessment: Task 1 header.
- §4.3 / §4.4 the un-capture (review round 1, G1): `uncapture: in_case → available` keyed on the ACTION in `applyDeviceTransitionTx` (Task 3), `cancelled_before_use` in the disposition CHECK and the partial cycle unique (Task 1), `uncaptureDeviceTx` with its three refusals in order — closed usage / 418 row (`RPD_USAGE_NOT_CANCELLABLE`), then `partialUse` (`RPD_RETURN_REQUIRED`) (Task 3); `onSessionCancelledTx` inside `cancelSession`'s new `setTenantTx` before the status UPDATE (Task 4 Step 3(e)); `onIssueCancelledTx` before the shared `set_issue_log` UPDATE (Task 5 Step 2); the six pinned write paths (Task 4 Step 5 + Task 5 Step 3); cancel tests in both deep suites; no best-effort branch anywhere.
- §5.1 capture steps 1–6 (step 5 freezing the live `Decision` as the evidence snapshot), the same-patient exposure exception, the one-command record with TCV/integrity verdicts over a re-resolved `Decision`, the optional (derived) cycle count validated inside `legacyWrite` only, settled-row rule, legacy path when dark (no resolver touched), the Cancel flow (no resolver needed): Task 4. §5.2 four hooks (issue, return, cancel, load), quarantine-on-return, forbidden-cycle-type quarantine, ceiling discard on release, a hold (exposure or `sterilization_failed`) survives a passed load, discard retires the set, `affected_devices[]`: Task 5. §5.3 shared disposition rule + parity test: Task 2. §5.4 safety reviews with `review_type = 'reprocessable_device_reuse'`: Task 3 `recordReuseSafetyReview`.
- §6.1–§6.5 routes, scopes, guard-before-claim, retain flags, the label shape: Tasks 4–6; §6.6 overlay and chain: Task 6 Step 5; §6.7 Admin: Task 8; §6.8 Staff incl. the role-graph feature and contract regeneration: Task 7.
- §7.1 every code named is thrown by name in Tasks 2–5 (`RPD_*` incl. `RPD_ISOLATION_RESOLVER_UNAVAILABLE` / `RPD_ISOLATION_DECISION_INVALID` in the adapter, `DIALYSER_*`, `DIALYZER_*`, `DIALYSIS_*`, `CSSD_SET_*`; no `DIALYSIS_SEROLOGY_FIELDS_NOT_ALLOWED`); §7.2 audit events emitted by `recordAudit` / `auditTx` under those names, `isolation_evaluated` carrying `required_group`, `machine_no`, `enforcement`, the codes and the Decision's status / evidence / asOf — never its reasons, its markers or a marker class (D11 = NO) — no `dialysis.patient.*` event; §7.3 rollout defaults are the `settingsDefaultsFor` table and the dark-by-default branches, the Phase 1 dependency fail-closed; §7.4 subset assertions: Task 6 Step 3; §7.5 CI trees: each task commits within its owning tree, the contract regeneration with the Staff task; §7.6 the census script: Task 4 Step 4.
- §8 tests: unit (Tasks 2, 3, 4 Steps 1 and 5, 5 Step 3, 6 Steps 3–4), deep (Task 4 Step 7 behind `describeIfPhase1`, Task 4 Step 4 census, Task 5 Step 6), mutation checks (Task 9 Step 4), seeder overrides (Task 1 Step 5), `prismaCoverage` pins (Task 1 Step 4), gates (Task 9 Step 2–3).
- Type consistency: `computeDispositionOptions({ domain, usage, policy, settings, restriction, device })` is called identically in the unit test, `getSessionDialyser`, `recordDialyserReprocessing` and `onSetReturnedTx` — it reads only `restriction.status`, so the cath/OT object and the dialysis `Decision` both drive it; `computeIsolationWarnings({ decision, machine, isolationGroups, enforcement })` reads `decision.status`, `decision.isolation_class` (as an unnamed local, to index `isolationGroups`) and `machine.isolation_group` only, and returns `{ codes, required_group, blocked }`; `applyDeviceTransitionTx(tx, device, action, patch, context)` is the one signature every transition uses; `captureDeviceTx` / `returnDeviceTx` take the same `{ device, usage, … , context }` shapes in both domains (`returnDeviceTx`'s `exposureMarkers` / `deviceMetadata` are optional and dialysis-only); `projectReuseRestrictionForRole` tells the two shapes apart by `evidence` and is the one projection both domains and the canary predicate rely on; the Staff `ReuseRestriction.fromJson` parses both shapes; the Staff `DialyserCaptureDraft.toJson()` emits exactly the keys `DialyserCaptureRequest` declares and `DialyserReprocessingDraft.toJson()` the keys `DialyserReuseRegisterRequest` declares; the Admin `RPD_STATUSES` / `RPD_DISCARD_REASONS` are `satisfies`-pinned to the generated types.
- Carve-out consistency with the spec: every `767` in this plan refers to the Phase 1 lane's migration; every `NNN` is this lane's; `dialysis_patients` appears only as something read (census, projection, the fixture neutralisation in a test) and never written; the only import of the Phase 1 module is the adapter (pinned).
