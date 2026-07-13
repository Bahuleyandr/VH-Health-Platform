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

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import logger from '../../logging/logger.js';
import { checkVitalAnomalies } from '../../utils/clinical/vitalSignMonitor.js';
import { istDateString } from '../../utils/dateUtils.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  assertPrivilegeForGate,
  isGateEnabled,
  privilegeKey,
} from '../staff/credentialingService.js';

export { istDateString };

const tenantOr = (tenantId) => requireTenantId(tenantId);

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
  const rows = await prisma.$queryRawUnsafe(
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
  await prisma.$executeRawUnsafe(
    `UPDATE users
        SET is_pregnant = TRUE,
            pregnancy_lmp_date = COALESCE($2::date, pregnancy_lmp_date),
            updated_at = NOW()
      WHERE tenant_id = $3::uuid AND uid = $1::uuid`,
    String(patient_uid),
    lmp_date || null,
    tid,
  );
  return rows[0];
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
}) {
  if (!pregnancy_id) throw AppError.badRequest('pregnancy_id is required');
  if (!visit_date) throw AppError.badRequest('visit_date is required');
  const pregnancy = await assertPregnancyInTenant(tenantId, pregnancy_id);
  const tid = tenantOr(tenantId);

  // Auto-assign visit_number per pregnancy (migration 181). The "ANC
  // visit #4" label is collapsed onto a single COALESCE/MAX +1 path
  // so recordAncVisit doesn't need a separate counter table.
  const nextNumberRow = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(MAX(visit_number), 0) + 1 AS next_number
       FROM maternity_anc_visits
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
    tid,
    pregnancy.id,
  );
  const nextNumber = Number(nextNumberRow?.[0]?.next_number) || 1;

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
  const rows = await prisma.$queryRawUnsafe(
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
  const visit = rows[0];

  // Phase 1.5 best-effort: emit pre-eclampsia alert on BP ≥140/90.
  // Patient-safety hook — finding
  // 2026-05-09-obstetric-anc-nurse-anc-visit-no-preeclampsia-alert.
  // Pregnancy BP thresholds live in vitalSignMonitor's
  // PREGNANCY_BP_OVERRIDES and only fire when users.is_pregnant=TRUE,
  // so we set the flag here too. Failure of this hook must NEVER block
  // visit creation — pattern mirrors maybeEmitTpaCapAlerts.
  let alerts = [];
  if (bp_systolic != null || bp_diastolic != null) {
    try {
      const patientRows = await prisma.$queryRawUnsafe(
        `SELECT u.id, u.is_pregnant
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
        if (patient.is_pregnant !== true) {
          await prisma.$executeRawUnsafe(
            `UPDATE users
                SET is_pregnant = TRUE,
                    updated_at = NOW()
              WHERE id = $1::int`,
            patient.id,
          );
        }
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

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id FROM maternity_supplements
       WHERE tenant_id = $1::uuid
         AND pregnancy_id = $2::int
         AND supplement = $3
         AND (end_date IS NULL OR end_date >= CURRENT_DATE)
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    tid, pregnancyId, supplement,
  );
  if (existing.length) {
    const rows = await prisma.$queryRawUnsafe(
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
        RETURNING *, TRUE AS continued`,
      Number(existing[0].id), tid, pregnancyId,
      dose || null, frequencyValue, routeValue, startDate,
      end_date || null, reminder_enabled !== undefined ? reminder_enabled !== false : null,
      notes || null, String(prescribed_by),
    );
    return rows[0];
  }

  const rows = await prisma.$queryRawUnsafe(
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
  return rows[0];
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
      const existing = await prisma.$queryRawUnsafe(
        `SELECT id FROM maternity_supplements
           WHERE tenant_id = $1::uuid
             AND pregnancy_id = $2::int
             AND supplement = $3
             AND (end_date IS NULL OR end_date >= CURRENT_DATE)
           LIMIT 1`,
        tid, pregnancyId, supplement,
      );
      if (existing.length) continue;

      const inserted = await prisma.$queryRawUnsafe(
        `INSERT INTO maternity_supplements
           (pregnancy_id, supplement, dose, frequency, route,
            reminder_enabled, notes, prescribed_by, tenant_id)
         VALUES ($1::int, $2, $3, $4, 'oral', TRUE,
                 'Auto-propagated from prescription', $5::uuid, $6::uuid)
         RETURNING id, supplement, dose, frequency, start_date`,
        pregnancyId, supplement, dose, frequency,
        String(prescribed_by), tid,
      );
      created.push(inserted[0]);
    }
  }

  return created;
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

  const rows = await prisma.$queryRawUnsafe(
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
  return rows[0];
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
  await assertPregnancyInTenant(tid, pregnancyId);
  const rows = await prisma.$queryRawUnsafe(
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
  if (!rows.length) throw AppError.notFound('Supplement not found');
  return rows[0];
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
}) {
  if (!pregnancy_id) throw AppError.badRequest('pregnancy_id is required');
  const tid = tenantOr(tenantId);
  const pregnancy = await assertPregnancyInTenant(tid, pregnancy_id);
  if (admission_id) {
    await assertAdmissionInTenant(tid, admission_id, pregnancy.patient_uid);
  }
  await assertObgynLabourWardPrivilege(attending_obstetrician, tid, 'maternity_labor_admission');

  const rows = await prisma.$queryRawUnsafe(
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
  return rows[0];
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
}) {
  if (!labor_admission_id) throw AppError.badRequest('labor_admission_id is required');
  const labor = await getLaborAdmission({ tenantId, id: labor_admission_id });

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

  const rows = await prisma.$queryRawUnsafe(
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
    recorded_by ? String(recorded_by) : null, tenantId,
  );
  return rows[0];
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
}) {
  if (!pregnancy_id) throw AppError.badRequest('pregnancy_id is required');
  if (!delivery_datetime) throw AppError.badRequest('delivery_datetime is required');
  if (!delivery_mode) throw AppError.badRequest('delivery_mode is required');
  const tid = tenantOr(tenantId);
  const pregnancy = await assertPregnancyInTenant(tid, pregnancy_id);
  let labor = null;
  if (labor_admission_id) {
    labor = await getLaborAdmission({ tenantId: tid, id: labor_admission_id });
    if (Number(labor.pregnancy_id) !== Number(pregnancy.id)) {
      throw AppError.forbidden('Labor admission belongs to a different pregnancy');
    }
  }
  await assertObgynLabourWardPrivilege(delivered_by, tid, 'maternity_delivery');

  const rows = await prisma.$queryRawUnsafe(
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

  // Project to pregnancy + labor admission.
  await prisma.$executeRawUnsafe(
    `UPDATE maternity_pregnancies
        SET status = 'delivered', updated_at = NOW()
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(pregnancy.id),
    tid,
  );
  if (labor) {
    await prisma.$executeRawUnsafe(
      `UPDATE maternity_labor_admissions
          SET status = 'delivered', updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(labor.id),
      tid,
    );
  }
  return rows[0];
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

export async function recordNewborn({
  tenantId, delivery_id, birth_order = 1, birth_datetime, sex,
  birth_weight_g, birth_length_cm, head_circumference_cm, chest_circumference_cm,
  gestational_age_weeks, outcome = 'live',
  resuscitation_done, resuscitation_type, newborn_patient_uid,
  cord_clamped_at_min, skin_to_skin_done, breastfeeding_initiated_min,
  vit_k_given, bcg_given, hep_b_given, opv_given,
  congenital_anomaly, congenital_anomaly_desc, recorded_by, notes,
}) {
  if (!delivery_id) throw AppError.badRequest('delivery_id is required');
  if (!birth_datetime) throw AppError.badRequest('birth_datetime is required');
  const tid = tenantOr(tenantId);
  const delivery = await assertDeliveryInTenant(tid, delivery_id);
  if (newborn_patient_uid) await assertPatientInTenant(tid, newborn_patient_uid);

  const rows = await prisma.$queryRawUnsafe(
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
    Number(delivery.id), Number(birth_order),
    birth_datetime, sex || null,
    birth_weight_g ? Number(birth_weight_g) : null,
    birth_length_cm ? Number(birth_length_cm) : null,
    head_circumference_cm ? Number(head_circumference_cm) : null,
    chest_circumference_cm ? Number(chest_circumference_cm) : null,
    gestational_age_weeks ? Number(gestational_age_weeks) : null,
    outcome,
    !!resuscitation_done, resuscitation_type || null,
    newborn_patient_uid ? String(newborn_patient_uid) : null,
    cord_clamped_at_min ? Number(cord_clamped_at_min) : null,
    !!skin_to_skin_done,
    breastfeeding_initiated_min ? Number(breastfeeding_initiated_min) : null,
    !!vit_k_given, !!bcg_given, !!hep_b_given, !!opv_given,
    !!congenital_anomaly, congenital_anomaly_desc || null,
    recorded_by ? String(recorded_by) : null,
    notes || null, tid,
  );
  return rows[0];
}

export async function recordApgar({
  tenantId, newborn_id, time_minute, appearance, pulse, grimace, activity, respiration, recorded_by,
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
  const newborn = await assertNewbornInTenant(tenantId, newborn_id);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_apgar_scores
       (newborn_id, time_minute, appearance, pulse, grimace, activity, respiration, recorded_by)
     VALUES ($1::int, $2::int, $3::int, $4::int, $5::int, $6::int, $7::int, $8::uuid)
     ON CONFLICT (newborn_id, time_minute) DO UPDATE SET
       appearance = EXCLUDED.appearance,
       pulse = EXCLUDED.pulse,
       grimace = EXCLUDED.grimace,
       activity = EXCLUDED.activity,
       respiration = EXCLUDED.respiration,
       recorded_by = EXCLUDED.recorded_by,
       recorded_at = NOW()
     RETURNING *`,
    Number(newborn.id), Number(time_minute),
    appearance != null ? Number(appearance) : null,
    pulse != null ? Number(pulse) : null,
    grimace != null ? Number(grimace) : null,
    activity != null ? Number(activity) : null,
    respiration != null ? Number(respiration) : null,
    recorded_by ? String(recorded_by) : null,
  );
  return rows[0];
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

export async function recordPostnatalVisit({
  tenantId, delivery_id, visit_at, visit_kind = 'mother', newborn_id,
  mother_temp_c, mother_pulse_bpm, mother_bp_systolic, mother_bp_diastolic,
  uterine_involution, lochia, perineum_status, breastfeeding_status,
  baby_weight_g, baby_temperature_c, baby_feeding, baby_jaundice,
  baby_passed_meconium, baby_passed_urine, baby_cord_status,
  red_flags, notes, recorded_by,
}) {
  if (!delivery_id) throw AppError.badRequest('delivery_id is required');
  const tid = tenantOr(tenantId);
  const delivery = await assertDeliveryInTenant(tid, delivery_id);
  const newborn = newborn_id ? await assertNewbornInTenant(tid, newborn_id, delivery.id) : null;

  const rows = await prisma.$queryRawUnsafe(
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
    visit_kind,
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
  return rows[0];
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
