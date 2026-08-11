// Hard plausibility bounds for ICU flowsheet + assessment inputs
// (2026-08-10 re-review H1: spo2 990, arbitrary drip rates, unbounded SOFA
// sub-scores were all chartable).
//
// Same philosophy as utils/clinical/vitalPlausibility.js (C-M4): these are
// NOT clinical alerting thresholds — they mark the edge of what a human body
// / bedside device can physically produce, with generous headroom. Anything
// outside is a data-entry or sensor error and must be REJECTED with a 400
// before it is persisted or trended. Core vital fields reuse the shared
// VITAL_PLAUSIBILITY_BOUNDS values under the ICU column names; ICU-only
// fields (ventilator, drips, I/O, neuro, scores) extend the same pattern.
// Migration 648 mirrors these bounds as a NOT VALID CHECK constraint.
// Migrations 651 and 654 relax its vital limits to reject only physically
// impossible values without scanning historical rows; every new write remains
// protected. The DB is the backstop; this module is the friendly 400.
import { AppError } from '../AppError.js';
import {
  VITAL_PLAUSIBILITY_BOUNDS,
  assertRecordedAtPlausibility,
} from './vitalPlausibility.js';

const shared = VITAL_PLAUSIBILITY_BOUNDS;

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const ICU_FLOWSHEET_BOUNDS = {
  // Vitals — shared bounds under the ICU flowsheet column names.
  hr: { ...shared.heart_rate, integer: true },
  sbp: { ...shared.systolic_bp, integer: true },
  dbp: { ...shared.diastolic_bp, integer: true },
  spo2: { ...shared.spo2, integer: true },
  rr: { ...shared.respiratory_rate, integer: true },
  temp_c: { ...shared.temperature },
  // ICU-only haemodynamics / perfusion.
  map: { min: 0, max: 250, unit: 'mmHg', integer: true },
  cvp: { min: -10, max: 60, unit: 'cmH2O', integer: true },
  cap_refill_sec: { min: 0, max: 30, unit: 's' },
  // Neuro.
  gcs_eye: { min: 1, max: 4, unit: '', integer: true },
  gcs_verbal: { min: 1, max: 5, unit: '', integer: true },
  gcs_motor: { min: 1, max: 6, unit: '', integer: true },
  pupils_left_size_mm: { min: 0, max: 12, unit: 'mm' },
  pupils_right_size_mm: { min: 0, max: 12, unit: 'mm' },
  // Ventilator.
  fio2_pct: { min: 21, max: 100, unit: '%', integer: true },
  peep_cmh2o: { min: 0, max: 40, unit: 'cmH2O' },
  tidal_volume_ml: { min: 0, max: 2000, unit: 'mL', integer: true },
  resp_rate_set: { min: 0, max: 80, unit: '/min', integer: true },
  airway_pressure_peak: { min: 0, max: 120, unit: 'cmH2O', integer: true },
  airway_pressure_plateau: { min: 0, max: 120, unit: 'cmH2O', integer: true },
  pf_ratio: { min: 0, max: 700, unit: '', integer: true },
  // Continuous infusions. Zero stays permitted — a 0 rate documents a held
  // drip, clinically distinct from null (not running).
  noradrenaline_mcg_kg_min: { min: 0, max: 10, unit: 'mcg/kg/min' },
  adrenaline_mcg_kg_min: { min: 0, max: 10, unit: 'mcg/kg/min' },
  vasopressin_units_hr: { min: 0, max: 10, unit: 'units/hr' },
  dobutamine_mcg_kg_min: { min: 0, max: 40, unit: 'mcg/kg/min' },
  propofol_mcg_kg_min: { min: 0, max: 300, unit: 'mcg/kg/min' },
  midazolam_mg_hr: { min: 0, max: 50, unit: 'mg/hr' },
  fentanyl_mcg_hr: { min: 0, max: 1000, unit: 'mcg/hr' },
  insulin_units_hr: { min: 0, max: 100, unit: 'units/hr' },
  // Hourly intake / output. Zero is a measurement (anuria), not absence.
  iv_fluids_ml: { min: 0, max: 5000, unit: 'mL', integer: true },
  oral_intake_ml: { min: 0, max: 3000, unit: 'mL', integer: true },
  blood_products_ml: { min: 0, max: 5000, unit: 'mL', integer: true },
  urine_output_ml: { min: 0, max: 3000, unit: 'mL', integer: true },
  drain_output_ml: { min: 0, max: 5000, unit: 'mL', integer: true },
  ng_aspirate_ml: { min: 0, max: 3000, unit: 'mL', integer: true },
  stool_count: { min: 0, max: 20, unit: '', integer: true },
};

// These columns share one database CHECK in migrations 648/651/654. Keep the
// structural field list beside the source bounds so drift tests can derive the
// complete SQL contract without copying any numeric limits.
export const ICU_FLOWSHEET_VITAL_FIELDS = [
  'hr',
  'sbp',
  'dbp',
  'map',
  'cvp',
  'spo2',
  'rr',
  'temp_c',
  'cap_refill_sec',
];

export const ICU_ASSESSMENT_BOUNDS = {
  // RASS −5 (unarousable) … +4 (combative).
  rass_score: { min: -5, max: 4, unit: '', integer: true },
  rass_target: { min: -5, max: 4, unit: '', integer: true },
  // SOFA sub-scores are each 0–4 (total 0–24, materialised at write time).
  sofa_resp: { min: 0, max: 4, unit: '', integer: true },
  sofa_coag: { min: 0, max: 4, unit: '', integer: true },
  sofa_liver: { min: 0, max: 4, unit: '', integer: true },
  sofa_cardio: { min: 0, max: 4, unit: '', integer: true },
  sofa_cns: { min: 0, max: 4, unit: '', integer: true },
  sofa_renal: { min: 0, max: 4, unit: '', integer: true },
  // CPOT domains are each 0–2 (total 0–8).
  cpot_facial: { min: 0, max: 2, unit: '', integer: true },
  cpot_movement: { min: 0, max: 2, unit: '', integer: true },
  cpot_muscle_tension: { min: 0, max: 2, unit: '', integer: true },
  cpot_vent_compliance: { min: 0, max: 2, unit: '', integer: true },
};

function assertBounds(values, boundsMap) {
  for (const [field, bounds] of Object.entries(boundsMap)) {
    const value = values[field];
    if (value === undefined || value === null) continue;
    const num = finiteNumber(value);
    if (num === null) {
      throw AppError.badRequest(`${field} must be a number`);
    }
    if (bounds.integer && !Number.isInteger(num)) {
      throw AppError.badRequest(`${field} must be an integer`);
    }
    if (num < bounds.min || num > bounds.max) {
      throw AppError.badRequest(
        `${field} must be between ${bounds.min} and ${bounds.max}${bounds.unit ? ` ${bounds.unit}` : ''}`,
      );
    }
  }
}

// other_drips is free-form JSONB ([{name, rate, unit}]) — bound the shape so
// the named-column plausibility gate cannot be dodged with garbage entries.
function assertOtherDrips(otherDrips) {
  if (otherDrips === undefined || otherDrips === null) return;
  if (!Array.isArray(otherDrips)) {
    throw AppError.badRequest('other_drips must be an array of {name, rate, unit} entries');
  }
  if (otherDrips.length > 20) {
    throw AppError.badRequest('other_drips cannot exceed 20 entries');
  }
  for (const entry of otherDrips) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw AppError.badRequest('each other_drips entry must be an object');
    }
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 120) {
      throw AppError.badRequest('each other_drips entry needs a name (max 120 chars)');
    }
    if (entry.rate !== undefined && entry.rate !== null) {
      const rate = finiteNumber(entry.rate);
      if (rate === null || rate < 0 || rate > 100000) {
        throw AppError.badRequest('other_drips rate must be a number between 0 and 100000');
      }
    }
  }
}

/**
 * Validate an ICU flowsheet write. Absent fields are skipped — partial
 * hourly entries are a first-class shape. Throws AppError.badRequest naming
 * the field and permitted range on the first violation. Flowsheet entries
 * are staff-entered, so recorded_at gets the human-entry sanity window.
 */
export function assertIcuFlowsheetPlausibility(body = {}, { now } = {}) {
  assertBounds(body, ICU_FLOWSHEET_BOUNDS);
  assertOtherDrips(body.other_drips);
  assertRecordedAtPlausibility(body.recorded_at, { source: 'staff', now });
}

/**
 * Validate an ICU assessment write (RASS / CAM-ICU / SOFA / CPOT scores +
 * recorded_at window).
 */
export function assertIcuAssessmentPlausibility(body = {}, { now } = {}) {
  assertBounds(body, ICU_ASSESSMENT_BOUNDS);
  assertRecordedAtPlausibility(body.recorded_at, { source: 'staff', now });
}

export default {
  ICU_FLOWSHEET_BOUNDS,
  ICU_ASSESSMENT_BOUNDS,
  assertIcuFlowsheetPlausibility,
  assertIcuAssessmentPlausibility,
};
