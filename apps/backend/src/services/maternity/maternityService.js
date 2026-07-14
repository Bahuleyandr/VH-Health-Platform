// src/services/maternity/maternityService.js
//
// Sprint 7 — Maternity workflow: pregnancy → ANC visits → labor
// admission → partograph entries → delivery summary → newborn record
// + Apgar → postnatal visits.
//
// Partograph alert/action line math follows WHO modified partograph:
//   - Active phase begins at 4cm cervical dilatation
//   - Expected dilation rate: 1cm/hour
//   - Alert line: from (4cm, time of 4cm) at 1cm/hr
//   - Action line: 4 hours to the right of alert line
// If the latest dilation is below the alert line at the recorded time,
// flag on_alert_line=true; below the action line → on_action_line=true
// → escalate to obstetrician.

import { createHash, randomUUID } from 'crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import logger from '../../logging/logger.js';
import { checkVitalAnomalies } from '../../utils/clinical/vitalSignMonitor.js';
import { istDateString } from '../../utils/dateUtils.js';
import {
  currentCanonicalTransactionRevision,
  recordCanonicalClinicalEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  assertExclusiveNewbornLink,
  assertNewbornIdentitySubject,
  IDENTITY_MINTING_OUTCOMES,
  NEWBORN_OUTCOMES,
  newbornIdentityInvalid,
  newbornIdentityRequired,
} from './newbornIdentity.js';
import {
  assertPrivilegeForGate,
  isGateEnabled,
  privilegeKey,
} from '../staff/credentialingService.js';

export { istDateString };

const tenantOr = (tenantId) => requireTenantId(tenantId);

function canonicalStateFingerprint(state) {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 32);
}

// ── OBGyn labour-ward credential gate (credential-hardening 2026-07-13) ──────
// The responsible obstetrician for a labour-ward act (attending_obstetrician on
// admission, delivered_by on a delivery) must hold an active
// `obgyn_labour_ward_access` privilege. This mirrors theatre gating on the
// surgeon: the check is on the CLINICIAN PERFORMING the act, not whoever typed
// the record — so there is no admin bypass (an admin recording a delivery does
// not change who delivered it). Additive + env-flagged (default OFF): nothing
// changes until an operator enables it after credentialing the obstetricians.
export function obgynLabourWardGateConfig() {
  return {
    key: privilegeKey(process.env.OBGYN_LABOUR_WARD_PRIVILEGE_KEY || 'obgyn_labour_ward_access'),
    enabled: isGateEnabled('OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED'),
  };
}

async function assertObgynLabourWardPrivilege(responsibleUid, tenantId, gate) {
  const cfg = obgynLabourWardGateConfig();
  if (!cfg.enabled) return;
  if (!responsibleUid) {
    throw AppError.badRequest(
      'A responsible obstetrician must be named for this labour-ward act while the OBGyn credential gate is enabled.',
      'OBGYN_RESPONSIBLE_OBSTETRICIAN_REQUIRED',
    );
  }
  await assertPrivilegeForGate({
    staffUid: String(responsibleUid),
    privilegeName: cfg.key,
    tenantId,
    gate,
    enabled: true,
  });
}

// ── Pregnancy episode ────────────────────────────────────────────────

async function assertPatientInTenant(tenantId, patientUid) {
  if (!patientUid) throw AppError.badRequest('patient_uid is required');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantOr(tenantId),
    String(patientUid),
  );
  if (!rows.length) throw AppError.notFound('Patient not found');
  return rows[0];
}

async function assertPregnancyInTenant(tenantId, pregnancyId) {
  const id = Number.parseInt(pregnancyId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('pregnancy_id must be a positive integer');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, lmp_date, edd_date, gravida, parity,
            high_risk, high_risk_reasons, status, created_at
       FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    tenantOr(tenantId),
    id,
  );
  if (!rows.length) throw AppError.notFound(`Pregnancy ${id} not found`);
  return rows[0];
}

async function assertAdmissionInTenant(tenantId, admissionId, patientUid = null) {
  const id = Number.parseInt(admissionId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('admission_id must be a positive integer');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid
       FROM admissions
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    tenantOr(tenantId),
    id,
  );
  if (!rows.length) throw AppError.notFound('Admission not found');
  if (patientUid && String(rows[0].patient_uid) !== String(patientUid)) {
    throw AppError.forbidden('Admission belongs to a different patient');
  }
  return rows[0];
}

async function assertDeliveryInTenant(tenantId, deliveryId) {
  const id = Number.parseInt(deliveryId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('delivery_id must be a positive integer');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT d.id, d.pregnancy_id, p.patient_uid
       FROM maternity_deliveries d
       JOIN maternity_pregnancies p
         ON p.id = d.pregnancy_id
        AND p.tenant_id = d.tenant_id
      WHERE d.tenant_id = $1::uuid AND d.id = $2::int`,
    tenantOr(tenantId),
    id,
  );
  if (!rows.length) throw AppError.notFound('Delivery not found');
  return rows[0];
}

async function assertNewbornInTenant(tenantId, newbornId, deliveryId = null) {
  const id = Number.parseInt(newbornId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('newborn_id must be a positive integer');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, delivery_id, newborn_patient_uid
       FROM maternity_newborns
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    tenantOr(tenantId),
    id,
  );
  if (!rows.length) throw AppError.notFound('Newborn not found');
  if (deliveryId && Number(rows[0].delivery_id) !== Number(deliveryId)) {
    throw AppError.forbidden('Newborn belongs to a different delivery');
  }
  return rows[0];
}

function computeEdd(lmpDate) {
  if (!lmpDate) return null;
  const lmp = new Date(lmpDate);
  if (Number.isNaN(lmp.getTime())) return null;
  // Naegele's rule: LMP + 280 days
  const edd = new Date(lmp.getTime() + 280 * 86400 * 1000);
  return edd.toISOString().split('T')[0];
}

// Current calendar date in IST (the clinic's timezone — India has no DST,
// fixed UTC+5:30) as 'YYYY-MM-DD'. Gestational age and the ANC schedule are
// calendar-day computations: defaulting "today" to a UTC instant (new Date())
// only rolls the day at UTC midnight = 05:30 IST, so between IST midnight and
// 05:30 the GA / visit milestones read one day behind the clinic's calendar.
// Anchoring the default to the IST date makes the day-diff exact.
// Finding: ANC uses UTC not IST for visit-number/GA.
/**
 * Gestational age (in weeks + days) on a given date, computed from LMP.
 * Returns { weeks, days, total_days, label } or null if inputs invalid.
 *
 * label is "GA 32+4" — the format obstetricians actually use, where
 * 32 is full weeks and 4 is residual days. Migration 181 / A7.
 */
export function computeGestationalAge(lmpDate, onDate = null) {
  if (!lmpDate) return null;
  const lmp = new Date(lmpDate);
  if (Number.isNaN(lmp.getTime())) return null;
  const reference = onDate ? new Date(onDate) : new Date(istDateString());
  if (Number.isNaN(reference.getTime())) return null;
  const diffMs = reference.getTime() - lmp.getTime();
  if (diffMs < 0) return null;
  const totalDays = Math.floor(diffMs / 86400000);
  const weeks = Math.floor(totalDays / 7);
  const days = totalDays % 7;
  return {
    weeks,
    days,
    total_days: totalDays,
    label: `GA ${weeks}+${days}`,
  };
}

// Standard ANC visit schedule (target GA week → milestone). Drives the
// forward care plan rendered on the ANC timeline. These are scheduling
// milestone labels only — the clinical content of each visit is owned
// elsewhere, not invented here.
const ANC_SCHEDULE = [
  { label: 'Booking visit', ga_weeks: 12, trimester: 1, visit_sequence_number: 1 },
  { label: 'Second ANC visit', ga_weeks: 16, trimester: 2, visit_sequence_number: 2 },
  { label: 'Anomaly scan window', ga_weeks: 20, trimester: 2, visit_sequence_number: null },
  { label: '24-week ANC visit', ga_weeks: 24, trimester: 2, visit_sequence_number: 3 },
  { label: 'Glucose screening window', ga_weeks: 26, trimester: 2, visit_sequence_number: null },
  { label: '28-week ANC visit', ga_weeks: 28, trimester: 2, visit_sequence_number: 4 },
  { label: 'Third trimester visit', ga_weeks: 32, trimester: 3, visit_sequence_number: 5 },
  { label: 'Growth scan window', ga_weeks: 36, trimester: 3, visit_sequence_number: null },
  { label: 'Term assessment', ga_weeks: 39, trimester: 3, visit_sequence_number: 6 },
];

function trimesterLabel(trimester) {
  if (trimester === 1) return 'First trimester';
  if (trimester === 2) return 'Second trimester';
  if (trimester === 3) return 'Third trimester';
  return null;
}

function milestoneForGestationalWeeks(weeks) {
  if (!Number.isFinite(Number(weeks))) return null;
  const current = Number(weeks);
  let best = null;
  for (const milestone of ANC_SCHEDULE) {
    const distance = Math.abs(current - milestone.ga_weeks);
    if (distance > 2) continue;
    if (!best || distance < best.distance ||
        (distance === best.distance && milestone.visit_sequence_number && !best.milestone.visit_sequence_number)) {
      best = { milestone, distance };
    }
  }
  return best?.milestone || null;
}

function decorateBookedAncVisit(row, lmpDate) {
  const gestationalAge = computeGestationalAge(lmpDate, row.appointment_date);
  const milestone = milestoneForGestationalWeeks(gestationalAge?.weeks);
  return {
    ...row,
    gestational_age: gestationalAge,
    milestone_label: milestone?.label || null,
    milestone_ga_weeks: milestone?.ga_weeks || null,
    visit_sequence_number: milestone?.visit_sequence_number || null,
    trimester: milestone?.trimester || null,
    trimester_label: milestone ? trimesterLabel(milestone.trimester) : null,
  };
}

/**
 * Compute the ANC schedule milestones from LMP. Each milestone gets a
 * target date (LMP + ga_weeks) and a past / current / upcoming status
 * relative to the reference date. "current" = within 2 weeks before
 * the target week. Returns [] when LMP is unknown.
 */
export function computeAncScheduleMilestones(lmpDate, onDate = null) {
  if (!lmpDate) return [];
  const lmp = new Date(lmpDate);
  if (Number.isNaN(lmp.getTime())) return [];
  const today = onDate ? new Date(onDate) : new Date(istDateString());
  const currentGa = computeGestationalAge(lmpDate, onDate);
  const currentWeeks = currentGa ? currentGa.weeks : null;
  return ANC_SCHEDULE.map((m) => {
    const targetDate = new Date(lmp.getTime() + m.ga_weeks * 7 * 86400000);
    let status = 'upcoming';
    if (currentWeeks != null) {
      if (currentWeeks > m.ga_weeks) status = 'past';
      else if (currentWeeks >= m.ga_weeks - 2) status = 'current';
    } else if (targetDate < today) {
      status = 'past';
    }
    return {
      label: m.label,
      ga_weeks: m.ga_weeks,
      trimester: m.trimester,
      trimester_label: trimesterLabel(m.trimester),
      visit_sequence_number: m.visit_sequence_number,
      target_date: targetDate.toISOString().slice(0, 10),
      status,
    };
  });
}

export async function createPregnancy({
  tenantId, patient_uid, pregnancy_number = 1,
  lmp_date, edd_date, edd_method,
  gravida = 1, parity = 0, living_children = 0, abortions = 0,
  blood_group, rh_factor, booking_status = 'booked', booking_visit_date,
  high_risk = false, high_risk_reasons, notes, created_by,
  actor_uid, actor_role,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const tid = tenantOr(tenantId);
  await assertPatientInTenant(tid, patient_uid);

  const eddFinal = edd_date || computeEdd(lmp_date);

  // Explicitly set status='ongoing' on insert. The vital-sign monitor's
  // pre-eclampsia screen + every active-pregnancy query (line 388, 767)
  // filters on status='ongoing'; without setting it explicitly, rows
  // landed with the column default ('active'), so a booked pregnancy
  // never triggered the BP+protein pre-eclampsia alert. Finding:
  //   POST /emr/vitals does not raise pre-eclampsia alert despite
  //   BP ≥140/90 + proteinuria in a known-pregnant patient.
  return setTenantTx(tid, async (tx) => {
    const lockedPatients = await tx.$queryRawUnsafe(
      `SELECT uid
         FROM users
        WHERE tenant_id = $1::uuid AND uid = $2::uuid
        FOR UPDATE`,
      tid,
      String(patient_uid),
    );
    if (!lockedPatients.length) throw AppError.notFound('Patient not found');
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO maternity_pregnancies
         (patient_uid, pregnancy_number, lmp_date, edd_date, edd_method,
          gravida, parity, living_children, abortions,
          blood_group, rh_factor, booking_status, booking_visit_date,
          high_risk, high_risk_reasons, notes, status, created_by, tenant_id)
       VALUES ($1::uuid, $2::int, $3::date, $4::date, $5,
               $6::int, $7::int, $8::int, $9::int,
               $10, $11, $12, $13::date,
               $14, $15::text[], $16, 'ongoing', $17::uuid, $18::uuid)
       RETURNING *`,
      String(patient_uid), Number(pregnancy_number),
      lmp_date || null, eddFinal || null, edd_method || null,
      Number(gravida), Number(parity), Number(living_children), Number(abortions),
      blood_group || null, rh_factor || null,
      booking_status, booking_visit_date || null,
      !!high_risk, high_risk_reasons || null, notes || null,
      created_by ? String(created_by) : null, tid,
    );
    const pregnancy = rows[0];

    await tx.$executeRawUnsafe(
      `UPDATE users
          SET is_pregnant = TRUE,
              pregnancy_lmp_date = COALESCE($2::date, pregnancy_lmp_date),
              updated_at = NOW()
        WHERE tenant_id = $3::uuid AND uid = $1::uuid`,
      String(patient_uid),
      lmp_date || null,
      tid,
    );

    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: String(patient_uid),
      eventType: 'maternity.pregnancy_created',
      eventStatus: 'ongoing',
      sourceTable: 'maternity_pregnancies',
      sourceId: pregnancy.id,
      resourceType: 'pregnancy',
      resourceId: pregnancy.id,
      actorUid: actor_uid || created_by || null,
      actorRole: actor_role || null,
      occurredAt: pregnancy.created_at,
      visibleToPatient: false,
      summary: 'Pregnancy episode recorded',
      payload: {
        pregnancy_id: pregnancy.id,
        pregnancy_number: pregnancy.pregnancy_number,
        status: pregnancy.status,
      },
      afterState: {
        pregnancy_status: pregnancy.status,
        user_is_pregnant: true,
      },
      timelineIdempotencyKey: `maternity_pregnancies:${pregnancy.id}:created`,
      auditIdempotencyKey: `maternity_pregnancies:${pregnancy.id}:audit:created`,
    }, { db: tx, strict: true });

    return pregnancy;
  });
}

export async function getPregnancy({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_pregnancies WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantOr(tenantId),
  );
  if (!rows.length) throw AppError.notFound('Pregnancy not found');
  return rows[0];
}

export async function listPregnanciesForPatient({ tenantId, patient_uid }) {
  const tid = tenantOr(tenantId);
  await assertPatientInTenant(tid, patient_uid);
  return prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
      ORDER BY created_at DESC`,
    tid, String(patient_uid),
  );
}

export async function updatePregnancy({ tenantId, id, ...patch }) {
  const allowed = ['lmp_date', 'edd_date', 'gravida', 'parity', 'living_children',
    'abortions', 'blood_group', 'rh_factor', 'high_risk', 'high_risk_reasons',
    'status', 'notes'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      params.push(patch[k]);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (!sets.length) return getPregnancy({ tenantId, id });
  params.push(Number(id));
  params.push(tenantOr(tenantId));
  await prisma.$executeRawUnsafe(
    `UPDATE maternity_pregnancies
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length - 1}::int AND tenant_id = $${params.length}::uuid`,
    ...params,
  );
  return getPregnancy({ tenantId, id });
}

// ── ANC visits ──────────────────────────────────────────────────────

export async function recordAncVisit({
  tenantId, pregnancy_id, visit_date, gestational_age_weeks,
  weight_kg, bp_systolic, bp_diastolic, pulse_bpm,
  fundal_height_cm, fetal_heart_rate_bpm, fetal_movements_felt,
  presentation, edema, pallor,
  hb_gm_dl, urine_albumin, urine_sugar,
  iron_folic_acid_given, calcium_given, tt_dose,
  next_visit_date, notes, recorded_by,
  actor_uid, actor_role,
}) {
  if (!pregnancy_id) throw AppError.badRequest('pregnancy_id is required');
  if (!visit_date) throw AppError.badRequest('visit_date is required');
  const pregnancy = await assertPregnancyInTenant(tenantId, pregnancy_id);
  const tid = tenantOr(tenantId);

  // UPSERT on (pregnancy_id, visit_date). Clinically there is at most
  // one ANC visit per pregnancy per calendar day — additional readings
  // taken later that day belong on the same row, not a duplicate. Pre-
  // migration 222 the absence of a unique constraint let the nurse's
  // pre-eclampsia threshold test insert a ghost row that polluted the
  // timeline (BP 142/92 with all other clinical fields NULL). EXCLUDED
  // fields overwrite the existing row only when non-null, so an
  // amendment that supplies only BP doesn't blank out previously
  // recorded weight / fundal height / FHR. visit_number stays on the
  // original row. Finding:
  //   2026-05-09-obstetric-anc-patient-duplicate-anc-visit-alarming-bp
  const visit = await setTenantTx(tid, async (tx) => {
    const lockedPregnancies = await tx.$queryRawUnsafe(
      `SELECT id
         FROM maternity_pregnancies
        WHERE tenant_id = $1::uuid AND id = $2::int
        FOR UPDATE`,
      tid,
      pregnancy.id,
    );
    if (!lockedPregnancies.length) throw AppError.notFound('Pregnancy not found');

    // Effective-state no-op guard (canonical revision-sequence fix). Compare
    // the EXACT state the ON CONFLICT UPDATE below would persist (COALESCE /
    // OR-merge semantics, column-scale casts) against the locked current row.
    // An exact retry must return before the UPSERT so the visit tuple keeps
    // its xmin, the users.is_pregnant projection is untouched, and no new
    // canonical revision is allocated. Evaluated under the pregnancy row lock
    // (plus FOR UPDATE here) so concurrent identical mutations collapse to
    // exactly one new revision pair.
    const guardRows = await tx.$queryRawUnsafe(
      `SELECT v.*,
              (
                    v.gestational_age_weeks IS NOT DISTINCT FROM COALESCE($3::numeric(4,1), v.gestational_age_weeks)
                AND v.weight_kg             IS NOT DISTINCT FROM COALESCE($4::numeric(5,2), v.weight_kg)
                AND v.bp_systolic           IS NOT DISTINCT FROM COALESCE($5::int, v.bp_systolic)
                AND v.bp_diastolic          IS NOT DISTINCT FROM COALESCE($6::int, v.bp_diastolic)
                AND v.pulse_bpm             IS NOT DISTINCT FROM COALESCE($7::int, v.pulse_bpm)
                AND v.fundal_height_cm      IS NOT DISTINCT FROM COALESCE($8::int, v.fundal_height_cm)
                AND v.fetal_heart_rate_bpm  IS NOT DISTINCT FROM COALESCE($9::int, v.fetal_heart_rate_bpm)
                AND v.fetal_movements_felt  IS NOT DISTINCT FROM COALESCE($10::boolean, v.fetal_movements_felt)
                AND v.presentation          IS NOT DISTINCT FROM COALESCE($11, v.presentation)
                AND v.edema                 IS NOT DISTINCT FROM COALESCE($12, v.edema)
                AND v.pallor                IS NOT DISTINCT FROM COALESCE($13, v.pallor)
                AND v.hb_gm_dl              IS NOT DISTINCT FROM COALESCE($14::numeric(4,1), v.hb_gm_dl)
                AND v.urine_albumin         IS NOT DISTINCT FROM COALESCE($15, v.urine_albumin)
                AND v.urine_sugar           IS NOT DISTINCT FROM COALESCE($16, v.urine_sugar)
                AND v.iron_folic_acid_given = (v.iron_folic_acid_given OR $17::boolean)
                AND v.calcium_given         = (v.calcium_given OR $18::boolean)
                AND v.tt_dose               IS NOT DISTINCT FROM COALESCE($19, v.tt_dose)
                AND v.next_visit_date       IS NOT DISTINCT FROM COALESCE($20::date, v.next_visit_date)
                AND v.notes                 IS NOT DISTINCT FROM COALESCE($21, v.notes)
                AND v.recorded_by           IS NOT DISTINCT FROM COALESCE($22::uuid, v.recorded_by)
              ) AS effective_state_unchanged
         FROM maternity_anc_visits v
        WHERE v.tenant_id = $1::uuid
          AND v.pregnancy_id = $2::int
          AND v.visit_date = $23::date
        FOR UPDATE`,
      tid,
      pregnancy.id,
      gestational_age_weeks ? Number(gestational_age_weeks) : null,
      weight_kg ? Number(weight_kg) : null,
      bp_systolic ? Number(bp_systolic) : null,
      bp_diastolic ? Number(bp_diastolic) : null,
      pulse_bpm ? Number(pulse_bpm) : null,
      fundal_height_cm ? Number(fundal_height_cm) : null,
      fetal_heart_rate_bpm ? Number(fetal_heart_rate_bpm) : null,
      fetal_movements_felt ?? null,
      presentation || null, edema || null, pallor || null,
      hb_gm_dl ? Number(hb_gm_dl) : null,
      urine_albumin || null, urine_sugar || null,
      !!iron_folic_acid_given, !!calcium_given, tt_dose || null,
      next_visit_date || null, notes || null,
      recorded_by ? String(recorded_by) : null,
      visit_date,
    );
    if (guardRows.length && guardRows[0].effective_state_unchanged === true) {
      const { effective_state_unchanged: _unchanged, ...existingVisit } = guardRows[0];
      return existingVisit;
    }

    // The pregnancy lock serializes visit-number allocation for this episode.
    const nextNumberRow = await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(visit_number), 0) + 1 AS next_number
         FROM maternity_anc_visits
        WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
      tid,
      pregnancy.id,
    );
    const nextNumber = Number(nextNumberRow?.[0]?.next_number) || 1;
    // updated_at is deliberately absent from the ON CONFLICT SET list (the table
    // carries none): canonicalStateFingerprint hashes the full returned row, and
    // A->B->A key-base stability (deep-test-asserted) needs it unstamped — xid8 only splits revisions.
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO maternity_anc_visits
         (pregnancy_id, visit_date, visit_number, gestational_age_weeks,
          weight_kg, bp_systolic, bp_diastolic, pulse_bpm,
          fundal_height_cm, fetal_heart_rate_bpm, fetal_movements_felt,
          presentation, edema, pallor,
          hb_gm_dl, urine_albumin, urine_sugar,
          iron_folic_acid_given, calcium_given, tt_dose,
          next_visit_date, notes, recorded_by, tenant_id)
       VALUES ($1::int, $2::date, $24::int, $3::numeric,
               $4::numeric, $5::int, $6::int, $7::int,
               $8::int, $9::int, $10,
               $11, $12, $13,
               $14::numeric, $15, $16,
               $17, $18, $19,
               $20::date, $21, $22::uuid, $23::uuid)
       ON CONFLICT (pregnancy_id, visit_date) DO UPDATE SET
         gestational_age_weeks  = COALESCE(EXCLUDED.gestational_age_weeks, maternity_anc_visits.gestational_age_weeks),
         weight_kg              = COALESCE(EXCLUDED.weight_kg, maternity_anc_visits.weight_kg),
         bp_systolic            = COALESCE(EXCLUDED.bp_systolic, maternity_anc_visits.bp_systolic),
         bp_diastolic           = COALESCE(EXCLUDED.bp_diastolic, maternity_anc_visits.bp_diastolic),
         pulse_bpm              = COALESCE(EXCLUDED.pulse_bpm, maternity_anc_visits.pulse_bpm),
         fundal_height_cm       = COALESCE(EXCLUDED.fundal_height_cm, maternity_anc_visits.fundal_height_cm),
         fetal_heart_rate_bpm   = COALESCE(EXCLUDED.fetal_heart_rate_bpm, maternity_anc_visits.fetal_heart_rate_bpm),
         fetal_movements_felt   = COALESCE(EXCLUDED.fetal_movements_felt, maternity_anc_visits.fetal_movements_felt),
         presentation           = COALESCE(EXCLUDED.presentation, maternity_anc_visits.presentation),
         edema                  = COALESCE(EXCLUDED.edema, maternity_anc_visits.edema),
         pallor                 = COALESCE(EXCLUDED.pallor, maternity_anc_visits.pallor),
         hb_gm_dl               = COALESCE(EXCLUDED.hb_gm_dl, maternity_anc_visits.hb_gm_dl),
         urine_albumin          = COALESCE(EXCLUDED.urine_albumin, maternity_anc_visits.urine_albumin),
         urine_sugar            = COALESCE(EXCLUDED.urine_sugar, maternity_anc_visits.urine_sugar),
         iron_folic_acid_given  = maternity_anc_visits.iron_folic_acid_given OR EXCLUDED.iron_folic_acid_given,
         calcium_given          = maternity_anc_visits.calcium_given OR EXCLUDED.calcium_given,
         tt_dose                = COALESCE(EXCLUDED.tt_dose, maternity_anc_visits.tt_dose),
         next_visit_date        = COALESCE(EXCLUDED.next_visit_date, maternity_anc_visits.next_visit_date),
         notes                  = COALESCE(EXCLUDED.notes, maternity_anc_visits.notes),
         recorded_by            = COALESCE(EXCLUDED.recorded_by, maternity_anc_visits.recorded_by)
       RETURNING *`,
      pregnancy.id, visit_date,
      gestational_age_weeks ? Number(gestational_age_weeks) : null,
      weight_kg ? Number(weight_kg) : null,
      bp_systolic ? Number(bp_systolic) : null,
      bp_diastolic ? Number(bp_diastolic) : null,
      pulse_bpm ? Number(pulse_bpm) : null,
      fundal_height_cm ? Number(fundal_height_cm) : null,
      fetal_heart_rate_bpm ? Number(fetal_heart_rate_bpm) : null,
      fetal_movements_felt ?? null,
      presentation || null, edema || null, pallor || null,
      hb_gm_dl ? Number(hb_gm_dl) : null,
      urine_albumin || null, urine_sugar || null,
      !!iron_folic_acid_given, !!calcium_given, tt_dose || null,
      next_visit_date || null, notes || null,
      recorded_by ? String(recorded_by) : null, tid,
      nextNumber,
    );
    const recordedVisit = rows[0];
    const canonicalRevision = canonicalStateFingerprint(recordedVisit);
    // Genuine mutation: pair the state fingerprint with a transaction-unique
    // xid8 so a later return to a previous state (A -> B -> A) still records
    // its own canonical revision instead of colliding with revision 1's key.
    const txRevision = await currentCanonicalTransactionRevision(tx);

    const projected = await tx.$executeRawUnsafe(
      `UPDATE users
          SET is_pregnant = TRUE,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      tid,
      String(pregnancy.patient_uid),
    );
    if (projected !== 1) throw AppError.notFound('Patient not found');

    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: String(pregnancy.patient_uid),
      eventType: 'maternity.anc_visit_recorded',
      eventStatus: 'recorded',
      sourceTable: 'maternity_anc_visits',
      sourceId: recordedVisit.id,
      resourceType: 'anc_visit',
      resourceId: recordedVisit.id,
      actorUid: actor_uid || recorded_by || null,
      actorRole: actor_role || null,
      occurredAt: recordedVisit.created_at,
      visibleToPatient: false,
      summary: 'ANC visit recorded',
      payload: {
        anc_visit_id: recordedVisit.id,
        pregnancy_id: pregnancy.id,
        visit_number: recordedVisit.visit_number,
      },
      afterState: {
        anc_visit_recorded: true,
        user_is_pregnant: true,
      },
      tags: ['maternity', 'anc'],
      timelineIdempotencyKey: `maternity_anc_visits:${recordedVisit.id}:${canonicalRevision}:tx:${txRevision}`,
      auditIdempotencyKey: `maternity_anc_visits:${recordedVisit.id}:audit:${canonicalRevision}:tx:${txRevision}`,
    }, { db: tx, strict: true });

    return recordedVisit;
  });

  // Phase 1.5 best-effort: emit pre-eclampsia alert on BP ≥140/90.
  // Patient-safety hook — finding
  // 2026-05-09-obstetric-anc-nurse-anc-visit-no-preeclampsia-alert.
  // Pregnancy BP thresholds live in vitalSignMonitor's
  // PREGNANCY_BP_OVERRIDES and only fire when users.is_pregnant=TRUE.
  // The pregnancy projection is committed with the visit above. Alert
  // generation remains post-commit and must NEVER block visit creation.
  let alerts = [];
  if (bp_systolic != null || bp_diastolic != null) {
    try {
      const patientRows = await prisma.$queryRawUnsafe(
        `SELECT u.id
           FROM maternity_pregnancies p
           JOIN users u ON u.uid = p.patient_uid
          WHERE p.tenant_id = $1::uuid
            AND u.tenant_id = $1::uuid
            AND p.id = $2::int
          LIMIT 1`,
        tid,
        pregnancy.id,
      );
      const patient = patientRows[0];
      if (patient?.id) {
        let recorderId = null;
        if (recorded_by) {
          const rRows = await prisma.$queryRawUnsafe(
            `SELECT id FROM users
              WHERE tenant_id = $1::uuid AND uid = $2::uuid
              LIMIT 1`,
            tid,
            String(recorded_by),
          );
          recorderId = rRows[0]?.id ?? null;
        }
        const vitalsForCheck = {};
        if (bp_systolic != null) vitalsForCheck.systolic_bp = Number(bp_systolic);
        if (bp_diastolic != null) vitalsForCheck.diastolic_bp = Number(bp_diastolic);
        if (urine_albumin != null) vitalsForCheck.urine_albumin = urine_albumin;
        alerts = await checkVitalAnomalies(patient.id, vitalsForCheck, {
          recordedBy: recorderId,
        });
      }
    } catch (err) {
      logger.warn(`ANC pre-eclampsia check failed for pregnancy=${pregnancy_id}: ${err.message}`);
    }
  }

  return { ...visit, alerts };
}

// ── A7 — ANC operational helpers (migration 181) ────────────────────

/**
 * The ongoing pregnancy for a patient, if any. Returns null otherwise.
 * Used by the patient app's ANC timeline tile and the OPD walk-in
 * form to skip the "is this patient pregnant?" question on returnees.
 */
export async function getActivePregnancyForPatient({ tenantId, patient_uid }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const tid = tenantOr(tenantId);
  await assertPatientInTenant(tid, patient_uid);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, pregnancy_number, lmp_date, edd_date, edd_method,
            gravida, parity, living_children, abortions, blood_group, rh_factor,
            booking_status, booking_visit_date, high_risk, high_risk_reasons,
            status, notes, created_at
       FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status = 'ongoing'
      ORDER BY created_at DESC
      LIMIT 1`,
    tid, patient_uid,
  );
  if (!rows.length) return null;
  const p = rows[0];
  // Decorate with computed GA so callers don't have to repeat the math.
  const ga = computeGestationalAge(p.lmp_date);
  return { ...p, gestational_age: ga };
}

/**
 * ANC timeline for a pregnancy: visits + supplements + recent kick
 * counts in one payload. The doctor's chart open hits this; the
 * patient app's timeline tile hits the patient-flavored variant
 * which calls this after resolving the active pregnancy.
 */
export async function getAncTimelineForPregnancy({ tenantId, pregnancy_id }) {
  const id = Number.parseInt(pregnancy_id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('pregnancy_id must be a positive integer');
  }
  const tid = tenantOr(tenantId);
  const [pregnancy, visits, supplements, kicks] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, lmp_date, edd_date, gravida, parity,
              high_risk, high_risk_reasons, status
         FROM maternity_pregnancies
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      id, tid,
    ),
    prisma.$queryRawUnsafe(
      // Urine dipstick: surface BOTH albumin (pre-eclampsia screen) and
      // sugar (gestational diabetes screen) on the ANC timeline — the
      // dipstick is a single tap on the nurse-recorded visit and both
      // results are part of the same clinical decision. Finding:
      // 2026-05-10-obstetric-anc-nurse-urine-glucose-hidden.
      `SELECT id, visit_date, visit_number, gestational_age_weeks,
              weight_kg, bp_systolic, bp_diastolic, fundal_height_cm,
              fetal_heart_rate_bpm, hb_gm_dl, urine_albumin, urine_sugar,
              iron_folic_acid_given, calcium_given, tt_dose,
              next_visit_date, notes
         FROM maternity_anc_visits
        WHERE tenant_id = $2::uuid AND pregnancy_id = $1::int
        ORDER BY visit_date DESC, id DESC`,
      id, tid,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, supplement, dose, frequency, route, start_date,
              end_date, reminder_enabled, notes, prescribed_by, created_at
         FROM maternity_supplements
        WHERE tenant_id = $2::uuid AND pregnancy_id = $1::int
        ORDER BY start_date DESC`,
      id, tid,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, log_date, kick_count, observation_window_minutes,
              low_count_flag, notes
         FROM maternity_fetal_kicks
        WHERE tenant_id = $2::uuid AND pregnancy_id = $1::int
        ORDER BY log_date DESC
        LIMIT 30`,
      id, tid,
    ),
  ]);
  if (!pregnancy.length) throw AppError.notFound(`Pregnancy ${id} not found`);
  const p = pregnancy[0];

  // Carry forward active supplement prescriptions onto the ANC
  // schedule so prior IFA / calcium courses surface as continued
  // orders the doctor can keep, not retype. Deduped against
  // structured maternity_supplements rows (and within itself) by
  // supplement kind so the same course isn't listed twice. Best-
  // effort: a scan failure must not break the timeline read. Finding:
  // 2026-05-10-obstetric-anc-doctor-supplements-not-carried-forward.
  const carriedForward = [];
  try {
    const activeRx = await prisma.$queryRawUnsafe(
      `SELECT id, prescription_number, medications, created_at
         FROM e_prescriptions
        WHERE patient_uid = $1::uuid
          AND tenant_id = $2::uuid
          AND COALESCE(status, 'active') = 'active'
        ORDER BY created_at DESC
        LIMIT 50`,
      String(p.patient_uid), tid,
    );
    const covered = new Set(dedupeActiveSupplementTherapies(supplements).map((s) => supplementTherapyKey(s)));
    for (const s of extractCarriedForwardSupplements(activeRx)) {
      const key = supplementTherapyKey(s);
      if (covered.has(key)) continue;
      covered.add(key);
      carriedForward.push(s);
    }
  } catch (e) {
    logger.warn(`ANC carry-forward supplement scan failed for pregnancy=${id}: ${e.message}`);
  }

  // Booked ANC appointments — the timeline previously showed only
  // recorded maternity_anc_visits, so a booked-but-not-yet-attended
  // visit (e.g. today's 24-week appointment) was invisible. Scope to
  // OB/ANC appointments within the pregnancy window. Best-effort.
  // Finding:
  // 2026-05-10-obstetric-anc-receptionist-anc-timeline-omits-booked-visit.
  let bookedVisits = [];
  try {
    bookedVisits = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.appointment_date, a.appointment_time, a.status,
              a.reason, a.department, a.token_number, a.visit_no, a.visit_type
         FROM appointments a
         JOIN users u ON u.id = a.patient_id
        WHERE u.uid = $1::uuid
          AND u.tenant_id = $2::uuid
          AND a.tenant_id = $2::uuid
          AND a.status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
          AND a.appointment_date >= COALESCE($3::date, a.appointment_date)
          AND (
            a.visit_no LIKE 'ANC-%'
            OR a.department ILIKE '%obstet%'
            OR a.department ILIKE '%gyn%'
            OR a.department ILIKE '%antenatal%'
            OR a.department ILIKE '%anc%'
          )
        ORDER BY a.appointment_date DESC, a.appointment_time DESC
        LIMIT 50`,
      String(p.patient_uid), tid, p.lmp_date || null,
    );
  } catch (e) {
    logger.warn(`ANC booked-visit scan failed for pregnancy=${id}: ${e.message}`);
  }

  // Vitals recorded through the generic vitals path (vitals_chart, e.g.
  // POST /emr/vitals from the staff app) within the pregnancy window. ANC
  // visits entered via the maternity composer land in maternity_anc_visits
  // and show as `visits`, but a nurse who recorded BP / weight on the
  // general vitals screen during this pregnancy had those readings
  // invisible on the ANC timeline. Surface them so the OB vitals populate
  // the timeline regardless of which screen captured them. Scope to >= LMP.
  // Best-effort: a scan failure must not break the timeline read.
  // Finding 2026-05-20-obstetric-anc-nurse-d4c9c118 (+ 971d3a14, e8bdd0ca).
  let generalVitals = [];
  try {
    generalVitals = await prisma.$queryRawUnsafe(
      `SELECT id, recorded_at, systolic_bp, diastolic_bp, heart_rate,
              temperature, spo2, weight_kg
         FROM vitals_chart
        WHERE patient_uid = $1::uuid
          AND tenant_id = $2::uuid
          AND recorded_at >= COALESCE($3::date, recorded_at)
        ORDER BY recorded_at DESC
        LIMIT 50`,
      String(p.patient_uid), tid, p.lmp_date || null,
    );
  } catch (e) {
    logger.warn(`ANC general-vitals scan failed for pregnancy=${id}: ${e.message}`);
  }

  // Prior obstetric imaging (anomaly / dating / growth scans, dopplers)
  // ordered for this patient during the pregnancy. The doctor's ANC
  // timeline previously showed visits + vitals + supplements but NO
  // imaging, so a completed 18-week anomaly scan was invisible when the
  // doctor opened the 24-week chart — and the soft duplicate-order guard
  // (orderService) only fires AFTER a re-order is attempted. Surfacing
  // the prior scan inline (with its status + result summary) lets the
  // doctor see "anomaly scan already done" before ordering, avoiding a
  // duplicate USG. Scoped to RADIOLOGY-type investigations whose name or
  // code reads as obstetric ultrasound so an unrelated chest X-ray does
  // not land on the ANC timeline. Joined via patient_id (always set by
  // orderService) with a patient_uid fallback for legacy rows. Best-
  // effort: a scan failure must not break the timeline read. Finding:
  //   2026-05-22-obstetric-anc-doctor-8d245f7c.
  let priorImaging = [];
  try {
    priorImaging = await prisma.$queryRawUnsafe(
      `SELECT i.id, i.test_name, i.test_code, i.test_type, i.status,
              i.priority, i.requested_at, i.completed_at, i.result_summary,
              i.result_uploaded_at
         FROM investigations i
         JOIN users u ON (u.id = i.patient_id OR u.uid = i.patient_uid)
        WHERE u.uid = $1::uuid
          AND u.tenant_id = $2::uuid
          AND i.tenant_id = $2::uuid
          AND UPPER(COALESCE(i.test_type, i.investigation_type, i.type)) = 'RADIOLOGY'
          AND i.status <> 'CANCELLED'
          AND i.created_at >= COALESCE($3::date, i.created_at)
          AND (
            i.test_name ILIKE '%ultrasound%'
            OR i.test_name ILIKE '%uss%'
            OR i.test_name ILIKE '%usg%'
            OR i.test_name ILIKE '%scan%'
            OR i.test_name ILIKE '%anomal%'
            OR i.test_name ILIKE '%doppler%'
            OR i.test_name ILIKE '%nuchal%'
            OR i.test_name ILIKE '%biophysical%'
            OR i.test_code ILIKE '%usg%'
          )
        ORDER BY i.requested_at DESC
        LIMIT 50`,
      String(p.patient_uid), tid, p.lmp_date || null,
    );
  } catch (e) {
    logger.warn(`ANC prior-imaging scan failed for pregnancy=${id}: ${e.message}`);
  }

  // Forward/back ANC care schedule computed from LMP, so the timeline
  // shows where the current visit sits in the plan and what's next.
  bookedVisits = bookedVisits.map((visit) => decorateBookedAncVisit(visit, p.lmp_date));

  const scheduleMilestones = computeAncScheduleMilestones(p.lmp_date);

  return {
    pregnancy: { ...p, gestational_age: computeGestationalAge(p.lmp_date) },
    visits,
    general_vitals: generalVitals,
    booked_visits: bookedVisits,
    schedule_milestones: scheduleMilestones,
    supplements: dedupeActiveSupplementTherapies(supplements).map(withDoseSchedule),
    carried_forward_supplements: carriedForward.map(withDoseSchedule),
    // `completed` is the at-a-glance flag the OB chart uses to render an
    // "already done — confirm before re-ordering" chip next to each prior
    // scan. Derived from status so the UI doesn't re-implement the enum.
    prior_imaging: priorImaging.map((row) => ({
      ...row,
      completed: String(row.status).toUpperCase() === 'COMPLETED',
    })),
    fetal_kicks: kicks,
  };
}

export function projectAncTimelineForPatient(timeline) {
  if (!timeline || typeof timeline !== 'object') return timeline;

  // Neither imaging source has a patient-release contract. Keep the entire
  // imaging collection out of patient responses until release can be proven.
  const patientTimeline = { ...timeline };
  delete patientTimeline.prior_imaging;
  return patientTimeline;
}

/**
 * Convenience: timeline for the patient's active pregnancy.
 * Returns null if no ongoing pregnancy exists.
 */
export async function getAncTimelineForPatient({ tenantId, patient_uid }) {
  const active = await getActivePregnancyForPatient({ tenantId, patient_uid });
  if (!active) return null;
  return getAncTimelineForPregnancy({ tenantId, pregnancy_id: active.id });
}

function supplementTherapyKey(row) {
  if (row?.supplement === 'folic_acid') return 'iron';
  if (row?.supplement === 'vitamin_d') return 'calcium';
  return row?.supplement || 'other';
}

function supplementPriority(row) {
  if (row?.supplement === 'iron' || row?.supplement === 'calcium') return 0;
  if (row?.supplement === 'folic_acid' || row?.supplement === 'vitamin_d') return 1;
  return 2;
}

function dedupeActiveSupplementTherapies(rows) {
  const byTherapy = new Map();
  for (const row of rows || []) {
    const key = supplementTherapyKey(row);
    const current = byTherapy.get(key);
    if (!current) {
      byTherapy.set(key, { row, duplicateIds: [] });
      continue;
    }
    const nextPriority = supplementPriority(row);
    const currentPriority = supplementPriority(current.row);
    const nextCreated = new Date(row?.created_at || row?.start_date || 0).getTime();
    const currentCreated = new Date(current.row?.created_at || current.row?.start_date || 0).getTime();
    if (nextPriority < currentPriority || (nextPriority === currentPriority && nextCreated > currentCreated)) {
      byTherapy.set(key, { row, duplicateIds: [current.row.id, ...current.duplicateIds].filter(Boolean) });
    } else if (row?.id) {
      current.duplicateIds.push(row.id);
    }
  }
  return [...byTherapy.values()].map(({ row, duplicateIds }) => ({
    ...row,
    duplicate_count: duplicateIds.length,
    deduped_from_ids: duplicateIds,
  }));
}

const VALID_SUPPLEMENTS = new Set([
  'iron', 'folic_acid', 'calcium', 'vitamin_d', 'b_complex', 'other',
]);
const VALID_FREQUENCIES = new Set([
  'once_daily', 'twice_daily', 'thrice_daily', 'weekly', 'as_needed',
]);

// Default dose times (IST, 24h) per supplement frequency. A supplement row
// only stored `frequency` + `reminder_enabled`, so the patient app had no
// concrete times to fire a reminder at — "take iron once daily" with no
// "when". This maps the frequency to a clinically-sensible daily schedule
// the app can turn into reminders. Finding: ANC supplement reminders lack
// a daily-dose schedule.
const SUPPLEMENT_DOSE_TIMES = {
  once_daily: ['09:00'],
  twice_daily: ['09:00', '21:00'],
  thrice_daily: ['08:00', '14:00', '20:00'],
  weekly: ['09:00'], // single dose on the dosing day
  as_needed: [], // no fixed schedule — taken on symptom
};

/**
 * Resolve a supplement's frequency to a concrete dose schedule the patient
 * app can build reminders from. Pure + exported for unit testing. Unknown
 * frequencies fall back to once-daily (better a 09:00 reminder than none).
 */
export function supplementDoseSchedule(frequency) {
  const key = String(frequency || 'once_daily').toLowerCase();
  const times = SUPPLEMENT_DOSE_TIMES[key] || SUPPLEMENT_DOSE_TIMES.once_daily;
  return { frequency: key, times, timezone: 'Asia/Kolkata' };
}

// Attach dose_schedule to a supplement row (read-path enrichment).
const withDoseSchedule = (s) => ({ ...s, dose_schedule: supplementDoseSchedule(s?.frequency) });

// maternity_supplements.dose is VARCHAR(60). Reject longer values with a
// 400 + field-level message instead of letting the INSERT raise a generic
// 500 ("value too long for type character varying(60)"). Finding:
// 2026-05-10-obstetric-anc-doctor-supplement-dose-500.
const DOSE_MAX_LEN = 60;

export async function recordSupplement({
  tenantId, pregnancy_id, supplement, dose, frequency, route, start_date,
  end_date, reminder_enabled, notes, prescribed_by,
  actor_uid, actor_role,
}) {
  if (!pregnancy_id) throw AppError.badRequest('pregnancy_id is required');
  if (!supplement || !VALID_SUPPLEMENTS.has(supplement)) {
    throw AppError.badRequest(`Invalid supplement: ${supplement}. Must be one of: ${[...VALID_SUPPLEMENTS].join(', ')}`);
  }
  if (frequency && !VALID_FREQUENCIES.has(frequency)) {
    throw AppError.badRequest(`Invalid frequency: ${frequency}`);
  }
  if (dose != null && typeof dose === 'string' && dose.length > DOSE_MAX_LEN) {
    throw AppError.badRequest(
      `dose must be ${DOSE_MAX_LEN} characters or fewer (got ${dose.length}). ` +
      `Use a short form like "Iron 60mg + FA 500mcg".`,
    );
  }
  if (!prescribed_by) throw AppError.badRequest('prescribed_by is required');
  const tid = tenantOr(tenantId);
  const pregnancy = await assertPregnancyInTenant(tid, pregnancy_id);
  const pregnancyId = Number(pregnancy.id);
  const startDate = start_date || new Date().toISOString().slice(0, 10);
  const frequencyValue = frequency || 'once_daily';
  const routeValue = route || 'oral';

  return setTenantTx(tid, async (tx) => {
    const lockedPregnancies = await tx.$queryRawUnsafe(
      `SELECT id
         FROM maternity_pregnancies
        WHERE tenant_id = $1::uuid AND id = $2::int
        FOR UPDATE`,
      tid,
      pregnancyId,
    );
    if (!lockedPregnancies.length) throw AppError.notFound('Pregnancy not found');

    const existing = await tx.$queryRawUnsafe(
      `SELECT id, pregnancy_id, supplement, dose, frequency, route, start_date,
              end_date, reminder_enabled, notes, prescribed_by, tenant_id,
              created_at, updated_at
         FROM maternity_supplements
         WHERE tenant_id = $1::uuid
           AND pregnancy_id = $2::int
           AND supplement = $3
           AND (end_date IS NULL OR end_date >= CURRENT_DATE)
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
      tid, pregnancyId, supplement,
    );
    let recordedSupplement;
    if (existing.length) {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE maternity_supplements
            SET dose = COALESCE($4, dose),
                frequency = $5,
                route = $6,
                start_date = COALESCE($7::date, start_date),
                end_date = COALESCE($8::date, end_date),
                reminder_enabled = COALESCE($9::boolean, reminder_enabled),
                notes = COALESCE($10, notes),
                prescribed_by = $11::uuid,
                updated_at = NOW()
          WHERE id = $1::int
            AND tenant_id = $2::uuid
            AND pregnancy_id = $3::int
            AND (
              dose IS DISTINCT FROM COALESCE($4, dose)
              OR frequency IS DISTINCT FROM $5
              OR route IS DISTINCT FROM $6
              OR start_date IS DISTINCT FROM COALESCE($7::date, start_date)
              OR end_date IS DISTINCT FROM COALESCE($8::date, end_date)
              OR reminder_enabled IS DISTINCT FROM COALESCE($9::boolean, reminder_enabled)
              OR notes IS DISTINCT FROM COALESCE($10, notes)
              OR prescribed_by IS DISTINCT FROM $11::uuid
            )
          RETURNING *, TRUE AS continued`,
        Number(existing[0].id), tid, pregnancyId,
        dose || null, frequencyValue, routeValue, startDate,
        end_date || null, reminder_enabled !== undefined ? reminder_enabled !== false : null,
        notes || null, String(prescribed_by),
      );
      if (!rows.length) return { ...existing[0], continued: true };
      recordedSupplement = rows[0];
    } else {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO maternity_supplements
           (pregnancy_id, supplement, dose, frequency, route, start_date,
            end_date, reminder_enabled, notes, prescribed_by, tenant_id)
         VALUES ($1::int, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10::uuid, $11::uuid)
         RETURNING *, FALSE AS continued`,
        pregnancyId, supplement, dose || null,
        frequencyValue, routeValue,
        startDate,
        end_date || null, reminder_enabled !== false, notes || null,
        String(prescribed_by), tid,
      );
      recordedSupplement = rows[0];
    }

    const canonicalRevision = canonicalStateFingerprint({
      pregnancy_id: Number(recordedSupplement.pregnancy_id),
      supplement: recordedSupplement.supplement,
      dose: recordedSupplement.dose || null,
      frequency: recordedSupplement.frequency,
      route: recordedSupplement.route,
      start_date: recordedSupplement.start_date,
      end_date: recordedSupplement.end_date || null,
      reminder_enabled: recordedSupplement.reminder_enabled,
      notes: recordedSupplement.notes || null,
      prescribed_by: recordedSupplement.prescribed_by
        ? String(recordedSupplement.prescribed_by)
        : null,
    });
    // Exact retries returned above without touching the tuple; every write
    // that reaches this point changed persisted state, so stamp the key with
    // this transaction's xid8 to keep A -> B -> A revisions distinct.
    const txRevision = await currentCanonicalTransactionRevision(tx);
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: String(pregnancy.patient_uid),
      eventType: 'maternity.supplement_recorded',
      eventStatus: recordedSupplement.continued ? 'continued' : 'recorded',
      sourceTable: 'maternity_supplements',
      sourceId: recordedSupplement.id,
      resourceType: 'maternity_supplement',
      resourceId: recordedSupplement.id,
      actorUid: actor_uid || prescribed_by || null,
      actorRole: actor_role || null,
      occurredAt: recordedSupplement.updated_at,
      visibleToPatient: false,
      summary: recordedSupplement.continued
        ? 'Maternity supplement continued'
        : 'Maternity supplement recorded',
      payload: {
        supplement_id: recordedSupplement.id,
        pregnancy_id: pregnancyId,
        supplement: recordedSupplement.supplement,
        frequency: recordedSupplement.frequency,
        continued: recordedSupplement.continued,
      },
      afterState: {
        reminder_enabled: recordedSupplement.reminder_enabled,
        continued: recordedSupplement.continued,
      },
      tags: ['maternity', 'supplement'],
      timelineIdempotencyKey: `maternity_supplements:${recordedSupplement.id}:${canonicalRevision}:tx:${txRevision}`,
      auditIdempotencyKey: `maternity_supplements:${recordedSupplement.id}:audit:${canonicalRevision}:tx:${txRevision}`,
    }, { db: tx, strict: true });

    return recordedSupplement;
  });
}

// Map common medication names → supplement enum used by maternity_supplements.
// The match runs against the medication's `name` field as written on the
// prescription (free text). One name can map to multiple supplements
// because OB combo drugs are routine (e.g. "Calcium 500mg + Vitamin D3
// 250IU" → calcium + vitamin_d).
const SUPPLEMENT_PATTERNS = [
  { kind: 'iron',       re: /\b(iron|ferrous|ferric)\b/i },
  { kind: 'folic_acid', re: /\b(folic\s*acid|folate)\b/i },
  { kind: 'calcium',    re: /\bcalcium\b/i },
  { kind: 'vitamin_d',  re: /\b(vit(?:amin)?\s*d3?|cholecalciferol)\b/i },
  { kind: 'b_complex',  re: /\b(b[\s-]?complex|vit(?:amin)?\s*b)\b/i },
];

function collapseComboSupplementMatches(matches) {
  const out = new Set(matches || []);
  if (out.has('iron') && out.has('folic_acid')) out.delete('folic_acid');
  if (out.has('calcium') && out.has('vitamin_d')) out.delete('vitamin_d');
  return [...out];
}

// Map prescription-form frequency labels (OD/BD/TDS/QID + long forms)
// to maternity_supplements.frequency enum. Anything unrecognised falls
// back to once_daily — better to schedule a reminder at 09:00 than to
// silently drop the supplement.
const FREQ_MAP = {
  od: 'once_daily', 'qd': 'once_daily', daily: 'once_daily', 'once_daily': 'once_daily', 'once daily': 'once_daily',
  bd: 'twice_daily', bid: 'twice_daily', 'twice_daily': 'twice_daily', 'twice daily': 'twice_daily',
  tds: 'thrice_daily', tid: 'thrice_daily', 'thrice_daily': 'thrice_daily', 'thrice daily': 'thrice_daily',
  qid: 'thrice_daily', // 4x maps onto thrice_daily — closest valid bucket
  weekly: 'weekly',
  sos: 'as_needed', prn: 'as_needed', 'as_needed': 'as_needed', 'as needed': 'as_needed',
};

/**
 * Extract pregnancy-relevant supplements from a set of e_prescriptions
 * rows so the ANC supplement schedule can surface prior IFA / calcium
 * courses as continued orders the doctor can keep instead of retyping.
 * Each entry carries the source prescription so the timeline can show
 * a "from last visit" / "active" indicator. Reuses the same name and
 * frequency mapping as maybePropagateAncSupplements. Finding:
 * 2026-05-10-obstetric-anc-doctor-supplements-not-carried-forward.
 */
export function extractCarriedForwardSupplements(prescriptions) {
  const out = [];
  for (const rx of prescriptions || []) {
    const meds = Array.isArray(rx?.medications) ? rx.medications : [];
    for (const med of meds) {
      if (!med || typeof med !== 'object') continue;
      const name = String(med.name || med.medication || med.medicine || '').trim();
      if (!name) continue;

      const matches = collapseComboSupplementMatches(SUPPLEMENT_PATTERNS
        .filter(({ re }) => re.test(name))
        .map(({ kind }) => kind));
      if (!matches.length) continue;

      const freqRaw = String(med.frequency || med.freq || '').toLowerCase().trim();
      const frequency = FREQ_MAP[freqRaw] || 'once_daily';
      const dose = String(med.dose || med.dosage || med.strength || '').trim() || null;

      for (const supplement of matches) {
        out.push({
          supplement,
          dose,
          frequency,
          route: 'oral',
          source: 'prescription',
          carried_forward: true,
          prescription_id: rx.id,
          prescription_number: rx.prescription_number,
          prescribed_on: rx.created_at,
          medication_name: name,
        });
      }
    }
  }
  return out;
}

/**
 * Propagate pregnancy-relevant medications from a prescription into
 * maternity_supplements so the patient app's reminder pipeline fires.
 *
 * Called from the prescription create flow as Phase 1.5 best-effort —
 * any error inside MUST be caught by the caller. Returns the rows it
 * inserted (possibly empty); idempotent on a per-pregnancy basis: if
 * an active row already exists for the same supplement kind, the
 * medication is skipped instead of duplicated.
 *
 * Finding: 2026-05-09-obstetric-anc-patient-supplements-missing.
 */
export async function maybePropagateAncSupplements({
  tenantId, patient_uid, medications, prescribed_by,
  actor_uid, actor_role,
}) {
  if (!patient_uid || !prescribed_by) return [];
  if (!Array.isArray(medications) || medications.length === 0) return [];
  const tid = tenantOr(tenantId);
  await assertPatientInTenant(tid, patient_uid);

  const pregRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM maternity_pregnancies
       WHERE tenant_id = $1::uuid
         AND patient_uid = $2::uuid
         AND status = 'ongoing'
       ORDER BY created_at DESC
       LIMIT 1`,
    tid,
    String(patient_uid),
  );
  if (!pregRows.length) return [];
  const pregnancyId = Number(pregRows[0].id);

  return setTenantTx(tid, async (tx) => {
    const lockedPregnancies = await tx.$queryRawUnsafe(
      `SELECT id
         FROM maternity_pregnancies
        WHERE tenant_id = $1::uuid AND id = $2::int
        FOR UPDATE`,
      tid,
      pregnancyId,
    );
    if (!lockedPregnancies.length) throw AppError.notFound('Pregnancy not found');

    const created = [];
    for (const med of medications) {
      if (!med || typeof med !== 'object') continue;
      const name = String(med.name || med.medication || med.medicine || '').trim();
      if (!name) continue;

      const matches = collapseComboSupplementMatches(SUPPLEMENT_PATTERNS
        .filter(({ re }) => re.test(name))
        .map(({ kind }) => kind));
      if (!matches.length) continue;

      const freqRaw = String(med.frequency || med.freq || '').toLowerCase().trim();
      const frequency = FREQ_MAP[freqRaw] || 'once_daily';
      const dose = String(med.dose || med.dosage || med.strength || '').trim() || null;

      for (const supplement of matches) {
        const existing = await tx.$queryRawUnsafe(
          `SELECT id FROM maternity_supplements
             WHERE tenant_id = $1::uuid
               AND pregnancy_id = $2::int
               AND supplement = $3
               AND (end_date IS NULL OR end_date >= CURRENT_DATE)
             LIMIT 1`,
          tid, pregnancyId, supplement,
        );
        if (existing.length) continue;

        const inserted = await tx.$queryRawUnsafe(
          `INSERT INTO maternity_supplements
             (pregnancy_id, supplement, dose, frequency, route,
              reminder_enabled, notes, prescribed_by, tenant_id)
           VALUES ($1::int, $2, $3, $4, 'oral', TRUE,
                   'Auto-propagated from prescription', $5::uuid, $6::uuid)
           RETURNING id, supplement, dose, frequency, start_date`,
          pregnancyId, supplement, dose, frequency,
          String(prescribed_by), tid,
        );
        const propagated = inserted[0];

        await recordCanonicalClinicalEvent({
          tenantId: tid,
          patientUid: String(patient_uid),
          eventType: 'maternity.supplement_recorded',
          eventSubtype: 'prescription_propagated',
          eventStatus: 'recorded',
          sourceTable: 'maternity_supplements',
          sourceId: propagated.id,
          resourceType: 'maternity_supplement',
          resourceId: propagated.id,
          actorUid: actor_uid || prescribed_by || null,
          actorRole: actor_role || null,
          visibleToPatient: false,
          summary: 'Maternity supplement propagated from prescription',
          payload: {
            supplement_id: propagated.id,
            pregnancy_id: pregnancyId,
            supplement: propagated.supplement,
            frequency: propagated.frequency,
            source_kind: 'prescription',
          },
          afterState: {
            reminder_enabled: true,
            propagated_from_prescription: true,
          },
          tags: ['maternity', 'supplement', 'prescription-propagated'],
          timelineIdempotencyKey: `maternity_supplements:${propagated.id}:recorded`,
          auditIdempotencyKey: `maternity_supplements:${propagated.id}:audit:recorded`,
        }, { db: tx, strict: true });

        created.push(propagated);
      }
    }

    return created;
  });
}

export async function listSupplements({ tenantId, pregnancy_id, activeOnly = false }) {
  const id = Number.parseInt(pregnancy_id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('pregnancy_id must be a positive integer');
  }
  const tid = tenantOr(tenantId);
  await assertPregnancyInTenant(tid, id);
  const baseSql = `
    SELECT id, supplement, dose, frequency, route, start_date, end_date,
           reminder_enabled, notes, prescribed_by, created_at, updated_at
      FROM maternity_supplements
     WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`;
  const sql = activeOnly
    ? `${baseSql} AND (end_date IS NULL OR end_date >= CURRENT_DATE) ORDER BY start_date DESC`
    : `${baseSql} ORDER BY start_date DESC`;
  return prisma.$queryRawUnsafe(sql, tid, id);
}

/**
 * Daily fetal kick log. Computes low_count_flag against the standard
 * 10-kicks-in-12h threshold (scaled if observation window differs).
 * UPSERT on (pregnancy_id, log_date) so a patient editing today's
 * count doesn't create duplicates.
 */
export async function recordFetalKick({
  tenantId, pregnancy_id, log_date, kick_count,
  observation_window_minutes, notes, recorded_by,
  actor_uid, actor_role,
}) {
  if (!pregnancy_id) throw AppError.badRequest('pregnancy_id is required');
  const tid = tenantOr(tenantId);
  const pregnancy = await assertPregnancyInTenant(tid, pregnancy_id);
  const count = Number.parseInt(kick_count, 10);
  if (!Number.isInteger(count) || count < 0 || count > 999) {
    throw AppError.badRequest('kick_count must be 0..999');
  }
  const window = Math.max(60, Math.min(1440, Number(observation_window_minutes) || 720));
  // Standard threshold scaled to the observation window.
  const threshold = Math.ceil(10 * (window / 720));
  const lowFlag = count < threshold;
  const day = log_date || new Date().toISOString().slice(0, 10);

  return setTenantTx(tid, async (tx) => {
    const lockedPregnancies = await tx.$queryRawUnsafe(
      `SELECT id
         FROM maternity_pregnancies
        WHERE tenant_id = $1::uuid AND id = $2::int
        FOR UPDATE`,
      tid,
      pregnancy.id,
    );
    if (!lockedPregnancies.length) throw AppError.notFound('Pregnancy not found');

    const existing = await tx.$queryRawUnsafe(
      `SELECT id, pregnancy_id, log_date, kick_count, observation_window_minutes,
              low_count_flag, notes, recorded_by, tenant_id, created_at, updated_at
         FROM maternity_fetal_kicks
        WHERE tenant_id = $1::uuid
          AND pregnancy_id = $2::int
          AND log_date = $3::date
        FOR UPDATE`,
      tid,
      Number(pregnancy.id),
      day,
    );
    const prior = existing[0] || null;
    const effectiveNotes = notes || prior?.notes || null;
    if (prior
      && Number(prior.kick_count) === count
      && Number(prior.observation_window_minutes) === window
      && prior.low_count_flag === lowFlag
      && (prior.notes || null) === effectiveNotes) {
      return prior;
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO maternity_fetal_kicks
         (pregnancy_id, log_date, kick_count, observation_window_minutes,
          low_count_flag, notes, recorded_by, tenant_id)
       VALUES ($1::int, $2::date, $3::int, $4::int, $5, $6, $7::uuid, $8::uuid)
       ON CONFLICT (pregnancy_id, log_date)
       DO UPDATE SET kick_count = EXCLUDED.kick_count,
                     observation_window_minutes = EXCLUDED.observation_window_minutes,
                     low_count_flag = EXCLUDED.low_count_flag,
                     notes = COALESCE(EXCLUDED.notes, maternity_fetal_kicks.notes),
                     updated_at = NOW()
       RETURNING *`,
      Number(pregnancy.id), day, count, window, lowFlag,
      notes || null,
      recorded_by ? String(recorded_by) : null,
      tid,
    );
    const fetalKick = rows[0];
    const canonicalActorUid = actor_uid || recorded_by || null;
    const patientGenerated = String(actor_role || '').toUpperCase() === 'PATIENT'
      || String(canonicalActorUid || '') === String(pregnancy.patient_uid);
    const verificationStatus = patientGenerated ? 'unverified' : 'verified';
    const canonicalRevision = canonicalStateFingerprint({
      pregnancy_id: Number(fetalKick.pregnancy_id),
      log_date: fetalKick.log_date,
      kick_count: Number(fetalKick.kick_count),
      observation_window_minutes: Number(fetalKick.observation_window_minutes),
      low_count_flag: fetalKick.low_count_flag,
      notes: fetalKick.notes || null,
      recorded_by: fetalKick.recorded_by ? String(fetalKick.recorded_by) : null,
    });
    // Exact retries returned above via the prior-state guard; this write
    // changed persisted state, so bind the revision to this transaction.
    const txRevision = await currentCanonicalTransactionRevision(tx);

    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: String(pregnancy.patient_uid),
      eventType: 'maternity.fetal_kick_recorded',
      eventStatus: patientGenerated ? 'unverified' : 'recorded',
      sourceTable: 'maternity_fetal_kicks',
      sourceId: fetalKick.id,
      resourceType: 'fetal_kick_log',
      resourceId: fetalKick.id,
      actorUid: canonicalActorUid,
      actorRole: actor_role || null,
      occurredAt: fetalKick.updated_at,
      visibleToPatient: false,
      summary: patientGenerated
        ? 'Patient-generated fetal kick count recorded — unverified'
        : 'Fetal kick count recorded',
      payload: {
        fetal_kick_id: fetalKick.id,
        pregnancy_id: pregnancy.id,
        kick_count: fetalKick.kick_count,
        observation_window_minutes: fetalKick.observation_window_minutes,
        source_kind: patientGenerated ? 'patient_generated' : 'staff_recorded',
        verification_status: verificationStatus,
      },
      afterState: {
        kick_count: fetalKick.kick_count,
        low_count_flag: fetalKick.low_count_flag,
        verification_status: verificationStatus,
      },
      tags: patientGenerated
        ? ['maternity', 'fetal-kick', 'patient_generated', 'unverified']
        : ['maternity', 'fetal-kick', 'staff-recorded'],
      timelineIdempotencyKey: `maternity_fetal_kicks:${fetalKick.id}:${canonicalRevision}:tx:${txRevision}`,
      auditIdempotencyKey: `maternity_fetal_kicks:${fetalKick.id}:audit:${canonicalRevision}:tx:${txRevision}`,
    }, { db: tx, strict: true });

    return fetalKick;
  });
}

/**
 * E-12 — prior-orders timeline for a pregnancy. Returns active /
 * recent investigations + e_prescriptions tied to the patient
 * (across the pregnancy window) so the OB can see "Anomaly USG —
 * done 18w" and "Iron+folate — currently active" before re-ordering.
 * Finding: 2026-05-08-obstetric-anc-doctor-no-prior-orders-surfaced.
 */
export async function listPriorOrdersForPregnancy({ tenantId, pregnancy_id }) {
  const id = Number.parseInt(pregnancy_id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('pregnancy_id must be a positive integer');
  }
  const tid = tenantOr(tenantId);
  // Resolve patient_uid + LMP from the pregnancy to scope the join.
  const pregRows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid, lmp_date, created_at
       FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    tid, id,
  );
  if (!pregRows.length) throw AppError.notFound(`Pregnancy ${id} not found`);
  const { patient_uid, lmp_date, created_at } = pregRows[0];
  const since = lmp_date || created_at;

  const [investigations, prescriptions] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT i.id, i.test_name, i.test_code, i.test_type, i.status,
              i.priority, i.requested_at, i.completed_at, i.result_summary,
              i.result_uploaded_at
         FROM investigations i
         JOIN users u ON u.id = i.patient_id
        WHERE u.uid = $1::uuid
          AND u.tenant_id = $2::uuid
          AND i.tenant_id = $2::uuid
          AND i.created_at >= $3::timestamptz
        ORDER BY i.requested_at DESC
        LIMIT 50`,
      patient_uid, tid, since,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, prescription_number, diagnosis, medications, status,
              created_at, follow_up_date
         FROM e_prescriptions
        WHERE patient_uid = $1::uuid
          AND tenant_id = $2::uuid
          AND created_at >= $3::timestamptz
        ORDER BY created_at DESC
        LIMIT 50`,
      patient_uid, tid, since,
    ),
  ]);

  // Bucket investigations by test_code so the UI can show "CBC: 4
  // prior, last 24w" instead of repeating each.
  const investigationsByCode = {};
  for (const inv of investigations) {
    const k = inv.test_code || inv.test_name || 'OTHER';
    if (!investigationsByCode[k]) investigationsByCode[k] = [];
    investigationsByCode[k].push(inv);
  }
  return {
    pregnancy_id: id,
    patient_uid,
    since,
    investigations,
    investigations_by_code: investigationsByCode,
    prescriptions,
  };
}

export async function listFetalKicks({ tenantId, pregnancy_id, fromDate = null, toDate = null }) {
  const id = Number.parseInt(pregnancy_id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('pregnancy_id must be a positive integer');
  }
  const tid = tenantOr(tenantId);
  await assertPregnancyInTenant(tid, id);
  const params = [tid, id];
  let dateClause = '';
  if (fromDate) { params.push(fromDate); dateClause += ` AND log_date >= $${params.length}::date`; }
  if (toDate) { params.push(toDate); dateClause += ` AND log_date <= $${params.length}::date`; }
  return prisma.$queryRawUnsafe(
    `SELECT id, log_date, kick_count, observation_window_minutes,
            low_count_flag, notes, recorded_by, created_at
       FROM maternity_fetal_kicks
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int${dateClause}
      ORDER BY log_date DESC
      LIMIT 90`,
    ...params,
  );
}

/**
 * Maternity / delivery packages for the patient pre-booking surface
 * and the receptionist pricing quote. Reads the obstetrics rows from
 * the shared `packages` master (seeded by migration 226). Prices are
 * NULL until the hospital's finance team fills them in — the response
 * carries the price_status placeholder so the UI shows "pricing under
 * review" rather than a fabricated number. Finding:
 * 2026-05-09-walk-in-opd-patient-maternity-package-forbidden.
 */
export async function listMaternityPackages({ tenantId }) {
  const tid = tenantOr(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, package_code, display_name, description,
            base_specialty, base_procedure_code, duration_days,
            fixed_price_minor, currency, status,
            inclusion_notes, exclusion_notes, metadata
       FROM packages
      WHERE tenant_id = $1::uuid
        AND base_specialty = 'obstetrics'
        AND status = 'active'
      ORDER BY display_name`,
    tid,
  );
  return rows.map((r) => ({
    ...r,
    // fixed_price_minor is a Postgres bigint → Prisma returns BigInt,
    // which JSON.stringify cannot serialise. Coerce to Number; NULL
    // (price not yet set) stays NULL.
    fixed_price_minor: r.fixed_price_minor == null ? null : Number(r.fixed_price_minor),
    price_status: r.metadata?.price_status
      ?? (r.fixed_price_minor == null
        ? '[PLACEHOLDER — clinical/financial review required]'
        : null),
  }));
}

/**
 * Trimester-specific patient ANC advice (danger signs, fetal-movement
 * guidance, foods to avoid, when to contact the hospital). Reads
 * maternity_anc_advice (migration 226). Scoped to one trimester when
 * given, else all three. Seeded content is a review placeholder — the
 * clinical team owns the real Hindi copy. Finding:
 * 2026-05-10-obstetric-anc-patient-no-kick-counter-or-ob-advice.
 */
const PLACEHOLDER_CONTENT_RE = /\[PLACEHOLDER\b/i;

function decorateAncAdviceRows(rows, { includePlaceholders }) {
  return rows.map((row) => {
    const placeholder = PLACEHOLDER_CONTENT_RE.test(String(row.content || ''));
    if (!placeholder) return { ...row, content_status: 'reviewed' };
    return {
      ...row,
      content: includePlaceholders ? row.content : null,
      content_status: 'pending_clinical_review',
    };
  });
}

export async function getAncAdvice({
  tenantId, trimester = null, language = 'hi', includePlaceholders = true,
}) {
  const tid = tenantOr(tenantId);
  const lang = language || 'hi';
  const params = [tid, lang];
  let trimesterClause = '';
  if (trimester != null && trimester !== '') {
    const t = Number.parseInt(trimester, 10);
    if (!Number.isInteger(t) || t < 1 || t > 3) {
      throw AppError.badRequest('trimester must be 1, 2, or 3');
    }
    params.push(t);
    trimesterClause = ` AND trimester = $${params.length}::int`;
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, trimester, language, category, title, content, display_order
       FROM maternity_anc_advice
      WHERE tenant_id = $1::uuid AND language = $2 AND active = true${trimesterClause}
      ORDER BY trimester, display_order`,
    ...params,
  );
  return decorateAncAdviceRows(rows, { includePlaceholders });
}

export async function setSupplementReminder({
  tenantId, pregnancy_id, supplement_id, reminder_enabled,
  actor_uid, actor_role,
}) {
  const pregnancyId = Number.parseInt(pregnancy_id, 10);
  const supplementId = Number.parseInt(supplement_id, 10);
  if (!Number.isInteger(pregnancyId) || pregnancyId <= 0) {
    throw AppError.badRequest('pregnancy_id must be a positive integer');
  }
  if (!Number.isInteger(supplementId) || supplementId <= 0) {
    throw AppError.badRequest('supplement_id must be a positive integer');
  }
  if (typeof reminder_enabled !== 'boolean') {
    throw AppError.badRequest('reminder_enabled must be a boolean');
  }
  const tid = tenantOr(tenantId);
  const pregnancy = await assertPregnancyInTenant(tid, pregnancyId);
  return setTenantTx(tid, async (tx) => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, supplement, dose, frequency, route, start_date, end_date,
              reminder_enabled, notes, prescribed_by, created_at, updated_at
         FROM maternity_supplements
        WHERE tenant_id = $1::uuid
          AND pregnancy_id = $2::int
          AND id = $3::int
        FOR UPDATE`,
      tid, pregnancyId, supplementId,
    );
    if (!currentRows.length) throw AppError.notFound('Supplement not found');
    if (currentRows[0].reminder_enabled === reminder_enabled) return currentRows[0];

    const rows = await tx.$queryRawUnsafe(
      `UPDATE maternity_supplements
          SET reminder_enabled = $1,
              updated_at = NOW()
        WHERE tenant_id = $2::uuid
          AND pregnancy_id = $3::int
          AND id = $4::int
        RETURNING id, supplement, dose, frequency, route, start_date, end_date,
                  reminder_enabled, notes, prescribed_by, created_at, updated_at`,
      reminder_enabled, tid, pregnancyId, supplementId,
    );
    const updated = rows[0];
    const canonicalRevision = canonicalStateFingerprint({
      pregnancy_id: pregnancyId,
      supplement: updated.supplement,
      dose: updated.dose || null,
      frequency: updated.frequency,
      route: updated.route,
      start_date: updated.start_date,
      end_date: updated.end_date || null,
      reminder_enabled: updated.reminder_enabled,
      notes: updated.notes || null,
      prescribed_by: updated.prescribed_by ? String(updated.prescribed_by) : null,
    });
    // Exact retries returned above via the equality guard; a toggle back to a
    // previous preference must still record its own canonical revision.
    const txRevision = await currentCanonicalTransactionRevision(tx);

    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: String(pregnancy.patient_uid),
      eventType: 'maternity.supplement_reminder_updated',
      eventStatus: reminder_enabled ? 'enabled' : 'disabled',
      sourceTable: 'maternity_supplements',
      sourceId: updated.id,
      resourceType: 'maternity_supplement',
      resourceId: updated.id,
      actorUid: actor_uid || null,
      actorRole: actor_role || null,
      occurredAt: updated.updated_at,
      visibleToPatient: false,
      summary: 'Maternity supplement reminder preference updated',
      payload: {
        supplement_id: updated.id,
        pregnancy_id: pregnancyId,
        reminder_enabled: updated.reminder_enabled,
      },
      afterState: {
        reminder_enabled: updated.reminder_enabled,
      },
      tags: ['maternity', 'supplement', 'reminder-preference'],
      timelineIdempotencyKey: `maternity_supplements:${updated.id}:reminder:${canonicalRevision}:tx:${txRevision}`,
      auditIdempotencyKey: `maternity_supplements:${updated.id}:audit:reminder:${canonicalRevision}:tx:${txRevision}`,
    }, { db: tx, strict: true });

    return updated;
  });
}

export async function listAncVisits({ tenantId, pregnancy_id }) {
  const tid = tenantOr(tenantId);
  const pregnancy = await assertPregnancyInTenant(tid, pregnancy_id);
  return prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_anc_visits
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int
      ORDER BY visit_date DESC`,
    tid, Number(pregnancy.id),
  );
}

// ── Labor admission ─────────────────────────────────────────────────

export async function admitToLabor({
  tenantId, pregnancy_id, admission_id, admission_reason,
  gestational_age_weeks, membrane_status, membranes_ruptured_at,
  cervix_dilation_cm, cervix_effacement_pct, station, presentation,
  fetal_heart_rate_bpm, contractions_per_10min, labor_started_at,
  attending_obstetrician, attending_midwife, notes,
  actor_uid, actor_role,
}) {
  if (!pregnancy_id) throw AppError.badRequest('pregnancy_id is required');
  const tid = tenantOr(tenantId);
  const pregnancy = await assertPregnancyInTenant(tid, pregnancy_id);
  if (admission_id) {
    await assertAdmissionInTenant(tid, admission_id, pregnancy.patient_uid);
  }
  await assertObgynLabourWardPrivilege(attending_obstetrician, tid, 'maternity_labor_admission');

  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO maternity_labor_admissions
         (pregnancy_id, admission_id, admission_reason,
          gestational_age_weeks, membrane_status, membranes_ruptured_at,
          cervix_dilation_cm, cervix_effacement_pct, station, presentation,
          fetal_heart_rate_bpm, contractions_per_10min, labor_started_at,
          attending_obstetrician, attending_midwife, notes, tenant_id)
       VALUES ($1::int, $2::int, $3,
               $4::numeric, $5, $6::timestamptz,
               $7::numeric, $8::int, $9, $10,
               $11::int, $12::int, $13::timestamptz,
               $14::uuid, $15::uuid, $16, $17::uuid)
       RETURNING *`,
      Number(pregnancy.id),
      admission_id ? Number(admission_id) : null,
      admission_reason || null,
      gestational_age_weeks ? Number(gestational_age_weeks) : null,
      membrane_status || null,
      membranes_ruptured_at || null,
      cervix_dilation_cm ? Number(cervix_dilation_cm) : null,
      cervix_effacement_pct ? Number(cervix_effacement_pct) : null,
      station || null, presentation || null,
      fetal_heart_rate_bpm ? Number(fetal_heart_rate_bpm) : null,
      contractions_per_10min ? Number(contractions_per_10min) : null,
      labor_started_at || null,
      attending_obstetrician ? String(attending_obstetrician) : null,
      attending_midwife ? String(attending_midwife) : null,
      notes || null, tid,
    );
    const laborAdmission = rows[0];

    // Fixed lifecycle key (insert-once, audited 2026-07-14): this emit runs
    // exactly once, in the tx that mints laborAdmission.id. The row's only
    // post-creation write is the one-way active->'delivered' transition in
    // recordDelivery (guarded on status='active', never reversed, surfaced
    // via the delivery event's afterState) — it does not re-emit this key.
    // Any future amendment/reopen path must NOT reuse this key: move the
    // emit to the state-fingerprint + :tx: revision pattern (PR #589; see
    // docs/CANONICAL_CLINICAL_TIMELINE.md "Idempotency-Key Discipline").
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: String(pregnancy.patient_uid),
      eventType: 'maternity.labor_admission_recorded',
      eventStatus: laborAdmission.status,
      sourceTable: 'maternity_labor_admissions',
      sourceId: laborAdmission.id,
      resourceType: 'labor_admission',
      resourceId: laborAdmission.id,
      actorUid: actor_uid || null,
      actorRole: actor_role || null,
      occurredAt: laborAdmission.admitted_at,
      visibleToPatient: false,
      summary: 'Labour admission recorded',
      payload: {
        labor_admission_id: laborAdmission.id,
        pregnancy_id: pregnancy.id,
        admission_id: laborAdmission.admission_id || null,
      },
      afterState: {
        labor_status: laborAdmission.status,
      },
      timelineIdempotencyKey: `maternity_labor_admissions:${laborAdmission.id}:recorded`,
      auditIdempotencyKey: `maternity_labor_admissions:${laborAdmission.id}:audit:recorded`,
    }, { db: tx, strict: true });

    return laborAdmission;
  });
}

export async function getLaborAdmission({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_labor_admissions WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantOr(tenantId),
  );
  if (!rows.length) throw AppError.notFound('Labor admission not found');
  return rows[0];
}

export async function listActiveLaborAdmissions({ tenantId, limit = 50 }) {
  return prisma.$queryRawUnsafe(
    `SELECT la.*, p.patient_uid, p.gravida, p.parity,
            p.high_risk, p.high_risk_reasons
       FROM maternity_labor_admissions la
       JOIN maternity_pregnancies p ON p.id = la.pregnancy_id
      WHERE la.tenant_id = $1::uuid
        AND p.tenant_id = $1::uuid
        AND la.status = 'active'
      ORDER BY la.admitted_at DESC
      LIMIT $2::int`,
    tenantId, Number(limit),
  );
}

// ── Partograph ──────────────────────────────────────────────────────

/**
 * WHO modified partograph alert/action line check.
 * Active phase starts at 4cm. Expected progression: 1cm/hr.
 *   alert at hour = (current_dilation_cm - 4) hours after 4cm reached
 *   action = alert + 4 hours
 * If the actual reading is at or below the expected dilation for the
 * given elapsed time, flag alert/action.
 */
export function computePartographAlerts({ activePhaseStartedAt, recordedAt, dilationCm }) {
  if (!activePhaseStartedAt || !recordedAt || dilationCm == null) {
    return { on_alert_line: null, on_action_line: null };
  }
  const start = new Date(activePhaseStartedAt).getTime();
  const now = new Date(recordedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(now)) {
    return { on_alert_line: null, on_action_line: null };
  }
  const hoursElapsed = (now - start) / (1000 * 60 * 60);
  if (hoursElapsed < 0) return { on_alert_line: false, on_action_line: false };
  const expectedAtAlert = 4 + hoursElapsed * 1.0;          // 1cm/hr from 4cm
  const expectedAtAction = 4 + Math.max(0, hoursElapsed - 4) * 1.0;
  return {
    on_alert_line: dilationCm < expectedAtAlert,
    on_action_line: dilationCm < expectedAtAction,
  };
}

export async function recordPartographEntry({
  tenantId, labor_admission_id, recorded_at,
  bp_systolic, bp_diastolic, pulse_bpm, temperature_c,
  urine_output_ml, urine_protein, urine_acetone,
  cervix_dilation_cm, descent_fifths_above_brim,
  contractions_per_10min, contractions_duration_sec, contractions_intensity,
  fetal_heart_rate_bpm, fetal_decel, amniotic_fluid, moulding,
  oxytocin_units_l, oxytocin_drops_min, drugs_given, iv_fluids,
  notes, recorded_by,
  actor_uid, actor_role,
}) {
  if (!labor_admission_id) throw AppError.badRequest('labor_admission_id is required');
  const tid = tenantOr(tenantId);
  const labor = await getLaborAdmission({ tenantId: tid, id: labor_admission_id });
  const pregnancy = await assertPregnancyInTenant(tid, labor.pregnancy_id);

  // Active phase starts when dilation first reaches 4cm. We use the
  // labor_started_at as an approximation; if not set, fall back to
  // admitted_at.
  const activePhaseStart = labor.labor_started_at || labor.admitted_at;
  const recAt = recorded_at || new Date().toISOString();
  const { on_alert_line, on_action_line } = computePartographAlerts({
    activePhaseStartedAt: activePhaseStart,
    recordedAt: recAt,
    dilationCm: cervix_dilation_cm != null ? Number(cervix_dilation_cm) : null,
  });

  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO maternity_partograph_entries
         (labor_admission_id, recorded_at,
          bp_systolic, bp_diastolic, pulse_bpm, temperature_c,
          urine_output_ml, urine_protein, urine_acetone,
          cervix_dilation_cm, descent_fifths_above_brim,
          contractions_per_10min, contractions_duration_sec, contractions_intensity,
          fetal_heart_rate_bpm, fetal_decel, amniotic_fluid, moulding,
          oxytocin_units_l, oxytocin_drops_min, drugs_given, iv_fluids,
          on_alert_line, on_action_line, notes, recorded_by, tenant_id)
       VALUES ($1::int, $2::timestamptz,
               $3::int, $4::int, $5::int, $6::numeric,
               $7::int, $8, $9,
               $10::numeric, $11::int,
               $12::int, $13::int, $14,
               $15::int, $16, $17, $18,
               $19::numeric, $20::int, $21, $22,
               $23, $24, $25, $26::uuid, $27::uuid)
       RETURNING *`,
      labor.id, recAt,
      bp_systolic ? Number(bp_systolic) : null,
      bp_diastolic ? Number(bp_diastolic) : null,
      pulse_bpm ? Number(pulse_bpm) : null,
      temperature_c ? Number(temperature_c) : null,
      urine_output_ml ? Number(urine_output_ml) : null,
      urine_protein || null, urine_acetone || null,
      cervix_dilation_cm != null ? Number(cervix_dilation_cm) : null,
      descent_fifths_above_brim != null ? Number(descent_fifths_above_brim) : null,
      contractions_per_10min ? Number(contractions_per_10min) : null,
      contractions_duration_sec ? Number(contractions_duration_sec) : null,
      contractions_intensity || null,
      fetal_heart_rate_bpm ? Number(fetal_heart_rate_bpm) : null,
      fetal_decel || null, amniotic_fluid || null, moulding || null,
      oxytocin_units_l != null ? Number(oxytocin_units_l) : null,
      oxytocin_drops_min ? Number(oxytocin_drops_min) : null,
      drugs_given || null, iv_fluids || null,
      on_alert_line, on_action_line,
      notes || null,
      recorded_by ? String(recorded_by) : null, tid,
    );
    const entry = rows[0];

    // Fixed lifecycle key (insert-once, audited 2026-07-14): partograph
    // entries are an append-only observation series — no UPDATE path exists
    // anywhere in product code; corrections are recorded as new entries. A
    // future in-place amendment path must move this emit to the
    // state-fingerprint + :tx: revision pattern (PR #589; see
    // docs/CANONICAL_CLINICAL_TIMELINE.md "Idempotency-Key Discipline").
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: String(pregnancy.patient_uid),
      eventType: 'maternity.partograph_entry_recorded',
      eventStatus: 'recorded',
      sourceTable: 'maternity_partograph_entries',
      sourceId: entry.id,
      resourceType: 'partograph_entry',
      resourceId: entry.id,
      actorUid: actor_uid || recorded_by || null,
      actorRole: actor_role || null,
      occurredAt: entry.recorded_at,
      visibleToPatient: false,
      summary: 'Partograph entry recorded',
      payload: {
        partograph_entry_id: entry.id,
        labor_admission_id: labor.id,
        pregnancy_id: pregnancy.id,
      },
      afterState: {
        partograph_entry_recorded: true,
      },
      timelineIdempotencyKey: `maternity_partograph_entries:${entry.id}:recorded`,
      auditIdempotencyKey: `maternity_partograph_entries:${entry.id}:audit:recorded`,
    }, { db: tx, strict: true });

    return entry;
  });
}

export async function listPartographEntries({ tenantId, labor_admission_id }) {
  const tid = tenantOr(tenantId);
  const labor = await getLaborAdmission({ tenantId: tid, id: labor_admission_id });
  return prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_partograph_entries
      WHERE tenant_id = $1::uuid AND labor_admission_id = $2::int
      ORDER BY recorded_at`,
    tid, Number(labor.id),
  );
}

// ── Delivery summary ────────────────────────────────────────────────

export async function recordDelivery({
  tenantId, pregnancy_id, labor_admission_id, delivery_datetime, delivery_mode,
  stage1_duration_min, stage2_duration_min, stage3_duration_min,
  episiotomy, perineal_tear_grade, perineal_repair_done,
  blood_loss_ml, pph_diagnosed, pph_treatment,
  placenta_delivered_at, placenta_method, placenta_complete,
  cord_around_neck, cord_loops_count, anesthesia_type, complications,
  delivered_by, delivered_by_name, pediatrician_present, pediatrician_uid, notes,
  actor_uid, actor_role,
}) {
  if (!pregnancy_id) throw AppError.badRequest('pregnancy_id is required');
  if (!delivery_datetime) throw AppError.badRequest('delivery_datetime is required');
  if (!delivery_mode) throw AppError.badRequest('delivery_mode is required');
  const tid = tenantOr(tenantId);
  const pregnancy = await assertPregnancyInTenant(tid, pregnancy_id);
  if (pregnancy.status !== 'ongoing') {
    throw AppError.conflict(
      'Delivery can only be recorded for an ongoing pregnancy',
      'MATERNITY_PREGNANCY_NOT_ONGOING',
    );
  }
  let labor = null;
  if (labor_admission_id) {
    labor = await getLaborAdmission({ tenantId: tid, id: labor_admission_id });
    if (Number(labor.pregnancy_id) !== Number(pregnancy.id)) {
      throw AppError.forbidden('Labor admission belongs to a different pregnancy');
    }
    if (labor.status !== 'active') {
      throw AppError.conflict(
        'Delivery can only be recorded for an active labor admission',
        'MATERNITY_LABOR_NOT_ACTIVE',
      );
    }
  }
  await assertObgynLabourWardPrivilege(delivered_by, tid, 'maternity_delivery');

  return setTenantTx(tid, async (tx) => {
    const lockedPatients = await tx.$queryRawUnsafe(
      `SELECT uid
         FROM users
        WHERE tenant_id = $1::uuid AND uid = $2::uuid
        FOR UPDATE`,
      tid,
      String(pregnancy.patient_uid),
    );
    if (!lockedPatients.length) throw AppError.notFound('Patient not found');
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO maternity_deliveries
         (pregnancy_id, labor_admission_id, delivery_datetime, delivery_mode,
          stage1_duration_min, stage2_duration_min, stage3_duration_min,
          episiotomy, perineal_tear_grade, perineal_repair_done,
          blood_loss_ml, pph_diagnosed, pph_treatment,
          placenta_delivered_at, placenta_method, placenta_complete,
          cord_around_neck, cord_loops_count, anesthesia_type, complications,
          delivered_by, delivered_by_name, pediatrician_present, pediatrician_uid,
          notes, tenant_id)
       VALUES ($1::int, $2::int, $3::timestamptz, $4,
               $5::int, $6::int, $7::int,
               $8, $9, $10,
               $11::int, $12, $13,
               $14::timestamptz, $15, $16,
               $17, $18::int, $19, $20,
               $21::uuid, $22, $23, $24::uuid,
               $25, $26::uuid)
       RETURNING *`,
      Number(pregnancy.id),
      labor ? Number(labor.id) : null,
      delivery_datetime, delivery_mode,
      stage1_duration_min ? Number(stage1_duration_min) : null,
      stage2_duration_min ? Number(stage2_duration_min) : null,
      stage3_duration_min ? Number(stage3_duration_min) : null,
      !!episiotomy, perineal_tear_grade || null, !!perineal_repair_done,
      blood_loss_ml ? Number(blood_loss_ml) : null,
      !!pph_diagnosed, pph_treatment || null,
      placenta_delivered_at || null, placenta_method || null, placenta_complete ?? null,
      !!cord_around_neck, Number(cord_loops_count || 0),
      anesthesia_type || null, complications || null,
      delivered_by ? String(delivered_by) : null,
      delivered_by_name || null,
      !!pediatrician_present,
      pediatrician_uid ? String(pediatrician_uid) : null,
      notes || null, tid,
    );
    const delivery = rows[0];

    const pregnancyTransitions = await tx.$queryRawUnsafe(
      `UPDATE maternity_pregnancies
          SET status = 'delivered', updated_at = NOW()
        WHERE id = $1::int
          AND tenant_id = $2::uuid
          AND status = 'ongoing'
      RETURNING id`,
      Number(pregnancy.id),
      tid,
    );
    if (pregnancyTransitions.length !== 1) {
      throw AppError.conflict(
        'Pregnancy is no longer ongoing',
        'MATERNITY_PREGNANCY_NOT_ONGOING',
      );
    }
    if (labor) {
      const laborTransitions = await tx.$queryRawUnsafe(
        `UPDATE maternity_labor_admissions
            SET status = 'delivered', updated_at = NOW()
          WHERE id = $1::int
            AND tenant_id = $2::uuid
            AND status = 'active'
        RETURNING id`,
        Number(labor.id),
        tid,
      );
      if (laborTransitions.length !== 1) {
        throw AppError.conflict(
          'Labor admission is no longer active',
          'MATERNITY_LABOR_NOT_ACTIVE',
        );
      }
    }

    const projectionRows = await tx.$queryRawUnsafe(
      `WITH projection AS (
         SELECT EXISTS (
                  SELECT 1
                    FROM maternity_pregnancies
                   WHERE tenant_id = $2::uuid
                     AND patient_uid = $1::uuid
                     AND status = 'ongoing'
                ) AS is_pregnant,
                (
                  SELECT lmp_date
                    FROM maternity_pregnancies
                   WHERE tenant_id = $2::uuid
                     AND patient_uid = $1::uuid
                     AND status = 'ongoing'
                   ORDER BY created_at DESC, id DESC
                   LIMIT 1
                ) AS lmp_date
       )
       UPDATE users u
          SET is_pregnant = projection.is_pregnant,
              pregnancy_lmp_date = projection.lmp_date,
              updated_at = NOW()
         FROM projection
        WHERE u.tenant_id = $2::uuid
          AND u.uid = $1::uuid
       RETURNING u.is_pregnant, u.pregnancy_lmp_date`,
      String(pregnancy.patient_uid),
      tid,
    );
    const projection = projectionRows[0];

    // Fixed lifecycle key (insert-once, audited 2026-07-14): this emit runs
    // exactly once, in the tx that mints delivery.id, and
    // maternity_deliveries has no UPDATE/DELETE path in product code (routes
    // are POST + GET only). Any future delivery-correction/amendment path
    // must NOT reuse this key: move the emit to the state-fingerprint +
    // :tx: revision pattern (PR #589; see
    // docs/CANONICAL_CLINICAL_TIMELINE.md "Idempotency-Key Discipline").
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: String(pregnancy.patient_uid),
      eventType: 'maternity.delivery_recorded',
      eventStatus: 'recorded',
      sourceTable: 'maternity_deliveries',
      sourceId: delivery.id,
      resourceType: 'delivery',
      resourceId: delivery.id,
      actorUid: actor_uid || null,
      actorRole: actor_role || null,
      occurredAt: delivery.delivery_datetime,
      visibleToPatient: false,
      summary: 'Delivery recorded',
      payload: {
        delivery_id: delivery.id,
        pregnancy_id: pregnancy.id,
        labor_admission_id: labor?.id || null,
      },
      afterState: {
        pregnancy_status: 'delivered',
        labor_status: labor ? 'delivered' : null,
        user_is_pregnant: projection?.is_pregnant === true,
      },
      timelineIdempotencyKey: `maternity_deliveries:${delivery.id}:recorded`,
      auditIdempotencyKey: `maternity_deliveries:${delivery.id}:audit:recorded`,
    }, { db: tx, strict: true });

    return delivery;
  });
}

export async function getDelivery({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_deliveries WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantOr(tenantId),
  );
  if (!rows.length) throw AppError.notFound('Delivery not found');
  return rows[0];
}

// ── Newborn record + Apgar ──────────────────────────────────────────

// D7 Shape-3 (signed 2026-07-15): "Twin-<n> B/O <mother>" for birth_order
// >= 2, "B/O <mother>" otherwise; renamed at ordinary registration later
// (no rename path in this build). users.name is VARCHAR(255).
function provisionalNewbornName({ motherName, birthOrder }) {
  const base = String(motherName || '').trim() || 'Unregistered Mother';
  const qualifier = Number(birthOrder) > 1 ? `Twin-${Number(birthOrder)} ` : '';
  return `${qualifier}B/O ${base}`.slice(0, 255);
}

// Synthetic placeholder phone satisfying UNIQUE(users.phone) for the minted
// infant identity — same impedance fix as the walk-in minor path's DEPEND-
// prefix; NB- marks birth-workflow identities. VARCHAR(15): 'NB-' + 12 hex.
function syntheticNewbornPhone() {
  return `NB-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

// Map A-1 unique-index violations (races that slipped past the in-tx
// prechecks) to clean 409 conflicts instead of raw 500s.
function mapNewbornUniqueViolation(err) {
  const text = `${err?.message || ''} ${err?.meta?.message || ''}`;
  if (!/23505|duplicate key/i.test(text)) return null;
  if (text.includes('uq_maternity_newborns_delivery_birth_order')) {
    return AppError.conflict(
      'A newborn with this birth order is already recorded for this delivery',
      'MATERNITY_NEWBORN_BIRTH_ORDER_TAKEN',
    );
  }
  if (text.includes('uq_maternity_newborns_tenant_patient_uid')) {
    return newbornIdentityInvalid('already_linked');
  }
  return null;
}

// Newborn context for infant-scope canonical subject resolution: the newborn
// row plus the delivery mother's patient uid (the E-3 mother-exclusion arm).
async function loadNewbornSubjectContext(db, tenantId, newbornId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT n.id, n.delivery_id, n.outcome, n.newborn_patient_uid,
            p.patient_uid AS mother_patient_uid
       FROM maternity_newborns n
       JOIN maternity_deliveries d
         ON d.id = n.delivery_id
        AND d.tenant_id = n.tenant_id
       JOIN maternity_pregnancies p
         ON p.id = d.pregnancy_id
        AND p.tenant_id = n.tenant_id
      WHERE n.tenant_id = $1::uuid
        AND n.id = $2::int`,
    tenantId,
    Number(newbornId),
  );
  return rows[0] || null;
}

/**
 * D7 S-2 FULL scope (signed 2026-07-15): resolve and validate the canonical
 * subject for an infant-scope maternity write, inside the caller's tenant
 * transaction.
 *
 * Locks the newborn row FOR UPDATE (the per-newborn serialisation point,
 * mirroring the immunisation paths), re-checks the identity link, enforces
 * B-2 outcome gating, then runs the signed E-3 predicate (users row FOR
 * UPDATE) and the E-c1 exclusivity re-check with migration 577's A-1 unique
 * index as the structural backstop. Absent link, failed predicate, or
 * ambiguity rejects fail-closed (409 NEWBORN_IDENTITY_REQUIRED /
 * NEWBORN_IDENTITY_INVALID) — no proxy writes, no mother fallback.
 *
 * Returns the validated infant subject uid.
 */
async function assertInfantScopeSubject(tx, { tenantId, newbornId, motherPatientUid }) {
  const lockedNewborns = await tx.$queryRawUnsafe(
    `SELECT id, newborn_patient_uid, outcome
       FROM maternity_newborns
      WHERE id = $1::int AND tenant_id = $2::uuid
      FOR UPDATE`,
    Number(newbornId),
    tenantId,
  );
  if (!lockedNewborns.length) throw AppError.notFound('Newborn not found');
  if (!lockedNewborns[0].newborn_patient_uid) throw newbornIdentityRequired();
  // B-2: identities exist only for babies who lived ('live',
  // 'early_neonatal_death'); a stillbirth row carrying one is residual
  // invalid data and stays rejected. B-r1 keeps early-neonatal-death events
  // attributed to the baby's own identity.
  if (!IDENTITY_MINTING_OUTCOMES.has(String(lockedNewborns[0].outcome))) {
    throw newbornIdentityInvalid('identity_forbidden_for_outcome');
  }
  const subjectUid = String(lockedNewborns[0].newborn_patient_uid);
  await assertNewbornIdentitySubject({
    db: tx,
    tenantId,
    candidateUid: subjectUid,
    motherPatientUid,
    forUpdate: true,
  });
  await assertExclusiveNewbornLink({
    db: tx,
    tenantId,
    candidateUid: subjectUid,
    newbornId: Number(newbornId),
  });
  return subjectUid;
}

/**
 * D7 Shape-3 — the birth workflow atomically creates the infant's patient
 * identity + guardian link (decision record obgyn-d7-decision-record.md,
 * SHA-256 E82EEC9A054CA3708A31F48568818BB27F9986D8F5A02C37AF9407F4D5DB9562):
 *
 * - Identity is minted when outcome IN ('live','early_neonatal_death') and
 *   no pre-registered identity is supplied; NEVER for stillbirths (B-2).
 *   Outcome correction later is compensating-events only (B-c1) — a minted
 *   identity is never retro-deleted here.
 * - Guardian: guardian_user_id = the mother's users.id, relationship
 *   'mother', set atomically with the identity (mig-202 substrate; the
 *   existing X-Acting-As-Uid guardian chain and /users/dependents pick the
 *   link up unchanged).
 * - Guardian(mother) consent evidence is captured through the existing
 *   patient_consents substrate (type 'treatment', source
 *   'birth_registration') in the same transaction (G-3).
 * - Detail row + identity + guardian + consent + one canonical
 *   timeline/audit pair commit or roll back together (C2 pattern).
 */
export async function recordNewborn({
  tenantId, delivery_id, birth_order = 1, birth_datetime, sex,
  birth_weight_g, birth_length_cm, head_circumference_cm, chest_circumference_cm,
  gestational_age_weeks, outcome = 'live',
  resuscitation_done, resuscitation_type, newborn_patient_uid,
  cord_clamped_at_min, skin_to_skin_done, breastfeeding_initiated_min,
  vit_k_given, bcg_given, hep_b_given, opv_given,
  congenital_anomaly, congenital_anomaly_desc, recorded_by, notes,
  actor_uid, actor_role,
}) {
  if (!delivery_id) throw AppError.badRequest('delivery_id is required');
  if (!birth_datetime) throw AppError.badRequest('birth_datetime is required');
  const birthOrder = Number.parseInt(birth_order, 10);
  if (!Number.isInteger(birthOrder) || birthOrder < 1) {
    throw AppError.badRequest('birth_order must be a positive integer');
  }
  const outcomeValue = String(outcome || 'live');
  if (!NEWBORN_OUTCOMES.includes(outcomeValue)) {
    throw AppError.badRequest(
      `outcome must be one of: ${NEWBORN_OUTCOMES.join(', ')}`,
      'MATERNITY_NEWBORN_OUTCOME_INVALID',
    );
  }
  const tid = tenantOr(tenantId);
  const delivery = await assertDeliveryInTenant(tid, delivery_id);
  const motherUid = String(delivery.patient_uid);
  const mintsIdentity = IDENTITY_MINTING_OUTCOMES.has(outcomeValue);

  // B-2: stillbirths never carry a patient identity — reject an explicit
  // link outright rather than silently dropping it.
  if (newborn_patient_uid && !mintsIdentity) {
    throw newbornIdentityInvalid('identity_forbidden_for_outcome');
  }
  // Phase 0 fast-fail on a supplied pre-registered identity; the
  // authoritative E-c1 re-check runs inside the transaction under locks.
  if (newborn_patient_uid) {
    await assertNewbornIdentitySubject({
      db: prisma,
      tenantId: tid,
      candidateUid: newborn_patient_uid,
      motherPatientUid: motherUid,
    });
    await assertExclusiveNewbornLink({
      db: prisma, tenantId: tid, candidateUid: newborn_patient_uid,
    });
  }

  return setTenantTx(tid, async (tx) => {
    // Lock the mother row first: stable guardian/name source AND a
    // per-delivery serialisation point, so the birth_order/identity
    // prechecks below are race-free for concurrent records of the same
    // delivery. The A-1 unique indexes remain the structural backstop.
    const motherRows = await tx.$queryRawUnsafe(
      `SELECT id, uid, name, phone
         FROM users
        WHERE tenant_id = $1::uuid AND uid = $2::uuid
        FOR UPDATE`,
      tid, motherUid,
    );
    if (!motherRows.length) throw AppError.notFound('Mother patient record not found');
    const mother = motherRows[0];

    const birthOrderClash = await tx.$queryRawUnsafe(
      `SELECT id
         FROM maternity_newborns
        WHERE tenant_id = $1::uuid AND delivery_id = $2::int AND birth_order = $3::int
        LIMIT 1`,
      tid, Number(delivery.id), birthOrder,
    );
    if (birthOrderClash.length) {
      throw AppError.conflict(
        'A newborn with this birth order is already recorded for this delivery',
        'MATERNITY_NEWBORN_BIRTH_ORDER_TAKEN',
      );
    }

    let infantUid = newborn_patient_uid ? String(newborn_patient_uid) : null;
    let mintedIdentity = null;
    let guardianConsentId = null;

    if (infantUid) {
      // E-c1 in-transaction re-check of the pre-registered identity under
      // row locks (users row FOR UPDATE) + exclusivity.
      await assertNewbornIdentitySubject({
        db: tx,
        tenantId: tid,
        candidateUid: infantUid,
        motherPatientUid: motherUid,
        forUpdate: true,
      });
      await assertExclusiveNewbornLink({
        db: tx, tenantId: tid, candidateUid: infantUid,
      });
    } else if (mintsIdentity) {
      const provisionalName = provisionalNewbornName({
        motherName: mother.name, birthOrder,
      });
      const infantRows = await tx.$queryRawUnsafe(
        `INSERT INTO users
           (phone, name, birthday, gender, role,
            is_minor, is_active,
            guardian_user_id, guardian_name, guardian_phone, guardian_relationship,
            tenant_id, updated_at)
         VALUES ($1, $2, $3::date, $4, 'PATIENT',
                 true, true,
                 $5::int, $6, $7, 'mother',
                 $8::uuid, NOW())
         RETURNING uid, id, name, phone`,
        syntheticNewbornPhone(),
        provisionalName,
        istDateString(new Date(birth_datetime)),
        sex ? String(sex).slice(0, 20) : null,
        Number(mother.id),
        mother.name || null,
        mother.phone || null,
        tid,
      );
      const infant = infantRows[0];
      infantUid = String(infant.uid);

      // G-3: guardian(mother) consent evidence through the EXISTING
      // patient_consents substrate — no new schema. Method 'verbal' with
      // the recording clinician as witness is the delivery-room capture
      // shape; a signature image can be attached later through the
      // existing POST /consent/:id/signatures path.
      const witnessUid = actor_uid || recorded_by || null;
      let witnessName = null;
      if (witnessUid) {
        const staffRows = await tx.$queryRawUnsafe(
          `SELECT name FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid LIMIT 1`,
          tid, String(witnessUid),
        );
        witnessName = staffRows[0]?.name || null;
      }
      const consentRows = await tx.$queryRawUnsafe(
        `INSERT INTO patient_consents
           (patient_uid, consent_type, granted, status, granted_at, granted_by,
            notes, purpose, data_categories, version, source,
            consent_method, witness_name, witness_uid, tenant_id,
            created_at, updated_at)
         VALUES ($1::uuid, 'treatment', true, 'active', NOW(), 'guardian_mother',
                 $2, $3, '[]'::jsonb, 'v1', 'birth_registration',
                 'verbal', $4, $5::uuid, $6::uuid,
                 NOW(), NOW())
         RETURNING id`,
        infantUid,
        'Guardian (mother) consent for newborn care captured at birth registration (D7 Shape-3 birth workflow).',
        'Newborn care at birth registration; consent given by the automatic initial guardian (mother).',
        witnessName,
        witnessUid ? String(witnessUid) : null,
        tid,
      );
      guardianConsentId = Number(consentRows[0].id);

      mintedIdentity = {
        patient_uid: infantUid,
        patient_id: Number(infant.id),
        provisional_name: infant.name,
        guardian_user_id: Number(mother.id),
        guardian_relationship: 'mother',
        guardian_consent_id: guardianConsentId,
      };
    }

    let newborn;
    try {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO maternity_newborns
           (delivery_id, birth_order, birth_datetime, sex,
            birth_weight_g, birth_length_cm, head_circumference_cm, chest_circumference_cm,
            gestational_age_weeks, outcome,
            resuscitation_done, resuscitation_type, newborn_patient_uid,
            cord_clamped_at_min, skin_to_skin_done, breastfeeding_initiated_min,
            vit_k_given, bcg_given, hep_b_given, opv_given,
            congenital_anomaly, congenital_anomaly_desc, recorded_by, notes, tenant_id)
         VALUES ($1::int, $2::int, $3::timestamptz, $4,
                 $5::int, $6::numeric, $7::numeric, $8::numeric,
                 $9::numeric, $10,
                 $11, $12, $13::uuid,
                 $14::numeric, $15, $16::int,
                 $17, $18, $19, $20,
                 $21, $22, $23::uuid, $24, $25::uuid)
         RETURNING *`,
        Number(delivery.id), birthOrder,
        birth_datetime, sex || null,
        birth_weight_g ? Number(birth_weight_g) : null,
        birth_length_cm ? Number(birth_length_cm) : null,
        head_circumference_cm ? Number(head_circumference_cm) : null,
        chest_circumference_cm ? Number(chest_circumference_cm) : null,
        gestational_age_weeks ? Number(gestational_age_weeks) : null,
        outcomeValue,
        !!resuscitation_done, resuscitation_type || null,
        infantUid,
        cord_clamped_at_min ? Number(cord_clamped_at_min) : null,
        !!skin_to_skin_done,
        breastfeeding_initiated_min ? Number(breastfeeding_initiated_min) : null,
        !!vit_k_given, !!bcg_given, !!hep_b_given, !!opv_given,
        !!congenital_anomaly, congenital_anomaly_desc || null,
        recorded_by ? String(recorded_by) : null,
        notes || null, tid,
      );
      newborn = rows[0];
    } catch (err) {
      throw mapNewbornUniqueViolation(err) || err;
    }

    // Fixed lifecycle key (insert-once): this emit runs exactly once, in
    // the tx that mints newborn.id, and maternity_newborns has no
    // UPDATE/DELETE path in product code (routes are POST + GET only).
    // Outcome corrections are compensating events (B-c1), never in-place
    // edits. Any future amendment path must NOT reuse this key: move the
    // emit to the state-fingerprint + :tx: revision pattern (PR #589; see
    // docs/CANONICAL_CLINICAL_TIMELINE.md "Idempotency-Key Discipline").
    //
    // Subject: the infant identity when one exists (S-2 FULL scope). A
    // stillbirth never has an identity (B-2), so its birth event is
    // recorded on the mother's episode — by design, not as a fallback.
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: infantUid || motherUid,
      eventType: 'maternity.newborn_recorded',
      eventStatus: 'recorded',
      sourceTable: 'maternity_newborns',
      sourceId: newborn.id,
      resourceType: 'newborn',
      resourceId: newborn.id,
      actorUid: actor_uid || recorded_by || null,
      actorRole: actor_role || null,
      occurredAt: newborn.birth_datetime,
      visibleToPatient: false,
      summary: 'Newborn recorded',
      payload: {
        newborn_id: newborn.id,
        delivery_id: Number(delivery.id),
        pregnancy_id: Number(delivery.pregnancy_id),
        birth_order: Number(newborn.birth_order),
        outcome: newborn.outcome,
        newborn_patient_uid: infantUid,
        mother_patient_uid: motherUid,
        identity_minted: !!mintedIdentity,
        guardian_user_id: mintedIdentity ? mintedIdentity.guardian_user_id : null,
        guardian_consent_id: guardianConsentId,
      },
      afterState: {
        outcome: newborn.outcome,
        newborn_patient_uid: infantUid,
        identity_minted: !!mintedIdentity,
      },
      timelineIdempotencyKey: `maternity_newborns:${newborn.id}:recorded`,
      auditIdempotencyKey: `maternity_newborns:${newborn.id}:audit:recorded`,
    }, { db: tx, strict: true });

    return { ...newborn, minted_identity: mintedIdentity };
  });
}

/**
 * D7 M-C rework (signed 2026-07-15): an Apgar score is an infant-scope
 * clinical write — the canonical subject is the newborn's OWN patient
 * identity (S-2 FULL scope), validated through the signed E-3/E-c1 checks
 * in-transaction. Detail UPSERT + one staff-only canonical timeline/audit
 * pair commit or roll back together.
 *
 * The (newborn_id, time_minute) UPSERT makes this an AMENDABLE record, so
 * canonical keys follow the PR #589 revision pattern (state fingerprint +
 * `:tx:<xid8>`) behind an effective-state no-op guard — exact retries
 * return before any write; A -> B -> A edits keep distinct revision keys.
 */
export async function recordApgar({
  tenantId, newborn_id, time_minute, appearance, pulse, grimace, activity, respiration,
  recorded_by, actor_uid, actor_role,
}) {
  if (!newborn_id) throw AppError.badRequest('newborn_id is required');
  if (![1, 5, 10].includes(Number(time_minute))) {
    throw AppError.badRequest('time_minute must be 1, 5, or 10');
  }
  for (const k of ['appearance', 'pulse', 'grimace', 'activity', 'respiration']) {
    const v = { appearance, pulse, grimace, activity, respiration }[k];
    if (v != null && (Number(v) < 0 || Number(v) > 2)) {
      throw AppError.badRequest(`${k} must be 0-2`);
    }
  }
  const tid = tenantOr(tenantId);
  const newborn = await assertNewbornInTenant(tid, newborn_id);
  // Fail fast on an absent identity link (B-2: a stillbirth newborn never
  // has one); the authoritative re-checks run in-transaction under locks.
  if (!newborn.newborn_patient_uid) throw newbornIdentityRequired();
  const context = await loadNewbornSubjectContext(prisma, tid, newborn.id);
  if (!context) throw AppError.notFound('Newborn not found');
  const motherPatientUid = String(context.mother_patient_uid);

  const incoming = {
    appearance: appearance != null ? Number(appearance) : null,
    pulse: pulse != null ? Number(pulse) : null,
    grimace: grimace != null ? Number(grimace) : null,
    activity: activity != null ? Number(activity) : null,
    respiration: respiration != null ? Number(respiration) : null,
    recorded_by: recorded_by ? String(recorded_by) : null,
  };

  return setTenantTx(tid, async (tx) => {
    const subjectUid = await assertInfantScopeSubject(tx, {
      tenantId: tid,
      newbornId: newborn.id,
      motherPatientUid,
    });

    // Effective-state no-op guard (canonical revision-sequence discipline,
    // PR #589): compare the EXACT state the ON CONFLICT UPDATE below would
    // persist (direct EXCLUDED overwrites) against the current row, locked
    // FOR UPDATE under the newborn row lock taken above. An exact retry
    // returns before the UPSERT so the row keeps its xmin, recorded_at is
    // not re-stamped, and no new canonical revision is allocated.
    const guardRows = await tx.$queryRawUnsafe(
      `SELECT a.*,
              (
                    a.appearance  IS NOT DISTINCT FROM $4::int
                AND a.pulse       IS NOT DISTINCT FROM $5::int
                AND a.grimace     IS NOT DISTINCT FROM $6::int
                AND a.activity    IS NOT DISTINCT FROM $7::int
                AND a.respiration IS NOT DISTINCT FROM $8::int
                AND a.recorded_by IS NOT DISTINCT FROM $9::uuid
              ) AS effective_state_unchanged
         FROM maternity_apgar_scores a
        WHERE a.tenant_id = $1::uuid
          AND a.newborn_id = $2::int
          AND a.time_minute = $3::int
        FOR UPDATE`,
      tid, Number(newborn.id), Number(time_minute),
      incoming.appearance, incoming.pulse, incoming.grimace,
      incoming.activity, incoming.respiration, incoming.recorded_by,
    );
    if (guardRows.length && guardRows[0].effective_state_unchanged === true) {
      const { effective_state_unchanged: _unchanged, ...existingScore } = guardRows[0];
      return existingScore;
    }

    // total_score is computed here with migration 155's formula. 155 defined
    // the column GENERATED ALWAYS AS (sum of COALESCEd components) STORED,
    // but the regenerated 000_baseline (schema-drift fix 2026-05-12) carries
    // it as a PLAIN integer — no generation, no default — so every write
    // through the pre-rework path left it NULL. The service now owns the
    // formula; the ON CONFLICT arm carries it via EXCLUDED.
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO maternity_apgar_scores
         (newborn_id, time_minute, appearance, pulse, grimace, activity, respiration,
          total_score, recorded_by, tenant_id)
       VALUES ($1::int, $2::int, $3::int, $4::int, $5::int, $6::int, $7::int,
               COALESCE($3::int, 0) + COALESCE($4::int, 0) + COALESCE($5::int, 0)
                 + COALESCE($6::int, 0) + COALESCE($7::int, 0),
               $8::uuid, $9::uuid)
       ON CONFLICT (newborn_id, time_minute) DO UPDATE SET
         appearance = EXCLUDED.appearance,
         pulse = EXCLUDED.pulse,
         grimace = EXCLUDED.grimace,
         activity = EXCLUDED.activity,
         respiration = EXCLUDED.respiration,
         total_score = EXCLUDED.total_score,
         recorded_by = EXCLUDED.recorded_by,
         recorded_at = NOW()
       WHERE maternity_apgar_scores.tenant_id = EXCLUDED.tenant_id
       RETURNING *`,
      Number(newborn.id), Number(time_minute),
      incoming.appearance, incoming.pulse, incoming.grimace,
      incoming.activity, incoming.respiration, incoming.recorded_by,
      tid,
    );
    if (!rows.length) throw AppError.notFound('Apgar score not found');
    const apgar = rows[0];

    // Genuine mutation on an amendable row: fingerprint the CLINICAL state
    // only (recorded_at is a stamp, not state — hashing it would break
    // A -> B -> A key-base stability) and pair it with the transaction-
    // unique xid8 so every committed mutation owns exactly one revision.
    const canonicalRevision = canonicalStateFingerprint({
      newborn_id: Number(apgar.newborn_id),
      time_minute: Number(apgar.time_minute),
      appearance: apgar.appearance == null ? null : Number(apgar.appearance),
      pulse: apgar.pulse == null ? null : Number(apgar.pulse),
      grimace: apgar.grimace == null ? null : Number(apgar.grimace),
      activity: apgar.activity == null ? null : Number(apgar.activity),
      respiration: apgar.respiration == null ? null : Number(apgar.respiration),
      total_score: apgar.total_score == null ? null : Number(apgar.total_score),
      recorded_by: apgar.recorded_by ? String(apgar.recorded_by) : null,
    });
    const txRevision = await currentCanonicalTransactionRevision(tx);

    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: subjectUid,
      eventType: 'maternity.apgar_recorded',
      eventStatus: 'recorded',
      sourceTable: 'maternity_apgar_scores',
      sourceId: apgar.id,
      resourceType: 'apgar_score',
      resourceId: apgar.id,
      actorUid: actor_uid || recorded_by || null,
      actorRole: actor_role || null,
      occurredAt: apgar.recorded_at,
      visibleToPatient: false,
      summary: 'Apgar score recorded',
      payload: {
        apgar_score_id: apgar.id,
        newborn_id: Number(apgar.newborn_id),
        time_minute: Number(apgar.time_minute),
        total_score: apgar.total_score == null ? null : Number(apgar.total_score),
      },
      afterState: {
        total_score: apgar.total_score == null ? null : Number(apgar.total_score),
      },
      tags: ['maternity', 'newborn', 'apgar'],
      timelineIdempotencyKey: `maternity_apgar_scores:${apgar.id}:${canonicalRevision}:tx:${txRevision}`,
      auditIdempotencyKey: `maternity_apgar_scores:${apgar.id}:audit:${canonicalRevision}:tx:${txRevision}`,
    }, { db: tx, strict: true });

    return apgar;
  });
}

export async function getNewbornBundle({ tenantId, id }) {
  const newbornRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_newborns WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantOr(tenantId),
  );
  if (!newbornRows.length) throw AppError.notFound('Newborn not found');
  const apgarRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_apgar_scores WHERE newborn_id = $1::int ORDER BY time_minute`,
    Number(newbornRows[0].id),
  );
  return { newborn: newbornRows[0], apgar: apgarRows };
}

export async function listNewbornsForDelivery({ tenantId, delivery_id }) {
  const tid = tenantOr(tenantId);
  const delivery = await assertDeliveryInTenant(tid, delivery_id);
  return prisma.$queryRawUnsafe(
    `SELECT n.*, COALESCE(json_agg(json_build_object(
        'time_minute', a.time_minute, 'total_score', a.total_score
      ) ORDER BY a.time_minute) FILTER (WHERE a.id IS NOT NULL), '[]') AS apgar
       FROM maternity_newborns n
       LEFT JOIN maternity_apgar_scores a ON a.newborn_id = n.id
      WHERE n.tenant_id = $1::uuid AND n.delivery_id = $2::int
      GROUP BY n.id
      ORDER BY n.birth_order`,
    tid, Number(delivery.id),
  );
}

// ── Postnatal visits ────────────────────────────────────────────────

const POSTNATAL_VISIT_KINDS = Object.freeze(['mother', 'baby', 'both']);

const numberOrNull = (value) => (value == null ? null : Number(value));

/**
 * D7 M-C rework (signed 2026-07-15) — postnatal visits under the B-i rule:
 *
 * - visit_kind 'mother'  -> ONE canonical pair, subject = the mother.
 * - visit_kind 'baby'    -> ONE canonical pair, subject = the infant's OWN
 *   identity (S-2 FULL scope; E-3/E-c1-validated in-transaction).
 * - visit_kind 'both'    -> ONE detail row, TWO canonical pairs (B-i dual
 *   pairs): a maternal event carrying ONLY maternal facts and an infant
 *   event carrying ONLY infant facts, with per-subject idempotency keys.
 *   Detail row + both pairs commit or roll back together.
 *
 * F-1: a 'both' visit with no linked newborn is rejected (the baby record
 * always exists under Shape 3 — staff link the baby first); 'baby' visits
 * carry the same requirement. F-t1: the linked newborn must belong to this
 * visit's delivery (mother-plus-twins = one visit per infant). F-n1: shared
 * free-text notes / red-flags stay detail-row-only — never in either
 * canonical payload.
 *
 * Rows are insert-once (POST + GET routes only, no amendment path), so the
 * canonical emits use fixed per-subject lifecycle keys — see the
 * Idempotency-Key Discipline table in docs/CANONICAL_CLINICAL_TIMELINE.md.
 */
export async function recordPostnatalVisit({
  tenantId, delivery_id, visit_at, visit_kind = 'mother', newborn_id,
  mother_temp_c, mother_pulse_bpm, mother_bp_systolic, mother_bp_diastolic,
  uterine_involution, lochia, perineum_status, breastfeeding_status,
  baby_weight_g, baby_temperature_c, baby_feeding, baby_jaundice,
  baby_passed_meconium, baby_passed_urine, baby_cord_status,
  red_flags, notes, recorded_by,
  actor_uid, actor_role,
}) {
  if (!delivery_id) throw AppError.badRequest('delivery_id is required');
  const visitKind = String(visit_kind || 'mother');
  if (!POSTNATAL_VISIT_KINDS.includes(visitKind)) {
    throw AppError.badRequest(
      `visit_kind must be one of: ${POSTNATAL_VISIT_KINDS.join(', ')}`,
    );
  }
  const tid = tenantOr(tenantId);
  const delivery = await assertDeliveryInTenant(tid, delivery_id);
  const motherUid = String(delivery.patient_uid);
  const infantScope = visitKind === 'baby' || visitKind === 'both';
  const maternalScope = visitKind === 'mother' || visitKind === 'both';

  // F-1 (signed): infant-scope visits REQUIRE the newborn link.
  if (infantScope && !newborn_id) {
    throw AppError.conflict(
      `A '${visitKind}' postnatal visit requires a linked newborn record`,
      'MATERNITY_POSTNATAL_NEWBORN_LINK_REQUIRED',
    );
  }
  // F-t1: assertNewbornInTenant(deliveryId) rejects a newborn from another
  // delivery with a 403.
  const newborn = newborn_id
    ? await assertNewbornInTenant(tid, newborn_id, delivery.id)
    : null;
  // Fail fast on an absent identity link for infant-scope writes (B-2: a
  // stillbirth newborn never has one); the authoritative E-3/E-c1 checks
  // re-run in-transaction under row locks.
  if (infantScope && !newborn.newborn_patient_uid) throw newbornIdentityRequired();

  return setTenantTx(tid, async (tx) => {
    const infantSubjectUid = infantScope
      ? await assertInfantScopeSubject(tx, {
        tenantId: tid,
        newbornId: newborn.id,
        motherPatientUid: motherUid,
      })
      : null;

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO maternity_postnatal_visits
         (delivery_id, visit_at, visit_kind, newborn_id,
          mother_temp_c, mother_pulse_bpm, mother_bp_systolic, mother_bp_diastolic,
          uterine_involution, lochia, perineum_status, breastfeeding_status,
          baby_weight_g, baby_temperature_c, baby_feeding, baby_jaundice,
          baby_passed_meconium, baby_passed_urine, baby_cord_status,
          red_flags, notes, recorded_by, tenant_id)
       VALUES ($1::int, $2::timestamptz, $3, $4::int,
               $5::numeric, $6::int, $7::int, $8::int,
               $9, $10, $11, $12,
               $13::int, $14::numeric, $15, $16,
               $17, $18, $19,
               $20::text[], $21, $22::uuid, $23::uuid)
       RETURNING *`,
      Number(delivery.id),
      visit_at || new Date().toISOString(),
      visitKind,
      newborn ? Number(newborn.id) : null,
      mother_temp_c ? Number(mother_temp_c) : null,
      mother_pulse_bpm ? Number(mother_pulse_bpm) : null,
      mother_bp_systolic ? Number(mother_bp_systolic) : null,
      mother_bp_diastolic ? Number(mother_bp_diastolic) : null,
      uterine_involution || null, lochia || null,
      perineum_status || null, breastfeeding_status || null,
      baby_weight_g ? Number(baby_weight_g) : null,
      baby_temperature_c ? Number(baby_temperature_c) : null,
      baby_feeding || null, baby_jaundice || null,
      baby_passed_meconium ?? null, baby_passed_urine ?? null,
      baby_cord_status || null,
      red_flags || null, notes || null,
      recorded_by ? String(recorded_by) : null, tid,
    );
    const visit = rows[0];

    const eventBase = {
      tenantId: tid,
      eventType: 'maternity.postnatal_visit_recorded',
      eventStatus: 'recorded',
      sourceTable: 'maternity_postnatal_visits',
      sourceId: visit.id,
      resourceType: 'postnatal_visit',
      resourceId: visit.id,
      actorUid: actor_uid || recorded_by || null,
      actorRole: actor_role || null,
      occurredAt: visit.visit_at,
      visibleToPatient: false,
      tags: ['maternity', 'postnatal'],
    };

    // Maternal pair: ONLY maternal facts (strict per-subject payload
    // separation; F-n1 keeps notes/red-flags out of both payloads).
    if (maternalScope) {
      await recordCanonicalClinicalEvent({
        ...eventBase,
        patientUid: motherUid,
        summary: 'Postnatal visit recorded (mother)',
        payload: {
          postnatal_visit_id: visit.id,
          delivery_id: Number(delivery.id),
          visit_kind: visitKind,
          subject_scope: 'mother',
          mother_temp_c: numberOrNull(visit.mother_temp_c),
          mother_pulse_bpm: numberOrNull(visit.mother_pulse_bpm),
          mother_bp_systolic: numberOrNull(visit.mother_bp_systolic),
          mother_bp_diastolic: numberOrNull(visit.mother_bp_diastolic),
          uterine_involution: visit.uterine_involution || null,
          lochia: visit.lochia || null,
          perineum_status: visit.perineum_status || null,
          breastfeeding_status: visit.breastfeeding_status || null,
        },
        afterState: {
          postnatal_visit_recorded: true,
          visit_kind: visitKind,
          subject_scope: 'mother',
        },
        timelineIdempotencyKey: `maternity_postnatal_visits:${visit.id}:mother:recorded`,
        auditIdempotencyKey: `maternity_postnatal_visits:${visit.id}:mother:audit:recorded`,
      }, { db: tx, strict: true });
    }

    // Infant pair: ONLY infant facts, attributed to the infant's own
    // validated identity (never the mother — no proxy, no fallback).
    if (infantScope) {
      await recordCanonicalClinicalEvent({
        ...eventBase,
        patientUid: infantSubjectUid,
        summary: 'Postnatal visit recorded (baby)',
        payload: {
          postnatal_visit_id: visit.id,
          delivery_id: Number(delivery.id),
          visit_kind: visitKind,
          subject_scope: 'infant',
          newborn_id: Number(newborn.id),
          baby_weight_g: numberOrNull(visit.baby_weight_g),
          baby_temperature_c: numberOrNull(visit.baby_temperature_c),
          baby_feeding: visit.baby_feeding || null,
          baby_jaundice: visit.baby_jaundice || null,
          baby_passed_meconium: visit.baby_passed_meconium ?? null,
          baby_passed_urine: visit.baby_passed_urine ?? null,
          baby_cord_status: visit.baby_cord_status || null,
        },
        afterState: {
          postnatal_visit_recorded: true,
          visit_kind: visitKind,
          subject_scope: 'infant',
        },
        timelineIdempotencyKey: `maternity_postnatal_visits:${visit.id}:infant:recorded`,
        auditIdempotencyKey: `maternity_postnatal_visits:${visit.id}:infant:audit:recorded`,
      }, { db: tx, strict: true });
    }

    return visit;
  });
}

export async function listPostnatalVisits({ tenantId, delivery_id }) {
  const tid = tenantOr(tenantId);
  const delivery = await assertDeliveryInTenant(tid, delivery_id);
  return prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_postnatal_visits
      WHERE tenant_id = $1::uuid AND delivery_id = $2::int
      ORDER BY visit_at DESC`,
    tid, Number(delivery.id),
  );
}
