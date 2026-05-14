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

// ── Pregnancy episode ────────────────────────────────────────────────

function computeEdd(lmpDate) {
  if (!lmpDate) return null;
  const lmp = new Date(lmpDate);
  if (Number.isNaN(lmp.getTime())) return null;
  // Naegele's rule: LMP + 280 days
  const edd = new Date(lmp.getTime() + 280 * 86400 * 1000);
  return edd.toISOString().split('T')[0];
}

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
  const reference = onDate ? new Date(onDate) : new Date();
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

export async function createPregnancy({
  tenantId, patient_uid, pregnancy_number = 1,
  lmp_date, edd_date, edd_method,
  gravida = 1, parity = 0, living_children = 0, abortions = 0,
  blood_group, rh_factor, booking_status = 'booked', booking_visit_date,
  high_risk = false, high_risk_reasons, notes, created_by,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');

  const eddFinal = edd_date || computeEdd(lmp_date);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, edd_method,
        gravida, parity, living_children, abortions,
        blood_group, rh_factor, booking_status, booking_visit_date,
        high_risk, high_risk_reasons, notes, created_by, tenant_id)
     VALUES ($1::uuid, $2::int, $3::date, $4::date, $5,
             $6::int, $7::int, $8::int, $9::int,
             $10, $11, $12, $13::date,
             $14, $15::text[], $16, $17::uuid, $18::uuid)
     RETURNING *`,
    String(patient_uid), Number(pregnancy_number),
    lmp_date || null, eddFinal || null, edd_method || null,
    Number(gravida), Number(parity), Number(living_children), Number(abortions),
    blood_group || null, rh_factor || null,
    booking_status, booking_visit_date || null,
    !!high_risk, high_risk_reasons || null, notes || null,
    created_by ? String(created_by) : null, tenantId,
  );
  return rows[0];
}

export async function getPregnancy({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_pregnancies WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Pregnancy not found');
  return rows[0];
}

export async function listPregnanciesForPatient({ tenantId, patient_uid }) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
      ORDER BY created_at DESC`,
    tenantId, String(patient_uid),
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
  params.push(tenantId);
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

  // Auto-assign visit_number per pregnancy (migration 181). The "ANC
  // visit #4" label is collapsed onto a single COALESCE/MAX +1 path
  // so recordAncVisit doesn't need a separate counter table.
  const nextNumberRow = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(MAX(visit_number), 0) + 1 AS next_number
       FROM maternity_anc_visits
      WHERE pregnancy_id = $1::int`,
    Number(pregnancy_id),
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
    Number(pregnancy_id), visit_date,
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
    recorded_by ? String(recorded_by) : null, tenantId,
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
          WHERE p.id = $1::int
          LIMIT 1`,
        Number(pregnancy_id),
      );
      const patient = patientRows[0];
      if (patient?.id) {
        if (patient.is_pregnant !== true) {
          await prisma.$executeRawUnsafe(
            `UPDATE users SET is_pregnant = TRUE WHERE id = $1::int`,
            patient.id,
          );
        }
        let recorderId = null;
        if (recorded_by) {
          const rRows = await prisma.$queryRawUnsafe(
            `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`,
            String(recorded_by),
          );
          recorderId = rRows[0]?.id ?? null;
        }
        const vitalsForCheck = {};
        if (bp_systolic != null) vitalsForCheck.systolic_bp = Number(bp_systolic);
        if (bp_diastolic != null) vitalsForCheck.diastolic_bp = Number(bp_diastolic);
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
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, pregnancy_number, lmp_date, edd_date, edd_method,
            gravida, parity, living_children, abortions, blood_group, rh_factor,
            booking_status, booking_visit_date, high_risk, high_risk_reasons,
            status, notes, created_at
       FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status = 'ongoing'
      ORDER BY created_at DESC
      LIMIT 1`,
    tenantId, patient_uid,
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
  const tid = tenantId || '00000000-0000-4000-8000-000000000001';
  const [pregnancy, visits, supplements, kicks] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, lmp_date, edd_date, gravida, parity,
              high_risk, high_risk_reasons, status
         FROM maternity_pregnancies
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      id, tid,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, visit_date, visit_number, gestational_age_weeks,
              weight_kg, bp_systolic, bp_diastolic, fundal_height_cm,
              fetal_heart_rate_bpm, hb_gm_dl, urine_albumin,
              iron_folic_acid_given, calcium_given, tt_dose,
              next_visit_date, notes
         FROM maternity_anc_visits
        WHERE pregnancy_id = $1::int
        ORDER BY visit_date DESC, id DESC`,
      id,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, supplement, dose, frequency, route, start_date,
              end_date, reminder_enabled, notes, prescribed_by, created_at
         FROM maternity_supplements
        WHERE pregnancy_id = $1::int
        ORDER BY start_date DESC`,
      id,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, log_date, kick_count, observation_window_minutes,
              low_count_flag, notes
         FROM maternity_fetal_kicks
        WHERE pregnancy_id = $1::int
        ORDER BY log_date DESC
        LIMIT 30`,
      id,
    ),
  ]);
  if (!pregnancy.length) throw AppError.notFound(`Pregnancy ${id} not found`);
  const p = pregnancy[0];
  return {
    pregnancy: { ...p, gestational_age: computeGestationalAge(p.lmp_date) },
    visits,
    supplements,
    fetal_kicks: kicks,
  };
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

const VALID_SUPPLEMENTS = new Set([
  'iron', 'folic_acid', 'calcium', 'vitamin_d', 'b_complex', 'other',
]);
const VALID_FREQUENCIES = new Set([
  'once_daily', 'twice_daily', 'thrice_daily', 'weekly', 'as_needed',
]);

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
  if (!prescribed_by) throw AppError.badRequest('prescribed_by is required');

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_supplements
       (pregnancy_id, supplement, dose, frequency, route, start_date,
        end_date, reminder_enabled, notes, prescribed_by, tenant_id)
     VALUES ($1::int, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10::uuid, $11::uuid)
     RETURNING *`,
    Number(pregnancy_id), supplement, dose || null,
    frequency || 'once_daily', route || 'oral',
    start_date || new Date().toISOString().slice(0, 10),
    end_date || null, reminder_enabled !== false, notes || null,
    String(prescribed_by), tenantId,
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

  const pregRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM maternity_pregnancies
       WHERE patient_uid = $1::uuid AND status = 'ongoing'
       ORDER BY created_at DESC
       LIMIT 1`,
    String(patient_uid),
  );
  if (!pregRows.length) return [];
  const pregnancyId = Number(pregRows[0].id);
  const tid = tenantId || '00000000-0000-4000-8000-000000000001';

  const created = [];
  for (const med of medications) {
    if (!med || typeof med !== 'object') continue;
    const name = String(med.name || med.medication || med.medicine || '').trim();
    if (!name) continue;

    const matches = SUPPLEMENT_PATTERNS
      .filter(({ re }) => re.test(name))
      .map(({ kind }) => kind);
    if (!matches.length) continue;

    const freqRaw = String(med.frequency || med.freq || '').toLowerCase().trim();
    const frequency = FREQ_MAP[freqRaw] || 'once_daily';
    const dose = String(med.dose || med.dosage || med.strength || '').trim() || null;

    for (const supplement of matches) {
      const existing = await prisma.$queryRawUnsafe(
        `SELECT id FROM maternity_supplements
           WHERE pregnancy_id = $1::int
             AND supplement = $2
             AND (end_date IS NULL OR end_date >= CURRENT_DATE)
           LIMIT 1`,
        pregnancyId, supplement,
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
  const tid = tenantId || '00000000-0000-4000-8000-000000000001';
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
    Number(pregnancy_id), day, count, window, lowFlag,
    notes || null,
    recorded_by ? String(recorded_by) : null,
    tenantId,
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
// tenantId reserved for future tenant scoping; currently unscoped per the in-flight finding.
export async function listPriorOrdersForPregnancy({ tenantId: _tenantId, pregnancy_id }) {
  const id = Number.parseInt(pregnancy_id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('pregnancy_id must be a positive integer');
  }
  // Resolve patient_uid + LMP from the pregnancy to scope the join.
  const pregRows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid, lmp_date, created_at
       FROM maternity_pregnancies
      WHERE id = $1::int`,
    id,
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
          AND i.created_at >= $2::timestamptz
        ORDER BY i.requested_at DESC
        LIMIT 50`,
      patient_uid, since,
    ),
    prisma.$queryRawUnsafe(
      `SELECT id, prescription_number, diagnosis, medications, status,
              created_at, follow_up_date
         FROM e_prescriptions
        WHERE patient_uid = $1::uuid
          AND created_at >= $2::timestamptz
        ORDER BY created_at DESC
        LIMIT 50`,
      patient_uid, since,
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
  const tid = tenantId || '00000000-0000-4000-8000-000000000001';
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
  const tid = tenantId || '00000000-0000-4000-8000-000000000001';
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
  return prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_anc_visits
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int
      ORDER BY visit_date DESC`,
    tenantId, Number(pregnancy_id),
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
    Number(pregnancy_id),
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
    notes || null, tenantId,
  );
  return rows[0];
}

export async function getLaborAdmission({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_labor_admissions WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
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
      WHERE la.tenant_id = $1::uuid AND la.status = 'active'
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
  return prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_partograph_entries
      WHERE tenant_id = $1::uuid AND labor_admission_id = $2::int
      ORDER BY recorded_at`,
    tenantId, Number(labor_admission_id),
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
    Number(pregnancy_id),
    labor_admission_id ? Number(labor_admission_id) : null,
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
    notes || null, tenantId,
  );

  // Project to pregnancy + labor admission.
  await prisma.$executeRawUnsafe(
    `UPDATE maternity_pregnancies SET status = 'delivered', updated_at = NOW() WHERE id = $1::int`,
    Number(pregnancy_id),
  );
  if (labor_admission_id) {
    await prisma.$executeRawUnsafe(
      `UPDATE maternity_labor_admissions SET status = 'delivered', updated_at = NOW() WHERE id = $1::int`,
      Number(labor_admission_id),
    );
  }
  return rows[0];
}

export async function getDelivery({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_deliveries WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
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
    Number(delivery_id), Number(birth_order),
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
    notes || null, tenantId,
  );
  return rows[0];
}

export async function recordApgar({
  newborn_id, time_minute, appearance, pulse, grimace, activity, respiration, recorded_by,
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
    Number(newborn_id), Number(time_minute),
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
    Number(id), tenantId,
  );
  if (!newbornRows.length) throw AppError.notFound('Newborn not found');
  const apgarRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_apgar_scores WHERE newborn_id = $1::int ORDER BY time_minute`,
    Number(id),
  );
  return { newborn: newbornRows[0], apgar: apgarRows };
}

export async function listNewbornsForDelivery({ delivery_id }) {
  return prisma.$queryRawUnsafe(
    `SELECT n.*, COALESCE(json_agg(json_build_object(
        'time_minute', a.time_minute, 'total_score', a.total_score
      ) ORDER BY a.time_minute) FILTER (WHERE a.id IS NOT NULL), '[]') AS apgar
       FROM maternity_newborns n
       LEFT JOIN maternity_apgar_scores a ON a.newborn_id = n.id
      WHERE n.delivery_id = $1::int
      GROUP BY n.id
      ORDER BY n.birth_order`,
    Number(delivery_id),
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
    Number(delivery_id),
    visit_at || new Date().toISOString(),
    visit_kind,
    newborn_id ? Number(newborn_id) : null,
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
    recorded_by ? String(recorded_by) : null, tenantId,
  );
  return rows[0];
}

export async function listPostnatalVisits({ tenantId, delivery_id }) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM maternity_postnatal_visits
      WHERE tenant_id = $1::uuid AND delivery_id = $2::int
      ORDER BY visit_at DESC`,
    tenantId, Number(delivery_id),
  );
}
