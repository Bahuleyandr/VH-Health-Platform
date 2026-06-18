# Revenue-Cycle Tracker (Forward #3 Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified `revenue_cycle_runs` standing-queue tracker that projects the PA→appeal spine into one queryable read-model per case, with a flag-gated 5-minute sweep and two GET endpoints.

**Architecture:** A new `revenue_cycle_runs` table (migration 316) is the read-model. A sweep service queries `clinical_ai_prior_auth_requests` and `clinical_ai_appeal_letters`, derives `current_stage` deterministically, and UPSERTs one row per case. Two thin GET routes expose the queue to billing staff. The tracker is observational only — it never submits, never generates drafts.

**Tech Stack:** Node.js 22 + ESM + Prisma + raw `$queryRawUnsafe` (RLS-wrapped via `setTenant`) + `node-cron` + Jest real-PG integration tests.

---

## DEFERRED (explicitly out of scope — do NOT build here)
- Per-stage auto-generation triggers: coding→denial→PA threshold logic that generates the next AI draft
- Event-driven (vs polled) appeal-start
- Appeal-outcome re-submission loop
- Any write path that submits, denies, or approves claims

These are decision-support / human-in-loop design problems. Note in code comments.

---

## File Map

| Action | Path |
|--------|------|
| Create | `apps/backend/src/migrations/316_revenue_cycle_runs.sql` |
| Modify | `apps/backend/prisma/schema.prisma` (regenerated via `npx prisma db pull`) |
| Create | `apps/backend/src/services/billing/revenueCycleTrackerService.js` |
| Modify | `apps/backend/src/utils/scheduler.js` (add import + flag-gated cron) |
| Create | `apps/backend/src/routes/billing/revenueCycleTrackerRoutes.js` |
| Modify | `apps/backend/src/app.js` (mount the new router) |
| Modify | `apps/backend/.env.example` (add `REVENUE_CYCLE_TRACKER_ENABLED=false`) |
| Modify | `apps/backend/src/utils/validateEnv.js` (add Joi key) |
| Create | `apps/backend/src/tests/revenueCycleTracker.deep.test.js` |

---

## Task 1: Git setup — branch off main

**Files:** none

- [ ] **Step 1: Checkout main and create feature branch**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
git checkout main
git pull --ff-only github main 2>/dev/null; git pull --ff-only origin main 2>/dev/null; true
git checkout -b feat/revenue-cycle-tracker
```

Expected: branch `feat/revenue-cycle-tracker` checked out.

---

## Task 2: Migration 316 — `revenue_cycle_runs` table + RLS

**Files:**
- Create: `apps/backend/src/migrations/316_revenue_cycle_runs.sql`

The RLS policy shape is copied byte-for-byte from migration 315 (`clinical_ai_operational_alerts`). Match USING / WITH CHECK / FORCE ROW LEVEL SECURITY / GUC-reading tenant_id default exactly.

- [ ] **Step 1: Write the migration file**

Create `apps/backend/src/migrations/316_revenue_cycle_runs.sql`:

```sql
-- 316_revenue_cycle_runs.sql
-- Unified revenue-cycle standing-queue tracker (Forward #3 core).
-- READ MODEL only — never auto-submits, never generates AI drafts.
-- A sweep service UPSERTs one row per case keyed by prior_auth_id.
-- Per-stage auto-generation triggers (coding→denial→PA threshold logic)
-- are DEFERRED — they require human-in-loop design decisions.

CREATE TABLE IF NOT EXISTS revenue_cycle_runs (
  id                   SERIAL PRIMARY KEY,
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_key             VARCHAR(120) NOT NULL,
  patient_uid          UUID,
  current_stage        VARCHAR(30)  NOT NULL DEFAULT 'prior_auth'
                         CHECK (current_stage IN ('coding','denial_risk','prior_auth','appeal','resolved','closed')),
  status               VARCHAR(20)  NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','resolved','closed')),
  payer_name           VARCHAR(200),
  claim_id             INTEGER,
  coding_generation_id INTEGER,
  denial_risk_generation_id INTEGER,
  prior_auth_id        INTEGER,
  appeal_id            INTEGER,
  stage_history        JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_revenue_cycle_runs_case
  ON revenue_cycle_runs (tenant_id, case_key);
CREATE INDEX IF NOT EXISTS idx_revenue_cycle_runs_tenant_stage
  ON revenue_cycle_runs (tenant_id, status, current_stage, last_evaluated_at DESC);

-- RLS: mirrors the canonical convention from migration 315 (USING + WITH CHECK,
-- FORCE RLS, GUC-reading tenant_id default). The bypass sentinel 'bypass' is
-- permissive so untenanted system queries and seeds continue to work.
ALTER TABLE revenue_cycle_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_cycle_runs FORCE ROW LEVEL SECURITY;

ALTER TABLE revenue_cycle_runs
  ALTER COLUMN tenant_id SET DEFAULT COALESCE(
    NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );

DROP POLICY IF EXISTS tenant_isolation ON revenue_cycle_runs;
CREATE POLICY tenant_isolation ON revenue_cycle_runs
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid
  );
```

- [ ] **Step 2: Apply migration to QA DB**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
DATABASE_URL="postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test" node scripts/ci-setup-db.mjs
```

Expected: migration 316 applied; output shows `316_revenue_cycle_runs.sql ... OK` (or already-applied skip).

- [ ] **Step 3: Regenerate schema.prisma**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
DATABASE_URL="postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test" npx prisma db pull
```

Expected: `prisma/schema.prisma` updated with `revenue_cycle_runs` model.

- [ ] **Step 4: Verify schema drift passes**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
DATABASE_URL="postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test" node scripts/check-schema-drift.mjs
```

Expected: `Schema drift check: PASS` (no output or explicit pass message).

- [ ] **Step 5: Commit migration + regenerated schema**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
git add src/migrations/316_revenue_cycle_runs.sql prisma/schema.prisma
git commit -m "feat(revenue-cycle): migration 316 revenue_cycle_runs + RLS + prisma pull"
```

---

## Task 3: Write the failing deep test FIRST (TDD)

**Files:**
- Create: `apps/backend/src/tests/revenueCycleTracker.deep.test.js`

Write the test before the service exists so it fails with "Cannot find module".

- [ ] **Step 1: Write the test**

Create `apps/backend/src/tests/revenueCycleTracker.deep.test.js`:

```js
// src/tests/revenueCycleTracker.deep.test.js
//
// Deep real-PG integration test for the revenue_cycle_runs tracker.
// Requires QA Postgres at 127.0.0.1:55432.
// DATABASE_URL must point there; if not set the describe block is skipped.

import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const {
  runRevenueCycleSweep,
  listRevenueCycleRuns,
  getRevenueCycleRun,
} = await import('../services/billing/revenueCycleTrackerService.js');

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT = DEFAULT_TENANT_ID; // '00000000-0000-4000-8000-000000000001'

// Seed helpers — insert the minimal required rows and return their ids.
async function seedPriorAuth(overrides = {}) {
  const [row] = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_prior_auth_requests
       (tenant_id, patient_uid, procedure_code, payer_name, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, NOW(), NOW())
     RETURNING id`,
    TENANT,
    overrides.patient_uid ?? '11111111-1111-4000-8000-000000000001',
    overrides.procedure_code ?? 'CPT-99213',
    overrides.payer_name ?? 'TestPayer',
    overrides.status ?? 'denied',
  );
  return row.id;
}

async function seedAppeal(priorAuthId, overrides = {}) {
  // appeal_status valid values: draft / ready_for_submission / submitted / approved / denied / withdrawn
  // clinical_ai_appeal_letters requires either claim_id or prior_auth_id (chk_appeal_single_source).
  const [row] = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_appeal_letters
       (tenant_id, prior_auth_id, appeal_status, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, NOW(), NOW())
     RETURNING id`,
    TENANT,
    priorAuthId,
    overrides.appeal_status ?? 'submitted',
  );
  return row.id;
}

async function cleanupRun(caseKey) {
  await prisma.$executeRawUnsafe(
    `DELETE FROM revenue_cycle_runs WHERE tenant_id = $1::uuid AND case_key = $2`,
    TENANT, caseKey,
  );
}

d('revenueCycleTracker (deep)', () => {
  let paId;
  let appealId;

  beforeAll(async () => {
    paId = await seedPriorAuth({ status: 'denied' });
    appealId = await seedAppeal(paId, { appeal_status: 'submitted' });
  });

  afterAll(async () => {
    // Clean up in dependency order.
    if (appealId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM clinical_ai_appeal_letters WHERE id = $1`, appealId,
      ).catch(() => {});
    }
    if (paId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM clinical_ai_prior_auth_requests WHERE id = $1`, paId,
      ).catch(() => {});
    }
    await cleanupRun(`prior_auth:${paId}`).catch(() => {});
    await prisma.$disconnect();
  });

  it('creates a revenue_cycle_runs row with stage=appeal after denied PA + submitted appeal', async () => {
    await runRevenueCycleSweep({ tenantId: TENANT });

    const { runs } = await listRevenueCycleRuns({ tenantId: TENANT, limit: 200 });
    const run = runs.find((r) => r.case_key === `prior_auth:${paId}`);

    expect(run).toBeTruthy();
    expect(run.current_stage).toBe('appeal');
    expect(run.status).toBe('open');
    expect(Number(run.prior_auth_id)).toBe(paId);
    expect(Number(run.appeal_id)).toBe(appealId);
  });

  it('advances stage to resolved + records stage_history when appeal is approved', async () => {
    // Flip appeal to approved.
    await prisma.$executeRawUnsafe(
      `UPDATE clinical_ai_appeal_letters SET appeal_status = 'approved', updated_at = NOW() WHERE id = $1`,
      appealId,
    );

    await runRevenueCycleSweep({ tenantId: TENANT });

    const run = await getRevenueCycleRun({ tenantId: TENANT, id: undefined, caseKey: `prior_auth:${paId}` });

    expect(run.current_stage).toBe('resolved');
    expect(run.status).toBe('resolved');
    expect(run.resolved_at).not.toBeNull();

    const history = Array.isArray(run.stage_history) ? run.stage_history : JSON.parse(run.stage_history ?? '[]');
    const resolvedEntry = history.find((h) => h.stage === 'resolved');
    expect(resolvedEntry).toBeTruthy();
  });

  it('listRevenueCycleRuns returns the run (no duplicates after two sweeps)', async () => {
    const { runs } = await listRevenueCycleRuns({ tenantId: TENANT, limit: 200 });
    const matching = runs.filter((r) => r.case_key === `prior_auth:${paId}`);
    // UPSERT guarantee: exactly one row, not two.
    expect(matching).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails with module-not-found**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
DATABASE_URL="postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node -r dotenv/config --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand revenueCycleTracker 2>&1 | head -30
```

Expected: FAIL with `Cannot find module '../services/billing/revenueCycleTrackerService.js'`.

- [ ] **Step 3: Commit the failing test**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
git add src/tests/revenueCycleTracker.deep.test.js
git commit -m "test(revenue-cycle): add failing deep integration test for tracker sweep"
```

---

## Task 4: Implement `revenueCycleTrackerService.js`

**Files:**
- Create: `apps/backend/src/services/billing/revenueCycleTrackerService.js`

Key logic:
- `runRevenueCycleSweep({ tenantId })`: scans `clinical_ai_prior_auth_requests` for the tenant, looks up matching appeal, derives stage, UPSERTs `revenue_cycle_runs`.
- `listRevenueCycleRuns({ tenantId, status?, stage?, limit? })`: returns runs ordered by last_evaluated_at DESC.
- `getRevenueCycleRun({ tenantId, id?, caseKey? })`: fetch by id or caseKey.

Stage derivation (pure, deterministic):
- appeal exists AND appeal_status IN (approved, denied, withdrawn) → stage='resolved', status='resolved'
- appeal exists (any other status) → stage='appeal', status='open'
- pa.status='denied' AND no appeal → stage='appeal' (awaiting), status='open'
- pa.status IN (approved, withdrawn) → stage='resolved', status='resolved'
- default → stage='prior_auth', status='open'

- [ ] **Step 1: Write the service file**

Create `apps/backend/src/services/billing/revenueCycleTrackerService.js`:

```js
// src/services/billing/revenueCycleTrackerService.js
//
// Revenue-cycle standing-queue tracker (Forward #3 core).
// READ-MODEL ONLY — derives current_stage from existing PA + appeal artifacts.
// Never submits, never generates AI drafts, never auto-advances.
//
// DEFERRED: per-stage auto-generation triggers (coding→denial→PA threshold
// logic that creates the next draft) require human-in-loop design and are
// explicitly NOT built here. See docs/REVENUE_CYCLE_ROADMAP.md when ready.

import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const TERMINAL_APPEAL_STATUSES = new Set(['approved', 'denied', 'withdrawn']);
const RESOLVED_PA_STATUSES = new Set(['approved', 'withdrawn']);
const LIMIT_CAP = 500;

function resolveTenantId(t) {
  return t || DEFAULT_TENANT_ID;
}

/**
 * Derive current_stage + status from a prior-auth row + optional appeal row.
 * Pure function — no DB calls.
 */
function deriveStage(pa, appeal) {
  if (appeal) {
    if (TERMINAL_APPEAL_STATUSES.has(appeal.appeal_status)) {
      return { current_stage: 'resolved', status: 'resolved' };
    }
    return { current_stage: 'appeal', status: 'open' };
  }
  if (pa.status === 'denied') {
    return { current_stage: 'appeal', status: 'open' }; // denied PA awaiting appeal
  }
  if (RESOLVED_PA_STATUSES.has(pa.status)) {
    return { current_stage: 'resolved', status: 'resolved' };
  }
  return { current_stage: 'prior_auth', status: 'open' };
}

/**
 * Load all prior-auth rows for a tenant.
 * Uses bypass (super-admin) mode so the sweep works outside the request scope.
 */
async function loadPriorAuths(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid::text AS patient_uid, procedure_code, payer_name, status
       FROM clinical_ai_prior_auth_requests
      WHERE tenant_id = $1::uuid
      ORDER BY id ASC`,
    tenantId,
  );
  return rows;
}

/**
 * Load appeal for a given prior_auth_id (there can be at most one per the
 * uq_appeal_prior_auth partial unique index on migration 313).
 */
async function loadAppeal(tenantId, priorAuthId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, appeal_status
       FROM clinical_ai_appeal_letters
      WHERE tenant_id = $1::uuid AND prior_auth_id = $2
      LIMIT 1`,
    tenantId,
    priorAuthId,
  );
  return rows[0] || null;
}

/**
 * Load the existing revenue_cycle_runs row for a case_key (to detect stage changes).
 */
async function loadExistingRun(tenantId, caseKey) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, current_stage, status, stage_history
       FROM revenue_cycle_runs
      WHERE tenant_id = $1::uuid AND case_key = $2
      LIMIT 1`,
    tenantId,
    caseKey,
  );
  return rows[0] || null;
}

/**
 * Build an updated stage_history array: append an entry only when the stage
 * has changed from the previous value. Reads the existing JSONB from DB row.
 */
function buildStageHistory(existingRow, newStage) {
  let history = [];
  if (existingRow) {
    const raw = existingRow.stage_history;
    history = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : []);
  }
  const prevStage = existingRow?.current_stage;
  if (prevStage && prevStage !== newStage) {
    history = [...history, { stage: newStage, transitioned_at: new Date().toISOString() }];
  } else if (!existingRow) {
    // First time — record the initial stage.
    history = [{ stage: newStage, transitioned_at: new Date().toISOString() }];
  }
  return history;
}

/**
 * UPSERT one revenue_cycle_runs row.
 * ON CONFLICT (tenant_id, case_key) updates in place — no duplicates.
 */
async function upsertRun(tenantId, pa, appeal, existing, derived) {
  const caseKey = `prior_auth:${pa.id}`;
  const stageHistory = buildStageHistory(existing, derived.current_stage);
  const resolvedAt = derived.status === 'resolved' ? 'NOW()' : 'NULL';

  await prisma.$executeRawUnsafe(
    `INSERT INTO revenue_cycle_runs
       (tenant_id, case_key, patient_uid, current_stage, status, payer_name,
        prior_auth_id, appeal_id,
        stage_history, last_evaluated_at, resolved_at, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6,
             $7, $8,
             $9::jsonb, NOW(), ${resolvedAt}, NOW())
     ON CONFLICT (tenant_id, case_key) DO UPDATE SET
       current_stage        = EXCLUDED.current_stage,
       status               = EXCLUDED.status,
       payer_name           = EXCLUDED.payer_name,
       prior_auth_id        = EXCLUDED.prior_auth_id,
       appeal_id            = EXCLUDED.appeal_id,
       patient_uid          = EXCLUDED.patient_uid,
       stage_history        = EXCLUDED.stage_history,
       last_evaluated_at    = NOW(),
       resolved_at          = ${resolvedAt},
       updated_at           = NOW()`,
    tenantId,
    caseKey,
    pa.patient_uid,
    derived.current_stage,
    derived.status,
    pa.payer_name || null,
    pa.id,
    appeal ? appeal.id : null,
    JSON.stringify(stageHistory),
  );
}

/**
 * Run the full revenue-cycle sweep for a tenant.
 * Scans all clinical_ai_prior_auth_requests, looks up appeals, derives stage,
 * and UPSERTs revenue_cycle_runs. Advisory tracker only — never acts.
 *
 * @param {{ tenantId?: string }} options
 * @returns {{ processed: number, errors: number }}
 */
export async function runRevenueCycleSweep({ tenantId } = {}) {
  const tid = resolveTenantId(tenantId);
  let processed = 0;
  let errors = 0;

  try {
    const priorAuths = await loadPriorAuths(tid);
    if (!priorAuths.length) {
      logger.info('revenue-cycle-tracker-sweep: no prior-auth rows', { tenantId: tid });
      return { processed: 0, errors: 0 };
    }

    for (const pa of priorAuths) {
      const caseKey = `prior_auth:${pa.id}`;
      try {
        const appeal = await loadAppeal(tid, pa.id);
        const existing = await loadExistingRun(tid, caseKey);
        const derived = deriveStage(pa, appeal);

        await setTenant(tid, async () => {
          await upsertRun(tid, pa, appeal, existing, derived);
        });

        processed++;
      } catch (err) {
        errors++;
        logger.error('revenue-cycle-tracker-sweep: upsert error', { caseKey, err: err.message });
      }
    }

    logger.info('revenue-cycle-tracker-sweep complete', { tenantId: tid, processed, errors });
  } catch (err) {
    logger.error('revenue-cycle-tracker-sweep: fatal error', { tenantId: tid, err: err.message });
    errors++;
  }

  return { processed, errors };
}

/**
 * List revenue_cycle_runs for a tenant, optionally filtered by status/stage.
 * Ordered by last_evaluated_at DESC (most recently swept first).
 *
 * @param {{ tenantId?: string, status?: string, stage?: string, limit?: number }}
 * @returns {{ runs: object[], count: number }}
 */
export async function listRevenueCycleRuns({ tenantId, status, stage, limit } = {}) {
  const tid = resolveTenantId(tenantId);
  const cap = Math.min(Number.isFinite(Number(limit)) ? Number(limit) : 50, LIMIT_CAP);

  let sql = `SELECT id, tenant_id::text, case_key, patient_uid::text, current_stage,
                    status, payer_name, claim_id, coding_generation_id,
                    denial_risk_generation_id, prior_auth_id, appeal_id,
                    stage_history, metadata,
                    first_seen_at, last_evaluated_at, resolved_at, created_at, updated_at
               FROM revenue_cycle_runs
              WHERE tenant_id = $1::uuid`;
  const params = [tid];

  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  if (stage) {
    params.push(stage);
    sql += ` AND current_stage = $${params.length}`;
  }

  params.push(cap);
  sql += ` ORDER BY last_evaluated_at DESC, id DESC LIMIT $${params.length}`;

  const runs = await prisma.$queryRawUnsafe(sql, ...params);
  return { runs, count: runs.length };
}

/**
 * Get a single revenue_cycle_runs row by numeric id OR by case_key.
 * Exactly one of `id` or `caseKey` must be provided.
 *
 * @param {{ tenantId?: string, id?: number, caseKey?: string }}
 * @returns {object|null}
 */
export async function getRevenueCycleRun({ tenantId, id, caseKey } = {}) {
  const tid = resolveTenantId(tenantId);

  if (id != null) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id::text, case_key, patient_uid::text, current_stage,
              status, payer_name, claim_id, coding_generation_id,
              denial_risk_generation_id, prior_auth_id, appeal_id,
              stage_history, metadata,
              first_seen_at, last_evaluated_at, resolved_at, created_at, updated_at
         FROM revenue_cycle_runs
        WHERE tenant_id = $1::uuid AND id = $2
        LIMIT 1`,
      tid,
      Number(id),
    );
    return rows[0] || null;
  }

  if (caseKey != null) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id::text, case_key, patient_uid::text, current_stage,
              status, payer_name, claim_id, coding_generation_id,
              denial_risk_generation_id, prior_auth_id, appeal_id,
              stage_history, metadata,
              first_seen_at, last_evaluated_at, resolved_at, created_at, updated_at
         FROM revenue_cycle_runs
        WHERE tenant_id = $1::uuid AND case_key = $2
        LIMIT 1`,
      tid,
      caseKey,
    );
    return rows[0] || null;
  }

  return null;
}
```

- [ ] **Step 2: Run the test — it should now pass**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
DATABASE_URL="postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node -r dotenv/config --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand revenueCycleTracker 2>&1
```

Expected: 3 tests PASS (`creates a row with stage=appeal`, `advances to resolved`, `no duplicates`). If any fail, debug — do NOT proceed until green.

- [ ] **Step 3: Commit service + passing test**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
git add src/services/billing/revenueCycleTrackerService.js src/tests/revenueCycleTracker.deep.test.js
git commit -m "feat(revenue-cycle): revenueCycleTrackerService + deep test green"
```

---

## Task 5: Scheduler integration — flag-gated cron

**Files:**
- Modify: `apps/backend/src/utils/scheduler.js`
- Modify: `apps/backend/.env.example`
- Modify: `apps/backend/src/utils/validateEnv.js`

- [ ] **Step 1: Add the import to scheduler.js**

After the existing `startPendingPriorAuthAppeals` import line (line ~55), add:

```js
// Revenue-cycle standing-queue tracker — flag-gated. Advisory tracker only.
// Per-stage auto-generation triggers are DEFERRED (human-in-loop design).
import { runRevenueCycleSweep } from '../services/billing/revenueCycleTrackerService.js';
```

- [ ] **Step 2: Add the cron registration to scheduler.js**

After the `CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED` block (around line 185), add:

```js
  // Revenue-cycle tracker sweep — flag-gated. Projects PA→appeal spine into
  // revenue_cycle_runs standing queue every 5 minutes. Advisory/read-model
  // only; never auto-submits or generates drafts.
  if (String(process.env.REVENUE_CYCLE_TRACKER_ENABLED || '').toLowerCase() === 'true') {
    cron.schedule('*/5 * * * *', withJobLock('revenue-cycle-tracker-sweep', async () => {
      const r = await runRevenueCycleSweep({});
      logger.info('revenue-cycle-tracker-sweep complete', r);
    }));
  }
```

- [ ] **Step 3: Add flag to .env.example**

Find the `CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED=false` line in `.env.example` and add immediately after it:

```
REVENUE_CYCLE_TRACKER_ENABLED=false
```

- [ ] **Step 4: Add Joi key to validateEnv.js**

Find the `CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED` Joi entry (lines ~178-182) and add immediately after it:

```js
  REVENUE_CYCLE_TRACKER_ENABLED: Joi.string()
    .valid('true', 'false')
    .allow('')
    .optional()
    .label('REVENUE_CYCLE_TRACKER_ENABLED'),
```

- [ ] **Step 5: Commit**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
git add src/utils/scheduler.js .env.example src/utils/validateEnv.js
git commit -m "feat(revenue-cycle): flag-gated cron sweep REVENUE_CYCLE_TRACKER_ENABLED"
```

---

## Task 6: Routes — GET /runs + GET /runs/:id

**Files:**
- Create: `apps/backend/src/routes/billing/revenueCycleTrackerRoutes.js`
- Modify: `apps/backend/src/app.js`

- [ ] **Step 1: Write the routes file**

Create `apps/backend/src/routes/billing/revenueCycleTrackerRoutes.js`:

```js
// src/routes/billing/revenueCycleTrackerRoutes.js
//
// Revenue-cycle standing-queue endpoints. Billing read-only.
// Mounted under /api/v1/billing/revenue-cycle via app.js (BILLING_ROUTE_ROLES).

import express from 'express';
import { success, error } from '../../utils/responseHelper.js';
import logger from '../../logging/logger.js';
import {
  listRevenueCycleRuns,
  getRevenueCycleRun,
} from '../../services/billing/revenueCycleTrackerService.js';

const router = express.Router();

function parseTenantId(req) {
  return req.user?.tenantId || req.query.tenantId || null;
}

/**
 * GET /api/v1/billing/revenue-cycle/runs
 * List revenue-cycle runs (billing standing queue).
 * Query params: status, stage, limit (max 500).
 */
router.get('/runs', async (req, res) => {
  try {
    const tenantId = parseTenantId(req);
    const { status, stage, limit } = req.query;
    const result = await listRevenueCycleRuns({ tenantId, status, stage, limit });
    return success(res, result, 'Revenue-cycle runs');
  } catch (err) {
    logger.error('GET /billing/revenue-cycle/runs error:', err);
    return error(res, 'Failed to list revenue-cycle runs', 500);
  }
});

/**
 * GET /api/v1/billing/revenue-cycle/runs/:id
 * Get a single revenue-cycle run by numeric id.
 */
router.get('/runs/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return error(res, 'Invalid run id', 400);
    const tenantId = parseTenantId(req);
    const run = await getRevenueCycleRun({ tenantId, id });
    if (!run) return error(res, 'Revenue-cycle run not found', 404);
    return success(res, run, 'Revenue-cycle run');
  } catch (err) {
    logger.error('GET /billing/revenue-cycle/runs/:id error:', err);
    return error(res, 'Failed to get revenue-cycle run', 500);
  }
});

export default router;
```

- [ ] **Step 2: Mount the router in app.js**

Find the line in `src/app.js` that mounts `revenueCycleRoutes`:

```js
app.use('/api/v1/billing', requireRole(...BILLING_ROUTE_ROLES), revenueCycleRoutes);
```

Add the import near the other billing route imports (look for `import revenueCycleRoutes from './routes/billing/revenueCycleRoutes.js';`):

```js
import revenueCycleTrackerRoutes from './routes/billing/revenueCycleTrackerRoutes.js';
```

Then add the mount immediately after the existing revenue-cycle mount line:

```js
app.use('/api/v1/billing/revenue-cycle', requireRole(...BILLING_ROUTE_ROLES), revenueCycleTrackerRoutes);
```

- [ ] **Step 3: Commit**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
git add src/routes/billing/revenueCycleTrackerRoutes.js src/app.js
git commit -m "feat(revenue-cycle): GET /billing/revenue-cycle/runs queue endpoints"
```

---

## Task 7: Gates — lint + drift + full test run

**Files:** none new — verification only.

- [ ] **Step 1: Run lint**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
npm run lint 2>&1 | tail -20
```

Expected: no errors. Fix any reported issues before proceeding.

- [ ] **Step 2: Run lint:raw-params**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
npm run lint:raw-params 2>&1 | tail -20
```

Expected: no violations. This checks that `$queryRawUnsafe` calls don't pass arrays or bare params inside `jsonb_build_object`.

- [ ] **Step 3: Run schema drift check**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
DATABASE_URL="postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test" node scripts/check-schema-drift.mjs 2>&1
```

Expected: PASS.

- [ ] **Step 4: Run only the new test in isolation (confirm still green)**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
DATABASE_URL="postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node -r dotenv/config --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand revenueCycleTracker 2>&1
```

Expected: 3 PASS, 0 FAIL.

- [ ] **Step 5: Fix any lint or drift issues, then commit fixes if needed**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
git add -A
git commit -m "fix(revenue-cycle): lint + drift fixes" || echo "nothing to fix"
```

---

## Task 8: Ship — merge to main

- [ ] **Step 1: Final commit on the feature branch**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform\apps\backend"
git add -A
git status
```

Confirm working tree is clean (or commit any remaining changes).

- [ ] **Step 2: Merge feature branch into main and push**

```bash
cd "D:\Dev\Projects\VH Health\VH-Health-Platform"
git checkout main
git merge --no-ff feat/revenue-cycle-tracker -m "Merge feat/revenue-cycle-tracker: unified revenue-cycle standing-queue tracker (forward #3 core)"
git push github main
git push origin main
git branch -d feat/revenue-cycle-tracker
```

Expected: push succeeds; branch deleted locally.

---

## Self-Review Checklist

### Spec coverage
| Requirement | Task |
|---|---|
| Migration 316 `revenue_cycle_runs` + RLS | Task 2 |
| `runRevenueCycleSweep` + stage derivation | Task 4 |
| `listRevenueCycleRuns` + `getRevenueCycleRun` | Task 4 |
| Flag-gated `*/5` cron + `REVENUE_CYCLE_TRACKER_ENABLED` | Task 5 |
| `.env.example` + `validateEnv.js` key | Task 5 |
| GET /runs + GET /runs/:id under BILLING_ROUTE_ROLES | Task 6 |
| Deep test: denied PA + submitted appeal → stage=appeal | Task 3/4 |
| Deep test: flip appeal to approved → stage=resolved + stage_history entry | Task 3/4 |
| Deep test: no duplicate rows (upsert) | Task 3/4 |
| `listRevenueCycleRuns` returns it | Task 3/4 |
| Lint + drift gates | Task 7 |
| Merge + push | Task 8 |

### Deferred (not built, documented in code comments)
- Per-stage auto-generation triggers (coding→denial→PA threshold logic)
- Event-driven (vs polled) appeal start
- Appeal-outcome re-submission loop

All three are `DEFERRED` comments in the service header and migration comment.
