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

// ── Pregnancy episode ────────────────────────────────────────────────

function computeEdd(lmpDate) {
  if (!lmpDate) return null;
  const lmp = new Date(lmpDate);
  if (Number.isNaN(lmp.getTime())) return null;
  // Naegele's rule: LMP + 280 days
  const edd = new Date(lmp.getTime() + 280 * 86400 * 1000);
  return edd.toISOString().split('T')[0];
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

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_anc_visits
       (pregnancy_id, visit_date, gestational_age_weeks,
        weight_kg, bp_systolic, bp_diastolic, pulse_bpm,
        fundal_height_cm, fetal_heart_rate_bpm, fetal_movements_felt,
        presentation, edema, pallor,
        hb_gm_dl, urine_albumin, urine_sugar,
        iron_folic_acid_given, calcium_given, tt_dose,
        next_visit_date, notes, recorded_by, tenant_id)
     VALUES ($1::int, $2::date, $3::numeric,
             $4::numeric, $5::int, $6::int, $7::int,
             $8::int, $9::int, $10,
             $11, $12, $13,
             $14::numeric, $15, $16,
             $17, $18, $19,
             $20::date, $21, $22::uuid, $23::uuid)
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
  );
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
function computePartographAlerts({ activePhaseStartedAt, recordedAt, dilationCm }) {
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
