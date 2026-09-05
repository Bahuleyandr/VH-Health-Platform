# Cath Pre-Procedure Lab Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cath case's `labs` readiness check tick itself when Hb, platelets, creatinine, potassium, HIV, HBsAg and HCV results exist, show a persistent "critical value" warning beside the tick, name exactly what is missing (never ordered, or ordered and awaiting), offer a one-tap order for the gaps, and let cath staff record outside-lab values as external lab results from the checklist only.

**Architecture:** Two new tables (`cath_lab_readiness_settings`, `cath_case_lab_readiness_items`) and four nullable columns on `lab_results` (`result_origin`, `external_lab_name`, `external_report_ref`, `external_reported_on`). A new `cathLabReadinessService.js` resolves the seven items from lab results, open orders and specimens, persists them, and applies the check-level rule to the existing `labs` row (automation only alters rows it set itself). The lab service gains an internal `allowUnlinkedExternal` escape in `recordResultManual` and post-commit refresh hooks. Staff gets the per-check readiness list it never had, with the labs expansion and actions; Admin gets a settings editor.

**Tech Stack:** Node 26 ESM backend, Postgres 17 RLS, jest ESM, OpenAPI overlays; Flutter Staff app; Next.js Admin.

**Spec:** `docs/superpowers/specs/2026-09-04-cath-pre-procedure-lab-readiness-design.md`. **Depends on Plan 1** (`labAnalyteCodes.js`, `bloodborneMarkerService.js`). Reads `cath_reprocessing_settings.serology_validity_days` from Plan 2 when that table exists, else defaults to 90, so it does not depend on Plan 2 landing first.

**Base:** `github/main` after the Plan 1 PR merges (branch `feat/cath-lab-readiness`).

---

## Conventions

All of Plan 1's conventions apply (tenant transactions, raw SQL, `AppError`, npm-run jest, immutable migrations, schema drift mirror, scratch DB, commit trailer, `[full-ci]`, draft PR, no merge). Plus:

- **Never change the eight `check_type` values** (482:94). `labs` stays the single check; items live in the new table.
- **Automation only alters rows it set itself**: every automated write to `cath_lab_readiness_checks` sets `metadata.auto_managed = true`; a row whose `metadata.auto_managed` is not `true` and whose status is not `pending` is never changed by automation.
- **A critical value never blocks.** It sets `critical_warning`; it never changes status. This is the owner's decision (spec §2).
- **Outside values enter only through the cath checklist route.** The public lab route keeps rejecting `result_origin` and unlinked results.
- **Migration number**: computed against `github/main` and every open branch at write time (the loop in Plan 1 Task 0 Step 2). This plan uses **766**; substitute if claimed and re-check before push.

---

## File structure

| File | Responsibility |
|---|---|
| Create `apps/backend/src/migrations/766_cath_lab_readiness.sql` | Settings, items, `lab_results` origin columns. |
| Modify `apps/backend/prisma/schema.prisma` | Mirror. |
| Create `apps/backend/src/services/clinical/cathLabReadinessService.js` | Settings, pure resolution rules, refresh + persistence, check-level automation, order-missing, external result entry, waive, refresh-on-lab-event. |
| Create `apps/backend/src/tests/unit/cathLabReadinessService.test.js` | Pure rules. |
| Create `apps/backend/src/tests/cath-lab-readiness.deep.test.js` | DB behaviour. |
| Modify `apps/backend/src/services/lab/labResultsService.js` | `recordResultManual` gains `allowUnlinkedExternal`/origin handling; post-commit refresh hooks in `recordResultManual`, `signOffResults` and the ORU ingest path. |
| Modify `apps/backend/src/services/lab/labPanelService.js` | Writes `result_origin = 'manual_in_house'`; post-commit refresh hook. |
| Modify `apps/backend/src/routes/lab/labRoutes.js` | Reject `result_origin` on the public manual route. |
| Modify `apps/backend/src/services/clinical/cathLabService.js` | `getCase` carries `lab_readiness`; `updateReadinessCheck` writes the safety review on a human pass over a critical warning. |
| Modify `apps/backend/src/routes/clinical/cathLabRoutes.js` | Four readiness routes; evidence refresh includes labs. |
| Modify `apps/backend/src/routes/admin/cathConsumablesRoutes.js` | `GET/PUT /lab-readiness-settings`. |
| Create `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs`; modify `generate-openapi.mjs`, `lab.mjs` (result_origin fields) | Contracts. |
| Staff: create `features/cath_lab/models/cath_readiness_models.dart`, `widgets/cath_readiness_checklist.dart`, `widgets/cath_lab_readiness_panel.dart`, `widgets/cath_external_result_sheet.dart`; modify `cath_lab_api_service.dart`, `screens/cath_lab_screen.dart`, `l10n/app_strings.dart`; tests | Per-check list, labs expansion, actions. |
| Admin: create `dashboard/quality/cath/components/LabReadinessSettingsTab.tsx`; modify `lib/api/cathDevices.ts` (settings functions), `quality/cath/page.tsx`; test | Settings editor. |

---

## Task 0: Branch, worktree, migration number

Same as Plan 2 Task 0 with `feat/cath-lab-readiness`, worktree `$SCRATCH/wt/readiness`, scratch DB `vh_clr_<initials>`, and the expectation that the number loop's tail shows `765` (Plan 2, if pushed) so this plan uses **766**.

---

## Task 1: Migration 766

**Files:**
- Create: `apps/backend/src/migrations/766_cath_lab_readiness.sql`
- Modify: `apps/backend/prisma/schema.prisma`

- [ ] **Step 1: Write the migration**

```sql
-- 766_cath_lab_readiness.sql
--
-- Cath-lab pre-procedure lab readiness
-- (docs/superpowers/specs/2026-09-04-cath-pre-procedure-lab-readiness-design.md).
-- The `labs` readiness check on a cath case was a bare human tick: nothing said
-- whether Hb, platelets, creatinine, potassium or serology existed, were never
-- ordered, or were awaiting a result; and a value from an outside laboratory had
-- no home because manual lab entry requires an in-house order and cannot name
-- the external lab (labResultsService.recordResultManual).
--
-- Forward-only additions:
--   * cath_lab_readiness_settings      — per tenant: required items, validity window,
--                                        auto-pass, whether external results count
--   * cath_case_lab_readiness_items    — persisted snapshot of the seven items per case
--   * lab_results.result_origin / external_lab_name / external_report_ref /
--     external_reported_on             — provenance for outside-lab values; nullable so
--                                        legacy rows are untouched
-- The eight cath_lab_readiness_checks.check_type values are unchanged; `labs`
-- remains the single check and its automation writes only to rows it set itself.
-- No NOT VALID constraints. Every CHECK is named.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

CREATE TABLE cath_lab_readiness_settings (
  tenant_id UUID PRIMARY KEY DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ) REFERENCES tenants(id) ON DELETE CASCADE,
  required_items TEXT[] NOT NULL DEFAULT ARRAY['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv']::text[],
  lab_validity_days INTEGER NOT NULL DEFAULT 30,
  auto_pass BOOLEAN NOT NULL DEFAULT TRUE,
  external_results_count BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT cath_lab_readiness_settings_items_check
    CHECK (required_items <@ ARRAY['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv']::text[]),
  CONSTRAINT cath_lab_readiness_settings_validity_check
    CHECK (lab_validity_days BETWEEN 1 AND 365)
);

CREATE TABLE cath_case_lab_readiness_items (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  case_id BIGINT NOT NULL REFERENCES cath_lab_cases(id) ON DELETE CASCADE,
  item_code VARCHAR(20) NOT NULL,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  state VARCHAR(32) NOT NULL,
  value_text VARCHAR(255),
  value_numeric NUMERIC(15, 4),
  unit VARCHAR(40),
  abnormal_flag VARCHAR(10),
  is_critical BOOLEAN NOT NULL DEFAULT FALSE,
  observed_at TIMESTAMPTZ(6),
  source VARCHAR(24),
  lab_result_id INTEGER REFERENCES lab_results(id) ON DELETE SET NULL,
  investigation_id INTEGER,
  specimen_id INTEGER REFERENCES lab_specimens(id) ON DELETE SET NULL,
  ordered_at TIMESTAMPTZ(6),
  waived_by UUID,
  waived_at TIMESTAMPTZ(6),
  waive_reason TEXT,
  refreshed_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT cath_case_lab_readiness_items_code_check
    CHECK (item_code IN ('hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv')),
  CONSTRAINT cath_case_lab_readiness_items_state_check
    CHECK (state IN ('result_final', 'result_preliminary', 'external_recorded', 'sample_sent_awaiting_result',
                     'ordered_awaiting_sample', 'not_ordered', 'stale', 'waived')),
  CONSTRAINT cath_case_lab_readiness_items_source_check
    CHECK (source IS NULL OR source IN ('lab_result', 'external', 'waiver')),
  CONSTRAINT cath_case_lab_readiness_items_waiver_check
    CHECK ((state <> 'waived') OR (waived_by IS NOT NULL AND waived_at IS NOT NULL AND waive_reason IS NOT NULL)),
  CONSTRAINT ux_cath_case_lab_readiness_items UNIQUE (tenant_id, case_id, item_code)
);

CREATE INDEX idx_cath_case_lab_readiness_items_case ON cath_case_lab_readiness_items (tenant_id, case_id);

ALTER TABLE lab_results
  ADD COLUMN result_origin VARCHAR(20),
  ADD COLUMN external_lab_name VARCHAR(160),
  ADD COLUMN external_report_ref VARCHAR(120),
  ADD COLUMN external_reported_on DATE;

ALTER TABLE lab_results
  ADD CONSTRAINT lab_results_result_origin_check
    CHECK (result_origin IS NULL OR result_origin IN ('analyzer', 'manual_in_house', 'external_lab')),
  ADD CONSTRAINT lab_results_external_origin_check
    CHECK (result_origin IS DISTINCT FROM 'external_lab'
           OR (external_lab_name IS NOT NULL AND external_reported_on IS NOT NULL));

CREATE INDEX idx_lab_results_external_origin ON lab_results (tenant_id, patient_uid, result_origin)
  WHERE result_origin = 'external_lab';

ALTER TABLE cath_lab_readiness_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_lab_readiness_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cath_lab_readiness_settings;
CREATE POLICY tenant_isolation ON cath_lab_readiness_settings
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

ALTER TABLE cath_case_lab_readiness_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cath_case_lab_readiness_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cath_case_lab_readiness_items;
CREATE POLICY tenant_isolation ON cath_case_lab_readiness_items
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

COMMIT;
```

- [ ] **Step 2: Apply, mirror, gate**

```bash
cd apps/backend
DATABASE_URL=postgres://…/vh_clr_<initials> node scripts/ci-setup-db.mjs
psql "$DATABASE_URL" -c "SELECT conname FROM pg_constraint WHERE conrelid IN ('cath_lab_readiness_settings'::regclass, 'cath_case_lab_readiness_items'::regclass) AND contype = 'c' ORDER BY 1;"
psql "$DATABASE_URL" -c "SELECT conname FROM pg_constraint WHERE conrelid = 'lab_results'::regclass AND conname LIKE 'lab_results_%origin%';"
```

Expected: six named CHECKs on the two new tables; two on `lab_results`. Mirror in `schema.prisma` via `prisma db pull --print` (two new models, four new `lab_results` fields, back-relations on `tenants`, `cath_lab_cases`, `lab_results`, `lab_specimens`), then `node scripts/check-schema-drift.mjs && npm run db:generate && npm run check:migration-numbers && npm run check:migration-session-guc && node ../../scripts/ci/check-inline-check-census.mjs`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/migrations/766_cath_lab_readiness.sql apps/backend/prisma/schema.prisma
git commit -m "feat(db): cath lab readiness items/settings and lab_results origin columns (mig 766)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: Pure resolution rules (TDD)

**Files:**
- Create: `apps/backend/src/services/clinical/cathLabReadinessService.js` (pure part)
- Test: `apps/backend/src/tests/unit/cathLabReadinessService.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// apps/backend/src/tests/unit/cathLabReadinessService.test.js
import {
  ITEM_CODES,
  SETTINGS_DEFAULTS,
  computeCheckDecision,
  isCriticalResult,
  resolveItemState,
} from '../../services/clinical/cathLabReadinessService.js';

const AS_OF = new Date('2026-09-04T10:00:00.000Z');
const daysAgo = (n) => new Date(AS_OF.getTime() - n * 86_400_000).toISOString();
const settings = { ...SETTINGS_DEFAULTS };

describe('resolveItemState', () => {
  const base = { item: 'potassium', windowDays: 30, asOf: AS_OF, results: [], orders: [], specimens: [] };

  test('no result, no order -> not_ordered', () => {
    expect(resolveItemState(base)).toMatchObject({ state: 'not_ordered', lab_result_id: null, investigation_id: null });
  });

  test('final signed result within window -> result_final with copied values', () => {
    const out = resolveItemState({ ...base, results: [
      { id: 7, test_code: 'K', value_text: '6.1', value_numeric: 6.1, unit: 'mmol/L', abnormal_flag: 'HH', is_critical: true, status: 'final', signed_off_at: daysAgo(1), performed_at: daysAgo(1), received_at: daysAgo(1), result_origin: 'analyzer' },
    ] });
    expect(out).toMatchObject({ state: 'result_final', lab_result_id: 7, value_numeric: 6.1, abnormal_flag: 'HH', is_critical: true, source: 'lab_result' });
  });

  test('preliminary result -> result_preliminary; external origin -> external_recorded', () => {
    expect(resolveItemState({ ...base, results: [{ id: 8, test_code: 'K', value_text: '4.0', status: 'preliminary', signed_off_at: null, performed_at: daysAgo(2), received_at: daysAgo(2), result_origin: 'manual_in_house' }] }).state).toBe('result_preliminary');
    expect(resolveItemState({ ...base, results: [{ id: 9, test_code: 'K', value_text: '4.0', status: 'preliminary', signed_off_at: null, performed_at: daysAgo(2), received_at: daysAgo(2), result_origin: 'external_lab' }] }).state).toBe('external_recorded');
  });

  test('latest result wins; cancelled rows are ignored', () => {
    const out = resolveItemState({ ...base, results: [
      { id: 1, test_code: 'K', value_text: '3.0', status: 'final', signed_off_at: daysAgo(5), performed_at: daysAgo(5), received_at: daysAgo(5) },
      { id: 2, test_code: 'K', value_text: '9.9', status: 'cancelled', signed_off_at: null, performed_at: daysAgo(1), received_at: daysAgo(1) },
      { id: 3, test_code: 'K', value_text: '4.2', status: 'final', signed_off_at: daysAgo(2), performed_at: daysAgo(2), received_at: daysAgo(2) },
    ] });
    expect(out.lab_result_id).toBe(3);
  });

  test('result older than the window with no open order -> stale, keeping the old value', () => {
    const out = resolveItemState({ ...base, results: [{ id: 4, test_code: 'K', value_text: '4.1', status: 'final', signed_off_at: daysAgo(40), performed_at: daysAgo(40), received_at: daysAgo(40) }] });
    expect(out).toMatchObject({ state: 'stale', lab_result_id: 4, value_text: '4.1' });
  });

  test('open order without collection -> ordered_awaiting_sample; with collection -> sample_sent_awaiting_result', () => {
    expect(resolveItemState({ ...base, orders: [{ id: 11, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: daysAgo(1), collected_at: null }] }))
      .toMatchObject({ state: 'ordered_awaiting_sample', investigation_id: 11 });
    expect(resolveItemState({ ...base, orders: [{ id: 12, test_code: 'ELECTROLYTES', status: 'IN_PROGRESS', requested_at: daysAgo(1), collected_at: daysAgo(0.5) }] }))
      .toMatchObject({ state: 'sample_sent_awaiting_result', investigation_id: 12 });
  });

  test('specimen state decides when present: in_transit -> sample_sent_awaiting_result even with collected_at null', () => {
    const out = resolveItemState({ ...base,
      orders: [{ id: 13, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: daysAgo(1), collected_at: null, booking_id: 99 }],
      specimens: [{ id: 5, booking_id: 99, status: 'in_transit' }],
    });
    expect(out).toMatchObject({ state: 'sample_sent_awaiting_result', specimen_id: 5 });
  });

  test('an open order beats a stale result', () => {
    const out = resolveItemState({ ...base,
      results: [{ id: 4, test_code: 'K', value_text: '4.1', status: 'final', signed_off_at: daysAgo(40), performed_at: daysAgo(40), received_at: daysAgo(40) }],
      orders: [{ id: 14, test_code: 'ELECTROLYTES', status: 'REQUESTED', requested_at: daysAgo(1), collected_at: null }],
    });
    expect(out.state).toBe('ordered_awaiting_sample');
  });

  test('hb resolves from HGB rows and CBC orders; hbsag from HBSAG rows and orders', () => {
    expect(resolveItemState({ ...base, item: 'hb', orders: [{ id: 15, test_code: 'CBC', status: 'REQUESTED', requested_at: daysAgo(1), collected_at: null }] }).state).toBe('ordered_awaiting_sample');
    expect(resolveItemState({ ...base, item: 'hbsag', windowDays: 90, results: [{ id: 16, test_code: 'HBSAG', value_text: 'Non-reactive', status: 'final', signed_off_at: daysAgo(3), performed_at: daysAgo(3), received_at: daysAgo(3) }] }).state).toBe('result_final');
  });

  test('a waiver overrides everything', () => {
    const out = resolveItemState({ ...base, waiver: { waived_by: 'u', waived_at: daysAgo(0), waive_reason: 'dialysis patient, K managed' } });
    expect(out.state).toBe('waived');
  });
});

describe('isCriticalResult', () => {
  test.each([
    [{ is_critical: true, abnormal_flag: 'H' }, true],
    [{ is_critical: false, abnormal_flag: 'HH' }, true],
    [{ is_critical: false, abnormal_flag: 'LL' }, true],
    [{ is_critical: false, abnormal_flag: 'AA' }, true],
    [{ is_critical: false, abnormal_flag: 'H' }, false],
    [{ is_critical: false, abnormal_flag: null }, false],
  ])('%p -> %s', (row, expected) => {
    expect(isCriticalResult(row)).toBe(expected);
  });
});

describe('computeCheckDecision', () => {
  const item = (code, state, extra = {}) => ({ item_code: code, required: true, state, is_critical: false, abnormal_flag: null, ...extra });
  const allAvailable = ITEM_CODES.map((c) => item(c, 'result_final'));
  const pendingCheck = { status: 'pending', metadata: {} };
  const autoPassCheck = { status: 'pass', metadata: { auto_managed: true } };
  const humanPassCheck = { status: 'pass', metadata: {}, completed_by: 'u' };
  const caseOpen = { actual_start_at: null };
  const caseStarted = { actual_start_at: '2026-09-04T09:00:00Z' };

  test('all required items available + pending check -> pass, no critical warning', () => {
    expect(computeCheckDecision({ items: allAvailable, settings, check: pendingCheck, caseRow: caseOpen }))
      .toEqual({ nextStatus: 'pass', criticalWarning: false, criticalItems: [], missing: [], autoPendingReason: null });
  });

  test('critical potassium still passes, with the warning naming the item', () => {
    const items = allAvailable.map((i) => (i.item_code === 'potassium' ? { ...i, is_critical: true, abnormal_flag: 'HH' } : i));
    const out = computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen });
    expect(out.nextStatus).toBe('pass');
    expect(out.criticalWarning).toBe(true);
    expect(out.criticalItems).toEqual(['potassium']);
  });

  test('external_recorded counts when the policy allows it, and not otherwise', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hcv' ? { ...i, state: 'external_recorded' } : i));
    expect(computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen }).nextStatus).toBe('pass');
    expect(computeCheckDecision({ items, settings: { ...settings, external_results_count: false }, check: pendingCheck, caseRow: caseOpen }).nextStatus).toBeNull();
  });

  test('a missing required item leaves a pending check pending and lists it', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hbsag' ? { ...i, state: 'sample_sent_awaiting_result' } : i));
    const out = computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen });
    expect(out.nextStatus).toBeNull();
    expect(out.missing).toEqual([{ item: 'hbsag', state: 'sample_sent_awaiting_result' }]);
  });

  test('an auto-managed pass flips back to pending when an item goes missing before start, not after', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hb' ? { ...i, state: 'stale' } : i));
    const before = computeCheckDecision({ items, settings, check: autoPassCheck, caseRow: caseOpen });
    expect(before.nextStatus).toBe('pending');
    expect(before.autoPendingReason).toBe('hb stale');
    expect(computeCheckDecision({ items, settings, check: autoPassCheck, caseRow: caseStarted }).nextStatus).toBeNull();
  });

  test('a human pass is never altered by automation', () => {
    const items = allAvailable.map((i) => (i.item_code === 'hb' ? { ...i, state: 'not_ordered' } : i));
    expect(computeCheckDecision({ items, settings, check: humanPassCheck, caseRow: caseOpen }).nextStatus).toBeNull();
  });

  test('auto_pass off never sets pass; not-required items are ignored; waived counts as available', () => {
    expect(computeCheckDecision({ items: allAvailable, settings: { ...settings, auto_pass: false }, check: pendingCheck, caseRow: caseOpen }).nextStatus).toBeNull();
    const items = allAvailable.map((i) => (i.item_code === 'hcv' ? { ...i, required: false, state: 'not_ordered' } : i.item_code === 'hiv' ? { ...i, state: 'waived' } : i));
    expect(computeCheckDecision({ items, settings, check: pendingCheck, caseRow: caseOpen }).nextStatus).toBe('pass');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --testPathPatterns unit/cathLabReadinessService`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the pure part**

```js
// apps/backend/src/services/clinical/cathLabReadinessService.js
//
// Pre-procedure lab readiness for cath cases. Spec:
// docs/superpowers/specs/2026-09-04-cath-pre-procedure-lab-readiness-design.md
//
// Seven items under the existing `labs` readiness check, resolved from
// lab_results, open investigations/bookings and lab_specimens. Automation
// passes the check on availability and flips it back only if it set it; a
// critical value warns and never blocks (owner decision).

import prisma, { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  BLOODBORNE_MARKER_ITEM_CODES,
  LAB_ANALYTE_ITEMS,
  LAB_ANALYTE_ITEM_CODES,
  analyteItemForResult,
  orderCodesCovering,
} from '../lab/labAnalyteCodes.js';
import { recordMarkers, normalizeSerologyValue } from './bloodborneMarkerService.js';
import { recordMedicationSafetyReviews } from './canonicalClinicalPlatformService.js';

export const ITEM_CODES = LAB_ANALYTE_ITEM_CODES;
export const ITEM_STATES = Object.freeze([
  'result_final', 'result_preliminary', 'external_recorded', 'sample_sent_awaiting_result',
  'ordered_awaiting_sample', 'not_ordered', 'stale', 'waived',
]);
export const AVAILABLE_STATES = Object.freeze(['result_final', 'result_preliminary', 'waived']);
export const SETTINGS_DEFAULTS = Object.freeze({
  required_items: [...ITEM_CODES],
  lab_validity_days: 30,
  auto_pass: true,
  external_results_count: true,
});
export const DEFAULT_SEROLOGY_VALIDITY_DAYS = 90;

const SIGNED_STATUSES = new Set(['final', 'corrected', 'amended', 'verified']);
const OPEN_ORDER_STATUSES_EXCLUDED = new Set(['COMPLETED', 'CANCELLED']);
const SPECIMEN_SENT_STATES = new Set(['collected', 'in_transit', 'received', 'processing']);
const CRITICAL_FLAGS = new Set(['HH', 'LL', 'AA']);

export function isCriticalResult(row) {
  return Boolean(row?.is_critical) || CRITICAL_FLAGS.has(String(row?.abnormal_flag || '').toUpperCase());
}

function observedAt(row) {
  return row.performed_at || row.received_at || null;
}

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : NaN;
}

function withinWindow(value, asOf, windowDays) {
  const ms = toMs(value);
  return Number.isFinite(ms) && (asOf.getTime() - ms) <= windowDays * 86_400_000;
}

function matchesItem(item, row) {
  return analyteItemForResult(row) === item;
}

function orderCoversItem(item, order) {
  const code = String(order.test_code || '').trim().toUpperCase();
  return LAB_ANALYTE_ITEMS[item].orderCodes.includes(code);
}

// One item's state from the patient's rows. Pure; the caller fetches rows.
export function resolveItemState({
  item,
  results = [],
  orders = [],
  specimens = [],
  waiver = null,
  windowDays,
  asOf = new Date(),
}) {
  const base = {
    item_code: item, state: 'not_ordered', value_text: null, value_numeric: null, unit: null,
    abnormal_flag: null, is_critical: false, observed_at: null, source: null, lab_result_id: null,
    investigation_id: null, specimen_id: null, ordered_at: null,
  };
  if (waiver) {
    return { ...base, state: 'waived', source: 'waiver', waived_by: waiver.waived_by, waived_at: waiver.waived_at, waive_reason: waiver.waive_reason };
  }

  const candidates = results
    .filter((row) => matchesItem(item, row) && String(row.status || '').toLowerCase() !== 'cancelled')
    .sort((a, b) => (toMs(observedAt(b)) - toMs(observedAt(a))) || (Number(b.id) - Number(a.id)));
  const latest = candidates[0] || null;
  const latestFresh = latest && withinWindow(observedAt(latest), asOf, windowDays) ? latest : null;

  if (latestFresh) {
    const status = String(latestFresh.status || '').toLowerCase();
    const state = latestFresh.result_origin === 'external_lab'
      ? 'external_recorded'
      : (SIGNED_STATUSES.has(status) && latestFresh.signed_off_at ? 'result_final' : 'result_preliminary');
    return {
      ...base, state,
      value_text: latestFresh.value_text ?? null,
      value_numeric: latestFresh.value_numeric == null ? null : Number(latestFresh.value_numeric),
      unit: latestFresh.unit ?? null,
      abnormal_flag: latestFresh.abnormal_flag ?? null,
      is_critical: isCriticalResult(latestFresh),
      observed_at: observedAt(latestFresh),
      source: latestFresh.result_origin === 'external_lab' ? 'external' : 'lab_result',
      lab_result_id: Number(latestFresh.id),
    };
  }

  const openOrders = orders
    .filter((order) => orderCoversItem(item, order)
      && !OPEN_ORDER_STATUSES_EXCLUDED.has(String(order.status || '').toUpperCase())
      && withinWindow(order.requested_at, asOf, windowDays))
    .sort((a, b) => toMs(b.requested_at) - toMs(a.requested_at));
  const order = openOrders[0] || null;
  if (order) {
    const specimen = order.booking_id == null
      ? null
      : specimens.find((s) => Number(s.booking_id) === Number(order.booking_id)) || null;
    const sent = specimen
      ? SPECIMEN_SENT_STATES.has(String(specimen.status || '').toLowerCase())
      : Boolean(order.collected_at);
    return {
      ...base,
      state: sent ? 'sample_sent_awaiting_result' : 'ordered_awaiting_sample',
      investigation_id: Number(order.id),
      specimen_id: specimen ? Number(specimen.id) : null,
      ordered_at: order.requested_at,
    };
  }

  if (latest) {
    return {
      ...base, state: 'stale',
      value_text: latest.value_text ?? null,
      value_numeric: latest.value_numeric == null ? null : Number(latest.value_numeric),
      unit: latest.unit ?? null,
      abnormal_flag: latest.abnormal_flag ?? null,
      is_critical: isCriticalResult(latest),
      observed_at: observedAt(latest),
      source: latest.result_origin === 'external_lab' ? 'external' : 'lab_result',
      lab_result_id: Number(latest.id),
    };
  }
  return base;
}

function isAvailable(item, settings) {
  if (AVAILABLE_STATES.includes(item.state)) return true;
  return item.state === 'external_recorded' && settings.external_results_count === true;
}

// What automation may do to the `labs` check row given the items.
// nextStatus: 'pass' | 'pending' | null (leave the row alone).
export function computeCheckDecision({ items, settings, check, caseRow }) {
  const required = items.filter((item) => item.required !== false);
  const missing = required.filter((item) => !isAvailable(item, settings)).map((item) => ({ item: item.item_code, state: item.state }));
  const criticalItems = required.filter((item) => item.state !== 'waived' && isCriticalResult(item)).map((item) => item.item_code);
  const autoManaged = check?.metadata?.auto_managed === true;
  const status = String(check?.status || 'pending').toLowerCase();
  const started = Boolean(caseRow?.actual_start_at);
  let nextStatus = null;
  let autoPendingReason = null;
  if (missing.length === 0) {
    if (settings.auto_pass === true && (status === 'pending' || (status === 'pass' && autoManaged))) {
      nextStatus = status === 'pass' ? null : 'pass';
    }
  } else if (status === 'pass' && autoManaged && !started) {
    nextStatus = 'pending';
    autoPendingReason = missing.map((m) => `${m.item} ${m.state.replace(/_/g, ' ')}`).join('; ');
  }
  return { nextStatus, criticalWarning: criticalItems.length > 0, criticalItems, missing, autoPendingReason };
}
```

- [ ] **Step 4: Run, commit**

Run: `npm test -- --testPathPatterns unit/cathLabReadinessService` → PASS.

```bash
git add apps/backend/src/services/clinical/cathLabReadinessService.js apps/backend/src/tests/unit/cathLabReadinessService.test.js
git commit -m "feat(cath): lab readiness item resolution and check-decision rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: Persistence, refresh, automation, lab hooks, order-missing, external entry, waiver

**Files:**
- Modify: `apps/backend/src/services/clinical/cathLabReadinessService.js` (append)
- Modify: `apps/backend/src/services/lab/labResultsService.js` (`recordResultManual` 1682–1981; post-commit blocks at ≈1965 and ≈2446; ORU ingest post-commit near its `notifyCreatedCriticalLabAlerts` call at ≈1512)
- Modify: `apps/backend/src/services/lab/labPanelService.js` (create data at ≈427; post-commit)
- Modify: `apps/backend/src/services/lab/labClosedLoopService.js:1099`, `apps/backend/src/services/integrations/externalLabRecoveryService.js:632,787` (add `result_origin`)
- Create: `apps/backend/src/middleware/labResultOriginGuard.js`; modify `apps/backend/src/routes/lab/labRoutes.js:445-465`
- Modify: `apps/backend/src/services/clinical/cathLabService.js` (`getCase`, `updateReadinessCheck`)
- Test: `apps/backend/src/tests/cath-lab-readiness.deep.test.js`, `apps/backend/src/tests/unit/labResultOriginGuard.test.js`

- [ ] **Step 1: Append settings, refresh and automation to the readiness service**

```js
// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const tenantOr = (value) => requireTenantId(value);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_PATTERN.test(text)) throw AppError.badRequest(`${label} must be a UUID`, 'CATH_LAB_BAD_UUID');
  return text.toLowerCase();
}

function positiveInt(value, label, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  return n;
}

function cleanText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
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

async function recordReadinessAudit(tx, { tenantId, action, resource, resourceId, context = {}, metadata = {} }) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $2::uuid, NOW())`,
    tenantId, context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null, cleanText(context.actorRole, 60),
    action, resource, String(resourceId), JSON.stringify(metadata),
  );
}

const SETTINGS_SELECT = 'tenant_id, required_items, lab_validity_days, auto_pass, external_results_count, updated_by, created_at, updated_at';

export async function getReadinessSettings({ tenantId, db = null } = {}) {
  const tid = tenantOr(tenantId);
  const rows = await withTenant(tid, db, (client) => client.$queryRawUnsafe(
    `SELECT ${SETTINGS_SELECT} FROM cath_lab_readiness_settings WHERE tenant_id = $1::uuid LIMIT 1`, tid,
  ));
  const row = rows[0];
  if (!row) return { tenant_id: tid, ...SETTINGS_DEFAULTS, required_items: [...SETTINGS_DEFAULTS.required_items], configured: false };
  return { ...row, lab_validity_days: Number(row.lab_validity_days), required_items: Array.isArray(row.required_items) ? row.required_items : [], configured: true };
}

export async function upsertReadinessSettings(input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const requiredItems = Array.isArray(input.required_items) ? input.required_items.map((i) => String(i).toLowerCase()) : [...SETTINGS_DEFAULTS.required_items];
  if (requiredItems.some((i) => !ITEM_CODES.includes(i))) throw AppError.badRequest(`required_items must be within ${ITEM_CODES.join(', ')}`, 'CATH_LAB_READINESS_ITEM_UNKNOWN');
  const validity = positiveInt(input.lab_validity_days ?? SETTINGS_DEFAULTS.lab_validity_days, 'lab_validity_days', 365);
  const autoPass = input.auto_pass === undefined ? true : Boolean(input.auto_pass);
  const externalCount = input.external_results_count === undefined ? true : Boolean(input.external_results_count);
  const actor = requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_lab_readiness_settings (tenant_id, required_items, lab_validity_days, auto_pass, external_results_count, updated_by)
       VALUES ($1::uuid, $2::text[], $3::int, $4, $5, $6::uuid)
       ON CONFLICT (tenant_id) DO UPDATE SET required_items = EXCLUDED.required_items, lab_validity_days = EXCLUDED.lab_validity_days,
         auto_pass = EXCLUDED.auto_pass, external_results_count = EXCLUDED.external_results_count, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING ${SETTINGS_SELECT}`,
      tid, [...new Set(requiredItems)], validity, autoPass, externalCount, actor,
    );
    await recordReadinessAudit(tx, { tenantId: tid, action: 'CATH_LAB_READINESS_SETTINGS_UPDATED', resource: 'cath_lab_readiness_settings', resourceId: tid, context, metadata: { required_items: requiredItems, lab_validity_days: validity, auto_pass: autoPass, external_results_count: externalCount } });
    return { ...rows[0], lab_validity_days: Number(rows[0].lab_validity_days), configured: true };
  });
}

// Serology window shared with the reuse settings when that table exists.
async function serologyValidityDays(tenantId, db) {
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT serology_validity_days FROM cath_reprocessing_settings WHERE tenant_id = $1::uuid LIMIT 1`, tenantId,
    );
    return rows[0] ? Number(rows[0].serology_validity_days) : DEFAULT_SEROLOGY_VALIDITY_DAYS;
  } catch (err) {
    const message = String(err?.message || '');
    if (err?.code === '42P01' || err?.meta?.code === '42P01' || /does not exist/i.test(message)) return DEFAULT_SEROLOGY_VALIDITY_DAYS;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Refresh: resolve the seven items, persist them, apply the check-level rule
// ---------------------------------------------------------------------------

async function caseRowTx(client, tenantId, caseId, { lock = false } = {}) {
  const rows = await client.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, facility_id, status, urgency, actual_start_at
       FROM cath_lab_cases WHERE tenant_id = $1::uuid AND id = $2::bigint ${lock ? 'FOR UPDATE' : ''} LIMIT 1`,
    tenantOr(tenantId), positiveInt(caseId, 'case_id'),
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Cath-lab case not found', 'CATH_LAB_CASE_NOT_FOUND');
  return { ...row, id: num(row.id) };
}

const ITEM_SELECT = 'id, case_id, item_code, required, state, value_text, value_numeric, unit, abnormal_flag, is_critical, observed_at, source, lab_result_id, investigation_id, specimen_id, ordered_at, waived_by, waived_at, waive_reason, refreshed_at';

async function upsertItemTx(tx, tenantId, caseId, item) {
  await tx.$executeRawUnsafe(
    `INSERT INTO cath_case_lab_readiness_items
       (tenant_id, case_id, item_code, required, state, value_text, value_numeric, unit, abnormal_flag, is_critical,
        observed_at, source, lab_result_id, investigation_id, specimen_id, ordered_at, waived_by, waived_at, waive_reason, refreshed_at)
     VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, $7::numeric, $8, $9, $10,
             $11::timestamptz, $12, $13::int, $14::int, $15::int, $16::timestamptz, $17::uuid, $18::timestamptz, $19, NOW())
     ON CONFLICT (tenant_id, case_id, item_code) DO UPDATE SET
       required = EXCLUDED.required, state = EXCLUDED.state, value_text = EXCLUDED.value_text, value_numeric = EXCLUDED.value_numeric,
       unit = EXCLUDED.unit, abnormal_flag = EXCLUDED.abnormal_flag, is_critical = EXCLUDED.is_critical, observed_at = EXCLUDED.observed_at,
       source = EXCLUDED.source, lab_result_id = EXCLUDED.lab_result_id, investigation_id = EXCLUDED.investigation_id,
       specimen_id = EXCLUDED.specimen_id, ordered_at = EXCLUDED.ordered_at, waived_by = EXCLUDED.waived_by, waived_at = EXCLUDED.waived_at,
       waive_reason = EXCLUDED.waive_reason, refreshed_at = NOW()`,
    tenantId, caseId, item.item_code, item.required !== false, item.state, item.value_text, item.value_numeric, item.unit, item.abnormal_flag, Boolean(item.is_critical),
    item.observed_at, item.source, item.lab_result_id, item.investigation_id, item.specimen_id, item.ordered_at,
    item.waived_by ?? null, item.waived_at ?? null, item.waive_reason ?? null,
  );
}

// Same gate as cathLabService.evaluateReadinessGate, inlined to avoid a
// service cycle (cathLabService imports this module for getCase).
async function recomputeCaseStatusTx(tx, tenantId, caseId, actorUid) {
  const checks = await tx.$queryRawUnsafe(
    `SELECT check_type, status, required FROM cath_lab_readiness_checks WHERE tenant_id = $1::uuid AND case_id = $2::bigint`, tenantId, caseId,
  );
  const types = ['consent', 'labs', 'allergy_renal_risk', 'anticoagulation', 'blood_bank', 'equipment', 'implants_device_rep', 'timeout'];
  const clear = new Set(['pass', 'waived', 'not_applicable']);
  const byType = new Map(checks.map((c) => [c.check_type, c]));
  const ready = types.every((t) => { const c = byType.get(t); return c && (c.required === false || clear.has(c.status)); });
  await tx.$executeRawUnsafe(
    `UPDATE cath_lab_cases SET status = CASE WHEN status IN ('scheduled', 'readiness_pending', 'ready') THEN $3 ELSE status END,
            updated_by = COALESCE($4::uuid, updated_by), updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    tenantId, caseId, ready ? 'ready' : 'readiness_pending', actorUid,
  );
  return ready;
}

export async function refreshCaseLabReadiness({ tenantId, caseId, db = null, context = {} } = {}) {
  const tid = tenantOr(tenantId);
  const run = db ? (fn) => fn(db) : (fn) => setTenantTx(tid, fn);
  return run(async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId, { lock: true });
    const settings = await getReadinessSettings({ tenantId: tid, db: tx });
    const serologyDays = await serologyValidityDays(tid, tx);
    const asOf = new Date();
    const lookbackDays = Math.max(settings.lab_validity_days, serologyDays) + 365;

    const results = await tx.$queryRawUnsafe(
      `SELECT id, test_code, loinc_code, value_text, value_numeric, unit, abnormal_flag, is_critical, status,
              signed_off_at, performed_at, received_at, result_origin
         FROM lab_results
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          AND COALESCE(performed_at, received_at) >= NOW() - ($3::int * INTERVAL '1 day')`,
      tid, cathCase.patient_uid, lookbackDays,
    );
    const orders = await tx.$queryRawUnsafe(
      `SELECT i.id, i.test_code, i.status, i.requested_at, i.collected_at, b.id AS booking_id
         FROM investigations i
         LEFT JOIN investigation_bookings b ON b.investigation_id = i.id
        WHERE i.tenant_id = $1::uuid AND i.patient_uid = $2::uuid
          AND i.status NOT IN ('COMPLETED', 'CANCELLED')
          AND i.requested_at >= NOW() - ($3::int * INTERVAL '1 day')`,
      tid, cathCase.patient_uid, lookbackDays,
    );
    const bookingIds = orders.map((o) => o.booking_id).filter((id) => id != null).map(Number);
    const specimens = bookingIds.length
      ? await tx.$queryRawUnsafe(
        `SELECT id, booking_id, status FROM lab_specimens WHERE tenant_id = $1::uuid AND booking_id = ANY($2::int[]) ORDER BY id DESC`,
        tid, bookingIds,
      )
      : [];
    const waivers = await tx.$queryRawUnsafe(
      `SELECT item_code, waived_by, waived_at, waive_reason FROM cath_case_lab_readiness_items
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND state = 'waived'`,
      tid, cathCase.id,
    );

    const items = ITEM_CODES.map((code) => {
      const windowDays = BLOODBORNE_MARKER_ITEM_CODES.includes(code) ? serologyDays : settings.lab_validity_days;
      const waiver = waivers.find((w) => w.item_code === code) || null;
      return { ...resolveItemState({ item: code, results, orders, specimens, waiver, windowDays, asOf }), required: settings.required_items.includes(code) };
    });
    for (const item of items) await upsertItemTx(tx, tid, cathCase.id, item);

    const checkRows = await tx.$queryRawUnsafe(
      `SELECT id, status, completed_by, metadata FROM cath_lab_readiness_checks
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type = 'labs' FOR UPDATE`,
      tid, cathCase.id,
    );
    const check = checkRows[0] || null;
    const decision = computeCheckDecision({ items, settings, check: check || { status: 'pending', metadata: {} }, caseRow: cathCase });
    let checkStatus = check ? check.status : 'pending';
    let autoManaged = check?.metadata?.auto_managed === true;
    if (check) {
      const metadataPatch = {
        critical_warning: decision.criticalWarning,
        critical_items: decision.criticalItems,
        live_evidence: items,
        live_evidence_refreshed_at: asOf.toISOString(),
        auto_pending_reason: decision.nextStatus === 'pending' ? decision.autoPendingReason : (decision.nextStatus === 'pass' ? null : check.metadata?.auto_pending_reason ?? null),
        ...(decision.nextStatus ? { auto_managed: true, auto_passed_at: decision.nextStatus === 'pass' ? asOf.toISOString() : null } : {}),
      };
      await tx.$executeRawUnsafe(
        `UPDATE cath_lab_readiness_checks
            SET status = COALESCE($4::text, status),
                completed_at = CASE WHEN $4::text = 'pass' THEN NOW() WHEN $4::text = 'pending' THEN NULL ELSE completed_at END,
                completed_by = CASE WHEN $4::text IS NOT NULL THEN NULL ELSE completed_by END,
                evidence_owner = 'lab_readiness', source_name = 'lab_results', attachment_ref = $5,
                metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        tid, num(check.id), JSON.stringify(metadataPatch), decision.nextStatus, `lab_readiness:${cathCase.id}`,
      );
      if (decision.nextStatus) {
        checkStatus = decision.nextStatus;
        autoManaged = true;
        await recomputeCaseStatusTx(tx, tid, cathCase.id, context.actorUid ? requireUuid(context.actorUid, 'actorUid') : null);
        await recordReadinessAudit(tx, { tenantId: tid, action: `cath_lab.readiness.labs.auto_${decision.nextStatus}`, resource: 'cath_lab_readiness_checks', resourceId: check.id, context: { actorUid: null, actorRole: 'SYSTEM' }, metadata: { case_id: cathCase.id, missing: decision.missing, critical_items: decision.criticalItems, reason: decision.autoPendingReason } });
      }
    }
    const missingItems = decision.missing.map((m) => m.item);
    return {
      case_id: cathCase.id,
      check_status: checkStatus,
      auto_managed: autoManaged,
      critical_warning: decision.criticalWarning,
      critical_items: decision.criticalItems,
      items,
      missing: decision.missing,
      orderable_now: orderCodesCovering(items.filter((i) => i.required && ['not_ordered', 'stale'].includes(i.state)).map((i) => i.item_code)),
      open_order_codes: [...new Set(orders.map((o) => String(o.test_code || '').toUpperCase()))],
      settings: { lab_validity_days: settings.lab_validity_days, serology_validity_days: serologyDays, auto_pass: settings.auto_pass, external_results_count: settings.external_results_count, required_items: settings.required_items },
      case_started: Boolean(cathCase.actual_start_at),
      _missing_items: missingItems,
    };
  });
}

// Best-effort, post-commit: refresh every open case of a patient after a lab
// event. Failures are logged and never propagate into the lab write.
export async function refreshOpenCasesForPatient({ tenantId, patientUid }) {
  const tid = tenantOr(tenantId);
  try {
    const cases = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT id FROM cath_lab_cases WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
        AND status IN ('scheduled', 'readiness_pending', 'ready') AND actual_start_at IS NULL`,
      tid, requireUuid(patientUid, 'patientUid'),
    ));
    for (const row of cases) {
      try { await refreshCaseLabReadiness({ tenantId: tid, caseId: num(row.id) }); }
      catch (err) { logger.warn(`Cath lab readiness refresh failed for case ${row.id}: ${err?.message}`); }
    }
    return cases.length;
  } catch (err) {
    logger.warn(`Cath lab readiness refresh lookup failed: ${err?.message}`);
    return 0;
  }
}
```

- [ ] **Step 2: Append waiver, order-missing and external entry**

```js
// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function requireItem(value) {
  const item = String(value ?? '').trim().toLowerCase();
  if (!ITEM_CODES.includes(item)) throw AppError.badRequest(`item must be one of ${ITEM_CODES.join(', ')}`, 'CATH_LAB_READINESS_ITEM_UNKNOWN');
  return item;
}

export async function waiveLabItem(caseId, itemCode, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const item = requireItem(itemCode);
  const reason = cleanText(input.reason, 500);
  if (!reason) throw AppError.badRequest('reason is required to waive a lab item', 'CATH_LAB_READINESS_VALUE_INVALID');
  const actor = requireUuid(context.actorUid, 'actorUid');
  return setTenantTx(tid, async (tx) => {
    const cathCase = await caseRowTx(tx, tid, caseId, { lock: true });
    await tx.$executeRawUnsafe(
      `INSERT INTO cath_case_lab_readiness_items (tenant_id, case_id, item_code, required, state, source, waived_by, waived_at, waive_reason, refreshed_at)
       VALUES ($1::uuid, $2::bigint, $3, TRUE, 'waived', 'waiver', $4::uuid, NOW(), $5, NOW())
       ON CONFLICT (tenant_id, case_id, item_code) DO UPDATE SET state = 'waived', source = 'waiver', waived_by = EXCLUDED.waived_by, waived_at = NOW(), waive_reason = EXCLUDED.waive_reason, refreshed_at = NOW()`,
      tid, cathCase.id, item, actor, reason,
    );
    await recordReadinessAudit(tx, { tenantId: tid, action: 'cath_lab.readiness.labs.item_waived', resource: 'cath_case_lab_readiness_items', resourceId: `${cathCase.id}:${item}`, context, metadata: { case_id: cathCase.id, item, reason } });
    return refreshCaseLabReadiness({ tenantId: tid, caseId: cathCase.id, db: tx, context });
  });
}

const CATALOGUE_TEST_NAMES = Object.freeze({
  CBC: 'Complete Blood Count', PLT: 'Platelet Count', CREATININE: 'Serum Creatinine', KFT: 'Kidney Function Test',
  ELECTROLYTES: 'Serum Electrolytes', HIV: 'HIV 1 & 2 Antibody (ELISA)', HBSAG: 'Hepatitis B Surface Antigen', HCV: 'Hepatitis C Antibody',
});

// Import at the top of the file:
//   import { createInvestigationOrder } from '../investigation/orderService.js';
export async function orderMissingLabs(caseId, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const actor = requireUuid(context.actorUid, 'actorUid');
  const before = await refreshCaseLabReadiness({ tenantId: tid, caseId, context });
  if (before.case_started) throw AppError.conflict('The procedure has started; order labs from the case instead', 'CATH_LAB_READINESS_CASE_STARTED');
  const codes = before.orderable_now.filter((code) => !before.open_order_codes.includes(code));
  const patientRows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT u.id FROM users u JOIN cath_lab_cases c ON c.patient_uid = u.uid AND c.tenant_id = u.tenant_id
      WHERE c.tenant_id = $1::uuid AND c.id = $2::bigint LIMIT 1`, tid, positiveInt(caseId, 'case_id'),
  ));
  if (!patientRows[0]) throw AppError.notFound('Cath-lab case patient not found', 'CATH_LAB_CASE_NOT_FOUND');
  const created = [];
  const skipped = before.orderable_now.filter((code) => before.open_order_codes.includes(code)).map((code) => ({ code, reason: 'already_ordered' }));
  for (const code of codes) {
    try {
      const order = await createInvestigationOrder({
        patient_id: Number(patientRows[0].id), doctor_uid: actor, orderedBy: actor,
        test_name: CATALOGUE_TEST_NAMES[code] || code, test_code: code, type: 'LAB', priority: 'NORMAL',
        notes: `Pre-cath lab readiness (case ${before.case_id})`, tenantId: tid, actorRole: context.actorRole || null,
      });
      created.push({ code, investigation_id: Number(order.id) });
    } catch (err) {
      throw AppError.internal(`Could not place the ${code} order: ${err?.code || err?.message}`, 'CATH_LAB_READINESS_ORDER_FAILED', { code, cause: err?.code || null });
    }
  }
  await setTenantTx(tid, (tx) => recordReadinessAudit(tx, { tenantId: tid, action: 'cath_lab.readiness.labs.orders_placed', resource: 'cath_lab_cases', resourceId: before.case_id, context, metadata: { created, skipped } }));
  const after = await refreshCaseLabReadiness({ tenantId: tid, caseId, context });
  return { created, skipped, readiness: after };
}

const QUALITATIVE_TOKENS = Object.freeze(['reactive', 'non-reactive', 'nonreactive', 'non reactive', 'positive', 'negative', 'indeterminate', 'not detected', 'detected']);

// Import at the top of the file:
//   import { recordResultManual } from '../lab/labResultsService.js';
export async function recordExternalLabResult(caseId, itemCode, input = {}, context = {}) {
  const tid = tenantOr(input.tenantId);
  const item = requireItem(itemCode);
  const def = LAB_ANALYTE_ITEMS[item];
  const actor = requireUuid(context.actorUid, 'actorUid');
  const labName = cleanText(input.external_lab_name, 160);
  const reportRef = cleanText(input.external_report_ref, 120);
  const notes = cleanText(input.notes, 2000);
  const observedOn = String(input.observed_on ?? '').trim();
  if (!labName) throw AppError.badRequest('external_lab_name is required', 'CATH_LAB_READINESS_VALUE_INVALID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observedOn) || observedOn > new Date().toISOString().slice(0, 10)) {
    throw AppError.badRequest('observed_on must be a past or present date (YYYY-MM-DD)', 'CATH_LAB_READINESS_VALUE_INVALID');
  }
  const valueText = cleanText(input.value_text, 255);
  let valueNumeric = null;
  let unit = cleanText(input.unit, 40) || def.unit;
  if (def.kind === 'qualitative') {
    const token = String(valueText || '').toLowerCase();
    if (!QUALITATIVE_TOKENS.some((t) => token === t)) {
      throw AppError.badRequest(`value_text must be one of ${QUALITATIVE_TOKENS.join(', ')}`, 'CATH_LAB_READINESS_VALUE_INVALID');
    }
    unit = null;
  } else {
    valueNumeric = Number(input.value_numeric ?? valueText);
    if (!Number.isFinite(valueNumeric) || valueNumeric < 0) throw AppError.badRequest('value_numeric must be a non-negative number', 'CATH_LAB_READINESS_VALUE_INVALID');
    if (!unit) throw AppError.badRequest('unit is required for a quantitative result', 'CATH_LAB_READINESS_VALUE_INVALID');
  }
  const cathCase = await setTenant(tid, (tx) => caseRowTx(tx, tid, caseId));
  if (cathCase.actual_start_at) throw AppError.conflict('The procedure has started; outside results are recorded on the case, not the checklist', 'CATH_LAB_READINESS_CASE_STARTED');

  const recorded = await recordResultManual({
    tenantId: tid,
    performed_by: actor,
    performed_by_role: context.actorRole || null,
    result: {
      patient_uid: cathCase.patient_uid,
      test_code: def.canonicalAnalyteCode,
      test_name: `${def.canonicalAnalyteCode} (external lab)`,
      value_text: def.kind === 'qualitative' ? valueText : String(valueNumeric),
      unit,
      comments: notes,
      result_origin: 'external_lab',
      external_lab_name: labName,
      external_report_ref: reportRef,
      external_reported_on: observedOn,
      performed_at: `${observedOn}T00:00:00+05:30`,
    },
    idempotencyKey: context.idempotencyKey,
    requestBodySha256: context.requestFingerprint || null,
    httpIdempotencyClaimId: context.httpIdempotencyClaimId || null,
    requestId: context.requestId || null,
    allowUnlinkedExternal: true,
    qualitative: def.kind === 'qualitative',
  });
  const labResult = recorded.result;

  if (def.marker) {
    await recordMarkers({
      tenantId: tid, patientUid: cathCase.patient_uid, actorUid: actor,
      entries: [{ marker: def.marker, result: normalizeSerologyValue(valueText), tested_on: observedOn, source: 'external_report', lab_result_id: labResult.id, evidence: { external_lab_name: labName, external_report_ref: reportRef, raw_value: valueText } }],
    });
  }
  await setTenantTx(tid, (tx) => recordReadinessAudit(tx, { tenantId: tid, action: 'CATH_LAB_EXTERNAL_RESULT_RECORDED', resource: 'lab_results', resourceId: labResult.id, context, metadata: { case_id: cathCase.id, item, external_lab_name: labName, observed_on: observedOn } }));
  const readiness = await refreshCaseLabReadiness({ tenantId: tid, caseId: cathCase.id, context });
  return { lab_result_id: Number(labResult.id), item, readiness };
}
```

- [ ] **Step 3: The `recordResultManual` escape hatch and origin columns**

In `apps/backend/src/services/lab/labResultsService.js`:

(a) Signature: add `allowUnlinkedExternal = false, qualitative = false,` to the destructured parameters of `recordResultManual`.

(b) `fields` array: append `'result_origin', 'external_lab_name', 'external_report_ref', 'external_reported_on', 'performed_at'`.

(c) After `const sanitised = { ...result, status: 'preliminary' };` add:

```js
  // Provenance. The public manual route may not set an origin (the route guard
  // rejects it); the cath readiness checklist is the only caller that may file
  // an external-lab result, and it must name the lab and the report date.
  const externalOrigin = allowUnlinkedExternal && sanitised.result_origin === 'external_lab';
  if (!allowUnlinkedExternal) {
    sanitised.result_origin = 'manual_in_house';
    sanitised.external_lab_name = null;
    sanitised.external_report_ref = null;
    sanitised.external_reported_on = null;
    sanitised.performed_at = null;
  } else if (!externalOrigin || !sanitised.external_lab_name || !sanitised.external_reported_on) {
    throw AppError.badRequest(
      'External results must carry result_origin=external_lab, external_lab_name and external_reported_on',
      'LAB_RESULT_EXTERNAL_PROVENANCE_REQUIRED',
    );
  }
```

(d) Wrap the order-link requirement so it is skipped for external results:

```js
  if (!externalOrigin && requestedInvestigationId == null && requestedBookingId == null) {
    throw AppError.badRequest( … LAB_RESULT_ORDER_LINK_REQUIRED … );
  }
```

(e) Inside the transaction, replace the `lockAndValidateOrderedResultSource` call and the three assignments after it with:

```js
    if (externalOrigin) {
      const patientRows = await tx.$queryRawUnsafe(
        `SELECT name FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid LIMIT 1`,
        tenantId, sanitised.patient_uid,
      );
      if (!patientRows[0]) throw labResultSourceMismatch();
      sanitised.investigation_id = null;
      sanitised.admission_id = null;
      sanitised.patient_name = patientRows[0].name || null;
    } else {
      const source = await lockAndValidateOrderedResultSource({ … unchanged … });
      sanitised.investigation_id = source.investigationId;
      sanitised.admission_id = source.admissionId;
      sanitised.patient_name = source.patientName;
    }
```

(f) Guard the duplicate-analyte check with `if (sanitised.investigation_id != null) { … }`.

(g) INSERT: append the five new columns `result_origin, external_lab_name, external_report_ref, external_reported_on, performed_at` to the column list and `$21, $22, $23, $24::date, $25::timestamptz` to VALUES; the `values` array already receives them through `fields` (they are the last five entries of `fields`, so the positional order follows `fields` then the four pushed extras — re-derive the `$n` numbers from the final array order and keep `performed_by_lab` as `sanitised.result_origin === 'external_lab' ? sanitised.external_lab_name : (performed_by ? String(performed_by) : null)`). Add `result_origin, external_lab_name, external_report_ref, external_reported_on` to the RETURNING list.

(h) After `materializeLabCriticalAlertGeneration`, change the numeric guard to `if (!qualitative && materialized.criticality?.unmatchedReason === 'non_numeric_value') { … throw … }`.

(i) Post-commit blocks. In `recordResultManual` after the `emitLabEvent('result-pending', …)` try/catch, and in `signOffResults` after the blood-borne marker hook added by Plan 1, and in the ORU ingest path next to its `notifyCreatedCriticalLabAlerts` call (search for the call at ≈1512 and add after the surrounding try/catch), add:

```js
  try {
    const { refreshOpenCasesForPatient } = await import('../clinical/cathLabReadinessService.js');
    await refreshOpenCasesForPatient({ tenantId, patientUid: <the patient uid in scope> });
  } catch (readinessErr) {
    logger.warn(`Cath lab readiness refresh after lab event failed (lab write stands): ${readinessErr?.message}`);
  }
```

using `phaseOne.responseData.result.patient_uid` in `recordResultManual`, `resultPatientUid` in `signOffResults`, and the ingested result's `patient_uid` in the ORU path (loop over the distinct patient uids of the inserted rows). The dynamic import keeps the lab module free of a static cycle with the readiness service (which imports `recordResultManual`), the same way `signOffResults` already imports `hl7OutboundService` dynamically.

(j) `labPanelService.js`: add `result_origin: 'manual_in_house',` to the `tx.lab_results.create({ data: … })` block and the same post-commit refresh (patient uid from `source.patientUid`). `labClosedLoopService.js:1099` and `externalLabRecoveryService.js:632, 787`: add `result_origin` with the literal `'analyzer'` to each INSERT column list and VALUES. The ORU INSERT at `labResultsService.js:1194` likewise gets `'analyzer'`.

- [ ] **Step 4: Public route guard**

```js
// apps/backend/src/middleware/labResultOriginGuard.js
//
// The public manual-result route may not choose a provenance. Outside-lab
// values enter only through the cath readiness checklist (spec
// 2026-09-04-cath-pre-procedure-lab-readiness §6.3, §8.2).
import { HTTP_STATUS } from '../config/responseCodes.js';
import { error } from '../utils/responseHelper.js';

export const LAB_RESULT_ORIGIN_FIELDS = Object.freeze([
  'result_origin', 'external_lab_name', 'external_report_ref', 'external_reported_on',
]);

export function rejectLabResultOriginFields(req, res, next) {
  const body = req.body || {};
  const present = LAB_RESULT_ORIGIN_FIELDS.filter((field) => body[field] !== undefined);
  if (present.length) {
    return error(res, `Fields not allowed on this route: ${present.join(', ')}`, HTTP_STATUS.BAD_REQUEST, { code: 'LAB_RESULT_ORIGIN_NOT_ALLOWED', fields: present });
  }
  return next();
}
```

In `labRoutes.js` import it and insert `rejectLabResultOriginFields,` immediately after `requireLabResultRecorder,` on `router.post('/results', …)`. Unit test:

```js
// apps/backend/src/tests/unit/labResultOriginGuard.test.js
import { jest } from '@jest/globals';
import { rejectLabResultOriginFields } from '../../middleware/labResultOriginGuard.js';

function res() { const r = { statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }

describe('rejectLabResultOriginFields', () => {
  test('passes a plain manual result through', () => {
    const next = jest.fn();
    rejectLabResultOriginFields({ body: { test_code: 'K', value_text: '4.1' } }, res(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
  test('rejects result_origin and external fields with 400', () => {
    const next = jest.fn();
    const r = res();
    rejectLabResultOriginFields({ body: { test_code: 'K', result_origin: 'external_lab', external_lab_name: 'X' } }, r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(400);
  });
});
```

(If `error()` writes through `res.status().json()` differently, mirror the shape another middleware unit test in `src/tests/unit` uses for its fake `res`.)

- [ ] **Step 5: `getCase` and human pass over a critical warning**

In `cathLabService.js` add `import { refreshCaseLabReadiness } from './cathLabReadinessService.js';` and `import { recordMedicationSafetyReviews } from './canonicalClinicalPlatformService.js';` (the latter may already be imported through the canonical import block; if so, extend that block).

In `getCase`, before the return, add `const labReadiness = await refreshCaseLabReadiness({ tenantId: tenantOr(tenantId), caseId }).catch((err) => { logger.warn(\`Lab readiness refresh failed on getCase: ${err?.message}\`); return null; });` and `lab_readiness: labReadiness,` in the returned object. (`getCase` reads with `db = prisma`; the refresh opens its own tenant transaction, which is why it is called outside `db`.)

In `updateReadinessCheck`, after the upsert `rows` and before the gate recompute, add:

```js
    const savedCheck = unwrap(rows);
    if (checkType === 'labs' && status === 'pass' && savedCheck?.metadata?.critical_warning === true) {
      const cathCase = await caseById(tx, tenantId, caseId);
      const reviews = await recordMedicationSafetyReviews({
        tenantId,
        patientUid: cathCase.patient_uid,
        encounterId: cathCase.encounter_id,
        safety: {
          safe: false,
          blockers: [{
            type: 'cath_lab_readiness',
            code: 'CRITICAL_LAB_ACKNOWLEDGED',
            severity: 'high',
            message: `Labs check passed by hand with critical value(s): ${(savedCheck.metadata.critical_items || []).join(', ')}`,
            case_id: normalizeDbValue(cathCase.id),
          }],
          warnings: []
        },
        override: { reason: cleanText(input.notes) || 'Critical lab value acknowledged at readiness', approvedBy: maybeUuid(context.actorUid, 'actorUid') },
        actorUid: maybeUuid(context.actorUid, 'actorUid')
      }, { db: tx });
      if (!reviews.length) {
        throw AppError.internal('Readiness critical-value acknowledgement did not persist', 'CATH_LAB_READINESS_REVIEW_FAILED');
      }
    }
```

A human `pass` carries `metadata` from the request body; the automation's `critical_warning` lives in the stored row. Because the upsert replaces `metadata` wholesale with the request's, read `critical_warning` from the row BEFORE the upsert (`SELECT metadata FROM cath_lab_readiness_checks … FOR UPDATE` at the top of the transaction) and merge it back: `metadata = ${request metadata} || jsonb_build_object('critical_warning', prior.critical_warning, 'critical_items', prior.critical_items, 'live_evidence', prior.live_evidence)` — implement by computing the merged object in JS before the upsert and passing it as the `$13::jsonb` parameter, and use the prior row's flag for the review decision.

- [ ] **Step 6: Deep test**

Copy the cath case fixture from `apps/backend/src/tests/cath-consumables.deep.test.js` (tenant, facility, actor, patient, case) with `…1ab…` UUIDs, then:

```js
// apps/backend/src/tests/cath-lab-readiness.deep.test.js
import prisma from '../lib/prisma.js';
import { getCase, updateReadinessCheck } from '../services/clinical/cathLabService.js';
import { orderMissingLabs, recordExternalLabResult, refreshCaseLabReadiness, upsertReadinessSettings, waiveLabItem } from '../services/clinical/cathLabReadinessService.js';
import { recordResultManual } from '../services/lab/labResultsService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
// TENANT '00000000-0000-4000-8000-000000001ab0', PATIENT '…1ab1', ACTOR '…1aba', CASE_ID from the fixture.
const ctx = (extra = {}) => ({ actorUid: ACTOR, actorRole: 'DOCTOR', tenantId: TENANT, ...extra });
const resultIds = [];

async function seedResult({ code, value, numeric = null, flag = 'N', critical = false, daysAgo = 1, status = 'final' }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results (tenant_id, patient_uid, test_code, test_name, value_text, value_numeric, unit, abnormal_flag, is_critical, status, signed_off_at, signed_off_by, performed_at, received_at, result_origin)
     VALUES ($1::uuid, $2::uuid, $3, $3, $4, $5::numeric, 'u', $6, $7, $8, CASE WHEN $8 = 'final' THEN NOW() ELSE NULL END, $9::uuid,
             NOW() - ($10::int * INTERVAL '1 day'), NOW() - ($10::int * INTERVAL '1 day'), 'analyzer')
     RETURNING id`,
    TENANT, PATIENT, code, value, numeric, flag, critical, status, ACTOR, daysAgo,
  );
  resultIds.push(Number(rows[0].id));
  return Number(rows[0].id);
}
const labsCheck = () => prisma.$queryRawUnsafe(`SELECT status, metadata FROM cath_lab_readiness_checks WHERE tenant_id = $1::uuid AND case_id = $2::bigint AND check_type = 'labs'`, TENANT, CASE_ID).then((r) => r[0]);

d('cath lab readiness (deep)', () => {
  beforeAll(async () => { await cleanup(); await seed(); }, 60000);
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM cath_case_lab_readiness_items WHERE tenant_id = $1::uuid`, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid`, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`, TENANT, PATIENT).catch(() => {});
    if (resultIds.length) await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`, TENANT, resultIds).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND result_origin = 'external_lab'`, TENANT, PATIENT).catch(() => {});
    await cleanup();
  }, 60000);

  test('nothing ordered: seven not_ordered items, check stays pending, six orderable codes', async () => {
    const out = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(out.items.map((i) => i.state)).toEqual(Array(7).fill('not_ordered'));
    expect(out.check_status).toBe('pending');
    expect(out.orderable_now).toEqual(['CBC', 'ELECTROLYTES', 'CREATININE', 'HIV', 'HBSAG', 'HCV']);
  });

  test('order-missing places one order per covering code and is idempotent', async () => {
    const first = await orderMissingLabs(CASE_ID, { tenantId: TENANT }, ctx({ idempotencyKey: 'clr-order-1' }));
    expect(first.created.map((c) => c.code)).toEqual(['CBC', 'ELECTROLYTES', 'CREATININE', 'HIV', 'HBSAG', 'HCV']);
    expect(first.readiness.items.every((i) => i.state === 'ordered_awaiting_sample')).toBe(true);
    const second = await orderMissingLabs(CASE_ID, { tenantId: TENANT }, ctx({ idempotencyKey: 'clr-order-2' }));
    expect(second.created).toEqual([]);
    const count = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM investigations WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status <> 'CANCELLED'`, TENANT, PATIENT);
    expect(count[0].n).toBe(6);
  }, 30000);

  test('all results present: auto-pass with a critical warning on potassium; case becomes ready when other checks are cleared', async () => {
    await prisma.$executeRawUnsafe(`UPDATE investigations SET status = 'COMPLETED' WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`, TENANT, PATIENT);
    await seedResult({ code: 'HGB', value: '12.1', numeric: 12.1 });
    await seedResult({ code: 'PLT', value: '210', numeric: 210 });
    await seedResult({ code: 'CREA', value: '0.9', numeric: 0.9 });
    await seedResult({ code: 'K', value: '6.3', numeric: 6.3, flag: 'HH', critical: true });
    for (const code of ['HIV', 'HBSAG', 'HCV']) await seedResult({ code, value: 'Non-reactive' });
    const out = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(out.check_status).toBe('pass');
    expect(out.auto_managed).toBe(true);
    expect(out.critical_warning).toBe(true);
    expect(out.critical_items).toEqual(['potassium']);
    const row = await labsCheck();
    expect(row.status).toBe('pass');
    expect(row.metadata.auto_managed).toBe(true);
    expect(row.metadata.critical_warning).toBe(true);
    const c = await getCase(CASE_ID, { tenantId: TENANT });
    expect(c.lab_readiness.check_status).toBe('pass');
  }, 30000);

  test('a value going stale flips an auto-managed pass back to pending before start, not after', async () => {
    await prisma.$executeRawUnsafe(`UPDATE lab_results SET performed_at = NOW() - INTERVAL '45 days', received_at = NOW() - INTERVAL '45 days' WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HGB'`, TENANT, PATIENT);
    const stale = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(stale.check_status).toBe('pending');
    expect((await labsCheck()).metadata.auto_pending_reason).toBe('hb stale');
    await prisma.$executeRawUnsafe(`UPDATE lab_results SET performed_at = NOW() - INTERVAL '1 day', received_at = NOW() - INTERVAL '1 day' WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HGB'`, TENANT, PATIENT);
    expect((await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() })).check_status).toBe('pass');
    await prisma.$executeRawUnsafe(`UPDATE cath_lab_cases SET actual_start_at = NOW() WHERE tenant_id = $1::uuid AND id = $2::bigint`, TENANT, CASE_ID);
    await prisma.$executeRawUnsafe(`UPDATE lab_results SET performed_at = NOW() - INTERVAL '45 days', received_at = NOW() - INTERVAL '45 days' WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HGB'`, TENANT, PATIENT);
    expect((await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() })).check_status).toBe('pass');
    await prisma.$executeRawUnsafe(`UPDATE cath_lab_cases SET actual_start_at = NULL WHERE tenant_id = $1::uuid AND id = $2::bigint`, TENANT, CASE_ID);
  }, 30000);

  test('a human pass is never touched by automation, and a human pass over a critical warning writes a safety review', async () => {
    await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() }); // HGB stale -> auto pending
    await updateReadinessCheck(CASE_ID, { tenantId: TENANT, check_type: 'labs', status: 'pass', notes: 'K reviewed by cardiologist' }, ctx());
    const out = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(out.check_status).toBe('pass');
    expect(out.auto_managed).toBe(false);
    const reviews = await prisma.$queryRawUnsafe(`SELECT finding_code FROM medication_safety_reviews WHERE tenant_id = $1::uuid AND review_type = 'cath_lab_readiness' ORDER BY id DESC LIMIT 1`, TENANT);
    expect(reviews[0]?.finding_code).toBe('CRITICAL_LAB_ACKNOWLEDGED');
    await updateReadinessCheck(CASE_ID, { tenantId: TENANT, check_type: 'labs', status: 'pending' }, ctx());
  }, 30000);

  test('an outside HBsAg result is stored as an external lab row, creates a marker, and counts only when the policy allows', async () => {
    await prisma.$executeRawUnsafe(`UPDATE lab_results SET performed_at = NOW() - INTERVAL '1 day', received_at = NOW() - INTERVAL '1 day' WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HGB'`, TENANT, PATIENT);
    await prisma.$executeRawUnsafe(`UPDATE lab_results SET status = 'cancelled' WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HBSAG'`, TENANT, PATIENT);
    const out = await recordExternalLabResult(CASE_ID, 'hbsag', { tenantId: TENANT, value_text: 'Non-reactive', observed_on: '2026-08-30', external_lab_name: 'City Path Lab', external_report_ref: 'CPL-7781' }, ctx({ idempotencyKey: 'clr-ext-1' }));
    const row = await prisma.$queryRawUnsafe(`SELECT result_origin, status, signed_off_at, external_lab_name, performed_by_lab, investigation_id FROM lab_results WHERE id = $1::int`, out.lab_result_id);
    expect(row[0]).toMatchObject({ result_origin: 'external_lab', status: 'preliminary', signed_off_at: null, external_lab_name: 'City Path Lab', performed_by_lab: 'City Path Lab', investigation_id: null });
    const marker = await prisma.$queryRawUnsafe(`SELECT marker, result, source FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND lab_result_id = $2::int`, TENANT, out.lab_result_id);
    expect(marker[0]).toMatchObject({ marker: 'hbsag', result: 'non_reactive', source: 'external_report' });
    expect(out.readiness.items.find((i) => i.item_code === 'hbsag').state).toBe('external_recorded');
    expect(out.readiness.check_status).toBe('pass');
    await upsertReadinessSettings({ tenantId: TENANT, external_results_count: false }, ctx());
    const strict = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(strict.missing).toEqual([{ item: 'hbsag', state: 'external_recorded' }]);
    await upsertReadinessSettings({ tenantId: TENANT, external_results_count: true }, ctx());
  }, 30000);

  test('the public manual path never stores an external origin; the escape needs full provenance', async () => {
    const inv = await prisma.$queryRawUnsafe(`SELECT id FROM investigations WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid ORDER BY id LIMIT 1`, TENANT, PATIENT);
    const stored = await recordResultManual({ tenantId: TENANT, performed_by: ACTOR, performed_by_role: 'LAB_TECHNICIAN', result: { investigation_id: Number(inv[0].id), patient_uid: PATIENT, test_code: 'NA', test_name: 'Sodium', value_text: '138', result_origin: 'external_lab', external_lab_name: 'Sneaky' }, idempotencyKey: 'clr-public-1', requestBodySha256: 'a'.repeat(64) });
    resultIds.push(Number(stored.result.id));
    expect(stored.result.result_origin).toBe('manual_in_house');
    expect(stored.result.external_lab_name).toBeNull();
    await expect(recordResultManual({ tenantId: TENANT, performed_by: ACTOR, performed_by_role: 'DOCTOR', result: { patient_uid: PATIENT, test_code: 'K', test_name: 'K', value_text: '4.0', result_origin: 'external_lab' }, idempotencyKey: 'clr-public-2', requestBodySha256: 'b'.repeat(64), allowUnlinkedExternal: true }))
      .rejects.toMatchObject({ code: 'LAB_RESULT_EXTERNAL_PROVENANCE_REQUIRED' });
  }, 30000);

  test('waiving an item makes it available and survives refresh', async () => {
    await prisma.$executeRawUnsafe(`UPDATE lab_results SET status = 'cancelled' WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND test_code = 'HCV'`, TENANT, PATIENT);
    const missing = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx() });
    expect(missing.missing.map((m) => m.item)).toEqual(['hcv']);
    const waived = await waiveLabItem(CASE_ID, 'hcv', { tenantId: TENANT, reason: 'Repeat HCV from last month on file elsewhere' }, ctx());
    expect(waived.items.find((i) => i.item_code === 'hcv').state).toBe('waived');
    expect(waived.check_status).toBe('pass');
  });
});
```

The `investigations` orders created by `createInvestigationOrder` require a `users` row with `role = 'PATIENT'` and `id`; the copied fixture's patient satisfies this. If `createInvestigationOrder` rejects `test_code` for a code missing from your scratch DB's catalogue (the seed applies migration 102), check `SELECT code FROM investigation_test_catalog WHERE code IN ('CBC','ELECTROLYTES','CREATININE','HIV','HBSAG','HCV')` returns six rows.

- [ ] **Step 7: Run, then commit**

```bash
DATABASE_URL=… npm test -- --testPathPatterns "cath-lab-readiness.deep|unit/labResultOriginGuard|unit/labResultsService|lab-signoff-safety.deep|lab-panel-critical-path.deep|unit/cathLabReadinessService"
git add apps/backend/src/services apps/backend/src/middleware/labResultOriginGuard.js apps/backend/src/routes/lab/labRoutes.js apps/backend/src/tests
git commit -m "feat(cath): lab readiness refresh, auto-pass with critical warning, order-missing, external results, waivers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: Routes and OpenAPI

**Files:**
- Modify: `apps/backend/src/routes/clinical/cathLabRoutes.js` (imports; after the `readiness/evidence/refresh` route)
- Modify: `apps/backend/src/routes/admin/cathConsumablesRoutes.js`
- Create: `apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs`; modify `lab.mjs` (result fields), `generate-openapi.mjs`; regenerate `openapi.json`

- [ ] **Step 1: Cath routes**

Imports:

```js
import {
  orderMissingLabs,
  recordExternalLabResult,
  refreshCaseLabReadiness,
  waiveLabItem
} from '../../services/clinical/cathLabReadinessService.js';
```

`contextOf(req)` must expose `idempotencyKey`, `requestFingerprint`, `httpIdempotencyClaimId` and `requestId` (the external-result path forwards them to `recordResultManual`). Read `contextOf` and add any missing field: `idempotencyKey: req.idempotencyClaim?.requestKey || null, requestFingerprint: req.idempotencyClaim?.requestBodyHash || null, httpIdempotencyClaimId: req.idempotencyClaim?.id || null, requestId: req.id || null`.

Replace the evidence-refresh handler's `try` body with:

```js
    const result = await refreshReadinessEvidence(req.params.id, { tenantId: tenantOf(req) }, contextOf(req));
    const labs = await refreshCaseLabReadiness({ tenantId: tenantOf(req), caseId: req.params.id, context: contextOf(req) });
    return success(res, { ...result, labs }, 'Cath-lab readiness evidence refreshed');
```

Add after it:

```js
router.get('/cases/:id/readiness/labs', requireReportRead, guardCathCaseById, async (req, res) => {
  try {
    const labs = await refreshCaseLabReadiness({ tenantId: tenantOf(req), caseId: req.params.id, context: contextOf(req) });
    return success(res, labs, 'Cath-lab lab readiness');
  } catch (err) {
    return handleFailure(res, err, 'lab readiness');
  }
});

router.post(
  '/cases/:id/readiness/labs/order-missing',
  requireCathWorkflow,
  guardCathCaseById,
  requireIdempotencyKey({ required: true, scope: 'cath_lab_readiness_order' }),
  async (req, res) => {
    try {
      const result = await orderMissingLabs(req.params.id, { tenantId: tenantOf(req) }, contextOf(req));
      return success(res, result, 'Missing pre-cath labs ordered', HTTP_STATUS.CREATED);
    } catch (err) {
      return handleFailure(res, err, 'order missing labs');
    }
  }
);

router.post(
  '/cases/:id/readiness/labs/:item/external-result',
  requireCathWorkflow,
  guardCathCaseById,
  requireIdempotencyKey({ required: true, scope: 'cath_lab_readiness_external' }),
  async (req, res) => {
    try {
      const result = await recordExternalLabResult(req.params.id, req.params.item, { ...req.body, tenantId: tenantOf(req) }, contextOf(req));
      return success(res, result, 'External lab result recorded', HTTP_STATUS.CREATED);
    } catch (err) {
      return handleFailure(res, err, 'record external lab result');
    }
  }
);

router.post('/cases/:id/readiness/labs/:item/waive', requireCathWorkflow, guardCathCaseById, async (req, res) => {
  try {
    const result = await waiveLabItem(req.params.id, req.params.item, { ...req.body, tenantId: tenantOf(req) }, contextOf(req));
    return success(res, result, 'Lab readiness item waived');
  } catch (err) {
    return handleFailure(res, err, 'waive lab item');
  }
});
```

- [ ] **Step 2: Admin settings routes**

In `cathConsumablesRoutes.js` import `getReadinessSettings, upsertReadinessSettings` from `cathLabReadinessService.js` and add, gated by the same `requireReprocessingPolicyRole` (define it here if Plan 2 has not landed: `requireRole('QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER', 'SUPER_ADMIN')`):

```js
router.get('/lab-readiness-settings', requireReprocessingPolicyRole, async (req, res, next) => {
  try { return success(res, { settings: await getReadinessSettings({ tenantId: req.tenantId }) }, 'Cath lab readiness settings retrieved'); }
  catch (err) { return next(err); }
});
router.put('/lab-readiness-settings', requireReprocessingPolicyRole, async (req, res, next) => {
  try { return success(res, { settings: await upsertReadinessSettings({ ...(req.body || {}), tenantId: req.tenantId }, actorContext(req)) }, 'Cath lab readiness settings saved'); }
  catch (err) { return next(err); }
});
```

- [ ] **Step 3: OpenAPI**

```js
// apps/backend/scripts/openapi/schemas/cathLabReadiness.mjs
import { envelope } from './_helpers.mjs';

const ITEMS = ['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv'];
const STATES = ['result_final', 'result_preliminary', 'external_recorded', 'sample_sent_awaiting_result', 'ordered_awaiting_sample', 'not_ordered', 'stale', 'waived'];
const ORDER_CODES = ['CBC', 'ELECTROLYTES', 'CREATININE', 'HIV', 'HBSAG', 'HCV'];
const nullableString = { type: 'string', nullable: true };
const nullableNumber = { type: 'number', nullable: true };
const nullableInteger = { type: 'integer', nullable: true };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };
const nullableUuid = { type: 'string', format: 'uuid', nullable: true };
const BIGINT_WIRE = { oneOf: [{ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: 'string', pattern: '^[1-9][0-9]*$' }] };
const idempotencyHeaderParameter = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_\\-:.]+$' } };

const item = {
  type: 'object', additionalProperties: false,
  required: ['item_code', 'required', 'state', 'is_critical'],
  properties: {
    item_code: { type: 'string', enum: ITEMS }, required: { type: 'boolean' }, state: { type: 'string', enum: STATES },
    value_text: nullableString, value_numeric: nullableNumber, unit: nullableString, abnormal_flag: nullableString,
    is_critical: { type: 'boolean' }, observed_at: nullableDateTime, source: { type: 'string', enum: ['lab_result', 'external', 'waiver'], nullable: true },
    lab_result_id: nullableInteger, investigation_id: nullableInteger, specimen_id: nullableInteger, ordered_at: nullableDateTime,
    waived_by: nullableUuid, waived_at: nullableDateTime, waive_reason: nullableString
  }
};

const readiness = {
  type: 'object', additionalProperties: false,
  required: ['case_id', 'check_status', 'auto_managed', 'critical_warning', 'critical_items', 'items', 'missing', 'orderable_now', 'open_order_codes', 'settings', 'case_started'],
  properties: {
    case_id: { type: 'integer', minimum: 1 },
    check_status: { type: 'string', enum: ['pending', 'pass', 'fail', 'waived', 'not_applicable'] },
    auto_managed: { type: 'boolean' }, critical_warning: { type: 'boolean' },
    critical_items: { type: 'array', items: { type: 'string', enum: ITEMS } },
    items: { type: 'array', items: { $ref: '#/components/schemas/CathLabReadinessItem' } },
    missing: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'state'], properties: { item: { type: 'string', enum: ITEMS }, state: { type: 'string', enum: STATES } } } },
    orderable_now: { type: 'array', items: { type: 'string', enum: ORDER_CODES } },
    open_order_codes: { type: 'array', items: { type: 'string' } },
    settings: { type: 'object', additionalProperties: false, required: ['lab_validity_days', 'serology_validity_days', 'auto_pass', 'external_results_count', 'required_items'],
      properties: { lab_validity_days: { type: 'integer' }, serology_validity_days: { type: 'integer' }, auto_pass: { type: 'boolean' }, external_results_count: { type: 'boolean' }, required_items: { type: 'array', items: { type: 'string', enum: ITEMS } } } },
    case_started: { type: 'boolean' },
    _missing_items: { type: 'array', items: { type: 'string' } }
  }
};

export const schemas = {
  CathLabReadinessItem: item,
  CathLabReadiness: readiness,
  CathLabReadinessResponse: envelope('CathLabReadiness'),
  CathLabReadinessOrderMissingData: {
    type: 'object', additionalProperties: false, required: ['created', 'skipped', 'readiness'],
    properties: {
      created: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'investigation_id'], properties: { code: { type: 'string', enum: ORDER_CODES }, investigation_id: { type: 'integer' } } } },
      skipped: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'reason'], properties: { code: { type: 'string' }, reason: { type: 'string' } } } },
      readiness: { $ref: '#/components/schemas/CathLabReadiness' }
    }
  },
  CathLabReadinessOrderMissingResponse: envelope('CathLabReadinessOrderMissingData'),
  CathLabReadinessExternalResultRequest: {
    type: 'object', additionalProperties: false, required: ['value_text', 'observed_on', 'external_lab_name'],
    properties: {
      value_text: { type: 'string', minLength: 1, maxLength: 255 }, value_numeric: { type: 'number' }, unit: { type: 'string', maxLength: 40 },
      observed_on: { type: 'string', format: 'date' }, external_lab_name: { type: 'string', minLength: 1, maxLength: 160 },
      external_report_ref: { type: 'string', maxLength: 120 }, notes: { type: 'string', maxLength: 2000 }
    }
  },
  CathLabReadinessExternalResultData: {
    type: 'object', additionalProperties: false, required: ['lab_result_id', 'item', 'readiness'],
    properties: { lab_result_id: { type: 'integer' }, item: { type: 'string', enum: ITEMS }, readiness: { $ref: '#/components/schemas/CathLabReadiness' } }
  },
  CathLabReadinessExternalResultResponse: envelope('CathLabReadinessExternalResultData'),
  CathLabReadinessWaiveRequest: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
  CathLabReadinessSettings: {
    type: 'object', additionalProperties: false, required: ['tenant_id', 'required_items', 'lab_validity_days', 'auto_pass', 'external_results_count', 'configured'],
    properties: { tenant_id: { type: 'string', format: 'uuid' }, required_items: { type: 'array', items: { type: 'string', enum: ITEMS } }, lab_validity_days: { type: 'integer', minimum: 1, maximum: 365 }, auto_pass: { type: 'boolean' }, external_results_count: { type: 'boolean' }, updated_by: nullableUuid, created_at: nullableDateTime, updated_at: nullableDateTime, configured: { type: 'boolean' } }
  },
  CathLabReadinessSettingsData: { type: 'object', additionalProperties: false, required: ['settings'], properties: { settings: { $ref: '#/components/schemas/CathLabReadinessSettings' } } },
  CathLabReadinessSettingsResponse: envelope('CathLabReadinessSettingsData'),
  CathLabReadinessSettingsUpdateRequest: {
    type: 'object', additionalProperties: false,
    properties: { required_items: { type: 'array', items: { type: 'string', enum: ITEMS } }, lab_validity_days: { type: 'integer', minimum: 1, maximum: 365 }, auto_pass: { type: 'boolean' }, external_results_count: { type: 'boolean' } }
  }
};

export const operations = {
  'GET /api/v1/cath-lab/cases/{id}/readiness/labs': { description: 'Resolves and persists the seven pre-procedure lab items and applies the labs-check automation. Read-through: the response reflects the state after refresh.', pathParameters: { id: BIGINT_WIRE }, response: 'CathLabReadinessResponse' },
  'POST /api/v1/cath-lab/cases/{id}/readiness/labs/order-missing': { description: 'Places the covering lab orders for every required item that is not ordered or stale (CBC covers Hb and platelets). Idempotent: codes with an open order are skipped.', pathParameters: { id: BIGINT_WIRE }, parameters: [idempotencyHeaderParameter], response: 'CathLabReadinessOrderMissingResponse' },
  'POST /api/v1/cath-lab/cases/{id}/readiness/labs/{item}/external-result': { description: 'Records an outside-laboratory value as an external-origin lab result (never signed off) and refreshes readiness. The only route that may create such a row.', pathParameters: { id: BIGINT_WIRE, item: { type: 'string', enum: ITEMS } }, parameters: [idempotencyHeaderParameter], request: 'CathLabReadinessExternalResultRequest', response: 'CathLabReadinessExternalResultResponse' },
  'POST /api/v1/cath-lab/cases/{id}/readiness/labs/{item}/waive': { pathParameters: { id: BIGINT_WIRE, item: { type: 'string', enum: ITEMS } }, request: 'CathLabReadinessWaiveRequest', response: 'CathLabReadinessResponse' },
  'GET /api/v1/admin/cath-consumables/lab-readiness-settings': { response: 'CathLabReadinessSettingsResponse' },
  'PUT /api/v1/admin/cath-consumables/lab-readiness-settings': { request: 'CathLabReadinessSettingsUpdateRequest', response: 'CathLabReadinessSettingsResponse' }
};
```

In `lab.mjs`, find the lab result item schema (`grep -n "performed_by_lab" apps/backend/scripts/openapi/schemas/lab.mjs`) and add `result_origin: { type: 'string', enum: ['analyzer', 'manual_in_house', 'external_lab'], nullable: true }, external_lab_name: nullableString, external_report_ref: nullableString, external_reported_on: { type: 'string', format: 'date', nullable: true }` beside it. Register the module in `generate-openapi.mjs`, then `npm run openapi:generate && npm run openapi:check && npm test -- --testPathPatterns unit/openapi`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes apps/backend/scripts/openapi apps/backend/scripts/generate-openapi.mjs apps/backend/src/docs/openapi.json
git commit -m "feat(api): cath lab readiness routes and settings with OpenAPI contracts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: Staff app — per-check readiness list, labs expansion, actions

**Files:**
- Create: `apps/staff/lib/features/cath_lab/models/cath_readiness_models.dart`, `widgets/cath_readiness_checklist.dart`, `widgets/cath_lab_readiness_panel.dart`, `widgets/cath_external_result_sheet.dart`
- Modify: `apps/staff/lib/features/cath_lab/services/cath_lab_api_service.dart`, `screens/cath_lab_screen.dart` (`_ReadinessCard` 956–1029, `CathLabScreen` constructor for a new `readinessDependencies` field), `apps/staff/lib/l10n/app_strings.dart`
- Test: `apps/staff/test/features/cath_lab/cath_readiness_checklist_test.dart`

- [ ] **Step 1: Models**

```dart
// apps/staff/lib/features/cath_lab/models/cath_readiness_models.dart
class CathReadinessCheck {
  const CathReadinessCheck({required this.checkType, required this.status, required this.required, this.completedBy = '', this.notes = '', this.criticalWarning = false, this.autoManaged = false});
  final String checkType;
  final String status; // pending | pass | fail | waived | not_applicable
  final bool required;
  final String completedBy;
  final String notes;
  final bool criticalWarning;
  final bool autoManaged;
  bool get cleared => const {'pass', 'waived', 'not_applicable'}.contains(status);

  factory CathReadinessCheck.fromJson(Map<String, dynamic> json) {
    final meta = json['metadata'] is Map ? Map<String, dynamic>.from(json['metadata'] as Map) : const <String, dynamic>{};
    return CathReadinessCheck(
      checkType: _text(json['check_type']),
      status: _text(json['status'], fallback: 'pending'),
      required: json['required'] != false,
      completedBy: _text(json['completed_by']),
      notes: _text(json['notes']),
      criticalWarning: meta['critical_warning'] == true,
      autoManaged: meta['auto_managed'] == true,
    );
  }
}

class CathLabReadinessItem {
  const CathLabReadinessItem({required this.itemCode, required this.required, required this.state, required this.isCritical, this.valueText = '', this.unit = '', this.abnormalFlag = '', this.observedAt, this.orderedAt, this.source = ''});
  final String itemCode;
  final bool required;
  final String state;
  final bool isCritical;
  final String valueText;
  final String unit;
  final String abnormalFlag;
  final DateTime? observedAt;
  final DateTime? orderedAt;
  final String source;
  bool get available => const {'result_final', 'result_preliminary', 'external_recorded', 'waived'}.contains(state);
  bool get awaiting => state == 'ordered_awaiting_sample' || state == 'sample_sent_awaiting_result';

  factory CathLabReadinessItem.fromJson(Map<String, dynamic> json) => CathLabReadinessItem(
    itemCode: _text(json['item_code']), required: json['required'] != false, state: _text(json['state'], fallback: 'not_ordered'),
    isCritical: json['is_critical'] == true, valueText: _text(json['value_text']), unit: _text(json['unit']), abnormalFlag: _text(json['abnormal_flag']),
    observedAt: _date(json['observed_at']), orderedAt: _date(json['ordered_at']), source: _text(json['source']),
  );
}

class CathLabReadiness {
  const CathLabReadiness({required this.checkStatus, required this.autoManaged, required this.criticalWarning, required this.criticalItems, required this.items, required this.orderableNow, required this.caseStarted});
  final String checkStatus;
  final bool autoManaged;
  final bool criticalWarning;
  final List<String> criticalItems;
  final List<CathLabReadinessItem> items;
  final List<String> orderableNow;
  final bool caseStarted;
  List<CathLabReadinessItem> get missing => items.where((i) => i.required && !i.available).toList();

  factory CathLabReadiness.fromJson(Map<String, dynamic> json) => CathLabReadiness(
    checkStatus: _text(json['check_status'], fallback: 'pending'), autoManaged: json['auto_managed'] == true, criticalWarning: json['critical_warning'] == true,
    criticalItems: _strings(json['critical_items']),
    items: json['items'] is List ? (json['items'] as List).whereType<Map>().map((m) => CathLabReadinessItem.fromJson(Map<String, dynamic>.from(m))).toList() : const [],
    orderableNow: _strings(json['orderable_now']), caseStarted: json['case_started'] == true,
  );
}

class CathCaseReadiness {
  const CathCaseReadiness({required this.checks, required this.ready, required this.labs});
  final List<CathReadinessCheck> checks;
  final bool ready;
  final CathLabReadiness? labs;

  factory CathCaseReadiness.fromJson(Map<String, dynamic> json) => CathCaseReadiness(
    checks: json['readiness'] is List ? (json['readiness'] as List).whereType<Map>().map((m) => CathReadinessCheck.fromJson(Map<String, dynamic>.from(m))).toList() : const [],
    ready: json['readiness_gate'] is Map && (json['readiness_gate'] as Map)['ready'] == true,
    labs: json['lab_readiness'] is Map ? CathLabReadiness.fromJson(Map<String, dynamic>.from(json['lab_readiness'] as Map)) : null,
  );
}

class CathExternalResultDraft {
  const CathExternalResultDraft({required this.item, required this.valueText, required this.observedOn, required this.externalLabName, this.valueNumeric, this.unit, this.externalReportRef, this.notes});
  final String item;
  final String valueText;
  final double? valueNumeric;
  final String? unit;
  final String observedOn; // YYYY-MM-DD
  final String externalLabName;
  final String? externalReportRef;
  final String? notes;
  Map<String, dynamic> toJson() => {
    'value_text': valueText, if (valueNumeric != null) 'value_numeric': valueNumeric, if ((unit ?? '').isNotEmpty) 'unit': unit,
    'observed_on': observedOn, 'external_lab_name': externalLabName,
    if ((externalReportRef ?? '').isNotEmpty) 'external_report_ref': externalReportRef, if ((notes ?? '').isNotEmpty) 'notes': notes,
  };
}

String _text(Object? v, {String fallback = ''}) { final t = v?.toString().trim() ?? ''; return t.isEmpty ? fallback : t; }
DateTime? _date(Object? v) { final t = _text(v); return t.isEmpty ? null : DateTime.tryParse(t)?.toLocal(); }
List<String> _strings(Object? v) => v is List ? v.map((e) => _text(e)).where((e) => e.isNotEmpty).toList() : const [];
```

- [ ] **Step 2: API service** (append; the file's `_successfulData`, `ApiClient` and `_mapList` helpers exist)

```dart
  /// GET /cath-lab/cases/:id — readiness checks, gate and lab readiness.
  static Future<CathCaseReadiness> fetchCaseReadiness(int caseId) async {
    final response = await ApiClient.get('/cath-lab/cases/$caseId');
    final data = _successfulData(response, 'Failed to load Cath Lab case');
    final raw = data['case'] is Map ? Map<String, dynamic>.from(data['case'] as Map) : data;
    return CathCaseReadiness.fromJson(raw);
  }

  /// POST /cath-lab/cases/:id/readiness — the existing human status control.
  static Future<void> updateReadinessCheck(int caseId, {required String checkType, required String status, String? notes}) async {
    final response = await ApiClient.post('/cath-lab/cases/$caseId/readiness', body: {
      'check_type': checkType, 'status': status, if ((notes ?? '').isNotEmpty) 'notes': notes,
    });
    if (!response.isSuccess) throw Exception(response.failureMessage('Failed to update readiness'));
  }

  static Future<CathLabReadiness> orderMissingLabs(int caseId, {required String idempotencyKey}) async {
    final response = await ApiClient.post('/cath-lab/cases/$caseId/readiness/labs/order-missing', body: const {}, idempotencyKey: idempotencyKey);
    final data = _successfulData(response, 'Failed to order missing labs');
    return CathLabReadiness.fromJson(Map<String, dynamic>.from(data['readiness'] as Map));
  }

  static Future<CathLabReadiness> recordExternalLabResult(int caseId, CathExternalResultDraft draft, {required String idempotencyKey}) async {
    final response = await ApiClient.post('/cath-lab/cases/$caseId/readiness/labs/${draft.item}/external-result', body: draft.toJson(), idempotencyKey: idempotencyKey);
    final data = _successfulData(response, 'Failed to record outside result');
    return CathLabReadiness.fromJson(Map<String, dynamic>.from(data['readiness'] as Map));
  }

  static Future<CathLabReadiness> waiveLabItem(int caseId, String item, {required String reason}) async {
    final response = await ApiClient.post('/cath-lab/cases/$caseId/readiness/labs/$item/waive', body: {'reason': reason});
    final data = _successfulData(response, 'Failed to waive lab item');
    return CathLabReadiness.fromJson(data);
  }
```

Confirm the `GET /cath-lab/cases/:id` response key (`data.case` or the case object itself) by reading the handler at `cathLabRoutes.js` ≈330-343 and adjust `fetchCaseReadiness` to match.

- [ ] **Step 3: Widgets**

`cath_readiness_checklist.dart` — a `CathReadinessChecklist(caseId, dependencies)` stateful widget with a `CathReadinessDependencies` bag (`loadReadiness`, `updateCheck`, `orderMissing`, `recordExternal`, `waiveItem`, all nullable, defaulting to the `CathLabApiService` statics). It loads on `initState`, renders the eight checks as `ListTile`s (icon: check_circle for cleared, radio_button_unchecked for pending, cancel for fail) with a trailing `PopupMenuButton<String>` (`key: ValueKey('cath-readiness-status-<checkType>')`, items pass / fail / waived / not_applicable / pending) that calls `updateCheck` then reloads. The `labs` tile shows, beside its status icon, a red `Chip` (`key: ValueKey('cath-readiness-critical-badge')`, label from `s4.lib.cath_lab.readiness.critical_value`) when `labs?.criticalWarning == true`, and expands into `CathLabReadinessPanel`.

`cath_lab_readiness_panel.dart` — `CathLabReadinessPanel(caseId, labs, onChanged, dependencies)`: one row per item (`key: ValueKey('cath-lab-item-<itemCode>')`) with a state chip coloured green (result_final), blue (external_recorded, text "external, unverified"), teal (result_preliminary), amber (awaiting states, label names the stage and `orderedAt`), red (not_ordered), grey (stale, showing the old date), and the value with unit and a red "critical" chip when `isCritical`; then a `Wrap` of actions: `FilledButton` "Order missing labs" (`key: ValueKey('cath-lab-order-missing')`, visible when `labs.orderableNow.isNotEmpty && !labs.caseStarted`), per-item `TextButton` "Enter outside result" (`key: ValueKey('cath-lab-external-<itemCode>')`, visible when `!item.available && !labs.caseStarted`) opening `CathExternalResultSheet`, and per-item "Waive" (`key: ValueKey('cath-lab-waive-<itemCode>')`) opening a reason dialog. Each action calls the dependency, then `onChanged(newLabs)`; idempotency keys come from `IdempotencyAttempt('cath-lab-order-<caseId>')` and `IdempotencyAttempt('cath-lab-external-<caseId>-<item>')`.

`cath_external_result_sheet.dart` — a bottom-sheet `Form` for one item: for `hiv`/`hbsag`/`hcv` a `DropdownButtonFormField` over Reactive / Non-reactive / Indeterminate (`key: ValueKey('cath-external-value-select')`); otherwise a numeric field (`key: ValueKey('cath-external-value')`) and unit prefilled from the item (`g/dL`, `10^3/uL`, `mg/dL`, `mmol/L`); a date field defaulting to today (`key: ValueKey('cath-external-date')`, `showDatePicker`, `lastDate: DateTime.now()`), lab name (`key: ValueKey('cath-external-lab')`, required), report reference and notes; a save button (`key: ValueKey('cath-external-save')`) that pops a `CathExternalResultDraft`. Show a one-line note under the title: `s4.lib.cath_lab.readiness.external_unverified_hint`.

In `cath_lab_screen.dart`, `CathLabScreen` gains `this.readinessDependencies = const CathReadinessDependencies()`, threads it to `_ReadinessCard`, and `_ReadinessCard` renders `CathReadinessChecklist(caseId: cathCase.id, dependencies: readinessDependencies)` between the progress row and `CathQuickWinsPanel`.

- [ ] **Step 4: Strings (five maps)**

| key | en | hi | ta | te | ml |
|---|---|---|---|---|---|
| `s4.lib.cath_lab.readiness.critical_value` | Critical value | गंभीर मान | ஆபத்தான மதிப்பு | క్లిష్ట విలువ | ഗുരുതര മൂല്യം |
| `s4.lib.cath_lab.readiness.order_missing` | Order missing labs | छूटी जांचें ऑर्डर करें | விடுபட்ட பரிசோதனைகளை ஆர்டர் செய் | తప్పిపోయిన పరీక్షలను ఆర్డర్ చేయండి | വിട്ടുപോയ പരിശോധനകൾ ഓർഡർ ചെയ്യുക |
| `s4.lib.cath_lab.readiness.enter_external` | Enter outside result | बाहरी परिणाम दर्ज करें | வெளி முடிவை உள்ளிடு | బయటి ఫలితాన్ని నమోదు చేయండి | പുറത്തുനിന്നുള്ള ഫലം രേഖപ്പെടുത്തുക |
| `s4.lib.cath_lab.readiness.waive` | Waive | छूट दें | விலக்கு | మినహాయించు | ഒഴിവാക്കുക |
| `s4.lib.cath_lab.readiness.external_unverified_hint` | Stored as an external lab result, unverified by a pathologist | बाहरी प्रयोगशाला परिणाम के रूप में सहेजा गया, पैथोलॉजिस्ट द्वारा असत्यापित | வெளி ஆய்வக முடிவாக சேமிக்கப்பட்டது; நோயியல் நிபுணரால் சரிபார்க்கப்படவில்லை | బాహ్య ల్యాబ్ ఫలితంగా నిల్వ; పాథాలజిస్ట్ ధృవీకరించలేదు | ബാഹ്യ ലാബ് ഫലമായി സൂക്ഷിച്ചു; പാത്തോളജിസ്റ്റ് പരിശോധിച്ചിട്ടില്ല |
| `s4.lib.cath_lab.readiness.state.result_final` | Result | परिणाम | முடிவு | ఫలితం | ഫലം |
| `s4.lib.cath_lab.readiness.state.result_preliminary` | Preliminary | प्रारंभिक | ஆரம்ப | ప్రాథమిక | പ്രാഥമികം |
| `s4.lib.cath_lab.readiness.state.external_recorded` | External, unverified | बाहरी, असत्यापित | வெளி, சரிபார்க்கப்படாதது | బాహ్య, ధృవీకరించనిది | ബാഹ്യം, പരിശോധിക്കാത്തത് |
| `s4.lib.cath_lab.readiness.state.sample_sent_awaiting_result` | Sent to lab, awaiting result | प्रयोगशाला भेजा गया, परिणाम प्रतीक्षित | ஆய்வகத்திற்கு அனுப்பப்பட்டது; முடிவு நிலுவை | ల్యాబ్‌కు పంపారు; ఫలితం వేచి ఉంది | ലാബിലേക്ക് അയച്ചു; ഫലം കാത്തിരിക്കുന്നു |
| `s4.lib.cath_lab.readiness.state.ordered_awaiting_sample` | Ordered, sample not collected | ऑर्डर किया गया, नमूना नहीं लिया गया | ஆர்டர் செய்யப்பட்டது; மாதிரி எடுக்கப்படவில்லை | ఆర్డర్ చేశారు; నమూనా సేకరించలేదు | ഓർഡർ ചെയ്തു; സാമ്പിൾ എടുത്തിട്ടില്ല |
| `s4.lib.cath_lab.readiness.state.not_ordered` | Not ordered | ऑर्डर नहीं किया गया | ஆர்டர் செய்யப்படவில்லை | ఆర్డర్ చేయలేదు | ഓർഡർ ചെയ്തിട്ടില്ല |
| `s4.lib.cath_lab.readiness.state.stale` | Result too old | परिणाम बहुत पुराना | முடிவு மிகப் பழையது | ఫలితం చాలా పాతది | ഫലം വളരെ പഴയത് |
| `s4.lib.cath_lab.readiness.state.waived` | Waived | छूट दी गई | விலக்கப்பட்டது | మినహాయించారు | ഒഴിവാക്കി |
| `s4.lib.cath_lab.readiness.item.hb` | Haemoglobin | हीमोग्लोबिन | ஹீமோகுளோபின் | హిమోగ్లోబిన్ | ഹീമോഗ്ലോബിൻ |
| `s4.lib.cath_lab.readiness.item.platelets` | Platelets | प्लेटलेट्स | தட்டணுக்கள் | ప్లేట్‌లెట్లు | പ്ലേറ്റ്‌ലെറ്റുകൾ |
| `s4.lib.cath_lab.readiness.item.creatinine` | Creatinine | क्रिएटिनिन | கிரியேட்டினின் | క్రియాటినిన్ | ക്രിയാറ്റിനിൻ |
| `s4.lib.cath_lab.readiness.item.potassium` | Potassium | पोटैशियम | பொட்டாசியம் | పొటాషియం | പൊട്ടാസ്യം |
| `s4.lib.cath_lab.readiness.item.hiv` | HIV | HIV | HIV | HIV | HIV |
| `s4.lib.cath_lab.readiness.item.hbsag` | HBsAg | HBsAg | HBsAg | HBsAg | HBsAg |
| `s4.lib.cath_lab.readiness.item.hcv` | HCV | HCV | HCV | HCV | HCV |

Same OPEN-21 note as Plan 2: these pass the parity gate and go to the named linguistic reviewers.

- [ ] **Step 5: Widget test**

```dart
// apps/staff/test/features/cath_lab/cath_readiness_checklist_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vhhealth_staff/features/cath_lab/models/cath_readiness_models.dart';
import 'package:vhhealth_staff/features/cath_lab/widgets/cath_readiness_checklist.dart';

CathCaseReadiness _readiness({required String labsStatus, bool critical = false, List<Map<String, dynamic>> items = const []}) =>
    CathCaseReadiness.fromJson({
      'readiness': [
        for (final t in ['consent', 'labs', 'allergy_renal_risk', 'anticoagulation', 'blood_bank', 'equipment', 'implants_device_rep', 'timeout'])
          {'check_type': t, 'status': t == 'labs' ? labsStatus : 'pending', 'required': true, 'metadata': t == 'labs' ? {'critical_warning': critical, 'auto_managed': true} : {}},
      ],
      'readiness_gate': {'ready': false},
      'lab_readiness': {'check_status': labsStatus, 'auto_managed': true, 'critical_warning': critical, 'critical_items': critical ? ['potassium'] : [], 'items': items, 'orderable_now': ['HCV'], 'case_started': false},
    });

Widget _wrap(CathReadinessDependencies deps) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: CathReadinessChecklist(caseId: 42, dependencies: deps))));

void main() {
  testWidgets('renders all eight checks with a status control, and the critical badge on labs', (tester) async {
    await tester.pumpWidget(_wrap(CathReadinessDependencies(
      loadReadiness: (_) async => _readiness(labsStatus: 'pass', critical: true, items: [
        {'item_code': 'potassium', 'required': true, 'state': 'result_final', 'is_critical': true, 'value_text': '6.3', 'unit': 'mmol/L', 'abnormal_flag': 'HH'},
        {'item_code': 'hcv', 'required': true, 'state': 'not_ordered', 'is_critical': false},
      ]),
    )));
    await tester.pumpAndSettle();
    for (final t in ['consent', 'labs', 'timeout']) {
      expect(find.byKey(ValueKey('cath-readiness-status-$t')), findsOneWidget);
    }
    expect(find.byKey(const ValueKey('cath-readiness-critical-badge')), findsOneWidget);
    expect(find.byKey(const ValueKey('cath-lab-item-potassium')), findsOneWidget);
    expect(find.text('Not ordered'), findsOneWidget);
    expect(find.byKey(const ValueKey('cath-lab-order-missing')), findsOneWidget);
  });

  testWidgets('order missing labs calls the dependency with an idempotency key and reloads', (tester) async {
    var ordered = 0;
    var loads = 0;
    await tester.pumpWidget(_wrap(CathReadinessDependencies(
      loadReadiness: (_) async { loads++; return _readiness(labsStatus: 'pending', items: [{'item_code': 'hcv', 'required': true, 'state': loads > 1 ? 'ordered_awaiting_sample' : 'not_ordered', 'is_critical': false}]); },
      orderMissing: (caseId, {required idempotencyKey}) async { ordered++; expect(idempotencyKey, isNotEmpty); return _readiness(labsStatus: 'pending').labs!; },
    )));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-lab-order-missing')));
    await tester.pumpAndSettle();
    expect(ordered, 1);
    expect(loads, greaterThanOrEqualTo(2));
  });

  testWidgets('outside serology result sheet posts a qualitative draft', (tester) async {
    CathExternalResultDraft? sent;
    await tester.pumpWidget(_wrap(CathReadinessDependencies(
      loadReadiness: (_) async => _readiness(labsStatus: 'pending', items: [{'item_code': 'hbsag', 'required': true, 'state': 'not_ordered', 'is_critical': false}]),
      recordExternal: (caseId, draft, {required idempotencyKey}) async { sent = draft; return _readiness(labsStatus: 'pass').labs!; },
    )));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('cath-lab-external-hbsag')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('cath-external-lab')), 'City Path Lab');
    await tester.tap(find.byKey(const ValueKey('cath-external-save')));
    await tester.pumpAndSettle();
    expect(sent!.item, 'hbsag');
    expect(sent!.valueText.toLowerCase(), 'non-reactive'); // dropdown default
    expect(sent!.externalLabName, 'City Path Lab');
  });
}
```

- [ ] **Step 6: Gates and commit**

```bash
cd apps/staff && flutter analyze && flutter test test/features/cath_lab
# parity gate: the command grep -rn "parity" ../../.github/workflows/*.yml names
git add apps/staff
git commit -m "feat(staff): cath readiness checklist with lab items, critical badge, order-missing and outside results

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: Admin settings editor

**Files:**
- Modify: `apps/admin/src/lib/api/cathDevices.ts` (or create `cathLabReadiness.ts` if Plan 2 has not landed)
- Create: `apps/admin/src/app/(with-auth)/dashboard/quality/cath/components/LabReadinessSettingsTab.tsx`
- Modify: `apps/admin/src/app/(with-auth)/dashboard/quality/cath/page.tsx`
- Test: `apps/admin/src/__tests__/dashboard/quality/cath-lab-readiness.test.tsx`

- [ ] **Step 1: API**

```ts
export const CATH_LAB_READINESS_ITEMS = ["hb", "platelets", "creatinine", "potassium", "hiv", "hbsag", "hcv"] as const;
export type CathLabReadinessSettings = { required_items: string[]; lab_validity_days: number; auto_pass: boolean; external_results_count: boolean; configured: boolean };
export function getCathLabReadinessSettings() { return getJSON<{ settings: CathLabReadinessSettings }>("/api/v1/admin/cath-consumables/lab-readiness-settings"); }
export function updateCathLabReadinessSettings(body: Partial<Omit<CathLabReadinessSettings, "configured">>) { return putJSON<{ settings: CathLabReadinessSettings }>("/api/v1/admin/cath-consumables/lab-readiness-settings", body); }
```

- [ ] **Step 2: Tab**

A form with: seven checkboxes (`aria-label="Require <item>"`), a number input `aria-label="Lab validity days"` (1–365), two checkboxes `aria-label="Auto-pass labs check"` and `aria-label="External results count"`, and a save button `Save lab readiness settings` wired to `useMutation(updateCathLabReadinessSettings)` with `toast` on success/error and `queryClient.invalidateQueries({ queryKey: ["cath", "lab-readiness"] })`. Copy the layout and class names of `ReprocessingPolicyTab.tsx` (Plan 2) so the two tabs match; explain each switch in one line of muted text: "A critical value never blocks; it shows a warning beside the tick." Add `{ key: "lab-readiness", label: "Lab readiness", icon: FlaskConical }` to `TABS` in `quality/cath/page.tsx` and render the tab.

- [ ] **Step 3: Test**

```tsx
import LabReadinessSettingsTab from "@/app/(with-auth)/dashboard/quality/cath/components/LabReadinessSettingsTab";
import * as api from "@/lib/api/cathDevices";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/api/cathDevices", () => ({ ...jest.requireActual("@/lib/api/cathDevices"), getCathLabReadinessSettings: jest.fn(), updateCathLabReadinessSettings: jest.fn() }));
jest.mock("react-hot-toast", () => ({ __esModule: true, toast: { success: jest.fn(), error: jest.fn() }, default: { success: jest.fn(), error: jest.fn() } }));

it("loads defaults and saves an edited validity window", async () => {
  jest.mocked(api.getCathLabReadinessSettings).mockResolvedValue({ settings: { required_items: ["hb", "platelets", "creatinine", "potassium", "hiv", "hbsag", "hcv"], lab_validity_days: 30, auto_pass: true, external_results_count: true, configured: false } });
  jest.mocked(api.updateCathLabReadinessSettings).mockResolvedValue({ settings: { required_items: ["hb"], lab_validity_days: 14, auto_pass: true, external_results_count: true, configured: true } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><LabReadinessSettingsTab /></QueryClientProvider>);
  const days = await screen.findByLabelText("Lab validity days");
  fireEvent.change(days, { target: { value: "14" } });
  fireEvent.click(screen.getByText("Save lab readiness settings"));
  await waitFor(() => expect(api.updateCathLabReadinessSettings).toHaveBeenCalledWith(expect.objectContaining({ lab_validity_days: 14 })));
});
```

- [ ] **Step 4: Gates and commit**

```bash
cd apps/admin && npm run type-check && npm run lint && npm run format:check && npm test -- --testPathPattern "quality/cath"
git add apps/admin
git commit -m "feat(admin): cath lab readiness settings editor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: Gates and hand-back

Same procedure as Plan 2 Task 8 with branch `feat/cath-lab-readiness`, scratch DB `vh_clr_<initials>`, deep suites `cath-lab-readiness.deep|lab-signoff-safety.deep|lab-panel-critical-path.deep|lab-corrected-signoff-reack.deep|bloodborne-markers.deep`, and a PR body that states: spec path; migration number and the branch check; that the eight `check_type` values are unchanged and automation only alters rows it set; that a critical value never blocks by owner decision; the `lab_results` origin columns and which writers set them; that the public manual route rejects origin fields; the deep suite counts; OpenAPI regeneration; Staff strings pending OPEN-21 review; `Merge Gate` / `Full Merge Gate` by name with the head SHA. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Draft only; merge authority stays with the coordinating session.

---

## Self-review against the spec

- §3 automation manages only its own rows; critical never blocks: Task 2 (`computeCheckDecision`), Task 3 (`refreshCaseLabReadiness` metadata `auto_managed`).
- §5 code map: consumed from Plan 1's `labAnalyteCodes.js`; `orderCodesCovering` drives §8.1.
- §6.1 settings table and defaults; §6.2 items table; §6.3 `lab_results` columns and the internal escape; §6.4 `labs` row fields: Task 1 + Task 3 Steps 1, 3.
- §7 resolution order (result → open order → stale → not ordered; waiver overrides; specimen state decides; window per item with serology from the reuse settings): Task 2 + Task 3 Step 1.
- §7 refresh triggers: on read (`getCase`, `GET …/readiness/labs`), on lab events (manual, panel, sign-off, ORU ingest; ASTM and external-recovery rows are picked up on read — stated in Task 3 Step 3(i)–(j)), explicit refresh route: Task 3 Step 5, Task 4 Step 1.
- §8.1 order-missing with CBC covering two items and idempotent skip: Task 3 Step 2. §8.2 external entry, canonical analyte code, `performed_by_lab` = lab name, marker creation for serology, audit: Task 3 Steps 2–3. §8.3 waive: Task 3 Step 2. §8.4 human pass over critical → safety review: Task 3 Step 5.
- §9 payload shape: `refreshCaseLabReadiness` return + `CathLabReadiness` schema (Task 4). The `_missing_items` helper key is declared in the schema so the strict contract accepts it; drop it from the payload and the schema together if the reviewer prefers.
- §10 Staff per-check list (new), labs expansion, actions, critical badge: Task 5. §11 error codes: `CATH_LAB_READINESS_ITEM_UNKNOWN`, `CATH_LAB_READINESS_VALUE_INVALID`, `CATH_LAB_READINESS_ORDER_FAILED` (thrown as an internal AppError carrying the code; the spec's 502 is not a constructor `AppError` offers, so the client keys on the code), `CATH_LAB_READINESS_CASE_STARTED`, and the public route's `LAB_RESULT_ORIGIN_NOT_ALLOWED` plus `LAB_RESULT_EXTERNAL_PROVENANCE_REQUIRED` for the internal escape.
- §13 tests: unit (Task 2, Task 3 Step 4), deep (Task 3 Step 6) including auto-pass, critical-with-warning, stale flip before/after start, human pass untouched, external entry + marker + policy off, public path forcing, order-missing idempotency, waiver; mutation checks: after Task 3, delete the `autoManaged` guard in `computeCheckDecision` and confirm the human-pass unit test goes red; delete the `!started` guard and confirm the post-start unit test goes red; restore both.
- §14 rollout defaults: `SETTINGS_DEFAULTS` and the migration defaults agree (all seven, 30 days, auto-pass on, external counts).
- Type consistency: `resolveItemState({ item, results, orders, specimens, waiver, windowDays, asOf })` is called identically in the unit test and in `refreshCaseLabReadiness`; `computeCheckDecision({ items, settings, check, caseRow })` likewise; Staff `CathExternalResultDraft.toJson()` emits the keys `CathLabReadinessExternalResultRequest` declares.
