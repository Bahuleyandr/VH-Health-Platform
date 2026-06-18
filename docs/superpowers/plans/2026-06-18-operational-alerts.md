# Operational Forecast Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the Wave-7 operational forecast modules into one unified, reviewable, advisory-only forward-risk alert stream (`clinical_ai_operational_alerts`), produced by a scheduled sweep over per-module evaluator adapters.

**Architecture:** A central `operationalAlertService` owns the alert table plus all cross-cutting logic (dedup-upsert, active→resolved lifecycle, severity, notify, event). A `withJobLock` cron sweep walks a registry of thin evaluator adapters; each wraps an existing forecast service / operational data source, applies a deterministic threshold, and returns normalized `AlertCandidate`s. Rules-authoritative, no auto-action, per-source-module enable gate, off by default behind a feature flag.

**Tech Stack:** Node.js 22 + Express 5, PostgreSQL 17 via Prisma (`prisma.$queryRawUnsafe`), raw-SQL migrations (source of truth), Jest + supertest, `node-cron`.

**Spec:** [`docs/superpowers/specs/2026-06-18-operational-alerts-design.md`](../specs/2026-06-18-operational-alerts-design.md)

---

## Conventions for every task (read once)

- **Run a single backend test file** (QA cluster up at `127.0.0.1:55432`):
  ```bash
  cd apps/backend && DATABASE_URL='postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test' \
    NODE_ENV=test node -r dotenv/config --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand <pattern>
  ```
- **Lint gate:** `cd apps/backend && npm run lint`
- **Raw SQL:** `prisma.$queryRawUnsafe(sql, ...params)` — spread params, never an array. Cast bare params inside `jsonb_build_*`. Explicit columns, no `SELECT *`.
- **Commit** after each task: `git add <paths> && git commit -m "<msg>"` (branch `feat/operational-alerts` already exists and holds the spec commit).
- **ESM jest:** unit tests that need `jest.fn()` must `import { jest } from '@jest/globals';`.

---

## File structure

| Path | Create/Modify | Responsibility |
|---|---|---|
| `src/migrations/315_operational_alerts.sql` | Create | table + indexes + RLS policy |
| `prisma/schema.prisma` | Modify (db pull) | regenerated model |
| `src/services/ai/operationalAlertEvaluators.js` | Create | `AlertCandidate` typedef + 13 evaluator adapters + `OPERATIONAL_ALERT_EVALUATORS` registry |
| `src/services/ai/operationalAlertService.js` | Create | table I/O, `reconcile`, lifecycle, notify+event, `runSweep`, `listOperationalAlerts`, `decideOperationalAlert` |
| `src/utils/scheduler.js` | Modify | register `operational-alert-sweep` cron (flag-gated) |
| `src/controllers/admin/clinicalAi/operationalAlertController.js` | Create | thin controllers |
| `src/routes/admin/clinicalAi/operationalAlertRoutes.js` | Create | 3 admin routes |
| `src/app.js` (or clinicalAi route index) | Modify | mount the router |
| `.env.example`, `src/utils/validateEnv.js` | Modify | `CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED` |
| `src/tests/unit/operationalAlertReconcile.test.js` | Create | reconcile unit tests |
| `src/tests/unit/operationalAlertEvaluators.test.js` | Create | evaluator threshold tests |
| `src/tests/operationalAlerts.deep.test.js` | Create | real-PG end-to-end |
| `docs/CLINICAL_AI_ENABLEMENT_PLAN.md` | Modify | flip forward-item #5 status |

---

## Task 1: Migration — `clinical_ai_operational_alerts` table

**Files:**
- Create: `src/migrations/315_operational_alerts.sql`
- Modify: `prisma/schema.prisma` (via `prisma db pull`)

- [ ] **Step 1: Write the migration**

```sql
-- 315_operational_alerts.sql
-- Unified forward-looking operational forecast alert stream.
-- Advisory only — never auto-acts. Rules-authoritative severity; auto-resolve
-- + keep history. See docs/superpowers/specs/2026-06-18-operational-alerts-design.md.

CREATE TABLE IF NOT EXISTS clinical_ai_operational_alerts (
  id                  SERIAL PRIMARY KEY,
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key          VARCHAR(80)  NOT NULL,
  domain              VARCHAR(40)  NOT NULL,
  owner_role          VARCHAR(40),
  scope_key           VARCHAR(200) NOT NULL,
  scope_label         VARCHAR(200),
  horizon             VARCHAR(40),
  predicted_for       TIMESTAMPTZ,
  alert_category      VARCHAR(60)  NOT NULL DEFAULT 'unknown',
  severity            VARCHAR(20)  NOT NULL DEFAULT 'low'
                        CHECK (severity IN ('low','moderate','high','critical','unknown')),
  metrics             JSONB NOT NULL DEFAULT '{}'::jsonb,
  signals             JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary             TEXT,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations    JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_id       INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,
  system_status       VARCHAR(20)  NOT NULL DEFAULT 'active'
                        CHECK (system_status IN ('active','resolved','superseded')),
  reviewer_decision   VARCHAR(30)  NOT NULL DEFAULT 'pending'
                        CHECK (reviewer_decision IN ('pending','accepted','deferred','rejected','edited')),
  reviewed_by         UUID,
  reviewed_at         TIMESTAMPTZ,
  reviewer_note       TEXT,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_evaluated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,
  resolved_reason     TEXT,
  notified_at         TIMESTAMPTZ,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until     DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1095 days')
);

-- one OPEN alert per (tenant, module, scope) → re-sweep upserts, never duplicates
CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_alerts_active_scope
  ON clinical_ai_operational_alerts (tenant_id, module_key, scope_key)
  WHERE system_status = 'active';
CREATE INDEX IF NOT EXISTS idx_operational_alerts_tenant_status_sev_eval
  ON clinical_ai_operational_alerts (tenant_id, system_status, severity, last_evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_alerts_tenant_domain_eval
  ON clinical_ai_operational_alerts (tenant_id, domain, last_evaluated_at DESC);
CREATE INDEX IF NOT EXISTS idx_operational_alerts_tenant_decision_created
  ON clinical_ai_operational_alerts (tenant_id, reviewer_decision, created_at DESC);

ALTER TABLE clinical_ai_operational_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON clinical_ai_operational_alerts;
CREATE POLICY tenant_isolation ON clinical_ai_operational_alerts
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id::text = current_setting('app.current_tenant_id', true)
  );
```

> Confirm the RLS policy clause matches the project's other `tenant_isolation` policies — open the
> newest `src/migrations/*tenant_rls*.sql` and copy its exact `USING (...)` expression if it differs
> from the above (the GUC name is `app.current_tenant_id`, `'bypass'` is the super-admin sentinel).

- [ ] **Step 2: Apply + regenerate schema + drift check**

```bash
cd apps/backend
node scripts/qa-reset.mjs            # or qa-cluster-up.mjs — applies pending migrations
npx prisma db pull --schema=prisma/schema.prisma
node scripts/check-schema-drift.mjs
```
Expected: drift check passes; `prisma/schema.prisma` gains a `clinical_ai_operational_alerts` model.

- [ ] **Step 3: Commit**

```bash
git add src/migrations/315_operational_alerts.sql prisma/schema.prisma prisma/SCHEMA_NOTES.md
git commit -m "feat(ops-alerts): clinical_ai_operational_alerts table + RLS (migration 315)"
```

---

## Task 2: `AlertCandidate` contract + evaluator registry skeleton

Build the contract and registry first so the orchestrator (Task 3) can be written + tested against it. Evaluators start as stubs returning `[]`; Task 8 fills them in. The registry's metadata (module_key/domain/owner_role) is real now.

**Files:**
- Create: `src/services/ai/operationalAlertEvaluators.js`

- [ ] **Step 1: Write the registry module**

```js
// src/services/ai/operationalAlertEvaluators.js
//
// Per-module evaluator adapters for the operational forecast alert stream.
// Each evaluator wraps an existing forecast service / operational data source,
// applies a DETERMINISTIC threshold, and returns normalized AlertCandidates.
// The orchestrator (operationalAlertService) owns persistence + lifecycle.

/**
 * @typedef {Object} AlertCandidate
 * @property {string} module_key
 * @property {string} domain
 * @property {string|null} owner_role
 * @property {string} scope_key             dedup identity within (tenant, module)
 * @property {string} [scope_label]
 * @property {string} [horizon]             'tonight'|'24h'|'72h'|'7d'|ISO date
 * @property {Date|null} [predicted_for]
 * @property {string} alert_category
 * @property {'low'|'moderate'|'high'|'critical'} severity
 * @property {object} [metrics]
 * @property {object[]} [signals]
 * @property {string} [summary]
 * @property {string[]} [recommended_actions]
 * @property {object[]} [source_citations]
 */

// Each evaluator: async ({ tenantId, now }) => AlertCandidate[]
// Stubs return [] until Task 8 implements them.
const stub = async () => [];

export const OPERATIONAL_ALERT_EVALUATORS = [
  { module_key: 'pharmacy_stockout_predictor',       domain: 'pharmacy',     owner_role: 'MATERIALS_MANAGER',    evaluate: stub },
  { module_key: 'blood_bank_demand_forecast',        domain: 'blood_bank',   owner_role: 'BLOOD_BANK_STAFF',     evaluate: stub },
  { module_key: 'bed_discharge_forecast',            domain: 'beds',         owner_role: 'BED_MANAGER',          evaluate: stub },
  { module_key: 'housekeeping_bed_turnover',         domain: 'housekeeping', owner_role: 'HOUSEKEEPING_STAFF',   evaluate: stub },
  { module_key: 'acuity_staffing_forecast',          domain: 'staffing',     owner_role: 'HOUSE_SUPERVISOR',     evaluate: stub },
  { module_key: 'staff_roster_optimizer',            domain: 'staffing',     owner_role: 'HR_STAFF',             evaluate: stub },
  { module_key: 'staff_burnout_workload_risk',       domain: 'staffing',     owner_role: 'HR_STAFF',             evaluate: stub },
  { module_key: 'ot_case_time_predictor',            domain: 'ot',           owner_role: 'OT_INCHARGE',          evaluate: stub },
  { module_key: 'ot_block_scheduling',               domain: 'ot',           owner_role: 'OT_INCHARGE',          evaluate: stub },
  { module_key: 'appointment_no_show_predictor',     domain: 'opd',          owner_role: 'RECEPTIONIST',         evaluate: stub },
  { module_key: 'biomed_device_maintenance',         domain: 'biomed',       owner_role: 'BIOMEDICAL_STAFF',     evaluate: stub },
  { module_key: 'inventory_intelligence',            domain: 'inventory',    owner_role: 'MATERIALS_MANAGER',    evaluate: stub },
  { module_key: 'procurement_negotiation_assistant', domain: 'procurement',  owner_role: 'PROCUREMENT_LEAD',     evaluate: stub },
];
```

> `owner_role` values are drawn from the role allowlist in `src/routes/admin/clinicalAi/shared.js`
> (`CLINICAL_AI_USER_ROLES_LIST`). Confirm each exists there; an unknown role still lists in the
> queue, it just gets no targeted push. Update the list in `shared.js` if a new ops role is needed.

- [ ] **Step 2: Commit**

```bash
git add src/services/ai/operationalAlertEvaluators.js
git commit -m "feat(ops-alerts): AlertCandidate contract + evaluator registry skeleton"
```

---

## Task 3: `operationalAlertService` — table I/O + reconcile + runSweep (TDD)

The heart of the feature. Write the reconcile unit test FIRST against a mocked evaluator + a mocked DB layer, then implement.

**Files:**
- Create: `src/services/ai/operationalAlertService.js`
- Test: `src/tests/unit/operationalAlertReconcile.test.js`

- [ ] **Step 1: Write the failing reconcile unit test**

`reconcile(openAlerts, candidates)` is a PURE function: given current open rows and this run's
candidates, it returns `{ toInsert, toUpdate, toResolve, toNotify }`. Test it in isolation (no DB).

```js
// src/tests/unit/operationalAlertReconcile.test.js
import { reconcile } from '../../services/ai/operationalAlertService.js';

const cand = (over = {}) => ({
  module_key: 'pharmacy_stockout_predictor', domain: 'pharmacy', owner_role: 'MATERIALS_MANAGER',
  scope_key: 'SKU-1', alert_category: 'stockout_risk', severity: 'high', ...over,
});
const open = (over = {}) => ({
  id: 1, module_key: 'pharmacy_stockout_predictor', scope_key: 'SKU-1', severity: 'moderate',
  notified_at: null, ...over,
});

describe('reconcile (ops-alerts)', () => {
  it('inserts a brand-new candidate and notifies when high/critical', () => {
    const r = reconcile([], [cand()]);
    expect(r.toInsert).toHaveLength(1);
    expect(r.toUpdate).toHaveLength(0);
    expect(r.toResolve).toHaveLength(0);
    expect(r.toNotify.map((n) => n.scope_key)).toEqual(['SKU-1']);
  });

  it('updates a matching open alert and does NOT duplicate', () => {
    const r = reconcile([open()], [cand({ severity: 'moderate' })]);
    expect(r.toInsert).toHaveLength(0);
    expect(r.toUpdate).toHaveLength(1);
    expect(r.toUpdate[0].id).toBe(1);
    expect(r.toNotify).toHaveLength(0); // moderate, not escalated
  });

  it('notifies once on escalation into high when not previously notified', () => {
    const r = reconcile([open({ severity: 'moderate', notified_at: null })], [cand({ severity: 'critical' })]);
    expect(r.toNotify).toHaveLength(1);
  });

  it('does NOT re-notify an already-notified alert', () => {
    const r = reconcile([open({ severity: 'high', notified_at: new Date() })], [cand({ severity: 'critical' })]);
    expect(r.toNotify).toHaveLength(0);
  });

  it('auto-resolves an open alert absent from this run', () => {
    const r = reconcile([open({ scope_key: 'SKU-GONE' })], [cand({ scope_key: 'SKU-1' })]);
    expect(r.toResolve.map((a) => a.scope_key)).toEqual(['SKU-GONE']);
    expect(r.toInsert).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

Run the single-file command with pattern `operationalAlertReconcile`. Expected: FAIL (`reconcile` not exported).

- [ ] **Step 3: Implement the service**

```js
// src/services/ai/operationalAlertService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { setTenant } from '../../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { OPERATIONAL_ALERT_EVALUATORS } from './operationalAlertEvaluators.js';
import { publishEvent } from '../events/eventOutboxService.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js';

const SEVERITY = ['unknown', 'low', 'moderate', 'high', 'critical'];
const PUSH_SEVERITIES = new Set(['high', 'critical']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

function sevRank(s) { const i = SEVERITY.indexOf(s); return i < 0 ? 0 : i; }
function resolveTenantId(t) { return t || DEFAULT_TENANT_ID; }

// Advisory guarantee (spec): EVERY persisted alert carries the decision-support
// disclaimer regardless of what an evaluator returned. Injected at the upsert.
const ADVISORY_FLAG = {
  severity: 'low', code: 'OPERATIONAL_ALERT_DECISION_SUPPORT_ONLY',
  message: 'Advisory forecast — decision support only; never auto-acts (no ordering, staffing, diversion, or transfer).',
};
function withAdvisoryFlags(flags = []) {
  return (flags || []).some((f) => f?.code === ADVISORY_FLAG.code)
    ? flags : [...(flags || []), ADVISORY_FLAG];
}

/**
 * Pure reconcile: diff this run's candidates against currently-open alerts.
 * @returns {{toInsert:AlertCandidate[], toUpdate:object[], toResolve:object[], toNotify:object[]}}
 */
export function reconcile(openAlerts, candidates) {
  const openByScope = new Map(openAlerts.map((a) => [a.scope_key, a]));
  const candScopes = new Set(candidates.map((c) => c.scope_key));
  const toInsert = [];
  const toUpdate = [];
  const toNotify = [];

  for (const c of candidates) {
    const existing = openByScope.get(c.scope_key);
    if (!existing) {
      toInsert.push(c);
      if (PUSH_SEVERITIES.has(c.severity)) toNotify.push(c);
    } else {
      toUpdate.push({ id: existing.id, candidate: c });
      const escalatedIntoPush = PUSH_SEVERITIES.has(c.severity)
        && sevRank(c.severity) > sevRank(existing.severity)
        && !existing.notified_at;
      if (escalatedIntoPush) toNotify.push({ ...c, id: existing.id });
    }
  }
  const toResolve = openAlerts.filter((a) => !candScopes.has(a.scope_key));
  return { toInsert, toUpdate, toResolve, toNotify };
}

async function loadOpenAlerts(tenantId, moduleKey) {
  return prisma.$queryRawUnsafe(
    `SELECT id, module_key, scope_key, severity, notified_at
       FROM clinical_ai_operational_alerts
      WHERE tenant_id = $1::uuid AND module_key = $2 AND system_status = 'active'`,
    tenantId, moduleKey,
  );
}

async function upsertCandidate(tenantId, c) {
  // ON CONFLICT on the partial unique index (active rows only).
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_operational_alerts
       (tenant_id, module_key, domain, owner_role, scope_key, scope_label, horizon,
        predicted_for, alert_category, severity, metrics, signals, summary,
        recommended_actions, source_citations, safety_flags, last_evaluated_at, updated_at)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,
             $14::jsonb,$15::jsonb,$16::jsonb,NOW(),NOW())
     ON CONFLICT (tenant_id, module_key, scope_key) WHERE system_status = 'active'
     DO UPDATE SET domain=EXCLUDED.domain, owner_role=EXCLUDED.owner_role,
        scope_label=EXCLUDED.scope_label, horizon=EXCLUDED.horizon,
        predicted_for=EXCLUDED.predicted_for, alert_category=EXCLUDED.alert_category,
        severity=EXCLUDED.severity, metrics=EXCLUDED.metrics, signals=EXCLUDED.signals,
        summary=EXCLUDED.summary, recommended_actions=EXCLUDED.recommended_actions,
        source_citations=EXCLUDED.source_citations, safety_flags=EXCLUDED.safety_flags,
        last_evaluated_at=NOW(), updated_at=NOW()
     RETURNING id`,
    tenantId, c.module_key, c.domain, c.owner_role ?? null, c.scope_key, c.scope_label ?? null,
    c.horizon ?? null, c.predicted_for ?? null, c.alert_category, c.severity,
    JSON.stringify(c.metrics || {}), JSON.stringify(c.signals || []), c.summary ?? null,
    JSON.stringify(c.recommended_actions || []), JSON.stringify(c.source_citations || []),
    JSON.stringify(withAdvisoryFlags(c.safety_flags)),
  );
  return rows?.[0]?.id ?? null;
}

async function resolveAlert(tenantId, id, reason = 'forecast_cleared') {
  await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_operational_alerts
        SET system_status='resolved', resolved_at=NOW(), resolved_reason=$3, updated_at=NOW()
      WHERE id=$1 AND tenant_id=$2::uuid AND system_status='active'`,
    id, tenantId, reason,
  );
}

async function notifyAndStamp(tenantId, c, alertId) {
  try {
    if (c.owner_role) {
      await notificationOutbox.queue({
        type: 'push', recipient: `role:${c.owner_role}`,
        payload: {
          kind: 'operational_alert', module_key: c.module_key, domain: c.domain,
          severity: c.severity, scope_label: c.scope_label || c.scope_key,
          horizon: c.horizon || null, summary: c.summary || null,
        },
      });
    }
    await publishEvent({
      eventType: 'clinical_ai.operational_alert_raised',
      aggregateType: 'clinical_ai_operational_alert', aggregateId: alertId,
      payload: { tenant_id: tenantId, module_key: c.module_key, domain: c.domain,
        severity: c.severity, scope_label: c.scope_label || c.scope_key,
        horizon: c.horizon || null, predicted_for: c.predicted_for || null },
    });
    await prisma.$queryRawUnsafe(
      `UPDATE clinical_ai_operational_alerts SET notified_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND tenant_id=$2::uuid`, alertId, tenantId,
    );
  } catch (err) {
    logger.warn('operational alert notify failed', { error: err?.message, module_key: c.module_key });
  }
}

export async function runSweep({ tenantId = null, moduleKeys = null, now = new Date() } = {}) {
  const tid = resolveTenantId(tenantId);
  const summary = { evaluated: 0, raised: 0, resolved: 0, errors: [] };
  const only = moduleKeys ? new Set(moduleKeys) : null;

  for (const evaluator of OPERATIONAL_ALERT_EVALUATORS) {
    if (only && !only.has(evaluator.module_key)) continue;
    let module;
    try {
      module = await getClinicalAiModule(evaluator.module_key, { tenantId: tid });
    } catch { module = { enabled: false }; }
    if (!module?.enabled) continue;

    summary.evaluated += 1;
    let candidates = [];
    try {
      candidates = (await evaluator.evaluate({ tenantId: tid, now })) || [];
    } catch (err) {
      summary.errors.push({ module_key: evaluator.module_key, error: err?.message });
      logger.warn('operational evaluator failed', { module_key: evaluator.module_key, error: err?.message });
      continue; // one module never aborts the sweep
    }

    const open = await loadOpenAlerts(tid, evaluator.module_key);
    const { toInsert, toUpdate, toResolve, toNotify } = reconcile(open, candidates);

    await setTenant(tid, async () => {
      for (const c of [...toInsert, ...toUpdate.map((u) => u.candidate)]) {
        await upsertCandidate(tid, c);
      }
      for (const a of toResolve) { await resolveAlert(tid, a.id); summary.resolved += 1; }
    });

    // Notify after the rows exist; re-load id by scope for the notify set.
    for (const c of toNotify) {
      const [row] = await prisma.$queryRawUnsafe(
        `SELECT id FROM clinical_ai_operational_alerts
          WHERE tenant_id=$1::uuid AND module_key=$2 AND scope_key=$3 AND system_status='active' LIMIT 1`,
        tid, c.module_key, c.scope_key,
      );
      if (row?.id) { await notifyAndStamp(tid, c, row.id); summary.raised += 1; }
    }
  }
  return summary;
}

export async function listOperationalAlerts({ tenantId = null, domain = null, severity = null,
  systemStatus = null, reviewerDecision = null, limit = 100 } = {}) {
  const tid = resolveTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, module_key, domain, owner_role, scope_key, scope_label, horizon,
            predicted_for, alert_category, severity, metrics, signals, summary,
            recommended_actions, source_citations, safety_flags, system_status,
            reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
            first_seen_at, last_evaluated_at, resolved_at, resolved_reason, notified_at,
            metadata, created_at, updated_at
       FROM clinical_ai_operational_alerts
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR domain = $2)
        AND ($3::text IS NULL OR severity = $3)
        AND ($4::text IS NULL OR system_status = $4)
        AND ($5::text IS NULL OR reviewer_decision = $5)
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2
               WHEN 'low' THEN 3 ELSE 4 END, last_evaluated_at DESC
      LIMIT $6`,
    tid, domain, severity, systemStatus, reviewerDecision, safeLimit,
  );
  return { alerts: rows, count: rows.length };
}

export async function decideOperationalAlert({ tenantId = null, alertId, decision, reviewerUid = null, note = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const d = String(decision || '').toLowerCase();
  if (!FINAL_DECISIONS.has(d)) throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  const id = Number.parseInt(alertId, 10);
  if (!Number.isFinite(id) || id < 1) throw AppError.badRequest('alert_id must be a positive integer');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_operational_alerts
        SET reviewer_decision=$2, reviewed_by=$3::uuid, reviewed_at=NOW(), reviewer_note=$4, updated_at=NOW()
      WHERE id=$1 AND tenant_id=$5::uuid
      RETURNING id, reviewer_decision, reviewed_by, reviewed_at, reviewer_note`,
    id, d, reviewerUid, note, tid,
  );
  if (!rows?.[0]) throw AppError.notFound('Operational alert not found');
  return rows[0];
}

export default { reconcile, runSweep, listOperationalAlerts, decideOperationalAlert };
```

> Verify these imports resolve as written before running: `setTenant`/`prisma` from `src/lib/prisma.js`,
> `publishEvent` from `src/services/events/eventOutboxService.js` (same path `hospitalCommandCenterService`
> uses), `notificationOutbox` default export from `src/utils/notifications/notificationOutbox.js`,
> `getClinicalAiModule` from `src/services/ai/clinicalAiModuleService.js`. Fix paths to match the repo if any differ.

- [ ] **Step 4: Run the reconcile test — expect PASS**

Pattern `operationalAlertReconcile`. Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/operationalAlertService.js src/tests/unit/operationalAlertReconcile.test.js
git commit -m "feat(ops-alerts): operationalAlertService reconcile + runSweep + list/decide"
```

---

## Task 4: Feature flag + scheduler registration

**Files:**
- Modify: `.env.example`, `src/utils/validateEnv.js`, `src/utils/scheduler.js`

- [ ] **Step 1: Add the env flag**

`.env.example` — add under the clinical-AI section:
```
# Operational forecast alert sweep (advisory). Off by default.
CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED=false
```
`src/utils/validateEnv.js` — add to the Joi schema as an optional boolean-ish string (warn-not-crash;
follow the existing pattern for other optional `CLINICAL_AI_*` flags in that file).

- [ ] **Step 2: Register the cron in `src/utils/scheduler.js`**

Add an import at the top: `import { runSweep } from '../services/ai/operationalAlertService.js';`
Then, in the scheduler start function alongside the other `cron.schedule(...)` lines:

```js
// Operational forecast alert sweep — advisory, flag-gated. Mirrors the
// every-30-min cadence of escalate-stuck-orders. Default tenant today; wrap in
// runWithSuperAdmin for cross-tenant fan-out when multi-tenant (see expire-break-glass).
if (String(process.env.CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED || '').toLowerCase() === 'true') {
  cron.schedule('*/30 * * * *', withJobLock('operational-alert-sweep', async () => {
    const r = await runSweep({});
    logger.info('operational-alert-sweep complete', r);
  }));
}
```

> Confirm `logger` is already imported in `scheduler.js` (it is used by other jobs). Match the exact
> indentation / placement of the surrounding `cron.schedule` block.

- [ ] **Step 3: Sanity — boot lint**

```bash
cd apps/backend && npm run lint
```
Expected: clean (no new eslint/raw-param/secret findings).

- [ ] **Step 4: Commit**

```bash
git add .env.example src/utils/validateEnv.js src/utils/scheduler.js
git commit -m "feat(ops-alerts): flag-gated operational-alert-sweep cron + env flag"
```

---

## Task 5: Admin API — routes + controllers

Mirror `src/routes/admin/clinicalAi/tierHOperationalRoutes.js` exactly (same `success()`,
`logClinicalAiAudit`, `req.tenantId`, `req.user.uid`, control-plane RBAC via the mount).

**Files:**
- Create: `src/controllers/admin/clinicalAi/operationalAlertController.js`
- Create: `src/routes/admin/clinicalAi/operationalAlertRoutes.js`
- Modify: the clinical-AI control-plane mount (where `tierHOperationalRoutes` is mounted — grep `tierHOperationalRoutes` to find it; mount the new router on the same parent path under `requireClinicalAiControl` + `adminIpAllowlist`).
- Test: `src/tests/operationalAlertRoutes.deep.test.js` (or fold into Task 6 deep test)

- [ ] **Step 1: Controller**

```js
// src/controllers/admin/clinicalAi/operationalAlertController.js
import { success } from '../../../utils/responseHelper.js';
import {
  listOperationalAlerts, decideOperationalAlert, runSweep,
} from '../../../services/ai/operationalAlertService.js';

export async function list(req, res, next) {
  try {
    const data = await listOperationalAlerts({
      tenantId: req.tenantId, domain: req.query.domain || null,
      severity: req.query.severity || null, systemStatus: req.query.system_status || null,
      reviewerDecision: req.query.reviewer_decision || null, limit: req.query.limit,
    });
    return success(res, data, 'Operational alerts');
  } catch (err) { return next(err); }
}

export async function decide(req, res, next) {
  try {
    const data = await decideOperationalAlert({
      tenantId: req.tenantId, alertId: req.params.id,
      decision: req.body?.decision, reviewerUid: req.user?.uid || null, note: req.body?.note || null,
    });
    return success(res, data, 'Operational alert decision recorded');
  } catch (err) { return next(err); }
}

export async function sweep(req, res, next) {
  try {
    const data = await runSweep({ tenantId: req.tenantId });
    return success(res, data, 'Operational alert sweep complete');
  } catch (err) { return next(err); }
}
```

- [ ] **Step 2: Router**

```js
// src/routes/admin/clinicalAi/operationalAlertRoutes.js
import express from 'express';
import { list, decide, sweep } from '../../../controllers/admin/clinicalAi/operationalAlertController.js';

const router = express.Router();
router.get('/operational-alerts', list);
router.post('/operational-alerts/:id/decision', decide);
router.post('/operational-alerts/run-sweep', sweep);
export default router;
```

- [ ] **Step 3: Mount it** next to `tierHOperationalRoutes` (same parent router/mount + middleware). Confirm the mount applies `requireClinicalAiControl` and `adminIpAllowlist` (the rest of `/admin` does).

- [ ] **Step 4: Lint + commit**

```bash
cd apps/backend && npm run lint
git add src/controllers/admin/clinicalAi/operationalAlertController.js \
        src/routes/admin/clinicalAi/operationalAlertRoutes.js src/app.js
git commit -m "feat(ops-alerts): admin list/decision/run-sweep routes"
```

---

## Task 6: Deep real-PG integration test (spine end-to-end)

Proves the spine with a **mocked evaluator registry** (Task 8 adds the real ones). Use `jest`'s module
mock to replace `operationalAlertEvaluators` with a controllable fake so the test owns the candidates.

**Files:**
- Create: `src/tests/operationalAlerts.deep.test.js`

- [ ] **Step 1: Write the deep test**

```js
import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';

// Controllable fake registry — one module, candidates driven per-test.
let FAKE_CANDIDATES = [];
jest.unstable_mockModule('../services/ai/operationalAlertEvaluators.js', () => ({
  OPERATIONAL_ALERT_EVALUATORS: [{
    module_key: 'pharmacy_stockout_predictor', domain: 'pharmacy', owner_role: 'MATERIALS_MANAGER',
    evaluate: async () => FAKE_CANDIDATES,
  }],
}));
// Force the module enabled regardless of catalog state.
jest.unstable_mockModule('../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: async () => ({ enabled: true, settings: {} }),
}));

const { runSweep, listOperationalAlerts } = await import('../services/ai/operationalAlertService.js');

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;
const TENANT = '00000000-0000-4000-8000-000000000001';
const C = (over = {}) => ({ module_key: 'pharmacy_stockout_predictor', domain: 'pharmacy',
  owner_role: 'MATERIALS_MANAGER', scope_key: 'SKU-DEEP-1', alert_category: 'stockout_risk',
  severity: 'critical', scope_label: 'Test SKU', ...over });

d('operational alerts sweep (deep)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_operational_alerts WHERE scope_key LIKE 'SKU-DEEP-%'`);
    FAKE_CANDIDATES = [];
  });
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_ai_operational_alerts WHERE scope_key LIKE 'SKU-DEEP-%'`).catch(() => {});
    await prisma.$disconnect();
  });

  it('raises an active alert and dedups on re-sweep (no duplicate, last_evaluated_at advances)', async () => {
    FAKE_CANDIDATES = [C()];
    await runSweep({ tenantId: TENANT });
    let { alerts } = await listOperationalAlerts({ tenantId: TENANT, domain: 'pharmacy' });
    const active = alerts.filter((a) => a.scope_key === 'SKU-DEEP-1' && a.system_status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].notified_at).not.toBeNull(); // critical → notified once

    const firstEval = active[0].last_evaluated_at;
    await new Promise((r) => setTimeout(r, 25));
    await runSweep({ tenantId: TENANT });
    ({ alerts } = await listOperationalAlerts({ tenantId: TENANT, domain: 'pharmacy' }));
    const active2 = alerts.filter((a) => a.scope_key === 'SKU-DEEP-1' && a.system_status === 'active');
    expect(active2).toHaveLength(1); // still one — upsert, not duplicate
    expect(new Date(active2[0].last_evaluated_at).getTime()).toBeGreaterThan(new Date(firstEval).getTime());
  });

  it('auto-resolves when the risk clears on the next sweep', async () => {
    FAKE_CANDIDATES = [C()];
    await runSweep({ tenantId: TENANT });
    FAKE_CANDIDATES = []; // risk cleared
    await runSweep({ tenantId: TENANT });
    const { alerts } = await listOperationalAlerts({ tenantId: TENANT, domain: 'pharmacy', systemStatus: 'resolved' });
    const resolved = alerts.find((a) => a.scope_key === 'SKU-DEEP-1');
    expect(resolved).toBeTruthy();
    expect(resolved.resolved_reason).toBe('forecast_cleared');
  });
});
```

- [ ] **Step 2: Run — expect PASS** (pattern `operationalAlerts.deep`). If notify fails because
  `notificationOutbox.queue`/`publishEvent` need schema not present in the QA DB, they are wrapped in
  try/catch and must not fail the sweep — assert `notified_at` is still set (the stamp UPDATE runs
  after the best-effort calls; if the event/outbox tables are absent the test still passes because
  the stamp is independent). If `notified_at` is null, move the stamp UPDATE before the
  outbox/event calls in `notifyAndStamp`.

- [ ] **Step 3: Commit**

```bash
git add src/tests/operationalAlerts.deep.test.js
git commit -m "test(ops-alerts): deep sweep — raise, dedup, auto-resolve, notify-once"
```

---

## Task 7: Implement the 13 evaluators

Replace each `stub` in `operationalAlertEvaluators.js` with a real `evaluate`. Each is a small,
independent commit. **For every evaluator, first read its producer** (the service/table named below),
then map breaching items to `AlertCandidate`s. Pattern below is the fully-worked reference; the table
specifies each remaining evaluator's data source, breach rule, `scope_key`, `alert_category`, `horizon`.

**Reference evaluator (fully coded) — `appointment_no_show_predictor` (aggregate):**

```js
// inside operationalAlertEvaluators.js — replace the appointment_no_show_predictor stub
import prisma from '../../lib/prisma.js';
import { scoreNoShowRisk } from './operationalAiService.js';

async function evaluateNoShow({ tenantId, now }) {
  // Aggregate: tomorrow's booked appointments → count high-risk → one hospital-level candidate.
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const ymd = tomorrow.toISOString().slice(0, 10);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM appointments
      WHERE appointment_date = $1::date AND status IN ('SCHEDULED','CONFIRMED')`, ymd);
  if (!rows.length) return [];
  let high = 0;
  for (const r of rows) {
    const s = await scoreNoShowRisk({ appointmentId: r.id, tenantId }).catch(() => null);
    if (s && s.band === 'high') high += 1;
  }
  const rate = high / rows.length;
  if (rate < 0.2) return []; // below threshold → no alert
  const severity = rate >= 0.4 ? 'high' : 'moderate';
  return [{
    module_key: 'appointment_no_show_predictor', domain: 'opd', owner_role: 'RECEPTIONIST',
    scope_key: `no-show:${ymd}`, scope_label: `OPD no-show load ${ymd}`, horizon: '24h',
    predicted_for: tomorrow, alert_category: 'no_show_surge', severity,
    metrics: { booked: rows.length, high_risk: high, rate: Number(rate.toFixed(2)) },
    signals: [{ code: 'NO_SHOW_LOAD', detail: `${high}/${rows.length} high-risk for ${ymd}` }],
    summary: `Predicted elevated no-show load for ${ymd}: ${high} of ${rows.length} high-risk.`,
    recommended_actions: ['Consider overbooking buffer / confirmation calls for high-risk slots.'],
    source_citations: [{ source_type: 'appointments', source_id: ymd, label: 'Booked appointments' }],
  }];
}
```
Wire it into the registry entry (`evaluate: evaluateNoShow`).

**Remaining 12 — per-module spec (one commit each):**

| module_key | producer to read first | breach rule (deterministic) | scope_key | alert_category | horizon |
|---|---|---|---|---|---|
| `inventory_intelligence` | `clinical_ai_inventory_alerts` table (already populated) | bridge: each row with `severity` ∈ {high,critical} & `system_status`-equivalent open → 1 candidate | `inv:${item_sku}` | map row's `alert_category` | `72h` |
| `pharmacy_stockout_predictor` | pharmacy stock/consumption tables (grep `inventory_items`/`stock` in pharmacySupplyService) | days-on-hand = on_hand / avg_daily_use < 7 → high, < 14 → moderate | `rx:${sku}` | `stockout_risk` | `7d` |
| `blood_bank_demand_forecast` | blood inventory + demand tables (grep `blood_`) | projected units < safety stock per group → high; < 1.5× → moderate | `blood:${group}` | `blood_shortage` | `tonight` |
| `bed_discharge_forecast` | beds/occupancy + admission queue (reuse `classifyBedStatus` inputs source) | predicted occupancy ≥ 92% or net beds < admissions queue → high | `beds:${ward||'hospital'}` | `bed_crunch` | `tonight` |
| `housekeeping_bed_turnover` | housekeeping pending turnovers (reuse `classifyHousekeepingStatus` source) | pending ≥ 10 or avg ≥ 45 min → moderate; ≥15/≥60 → high | `hk:${ward||'hospital'}` | `turnover_backlog` | `24h` |
| `acuity_staffing_forecast` | `acuityStaffingForecastService.js` | predicted nurse gap (required − rostered) ≥ 2 → high; ≥1 → moderate | `staffing:${ward}:${shift}` | `staffing_gap` | `24h` |
| `staff_roster_optimizer` | roster tables (grep `roster`) | uncovered shifts next 48h ≥ 1 → moderate; ≥3 → high | `roster:${date}:${shift}` | `roster_gap` | `72h` |
| `staff_burnout_workload_risk` | attendance/hours tables | staff with >X consecutive shifts / OT hours over threshold ≥ N → moderate | `burnout:${unit}` | `burnout_risk` | `7d` |
| `ot_case_time_predictor` | `operationalAiService.predictOtCaseTime` over tomorrow's OT list | sum(predicted) > block minutes → overrun: >60min → high, >20 → moderate | `ot-overrun:${date}:${theatre}` | `ot_overrun` | `24h` |
| `ot_block_scheduling` | OT block schedule tables | block utilization predicted >100% → high; gaps >X% → moderate | `ot-block:${date}:${theatre}` | `block_imbalance` | `7d` |
| `biomed_device_maintenance` | biomed device/PM-due tables (grep `biomed`/`device_maintenance`) | devices with PM overdue or due ≤7d & critical ≥1 → high | `biomed:${device_id}` | `pm_due` | `7d` |
| `procurement_negotiation_assistant` | procurement/PO + price tables | contracts expiring ≤30d or price-variance flagged ≥1 → moderate | `proc:${contract_id}` | `contract_risk` | `30d` |

For each: **Step a** read the producer, **Step b** add a `unit` test in
`src/tests/unit/operationalAlertEvaluators.test.js` asserting the threshold (mock the producer/`prisma`
to return one breaching + one healthy row → expect exactly one candidate of the right severity),
**Step c** implement, **Step d** run the unit test, **Step e** commit
(`feat(ops-alerts): <module_key> evaluator`).

> If a producer/table doesn't exist yet (some Wave-7 modules are LLM-explainers with no numeric
> source), the evaluator computes its rule over the nearest real operational table (the same source
> the command-center classifier uses), or — if there is genuinely no data source — leave that one
> entry as the stub, `log()` it as deferred, and note it in the final docs flip. Do NOT fabricate a
> data source.

---

## Task 8: Re-point the deep test at the real registry + full suite

- [ ] **Step 1** Remove the `jest.unstable_mockModule` for `operationalAlertEvaluators` from the deep
  test ONLY if you seed real breaching data for `inventory_intelligence` (the simplest real evaluator:
  insert a high-severity `clinical_ai_inventory_alerts` row, sweep, assert a bridged operational alert).
  Otherwise keep the controllable fake for the spine test and rely on the per-evaluator unit tests +
  one real-bridge deep case. Add that bridge case.
- [ ] **Step 2** Run the full relevant set:
  ```bash
  ... jest.js --runInBand operationalAlert operationalAlerts.deep
  ```
  Expected: all green.
- [ ] **Step 3** Commit.

---

## Task 9: Docs flip + full gates + ship

- [ ] **Step 1** In `docs/CLINICAL_AI_ENABLEMENT_PLAN.md`, flip forward-item **#5 "Ops forecasts → live
  alerts"** to a `✅ DONE (2026-06-18)` note: unified `clinical_ai_operational_alerts` stream + sweep +
  admin API, advisory/flag-gated, with the count of evaluators wired vs deferred.
- [ ] **Step 2** Full gates:
  ```bash
  cd apps/backend && npm run lint
  # deep + unit:
  DATABASE_URL='postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test' NODE_ENV=test \
    node -r dotenv/config --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand operationalAlert
  node scripts/check-schema-drift.mjs
  ```
- [ ] **Step 3** Ship per the default git workflow:
  ```bash
  git add docs/CLINICAL_AI_ENABLEMENT_PLAN.md && git commit -m "docs(ai): flip enablement #5 — ops forecast alerts shipped"
  git checkout main && git merge --no-ff feat/operational-alerts \
    -m "Merge feat/operational-alerts: unified operational forecast alert stream (enablement #5)"
  git push github main && git push origin main
  git branch -d feat/operational-alerts
  ```

---

## Verification checklist (run after Task 9)

- [ ] `npm run lint` clean.
- [ ] `operationalAlertReconcile` unit: 5/5.
- [ ] `operationalAlertEvaluators` unit: one per wired evaluator.
- [ ] `operationalAlerts.deep`: raise + dedup + auto-resolve + notify-once green.
- [ ] Schema drift clean; `315` recorded in `_migrations`.
- [ ] Sweep is a no-op when `CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED` unset and when all source modules disabled.
- [ ] No auto-action code path exists (advisory only); every alert carries the decision-support disclaimer in `safety_flags`/`metadata`.
