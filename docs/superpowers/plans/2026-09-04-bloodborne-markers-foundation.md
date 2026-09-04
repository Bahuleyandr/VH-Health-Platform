# Blood-borne Marker Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the platform-level patient blood-borne marker record (HIV, HBsAg, HCV, CJD-suspected, other) with its resolver, the lab sign-off hook that feeds it, a read/void API, and the shared lab analyte code map that the cath device-reuse and pre-cath lab-readiness plans consume.

**Architecture:** One new table (`patient_bloodborne_markers`, append-only with voiding, tenant RLS), one service module (`bloodborneMarkerService.js`) that owns the value normaliser, the pure `computeReuseStatus` function, the DB writers and an exposure-handler registry, one shared constants module (`labAnalyteCodes.js`), a post-commit hook in the lab sign-off path, and a small router mounted like the allergy router. Nothing in this plan touches cath or CSSD code; those are Plans 2 and 3.

**Tech Stack:** Node 26 ESM backend (Express, Prisma raw SQL via `setTenantTx`/`setTenant`, Postgres 17 with RLS), jest with `--experimental-vm-modules`, OpenAPI overlay modules under `apps/backend/scripts/openapi/schemas`.

**Spec:** `docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md` §5.1, §7; companion spec §5 (code map).

**Base:** branch `design/cath-device-reuse` at `b3a4619b1` (main `f60df4e95`). Work on a new branch `feat/bloodborne-markers` cut from `github/main`, in a worktree under the session scratchpad (never `.claude/worktrees/`, which breaks jest: 0 tests, exit 0).

---

## Conventions you must follow (read once)

- **Every DB write goes through `setTenantTx(tenantId, async (tx) => …)`** from `apps/backend/src/lib/prisma.js`; reads outside a request context go through `setTenant(tenantId, (tx) => …)`. The bare `prisma` client no longer bypasses RLS.
- **Raw SQL only** for the new table (`tx.$queryRawUnsafe(sql, ...params)` with `$n::type` casts; jsonb params need `::jsonb`).
- **Errors** are `AppError.badRequest|conflict|notFound|forbidden|internal(message, CODE, details?)` from `apps/backend/src/utils/AppError.js`.
- **Tests**: unit tests live in `apps/backend/src/tests/unit/*.test.js` and must not touch the DB; deep tests live in `apps/backend/src/tests/*.deep.test.js`, guard on `DATABASE_URL`, seed their OWN tenant, clean up in `afterAll`, and give fixture-heavy tests a 30 s budget as the third argument to `test(...)`.
- **Run tests with npm, never the bare jest binary** (ESM): `npm test -- --testPathPatterns <pattern>` from `apps/backend`. Guard on npm's exit code; do not pipe through grep.
- **Migrations are immutable once pushed.** New file, new number, `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'; … COMMIT;`, every CHECK named, RLS block copied from `apps/backend/src/migrations/566_cath_consumables_billing_hook.sql:96-113`.
- **Schema drift gate:** `apps/backend/scripts/check-schema-drift.mjs` diffs `prisma db pull` against `apps/backend/prisma/schema.prisma`. Every new table and column must be mirrored in `schema.prisma` (relations on BOTH models).
- **Local DB for deep tests:** `apps/backend/.env` points at the QA cluster `127.0.0.1:55432`. Create your own scratch DB (`createdb -h 127.0.0.1 -p 55432 vh_bbm_<initials>`), then in that DB `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;`, then from `apps/backend`: `DATABASE_URL=postgres://…/vh_bbm_<initials> VH_ALLOW_NON_TEST_DATA_SEED=true node scripts/ci-setup-db.mjs` (about 2.5 minutes). Drop the DB when done.
- **Commit messages** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. The LAST commit before hand-back carries `[full-ci]` in its subject. Hand back as a DRAFT PR; do not merge, do not mark ready.

---

## File structure

| File | Responsibility |
|---|---|
| Create `apps/backend/src/services/lab/labAnalyteCodes.js` | The single order-code / analyte-code / LOINC map for the seven lab items and the three serology markers. Pure constants + lookup functions. |
| Create `apps/backend/src/tests/unit/labAnalyteCodes.test.js` | Pins every alias row of the map. |
| Create `apps/backend/src/migrations/765_patient_bloodborne_markers.sql` | The marker table, indexes, RLS. |
| Modify `apps/backend/prisma/schema.prisma` | Mirror the new table (drift gate). |
| Create `apps/backend/src/services/clinical/bloodborneMarkerService.js` | Normaliser, `computeReuseStatus`, `resolveReuseStatus`, `recordMarkerTx`, `recordMarkers`, `recordMarkersFromSignedResults`, `listMarkersForPatient`, `voidMarker`, exposure-handler registry. |
| Create `apps/backend/src/tests/unit/bloodborneMarkerService.test.js` | Normaliser and resolver rules, exposure registry. |
| Create `apps/backend/src/tests/bloodborne-markers.deep.test.js` | DB behaviour: record, idempotent lab replay, corrective void + reinsert, void endpoint semantics, RLS isolation. |
| Modify `apps/backend/src/services/lab/labResultsService.js:2446` | Post-commit hook call in `signOffResults`. |
| Modify `apps/backend/src/tests/unit/labResultsService.test.js` | Mock the marker module so the existing hermetic unit test stays hermetic. |
| Create `apps/backend/src/routes/clinical/bloodborneMarkerRoutes.js` | `GET /patient/:patientUid`, `POST /patient/:patientUid/markers/:id/void`. |
| Modify `apps/backend/src/app.js` (import near :352, mount after :1639) | Mount mirroring the allergy router. |
| Create `apps/backend/scripts/openapi/schemas/bloodborneMarkers.mjs` | OpenAPI overlay for the two routes. |
| Modify `apps/backend/scripts/generate-openapi.mjs:36,89` | Register the module. |
| Regenerate `apps/backend/src/docs/openapi.json` | Via `npm run openapi:generate`. |

---

## Task 0: Branch and worktree

**Files:** none.

- [ ] **Step 1: Cut the branch from current main in a scratchpad worktree**

```bash
cd "/d/Dev/Projects/VH Health/VH-Health-Platform"
git fetch github main
git worktree add "$SCRATCH/wt/bbm" -b feat/bloodborne-markers github/main
cd "$SCRATCH/wt/bbm/apps/backend" && npm ci
```

Expected: worktree created at `github/main`'s SHA; `npm ci` completes (prisma generate can take 15–55 minutes silently; do not kill it).

- [ ] **Step 2: Confirm the migration number is free on main AND every open branch**

```bash
cd "$SCRATCH/wt/bbm"
git fetch github '+refs/heads/*:refs/remotes/github/*'
for ref in $(git for-each-ref --format='%(refname)' refs/remotes/github/); do
  git ls-tree --name-only "$ref" apps/backend/src/migrations/ 2>/dev/null
done | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | uniq | tail -3
```

Expected output ends with `763`, `764` (claimed by `audit/cath-implant-lifecycle`). This plan uses **765**. If the output shows 765 already claimed, use the next free number and substitute it everywhere below (file name and `_migrations` expectations). Re-run this check immediately before the final push.

---

## Task 1: Shared lab analyte code map

**Files:**
- Create: `apps/backend/src/services/lab/labAnalyteCodes.js`
- Test: `apps/backend/src/tests/unit/labAnalyteCodes.test.js`

- [ ] **Step 1: Write the failing test**

```js
// apps/backend/src/tests/unit/labAnalyteCodes.test.js
import {
  BLOODBORNE_MARKER_ITEM_CODES,
  LAB_ANALYTE_ITEMS,
  LAB_ANALYTE_ITEM_CODES,
  analyteItemForResult,
  markerForResult,
  orderCodesCovering,
} from '../../services/lab/labAnalyteCodes.js';

describe('labAnalyteCodes', () => {
  test('exposes exactly the seven readiness items in a stable order', () => {
    expect(LAB_ANALYTE_ITEM_CODES).toEqual([
      'hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv',
    ]);
    expect(BLOODBORNE_MARKER_ITEM_CODES).toEqual(['hiv', 'hbsag', 'hcv']);
  });

  test.each([
    ['HGB', 'hb'], ['hb', 'hb'], ['Haemoglobin', 'hb'], ['HEMOGLOBIN', 'hb'],
    ['PLT', 'platelets'], ['Platelet', 'platelets'], ['PLATELETS', 'platelets'],
    ['CREA', 'creatinine'], ['CREATININE', 'creatinine'], ['CREAT', 'creatinine'],
    ['K', 'potassium'], ['potassium', 'potassium'],
    ['HIV', 'hiv'], ['HIV1_2', 'hiv'], ['HIV-AB', 'hiv'],
    ['HBSAG', 'hbsag'], ['HBs Ag', 'hbsag'],
    ['HCV', 'hcv'], ['ANTI_HCV', 'hcv'], ['Anti-HCV', 'hcv'], ['HCV AB', 'hcv'],
  ])('maps analyte code %s to item %s', (code, item) => {
    expect(analyteItemForResult({ test_code: code })).toBe(item);
  });

  test.each([
    ['718-7', 'hb'], ['777-3', 'platelets'], ['2160-0', 'creatinine'], ['2823-3', 'potassium'],
  ])('falls back to LOINC %s when the local code is unknown', (loinc, item) => {
    expect(analyteItemForResult({ test_code: 'LOCAL-XYZ', loinc_code: loinc })).toBe(item);
  });

  test('prefers the local code over LOINC when both match', () => {
    expect(analyteItemForResult({ test_code: 'K', loinc_code: '718-7' })).toBe('potassium');
  });

  test('returns null for unknown codes and empty input', () => {
    expect(analyteItemForResult({ test_code: 'NA' })).toBeNull();
    expect(analyteItemForResult({})).toBeNull();
    expect(analyteItemForResult({ test_code: '', loinc_code: '' })).toBeNull();
  });

  test('markerForResult returns a marker only for the serology items', () => {
    expect(markerForResult({ test_code: 'HBSAG' })).toBe('hbsag');
    expect(markerForResult({ test_code: 'hiv' })).toBe('hiv');
    expect(markerForResult({ test_code: 'HCV' })).toBe('hcv');
    expect(markerForResult({ test_code: 'HGB' })).toBeNull();
    expect(markerForResult({ test_code: 'ZZZ' })).toBeNull();
  });

  test('every item names a canonical analyte code contained in its own alias list', () => {
    for (const item of LAB_ANALYTE_ITEM_CODES) {
      const def = LAB_ANALYTE_ITEMS[item];
      expect(def.analyteCodes).toContain(def.canonicalAnalyteCode);
      expect(def.orderCodes.length).toBeGreaterThan(0);
      expect(['quantitative', 'qualitative']).toContain(def.kind);
    }
  });

  test('orderCodesCovering orders CBC once for hb and platelets together', () => {
    expect(orderCodesCovering(['hb', 'platelets'])).toEqual(['CBC']);
    expect(orderCodesCovering(['potassium', 'creatinine'])).toEqual(['ELECTROLYTES', 'CREATININE']);
    expect(orderCodesCovering(['hcv', 'hiv', 'hbsag'])).toEqual(['HIV', 'HBSAG', 'HCV']);
    expect(orderCodesCovering([])).toEqual([]);
    expect(orderCodesCovering(['not-an-item'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/backend`: `npm test -- --testPathPatterns unit/labAnalyteCodes`
Expected: FAIL with `Cannot find module '../../services/lab/labAnalyteCodes.js'`.

- [ ] **Step 3: Write the module**

```js
// apps/backend/src/services/lab/labAnalyteCodes.js
//
// The one map between orderable investigation catalogue codes
// (investigation_test_catalog.code: CBC, PLT, CREATININE, KFT, ELECTROLYTES,
// HIV, HBSAG, HCV — migration 102) and the analyte codes that arrive on
// lab_results.test_code (HGB, PLT, CREA, K — migration 175; serology arrives
// under the catalogue code). There is no join key between the two tables, so
// every consumer (cath lab readiness, blood-borne marker hook) reads this map
// and nothing else. Extend the alias lists here; the unit test pins every row.

const item = ({
  canonicalAnalyteCode,
  analyteCodes,
  loincCodes = [],
  orderCodes,
  kind,
  unit = null,
  marker = null,
}) => Object.freeze({
  canonicalAnalyteCode,
  analyteCodes: Object.freeze(analyteCodes),
  loincCodes: Object.freeze(loincCodes),
  orderCodes: Object.freeze(orderCodes),
  kind,
  unit,
  marker,
});

export const LAB_ANALYTE_ITEMS = Object.freeze({
  hb: item({
    canonicalAnalyteCode: 'HGB',
    analyteCodes: ['HGB', 'HB', 'HAEMOGLOBIN', 'HEMOGLOBIN'],
    loincCodes: ['718-7'],
    orderCodes: ['CBC'],
    kind: 'quantitative',
    unit: 'g/dL',
  }),
  platelets: item({
    canonicalAnalyteCode: 'PLT',
    analyteCodes: ['PLT', 'PLATELET', 'PLATELETS'],
    loincCodes: ['777-3'],
    orderCodes: ['CBC', 'PLT'],
    kind: 'quantitative',
    unit: '10^3/uL',
  }),
  creatinine: item({
    canonicalAnalyteCode: 'CREA',
    analyteCodes: ['CREA', 'CREATININE', 'CREAT'],
    loincCodes: ['2160-0'],
    orderCodes: ['CREATININE', 'KFT'],
    kind: 'quantitative',
    unit: 'mg/dL',
  }),
  potassium: item({
    canonicalAnalyteCode: 'K',
    analyteCodes: ['K', 'POTASSIUM'],
    loincCodes: ['2823-3'],
    orderCodes: ['ELECTROLYTES'],
    kind: 'quantitative',
    unit: 'mmol/L',
  }),
  hiv: item({
    canonicalAnalyteCode: 'HIV',
    analyteCodes: ['HIV', 'HIV1_2', 'HIV_AB'],
    orderCodes: ['HIV'],
    kind: 'qualitative',
    marker: 'hiv',
  }),
  hbsag: item({
    canonicalAnalyteCode: 'HBSAG',
    analyteCodes: ['HBSAG', 'HBS_AG'],
    orderCodes: ['HBSAG'],
    kind: 'qualitative',
    marker: 'hbsag',
  }),
  hcv: item({
    canonicalAnalyteCode: 'HCV',
    analyteCodes: ['HCV', 'ANTI_HCV', 'HCV_AB'],
    orderCodes: ['HCV'],
    kind: 'qualitative',
    marker: 'hcv',
  }),
});

export const LAB_ANALYTE_ITEM_CODES = Object.freeze(Object.keys(LAB_ANALYTE_ITEMS));
export const BLOODBORNE_MARKER_ITEM_CODES = Object.freeze(
  LAB_ANALYTE_ITEM_CODES.filter((code) => LAB_ANALYTE_ITEMS[code].marker !== null),
);

// "HBs Ag", "Anti-HCV", "hiv-ab" all normalise to the underscore form used in
// the alias lists: uppercase, runs of spaces and hyphens become one underscore.
function normalizeCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function analyteItemForResult({ test_code = null, loinc_code = null } = {}) {
  const code = normalizeCode(test_code);
  if (code) {
    for (const [key, def] of Object.entries(LAB_ANALYTE_ITEMS)) {
      if (def.analyteCodes.includes(code)) return key;
    }
  }
  const loinc = String(loinc_code ?? '').trim();
  if (loinc) {
    for (const [key, def] of Object.entries(LAB_ANALYTE_ITEMS)) {
      if (def.loincCodes.includes(loinc)) return key;
    }
  }
  return null;
}

export function markerForResult(result = {}) {
  const key = analyteItemForResult(result);
  return key ? LAB_ANALYTE_ITEMS[key].marker : null;
}

// Which orderable codes cover a set of missing items. CBC covers hb and
// platelets at once; serology items order under their own catalogue code.
export function orderCodesCovering(items = []) {
  const wanted = new Set(items);
  const codes = [];
  if (wanted.has('hb') || wanted.has('platelets')) codes.push('CBC');
  if (wanted.has('potassium')) codes.push('ELECTROLYTES');
  if (wanted.has('creatinine')) codes.push('CREATININE');
  for (const key of BLOODBORNE_MARKER_ITEM_CODES) {
    if (wanted.has(key)) codes.push(LAB_ANALYTE_ITEMS[key].canonicalAnalyteCode);
  }
  return codes;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --testPathPatterns unit/labAnalyteCodes`
Expected: PASS, 8 test groups (the `test.each` rows expand to more).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/lab/labAnalyteCodes.js apps/backend/src/tests/unit/labAnalyteCodes.test.js
git commit -m "feat(lab): shared analyte code map for readiness items and serology markers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: Migration 765 — `patient_bloodborne_markers`

**Files:**
- Create: `apps/backend/src/migrations/765_patient_bloodborne_markers.sql`
- Modify: `apps/backend/prisma/schema.prisma` (append model; add back-relations on `users` and `lab_results`)

- [ ] **Step 1: Write the migration**

```sql
-- 765_patient_bloodborne_markers.sql
--
-- Platform-level patient blood-borne marker record (HIV, HBsAg, HCV,
-- CJD-suspected, other). Until now the only serology status lived inside
-- dialysis enrolment (dialysis_patients.hbsag_status/hcv_status/hiv_status,
-- migration 168) and blood-bank donor testing (tti_tests, migration 404); no
-- consumer outside those modules could ask "may a device used on this patient
-- be reprocessed?". Cath-lab device reuse is the first consumer
-- (docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md §5.1, §7);
-- OT and dialysis are named future consumers.
--
-- Append-only with voiding: a correction inserts a new row and voids the old
-- one; the resolver reads the latest non-voided row per marker.
--
-- Writers: the lab sign-off hook (source = lab_result, one row per signed
-- HIV/HBSAG/HCV result, idempotent through ux_patient_bloodborne_markers_lab_result)
-- and, in the companion cath readiness work, the checklist's external-result
-- and clinical-declaration paths. There is no general create endpoint.
--
-- No NOT VALID constraints; the table is new, so nothing joins the OPEN-15
-- validation backlog. Every CHECK is named so the inline-check census reads
-- it as declared.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE patient_bloodborne_markers (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT COALESCE(
    (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  ),
  patient_uid UUID NOT NULL,
  marker VARCHAR(32) NOT NULL,
  marker_label VARCHAR(120),
  result VARCHAR(20) NOT NULL,
  tested_on DATE NOT NULL,
  source VARCHAR(24) NOT NULL,
  lab_result_id INTEGER,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by UUID NOT NULL,
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  voided_at TIMESTAMPTZ(6),
  voided_by UUID,
  void_reason TEXT,
  notes TEXT,

  CONSTRAINT fk_patient_bloodborne_markers_patient
    FOREIGN KEY (patient_uid) REFERENCES users(uid) ON DELETE RESTRICT,
  CONSTRAINT fk_patient_bloodborne_markers_lab_result
    FOREIGN KEY (lab_result_id) REFERENCES lab_results(id) ON DELETE RESTRICT,
  CONSTRAINT patient_bloodborne_markers_marker_check
    CHECK (marker IN ('hiv', 'hbsag', 'hcv', 'cjd_suspected', 'other')),
  CONSTRAINT patient_bloodborne_markers_result_check
    CHECK (result IN ('reactive', 'non_reactive', 'indeterminate', 'pending')),
  CONSTRAINT patient_bloodborne_markers_source_check
    CHECK (source IN ('lab_result', 'external_report', 'clinical_declaration')),
  CONSTRAINT patient_bloodborne_markers_label_check
    CHECK (marker <> 'other' OR NULLIF(BTRIM(marker_label), '') IS NOT NULL),
  CONSTRAINT patient_bloodborne_markers_cjd_result_check
    CHECK (marker <> 'cjd_suspected' OR result IN ('reactive', 'non_reactive')),
  CONSTRAINT patient_bloodborne_markers_lab_link_check
    CHECK (source <> 'lab_result' OR lab_result_id IS NOT NULL),
  CONSTRAINT patient_bloodborne_markers_void_check
    CHECK (
      (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
      OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)
    )
);

CREATE INDEX idx_patient_bloodborne_markers_patient
  ON patient_bloodborne_markers (tenant_id, patient_uid, marker, tested_on DESC, id DESC);

-- One active marker row per signed lab result: the sign-off hook replays as a
-- no-op, and a corrective sign-off voids the old row before inserting the new.
CREATE UNIQUE INDEX ux_patient_bloodborne_markers_lab_result
  ON patient_bloodborne_markers (tenant_id, lab_result_id)
  WHERE lab_result_id IS NOT NULL AND voided_at IS NULL;

ALTER TABLE patient_bloodborne_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_bloodborne_markers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON patient_bloodborne_markers;
CREATE POLICY tenant_isolation ON patient_bloodborne_markers
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

- [ ] **Step 2: Apply it to your scratch DB and confirm the constraints exist by name**

```bash
cd apps/backend
DATABASE_URL=postgres://…/vh_bbm_<initials> node scripts/ci-setup-db.mjs
psql "postgres://…/vh_bbm_<initials>" -c "SELECT conname FROM pg_constraint WHERE conrelid = 'patient_bloodborne_markers'::regclass ORDER BY conname;"
```

Expected: the seven `patient_bloodborne_markers_*_check` names, the two `fk_*` names and the primary key. If any CHECK is missing, the migration did not run; check `_migrations` for the row `765_patient_bloodborne_markers.sql`.

- [ ] **Step 3: Mirror the table in `schema.prisma`**

Run `npx prisma db pull --print --url "$DATABASE_URL" 2>/dev/null | sed -n '/^model patient_bloodborne_markers/,/^}/p'` against the scratch DB and paste the emitted model into `apps/backend/prisma/schema.prisma`, keeping the file's alphabetical model order. The emitted model has this shape (field order and attributes come from `db pull`; keep exactly what it prints):

```prisma
model patient_bloodborne_markers {
  id           BigInt    @id @default(autoincrement())
  tenant_id    String    @default(dbgenerated("COALESCE((NULLIF(NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text), 'bypass'::text))::uuid, '00000000-0000-4000-8000-000000000001'::uuid)")) @db.Uuid
  patient_uid  String    @db.Uuid
  marker       String    @db.VarChar(32)
  marker_label String?   @db.VarChar(120)
  result       String    @db.VarChar(20)
  tested_on    DateTime  @db.Date
  source       String    @db.VarChar(24)
  lab_result_id Int?
  evidence     Json      @default("{}")
  recorded_by  String    @db.Uuid
  recorded_at  DateTime  @default(now()) @db.Timestamptz(6)
  voided_at    DateTime? @db.Timestamptz(6)
  voided_by    String?   @db.Uuid
  void_reason  String?
  notes        String?
  lab_results  lab_results? @relation(fields: [lab_result_id], references: [id], onDelete: Restrict, onUpdate: NoAction, map: "fk_patient_bloodborne_markers_lab_result")
  users        users     @relation(fields: [patient_uid], references: [uid], onDelete: Restrict, onUpdate: NoAction, map: "fk_patient_bloodborne_markers_patient")

  @@index([tenant_id, patient_uid, marker, tested_on(sort: Desc), id(sort: Desc)], map: "idx_patient_bloodborne_markers_patient")
}
```

Correction from execution (2026-09-04): this schema declares `relationMode = "prisma"` and `scripts/check-prisma-relation-budget.mjs` enforces an exact allowlist of 24 curated relation fields, so `db pull` emits NO relation fields for the new FKs and none may be added; the mirrored model carries scalar fields, `@@index` and the partial `@@unique … where: raw(...)` only (the `partialIndexes` preview feature is on, so the partial index IS mirrored). Append the model where `db pull` places it (the file is not alphabetical). The migration as reviewed also pins the FKs as composites (`users (tenant_id, uid)`, `lab_results (tenant_id, id, patient_uid)`, deferrable), adds `tenant_id`, `recorded_by` and `voided_by` FKs, rejects a blank void reason, and enforces `(source = 'clinical_declaration') = (lab_result_id IS NULL)`; see the committed file, which is authoritative over the SQL shown above.

- [ ] **Step 4: Run the drift check and the relation check**

```bash
DATABASE_URL=postgres://…/vh_bbm_<initials> node scripts/check-schema-drift.mjs
npm run db:generate
```

Expected: drift check exits 0 with `schemas match`; `db:generate` completes.

- [ ] **Step 5: Run the migration guards**

```bash
npm run check:migration-numbers
npm run check:migration-session-guc
node ../../scripts/ci/check-inline-check-census.mjs
```

Expected: all three exit 0 (the census static guard reports the manifest unchanged; new tables are not baseline re-declarations).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/migrations/765_patient_bloodborne_markers.sql apps/backend/prisma/schema.prisma
git commit -m "feat(db): patient_bloodborne_markers table (mig 765)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: Normaliser and resolver (pure functions, TDD)

**Files:**
- Create: `apps/backend/src/services/clinical/bloodborneMarkerService.js` (pure part; DB functions come in Task 4)
- Test: `apps/backend/src/tests/unit/bloodborneMarkerService.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// apps/backend/src/tests/unit/bloodborneMarkerService.test.js
import {
  CORE_MARKERS,
  DEFAULT_VALIDITY_DAYS,
  computeReuseStatus,
  normalizeSerologyValue,
  __clearExposureHandlersForTests,
  notifyExposureHandlers,
  registerExposureHandler,
} from '../../services/clinical/bloodborneMarkerService.js';

const AS_OF = new Date('2026-09-04T10:00:00.000Z');
const day = (n) => new Date(AS_OF.getTime() - n * 86_400_000).toISOString().slice(0, 10);

function row(marker, result, daysAgo, extra = {}) {
  return {
    id: extra.id ?? Math.floor(Math.random() * 1e6),
    marker,
    marker_label: extra.marker_label ?? null,
    result,
    tested_on: day(daysAgo),
    source: extra.source ?? 'lab_result',
    voided_at: extra.voided_at ?? null,
  };
}

describe('normalizeSerologyValue', () => {
  test.each([
    ['Reactive', 'reactive'], ['POSITIVE', 'reactive'], ['Detected', 'reactive'],
    ['Weakly reactive', 'reactive'], ['reactive (repeat)', 'reactive'],
    ['Non-reactive', 'non_reactive'], ['nonreactive', 'non_reactive'],
    ['Non Reactive', 'non_reactive'], ['Negative', 'non_reactive'], ['Not detected', 'non_reactive'],
    ['non_reactive', 'non_reactive'],
    ['Indeterminate', 'indeterminate'], ['equivocal', 'indeterminate'],
    ['Borderline', 'indeterminate'], ['grey zone', 'indeterminate'], ['Gray Zone', 'indeterminate'],
    ['pending', 'pending'], ['Awaited', 'pending'], ['', 'pending'], [null, 'pending'], [undefined, 'pending'],
    ['1.23', 'indeterminate'], ['see comment', 'indeterminate'],
  ])('%p -> %s', (input, expected) => {
    expect(normalizeSerologyValue(input)).toBe(expected);
  });
});

describe('computeReuseStatus', () => {
  test('defaults: 90-day window, core markers are hiv/hbsag/hcv', () => {
    expect(DEFAULT_VALIDITY_DAYS).toBe(90);
    expect(CORE_MARKERS).toEqual(['hiv', 'hbsag', 'hcv']);
  });

  test('no rows -> unknown, naming every core marker as not on record', () => {
    const out = computeReuseStatus([], { asOf: AS_OF });
    expect(out.status).toBe('unknown');
    expect(out.reasons).toEqual([
      'HIV not on record', 'HBsAg not on record', 'HCV not on record',
    ]);
    expect(out.markers).toEqual([]);
    expect(out.validity_days).toBe(90);
  });

  test('all three core markers non-reactive within window -> clear', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 10), row('hbsag', 'non_reactive', 20), row('hcv', 'non_reactive', 89),
    ], { asOf: AS_OF });
    expect(out.status).toBe('clear');
    expect(out.markers.map((m) => m.within_window)).toEqual([true, true, true]);
  });

  test('a stale non-reactive core marker -> unknown, reason names the age', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 10), row('hbsag', 'non_reactive', 20), row('hcv', 'non_reactive', 91),
    ], { asOf: AS_OF });
    expect(out.status).toBe('unknown');
    expect(out.reasons).toEqual(['HCV result older than 90 days']);
  });

  test('any reactive core marker -> restricted, even outside the window', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 10), row('hbsag', 'reactive', 400), row('hcv', 'non_reactive', 5),
    ], { asOf: AS_OF });
    expect(out.status).toBe('restricted');
    expect(out.reasons).toEqual([`HBsAg reactive ${day(400)}`]);
  });

  test('pending or indeterminate core marker -> unknown with a specific reason', () => {
    const out = computeReuseStatus([
      row('hiv', 'pending', 1), row('hbsag', 'non_reactive', 2), row('hcv', 'indeterminate', 3),
    ], { asOf: AS_OF });
    expect(out.status).toBe('unknown');
    expect(out.reasons).toEqual(['HIV pending', 'HCV indeterminate']);
  });

  test('cjd_suspected reactive -> restricted regardless of age or other markers', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 1), row('hbsag', 'non_reactive', 1), row('hcv', 'non_reactive', 1),
      row('cjd_suspected', 'reactive', 2000),
    ], { asOf: AS_OF });
    expect(out.status).toBe('restricted');
    expect(out.reasons).toEqual(['CJD suspected']);
  });

  test('other marker reactive within window -> restricted with its label', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 1), row('hbsag', 'non_reactive', 1), row('hcv', 'non_reactive', 1),
      row('other', 'reactive', 3, { marker_label: 'HTLV-1' }),
    ], { asOf: AS_OF });
    expect(out.status).toBe('restricted');
    expect(out.reasons).toEqual([`HTLV-1 reactive ${day(3)}`]);
  });

  test('uses the latest row per marker by tested_on then id, and ignores voided rows', () => {
    const out = computeReuseStatus([
      row('hbsag', 'reactive', 30, { id: 1 }),
      row('hbsag', 'non_reactive', 5, { id: 2 }),
      row('hiv', 'non_reactive', 5, { id: 3 }),
      row('hcv', 'reactive', 5, { id: 4, voided_at: '2026-09-01T00:00:00.000Z' }),
      row('hcv', 'non_reactive', 5, { id: 5 }),
    ], { asOf: AS_OF });
    expect(out.status).toBe('clear');
  });

  test('a custom validity window is honoured', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 10), row('hbsag', 'non_reactive', 10), row('hcv', 'non_reactive', 10),
    ], { asOf: AS_OF, validityDays: 7 });
    expect(out.status).toBe('unknown');
    expect(out.validity_days).toBe(7);
  });
});

describe('exposure handlers', () => {
  afterEach(() => __clearExposureHandlersForTests());

  test('every registered handler receives every event; a throwing handler does not stop the others', async () => {
    const seen = [];
    registerExposureHandler(async (event) => { seen.push(`a:${event.marker}`); });
    registerExposureHandler(async () => { throw new Error('boom'); });
    registerExposureHandler(async (event) => { seen.push(`c:${event.marker}`); });
    await notifyExposureHandlers([{ marker: 'hiv' }, { marker: 'hcv' }]);
    expect(seen).toEqual(['a:hiv', 'c:hiv', 'a:hcv', 'c:hcv']);
  });

  test('unregister removes a handler', async () => {
    const seen = [];
    const off = registerExposureHandler(async (event) => { seen.push(event.marker); });
    off();
    await notifyExposureHandlers([{ marker: 'hiv' }]);
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --testPathPatterns unit/bloodborneMarkerService`
Expected: FAIL with `Cannot find module '../../services/clinical/bloodborneMarkerService.js'`.

- [ ] **Step 3: Write the pure part of the service**

```js
// apps/backend/src/services/clinical/bloodborneMarkerService.js
//
// Platform-level patient blood-borne marker record and its reuse resolver.
// Spec: docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md §5.1, §7.
//
// Consumers today: cath-lab device reuse (restriction strip, post-use rules,
// late-result quarantine). Named future consumers: OT sign-in, dialysis.
// Writers: the lab sign-off hook (recordMarkersFromSignedResults) and the cath
// readiness checklist's external-result / clinical-declaration paths, both of
// which call recordMarkers. There is deliberately no general create endpoint.

import prisma, { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { markerForResult } from '../lab/labAnalyteCodes.js';

export const MARKERS = Object.freeze(['hiv', 'hbsag', 'hcv', 'cjd_suspected', 'other']);
export const CORE_MARKERS = Object.freeze(['hiv', 'hbsag', 'hcv']);
export const RESULTS = Object.freeze(['reactive', 'non_reactive', 'indeterminate', 'pending']);
export const SOURCES = Object.freeze(['lab_result', 'external_report', 'clinical_declaration']);
export const DEFAULT_VALIDITY_DAYS = 90;
export const STATUSES = Object.freeze(['restricted', 'unknown', 'clear']);

const MARKER_DISPLAY = Object.freeze({
  hiv: 'HIV',
  hbsag: 'HBsAg',
  hcv: 'HCV',
  cjd_suspected: 'CJD suspected',
});

// Order matters: negative tokens contain "reactive"/"detected", so they are
// tested before the positive tokens. Anything unrecognised is indeterminate,
// never silently non_reactive.
const PENDING_TOKENS = ['pending', 'awaited'];
const NEGATIVE_TOKENS = ['non-reactive', 'nonreactive', 'non reactive', 'non_reactive', 'negative', 'not detected'];
const INDETERMINATE_TOKENS = ['indeterminate', 'equivocal', 'borderline', 'grey zone', 'gray zone'];
const POSITIVE_TOKENS = ['weakly reactive', 'reactive', 'positive', 'detected'];

export function normalizeSerologyValue(valueText) {
  const text = String(valueText ?? '').trim().toLowerCase();
  if (!text) return 'pending';
  if (PENDING_TOKENS.includes(text)) return 'pending';
  if (NEGATIVE_TOKENS.some((token) => text.includes(token))) return 'non_reactive';
  if (INDETERMINATE_TOKENS.some((token) => text.includes(token))) return 'indeterminate';
  if (POSITIVE_TOKENS.some((token) => text.includes(token))) return 'reactive';
  return 'indeterminate';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_PATTERN.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'BLOODBORNE_MARKER_INVALID');
  }
  return text.toLowerCase();
}

function isoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  return text.length >= 10 ? text.slice(0, 10) : text;
}

// Calendar days between a DATE (YYYY-MM-DD or Date) and asOf, in UTC days.
function ageInDays(testedOn, asOf) {
  const tested = Date.UTC(
    Number(isoDate(testedOn).slice(0, 4)),
    Number(isoDate(testedOn).slice(5, 7)) - 1,
    Number(isoDate(testedOn).slice(8, 10)),
  );
  const now = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return Math.floor((now - tested) / 86_400_000);
}

function markerLabel(row) {
  if (row.marker === 'other') return row.marker_label || 'Other marker';
  return MARKER_DISPLAY[row.marker] || row.marker;
}

function markerKey(row) {
  return row.marker === 'other' ? `other:${String(row.marker_label || '').toLowerCase()}` : row.marker;
}

// Latest non-voided row per marker (per label for 'other'), by tested_on then id.
function latestPerMarker(rows) {
  const sorted = [...rows]
    .filter((row) => !row.voided_at)
    .sort((a, b) => {
      const byDate = isoDate(b.tested_on).localeCompare(isoDate(a.tested_on));
      if (byDate !== 0) return byDate;
      return Number(b.id) - Number(a.id);
    });
  const latest = new Map();
  for (const row of sorted) {
    const key = markerKey(row);
    if (!latest.has(key)) latest.set(key, row);
  }
  return latest;
}

export function computeReuseStatus(rows = [], {
  validityDays = DEFAULT_VALIDITY_DAYS,
  asOf = new Date(),
} = {}) {
  const latest = latestPerMarker(rows);
  const markers = [];
  const reasons = [];
  let restricted = false;

  for (const row of latest.values()) {
    const age = ageInDays(row.tested_on, asOf);
    markers.push({
      marker: row.marker,
      label: row.marker === 'other' ? (row.marker_label || null) : null,
      result: row.result,
      tested_on: isoDate(row.tested_on),
      source: row.source,
      age_days: age,
      within_window: age <= validityDays,
    });
    if (row.marker === 'cjd_suspected' && row.result === 'reactive') {
      restricted = true;
      reasons.push('CJD suspected');
    } else if (row.result === 'reactive') {
      // A reactive result never lapses: the window governs how long a
      // negative may be relied on, not how long a positive counts.
      restricted = true;
      reasons.push(`${markerLabel(row)} reactive ${isoDate(row.tested_on)}`);
    }
  }

  const base = {
    markers,
    validity_days: validityDays,
    evaluated_at: asOf.toISOString(),
  };
  if (restricted) return { status: 'restricted', reasons, ...base };

  const clear = CORE_MARKERS.every((marker) => {
    const row = latest.get(marker);
    return row && row.result === 'non_reactive' && ageInDays(row.tested_on, asOf) <= validityDays;
  });
  if (clear) {
    return { status: 'clear', reasons: ['HIV, HBsAg and HCV non-reactive within window'], ...base };
  }

  for (const marker of CORE_MARKERS) {
    const row = latest.get(marker);
    const label = MARKER_DISPLAY[marker];
    if (!row) reasons.push(`${label} not on record`);
    else if (row.result === 'pending') reasons.push(`${label} pending`);
    else if (row.result === 'indeterminate') reasons.push(`${label} indeterminate`);
    else if (ageInDays(row.tested_on, asOf) > validityDays) {
      reasons.push(`${label} result older than ${validityDays} days`);
    }
  }
  return { status: 'unknown', reasons, ...base };
}

// ---------------------------------------------------------------------------
// Exposure handlers — invoked post-commit whenever a reactive row is recorded.
// Consumers register at module load (cath device reuse quarantines devices).
// ---------------------------------------------------------------------------

const exposureHandlers = new Set();

export function registerExposureHandler(handler) {
  exposureHandlers.add(handler);
  return () => exposureHandlers.delete(handler);
}

export function __clearExposureHandlersForTests() {
  exposureHandlers.clear();
}

export async function notifyExposureHandlers(events = []) {
  for (const event of events) {
    for (const handler of exposureHandlers) {
      try {
        await handler(event);
      } catch (err) {
        logger.error(`Blood-borne exposure handler failed: ${err?.message}`, {
          marker: event?.marker,
          tenantId: event?.tenantId,
        });
      }
    }
  }
}

export { markerForResult, requireUuid as __requireUuidForTests, isoDate as __isoDateForTests };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --testPathPatterns unit/bloodborneMarkerService`
Expected: PASS. If `'HBsAg reactive …'` ordering differs, the reactive reasons are emitted in latest-row iteration order; the test above only has one reactive row per case, so order cannot vary.

- [ ] **Step 5: Mutation check (the lesson from PR #973)**

Temporarily swap the order of the `NEGATIVE_TOKENS` and `POSITIVE_TOKENS` checks in `normalizeSerologyValue`, run the suite, confirm the `Non-reactive` and `Not detected` rows go RED, then restore the order and confirm GREEN. Do not commit the mutation.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/services/clinical/bloodborneMarkerService.js apps/backend/src/tests/unit/bloodborneMarkerService.test.js
git commit -m "feat(clinical): blood-borne marker normaliser, reuse resolver, exposure registry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: Service DB functions + deep test

**Files:**
- Modify: `apps/backend/src/services/clinical/bloodborneMarkerService.js` (append DB functions)
- Test: `apps/backend/src/tests/bloodborne-markers.deep.test.js`

- [ ] **Step 1: Write the failing deep test**

```js
// apps/backend/src/tests/bloodborne-markers.deep.test.js
import prisma from '../lib/prisma.js';
import {
  __clearExposureHandlersForTests,
  listMarkersForPatient,
  recordMarkers,
  recordMarkersFromSignedResults,
  registerExposureHandler,
  resolveReuseStatus,
  voidMarker,
} from '../services/clinical/bloodborneMarkerService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000000bb001';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000bb002';
const PATIENT = '00000000-0000-4000-8000-0000000bb011';
const OTHER_PATIENT = '00000000-0000-4000-8000-0000000bb012';
const ACTOR = '00000000-0000-4000-8000-0000000bb0aa';
const RLS_ROLE = 'vhhealth_runtime';

const resultIds = [];

async function asRlsRole(tenantId, sql, ...params) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RLS_ROLE}`);
    await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", tenantId);
    return tx.$queryRawUnsafe(sql, ...params);
  });
}

async function seedSignedResult({ testCode, valueText, patientUid = PATIENT, daysAgo = 3 }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text, status,
        signed_off_at, signed_off_by, performed_at, received_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, $4, 'final',
             NOW(), $5::uuid, NOW() - ($6::int * INTERVAL '1 day'), NOW() - ($6::int * INTERVAL '1 day'))
     RETURNING id`,
    TENANT, patientUid, testCode, valueText, ACTOR, daysAgo,
  );
  const id = Number(rows[0].id);
  resultIds.push(id);
  return id;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_bloodborne_markers WHERE tenant_id = ANY($1::uuid[])`,
    [TENANT, OTHER_TENANT],
  ).catch(() => {});
  if (resultIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_results WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT, resultIds,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
    [PATIENT, OTHER_PATIENT, ACTOR],
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = ANY($1::uuid[])`,
    [TENANT, OTHER_TENANT],
  ).catch(() => {});
}

d('blood-borne markers (deep)', () => {
  beforeAll(async () => {
    await cleanup();
    for (const [id, slug] of [[TENANT, 'bbm-test'], [OTHER_TENANT, 'bbm-other']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $2) ON CONFLICT (id) DO NOTHING`,
        id, slug,
      );
    }
    for (const [uid, tenant, role, phone] of [
      [PATIENT, TENANT, 'PATIENT', '+919000011011'],
      [OTHER_PATIENT, OTHER_TENANT, 'PATIENT', '+919000011012'],
      [ACTOR, TENANT, 'DOCTOR', '+919000011099'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'BBM Test', $4, true, 'active', NOW())`,
        uid, tenant, phone, role,
      );
    }
  }, 30000);

  afterAll(async () => {
    __clearExposureHandlersForTests();
    await cleanup();
  }, 30000);

  afterEach(() => __clearExposureHandlersForTests());

  test('recordMarkers writes rows and the resolver reads them back', async () => {
    const recorded = await recordMarkers({
      tenantId: TENANT,
      patientUid: PATIENT,
      actorUid: ACTOR,
      entries: [
        { marker: 'hiv', result: 'non_reactive', testedOn: '2026-08-20', source: 'clinical_declaration', evidence: { note: 'outside report sighted' } },
        { marker: 'hbsag', result: 'non_reactive', testedOn: '2026-08-20', source: 'clinical_declaration' },
        { marker: 'hcv', result: 'non_reactive', testedOn: '2026-08-20', source: 'clinical_declaration' },
      ],
    });
    expect(recorded.recorded).toHaveLength(3);
    const status = await resolveReuseStatus({ tenantId: TENANT, patientUid: PATIENT, asOf: new Date('2026-09-04T00:00:00Z') });
    expect(status.status).toBe('clear');
    const listed = await listMarkersForPatient({ tenantId: TENANT, patientUid: PATIENT });
    expect(listed.markers).toHaveLength(3);
    expect(listed.reuse_status.status).toBe('clear');
  }, 30000);

  test('recordMarkers rejects an invalid marker, a missing label for other, and a future date', async () => {
    await expect(recordMarkers({
      tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR,
      entries: [{ marker: 'malaria', result: 'reactive', testedOn: '2026-09-01', source: 'clinical_declaration' }],
    })).rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({
      tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR,
      entries: [{ marker: 'other', result: 'reactive', testedOn: '2026-09-01', source: 'clinical_declaration' }],
    })).rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    await expect(recordMarkers({
      tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR,
      entries: [{ marker: 'hiv', result: 'reactive', testedOn: '2999-01-01', source: 'clinical_declaration' }],
    })).rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
  });

  test('a reactive entry fires exposure handlers after commit with the row identity', async () => {
    const events = [];
    registerExposureHandler(async (event) => { events.push(event); });
    await recordMarkers({
      tenantId: TENANT, patientUid: PATIENT, actorUid: ACTOR,
      entries: [{ marker: 'other', marker_label: 'HTLV-1', result: 'reactive', testedOn: '2026-09-01', source: 'clinical_declaration' }],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT, patientUid: PATIENT, marker: 'other', markerLabel: 'HTLV-1', testedOn: '2026-09-01', source: 'clinical_declaration',
    });
    expect(Number(events[0].markerRowId)).toBeGreaterThan(0);
    const status = await resolveReuseStatus({ tenantId: TENANT, patientUid: PATIENT });
    expect(status.status).toBe('restricted');
  });

  test('voidMarker hides a row from the resolver and refuses a second void', async () => {
    const listed = await listMarkersForPatient({ tenantId: TENANT, patientUid: PATIENT });
    const htlv = listed.markers.find((m) => m.marker === 'other');
    const voided = await voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId: htlv.id, actorUid: ACTOR, reason: 'entered in error' });
    expect(voided.void_reason).toBe('entered in error');
    const after = await resolveReuseStatus({ tenantId: TENANT, patientUid: PATIENT, asOf: new Date('2026-09-04T00:00:00Z') });
    expect(after.status).toBe('clear');
    await expect(voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId: htlv.id, actorUid: ACTOR, reason: 'again' }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_ALREADY_VOIDED' });
    await expect(voidMarker({ tenantId: TENANT, patientUid: PATIENT, markerId: 999999999, actorUid: ACTOR, reason: 'x' }))
      .rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_NOT_FOUND' });
  });

  test('signed HBSAG/HIV/HCV results create markers once; replay is a no-op; non-serology is ignored', async () => {
    const hbsag = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });
    const hgb = await seedSignedResult({ testCode: 'HGB', valueText: '12.1' });
    const events = [];
    registerExposureHandler(async (event) => { events.push(event); });

    const first = await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hbsag, hgb], decision: 'verified', actorUid: ACTOR });
    expect(first.recorded).toHaveLength(1);
    expect(first.recorded[0]).toMatchObject({ marker: 'hbsag', result: 'reactive', source: 'lab_result', lab_result_id: hbsag });
    expect(events).toHaveLength(1);

    const replay = await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hbsag, hgb], decision: 'verified', actorUid: ACTOR });
    expect(replay.recorded).toHaveLength(0);
    expect(events).toHaveLength(1);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND lab_result_id = $2::int`,
      TENANT, hbsag,
    );
    expect(rows[0].n).toBe(1);
  }, 30000);

  test('a corrective sign-off voids the earlier marker row and inserts the corrected one', async () => {
    const hcv = await seedSignedResult({ testCode: 'HCV', valueText: 'Reactive' });
    await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hcv], decision: 'verified', actorUid: ACTOR });
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET value_text = 'Non-reactive', status = 'corrected', updated_at = NOW() WHERE id = $1::int AND tenant_id = $2::uuid`,
      hcv, TENANT,
    );
    const corrected = await recordMarkersFromSignedResults({ tenantId: TENANT, resultIds: [hcv], decision: 'corrected', actorUid: ACTOR });
    expect(corrected.voided).toBe(1);
    expect(corrected.recorded).toHaveLength(1);
    expect(corrected.recorded[0].result).toBe('non_reactive');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT result, voided_at IS NOT NULL AS voided, void_reason
         FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid AND lab_result_id = $2::int ORDER BY id`,
      TENANT, hcv,
    );
    expect(rows).toEqual([
      { result: 'reactive', voided: true, void_reason: 'lab_result_corrected' },
      { result: 'non_reactive', voided: false, void_reason: null },
    ]);
  }, 30000);

  test('RLS: another tenant cannot read this tenant\'s marker rows', async () => {
    const visible = await asRlsRole(
      OTHER_TENANT,
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE patient_uid = $1::uuid`,
      PATIENT,
    );
    expect(visible[0].n).toBe(0);
    const own = await asRlsRole(
      TENANT,
      `SELECT COUNT(*)::int AS n FROM patient_bloodborne_markers WHERE patient_uid = $1::uuid`,
      PATIENT,
    );
    expect(own[0].n).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `DATABASE_URL=postgres://…/vh_bbm_<initials> npm test -- --testPathPatterns bloodborne-markers.deep`
Expected: FAIL with `recordMarkers is not a function` (or an import error naming the missing export).

- [ ] **Step 3: Append the DB functions to the service**

Execution note (2026-09-04): Task 3's review split the pure rules into `apps/backend/src/services/clinical/bloodborneMarkerRules.js` (normaliser, `computeReuseStatus`, exposure registry, `requireUuid`, `isoDate`, `clinicalDate`, `ageInDays`, the constants), and `bloodborneMarkerService.js` became `export * from './bloodborneMarkerRules.js'; export { markerForResult } from '../lab/labAnalyteCodes.js';`. The rules also changed: a non-voided reactive row LATCHES (a later non-reactive never clears it; only voiding does), `unknown` always carries a reason, ages are Asia/Kolkata calendar days, and the normaliser treats mixed negative+positive text as `indeterminate`. So this task ADDS the persistence functions to `bloodborneMarkerService.js` beneath the two re-export lines, importing what it needs from the rules module (`computeReuseStatus, normalizeSerologyValue, notifyExposureHandlers, requireUuid, isoDate, clinicalDate, DEFAULT_VALIDITY_DAYS, MARKERS, RESULTS, SOURCES`) plus `prisma, { setTenant, setTenantTx }`, `logger`, `AppError`, `requireTenantId`, `markerForResult`. Do not re-declare the helpers the rules module already exports. With that read, the code below is what to add:

```js
// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const MARKER_SELECT = `id, tenant_id, patient_uid, marker, marker_label, result, tested_on, source,
  lab_result_id, evidence, recorded_by, recorded_at, voided_at, voided_by, void_reason, notes`;

function normalizeMarkerRow(row) {
  if (!row) return row;
  return {
    ...row,
    id: Number(row.id),
    lab_result_id: row.lab_result_id == null ? null : Number(row.lab_result_id),
    tested_on: isoDate(row.tested_on),
  };
}

function withTenant(tenantId, db, fn) {
  return db ? fn(db) : setTenant(tenantId, fn);
}

function cleanText(value, max = 500) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function requireDate(value, label) {
  const text = isoDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest(`${label} must be a date (YYYY-MM-DD)`, 'BLOODBORNE_MARKER_INVALID');
  }
  const today = new Date().toISOString().slice(0, 10);
  if (text > today) {
    throw AppError.badRequest(`${label} cannot be in the future`, 'BLOODBORNE_MARKER_INVALID');
  }
  return text;
}

function requireOneOf(value, allowed, label) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of ${allowed.join(', ')}`, 'BLOODBORNE_MARKER_INVALID');
  }
  return text;
}

function exposureEventFrom(row) {
  return {
    tenantId: row.tenant_id,
    patientUid: row.patient_uid,
    marker: row.marker,
    markerLabel: row.marker_label ?? null,
    result: row.result,
    testedOn: isoDate(row.tested_on),
    source: row.source,
    markerRowId: Number(row.id),
    labResultId: row.lab_result_id == null ? null : Number(row.lab_result_id),
  };
}

// Insert one marker row inside the caller's tenant transaction. Returns the
// row, or null when a lab-result-linked row already exists (idempotent replay).
export async function recordMarkerTx(tx, {
  tenantId,
  patientUid,
  marker,
  markerLabel = null,
  result,
  testedOn,
  source,
  labResultId = null,
  evidence = {},
  recordedBy,
  notes = null,
}) {
  const tid = requireTenantId(tenantId);
  const uid = requireUuid(patientUid, 'patientUid');
  const actor = requireUuid(recordedBy, 'recordedBy');
  const safeMarker = requireOneOf(marker, MARKERS, 'marker');
  const safeResult = requireOneOf(result, RESULTS, 'result');
  const safeSource = requireOneOf(source, SOURCES, 'source');
  const label = cleanText(markerLabel, 120);
  if (safeMarker === 'other' && !label) {
    throw AppError.badRequest('marker_label is required when marker is other', 'BLOODBORNE_MARKER_INVALID');
  }
  if (safeMarker === 'cjd_suspected' && !['reactive', 'non_reactive'].includes(safeResult)) {
    throw AppError.badRequest('cjd_suspected accepts reactive (suspected) or non_reactive (cleared)', 'BLOODBORNE_MARKER_INVALID');
  }
  // Mirrors patient_bloodborne_markers_lab_link_check: lab_result and
  // external_report rows always carry the lab result id; clinical
  // declarations never do.
  if (safeSource !== 'clinical_declaration' && labResultId == null) {
    throw AppError.badRequest(`lab_result_id is required for ${safeSource} markers`, 'BLOODBORNE_MARKER_INVALID');
  }
  if (safeSource === 'clinical_declaration' && labResultId != null) {
    throw AppError.badRequest('clinical_declaration markers do not reference a lab result', 'BLOODBORNE_MARKER_INVALID');
  }
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO patient_bloodborne_markers
       (tenant_id, patient_uid, marker, marker_label, result, tested_on, source,
        lab_result_id, evidence, recorded_by, notes)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7,
             $8::int, $9::jsonb, $10::uuid, $11)
     ON CONFLICT (tenant_id, lab_result_id)
       WHERE lab_result_id IS NOT NULL AND voided_at IS NULL
       DO NOTHING
     RETURNING ${MARKER_SELECT}`,
    tid,
    uid,
    safeMarker,
    safeMarker === 'other' ? label : null,
    safeResult,
    requireDate(testedOn, 'tested_on'),
    safeSource,
    labResultId == null ? null : Number(labResultId),
    JSON.stringify(evidence && typeof evidence === 'object' ? evidence : {}),
    actor,
    cleanText(notes, 2000),
  );
  return rows[0] ? normalizeMarkerRow(rows[0]) : null;
}

// Record one or more marker rows for a patient in one tenant transaction, then
// notify exposure handlers for every reactive row AFTER commit.
export async function recordMarkers({ tenantId, patientUid, entries = [], actorUid }) {
  const tid = requireTenantId(tenantId);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw AppError.badRequest('At least one marker entry is required', 'BLOODBORNE_MARKER_INVALID');
  }
  const recorded = await setTenantTx(tid, async (tx) => {
    const rows = [];
    for (const entry of entries) {
      const row = await recordMarkerTx(tx, {
        tenantId: tid,
        patientUid,
        marker: entry.marker,
        markerLabel: entry.marker_label ?? entry.markerLabel ?? null,
        result: entry.result,
        testedOn: entry.tested_on ?? entry.testedOn,
        source: entry.source,
        labResultId: entry.lab_result_id ?? entry.labResultId ?? null,
        evidence: entry.evidence ?? {},
        recordedBy: actorUid,
        notes: entry.notes ?? null,
      });
      if (row) rows.push(row);
    }
    return rows;
  });
  await notifyExposureHandlers(recorded.filter((row) => row.result === 'reactive').map(exposureEventFrom));
  return { recorded };
}

async function activeMarkerRows(tenantId, patientUid, { db = null, includeVoided = false } = {}) {
  return withTenant(tenantId, db, (client) => client.$queryRawUnsafe(
    `SELECT ${MARKER_SELECT}
       FROM patient_bloodborne_markers
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        ${includeVoided ? '' : 'AND voided_at IS NULL'}
      ORDER BY tested_on DESC, id DESC`,
    tenantId,
    patientUid,
  ));
}

export async function resolveReuseStatus({
  tenantId,
  patientUid,
  validityDays = DEFAULT_VALIDITY_DAYS,
  asOf = new Date(),
  db = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const uid = requireUuid(patientUid, 'patientUid');
  const rows = await activeMarkerRows(tid, uid, { db });
  return computeReuseStatus(rows, { validityDays, asOf });
}

export async function listMarkersForPatient({
  tenantId,
  patientUid,
  validityDays = DEFAULT_VALIDITY_DAYS,
  includeVoided = false,
} = {}) {
  const tid = requireTenantId(tenantId);
  const uid = requireUuid(patientUid, 'patientUid');
  const rows = await activeMarkerRows(tid, uid, { includeVoided });
  return {
    markers: rows.map(normalizeMarkerRow),
    reuse_status: computeReuseStatus(rows, { validityDays }),
  };
}

export async function voidMarker({ tenantId, patientUid, markerId, actorUid, reason }) {
  const tid = requireTenantId(tenantId);
  const uid = requireUuid(patientUid, 'patientUid');
  const actor = requireUuid(actorUid, 'actorUid');
  const id = Number(markerId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw AppError.badRequest('marker id must be a positive integer', 'BLOODBORNE_MARKER_INVALID');
  }
  const safeReason = cleanText(reason, 500);
  if (!safeReason) {
    throw AppError.badRequest('reason is required to void a marker', 'BLOODBORNE_MARKER_INVALID');
  }
  return setTenantTx(tid, async (tx) => {
    const existing = await tx.$queryRawUnsafe(
      `SELECT ${MARKER_SELECT} FROM patient_bloodborne_markers
        WHERE tenant_id = $1::uuid AND id = $2::bigint AND patient_uid = $3::uuid
        FOR UPDATE`,
      tid, id, uid,
    );
    const row = existing[0];
    if (!row) throw AppError.notFound('Blood-borne marker not found', 'BLOODBORNE_MARKER_NOT_FOUND');
    if (row.voided_at) throw AppError.conflict('Blood-borne marker is already voided', 'BLOODBORNE_MARKER_ALREADY_VOIDED');
    const updated = await tx.$queryRawUnsafe(
      `UPDATE patient_bloodborne_markers
          SET voided_at = NOW(), voided_by = $3::uuid, void_reason = $4
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING ${MARKER_SELECT}`,
      tid, id, actor, safeReason,
    );
    return normalizeMarkerRow(updated[0]);
  });
}

// ---------------------------------------------------------------------------
// Lab sign-off hook — called post-commit from labResultsService.signOffResults.
// Verified/corrected/amended HIV, HBSAG and HCV results become marker rows;
// a corrective decision voids the previous row for the same lab result first.
// ---------------------------------------------------------------------------

const CORRECTIVE_DECISIONS = new Set(['corrected', 'amended']);
const SIGNED_STATUSES = new Set(['final', 'corrected', 'amended', 'verified']);

// IST calendar date of a timestamp: lab results are performed and read in
// Asia/Kolkata, and a 23:30 IST draw must not become the next UTC day.
function istDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export async function recordMarkersFromSignedResults({ tenantId, resultIds = [], decision = 'verified', actorUid }) {
  const tid = requireTenantId(tenantId);
  const ids = [...new Set((resultIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (ids.length === 0) return { recorded: [], voided: 0 };
  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT id, patient_uid, test_code, loinc_code, value_text, status,
            signed_off_at, performed_at, received_at
       FROM lab_results
      WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
    tid, ids,
  ));
  const candidates = rows
    .map((row) => ({ row, marker: markerForResult(row) }))
    .filter(({ row, marker }) => marker
      && row.signed_off_at
      && SIGNED_STATUSES.has(String(row.status || '').toLowerCase()));
  if (candidates.length === 0) return { recorded: [], voided: 0 };

  const normalizedDecision = String(decision || 'verified').toLowerCase();
  const outcome = await setTenantTx(tid, async (tx) => {
    let voided = 0;
    const recorded = [];
    for (const { row, marker } of candidates) {
      if (CORRECTIVE_DECISIONS.has(normalizedDecision)) {
        voided += await tx.$executeRawUnsafe(
          `UPDATE patient_bloodborne_markers
              SET voided_at = NOW(), voided_by = $3::uuid, void_reason = 'lab_result_corrected'
            WHERE tenant_id = $1::uuid AND lab_result_id = $2::int AND voided_at IS NULL`,
          tid, Number(row.id), requireUuid(actorUid, 'actorUid'),
        );
      }
      const inserted = await recordMarkerTx(tx, {
        tenantId: tid,
        patientUid: row.patient_uid,
        marker,
        result: normalizeSerologyValue(row.value_text),
        testedOn: istDate(row.performed_at || row.received_at || new Date()),
        source: 'lab_result',
        labResultId: Number(row.id),
        evidence: {
          raw_value: row.value_text,
          test_code: row.test_code,
          loinc_code: row.loinc_code,
          decision: normalizedDecision,
        },
        recordedBy: actorUid,
      });
      if (inserted) recorded.push(inserted);
    }
    return { recorded, voided };
  });
  await notifyExposureHandlers(outcome.recorded.filter((row) => row.result === 'reactive').map(exposureEventFrom));
  return outcome;
}
```

- [ ] **Step 4: Run the deep test to verify it passes**

Run: `DATABASE_URL=postgres://…/vh_bbm_<initials> npm test -- --testPathPatterns bloodborne-markers.deep`
Expected: PASS, 7 tests. If the RLS test fails with `role "vhhealth_runtime" does not exist`, your scratch DB was not built by `ci-setup-db.mjs`; rebuild it.

- [ ] **Step 5: Run the unit suite again to confirm the pure part is unaffected**

Run: `npm test -- --testPathPatterns "unit/(bloodborneMarkerService|labAnalyteCodes)"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/services/clinical/bloodborneMarkerService.js apps/backend/src/tests/bloodborne-markers.deep.test.js
git commit -m "feat(clinical): blood-borne marker persistence, void, lab sign-off ingestion

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: Lab sign-off hook

**Files:**
- Modify: `apps/backend/src/services/lab/labResultsService.js` (import near line 33; call after line 2446)
- Modify: `apps/backend/src/tests/unit/labResultsService.test.js` (add a module mock near the other `unstable_mockModule` calls, before the dynamic import of the service)

- [ ] **Step 1: Add the import**

In `apps/backend/src/services/lab/labResultsService.js`, after the line `import { createLabDiagnosticGenerationTx } from '../diagnostics/diagnosticResultGenerationService.js';` add:

```js
import { recordMarkersFromSignedResults } from '../clinical/bloodborneMarkerService.js';
```

- [ ] **Step 2: Add the post-commit call**

In `signOffResults`, immediately after the line `emitLabEvent('result-signed', { tenantId: tid });` (currently line 2446) insert:

```js
  // Blood-borne marker record (spec 2026-09-04 §7.1): signed HIV/HBSAG/HCV
  // results become patient marker rows. Post-commit and best-effort — the
  // sign-off stands whether or not the marker write succeeds; the hook is
  // idempotent so a later re-run repairs a miss.
  try {
    await recordMarkersFromSignedResults({
      tenantId: tid,
      resultIds: ids,
      decision: normalizedDecision,
      actorUid: signoffRow.signed_off_by,
    });
  } catch (markerErr) {
    logger.warn(`Blood-borne marker sync failed after sign-off (sign-off stands): ${markerErr?.message}`);
  }
```

- [ ] **Step 3: Keep the existing hermetic unit test hermetic**

In `apps/backend/src/tests/unit/labResultsService.test.js`, next to the other `jest.unstable_mockModule(...)` calls (they precede the `await import('../../services/lab/labResultsService.js')`), add:

```js
jest.unstable_mockModule('../../services/clinical/bloodborneMarkerService.js', () => ({
  recordMarkersFromSignedResults: jest.fn().mockResolvedValue({ recorded: [], voided: 0 }),
}));
```

- [ ] **Step 4: Run the touched unit suites**

Run: `npm test -- --testPathPatterns "unit/labResultsService"`
Expected: PASS with the same count as before the change. If a test asserts the exact number of `$queryRawUnsafe` calls in `signOffResults`, the mock above keeps it unchanged because the hook is mocked out entirely.

- [ ] **Step 5: Run the existing sign-off deep tests against your scratch DB**

Run: `DATABASE_URL=postgres://…/vh_bbm_<initials> npm test -- --testPathPatterns "lab-signoff-safety.deep|lab-order-complete-on-signoff|lab-corrected-signoff-reack.deep"`
Expected: PASS. Their analytes are `S2A-*` codes, so the hook records nothing; this proves the hook is inert for non-serology sign-offs and never breaks the sign-off.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/services/lab/labResultsService.js apps/backend/src/tests/unit/labResultsService.test.js
git commit -m "feat(lab): record blood-borne markers after HIV/HBsAg/HCV sign-off

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: Routes, mount, OpenAPI

**Files:**
- Create: `apps/backend/src/routes/clinical/bloodborneMarkerRoutes.js`
- Modify: `apps/backend/src/app.js` (import after line 352; mount after line 1639)
- Create: `apps/backend/scripts/openapi/schemas/bloodborneMarkers.mjs`
- Modify: `apps/backend/scripts/generate-openapi.mjs` (import at ~line 36, array entry after `cathConsumables,` at ~line 89)
- Regenerate: `apps/backend/src/docs/openapi.json`

- [ ] **Step 1: Write the router**

```js
// apps/backend/src/routes/clinical/bloodborneMarkerRoutes.js
//
// Read and void surface for the patient blood-borne marker record. Mounted at
// /api/v1/bloodborne-markers behind the clinical-staff gate + PHI logger (see
// app.js), mirroring /api/v1/allergies. There is no create route by owner
// decision: marker rows are written by the lab sign-off hook and by the cath
// readiness checklist's external-result path.

import express from 'express';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import {
  DEFAULT_VALIDITY_DAYS,
  listMarkersForPatient,
  voidMarker,
} from '../../services/clinical/bloodborneMarkerService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guardMarkerAccess = patientAccessGuard('BLOODBORNE_MARKERS', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});

function validityDaysOf(req) {
  const raw = req.query?.validity_days;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_VALIDITY_DAYS;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
    throw Object.assign(new Error('validity_days must be an integer between 1 and 365'), { statusCode: 400 });
  }
  return parsed;
}

router.get('/patient/:patientUid', guardMarkerAccess, async (req, res) => {
  try {
    const patientUid = String(req.params.patientUid || '').trim();
    if (!UUID_RE.test(patientUid)) {
      return error(res, 'patientUid must be a UUID', HTTP_STATUS.BAD_REQUEST);
    }
    const data = await listMarkersForPatient({
      tenantId: resolveTenantOrThrow(req),
      patientUid,
      validityDays: validityDaysOf(req),
      includeVoided: String(req.query?.include_voided || '').toLowerCase() === 'true',
    });
    return success(res, data, 'Blood-borne markers');
  } catch (err) {
    if (err?.statusCode === 400 && !err?.code) {
      return error(res, err.message, HTTP_STATUS.BAD_REQUEST);
    }
    return relayAppError(res, err, 'Failed to read blood-borne markers');
  }
});

router.post(
  '/patient/:patientUid/markers/:id/void',
  guardMarkerAccess,
  requireIdempotencyKey({ required: true, scope: 'bloodborne_marker_void' }),
  async (req, res) => {
    try {
      const patientUid = String(req.params.patientUid || '').trim();
      if (!UUID_RE.test(patientUid)) {
        return error(res, 'patientUid must be a UUID', HTTP_STATUS.BAD_REQUEST);
      }
      const marker = await voidMarker({
        tenantId: resolveTenantOrThrow(req),
        patientUid,
        markerId: req.params.id,
        actorUid: req.user?.uid,
        reason: req.body?.reason,
      });
      return success(res, { marker }, 'Blood-borne marker voided');
    } catch (err) {
      return relayAppError(res, err, 'Failed to void blood-borne marker');
    }
  },
);

export default router;
```

- [ ] **Step 2: Mount it in `app.js`**

After the line `import allergyRoutes from './routes/clinical/allergyRoutes.js';` add:

```js
import bloodborneMarkerRoutes from './routes/clinical/bloodborneMarkerRoutes.js';
```

Immediately after the allergies mount (the line starting `app.use('/api/v1/allergies', requireRole(...CLINICAL_STAFF_ROUTE_ROLES), …`) add:

```js
app.use('/api/v1/bloodborne-markers', requireRole(...CLINICAL_STAFF_ROUTE_ROLES), sanitizeAllBodyStrings, patientAccessGuard('BLOODBORNE_MARKERS', { careTeamModeGoverned: true }), phiAccessLogger('BLOODBORNE_MARKERS'), bloodborneMarkerRoutes);
```

- [ ] **Step 3: Confirm the PHI logger and guard accept the new record type**

```bash
grep -n "'ALLERGY'" apps/backend/src/middleware/phiAccessMiddleware.js apps/backend/src/config/*.js | head
```

If `ALLERGY` appears in an allowlist of record types (for example a `PHI_RECORD_TYPES` set), add `BLOODBORNE_MARKERS` beside it in the same file; if it does not appear anywhere but the mount line, no change is needed. Then start the app once to confirm it boots:

```bash
DATABASE_URL=postgres://…/vh_bbm_<initials> node -e "import('./src/app.js').then(() => { console.log('app loaded'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"
```

Expected: `app loaded`.

- [ ] **Step 4: Write the OpenAPI overlay**

```js
// apps/backend/scripts/openapi/schemas/bloodborneMarkers.mjs
import { envelope } from './_helpers.mjs';

const MARKERS = ['hiv', 'hbsag', 'hcv', 'cjd_suspected', 'other'];
const RESULTS = ['reactive', 'non_reactive', 'indeterminate', 'pending'];
const SOURCES = ['lab_result', 'external_report', 'clinical_declaration'];
const STATUSES = ['restricted', 'unknown', 'clear'];

const nullableString = { type: 'string', nullable: true };
const nullableUuid = { type: 'string', format: 'uuid', nullable: true };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };

const idempotencyHeaderParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_\\-:.]+$' },
};

export const schemas = {
  BloodborneMarker: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'tenant_id', 'patient_uid', 'marker', 'result', 'tested_on', 'source', 'recorded_by', 'recorded_at'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      tenant_id: { type: 'string', format: 'uuid' },
      patient_uid: { type: 'string', format: 'uuid' },
      marker: { type: 'string', enum: MARKERS },
      marker_label: nullableString,
      result: { type: 'string', enum: RESULTS },
      tested_on: { type: 'string', format: 'date' },
      source: { type: 'string', enum: SOURCES },
      lab_result_id: { type: 'integer', nullable: true },
      evidence: { type: 'object', additionalProperties: true },
      recorded_by: { type: 'string', format: 'uuid' },
      recorded_at: { type: 'string', format: 'date-time' },
      voided_at: nullableDateTime,
      voided_by: nullableUuid,
      void_reason: nullableString,
      notes: nullableString,
    },
  },
  BloodborneReuseMarkerSummary: {
    type: 'object',
    additionalProperties: false,
    required: ['marker', 'result', 'tested_on', 'source', 'age_days', 'within_window'],
    properties: {
      marker: { type: 'string', enum: MARKERS },
      label: nullableString,
      result: { type: 'string', enum: RESULTS },
      tested_on: { type: 'string', format: 'date' },
      source: { type: 'string', enum: SOURCES },
      age_days: { type: 'integer' },
      within_window: { type: 'boolean' },
    },
  },
  BloodborneReuseStatus: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'reasons', 'markers', 'validity_days', 'evaluated_at'],
    properties: {
      status: { type: 'string', enum: STATUSES },
      reasons: { type: 'array', items: { type: 'string' } },
      markers: { type: 'array', items: { $ref: '#/components/schemas/BloodborneReuseMarkerSummary' } },
      validity_days: { type: 'integer', minimum: 1, maximum: 365 },
      evaluated_at: { type: 'string', format: 'date-time' },
    },
  },
  BloodborneMarkerListData: {
    type: 'object',
    additionalProperties: false,
    required: ['markers', 'reuse_status'],
    properties: {
      markers: { type: 'array', items: { $ref: '#/components/schemas/BloodborneMarker' } },
      reuse_status: { $ref: '#/components/schemas/BloodborneReuseStatus' },
    },
  },
  BloodborneMarkerListResponse: envelope('BloodborneMarkerListData'),
  BloodborneMarkerVoidRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
  },
  BloodborneMarkerVoidData: {
    type: 'object',
    additionalProperties: false,
    required: ['marker'],
    properties: { marker: { $ref: '#/components/schemas/BloodborneMarker' } },
  },
  BloodborneMarkerVoidResponse: envelope('BloodborneMarkerVoidData'),
};

export const operations = {
  'GET /api/v1/bloodborne-markers/patient/{patientUid}': {
    description:
      'Patient blood-borne marker rows (latest first) and the reuse-restriction status derived from them. Reactive rows never lapse; non-reactive rows are relied on for validity_days (default 90).',
    pathParameters: { patientUid: { type: 'string', format: 'uuid' } },
    parameters: [
      { name: 'validity_days', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 365 } },
      { name: 'include_voided', in: 'query', required: false, schema: { type: 'boolean' } },
    ],
    response: 'BloodborneMarkerListResponse',
  },
  'POST /api/v1/bloodborne-markers/patient/{patientUid}/markers/{id}/void': {
    description:
      'Voids one marker row (entered in error). Requires Idempotency-Key (scope bloodborne_marker_void). A voided row is ignored by the resolver and cannot be voided again.',
    pathParameters: {
      patientUid: { type: 'string', format: 'uuid' },
      id: { type: 'integer', minimum: 1 },
    },
    parameters: [idempotencyHeaderParameter],
    request: 'BloodborneMarkerVoidRequest',
    response: 'BloodborneMarkerVoidResponse',
  },
};
```

- [ ] **Step 5: Register the module and regenerate**

In `apps/backend/scripts/generate-openapi.mjs`, next to `import * as cathConsumables from './openapi/schemas/cathConsumables.mjs';` add `import * as bloodborneMarkers from './openapi/schemas/bloodborneMarkers.mjs';`, and in the modules array add `bloodborneMarkers,` on the line after `cathConsumables,`. Then:

```bash
npm run openapi:generate
npm run openapi:check
npm test -- --testPathPatterns "unit/openapiContracts|unit/openapi"
```

Expected: generate rewrites `src/docs/openapi.json`; check exits 0; contract tests PASS. If `openapiContracts.test.js` enumerates schema modules by name (look at its lines 15–80), add `bloodborneMarkers` beside `cathConsumables` there too.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/clinical/bloodborneMarkerRoutes.js apps/backend/src/app.js apps/backend/scripts/openapi/schemas/bloodborneMarkers.mjs apps/backend/scripts/generate-openapi.mjs apps/backend/src/docs/openapi.json
git add -A apps/backend/src/middleware apps/backend/src/config 2>/dev/null
git commit -m "feat(api): blood-borne marker read/void routes with OpenAPI contract

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: Gates and hand-back

**Files:** none new.

- [ ] **Step 1: Backend lint and the full unit suite**

```bash
cd apps/backend
npm run lint
npm test -- --testPathPatterns unit/
```

Expected: lint exits 0 (the lint script chains several checks; all must pass); unit suite PASS.

- [ ] **Step 2: Deep suites touched by this plan**

```bash
DATABASE_URL=postgres://…/vh_bbm_<initials> npm test -- --testPathPatterns "bloodborne-markers.deep|lab-signoff-safety.deep|lab-corrected-signoff-reack.deep|lab-order-complete-on-signoff"
```

Expected: PASS. Read the summary line for `Suites failed` as well as `Tests passed`: a suite that fails in a hook shows tests passed and the suite failed, and that is a real failure.

- [ ] **Step 3: Repository gates**

```bash
cd "$SCRATCH/wt/bbm"
node scripts/ci/security.mjs
cd apps/backend && npm run check:migration-numbers && npm run check:migration-immutability && DATABASE_URL=postgres://…/vh_bbm_<initials> node scripts/check-schema-drift.mjs
```

Expected: all exit 0.

- [ ] **Step 4: Re-check the migration number against every open branch, then push and open a DRAFT PR**

Re-run Task 0 Step 2. If 765 is now claimed elsewhere, renumber the file (and the `schema.prisma` needs nothing) and amend the migration commit before pushing.

```bash
git commit --allow-empty -m "chore(ci): [full-ci] blood-borne marker foundation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push -u github feat/bloodborne-markers
gh pr create --repo Bahuleyandr/VH-Health-Platform --draft --base main --head feat/bloodborne-markers \
  --title "feat: patient blood-borne marker record + shared lab analyte code map" \
  --body-file <the PR body below>
```

PR body must state: spec paths; migration number and the branch check output; that no cath or CSSD code changed; the deep suites run and their counts; the OpenAPI regeneration; `Merge Gate` and `Full Merge Gate` results by name with the head SHA once the canonical `ci.yml` run lands (poll with `scratchpad/poll-pr.ps1 -Pr <N>`); merge authority stays with the coordinating session. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 5: Drop the scratch DB**

```bash
dropdb -h 127.0.0.1 -p 55432 vh_bbm_<initials>
```

---

## Self-review against the spec

- §5.1 table columns, constraints, indexes: Task 2. Unique partial index on `(tenant_id, lab_result_id)` restricted to non-voided rows so a corrective sign-off can re-insert: Task 2 + Task 4.
- §7.1 lab sign-off writer with code-map matching and corrective void/reinsert: Task 4 (`recordMarkersFromSignedResults`) + Task 5 (hook). External-report and clinical-declaration writers are the companion plan's (they call `recordMarkers`).
- §7.2 normaliser table, negative-before-positive ordering: Task 3, with the mutation check.
- §7.3 resolver rules including "reactive never lapses" and CJD without window: Task 3.
- §9.2 read + void routes, no create route, mount mirroring allergies: Task 6.
- Exposure handler registry for the cath late-result quarantine: Task 3 + Task 4 (fired after commit).
- Gates named in §15: Task 7.
