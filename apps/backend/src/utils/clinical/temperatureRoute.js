// src/utils/clinical/temperatureRoute.js
//
// Temperature measurement route (oral / axillary / rectal / tympanic).
// Shared by the two staff-facing vitals surfaces — vitalsChartService
// (EMR vitals_chart) and patientHealthController (patient_vitals) — so
// the allowlist has a single source of truth and the two tables can't
// drift apart. Stored as plain text per the migration-211 dipstick
// precedent; validated here rather than via a DB enum so the value
// round-trips without an enum migration.
//
// Finding: 2026-05-09-pediatric-opd-nurse-no-temperature-route-field.

export const VALID_TEMPERATURE_ROUTES = ['oral', 'axillary', 'rectal', 'tympanic'];

// Normalise a temperature route to its canonical lowercase token.
// Returns { value } on success (value is null for empty input) and
// { error } for an unrecognised route. The result-object shape lets
// each caller decide how to surface the failure: the EMR service
// throws AppError.badRequest, while the health controller — whose
// catch block would otherwise turn a throw into a 500 — returns a
// clean 400 inline.
export function normaliseTemperatureRoute(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const v = String(raw).trim().toLowerCase();
  if (!VALID_TEMPERATURE_ROUTES.includes(v)) {
    return { error: `temperature_route must be one of: ${VALID_TEMPERATURE_ROUTES.join(', ')}` };
  }
  return { value: v };
}
