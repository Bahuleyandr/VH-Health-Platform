// Device payloads stay with NL-7; cath-lab stores only case-scoped links.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { emitCathProcedureCompletionFollowUps } from './cathQuickWinsService.js';
import {
  completeWorkflowSla,
  recordCanonicalClinicalEvent,
  startWorkflowSla
} from './canonicalClinicalPlatformService.js';
import {
  assertPrivilegeForGate,
  isGateEnabled,
  privilegeKey
} from '../staff/credentialingService.js';

const tenantOr = value => requireTenantId(value);

export const READINESS_TYPES = Object.freeze([
  'consent',
  'labs',
  'allergy_renal_risk',
  'anticoagulation',
  'blood_bank',
  'equipment',
  'implants_device_rep',
  'timeout'
]);

export const READINESS_CLEAR_STATES = Object.freeze(['pass', 'waived', 'not_applicable']);
export const CASE_STATUSES = Object.freeze([
  'requested',
  'scheduled',
  'readiness_pending',
  'ready',
  'in_progress',
  'completed',
  'cancelled'
]);

export const CASE_TRANSITIONS = Object.freeze({
  requested: ['scheduled', 'cancelled'],
  scheduled: ['readiness_pending', 'ready', 'cancelled'],
  readiness_pending: ['ready', 'cancelled'],
  ready: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
});

const CONTRAST_FIELDS = [
  'contrast_volume_ml',
  'fluoroscopy_time_min',
  'dose_area_product_gy_cm2',
  'air_kerma_mgy'
];

function cleanText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'CATH_LAB_BAD_ID');
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'CATH_LAB_BAD_UUID');
  }
  return text;
}

function normalizeJson(value, label, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'object') {
    throw AppError.badRequest(`${label} must be JSON`, 'CATH_LAB_BAD_JSON');
  }
  return value;
}

function optionalNumber(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw AppError.badRequest(`${label} must be a non-negative number`, 'CATH_LAB_BAD_NUMBER');
  }
  return number;
}

function optionalTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${label} must be a valid timestamp`, 'CATH_LAB_BAD_TIMESTAMP');
  }
  return date.toISOString();
}

function normalizeStatus(value, allowed, label) {
  const status = cleanText(value, 60);
  if (!status || !allowed.includes(status)) {
    throw AppError.badRequest(
      `${label} must be one of: ${allowed.join(', ')}`,
      'CATH_LAB_BAD_STATUS'
    );
  }
  return status;
}

function normalizeDbValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.map(normalizeDbValue);
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeDbValue(item)])
    );
  }
  return value;
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows.map(normalizeDbValue) : normalizeDbValue(rows);
}

function unwrap(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

export function evaluateReadinessGate(checks = []) {
  const byType = new Map(checks.map(check => [check.check_type, check]));
  const blocking = [];
  for (const type of READINESS_TYPES) {
    const check = byType.get(type);
    if (!check) {
      blocking.push({ check_type: type, reason: 'missing' });
      continue;
    }
    if (check.required === false) continue;
    if (!READINESS_CLEAR_STATES.includes(check.status)) {
      blocking.push({ check_type: type, reason: check.status || 'pending' });
    }
  }
  return {
    ready: blocking.length === 0,
    blocking,
    total: checks.length,
    cleared: checks.filter(check => READINESS_CLEAR_STATES.includes(check.status)).length
  };
}

export function validateCaseTransition(from, to) {
  const target = normalizeStatus(to, CASE_STATUSES, 'status');
  const allowed = CASE_TRANSITIONS[from] || [];
  if (!allowed.includes(target)) {
    throw AppError.invalidTransition(from, target, allowed);
  }
  return target;
}

export function validateContrastRadiationInput(input = {}) {
  const normalized = {};
  for (const field of CONTRAST_FIELDS) {
    normalized[field] = optionalNumber(input[field], field);
  }
  if (
    normalized.contrast_volume_ml === null &&
    normalized.fluoroscopy_time_min === null &&
    normalized.dose_area_product_gy_cm2 === null &&
    normalized.air_kerma_mgy === null
  ) {
    throw AppError.badRequest(
      'At least one contrast, fluoroscopy, or dose value is required',
      'CATH_LAB_DOSE_SUMMARY_REQUIRED'
    );
  }
  return normalized;
}

export function cathLabPrivilegeGateConfig() {
  const key = privilegeKey(
    process.env.CATH_LAB_PRIVILEGE_KEY || 'cath_lab_owner_supplied_privilege'
  );
  return {
    key,
    enabled: isGateEnabled('CATH_LAB_PRIVILEGE_GATE_ENABLED')
  };
}

async function assertPatient(tenantId, patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantOr(tenantId),
    maybeUuid(patientUid, 'patient_uid')
  );
  if (!rows.length) throw AppError.notFound('Patient not found', 'CATH_LAB_PATIENT_NOT_FOUND');
}

async function caseById(db, tenantId, caseId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, requested_procedure,
            indication, urgency, lab_room, status, planned_start_at, planned_end_at,
            actual_start_at, actual_end_at, team, sla_rule_code, sla_instance_id
       FROM cath_lab_cases
      WHERE id = $1::bigint
        AND tenant_id = $2::uuid
      ${lock ? 'FOR UPDATE' : ''}
      LIMIT 1`,
    normalizeId(caseId, 'case_id'),
    tenantOr(tenantId)
  );
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('Cath-lab case not found', 'CATH_LAB_CASE_NOT_FOUND');
  return row;
}

async function readinessForCase(db, tenantId, caseId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, check_type, status, required, completed_by, completed_at,
            evidence_owner, source_name, source_version, attachment_ref, notes, metadata
       FROM cath_lab_readiness_checks
      WHERE tenant_id = $1::uuid
        AND case_id = $2::bigint
      ORDER BY array_position($3::text[], check_type), check_type`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id'),
    READINESS_TYPES
  );
  return normalizeRows(rows);
}

async function assertReadinessComplete(db, tenantId, caseId) {
  const checks = await readinessForCase(db, tenantId, caseId);
  const gate = evaluateReadinessGate(checks);
  if (!gate.ready) {
    throw AppError.badRequest(
      'Cath-lab readiness checks must be cleared before procedure start',
      'CATH_LAB_READINESS_BLOCKED',
      { blocking: gate.blocking }
    );
  }
  return gate;
}

async function writeCanonicalEvent(
  db,
  {
    tenantId,
    patientUid,
    encounterId = null,
    eventType,
    eventStatus = null,
    sourceTable,
    sourceId,
    actorUid = null,
    actorRole = null,
    summary,
    payload = {},
    beforeState = null,
    afterState = null
  }
) {
  return recordCanonicalClinicalEvent(
    {
      tenantId,
      patientUid,
      encounterId,
      eventType,
      eventStatus,
      sourceTable,
      sourceId,
      resourceType: sourceTable,
      resourceId: sourceId,
      actorUid,
      actorRole,
      summary,
      payload,
      beforeState,
      afterState,
      tags: ['cath_lab', 'nl13_p1']
    },
    { db }
  );
}

async function updateCaseCanonicalRefs(db, { tenantId, caseId, event, sla = null }) {
  await db.$queryRawUnsafe(
    `UPDATE cath_lab_cases
        SET timeline_event_id = COALESCE($3::uuid, timeline_event_id),
            audit_event_id = COALESCE($4::uuid, audit_event_id),
            sla_instance_id = COALESCE($5::uuid, sla_instance_id),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id'),
    event?.timeline?.id || null,
    event?.audit?.id || null,
    sla?.id || null
  );
}

export async function createCase(input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const patientUid = maybeUuid(input.patient_uid || input.patientUid, 'patient_uid');
  await assertPatient(tenantId, patientUid);
  const requestedProcedure = cleanText(input.requested_procedure || input.requestedProcedure, 160);
  if (!requestedProcedure) {
    throw AppError.badRequest('requested_procedure is required', 'CATH_LAB_PROCEDURE_REQUIRED');
  }
  const urgency = input.urgency
    ? normalizeStatus(input.urgency, ['elective', 'routine', 'urgent', 'emergency'], 'urgency')
    : 'routine';
  const status = input.status
    ? normalizeStatus(input.status, CASE_STATUSES, 'status')
    : 'scheduled';
  const team = normalizeJson(input.team, 'team', {});
  const metadata = normalizeJson(input.metadata, 'metadata', {});
  const plannedStartAt = optionalTimestamp(
    input.planned_start_at || input.plannedStartAt,
    'planned_start_at'
  );
  const plannedEndAt = optionalTimestamp(
    input.planned_end_at || input.plannedEndAt,
    'planned_end_at'
  );
  const slaRuleCode = cleanText(input.sla_rule_code || input.slaRuleCode, 100);

  return setTenantTx(tenantId, async tx => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_lab_cases
         (tenant_id, patient_uid, encounter_id, appointment_id, requested_procedure,
          indication, urgency, lab_room, status, planned_start_at, planned_end_at,
          team, sla_rule_code, created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5,
               $6, $7, $8, $9, $10::timestamptz, $11::timestamptz,
               $12::jsonb, $13, $14::uuid, $14::uuid, $15::jsonb)
       RETURNING *`,
      tenantId,
      patientUid,
      maybeUuid(input.encounter_id || input.encounterId, 'encounter_id'),
      input.appointment_id ? normalizeId(input.appointment_id, 'appointment_id') : null,
      requestedProcedure,
      cleanText(input.indication),
      urgency,
      cleanText(input.lab_room || input.labRoom, 120),
      status,
      plannedStartAt,
      plannedEndAt,
      JSON.stringify(team),
      slaRuleCode,
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(metadata)
    );
    const cathCase = unwrap(rows);
    for (const checkType of READINESS_TYPES) {
      await tx.$queryRawUnsafe(
        `INSERT INTO cath_lab_readiness_checks
           (tenant_id, case_id, check_type, status, required)
         VALUES ($1::uuid, $2::bigint, $3, 'pending', TRUE)
         ON CONFLICT (tenant_id, case_id, check_type) DO NOTHING`,
        tenantId,
        cathCase.id,
        checkType
      );
    }
    const event = await writeCanonicalEvent(tx, {
      tenantId,
      patientUid,
      encounterId: cathCase.encounter_id,
      eventType: 'cath_lab.case_created',
      eventStatus: cathCase.status,
      sourceTable: 'cath_lab_cases',
      sourceId: cathCase.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Cath-lab case created: ${requestedProcedure}`,
      payload: {
        requested_procedure: requestedProcedure,
        urgency,
        lab_room: cathCase.lab_room
      },
      afterState: cathCase
    });
    const sla = slaRuleCode
      ? await startWorkflowSla(
          {
            tenantId,
            ruleCode: slaRuleCode,
            patientUid,
            encounterId: cathCase.encounter_id,
            sourceTable: 'cath_lab_cases',
            sourceId: String(cathCase.id),
            assignedRoleCodes: ['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF'],
            metadata: { requested_procedure: requestedProcedure, urgency }
          },
          { db: tx }
        )
      : null;
    await updateCaseCanonicalRefs(tx, { tenantId, caseId: cathCase.id, event, sla });
    return getCase(cathCase.id, { tenantId, db: tx });
  });
}

export async function listCases({ tenantId, date = null, status = null, limit = 100 } = {}) {
  const tid = tenantOr(tenantId);
  const params = [tid];
  const clauses = ['c.tenant_id = $1::uuid'];
  if (date) {
    params.push(String(date).slice(0, 10));
    clauses.push(`DATE(c.planned_start_at AT TIME ZONE 'Asia/Kolkata') = $${params.length}::date`);
  }
  if (status) {
    params.push(normalizeStatus(status, CASE_STATUSES, 'status'));
    clauses.push(`c.status = $${params.length}`);
  }
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.tenant_id, c.patient_uid, u.name AS patient_name,
            c.encounter_id, c.appointment_id, c.requested_procedure, c.indication,
            c.urgency, c.lab_room, c.status, c.planned_start_at, c.planned_end_at,
            c.actual_start_at, c.actual_end_at, c.team, c.sla_rule_code,
            c.sla_instance_id, c.created_at, c.updated_at,
            report_tat.procedure_to_signed_minutes AS report_tat_minutes,
            (
              SELECT COUNT(*)::int
                FROM cath_procedure_reports report_count
               WHERE report_count.tenant_id = c.tenant_id
                 AND report_count.case_id = c.id
                 AND report_count.status = 'signed'
            ) AS signed_report_count,
            (
              SELECT COUNT(*)::int
                FROM cath_lab_readiness_checks r
               WHERE r.tenant_id = c.tenant_id
                 AND r.case_id = c.id
            ) AS readiness_total,
            (
              SELECT COUNT(*)::int
                FROM cath_lab_readiness_checks r
               WHERE r.tenant_id = c.tenant_id
                 AND r.case_id = c.id
                 AND r.status IN ('pass', 'waived', 'not_applicable')
            ) AS readiness_cleared,
            (
              SELECT COUNT(*)::int
                FROM cath_procedure_logs p
               WHERE p.tenant_id = c.tenant_id
                 AND p.case_id = c.id
            ) AS procedure_count,
            (
              SELECT COUNT(*)::int
                FROM cath_contrast_radiation_records d
               WHERE d.tenant_id = c.tenant_id
                 AND d.case_id = c.id
            ) AS dose_record_count,
            (
              SELECT COUNT(*)::int
                FROM cath_post_procedure_orders o
               WHERE o.tenant_id = c.tenant_id
                 AND o.case_id = c.id
                 AND o.order_status IN ('draft', 'active')
            ) AS active_post_order_count,
            (
              SELECT COUNT(*)::int
                FROM cath_device_links l
               WHERE l.tenant_id = c.tenant_id
                 AND l.case_id = c.id
            ) AS device_link_count
       FROM cath_lab_cases c
       LEFT JOIN users u
         ON u.uid = c.patient_uid
        AND u.tenant_id = c.tenant_id
       LEFT JOIN LATERAL (
         SELECT tat.procedure_to_signed_minutes
           FROM cath_report_tat_metrics tat
          WHERE tat.tenant_id = c.tenant_id
            AND tat.case_id = c.id
            AND tat.signed_at IS NOT NULL
          ORDER BY tat.signed_at DESC, tat.report_id DESC
          LIMIT 1
       ) report_tat ON TRUE
      WHERE ${clauses.join(' AND ')}
      ORDER BY c.planned_start_at NULLS LAST, c.created_at DESC
      LIMIT $${params.length + 1}::int`,
    ...params,
    safeLimit
  );
  return normalizeRows(rows);
}

export async function getCase(caseId, { tenantId, db = prisma } = {}) {
  const cathCase = await caseById(db, tenantId, caseId);
  const readiness = await readinessForCase(db, tenantId, caseId);
  const procedures = await db.$queryRawUnsafe(
    `SELECT * FROM cath_procedure_logs
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
      ORDER BY created_at DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const hemodynamics = await db.$queryRawUnsafe(
    `SELECT * FROM cath_hemodynamic_summaries
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
      ORDER BY recorded_at DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const contrastRadiation = await db.$queryRawUnsafe(
    `SELECT * FROM cath_contrast_radiation_records
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
      ORDER BY recorded_at DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const postOrders = await db.$queryRawUnsafe(
    `SELECT * FROM cath_post_procedure_orders
      WHERE tenant_id = $1::uuid AND case_id = $2::bigint
      ORDER BY ordered_at DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const deviceLinks = await db.$queryRawUnsafe(
    `SELECT l.*, d.device_registry_id, d.channel, d.started_at AS association_started_at
       FROM cath_device_links l
       JOIN device_patient_associations d
         ON d.id = l.device_patient_association_id
      WHERE l.tenant_id = $1::uuid
        AND l.case_id = $2::bigint
      ORDER BY l.attached_at DESC`,
    tenantOr(tenantId),
    normalizeId(caseId, 'case_id')
  );
  const normalizedReadiness = normalizeRows(readiness);
  return normalizeDbValue({
    ...cathCase,
    readiness: normalizedReadiness,
    readiness_gate: evaluateReadinessGate(normalizedReadiness),
    procedures,
    hemodynamics,
    contrast_radiation: contrastRadiation,
    post_orders: postOrders,
    device_links: deviceLinks
  });
}

export async function updateReadinessCheck(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const checkType = normalizeStatus(
    input.check_type || input.checkType,
    READINESS_TYPES,
    'check_type'
  );
  const status = normalizeStatus(
    input.status || 'pending',
    ['pending', 'pass', 'fail', 'waived', 'not_applicable'],
    'status'
  );
  return setTenantTx(tenantId, async tx => {
    await caseById(tx, tenantId, caseId, { lock: true });
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_lab_readiness_checks
         (tenant_id, case_id, check_type, status, required, completed_by, completed_at,
          evidence_owner, source_name, source_version, attachment_ref, notes, metadata)
       VALUES ($1::uuid, $2::bigint, $3, $4::text, COALESCE($5, TRUE), $6::uuid,
               CASE WHEN $4::text = 'pending' THEN NULL ELSE COALESCE($7::timestamptz, NOW()) END,
               $8, $9, $10, $11, $12, $13::jsonb)
       ON CONFLICT (tenant_id, case_id, check_type) DO UPDATE SET
          status = EXCLUDED.status,
          required = EXCLUDED.required,
          completed_by = EXCLUDED.completed_by,
          completed_at = EXCLUDED.completed_at,
          evidence_owner = EXCLUDED.evidence_owner,
          source_name = EXCLUDED.source_name,
          source_version = EXCLUDED.source_version,
          attachment_ref = EXCLUDED.attachment_ref,
          notes = EXCLUDED.notes,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
       RETURNING *`,
      tenantId,
      normalizeId(caseId, 'case_id'),
      checkType,
      status,
      input.required ?? true,
      maybeUuid(context.actorUid, 'actorUid'),
      optionalTimestamp(input.completed_at || input.completedAt, 'completed_at'),
      cleanText(input.evidence_owner || input.evidenceOwner, 160),
      cleanText(input.source_name || input.sourceName, 160),
      cleanText(input.source_version || input.sourceVersion, 80),
      cleanText(input.attachment_ref || input.attachmentRef),
      cleanText(input.notes),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    const checks = await readinessForCase(tx, tenantId, caseId);
    const gate = evaluateReadinessGate(checks);
    const nextStatus = gate.ready ? 'ready' : 'readiness_pending';
    await tx.$queryRawUnsafe(
      `UPDATE cath_lab_cases
          SET status = CASE
                WHEN status IN ('scheduled', 'readiness_pending', 'ready') THEN $3
                ELSE status
              END,
              updated_by = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      normalizeId(caseId, 'case_id'),
      nextStatus,
      maybeUuid(context.actorUid, 'actorUid')
    );
    return normalizeDbValue({ check: unwrap(rows), readiness_gate: gate });
  });
}

export async function transitionCaseStatus(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  return setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    const target = validateCaseTransition(cathCase.status, input.status);
    if (target === 'in_progress') {
      await assertReadinessComplete(tx, tenantId, cathCase.id);
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE cath_lab_cases
          SET status = $3,
              actual_start_at = CASE WHEN $3 = 'in_progress' THEN COALESCE(actual_start_at, NOW()) ELSE actual_start_at END,
              actual_end_at = CASE WHEN $3 IN ('completed', 'cancelled') THEN COALESCE(actual_end_at, NOW()) ELSE actual_end_at END,
              updated_by = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        RETURNING *`,
      tenantId,
      cathCase.id,
      target,
      maybeUuid(context.actorUid, 'actorUid')
    );
    const updated = unwrap(rows);
    const event = await writeCanonicalEvent(tx, {
      tenantId,
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: `cath_lab.case_${target}`,
      eventStatus: target,
      sourceTable: 'cath_lab_cases',
      sourceId: updated.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Cath-lab case ${target}: ${updated.requested_procedure}`,
      payload: { status: target, reason: cleanText(input.reason) },
      beforeState: { status: cathCase.status },
      afterState: { status: target }
    });
    if (target === 'completed' && updated.sla_rule_code) {
      await completeWorkflowSla(
        {
          tenantId,
          ruleCode: updated.sla_rule_code,
          sourceTable: 'cath_lab_cases',
          sourceId: String(updated.id),
          metadata: { completed_by: context.actorUid || null }
        },
        { db: tx }
      );
    }
    await updateCaseCanonicalRefs(tx, { tenantId, caseId: updated.id, event });
    return normalizeDbValue(updated);
  });
}

export async function recordProcedureLog(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const gate = cathLabPrivilegeGateConfig();
  await assertPrivilegeForGate({
    staffUid: context.actorUid,
    privilegeName: gate.key,
    tenantId,
    gate: 'cath_lab_procedure_log',
    enabled: gate.enabled
  });
  const recorded = await setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    await assertReadinessComplete(tx, tenantId, cathCase.id);
    const procedureType = cleanText(input.procedure_type || input.procedureType, 120);
    if (!procedureType)
      throw AppError.badRequest('procedure_type is required', 'CATH_LAB_PROCEDURE_TYPE_REQUIRED');
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_procedure_logs
         (tenant_id, case_id, patient_uid, encounter_id, procedure_type, access_site,
          operators, sedation_anesthesia_ref, devices, findings_summary, complications,
          status, started_at, ended_at, logged_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid, $5, $6,
               $7::jsonb, $8, $9::jsonb, $10, $11::jsonb,
               $12, $13::timestamptz, $14::timestamptz, $15::uuid, $16::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      cathCase.patient_uid,
      cathCase.encounter_id,
      procedureType,
      cleanText(input.access_site || input.accessSite, 120),
      JSON.stringify(normalizeJson(input.operators, 'operators', [])),
      cleanText(input.sedation_anesthesia_ref || input.sedationAnesthesiaRef, 160),
      JSON.stringify(normalizeJson(input.devices, 'devices', [])),
      cleanText(input.findings_summary || input.findingsSummary),
      JSON.stringify(normalizeJson(input.complications, 'complications', [])),
      input.status
        ? normalizeStatus(input.status, ['draft', 'finalized', 'amended'], 'status')
        : 'finalized',
      optionalTimestamp(input.started_at || input.startedAt, 'started_at'),
      optionalTimestamp(input.ended_at || input.endedAt, 'ended_at'),
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    const procedure = unwrap(rows);
    if (cathCase.status !== 'in_progress') {
      await tx.$queryRawUnsafe(
        `UPDATE cath_lab_cases
            SET status = 'in_progress',
                actual_start_at = COALESCE(actual_start_at, NOW()),
                updated_by = $3::uuid,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint`,
        tenantId,
        cathCase.id,
        maybeUuid(context.actorUid, 'actorUid')
      );
    }
    const event = await writeCanonicalEvent(tx, {
      tenantId,
      patientUid: procedure.patient_uid,
      encounterId: procedure.encounter_id,
      eventType: 'cath_lab.procedure_logged',
      eventStatus: procedure.status,
      sourceTable: 'cath_procedure_logs',
      sourceId: procedure.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Cath procedure logged: ${procedureType}`,
      payload: {
        case_id: cathCase.id,
        procedure_type: procedureType,
        access_site: procedure.access_site,
        privilege_gate: { key: gate.key, enforced: gate.enabled }
      },
      afterState: procedure
    });
    await tx.$queryRawUnsafe(
      `UPDATE cath_procedure_logs
          SET timeline_event_id = $3::uuid,
              audit_event_id = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      procedure.id,
      event?.timeline?.id || null,
      event?.audit?.id || null
    );
    return normalizeDbValue(procedure);
  });
  // NL-13 P1e Phase-1.5 seam: finalized procedure logs emit their completion
  // fact to the NL9-P3 follow-up rails post-commit, best-effort. Owner
  // templates in tenants.settings decide whether anything triggers; failure
  // here never blocks the procedure log itself.
  if (recorded?.status === 'finalized') {
    try {
      await emitCathProcedureCompletionFollowUps({
        tenantId,
        procedureLogId: recorded.id,
        actorUid: context.actorUid
      });
    } catch (err) {
      logger.warn(
        `Cath follow-up loop emission failed for procedure_log=${recorded.id}: ${err.message}`
      );
    }
  }
  return recorded;
}

export async function addHemodynamicSummary(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  return setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_hemodynamic_summaries
         (tenant_id, case_id, procedure_log_id, patient_uid, summary_text,
          observations, file_refs, device_refs, source_system, source_version,
          recorded_by, recorded_at, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5,
               $6::jsonb, $7::jsonb, $8::jsonb, $9, $10,
               $11::uuid, COALESCE($12::timestamptz, NOW()), $13::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      input.procedure_log_id ? normalizeId(input.procedure_log_id, 'procedure_log_id') : null,
      cathCase.patient_uid,
      cleanText(input.summary_text || input.summaryText),
      JSON.stringify(normalizeJson(input.observations, 'observations', {})),
      JSON.stringify(normalizeJson(input.file_refs || input.fileRefs, 'file_refs', [])),
      JSON.stringify(normalizeJson(input.device_refs || input.deviceRefs, 'device_refs', [])),
      cleanText(input.source_system || input.sourceSystem, 160),
      cleanText(input.source_version || input.sourceVersion, 80),
      maybeUuid(context.actorUid, 'actorUid'),
      optionalTimestamp(input.recorded_at || input.recordedAt, 'recorded_at'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    return normalizeDbValue(unwrap(rows));
  });
}

export async function addContrastRadiationRecord(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  const dose = validateContrastRadiationInput(input);
  return setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_contrast_radiation_records
         (tenant_id, case_id, procedure_log_id, patient_uid, contrast_agent,
          contrast_volume_ml, fluoroscopy_time_min, dose_area_product_gy_cm2,
          air_kerma_mgy, dose_document_ref, dose_document_storage_key,
          aerb_evidence_owner, aerb_source_name, aerb_source_version,
          aerb_evidence_attachment_ref, equipment_qa_reference, recorded_by,
          recorded_at, notes, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5,
               $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10, $11,
               $12, $13, $14, $15, $16, $17::uuid,
               COALESCE($18::timestamptz, NOW()), $19, $20::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      input.procedure_log_id ? normalizeId(input.procedure_log_id, 'procedure_log_id') : null,
      cathCase.patient_uid,
      cleanText(input.contrast_agent || input.contrastAgent, 160),
      dose.contrast_volume_ml,
      dose.fluoroscopy_time_min,
      dose.dose_area_product_gy_cm2,
      dose.air_kerma_mgy,
      cleanText(input.dose_document_ref || input.doseDocumentRef),
      cleanText(input.dose_document_storage_key || input.doseDocumentStorageKey),
      cleanText(input.aerb_evidence_owner || input.aerbEvidenceOwner, 160),
      cleanText(input.aerb_source_name || input.aerbSourceName, 160),
      cleanText(input.aerb_source_version || input.aerbSourceVersion, 80),
      cleanText(input.aerb_evidence_attachment_ref || input.aerbEvidenceAttachmentRef),
      cleanText(input.equipment_qa_reference || input.equipmentQaReference),
      maybeUuid(context.actorUid, 'actorUid'),
      optionalTimestamp(input.recorded_at || input.recordedAt, 'recorded_at'),
      cleanText(input.notes),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    return normalizeDbValue(unwrap(rows));
  });
}

export async function addPostProcedureOrder(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  return setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId, { lock: true });
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_post_procedure_orders
         (tenant_id, case_id, procedure_log_id, patient_uid, recovery_location,
          sheath_management, vascular_closure, vitals_frequency, antiplatelet_plan,
          anticoagulation_plan, complication_watch, order_status, ordered_by,
          ordered_at, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5,
               $6, $7, $8, $9, $10, $11::jsonb, $12, $13::uuid,
               COALESCE($14::timestamptz, NOW()), $15::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      input.procedure_log_id ? normalizeId(input.procedure_log_id, 'procedure_log_id') : null,
      cathCase.patient_uid,
      cleanText(input.recovery_location || input.recoveryLocation, 160),
      cleanText(input.sheath_management || input.sheathManagement),
      cleanText(input.vascular_closure || input.vascularClosure),
      cleanText(input.vitals_frequency || input.vitalsFrequency, 120),
      cleanText(input.antiplatelet_plan || input.antiplateletPlan),
      cleanText(input.anticoagulation_plan || input.anticoagulationPlan),
      JSON.stringify(
        normalizeJson(input.complication_watch || input.complicationWatch, 'complication_watch', [])
      ),
      input.order_status
        ? normalizeStatus(
            input.order_status,
            ['draft', 'active', 'completed', 'cancelled'],
            'order_status'
          )
        : 'active',
      maybeUuid(context.actorUid, 'actorUid'),
      optionalTimestamp(input.ordered_at || input.orderedAt, 'ordered_at'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    const order = unwrap(rows);
    const event = await writeCanonicalEvent(tx, {
      tenantId,
      patientUid: order.patient_uid,
      encounterId: cathCase.encounter_id,
      eventType: 'cath_lab.post_orders_created',
      eventStatus: order.order_status,
      sourceTable: 'cath_post_procedure_orders',
      sourceId: order.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Cath post-procedure orders: ${order.recovery_location || 'recovery plan'}`,
      payload: {
        case_id: cathCase.id,
        vitals_frequency: order.vitals_frequency,
        complication_watch: order.complication_watch
      },
      afterState: order
    });
    await tx.$queryRawUnsafe(
      `UPDATE cath_post_procedure_orders
          SET timeline_event_id = $3::uuid,
              audit_event_id = $4::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      tenantId,
      order.id,
      event?.timeline?.id || null,
      event?.audit?.id || null
    );
    return normalizeDbValue(order);
  });
}

export async function addDeviceLink(caseId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  return setTenantTx(tenantId, async tx => {
    const cathCase = await caseById(tx, tenantId, caseId);
    const assocRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, ended_at
         FROM device_patient_associations
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND patient_uid = $3::uuid
          AND ended_at IS NULL
        LIMIT 1`,
      tenantId,
      normalizeId(
        input.device_patient_association_id || input.devicePatientAssociationId,
        'device_patient_association_id'
      ),
      cathCase.patient_uid
    );
    const association = unwrap(assocRows);
    if (!association) {
      throw AppError.badRequest(
        'Cath device links require an active NL-7 device-patient association for the same patient',
        'CATH_LAB_DEVICE_ASSOCIATION_INACTIVE'
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO cath_device_links
         (tenant_id, case_id, procedure_log_id, patient_uid, device_patient_association_id,
          link_type, external_system, external_accession_id, inbound_document_id,
          summary, attached_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5::int,
               $6, $7, $8, $9, $10, $11::uuid, $12::jsonb)
       RETURNING *`,
      tenantId,
      cathCase.id,
      input.procedure_log_id ? normalizeId(input.procedure_log_id, 'procedure_log_id') : null,
      cathCase.patient_uid,
      association.id,
      input.link_type
        ? normalizeStatus(
            input.link_type,
            [
              'hemodynamic_summary',
              'angiography_accession',
              'ep_system',
              'tavr_device',
              'dose_document',
              'summary',
              'other'
            ],
            'link_type'
          )
        : 'summary',
      cleanText(input.external_system || input.externalSystem, 160),
      cleanText(input.external_accession_id || input.externalAccessionId, 160),
      cleanText(input.inbound_document_id || input.inboundDocumentId, 160),
      cleanText(input.summary),
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {}))
    );
    return normalizeDbValue(unwrap(rows));
  });
}

export const __testing__ = {
  normalizeDbValue
};

export default {
  createCase,
  listCases,
  getCase,
  updateReadinessCheck,
  transitionCaseStatus,
  recordProcedureLog,
  addHemodynamicSummary,
  addContrastRadiationRecord,
  addPostProcedureOrder,
  addDeviceLink
};
