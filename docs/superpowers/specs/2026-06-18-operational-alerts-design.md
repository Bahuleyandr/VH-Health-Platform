# Operational Forecast Alerts — Design

**Date:** 2026-06-18
**Status:** Approved (brainstorming complete)
**Source:** Forward-roadmap item #5 of `docs/CLINICAL_AI_ENABLEMENT_PLAN.md` — "Ops forecasts → live alerts".

## Goal

Promote the existing Wave-7 / Tier-H operational **forecast** modules from compute-on-demand
scores into a single **live, reviewable, forward-looking alert stream** that a duty officer /
operational owner monitors. Advisory only — the system surfaces predicted operational risk; it
never auto-acts (no auto-ordering, staffing change, diversion, or transfer).

## Context (verified against `main`)

- The platform already has two "operational AI output as a reviewable row" precedents that share
  one column shape (severity · signals · summary · recommended_actions · source_citations ·
  safety_flags · a `pending→accepted/deferred/rejected/edited` reviewer lifecycle · retention):
  - `clinical_ai_command_center_snapshots` (mig 066) — hospital-wide **current-state** snapshot
    (`hospitalCommandCenterService.js`).
  - `clinical_ai_inventory_alerts` (mig 059) — per-item operational alert; `inventory_intelligence`
    is the one forecast module that already persists alerts.
- The ~13 Wave-7 forecast modules (`operationalAiService.js`, `acuityStaffingForecastService.js`,
  etc.) mostly compute-and-return on demand. There is **no unified forward-looking alert stream**.
- This feature adds that stream. It is **net-new alerting code**; the existing forecast services are
  treated as stable inputs and are **not modified**.

## Decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Where alerts live | **Unified `clinical_ai_operational_alerts` table** — one reviewable forward-risk stream |
| 2 | v1 coverage | **All ~13 Wave-7 modules.** Per-entity modules (no-show, OT case-time) aggregate to hospital-level alerts, not one row per appointment/case. The compose meta `discharge_summary_compose` is excluded (not a forecast). |
| 3 | Lifecycle | **Auto-resolve + keep history.** `system_status` (active/resolved/superseded) distinct from human `reviewer_decision`; dedup key (module + scope) upserts on re-sweep; cleared risks auto-resolve with a reason; rows retained for audit/trend. |
| 4 | Notifications | **Push high/critical + publish events.** New/escalated high/critical → `notificationOutbox` to the owner role + `clinical_ai.operational_alert_raised` event. Low/moderate stay queue-only. |
| 5 | Emitter architecture | **A — central orchestrator + per-module evaluator adapters.** One `operationalAlertService` owns the table + dedup/lifecycle/notify; a scheduled sweep walks a registry of thin adapters that wrap the existing forecast services and return normalized `AlertCandidate`s. |

Defaulted (approved): 30-min sweep cadence (configurable); feature **off by default** behind
`CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED`; alerts gate **per source module** (no new meta module);
the alert row is the system of record (`generation_id` optional, set only when an AI narrative is
generated).

## Architecture

```
scheduler (withJobLock, 30-min)            manual: POST /run-sweep
                \                          /
                 v                        v
            operationalAlertService.runSweep({ tenantId })
                 |
                 |  for each registered evaluator whose SOURCE module is enabled:
                 v
        operationalAlertEvaluators  ──calls──>  existing forecast services (UNCHANGED)
         (13 thin adapters)                     operationalAiService, acuityStaffingForecastService,
                 |                               inventory_intelligence, blood/bed/OT/biomed/...
                 v  AlertCandidate[]
            reconcile(candidates, openAlerts)
                 |   new → insert(active) [+notify if high/critical]
                 |   existing → upsert(update severity/metrics/last_evaluated_at) [+notify if escalated]
                 |   active-but-absent → auto-resolve(resolved_reason='forecast_cleared')
                 v
        clinical_ai_operational_alerts  ──(high/critical)──> notificationOutbox + publishEvent
                 ^
                 |  GET list / POST :id/decision (admin control-plane)
            admin + ops-owner roles, adminIpAllowlist, tenant-scoped
```

Clean split: **forecasting** (existing services, untouched) vs **alerting** (this feature). All
cross-cutting logic (dedup, lifecycle, severity, notify, event) lives in exactly one place.

## Component 1 — Data model: `clinical_ai_operational_alerts`

New migration `src/migrations/NNN_operational_alerts.sql` (next free number at implementation time).

```sql
CREATE TABLE IF NOT EXISTS clinical_ai_operational_alerts (
  id                 SERIAL PRIMARY KEY,
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- identity / routing
  module_key         VARCHAR(80)  NOT NULL,          -- source forecast module, e.g. 'pharmacy_stockout_predictor'
  domain             VARCHAR(40)  NOT NULL,          -- pharmacy|beds|blood_bank|staffing|ot|biomed|procurement|housekeeping|opd|inventory
  owner_role         VARCHAR(40),                    -- routing target role, e.g. 'PHARMACY_INCHARGE'
  scope_key          VARCHAR(200) NOT NULL,          -- dedup identity within (tenant, module): SKU/ward/blood_group/date
  scope_label        VARCHAR(200),                   -- human label
  horizon            VARCHAR(40),                    -- 'tonight'|'24h'|'72h'|'7d'|ISO date
  predicted_for      TIMESTAMPTZ,                    -- when the predicted window/event is

  -- assessment (rules-authoritative)
  alert_category     VARCHAR(60)  NOT NULL DEFAULT 'unknown',  -- stockout_risk|staffing_gap|bed_crunch|blood_shortage|...
  severity           VARCHAR(20)  NOT NULL DEFAULT 'low'
                       CHECK (severity IN ('low','moderate','high','critical','unknown')),
  metrics            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {predicted_value, threshold, confidence, ...}
  signals            JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary            TEXT,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_citations   JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_flags       JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_id      INTEGER REFERENCES clinical_ai_generations(id) ON DELETE SET NULL,

  -- lifecycle (system) — distinct from reviewer_decision (human)
  system_status      VARCHAR(20)  NOT NULL DEFAULT 'active'   -- v1 writes only active|resolved; 'superseded' reserved
                       CHECK (system_status IN ('active','resolved','superseded')),
  reviewer_decision  VARCHAR(30)  NOT NULL DEFAULT 'pending'
                       CHECK (reviewer_decision IN ('pending','accepted','deferred','rejected','edited')),
  reviewed_by        UUID,
  reviewed_at        TIMESTAMPTZ,
  reviewer_note      TEXT,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_evaluated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ,
  resolved_reason    TEXT,
  notified_at        TIMESTAMPTZ,                    -- high/critical notify dedup

  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retention_until    DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '1095 days')
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
```

RLS: add a `tenant_isolation` policy mirroring the other PHI/operational tables (see the RLS
migration pattern). The table holds no direct PHI (operational aggregates), but tenant isolation is
mandatory. `prisma/schema.prisma` regenerated via `prisma db pull` after the migration; the two
commit together (per backend CLAUDE.md "raw SQL migrations are source of truth").

## Component 2 — Evaluator contract + registry

`src/services/ai/operationalAlertEvaluators.js` (or a directory of one file per evaluator if it
grows large).

```js
/** @typedef {{
 *   module_key: string, domain: string, owner_role: string|null,
 *   scope_key: string, scope_label?: string, horizon?: string, predicted_for?: Date|null,
 *   alert_category: string, severity: 'low'|'moderate'|'high'|'critical',
 *   metrics?: object, signals?: object[], summary?: string,
 *   recommended_actions?: string[], source_citations?: object[]
 * }} AlertCandidate */

/** Evaluator: wraps ONE existing forecast service. Pure w.r.t. the alert table —
 *  returns candidates only; the orchestrator owns persistence/lifecycle. */
// async evaluate({ tenantId, now }) => AlertCandidate[]

export const OPERATIONAL_ALERT_EVALUATORS = [
  { module_key: 'pharmacy_stockout_predictor', domain: 'pharmacy',  owner_role: 'PHARMACY_INCHARGE', evaluate },
  { module_key: 'blood_bank_demand_forecast',  domain: 'blood_bank',owner_role: 'BLOOD_BANK_INCHARGE', evaluate },
  { module_key: 'bed_discharge_forecast',      domain: 'beds',      owner_role: 'BED_MANAGER', evaluate },
  { module_key: 'housekeeping_bed_turnover',   domain: 'housekeeping', owner_role: 'HOUSEKEEPING_INCHARGE', evaluate },
  { module_key: 'acuity_staffing_forecast',    domain: 'staffing',  owner_role: 'NURSING_SUPERVISOR', evaluate },
  { module_key: 'staff_roster_optimizer',      domain: 'staffing',  owner_role: 'HR_INCHARGE', evaluate },
  { module_key: 'staff_burnout_workload_risk', domain: 'staffing',  owner_role: 'HR_INCHARGE', evaluate },
  { module_key: 'ot_case_time_predictor',      domain: 'ot',        owner_role: 'OT_INCHARGE', evaluate },   // aggregate → list overrun risk
  { module_key: 'ot_block_scheduling',         domain: 'ot',        owner_role: 'OT_INCHARGE', evaluate },
  { module_key: 'appointment_no_show_predictor', domain: 'opd',     owner_role: 'OPD_MANAGER', evaluate },   // aggregate → clinic/day load
  { module_key: 'biomed_device_maintenance',   domain: 'biomed',    owner_role: 'BIOMED_INCHARGE', evaluate },
  { module_key: 'inventory_intelligence',      domain: 'inventory', owner_role: 'MATERIALS_MANAGER', evaluate }, // bridges existing inventory_alerts
  { module_key: 'procurement_negotiation_assistant', domain: 'procurement', owner_role: 'PROCUREMENT_INCHARGE', evaluate },
];
```

- Each `evaluate` runs its source service over the relevant population, applies a **deterministic
  threshold**, and returns candidates only for breaching items.
- **Aggregation rule** for per-entity modules: `appointment_no_show_predictor` and
  `ot_case_time_predictor` roll up to a hospital-level candidate (e.g. "elevated predicted no-show
  load for tomorrow's OPD: N high-risk of M booked" / "OT list overrun risk: predicted +X min over
  block"), not one candidate per appointment/case.
- `owner_role` values are placeholders to be confirmed against `roleHelpers`/the role registry at
  implementation time; an unknown role degrades to the duty-officer/admin queue (still listed, just
  no targeted push).

## Component 3 — Orchestrator + sweep: `operationalAlertService.js`

Public API:
- `runSweep({ tenantId, moduleKeys = null, now = new Date() }) → { evaluated, raised, escalated, resolved, errors }`
- `listOperationalAlerts({ tenantId, domain?, severity?, systemStatus?, reviewerDecision?, limit })`
- `decideOperationalAlert({ tenantId, alertId, decision, reviewerUid, note })`

`runSweep` algorithm:
1. For each registered evaluator: gate on `getClinicalAiModule(module_key, { tenantId }).enabled`;
   skip if disabled. Each evaluator call wrapped in try/catch → on error, record in `errors[]` and
   continue (one module never aborts the sweep — Phase 1.5 best-effort per backend CLAUDE.md).
2. Collect `candidates` (per module).
3. Load current `active` alerts for this `(tenant, module_key)`.
4. **Reconcile** per module:
   - candidate with no active row → `INSERT` (system_status='active', first/last_evaluated_at=now);
     if severity ∈ {high, critical} → notify + event + set `notified_at`.
   - candidate matching an active row (by `scope_key`) → `UPDATE` severity/metrics/signals/summary/
     recommended_actions/`last_evaluated_at`; if severity escalated into {high, critical} and
     `notified_at IS NULL` → notify + event + set `notified_at`.
   - active row with **no** matching candidate → auto-resolve: `system_status='resolved'`,
     `resolved_at=now`, `resolved_reason='forecast_cleared'`.
5. The reconcile is two writes, both under `setTenant(tenantId, …)` for RLS scope: (a) **present
   candidates** are upserted via the partial unique index
   (`INSERT … ON CONFLICT (tenant_id, module_key, scope_key) WHERE system_status='active' DO UPDATE`),
   which atomically handles the insert-vs-update race; (b) the **auto-resolve set** — active rows
   from the step-3 load whose `scope_key` is absent from this run's candidates — is closed in one
   `UPDATE … SET system_status='resolved'`. Notify decisions are derived from the upsert's
   inserted/severity-changed result.
6. Return counts.

Scheduler: register `operational-alert-sweep` in the existing scheduler under `withJobLock`,
default `*/30 * * * *`, **only when `CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED` is truthy**. Iterates
active tenants (default tenant today).

Notify helper: `notificationOutbox.queue()` targeting `owner_role` (fallback duty-officer/admin) +
`publishEvent({ eventType: 'clinical_ai.operational_alert_raised', aggregateType:
'clinical_ai_operational_alert', aggregateId: alert.id, payload: { module_key, domain, severity,
scope_label, horizon, predicted_for } })`. Both best-effort (logged, never block the sweep).

## Component 4 — API (admin control-plane)

Mounted under the existing admin clinical-AI routes (admin RBAC + `adminIpAllowlist`, tenant-scoped):

- `GET  /api/v1/admin/clinical-ai/operational-alerts` — filters `domain`, `severity`,
  `system_status`, `reviewer_decision`; ordered crisis-first then `last_evaluated_at DESC`.
- `POST /api/v1/admin/clinical-ai/operational-alerts/:id/decision` — body `{ decision, note }`;
  sets `reviewer_decision` + `reviewed_by/at/note` (decision is independent of `system_status`).
- `POST /api/v1/admin/clinical-ai/operational-alerts/run-sweep` — manual trigger (admin only).

All responses via `success()/error()`; controllers thin; logic in `operationalAlertService`.

## Component 5 — Governance / safety

- **Advisory-only:** every alert carries a `decision_support_only` safety flag + disclaimer; no code
  path auto-acts. Mirrors the command-center "review-only" stance.
- **Rules-authoritative:** `severity` and `alert_category` come from deterministic thresholds in the
  evaluators. Any optional AI narrative enriches `summary` only and never overrides severity/category
  (same guarantee `hospitalCommandCenterService` applies).
- **Enable gate:** an evaluator runs only if its source module is enabled — enablement stays governed
  by the existing 3-layer model (`clinical_ai_tenant_modules`). Plus the `CLINICAL_AI_OPERATIONAL_
  ALERTS_ENABLED` master flag and `withJobLock` for the cron.
- **Tenant isolation:** `tenant_id NOT NULL`, RLS policy, `setTenant` for writes.
- **Env:** add `CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED` to `.env.example` + `validateEnv.js`
  (warn-not-crash; default off).

## Component 6 — Testing

- **Unit** (`src/tests/unit/operationalAlertReconcile.test.js`): the reconcile logic with mocked
  evaluators — new→insert, unchanged→upsert-no-duplicate + `last_evaluated_at` bumped,
  cleared→auto-resolve, escalation→notify-once, disabled-module→skipped. Plus 1-2 evaluator
  threshold→candidate mappings with a mocked forecast service.
- **Deep / real-PG** (`src/tests/operationalAlerts.deep.test.js`, QA cluster): seed data that trips
  ≥2 modules → `runSweep` asserts active rows with correct severity + dedup unique index holds;
  re-run same → no new rows, `last_evaluated_at` advanced; re-run cleared → rows auto-resolved;
  high/critical → `notified_at` set once + event emitted; disabled module → no rows.
- **Gates:** `npm run lint` (eslint + raw-params + phi-tenant-id + secrets) and the deep test on the
  QA cluster (`DATABASE_URL=…55432/vhhealth_test`). Regenerate `schema.prisma` + drift check.

## Non-goals / out of scope (v1)

- No staff/patient mobile surface (admin control-plane only; a Flutter ops view is a later wave).
- No auto-action of any kind (ordering, staffing, diversion, transfer) — advisory only, permanently.
- No new forecasting/ML — evaluators wrap the existing forecast services unchanged.
- `discharge_summary_compose` (a compose meta in the Wave-7 row) is not a forecast → excluded.
- Multi-tenant fan-out beyond the default tenant is supported by the schema but not exercised until
  the platform goes multi-tenant.

## File inventory

| Path | Create/Modify | Responsibility |
|---|---|---|
| `src/migrations/NNN_operational_alerts.sql` | Create | table + indexes + RLS policy + (no module seed) |
| `prisma/schema.prisma` | Modify (db pull) | regenerated model |
| `src/services/ai/operationalAlertEvaluators.js` | Create | 13 adapter `evaluate()` fns + registry |
| `src/services/ai/operationalAlertService.js` | Create | table I/O, reconcile, lifecycle, notify, list/decide, runSweep |
| `src/jobs/` or existing scheduler | Modify | register `operational-alert-sweep` cron (flag-gated, withJobLock) |
| `src/controllers/.../operationalAlertController.js` | Create | thin controllers |
| `src/routes/.../` (admin clinical-ai) | Modify | mount 3 routes |
| `.env.example`, `src/utils/validateEnv.js` | Modify | `CLINICAL_AI_OPERATIONAL_ALERTS_ENABLED` |
| `src/tests/unit/operationalAlertReconcile.test.js` | Create | unit |
| `src/tests/operationalAlerts.deep.test.js` | Create | real-PG integration |
| `docs/CLINICAL_AI_ENABLEMENT_PLAN.md` | Modify | flip forward-item #5 status |
