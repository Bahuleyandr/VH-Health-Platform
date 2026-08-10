// src/services/clinical/icuService.js — Sprint 19
//
// ICU admission, hourly flowsheet, RASS/CAM-ICU/SOFA/CPOT assessments,
// and ABCDEF daily bundles. All raw-SQL via prisma.$queryRawUnsafe with
// SPREAD args (per Phase 0.5 convention).

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { scheduleMedications } from './marService.js';
import { closeIcuDeviceAssociationsForAdmission } from './icuChartingService.js';
import { gcsTotal, netBalance, camPositive, bundleComplete, bundlePct } from './icuComputations.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  currentCanonicalTransactionRevision,
  recordCanonicalClinicalEvent,
} from './canonicalClinicalPlatformService.js';
import {
  assertIcuFlowsheetPlausibility,
  assertIcuAssessmentPlausibility,
} from '../../utils/clinical/icuPlausibility.js';

function tenantOr(t) {
  return requireTenantId(t);
}

function unwrap(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

async function assertIcuAdmissionInTenant(tenantId, icuAdmissionId) {
  const id = parseInt(icuAdmissionId, 10);
  if (!Number.isInteger(id)) throw AppError.badRequest('icu_admission_id must be numeric');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM icu_admissions WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    id,
    tenantOr(tenantId)
  );
  if (!unwrap(rows)) throw AppError.notFound('ICU admission not found');
  return id;
}

// ════════════════════════════════════════════════════════════════════
// ADMISSIONS
// ════════════════════════════════════════════════════════════════════

const VALID_CODE_STATUSES = ['full_code', 'dni', 'dnr', 'dnr_dni', 'comfort_only'];

// Canonical lifecycle emit — every ICU lifecycle write (admit, code-status
// flip, discharge/death) persists the detail row plus one
// clinical_timeline_events row and one clinical_audit_events row in the SAME
// transaction (docs/CANONICAL_CLINICAL_TIMELINE.md; re-review CLIN-3).
// recordCanonicalClinicalEvent with { db: tx } + a patientUid requires both
// halves and throws (rolling the tx back) if either write fails.
async function emitIcuLifecycleEvent(tx, {
  tenantId,
  admissionId,
  patientUid,
  eventType,
  eventStatus,
  actorUid = null,
  actorRole = null,
  summary,
  payload = {},
  beforeState = null,
  afterState = null,
  timelineKey,
  auditKey
}) {
  return recordCanonicalClinicalEvent(
    {
      tenantId,
      patientUid,
      eventType,
      eventStatus,
      sourceTable: 'icu_admissions',
      sourceId: String(admissionId),
      resourceType: 'icu_admission',
      resourceId: String(admissionId),
      actorUid,
      actorRole,
      summary,
      payload,
      beforeState,
      afterState,
      tags: ['icu'],
      timelineIdempotencyKey: timelineKey,
      auditIdempotencyKey: auditKey
    },
    { db: tx }
  );
}

export async function createAdmission({ tenantId, actorUid = null, actorRole = null, ...body }) {
  if (!body.patient_uid) throw AppError.badRequest('patient_uid required');
  if (!body.unit_code) throw AppError.badRequest('unit_code required');
  const codeStatus = body.code_status ?? 'full_code';
  if (!VALID_CODE_STATUSES.includes(codeStatus)) {
    throw AppError.badRequest('invalid code_status');
  }
  const codeStatusWasExplicit = body.code_status !== undefined && body.code_status !== null;
  const codeStatusActor = codeStatusWasExplicit ? actorUid : null;

  // E-4 — uuid columns (patient_uid, admitting_doctor_uid,
  // code_status_set_by, tenant_id) need explicit ::uuid casts. node-pg
  // types raw strings as `text` and Postgres rejects the comparison.
  // Findings:
  //   2026-05-08-emergency-walk-in-doctor-icu-admission-uuid-cast
  //   2026-05-08-emergency-walk-in-nurse-icu-flowsheet-uuid-cast
  const sql = `
    INSERT INTO icu_admissions
      (patient_uid, admission_id, unit_code, bed_no,
       admitting_doctor_uid, admitting_doctor_name,
       primary_diagnosis, reason_for_icu,
       apache_ii_score, apache_ii_at, sofa_score,
       predicted_mortality_pct, expected_los_days,
       code_status, code_status_set_at, code_status_set_by, tenant_id,
       monitoring_interval_minutes, npo_from, fasting_until, pre_op_status,
       er_visit_id)
    VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16::uuid, $17::uuid,
            $18, $19::timestamptz, $20::timestamptz, $21, $22)
    RETURNING *`;
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const rows = await tx.$queryRawUnsafe(
      sql,
      body.patient_uid,
      body.admission_id || null,
      body.unit_code,
      body.bed_no || null,
      body.admitting_doctor_uid || null,
      body.admitting_doctor_name || null,
      body.primary_diagnosis || null,
      body.reason_for_icu || null,
      body.apache_ii_score || null,
      body.apache_ii_score ? new Date() : null,
      body.sofa_score || null,
      body.predicted_mortality_pct || null,
      body.expected_los_days || null,
      codeStatus,
      codeStatusWasExplicit ? new Date() : null,
      codeStatusActor,
      tenant,
      // E-4 ICU monitoring + fasting fields (migration 184).
      body.monitoring_interval_minutes ?? 60,
      body.npo_from || null,
      body.fasting_until || null,
      body.pre_op_status || null,
      // Stage 5 — nullable link back to the ER visit this ICU admission
      // was admitted from (migration 224). Set by createAdmissionFromEr;
      // null for direct ICU admits.
      body.er_visit_id ? parseInt(body.er_visit_id, 10) : null
    );
    const row = unwrap(rows);
    // Anchor the initial order for admissions created after migration 648.
    // The migration backfills pre-existing admissions, but without this row a
    // new admission's first history entry would only appear after a later
    // flip, leaving the initial code-status order absent from its dedicated
    // append-only ledger. The authenticated actor is authoritative; a request
    // body cannot attribute the order to another user.
    await tx.$queryRawUnsafe(
      `INSERT INTO icu_code_status_history
         (tenant_id, icu_admission_id, patient_uid, previous_code_status,
          new_code_status, changed_by, changed_at)
       VALUES ($1::uuid, $2, $3::uuid, NULL, $4, $5::uuid,
               COALESCE($6::timestamptz, $7::timestamptz, NOW()))`,
      tenant,
      row.id,
      row.patient_uid,
      row.code_status,
      row.code_status_set_by || null,
      row.code_status_set_at || null,
      row.admitted_at || null
    );
    // Insert-once fixed key: the emit runs exactly once, in the tx that
    // mints the admission id.
    await emitIcuLifecycleEvent(tx, {
      tenantId: tenant,
      admissionId: row.id,
      patientUid: row.patient_uid,
      eventType: 'icu.admission_created',
      eventStatus: row.status,
      actorUid: actorUid || body.admitting_doctor_uid || null,
      actorRole,
      summary: `Admitted to ICU ${row.unit_code}${row.bed_no ? ` bed ${row.bed_no}` : ''}`,
      payload: {
        icu_admission_id: row.id,
        unit_code: row.unit_code,
        bed_no: row.bed_no || null,
        reason_for_icu: row.reason_for_icu || null,
        code_status: row.code_status || null,
        er_visit_id: row.er_visit_id || null
      },
      afterState: { status: row.status, code_status: row.code_status },
      timelineKey: `icu_admissions:${row.id}:icu.admission_created`,
      auditKey: `icu_admissions:${row.id}:audit:icu.admission_created`
    });
    return row;
  });
}

export async function listAdmissions({ tenantId, status, unit_code, limit = 100 }) {
  const conds = ['tenant_id = $1::uuid'];
  const args = [tenantOr(tenantId)];
  if (status) {
    args.push(status);
    conds.push(`status = $${args.length}`);
  }
  if (unit_code) {
    args.push(unit_code);
    conds.push(`unit_code = $${args.length}`);
  }
  const lim = Math.min(parseInt(limit, 10) || 100, 500);

  const sql = `
    SELECT * FROM icu_admissions
    WHERE ${conds.join(' AND ')}
    ORDER BY admitted_at DESC
    LIMIT ${lim}`;
  const rows = await prisma.$queryRawUnsafe(sql, ...args);
  return rows;
}

export async function getAdmission({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM icu_admissions WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(id, 10),
    tenantOr(tenantId)
  );
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('ICU admission not found');
  return withNextVitalsDue(row);
}

// Materialise next-vitals-due time off the monitoring cadence + the
// most recent flowsheet entry. Cheap one-row probe — bedside tablets
// can poll the admission detail to drive a countdown / overdue badge
// without a separate /schedule endpoint. Bedside compliance with the
// 15-min protocol is the clinical motivation (NSTEMI rescue-PCI
// window). The interval lives on the admission so the doctor / charge
// nurse can change it via PATCH /admissions/:id/monitoring-interval.
async function withNextVitalsDue(adm) {
  if (!adm || !adm.monitoring_interval_minutes) return adm;
  const last = await prisma.$queryRawUnsafe(
    `SELECT recorded_at FROM icu_flowsheet_entries
     WHERE icu_admission_id = $1
     ORDER BY recorded_at DESC LIMIT 1`,
    adm.id
  );
  const lastRow = unwrap(last);
  const interval = adm.monitoring_interval_minutes;
  const anchor = lastRow?.recorded_at
    ? new Date(lastRow.recorded_at)
    : adm.admitted_at
      ? new Date(adm.admitted_at)
      : new Date();
  const nextDue = new Date(anchor.getTime() + interval * 60_000);
  return {
    ...adm,
    last_vitals_recorded_at: lastRow?.recorded_at ?? null,
    next_vitals_due_at: nextDue.toISOString(),
    vitals_overdue: nextDue.getTime() < Date.now()
  };
}

const VALID_MONITORING_INTERVALS = [5, 10, 15, 30, 60, 120, 240, 480];

export async function updateMonitoringInterval({ tenantId, id, monitoring_interval_minutes }) {
  const minutes = parseInt(monitoring_interval_minutes, 10);
  if (!VALID_MONITORING_INTERVALS.includes(minutes)) {
    throw AppError.badRequest(
      `monitoring_interval_minutes must be one of ${VALID_MONITORING_INTERVALS.join(', ')}`
    );
  }
  const sql = `
    UPDATE icu_admissions
    SET monitoring_interval_minutes = $1,
        updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql, minutes, parseInt(id, 10), tenantOr(tenantId));
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('ICU admission not found');
  return withNextVitalsDue(row);
}

export async function updateAdmissionCodeStatus({ tenantId, id, code_status, set_by, actorRole = null }) {
  if (!VALID_CODE_STATUSES.includes(code_status)) {
    throw AppError.badRequest('invalid code_status');
  }
  const admissionId = parseInt(id, 10);
  if (!Number.isInteger(admissionId)) throw AppError.badRequest('icu admission id must be numeric');
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, code_status FROM icu_admissions
        WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
      admissionId,
      tenant
    );
    const current = unwrap(currentRows);
    if (!current) throw AppError.notFound('ICU admission not found');

    // Effective-state no-op guard under the FOR UPDATE lock: an exact retry
    // returns before any write, so no duplicate history row or canonical
    // revision is minted (docs/CANONICAL_CLINICAL_TIMELINE.md).
    if (current.code_status === code_status) {
      const rows = await tx.$queryRawUnsafe(
        `SELECT * FROM icu_admissions WHERE id = $1 AND tenant_id = $2::uuid`,
        admissionId,
        tenant
      );
      return unwrap(rows);
    }

    const rows = await tx.$queryRawUnsafe(
      `UPDATE icu_admissions
       SET code_status = $1, code_status_set_at = NOW(), code_status_set_by = $2,
           updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4::uuid
       RETURNING *`,
      code_status,
      set_by || null,
      admissionId,
      tenant
    );
    const row = unwrap(rows);

    // Append-only code-status history (migration 648) — DNR/code-status flips
    // were previously overwritten in place with no trace of the prior order.
    await tx.$queryRawUnsafe(
      `INSERT INTO icu_code_status_history
         (tenant_id, icu_admission_id, patient_uid, previous_code_status, new_code_status, changed_by)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid)`,
      tenant,
      admissionId,
      row.patient_uid,
      current.code_status || null,
      code_status,
      set_by || null
    );

    // Code status is amendable (a DNR can be reversed and re-ordered), so the
    // canonical key needs the tx-revision suffix — a fixed key would silently
    // absorb the third revision of an A->B->A sequence.
    const revision = await currentCanonicalTransactionRevision(tx);
    await emitIcuLifecycleEvent(tx, {
      tenantId: tenant,
      admissionId,
      patientUid: row.patient_uid,
      eventType: 'icu.code_status_changed',
      eventStatus: code_status,
      actorUid: set_by || null,
      actorRole,
      summary: `ICU code status changed from ${current.code_status || 'unset'} to ${code_status}`,
      payload: {
        icu_admission_id: admissionId,
        previous_code_status: current.code_status || null,
        code_status
      },
      beforeState: { code_status: current.code_status || null },
      afterState: { code_status },
      timelineKey: `icu_admissions:${admissionId}:code_status:${code_status}:tx:${revision}`,
      auditKey: `icu_admissions:${admissionId}:audit:code_status:${code_status}:tx:${revision}`
    });
    return row;
  });
}

// Update the pre-op / fasting fields on a live ICU admission. NPO orders
// are placed *after* admit (e.g. when a cath-lab pre-op NPO is ordered at
// T+30min), and the only earlier mutators were code-status and
// monitoring-interval — there was no path to change npo_from /
// fasting_until / pre_op_status without deleting and re-creating the
// admission (which would orphan every FKed flowsheet entry). Partial
// update: an omitted field (`undefined`) is left untouched; an explicit
// `null` clears the column (NPO order cancelled). Finding:
// 2026-05-09-emergency-walk-in-nurse-icu-no-npo-patch-route.
export async function updateAdmissionFasting({
  tenantId,
  id,
  npo_from,
  fasting_until,
  pre_op_status
}) {
  const sets = [];
  const args = [];
  if (npo_from !== undefined) {
    args.push(npo_from || null);
    sets.push(`npo_from = $${args.length}::timestamptz`);
  }
  if (fasting_until !== undefined) {
    args.push(fasting_until || null);
    sets.push(`fasting_until = $${args.length}::timestamptz`);
  }
  if (pre_op_status !== undefined) {
    args.push(pre_op_status || null);
    sets.push(`pre_op_status = $${args.length}`);
  }
  if (!sets.length) {
    throw AppError.badRequest(
      'At least one of npo_from, fasting_until, pre_op_status must be provided'
    );
  }
  args.push(parseInt(id, 10));
  args.push(tenantOr(tenantId));
  const sql = `
    UPDATE icu_admissions
    SET ${sets.join(', ')}, updated_at = NOW()
    WHERE id = $${args.length - 1} AND tenant_id = $${args.length}::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql, ...args);
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('ICU admission not found');
  return withNextVitalsDue(row);
}

const VALID_DISCHARGE_DISPOSITIONS = ['ward', 'step_down', 'home', 'expired', 'transferred_out'];

export async function dischargeAdmission({
  tenantId,
  id,
  disposition,
  outcome_notes,
  actorUid = null,
  actorRole = null
}) {
  if (!VALID_DISCHARGE_DISPOSITIONS.includes(disposition)) {
    throw AppError.badRequest(
      `disposition must be one of ${VALID_DISCHARGE_DISPOSITIONS.join(', ')}`
    );
  }
  const admissionId = parseInt(id, 10);
  if (!Number.isInteger(admissionId)) throw AppError.badRequest('icu admission id must be numeric');
  const tenant = tenantOr(tenantId);
  return setTenantTx(tenant, async tx => {
    // State guard (re-review CLIN-4): only an active admission can be
    // discharged. Previously a repeat discharge silently re-stamped
    // discharged_at / disposition on an already-closed admission.
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, status, patient_uid FROM icu_admissions
        WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
      admissionId,
      tenant
    );
    const current = unwrap(currentRows);
    if (!current) throw AppError.notFound('ICU admission not found');
    if (current.status !== 'active') {
      throw AppError.conflict(
        `ICU admission is already ${current.status} — only an active admission can be discharged`,
        'ICU_ADMISSION_NOT_ACTIVE',
        { status: current.status }
      );
    }

    const sql = `
      UPDATE icu_admissions
      SET status = CASE WHEN $1 = 'expired' THEN 'expired'
                         WHEN $1 = 'transferred_out' THEN 'transferred'
                         ELSE 'discharged' END,
          discharged_at = NOW(),
          discharge_disposition = $1,
          outcome_notes = $2,
          updated_at = NOW()
      WHERE id = $3 AND tenant_id = $4::uuid AND status = 'active'
      RETURNING *`;
    const rows = await tx.$queryRawUnsafe(
      sql,
      disposition,
      outcome_notes || null,
      admissionId,
      tenant
    );
    const row = unwrap(rows);
    if (!row) throw AppError.notFound('ICU admission not found');
    await closeIcuDeviceAssociationsForAdmission({
      tx,
      tenantId,
      icuAdmissionId: row.id,
      actorUid,
      reason: disposition === 'transferred_out' ? 'transfer' : 'discharge',
      stoppedAt: row.discharged_at
    });
    // Insert-once fixed key: the active->closed transition is one-way (the
    // state guard above blocks re-discharge), so this emit runs at most once
    // per admission. An ICU death is a distinct timeline event type.
    await emitIcuLifecycleEvent(tx, {
      tenantId: tenant,
      admissionId,
      patientUid: row.patient_uid,
      eventType: disposition === 'expired' ? 'icu.death_recorded' : 'icu.discharged',
      eventStatus: row.status,
      actorUid,
      actorRole,
      summary: disposition === 'expired'
        ? `Patient expired in ICU ${row.unit_code}`
        : `Discharged from ICU ${row.unit_code} (${disposition})`,
      payload: {
        icu_admission_id: admissionId,
        unit_code: row.unit_code,
        discharge_disposition: disposition,
        outcome_notes: outcome_notes || null
      },
      beforeState: { status: 'active' },
      afterState: { status: row.status, discharge_disposition: disposition },
      timelineKey: `icu_admissions:${admissionId}:icu.discharged`,
      auditKey: `icu_admissions:${admissionId}:audit:icu.discharged`
    });
    return row;
  });
}

// Carry the ER visit's active medication orders into the ICU MAR so the
// receiving nurse can confirm "ER drugs given" without a phone handover.
// medication_administrations is patient-keyed, so an ER order placed
// through /emr/orders already scheduled its MAR row — but scheduleMedications
// is idempotent (it dedups on patient + medication + scheduled_time), so
// re-running this on admission is safe and also picks up any ER medication
// order that never reached the MAR. Finding:
// 2026-05-08-emergency-walk-in-nurse-no-fasting-no-io-no-mar-handoff.
async function carryErMedicationsToMar(visit) {
  if (!visit?.encounter_id || !visit?.patient_uid) return [];
  const orders = await prisma.clinical_orders.findMany({
    where: {
      encounter_id: visit.encounter_id,
      order_type: 'medication',
      status: { notIn: ['cancelled', 'discontinued'] }
    },
    select: { id: true, details: true, start_date: true, created_at: true }
  });
  const meds = [];
  for (const order of orders) {
    const d = typeof order.details === 'string' ? JSON.parse(order.details) : order.details || {};
    const medication_name = d.medication_name || d.drug_name;
    const dose = d.dose || d.dosage;
    const route = d.route;
    // scheduleMedications requires name + dose + route; skip ER orders
    // that were filed without a chartable shape rather than 400 the whole
    // carry-over.
    if (!medication_name || !dose || !route) continue;
    const when = order.start_date || order.created_at || new Date();
    meds.push({
      medication_name,
      dose,
      route,
      scheduled_time: new Date(when).toISOString(),
      notes: 'Carried over from ER visit on ICU admission'
    });
  }
  if (!meds.length) return [];
  return scheduleMedications(visit.patient_uid, null, meds);
}

// "Admit from ER" — create an ICU admission that inherits the ER visit's
// patient context and links back to it via er_visit_id, instead of a
// standalone row keyed only by patient_uid. The ER episode (triage, ER
// orders, results) stays reachable through emergency_visits.id for PHI
// audit, TPA pre-auth packets, and clinical handover. Active ER
// medication orders are carried into the ICU MAR (best-effort). Findings:
//   2026-05-08-emergency-walk-in-doctor-er-to-icu-no-continuation
//   2026-05-08-emergency-walk-in-nurse-no-fasting-no-io-no-mar-handoff
export async function createAdmissionFromEr({ tenantId, emergencyVisitId, ...body }) {
  const visitId = parseInt(emergencyVisitId, 10);
  if (!Number.isInteger(visitId)) {
    throw AppError.badRequest('A numeric emergency visit id is required');
  }

  // Phase 0 — pre-flight on plain prisma: the ER visit must exist and
  // carry a registered patient before it can be admitted to ICU.
  const visitRows = await prisma.$queryRawUnsafe(
    `SELECT id, encounter_id, patient_uid, chief_complaint, attending_doctor_uid
       FROM emergency_visits
      WHERE id = $1 AND tenant_id = $2::uuid`,
    visitId,
    tenantOr(tenantId)
  );
  const visit = unwrap(visitRows);
  if (!visit) throw AppError.notFound('Emergency visit not found');
  if (!visit.patient_uid) {
    throw AppError.badRequest(
      'Emergency visit has no registered patient — register the patient before ICU admission'
    );
  }

  // ER context pre-fills; an explicit value in the request body wins.
  // patient_uid and er_visit_id are authoritative from the ER visit and
  // cannot be overridden by the body.
  const admission = await createAdmission({
    tenantId,
    ...body,
    patient_uid: visit.patient_uid,
    er_visit_id: visit.id,
    reason_for_icu: body.reason_for_icu || visit.chief_complaint || null,
    admitting_doctor_uid: body.admitting_doctor_uid || visit.attending_doctor_uid || null
  });

  // Phase 1.5 — best-effort MAR carry-over. A handoff failure must not
  // block the admission itself.
  let carried_mar = [];
  try {
    carried_mar = await carryErMedicationsToMar(visit);
  } catch (err) {
    logger.warn(`ER→ICU MAR carry-over failed for emergency visit ${visit.id}: ${err.message}`);
  }

  return {
    admission,
    er_visit: {
      id: visit.id,
      encounter_id: visit.encounter_id,
      patient_uid: visit.patient_uid
    },
    carried_mar
  };
}

// ════════════════════════════════════════════════════════════════════
// FLOWSHEET (hourly)
// ════════════════════════════════════════════════════════════════════

export async function logFlowsheet({ tenantId, icu_admission_id, ...body }) {
  if (!icu_admission_id) throw AppError.badRequest('icu_admission_id required');
  const admissionId = await assertIcuAdmissionInTenant(tenantId, icu_admission_id);

  // Hard plausibility gate (re-review H1): vitals, vent settings, drip rates,
  // I/O volumes, and recorded_at are bounded before anything persists.
  // Migration 648's CHECK constraints are the DB backstop for the same bounds.
  assertIcuFlowsheetPlausibility(body);

  const computed = {
    gcs_total: gcsTotal(body.gcs_eye, body.gcs_verbal, body.gcs_motor),
    net_balance_ml: netBalance(body)
  };

  const sql = `
    INSERT INTO icu_flowsheet_entries
      (icu_admission_id, recorded_at,
       hr, sbp, dbp, map, cvp, spo2, rr, temp_c, cap_refill_sec,
       gcs_eye, gcs_verbal, gcs_motor, gcs_total,
       pupils_left_size_mm, pupils_right_size_mm, pupils_reactive,
       vent_mode, fio2_pct, peep_cmh2o, tidal_volume_ml,
       resp_rate_set, airway_pressure_peak, airway_pressure_plateau, pf_ratio,
       noradrenaline_mcg_kg_min, adrenaline_mcg_kg_min, vasopressin_units_hr,
       dobutamine_mcg_kg_min, propofol_mcg_kg_min, midazolam_mg_hr,
       fentanyl_mcg_hr, insulin_units_hr, other_drips,
       iv_fluids_ml, oral_intake_ml, blood_products_ml,
       urine_output_ml, drain_output_ml, ng_aspirate_ml, stool_count,
       net_balance_ml, event_note,
       recorded_by, recorded_by_name, tenant_id)
    VALUES ($1, COALESCE($2::timestamptz, NOW()),
            $3, $4, $5, $6, $7, $8, $9, $10, $11,
            $12, $13, $14, $15,
            $16, $17, $18,
            $19, $20, $21, $22,
            $23, $24, $25, $26,
            $27, $28, $29,
            $30, $31, $32,
            $33, $34, COALESCE($35::jsonb, '[]'::jsonb),
            $36, $37, $38,
            $39, $40, $41, $42,
            $43, $44,
            $45::uuid, $46, $47::uuid)
    RETURNING *`;
  // Numeric clinical measurements use `?? null` so an explicit zero is
  // stored as zero. A nurse documenting `urine_output_ml: 0` is recording
  // measured anuria (oliguria), which is clinically distinct from `null`
  // (not measured). The same applies to vasopressor rates (a 0 mcg/kg/min
  // entry means the drip is held), oral intake, and other I/O totals.
  // Finding: 2026-05-09-emergency-walk-in-nurse-icu-urine-zero-stored-null.
  const rows = await prisma.$queryRawUnsafe(
    sql,
    admissionId,
    body.recorded_at || null,
    body.hr ?? null,
    body.sbp ?? null,
    body.dbp ?? null,
    body.map ?? null,
    body.cvp ?? null,
    body.spo2 ?? null,
    body.rr ?? null,
    body.temp_c ?? null,
    body.cap_refill_sec ?? null,
    body.gcs_eye ?? null,
    body.gcs_verbal ?? null,
    body.gcs_motor ?? null,
    computed.gcs_total,
    body.pupils_left_size_mm ?? null,
    body.pupils_right_size_mm ?? null,
    body.pupils_reactive ?? null,
    body.vent_mode || null,
    body.fio2_pct ?? null,
    body.peep_cmh2o ?? null,
    body.tidal_volume_ml ?? null,
    body.resp_rate_set ?? null,
    body.airway_pressure_peak ?? null,
    body.airway_pressure_plateau ?? null,
    body.pf_ratio ?? null,
    body.noradrenaline_mcg_kg_min ?? null,
    body.adrenaline_mcg_kg_min ?? null,
    body.vasopressin_units_hr ?? null,
    body.dobutamine_mcg_kg_min ?? null,
    body.propofol_mcg_kg_min ?? null,
    body.midazolam_mg_hr ?? null,
    body.fentanyl_mcg_hr ?? null,
    body.insulin_units_hr ?? null,
    body.other_drips ? JSON.stringify(body.other_drips) : null,
    body.iv_fluids_ml ?? null,
    body.oral_intake_ml ?? null,
    body.blood_products_ml ?? null,
    body.urine_output_ml ?? null,
    body.drain_output_ml ?? null,
    body.ng_aspirate_ml ?? null,
    body.stool_count ?? null,
    computed.net_balance_ml,
    body.event_note || null,
    body.recorded_by || null,
    body.recorded_by_name || null,
    tenantOr(tenantId)
  );
  return unwrap(rows);
}

export async function listFlowsheet({ tenantId, icu_admission_id, hours = 24 }) {
  const admissionId = await assertIcuAdmissionInTenant(tenantId, icu_admission_id);
  const h = Math.min(parseInt(hours, 10) || 24, 168);
  const sql = `
    SELECT * FROM icu_flowsheet_entries
    WHERE icu_admission_id = $1
      AND tenant_id = $2::uuid
      AND recorded_at > NOW() - $3::interval
    ORDER BY recorded_at ASC`;
  return prisma.$queryRawUnsafe(sql, admissionId, tenantOr(tenantId), `${h} hours`);
}

export async function ioSummary({ tenantId, icu_admission_id }) {
  const admissionId = await assertIcuAdmissionInTenant(tenantId, icu_admission_id);
  const sql = `
    SELECT * FROM icu_24h_io_summary
    WHERE icu_admission_id = $1
    ORDER BY day DESC LIMIT 7`;
  return prisma.$queryRawUnsafe(sql, admissionId);
}

// ════════════════════════════════════════════════════════════════════
// ASSESSMENTS — RASS / CAM-ICU / SOFA / CPOT
// ════════════════════════════════════════════════════════════════════

export async function recordAssessment({ tenantId, icu_admission_id, assessment_kind, ...body }) {
  if (!icu_admission_id) throw AppError.badRequest('icu_admission_id required');
  const admissionId = await assertIcuAdmissionInTenant(tenantId, icu_admission_id);
  if (!['rass', 'cam_icu', 'sofa', 'cpot'].includes(assessment_kind)) {
    throw AppError.badRequest('invalid assessment_kind');
  }

  // Hard plausibility gate (re-review H1): RASS -5..4, SOFA sub-scores 0-4,
  // CPOT domains 0-2, recorded_at sanity window. Migration 648 mirrors these
  // as CHECK constraints.
  assertIcuAssessmentPlausibility(body);

  // RASS validation
  if (assessment_kind === 'rass') {
    if (body.rass_score == null) throw AppError.badRequest('rass_score required');
  }

  // CAM-ICU computed
  let camPos = null;
  if (assessment_kind === 'cam_icu') {
    if (body.cam_feature_1 == null || body.cam_feature_2 == null) {
      throw AppError.badRequest('cam_feature_1 and cam_feature_2 required');
    }
    camPos = camPositive(
      body.cam_feature_1,
      body.cam_feature_2,
      body.cam_feature_3,
      body.cam_feature_4
    );
  }

  // SOFA total
  let sofaTotal = null;
  if (assessment_kind === 'sofa') {
    sofaTotal =
      (body.sofa_resp || 0) +
      (body.sofa_coag || 0) +
      (body.sofa_liver || 0) +
      (body.sofa_cardio || 0) +
      (body.sofa_cns || 0) +
      (body.sofa_renal || 0);
  }

  // CPOT total
  let cpotTotal = null;
  if (assessment_kind === 'cpot') {
    cpotTotal =
      (body.cpot_facial || 0) +
      (body.cpot_movement || 0) +
      (body.cpot_muscle_tension || 0) +
      (body.cpot_vent_compliance || 0);
  }

  const sql = `
    INSERT INTO icu_assessments
      (icu_admission_id, recorded_at, assessment_kind,
       rass_score, rass_target,
       cam_feature_1, cam_feature_2, cam_feature_3, cam_feature_4, cam_positive,
       sofa_resp, sofa_coag, sofa_liver, sofa_cardio, sofa_cns, sofa_renal, sofa_total,
       cpot_facial, cpot_movement, cpot_muscle_tension, cpot_vent_compliance, cpot_total,
       notes, recorded_by, tenant_id)
    VALUES ($1, COALESCE($2::timestamptz, NOW()), $3,
            $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17,
            $18, $19, $20, $21, $22,
            $23, $24::uuid, $25::uuid)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(
    sql,
    admissionId,
    body.recorded_at || null,
    assessment_kind,
    body.rass_score ?? null,
    body.rass_target ?? null,
    body.cam_feature_1 ?? null,
    body.cam_feature_2 ?? null,
    body.cam_feature_3 ?? null,
    body.cam_feature_4 ?? null,
    camPos,
    body.sofa_resp ?? null,
    body.sofa_coag ?? null,
    body.sofa_liver ?? null,
    body.sofa_cardio ?? null,
    body.sofa_cns ?? null,
    body.sofa_renal ?? null,
    sofaTotal,
    body.cpot_facial ?? null,
    body.cpot_movement ?? null,
    body.cpot_muscle_tension ?? null,
    body.cpot_vent_compliance ?? null,
    cpotTotal,
    body.notes || null,
    body.recorded_by || null,
    tenantOr(tenantId)
  );
  return unwrap(rows);
}

export async function listAssessments({ tenantId, icu_admission_id, kind, limit = 50 }) {
  const admissionId = await assertIcuAdmissionInTenant(tenantId, icu_admission_id);
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const args = [admissionId, tenantOr(tenantId)];
  let where = 'icu_admission_id = $1 AND tenant_id = $2::uuid';
  if (kind) {
    args.push(kind);
    where += ` AND assessment_kind = $${args.length}`;
  }
  const sql = `
    SELECT * FROM icu_assessments
    WHERE ${where}
    ORDER BY recorded_at DESC
    LIMIT ${lim}`;
  return prisma.$queryRawUnsafe(sql, ...args);
}

// ════════════════════════════════════════════════════════════════════
// ABCDEF DAILY BUNDLE
// ════════════════════════════════════════════════════════════════════

export async function upsertBundle({ tenantId, icu_admission_id, bundle_date, ...body }) {
  if (!icu_admission_id) throw AppError.badRequest('icu_admission_id required');
  const admissionId = await assertIcuAdmissionInTenant(tenantId, icu_admission_id);
  const day = bundle_date || new Date().toISOString().slice(0, 10);

  const merged = {
    a_awakening_done: Boolean(body.a_awakening_done),
    a_awakening_reason_skipped: body.a_awakening_reason_skipped || null,
    b_breathing_done: Boolean(body.b_breathing_done),
    b_breathing_reason_skipped: body.b_breathing_reason_skipped || null,
    b_breathing_outcome: body.b_breathing_outcome || null,
    c_choice_done: Boolean(body.c_choice_done),
    c_protocol_followed: body.c_protocol_followed ?? null,
    d_delirium_assessed: Boolean(body.d_delirium_assessed),
    d_delirium_positive: body.d_delirium_positive ?? null,
    d_delirium_managed: body.d_delirium_managed ?? null,
    e_mobility_done: Boolean(body.e_mobility_done),
    e_mobility_level: body.e_mobility_level || null,
    e_mobility_reason_skipped: body.e_mobility_reason_skipped || null,
    f_family_done: Boolean(body.f_family_done),
    f_family_method: body.f_family_method || null
  };

  const complete = bundleComplete(merged);
  const pct = bundlePct(merged);

  const sql = `
    INSERT INTO icu_daily_bundles
      (icu_admission_id, bundle_date,
       a_awakening_done, a_awakening_reason_skipped,
       b_breathing_done, b_breathing_reason_skipped, b_breathing_outcome,
       c_choice_done, c_protocol_followed,
       d_delirium_assessed, d_delirium_positive, d_delirium_managed,
       e_mobility_done, e_mobility_level, e_mobility_reason_skipped,
       f_family_done, f_family_method,
       bundle_complete, bundle_pct,
       recorded_by, notes, tenant_id)
    VALUES ($1, $2::date,
            $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17,
            $18, $19, $20::uuid, $21, $22::uuid)
    ON CONFLICT (icu_admission_id, bundle_date)
    DO UPDATE SET
      a_awakening_done            = EXCLUDED.a_awakening_done,
      a_awakening_reason_skipped  = EXCLUDED.a_awakening_reason_skipped,
      b_breathing_done            = EXCLUDED.b_breathing_done,
      b_breathing_reason_skipped  = EXCLUDED.b_breathing_reason_skipped,
      b_breathing_outcome         = EXCLUDED.b_breathing_outcome,
      c_choice_done               = EXCLUDED.c_choice_done,
      c_protocol_followed         = EXCLUDED.c_protocol_followed,
      d_delirium_assessed         = EXCLUDED.d_delirium_assessed,
      d_delirium_positive         = EXCLUDED.d_delirium_positive,
      d_delirium_managed          = EXCLUDED.d_delirium_managed,
      e_mobility_done             = EXCLUDED.e_mobility_done,
      e_mobility_level            = EXCLUDED.e_mobility_level,
      e_mobility_reason_skipped   = EXCLUDED.e_mobility_reason_skipped,
      f_family_done               = EXCLUDED.f_family_done,
      f_family_method             = EXCLUDED.f_family_method,
      bundle_complete             = EXCLUDED.bundle_complete,
      bundle_pct                  = EXCLUDED.bundle_pct,
      recorded_by                 = EXCLUDED.recorded_by,
      notes                       = EXCLUDED.notes,
      updated_at                  = NOW()
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(
    sql,
    admissionId,
    day,
    merged.a_awakening_done,
    merged.a_awakening_reason_skipped,
    merged.b_breathing_done,
    merged.b_breathing_reason_skipped,
    merged.b_breathing_outcome,
    merged.c_choice_done,
    merged.c_protocol_followed,
    merged.d_delirium_assessed,
    merged.d_delirium_positive,
    merged.d_delirium_managed,
    merged.e_mobility_done,
    merged.e_mobility_level,
    merged.e_mobility_reason_skipped,
    merged.f_family_done,
    merged.f_family_method,
    complete,
    pct,
    body.recorded_by || null,
    body.notes || null,
    tenantOr(tenantId)
  );
  return unwrap(rows);
}

export async function getBundle({ tenantId, icu_admission_id, bundle_date }) {
  const admissionId = await assertIcuAdmissionInTenant(tenantId, icu_admission_id);
  const sql = `
    SELECT * FROM icu_daily_bundles
    WHERE icu_admission_id = $1 AND tenant_id = $2::uuid AND bundle_date = $3::date`;
  const rows = await prisma.$queryRawUnsafe(
    sql,
    admissionId,
    tenantOr(tenantId),
    bundle_date || new Date().toISOString().slice(0, 10)
  );
  return unwrap(rows) || null;
}

export async function bundle30dCompliance({ tenantId }) {
  const sql = `
    SELECT * FROM icu_bundle_30d
    WHERE tenant_id = $1::uuid
    ORDER BY bundle_date DESC`;
  return prisma.$queryRawUnsafe(sql, tenantOr(tenantId));
}

// Re-export pure-compute helpers (lives in icuComputations.js so unit
// tests can import them without pulling prisma).
export { gcsTotal, netBalance, camPositive, bundleComplete, bundlePct } from './icuComputations.js';
