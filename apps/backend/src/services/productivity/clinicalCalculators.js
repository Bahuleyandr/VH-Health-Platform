// src/services/productivity/clinicalCalculators.js
//
// Sprint 8 — pure-compute clinical calculators. No DB access.
// Reference ranges and scoring are documented inline against the
// originating clinical guideline so a clinician can verify the
// implementation is faithful.
//
// Each calculator validates inputs and returns:
//   { result: <number|object>, interpretation: '<short clinical text>' }
// Calculators NEVER prescribe action — they report.

import { AppError } from '../../utils/AppError.js';

// ── Anthropometric ───────────────────────────────────────────────────

/** Body Mass Index. WHO classification. */
export function bmi({ weight_kg, height_cm }) {
  if (!weight_kg || !height_cm) throw AppError.badRequest('weight_kg and height_cm required');
  const m = Number(height_cm) / 100;
  const b = Number(weight_kg) / (m * m);
  let band;
  if (b < 18.5) band = 'underweight';
  else if (b < 25) band = 'normal';
  else if (b < 30) band = 'overweight';
  else if (b < 35) band = 'obese_class_i';
  else if (b < 40) band = 'obese_class_ii';
  else band = 'obese_class_iii';
  return { result: Number(b.toFixed(2)), band, interpretation: `BMI ${b.toFixed(1)} (${band})` };
}

/** Body Surface Area, Mosteller formula. Used for chemo dosing. */
export function bsaMosteller({ weight_kg, height_cm }) {
  if (!weight_kg || !height_cm) throw AppError.badRequest('weight_kg and height_cm required');
  const bsa = Math.sqrt((Number(height_cm) * Number(weight_kg)) / 3600);
  return { result: Number(bsa.toFixed(3)), interpretation: `BSA ${bsa.toFixed(2)} m²` };
}

// ── Renal ────────────────────────────────────────────────────────────

/**
 * Creatinine clearance (Cockcroft-Gault). Imperial / SI mixed: serum
 * creatinine in mg/dL (Indian labs usually report this).
 */
export function crClCockcroftGault({ age, weight_kg, serum_creatinine_mg_dl, sex }) {
  if (!age || !weight_kg || !serum_creatinine_mg_dl || !sex) {
    throw AppError.badRequest('age, weight_kg, serum_creatinine_mg_dl, sex required');
  }
  const factor = String(sex).toLowerCase().startsWith('f') ? 0.85 : 1.0;
  const cr = ((140 - Number(age)) * Number(weight_kg) * factor) /
             (72 * Number(serum_creatinine_mg_dl));
  let stage;
  if (cr >= 90) stage = 'normal_or_high';
  else if (cr >= 60) stage = 'ckd_2_mild';
  else if (cr >= 45) stage = 'ckd_3a_mild_moderate';
  else if (cr >= 30) stage = 'ckd_3b_moderate_severe';
  else if (cr >= 15) stage = 'ckd_4_severe';
  else stage = 'ckd_5_kidney_failure';
  return {
    result: Number(cr.toFixed(1)),
    stage,
    interpretation: `CrCl ${cr.toFixed(1)} mL/min (${stage.replaceAll('_', ' ')})`,
  };
}

// ── Cardio ───────────────────────────────────────────────────────────

/**
 * CHA2DS2-VASc — annual stroke risk in non-valvular atrial fibrillation.
 * Each input boolean. Returns score 0-9.
 */
export function cha2ds2Vasc({
  congestive_hf, hypertension, age, sex,
  diabetes, prior_stroke_tia, vascular_disease,
}) {
  if (age == null || !sex) throw AppError.badRequest('age and sex required');
  let score = 0;
  if (congestive_hf) score += 1;
  if (hypertension) score += 1;
  if (Number(age) >= 75) score += 2;
  else if (Number(age) >= 65) score += 1;
  if (diabetes) score += 1;
  if (prior_stroke_tia) score += 2;
  if (vascular_disease) score += 1;
  if (String(sex).toLowerCase().startsWith('f')) score += 1;
  let band;
  if (score <= 1) band = 'low_risk_consider_no_anticoag';
  else if (score === 2) band = 'moderate_risk_consider_anticoag';
  else band = 'high_risk_anticoag_recommended';
  return { result: score, band, interpretation: `CHA2DS2-VASc ${score} — ${band.replaceAll('_', ' ')}` };
}

/**
 * HAS-BLED — major bleeding risk on anticoagulation.
 */
export function hasBled({
  hypertension_uncontrolled, abnormal_renal, abnormal_liver,
  prior_stroke, prior_bleed, labile_inr,
  age_over_65, drugs_predisposing_bleed, alcohol_excess,
}) {
  let score = 0;
  if (hypertension_uncontrolled) score += 1;
  if (abnormal_renal) score += 1;
  if (abnormal_liver) score += 1;
  if (prior_stroke) score += 1;
  if (prior_bleed) score += 1;
  if (labile_inr) score += 1;
  if (age_over_65) score += 1;
  if (drugs_predisposing_bleed) score += 1;
  if (alcohol_excess) score += 1;
  const band = score >= 3 ? 'high_bleeding_risk' : 'lower_bleeding_risk';
  return { result: score, band, interpretation: `HAS-BLED ${score} — ${band.replaceAll('_', ' ')}` };
}

// ── PE / DVT ────────────────────────────────────────────────────────

/** Wells score for PE. */
export function wellsPe({
  clinical_signs_dvt, pe_most_likely_diagnosis,
  hr_over_100, immobilisation_or_recent_surgery,
  prior_dvt_or_pe, hemoptysis, malignancy,
}) {
  let s = 0;
  if (clinical_signs_dvt) s += 3;
  if (pe_most_likely_diagnosis) s += 3;
  if (hr_over_100) s += 1.5;
  if (immobilisation_or_recent_surgery) s += 1.5;
  if (prior_dvt_or_pe) s += 1.5;
  if (hemoptysis) s += 1;
  if (malignancy) s += 1;
  let band;
  if (s > 6) band = 'high_probability';
  else if (s >= 2) band = 'moderate_probability';
  else band = 'low_probability';
  return { result: s, band, interpretation: `Wells PE ${s} — ${band.replaceAll('_', ' ')}` };
}

/** Wells score for DVT. */
export function wellsDvt({
  active_cancer, paralysis_paresis_recent_immob,
  bedridden_3d_or_surgery_4w, tenderness_along_deep_veins,
  entire_leg_swollen, calf_swelling_3cm,
  pitting_edema_symptomatic_leg, collateral_superficial_veins,
  prior_dvt, alternative_dx_at_least_as_likely,
}) {
  let s = 0;
  if (active_cancer) s += 1;
  if (paralysis_paresis_recent_immob) s += 1;
  if (bedridden_3d_or_surgery_4w) s += 1;
  if (tenderness_along_deep_veins) s += 1;
  if (entire_leg_swollen) s += 1;
  if (calf_swelling_3cm) s += 1;
  if (pitting_edema_symptomatic_leg) s += 1;
  if (collateral_superficial_veins) s += 1;
  if (prior_dvt) s += 1;
  if (alternative_dx_at_least_as_likely) s -= 2;
  let band;
  if (s >= 3) band = 'high_probability';
  else if (s >= 1) band = 'moderate_probability';
  else band = 'low_probability';
  return { result: s, band, interpretation: `Wells DVT ${s} — ${band.replaceAll('_', ' ')}` };
}

// ── Sepsis / critical care ──────────────────────────────────────────

/** qSOFA — bedside sepsis screen. >=2 → high risk for poor outcome. */
export function qsofa({ rr_over_22, altered_mentation, sbp_under_100 }) {
  let s = 0;
  if (rr_over_22) s += 1;
  if (altered_mentation) s += 1;
  if (sbp_under_100) s += 1;
  return {
    result: s,
    band: s >= 2 ? 'high_risk_evaluate_for_sepsis' : 'low_risk',
    interpretation: `qSOFA ${s}`,
  };
}

/** Glasgow Coma Scale. Range 3-15. */
export function gcs({ eye, verbal, motor }) {
  const e = Number(eye), v = Number(verbal), m = Number(motor);
  if (!Number.isFinite(e) || e < 1 || e > 4) throw AppError.badRequest('eye 1-4');
  if (!Number.isFinite(v) || v < 1 || v > 5) throw AppError.badRequest('verbal 1-5');
  if (!Number.isFinite(m) || m < 1 || m > 6) throw AppError.badRequest('motor 1-6');
  const total = e + v + m;
  let band;
  if (total >= 13) band = 'mild';
  else if (total >= 9) band = 'moderate';
  else band = 'severe';
  return { result: { eye: e, verbal: v, motor: m, total }, band, interpretation: `GCS E${e}V${v}M${m} = ${total} (${band})` };
}

// ── Hepatic ─────────────────────────────────────────────────────────

/**
 * MELD score — chronic liver disease severity. Higher = worse.
 * Formula uses natural log of creatinine, bilirubin, INR.
 * Note: Indian clinical practice sometimes uses MELD-Na; this is
 * classic MELD.
 */
export function meld({ creatinine_mg_dl, bilirubin_mg_dl, inr, on_dialysis }) {
  if (!creatinine_mg_dl || !bilirubin_mg_dl || !inr) {
    throw AppError.badRequest('creatinine_mg_dl, bilirubin_mg_dl, inr required');
  }
  // Floor each value at 1.0 per UNOS.
  const cr = on_dialysis ? 4.0 : Math.max(1.0, Math.min(4.0, Number(creatinine_mg_dl)));
  const bili = Math.max(1.0, Number(bilirubin_mg_dl));
  const i = Math.max(1.0, Number(inr));
  const score = 9.57 * Math.log(cr) + 3.78 * Math.log(bili) + 11.2 * Math.log(i) + 6.43;
  const rounded = Math.round(score);
  let band;
  if (rounded < 10) band = 'mild';
  else if (rounded < 20) band = 'moderate';
  else band = 'severe';
  return { result: rounded, band, interpretation: `MELD ${rounded} (${band})` };
}

// ── Electrolytes ────────────────────────────────────────────────────

/** Anion gap — sodium - (chloride + bicarbonate). Normal 8-12. */
export function anionGap({ na, cl, hco3 }) {
  if (na == null || cl == null || hco3 == null) {
    throw AppError.badRequest('na, cl, hco3 required');
  }
  const ag = Number(na) - (Number(cl) + Number(hco3));
  let band;
  if (ag > 12) band = 'high_ag_consider_metabolic_acidosis';
  else if (ag < 8) band = 'low_ag';
  else band = 'normal';
  return { result: ag, band, interpretation: `Anion gap ${ag} (${band.replaceAll('_', ' ')})` };
}

/** Corrected calcium for albumin. */
export function correctedCalcium({ calcium_mg_dl, albumin_g_dl }) {
  if (!calcium_mg_dl || !albumin_g_dl) {
    throw AppError.badRequest('calcium_mg_dl, albumin_g_dl required');
  }
  // Corrected Ca = measured Ca + 0.8 × (4 − albumin)
  const corr = Number(calcium_mg_dl) + 0.8 * (4 - Number(albumin_g_dl));
  return {
    result: Number(corr.toFixed(2)),
    interpretation: `Corrected calcium ${corr.toFixed(2)} mg/dL`,
  };
}

// ── Pediatric ───────────────────────────────────────────────────────

/** Apgar total. 0-10. Each component 0-2. */
export function apgar({ appearance, pulse, grimace, activity, respiration }) {
  for (const [k, v] of Object.entries({ appearance, pulse, grimace, activity, respiration })) {
    if (v == null || v < 0 || v > 2) throw AppError.badRequest(`${k} must be 0-2`);
  }
  const total = Number(appearance) + Number(pulse) + Number(grimace) +
                Number(activity) + Number(respiration);
  let band;
  if (total >= 7) band = 'normal';
  else if (total >= 4) band = 'moderately_depressed';
  else band = 'severely_depressed';
  return { result: total, band, interpretation: `Apgar ${total}/10 (${band.replaceAll('_', ' ')})` };
}

// ── Registry (so the route can iterate) ─────────────────────────────

export const CALCULATORS = {
  bmi, bsaMosteller, crClCockcroftGault,
  cha2ds2Vasc, hasBled, wellsPe, wellsDvt,
  qsofa, gcs, meld, anionGap, correctedCalcium, apgar,
};
