# Cath Device Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a cath lab record the reprocessing and reuse of catheters, guidewires, balloons and sheaths without a manual ledger: a system-minted device identity at return, a per-category tenant policy, reuse by tag scan with no stock movement and no pharmacy shortfall task, a manual CSSD device queue, reduced-tariff billing, and blood-borne restriction alerts at capture and return.

**Architecture:** Three new tables (`cath_reprocessing_settings`, `cath_reprocessing_category_policies`, `cath_reprocessable_devices`) plus new columns on `cath_case_consumable_usage` and `cath_consumable_catalog`; one forward migration re-declares the 753 assert function with a `reused_device` branch (753 and 758 untouched). A new `cathDeviceReuseService.js` owns the register, policies, post-use flow and CSSD transitions; `cathLabService.js` gains a reused-capture branch and a reuse-context decorator; billing picks the reprocessed code. Staff (Flutter) gets the New/Reused capture mode, the restriction strip and the post-use actions; Admin (Next.js) gets the CSSD Devices tab, the catalogue field and the policy editor.

**Tech Stack:** Node 26 ESM backend (Express, raw SQL via `setTenantTx`, Postgres 17 RLS, plpgsql), jest ESM, OpenAPI overlays; Flutter Staff app (`AppStrings` five-locale map, `ApiClient`, `mobile_scanner`); Next.js Admin (`@tanstack/react-query`, `core.ts` typed helpers, `createAttemptKeyStore`).

**Spec:** `docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md` §5.2–§5.6, §6, §8–§13. **Depends on Plan 1** (`2026-09-04-bloodborne-markers-foundation.md`): `bloodborneMarkerService.js` and `labAnalyteCodes.js` must exist on the base branch.

**Base:** `github/main` after the Plan 1 PR merges. If it has not merged yet, branch from `feat/bloodborne-markers` and rebase onto main before hand-back.

---

## Conventions (same as Plan 1, plus)

- All the conventions in Plan 1's "Conventions you must follow" apply verbatim (tenant transactions, raw SQL, `AppError`, npm-run jest, immutable migrations, schema drift mirror, scratch DB, commit trailer, `[full-ci]` last commit, draft PR, no merge).
- **Never edit `753_*.sql` or `758_*.sql`.** The new migration re-declares the function by copying 758's text.
- **The 753 constraint trigger is deferred to commit.** A deep test that expects a 23514 must `await expect(setTenantTx(...)).rejects…` on the whole transaction, not on the statement.
- **`cathLabService.js` is 4,956 lines.** Add only the call-outs shown here; everything new lives in `cathDeviceReuseService.js`.
- **Pharmacy caution from the coordinator:** an unexplained regression exists on the admin pharmacy dashboard. This plan touches cath reconciliation reads only through the new status value; if anything you change makes a pharmacy suite red, stop and report rather than patch.
- **Staff strings:** every new `s4.lib.cath_lab.*` key must be added to all FIVE locale maps in `apps/staff/lib/l10n/app_strings.dart` (en near line 8038, hi near 15480, ta near 24246, te near 33091, ml near 38793 for the existing cath keys). The parity gate fails on a missing key in any locale.

---

## File structure

| File | Responsibility |
|---|---|
| Create `apps/backend/src/migrations/766_cath_device_reuse.sql` | Settings, category policies, device register, usage/catalog columns, 753 assert re-declaration. |
| Modify `apps/backend/prisma/schema.prisma` | Mirror the three tables and the new columns. |
| Create `apps/backend/src/services/clinical/cathDeviceReuseService.js` | Policy reads/writes, register, transitions, post-use, reused capture helpers, reuse context, late-reactive handler. |
| Create `apps/backend/src/tests/unit/cathDeviceReuseService.test.js` | Pure rules: transitions, post-use options, tag validation. |
| Create `apps/backend/src/tests/cath-device-reuse.deep.test.js` | Contract, capture, post-use, CSSD, billing, late-result quarantine, RLS. |
| Modify `apps/backend/src/services/clinical/cathLabService.js` | Reused branch in `recordConsumableUsage`; `reuse_restriction` on `getCase`; billing code selection; unbilled gap reason. |
| Modify `apps/backend/src/routes/clinical/cathLabRoutes.js` | Post-use, device lookup, device history; consumables listing decorated with reuse context. |
| Modify `apps/backend/src/routes/cssd/cssdRoutes.js` | Six device queue routes. |
| Modify `apps/backend/src/routes/admin/cathConsumablesRoutes.js` | Settings and policy endpoints; catalogue accepts the reused code. |
| Create `apps/backend/scripts/openapi/schemas/cathDeviceReuse.mjs`; modify `cathConsumables.mjs`, `generate-openapi.mjs`; regenerate `openapi.json` | Contracts. |
| Modify Staff: `cath_consumable_models.dart`, `cath_lab_api_service.dart`, `cath_consumable_capture_sheet.dart`, `cath_case_consumables_panel.dart`, `app_strings.dart`; tests under `apps/staff/test/features/cath_lab/` | Reused capture, restriction strip, post-use actions. |
| Create Admin: `src/lib/api/cathDevices.ts`, `dashboard/cssd/components/DevicesTab.tsx`, `DeviceActions.tsx`, `dashboard/quality/cath/components/ReprocessingPolicyTab.tsx`; modify `cssd/page.tsx`, `quality/cath/page.tsx`, `billing/cath-consumables/components/CatalogForm.tsx`; tests under `src/__tests__/dashboard/` | CSSD queue, policy editor, catalogue field. |

---

## Task 0: Branch, worktree, migration number

- [ ] **Step 1: Cut the branch in a scratchpad worktree**

```bash
cd "/d/Dev/Projects/VH Health/VH-Health-Platform"
git fetch github '+refs/heads/*:refs/remotes/github/*'
git worktree add "$SCRATCH/wt/reuse-impl" -b feat/cath-device-reuse github/main
cd "$SCRATCH/wt/reuse-impl/apps/backend" && npm ci
```

If `git show github/main:apps/backend/src/services/clinical/bloodborneMarkerService.js` fails, Plan 1 has not merged: use `-b feat/cath-device-reuse github/feat/bloodborne-markers` instead.

- [ ] **Step 2: Compute the migration number against main and every open branch**

```bash
cd "$SCRATCH/wt/reuse-impl"
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do
  git ls-tree --name-only "$ref" apps/backend/src/migrations/ 2>/dev/null
done | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | uniq | tail -3
```

Expected tail: `764`, `765` (Plan 1). This plan uses **766**. Substitute if claimed; re-run immediately before the final push.

---

## Task 1: Migration 766

**Files:**
- Create: `apps/backend/src/migrations/766_cath_device_reuse.sql`
- Modify: `apps/backend/prisma/schema.prisma`

- [ ] **Step 1: Extract the 758 function text you will re-declare**

```bash
cd apps/backend/src/migrations
grep -n "CREATE OR REPLACE FUNCTION public.cath_inventory_authority_assert_contract_753" 758_pharmacy_advance_funding_authority.sql
```

Expected: one line number near 4042. Then find its end (the line `$function$;` that follows, near 4363):

```bash
awk 'NR>=4042 && /^\$function\$;/ {print NR; exit}' 758_pharmacy_advance_funding_authority.sql
```

Note both numbers as START and END. Write the function text to a scratch file:

```bash
sed -n "${START},${END}p" 758_pharmacy_advance_funding_authority.sql > "$SCRATCH/assert753.sql"
grep -n "Terminal Cath usage preservation lacks its governed recovery receipt" "$SCRATCH/assert753.sql"
```

Expected: one match. Three lines below it are `USING ERRCODE='23514';`, `END IF;`, `RETURN;`, `END IF;` — the fourth `END IF;` after the match closes the `not_applicable` early return. The reused branch goes immediately after that line.

- [ ] **Step 2: Insert the reused-device branch into the scratch copy**

Open `$SCRATCH/assert753.sql` and, immediately after the `END IF;` that closes the `not_applicable` early return, insert:

```sql
  -- 766: a reused reprocessable device consumes no stock and owes no pharmacy
  -- shortfall obligation (spec 2026-09-04 §8). Independent of ballot 753-D1.
  IF usage_record.inventory_decrement_status = 'reused_device' THEN
    IF usage_record.device_id IS NULL
       OR usage_record.reuse_cycle IS NULL
       OR usage_record.inventory_batch_id IS NOT NULL
       OR usage_record.inventory_movement_id IS NOT NULL
       OR EXISTS (
         SELECT 1
           FROM public.pharmacy_stock_movements movement
          WHERE movement.tenant_id = usage_record.tenant_id
            AND movement.reference_type = 'cath_consumable_usage'
            AND movement.reference_id = usage_record.id
       )
       OR EXISTS (
         SELECT 1
           FROM public.tasks task
          WHERE task.tenant_id = usage_record.tenant_id
            AND task.task_contract = 'cath_inventory_shortfall_v1'
            AND task.related_resource_id = usage_record.id::text
       )
       OR EXISTS (
         SELECT 1
           FROM public.workflow_sla_instances sla
          WHERE sla.tenant_id = usage_record.tenant_id
            AND sla.rule_code = 'cath_consumable_inventory_reconciliation'
            AND sla.source_table = 'cath_case_consumable_usage'
            AND sla.source_id = usage_record.id::text
       )
       OR NOT EXISTS (
         SELECT 1
           FROM public.cath_reprocessable_devices device
          WHERE device.id = usage_record.device_id
            AND device.tenant_id = usage_record.tenant_id
            AND device.catalog_item_id = usage_record.catalog_item_id
       )
    THEN
      RAISE EXCEPTION 'Reused device usage carries inventory or shortfall artefacts'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
```

Before saving, confirm the three referenced column names against the existing triple assertion in the same scratch file (search it for `task_contract`, `related_resource_id`, `rule_code`, `source_table`): use exactly the column names that function already uses. If the existing text references the SLA through a different column pair, mirror it. Also confirm `usage_record` declares `device_id` and `reuse_cycle`: the function reads `usage_record` with `SELECT * ... INTO usage_record` (or an explicit column list). If it is an explicit list, add `device_id` and `reuse_cycle` to that list in the scratch copy. Do not use `CASE` inside `IF` (SQLSTATE 42601 in the body gate).

- [ ] **Step 3: Write the migration**

```sql
-- 766_cath_device_reuse.sql
--
-- Cath-lab device reuse (spec docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md).
-- Indian cath labs reprocess and reuse catheters, guidewires, balloons and
-- sheaths; stents, pacemakers, leads and closure devices are never reused.
-- Until now a cath usage row could only bind to a stock batch, and migration
-- 753 obliged every non-terminal usage to carry a pharmacy shortfall task, so a
-- reused device could not be recorded truthfully.
--
-- This migration adds, forward-only:
--   * cath_reprocessing_settings            — per tenant: blood-borne rules + serology window
--   * cath_reprocessing_category_policies   — per tenant per category: reprocessable, max cycles
--   * cath_reprocessable_devices            — the device register (system-minted tag, cycle count)
--   * cath_case_consumable_usage            — device_id, reuse_cycle, post_use_disposition,
--                                             reuse_screen, post_use_screen; status value
--                                             'reused_device'; shape CHECK; the 753 exact-authority
--                                             CHECK re-added with a third arm
--   * cath_consumable_catalog               — reused_billing_item_code
--   * cath_inventory_authority_assert_contract_753 re-declared exactly as 758
--     re-declared it, plus one branch: a 'reused_device' usage must reference a
--     device of the same catalogue item and carry no stock movement, no
--     shortfall task and no SLA. Every other branch is byte-identical to 758.
--     Migrations 753 and 758 are not edited.
--
-- Ballot 753-D1 (every new-unit use is a shortfall task, or only actual
-- shortfalls) is NOT decided here. Reused devices are exempt whichever way the
-- owner votes; the ballot now concerns new units only.
--
-- NOT VALID: chk_cath_usage_exact_inventory_authority_753 was NOT VALID in 753
-- because legacy rows may violate its first two arms. It is dropped and re-added
-- NOT VALID here with a third arm for reused devices, for the same reason. It is
-- not meant to stay unvalidated (OPEN-15 class). Validate in a follow-up once:
--
--   SELECT count(*) FROM cath_case_consumable_usage u
--    WHERE NOT (
--      (u.facility_id IS NOT NULL AND u.inventory_item_id IS NOT NULL AND u.inventory_batch_id IS NOT NULL)
--      OR (u.inventory_decrement_status = 'not_applicable'
--          AND u.metadata->'authority_recovery'->>'action' IN ('PRESERVE','CANCEL')
--          AND u.facility_id IS NULL AND u.inventory_item_id IS NULL
--          AND u.inventory_batch_id IS NULL AND u.inventory_movement_id IS NULL)
--      OR (u.inventory_decrement_status = 'reused_device' AND u.device_id IS NOT NULL
--          AND u.facility_id IS NOT NULL AND u.inventory_item_id IS NOT NULL
--          AND u.inventory_batch_id IS NULL AND u.inventory_movement_id IS NULL));
--
--   ALTER TABLE cath_case_consumable_usage
--     VALIDATE CONSTRAINT chk_cath_usage_exact_inventory_authority_753;
--
-- On a freshly migrated database the count is 0 immediately.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ---------------------------------------------------------------------------
-- 1. Tenant settings
-- ---------------------------------------------------------------------------
CREATE TABLE cath_reprocessing_settings (
  tenant_id UUID PRIMARY KEY DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  reactive_patient_rule VARCHAR(24) NOT NULL DEFAULT 'discard',
  unknown_serology_rule VARCHAR(24) NOT NULL DEFAULT 'warn',
  serology_validity_days INTEGER NOT NULL DEFAULT 90,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ(6),
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT cath_reprocessing_settings_reactive_rule_check
    CHECK (reactive_patient_rule IN ('discard', 'override_allowed')),
  CONSTRAINT cath_reprocessing_settings_unknown_rule_check
    CHECK (unknown_serology_rule IN ('warn', 'block_return')),
  CONSTRAINT cath_reprocessing_settings_validity_check
    CHECK (serology_validity_days BETWEEN 1 AND 365)
);

-- ---------------------------------------------------------------------------
-- 2. Category policies
-- ---------------------------------------------------------------------------
CREATE TABLE cath_reprocessing_category_policies (
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  category VARCHAR(40) NOT NULL,
  reprocessable BOOLEAN NOT NULL DEFAULT FALSE,
  max_cycles INTEGER,
  allowed_cycle_types TEXT[] NOT NULL DEFAULT '{}'::text[],
  function_check_required BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT cath_reprocessing_category_policies_pkey PRIMARY KEY (tenant_id, category),
  CONSTRAINT cath_reprocessing_category_policies_category_check
    CHECK (category IN ('stent', 'balloon', 'guidewire', 'catheter', 'sheath',
                        'closure_device', 'pacemaker', 'lead', 'other')),
  CONSTRAINT cath_reprocessing_category_policies_implant_check
    CHECK (category NOT IN ('stent', 'pacemaker', 'lead', 'closure_device') OR reprocessable = FALSE),
  CONSTRAINT cath_reprocessing_category_policies_max_cycles_check
    CHECK (max_cycles IS NULL OR max_cycles BETWEEN 1 AND 50),
  CONSTRAINT cath_reprocessing_category_policies_cycle_types_check
    CHECK (allowed_cycle_types <@ ARRAY['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other']::text[]),
  CONSTRAINT cath_reprocessing_category_policies_complete_check
    CHECK (reprocessable = FALSE OR (max_cycles IS NOT NULL AND cardinality(allowed_cycle_types) >= 1))
);

-- ---------------------------------------------------------------------------
-- 3. Device register (no patient identity; patient linkage lives on usage rows)
-- ---------------------------------------------------------------------------
CREATE TABLE cath_reprocessable_devices (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  facility_id INTEGER NOT NULL,
  catalog_item_id BIGINT NOT NULL REFERENCES cath_consumable_catalog(id) ON DELETE RESTRICT,
  device_tag VARCHAR(24) GENERATED ALWAYS AS ('RP' || lpad(id::text, 8, '0')) STORED,
  origin_usage_id BIGINT NOT NULL REFERENCES cath_case_consumable_usage(id) ON DELETE RESTRICT,
  origin_unit_index SMALLINT NOT NULL DEFAULT 1,
  cycle_count INTEGER NOT NULL DEFAULT 0,
  max_cycles_snapshot INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'awaiting_reprocessing',
  current_usage_id BIGINT REFERENCES cath_case_consumable_usage(id) ON DELETE SET NULL,
  exposure_flag BOOLEAN NOT NULL DEFAULT FALSE,
  exposure_markers TEXT[] NOT NULL DEFAULT '{}'::text[],
  last_reprocessed_at TIMESTAMPTZ(6),
  last_reprocessed_by UUID,
  last_cycle_type VARCHAR(20),
  last_function_check VARCHAR(16),
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
  CONSTRAINT cath_reprocessable_devices_unit_index_check CHECK (origin_unit_index >= 1),
  CONSTRAINT cath_reprocessable_devices_cycle_check CHECK (cycle_count >= 0),
  CONSTRAINT cath_reprocessable_devices_max_cycles_check CHECK (max_cycles_snapshot >= 1),
  CONSTRAINT cath_reprocessable_devices_cycle_bound_check CHECK (cycle_count <= max_cycles_snapshot),
  CONSTRAINT cath_reprocessable_devices_status_check
    CHECK (status IN ('awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded')),
  CONSTRAINT cath_reprocessable_devices_in_case_check
    CHECK (status <> 'in_case' OR current_usage_id IS NOT NULL),
  CONSTRAINT cath_reprocessable_devices_cycle_type_check
    CHECK (last_cycle_type IS NULL OR last_cycle_type IN ('steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other')),
  CONSTRAINT cath_reprocessable_devices_function_check_check
    CHECK (last_function_check IS NULL OR last_function_check IN ('not_required', 'pass', 'fail')),
  CONSTRAINT cath_reprocessable_devices_discard_reason_check
    CHECK (discard_reason IS NULL OR discard_reason IN (
      'max_cycles_reached', 'bloodborne_exposure', 'late_reactive_marker', 'function_check_failed',
      'sterilization_failed', 'damaged', 'wasted', 'policy_change', 'other')),
  CONSTRAINT cath_reprocessable_devices_discarded_check
    CHECK (status <> 'discarded' OR (discard_reason IS NOT NULL AND discarded_at IS NOT NULL)),
  CONSTRAINT ux_cath_reprocessable_devices_origin UNIQUE (origin_usage_id, origin_unit_index)
);

CREATE UNIQUE INDEX ux_cath_reprocessable_devices_tag ON cath_reprocessable_devices (tenant_id, device_tag);
CREATE INDEX idx_cath_reprocessable_devices_status ON cath_reprocessable_devices (tenant_id, status);
CREATE INDEX idx_cath_reprocessable_devices_facility ON cath_reprocessable_devices (tenant_id, facility_id, status);
CREATE INDEX idx_cath_reprocessable_devices_catalog ON cath_reprocessable_devices (tenant_id, catalog_item_id, status);

-- ---------------------------------------------------------------------------
-- 4. Usage row: reused-device columns, status value, shape checks
-- ---------------------------------------------------------------------------
ALTER TABLE cath_case_consumable_usage
  ADD COLUMN device_id BIGINT REFERENCES cath_reprocessable_devices(id) ON DELETE RESTRICT,
  ADD COLUMN reuse_cycle INTEGER,
  ADD COLUMN post_use_disposition VARCHAR(32),
  ADD COLUMN reuse_screen JSONB,
  ADD COLUMN post_use_screen JSONB;

ALTER TABLE cath_case_consumable_usage
  DROP CONSTRAINT IF EXISTS cath_consumable_usage_inventory_status_check,
  ADD CONSTRAINT cath_consumable_usage_inventory_status_check
    CHECK (inventory_decrement_status IN (
      'pending', 'not_linked', 'decremented', 'insufficient_stock', 'error',
      'not_applicable', 'reused_device'
    )),
  ADD CONSTRAINT cath_consumable_usage_reuse_cycle_check
    CHECK (reuse_cycle IS NULL OR reuse_cycle >= 1),
  ADD CONSTRAINT cath_consumable_usage_post_use_check
    CHECK (post_use_disposition IS NULL OR post_use_disposition IN (
      'sent_for_reprocessing', 'discarded_bloodborne_exposure', 'discarded_max_cycles',
      'discarded_wasted', 'discarded_other', 'not_reprocessable')),
  ADD CONSTRAINT cath_consumable_usage_reused_device_shape_check
    CHECK (
      ((inventory_decrement_status = 'reused_device') = (device_id IS NOT NULL AND reuse_cycle IS NOT NULL))
      AND (inventory_decrement_status <> 'reused_device'
           OR (inventory_batch_id IS NULL AND inventory_movement_id IS NULL))
    ),
  DROP CONSTRAINT IF EXISTS chk_cath_usage_exact_inventory_authority_753,
  ADD CONSTRAINT chk_cath_usage_exact_inventory_authority_753
    CHECK (
      (facility_id IS NOT NULL AND inventory_item_id IS NOT NULL AND inventory_batch_id IS NOT NULL)
      OR (
        inventory_decrement_status = 'not_applicable'
        AND metadata->'authority_recovery'->>'action' IN ('PRESERVE', 'CANCEL')
        AND facility_id IS NULL AND inventory_item_id IS NULL
        AND inventory_batch_id IS NULL AND inventory_movement_id IS NULL
      )
      OR (
        inventory_decrement_status = 'reused_device'
        AND device_id IS NOT NULL
        AND facility_id IS NOT NULL AND inventory_item_id IS NOT NULL
        AND inventory_batch_id IS NULL AND inventory_movement_id IS NULL
      )
    ) NOT VALID;

CREATE INDEX idx_cath_consumable_usage_device ON cath_case_consumable_usage (tenant_id, device_id)
  WHERE device_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Catalogue: reprocessed tariff code
-- ---------------------------------------------------------------------------
ALTER TABLE cath_consumable_catalog
  ADD COLUMN reused_billing_item_code VARCHAR(50);

-- ---------------------------------------------------------------------------
-- 6. RLS on the three new tables
-- ---------------------------------------------------------------------------
ALTER TABLE cath_reprocessing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_reprocessing_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cath_reprocessing_settings;
CREATE POLICY tenant_isolation ON cath_reprocessing_settings
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

ALTER TABLE cath_reprocessing_category_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_reprocessing_category_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cath_reprocessing_category_policies;
CREATE POLICY tenant_isolation ON cath_reprocessing_category_policies
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

ALTER TABLE cath_reprocessable_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_reprocessable_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cath_reprocessable_devices;
CREATE POLICY tenant_isolation ON cath_reprocessable_devices
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
-- 7. Re-declare the 753 assert function (body copied from 758 + the reused branch)
-- ---------------------------------------------------------------------------
```

Then append the entire contents of `$SCRATCH/assert753.sql` (the edited copy) below that comment, followed by:

```sql

COMMIT;
```

- [ ] **Step 4: Apply, verify the function and the constraints**

```bash
cd apps/backend
DATABASE_URL=postgres://…/vh_cdr_<initials> node scripts/ci-setup-db.mjs
psql "$DATABASE_URL" -c "SELECT position('reused_device' in pg_get_functiondef('public.cath_inventory_authority_assert_contract_753'::regproc)) > 0 AS has_branch;"
psql "$DATABASE_URL" -c "SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'cath_case_consumable_usage'::regclass AND conname IN ('cath_consumable_usage_inventory_status_check','cath_consumable_usage_reused_device_shape_check','chk_cath_usage_exact_inventory_authority_753') ORDER BY 1;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM pg_constraint WHERE conrelid = 'cath_reprocessable_devices'::regclass AND contype = 'c';"
```

Expected: `has_branch = t`; the three usage constraints present, the exact-authority one with `convalidated = f` and the other two `t`; device table check count = 11.

- [ ] **Step 5: Mirror in `schema.prisma`, run the gates**

Run `npx prisma db pull --print --url "$DATABASE_URL"` and copy the emitted `cath_reprocessing_settings`, `cath_reprocessing_category_policies`, `cath_reprocessable_devices` models, the new fields on `cath_case_consumable_usage` (`device_id`, `reuse_cycle`, `post_use_disposition`, `reuse_screen`, `post_use_screen`, plus the relation fields it emits) and `reused_billing_item_code` on `cath_consumable_catalog`, and every back-relation it adds on `tenants`, `cath_consumable_catalog` and `cath_case_consumable_usage`. Then:

```bash
node scripts/check-schema-drift.mjs
npm run db:generate
npm run check:migration-numbers && npm run check:migration-session-guc
node ../../scripts/ci/check-inline-check-census.mjs
node ../../scripts/ci/check-migration-immutability.mjs
```

Expected: all exit 0. The plpgsql body gate runs in CI; to pre-check locally, `grep -n "plpgsql" ../../scripts/ci/security.mjs` names the script and run it.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/migrations/766_cath_device_reuse.sql apps/backend/prisma/schema.prisma
git commit -m "feat(db): cath device reuse register, policies, usage columns, 753 assert re-declared (mig 766)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: `cathDeviceReuseService.js` — rules, policies, register, CSSD transitions (TDD)

**Files:**
- Create: `apps/backend/src/services/clinical/cathDeviceReuseService.js`
- Test: `apps/backend/src/tests/unit/cathDeviceReuseService.test.js`

- [ ] **Step 1: Write the failing unit tests for the pure rules**

```js
// apps/backend/src/tests/unit/cathDeviceReuseService.test.js
import {
  DEVICE_ACTIONS,
  computePostUseOptions,
  deviceTransition,
  normalizeDeviceTag,
} from '../../services/clinical/cathDeviceReuseService.js';

const policy = { reprocessable: true, max_cycles: 3, allowed_cycle_types: ['eto'], function_check_required: false };
const settings = { reactive_patient_rule: 'discard', unknown_serology_rule: 'warn', serology_validity_days: 90 };
const clear = { status: 'clear', reasons: [] };
const restricted = { status: 'restricted', reasons: ['HBsAg reactive 2026-08-12'] };
const unknown = { status: 'unknown', reasons: ['HCV not on record'] };
const firstUse = { id: 1, wasted: false, quantity: '2.0000', device_id: null, post_use_disposition: null };
const reusedRow = { id: 2, wasted: false, quantity: '1.0000', device_id: 9, reuse_cycle: 1, post_use_disposition: null };

describe('deviceTransition', () => {
  test.each([
    ['awaiting_reprocessing', 'receive', 'in_cssd'],
    ['awaiting_reprocessing', 'reprocessed', 'available'],
    ['in_cssd', 'reprocessed', 'available'],
    ['available', 'capture', 'in_case'],
    ['in_case', 'return', 'awaiting_reprocessing'],
    ['available', 'quarantine', 'quarantined'],
    ['quarantined', 'release', 'awaiting_reprocessing'],
    ['in_case', 'discard', 'discarded'],
    ['quarantined', 'discard', 'discarded'],
  ])('%s --%s--> %s', (from, action, to) => {
    expect(deviceTransition(from, action)).toEqual({ ok: true, to, allowedFrom: DEVICE_ACTIONS[action].from });
  });

  test.each([
    ['discarded', 'receive'], ['available', 'release'], ['in_case', 'reprocessed'],
    ['quarantined', 'capture'], ['discarded', 'discard'], ['awaiting_reprocessing', 'nonsense'],
  ])('%s --%s--> refused', (from, action) => {
    expect(deviceTransition(from, action).ok).toBe(false);
  });
});

describe('normalizeDeviceTag', () => {
  test('accepts RP + 8 digits in any case with surrounding whitespace', () => {
    expect(normalizeDeviceTag(' rp00000042 ')).toBe('RP00000042');
  });
  test.each(['RP42', 'XX00000042', '', null, 'RP0000004A'])('rejects %p', (value) => {
    expect(() => normalizeDeviceTag(value)).toThrow(/device tag/);
  });
});

describe('computePostUseOptions', () => {
  test('wasted rows offer nothing', () => {
    const out = computePostUseOptions({ usage: { ...firstUse, wasted: true }, category: 'catheter', isImplant: false, policy, settings, restriction: clear });
    expect(out).toMatchObject({ dispositions: [], reason_codes: ['wasted'] });
  });
  test('rows already dispositioned offer nothing', () => {
    const out = computePostUseOptions({ usage: { ...firstUse, post_use_disposition: 'sent_for_reprocessing' }, category: 'catheter', isImplant: false, policy, settings, restriction: clear });
    expect(out).toMatchObject({ dispositions: [], reason_codes: ['already_recorded'] });
  });
  test('implants and non-reprocessable categories offer nothing', () => {
    expect(computePostUseOptions({ usage: firstUse, category: 'stent', isImplant: true, policy: { ...policy }, settings, restriction: clear }).reason_codes).toEqual(['not_reprocessable']);
    expect(computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy: null, settings, restriction: clear }).reason_codes).toEqual(['not_reprocessable']);
    expect(computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy: { ...policy, reprocessable: false }, settings, restriction: clear }).reason_codes).toEqual(['not_reprocessable']);
  });
  test('clear serology: reprocess and discard, no acknowledgement, units up to the row quantity', () => {
    const out = computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings, restriction: clear });
    expect(out).toEqual({ dispositions: ['reprocess', 'discard'], requires_acknowledgement: false, exposure: false, discard_reason: null, blocked_code: null, reason_codes: [], units_max: 2 });
  });
  test('restricted + discard rule: discard only, reason bloodborne_exposure', () => {
    const out = computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings, restriction: restricted });
    expect(out).toMatchObject({ dispositions: ['discard'], discard_reason: 'bloodborne_exposure', reason_codes: ['bloodborne_restricted'] });
  });
  test('restricted + override_allowed: reprocess with acknowledgement, device flagged', () => {
    const out = computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings: { ...settings, reactive_patient_rule: 'override_allowed' }, restriction: restricted });
    expect(out).toMatchObject({ dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, exposure: true, reason_codes: ['bloodborne_restricted_override'] });
  });
  test('unknown + warn: reprocess with acknowledgement', () => {
    const out = computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings, restriction: unknown });
    expect(out).toMatchObject({ dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, exposure: false, reason_codes: ['serology_unknown'] });
  });
  test('unknown + block_return: discard only with the blocking code', () => {
    const out = computePostUseOptions({ usage: firstUse, category: 'catheter', isImplant: false, policy, settings: { ...settings, unknown_serology_rule: 'block_return' }, restriction: unknown });
    expect(out).toMatchObject({ dispositions: ['discard'], blocked_code: 'CATH_REPROCESSING_SEROLOGY_REQUIRED', reason_codes: ['serology_required'] });
  });
  test('a reused row whose device is at max cycles: discard only, reason max_cycles_reached, one unit', () => {
    const out = computePostUseOptions({ usage: reusedRow, category: 'catheter', isImplant: false, policy, settings, restriction: clear, device: { cycle_count: 3, max_cycles_snapshot: 3, status: 'in_case' } });
    expect(out).toMatchObject({ dispositions: ['discard'], discard_reason: 'max_cycles_reached', reason_codes: ['max_cycles_reached'], units_max: 1 });
  });
  test('a reused row below max cycles follows the serology rules with one unit', () => {
    const out = computePostUseOptions({ usage: reusedRow, category: 'catheter', isImplant: false, policy, settings, restriction: clear, device: { cycle_count: 1, max_cycles_snapshot: 3, status: 'in_case' } });
    expect(out).toMatchObject({ dispositions: ['reprocess', 'discard'], units_max: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --testPathPatterns unit/cathDeviceReuseService`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the service (rules, settings, policies, register, transitions)**

```js
// apps/backend/src/services/clinical/cathDeviceReuseService.js
//
// Cath-lab reprocessable device register, per-tenant reprocessing policy,
// post-use flow and CSSD device queue. Spec:
// docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md
//
// Boundaries: cathLabService.recordConsumableUsage calls captureReusedDeviceTx
// and markDeviceInCaseTx; everything else about devices lives here. The
// register carries no patient identity — patient linkage is on usage rows —
// so the CSSD routes can read it without PHI logging.

import prisma, { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  DEFAULT_VALIDITY_DAYS,
  registerExposureHandler,
  resolveReuseStatus,
} from './bloodborneMarkerService.js';

export const DEVICE_STATUSES = Object.freeze([
  'awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded',
]);
export const CYCLE_TYPES = Object.freeze(['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other']);
export const FUNCTION_CHECK_RESULTS = Object.freeze(['not_required', 'pass', 'fail']);
export const DISCARD_REASONS = Object.freeze([
  'max_cycles_reached', 'bloodborne_exposure', 'late_reactive_marker', 'function_check_failed',
  'sterilization_failed', 'damaged', 'wasted', 'policy_change', 'other',
]);
export const POST_USE_DISPOSITIONS = Object.freeze([
  'sent_for_reprocessing', 'discarded_bloodborne_exposure', 'discarded_max_cycles',
  'discarded_wasted', 'discarded_other', 'not_reprocessable',
]);
export const REACTIVE_PATIENT_RULES = Object.freeze(['discard', 'override_allowed']);
export const UNKNOWN_SEROLOGY_RULES = Object.freeze(['warn', 'block_return']);
export const CATH_CATEGORIES = Object.freeze([
  'stent', 'balloon', 'guidewire', 'catheter', 'sheath', 'closure_device', 'pacemaker', 'lead', 'other',
]);
export const IMPLANT_CATEGORIES = Object.freeze(['stent', 'pacemaker', 'lead', 'closure_device']);
export const DEVICE_TAG_PATTERN = /^RP[0-9]{8}$/;

// Every state change on a device, and the states it may start from.
export const DEVICE_ACTIONS = Object.freeze({
  receive: Object.freeze({ from: Object.freeze(['awaiting_reprocessing']), to: 'in_cssd' }),
  reprocessed: Object.freeze({ from: Object.freeze(['awaiting_reprocessing', 'in_cssd']), to: 'available' }),
  quarantine: Object.freeze({ from: Object.freeze(['awaiting_reprocessing', 'in_cssd', 'available']), to: 'quarantined' }),
  release: Object.freeze({ from: Object.freeze(['quarantined']), to: 'awaiting_reprocessing' }),
  discard: Object.freeze({ from: Object.freeze(['awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined']), to: 'discarded' }),
  capture: Object.freeze({ from: Object.freeze(['available']), to: 'in_case' }),
  return: Object.freeze({ from: Object.freeze(['in_case']), to: 'awaiting_reprocessing' }),
});

export function deviceTransition(status, action) {
  const rule = DEVICE_ACTIONS[action];
  if (!rule) return { ok: false, to: null, allowedFrom: [] };
  return { ok: rule.from.includes(status), to: rule.to, allowedFrom: rule.from };
}

export function normalizeDeviceTag(value) {
  const tag = String(value ?? '').trim().toUpperCase();
  if (!DEVICE_TAG_PATTERN.test(tag)) {
    throw AppError.badRequest('device tag must look like RP00000042', 'CATH_DEVICE_TAG_INVALID');
  }
  return tag;
}

// Which post-use dispositions a usage row may take right now. Pure; the
// caller supplies the policy, settings, serology restriction and (for reused
// rows) the device. `units_max` is how many register rows a first-use row may
// still spawn.
export function computePostUseOptions({
  usage,
  category,
  isImplant,
  policy,
  settings,
  restriction,
  device = null,
}) {
  const base = {
    dispositions: [],
    requires_acknowledgement: false,
    exposure: false,
    discard_reason: null,
    blocked_code: null,
    reason_codes: [],
    units_max: device ? 1 : Math.max(0, Math.floor(Number(usage?.quantity) || 0)),
  };
  if (usage?.wasted) return { ...base, reason_codes: ['wasted'] };
  if (usage?.post_use_disposition) return { ...base, reason_codes: ['already_recorded'] };
  if (isImplant || IMPLANT_CATEGORIES.includes(category) || !policy || policy.reprocessable !== true) {
    return { ...base, reason_codes: ['not_reprocessable'] };
  }
  if (device && Number(device.cycle_count) >= Number(device.max_cycles_snapshot)) {
    return { ...base, dispositions: ['discard'], discard_reason: 'max_cycles_reached', reason_codes: ['max_cycles_reached'] };
  }
  const status = restriction?.status || 'unknown';
  if (status === 'restricted') {
    if (settings.reactive_patient_rule === 'override_allowed') {
      return { ...base, dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, exposure: true, reason_codes: ['bloodborne_restricted_override'] };
    }
    return { ...base, dispositions: ['discard'], discard_reason: 'bloodborne_exposure', reason_codes: ['bloodborne_restricted'] };
  }
  if (status === 'unknown') {
    if (settings.unknown_serology_rule === 'block_return') {
      return { ...base, dispositions: ['discard'], blocked_code: 'CATH_REPROCESSING_SEROLOGY_REQUIRED', reason_codes: ['serology_required'] };
    }
    return { ...base, dispositions: ['reprocess', 'discard'], requires_acknowledgement: true, reason_codes: ['serology_unknown'] };
  }
  return { ...base, dispositions: ['reprocess', 'discard'] };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const tenantOr = (value) => requireTenantId(value);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_PATTERN.test(text)) throw AppError.badRequest(`${label} must be a UUID`, 'CATH_LAB_BAD_UUID');
  return text.toLowerCase();
}

function positiveInt(value, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  }
  return n;
}

function oneOf(value, allowed, label, code = 'CATH_LAB_BAD_ENUM') {
  const text = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(text)) throw AppError.badRequest(`${label} must be one of ${allowed.join(', ')}`, code);
  return text;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  throw AppError.badRequest('Boolean field is invalid', 'CATH_LAB_BAD_BOOLEAN');
}

function num(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value?.toNumber === 'function') return value.toNumber();
  return value;
}

function withTenant(tenantId, db, fn) {
  return db ? fn(db) : setTenant(tenantId, fn);
}

async function recordDeviceAudit(tx, { tenantId, action, resource, resourceId, context = {}, metadata = {} }) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`,
    tenantId,
    context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null,
    cleanText(context.actorRole, 60),
    action,
    resource,
    String(resourceId),
    JSON.stringify(metadata),
  );
}

// ---------------------------------------------------------------------------
// Tenant settings
// ---------------------------------------------------------------------------

export const SETTINGS_DEFAULTS = Object.freeze({
  reactive_patient_rule: 'discard',
  unknown_serology_rule: 'warn',
  serology_validity_days: DEFAULT_VALIDITY_DAYS,
});

const SETTINGS_SELECT = `tenant_id, reactive_patient_rule, unknown_serology_rule, serology_validity_days,
  reviewed_by, reviewed_at, updated_by, created_at, updated_at`;

export async function getReprocessingSettings({ tenantId, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(
    `SELECT ${SETTINGS_SELECT} FROM cath_reprocessing_settings WHERE tenant_id = $1::uuid LIMIT 1`,
    tid,
  ));
  const row = rows[0];
  if (!row) return { tenant_id: tid, ...SETTINGS_DEFAULTS, reviewed_by: null, reviewed_at: null, configured: false };
  return { ...row, serology_validity_days: Number(row.serology_validity_days), configured: true };
}

export async function upsertReprocessingSettings(input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const reactiveRule = oneOf(input.reactive_patient_rule ?? SETTINGS_DEFAULTS.reactive_patient_rule, REACTIVE_PATIENT_RULES, 'reactive_patient_rule');
  const unknownRule = oneOf(input.unknown_serology_rule ?? SETTINGS_DEFAULTS.unknown_serology_rule, UNKNOWN_SEROLOGY_RULES, 'unknown_serology_rule');
  const validity = positiveInt(input.serology_validity_days ?? SETTINGS_DEFAULTS.serology_validity_days, 'serology_validity_days', { max: 365 });
  const actor = requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_reprocessing_settings
         (tenant_id, reactive_patient_rule, unknown_serology_rule, serology_validity_days, reviewed_by, reviewed_at, updated_by)
       VALUES ($1::uuid, $2, $3, $4::int, $5::uuid, NOW(), $5::uuid)
       ON CONFLICT (tenant_id) DO UPDATE SET
         reactive_patient_rule = EXCLUDED.reactive_patient_rule,
         unknown_serology_rule = EXCLUDED.unknown_serology_rule,
         serology_validity_days = EXCLUDED.serology_validity_days,
         reviewed_by = EXCLUDED.reviewed_by,
         reviewed_at = NOW(),
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING ${SETTINGS_SELECT}`,
      tid, reactiveRule, unknownRule, validity, actor,
    );
    await recordDeviceAudit(tx, {
      tenantId: tid, action: 'CATH_REPROCESSING_SETTINGS_UPDATED', resource: 'cath_reprocessing_settings', resourceId: tid,
      context, metadata: { reactive_patient_rule: reactiveRule, unknown_serology_rule: unknownRule, serology_validity_days: validity },
    });
    return { ...rows[0], serology_validity_days: Number(rows[0].serology_validity_days), configured: true };
  });
}

// ---------------------------------------------------------------------------
// Category policies
// ---------------------------------------------------------------------------

const POLICY_SELECT = `tenant_id, category, reprocessable, max_cycles, allowed_cycle_types, function_check_required, updated_by, created_at, updated_at`;

function normalizePolicy(row) {
  return {
    ...row,
    max_cycles: row.max_cycles == null ? null : Number(row.max_cycles),
    allowed_cycle_types: Array.isArray(row.allowed_cycle_types) ? row.allowed_cycle_types : [],
  };
}

function defaultPolicy(tenantId, category) {
  return { tenant_id: tenantId, category, reprocessable: false, max_cycles: null, allowed_cycle_types: [], function_check_required: false, updated_by: null, created_at: null, updated_at: null };
}

export async function listCategoryPolicies({ tenantId, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(
    `SELECT ${POLICY_SELECT} FROM cath_reprocessing_category_policies WHERE tenant_id = $1::uuid`,
    tid,
  ));
  const byCategory = new Map(rows.map((row) => [row.category, normalizePolicy(row)]));
  return CATH_CATEGORIES.map((category) => byCategory.get(category) || defaultPolicy(tid, category));
}

export async function categoryPolicyTx(tx, tenantId, category) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${POLICY_SELECT} FROM cath_reprocessing_category_policies WHERE tenant_id = $1::uuid AND category = $2 LIMIT 1`,
    tenantOr(tenantId), category,
  );
  return rows[0] ? normalizePolicy(rows[0]) : null;
}

function validatePolicyInput(entry) {
  const category = oneOf(entry.category, CATH_CATEGORIES, 'category');
  const reprocessable = boolValue(entry.reprocessable, false);
  if (reprocessable && IMPLANT_CATEGORIES.includes(category)) {
    throw AppError.badRequest(`${category} is an implant category and can never be reprocessable`, 'CATH_REPROCESSING_IMPLANT_FORBIDDEN');
  }
  const maxCycles = entry.max_cycles == null || entry.max_cycles === '' ? null : positiveInt(entry.max_cycles, 'max_cycles', { max: 50 });
  const cycleTypes = Array.isArray(entry.allowed_cycle_types) ? entry.allowed_cycle_types.map((t) => oneOf(t, CYCLE_TYPES, 'allowed_cycle_types')) : [];
  const functionCheck = boolValue(entry.function_check_required, false);
  if (reprocessable && (maxCycles == null || cycleTypes.length === 0)) {
    throw AppError.badRequest('A reprocessable category needs max_cycles and at least one allowed cycle type', 'CATH_REPROCESSING_POLICY_INCOMPLETE');
  }
  return { category, reprocessable, maxCycles, cycleTypes: [...new Set(cycleTypes)], functionCheck };
}

export async function upsertCategoryPolicies({ tenantId, policies = [] } = {}, context = {}) {
  const tid = tenantOr(tenantId);
  if (!Array.isArray(policies) || policies.length === 0) {
    throw AppError.badRequest('policies must be a non-empty array', 'CATH_REPROCESSING_POLICY_INCOMPLETE');
  }
  const actor = requireUuid(context.actorUid, 'actorUid');
  const validated = policies.map(validatePolicyInput);
  await setTenantTx(tid, async (tx) => {
    for (const policy of validated) {
      await tx.$executeRawUnsafe(
        `INSERT INTO cath_reprocessing_category_policies
           (tenant_id, category, reprocessable, max_cycles, allowed_cycle_types, function_check_required, updated_by)
         VALUES ($1::uuid, $2, $3, $4::int, $5::text[], $6, $7::uuid)
         ON CONFLICT (tenant_id, category) DO UPDATE SET
           reprocessable = EXCLUDED.reprocessable,
           max_cycles = EXCLUDED.max_cycles,
           allowed_cycle_types = EXCLUDED.allowed_cycle_types,
           function_check_required = EXCLUDED.function_check_required,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        tid, policy.category, policy.reprocessable, policy.maxCycles, policy.cycleTypes, policy.functionCheck, actor,
      );
    }
    await recordDeviceAudit(tx, {
      tenantId: tid, action: 'CATH_REPROCESSING_POLICY_UPDATED', resource: 'cath_reprocessing_category_policies', resourceId: tid,
      context, metadata: { categories: validated.map((p) => ({ category: p.category, reprocessable: p.reprocessable, max_cycles: p.maxCycles })) },
    });
  });
  return listCategoryPolicies({ tenantId: tid });
}

// ---------------------------------------------------------------------------
// Device register
// ---------------------------------------------------------------------------

const DEVICE_SELECT = `d.id, d.tenant_id, d.facility_id, d.catalog_item_id, d.device_tag, d.origin_usage_id,
  d.origin_unit_index, d.cycle_count, d.max_cycles_snapshot, d.status, d.current_usage_id,
  d.exposure_flag, d.exposure_markers, d.last_reprocessed_at, d.last_reprocessed_by,
  d.last_cycle_type, d.last_function_check, d.quarantine_reason, d.quarantined_at,
  d.discard_reason, d.discard_note, d.discarded_at, d.discarded_by, d.created_by, d.created_at,
  d.updated_at, d.metadata, c.item_name, c.category, c.manufacturer, c.model`;
const DEVICE_FROM = `FROM cath_reprocessable_devices d
  JOIN cath_consumable_catalog c ON c.id = d.catalog_item_id AND c.tenant_id = d.tenant_id`;

export function normalizeDevice(row) {
  if (!row) return row;
  return {
    ...row,
    id: num(row.id),
    catalog_item_id: num(row.catalog_item_id),
    origin_usage_id: num(row.origin_usage_id),
    current_usage_id: row.current_usage_id == null ? null : num(row.current_usage_id),
    cycle_count: Number(row.cycle_count),
    max_cycles_snapshot: Number(row.max_cycles_snapshot),
    facility_id: Number(row.facility_id),
    exposure_markers: Array.isArray(row.exposure_markers) ? row.exposure_markers : [],
  };
}

export async function listDevices({ tenantId, status = null, facilityId = null, limit = 100 } = {}) {
  const tid = tenantOr(tenantId);
  const params = [tid];
  const clauses = ['d.tenant_id = $1::uuid'];
  if (status) { params.push(oneOf(status, DEVICE_STATUSES, 'status')); clauses.push(`d.status = $${params.length}`); }
  if (facilityId) { params.push(positiveInt(facilityId, 'facility_id')); clauses.push(`d.facility_id = $${params.length}::int`); }
  params.push(Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500));
  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT ${DEVICE_SELECT} ${DEVICE_FROM}
      WHERE ${clauses.join(' AND ')}
      ORDER BY CASE d.status
                 WHEN 'awaiting_reprocessing' THEN 0 WHEN 'in_cssd' THEN 1 WHEN 'quarantined' THEN 2
                 WHEN 'available' THEN 3 WHEN 'in_case' THEN 4 ELSE 5 END,
               d.updated_at DESC, d.id DESC
      LIMIT $${params.length}::int`,
    ...params,
  ));
  return rows.map(normalizeDevice);
}

export async function deviceByTag({ tenantId, tag, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const safeTag = normalizeDeviceTag(tag);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(
    `SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.device_tag = $2 LIMIT 1`,
    tid, safeTag,
  ));
  return rows[0] ? normalizeDevice(rows[0]) : null;
}

async function lockDeviceTx(tx, tenantId, deviceId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${DEVICE_SELECT} ${DEVICE_FROM}
      WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint
      FOR UPDATE OF d`,
    tenantOr(tenantId), positiveInt(deviceId, 'device_id'),
  );
  const device = rows[0];
  if (!device) throw AppError.notFound('Reprocessable device not found', 'CATH_DEVICE_NOT_FOUND');
  return normalizeDevice(device);
}

async function lockDeviceByTagTx(tx, tenantId, tag) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${DEVICE_SELECT} ${DEVICE_FROM}
      WHERE d.tenant_id = $1::uuid AND d.device_tag = $2
      FOR UPDATE OF d`,
    tenantOr(tenantId), normalizeDeviceTag(tag),
  );
  const device = rows[0];
  if (!device) throw AppError.notFound('Reprocessable device not found', 'CATH_DEVICE_NOT_FOUND');
  return normalizeDevice(device);
}

function assertTransition(device, action) {
  const verdict = deviceTransition(device.status, action);
  if (!verdict.ok) {
    throw AppError.conflict(
      `Device ${device.device_tag} is ${device.status}; ${action} is only allowed from ${verdict.allowedFrom.join(', ')}`,
      'CATH_DEVICE_INVALID_TRANSITION',
      { status: device.status, action, allowed_from: verdict.allowedFrom },
    );
  }
  return verdict.to;
}

// One UPDATE per action. `patch` carries the action-specific columns.
async function applyDeviceTransitionTx(tx, device, action, patch = {}, context = {}) {
  const to = assertTransition(device, action);
  const actor = context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null;
  const rows = await tx.$queryRawUnsafe(
    `UPDATE cath_reprocessable_devices d
        SET status = $3,
            current_usage_id = CASE WHEN $3 = 'in_case' THEN $4::bigint
                                    WHEN $3 IN ('awaiting_reprocessing', 'discarded') THEN NULL
                                    ELSE current_usage_id END,
            cycle_count = CASE WHEN $3 = 'available' THEN cycle_count + 1 ELSE cycle_count END,
            last_reprocessed_at = CASE WHEN $3 = 'available' THEN NOW() ELSE last_reprocessed_at END,
            last_reprocessed_by = CASE WHEN $3 = 'available' THEN $5::uuid ELSE last_reprocessed_by END,
            last_cycle_type = CASE WHEN $3 = 'available' THEN $6 ELSE last_cycle_type END,
            last_function_check = CASE WHEN $3 = 'available' THEN $7 ELSE last_function_check END,
            quarantine_reason = CASE WHEN $3 = 'quarantined' THEN $8 ELSE quarantine_reason END,
            quarantined_at = CASE WHEN $3 = 'quarantined' THEN NOW() ELSE quarantined_at END,
            discard_reason = CASE WHEN $3 = 'discarded' THEN $9 ELSE discard_reason END,
            discard_note = CASE WHEN $3 = 'discarded' THEN $10 ELSE discard_note END,
            discarded_at = CASE WHEN $3 = 'discarded' THEN NOW() ELSE discarded_at END,
            discarded_by = CASE WHEN $3 = 'discarded' THEN $5::uuid ELSE discarded_by END,
            exposure_flag = exposure_flag OR $11,
            exposure_markers = CASE WHEN $12::text[] IS NULL THEN exposure_markers
                                    ELSE (SELECT ARRAY(SELECT DISTINCT unnest(exposure_markers || $12::text[]))) END,
            metadata = metadata || $13::jsonb,
            updated_at = NOW()
      WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint
      RETURNING d.id`,
    device.tenant_id,
    device.id,
    to,
    patch.usageId == null ? null : positiveInt(patch.usageId, 'usage_id'),
    actor,
    patch.cycleType ?? null,
    patch.functionCheck ?? null,
    cleanText(patch.quarantineReason, 500),
    patch.discardReason ?? null,
    cleanText(patch.discardNote, 2000),
    Boolean(patch.exposureFlag),
    Array.isArray(patch.exposureMarkers) && patch.exposureMarkers.length ? patch.exposureMarkers : null,
    JSON.stringify(patch.metadata || {}),
  );
  if (!rows[0]) throw AppError.internal('Device transition did not persist', 'CATH_DEVICE_TRANSITION_FAILED');
  await recordDeviceAudit(tx, {
    tenantId: device.tenant_id,
    action: `cath_device.${action}`,
    resource: 'cath_reprocessable_devices',
    resourceId: device.id,
    context,
    metadata: {
      device_tag: device.device_tag, from: device.status, to,
      cycle_count_before: device.cycle_count,
      discard_reason: patch.discardReason ?? null,
      quarantine_reason: cleanText(patch.quarantineReason, 500),
      note: cleanText(patch.discardNote ?? patch.note, 500),
    },
  });
  return lockDeviceTx(tx, device.tenant_id, device.id);
}

// ---- CSSD queue actions ----------------------------------------------------

export async function receiveDevice(deviceId, context = {}) {
  const tid = tenantOr(context.tenantId);
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'receive', {}, context));
}

export async function markDeviceReprocessed(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId);
  const cycleType = oneOf(input.cycle_type ?? input.cycleType, CYCLE_TYPES, 'cycle_type', 'CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED');
  const functionCheck = input.function_check_result == null && input.functionCheckResult == null
    ? null
    : oneOf(input.function_check_result ?? input.functionCheckResult, FUNCTION_CHECK_RESULTS, 'function_check_result');
  return setTenantTx(tid, async (tx) => {
    const device = await lockDeviceTx(tx, tid, deviceId);
    const policy = await categoryPolicyTx(tx, tid, device.category);
    if (!policy || policy.reprocessable !== true) {
      throw AppError.conflict(`${device.category} is not reprocessable under the current policy`, 'CATH_REPROCESSING_NOT_ALLOWED');
    }
    if (!policy.allowed_cycle_types.includes(cycleType)) {
      throw AppError.conflict(`${cycleType} is not an allowed cycle type for ${device.category}`, 'CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED', { allowed: policy.allowed_cycle_types });
    }
    if (policy.function_check_required && functionCheck !== 'pass' && functionCheck !== 'fail') {
      throw AppError.badRequest('function_check_result (pass or fail) is required for this category', 'CATH_DEVICE_FUNCTION_CHECK_REQUIRED');
    }
    if (functionCheck === 'fail') {
      return applyDeviceTransitionTx(tx, device, 'discard', { discardReason: 'function_check_failed', discardNote: cleanText(input.note, 2000), metadata: { cycle_type: cycleType } }, context);
    }
    if (device.cycle_count >= device.max_cycles_snapshot) {
      throw AppError.conflict(`Device ${device.device_tag} has reached ${device.max_cycles_snapshot} cycles; discard it`, 'CATH_DEVICE_MAX_CYCLES_REACHED');
    }
    return applyDeviceTransitionTx(tx, device, 'reprocessed', { cycleType, functionCheck: functionCheck ?? 'not_required' }, context);
  });
}

export async function quarantineDevice(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId);
  const reason = cleanText(input.reason, 500);
  if (!reason) throw AppError.badRequest('reason is required to quarantine a device', 'CATH_DEVICE_REASON_REQUIRED');
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'quarantine', { quarantineReason: reason }, context));
}

export async function releaseDevice(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId);
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'release', { note: cleanText(input.note, 500), metadata: { release_note: cleanText(input.note, 500) } }, context));
}

export async function discardDevice(deviceId, input = {}, context = {}) {
  const tid = tenantOr(context.tenantId);
  const reason = oneOf(input.reason, DISCARD_REASONS, 'reason', 'CATH_DEVICE_REASON_REQUIRED');
  return setTenantTx(tid, async (tx) => applyDeviceTransitionTx(tx, await lockDeviceTx(tx, tid, deviceId), 'discard', { discardReason: reason, discardNote: cleanText(input.note, 2000) }, context));
}

export { lockDeviceTx, lockDeviceByTagTx, applyDeviceTransitionTx, recordDeviceAudit, withTenant, cleanText, requireUuid, positiveInt, oneOf };
```

- [ ] **Step 4: Run the unit tests**

Run: `npm test -- --testPathPatterns unit/cathDeviceReuseService`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/clinical/cathDeviceReuseService.js apps/backend/src/tests/unit/cathDeviceReuseService.test.js
git commit -m "feat(cath): device reuse service — rules, policies, register, CSSD transitions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: Reuse context, reused capture, post-use, late-reactive handler, history

**Files:**
- Modify: `apps/backend/src/services/clinical/cathDeviceReuseService.js` (append)
- Modify: `apps/backend/src/services/clinical/cathLabService.js` (`recordConsumableUsage` 4064–4466, `getCase` 971–1026, import block)
- Test: `apps/backend/src/tests/cath-device-reuse.deep.test.js`

- [ ] **Step 1: Append the case-level helpers to the reuse service**

```js
// ---------------------------------------------------------------------------
// Case-level reuse context and usage decoration
// ---------------------------------------------------------------------------

async function caseRowTx(client, tenantId, caseId, { lock = false } = {}) {
  const rows = await client.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, facility_id, status, actual_start_at
       FROM cath_lab_cases
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      ${lock ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    tenantOr(tenantId), positiveInt(caseId, 'case_id'),
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Cath-lab case not found', 'CATH_LAB_CASE_NOT_FOUND');
  return { ...row, id: num(row.id), facility_id: row.facility_id == null ? null : Number(row.facility_id) };
}

export async function caseReuseContext({ tenantId, caseId, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const run = (fn) => withTenant(tid, db, fn);
  return run(async (client) => {
    const cathCase = await caseRowTx(client, tid, caseId);
    const settings = await getReprocessingSettings({ tenantId: tid, db: client });
    const policies = await listCategoryPolicies({ tenantId: tid, db: client });
    const restriction = await resolveReuseStatus({
      tenantId: tid, patientUid: cathCase.patient_uid, validityDays: settings.serology_validity_days, db: client,
    });
    return {
      case: cathCase,
      settings,
      policies,
      restriction,
      reprocessable_categories: policies.filter((p) => p.reprocessable).map((p) => p.category),
    };
  });
}

// Adds device_tag / reuse_cycle / post_use_disposition / allowed_post_use to
// usage rows produced by cathLabService.listCaseConsumableUsage.
export async function decorateConsumablesWithReuse(usageRows, { tenantId, caseId }) {
  const tid = tenantOr(tenantId);
  const context = await caseReuseContext({ tenantId: tid, caseId });
  const deviceIds = usageRows.map((u) => u.device_id).filter((id) => id != null).map(Number);
  const devices = deviceIds.length
    ? await setTenant(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.id = ANY($2::bigint[])`,
      tid, deviceIds,
    ))
    : [];
  const byId = new Map(devices.map((d) => [num(d.id), normalizeDevice(d)]));
  const policyByCategory = new Map(context.policies.map((p) => [p.category, p]));
  const usage = usageRows.map((row) => {
    const device = row.device_id == null ? null : byId.get(Number(row.device_id)) || null;
    const options = computePostUseOptions({
      usage: row,
      category: row.category,
      isImplant: Boolean(row.is_implant),
      policy: policyByCategory.get(row.category) || null,
      settings: context.settings,
      restriction: context.restriction,
      device,
    });
    return {
      ...row,
      device_tag: device ? device.device_tag : null,
      device_status: device ? device.status : null,
      device_exposure_flag: device ? device.exposure_flag : false,
      allowed_post_use: options,
    };
  });
  return {
    usage,
    reuse_restriction: context.restriction,
    reprocessing: {
      settings: context.settings,
      reprocessable_categories: context.reprocessable_categories,
    },
  };
}

// ---------------------------------------------------------------------------
// Reused capture — called by cathLabService.recordConsumableUsage inside its tx
// ---------------------------------------------------------------------------

export async function captureReusedDeviceTx(tx, { tenantId, cathCase, catalog, deviceTag, acknowledgementReason = null }) {
  const tid = tenantOr(tenantId);
  const device = await lockDeviceByTagTx(tx, tid, deviceTag);
  if (device.catalog_item_id !== Number(catalog.id)) {
    throw AppError.conflict(`Device ${device.device_tag} is a ${device.item_name}, not the selected catalogue item`, 'CATH_DEVICE_CATALOG_MISMATCH');
  }
  if (device.facility_id !== Number(cathCase.facility_id)) {
    throw AppError.conflict(`Device ${device.device_tag} belongs to another facility`, 'CATH_DEVICE_FACILITY_MISMATCH');
  }
  const policy = await categoryPolicyTx(tx, tid, catalog.category);
  if (!policy || policy.reprocessable !== true) {
    throw AppError.conflict(`${catalog.category} is not reprocessable under the current policy`, 'CATH_REPROCESSING_NOT_ALLOWED');
  }
  if (device.status !== 'available') {
    throw AppError.conflict(`Device ${device.device_tag} is ${device.status}, not available`, 'CATH_DEVICE_NOT_AVAILABLE', { status: device.status });
  }
  const settings = await getReprocessingSettings({ tenantId: tid, db: tx });
  if (device.exposure_flag) {
    if (settings.reactive_patient_rule === 'discard') {
      throw AppError.conflict(`Device ${device.device_tag} carries a blood-borne exposure flag`, 'CATH_DEVICE_EXPOSURE_BLOCKED', { exposure_markers: device.exposure_markers });
    }
    if (!acknowledgementReason) {
      throw AppError.badRequest('exposure_acknowledgement.reason is required to reuse an exposure-flagged device', 'CATH_DEVICE_ACKNOWLEDGEMENT_REQUIRED', { exposure_markers: device.exposure_markers });
    }
  }
  const restriction = await resolveReuseStatus({
    tenantId: tid, patientUid: cathCase.patient_uid, validityDays: settings.serology_validity_days, db: tx,
  });
  return { device, policy, settings, restriction };
}

export async function markDeviceInCaseTx(tx, { device, usageId, acknowledgementReason = null, patientUid, encounterId = null, context = {} }) {
  const updated = await applyDeviceTransitionTx(tx, device, 'capture', {
    usageId,
    metadata: acknowledgementReason ? { last_exposure_acknowledgement: acknowledgementReason } : {},
  }, context);
  if (acknowledgementReason) {
    await recordReuseSafetyReview(tx, {
      tenantId: device.tenant_id, patientUid, encounterId,
      findingCode: 'EXPOSED_DEVICE_REUSED',
      message: `Exposure-flagged device ${device.device_tag} reused with acknowledgement`,
      reason: acknowledgementReason, actorUid: context.actorUid,
      payload: { device_id: device.id, device_tag: device.device_tag, usage_id: usageId, exposure_markers: device.exposure_markers },
    });
  }
  return updated;
}

// Overrides land on the clinical timeline through the platform safety-review
// vehicle (spec §7.5). Import lives at the top of the file:
//   import { recordMedicationSafetyReviews } from './canonicalClinicalPlatformService.js';
async function recordReuseSafetyReview(tx, { tenantId, patientUid, encounterId, findingCode, message, reason, actorUid, payload }) {
  const rows = await recordMedicationSafetyReviews({
    tenantId,
    patientUid,
    encounterId,
    safety: {
      safe: false,
      blockers: [{ type: 'cath_device_reuse', code: findingCode, severity: 'high', message, ...payload }],
      warnings: [],
    },
    override: { reason, approvedBy: actorUid },
    actorUid,
  }, { db: tx });
  if (!rows.length) {
    throw AppError.internal('Cath device reuse safety review did not persist', 'CATH_DEVICE_SAFETY_REVIEW_FAILED');
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// Post-use: the return tap
// ---------------------------------------------------------------------------

async function lockUsageTx(tx, tenantId, caseId, usageId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT u.id, u.tenant_id, u.case_id, u.patient_uid, u.facility_id, u.catalog_item_id, u.quantity,
            u.wasted, u.device_id, u.reuse_cycle, u.post_use_disposition, u.metadata, u.used_at,
            c.category, c.is_implant, c.item_name
       FROM cath_case_consumable_usage u
       JOIN cath_consumable_catalog c ON c.id = u.catalog_item_id AND c.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1::uuid AND u.case_id = $2::bigint AND u.id = $3::bigint
      FOR UPDATE OF u`,
    tenantOr(tenantId), positiveInt(caseId, 'case_id'), positiveInt(usageId, 'usage_id'),
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Cath consumable usage not found', 'CATH_CONSUMABLE_USAGE_NOT_FOUND');
  return { ...row, id: num(row.id), case_id: num(row.case_id), catalog_item_id: num(row.catalog_item_id), device_id: row.device_id == null ? null : num(row.device_id) };
}

function dispositionCodeFor(disposition, discardReason) {
  if (disposition === 'reprocess') return 'sent_for_reprocessing';
  if (discardReason === 'bloodborne_exposure' || discardReason === 'late_reactive_marker') return 'discarded_bloodborne_exposure';
  if (discardReason === 'max_cycles_reached') return 'discarded_max_cycles';
  if (discardReason === 'wasted') return 'discarded_wasted';
  return 'discarded_other';
}

export async function recordPostUse(caseId, usageId, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const disposition = oneOf(input.disposition, ['reprocess', 'discard'], 'disposition', 'CATH_POST_USE_DISPOSITION_INVALID');
  const acknowledgement = cleanText(input.acknowledgement?.reason ?? input.acknowledgement_reason, 500);
  const requestedDiscardReason = input.discard_reason ? oneOf(input.discard_reason, DISCARD_REASONS, 'discard_reason') : null;
  const discardNote = cleanText(input.discard_note, 2000);
  const idempotencyKey = cleanText(context.idempotencyKey, 200);
  const actor = requireUuid(context.actorUid, 'actorUid');

  return setTenantTx(tid, async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId, { lock: true });
    const usage = await lockUsageTx(tx, tid, cathCase.id, usageId);

    // Replay of the same command returns the recorded result; a different
    // command on a dispositioned row is a conflict.
    if (usage.post_use_disposition) {
      const previous = usage.metadata?.post_use;
      if (previous && idempotencyKey && previous.idempotency_key === idempotencyKey) {
        return { ...previous.result, idempotent_replay: true };
      }
      throw AppError.conflict('Post-use disposition already recorded for this usage', 'CATH_POST_USE_ALREADY_RECORDED', { post_use_disposition: usage.post_use_disposition });
    }

    const settings = await getReprocessingSettings({ tenantId: tid, db: tx });
    const policy = await categoryPolicyTx(tx, tid, usage.category);
    const restriction = await resolveReuseStatus({ tenantId: tid, patientUid: cathCase.patient_uid, validityDays: settings.serology_validity_days, db: tx });
    const device = usage.device_id ? await lockDeviceTx(tx, tid, usage.device_id) : null;
    const options = computePostUseOptions({ usage, category: usage.category, isImplant: Boolean(usage.is_implant), policy, settings, restriction, device });

    if (!options.dispositions.includes(disposition)) {
      if (options.blocked_code && disposition === 'reprocess') {
        throw AppError.conflict('Serology must be recorded before this device can be sent for reprocessing', options.blocked_code, { reasons: restriction.reasons });
      }
      if (options.reason_codes.includes('max_cycles_reached')) {
        throw AppError.conflict(`Device ${device.device_tag} has reached its maximum cycles; only discard is allowed`, 'CATH_DEVICE_MAX_CYCLES_REACHED');
      }
      if (options.reason_codes.includes('bloodborne_restricted')) {
        throw AppError.conflict('Patient is blood-borne restricted; only discard is allowed', 'CATH_DEVICE_EXPOSURE_BLOCKED', { reasons: restriction.reasons });
      }
      throw AppError.conflict(`This usage cannot be ${disposition}ed`, 'CATH_REPROCESSING_NOT_ALLOWED', { reason_codes: options.reason_codes });
    }
    if (disposition === 'reprocess' && options.requires_acknowledgement && !acknowledgement) {
      throw AppError.badRequest('acknowledgement.reason is required for this post-use disposition', 'CATH_DEVICE_ACKNOWLEDGEMENT_REQUIRED', { reason_codes: options.reason_codes, reasons: restriction.reasons });
    }

    const exposureMarkers = options.exposure
      ? restriction.markers.filter((m) => m.result === 'reactive').map((m) => m.marker)
      : null;
    let devices = [];
    let discardReason = null;
    let units = null;

    if (disposition === 'reprocess') {
      if (device) {
        devices = [await applyDeviceTransitionTx(tx, device, 'return', {
          exposureFlag: options.exposure, exposureMarkers,
          metadata: acknowledgement ? { last_post_use_acknowledgement: acknowledgement } : {},
        }, context)];
      } else {
        units = input.units == null ? options.units_max : positiveInt(input.units, 'units');
        if (units > options.units_max) {
          throw AppError.badRequest(`units cannot exceed the recorded quantity (${options.units_max})`, 'CATH_DEVICE_UNITS_EXCEED_QUANTITY');
        }
        for (let index = 1; index <= units; index += 1) {
          const rows = await tx.$queryRawUnsafe(
            `INSERT INTO cath_reprocessable_devices
               (tenant_id, facility_id, catalog_item_id, origin_usage_id, origin_unit_index,
                cycle_count, max_cycles_snapshot, status, exposure_flag, exposure_markers, created_by, metadata)
             VALUES ($1::uuid, $2::int, $3::bigint, $4::bigint, $5::smallint,
                     0, $6::int, 'awaiting_reprocessing', $7, $8::text[], $9::uuid, $10::jsonb)
             RETURNING id`,
            tid, Number(cathCase.facility_id), usage.catalog_item_id, usage.id, index,
            policy.max_cycles, Boolean(options.exposure), exposureMarkers || [], actor,
            JSON.stringify({ created_from: 'post_use', acknowledgement: acknowledgement || null }),
          );
          const created = await lockDeviceTx(tx, tid, rows[0].id);
          await recordDeviceAudit(tx, {
            tenantId: tid, action: 'cath_device.created', resource: 'cath_reprocessable_devices', resourceId: created.id,
            context, metadata: { device_tag: created.device_tag, origin_usage_id: usage.id, unit_index: index, max_cycles: policy.max_cycles, exposure: Boolean(options.exposure) },
          });
          devices.push(created);
        }
      }
    } else {
      discardReason = options.discard_reason || requestedDiscardReason || 'other';
      if (device) {
        devices = [await applyDeviceTransitionTx(tx, device, 'discard', { discardReason, discardNote }, context)];
      }
    }

    const dispositionCode = dispositionCodeFor(disposition, discardReason);
    const result = {
      usage_id: usage.id,
      case_id: cathCase.id,
      disposition: dispositionCode,
      units,
      devices: devices.map(normalizeDevice),
      restriction_status: restriction.status,
    };
    await tx.$queryRawUnsafe(
      `UPDATE cath_case_consumable_usage
          SET post_use_disposition = $3,
              post_use_screen = $4::jsonb,
              metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      tid, usage.id, dispositionCode, JSON.stringify(restriction),
      JSON.stringify({ post_use: { idempotency_key: idempotencyKey, acknowledgement: acknowledgement || null, actor_uid: actor, recorded_at: new Date().toISOString(), result } }),
    );
    if (acknowledgement) {
      await recordReuseSafetyReview(tx, {
        tenantId: tid, patientUid: cathCase.patient_uid, encounterId: cathCase.encounter_id,
        findingCode: options.exposure ? 'BLOODBORNE_RESTRICTED_OVERRIDE' : 'SEROLOGY_UNKNOWN_ACKNOWLEDGED',
        message: options.exposure
          ? `Device from a blood-borne restricted patient sent for reprocessing (${restriction.reasons.join('; ')})`
          : `Device sent for reprocessing with serology unknown (${restriction.reasons.join('; ')})`,
        reason: acknowledgement, actorUid: actor,
        payload: { usage_id: usage.id, case_id: cathCase.id, device_ids: devices.map((d) => d.id) },
      });
    }
    await recordDeviceAudit(tx, {
      tenantId: tid, action: 'cath_usage.post_use', resource: 'cath_case_consumable_usage', resourceId: usage.id,
      context, metadata: { disposition: dispositionCode, units, device_tags: devices.map((d) => d.device_tag), restriction_status: restriction.status },
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Device history (PHI: lists the patients the device touched)
// ---------------------------------------------------------------------------

export async function deviceHistory({ tenantId, deviceId } = {}) {
  const tid = tenantOr(tenantId);
  const id = positiveInt(deviceId, 'device_id');
  return setTenant(tid, async (tx) => {
    const deviceRows = await tx.$queryRawUnsafe(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.tenant_id = $1::uuid AND d.id = $2::bigint LIMIT 1`, tid, id);
    if (!deviceRows[0]) throw AppError.notFound('Reprocessable device not found', 'CATH_DEVICE_NOT_FOUND');
    const uses = await tx.$queryRawUnsafe(
      `SELECT u.id AS usage_id, u.case_id, u.patient_uid, u.used_at, u.reuse_cycle, u.post_use_disposition,
              CASE WHEN u.id = $3::bigint THEN 'first_use' ELSE 'reuse' END AS kind
         FROM cath_case_consumable_usage u
        WHERE u.tenant_id = $1::uuid AND (u.device_id = $2::bigint OR u.id = $3::bigint)
        ORDER BY u.used_at ASC, u.id ASC`,
      tid, id, num(deviceRows[0].origin_usage_id),
    );
    const events = await tx.$queryRawUnsafe(
      `SELECT action, actor_uid, metadata, created_at
         FROM audit_logs
        WHERE tenant_id = $1::uuid AND resource = 'cath_reprocessable_devices' AND resource_id = $2
        ORDER BY created_at ASC, id ASC`,
      tid, String(id),
    );
    return { device: normalizeDevice(deviceRows[0]), uses: uses.map((u) => ({ ...u, usage_id: num(u.usage_id), case_id: num(u.case_id) })), events };
  });
}

// ---------------------------------------------------------------------------
// Late reactive result: quarantine in-flight devices and alert infection control
// Imports at the top of the file:
//   import { persistCdsAlert } from '../emr/cdsEngine.js';
//   import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
// ---------------------------------------------------------------------------

async function flagDeviceExposureTx(tx, device, event, context) {
  await tx.$executeRawUnsafe(
    `UPDATE cath_reprocessable_devices
        SET exposure_flag = TRUE,
            exposure_markers = (SELECT ARRAY(SELECT DISTINCT unnest(exposure_markers || $3::text[]))),
            metadata = metadata || $4::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    device.tenant_id, device.id, [event.marker], JSON.stringify({ late_reactive_marker_row_id: event.markerRowId }),
  );
  await recordDeviceAudit(tx, { tenantId: device.tenant_id, action: 'cath_device.exposure_flagged', resource: 'cath_reprocessable_devices', resourceId: device.id, context, metadata: { marker: event.marker, tested_on: event.testedOn, status: device.status } });
}

export async function quarantineDevicesExposedToPatient(event) {
  const tid = tenantOr(event.tenantId);
  const settings = await getReprocessingSettings({ tenantId: tid });
  const lookbackDays = event.marker === 'cjd_suspected' ? 36500 : settings.serology_validity_days;
  const context = { actorUid: null, actorRole: 'SYSTEM' };
  const affected = await setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT DISTINCT d.id
         FROM cath_reprocessable_devices d
         JOIN cath_case_consumable_usage u
           ON u.tenant_id = d.tenant_id AND (u.id = d.origin_usage_id OR u.device_id = d.id)
        WHERE d.tenant_id = $1::uuid
          AND u.patient_uid = $2::uuid
          AND d.status <> 'discarded'
          AND u.used_at >= ($3::date - ($4::int * INTERVAL '1 day'))`,
      tid, requireUuid(event.patientUid, 'patientUid'), event.testedOn, lookbackDays,
    );
    const out = [];
    for (const { id } of rows) {
      const device = await lockDeviceTx(tx, tid, id);
      if (device.status === 'in_case' || device.status === 'quarantined') {
        await flagDeviceExposureTx(tx, device, event, context);
        out.push(await lockDeviceTx(tx, tid, id));
        continue;
      }
      out.push(await applyDeviceTransitionTx(tx, device, 'quarantine', {
        exposureFlag: true, exposureMarkers: [event.marker],
        quarantineReason: `Late reactive ${event.marker} result dated ${event.testedOn}`,
        metadata: { late_reactive_marker_row_id: event.markerRowId },
      }, context));
    }
    return out;
  });
  if (affected.length === 0) return { affected: [] };

  const tags = affected.map((d) => d.device_tag).join(', ');
  try {
    await persistCdsAlert({
      patientUid: event.patientUid,
      encounterId: null,
      alertType: 'bloodborne_reuse_exposure',
      severity: 'high',
      title: 'Reprocessable devices exposed to a reactive blood-borne marker',
      description: `Devices ${tags} were used on this patient and are now quarantined or flagged after a reactive ${event.marker} result dated ${event.testedOn}.`,
      sourceData: { marker: event.marker, tested_on: event.testedOn, device_ids: affected.map((d) => d.id), marker_row_id: event.markerRowId },
    });
  } catch (err) {
    logger.error(`CDS alert for blood-borne reuse exposure failed: ${err?.message}`, { tenantId: tid });
  }
  try {
    const officers = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT id, uid FROM users
        WHERE tenant_id = $1::uuid AND role = 'INFECTION_CONTROL_OFFICER'
          AND is_active = TRUE AND status = 'active' AND COALESCE(is_deleted, FALSE) = FALSE`,
      tid,
    ));
    for (const officer of officers) {
      await notificationOutbox.queue({
        tenantId: tid,
        type: 'bloodborne_reuse_exposure',
        channel: 'inapp',
        recipientId: officer.id,
        recipientPhone: null,
        title: 'Reprocessable devices quarantined after a reactive result',
        body: `Devices ${tags}: reactive ${event.marker} result dated ${event.testedOn}. Review the CSSD device queue.`,
        sourceEventKey: `bloodborne-reuse-exposure:${event.markerRowId}:${officer.uid}`,
        templateVersion: 'bloodborne-reuse-exposure.v1',
        data: { kind: 'bloodborne_reuse_exposure', marker: event.marker, tested_on: event.testedOn, device_ids: affected.map((d) => d.id), deep_link: '/dashboard/cssd?tab=devices' },
      }, { strict: false });
    }
  } catch (err) {
    logger.error(`Infection-control notification for blood-borne reuse exposure failed: ${err?.message}`, { tenantId: tid });
  }
  return { affected: affected.map(normalizeDevice) };
}

registerExposureHandler(quarantineDevicesExposedToPatient);
```

Add the two imports named in the comments at the top of the file:

```js
import { recordMedicationSafetyReviews } from './canonicalClinicalPlatformService.js';
import { persistCdsAlert } from '../emr/cdsEngine.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
```

- [ ] **Step 2: Wire the reused branch into `recordConsumableUsage`**

In `apps/backend/src/services/clinical/cathLabService.js`:

(a) Add to the import block:

```js
import {
  captureReusedDeviceTx,
  markDeviceInCaseTx
} from './cathDeviceReuseService.js';
import { resolveReuseStatus } from './bloodborneMarkerService.js';
```

(b) After the `if (wasted && !wasteReason) { … }` block at the top of `recordConsumableUsage` (before `const committed = await setTenantTx(`), add:

```js
  const reusedDeviceTag = cleanText(input.reused_device_tag || input.reusedDeviceTag, 24);
  const exposureAcknowledgement = cleanText(
    input.exposure_acknowledgement?.reason || input.exposure_acknowledgement_reason,
    500
  );
  if (reusedDeviceTag) {
    const conflicting = [
      'inventory_batch_id', 'inventoryBatchId', 'batch_number', 'batchNumber',
      'lot_number', 'lotNumber', 'expiry_date', 'expiryDate', 'serial_number', 'serialNumber'
    ].filter(key => input[key] !== undefined && input[key] !== null && input[key] !== '');
    if (conflicting.length) {
      throw AppError.badRequest(
        'reused_device_tag cannot be combined with batch, lot, expiry or serial fields',
        'CATH_CONSUMABLE_REUSE_FIELDS_CONFLICT',
        { fields: conflicting }
      );
    }
    if (quantity !== 1) {
      throw AppError.badRequest('A reused device is one unit', 'CATH_CONSUMABLE_BAD_QUANTITY');
    }
  }
```

(c) Inside the transaction, immediately after the `lockedAuthority` check (`if (lockedAuthority.length !== 1) { … }`), add:

```js
    let reused = null;
    if (reusedDeviceTag) {
      reused = await captureReusedDeviceTx(tx, {
        tenantId,
        cathCase,
        catalog,
        deviceTag: reusedDeviceTag,
        acknowledgementReason: exposureAcknowledgement
      });
    }
```

(d) Change `const inventoryDecrementStatus = 'pending';` to `let inventoryDecrementStatus = 'pending';` and wrap the whole batch-resolution chain (from `if (inventoryBatchValue && catalog.inventory_item_id) {` through the closing of the final `else { throw AppError.badRequest('inventory_batch_id or exact batch/lot/expiry lineage is required …') }` and the following `if (catalog.batch_tracked && (!batchNumber && !lotNumber || !expiryDate)) { … }` guard) in:

```js
    if (reused) {
      inventoryBatchId = null;
      batchNumber = null;
      lotNumber = null;
      expiryDate = null;
      inventoryDecrementStatus = 'reused_device';
      inventoryWarning = null;
    } else {
      // …existing batch-resolution chain and batch_tracked guard, unchanged…
    }
```

(e) Resolve the serology screen for every capture, just before `const metadata = {` :

```js
    const reuseScreen = reused
      ? reused.restriction
      : await resolveReuseStatus({ tenantId, patientUid: cathCase.patient_uid, db: tx });
```

(f) In the `metadata` object, replace `inventory_batch_id: Number(inventoryBatchId),` with `inventory_batch_id: inventoryBatchId == null ? null : Number(inventoryBatchId),` and add after the `inventory_authority` block:

```js
      ...(reused ? {
        reused_device: {
          device_id: reused.device.id,
          device_tag: reused.device.device_tag,
          reuse_cycle: reused.device.cycle_count,
          exposure_flag: reused.device.exposure_flag,
          acknowledgement: exposureAcknowledgement || null
        }
      } : {})
```

(g) Extend the INSERT: add `device_id, reuse_cycle, reuse_screen` to the column list, `$25::bigint, $26::int, $27::jsonb` to the VALUES, and append three parameters after `idempotencyKey`:

```js
      reused ? reused.device.id : null,
      reused ? reused.device.cycle_count : null,
      JSON.stringify(reuseScreen)
```

(h) In the canonical event `payload`, replace `inventory_batch_id: Number(inventoryBatchId),` with `inventory_batch_id: inventoryBatchId == null ? null : Number(inventoryBatchId),` and add `reused_device_tag: reused ? reused.device.device_tag : null, reuse_cycle: reused ? reused.device.cycle_count : null,`.

(i) Replace the unconditional `await materializeCathInventoryShortfallTx(tx, { … })` call with:

```js
    if (reused) {
      await markDeviceInCaseTx(tx, {
        device: reused.device,
        usageId: usage.id,
        acknowledgementReason: exposureAcknowledgement,
        patientUid: cathCase.patient_uid,
        encounterId: cathCase.encounter_id,
        context
      });
    } else {
      await materializeCathInventoryShortfallTx(tx, {
        ...normalizedUsage,
        encounter_id: cathCase.encounter_id,
        facility_id: Number(cathCase.facility_id),
        inventory_item_id: Number(catalog.inventory_item_id)
      }, {
        decrementedUnits: 0,
        finalMovementId: null,
        warning: inventoryWarning
      });
    }
```

(j) In `getCase`, before the `return normalizeDbValue({` add `const reuseRestriction = await resolveReuseStatus({ tenantId: tenantOr(tenantId), patientUid: cathCase.patient_uid, db });` and add `reuse_restriction: reuseRestriction,` to the returned object after `consumable_usage`.

(k) Add the two new columns to `CATH_CONSUMABLE_USAGE_SELECT` (line ≈2705): after `u.audit_event_id, u.idempotency_key,` insert `u.device_id, u.reuse_cycle, u.post_use_disposition,`.

- [ ] **Step 3: Write the deep test**

The fixture (tenant, facility, actor with a cath role, patient, pharmacy inventory item and batch, an active `catheter` catalogue item mapped to it, a cath case in `in_progress` with `facility_id` set) is exactly what `apps/backend/src/tests/cath-consumables.deep.test.js` seeds in its `beforeAll`. Copy that file's seeding and cleanup functions verbatim into the new test (rename the constants to the `…c0de…` UUIDs below so the two suites never collide), then add the tests:

```js
// apps/backend/src/tests/cath-device-reuse.deep.test.js
import prisma, { setTenantTx } from '../lib/prisma.js';
import { recordConsumableUsage, listCaseConsumableUsage, getCase } from '../services/clinical/cathLabService.js';
import {
  decorateConsumablesWithReuse, deviceByTag, discardDevice, listDevices, markDeviceReprocessed,
  quarantineDevice, receiveDevice, recordPostUse, releaseDevice, upsertCategoryPolicies,
  upsertReprocessingSettings, quarantineDevicesExposedToPatient,
} from '../services/clinical/cathDeviceReuseService.js';
import { recordMarkers } from '../services/clinical/bloodborneMarkerService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Constants: TENANT '00000000-0000-4000-8000-00000000c0de', PATIENT '…c0d1', ACTOR '…c0da',
// CSSD_ACTOR '…c0db'; FACILITY_ID, CATALOG_ID (catheter, batch_tracked=false), BATCH fields and
// CASE_ID come from the copied seeding functions.
// ---- copied seeding + cleanup from cath-consumables.deep.test.js goes here ----

const ctx = (actorUid = ACTOR, extra = {}) => ({ actorUid, actorRole: 'DOCTOR', tenantId: TENANT, ...extra });
const captureNew = (idempotencyKey) => recordConsumableUsage(CASE_ID, {
  tenantId: TENANT, catalog_item_id: CATALOG_ID, quantity: 2,
  batch_number: BATCH_NUMBER, expiry_date: BATCH_EXPIRY,
}, ctx(ACTOR, { idempotencyKey }));

d('cath device reuse (deep)', () => {
  beforeAll(async () => {
    await cleanup(); await seed();
    await upsertCategoryPolicies({ tenantId: TENANT, policies: [{ category: 'catheter', reprocessable: true, max_cycles: 2, allowed_cycle_types: ['eto'] }] }, ctx());
    await upsertReprocessingSettings({ tenantId: TENANT }, ctx());
  }, 60000);
  afterAll(cleanup, 60000);

  let firstUse; let deviceTags;

  test('policy: implant categories refuse reprocessable', async () => {
    await expect(upsertCategoryPolicies({ tenantId: TENANT, policies: [{ category: 'stent', reprocessable: true, max_cycles: 1, allowed_cycle_types: ['eto'] }] }, ctx()))
      .rejects.toMatchObject({ code: 'CATH_REPROCESSING_IMPLANT_FORBIDDEN' });
  });

  test('first use is unchanged: pending status, shortfall task, reuse_screen stored', async () => {
    firstUse = await captureNew('cdr-first-1');
    expect(firstUse.inventory_decrement_status).toBe('insufficient_stock');
    expect(firstUse.device_id).toBeNull();
    const rows = await prisma.$queryRawUnsafe(`SELECT reuse_screen->>'status' AS s FROM cath_case_consumable_usage WHERE id = $1::bigint`, firstUse.id);
    expect(['unknown', 'clear', 'restricted']).toContain(rows[0].s);
  }, 30000);

  test('post-use with unknown serology requires acknowledgement, then mints one device per unit', async () => {
    await expect(recordPostUse(CASE_ID, firstUse.id, { tenantId: TENANT, disposition: 'reprocess' }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-1' })))
      .rejects.toMatchObject({ code: 'CATH_DEVICE_ACKNOWLEDGEMENT_REQUIRED' });
    const result = await recordPostUse(CASE_ID, firstUse.id, { tenantId: TENANT, disposition: 'reprocess', acknowledgement: { reason: 'Emergency PCI, serology pending' } }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-1' }));
    expect(result.disposition).toBe('sent_for_reprocessing');
    expect(result.devices).toHaveLength(2);
    deviceTags = result.devices.map((dev) => dev.device_tag);
    expect(deviceTags[0]).toMatch(/^RP\d{8}$/);
    const replay = await recordPostUse(CASE_ID, firstUse.id, { tenantId: TENANT, disposition: 'reprocess', acknowledgement: { reason: 'x' } }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-1' }));
    expect(replay.idempotent_replay).toBe(true);
    await expect(recordPostUse(CASE_ID, firstUse.id, { tenantId: TENANT, disposition: 'discard' }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-2' })))
      .rejects.toMatchObject({ code: 'CATH_POST_USE_ALREADY_RECORDED' });
    const reviews = await prisma.$queryRawUnsafe(`SELECT finding_code FROM medication_safety_reviews WHERE tenant_id = $1::uuid AND review_type = 'cath_device_reuse' ORDER BY id DESC LIMIT 1`, TENANT);
    expect(reviews[0].finding_code).toBe('SEROLOGY_UNKNOWN_ACKNOWLEDGED');
  }, 30000);

  test('CSSD: receive, wrong cycle type refused, reprocessed increments the cycle', async () => {
    const device = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    await receiveDevice(device.id, ctx(CSSD_ACTOR));
    await expect(markDeviceReprocessed(device.id, { cycle_type: 'steam' }, ctx(CSSD_ACTOR))).rejects.toMatchObject({ code: 'CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED' });
    const done = await markDeviceReprocessed(device.id, { cycle_type: 'eto' }, ctx(CSSD_ACTOR));
    expect(done).toMatchObject({ status: 'available', cycle_count: 1, last_cycle_type: 'eto' });
  });

  test('reused capture: no shortfall task, no movement, device in_case; the 753 contract accepts it', async () => {
    const reused = await recordConsumableUsage(CASE_ID, { tenantId: TENANT, catalog_item_id: CATALOG_ID, quantity: 1, reused_device_tag: deviceTags[0] }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-1' }));
    expect(reused.inventory_decrement_status).toBe('reused_device');
    expect(reused.reuse_cycle).toBe(1);
    expect(reused.inventory_warning).toBeNull();
    const tasks = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM tasks WHERE tenant_id = $1::uuid AND task_contract = 'cath_inventory_shortfall_v1' AND related_resource_id = $2`, TENANT, String(reused.id));
    expect(tasks[0].n).toBe(0);
    const device = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    expect(device).toMatchObject({ status: 'in_case', current_usage_id: reused.id });
    await expect(recordConsumableUsage(CASE_ID, { tenantId: TENANT, catalog_item_id: CATALOG_ID, quantity: 1, reused_device_tag: deviceTags[0] }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-2' })))
      .rejects.toMatchObject({ code: 'CATH_DEVICE_NOT_AVAILABLE' });
    await expect(recordConsumableUsage(CASE_ID, { tenantId: TENANT, catalog_item_id: CATALOG_ID, quantity: 1, reused_device_tag: deviceTags[1], batch_number: 'B1' }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-3' })))
      .rejects.toMatchObject({ code: 'CATH_CONSUMABLE_REUSE_FIELDS_CONFLICT' });
  }, 30000);

  test('the 753 contract rejects a reused row that carries a shortfall task', async () => {
    const usageRows = await prisma.$queryRawUnsafe(`SELECT id FROM cath_case_consumable_usage WHERE tenant_id = $1::uuid AND inventory_decrement_status = 'reused_device' ORDER BY id DESC LIMIT 1`, TENANT);
    const usageId = Number(usageRows[0].id);
    await expect(setTenantTx(TENANT, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO tasks (tenant_id, task_contract, related_resource_id, title, status, priority, created_at, updated_at)
         VALUES ($1::uuid, 'cath_inventory_shortfall_v1', $2, 'contract probe', 'open', 'high', NOW(), NOW())`,
        TENANT, String(usageId),
      );
    })).rejects.toMatchObject({ code: expect.stringMatching(/P2010|23514/) });
  }, 30000);

  test('decorateConsumablesWithReuse exposes tags and allowed post-use options', async () => {
    const usage = await listCaseConsumableUsage(CASE_ID, { tenantId: TENANT });
    const decorated = await decorateConsumablesWithReuse(usage, { tenantId: TENANT, caseId: CASE_ID });
    const reusedRow = decorated.usage.find((u) => u.inventory_decrement_status === 'reused_device');
    expect(reusedRow.device_tag).toBe(deviceTags[0]);
    expect(reusedRow.allowed_post_use.dispositions).toEqual(['reprocess', 'discard']);
    expect(decorated.reprocessing.reprocessable_categories).toEqual(['catheter']);
    expect(decorated.reuse_restriction.status).toBe('unknown');
    const c = await getCase(CASE_ID, { tenantId: TENANT });
    expect(c.reuse_restriction.status).toBe('unknown');
  });

  test('a restricted patient forces discard at post-use (rule: discard)', async () => {
    await recordMarkers({ tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR, entries: [{ marker: 'hbsag', result: 'reactive', testedOn: '2026-09-01', source: 'clinical_declaration' }] });
    const usageRows = await prisma.$queryRawUnsafe(`SELECT id FROM cath_case_consumable_usage WHERE tenant_id = $1::uuid AND inventory_decrement_status = 'reused_device' ORDER BY id DESC LIMIT 1`, TENANT);
    const usageId = Number(usageRows[0].id);
    await expect(recordPostUse(CASE_ID, usageId, { tenantId: TENANT, disposition: 'reprocess', acknowledgement: { reason: 'x' } }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-3' })))
      .rejects.toMatchObject({ code: 'CATH_DEVICE_EXPOSURE_BLOCKED' });
    const out = await recordPostUse(CASE_ID, usageId, { tenantId: TENANT, disposition: 'discard' }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-4' }));
    expect(out.disposition).toBe('discarded_bloodborne_exposure');
    expect(out.devices[0]).toMatchObject({ status: 'discarded', discard_reason: 'bloodborne_exposure' });
  }, 30000);

  test('late reactive result quarantines the other device that touched the patient and writes a CDS alert', async () => {
    const before = await deviceByTag({ tenantId: TENANT, tag: deviceTags[1] });
    expect(before.status).toBe('awaiting_reprocessing');
    const result = await quarantineDevicesExposedToPatient({ tenantId: TENANT, patientUid: PATIENT, marker: 'hcv', testedOn: '2026-09-03', markerRowId: 1, source: 'lab_result' });
    expect(result.affected.map((dev) => dev.device_tag)).toContain(deviceTags[1]);
    const after = await deviceByTag({ tenantId: TENANT, tag: deviceTags[1] });
    expect(after).toMatchObject({ status: 'quarantined', exposure_flag: true });
    expect(after.exposure_markers).toContain('hcv');
    const alerts = await prisma.$queryRawUnsafe(`SELECT alert_type FROM cds_alerts WHERE patient_uid = $1::uuid AND alert_type = 'bloodborne_reuse_exposure'`, PATIENT);
    expect(alerts.length).toBeGreaterThan(0);
  }, 30000);

  test('quarantine release goes back to awaiting_reprocessing, never straight to available; discard is terminal', async () => {
    const device = await deviceByTag({ tenantId: TENANT, tag: deviceTags[1] });
    const released = await releaseDevice(device.id, { note: 'reviewed by infection control' }, ctx(CSSD_ACTOR));
    expect(released.status).toBe('awaiting_reprocessing');
    await expect(quarantineDevice(device.id, {}, ctx(CSSD_ACTOR))).rejects.toMatchObject({ code: 'CATH_DEVICE_REASON_REQUIRED' });
    const discarded = await discardDevice(device.id, { reason: 'damaged', note: 'kinked shaft' }, ctx(CSSD_ACTOR));
    expect(discarded.status).toBe('discarded');
    await expect(receiveDevice(device.id, ctx(CSSD_ACTOR))).rejects.toMatchObject({ code: 'CATH_DEVICE_INVALID_TRANSITION' });
    const queue = await listDevices({ tenantId: TENANT, status: 'discarded' });
    expect(queue.map((dev) => dev.device_tag)).toEqual(expect.arrayContaining([deviceTags[1]]));
  });
});
```

The `tasks` INSERT in the contract-rejection test must name that table's NOT NULL columns; open `apps/backend/src/migrations` for the `tasks` definition (`grep -ln "CREATE TABLE.*tasks (" apps/backend/src/migrations/*.sql`) and add any further NOT NULL columns it requires (for example `task_type`, `assigned_to_role`). The assertion only needs the transaction to fail at commit with SQLSTATE 23514 raised by the deferred constraint trigger; Prisma surfaces it as `P2010` with the message text, so the matcher accepts either.

- [ ] **Step 4: Run the deep test**

Run: `DATABASE_URL=postgres://…/vh_cdr_<initials> npm test -- --testPathPatterns cath-device-reuse.deep`
Expected: PASS, 10 tests. Also re-run the existing suites that exercise the same rows to prove nothing regressed:

```bash
DATABASE_URL=… npm test -- --testPathPatterns "cath-consumables.deep|cath-inventory"
```

Expected: PASS with the same counts as on main.

- [ ] **Step 5: Mutation checks**

(1) Comment out the `if (device.exposure_flag) { … }` block in `captureReusedDeviceTx` and confirm no test goes red — then ADD a test: flag `deviceTags[0]`'s device with `exposure_flag = TRUE` by SQL after it is `available` and assert `CATH_DEVICE_EXPOSURE_BLOCKED` on reused capture; restore the block and confirm GREEN. (2) Remove the `reused ? … : materializeCathInventoryShortfallTx` split so the shortfall always materialises, and confirm the reused-capture test goes RED on the task count (and the contract test would too). Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/services/clinical/cathDeviceReuseService.js apps/backend/src/services/clinical/cathLabService.js apps/backend/src/tests/cath-device-reuse.deep.test.js
git commit -m "feat(cath): reused-device capture, post-use flow, late-reactive quarantine, device history

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: Routes and OpenAPI

**Files:**
- Modify: `apps/backend/src/services/clinical/cathDeviceReuseService.js` (one lookup helper)
- Modify: `apps/backend/src/routes/clinical/cathLabRoutes.js` (import block; `GET /cases/:id/consumables` at ≈345; new routes after `POST /cases/:id/consumables`)
- Modify: `apps/backend/src/routes/cssd/cssdRoutes.js` (import block; six routes after `router.patch('/loads/:id/status', …)`)
- Modify: `apps/backend/src/routes/admin/cathConsumablesRoutes.js` (import block; four routes before `export default router;`)
- Create: `apps/backend/scripts/openapi/schemas/cathDeviceReuse.mjs`
- Modify: `apps/backend/scripts/openapi/schemas/cathConsumables.mjs`, `apps/backend/scripts/generate-openapi.mjs`
- Regenerate: `apps/backend/src/docs/openapi.json`

- [ ] **Step 1: Add the case-pinned device lookup to the reuse service**

Append to `cathDeviceReuseService.js`:

```js
// Device state for the capture sheet. Case-pinned like the catalogue reads:
// a device from another facility is reported as not found, never described.
export async function deviceForCaseLookup({ tenantId, caseId, tag } = {}) {
  const tid = tenantOr(tenantId);
  return setTenant(tid, async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId);
    const device = await deviceByTag({ tenantId: tid, tag, db: tx });
    if (!device || device.facility_id !== Number(cathCase.facility_id)) {
      throw AppError.notFound('Reprocessable device not found', 'CATH_DEVICE_NOT_FOUND');
    }
    const policy = await categoryPolicyTx(tx, tid, device.category);
    const settings = await getReprocessingSettings({ tenantId: tid, db: tx });
    return {
      device,
      reprocessable: Boolean(policy?.reprocessable),
      cycles_remaining: Math.max(0, device.max_cycles_snapshot - device.cycle_count),
      exposure_rule: settings.reactive_patient_rule,
      requires_acknowledgement: device.exposure_flag && settings.reactive_patient_rule === 'override_allowed',
      blocked: device.exposure_flag && settings.reactive_patient_rule === 'discard',
    };
  });
}
```

- [ ] **Step 2: Cath routes**

In `apps/backend/src/routes/clinical/cathLabRoutes.js` add to the imports:

```js
import {
  decorateConsumablesWithReuse,
  deviceForCaseLookup,
  deviceHistory,
  recordPostUse
} from '../../services/clinical/cathDeviceReuseService.js';
```

Replace the body of the `GET /cases/:id/consumables` handler's `try` block with:

```js
      const usage = await listCaseConsumableUsage(req.params.id, { tenantId: tenantOf(req) });
      const decorated = await decorateConsumablesWithReuse(usage, {
        tenantId: tenantOf(req),
        caseId: req.params.id
      });
      return success(res, {
        usage: decorated.usage,
        count: decorated.usage.length,
        reuse_restriction: decorated.reuse_restriction,
        reprocessing: decorated.reprocessing
      }, 'Cath consumable usage');
```

Immediately after the `POST /cases/:id/consumables` route add:

```js
router.post(
  '/cases/:id/consumables/:usageId/post-use',
  requireCathWorkflow,
  guardCathCaseById,
  requireIdempotencyKey({ required: true, scope: 'cath_consumable_post_use' }),
  async (req, res) => {
    try {
      const result = await recordPostUse(
        req.params.id,
        req.params.usageId,
        { ...req.body, tenantId: tenantOf(req) },
        contextOf(req)
      );
      return success(res, result, 'Cath consumable post-use recorded', HTTP_STATUS.CREATED);
    } catch (err) {
      return handleFailure(res, err, 'record consumable post-use');
    }
  }
);

// Device state for the capture sheet. No patient data; case-pinned so the
// facility identity is enforced exactly like the catalogue reads.
router.get('/devices/lookup', requireReportRead, guardCathCatalogCase, async (req, res) => {
  try {
    const result = await deviceForCaseLookup({
      tenantId: tenantOf(req),
      caseId: req.query.case_id,
      tag: req.query.tag
    });
    return success(res, result, 'Reprocessable device');
  } catch (err) {
    return handleFailure(res, err, 'lookup device');
  }
});

// Which patients a device touched (infection-control lookback). PHI: the mount
// logger covers it; the role gate is the cath workflow gate.
router.get('/devices/:deviceId/history', requireReportRead, async (req, res) => {
  try {
    const history = await deviceHistory({ tenantId: tenantOf(req), deviceId: req.params.deviceId });
    return success(res, history, 'Reprocessable device history');
  } catch (err) {
    return handleFailure(res, err, 'device history');
  }
});
```

`contextOf(req)` already carries `idempotencyKey` from `req.idempotencyClaim` (that is how `recordConsumableUsage` receives it); confirm by reading `contextOf` at the top of the file and, if it does not, add `idempotencyKey: req.idempotencyClaim?.requestKey || null` to it.

- [ ] **Step 3: CSSD routes**

In `apps/backend/src/routes/cssd/cssdRoutes.js` add to the imports:

```js
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import {
  discardDevice,
  listDevices,
  markDeviceReprocessed,
  quarantineDevice,
  receiveDevice,
  releaseDevice,
} from '../../services/clinical/cathDeviceReuseService.js';
```

After the `router.patch('/loads/:id/status', …)` route add:

```js
// Reprocessable cath devices (spec 2026-09-04 §6.4). No patient data on this
// router: the register carries none, and CSSD roles never see usage rows.
const deviceIdempotency = requireIdempotencyKey({ required: true, scope: 'cssd_device_transition' });
const deviceContext = (req) => ({
  ...contextOf(req),
  idempotencyKey: req.idempotencyClaim?.requestKey || null,
});

router.get('/devices', wrap((req) =>
  listDevices({
    tenantId: contextOf(req).tenantId,
    status: req.query.status,
    facilityId: req.query.facility_id,
    limit: req.query.limit,
  })));

router.post('/devices/:id/receive', deviceIdempotency, wrap((req) =>
  receiveDevice(req.params.id, deviceContext(req)), { message: 'Device received in CSSD' }));

router.post('/devices/:id/reprocessed', deviceIdempotency, wrap((req) =>
  markDeviceReprocessed(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device reprocessed' }));

router.post('/devices/:id/quarantine', deviceIdempotency, wrap((req) =>
  quarantineDevice(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device quarantined' }));

router.post('/devices/:id/release', deviceIdempotency, wrap((req) =>
  releaseDevice(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device released for reprocessing' }));

router.post('/devices/:id/discard', deviceIdempotency, wrap((req) =>
  discardDevice(req.params.id, req.body || {}, deviceContext(req)), { message: 'Device discarded' }));
```

- [ ] **Step 4: Admin routes**

In `apps/backend/src/routes/admin/cathConsumablesRoutes.js` add to the imports:

```js
import { requireRole } from '../../middleware/rbacMiddleware.js';
import {
  getReprocessingSettings,
  listCategoryPolicies,
  upsertCategoryPolicies,
  upsertReprocessingSettings
} from '../../services/clinical/cathDeviceReuseService.js';
```

Before `export default router;` add:

```js
// Reprocessing policy is clinical governance, not billing: route-level gate on
// top of the admin barrel gate (the pattern admin/index.js uses for its
// dark-gate console).
const requireReprocessingPolicyRole = requireRole('QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER', 'SUPER_ADMIN');

router.get('/reprocessing-settings', requireReprocessingPolicyRole, async (req, res, next) => {
  try {
    const settings = await getReprocessingSettings({ tenantId: req.tenantId });
    return success(res, { settings }, 'Cath reprocessing settings retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/reprocessing-settings', requireReprocessingPolicyRole, async (req, res, next) => {
  try {
    const settings = await upsertReprocessingSettings(
      { ...(req.body || {}), tenantId: req.tenantId },
      actorContext(req)
    );
    return success(res, { settings }, 'Cath reprocessing settings saved');
  } catch (err) {
    return next(err);
  }
});

router.get('/reprocessing-policies', requireReprocessingPolicyRole, async (req, res, next) => {
  try {
    const policies = await listCategoryPolicies({ tenantId: req.tenantId });
    return success(res, { policies, count: policies.length }, 'Cath reprocessing policies retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/reprocessing-policies', requireReprocessingPolicyRole, async (req, res, next) => {
  try {
    const policies = await upsertCategoryPolicies(
      { tenantId: req.tenantId, policies: req.body?.policies },
      actorContext(req)
    );
    return success(res, { policies, count: policies.length }, 'Cath reprocessing policies saved');
  } catch (err) {
    return next(err);
  }
});
```

- [ ] **Step 5: OpenAPI overlay for the new endpoints**

```js
// apps/backend/scripts/openapi/schemas/cathDeviceReuse.mjs
import { envelope } from './_helpers.mjs';

const CATEGORIES = ['stent', 'balloon', 'guidewire', 'catheter', 'sheath', 'closure_device', 'pacemaker', 'lead', 'other'];
const DEVICE_STATUSES = ['awaiting_reprocessing', 'in_cssd', 'available', 'in_case', 'quarantined', 'discarded'];
const CYCLE_TYPES = ['steam', 'eto', 'plasma', 'dry_heat', 'chemical', 'other'];
const FUNCTION_CHECKS = ['not_required', 'pass', 'fail'];
const DISCARD_REASONS = ['max_cycles_reached', 'bloodborne_exposure', 'late_reactive_marker', 'function_check_failed', 'sterilization_failed', 'damaged', 'wasted', 'policy_change', 'other'];
const POST_USE_DISPOSITIONS = ['sent_for_reprocessing', 'discarded_bloodborne_exposure', 'discarded_max_cycles', 'discarded_wasted', 'discarded_other', 'not_reprocessable'];
const REUSE_STATUSES = ['restricted', 'unknown', 'clear'];

const nullableString = { type: 'string', nullable: true };
const nullableInteger = { type: 'integer', nullable: true };
const nullableUuid = { type: 'string', format: 'uuid', nullable: true };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };
const BIGINT_WIRE = {
  oneOf: [
    { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    { type: 'string', pattern: '^[1-9][0-9]*$' }
  ]
};
const idempotencyHeaderParameter = {
  name: 'Idempotency-Key', in: 'header', required: true,
  schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_\\-:.]+$' }
};
const queryParameter = (name, schema) => ({ name, in: 'query', required: false, schema });

const device = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'tenant_id', 'facility_id', 'catalog_item_id', 'device_tag', 'origin_usage_id', 'origin_unit_index', 'cycle_count', 'max_cycles_snapshot', 'status', 'exposure_flag', 'exposure_markers', 'created_by', 'created_at', 'updated_at', 'item_name', 'category'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    tenant_id: { type: 'string', format: 'uuid' },
    facility_id: { type: 'integer', minimum: 1 },
    catalog_item_id: { type: 'integer', minimum: 1 },
    device_tag: { type: 'string', pattern: '^RP[0-9]{8}$' },
    origin_usage_id: { type: 'integer', minimum: 1 },
    origin_unit_index: { type: 'integer', minimum: 1 },
    cycle_count: { type: 'integer', minimum: 0 },
    max_cycles_snapshot: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: DEVICE_STATUSES },
    current_usage_id: nullableInteger,
    exposure_flag: { type: 'boolean' },
    exposure_markers: { type: 'array', items: { type: 'string' } },
    last_reprocessed_at: nullableDateTime,
    last_reprocessed_by: nullableUuid,
    last_cycle_type: { type: 'string', enum: CYCLE_TYPES, nullable: true },
    last_function_check: { type: 'string', enum: FUNCTION_CHECKS, nullable: true },
    quarantine_reason: nullableString,
    quarantined_at: nullableDateTime,
    discard_reason: { type: 'string', enum: DISCARD_REASONS, nullable: true },
    discard_note: nullableString,
    discarded_at: nullableDateTime,
    discarded_by: nullableUuid,
    created_by: { type: 'string', format: 'uuid' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    metadata: { type: 'object', additionalProperties: true },
    item_name: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    manufacturer: nullableString,
    model: nullableString
  }
};

const settings = {
  type: 'object',
  additionalProperties: false,
  required: ['tenant_id', 'reactive_patient_rule', 'unknown_serology_rule', 'serology_validity_days', 'configured'],
  properties: {
    tenant_id: { type: 'string', format: 'uuid' },
    reactive_patient_rule: { type: 'string', enum: ['discard', 'override_allowed'] },
    unknown_serology_rule: { type: 'string', enum: ['warn', 'block_return'] },
    serology_validity_days: { type: 'integer', minimum: 1, maximum: 365 },
    reviewed_by: nullableUuid,
    reviewed_at: nullableDateTime,
    updated_by: nullableUuid,
    created_at: nullableDateTime,
    updated_at: nullableDateTime,
    configured: { type: 'boolean' }
  }
};

const policy = {
  type: 'object',
  additionalProperties: false,
  required: ['tenant_id', 'category', 'reprocessable', 'allowed_cycle_types', 'function_check_required'],
  properties: {
    tenant_id: { type: 'string', format: 'uuid' },
    category: { type: 'string', enum: CATEGORIES },
    reprocessable: { type: 'boolean' },
    max_cycles: { type: 'integer', minimum: 1, maximum: 50, nullable: true },
    allowed_cycle_types: { type: 'array', items: { type: 'string', enum: CYCLE_TYPES } },
    function_check_required: { type: 'boolean' },
    updated_by: nullableUuid,
    created_at: nullableDateTime,
    updated_at: nullableDateTime
  }
};

const postUseOptions = {
  type: 'object',
  additionalProperties: false,
  required: ['dispositions', 'requires_acknowledgement', 'exposure', 'reason_codes', 'units_max'],
  properties: {
    dispositions: { type: 'array', items: { type: 'string', enum: ['reprocess', 'discard'] } },
    requires_acknowledgement: { type: 'boolean' },
    exposure: { type: 'boolean' },
    discard_reason: { type: 'string', enum: DISCARD_REASONS, nullable: true },
    blocked_code: nullableString,
    reason_codes: { type: 'array', items: { type: 'string' } },
    units_max: { type: 'integer', minimum: 0 }
  }
};

export const schemas = {
  CathReprocessableDevice: device,
  CathReprocessingSettings: settings,
  CathReprocessingCategoryPolicy: policy,
  CathPostUseOptions: postUseOptions,
  CathPostUseRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['disposition'],
    properties: {
      disposition: { type: 'string', enum: ['reprocess', 'discard'] },
      units: { type: 'integer', minimum: 1 },
      discard_reason: { type: 'string', enum: DISCARD_REASONS },
      discard_note: { type: 'string', maxLength: 2000 },
      acknowledgement: {
        type: 'object', additionalProperties: false, required: ['reason'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } }
      }
    }
  },
  CathPostUseResultData: {
    type: 'object',
    additionalProperties: false,
    required: ['usage_id', 'case_id', 'disposition', 'devices', 'restriction_status'],
    properties: {
      usage_id: { type: 'integer', minimum: 1 },
      case_id: { type: 'integer', minimum: 1 },
      disposition: { type: 'string', enum: POST_USE_DISPOSITIONS },
      units: nullableInteger,
      devices: { type: 'array', items: { $ref: '#/components/schemas/CathReprocessableDevice' } },
      restriction_status: { type: 'string', enum: REUSE_STATUSES },
      idempotent_replay: { type: 'boolean' }
    }
  },
  CathPostUseResponse: envelope('CathPostUseResultData'),
  CathDeviceLookupData: {
    type: 'object',
    additionalProperties: false,
    required: ['device', 'reprocessable', 'cycles_remaining', 'exposure_rule', 'requires_acknowledgement', 'blocked'],
    properties: {
      device: { $ref: '#/components/schemas/CathReprocessableDevice' },
      reprocessable: { type: 'boolean' },
      cycles_remaining: { type: 'integer', minimum: 0 },
      exposure_rule: { type: 'string', enum: ['discard', 'override_allowed'] },
      requires_acknowledgement: { type: 'boolean' },
      blocked: { type: 'boolean' }
    }
  },
  CathDeviceLookupResponse: envelope('CathDeviceLookupData'),
  CathDeviceHistoryData: {
    type: 'object',
    additionalProperties: false,
    required: ['device', 'uses', 'events'],
    properties: {
      device: { $ref: '#/components/schemas/CathReprocessableDevice' },
      uses: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['usage_id', 'case_id', 'patient_uid', 'used_at', 'kind'],
          properties: {
            usage_id: { type: 'integer' }, case_id: { type: 'integer' },
            patient_uid: { type: 'string', format: 'uuid' }, used_at: { type: 'string', format: 'date-time' },
            reuse_cycle: nullableInteger, post_use_disposition: { type: 'string', enum: POST_USE_DISPOSITIONS, nullable: true },
            kind: { type: 'string', enum: ['first_use', 'reuse'] }
          }
        }
      },
      events: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['action', 'created_at'],
          properties: {
            action: { type: 'string' }, actor_uid: nullableUuid,
            metadata: { type: 'object', additionalProperties: true }, created_at: { type: 'string', format: 'date-time' }
          }
        }
      }
    }
  },
  CathDeviceHistoryResponse: envelope('CathDeviceHistoryData'),
  CssdDeviceListResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { type: 'array', items: { $ref: '#/components/schemas/CathReprocessableDevice' } },
      requestId: { type: 'string', nullable: true }
    }
  },
  CssdDeviceResponse: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { $ref: '#/components/schemas/CathReprocessableDevice' },
      requestId: { type: 'string', nullable: true }
    }
  },
  CssdDeviceReprocessedRequest: {
    type: 'object', additionalProperties: false, required: ['cycle_type'],
    properties: {
      cycle_type: { type: 'string', enum: CYCLE_TYPES },
      function_check_result: { type: 'string', enum: FUNCTION_CHECKS },
      note: { type: 'string', maxLength: 2000 }
    }
  },
  CssdDeviceReasonRequest: {
    type: 'object', additionalProperties: false, required: ['reason'],
    properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } }
  },
  CssdDeviceNoteRequest: {
    type: 'object', additionalProperties: false,
    properties: { note: { type: 'string', maxLength: 500 } }
  },
  CssdDeviceDiscardRequest: {
    type: 'object', additionalProperties: false, required: ['reason'],
    properties: { reason: { type: 'string', enum: DISCARD_REASONS }, note: { type: 'string', maxLength: 2000 } }
  },
  CathReprocessingSettingsData: {
    type: 'object', additionalProperties: false, required: ['settings'],
    properties: { settings: { $ref: '#/components/schemas/CathReprocessingSettings' } }
  },
  CathReprocessingSettingsResponse: envelope('CathReprocessingSettingsData'),
  CathReprocessingSettingsUpdateRequest: {
    type: 'object', additionalProperties: false,
    properties: {
      reactive_patient_rule: { type: 'string', enum: ['discard', 'override_allowed'] },
      unknown_serology_rule: { type: 'string', enum: ['warn', 'block_return'] },
      serology_validity_days: { type: 'integer', minimum: 1, maximum: 365 }
    }
  },
  CathReprocessingPoliciesData: {
    type: 'object', additionalProperties: false, required: ['policies', 'count'],
    properties: {
      policies: { type: 'array', items: { $ref: '#/components/schemas/CathReprocessingCategoryPolicy' } },
      count: { type: 'integer', minimum: 0 }
    }
  },
  CathReprocessingPoliciesResponse: envelope('CathReprocessingPoliciesData'),
  CathReprocessingPoliciesUpdateRequest: {
    type: 'object', additionalProperties: false, required: ['policies'],
    properties: {
      policies: {
        type: 'array', minItems: 1,
        items: {
          type: 'object', additionalProperties: false, required: ['category', 'reprocessable'],
          properties: {
            category: { type: 'string', enum: CATEGORIES },
            reprocessable: { type: 'boolean' },
            max_cycles: { type: 'integer', minimum: 1, maximum: 50, nullable: true },
            allowed_cycle_types: { type: 'array', items: { type: 'string', enum: CYCLE_TYPES } },
            function_check_required: { type: 'boolean' }
          }
        }
      }
    }
  }
};

export const operations = {
  'POST /api/v1/cath-lab/cases/{id}/consumables/{usageId}/post-use': {
    description: 'Records what happened to a consumable after the case: reprocess (mints register rows for a first-use row, returns a reused device to CSSD) or discard. Allowed dispositions come from the consumables listing (allowed_post_use). Requires Idempotency-Key (scope cath_consumable_post_use).',
    pathParameters: { id: BIGINT_WIRE, usageId: BIGINT_WIRE },
    parameters: [idempotencyHeaderParameter],
    request: 'CathPostUseRequest',
    response: 'CathPostUseResponse'
  },
  'GET /api/v1/cath-lab/devices/lookup': {
    description: 'Device state for the capture sheet, pinned to the case facility. No patient data.',
    parameters: [
      { name: 'case_id', in: 'query', required: true, schema: BIGINT_WIRE },
      { name: 'tag', in: 'query', required: true, schema: { type: 'string', pattern: '^[Rr][Pp][0-9]{8}$' } }
    ],
    response: 'CathDeviceLookupResponse'
  },
  'GET /api/v1/cath-lab/devices/{deviceId}/history': {
    description: 'Every use of a device (patients included) and its register events, for infection-control lookback.',
    pathParameters: { deviceId: BIGINT_WIRE },
    response: 'CathDeviceHistoryResponse'
  },
  'GET /api/v1/cssd/devices': {
    parameters: [
      queryParameter('status', { type: 'string', enum: DEVICE_STATUSES }),
      queryParameter('facility_id', { type: 'integer', minimum: 1 }),
      queryParameter('limit', { type: 'integer', minimum: 1, maximum: 500 })
    ],
    response: 'CssdDeviceListResponse'
  },
  'POST /api/v1/cssd/devices/{id}/receive': { pathParameters: { id: BIGINT_WIRE }, parameters: [idempotencyHeaderParameter], response: 'CssdDeviceResponse' },
  'POST /api/v1/cssd/devices/{id}/reprocessed': { pathParameters: { id: BIGINT_WIRE }, parameters: [idempotencyHeaderParameter], request: 'CssdDeviceReprocessedRequest', response: 'CssdDeviceResponse' },
  'POST /api/v1/cssd/devices/{id}/quarantine': { pathParameters: { id: BIGINT_WIRE }, parameters: [idempotencyHeaderParameter], request: 'CssdDeviceReasonRequest', response: 'CssdDeviceResponse' },
  'POST /api/v1/cssd/devices/{id}/release': { pathParameters: { id: BIGINT_WIRE }, parameters: [idempotencyHeaderParameter], request: 'CssdDeviceNoteRequest', response: 'CssdDeviceResponse' },
  'POST /api/v1/cssd/devices/{id}/discard': { pathParameters: { id: BIGINT_WIRE }, parameters: [idempotencyHeaderParameter], request: 'CssdDeviceDiscardRequest', response: 'CssdDeviceResponse' },
  'GET /api/v1/admin/cath-consumables/reprocessing-settings': { response: 'CathReprocessingSettingsResponse' },
  'PUT /api/v1/admin/cath-consumables/reprocessing-settings': { request: 'CathReprocessingSettingsUpdateRequest', response: 'CathReprocessingSettingsResponse' },
  'GET /api/v1/admin/cath-consumables/reprocessing-policies': { response: 'CathReprocessingPoliciesResponse' },
  'PUT /api/v1/admin/cath-consumables/reprocessing-policies': { request: 'CathReprocessingPoliciesUpdateRequest', response: 'CathReprocessingPoliciesResponse' }
};
```

- [ ] **Step 6: Extend `cathConsumables.mjs`**

In `apps/backend/scripts/openapi/schemas/cathConsumables.mjs`:

1. Replace the `INVENTORY_DECREMENT_STATUSES` array with the seven live values: `['pending', 'not_linked', 'decremented', 'insufficient_stock', 'error', 'not_applicable', 'reused_device']`.
2. Append `'reused_billing_code_not_mapped'` to `BILLING_GAP_REASONS`.
3. Find the usage item schema (`grep -n "inventory_decrement_status" cathConsumables.mjs` lands inside it) and add these properties beside `inventory_decrement_status`:

```js
    device_id: NULLABLE_BIGINT_WIRE,
    reuse_cycle: nullableInteger,
    post_use_disposition: { type: 'string', enum: ['sent_for_reprocessing', 'discarded_bloodborne_exposure', 'discarded_max_cycles', 'discarded_wasted', 'discarded_other', 'not_reprocessable'], nullable: true },
    device_tag: nullableString,
    device_status: nullableString,
    device_exposure_flag: { type: 'boolean' },
    allowed_post_use: { $ref: '#/components/schemas/CathPostUseOptions' },
```

4. Find the create-request schema (`CathCaseConsumableUsageCreateRequest`) and add:

```js
    reused_device_tag: { type: 'string', pattern: '^[Rr][Pp][0-9]{8}$' },
    exposure_acknowledgement: {
      type: 'object', additionalProperties: false, required: ['reason'],
      properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } }
    },
```

5. Find the list response for `GET /api/v1/cath-lab/cases/{id}/consumables` (`CathCaseConsumableUsageListResponse`, built with `countData('usage', …)`). Replace its `data` with an explicit object that adds the two new keys:

```js
  CathCaseConsumableUsageListResponse: envelope('CathCaseConsumableUsageListData'),
  CathCaseConsumableUsageListData: {
    type: 'object',
    additionalProperties: false,
    required: ['usage', 'count', 'reuse_restriction', 'reprocessing'],
    properties: {
      usage: { type: 'array', items: { $ref: '#/components/schemas/CathCaseConsumableUsage' } },
      count: { type: 'integer', minimum: 0 },
      reuse_restriction: { $ref: '#/components/schemas/BloodborneReuseStatus' },
      reprocessing: {
        type: 'object', additionalProperties: false, required: ['settings', 'reprocessable_categories'],
        properties: {
          settings: { $ref: '#/components/schemas/CathReprocessingSettings' },
          reprocessable_categories: { type: 'array', items: { type: 'string', enum: CATEGORIES } }
        }
      }
    }
  },
```

(If the existing item schema is named differently from `CathCaseConsumableUsage`, use the existing name; the `$ref` must match a schema key exactly.)

6. Add `reused_billing_item_code: nullableString` to the catalogue item schema and to the catalogue upsert request schema (`grep -n "billing_item_code" cathConsumables.mjs` shows both places).

- [ ] **Step 7: Register, regenerate, check**

In `generate-openapi.mjs` add `import * as cathDeviceReuse from './openapi/schemas/cathDeviceReuse.mjs';` and `cathDeviceReuse,` after `cathConsumables,`. Then:

```bash
npm run openapi:generate && npm run openapi:check
npm test -- --testPathPatterns "unit/openapi|unit/cathInventoryReconciliationOpenApiSource"
```

Expected: exit 0 and PASS. A `$ref` to a missing schema fails generation with the schema name; fix the name, not the reference.

- [ ] **Step 8: Boot check and commit**

```bash
DATABASE_URL=… node -e "import('./src/app.js').then(() => { console.log('app loaded'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"
git add apps/backend/src/services/clinical/cathDeviceReuseService.js apps/backend/src/routes apps/backend/scripts/openapi apps/backend/scripts/generate-openapi.mjs apps/backend/src/docs/openapi.json
git commit -m "feat(api): cath device reuse routes (cath, CSSD queue, admin policy) with OpenAPI contracts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: Billing and catalogue code

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabService.js` (`CATH_CONSUMABLE_CATALOG_SELECT` ≈1526, `upsertConsumableCatalogItem` ≈1653–1875, `maybeEmitCathBillingLines` ≈4653–4825, `listUnbilledConsumableUsage` ≈4827–4917)
- Test: append to `apps/backend/src/tests/cath-device-reuse.deep.test.js`

- [ ] **Step 1: Catalogue accepts and returns the reused code**

In `CATH_CONSUMABLE_CATALOG_SELECT` add `c.reused_billing_item_code,` after `c.billing_item_code,`. In `upsertConsumableCatalogItem`, next to where `billingCode` is derived (search `billing_item_code` inside the function), add:

```js
    const reusedBillingCode = cleanText(
      input.reused_billing_item_code ?? input.reusedBillingItemCode ?? existing?.reused_billing_item_code,
      50
    );
```

Add `reused_billing_item_code = $16` to the UPDATE (with `reusedBillingCode` as the 16th parameter after `JSON.stringify(metadata)`) and `reused_billing_item_code` to the INSERT column list as `$15` (with `reusedBillingCode` as the 15th parameter). Keep the existing parameter order; only append.

- [ ] **Step 2: Emission picks the reprocessed code**

In `maybeEmitCathBillingLines`, replace the `usageRows` query with:

```js
    const usageRows = await prisma.$queryRawUnsafe(
      `SELECT u.id, u.quantity, u.wasted, u.is_implant, u.reuse_cycle,
              c.item_name, c.billing_item_code, c.reused_billing_item_code,
              bsm.id AS billing_service_id,
              bsm_reused.id AS reused_billing_service_id
         FROM cath_case_consumable_usage u
         JOIN cath_consumable_catalog c
           ON c.id = u.catalog_item_id
          AND c.tenant_id = u.tenant_id
         LEFT JOIN billing_service_master bsm
           ON bsm.tenant_id = u.tenant_id
          AND bsm.code = c.billing_item_code
          AND bsm.is_active = TRUE
         LEFT JOIN billing_service_master bsm_reused
           ON bsm_reused.tenant_id = u.tenant_id
          AND bsm_reused.code = c.reused_billing_item_code
          AND bsm_reused.is_active = TRUE
        WHERE u.tenant_id = $1::uuid
          AND u.case_id = $2::bigint
        ORDER BY u.id`,
      tid,
      normalizeId(context.id, 'case_id')
    );
```

and replace the loop body's gap check and `addInvoiceItem` call with:

```js
      const reused = Number(usage.reuse_cycle || 0) >= 1;
      const serviceCode = reused ? usage.reused_billing_item_code : usage.billing_item_code;
      const serviceId = reused ? usage.reused_billing_service_id : usage.billing_service_id;
      if (usage.wasted || !serviceCode || !serviceId) {
        unmapped.push({
          type: 'consumable',
          source_id: sourceId,
          reason: usage.wasted
            ? 'wastage_review_required'
            : (serviceCode
              ? 'billing_code_invalid'
              : (reused ? 'reused_billing_code_not_mapped' : 'billing_code_not_mapped'))
        });
        continue;
      }
      try {
        const line = await addInvoiceItem(invoice.id, {
          tenantId: tid,
          service_code: serviceCode,
          description: reused ? `${usage.item_name} (reprocessed, cycle ${usage.reuse_cycle})` : usage.item_name,
          category: usage.is_implant ? 'implants' : 'procedure',
          quantity: Number(usage.quantity),
          // Inventory cost references are not patient tariffs. The active,
          // tenant-scoped billing master remains authoritative for price.
          unit_price: null,
          gst_rate: null,
          notes: reused
            ? 'Reprocessed cath device emitted from documented per-case reuse.'
            : 'Cath consumable emitted from documented per-case usage.',
          source_ref_type: 'cath_consumable_usage',
          source_ref_id: sourceId
        });
        emitted.push({ type: 'consumable', source_id: sourceId, line_id: line.id });
      } catch (err) {
```

(keep the existing `catch` block unchanged).

- [ ] **Step 3: Unbilled listing names the new gap**

In `listUnbilledConsumableUsage`, add a second join after the `bsm` join:

```sql
       LEFT JOIN billing_service_master bsm_reused
         ON bsm_reused.tenant_id = u.tenant_id
        AND bsm_reused.code = c.reused_billing_item_code
        AND bsm_reused.is_active = TRUE
```

and change the `billing_gap_reason` CASE to:

```sql
            CASE
              WHEN cath_case.status <> 'completed' THEN 'procedure_not_completed'
              WHEN u.wasted THEN 'wastage_review_required'
              WHEN COALESCE(u.reuse_cycle, 0) >= 1 AND c.reused_billing_item_code IS NULL THEN 'reused_billing_code_not_mapped'
              WHEN COALESCE(u.reuse_cycle, 0) >= 1 AND bsm_reused.id IS NULL THEN 'billing_code_invalid'
              WHEN COALESCE(u.reuse_cycle, 0) = 0 AND c.billing_item_code IS NULL THEN 'billing_code_not_mapped'
              WHEN COALESCE(u.reuse_cycle, 0) = 0 AND bsm.id IS NULL THEN 'billing_code_invalid'
              WHEN COALESCE(settings.charge_enabled, FALSE) = FALSE THEN 'billing_disabled'
              ELSE 'billing_pending_or_failed'
            END AS billing_gap_reason
```

Also add `u.reuse_cycle, c.reused_billing_item_code,` to that SELECT list.

- [ ] **Step 4: Deep test for billing**

Append to `cath-device-reuse.deep.test.js` (inside the describe, after the CSSD tests; it needs a fresh available device, so reprocess `deviceTags[1]` before its quarantine test or seed a third first-use row — simplest: capture a new first-use row, post-use it with acknowledgement, receive + reprocess its device, then reuse it):

```js
  test('billing: a reused row bills the reprocessed code; an unmapped reused code is reported', async () => {
    const { upsertCathConsumablesBillingSettings, upsertConsumableCatalogItem, maybeEmitCathBillingLines, listUnbilledConsumableUsage, transitionCaseStatus } = await import('../services/clinical/cathLabService.js');
    for (const code of ['CATH-TEST-NEW', 'CATH-TEST-REUSED']) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO billing_service_master (tenant_id, code, name, category, unit_price, gst_rate, is_active, created_at, updated_at)
         VALUES ($1::uuid, $2, $2, 'procedure', 1000, 0, TRUE, NOW(), NOW()) ON CONFLICT DO NOTHING`,
        TENANT, code,
      );
    }
    await upsertConsumableCatalogItem({ tenantId: TENANT, id: CATALOG_ID, billing_item_code: 'CATH-TEST-NEW', reused_billing_item_code: 'CATH-TEST-REUSED' }, ctx());
    await upsertCathConsumablesBillingSettings({ tenantId: TENANT, charge_enabled: true, finance_reviewed_at: new Date().toISOString() }, ctx());

    const fresh = await captureNew('cdr-bill-1');
    const pu = await recordPostUse(CASE_ID, fresh.id, { tenantId: TENANT, disposition: 'discard', discard_reason: 'other' }, ctx(ACTOR, { idempotencyKey: 'cdr-bill-pu' }));
    expect(pu.disposition).toBe('discarded_other');

    await transitionCaseStatus(CASE_ID, { tenantId: TENANT, status: 'completed' }, ctx());
    const hook = await maybeEmitCathBillingLines({ tenantId: TENANT, caseId: CASE_ID, actorUid: ACTOR });
    expect(['emitted', 'partial']).toContain(hook.status);
    const lines = await prisma.$queryRawUnsafe(
      `SELECT service_code, source_ref_id FROM billing_invoice_items WHERE tenant_id = $1::uuid AND source_ref_type = 'cath_consumable_usage' ORDER BY id`,
      TENANT,
    );
    const reusedUsage = await prisma.$queryRawUnsafe(`SELECT id FROM cath_case_consumable_usage WHERE tenant_id = $1::uuid AND inventory_decrement_status = 'reused_device' ORDER BY id LIMIT 1`, TENANT);
    const reusedLine = lines.find((l) => Number(l.source_ref_id) === Number(reusedUsage[0].id));
    expect(reusedLine.service_code).toBe('CATH-TEST-REUSED');
    const firstLine = lines.find((l) => Number(l.source_ref_id) === Number(firstUse.id));
    expect(firstLine.service_code).toBe('CATH-TEST-NEW');

    await upsertConsumableCatalogItem({ tenantId: TENANT, id: CATALOG_ID, reused_billing_item_code: null }, ctx());
    const unbilled = await listUnbilledConsumableUsage({ tenantId: TENANT, case_id: CASE_ID });
    expect(unbilled.items.every((row) => row.billing_gap_reason !== 'reused_billing_code_not_mapped' || Number(row.reuse_cycle) >= 1)).toBe(true);
  }, 60000);
```

The `billing_service_master` INSERT names that table's NOT NULL columns as of migration 000; confirm with `grep -n "CREATE TABLE public.billing_service_master" -A 30 apps/backend/src/migrations/000_baseline.sql` and add any further NOT NULL column it shows. The `transitionCaseStatus` call may require `in_progress → completed` to be reachable from the seeded case status; the copied fixture seeds `in_progress`, which allows it.

- [ ] **Step 5: Run, then commit**

```bash
DATABASE_URL=… npm test -- --testPathPatterns "cath-device-reuse.deep|cath-consumables.deep"
git add apps/backend/src/services/clinical/cathLabService.js apps/backend/src/tests/cath-device-reuse.deep.test.js
git commit -m "feat(cath): reprocessed tariff code on catalogue, billing emission and unbilled gap reason

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: Staff app — reused capture, restriction strip, post-use actions

**Files:**
- Modify: `apps/staff/lib/features/cath_lab/models/cath_consumable_models.dart`
- Modify: `apps/staff/lib/features/cath_lab/services/cath_lab_api_service.dart` (after `createConsumableUsage`, ≈line 626)
- Modify: `apps/staff/lib/features/cath_lab/widgets/cath_consumable_capture_sheet.dart`
- Modify: `apps/staff/lib/features/cath_lab/widgets/cath_case_consumables_panel.dart`
- Modify: `apps/staff/lib/l10n/app_strings.dart` (five locale maps)
- Test: `apps/staff/test/features/cath_lab/cath_case_consumables_panel_test.dart` (append), `apps/staff/test/features/cath_lab/cath_consumable_models_test.dart` (append)

- [ ] **Step 1: Models**

Append to `cath_consumable_models.dart` (the file-private helpers `_text`, `_firstText`, `_asInt`, `_asDouble`, `_asBool`, `_asDate` already exist at its foot):

```dart
class CathReuseRestriction {
  const CathReuseRestriction({
    required this.status,
    required this.reasons,
    required this.validityDays,
  });

  final String status; // restricted | unknown | clear
  final List<String> reasons;
  final int validityDays;

  bool get isRestricted => status == 'restricted';
  bool get isUnknown => status == 'unknown';
  bool get isClear => status == 'clear';

  factory CathReuseRestriction.fromJson(Map<String, dynamic> json) {
    return CathReuseRestriction(
      status: _text(json['status'], fallback: 'unknown'),
      reasons: json['reasons'] is List
          ? (json['reasons'] as List).map((e) => _text(e)).where((e) => e.isNotEmpty).toList()
          : const [],
      validityDays: _asInt(json['validity_days']) ?? 90,
    );
  }
}

class CathPostUseOptions {
  const CathPostUseOptions({
    required this.dispositions,
    required this.requiresAcknowledgement,
    required this.exposure,
    required this.reasonCodes,
    required this.unitsMax,
    this.discardReason,
    this.blockedCode,
  });

  final List<String> dispositions; // reprocess | discard
  final bool requiresAcknowledgement;
  final bool exposure;
  final List<String> reasonCodes;
  final int unitsMax;
  final String? discardReason;
  final String? blockedCode;

  bool get canReprocess => dispositions.contains('reprocess');
  bool get canDiscard => dispositions.contains('discard');
  bool get isEmpty => dispositions.isEmpty;

  factory CathPostUseOptions.fromJson(Map<String, dynamic> json) {
    List<String> list(Object? v) =>
        v is List ? v.map((e) => _text(e)).where((e) => e.isNotEmpty).toList() : const [];
    return CathPostUseOptions(
      dispositions: list(json['dispositions']),
      requiresAcknowledgement: _asBool(json['requires_acknowledgement']),
      exposure: _asBool(json['exposure']),
      reasonCodes: list(json['reason_codes']),
      unitsMax: _asInt(json['units_max']) ?? 0,
      discardReason: _text(json['discard_reason']).isEmpty ? null : _text(json['discard_reason']),
      blockedCode: _text(json['blocked_code']).isEmpty ? null : _text(json['blocked_code']),
    );
  }
}

class CathReprocessableDevice {
  const CathReprocessableDevice({
    required this.id,
    required this.deviceTag,
    required this.itemName,
    required this.category,
    required this.status,
    required this.cycleCount,
    required this.maxCycles,
    required this.exposureFlag,
    required this.exposureMarkers,
  });

  final int id;
  final String deviceTag;
  final String itemName;
  final String category;
  final String status;
  final int cycleCount;
  final int maxCycles;
  final bool exposureFlag;
  final List<String> exposureMarkers;

  factory CathReprocessableDevice.fromJson(Map<String, dynamic> json) {
    return CathReprocessableDevice(
      id: _asInt(json['id']) ?? 0,
      deviceTag: _text(json['device_tag']),
      itemName: _text(json['item_name']),
      category: _text(json['category'], fallback: 'other'),
      status: _text(json['status'], fallback: 'unknown'),
      cycleCount: _asInt(json['cycle_count']) ?? 0,
      maxCycles: _asInt(json['max_cycles_snapshot']) ?? 0,
      exposureFlag: _asBool(json['exposure_flag']),
      exposureMarkers: json['exposure_markers'] is List
          ? (json['exposure_markers'] as List).map((e) => _text(e)).toList()
          : const [],
    );
  }
}

class CathDeviceLookup {
  const CathDeviceLookup({
    required this.device,
    required this.reprocessable,
    required this.cyclesRemaining,
    required this.requiresAcknowledgement,
    required this.blocked,
  });

  final CathReprocessableDevice device;
  final bool reprocessable;
  final int cyclesRemaining;
  final bool requiresAcknowledgement;
  final bool blocked;

  bool get usable => device.status == 'available' && reprocessable && !blocked;

  factory CathDeviceLookup.fromJson(Map<String, dynamic> json) {
    final raw = json['device'];
    return CathDeviceLookup(
      device: CathReprocessableDevice.fromJson(
        raw is Map ? Map<String, dynamic>.from(raw) : const <String, dynamic>{},
      ),
      reprocessable: _asBool(json['reprocessable']),
      cyclesRemaining: _asInt(json['cycles_remaining']) ?? 0,
      requiresAcknowledgement: _asBool(json['requires_acknowledgement']),
      blocked: _asBool(json['blocked']),
    );
  }
}

class CathCaseConsumablesPayload {
  const CathCaseConsumablesPayload({
    required this.usage,
    required this.restriction,
    required this.reprocessableCategories,
  });

  final List<CathCaseConsumableUsage> usage;
  final CathReuseRestriction restriction;
  final Set<String> reprocessableCategories;
}

class CathPostUseDraft {
  const CathPostUseDraft({
    required this.disposition,
    this.units,
    this.discardReason,
    this.discardNote,
    this.acknowledgementReason,
  });

  final String disposition; // reprocess | discard
  final int? units;
  final String? discardReason;
  final String? discardNote;
  final String? acknowledgementReason;

  Map<String, dynamic> toJson() => {
    'disposition': disposition,
    if (units != null) 'units': units,
    if ((discardReason ?? '').isNotEmpty) 'discard_reason': discardReason,
    if ((discardNote ?? '').isNotEmpty) 'discard_note': discardNote,
    if ((acknowledgementReason ?? '').isNotEmpty)
      'acknowledgement': {'reason': acknowledgementReason},
  };
}

class CathPostUseResult {
  const CathPostUseResult({
    required this.usageId,
    required this.disposition,
    required this.deviceTags,
  });

  final int usageId;
  final String disposition;
  final List<String> deviceTags;

  factory CathPostUseResult.fromJson(Map<String, dynamic> json) {
    final devices = json['devices'];
    return CathPostUseResult(
      usageId: _asInt(json['usage_id']) ?? 0,
      disposition: _text(json['disposition']),
      deviceTags: devices is List
          ? devices
                .whereType<Map>()
                .map((d) => _text(d['device_tag']))
                .where((t) => t.isNotEmpty)
                .toList()
          : const [],
    );
  }
}
```

In `CathCaseConsumableUsage` add these fields (constructor, finals, `fromJson`):

```dart
    this.deviceTag = '',
    this.reuseCycle,
    this.postUseDisposition = '',
    this.deviceStatus = '',
    this.deviceExposureFlag = false,
    this.allowedPostUse,
```
```dart
  final String deviceTag;
  final int? reuseCycle;
  final String postUseDisposition;
  final String deviceStatus;
  final bool deviceExposureFlag;
  final CathPostUseOptions? allowedPostUse;

  bool get isReused => reuseCycle != null && reuseCycle! >= 1;
```
```dart
      deviceTag: _text(json['device_tag']),
      reuseCycle: _asInt(json['reuse_cycle']),
      postUseDisposition: _text(json['post_use_disposition']),
      deviceStatus: _text(json['device_status']),
      deviceExposureFlag: _asBool(json['device_exposure_flag']),
      allowedPostUse: json['allowed_post_use'] is Map
          ? CathPostUseOptions.fromJson(Map<String, dynamic>.from(json['allowed_post_use'] as Map))
          : null,
```

In `CathConsumableUsageDraft` add `this.reusedDeviceTag, this.exposureAcknowledgementReason,` to the constructor, the two `final String?` fields, and in `toJson()`:

```dart
    if ((reusedDeviceTag ?? '').isNotEmpty) 'reused_device_tag': reusedDeviceTag,
    if ((exposureAcknowledgementReason ?? '').isNotEmpty)
      'exposure_acknowledgement': {'reason': exposureAcknowledgementReason},
```

Append to `cath_consumable_models_test.dart`:

```dart
  test('draft emits reused_device_tag and exposure acknowledgement, no batch fields', () {
    const draft = CathConsumableUsageDraft(
      catalogItemId: 10, quantity: 1, wasted: false,
      reusedDeviceTag: 'RP00000042', exposureAcknowledgementReason: 'reviewed',
    );
    expect(draft.toJson(), {
      'catalog_item_id': '10', 'quantity': 1.0, 'wasted': false,
      'reused_device_tag': 'RP00000042',
      'exposure_acknowledgement': {'reason': 'reviewed'},
    });
  });

  test('usage parses reuse fields and post-use options', () {
    final usage = CathCaseConsumableUsage.fromJson({
      'id': 5, 'case_id': 42, 'catalog_item_id': 10, 'item_name': 'Diagnostic catheter',
      'quantity': '1.0000', 'device_tag': 'RP00000042', 'reuse_cycle': 2,
      'inventory_decrement_status': 'reused_device',
      'allowed_post_use': {'dispositions': ['discard'], 'requires_acknowledgement': false, 'exposure': false, 'discard_reason': 'max_cycles_reached', 'reason_codes': ['max_cycles_reached'], 'units_max': 1},
    });
    expect(usage.isReused, isTrue);
    expect(usage.deviceTag, 'RP00000042');
    expect(usage.allowedPostUse!.canReprocess, isFalse);
    expect(usage.allowedPostUse!.discardReason, 'max_cycles_reached');
  });
```

- [ ] **Step 2: API service**

Add after `createConsumableUsage` in `cath_lab_api_service.dart`:

```dart
  /// GET /cath-lab/cases/:id/consumables — usage rows decorated with reuse
  /// state, plus the patient's blood-borne restriction and the categories the
  /// tenant allows to be reprocessed.
  static Future<CathCaseConsumablesPayload> fetchCaseConsumablesWithReuse(
    int caseId,
  ) async {
    final response = await ApiClient.get('/cath-lab/cases/$caseId/consumables');
    final data = _successfulData(
      response,
      'Failed to load Cath Lab consumable usage',
    );
    final restrictionRaw = data['reuse_restriction'];
    final reprocessingRaw = data['reprocessing'];
    final categories = reprocessingRaw is Map &&
            reprocessingRaw['reprocessable_categories'] is List
        ? (reprocessingRaw['reprocessable_categories'] as List)
              .map((e) => e.toString())
              .toSet()
        : <String>{};
    return CathCaseConsumablesPayload(
      usage: _mapList(data['usage'])
          .map(CathCaseConsumableUsage.fromJson)
          .where((usage) => usage.id > 0)
          .toList(growable: false),
      restriction: CathReuseRestriction.fromJson(
        restrictionRaw is Map
            ? Map<String, dynamic>.from(restrictionRaw)
            : const <String, dynamic>{},
      ),
      reprocessableCategories: categories,
    );
  }

  /// GET /cath-lab/devices/lookup?case_id=&tag= — device state for the
  /// capture sheet. 404 when the tag is unknown or belongs to another facility.
  static Future<CathDeviceLookup> lookupReusableDevice(
    int caseId,
    String tag,
  ) async {
    final response = await ApiClient.get(
      '/cath-lab/devices/lookup',
      queryParameters: {'case_id': '$caseId', 'tag': tag.trim().toUpperCase()},
    );
    final data = _successfulData(response, 'Device not found');
    return CathDeviceLookup.fromJson(data);
  }

  /// POST /cath-lab/cases/:id/consumables/:usageId/post-use. Requires an
  /// idempotency key (scope cath_consumable_post_use).
  static Future<CathPostUseResult> recordPostUse(
    int caseId,
    int usageId,
    CathPostUseDraft draft, {
    required String idempotencyKey,
  }) async {
    final response = await ApiClient.post(
      '/cath-lab/cases/$caseId/consumables/$usageId/post-use',
      body: draft.toJson(),
      idempotencyKey: idempotencyKey,
    );
    final data = _successfulData(response, 'Failed to record post-use');
    return CathPostUseResult.fromJson(data);
  }
```

- [ ] **Step 3: Strings (all five locale maps in `app_strings.dart`)**

Add each key next to the existing `s4.lib.cath_lab.consumables.*` entries in every map. English (en), then hi, ta, te, ml values:

| key | en | hi | ta | te | ml |
|---|---|---|---|---|---|
| `s4.lib.cath_lab.consumables.mode_new` | New unit | नई इकाई | புதிய அலகு | కొత్త యూనిట్ | പുതിയ യൂണിറ്റ് |
| `s4.lib.cath_lab.consumables.mode_reused` | Reprocessed device | पुनःसंसाधित उपकरण | மறுசெயலாக்கப்பட்ட சாதனம் | పునఃప్రాసెస్ చేసిన పరికరం | പുനഃസംസ്കരിച്ച ഉപകരണം |
| `s4.lib.cath_lab.consumables.device_tag_label` | Device tag | उपकरण टैग | சாதன குறிச்சொல் | పరికర ట్యాగ్ | ഉപകരണ ടാഗ് |
| `s4.lib.cath_lab.consumables.device_check` | Check device | उपकरण जांचें | சாதனத்தைச் சரிபார் | పరికరాన్ని తనిఖీ చేయండి | ഉപകരണം പരിശോധിക്കുക |
| `s4.lib.cath_lab.consumables.device_not_available` | This device is not available for use | यह उपकरण उपयोग के लिए उपलब्ध नहीं है | இந்த சாதனம் பயன்பாட்டிற்கு கிடைக்கவில்லை | ఈ పరికరం వినియోగానికి అందుబాటులో లేదు | ഈ ഉപകരണം ഉപയോഗത്തിന് ലഭ്യമല്ല |
| `s4.lib.cath_lab.consumables.device_blocked` | This device carries a blood-borne exposure flag and cannot be reused | इस उपकरण पर रक्तजनित संक्रमण का चिह्न है और इसे पुनः उपयोग नहीं किया जा सकता | இந்த சாதனத்தில் இரத்தம் வழி நோய்த்தொற்று குறி உள்ளது; மறுபயன்பாடு இயலாது | ఈ పరికరంపై రక్తజనిత సంక్రమణ గుర్తు ఉంది; తిరిగి వాడలేము | ഈ ഉപകരണത്തിൽ രക്തജന്യ അണുബാധ ഫ്ലാഗ് ഉണ്ട്; പുനരുപയോഗം സാധ്യമല്ല |
| `s4.lib.cath_lab.consumables.acknowledgement_label` | Reason for proceeding | आगे बढ़ने का कारण | தொடர்வதற்கான காரணம் | కొనసాగడానికి కారణం | തുടരാനുള്ള കാരണം |
| `s4.lib.cath_lab.consumables.restriction_restricted` | Devices used in this case will be discarded, not reprocessed | इस केस में उपयोग किए गए उपकरण नष्ट किए जाएंगे, पुनःसंसाधित नहीं | இந்த வழக்கில் பயன்படுத்தப்படும் சாதனங்கள் அகற்றப்படும்; மறுசெயலாக்கப்படாது | ఈ కేసులో వాడిన పరికరాలు పారవేయబడతాయి; పునఃప్రాసెస్ చేయబడవు | ഈ കേസിൽ ഉപയോഗിക്കുന്ന ഉപകരണങ്ങൾ നീക്കം ചെയ്യപ്പെടും; പുനഃസംസ്കരിക്കില്ല |
| `s4.lib.cath_lab.consumables.restriction_unknown` | Serology not on record; reprocessing needs acknowledgement | सीरोलॉजी दर्ज नहीं है; पुनःसंसाधन के लिए पुष्टि आवश्यक | சீராலஜி பதிவில் இல்லை; மறுசெயலாக்கத்திற்கு ஒப்புதல் தேவை | సెరాలజీ నమోదులో లేదు; పునఃప్రాసెసింగ్‌కు ధృవీకరణ అవసరం | സെറോളജി രേഖയിലില്ല; പുനഃസംസ്കരണത്തിന് സ്ഥിരീകരണം ആവശ്യം |
| `s4.lib.cath_lab.consumables.post_use_send` | Send to CSSD | CSSD को भेजें | CSSD-க்கு அனுப்பு | CSSDకి పంపండి | CSSD-ലേക്ക് അയയ്ക്കുക |
| `s4.lib.cath_lab.consumables.post_use_discard` | Discard | नष्ट करें | அகற்று | పారవేయండి | നീക്കം ചെയ്യുക |
| `s4.lib.cath_lab.consumables.post_use_units` | Units going to CSSD | CSSD को जाने वाली इकाइयां | CSSD-க்கு செல்லும் அலகுகள் | CSSDకి వెళ్లే యూనిట్లు | CSSD-ലേക്ക് പോകുന്ന യൂണിറ്റുകൾ |
| `s4.lib.cath_lab.consumables.post_use_discard_reason` | Discard reason | नष्ट करने का कारण | அகற்றுவதற்கான காரணம் | పారవేయడానికి కారణం | നീക്കം ചെയ്യാനുള്ള കാരണം |
| `s4.lib.cath_lab.consumables.post_use_saved` | Post-use recorded | उपयोग-पश्चात दर्ज किया गया | பயன்பாட்டிற்குப் பின் பதிவு செய்யப்பட்டது | వినియోగానంతరం నమోదైంది | ഉപയോഗാനന്തരം രേഖപ്പെടുത്തി |
| `s4.lib.cath_lab.consumables.reused_badge` | Reprocessed | पुनःसंसाधित | மறுசெயலாக்கப்பட்டது | పునఃప్రాసెస్ చేయబడింది | പുനഃസംസ്കരിച്ചത് |
| `s4.lib.cath_lab.consumables.exposure_badge` | Exposure | संक्रमण जोखिम | தொற்று ஆபத்து | సంక్రమణ ప్రమాదం | അണുബാധ സാധ്യത |
| `s4.dynamic.cath_lab.consumables.device_cycle` | Cycle {cycle} of {max} | चक्र {cycle} / {max} | சுழற்சி {cycle} / {max} | చక్రం {cycle} / {max} | സൈക്കിൾ {cycle} / {max} |
| `s4.dynamic.cath_lab.consumables.device_tag` | Tag {tag} | टैग {tag} | குறிச்சொல் {tag} | ట్యాగ్ {tag} | ടാഗ് {tag} |

These hi/ta/te/ml renderings are engineering placeholders in the sense of ledger row OPEN-21: they pass the parity gate and must be routed to the named linguistic reviewers like every other string.

- [ ] **Step 4: Capture sheet**

In `cath_consumable_capture_sheet.dart`:

Constructor gains three optional parameters (add to the `const CathConsumableCaptureSheet({…})` list and as finals):

```dart
    this.reprocessableCategories = const <String>{},
    this.restriction,
    this.lookupDevice,
```
```dart
  final Set<String> reprocessableCategories;
  final CathReuseRestriction? restriction;
  final Future<CathDeviceLookup> Function(int caseId, String tag)? lookupDevice;
```

State additions:

```dart
  final _tagController = TextEditingController();
  final _ackController = TextEditingController();
  String _mode = 'new';
  CathDeviceLookup? _lookup;
  bool _lookingUp = false;
```

Dispose both controllers. In `_selectItem` reset `_mode = 'new'; _lookup = null; _tagController.clear(); _ackController.clear();`. Add:

```dart
  bool get _reusedModeAvailable =>
      _selectedItem != null &&
      !_selectedItem!.isImplant &&
      widget.lookupDevice != null &&
      widget.reprocessableCategories.contains(_selectedItem!.category);

  Future<void> _checkDevice() async {
    final tag = _tagController.text.trim().toUpperCase();
    if (tag.isEmpty || _lookingUp) return;
    setState(() {
      _lookingUp = true;
      _lookup = null;
      _error = null;
    });
    try {
      final result = await widget.lookupDevice!(widget.caseId, tag);
      if (!mounted) return;
      setState(() => _lookup = result);
    } catch (error) {
      if (mounted) setState(() => _error = _cleanError(error));
    } finally {
      if (mounted) setState(() => _lookingUp = false);
    }
  }
```

In `_save`, when `_mode == 'reused'`:

```dart
      if (_mode == 'reused') {
        final lookup = _lookup;
        if (lookup == null || !lookup.usable) {
          setState(() => _error = s.lookup(
                lookup?.blocked == true
                    ? 's4.lib.cath_lab.consumables.device_blocked'
                    : 's4.lib.cath_lab.consumables.device_not_available',
              ));
          return;
        }
      }
```

and build the draft as:

```dart
      final reused = _mode == 'reused';
      final draft = CathConsumableUsageDraft(
        catalogItemId: item.id,
        quantity: reused ? 1 : double.parse(_quantityController.text.trim()),
        inventoryBatchId: reused ? null : _selectedBatchId,
        batchNumber: reused ? null : _nullableText(_batchController.text),
        lotNumber: reused ? null : _nullableText(_lotController.text),
        expiryDate: reused ? null : _expiryDate,
        serialNumber: reused ? null : _nullableText(_serialController.text),
        wasted: _wasted,
        wastageReason: _wasted ? _nullableText(_wastageReasonController.text) : null,
        reusedDeviceTag: reused ? _lookup!.device.deviceTag : null,
        exposureAcknowledgementReason:
            reused && (_lookup?.requiresAcknowledgement ?? false)
                ? _nullableText(_ackController.text)
                : null,
      );
```

(`final s = AppStrings.of(context);` must be hoisted to the top of `_save`.)

In `build`, directly under the title (before the search field), render the restriction strip when supplied:

```dart
          if (widget.restriction != null && !widget.restriction!.isClear) ...[
            Container(
              key: const ValueKey('cath-consumable-restriction-strip'),
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: (widget.restriction!.isRestricted
                        ? AppTheme.errorRed
                        : AppTheme.warningAmber)
                    .withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.lookup(widget.restriction!.isRestricted
                        ? 's4.lib.cath_lab.consumables.restriction_restricted'
                        : 's4.lib.cath_lab.consumables.restriction_unknown'),
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      color: widget.restriction!.isRestricted
                          ? AppTheme.errorOnSurface
                          : AppTheme.warningOnSurface,
                    ),
                  ),
                  for (final reason in widget.restriction!.reasons)
                    Text(reason, style: Theme.of(context).textTheme.bodySmall),
                ],
              ),
            ),
            const SizedBox(height: 12),
          ],
```

After the selected-item `Card` (inside the `else` branch, before the quantity field) add the mode control and the reused block; wrap the existing quantity, batch and serial fields in `if (_mode == 'new') ...[ … ]`:

```dart
            if (_reusedModeAvailable) ...[
              const SizedBox(height: 12),
              SegmentedButton<String>(
                key: const ValueKey('cath-consumable-mode'),
                segments: [
                  ButtonSegment(value: 'new', label: Text(s.lookup('s4.lib.cath_lab.consumables.mode_new'))),
                  ButtonSegment(value: 'reused', label: Text(s.lookup('s4.lib.cath_lab.consumables.mode_reused'))),
                ],
                selected: {_mode},
                onSelectionChanged: _saving
                    ? null
                    : (selection) => setState(() {
                          _mode = selection.first;
                          _lookup = null;
                          _error = null;
                        }),
              ),
            ],
            if (_mode == 'reused') ...[
              const SizedBox(height: 12),
              TextFormField(
                key: const ValueKey('cath-consumable-device-tag'),
                controller: _tagController,
                textCapitalization: TextCapitalization.characters,
                onFieldSubmitted: (_) => _checkDevice(),
                decoration: InputDecoration(
                  labelText: s.lookup('s4.lib.cath_lab.consumables.device_tag_label'),
                  hintText: 'RP00000042',
                  suffixIcon: IconButton(
                    key: const ValueKey('cath-consumable-device-check'),
                    tooltip: s.lookup('s4.lib.cath_lab.consumables.device_check'),
                    onPressed: _lookingUp ? null : _checkDevice,
                    icon: const Icon(Icons.search),
                  ),
                ),
                validator: _requiredValidator,
              ),
              if (_lookingUp) const LinearProgressIndicator(),
              if (_lookup != null) ...[
                const SizedBox(height: 8),
                Card(
                  key: const ValueKey('cath-consumable-device-card'),
                  color: (_lookup!.usable ? AppTheme.successGreen : AppTheme.errorRed).withValues(alpha: 0.08),
                  child: ListTile(
                    dense: true,
                    title: Text(_lookup!.device.itemName),
                    subtitle: Text([
                      s.format('s4.dynamic.cath_lab.consumables.device_cycle', {
                        'cycle': _lookup!.device.cycleCount + 1,
                        'max': _lookup!.device.maxCycles + 1,
                      }),
                      _humanize(_lookup!.device.status),
                      if (_lookup!.blocked) s.lookup('s4.lib.cath_lab.consumables.device_blocked'),
                    ].join(' - ')),
                    trailing: _lookup!.device.exposureFlag
                        ? const Icon(Icons.warning_amber_outlined)
                        : null,
                  ),
                ),
              ],
              if (_lookup?.requiresAcknowledgement ?? false) ...[
                const SizedBox(height: 8),
                TextFormField(
                  key: const ValueKey('cath-consumable-acknowledgement'),
                  controller: _ackController,
                  minLines: 2,
                  maxLines: 3,
                  decoration: InputDecoration(
                    labelText: s.lookup('s4.lib.cath_lab.consumables.acknowledgement_label'),
                  ),
                  validator: _requiredValidator,
                ),
              ],
            ],
```

- [ ] **Step 5: Panel**

In `cath_case_consumables_panel.dart`:

Typedefs and dependency bag gain:

```dart
typedef CathCaseConsumablesLoader =
    Future<CathCaseConsumablesPayload> Function(int caseId);
typedef CathDeviceLookupFn =
    Future<CathDeviceLookup> Function(int caseId, String tag);
typedef CathPostUseRecorder = Future<CathPostUseResult> Function(
  int caseId,
  int usageId,
  CathPostUseDraft draft, {
  required String idempotencyKey,
});
```
```dart
    this.loadConsumables,
    this.lookupDevice,
    this.recordPostUse,
```
```dart
  final CathCaseConsumablesLoader? loadConsumables;
  final CathDeviceLookupFn? lookupDevice;
  final CathPostUseRecorder? recordPostUse;
```

State: add `CathReuseRestriction? _restriction; Set<String> _reprocessableCategories = const {};` and getters:

```dart
  CathCaseConsumablesLoader get _loadConsumables =>
      widget.dependencies.loadConsumables ??
      (widget.dependencies.loadUsage != null
          ? (caseId) async => CathCaseConsumablesPayload(
                usage: await widget.dependencies.loadUsage!(caseId),
                restriction: const CathReuseRestriction(status: 'clear', reasons: [], validityDays: 90),
                reprocessableCategories: const {},
              )
          : CathLabApiService.fetchCaseConsumablesWithReuse);
  CathDeviceLookupFn get _lookupDevice =>
      widget.dependencies.lookupDevice ?? CathLabApiService.lookupReusableDevice;
  CathPostUseRecorder get _recordPostUse =>
      widget.dependencies.recordPostUse ?? CathLabApiService.recordPostUse;
```

`_load` becomes:

```dart
      final payload = await _loadConsumables(widget.cathCase.id);
      if (!mounted) return;
      setState(() {
        _usage = payload.usage;
        _restriction = payload.restriction;
        _reprocessableCategories = payload.reprocessableCategories;
        _loaded = true;
      });
```

`_openCapture` passes `reprocessableCategories: _reprocessableCategories, restriction: _restriction, lookupDevice: _lookupDevice,` to the sheet, and after a successful capture calls `_load()` (so the new row carries its `allowed_post_use`) instead of splicing the returned row in.

Add the post-use flow:

```dart
  Future<void> _openPostUse(CathCaseConsumableUsage usage, String disposition) async {
    final options = usage.allowedPostUse;
    if (options == null) return;
    final draft = await showModalBottomSheet<CathPostUseDraft>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => _PostUseSheet(
        usage: usage,
        disposition: disposition,
        options: options,
        restriction: _restriction,
      ),
    );
    if (draft == null || !mounted) return;
    final attempt = IdempotencyAttempt('cath-post-use-${usage.id}');
    try {
      final result = await _recordPostUse(
        widget.cathCase.id,
        usage.id,
        draft,
        idempotencyKey: attempt.keyFor(draft.toJson()),
      );
      if (!mounted) return;
      final s = AppStrings.of(context);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text([
          s.lookup('s4.lib.cath_lab.consumables.post_use_saved'),
          if (result.deviceTags.isNotEmpty) result.deviceTags.join(', '),
        ].join(' - ')),
        backgroundColor: AppTheme.successGreen,
      ));
      await _load();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(_cleanError(error)),
        backgroundColor: AppTheme.errorRed,
      ));
    }
  }
```

(import `package:vhhealth_core/services/idempotency_key.dart` at the top, as the capture sheet does.)

In `build`, inside the expanded children `Column`, before the `if (widget.canAddUsage)` block, render the strip when `_restriction != null && !_restriction!.isClear` using the same widget as the capture sheet (extract it into a small file-private `_ReuseRestrictionStrip` widget in the panel file with `key: ValueKey('cath-reuse-restriction-${widget.cathCase.id}')`; the capture sheet keeps its own copy since it is a separate file — a shared widget file `cath_reuse_restriction_strip.dart` is the cleaner choice: create it, export `CathReuseRestrictionStrip({required CathReuseRestriction restriction, Key? key})`, and use it from both places).

`_UsageCard` gains `final void Function(String disposition)? onPostUse;` and renders, after the inventory warning block:

```dart
            if (usage.isReused) ...[
              const SizedBox(height: 6),
              Wrap(spacing: 6, children: [
                _UsageChip(label: s.lookup('s4.lib.cath_lab.consumables.reused_badge'), color: AppTheme.primaryBlue),
                if (usage.deviceTag.isNotEmpty)
                  _UsageChip(label: s.format('s4.dynamic.cath_lab.consumables.device_tag', {'tag': usage.deviceTag}), color: AppTheme.textSecondary),
                if (usage.deviceExposureFlag)
                  _UsageChip(label: s.lookup('s4.lib.cath_lab.consumables.exposure_badge'), color: AppTheme.errorRed),
              ]),
            ],
            if (onPostUse != null && usage.allowedPostUse != null && !usage.allowedPostUse!.isEmpty) ...[
              const SizedBox(height: 10),
              Row(children: [
                if (usage.allowedPostUse!.canReprocess)
                  FilledButton.tonalIcon(
                    key: ValueKey('cath-post-use-reprocess-${usage.id}'),
                    onPressed: () => onPostUse!('reprocess'),
                    icon: const Icon(Icons.local_laundry_service_outlined, size: 18),
                    label: Text(s.lookup('s4.lib.cath_lab.consumables.post_use_send')),
                  ),
                if (usage.allowedPostUse!.canReprocess && usage.allowedPostUse!.canDiscard)
                  const SizedBox(width: 8),
                if (usage.allowedPostUse!.canDiscard)
                  OutlinedButton.icon(
                    key: ValueKey('cath-post-use-discard-${usage.id}'),
                    onPressed: () => onPostUse!('discard'),
                    icon: const Icon(Icons.delete_outline, size: 18),
                    label: Text(s.lookup('s4.lib.cath_lab.consumables.post_use_discard')),
                  ),
              ]),
            ],
            if (usage.postUseDisposition.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(_humanize(usage.postUseDisposition), style: Theme.of(context).textTheme.bodySmall),
            ],
```

and the panel passes `onPostUse: widget.canAddUsage ? (d) => _openPostUse(usage, d) : null`. Add the `_humanize` helper (copy of the capture sheet's) at the panel file foot.

The `_PostUseSheet` (file-private, in the panel file): a `Form` with, for `reprocess`: a units field defaulted to `options.unitsMax` (hidden when `unitsMax == 1`), an acknowledgement field when `options.requiresAcknowledgement` (required), and the restriction reasons; for `discard`: a `DropdownButtonFormField` over the discard reasons (`max_cycles_reached, bloodborne_exposure, function_check_failed, damaged, wasted, policy_change, other`) preselected to `options.discardReason` and disabled when `options.discardReason != null`, plus an optional note. Its confirm button pops `CathPostUseDraft(...)`. Keys: `cath-post-use-units`, `cath-post-use-acknowledgement`, `cath-post-use-reason`, `cath-post-use-note`, `cath-post-use-confirm`.

- [ ] **Step 6: Widget tests**

Append to `cath_case_consumables_panel_test.dart`:

```dart
  testWidgets('reused mode sends reused_device_tag and no batch fields', (tester) async {
    Map<String, dynamic>? sent;
    final deps = CathConsumableDependencies(
      loadConsumables: (_) async => CathCaseConsumablesPayload(
        usage: const [],
        restriction: const CathReuseRestriction(status: 'clear', reasons: [], validityDays: 90),
        reprocessableCategories: const {'catheter'},
      ),
      searchCatalog: ({required caseId, query, scan}) async => const [_untrackedItem],
      loadBatches: (_, {required caseId}) async => const [],
      lookupDevice: (_, tag) async => CathDeviceLookup(
        device: CathReprocessableDevice(
          id: 9, deviceTag: tag, itemName: 'Diagnostic catheter', category: 'catheter',
          status: 'available', cycleCount: 1, maxCycles: 3, exposureFlag: false, exposureMarkers: const [],
        ),
        reprocessable: true, cyclesRemaining: 2, requiresAcknowledgement: false, blocked: false,
      ),
      createUsage: (caseId, draft, {required idempotencyKey}) async {
        sent = draft.toJson();
        return CathCaseConsumableUsage.fromJson({'id': 77, 'case_id': caseId, 'catalog_item_id': 10, 'item_name': 'Diagnostic catheter', 'quantity': 1, 'reuse_cycle': 1, 'device_tag': 'RP00000042'});
      },
      scanCode: () async => null,
    );
    await tester.pumpWidget(_wrap(deps));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumables-add-42')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('cath-consumable-search')), 'cath');
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-consumable-option-10')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reprocessed device'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('cath-consumable-device-tag')), 'rp00000042');
    await tester.tap(find.byKey(const ValueKey('cath-consumable-device-check')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('cath-consumable-device-card')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('cath-consumable-save')));
    await tester.pumpAndSettle();
    expect(sent!['reused_device_tag'], 'RP00000042');
    expect(sent!.containsKey('batch_number'), isFalse);
    expect(sent!['quantity'], 1.0);
  });

  testWidgets('restricted patient shows the strip and only the discard action', (tester) async {
    final deps = CathConsumableDependencies(
      loadConsumables: (_) async => CathCaseConsumablesPayload(
        usage: [
          CathCaseConsumableUsage.fromJson({
            'id': 5, 'case_id': 42, 'catalog_item_id': 10, 'item_name': 'Diagnostic catheter', 'quantity': 1,
            'allowed_post_use': {'dispositions': ['discard'], 'requires_acknowledgement': false, 'exposure': false, 'discard_reason': 'bloodborne_exposure', 'reason_codes': ['bloodborne_restricted'], 'units_max': 1},
          }),
        ],
        restriction: const CathReuseRestriction(status: 'restricted', reasons: ['HBsAg reactive 2026-08-12'], validityDays: 90),
        reprocessableCategories: const {'catheter'},
      ),
      scanCode: () async => null,
    );
    await tester.pumpWidget(_wrap(deps));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('cath-reuse-restriction-42')), findsOneWidget);
    expect(find.text('HBsAg reactive 2026-08-12'), findsOneWidget);
    expect(find.byKey(const ValueKey('cath-post-use-discard-5')), findsOneWidget);
    expect(find.byKey(const ValueKey('cath-post-use-reprocess-5')), findsNothing);
  });

  testWidgets('unknown serology: send to CSSD requires an acknowledgement and posts it', (tester) async {
    CathPostUseDraft? posted;
    final deps = CathConsumableDependencies(
      loadConsumables: (_) async => CathCaseConsumablesPayload(
        usage: [
          CathCaseConsumableUsage.fromJson({
            'id': 6, 'case_id': 42, 'catalog_item_id': 10, 'item_name': 'Diagnostic catheter', 'quantity': 2,
            'allowed_post_use': {'dispositions': ['reprocess', 'discard'], 'requires_acknowledgement': true, 'exposure': false, 'reason_codes': ['serology_unknown'], 'units_max': 2},
          }),
        ],
        restriction: const CathReuseRestriction(status: 'unknown', reasons: ['HCV not on record'], validityDays: 90),
        reprocessableCategories: const {'catheter'},
      ),
      recordPostUse: (caseId, usageId, draft, {required idempotencyKey}) async {
        posted = draft;
        return const CathPostUseResult(usageId: 6, disposition: 'sent_for_reprocessing', deviceTags: ['RP00000001', 'RP00000002']);
      },
      scanCode: () async => null,
    );
    await tester.pumpWidget(_wrap(deps));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-post-use-reprocess-6')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-post-use-confirm')));
    await tester.pumpAndSettle();
    expect(posted, isNull); // validator blocked the empty acknowledgement
    await tester.enterText(find.byKey(const ValueKey('cath-post-use-acknowledgement')), 'Emergency PCI, serology pending');
    await tester.tap(find.byKey(const ValueKey('cath-post-use-confirm')));
    await tester.pumpAndSettle();
    expect(posted!.disposition, 'reprocess');
    expect(posted!.units, 2);
    expect(posted!.acknowledgementReason, 'Emergency PCI, serology pending');
  });
```

- [ ] **Step 7: Run the Staff gates**

```bash
cd apps/staff
flutter analyze
flutter test test/features/cath_lab
grep -rn "parity" ../../.github/workflows/*.yml | head -3
```

Run the parity command that grep names (it is the five-locale key check the Flutter CI halves run) and confirm it passes with the new keys.

- [ ] **Step 8: Commit**

```bash
git add apps/staff
git commit -m "feat(staff): cath reused-device capture, restriction strip, post-use actions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: Admin — CSSD Devices tab, catalogue field, reprocessing policy editor

**Files:**
- Create: `apps/admin/src/lib/api/cathDevices.ts`
- Create: `apps/admin/src/app/(with-auth)/dashboard/cssd/components/DevicesTab.tsx`, `DeviceActions.tsx`
- Modify: `apps/admin/src/app/(with-auth)/dashboard/cssd/page.tsx`
- Modify: `apps/admin/src/app/(with-auth)/dashboard/billing/cath-consumables/components/CatalogForm.tsx`
- Create: `apps/admin/src/app/(with-auth)/dashboard/quality/cath/components/ReprocessingPolicyTab.tsx`
- Modify: `apps/admin/src/app/(with-auth)/dashboard/quality/cath/page.tsx`
- Test: `apps/admin/src/__tests__/dashboard/cssd/devices.test.tsx`, `apps/admin/src/__tests__/dashboard/quality/cath-reprocessing.test.tsx`

- [ ] **Step 1: API module (core helpers, idempotency via attempt-key store)**

```ts
// apps/admin/src/lib/api/cathDevices.ts
//
// Cath reprocessable devices (CSSD queue) and reprocessing policy. Uses the
// core.ts helpers because every device transition requires an Idempotency-Key
// (scope cssd_device_transition) — fetchAdminAPI carries no headers.

import { assertIdempotencyKey, createAttemptKeyStore, payloadIdentity } from "../idempotencyKey";

import { getJSON, postJSON, putJSON } from "./core";

export const CSSD_DEVICE_STATUSES = [
  "awaiting_reprocessing", "in_cssd", "available", "in_case", "quarantined", "discarded",
] as const;
export const CATH_DEVICE_CYCLE_TYPES = ["steam", "eto", "plasma", "dry_heat", "chemical", "other"] as const;
export const CATH_DEVICE_DISCARD_REASONS = [
  "max_cycles_reached", "bloodborne_exposure", "late_reactive_marker", "function_check_failed",
  "sterilization_failed", "damaged", "wasted", "policy_change", "other",
] as const;
export const CATH_CATEGORIES = [
  "stent", "balloon", "guidewire", "catheter", "sheath", "closure_device", "pacemaker", "lead", "other",
] as const;
export const IMPLANT_CATEGORIES = new Set(["stent", "pacemaker", "lead", "closure_device"]);

export type CathDevice = {
  id: number;
  facility_id: number;
  catalog_item_id: number;
  device_tag: string;
  origin_usage_id: number;
  origin_unit_index: number;
  cycle_count: number;
  max_cycles_snapshot: number;
  status: (typeof CSSD_DEVICE_STATUSES)[number];
  current_usage_id: number | null;
  exposure_flag: boolean;
  exposure_markers: string[];
  last_reprocessed_at: string | null;
  last_cycle_type: string | null;
  last_function_check: string | null;
  quarantine_reason: string | null;
  discard_reason: string | null;
  discard_note: string | null;
  created_at: string;
  updated_at: string;
  item_name: string;
  category: string;
  manufacturer: string | null;
  model: string | null;
};

export type CathReprocessingSettings = {
  reactive_patient_rule: "discard" | "override_allowed";
  unknown_serology_rule: "warn" | "block_return";
  serology_validity_days: number;
  configured: boolean;
  reviewed_at?: string | null;
};

export type CathReprocessingPolicy = {
  category: string;
  reprocessable: boolean;
  max_cycles: number | null;
  allowed_cycle_types: string[];
  function_check_required: boolean;
};

const deviceKeys = createAttemptKeyStore("cssd-device");

function transitionHeaders(deviceId: number, action: string, body: unknown) {
  const key = deviceKeys.keyFor(payloadIdentity({ deviceId, action, body }));
  return { "Idempotency-Key": assertIdempotencyKey(key) };
}

/** Call after a transition settles (success or failure) so the next click is a new attempt. */
export function resetDeviceAttempt() {
  deviceKeys.reset();
}

export function listCssdDevices(params: { status?: string; facility_id?: number; limit?: number } = {}) {
  return getJSON<CathDevice[]>("/api/v1/cssd/devices", {
    status: params.status,
    facility_id: params.facility_id,
    limit: params.limit ?? 200,
  });
}

export function receiveCssdDevice(id: number) {
  return postJSON<CathDevice>(`/api/v1/cssd/devices/${id}/receive`, {}, true, transitionHeaders(id, "receive", {}));
}

export function markCssdDeviceReprocessed(id: number, body: { cycle_type: string; function_check_result?: string; note?: string }) {
  return postJSON<CathDevice>(`/api/v1/cssd/devices/${id}/reprocessed`, body, true, transitionHeaders(id, "reprocessed", body));
}

export function quarantineCssdDevice(id: number, body: { reason: string }) {
  return postJSON<CathDevice>(`/api/v1/cssd/devices/${id}/quarantine`, body, true, transitionHeaders(id, "quarantine", body));
}

export function releaseCssdDevice(id: number, body: { note?: string } = {}) {
  return postJSON<CathDevice>(`/api/v1/cssd/devices/${id}/release`, body, true, transitionHeaders(id, "release", body));
}

export function discardCssdDevice(id: number, body: { reason: string; note?: string }) {
  return postJSON<CathDevice>(`/api/v1/cssd/devices/${id}/discard`, body, true, transitionHeaders(id, "discard", body));
}

export function getCathReprocessingSettings() {
  return getJSON<{ settings: CathReprocessingSettings }>("/api/v1/admin/cath-consumables/reprocessing-settings");
}

export function updateCathReprocessingSettings(body: Partial<Pick<CathReprocessingSettings, "reactive_patient_rule" | "unknown_serology_rule" | "serology_validity_days">>) {
  return putJSON<{ settings: CathReprocessingSettings }>("/api/v1/admin/cath-consumables/reprocessing-settings", body);
}

export function listCathReprocessingPolicies() {
  return getJSON<{ policies: CathReprocessingPolicy[]; count: number }>("/api/v1/admin/cath-consumables/reprocessing-policies");
}

export function updateCathReprocessingPolicies(policies: CathReprocessingPolicy[]) {
  return putJSON<{ policies: CathReprocessingPolicy[]; count: number }>("/api/v1/admin/cath-consumables/reprocessing-policies", { policies });
}
```

If `getJSON`'s second parameter is not a query-params object in `core.ts` (read lines 234–247), build the query string the way `cssd.ts` does with `URLSearchParams` and pass the suffixed endpoint instead.

- [ ] **Step 2: Devices tab and actions**

```tsx
// apps/admin/src/app/(with-auth)/dashboard/cssd/components/DevicesTab.tsx
"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { CSSD_DEVICE_STATUSES, listCssdDevices, type CathDevice } from "@/lib/api/cathDevices";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { DeviceActionDialog, type DeviceAction } from "./DeviceActions";
import { StatusPill, fmtDate, humanize, inputClass } from "./helpers";

const ACTIONS_BY_STATUS: Record<string, DeviceAction[]> = {
  awaiting_reprocessing: ["receive", "reprocessed", "quarantine", "discard"],
  in_cssd: ["reprocessed", "quarantine", "discard"],
  available: ["quarantine", "discard"],
  quarantined: ["release", "discard"],
  in_case: [],
  discarded: [],
};

const ACTION_LABEL: Record<DeviceAction, string> = {
  receive: "Receive",
  reprocessed: "Mark reprocessed",
  quarantine: "Quarantine",
  release: "Release",
  discard: "Discard",
};

export function DevicesTab() {
  const [status, setStatus] = useState("awaiting_reprocessing");
  const [dialog, setDialog] = useState<{ device: CathDevice; action: DeviceAction } | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["cssd", "devices", { status }],
    queryFn: () => listCssdDevices({ status: status || undefined, limit: 200 }),
  });
  const devices = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Status</span>
          <select aria-label="Device status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {CSSD_DEVICE_STATUSES.map((option) => (
              <option key={option} value={option}>{humanize(option)}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => refetch()} disabled={isFetching}
          className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {isLoading && <LoadingSpinner label="Loading reprocessable devices" />}
      {error instanceof Error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">{error.message}</div>
      )}
      {!isLoading && !error && devices.length === 0 && (
        <div className="rounded-lg border border-border">
          <EmptyState title="No devices in this state" description="Devices arrive here when the cath lab sends a used catheter, wire, balloon or sheath for reprocessing." />
        </div>
      )}
      {!isLoading && !error && devices.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="p-3 text-left">Tag</th>
                <th className="p-3 text-left">Device</th>
                <th className="p-3 text-left">Cycle</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 text-left">Exposure</th>
                <th className="p-3 text-left">Updated</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id} className="border-t border-border">
                  <td className="p-3 font-mono text-xs">{device.device_tag}</td>
                  <td className="p-3">
                    <div className="font-medium">{device.item_name}</div>
                    <div className="text-xs text-muted-foreground">{humanize(device.category)}{device.manufacturer ? ` · ${device.manufacturer}` : ""}</div>
                  </td>
                  <td className="p-3 text-xs tabular-nums">{device.cycle_count} of {device.max_cycles_snapshot}</td>
                  <td className="p-3"><StatusPill status={device.status} /></td>
                  <td className="p-3 text-xs">
                    {device.exposure_flag ? (
                      <span className="rounded bg-rose-500/15 px-2 py-1 text-rose-700 dark:text-rose-300">{device.exposure_markers.join(", ") || "flagged"}</span>
                    ) : "—"}
                  </td>
                  <td className="p-3 text-xs">{fmtDate(device.updated_at)}</td>
                  <td className="p-3 text-right">
                    <div className="flex justify-end gap-1">
                      {(ACTIONS_BY_STATUS[device.status] ?? []).map((action) => (
                        <button key={action} type="button" aria-label={`${ACTION_LABEL[action]} ${device.device_tag}`}
                          onClick={() => setDialog({ device, action })}
                          className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted">
                          {ACTION_LABEL[action]}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog && <DeviceActionDialog device={dialog.device} action={dialog.action} onClose={() => setDialog(null)} />}
    </div>
  );
}
```

```tsx
// apps/admin/src/app/(with-auth)/dashboard/cssd/components/DeviceActions.tsx
"use client";

import {
  CATH_DEVICE_CYCLE_TYPES,
  CATH_DEVICE_DISCARD_REASONS,
  discardCssdDevice,
  markCssdDeviceReprocessed,
  quarantineCssdDevice,
  receiveCssdDevice,
  releaseCssdDevice,
  resetDeviceAttempt,
  type CathDevice,
} from "@/lib/api/cathDevices";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { DialogError, Field, Modal, errorMessage, humanize, inputClass } from "./helpers";

export type DeviceAction = "receive" | "reprocessed" | "quarantine" | "release" | "discard";

const TITLE: Record<DeviceAction, string> = {
  receive: "Receive device in CSSD",
  reprocessed: "Mark device reprocessed",
  quarantine: "Quarantine device",
  release: "Release device for reprocessing",
  discard: "Discard device",
};

export function DeviceActionDialog({ device, action, onClose }: { device: CathDevice; action: DeviceAction; onClose: () => void }) {
  const qc = useQueryClient();
  const [cycleType, setCycleType] = useState<string>("eto");
  const [functionCheck, setFunctionCheck] = useState<string>("");
  const [reason, setReason] = useState<string>(action === "discard" ? "other" : "");
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      switch (action) {
        case "receive": return receiveCssdDevice(device.id);
        case "reprocessed": return markCssdDeviceReprocessed(device.id, { cycle_type: cycleType, function_check_result: functionCheck || undefined, note: note.trim() || undefined });
        case "quarantine": return quarantineCssdDevice(device.id, { reason: reason.trim() });
        case "release": return releaseCssdDevice(device.id, { note: note.trim() || undefined });
        case "discard": return discardCssdDevice(device.id, { reason, note: note.trim() || undefined });
        default: throw new Error("Unknown action");
      }
    },
    onSuccess: (updated) => {
      resetDeviceAttempt();
      toast.success(`${updated.device_tag} is now ${humanize(updated.status)}`);
      qc.invalidateQueries({ queryKey: ["cssd", "devices"] });
      onClose();
    },
    onError: (err: unknown) => {
      resetDeviceAttempt();
      setFailure(errorMessage(err, "Could not update the device"));
    },
  });

  const disabled = run.isPending
    || (action === "quarantine" && reason.trim() === "")
    || (action === "discard" && reason === "");

  return (
    <Modal title={TITLE[action]} onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm">Cancel</button>
          <button type="button" aria-label="Confirm device action" disabled={disabled}
            onClick={() => { setFailure(null); run.mutate(); }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {run.isPending ? "Saving…" : TITLE[action]}
          </button>
        </>
      }>
      <DialogError message={failure} />
      <p className="text-sm text-muted-foreground">
        <span className="font-mono">{device.device_tag}</span> · {device.item_name} · cycle {device.cycle_count} of {device.max_cycles_snapshot}
        {device.exposure_flag ? " · exposure flagged" : ""}
      </p>
      {action === "reprocessed" && (
        <>
          <Field label="Cycle type">
            <select aria-label="Cycle type" className={inputClass} value={cycleType} onChange={(e) => setCycleType(e.target.value)}>
              {CATH_DEVICE_CYCLE_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
            </select>
          </Field>
          <Field label="Function check" hint="Required when the category policy demands it. Fail discards the device.">
            <select aria-label="Function check" className={inputClass} value={functionCheck} onChange={(e) => setFunctionCheck(e.target.value)}>
              <option value="">Not recorded</option>
              <option value="pass">Pass</option>
              <option value="fail">Fail</option>
            </select>
          </Field>
          <p className="text-xs text-muted-foreground">Print and affix the label with tag {device.device_tag} before the device leaves CSSD.</p>
        </>
      )}
      {action === "quarantine" && (
        <Field label="Reason">
          <input aria-label="Quarantine reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {action === "discard" && (
        <Field label="Reason">
          <select aria-label="Discard reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)}>
            {CATH_DEVICE_DISCARD_REASONS.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
          </select>
        </Field>
      )}
      {(action === "release" || action === "discard" || action === "reprocessed") && (
        <Field label="Note">
          <input aria-label="Note" className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}
```

In `cssd/page.tsx` add `{ id: "devices", label: "Devices" }` to `TABS`, `"devices"` to the `Tab` union, `import { DevicesTab } from "./components/DevicesTab";`, and `{tab === "devices" && <DevicesTab />}`. Update the header comment list with the two new components.

- [ ] **Step 3: Catalogue form field**

In `CatalogForm.tsx` add `reused_billing_item_code: string;` to `CatalogFormState`, initialise it from `item?.reused_billing_item_code ?? ""`, include it in the submitted payload next to `billing_item_code` (empty string → `null`), and render below the "Billing item code" field:

```tsx
            <FormField label="Reprocessed tariff code">
              <input
                aria-describedby="reused-billing-code-help"
                aria-label="Reprocessed tariff code"
                className="h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm"
                onChange={(event) => update("reused_billing_item_code", event.target.value)}
                placeholder="Service-master code for reuse"
                value={form.reused_billing_item_code}
              />
              <span id="reused-billing-code-help" className="mt-1 block text-xs text-muted-foreground">
                Billed instead of the item code when a reprocessed device is used (cycle 1 or later).
              </span>
            </FormField>
```

- [ ] **Step 4: Reprocessing policy tab**

```tsx
// apps/admin/src/app/(with-auth)/dashboard/quality/cath/components/ReprocessingPolicyTab.tsx
"use client";

import {
  CATH_CATEGORIES,
  CATH_DEVICE_CYCLE_TYPES,
  IMPLANT_CATEGORIES,
  getCathReprocessingSettings,
  listCathReprocessingPolicies,
  updateCathReprocessingPolicies,
  updateCathReprocessingSettings,
  type CathReprocessingPolicy,
  type CathReprocessingSettings,
} from "@/lib/api/cathDevices";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";

const inputClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";

export default function ReprocessingPolicyTab() {
  const qc = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["cath", "reprocessing", "settings"], queryFn: getCathReprocessingSettings });
  const policiesQuery = useQuery({ queryKey: ["cath", "reprocessing", "policies"], queryFn: listCathReprocessingPolicies });

  const [settings, setSettings] = useState<CathReprocessingSettings | null>(null);
  const [policies, setPolicies] = useState<CathReprocessingPolicy[]>([]);
  useEffect(() => { if (settingsQuery.data) setSettings(settingsQuery.data.settings); }, [settingsQuery.data]);
  useEffect(() => { if (policiesQuery.data) setPolicies(policiesQuery.data.policies); }, [policiesQuery.data]);

  const saveSettings = useMutation({
    mutationFn: () => updateCathReprocessingSettings({
      reactive_patient_rule: settings!.reactive_patient_rule,
      unknown_serology_rule: settings!.unknown_serology_rule,
      serology_validity_days: settings!.serology_validity_days,
    }),
    onSuccess: () => { toast.success("Reprocessing settings saved"); qc.invalidateQueries({ queryKey: ["cath", "reprocessing"] }); },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not save settings"),
  });
  const savePolicies = useMutation({
    mutationFn: () => updateCathReprocessingPolicies(policies),
    onSuccess: () => { toast.success("Category policies saved"); qc.invalidateQueries({ queryKey: ["cath", "reprocessing"] }); },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Could not save policies"),
  });

  function updatePolicy(category: string, patch: Partial<CathReprocessingPolicy>) {
    setPolicies((current) => current.map((p) => (p.category === category ? { ...p, ...patch } : p)));
  }

  if (!settings) return <p className="text-sm text-gray-500">Loading reprocessing policy…</p>;

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <h2 className="text-sm font-semibold">Blood-borne marker rules</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-xs">
            Reactive patient
            <select aria-label="Reactive patient rule" className={inputClass} value={settings.reactive_patient_rule}
              onChange={(e) => setSettings({ ...settings, reactive_patient_rule: e.target.value as CathReprocessingSettings["reactive_patient_rule"] })}>
              <option value="discard">Discard devices (default)</option>
              <option value="override_allowed">Reprocess with acknowledged override</option>
            </select>
          </label>
          <label className="block text-xs">
            Serology unknown
            <select aria-label="Unknown serology rule" className={inputClass} value={settings.unknown_serology_rule}
              onChange={(e) => setSettings({ ...settings, unknown_serology_rule: e.target.value as CathReprocessingSettings["unknown_serology_rule"] })}>
              <option value="warn">Warn and require acknowledgement (default)</option>
              <option value="block_return">Block until serology is recorded</option>
            </select>
          </label>
          <label className="block text-xs">
            Serology validity (days)
            <input aria-label="Serology validity days" type="number" min={1} max={365} className={inputClass} value={settings.serology_validity_days}
              onChange={(e) => setSettings({ ...settings, serology_validity_days: Number(e.target.value) })} />
          </label>
        </div>
        <button type="button" onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {saveSettings.isPending ? "Saving…" : "Save settings"}
        </button>
      </section>

      <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <h2 className="text-sm font-semibold">Reprocessable categories</h2>
        <p className="text-xs text-gray-500">Implant categories can never be reprocessed. Max cycles is the number of reprocessing cycles a device may undergo; a device is used on at most max cycles + 1 patients.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500"><tr><th className="p-2">Category</th><th className="p-2">Reprocessable</th><th className="p-2">Max cycles</th><th className="p-2">Cycle types</th><th className="p-2">Function check</th></tr></thead>
            <tbody>
              {CATH_CATEGORIES.map((category) => {
                const policy = policies.find((p) => p.category === category) ?? { category, reprocessable: false, max_cycles: null, allowed_cycle_types: [], function_check_required: false };
                const implant = IMPLANT_CATEGORIES.has(category);
                return (
                  <tr key={category} className="border-t border-gray-200 dark:border-gray-700">
                    <td className="p-2 capitalize">{category.replace(/_/g, " ")}</td>
                    <td className="p-2">
                      <input type="checkbox" aria-label={`${category} reprocessable`} disabled={implant} checked={policy.reprocessable}
                        onChange={(e) => updatePolicy(category, { reprocessable: e.target.checked })} />
                      {implant && <span className="ml-2 text-xs text-gray-500">implant</span>}
                    </td>
                    <td className="p-2">
                      <input type="number" min={1} max={50} aria-label={`${category} max cycles`} className={inputClass} disabled={!policy.reprocessable}
                        value={policy.max_cycles ?? ""} onChange={(e) => updatePolicy(category, { max_cycles: e.target.value === "" ? null : Number(e.target.value) })} />
                    </td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-2">
                        {CATH_DEVICE_CYCLE_TYPES.map((t) => (
                          <label key={t} className="flex items-center gap-1 text-xs">
                            <input type="checkbox" aria-label={`${category} allows ${t}`} disabled={!policy.reprocessable}
                              checked={policy.allowed_cycle_types.includes(t)}
                              onChange={(e) => updatePolicy(category, { allowed_cycle_types: e.target.checked ? [...new Set([...policy.allowed_cycle_types, t])] : policy.allowed_cycle_types.filter((x) => x !== t) })} />
                            {t}
                          </label>
                        ))}
                      </div>
                    </td>
                    <td className="p-2">
                      <input type="checkbox" aria-label={`${category} function check required`} disabled={!policy.reprocessable}
                        checked={policy.function_check_required} onChange={(e) => updatePolicy(category, { function_check_required: e.target.checked })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button type="button" onClick={() => savePolicies.mutate()} disabled={savePolicies.isPending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {savePolicies.isPending ? "Saving…" : "Save category policies"}
        </button>
      </section>
    </div>
  );
}
```

In `quality/cath/page.tsx` add `{ key: "reprocessing", label: "Reprocessing policy", icon: Recycle }` to `TABS` (import `Recycle` from `lucide-react`), import the tab, and render it: replace the ternary with `{activeTab === "dose" ? <DoseRollupTab /> : activeTab === "registry" ? <ComplicationRegistryTab /> : <ReprocessingPolicyTab />}`. When `policies` is saved, send ALL nine categories (the backend upserts the set it receives; unchanged rows are harmless).

- [ ] **Step 5: Admin tests**

```tsx
// apps/admin/src/__tests__/dashboard/cssd/devices.test.tsx
import { DevicesTab } from "@/app/(with-auth)/dashboard/cssd/components/DevicesTab";
import * as api from "@/lib/api/cathDevices";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/cathDevices", () => ({
  ...jest.requireActual("@/lib/api/cathDevices"),
  listCssdDevices: jest.fn(),
  markCssdDeviceReprocessed: jest.fn(),
  receiveCssdDevice: jest.fn(),
  resetDeviceAttempt: jest.fn(),
}));
jest.mock("react-hot-toast", () => ({ __esModule: true, toast: { success: jest.fn(), error: jest.fn() }, default: { success: jest.fn(), error: jest.fn() } }));

const DEVICE = {
  id: 1, facility_id: 1, catalog_item_id: 10, device_tag: "RP00000001", origin_usage_id: 5, origin_unit_index: 1,
  cycle_count: 0, max_cycles_snapshot: 3, status: "awaiting_reprocessing", current_usage_id: null,
  exposure_flag: true, exposure_markers: ["hbsag"], last_reprocessed_at: null, last_cycle_type: null,
  last_function_check: null, quarantine_reason: null, discard_reason: null, discard_note: null,
  created_at: "2026-09-04T06:00:00.000Z", updated_at: "2026-09-04T06:00:00.000Z",
  item_name: "Diagnostic catheter", category: "catheter", manufacturer: "Synthetic", model: "DX-5F",
} as const;

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><DevicesTab /></QueryClientProvider>);
}

describe("CSSD Devices tab", () => {
  beforeEach(() => {
    jest.mocked(api.listCssdDevices).mockResolvedValue([DEVICE as unknown as api.CathDevice]);
  });

  it("lists devices with tag, cycle and exposure markers, and offers the queue actions", async () => {
    renderTab();
    expect(await screen.findByText("RP00000001")).toBeInTheDocument();
    expect(screen.getByText("0 of 3")).toBeInTheDocument();
    expect(screen.getByText("hbsag")).toBeInTheDocument();
    expect(screen.getByLabelText("Mark reprocessed RP00000001")).toBeInTheDocument();
    expect(screen.queryByLabelText("Release RP00000001")).not.toBeInTheDocument();
  });

  it("marks a device reprocessed with the chosen cycle type", async () => {
    jest.mocked(api.markCssdDeviceReprocessed).mockResolvedValue({ ...DEVICE, status: "available", cycle_count: 1 } as unknown as api.CathDevice);
    renderTab();
    fireEvent.click(await screen.findByLabelText("Mark reprocessed RP00000001"));
    fireEvent.change(screen.getByLabelText("Cycle type"), { target: { value: "plasma" } });
    fireEvent.click(screen.getByLabelText("Confirm device action"));
    await waitFor(() => expect(api.markCssdDeviceReprocessed).toHaveBeenCalledWith(1, { cycle_type: "plasma", function_check_result: undefined, note: undefined }));
  });
});
```

```tsx
// apps/admin/src/__tests__/dashboard/quality/cath-reprocessing.test.tsx
import ReprocessingPolicyTab from "@/app/(with-auth)/dashboard/quality/cath/components/ReprocessingPolicyTab";
import * as api from "@/lib/api/cathDevices";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/cathDevices", () => ({
  ...jest.requireActual("@/lib/api/cathDevices"),
  getCathReprocessingSettings: jest.fn(),
  listCathReprocessingPolicies: jest.fn(),
  updateCathReprocessingPolicies: jest.fn(),
  updateCathReprocessingSettings: jest.fn(),
}));
jest.mock("react-hot-toast", () => ({ __esModule: true, toast: { success: jest.fn(), error: jest.fn() }, default: { success: jest.fn(), error: jest.fn() } }));

describe("Reprocessing policy tab", () => {
  beforeEach(() => {
    jest.mocked(api.getCathReprocessingSettings).mockResolvedValue({ settings: { reactive_patient_rule: "discard", unknown_serology_rule: "warn", serology_validity_days: 90, configured: false } });
    jest.mocked(api.listCathReprocessingPolicies).mockResolvedValue({ policies: [], count: 0 });
    jest.mocked(api.updateCathReprocessingPolicies).mockResolvedValue({ policies: [], count: 0 });
  });

  it("disables the reprocessable toggle for implant categories and saves the full set", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ReprocessingPolicyTab /></QueryClientProvider>);
    expect(await screen.findByLabelText("stent reprocessable")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("catheter reprocessable"));
    fireEvent.change(screen.getByLabelText("catheter max cycles"), { target: { value: "3" } });
    fireEvent.click(screen.getByLabelText("catheter allows eto"));
    fireEvent.click(screen.getByText("Save category policies"));
    await waitFor(() => expect(api.updateCathReprocessingPolicies).toHaveBeenCalled());
    const sent = jest.mocked(api.updateCathReprocessingPolicies).mock.calls[0][0];
    expect(sent.find((p) => p.category === "catheter")).toMatchObject({ reprocessable: true, max_cycles: 3, allowed_cycle_types: ["eto"] });
  });
});
```

Note: `policies` in the component starts empty until the query resolves; `CATH_CATEGORIES.map` falls back to a default policy per row, and `updatePolicy` on a category not yet in `policies` must add it. Adjust `updatePolicy` to `setPolicies((current) => current.some((p) => p.category === category) ? current.map(...) : [...current, { category, reprocessable: false, max_cycles: null, allowed_cycle_types: [], function_check_required: false, ...patch }])`, and when saving, send `CATH_CATEGORIES.map((c) => policies.find((p) => p.category === c) ?? defaultPolicy(c))`.

- [ ] **Step 6: Admin gates and commit**

```bash
cd apps/admin
npm run type-check
npm run lint
npm run format:check
npm test -- --testPathPattern "cssd|quality/cath|cath-consumables"
git add apps/admin
git commit -m "feat(admin): CSSD device queue, reprocessed tariff code, cath reprocessing policy editor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

`type-check` and `test` regenerate `src/lib/openapi.generated.ts` from the backend `openapi.json` first; the backend commit from Task 4 must be in the same branch.

---

## Task 8: Gates and hand-back

- [ ] **Step 1: Backend**

```bash
cd apps/backend
npm run lint
npm test -- --testPathPatterns unit/
DATABASE_URL=… npm test -- --testPathPatterns "cath-device-reuse.deep|cath-consumables.deep|cath-inventory|bloodborne-markers.deep"
npm run openapi:check && npm run check:migration-numbers && npm run check:migration-immutability
DATABASE_URL=… node scripts/check-schema-drift.mjs
cd ../.. && node scripts/ci/security.mjs
```

Read the jest summary for `Suites failed` separately from `Tests passed`.

- [ ] **Step 2: Staff and Admin** — repeat Task 6 Step 7 and Task 7 Step 6.

- [ ] **Step 3: Re-check the migration number against every open branch** (Task 0 Step 2). Renumber and amend the migration commit if 766 is now claimed.

- [ ] **Step 4: Push and open the DRAFT PR**

```bash
git commit --allow-empty -m "chore(ci): [full-ci] cath device reuse

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u github feat/cath-device-reuse
gh pr create --repo Bahuleyandr/VH-Health-Platform --draft --base main --head feat/cath-device-reuse --title "feat: cath-lab device reuse — register, policy, CSSD queue, reduced tariff, blood-borne restriction" --body-file <body>
```

The PR body states: spec path; that migrations 753 and 758 are untouched and the assert function is re-declared from 758's text with one added branch; the `NOT VALID` re-add and its validation plan; that ballot 753-D1 remains undecided and now concerns new units only; the deep suites run with counts; the OpenAPI regeneration; the Staff string keys added in all five locales and that they await linguistic review under OPEN-21; the pharmacy caution acknowledged; `Merge Gate` and `Full Merge Gate` by name with the head SHA once the canonical run lands. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Merge authority stays with the coordinating session; do not mark ready.

- [ ] **Step 5: Drop the scratch DB** — `dropdb -h 127.0.0.1 -p 55432 vh_cdr_<initials>`.

---

## Self-review against the spec

- §5.2–§5.4 tables, constraints, transitions: Task 1 (schema), Task 2 (`DEVICE_ACTIONS`, transitions, policy validation incl. implant forbiddance), Task 3 (`release` → `awaiting_reprocessing` only; discard reasons).
- §5.5 usage columns, `reused_device` status, shape check, NOT VALID re-add with plan: Task 1.
- §5.6 catalogue code: Task 1 + Task 5.
- §6.1 first use unchanged; §6.2 reused capture with each error code: Task 3 Step 2 + `captureReusedDeviceTx`.
- §6.3 post-use rules for every serology × rule combination, units, idempotent replay: Task 2 (`computePostUseOptions`) + Task 3 (`recordPostUse`).
- §6.4 CSSD queue actions and label print: Task 2 (transitions), Task 4 (routes), Task 7 (tab + dialog; label text names the tag).
- §6.5 wasted reused device → discarded: the capture path records `wasted` today; the device discard on wasted reuse happens in `recordPostUse` with `discard_reason = wasted`, or add to `markDeviceInCaseTx` a `wasted` branch that discards instead of marking in-case. **Gap found in review:** add to Task 3 Step 2 (i): when `reused && wasted`, call `applyDeviceTransitionTx(tx, reused.device, 'discard', { discardReason: 'wasted', discardNote: wasteReason }, context)` instead of `markDeviceInCaseTx`, and set `post_use_disposition = 'discarded_wasted'` on the usage row in the same statement that stamps the timeline ids. Include a deep test: reused capture with `wasted: true` leaves the device `discarded`.
- §6.6 late reactive result: Task 3 (`quarantineDevicesExposedToPatient`, registered as an exposure handler; CDS alert; infection-control notifications).
- §7.4 evidence freezing (`reuse_screen`, `post_use_screen`): Task 3.
- §7.5 overrides → `medication_safety_reviews`: Task 3 (`recordReuseSafetyReview`, three finding codes).
- §8 contract migration: Task 1.
- §9 routes with roles and idempotency scopes: Task 4. §9.2's marker routes are Plan 1.
- §10 billing at both call sites, gap reason: Task 5.
- §11 client scope: Task 6 (Staff), Task 7 (Admin).
- §12 error codes: every code named in the spec table is thrown by name in Tasks 2–3 (`CATH_CONSUMABLE_REUSE_FIELDS_CONFLICT`, `CATH_DEVICE_NOT_FOUND`, `CATH_DEVICE_CATALOG_MISMATCH`, `CATH_DEVICE_FACILITY_MISMATCH`, `CATH_DEVICE_NOT_AVAILABLE`, `CATH_DEVICE_EXPOSURE_BLOCKED`, `CATH_DEVICE_ACKNOWLEDGEMENT_REQUIRED`, `CATH_REPROCESSING_NOT_ALLOWED`, `CATH_REPROCESSING_SEROLOGY_REQUIRED`, `CATH_DEVICE_MAX_CYCLES_REACHED`, `CATH_DEVICE_UNITS_EXCEED_QUANTITY`, `CATH_DEVICE_INVALID_TRANSITION`, `CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED`).
- §15 testing and gates: Tasks 2–8. Mutation checks: Task 3 Step 5.
- §16 dark by default: no policy rows → `computePostUseOptions` returns `not_reprocessable`; reused capture refuses with `CATH_REPROCESSING_NOT_ALLOWED`.
- Type consistency: `computePostUseOptions` is called with `{ usage, category, isImplant, policy, settings, restriction, device }` in Task 2's test, Task 3's `decorateConsumablesWithReuse` and `recordPostUse` alike; `applyDeviceTransitionTx(tx, device, action, patch, context)` is the one signature used by every transition; the Staff `CathPostUseDraft.toJson()` emits the same keys `CathPostUseRequest` declares in Task 4.
