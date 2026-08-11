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

import { AppError } from '../../utils/AppError.js';

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
  '3151-8': { field: 'o2_flow_rate', label: 'Inhaled oxygen flow rate' },
  '29463-7': { field: 'weight_kg', label: 'Body weight' },
  '8302-2': { field: 'height_cm', label: 'Body height' },
});

// 85354-9 = blood-pressure panel (components carry 8480-6 / 8462-4).
export const BP_PANEL_LOINC = '85354-9';

function codeOf(codeable) {
  const coding = Array.isArray(codeable?.coding) ? codeable.coding : [];
  const loinc = coding.find((c) => (
    String(c.system || '').trim() === 'http://loinc.org'
  ));
  return loinc?.code ? String(loinc.code).trim() : null;
}

const STRICT_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function strictNumericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!STRICT_NUMBER_RE.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedUnitToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

const UCUM_CODES_BY_FIELD = Object.freeze({
  heart_rate: new Set(['/min', '{beats}/min']),
  respiratory_rate: new Set(['/min', '{breaths}/min']),
  systolic_bp: new Set(['mm[Hg]']),
  diastolic_bp: new Set(['mm[Hg]']),
  temperature: new Set(['Cel', '[degF]']),
  spo2: new Set(['%', '1', '{fraction}']),
  blood_glucose: new Set(['mg/dL', 'mg/dL{blood}', 'mmol/L']),
  weight_kg: new Set(['kg', 'g', '[lb_av]']),
  height_cm: new Set(['cm', 'm', 'mm', '[in_i]']),
  gcs_score: new Set(['1', '{score}']),
  pain_score: new Set(['1', '{score}']),
  o2_flow_rate: new Set(['L/min']),
});

function unitConversion(field, token) {
  const unit = normalizedUnitToken(token);
  if (!unit) return null;

  const conversions = {
    heart_rate: new Map([
      ['/min', { kind: 'per_minute', factor: 1 }],
      ['{beats}/min', { kind: 'per_minute', factor: 1 }],
      ['beats/min', { kind: 'per_minute', factor: 1 }],
      ['beats/minute', { kind: 'per_minute', factor: 1 }],
      ['bpm', { kind: 'per_minute', factor: 1 }],
    ]),
    respiratory_rate: new Map([
      ['/min', { kind: 'per_minute', factor: 1 }],
      ['{breaths}/min', { kind: 'per_minute', factor: 1 }],
      ['breaths/min', { kind: 'per_minute', factor: 1 }],
      ['breaths/minute', { kind: 'per_minute', factor: 1 }],
    ]),
    systolic_bp: new Map([
      ['mm[hg]', { kind: 'mmhg', factor: 1 }],
      ['mmhg', { kind: 'mmhg', factor: 1 }],
    ]),
    diastolic_bp: new Map([
      ['mm[hg]', { kind: 'mmhg', factor: 1 }],
      ['mmhg', { kind: 'mmhg', factor: 1 }],
    ]),
    temperature: new Map([
      ['cel', { kind: 'celsius', factor: 1, temperatureUnit: 'C' }],
      ['degc', { kind: 'celsius', factor: 1, temperatureUnit: 'C' }],
      ['[degc]', { kind: 'celsius', factor: 1, temperatureUnit: 'C' }],
      ['°c', { kind: 'celsius', factor: 1, temperatureUnit: 'C' }],
      ['celsius', { kind: 'celsius', factor: 1, temperatureUnit: 'C' }],
      ['[degf]', { kind: 'fahrenheit', factor: 1, temperatureUnit: 'F' }],
      ['degf', { kind: 'fahrenheit', factor: 1, temperatureUnit: 'F' }],
      ['°f', { kind: 'fahrenheit', factor: 1, temperatureUnit: 'F' }],
      ['f', { kind: 'fahrenheit', factor: 1, temperatureUnit: 'F' }],
      ['fahrenheit', { kind: 'fahrenheit', factor: 1, temperatureUnit: 'F' }],
    ]),
    spo2: new Map([
      ['%', { kind: 'percent', factor: 1 }],
      ['percent', { kind: 'percent', factor: 1 }],
      ['1', { kind: 'fraction', factor: 100 }],
      ['{fraction}', { kind: 'fraction', factor: 100 }],
      ['fraction', { kind: 'fraction', factor: 100 }],
      ['unity', { kind: 'fraction', factor: 100 }],
    ]),
    blood_glucose: new Map([
      ['mg/dl', { kind: 'mg_per_dl', factor: 1 }],
      ['mg/dl{blood}', { kind: 'mg_per_dl', factor: 1 }],
      ['mmol/l', { kind: 'mmol_per_l', factor: 18.0182 }],
    ]),
    weight_kg: new Map([
      ['kg', { kind: 'kilogram', factor: 1 }],
      ['g', { kind: 'gram', factor: 0.001 }],
      ['[lb_av]', { kind: 'pound', factor: 0.45359237 }],
      ['lb', { kind: 'pound', factor: 0.45359237 }],
      ['lbs', { kind: 'pound', factor: 0.45359237 }],
    ]),
    height_cm: new Map([
      ['cm', { kind: 'centimetre', factor: 1 }],
      ['centimeter', { kind: 'centimetre', factor: 1 }],
      ['centimeters', { kind: 'centimetre', factor: 1 }],
      ['centimetre', { kind: 'centimetre', factor: 1 }],
      ['centimetres', { kind: 'centimetre', factor: 1 }],
      ['m', { kind: 'metre', factor: 100 }],
      ['meter', { kind: 'metre', factor: 100 }],
      ['meters', { kind: 'metre', factor: 100 }],
      ['metre', { kind: 'metre', factor: 100 }],
      ['metres', { kind: 'metre', factor: 100 }],
      ['mm', { kind: 'millimetre', factor: 0.1 }],
      ['[in_i]', { kind: 'inch', factor: 2.54 }],
      ['in', { kind: 'inch', factor: 2.54 }],
      ['inch', { kind: 'inch', factor: 2.54 }],
      ['inches', { kind: 'inch', factor: 2.54 }],
    ]),
    gcs_score: new Map([
      ['1', { kind: 'score', factor: 1 }],
      ['{score}', { kind: 'score', factor: 1 }],
      ['score', { kind: 'score', factor: 1 }],
    ]),
    pain_score: new Map([
      ['1', { kind: 'score', factor: 1 }],
      ['{score}', { kind: 'score', factor: 1 }],
      ['score', { kind: 'score', factor: 1 }],
    ]),
    o2_flow_rate: new Map([
      ['l/min', { kind: 'litres_per_minute', factor: 1 }],
      ['l/minute', { kind: 'litres_per_minute', factor: 1 }],
      ['litres/min', { kind: 'litres_per_minute', factor: 1 }],
      ['liters/min', { kind: 'litres_per_minute', factor: 1 }],
    ]),
  };
  return conversions[field]?.get(unit) || null;
}

function conversionForQuantity(quantity, mapping) {
  const code = String(quantity?.code ?? '').trim();
  const unit = String(quantity?.unit ?? '').trim();
  const system = String(quantity?.system ?? '').trim();
  if (system && system !== 'http://unitsofmeasure.org') {
    throw AppError.badRequest(
      `FHIR Observation ${mapping.label} must use the canonical UCUM system for coded units`,
      'FHIR_OBSERVATION_INVALID_UNIT',
    );
  }
  if (system === 'http://unitsofmeasure.org'
    && code
    && !UCUM_CODES_BY_FIELD[mapping.field]?.has(code)) {
    throw AppError.badRequest(
      `FHIR Observation ${mapping.label} has a missing or unsupported case-sensitive UCUM code`,
      'FHIR_OBSERVATION_INVALID_UNIT',
    );
  }
  if (!code && !unit && ['gcs_score', 'pain_score'].includes(mapping.field)) {
    return { kind: 'score', factor: 1 };
  }

  const codeConversion = code ? unitConversion(mapping.field, code) : null;
  const unitConversionResult = unit ? unitConversion(mapping.field, unit) : null;
  if ((code && !codeConversion) || (!code && !unitConversionResult)) {
    throw AppError.badRequest(
      `FHIR Observation ${mapping.label} has a missing or unsupported source unit`,
      'FHIR_OBSERVATION_INVALID_UNIT',
    );
  }
  if (codeConversion && unitConversionResult && codeConversion.kind !== unitConversionResult.kind) {
    throw AppError.badRequest(
      `FHIR Observation ${mapping.label} has conflicting source units`,
      'FHIR_OBSERVATION_CONFLICTING_UNITS',
    );
  }
  return codeConversion || unitConversionResult;
}

function assignFhir(vitals, code, node, unmapped) {
  const mapping = LOINC_TO_VITALS_FIELD[code];
  if (!mapping) {
    unmapped.push(code || '(missing or non-LOINC component code)');
    return null;
  }
  if (node?.valueQuantity?.comparator != null) {
    throw AppError.badRequest(
      `FHIR Observation ${mapping.label} must provide an exact Quantity value without a comparator`,
      'FHIR_OBSERVATION_INVALID_VALUE',
    );
  }
  const value = strictNumericValue(node?.valueQuantity?.value);
  if (value == null) {
    throw AppError.badRequest(
      `FHIR Observation ${mapping.label} must have a finite numeric Quantity value`,
      'FHIR_OBSERVATION_INVALID_VALUE',
    );
  }
  if (Object.hasOwn(vitals, mapping.field)) {
    throw AppError.badRequest(
      `FHIR Observation maps more than one component to ${mapping.label}`,
      'FHIR_OBSERVATION_DUPLICATE_FIELD',
    );
  }
  const conversion = conversionForQuantity(node.valueQuantity, mapping);
  vitals[mapping.field] = value * conversion.factor;
  return { code, temperatureUnit: conversion.temperatureUnit || null };
}

function assignObx(vitals, code, value, unmapped) {
  const mapping = LOINC_TO_VITALS_FIELD[code];
  if (!mapping) {
    if (code) unmapped.push(code);
    return null;
  }
  if (value == null) {
    throw AppError.badRequest(
      `OBX ${mapping.label} must have a finite numeric value`,
      'OBX_VITAL_INVALID_VALUE',
    );
  }
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
  const unmappedComponents = [];
  let temperatureUnit = null;

  const rootCode = codeOf(resource.code);
  const components = Array.isArray(resource.component) ? resource.component : [];

  if (components.length > 0) {
    for (const component of components) {
      const code = codeOf(component.code);
      const hit = assignFhir(vitals, code, component, unmappedComponents);
      if (hit) {
        mapped.push(hit.code);
        temperatureUnit = hit.temperatureUnit || temperatureUnit;
      }
    }
    unmapped.push(...unmappedComponents);
    // A BP panel whose components mapped is fine even though 85354-9
    // itself has no direct column.
    if (rootCode && rootCode !== BP_PANEL_LOINC && !LOINC_TO_VITALS_FIELD[rootCode]
      && mapped.length === 0) {
      unmapped.push(rootCode);
    }
  } else {
    const hit = assignFhir(vitals, rootCode, resource, unmapped);
    if (hit) {
      mapped.push(hit.code);
      temperatureUnit = hit.temperatureUnit;
    }
  }

  return {
    vitals,
    mapped: [...new Set(mapped)],
    unmapped: [...new Set(unmapped)],
    unmappedComponents: [...new Set(unmappedComponents)],
    effective: resource.effectiveDateTime || resource.issued || null,
    temperatureUnit,
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
    const sourceValue = r?.value_text !== undefined
      ? r.value_text
      : (r?.value ?? r?.value_numeric);
    const value = strictNumericValue(sourceValue);
    const hit = assignObx(vitals, code, value, unmapped);
    if (hit) mapped.push(hit);
  }
  return { vitals, mapped: [...new Set(mapped)], unmapped: [...new Set(unmapped)] };
}

export default { LOINC_TO_VITALS_FIELD, BP_PANEL_LOINC, fhirObservationToVitals, obxResultsToVitals };
