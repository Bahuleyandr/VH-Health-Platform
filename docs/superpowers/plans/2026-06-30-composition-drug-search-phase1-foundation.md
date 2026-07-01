# Composition-based drug search — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the inert composition data layer — `drug_compositions` + structured catalog columns + a parser + an idempotent backfill + a curation queue/resolve path — with no UI or behavioural change, so later slices can rely on it.

**Architecture:** A new global `drug_compositions` table holds canonical molecule sets; `pharmacy_catalog` gains structured `composition_id`/strength/form columns populated by a pure `compositionParser` module from the existing free-text `name`/`generic_name`. A backfill seeds existing rows and queues unresolved/ambiguous ones for human curation. Nothing the app reads at runtime changes yet (additive columns, existing search untouched).

**Tech Stack:** Node 22 + Express 5 + PostgreSQL 17 (raw-SQL migrations, tracker-driven; Prisma client regenerated via `prisma db pull`), Jest (`--experimental-vm-modules`).

**Spec:** `docs/superpowers/specs/2026-06-30-composition-based-drug-search-design.md`

---

## File structure

- **Create** `apps/backend/src/migrations/350_drug_compositions.sql` — DDL: `drug_compositions`, `pharmacy_catalog` columns, `drug_composition_curation_queue`, index.
- **Create** `apps/backend/src/services/pharmacy/compositionParser.js` — pure module: `compositionKey`, `parseStrength`, `parseForm`, `parseCatalogRow`. No DB, no imports beyond stdlib.
- **Create** `apps/backend/src/tests/unit/compositionParser.test.js` — parser unit tests.
- **Create** `apps/backend/scripts/backfill-drug-compositions.mjs` — idempotent backfill + coverage report + curation-queue population.
- **Create** `apps/backend/src/tests/drug-composition-backfill.deep.test.js` — integration: backfill idempotency, coverage, curation queue, `source=curated` precedence.
- **Modify** `apps/backend/src/controllers/pharmacy/pharmacyOrderController.js` (`upsertCatalog` ~L1485) — call the parser on create/update.
- **Modify** `apps/backend/scripts/import-hospital-medicine-list.mjs` (~L291) — call the same enrichment (or invoke the backfill for touched rows).
- **Create** `apps/backend/scripts/resolve-drug-composition.mjs` — curation resolve: set identity + `source=curated` on a catalog row, close the queue row.
- **Modify** `apps/backend/prisma/schema.prisma` — regenerated via `prisma db pull` (do not hand-edit).

---

## Task 1: Migration — composition tables + catalog columns

**Files:**
- Create: `apps/backend/src/migrations/350_drug_compositions.sql`
- Modify: `apps/backend/prisma/schema.prisma` (regenerated)

- [ ] **Step 1: Write the migration DDL**

Create `apps/backend/src/migrations/350_drug_compositions.sql`:

```sql
-- 350_drug_compositions.sql
-- Composition layer for same-composition drug search (Phase 1, inert).
-- drug_compositions is GLOBAL (no tenant_id; a molecule set is a universal fact).
-- pharmacy_catalog gains structured composition/strength/form columns (additive).
-- drug_composition_curation_queue is tenant-scoped (review worklist).

CREATE TABLE IF NOT EXISTS drug_compositions (
  id                 SERIAL PRIMARY KEY,
  composition_key    VARCHAR(255) NOT NULL UNIQUE,
  display_label      VARCHAR(255) NOT NULL,
  active_ingredients TEXT[]       NOT NULL DEFAULT '{}',
  source             VARCHAR(20)  NOT NULL DEFAULT 'parsed'
                       CHECK (source IN ('parsed','curated','imported')),
  atc_code           VARCHAR(20),
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE pharmacy_catalog
  ADD COLUMN IF NOT EXISTS composition_id         INTEGER REFERENCES drug_compositions(id),
  ADD COLUMN IF NOT EXISTS strength               VARCHAR(80),
  ADD COLUMN IF NOT EXISTS strength_key           VARCHAR(120),
  ADD COLUMN IF NOT EXISTS strength_components    JSONB,
  ADD COLUMN IF NOT EXISTS form                   VARCHAR(40),
  ADD COLUMN IF NOT EXISTS form_key               VARCHAR(40),
  ADD COLUMN IF NOT EXISTS release_key            VARCHAR(10),
  ADD COLUMN IF NOT EXISTS route                  VARCHAR(40),
  ADD COLUMN IF NOT EXISTS composition_source     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS composition_confidence VARCHAR(10),
  ADD COLUMN IF NOT EXISTS parsed_notes           TEXT;

-- tenant-aware composite index for the alternatives lookup
CREATE INDEX IF NOT EXISTS idx_pharmacy_catalog_composition
  ON pharmacy_catalog (tenant_id, composition_id, strength_key, form_key, release_key)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS drug_composition_curation_queue (
  id             SERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL,
  catalog_id     INTEGER NOT NULL REFERENCES pharmacy_catalog(id) ON DELETE CASCADE,
  reason         VARCHAR(40) NOT NULL,           -- unresolved | partial_strength | ambiguous_molecules | ambiguous_form
  status         VARCHAR(20) NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','resolved','skip')),
  parser_output  JSONB,
  reviewer       VARCHAR(120),
  notes          TEXT,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT drug_composition_curation_queue_unique UNIQUE (tenant_id, catalog_id)
);

ALTER TABLE drug_composition_curation_queue ENABLE ROW LEVEL SECURITY;
-- Mirror the platform tenant_isolation pattern (migration 075): default-tenant
-- floor + GUC scoping. The bare policy below matches the existing PHI tables;
-- if the surrounding migrations use a helper, use that instead.
DROP POLICY IF EXISTS tenant_isolation ON drug_composition_curation_queue;
CREATE POLICY tenant_isolation ON drug_composition_curation_queue
  USING (
    tenant_id = COALESCE(
      NULLIF(current_setting('app.current_tenant_id', true), ''),
      '00000000-0000-4000-8000-000000000001'
    )::uuid
    OR current_setting('app.current_tenant_id', true) = 'bypass'
  );
```

> Before writing the RLS policy, open the most recent `*_tenant_rls_*` migration
> and copy its exact policy shape — match it verbatim rather than the sketch above
> if it differs.

- [ ] **Step 2: Apply the migration to a fresh CI-style DB and verify**

Run (from `apps/backend`, with the QA cluster up at `127.0.0.1:55432`):

```bash
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test" \
NODE_ENV=development node scripts/ci-setup-db.mjs
```

Expected: applies pending migrations incl. `350_drug_compositions.sql`, no error.

Verify the columns exist:

```bash
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test" node -e '
const pg=require("pg");(async()=>{const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
const r=await c.query("SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name IN ($2,$3,$4)",["pharmacy_catalog","composition_id","strength_key","strength_components"]);
console.log(r.rows.map(x=>x.column_name).sort().join(","));
await c.end();})();'
```

Expected output: `composition_id,strength_components,strength_key`

- [ ] **Step 3: Regenerate the Prisma schema (codebase rule: schema follows migrations)**

Run:

```bash
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test" \
  npx prisma db pull --schema=prisma/schema.prisma
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test" \
  node scripts/check-schema-drift.mjs
```

Expected: drift check passes (schema.prisma now models the new tables/columns).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/migrations/350_drug_compositions.sql apps/backend/prisma/schema.prisma apps/backend/prisma/SCHEMA_NOTES.md
git commit -m "feat(pharmacy): migration 350 — composition layer (drug_compositions + catalog columns + curation queue)"
```

---

## Task 2: `compositionParser.compositionKey`

**Files:**
- Create: `apps/backend/src/services/pharmacy/compositionParser.js`
- Test: `apps/backend/src/tests/unit/compositionParser.test.js`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/tests/unit/compositionParser.test.js`:

```js
import { compositionKey } from '../../services/pharmacy/compositionParser.js';

describe('compositionKey', () => {
  it('normalizes a single molecule', () => {
    const r = compositionKey('Paracetamol');
    expect(r.key).toBe('paracetamol');
    expect(r.activeIngredients).toEqual(['paracetamol']);
    expect(r.confidence).toBe('high');
  });

  it('splits + canonicalizes a combination, order-independent', () => {
    const a = compositionKey('Amoxicillin + Clavulanic acid');
    const b = compositionKey('Clavulanic Acid & Amoxicillin');
    expect(a.key).toBe('amoxicillin+clavulanic_acid');
    expect(a.key).toBe(b.key);
    expect(a.activeIngredients).toEqual(['amoxicillin', 'clavulanic_acid']);
  });

  it('expands known abbreviations via the alias map', () => {
    const r = compositionKey('Amoxicillin+Clav');
    expect(r.key).toBe('amoxicillin+clavulanic_acid');
  });

  it('flags empty/garbage input as low confidence', () => {
    const r = compositionKey('');
    expect(r.key).toBe('');
    expect(r.confidence).toBe('low');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/compositionParser.test.js -t compositionKey`
Expected: FAIL — "Cannot find module …/compositionParser.js".

- [ ] **Step 3: Write the minimal implementation**

Create `apps/backend/src/services/pharmacy/compositionParser.js`:

```js
// Pure composition/strength/form parser for the pharmacy catalog. No DB, no IO.

// Minimal, extensible alias map for the top Indian-formulary combos. Keys are
// lowercased tokens; values are the canonical molecule. Extend as curation finds
// gaps (a missing alias only lowers confidence — it never produces a wrong merge).
const MOLECULE_ALIASES = {
  clav: 'clavulanic_acid',
  'clavulanic acid': 'clavulanic_acid',
  clavulanate: 'clavulanic_acid',
  d3: 'cholecalciferol',
  b12: 'cyanocobalamin',
};

function canonMolecule(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return '';
  const aliased = MOLECULE_ALIASES[t] || t;
  return aliased.replace(/\s+/g, '_');
}

export function compositionKey(genericName) {
  const text = String(genericName || '').trim();
  if (!text) return { key: '', activeIngredients: [], displayLabel: '', confidence: 'low', notes: 'empty' };
  const parts = text
    .split(/\s*(?:\+|&|\/|,|\band\b|-)\s*/i)
    .map(canonMolecule)
    .filter(Boolean);
  if (parts.length === 0) return { key: '', activeIngredients: [], displayLabel: text, confidence: 'low', notes: 'no-molecules' };
  const ingredients = [...new Set(parts)].sort();
  const key = ingredients.join('+');
  const displayLabel = ingredients.map((m) => m.replace(/_/g, ' ')).join(' + ');
  // A molecule we had to keep verbatim (no alias, multi-word) is slightly riskier.
  const confidence = ingredients.length > 0 ? 'high' : 'low';
  return { key, activeIngredients: ingredients, displayLabel, confidence, notes: '' };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/compositionParser.test.js -t compositionKey`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/pharmacy/compositionParser.js apps/backend/src/tests/unit/compositionParser.test.js
git commit -m "feat(pharmacy): compositionKey — canonical molecule-set parsing"
```

---

## Task 3: `compositionParser.parseStrength`

**Files:**
- Modify: `apps/backend/src/services/pharmacy/compositionParser.js`
- Test: `apps/backend/src/tests/unit/compositionParser.test.js`

- [ ] **Step 1: Write the failing test** (append to the test file)

```js
import { parseStrength } from '../../services/pharmacy/compositionParser.js';

describe('parseStrength', () => {
  it('parses a simple strength + canonical key', () => {
    const r = parseStrength('Paracetamol 500mg');
    expect(r.display).toBe('500 mg');
    expect(r.key).toBe('500mg');
    expect(r.confidence).toBe('high');
  });

  it('normalizes units + spacing into the key (mcg/µg, spaces)', () => {
    expect(parseStrength('Levothyroxine 50 µg').key).toBe('50mcg');
    expect(parseStrength('Levothyroxine 50mcg').key).toBe('50mcg');
  });

  it('parses a ratio strength', () => {
    const r = parseStrength('Amoxicillin Syrup 125mg/5ml');
    expect(r.key).toBe('125mg/5ml');
  });

  it('extracts per-ingredient components only when explicit', () => {
    expect(parseStrength('Amox-Clav 500mg + 125mg').components)
      .toEqual([{ amount: 500, unit: 'mg' }, { amount: 125, unit: 'mg' }]);
    expect(parseStrength('Amoxicillin-Clavulanate 625').components).toBeNull();
  });

  it('returns null strength for a name with no dosage', () => {
    expect(parseStrength('Vitamin B Complex').key).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/compositionParser.test.js -t parseStrength`
Expected: FAIL — "parseStrength is not a function".

- [ ] **Step 3: Add the implementation** (append to `compositionParser.js`)

```js
const UNIT = '(mg|mcg|µg|g|ml|iu|%)';
const NUM = '(\\d+(?:\\.\\d+)?)';
const STRENGTH_RE = new RegExp(`${NUM}\\s*${UNIT}(?:\\s*/\\s*${NUM}\\s*${UNIT})?`, 'i');
const ALL_STRENGTHS_RE = new RegExp(`${NUM}\\s*${UNIT}`, 'gi');

function normUnit(u) {
  const x = String(u || '').toLowerCase();
  return x === 'µg' ? 'mcg' : x;
}

export function parseStrength(name) {
  const text = String(name || '');
  const m = STRENGTH_RE.exec(text);
  if (!m) return { display: null, key: null, components: null, confidence: 'low' };
  const a = m[1];
  const ua = normUnit(m[2]);
  let display = `${a} ${ua}`;
  let key = `${a}${ua}`;
  if (m[3]) { // ratio form NN unit / NN unit
    const ub = normUnit(m[4]);
    display = `${a}${ua}/${m[3]}${ub}`;
    key = `${a}${ua}/${m[3]}${ub}`;
  }
  // Per-ingredient components: only when ≥2 explicit "NN unit" tokens appear.
  const tokens = [...text.matchAll(ALL_STRENGTHS_RE)].map((t) => ({
    amount: Number(t[1]), unit: normUnit(t[2]),
  }));
  const components = tokens.length >= 2 ? tokens : null;
  return { display, key: key.toLowerCase().replace(/\s+/g, ''), components, confidence: 'high' };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/compositionParser.test.js -t parseStrength`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/pharmacy/compositionParser.js apps/backend/src/tests/unit/compositionParser.test.js
git commit -m "feat(pharmacy): parseStrength — canonical strength key + per-ingredient components"
```

---

## Task 4: `compositionParser.parseForm` + `parseCatalogRow`

**Files:**
- Modify: `apps/backend/src/services/pharmacy/compositionParser.js`
- Test: `apps/backend/src/tests/unit/compositionParser.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { parseForm, parseCatalogRow } from '../../services/pharmacy/compositionParser.js';

describe('parseForm', () => {
  it('detects form + canonical key', () => {
    expect(parseForm('Paracetamol 1g Injection').formKey).toBe('injection');
    expect(parseForm('Ondansetron Syrup 2mg/5ml').formKey).toBe('syrup');
    expect(parseForm('Metformin 500mg').formKey).toBe('tablet'); // default oral solid
  });

  it('detects modified release', () => {
    expect(parseForm('Metformin 500mg SR').releaseKey).toBe('sr');
    expect(parseForm('Nifedipine XR 30mg').releaseKey).toBe('xr');
    expect(parseForm('Amoxicillin 500mg').releaseKey).toBeNull();
  });
});

describe('parseCatalogRow', () => {
  it('combines composition + strength + form with an overall confidence', () => {
    const r = parseCatalogRow({ name: 'Augmentin 625mg', generic_name: 'Amoxicillin+Clav' });
    expect(r.composition.key).toBe('amoxicillin+clavulanic_acid');
    expect(r.strength.key).toBe('625mg');
    // combo with a total-only strength → flagged for curation
    expect(r.curationReason).toBe('partial_strength');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/compositionParser.test.js -t "parseForm|parseCatalogRow"`
Expected: FAIL — "parseForm is not a function".

- [ ] **Step 3: Add the implementation** (append)

```js
const FORM_KEYWORDS = [
  ['injection', /\b(inj|injection|vial|iv|im)\b/i],
  ['syrup', /\bsyrup\b/i],
  ['suspension', /\bsuspension\b/i],
  ['drops', /\bdrops?\b/i],
  ['capsule', /\b(cap|capsule)\b/i],
  ['cream', /\bcream\b/i],
  ['ointment', /\boint(ment)?\b/i],
  ['gel', /\bgel\b/i],
  ['spray', /\bspray\b/i],
  ['inhaler', /\b(inhaler|mdi|rotacap)\b/i],
  ['tablet', /\b(tab|tablet)\b/i],
];
const RELEASE_RE = /\b(sr|er|xr|cr|mr)\b/i;

export function parseForm(name) {
  const text = String(name || '');
  let formKey = null;
  for (const [key, re] of FORM_KEYWORDS) { if (re.test(text)) { formKey = key; break; } }
  if (!formKey) formKey = 'tablet'; // oral-solid default for a bare "Name NNmg"
  const rel = RELEASE_RE.exec(text);
  const releaseKey = rel ? rel[1].toLowerCase() : null;
  const route = formKey === 'injection' ? 'parenteral' : null;
  return { form: formKey, formKey, releaseKey, route, confidence: formKey === 'tablet' ? 'medium' : 'high' };
}

export function parseCatalogRow(row) {
  const composition = compositionKey(row.generic_name || '');
  const strength = parseStrength(row.name || '');
  const form = parseForm(row.name || '');
  const isCombo = composition.activeIngredients.length >= 2;
  let curationReason = null;
  if (!composition.key) curationReason = 'unresolved';
  else if (isCombo && !strength.components) curationReason = 'partial_strength';
  else if (!strength.key) curationReason = 'partial_strength';
  const confidence = curationReason ? (composition.key ? 'medium' : 'low') : 'high';
  return { composition, strength, form, confidence, curationReason };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/compositionParser.test.js`
Expected: PASS (all parser tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/pharmacy/compositionParser.js apps/backend/src/tests/unit/compositionParser.test.js
git commit -m "feat(pharmacy): parseForm + parseCatalogRow — form/release + combined row parse"
```

---

## Task 5: Backfill script + integration test

**Files:**
- Create: `apps/backend/scripts/backfill-drug-compositions.mjs`
- Test: `apps/backend/src/tests/drug-composition-backfill.deep.test.js`

- [ ] **Step 1: Write the failing integration test**

Create `apps/backend/src/tests/drug-composition-backfill.deep.test.js`:

```js
import prisma from '../lib/prisma.js';
import { backfillCompositions } from '../../scripts/backfill-drug-compositions.mjs';

const TENANT = '00000000-0000-4000-8000-000000000001';

describe('drug-composition backfill', () => {
  let augId, clavId;
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM drug_composition_curation_queue WHERE catalog_id IN (SELECT id FROM pharmacy_catalog WHERE name LIKE 'BFTEST %')`);
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'BFTEST %'`);
    const a = await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_catalog (name, generic_name, is_active, tenant_id, updated_at) VALUES ('BFTEST Augmentin 625mg','Amoxicillin+Clav',TRUE,$1::uuid,NOW()) RETURNING id`, TENANT);
    augId = Number(a[0].id);
    const b = await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_catalog (name, generic_name, is_active, tenant_id, updated_at) VALUES ('BFTEST Clavam 625mg','Amoxicillin + Clavulanic acid',TRUE,$1::uuid,NOW()) RETURNING id`, TENANT);
    clavId = Number(b[0].id);
  });
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('resolves both brands to the SAME composition and is idempotent', async () => {
    await backfillCompositions({ where: "name LIKE 'BFTEST %'" });
    const rows = await prisma.$queryRawUnsafe(`SELECT id, composition_id, strength_key FROM pharmacy_catalog WHERE id IN ($1::int,$2::int)`, augId, clavId);
    expect(rows[0].composition_id).toBeTruthy();
    expect(rows[0].composition_id).toBe(rows[1].composition_id); // same composition
    expect(rows[0].strength_key).toBe('625mg');
    // idempotent: a second run produces no new composition rows
    const before = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM drug_compositions`);
    await backfillCompositions({ where: "name LIKE 'BFTEST %'" });
    const after = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int n FROM drug_compositions`);
    expect(after[0].n).toBe(before[0].n);
  });

  it('queues the combo for curation (partial_strength) and does NOT overwrite source=curated', async () => {
    const q = await prisma.$queryRawUnsafe(`SELECT reason FROM drug_composition_curation_queue WHERE catalog_id=$1::int`, augId);
    expect(q[0].reason).toBe('partial_strength');
    await prisma.$executeRawUnsafe(`UPDATE pharmacy_catalog SET composition_source='curated' WHERE id=$1::int`, augId);
    await prisma.$executeRawUnsafe(`UPDATE pharmacy_catalog SET strength_key='OVERRIDDEN' WHERE id=$1::int`, augId);
    await backfillCompositions({ where: "name LIKE 'BFTEST %'" });
    const r = await prisma.$queryRawUnsafe(`SELECT strength_key FROM pharmacy_catalog WHERE id=$1::int`, augId);
    expect(r[0].strength_key).toBe('OVERRIDDEN'); // curated rows are skipped
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/drug-composition-backfill.deep.test.js`
Expected: FAIL — cannot import `backfillCompositions`.

- [ ] **Step 3: Write the backfill script**

Create `apps/backend/scripts/backfill-drug-compositions.mjs`:

```js
import pg from 'pg';
import { parseCatalogRow } from '../src/services/pharmacy/compositionParser.js';

async function upsertComposition(client, comp) {
  const rows = (await client.query(
    `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
     VALUES ($1,$2,$3,'parsed')
     ON CONFLICT (composition_key) DO UPDATE SET updated_at=NOW()
     RETURNING id`,
    [comp.key, comp.displayLabel, comp.activeIngredients],
  )).rows;
  return rows[0].id;
}

export async function backfillCompositions({ where = 'TRUE', connectionString } = {}) {
  const url = connectionString || process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const stats = { total: 0, resolved: 0, queued: 0 };
  try {
    const cat = (await client.query(
      `SELECT id, name, generic_name, tenant_id, composition_source
         FROM pharmacy_catalog WHERE is_active AND (${where})`,
    )).rows;
    for (const row of cat) {
      stats.total += 1;
      if (row.composition_source === 'curated' || row.composition_source === 'imported') continue; // precedence
      const p = parseCatalogRow(row);
      let compositionId = null;
      if (p.composition.key) compositionId = await upsertComposition(client, p.composition);
      await client.query(
        `UPDATE pharmacy_catalog SET
           composition_id=$2, strength=$3, strength_key=$4, strength_components=$5,
           form=$6, form_key=$7, release_key=$8, route=$9,
           composition_source='parsed', composition_confidence=$10, parsed_notes=$11, updated_at=NOW()
         WHERE id=$1`,
        [row.id, compositionId, p.strength.display, p.strength.key,
         p.strength.components ? JSON.stringify(p.strength.components) : null,
         p.form.form, p.form.formKey, p.form.releaseKey, p.form.route,
         p.confidence, p.composition.notes || null],
      );
      if (p.confidence === 'high') stats.resolved += 1;
      if (p.curationReason) {
        stats.queued += 1;
        await client.query(
          `INSERT INTO drug_composition_curation_queue (tenant_id, catalog_id, reason, status, parser_output)
           VALUES ($1::uuid,$2,$3,'open',$4)
           ON CONFLICT (tenant_id, catalog_id) DO UPDATE SET reason=EXCLUDED.reason, parser_output=EXCLUDED.parser_output, updated_at=NOW()`,
          [row.tenant_id, row.id, p.curationReason, JSON.stringify(p)],
        );
      }
    }
    return stats;
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('backfill-drug-compositions.mjs');
if (invokedDirectly) {
  backfillCompositions().then((s) => {
    console.log(`backfill: ${s.total} rows, ${s.resolved} high-confidence, ${s.queued} queued for curation`);
    process.exit(0);
  }).catch((e) => { console.error('backfill failed:', e.message); process.exit(1); });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/drug-composition-backfill.deep.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/scripts/backfill-drug-compositions.mjs apps/backend/src/tests/drug-composition-backfill.deep.test.js
git commit -m "feat(pharmacy): idempotent composition backfill + curation-queue population"
```

---

## Task 6: Parser hook on the catalog write paths

**Files:**
- Modify: `apps/backend/src/controllers/pharmacy/pharmacyOrderController.js` (`upsertCatalog`)
- Modify: `apps/backend/scripts/import-hospital-medicine-list.mjs`

- [ ] **Step 1: Write the failing test** (extend the backfill deep test file)

Append to `apps/backend/src/tests/drug-composition-backfill.deep.test.js`:

```js
import { enrichCatalogRowForWrite } from '../../scripts/backfill-drug-compositions.mjs';

describe('enrichCatalogRowForWrite (write-path hook)', () => {
  it('returns the structured columns for an upsert payload', () => {
    const e = enrichCatalogRowForWrite({ name: 'Metformin 500mg SR', generic_name: 'Metformin' });
    expect(e.strength_key).toBe('500mg');
    expect(e.form_key).toBe('tablet');
    expect(e.release_key).toBe('sr');
    expect(e.composition_confidence).toBe('high');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/drug-composition-backfill.deep.test.js -t enrichCatalogRowForWrite`
Expected: FAIL — `enrichCatalogRowForWrite` not exported.

- [ ] **Step 3: Add the helper + wire it into `upsertCatalog`**

In `apps/backend/scripts/backfill-drug-compositions.mjs`, add (and export) a DB-free enrichment helper for the write path (composition_id is resolved by the caller's DB or left to the next backfill; the structured columns are computed here):

```js
export function enrichCatalogRowForWrite(row) {
  const p = parseCatalogRow(row);
  return {
    strength: p.strength.display, strength_key: p.strength.key,
    strength_components: p.strength.components ? JSON.stringify(p.strength.components) : null,
    form: p.form.form, form_key: p.form.formKey, release_key: p.form.releaseKey, route: p.form.route,
    composition_source: 'parsed', composition_confidence: p.confidence, parsed_notes: p.composition.notes || null,
    _composition: p.composition, _curationReason: p.curationReason,
  };
}
```

In `pharmacyOrderController.js` `upsertCatalog` (~L1485): after building the
insert/update, import `enrichCatalogRowForWrite` and `parseCatalogRow`'s
composition upsert, set the structured columns, resolve `composition_id` via an
`INSERT INTO drug_compositions … ON CONFLICT (composition_key) DO UPDATE …
RETURNING id`, and add the columns to the `UPDATE`/`INSERT` SQL. Show the exact
edit:

```js
// near the top of the file
import { enrichCatalogRowForWrite } from '../../../scripts/backfill-drug-compositions.mjs';
```

```js
// inside upsertCatalog, after reading req.body name/generic_name:
const enriched = enrichCatalogRowForWrite({ name, generic_name: genericName });
let compositionId = null;
if (enriched._composition.key) {
  const cr = await prisma.$queryRawUnsafe(
    `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
     VALUES ($1,$2,$3,'parsed') ON CONFLICT (composition_key) DO UPDATE SET updated_at=NOW() RETURNING id`,
    enriched._composition.key, enriched._composition.displayLabel, enriched._composition.activeIngredients,
  );
  compositionId = cr[0].id;
}
// then include composition_id, strength, strength_key, strength_components, form,
// form_key, release_key, route, composition_source, composition_confidence,
// parsed_notes in the existing INSERT and UPDATE column lists + params.
```

In `import-hospital-medicine-list.mjs` (~L291): after each `UPDATE/INSERT
pharmacy_catalog`, either call the same enrichment inline, OR (simpler + matches
the spec's "minimally a mandatory post-import backfill") append a final step that
imports and runs `backfillCompositions({ where: '<rows touched by this import>' })`.
Choose the post-import backfill: add at the end of the importer's main routine:

```js
import { backfillCompositions } from './backfill-drug-compositions.mjs';
// … after the import loop commits:
await backfillCompositions({ connectionString }); // enrich every catalog row (idempotent; curated rows skipped)
```

- [ ] **Step 4: Run the tests + lint**

Run:
```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/drug-composition-backfill.deep.test.js
npm run lint
```
Expected: PASS + lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/scripts/backfill-drug-compositions.mjs apps/backend/src/controllers/pharmacy/pharmacyOrderController.js apps/backend/scripts/import-hospital-medicine-list.mjs apps/backend/src/tests/drug-composition-backfill.deep.test.js
git commit -m "feat(pharmacy): enrich composition on catalog upsert + post-import backfill"
```

---

## Task 7: Curation resolve script

**Files:**
- Create: `apps/backend/scripts/resolve-drug-composition.mjs`
- Test: `apps/backend/src/tests/drug-composition-backfill.deep.test.js` (extend)

- [ ] **Step 1: Write the failing test** (append)

```js
import { resolveCuration } from '../../scripts/resolve-drug-composition.mjs';

describe('resolveCuration', () => {
  it('sets curated identity, closes the queue row, and survives re-backfill', async () => {
    const c = await prisma.$queryRawUnsafe(`SELECT id, tenant_id FROM pharmacy_catalog WHERE name='BFTEST Clavam 625mg'`);
    const catalogId = Number(c[0].id);
    await resolveCuration({
      catalogId,
      compositionKey: 'amoxicillin+clavulanic_acid',
      strengthComponents: [{ ingredient: 'amoxicillin', amount: 500, unit: 'mg' }, { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' }],
      confidence: 'high', reviewer: 'pharmacist-1', notes: 'verified per pack',
    });
    const row = await prisma.$queryRawUnsafe(`SELECT composition_source, composition_confidence, strength_components FROM pharmacy_catalog WHERE id=$1::int`, catalogId);
    expect(row[0].composition_source).toBe('curated');
    expect(row[0].composition_confidence).toBe('high');
    const q = await prisma.$queryRawUnsafe(`SELECT status, reviewer FROM drug_composition_curation_queue WHERE catalog_id=$1::int`, catalogId);
    expect(q[0].status).toBe('resolved');
    expect(q[0].reviewer).toBe('pharmacist-1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/drug-composition-backfill.deep.test.js -t resolveCuration`
Expected: FAIL — cannot import `resolveCuration`.

- [ ] **Step 3: Write the resolver**

Create `apps/backend/scripts/resolve-drug-composition.mjs`:

```js
import pg from 'pg';

export async function resolveCuration({ catalogId, compositionKey, displayLabel, activeIngredients,
  strengthComponents, confidence = 'high', reviewer, notes, connectionString } = {}) {
  const url = connectionString || process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    let compositionId = null;
    if (compositionKey) {
      const label = displayLabel || compositionKey.replace(/[_+]/g, (m) => (m === '+' ? ' + ' : ' '));
      const ai = activeIngredients || compositionKey.split('+');
      const cr = await client.query(
        `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
         VALUES ($1,$2,$3,'curated')
         ON CONFLICT (composition_key) DO UPDATE SET source='curated', updated_at=NOW() RETURNING id`,
        [compositionKey, label, ai]);
      compositionId = cr.rows[0].id;
    }
    await client.query(
      `UPDATE pharmacy_catalog SET composition_id=$2, strength_components=$3,
         composition_source='curated', composition_confidence=$4, updated_at=NOW() WHERE id=$1`,
      [catalogId, compositionId, strengthComponents ? JSON.stringify(strengthComponents) : null, confidence]);
    await client.query(
      `UPDATE drug_composition_curation_queue SET status='resolved', reviewer=$2, notes=$3, updated_at=NOW()
       WHERE catalog_id=$1`,
      [catalogId, reviewer || null, notes || null]);
  } finally {
    await client.end();
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/drug-composition-backfill.deep.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/scripts/resolve-drug-composition.mjs apps/backend/src/tests/drug-composition-backfill.deep.test.js
git commit -m "feat(pharmacy): curation resolve — set curated identity + close queue row"
```

---

## Phase 1 done — verify the slice

- [ ] Run the full parser + backfill suites:
  `node --experimental-vm-modules node_modules/jest/bin/jest.js compositionParser drug-composition-backfill`
  Expected: all PASS.
- [ ] Run the real-catalog backfill + read the coverage line:
  `DATABASE_URL=… node scripts/backfill-drug-compositions.mjs`
  Expected: `backfill: N rows, R high-confidence, Q queued for curation` — **this R/Q is the coverage input for the Phase-rollout acceptance gate.** Capture it for the gate decision.
- [ ] Confirm no behavioural change: the existing `GET /pharmacy-orders/catalog` search response is unchanged (new columns are not yet returned — that's Phase 2).

**Next:** Plan 2 (Backend API) — grounded in this phase's real coverage numbers — adds the additive search fields, `/catalog/:id/alternatives`, the server-side composition allergy/duplicate in `validatePrescriptionSafety`, the IPD/e-Rx server-derived identity, and the substitution audit.
