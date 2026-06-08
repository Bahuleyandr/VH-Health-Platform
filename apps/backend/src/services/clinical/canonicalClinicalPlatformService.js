// Canonical Clinical Platform Service
//
// This is the additive foundation for one patient timeline, encounter
// lifecycle, normalized clinical audit, medication safety reviews, and
// workflow SLA instances. Existing feature tables stay the source detail
// tables; successful writes emit through these helpers.

import { randomUUID } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getPatientTimeline as getLegacyPatientTimeline } from '../emr/clinicalTimelineService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GLOBAL_TENANT_SENTINEL = '00000000-0000-0000-0000-000000000000';

const ENCOUNTER_TRANSITIONS = {
  open: new Set(['active', 'signed', 'cancelled']),
  active: new Set(['signed', 'cancelled']),
  signed: new Set(['amended', 'locked']),
  amended: new Set(['signed', 'locked']),
  locked: new Set([]),
  cancelled: new Set([]),
};

function dbClient(db) {
  return db || prisma;
}

function hasRawClient(db) {
  return db && typeof db.$queryRawUnsafe === 'function';
}

function isSchemaMissing(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  return code === '42P01'
    || code === '42703'
    || /relation .* does not exist|column .* does not exist/i.test(String(err?.message || ''));
}

function logCanonicalFailure(context, err) {
  if (isSchemaMissing(err)) {
    logger.warn(`Canonical clinical platform table unavailable during ${context}`, {
      error: err?.message || String(err),
    });
    return;
  }
  throw err;
}

function cleanUuid(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

function cleanText(value, fallback = null) {
  const text = value == null ? '' : String(value).trim();
  return text || fallback;
}

function normalizeTenantId(value) {
  return cleanUuid(value) || DEFAULT_TENANT_ID;
}

function safeJson(value, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  return value;
}

function stringifyJson(value, fallback = {}) {
  return JSON.stringify(safeJson(value, fallback));
}

function sourceKey({ eventType, action, sourceTable, sourceId, resourceType, resourceId, patientUid }) {
  return [
    eventType || action || 'clinical.event',
    sourceTable || resourceType || 'resource',
    sourceId || resourceId || patientUid || randomUUID(),
  ].map((part) => String(part).trim()).join(':').slice(0, 220);
}

function mapLegacyTypeToCanonical(type) {
  const raw = String(type || '').toLowerCase();
  if (raw === 'clinical_note' || raw === 'clinical.notes') return 'clinical_note';
  if (raw.includes('vital')) return 'vitals.recorded';
  if (raw.includes('io') || raw.includes('intake') || raw.includes('output')) return 'io.recorded';
  if (raw.includes('prescription')) return 'prescription.created';
  if (raw.includes('investigation') || raw.includes('lab')) return 'investigation.event';
  if (raw.includes('referral')) return 'referral.event';
  if (raw.includes('order')) return 'order.created';
  if (raw.includes('admission')) return 'admission.event';
  if (raw.includes('discharge')) return 'discharge.event';
  if (raw.includes('medication')) return 'medication.event';
  return raw ? `legacy.${raw}` : 'legacy.event';
}

function normalizeLegacyEvent(event) {
  const timestamp = event.timestamp || event.recorded_at || event.created_at || event.occurred_at || null;
  return {
    id: event.id != null ? `legacy-${event.type || 'event'}-${event.id}` : `legacy-${randomUUID()}`,
    canonical: false,
    event_type: mapLegacyTypeToCanonical(event.type || event.event_type),
    event_subtype: event.type || event.event_subtype || null,
    event_status: event.status || null,
    resource_type: event.type || null,
    resource_id: event.id == null ? null : String(event.id),
    occurred_at: timestamp,
    timestamp,
    title: event.title || event.type || 'Clinical event',
    clinical_summary: event.summary || event.description || event.title || null,
    actor_uid: event.actor_uid || event.author_uid || event.recorded_by || null,
    actor_role: event.actor_role || event.author_role || null,
    payload: event,
  };
}

function normalizeCanonicalEvent(row) {
  return {
    id: row.id,
    canonical: true,
    event_type: row.event_type,
    event_subtype: row.event_subtype,
    event_status: row.event_status,
    source_table: row.source_table,
    source_id: row.source_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    encounter_id: row.encounter_id,
    occurred_at: row.occurred_at,
    timestamp: row.occurred_at,
    title: row.payload?.title || row.event_subtype || row.event_type,
    clinical_summary: row.clinical_summary,
    actor_uid: row.actor_uid,
    actor_role: row.actor_role,
    visible_to_patient: row.visible_to_patient,
    payload: row.payload || {},
    tags: row.tags || [],
  };
}

export async function recordTimelineEvent(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return null;

  const tenantId = normalizeTenantId(input.tenantId || input.tenant_id);
  const patientUid = cleanUuid(input.patientUid || input.patient_uid);
  if (!patientUid) return null;

  const eventType = cleanText(input.eventType || input.event_type, 'clinical.event');
  const eventStatus = cleanText(input.eventStatus || input.event_status);
  const sourceTable = cleanText(input.sourceTable || input.source_table);
  const sourceId = cleanText(input.sourceId || input.source_id);
  const resourceType = cleanText(input.resourceType || input.resource_type || sourceTable);
  const resourceId = cleanText(input.resourceId || input.resource_id || sourceId);
  const idempotencyKey = cleanText(input.idempotencyKey || input.idempotency_key)
    || sourceKey({ eventType, sourceTable, sourceId, resourceType, resourceId, patientUid });

  try {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO clinical_timeline_events
         (tenant_id, patient_uid, encounter_id, event_type, event_subtype, event_status,
          source_table, source_id, source_uid, resource_type, resource_id, actor_uid, actor_role,
          occurred_at, visible_to_patient, clinical_summary, payload, tags, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
               $7, $8, $9::uuid, $10, $11, $12::uuid, $13,
               COALESCE($14::timestamptz, NOW()), $15, $16, $17::jsonb, $18::text[], $19)
       ON CONFLICT (idempotency_key)
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      tenantId,
      patientUid,
      cleanUuid(input.encounterId || input.encounter_id),
      eventType,
      cleanText(input.eventSubtype || input.event_subtype),
      eventStatus,
      sourceTable,
      sourceId,
      cleanUuid(input.sourceUid || input.source_uid),
      resourceType,
      resourceId,
      cleanUuid(input.actorUid || input.actor_uid),
      cleanText(input.actorRole || input.actor_role),
      input.occurredAt || input.occurred_at || null,
      input.visibleToPatient === true || input.visible_to_patient === true,
      cleanText(input.summary || input.clinical_summary),
      stringifyJson(input.payload),
      Array.isArray(input.tags) ? input.tags.map(String) : [],
      idempotencyKey,
    );
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('timeline event record', err);
    return null;
  }
}

export async function recordClinicalAuditEvent(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return null;

  const tenantId = normalizeTenantId(input.tenantId || input.tenant_id);
  const action = cleanText(input.action);
  if (!action) return null;

  try {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO clinical_audit_events
         (tenant_id, patient_uid, encounter_id, action, action_status, actor_uid, actor_role,
          resource_type, resource_table, resource_id, request_id, ip_address, user_agent,
          before_state, after_state, metadata, idempotency_key, occurred_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7,
               $8, $9, $10, $11, NULLIF($12, '')::inet, $13,
               $14::jsonb, $15::jsonb, $16::jsonb, $17, COALESCE($18::timestamptz, NOW()))
       ON CONFLICT (idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      tenantId,
      cleanUuid(input.patientUid || input.patient_uid),
      cleanUuid(input.encounterId || input.encounter_id),
      action,
      cleanText(input.actionStatus || input.action_status, 'success'),
      cleanUuid(input.actorUid || input.actor_uid),
      cleanText(input.actorRole || input.actor_role),
      cleanText(input.resourceType || input.resource_type),
      cleanText(input.resourceTable || input.resource_table),
      cleanText(input.resourceId || input.resource_id),
      cleanText(input.requestId || input.request_id),
      cleanText(input.ipAddress || input.ip_address, ''),
      cleanText(input.userAgent || input.user_agent),
      stringifyJson(input.beforeState || input.before_state, null),
      stringifyJson(input.afterState || input.after_state, null),
      stringifyJson(input.metadata),
      cleanText(input.idempotencyKey || input.idempotency_key)
        || sourceKey({
          action,
          sourceTable: input.resourceTable || input.resource_table,
          sourceId: input.resourceId || input.resource_id,
          patientUid: input.patientUid || input.patient_uid,
        }),
      input.occurredAt || input.occurred_at || null,
    );
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('clinical audit event record', err);
    return null;
  }
}

export async function recordCanonicalClinicalEvent(input = {}, options = {}) {
  const db = dbClient(options.db);
  const resourceTable = input.resourceTable || input.resource_table || input.sourceTable || input.source_table;
  const resourceId = input.resourceId || input.resource_id || input.sourceId || input.source_id;
  const timeline = await recordTimelineEvent({
    ...input,
    sourceTable: input.sourceTable || resourceTable,
    sourceId: input.sourceId || resourceId,
    idempotencyKey: input.timelineIdempotencyKey || input.timeline_idempotency_key,
  }, { db });
  const audit = await recordClinicalAuditEvent({
    ...input,
    action: input.action || input.eventType || input.event_type,
    resourceTable,
    resourceId,
    idempotencyKey: input.auditIdempotencyKey || input.audit_idempotency_key,
  }, { db });
  return { timeline, audit };
}

export async function ensureEncounterForAppointment(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return null;

  const appointmentId = Number.parseInt(input.appointmentId || input.appointment_id, 10);
  const patientUid = cleanUuid(input.patientUid || input.patient_uid);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0 || !patientUid) return null;

  const tenantId = normalizeTenantId(input.tenantId || input.tenant_id);
  const actorUid = cleanUuid(input.actorUid || input.actor_uid);
  const doctorUid = cleanUuid(input.doctorUid || input.doctor_uid || input.primaryDoctorUid);

  try {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO patient_encounters
         (tenant_id, patient_uid, encounter_type, status, appointment_id, primary_doctor_uid,
          care_team_uids, created_by, updated_by, status_history, metadata)
       VALUES ($1::uuid, $2::uuid, 'op', 'open', $3::int, $4::uuid,
               ARRAY_REMOVE(ARRAY[$4::uuid, $5::uuid], NULL)::uuid[], $5::uuid, $5::uuid,
               jsonb_build_array(jsonb_build_object(
                 'status', 'open',
                 'changed_at', NOW(),
                 'changed_by', $5::uuid,
                 'reason', 'appointment clinical workflow'
               )),
               $6::jsonb)
       ON CONFLICT (tenant_id, appointment_id) WHERE appointment_id IS NOT NULL
       DO UPDATE SET
         updated_at = NOW(),
         updated_by = COALESCE(EXCLUDED.updated_by, patient_encounters.updated_by),
         primary_doctor_uid = COALESCE(patient_encounters.primary_doctor_uid, EXCLUDED.primary_doctor_uid),
         care_team_uids = (
           SELECT ARRAY(SELECT DISTINCT uid FROM UNNEST(patient_encounters.care_team_uids || EXCLUDED.care_team_uids) AS uid WHERE uid IS NOT NULL)
         )
       RETURNING *`,
      tenantId,
      patientUid,
      appointmentId,
      doctorUid,
      actorUid,
      stringifyJson(input.metadata),
    );
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('encounter ensure for appointment', err);
    return null;
  }
}

export async function getEncounter(encounterId, options = {}) {
  const db = dbClient(options.db);
  const id = cleanUuid(encounterId);
  if (!id || !hasRawClient(db)) return null;
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT * FROM patient_encounters WHERE id = $1::uuid LIMIT 1`,
      id,
    );
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('encounter load', err);
    return null;
  }
}

export async function transitionEncounter(encounterId, nextStatus, input = {}, options = {}) {
  const db = dbClient(options.db);
  const id = cleanUuid(encounterId);
  const target = cleanText(nextStatus)?.toLowerCase();
  if (!id || !target || !hasRawClient(db)) {
    throw AppError.badRequest('encounter id and target status are required');
  }
  const existing = await getEncounter(id, { db });
  if (!existing) throw AppError.notFound('Encounter not found');

  const current = String(existing.status || '').toLowerCase();
  if (!ENCOUNTER_TRANSITIONS[current]?.has(target)) {
    throw AppError.conflict(`Invalid encounter transition: ${current} -> ${target}`, 'INVALID_ENCOUNTER_TRANSITION');
  }

  const actorUid = cleanUuid(input.actorUid || input.actor_uid);
  const metadata = safeJson(input.metadata);
  const timestampColumn = {
    active: 'activated_at',
    signed: 'signed_at',
    amended: 'amended_at',
    locked: 'locked_at',
    cancelled: 'closed_at',
  }[target];
  const actorColumn = {
    signed: 'signed_by',
    amended: 'amended_by',
    locked: 'locked_by',
  }[target];

  try {
    const rows = await db.$queryRawUnsafe(
      `UPDATE patient_encounters
          SET status = $2,
              ${timestampColumn ? `${timestampColumn} = NOW(),` : ''}
              ${actorColumn ? `${actorColumn} = $3::uuid,` : ''}
              updated_by = $3::uuid,
              updated_at = NOW(),
              status_history = status_history || jsonb_build_array(jsonb_build_object(
                'from_status', $4,
                'to_status', $2,
                'changed_at', NOW(),
                'changed_by', $3::uuid,
                'reason', $5,
                'metadata', $6::jsonb
              ))
        WHERE id = $1::uuid
        RETURNING *`,
      id,
      target,
      actorUid,
      current,
      cleanText(input.reason),
      stringifyJson(metadata),
    );
    const updated = rows[0];
    await recordCanonicalClinicalEvent({
      tenantId: updated.tenant_id,
      patientUid: updated.patient_uid,
      encounterId: updated.id,
      eventType: `encounter.${target}`,
      eventStatus: target,
      sourceTable: 'patient_encounters',
      sourceId: updated.id,
      resourceType: 'encounter',
      resourceId: updated.id,
      actorUid,
      actorRole: input.actorRole || input.actor_role,
      summary: `Encounter ${target}`,
      payload: { from_status: current, to_status: target, metadata },
      beforeState: { status: current },
      afterState: { status: target },
      timelineIdempotencyKey: `encounter:${updated.id}:${target}:${updated.updated_at?.toISOString?.() || Date.now()}`,
      auditIdempotencyKey: `encounter-audit:${updated.id}:${target}:${updated.updated_at?.toISOString?.() || Date.now()}`,
    }, { db });
    return updated;
  } catch (err) {
    logCanonicalFailure('encounter transition', err);
    return null;
  }
}

export async function readCanonicalPatientTimeline(patientUid, filters = {}, options = {}) {
  const db = dbClient(options.db);
  const uid = cleanUuid(patientUid);
  if (!uid) throw AppError.badRequest('patient uid is required');

  const tenantId = normalizeTenantId(filters.tenantId || filters.tenant_id);
  const limit = Math.max(1, Math.min(Number.parseInt(filters.limit, 10) || 100, 500));
  const includeLegacy = filters.includeLegacy !== false && filters.include_legacy !== false;
  const params = [tenantId, uid];
  let idx = 3;
  const where = ['tenant_id = $1::uuid', 'patient_uid = $2::uuid'];
  if (filters.date_from) {
    where.push(`occurred_at >= $${idx++}::timestamptz`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    where.push(`occurred_at <= $${idx++}::timestamptz`);
    params.push(filters.date_to);
  }

  let canonical = [];
  if (hasRawClient(db)) {
    try {
      const rows = await db.$queryRawUnsafe(
        `SELECT *
           FROM clinical_timeline_events
          WHERE ${where.join(' AND ')}
          ORDER BY occurred_at DESC
          LIMIT $${idx}::int`,
        ...params,
        limit,
      );
      canonical = rows.map(normalizeCanonicalEvent);
    } catch (err) {
      logCanonicalFailure('patient timeline read', err);
    }
  }

  let legacy = [];
  if (includeLegacy) {
    try {
      legacy = (await getLegacyPatientTimeline(uid, {
        dateFrom: filters.date_from || null,
        dateTo: filters.date_to || null,
        limit,
        sort: 'desc',
      })).map(normalizeLegacyEvent);
    } catch (err) {
      logger.warn('Legacy timeline merge failed', {
        patientUid: uid,
        error: err?.message || String(err),
      });
    }
  }

  const seen = new Set(canonical.map((event) => `${event.source_table || event.resource_type}:${event.source_id || event.resource_id}:${event.event_type}`));
  const merged = [
    ...canonical,
    ...legacy.filter((event) => {
      const key = `${event.resource_type || 'legacy'}:${event.resource_id || event.id}:${event.event_type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ].sort((a, b) => new Date(b.timestamp || b.occurred_at || 0) - new Date(a.timestamp || a.occurred_at || 0))
    .slice(0, limit);

  return {
    patient_uid: uid,
    events: merged,
    counts: {
      canonical: canonical.length,
      legacy: legacy.length,
      returned: merged.length,
    },
    generated_at: new Date().toISOString(),
  };
}

export async function startWorkflowSla(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return null;
  const tenantId = normalizeTenantId(input.tenantId || input.tenant_id);
  const ruleCode = cleanText(input.ruleCode || input.rule_code);
  if (!ruleCode) return null;

  try {
    const rules = await db.$queryRawUnsafe(
      `SELECT *
         FROM workflow_sla_rules
        WHERE enabled = TRUE
          AND rule_code = $1
          AND (tenant_id = $2::uuid OR tenant_id IS NULL)
        ORDER BY CASE WHEN tenant_id = $2::uuid THEN 0 ELSE 1 END
        LIMIT 1`,
      ruleCode,
      tenantId,
    );
    const rule = rules[0];
    if (!rule) return null;

    const rows = await db.$queryRawUnsafe(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_id, rule_code, patient_uid, encounter_id, source_table, source_id,
          source_uid, status, priority, started_at, due_at, assigned_role_codes,
          assigned_user_uid, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7,
               $8::uuid, 'active', $9, NOW(), NOW() + ($10::int * INTERVAL '1 minute'),
               $11::text[], $12::uuid, $13::jsonb)
       ON CONFLICT (tenant_id, rule_code, source_table, source_id)
       WHERE source_table IS NOT NULL AND source_id IS NOT NULL
       DO UPDATE SET
         updated_at = NOW(),
         status = CASE
           WHEN workflow_sla_instances.status IN ('completed', 'cancelled') THEN workflow_sla_instances.status
           ELSE 'active'
         END
       RETURNING *`,
      tenantId,
      rule.id,
      rule.rule_code,
      cleanUuid(input.patientUid || input.patient_uid),
      cleanUuid(input.encounterId || input.encounter_id),
      cleanText(input.sourceTable || input.source_table),
      cleanText(input.sourceId || input.source_id),
      cleanUuid(input.sourceUid || input.source_uid),
      cleanText(input.priority, 'normal'),
      rule.target_minutes,
      Array.isArray(input.assignedRoleCodes || input.assigned_role_codes)
        ? (input.assignedRoleCodes || input.assigned_role_codes).map(String)
        : (rule.owner_role_codes || []),
      cleanUuid(input.assignedUserUid || input.assigned_user_uid),
      stringifyJson(input.metadata),
    );
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('workflow SLA start', err);
    return null;
  }
}

export async function completeWorkflowSla(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return null;
  const tenantId = normalizeTenantId(input.tenantId || input.tenant_id);
  const ruleCode = cleanText(input.ruleCode || input.rule_code);
  const sourceTable = cleanText(input.sourceTable || input.source_table);
  const sourceId = cleanText(input.sourceId || input.source_id);
  if (!ruleCode || !sourceTable || !sourceId) return null;

  try {
    const rows = await db.$queryRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = CASE WHEN NOW() > due_at THEN 'breached' ELSE 'completed' END,
              completed_at = NOW(),
              breached_at = CASE WHEN NOW() > due_at THEN COALESCE(breached_at, NOW()) ELSE breached_at END,
              metadata = metadata || $5::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND rule_code = $2
          AND source_table = $3
          AND source_id = $4
        RETURNING *`,
      tenantId,
      ruleCode,
      sourceTable,
      sourceId,
      stringifyJson(input.metadata),
    );
    return rows[0] || null;
  } catch (err) {
    logCanonicalFailure('workflow SLA complete', err);
    return null;
  }
}

function issueMessage(issue) {
  return cleanText(issue?.message || issue?.reason || issue?.summary || issue?.title, 'Medication safety review finding');
}

function issueType(issue, fallback) {
  return cleanText(issue?.type || issue?.category || issue?.code, fallback);
}

function issueSeverity(issue, fallback) {
  return cleanText(issue?.severity, fallback)?.toLowerCase() || fallback;
}

function issueMedication(issue) {
  return cleanText(issue?.medication || issue?.medication_name || issue?.drug || issue?.drug_name || issue?.name);
}

export async function recordMedicationSafetyReviews(input = {}, options = {}) {
  const db = dbClient(options.db);
  if (!hasRawClient(db)) return [];

  const safety = input.safety || { warnings: [], blockers: [], safe: true };
  const findings = [
    ...(Array.isArray(safety.blockers) ? safety.blockers.map((issue) => ({ issue, status: 'blocked', fallbackSeverity: 'high' })) : []),
    ...(Array.isArray(safety.warnings) ? safety.warnings.map((issue) => ({ issue, status: 'warning', fallbackSeverity: 'medium' })) : []),
  ];
  if (findings.length === 0) {
    findings.push({
      issue: { type: 'overall', message: 'No medication safety findings detected' },
      status: 'passed',
      fallbackSeverity: 'info',
    });
  }

  const tenantId = normalizeTenantId(input.tenantId || input.tenant_id);
  const rows = [];
  for (const finding of findings) {
    const issue = finding.issue || {};
    const overrideReason = cleanText(input.override?.reason || input.override_reason);
    try {
      const inserted = await db.$queryRawUnsafe(
        `INSERT INTO medication_safety_reviews
           (tenant_id, patient_uid, patient_id, encounter_id, prescription_id, clinical_order_id,
            review_type, severity, status, finding_code, medication_name, message,
            override_required, override_reason, overridden_by, overridden_at, payload, created_by)
         VALUES ($1::uuid, $2::uuid, $3::int, $4::uuid, $5::int, $6::int,
                 $7, $8, $9, $10, $11, $12,
                 $13, $14, $15::uuid, CASE WHEN $14::text IS NOT NULL THEN NOW() ELSE NULL END,
                 $16::jsonb, $17::uuid)
         RETURNING *`,
        tenantId,
        cleanUuid(input.patientUid || input.patient_uid),
        input.patientId || input.patient_id || null,
        cleanUuid(input.encounterId || input.encounter_id),
        input.prescriptionId || input.prescription_id || null,
        input.clinicalOrderId || input.clinical_order_id || null,
        issueType(issue, 'overall'),
        issueSeverity(issue, finding.fallbackSeverity),
        overrideReason && finding.status === 'blocked' ? 'overridden' : finding.status,
        cleanText(issue.code || issue.finding_code),
        issueMedication(issue),
        issueMessage(issue),
        finding.status === 'blocked',
        overrideReason,
        cleanUuid(input.override?.approvedBy || input.override?.approved_by || input.actorUid || input.actor_uid),
        stringifyJson(issue),
        cleanUuid(input.actorUid || input.actor_uid),
      );
      if (inserted[0]) rows.push(inserted[0]);
    } catch (err) {
      logCanonicalFailure('medication safety review record', err);
    }
  }
  return rows;
}

export async function evaluateMedicationSafety(input = {}, options = {}) {
  const safety = await validatePrescriptionSafety(input.patientId || input.patient_id, input.medications || []);
  await recordMedicationSafetyReviews({ ...input, safety }, options);
  return safety;
}

export const CANONICAL_GLOBAL_TENANT_SENTINEL = GLOBAL_TENANT_SENTINEL;
