// Operational bridge for the canonical clinical platform.
//
// These helpers keep existing feature tables as the source detail tables
// while ensuring pharmacy, housekeeping, discharge, and alert workflows emit
// normalized timeline, audit, and SLA events.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  completeWorkflowSla,
  recordCanonicalClinicalEvent,
  startWorkflowSla,
} from './canonicalClinicalPlatformService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dbClient(db) {
  return db || prisma;
}

function cleanUuid(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

function cleanText(value, fallback = null) {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

function normalizeStatus(value) {
  return cleanText(value)?.toLowerCase() || null;
}

function eventTimestampKey(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return String(value);
}

async function safeCanonical(label, task) {
  try {
    return await task();
  } catch (err) {
    logger.warn(`Canonical operational bridge skipped ${label}`, {
      error: err?.message || String(err),
    });
    return null;
  }
}

async function resolvePatientUidFromUserId(db, patientId) {
  const id = Number.parseInt(String(patientId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return safeCanonical('patient uid lookup', async () => {
    const rows = await db.$queryRawUnsafe(
      'SELECT uid FROM users WHERE id = $1::int LIMIT 1',
      id,
    );
    return cleanUuid(rows[0]?.uid);
  });
}

async function resolvePatientUidForOrder(db, order = {}) {
  return cleanUuid(order.patient_uid || order.patientUid)
    || resolvePatientUidFromUserId(db, order.patient_id || order.patientId);
}

async function resolveInvestigationForLabAlert(db, alert = {}) {
  const resultId = Number.parseInt(String(alert.result_id || alert.resultId || ''), 10);
  if (!Number.isInteger(resultId) || resultId <= 0) return null;
  return safeCanonical('critical result investigation lookup', async () => {
    const rows = await db.$queryRawUnsafe(
      `SELECT lr.investigation_id,
              lr.patient_uid,
              lr.test_name,
              lr.tenant_id
         FROM lab_results lr
        WHERE lr.id = $1::int
        LIMIT 1`,
      resultId,
    );
    return rows[0] || null;
  });
}

// Terminate the open results-inbox task for a given result resource on
// acknowledgement, so the ack closes the accountable task (audit C-3) and the
// escalation engine's backfill won't re-create one (it skips resources that
// already have a terminal task). Best-effort + never-throws + idempotent: it
// only flips a task still in an open/in_progress/blocked/overdue state, stamps
// the terminal SLA-completion marker, and is a no-op when no such task exists.
// An explicit tenant_id predicate keeps it correct whether run on the singleton
// (GUC unset → mig-075 permissive) or a tenant-scoped tx.
async function completeOpenResultTask({
  db = null,
  tenantId = null,
  resourceType,
  resourceId,
  actorUid = null,
} = {}) {
  const client = dbClient(db);
  const tid = cleanUuid(tenantId);
  const type = cleanText(resourceType);
  const id = cleanText(resourceId);
  if (!tid || !type || !id) return null;
  return safeCanonical('results-inbox task completion on ack', async () => {
    const rows = await client.$queryRawUnsafe(
      `UPDATE tasks
          SET status = 'completed',
              completed_at = NOW(),
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object('completed_via', 'critical_result_ack'::text)
                || CASE WHEN $4::text IS NOT NULL
                        THEN jsonb_build_object('acknowledged_by', $4::text)
                        ELSE '{}'::jsonb END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND related_resource_type = $2
          AND related_resource_id = $3
          AND status IN ('open', 'in_progress', 'blocked', 'overdue')
        RETURNING id`,
      tid,
      type,
      id,
      actorUid ? String(actorUid) : null,
    );
    return rows[0] || null;
  });
}

export async function emitPharmacyOrderEvent({
  db = null,
  order = {},
  actorUid = null,
  actorRole = null,
  eventType = 'pharmacy.order_updated',
  eventStatus = null,
  previousStatus = null,
  summary = null,
  payload = {},
} = {}) {
  const client = dbClient(db);
  const orderId = order?.id;
  if (!orderId) return null;

  return safeCanonical(`pharmacy order ${eventType}`, async () => {
    const patientUid = await resolvePatientUidForOrder(client, order);
    const status = eventStatus || order.status || null;
    const stamp = eventTimestampKey(order.updated_at || order.dispensed_at || order.delivered_at || order.created_at)
      || Date.now();
    return recordCanonicalClinicalEvent({
      tenantId: order.tenant_id,
      patientUid,
      eventType,
      eventStatus: status,
      sourceTable: 'pharmacy_orders',
      sourceId: String(orderId),
      sourceUid: order.uid,
      resourceType: 'pharmacy_order',
      resourceId: String(orderId),
      actorUid,
      actorRole,
      summary: summary || `Pharmacy order ${status || 'updated'}`,
      payload: {
        order_id: orderId,
        order_uid: order.uid || null,
        order_number: order.order_number || null,
        patient_name: order.patient_name || null,
        previous_status: previousStatus || null,
        status: status || null,
        total_amount: order.total_amount ?? null,
        partial_dispense: order.partial_dispense ?? null,
        ...payload,
      },
      beforeState: previousStatus ? { status: previousStatus } : null,
      afterState: { status: status || null },
      tags: ['pharmacy'],
      timelineIdempotencyKey: `pharmacy_orders:${orderId}:${eventType}:${status || 'none'}:${stamp}`,
      auditIdempotencyKey: `pharmacy_orders:${orderId}:audit:${eventType}:${status || 'none'}:${stamp}`,
    }, { db: client });
  });
}

export async function emitHousekeepingRequestRaised({
  db = null,
  request = {},
  actorUid = null,
  actorRole = null,
  trigger = null,
  payload = {},
} = {}) {
  const client = dbClient(db);
  if (!request?.id) return null;

  return safeCanonical('housekeeping request raised', async () => {
    await recordCanonicalClinicalEvent({
      eventType: 'housekeeping.requested',
      eventStatus: request.status || 'open',
      sourceTable: 'housekeeping_requests',
      sourceId: String(request.id),
      resourceType: 'housekeeping_request',
      resourceId: String(request.id),
      actorUid,
      actorRole,
      summary: `Housekeeping request ${request.request_number || request.id} raised`,
      payload: {
        request_id: request.id,
        request_number: request.request_number || null,
        location_text: request.location_text || null,
        request_type: request.request_type || request.task_type || null,
        urgency: request.urgency || null,
        trigger,
        ...payload,
      },
      tags: ['housekeeping', 'bed_cleaning'],
      timelineIdempotencyKey: `housekeeping_requests:${request.id}:requested`,
      auditIdempotencyKey: `housekeeping_requests:${request.id}:audit:requested`,
    }, { db: client });

    return startWorkflowSla({
      ruleCode: 'bed_cleaning_turnaround',
      sourceTable: 'housekeeping_requests',
      sourceId: String(request.id),
      priority: request.urgency || 'high',
      assignedUserUid: request.assigned_to_uid || null,
      metadata: {
        request_number: request.request_number || null,
        bed_id: payload.bed_id || null,
        trigger,
      },
    }, { db: client });
  });
}

export async function emitHousekeepingRequestStatus({
  db = null,
  request = {},
  actorUid = null,
  actorRole = null,
  eventType = 'housekeeping.status_changed',
  previousStatus = null,
  payload = {},
} = {}) {
  const client = dbClient(db);
  if (!request?.id) return null;
  const status = normalizeStatus(request.status);
  const stamp = eventTimestampKey(request.completed_at || request.updated_at || request.created_at) || Date.now();

  return safeCanonical(`housekeeping request ${eventType}`, async () => {
    const event = await recordCanonicalClinicalEvent({
      eventType,
      eventStatus: status,
      sourceTable: 'housekeeping_requests',
      sourceId: String(request.id),
      resourceType: 'housekeeping_request',
      resourceId: String(request.id),
      actorUid,
      actorRole,
      summary: `Housekeeping request ${request.request_number || request.id} ${status || 'updated'}`,
      payload: {
        request_id: request.id,
        request_number: request.request_number || null,
        previous_status: previousStatus || null,
        status,
        request_type: request.request_type || request.task_type || null,
        ...payload,
      },
      beforeState: previousStatus ? { status: previousStatus } : null,
      afterState: { status },
      tags: ['housekeeping', 'bed_cleaning'],
      timelineIdempotencyKey: `housekeeping_requests:${request.id}:${eventType}:${status || 'none'}:${stamp}`,
      auditIdempotencyKey: `housekeeping_requests:${request.id}:audit:${eventType}:${status || 'none'}:${stamp}`,
    }, { db: client });

    if (['completed', 'verified', 'closed'].includes(status)) {
      await completeWorkflowSla({
        ruleCode: 'bed_cleaning_turnaround',
        sourceTable: 'housekeeping_requests',
        sourceId: String(request.id),
        metadata: {
          completed_status: status,
          completed_by: actorUid || null,
        },
      }, { db: client });
    }

    return event;
  });
}

export async function emitBedMarkedReady({
  db = null,
  bed = {},
  bedId = null,
  actorUid = null,
  actorRole = null,
  cleaningTicketId = null,
  cleanerId = null,
  notes = null,
} = {}) {
  const client = dbClient(db);
  const id = bed?.id || bedId;
  if (!id) return null;

  return safeCanonical('bed marked ready', async () => {
    await recordCanonicalClinicalEvent({
      eventType: 'bed.ready',
      eventStatus: 'available',
      sourceTable: 'beds',
      sourceId: String(id),
      resourceType: 'bed',
      resourceId: String(id),
      actorUid,
      actorRole,
      summary: `Bed ${bed?.bed_number || id} marked ready`,
      payload: {
        bed_id: id,
        bed_number: bed?.bed_number || null,
        ward_id: bed?.ward_id || null,
        cleaning_ticket_id: cleaningTicketId || null,
        cleaner_id: cleanerId || null,
        notes: notes || null,
      },
      tags: ['bed', 'housekeeping'],
      timelineIdempotencyKey: `beds:${id}:ready:${eventTimestampKey(bed?.updated_at) || Date.now()}`,
      auditIdempotencyKey: `beds:${id}:audit:ready:${eventTimestampKey(bed?.updated_at) || Date.now()}`,
    }, { db: client });

    if (cleaningTicketId) {
      return completeWorkflowSla({
        ruleCode: 'bed_cleaning_turnaround',
        sourceTable: 'housekeeping_requests',
        sourceId: String(cleaningTicketId),
        metadata: {
          bed_id: id,
          marked_ready_by: actorUid || null,
        },
      }, { db: client });
    }
    return null;
  });
}

export async function emitDischargeWorkflowOpened({
  db = null,
  admission = {},
  consults = [],
  actorUid = null,
  actorRole = null,
} = {}) {
  const client = dbClient(db);
  if (!admission?.id) return null;

  return safeCanonical('discharge workflow opened', async () => {
    await recordCanonicalClinicalEvent({
      tenantId: admission.tenant_id,
      patientUid: admission.patient_uid,
      encounterId: admission.encounter_id,
      eventType: 'discharge.workflow_opened',
      eventStatus: 'active',
      sourceTable: 'admissions',
      sourceId: String(admission.id),
      resourceType: 'admission',
      resourceId: String(admission.id),
      actorUid,
      actorRole,
      summary: `Discharge workflow opened for admission #${admission.id}`,
      payload: {
        admission_id: admission.id,
        consults_opened: consults.map((c) => c.consult_type),
      },
      tags: ['discharge'],
      timelineIdempotencyKey: `admissions:${admission.id}:discharge_workflow_opened`,
      auditIdempotencyKey: `admissions:${admission.id}:audit:discharge_workflow_opened`,
    }, { db: client });

    for (const consult of consults) {
      if (!consult?.id) continue;
      await startWorkflowSla({
        tenantId: consult.tenant_id || admission.tenant_id,
        ruleCode: 'discharge_blocker_clearance',
        patientUid: consult.patient_uid || admission.patient_uid,
        encounterId: admission.encounter_id,
        sourceTable: 'discharge_consults',
        sourceId: String(consult.id),
        priority: 'high',
        assignedRoleCodes: [],
        metadata: {
          admission_id: admission.id,
          consult_type: consult.consult_type,
        },
      }, { db: client });
    }
    return true;
  });
}

export async function emitDischargeWorkItemCompleted({
  db = null,
  consult = {},
  admission = {},
  actorUid = null,
  actorRole = null,
} = {}) {
  const client = dbClient(db);
  if (!consult?.id) return null;

  return safeCanonical('discharge work item completed', async () => {
    await recordCanonicalClinicalEvent({
      tenantId: consult.tenant_id || admission.tenant_id,
      patientUid: consult.patient_uid || admission.patient_uid,
      encounterId: admission.encounter_id,
      eventType: 'discharge.work_item_completed',
      eventSubtype: consult.consult_type,
      eventStatus: 'completed',
      sourceTable: 'discharge_consults',
      sourceId: String(consult.id),
      resourceType: 'discharge_consult',
      resourceId: String(consult.id),
      actorUid,
      actorRole,
      summary: `Discharge ${String(consult.consult_type || 'work item').replace(/_/g, ' ')} completed`,
      payload: {
        admission_id: consult.admission_id || admission.id || null,
        consult_type: consult.consult_type || null,
        notes: consult.notes || null,
      },
      tags: ['discharge'],
      timelineIdempotencyKey: `discharge_consults:${consult.id}:completed`,
      auditIdempotencyKey: `discharge_consults:${consult.id}:audit:completed`,
    }, { db: client });

    return completeWorkflowSla({
      tenantId: consult.tenant_id || admission.tenant_id,
      ruleCode: 'discharge_blocker_clearance',
      sourceTable: 'discharge_consults',
      sourceId: String(consult.id),
      metadata: {
        consult_type: consult.consult_type || null,
        completed_by: actorUid || null,
      },
    }, { db: client });
  });
}

export async function emitDischargeDrugsDispensed({
  db = null,
  admission = {},
  actorUid = null,
  actorRole = null,
} = {}) {
  const client = dbClient(db);
  if (!admission?.id) return null;

  return safeCanonical('discharge drugs dispensed', async () =>
    recordCanonicalClinicalEvent({
      tenantId: admission.tenant_id,
      patientUid: admission.patient_uid,
      encounterId: admission.encounter_id,
      eventType: 'discharge.drugs_dispensed',
      eventStatus: 'completed',
      sourceTable: 'admissions',
      sourceId: String(admission.id),
      resourceType: 'admission',
      resourceId: String(admission.id),
      actorUid,
      actorRole,
      summary: `Discharge medicines dispensed for admission #${admission.id}`,
      payload: {
        admission_id: admission.id,
        discharge_drugs_dispensed_at: admission.discharge_drugs_dispensed_at || null,
      },
      tags: ['discharge', 'pharmacy'],
      timelineIdempotencyKey: `admissions:${admission.id}:discharge_drugs_dispensed`,
      auditIdempotencyKey: `admissions:${admission.id}:audit:discharge_drugs_dispensed`,
    }, { db: client }));
}

export async function emitFinalDischargeCompleted({
  db = null,
  admission = {},
  actorUid = null,
  actorRole = null,
  payload = {},
} = {}) {
  const client = dbClient(db);
  if (!admission?.id) return null;

  return safeCanonical('final discharge completed', async () =>
    recordCanonicalClinicalEvent({
      tenantId: admission.tenant_id,
      patientUid: admission.patient_uid,
      encounterId: admission.encounter_id,
      eventType: 'discharge.completed',
      eventStatus: admission.status || 'discharged',
      sourceTable: 'admissions',
      sourceId: String(admission.id),
      resourceType: 'admission',
      resourceId: String(admission.id),
      actorUid,
      actorRole,
      summary: `Admission #${admission.id} discharged`,
      payload: {
        admission_id: admission.id,
        discharge_type: admission.discharge_type || null,
        discharged_at: admission.discharged_at || null,
        ...payload,
      },
      tags: ['discharge'],
      timelineIdempotencyKey: `admissions:${admission.id}:discharge_completed`,
      auditIdempotencyKey: `admissions:${admission.id}:audit:discharge_completed`,
    }, { db: client }));
}

export async function emitCriticalLabAlertAcknowledged({
  db = null,
  alert = {},
  actorUid = null,
  actorRole = null,
  payload = {},
} = {}) {
  const client = dbClient(db);
  if (!alert?.id) return null;

  return safeCanonical('critical lab alert acknowledged', async () => {
    const linked = await resolveInvestigationForLabAlert(client, alert);
    const patientUid = cleanUuid(alert.patient_uid) || cleanUuid(linked?.patient_uid);
    await recordCanonicalClinicalEvent({
      tenantId: alert.tenant_id || linked?.tenant_id,
      patientUid,
      eventType: 'critical_result.acknowledged',
      eventStatus: 'acknowledged',
      sourceTable: 'lab_critical_alerts',
      sourceId: String(alert.id),
      resourceType: 'critical_lab_alert',
      resourceId: String(alert.id),
      actorUid,
      actorRole,
      summary: `${alert.test_name || linked?.test_name || 'Critical result'} acknowledged`,
      payload: {
        alert_id: alert.id,
        result_id: alert.result_id || null,
        investigation_id: linked?.investigation_id || null,
        test_name: alert.test_name || linked?.test_name || null,
        read_back_method: alert.read_back_method || null,
        notes: alert.notes || null,
        ...payload,
      },
      tags: ['critical', 'investigation'],
      timelineIdempotencyKey: `lab_critical_alerts:${alert.id}:acknowledged`,
      auditIdempotencyKey: `lab_critical_alerts:${alert.id}:audit:acknowledged`,
    }, { db: client });

    // PRIMARY: complete the SLA the lab producer actually started. The
    // results-inbox producer (labResultsService → enqueueCriticalResultTask)
    // keys the critical_result_ack SLA + task to sourceTable='lab_result',
    // source_id = lab_results.id. Historically the ack path here completed only
    // 'investigations' / 'lab_critical_alerts' — never 'lab_result' — so the
    // HL7 lab-panic SLA stayed active/breached forever and the escalation
    // backfill kept re-creating a task for an already-acknowledged result
    // (audit C-3). Unify the key: acknowledge the SAME ('lab_result', result_id)
    // resource the producer started.
    const resultId = alert.result_id != null ? String(alert.result_id) : null;
    if (resultId) {
      await completeWorkflowSla({
        tenantId: alert.tenant_id || linked?.tenant_id,
        ruleCode: 'critical_result_ack',
        sourceTable: 'lab_result',
        sourceId: resultId,
        metadata: {
          alert_id: alert.id,
          acknowledged_by: actorUid || null,
        },
      }, { db: client });

      // Also terminate the open results-inbox task for this lab_result resource,
      // so the ack closes the accountable task (not just the SLA clock) and the
      // engine's backfill won't re-alert (it skips resources with a terminal
      // task). Best-effort + idempotent: only flips a still-open task.
      await completeOpenResultTask({
        db: client,
        tenantId: alert.tenant_id || linked?.tenant_id,
        resourceType: 'lab_result',
        resourceId: resultId,
        actorUid,
      });
    }

    // Back-compat: also complete the investigation-keyed and alert-keyed SLAs
    // (older producers / the manual investigation path may have started one of
    // these). completeWorkflowSla is a no-op when no matching instance exists.
    if (linked?.investigation_id) {
      await completeWorkflowSla({
        tenantId: alert.tenant_id || linked.tenant_id,
        ruleCode: 'critical_result_ack',
        sourceTable: 'investigations',
        sourceId: String(linked.investigation_id),
        metadata: {
          alert_id: alert.id,
          result_id: alert.result_id || null,
          acknowledged_by: actorUid || null,
        },
      }, { db: client });
    }

    return completeWorkflowSla({
      tenantId: alert.tenant_id || linked?.tenant_id,
      ruleCode: 'critical_result_ack',
      sourceTable: 'lab_critical_alerts',
      sourceId: String(alert.id),
      metadata: {
        result_id: alert.result_id || null,
        acknowledged_by: actorUid || null,
      },
    }, { db: client });
  });
}

export async function emitCdsAlertAcknowledged({
  db = null,
  alert = {},
  actorUid = null,
  actorRole = null,
  payload = {},
} = {}) {
  const client = dbClient(db);
  if (!alert?.id) return null;

  return safeCanonical('CDS alert acknowledged', async () =>
    recordCanonicalClinicalEvent({
      patientUid: alert.patient_uid,
      encounterId: alert.encounter_id,
      eventType: 'cds.alert_acknowledged',
      eventSubtype: alert.alert_type,
      eventStatus: 'acknowledged',
      sourceTable: 'cds_alerts',
      sourceId: String(alert.id),
      resourceType: 'cds_alert',
      resourceId: String(alert.id),
      actorUid,
      actorRole,
      summary: alert.title || 'CDS alert acknowledged',
      payload: {
        alert_id: alert.id,
        alert_type: alert.alert_type || null,
        severity: alert.severity || null,
        override_reason: alert.override_reason || null,
        ...payload,
      },
      tags: ['cds', 'safety'],
      timelineIdempotencyKey: `cds_alerts:${alert.id}:acknowledged`,
      auditIdempotencyKey: `cds_alerts:${alert.id}:audit:acknowledged`,
    }, { db: client }));
}
