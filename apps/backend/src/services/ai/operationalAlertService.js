// src/services/ai/operationalAlertService.js
import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { OPERATIONAL_ALERT_EVALUATORS } from './operationalAlertEvaluators.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';

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
 * @returns {{toInsert:object[], toUpdate:object[], toResolve:object[], toNotify:object[]}}
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
      // Role-addressed intent row using the REAL notificationOutbox contract
      // (recipientId/title/body/data). recipient_id is null — a role-fanout
      // notifier resolves `data.notify_role`, the same pattern
      // escalationEngineService uses for role notifications. The durable
      // surfacing is the event below + the admin alert list.
      await notificationOutbox.queue({
        type: 'push',
        title: `Operational alert (${c.severity}): ${c.domain}`,
        body: c.summary || `${c.scope_label || c.scope_key} — ${c.alert_category}`,
        data: {
          kind: 'operational_alert', notify_role: c.owner_role, module_key: c.module_key,
          domain: c.domain, severity: c.severity, scope_label: c.scope_label || c.scope_key,
          horizon: c.horizon || null,
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
  } catch (err) {
    logger.warn('operational alert notify failed', { error: err?.message, module_key: c.module_key });
  }
  // Stamp notified_at independently so a missing outbox/event store doesn't lose the dedup mark.
  try {
    await prisma.$queryRawUnsafe(
      `UPDATE clinical_ai_operational_alerts SET notified_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND tenant_id=$2::uuid`, alertId, tenantId,
    );
  } catch (err) {
    logger.warn('operational alert notify stamp failed', { error: err?.message });
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
    } catch (err) {
      logger.warn('operational module gate lookup failed', { module_key: evaluator.module_key, error: err?.message });
      module = { enabled: false };
    }
    if (!module?.enabled) continue;

    summary.evaluated += 1;
    let candidates = [];
    try {
      candidates = (await evaluator.evaluate({ tenantId: tid, now })) || [];
    } catch (err) {
      summary.errors.push({ module_key: evaluator.module_key, error: err?.message });
      logger.warn('operational evaluator failed', { module_key: evaluator.module_key, error: err?.message });
      continue;
    }

    const open = await loadOpenAlerts(tid, evaluator.module_key);
    const { toInsert, toUpdate, toResolve, toNotify } = reconcile(open, candidates);

    // Collect upserted ids so the notify pass reuses them (no re-SELECT). The
    // whole write+notify body is fault-isolated per evaluator: a DB error on one
    // module records into summary.errors and continues — it never aborts the
    // sweep for the remaining modules.
    const upsertedIds = new Map(); // scope_key → id
    try {
      await setTenant(tid, async () => {
        for (const c of [...toInsert, ...toUpdate.map((u) => u.candidate)]) {
          const id = await upsertCandidate(tid, c);
          if (id != null) upsertedIds.set(c.scope_key, id);
        }
        for (const a of toResolve) { await resolveAlert(tid, a.id); summary.resolved += 1; }
      });

      for (const c of toNotify) {
        const alertId = upsertedIds.get(c.scope_key);
        if (alertId) { await notifyAndStamp(tid, c, alertId); summary.raised += 1; }
      }
    } catch (err) {
      summary.errors.push({ module_key: evaluator.module_key, error: err?.message });
      logger.warn('operational alert write/notify pass failed', { module_key: evaluator.module_key, error: err?.message });
      continue;
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
