// src/services/fhir/observationVitalsMapper.js
//
// Roadmap C3/C5 — shared, pure mapping between LOINC-coded observations and
// vitals_chart columns. Consumed by:
//   * the FHIR write endpoint (POST /fhir/Observation, roadmap C3)
//   * the ICU monitor ORU ingestion path (roadmap C5)
//
// Only well-known vital-sign LOINCs map; everything else is reported in
// `unmapped` so callers can decide (FHIR write rejects, device ingestion
// logs + skips).

export const LOINC_TO_VITALS_FIELD = Object.freeze({
  '8867-4': { field: 'heart_rate', label: 'Heart rate' },
  '8480-6': { field: 'systolic_bp', label: 'Systolic blood pressure' },
  '8462-4': { field: 'diastolic_bp', label: 'Diastolic blood pressure' },
  '8310-5': { field: 'temperature', label: 'Body temperature' },
  '9279-1': { field: 'respiratory_rate', label: 'Respiratory rate' },
  '2708-6': { field: 'spo2', label: 'Oxygen saturation (arterial)' },
  '59408-5': { field: 'spo2', label: 'Oxygen saturation (pulse oximetry)' },
  '2339-0': { field: 'blood_glucose', label: 'Glucose (blood)' },
  '9269-2': { field: 'gcs_score', label: 'Glasgow Coma Scale total' },
  '72514-3': { field: 'pain_score', label: 'Pain severity 0-10' },
  '29463-7': { field: 'weight_kg', label: 'Body weight' },
  '8302-2': { field: 'height_cm', label: 'Body height' },
});

// 85354-9 = blood-pressure panel (components carry 8480-6 / 8462-4).
export const BP_PANEL_LOINC = '85354-9';

function codeOf(codeable) {
  const coding = Array.isArray(codeable?.coding) ? codeable.coding : [];
  const loinc = coding.find((c) => !c.system || String(c.system).includes('loinc'));
  return loinc?.code ? String(loinc.code).trim() : null;
}

function numericValue(node) {
  const v = node?.valueQuantity?.value;
  const parsed = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(parsed) ? parsed : null;
}

function assign(vitals, code, value, unmapped) {
  const mapping = LOINC_TO_VITALS_FIELD[code];
  if (!mapping) {
    if (code) unmapped.push(code);
    return null;
  }
  if (value == null) return null;
  vitals[mapping.field] = value;
  return code;
}

/**
 * Map ONE FHIR Observation (single-code, BP panel with components, or any
 * Observation carrying LOINC-coded components) to vitals_chart fields.
 * Pure — unit-tested.
 *
 * Returns { vitals, mapped, unmapped, effective, temperatureUnit }.
 */
export function fhirObservationToVitals(resource = {}) {
  const vitals = {};
  const mapped = [];
  const unmapped = [];

  const rootCode = codeOf(resource.code);
  const components = Array.isArray(resource.component) ? resource.component : [];

  if (components.length > 0) {
    for (const component of components) {
      const code = codeOf(component.code);
      const hit = assign(vitals, code, numericValue(component), unmapped);
      if (hit) mapped.push(hit);
    }
    // A BP panel whose components mapped is fine even though 85354-9
    // itself has no direct column.
    if (rootCode && rootCode !== BP_PANEL_LOINC && !LOINC_TO_VITALS_FIELD[rootCode]
      && mapped.length === 0) {
      unmapped.push(rootCode);
    }
  } else {
    const hit = assign(vitals, rootCode, numericValue(resource), unmapped);
    if (hit) mapped.push(hit);
  }

  // Temperature unit from the quantity (F → recordVitals converts).
  let temperatureUnit;
  if (vitals.temperature != null) {
    const unit = String(
      resource.valueQuantity?.unit
      ?? components.find((c) => codeOf(c.code) === '8310-5')?.valueQuantity?.unit
      ?? '',
    ).toLowerCase();
    if (unit.includes('f') && !unit.includes('cel')) temperatureUnit = 'F';
  }

  return {
    vitals,
    mapped: [...new Set(mapped)],
    unmapped: [...new Set(unmapped)],
    effective: resource.effectiveDateTime || resource.issued || null,
    temperatureUnit: temperatureUnit || null,
  };
}

/**
 * Map a list of parsed OBX-style results ({ loinc_code|test_code, value })
 * to vitals fields — the ORU/device flavour of the same table. Pure.
 */
export function obxResultsToVitals(results = []) {
  const vitals = {};
  const mapped = [];
  const unmapped = [];
  for (const r of results || []) {
    const code = String(r?.loinc_code || r?.test_code || '').trim();
    const value = typeof r?.value_numeric === 'number'
      ? r.value_numeric
      : Number.parseFloat(r?.value_numeric ?? r?.value ?? r?.value_text);
    const hit = assign(vitals, code, Number.isFinite(value) ? value : null, unmapped);
    if (hit) mapped.push(hit);
  }
  return { vitals, mapped: [...new Set(mapped)], unmapped: [...new Set(unmapped)] };
}

export default { LOINC_TO_VITALS_FIELD, BP_PANEL_LOINC, fhirObservationToVitals, obxResultsToVitals };
