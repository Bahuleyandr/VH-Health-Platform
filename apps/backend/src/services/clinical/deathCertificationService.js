// src/services/clinical/deathCertificationService.js — Sprint 21
//
// MCCD (Medical Certificate of Cause of Death — Form 4) + mortality
// review (M&M). Status walk for the death record:
//   pending → certified → submitted_to_registrar → registered
// or → cancelled (only from pending). Body release is a separate
// PATCH that can happen any time after pending.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import * as taskService from '../workflow/taskService.js';

function tenantOr(t) { return requireTenantId(t); }
function unwrap(rows) { return Array.isArray(rows) ? rows[0] : rows; }

const STATUS_TRANSITIONS = {
  pending:                ['certified', 'cancelled'],
  certified:              ['submitted_to_registrar'],
  submitted_to_registrar: ['registered'],
  registered:             [],
  cancelled:              [],
};

const VALID_PLACES = ['inpatient', 'emergency', 'icu', 'or', 'home_brought_dead', 'transferred_out_dead'];
const VALID_MANNERS = ['natural', 'accident', 'suicide', 'homicide', 'pending', 'undetermined'];
const SLOT_STATUSES = ['available', 'occupied', 'cleaning', 'maintenance', 'retired'];
const CUSTODY_EVENT_TYPES = ['receive', 'store', 'release'];
const RELEASE_METHODS = ['family', 'mortuary_van', 'unclaimed_to_municipality'];
const UNCLAIMED_SLA_KEY = 'mortuary_unclaimed_body';
const TASK_MATERIALIZATION_CONTRACT = 'application_atomic_v1';
const TASK_TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const TASK_COMPLETABLE_STATUSES = new Set(['open', 'in_progress', 'overdue']);
const TASK_ADVANCE_ATTEMPTS = 4;

async function assertPatientInTenant(tenantId, patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantOr(tenantId),
    String(patientUid),
  );
  if (!rows.length) throw AppError.notFound('Patient not found');
}

async function assertAdmissionInTenant(tenantId, admissionId, patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid
       FROM admissions
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    tenantOr(tenantId),
    parseInt(admissionId, 10),
  );
  const admission = unwrap(rows);
  if (!admission) throw AppError.notFound('Admission not found');
  if (String(admission.patient_uid) !== String(patientUid)) {
    throw AppError.forbidden('Admission belongs to a different patient');
  }
  return admission;
}

async function nextSerial(tenantId, year) {
  const sql = `
    INSERT INTO mccd_serial_counter (tenant_id, next_serial)
    VALUES ($1, 2)
    ON CONFLICT (tenant_id)
    DO UPDATE SET next_serial = mccd_serial_counter.next_serial + 1
    RETURNING next_serial - 1 AS issued`;
  const rows = await prisma.$queryRawUnsafe(sql, tenantOr(tenantId));
  const r = unwrap(rows);
  return `MCCD-${year}-${String(r.issued).padStart(6, '0')}`;
}

// Validate MCCD content before letting status leave 'pending'.
// The State registrar rejects forms that are missing 1a or that
// declare medicolegal without police clearance.
function validateForCertification(rec) {
  const errs = [];
  if (!rec.cause_part_1a || !rec.cause_part_1a.trim()) {
    errs.push('Part Ia (immediate cause) required');
  }
  if (!rec.manner_of_death) errs.push('manner_of_death required');
  if (rec.is_medicolegal) {
    if (!rec.police_station) errs.push('police_station required when medicolegal');
    if (!rec.police_fir_no) errs.push('police_fir_no required when medicolegal');
  }
  if (rec.was_pregnancy_related && !rec.pregnancy_stage) {
    errs.push('pregnancy_stage required when was_pregnancy_related');
  }
  return errs;
}

function cleanText(value, max = null) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizePositiveBigInt(value, label) {
  const text = cleanText(value);
  if (!text || !/^\d+$/.test(text)) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return text;
}

function normalizeLimit(value, fallback = 100, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function normalizeSlotStatus(status, fallback = 'available') {
  const clean = cleanText(status) || fallback;
  if (!SLOT_STATUSES.includes(clean)) {
    throw AppError.badRequest(`slot status must be one of: ${SLOT_STATUSES.join(', ')}`);
  }
  return clean;
}

function stringifyObject(value, label = 'metadata') {
  if (value === null || value === undefined) return '{}';
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return JSON.stringify(value);
}

function validateCustodyEventInput(eventType, body = {}) {
  const errs = [];
  if (!CUSTODY_EVENT_TYPES.includes(eventType)) {
    errs.push(`event_type must be one of: ${CUSTODY_EVENT_TYPES.join(', ')}`);
  }
  if (eventType === 'store' && !body.slot_id) {
    errs.push('slot_id required for store events');
  }
  if (eventType === 'release') {
    if (!body.body_released_to_name && body.release_method !== 'unclaimed_to_municipality') {
      errs.push('body_released_to_name required for release events');
    }
    if (!body.body_released_to_relation && body.release_method !== 'unclaimed_to_municipality') {
      errs.push('body_released_to_relation required for release events');
    }
    if (!body.release_method && !body.body_release_method) {
      errs.push('release_method required for release events');
    }
  }
  const releaseMethod = body.release_method || body.body_release_method;
  if (releaseMethod && !RELEASE_METHODS.includes(releaseMethod)) {
    errs.push(`release_method must be one of: ${RELEASE_METHODS.join(', ')}`);
  }
  return errs;
}

function ensureCustodyEventInput(eventType, body = {}) {
  const errs = validateCustodyEventInput(eventType, body);
  if (errs.length) throw AppError.badRequest(errs.join('; '));
}

async function assertDeathRecordForCustody(tx, tenantId, id, { forUpdate = false } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, mccd_serial, date_of_death, time_of_death,
            is_medicolegal, police_clearance_at, body_released_at
       FROM death_records
      WHERE id = $1::int AND tenant_id = $2::uuid
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    normalizePositiveInt(id, 'death_record_id'),
    tenantOr(tenantId),
  );
  const rec = unwrap(rows);
  if (!rec) throw AppError.notFound('Death record not found');
  return rec;
}

async function latestCustodyEvent(tx, tenantId, deathRecordId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM body_custody_events
      WHERE tenant_id = $1::uuid AND death_record_id = $2::int
      ORDER BY event_at DESC, id DESC
      LIMIT 1`,
    tenantOr(tenantId),
    normalizePositiveInt(deathRecordId, 'death_record_id'),
  );
  return unwrap(rows) || null;
}

async function insertCustodyEvent(tx, tenantId, deathRecordId, eventType, body = {}) {
  ensureCustodyEventInput(eventType, body);
  const slotId = body.slot_id ? normalizePositiveBigInt(body.slot_id, 'slot_id') : null;
  const releaseMethod = body.release_method || body.body_release_method || null;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO body_custody_events
       (tenant_id, death_record_id, slot_id, event_type, event_at,
        performed_by, performed_by_role, witness_name, witness_uid, witness_id_proof,
        claimant_name, claimant_relation, claimant_contact,
        is_unclaimed, unclaimed_reason, release_method, notes, metadata)
     VALUES ($1::uuid, $2::int, $3::bigint, $4, COALESCE($5::timestamptz, NOW()),
             $6::uuid, $7, $8, $9::uuid, $10,
             $11, $12, $13,
             COALESCE($14::boolean, false), $15, $16, $17, $18::jsonb)
     RETURNING *`,
    tenantOr(tenantId),
    normalizePositiveInt(deathRecordId, 'death_record_id'),
    slotId,
    eventType,
    body.event_at || null,
    body.performed_by || null,
    cleanText(body.performed_by_role, 80),
    cleanText(body.witness_name, 160),
    body.witness_uid || null,
    cleanText(body.witness_id_proof, 80),
    cleanText(body.claimant_name || body.body_released_to_name, 160),
    cleanText(body.claimant_relation || body.body_released_to_relation, 80),
    cleanText(body.claimant_contact, 80),
    Boolean(body.is_unclaimed),
    cleanText(body.unclaimed_reason),
    releaseMethod,
    cleanText(body.notes),
    stringifyObject(body.metadata),
  );
  return unwrap(rows);
}

async function queueUnclaimedBodyTask({ tenantId, deathRecordId, actorUid = null, tx }) {
  const tid = tenantOr(tenantId);
  const id = normalizePositiveInt(deathRecordId, 'death_record_id');
  if (!tx) throw AppError.internal('Mortuary SLA/task materialization requires a transaction');
  const { startWorkflowSla } = await import('./canonicalClinicalPlatformService.js');
  const sla = await startWorkflowSla({
    tenantId: tid,
    ruleCode: UNCLAIMED_SLA_KEY,
    sourceTable: 'death_records',
    sourceId: String(id),
    priority: 'high',
    metadata: {
      source: 'mortuary_body_custody',
      task_materialization_contract: TASK_MATERIALIZATION_CONTRACT,
    },
  }, { db: tx, strict: true });
  const slaPolicyMissing = !sla;
  if (
    sla
    && (
      !sla.id
      || sla.completed_at != null
      || !['active', 'breached', 'escalated'].includes(String(sla.status || '').toLowerCase())
    )
  ) {
    throw AppError.conflict(
      'Mortuary unclaimed-body SLA could not be started as an incomplete clock',
      'MORTUARY_SLA_MATERIALIZATION_FAILED',
    );
  }

  let task = await taskService.createTask({
    tenantId: tid,
    tx,
    taskKind: 'review',
    title: `Unclaimed body custody follow-up: death record #${id}`,
    description: 'Body received into mortuary custody without a claimant or release plan.',
    relatedResourceType: 'death_record',
    relatedResourceId: String(id),
    priority: 'high',
    assignedToRole: 'MEDICAL_RECORDS',
    createdBy: actorUid || null,
    ...(slaPolicyMissing ? { slaCompletionSemantics: 'none' } : {
      workflowSlaInstanceId: sla.id,
      slaCompletionSemantics: 'domain_evidence',
    }),
    metadata: {
      source: 'mortuary_body_custody',
      ...(slaPolicyMissing
        ? {
            sla_key: UNCLAIMED_SLA_KEY,
            requested_sla_key: UNCLAIMED_SLA_KEY,
            sla_policy_status: 'missing',
          }
        : { sla_key: UNCLAIMED_SLA_KEY }),
    },
    onConflictResourceDoNothing: true,
  });
  if (!task?.id) {
    const existing = await tx.$queryRawUnsafe(
      `SELECT id, workflow_sla_instance_id, sla_completion_semantics, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'death_record'
          AND related_resource_id = $2::text
          AND status IN ('open', 'in_progress', 'blocked', 'overdue')
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE`,
      tid,
      String(id),
    );
    task = existing[0] || null;
    const existingMatchesPolicy = slaPolicyMissing
      ? (
          task?.sla_completion_semantics === 'none'
          && !task?.workflow_sla_instance_id
          && task?.metadata?.requested_sla_key === UNCLAIMED_SLA_KEY
          && task?.metadata?.sla_policy_status === 'missing'
        )
      : (
          task?.sla_completion_semantics === 'domain_evidence'
          && String(task?.workflow_sla_instance_id || '') === String(sla.id)
        );
    if (!task?.id || !existingMatchesPolicy) {
      throw AppError.conflict(
        'Mortuary unclaimed-body task could not be materialized for the resolved SLA policy',
        'MORTUARY_TASK_MATERIALIZATION_FAILED',
      );
    }
  }
  return task;
}

async function completeUnclaimedBodyTask({
  tenantId, deathRecordId, evidenceEventId, actorUid = null, tx = null,
}) {
  const tid = tenantOr(tenantId);
  const db = tx || prisma;
  const rows = await db.$queryRawUnsafe(
    `SELECT task.id, task.status, task.workflow_sla_instance_id,
            task.sla_completion_semantics
       FROM tasks task
       LEFT JOIN workflow_sla_instances sla
         ON sla.tenant_id = task.tenant_id
        AND sla.id = task.workflow_sla_instance_id
      WHERE task.tenant_id = $1::uuid
        AND task.related_resource_type = 'death_record'
        AND task.related_resource_id = $2
        AND task.status NOT IN ('completed', 'cancelled')
        AND (
          (
            task.sla_completion_semantics = 'domain_evidence'
            AND sla.rule_code = $3
          )
          OR (
            task.sla_completion_semantics = 'none'
            AND task.workflow_sla_instance_id IS NULL
            AND (
              task.metadata->>'sla_key' = $3
              OR (
                task.metadata->>'requested_sla_key' = $3
                AND task.metadata->>'sla_policy_status' = 'missing'
              )
            )
          )
        )
      ORDER BY task.id ASC`,
    tid,
    String(normalizePositiveInt(deathRecordId, 'death_record_id')),
    UNCLAIMED_SLA_KEY,
  );
  for (const task of rows) {
    if (task.sla_completion_semantics === 'domain_evidence' && task.workflow_sla_instance_id) {
      await taskService.completeTaskFromDomainEvidence({
        tenantId: tid,
        id: task.id,
        evidenceKind: 'mortuary_body_release',
        evidenceResourceType: 'body_custody_event',
        evidenceResourceId: evidenceEventId,
        actorUid,
        tx,
      });
      continue;
    }
    let current = task;
    let lastConflict = null;
    for (let attempt = 0; attempt < TASK_ADVANCE_ATTEMPTS; attempt += 1) {
      if (TASK_TERMINAL_STATUSES.has(current.status)) break;
      const nextStatus = current.status === 'blocked'
        ? 'in_progress'
        : (TASK_COMPLETABLE_STATUSES.has(current.status) ? 'completed' : null);
      if (!nextStatus) break;
      try {
        current = await taskService.transitionTask({
          tenantId: tid,
          id: task.id,
          nextStatus,
          tx,
        });
        lastConflict = null;
      } catch (err) {
        if (!['INVALID_STATE_TRANSITION', 'TASK_TRANSITION_CONFLICT'].includes(err?.code)) throw err;
        if (err.code === 'TASK_TRANSITION_CONFLICT') lastConflict = err;
        current = await taskService.getTask({ tenantId: tid, id: task.id, tx });
      }
    }
    if (!TASK_TERMINAL_STATUSES.has(current.status)) {
      throw lastConflict || AppError.conflict(
        'Unclaimed-body task could not reach a terminal status',
        'TASK_COMPLETION_CONFLICT',
      );
    }
  }
  return rows.length;
}

export async function createDeathRecord({ tenantId, ...body }) {
  if (!body.patient_uid) throw AppError.badRequest('patient_uid required');
  if (!body.date_of_death) throw AppError.badRequest('date_of_death required');
  if (!body.time_of_death) throw AppError.badRequest('time_of_death required');
  if (!body.cause_part_1a) throw AppError.badRequest('cause_part_1a required (immediate cause)');
  await assertPatientInTenant(tenantId, body.patient_uid);
  if (body.admission_id) {
    await assertAdmissionInTenant(tenantId, body.admission_id, body.patient_uid);
  }

  const place = body.place_of_death || 'inpatient';
  if (!VALID_PLACES.includes(place)) {
    throw AppError.badRequest(`place_of_death must be one of: ${VALID_PLACES.join(', ')}`);
  }
  const manner = body.manner_of_death || 'natural';
  if (!VALID_MANNERS.includes(manner)) {
    throw AppError.badRequest(`manner_of_death must be one of: ${VALID_MANNERS.join(', ')}`);
  }

  // Auto-flag medicolegal for accident/suicide/homicide/undetermined.
  const autoMedicolegal = ['accident', 'suicide', 'homicide', 'undetermined'].includes(manner);
  const isMedicolegal = body.is_medicolegal != null
    ? Boolean(body.is_medicolegal)
    : autoMedicolegal;

  const sql = `
    INSERT INTO death_records
      (patient_uid, admission_id, date_of_death, time_of_death,
       place_of_death, ward_or_unit,
       cause_part_1a, icd10_part_1a, cause_part_1b, icd10_part_1b,
       cause_part_1c, icd10_part_1c, cause_part_2, icd10_part_2,
       manner_of_death,
       was_pregnancy_related, pregnancy_stage,
       was_postsurgery, surgery_within_30d,
       is_medicolegal, police_station, police_fir_no,
       postmortem_required,
       status, notes, tenant_id)
    VALUES ($1, $2, $3::date, $4::time,
            COALESCE($5, 'inpatient'), $6,
            $7, $8, $9, $10, $11, $12, $13, $14,
            COALESCE($15, 'natural'),
            COALESCE($16, false), $17,
            COALESCE($18, false), COALESCE($19, false),
            $20, $21, $22, COALESCE($23, false),
            'pending', $24, $25)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    body.patient_uid, body.admission_id || null,
    body.date_of_death, body.time_of_death,
    place, body.ward_or_unit || null,
    body.cause_part_1a, body.icd10_part_1a || null,
    body.cause_part_1b || null, body.icd10_part_1b || null,
    body.cause_part_1c || null, body.icd10_part_1c || null,
    body.cause_part_2 || null, body.icd10_part_2 || null,
    manner,
    Boolean(body.was_pregnancy_related), body.pregnancy_stage || null,
    Boolean(body.was_postsurgery), Boolean(body.surgery_within_30d),
    isMedicolegal, body.police_station || null, body.police_fir_no || null,
    Boolean(body.postmortem_required),
    body.notes || null, tenantOr(tenantId));
  return unwrap(rows);
}

export async function listDeathRecords({ tenantId, status, from, to, is_medicolegal, limit = 100 }) {
  const conds = ['tenant_id = $1::uuid'];
  const args = [tenantOr(tenantId)];
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  if (from) { args.push(from); conds.push(`date_of_death >= $${args.length}::date`); }
  if (to) { args.push(to); conds.push(`date_of_death <= $${args.length}::date`); }
  if (is_medicolegal != null) {
    args.push(is_medicolegal === 'true' || is_medicolegal === true);
    conds.push(`is_medicolegal = $${args.length}`);
  }
  const lim = Math.min(parseInt(limit, 10) || 100, 500);
  const sql = `
    SELECT * FROM death_records
    WHERE ${conds.join(' AND ')}
    ORDER BY date_of_death DESC, time_of_death DESC
    LIMIT ${lim}`;
  return prisma.$queryRawUnsafe(sql, ...args);
}

export async function getDeathRecord({ tenantId, id }) {
  const recRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM death_records WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(id, 10), tenantOr(tenantId));
  const rec = unwrap(recRows);
  if (!rec) throw AppError.notFound('Death record not found');

  const reviewRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM mortality_reviews
      WHERE death_record_id = $1 AND tenant_id = $2::uuid
      ORDER BY review_date DESC`,
    rec.id, tenantOr(tenantId));
  return { ...rec, reviews: reviewRows };
}

export async function transition({ tenantId, id, to_status, certified_by, certifier_name, registration_no, ack_no }) {
  const recRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM death_records WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
    parseInt(id, 10), tenantOr(tenantId));
  const rec = unwrap(recRows);
  if (!rec) throw AppError.notFound('Death record not found');

  const allowed = STATUS_TRANSITIONS[rec.status] || [];
  if (!allowed.includes(to_status)) {
    throw AppError.invalidTransition(rec.status, to_status, allowed);
  }

  if (to_status === 'certified') {
    const errs = validateForCertification(rec);
    if (errs.length > 0) {
      throw AppError.badRequest(`Cannot certify: ${errs.join('; ')}`);
    }
    if (!certified_by || !certifier_name || !registration_no) {
      throw AppError.badRequest('certified_by + certifier_name + registration_no required');
    }
    // Auto-issue MCCD serial when certifying for the first time.
    const year = new Date(rec.date_of_death).getFullYear();
    const serial = rec.mccd_serial || await nextSerial(tenantOr(tenantId), year);

    const sql = `
      UPDATE death_records
      SET status = 'certified',
          mccd_serial = $1,
          certified_by = $2,
          certified_by_name = $3,
          certifier_registration_no = $4,
          certified_at = NOW(),
          updated_at = NOW()
      WHERE id = $5 AND tenant_id = $6::uuid
      RETURNING *`;
    const rows = await prisma.$queryRawUnsafe(sql,
      serial, certified_by, certifier_name, registration_no,
      rec.id, tenantOr(tenantId));
    return unwrap(rows);
  }

  if (to_status === 'registered') {
    if (!ack_no) throw AppError.badRequest('Registrar acknowledgement no. required');
    const sql = `
      UPDATE death_records
      SET status = 'registered',
          registrar_acknowledgement_no = $1,
          registered_at = NOW(),
          updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3::uuid
      RETURNING *`;
    const rows = await prisma.$queryRawUnsafe(sql, ack_no, rec.id, tenantOr(tenantId));
    return unwrap(rows);
  }

  // generic
  const sql = `
    UPDATE death_records
    SET status = $1, updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql, to_status, rec.id, tenantOr(tenantId));
  return unwrap(rows);
}

async function recordBodyReleaseWithDb(db, { tenantId, id, ...body }) {
  if (!body.body_released_to_name) throw AppError.badRequest('body_released_to_name required');
  if (!body.body_released_to_relation) throw AppError.badRequest('body_released_to_relation required');

  // Block release if medicolegal AND no police clearance recorded.
  const recRows = await db.$queryRawUnsafe(
    `SELECT id, is_medicolegal, police_clearance_at FROM death_records
     WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(id, 10), tenantOr(tenantId));
  const rec = unwrap(recRows);
  if (!rec) throw AppError.notFound('Death record not found');
  if (rec.is_medicolegal && !rec.police_clearance_at) {
    throw AppError.badRequest('Cannot release body: medicolegal case requires police clearance first');
  }

  const sql = `
    UPDATE death_records
    SET body_released_at = NOW(),
        body_released_to_name = $1,
        body_released_to_relation = $2,
        body_released_to_id_proof = $3,
        body_release_witnessed_by = $4,
        body_release_method = COALESCE($5, 'family'),
        updated_at = NOW()
    WHERE id = $6 AND tenant_id = $7::uuid
    RETURNING *`;
  const rows = await db.$queryRawUnsafe(sql,
    body.body_released_to_name, body.body_released_to_relation,
    body.body_released_to_id_proof || null,
    body.body_release_witnessed_by || null,
    body.body_release_method || null,
    rec.id, tenantOr(tenantId));
  return unwrap(rows);
}

async function assertLegacyBodyReleaseHasNoCustodyRail(tx, tenantId, deathRecordId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT
       EXISTS (
         SELECT 1
           FROM body_custody_events event
          WHERE event.tenant_id = $1::uuid
            AND event.death_record_id = $2::int
       ) AS has_custody,
       EXISTS (
         SELECT 1
           FROM tasks task
           LEFT JOIN workflow_sla_instances linked_sla
            ON linked_sla.tenant_id = task.tenant_id
            AND linked_sla.id = task.workflow_sla_instance_id
          WHERE task.tenant_id = $1::uuid
            AND task.related_resource_type = 'death_record'
            AND task.related_resource_id = ($2::int)::text
            AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
            AND (
              linked_sla.rule_code = $3::text
              OR task.metadata->>'sla_key' = $3::text
              OR (
                task.metadata->>'requested_sla_key' = $3::text
                AND task.metadata->>'sla_policy_status' = 'missing'
              )
            )
       ) AS has_unclaimed_task,
       EXISTS (
         SELECT 1
           FROM workflow_sla_instances sla
          WHERE sla.tenant_id = $1::uuid
            AND sla.rule_code = $3::text
            AND sla.source_table = 'death_records'
            AND sla.source_id = ($2::int)::text
            AND sla.completed_at IS NULL
            AND sla.status IN ('active', 'breached', 'escalated')
       ) AS has_unclaimed_sla`,
    tenantId,
    deathRecordId,
    UNCLAIMED_SLA_KEY,
  );
  const rail = unwrap(rows);
  if (rail?.has_custody || rail?.has_unclaimed_task || rail?.has_unclaimed_sla) {
    throw AppError.conflict(
      'Body has an active mortuary custody obligation; use the custody release workflow',
      'MORTUARY_CUSTODY_RELEASE_REQUIRED',
    );
  }
}

export async function recordBodyRelease({ tenantId, id, ...body }) {
  const tid = tenantOr(tenantId);
  const deathRecordId = normalizePositiveInt(id, 'death_record_id');
  return setTenantTx(tid, async (tx) => {
    await assertDeathRecordForCustody(tx, tid, deathRecordId, { forUpdate: true });
    await assertLegacyBodyReleaseHasNoCustodyRail(tx, tid, deathRecordId);
    return recordBodyReleaseWithDb(tx, { tenantId: tid, id: deathRecordId, ...body });
  });
}

export async function recordPoliceClearance({ tenantId, id, fir_no, station }) {
  const sql = `
    UPDATE death_records
    SET police_clearance_at = NOW(),
        police_fir_no = COALESCE($1, police_fir_no),
        police_station = COALESCE($2, police_station),
        updated_at = NOW()
    WHERE id = $3 AND tenant_id = $4::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    fir_no || null, station || null,
    parseInt(id, 10), tenantOr(tenantId));
  const r = unwrap(rows);
  if (!r) throw AppError.notFound('Death record not found');
  return r;
}

// -- Mortuary custody -------------------------------------------------------

export async function createMortuarySlot({ tenantId, slot_code, display_name, location_id, status = 'available', notes }) {
  const code = cleanText(slot_code, 80);
  if (!code) throw AppError.badRequest('slot_code required');
  const cleanStatus = normalizeSlotStatus(status);
  if (cleanStatus === 'occupied') {
    throw AppError.badRequest('New mortuary slots cannot start occupied');
  }
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO mortuary_slots
         (tenant_id, slot_code, display_name, location_id, status, notes)
       VALUES ($1::uuid, $2, $3, $4::int, $5, $6)
       ON CONFLICT (tenant_id, slot_code) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         location_id = EXCLUDED.location_id,
         status = CASE
           WHEN mortuary_slots.status = 'occupied' THEN mortuary_slots.status
           ELSE EXCLUDED.status
         END,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      tenantOr(tenantId),
      code,
      cleanText(display_name, 160) || code,
      location_id ? normalizePositiveInt(location_id, 'location_id') : null,
      cleanStatus,
      cleanText(notes),
    );
    return unwrap(rows);
  });
}

export async function listMortuarySlots({ tenantId, status = null, limit = 200 } = {}) {
  const lim = normalizeLimit(limit, 200, 500);
  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const params = [tenantOr(tenantId)];
    const filters = ['s.tenant_id = $1::uuid'];
    if (status) {
      params.push(normalizeSlotStatus(status, null));
      filters.push(`s.status = $${params.length}`);
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT s.*,
              l.display_name AS location_name,
              d.patient_uid AS current_patient_uid,
              d.mccd_serial AS current_mccd_serial,
              d.date_of_death AS current_date_of_death,
              d.time_of_death AS current_time_of_death
         FROM mortuary_slots s
         LEFT JOIN facility_locations l
           ON l.id = s.location_id AND l.tenant_id = s.tenant_id
         LEFT JOIN death_records d
           ON d.id = s.current_death_record_id AND d.tenant_id = s.tenant_id
        WHERE ${filters.join(' AND ')}
        ORDER BY s.slot_code ASC
        LIMIT $${params.length + 1}::int`,
      ...params,
      lim,
    );
    return rows;
  });
}

export async function recordBodyReceive({ tenantId, id, ...body }) {
  const tid = tenantOr(tenantId);
  const deathRecordId = normalizePositiveInt(id, 'death_record_id');
  return setTenantTx(tid, async (tx) => {
    const rec = await assertDeathRecordForCustody(tx, tid, deathRecordId, { forUpdate: true });
    if (rec.body_released_at) throw AppError.badRequest('Body is already released');
    const latest = await latestCustodyEvent(tx, tid, deathRecordId);
    if (latest && latest.event_type !== 'release') {
      throw AppError.badRequest('Body is already in mortuary custody');
    }
    const event = await insertCustodyEvent(tx, tid, deathRecordId, 'receive', body);
    if (event.is_unclaimed) {
      await queueUnclaimedBodyTask({
        tenantId: tid,
        deathRecordId,
        actorUid: body.performed_by || null,
        tx,
      });
    }
    return event;
  });
}

export async function recordBodyStorage({ tenantId, id, slot_id, ...body }) {
  const tid = tenantOr(tenantId);
  const deathRecordId = normalizePositiveInt(id, 'death_record_id');
  const slotId = normalizePositiveBigInt(slot_id, 'slot_id');
  return setTenantTx(tid, async (tx) => {
    const rec = await assertDeathRecordForCustody(tx, tid, deathRecordId, { forUpdate: true });
    if (rec.body_released_at) throw AppError.badRequest('Body is already released');

    const latest = await latestCustodyEvent(tx, tid, deathRecordId);
    if (!latest) throw AppError.badRequest('Body must be received before storage');
    if (latest.event_type === 'release') throw AppError.badRequest('Body is already released');

    const slotRows = await tx.$queryRawUnsafe(
      `SELECT id, status, current_death_record_id
         FROM mortuary_slots
        WHERE id = $1::bigint AND tenant_id = $2::uuid
        FOR UPDATE`,
      slotId,
      tid,
    );
    const slot = unwrap(slotRows);
    if (!slot) throw AppError.notFound('Mortuary slot not found');
    if (slot.status !== 'available' && Number(slot.current_death_record_id) !== deathRecordId) {
      throw AppError.badRequest('Mortuary slot is not available');
    }

    const otherSlotRows = await tx.$queryRawUnsafe(
      `SELECT id, slot_code
         FROM mortuary_slots
        WHERE tenant_id = $1::uuid
          AND current_death_record_id = $2::int
          AND id <> $3::bigint
        LIMIT 1`,
      tid,
      deathRecordId,
      slotId,
    );
    if (unwrap(otherSlotRows)) throw AppError.badRequest('Body is already stored in another slot');

    await tx.$executeRawUnsafe(
      `UPDATE mortuary_slots
          SET status = 'occupied',
              current_death_record_id = $1::int,
              occupied_since = COALESCE(occupied_since, NOW()),
              updated_at = NOW()
        WHERE id = $2::bigint AND tenant_id = $3::uuid`,
      deathRecordId,
      slotId,
      tid,
    );

    return insertCustodyEvent(tx, tid, deathRecordId, 'store', {
      ...body,
      slot_id: slotId,
      is_unclaimed: body.is_unclaimed ?? latest.is_unclaimed,
    });
  });
}

export async function recordMortuaryBodyRelease({ tenantId, id, ...body }) {
  const tid = tenantOr(tenantId);
  const deathRecordId = normalizePositiveInt(id, 'death_record_id');
  const releaseMethod = body.release_method || body.body_release_method || 'family';

  return setTenantTx(tid, async (tx) => {
    const rec = await assertDeathRecordForCustody(tx, tid, deathRecordId, { forUpdate: true });
    if (rec.body_released_at) throw AppError.badRequest('Body is already released');

    const activeSlotRows = await tx.$queryRawUnsafe(
      `SELECT id
         FROM mortuary_slots
        WHERE tenant_id = $1::uuid
          AND current_death_record_id = $2::int
        FOR UPDATE`,
      tid,
      deathRecordId,
    );
    const activeSlot = unwrap(activeSlotRows);

    const released = await recordBodyReleaseWithDb(tx, {
      tenantId: tid,
      id: deathRecordId,
      body_released_to_name: body.body_released_to_name || body.claimant_name,
      body_released_to_relation: body.body_released_to_relation || body.claimant_relation,
      body_released_to_id_proof: body.body_released_to_id_proof || body.witness_id_proof,
      body_release_witnessed_by: body.body_release_witnessed_by || body.performed_by,
      body_release_method: releaseMethod,
    });

    if (activeSlot) {
      await tx.$executeRawUnsafe(
        `UPDATE mortuary_slots
            SET status = 'available',
                current_death_record_id = NULL,
                occupied_since = NULL,
                updated_at = NOW()
          WHERE id = $1::bigint AND tenant_id = $2::uuid`,
        activeSlot.id,
        tid,
      );
    }

    const event = await insertCustodyEvent(tx, tid, deathRecordId, 'release', {
      ...body,
      slot_id: activeSlot?.id || null,
      release_method: releaseMethod,
      claimant_name: body.claimant_name || body.body_released_to_name,
      claimant_relation: body.claimant_relation || body.body_released_to_relation,
      is_unclaimed: releaseMethod === 'unclaimed_to_municipality',
    });
    await completeUnclaimedBodyTask({
      tenantId: tid,
      deathRecordId,
      evidenceEventId: event.id,
      actorUid: body.performed_by || null,
      tx,
    });
    return { death_record: released, custody_event: event };
  });
}

export async function getBodyCustodyChain({ tenantId, id }) {
  const tid = tenantOr(tenantId);
  const deathRecordId = normalizePositiveInt(id, 'death_record_id');
  return setTenantTx(tid, async (tx) => {
    const rec = await assertDeathRecordForCustody(tx, tid, deathRecordId);
    const events = await tx.$queryRawUnsafe(
      `SELECT e.*, s.slot_code, s.display_name AS slot_name
         FROM body_custody_events e
         LEFT JOIN mortuary_slots s
           ON s.id = e.slot_id AND s.tenant_id = e.tenant_id
        WHERE e.tenant_id = $1::uuid AND e.death_record_id = $2::int
        ORDER BY e.event_at ASC, e.id ASC`,
      tid,
      deathRecordId,
    );
    return { death_record: rec, events };
  });
}

export async function mortuaryBoard({ tenantId }) {
  const tid = tenantOr(tenantId);
  return setTenantTx(tid, async (tx) => {
    const slots = await tx.$queryRawUnsafe(
      `SELECT s.*, l.display_name AS location_name,
              d.patient_uid AS current_patient_uid,
              d.mccd_serial AS current_mccd_serial,
              d.date_of_death AS current_date_of_death,
              d.time_of_death AS current_time_of_death
         FROM mortuary_slots s
         LEFT JOIN facility_locations l
           ON l.id = s.location_id AND l.tenant_id = s.tenant_id
         LEFT JOIN death_records d
           ON d.id = s.current_death_record_id AND d.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1::uuid
        ORDER BY s.slot_code ASC`,
      tid,
    );
    const occupancyRows = await tx.$queryRawUnsafe(
      `SELECT status, COUNT(*)::int AS count
         FROM mortuary_slots
        WHERE tenant_id = $1::uuid
        GROUP BY status`,
      tid,
    );
    const activeBodies = await tx.$queryRawUnsafe(
      `WITH latest AS (
         SELECT DISTINCT ON (death_record_id) *
           FROM body_custody_events
          WHERE tenant_id = $1::uuid
          ORDER BY death_record_id, event_at DESC, id DESC
       )
       SELECT d.id AS death_record_id, d.patient_uid, d.mccd_serial,
              d.date_of_death, d.time_of_death, d.is_medicolegal,
              d.police_clearance_at, d.body_released_at,
              latest.event_type AS latest_event_type,
              latest.event_at AS latest_event_at,
              latest.is_unclaimed,
              latest.unclaimed_reason,
              s.id AS slot_id, s.slot_code, s.display_name AS slot_name,
              task.id AS unclaimed_task_id, task.status AS unclaimed_task_status,
              sla.id AS unclaimed_sla_id, sla.status AS unclaimed_sla_status,
              sla.due_at AS unclaimed_due_at
         FROM latest
         JOIN death_records d
           ON d.id = latest.death_record_id AND d.tenant_id = latest.tenant_id
         LEFT JOIN mortuary_slots s
           ON s.current_death_record_id = d.id AND s.tenant_id = d.tenant_id
          LEFT JOIN tasks task
            ON task.tenant_id = d.tenant_id
           AND task.related_resource_type = 'death_record'
           AND task.related_resource_id = d.id::text
           AND task.status NOT IN ('completed', 'cancelled')
           AND (
             (
               task.sla_completion_semantics = 'domain_evidence'
               AND EXISTS (
                 SELECT 1
                   FROM workflow_sla_instances linked_sla
                  WHERE linked_sla.tenant_id = task.tenant_id
                    AND linked_sla.id = task.workflow_sla_instance_id
                    AND linked_sla.rule_code = $2
               )
             )
             OR (
               task.sla_completion_semantics = 'none'
               AND task.workflow_sla_instance_id IS NULL
               AND (
                 task.metadata->>'sla_key' = $2
                 OR (
                   task.metadata->>'requested_sla_key' = $2
                   AND task.metadata->>'sla_policy_status' = 'missing'
                 )
               )
             )
           )
         LEFT JOIN workflow_sla_instances sla
            ON sla.id = task.workflow_sla_instance_id
           AND sla.tenant_id = task.tenant_id
        WHERE d.body_released_at IS NULL
          AND latest.event_type <> 'release'
        ORDER BY latest.event_at DESC`,
      tid,
      UNCLAIMED_SLA_KEY,
    );
    return {
      occupancy: occupancyRows.reduce((acc, row) => {
        acc.total += Number(row.count || 0);
        acc[row.status] = Number(row.count || 0);
        return acc;
      }, { total: 0, available: 0, occupied: 0, cleaning: 0, maintenance: 0, retired: 0 }),
      slots,
      active_bodies: activeBodies,
      unclaimed: activeBodies.filter((row) => row.is_unclaimed),
    };
  });
}

// ── MORTALITY REVIEW ────────────────────────────────────────────────

export async function upsertReview({ tenantId, death_record_id, ...body }) {
  if (!death_record_id) throw AppError.badRequest('death_record_id required');

  // Confirm parent belongs to tenant.
  const drRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM death_records WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(death_record_id, 10), tenantOr(tenantId));
  if (!unwrap(drRows)) throw AppError.notFound('Parent death record not found');

  // Update existing or insert.
  const existingRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM mortality_reviews
      WHERE death_record_id = $1 AND tenant_id = $2::uuid`,
    parseInt(death_record_id, 10), tenantOr(tenantId));
  const existing = unwrap(existingRows);

  if (existing) {
    const sql = `
      UPDATE mortality_reviews
      SET review_date         = COALESCE($1::date, review_date),
          scheduled_for       = $2,
          preventability      = $3,
          cause_classification = $4,
          factor_disease      = COALESCE($5,  factor_disease),
          factor_communication = COALESCE($6, factor_communication),
          factor_documentation = COALESCE($7, factor_documentation),
          factor_diagnostic_delay = COALESCE($8, factor_diagnostic_delay),
          factor_treatment_delay  = COALESCE($9, factor_treatment_delay),
          factor_medication   = COALESCE($10, factor_medication),
          factor_procedural   = COALESCE($11, factor_procedural),
          factor_supervision  = COALESCE($12, factor_supervision),
          factor_resource     = COALESCE($13, factor_resource),
          factor_handover     = COALESCE($14, factor_handover),
          discussion_summary  = $15,
          learning_points     = $16,
          action_items        = $17,
          presented_by        = $18,
          presented_by_name   = $19,
          status              = COALESCE($20, status),
          updated_at = NOW()
      WHERE id = $21 AND tenant_id = $22::uuid
      RETURNING *`;
    const rows = await prisma.$queryRawUnsafe(sql,
      body.review_date || null, body.scheduled_for || null,
      body.preventability || null, body.cause_classification || null,
      body.factor_disease ?? null, body.factor_communication ?? null,
      body.factor_documentation ?? null, body.factor_diagnostic_delay ?? null,
      body.factor_treatment_delay ?? null, body.factor_medication ?? null,
      body.factor_procedural ?? null, body.factor_supervision ?? null,
      body.factor_resource ?? null, body.factor_handover ?? null,
      body.discussion_summary || null, body.learning_points || null,
      body.action_items || null,
      body.presented_by || null, body.presented_by_name || null,
      body.status || null,
      existing.id, tenantOr(tenantId));
    return unwrap(rows);
  }

  // Insert
  const sql = `
    INSERT INTO mortality_reviews
      (death_record_id, review_date, scheduled_for,
       preventability, cause_classification,
       factor_disease, factor_communication, factor_documentation,
       factor_diagnostic_delay, factor_treatment_delay,
       factor_medication, factor_procedural, factor_supervision,
       factor_resource, factor_handover,
       discussion_summary, learning_points, action_items,
       presented_by, presented_by_name, status, tenant_id)
    VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3,
            $4, $5,
            COALESCE($6,  false), COALESCE($7,  false), COALESCE($8,  false),
            COALESCE($9,  false), COALESCE($10, false),
            COALESCE($11, false), COALESCE($12, false), COALESCE($13, false),
            COALESCE($14, false), COALESCE($15, false),
            $16, $17, $18,
            $19, $20, COALESCE($21, 'draft'), $22)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    parseInt(death_record_id, 10), body.review_date || null, body.scheduled_for || null,
    body.preventability || null, body.cause_classification || null,
    body.factor_disease ?? null, body.factor_communication ?? null, body.factor_documentation ?? null,
    body.factor_diagnostic_delay ?? null, body.factor_treatment_delay ?? null,
    body.factor_medication ?? null, body.factor_procedural ?? null, body.factor_supervision ?? null,
    body.factor_resource ?? null, body.factor_handover ?? null,
    body.discussion_summary || null, body.learning_points || null, body.action_items || null,
    body.presented_by || null, body.presented_by_name || null, body.status || null,
    tenantOr(tenantId));
  return unwrap(rows);
}

export async function finaliseReview({ tenantId, id, finalised_by }) {
  const sql = `
    UPDATE mortality_reviews
    SET status = 'finalised',
        finalised_by = $1,
        finalised_at = NOW(),
        updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    finalised_by || null, parseInt(id, 10), tenantOr(tenantId));
  const r = unwrap(rows);
  if (!r) throw AppError.notFound('Review not found');
  return r;
}

export async function summary30d({ tenantId }) {
  const sql = `SELECT * FROM mortality_30d_summary WHERE tenant_id = $1::uuid`;
  const rows = await prisma.$queryRawUnsafe(sql, tenantOr(tenantId));
  return unwrap(rows) || {
    total_deaths: 0, registered_count: 0, medicolegal_count: 0,
    maternal_deaths: 0, surgical_30d_deaths: 0,
    reviews_done: 0, reviews_preventable: 0,
  };
}

// Pure helpers for unit tests
export const _internal = {
  STATUS_TRANSITIONS, validateForCertification,
  VALID_PLACES, VALID_MANNERS,
  SLOT_STATUSES, CUSTODY_EVENT_TYPES, RELEASE_METHODS,
  UNCLAIMED_SLA_KEY, validateCustodyEventInput,
};
