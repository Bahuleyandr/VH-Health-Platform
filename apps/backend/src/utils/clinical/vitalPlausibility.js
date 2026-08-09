// Hard plausibility bounds for core vital-sign inputs (C-M4).
//
// These are NOT clinical alerting thresholds — those live in
// utils/clinical/vitalSignMonitor.js and classify values as WARNING/CRITICAL.
// The bounds here mark the edge of what a human body can physically produce
// (plus generous headroom for peri-arrest documentation): anything outside is
// a data-entry or sensor error and must be REJECTED with a 400 before it is
// persisted, feeds NEWS2, or reaches the alert engine. Before this module,
// HR 9999 or SpO2 500 stored happily and fired code-blue fan-outs.
//
// Ranges are deliberately wide (reject-only-the-impossible), aligned with the
// per-field precedents already in vitalsChartService (fhr 60-220,
// fundal_height 0-50) and the NEWS2 vitals vocabulary in
// validators/sharedValidators.js. Temperature is bounded in CELSIUS — callers
// must normalize (toCelsius / normalizeTemperatureC) before validating.
import { AppError } from '../AppError.js';

export const VITAL_PLAUSIBILITY_BOUNDS = {
  heart_rate: { min: 20, max: 300, unit: 'bpm' },
  systolic_bp: { min: 40, max: 300, unit: 'mmHg' },
  diastolic_bp: { min: 20, max: 200, unit: 'mmHg' },
  temperature: { min: 30, max: 45, unit: '°C' },
  // 0 stays permitted so peri-arrest saturations remain chartable; >100 is
  // physically impossible (also keeps sensor glitches out of the SpO2
  // classification bands — see vitalSignMonitor's one-sided SpO2 range).
  spo2: { min: 0, max: 100, unit: '%' },
  respiratory_rate: { min: 0, max: 80, unit: '/min' },
  blood_glucose: { min: 10, max: 1500, unit: 'mg/dL' },
  o2_flow_rate: { min: 0, max: 80, unit: 'L/min' },
};

/**
 * Validate present vital values against the hard plausibility bounds.
 * Absent fields (undefined/null) are skipped — partial vitals are a
 * first-class write shape. Throws AppError.badRequest naming the field and
 * the permitted range on the first violation.
 * @param {Object} values - map of field → raw value (temperature in °C)
 */
export function assertVitalPlausibility(values = {}) {
  for (const [field, bounds] of Object.entries(VITAL_PLAUSIBILITY_BOUNDS)) {
    const value = values[field];
    if (value === undefined || value === null) continue;
    const num = Number(value);
    if (Number.isNaN(num)) {
      throw AppError.badRequest(`${field} must be a number`);
    }
    if (num < bounds.min || num > bounds.max) {
      throw AppError.badRequest(
        `${field} must be between ${bounds.min} and ${bounds.max} ${bounds.unit}`,
      );
    }
  }
}

// recorded_at sanity window (C-M4). A vitals timestamp arbitrarily far in the
// future or past corrupts trend charts, NEWS2 history ordering, and the
// 5-minute correction window that keys off recorded_at.
//
// - Future: nothing legitimate records more than clock-skew ahead of the
//   server — 5 minutes covers device/browser drift.
// - Past: bedside back-entry (paper rounds, growth-percentile backdating) is
//   legitimate but bounded at 72h for human entry paths ('staff',
//   'patient_app'). Machine-ingest paths ('device', 'fhir') are EXEMPT from
//   the backdate bound: the device-gateway recovery spool and FHIR imports
//   replay held readings whose observation timestamps are legitimately old.
//   (The I09/I15 late-recovery path inserts into vitals_chart directly via
//   externalVitalsRecoveryService and never passes through this check.)
export const RECORDED_AT_MAX_FUTURE_MS = 5 * 60 * 1000;
export const RECORDED_AT_MAX_BACKDATE_MS = 72 * 60 * 60 * 1000;
export const RECORDED_AT_BACKDATE_EXEMPT_SOURCES = new Set(['device', 'fhir']);

/**
 * Validate a parsed recorded_at Date against the sanity window.
 * @param {Date|null|undefined} recordedAt - already-parsed timestamp (callers
 *   parse/400 on unparseable input first); absent values are skipped (the DB
 *   defaults recorded_at to now()).
 * @param {Object} [options]
 * @param {string} [options.source] - vitals provenance ('staff' | 'device' |
 *   'fhir' | 'patient_app'); machine-ingest sources skip the backdate bound.
 * @param {number} [options.now] - injection point for tests.
 */
export function assertRecordedAtPlausibility(recordedAt, { source, now = Date.now() } = {}) {
  if (recordedAt === undefined || recordedAt === null) return;
  const ts = recordedAt instanceof Date ? recordedAt.getTime() : new Date(recordedAt).getTime();
  if (Number.isNaN(ts)) {
    throw AppError.badRequest('recorded_at must be a valid ISO timestamp');
  }
  if (ts - now > RECORDED_AT_MAX_FUTURE_MS) {
    throw AppError.badRequest('recorded_at cannot be in the future');
  }
  if (
    !RECORDED_AT_BACKDATE_EXEMPT_SOURCES.has(source)
    && now - ts > RECORDED_AT_MAX_BACKDATE_MS
  ) {
    throw AppError.badRequest(
      'recorded_at cannot be backdated more than 72 hours — use the paper reconciliation workflow for older entries',
    );
  }
}

export default {
  VITAL_PLAUSIBILITY_BOUNDS,
  RECORDED_AT_MAX_FUTURE_MS,
  RECORDED_AT_MAX_BACKDATE_MS,
  RECORDED_AT_BACKDATE_EXEMPT_SOURCES,
  assertVitalPlausibility,
  assertRecordedAtPlausibility,
};
