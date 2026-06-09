/**
 * Helpers for the encounter-start + encounter-discharge CDS Hooks
 * (Phase D2). Pure read-only assemblers — they pull from the existing
 * cdsEngine + clinical_ai_workflow_runs + tasks + follow_up_plans
 * substrate and shape the result into the alert-array shape that
 * cdsHooksAdapter already knows how to translate.
 *
 * Decision-support only: nothing here mutates state. The hooks are
 * fired by a third-party EHR's CDS Hooks client (or VH Health's own
 * staff app); cards are advisory.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { getActiveAlerts, getProtocolReminders } from '../emr/cdsEngine.js';
import { getUnifiedActiveAllergies } from '../clinical/allergySourceService.js';

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

/**
 * Build an alert array for encounter-start: combine
 *   - active patient alerts (from cds_alerts)
 *   - protocol reminders for the patient/encounter
 *   - patient allergies on file
 *   - critical/urgent open follow-up plans
 *   - high-priority open tasks for this patient
 */
export async function buildEncounterStartAlerts({ patientUid, encounterId = null }) {
  if (!patientUid) return [];
  const alerts = [];

  // 1. Active alerts (from cdsEngine)
  try {
    const active = await getActiveAlerts(patientUid);
    for (const alert of active) {
      alerts.push({
        type: alert.alert_type,
        severity: alert.severity,
        title: alert.title,
        description: alert.description,
        canOverride: !alert.acknowledged,
        sourceData: alert.source_data || null,
      });
    }
  } catch (err) {
    logger.warn('encounter-start active-alerts fetch failed', { error: err.message });
  }

  // 2. Protocol reminders
  try {
    const reminders = await getProtocolReminders(patientUid, encounterId);
    alerts.push(...(reminders || []));
  } catch (err) {
    logger.warn('encounter-start protocol-reminders fetch failed', { error: err.message });
  }

  // 3. Allergies on file (informational card)
  //
  // Roadmap A10: this used to `SELECT allergen FROM patient_allergies` —
  // but that table's column is allergy_name, so the query 42703'd on every
  // call and the missing-schema guard swallowed it: the allergy card NEVER
  // rendered (verified against the QA schema 2026-06-10). The unified
  // service reads all four allergy stores and never throws.
  try {
    const allergyRows = await getUnifiedActiveAllergies(prisma, { patientUid });
    if (allergyRows.length > 0) {
      alerts.push({
        type: 'allergies_on_file',
        severity: 'info',
        title: `${allergyRows.length} allergy/allergies on file`,
        description: allergyRows.map((a) => `${a.allergen}${a.severity ? ` (${a.severity})` : ''}`).join('; '),
        canOverride: true,
        sourceData: {
          allergy_count: allergyRows.length,
          allergens: allergyRows.map((a) => a.allergen),
          sources: [...new Set(allergyRows.flatMap((a) => a.sources || []))],
        },
      });
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('encounter-start allergies fetch failed', { error: err.message });
    }
  }

  // 4. Open follow-up plans (overdue or due-soon)
  try {
    const followups = await prisma.$queryRawUnsafe(
      `SELECT id, origin_kind, due_at, reason
       FROM follow_up_plans
       WHERE patient_uid = $1::uuid AND status IN ('open', 'overdue')
       ORDER BY due_at NULLS LAST, created_at DESC
       LIMIT 5`,
      patientUid,
    );
    for (const fu of followups) {
      const overdue = fu.due_at && new Date(fu.due_at).getTime() < Date.now();
      alerts.push({
        type: 'follow_up_plan_due',
        severity: overdue ? 'warning' : 'info',
        title: overdue ? 'Follow-up plan overdue' : 'Follow-up plan due',
        description: `${fu.origin_kind} follow-up: ${fu.reason || 'no reason recorded'}`,
        canOverride: true,
        sourceData: { follow_up_id: fu.id, origin_kind: fu.origin_kind, due_at: fu.due_at },
      });
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('encounter-start follow-ups fetch failed', { error: err.message });
    }
  }

  // 5. Open high-priority tasks
  try {
    const tasks = await prisma.$queryRawUnsafe(
      `SELECT id, title, priority, due_at, task_kind
       FROM tasks
       WHERE patient_uid = $1::uuid
         AND status IN ('open', 'in_progress', 'blocked', 'overdue')
         AND priority IN ('high', 'critical')
       ORDER BY priority DESC, due_at NULLS LAST
       LIMIT 5`,
      patientUid,
    );
    for (const task of tasks) {
      alerts.push({
        type: 'open_task_high_priority',
        severity: task.priority === 'critical' ? 'critical' : 'warning',
        title: `Open task: ${task.title}`,
        description: `${task.task_kind} task, priority=${task.priority}${task.due_at ? ` due ${new Date(task.due_at).toISOString()}` : ''}`,
        canOverride: true,
        sourceData: { task_id: task.id, priority: task.priority, due_at: task.due_at },
      });
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('encounter-start tasks fetch failed', { error: err.message });
    }
  }

  return alerts;
}

/**
 * Build an alert array for encounter-discharge (CDS Hooks v1.0 hook id
 * is "encounter-discharge"). Pre-discharge readiness checks:
 *   - unsigned orders
 *   - pending follow-up plans without an appointment
 *   - missing discharge summary (active admission with no signed
 *     discharge_summary clinical_ai_review)
 *   - unacknowledged critical CDS alerts
 *   - active CarePlan goals not yet achieved
 */
export async function buildEncounterDischargeAlerts({ patientUid, encounterId = null }) {
  if (!patientUid) return [];
  const alerts = [];

  // 1. Unsigned orders for this patient
  try {
    const unsigned = await prisma.$queryRawUnsafe(
      `SELECT id, status, order_type
       FROM clinical_orders
       WHERE patient_uid = $1::uuid AND status IN ('draft', 'pending_signature')
       LIMIT 20`,
      patientUid,
    );
    if (unsigned.length > 0) {
      alerts.push({
        type: 'unsigned_orders',
        severity: 'warning',
        title: `${unsigned.length} unsigned order(s) before discharge`,
        description: unsigned.map((o) => `${o.order_type} (#${o.id}, ${o.status})`).join('; '),
        canOverride: true,
        sourceData: { unsigned_order_count: unsigned.length, order_ids: unsigned.map((o) => o.id) },
      });
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('encounter-discharge unsigned-orders fetch failed', { error: err.message });
    }
  }

  // 2. Open follow-ups without an appointment scheduled
  try {
    const followups = await prisma.$queryRawUnsafe(
      `SELECT id, origin_kind, reason
       FROM follow_up_plans
       WHERE patient_uid = $1::uuid AND status = 'open' AND appointment_id IS NULL
       LIMIT 10`,
      patientUid,
    );
    if (followups.length > 0) {
      alerts.push({
        type: 'follow_up_unscheduled',
        severity: 'warning',
        title: `${followups.length} follow-up plan(s) without appointment`,
        description: followups.map((f) => `${f.origin_kind}: ${f.reason || 'no reason'}`).join('; '),
        canOverride: true,
        sourceData: { follow_up_ids: followups.map((f) => f.id) },
      });
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('encounter-discharge follow-ups fetch failed', { error: err.message });
    }
  }

  // 3. Active CarePlan goals not yet achieved
  try {
    const goals = await prisma.$queryRawUnsafe(
      `SELECT cpg.id, cpg.description, cpg.priority
       FROM care_plan_goals cpg
       JOIN care_plans cp ON cp.id = cpg.care_plan_id
       WHERE cp.patient_uid = $1::uuid AND cp.status = 'active'
         AND cpg.status IN ('planned', 'in_progress')
       LIMIT 10`,
      patientUid,
    );
    if (goals.length > 0) {
      alerts.push({
        type: 'unachieved_care_goals',
        severity: 'info',
        title: `${goals.length} active care-plan goal(s) outstanding`,
        description: goals.slice(0, 3).map((g) => g.description).join('; '),
        canOverride: true,
        sourceData: { goal_ids: goals.map((g) => g.id) },
      });
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('encounter-discharge care-goals fetch failed', { error: err.message });
    }
  }

  // 4. Unacknowledged critical alerts
  try {
    const active = await getActiveAlerts(patientUid);
    const critical = active.filter((a) => String(a.severity).toLowerCase() === 'critical' && !a.acknowledged);
    for (const alert of critical) {
      alerts.push({
        type: alert.alert_type,
        severity: 'critical',
        title: `Unacknowledged critical: ${alert.title}`,
        description: alert.description,
        canOverride: false,
        sourceData: alert.source_data || null,
      });
    }
  } catch (err) {
    logger.warn('encounter-discharge critical-alerts fetch failed', { error: err.message });
  }

  // 5. Missing discharge summary signal: there is no signed discharge
  //    summary review for this admission yet.
  if (encounterId) {
    try {
      const summaries = await prisma.$queryRawUnsafe(
        `SELECT r.id, r.decision
         FROM clinical_ai_reviews r
         WHERE r.patient_uid = $1::uuid
           AND r.module_key = 'discharge_summary'
           AND r.decision IN ('accepted', 'edited')
         LIMIT 1`,
        patientUid,
      );
      if (summaries.length === 0) {
        alerts.push({
          type: 'missing_discharge_summary',
          severity: 'warning',
          title: 'No signed discharge summary',
          description: 'No accepted clinical_ai_review for module=discharge_summary; clinician should generate or write one before discharging.',
          canOverride: true,
          sourceData: { encounter_id: encounterId },
        });
      }
    } catch (err) {
      if (!isMissingSchemaError(err)) {
        logger.warn('encounter-discharge summary-check failed', { error: err.message });
      }
    }
  }

  return alerts;
}

export default {
  buildEncounterStartAlerts,
  buildEncounterDischargeAlerts,
};
