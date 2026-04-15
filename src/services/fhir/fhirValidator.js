// src/services/fhir/fhirValidator.js
//
// Light FHIR R4 conformance checker. Runs on every resource the fhirAdapter
// produces before it leaves the server — catches missing required fields so
// downstream EHRs don't reject our bundles with a vague "invalid resource".
//
// This is **not** a full validator — we don't implement the 1200+ slicing
// rules in the R4 spec. We check:
//
//   * resourceType present and matches the caller's expectation.
//   * Cardinality-1 required elements per the R4 profile.
//   * For Observation: code.coding[] present and each coding has `system` +
//     `code` (prevents the "empty code" anti-pattern).
//
// Full conformance tests against the official validator JAR are flagged as
// follow-up in docs/ROADMAP.md under 3B.

import logger from '../../logging/logger.js';

/** Required fields per resource type (R4 minimums). */
const REQUIRED = {
  Patient:          ['id'],
  Observation:      ['id', 'status', 'code', 'subject'],
  Condition:        ['id', 'subject'],
  MedicationRequest:['id', 'status', 'intent', 'subject'],
  AllergyIntolerance:['id', 'patient'],
  Encounter:        ['id', 'status', 'class'],
  Appointment:      ['id', 'status'],
  Procedure:        ['id', 'status', 'subject'],
  DiagnosticReport: ['id', 'status', 'code'],
  DocumentReference:['id', 'status'],
  ServiceRequest:   ['id', 'status', 'intent', 'subject'],
};

/** R4 enum constraints — flagged as errors when violated. */
const VALUE_SETS = {
  Observation: {
    status: ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'],
  },
  MedicationRequest: {
    status: ['active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown'],
    intent: ['proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'],
  },
  Appointment: {
    status: ['proposed', 'pending', 'booked', 'arrived', 'fulfilled', 'cancelled', 'noshow', 'entered-in-error', 'checked-in', 'waitlist'],
  },
  ServiceRequest: {
    status: ['draft', 'active', 'on-hold', 'revoked', 'completed', 'entered-in-error', 'unknown'],
    intent: ['proposal', 'plan', 'directive', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'],
  },
  Encounter: {
    status: ['planned', 'arrived', 'triaged', 'in-progress', 'onleave', 'finished', 'cancelled', 'entered-in-error', 'unknown'],
  },
  Procedure: {
    status: ['preparation', 'in-progress', 'not-done', 'on-hold', 'stopped', 'completed', 'entered-in-error', 'unknown'],
  },
  DiagnosticReport: {
    status: ['registered', 'partial', 'preliminary', 'final', 'amended', 'corrected', 'appended', 'cancelled', 'entered-in-error', 'unknown'],
  },
  DocumentReference: {
    status: ['current', 'superseded', 'entered-in-error'],
  },
};

/**
 * Validate a FHIR resource. Returns { valid: true } on success or
 * { valid: false, issues: [...] } describing the first-level problems.
 */
export function validateResource(resource, { expectedType } = {}) {
  const issues = [];
  if (!resource || typeof resource !== 'object') {
    return { valid: false, issues: [{ severity: 'error', code: 'structure', message: 'Not an object' }] };
  }
  if (!resource.resourceType) {
    issues.push({ severity: 'error', code: 'structure', message: 'Missing resourceType' });
  } else if (expectedType && resource.resourceType !== expectedType) {
    issues.push({ severity: 'error', code: 'structure', message: `Expected ${expectedType}, got ${resource.resourceType}` });
  }

  const required = REQUIRED[resource.resourceType] ?? [];
  for (const f of required) {
    if (resource[f] === undefined || resource[f] === null || resource[f] === '') {
      issues.push({ severity: 'error', code: 'required', message: `Missing required element ${resource.resourceType}.${f}` });
    }
  }

  // Enum validation — reject non-spec values on bound elements.
  const valueSet = VALUE_SETS[resource.resourceType];
  if (valueSet) {
    for (const [field, allowed] of Object.entries(valueSet)) {
      const v = resource[field];
      if (v !== undefined && v !== null && !allowed.includes(v)) {
        issues.push({
          severity: 'error',
          code: 'code-invalid',
          message: `${resource.resourceType}.${field}="${v}" not in R4 value set`,
        });
      }
    }
  }

  // MedicationRequest must have at least one of medicationReference |
  // medicationCodeableConcept (the "medication[x]" required choice).
  if (resource.resourceType === 'MedicationRequest') {
    const hasMed = Boolean(resource.medicationCodeableConcept || resource.medicationReference);
    if (!hasMed) {
      issues.push({
        severity: 'error',
        code: 'required',
        message: 'MedicationRequest must have medicationCodeableConcept or medicationReference',
      });
    }
  }

  // Observation-specific: code.coding[] must exist with system+code.
  if (resource.resourceType === 'Observation') {
    const codings = resource.code?.coding ?? [];
    if (codings.length === 0) {
      issues.push({ severity: 'error', code: 'required', message: 'Observation.code.coding[] is empty' });
    }
    for (let i = 0; i < codings.length; i++) {
      const c = codings[i];
      if (!c.system) {
        issues.push({ severity: 'error', code: 'required', message: `Observation.code.coding[${i}].system missing` });
      }
      if (!c.code) {
        issues.push({ severity: 'error', code: 'required', message: `Observation.code.coding[${i}].code missing` });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Express middleware — wraps a route handler, validates the resource it would
 * send, and on failure returns an OperationOutcome with 500 + logs the issues
 * rather than shipping invalid FHIR. Intended for read endpoints where the
 * caller passes `resource` to `res.json(resource)`.
 */
export function validatedFhirJson(res, resource, { expectedType } = {}) {
  const { valid, issues } = validateResource(resource, { expectedType });
  if (!valid) {
    logger.warn(`FHIR validation failed for ${expectedType}: ${JSON.stringify(issues)}`);
    return res.status(500).json({
      resourceType: 'OperationOutcome',
      issue: issues.map((i) => ({
        severity: i.severity,
        code: i.code,
        diagnostics: i.message,
      })),
    });
  }
  return res.json(resource);
}

/**
 * Validate every entry in a FHIR searchset Bundle. Invalid entries are left
 * in place (dropping them silently would hide data) but each is logged at
 * `warn`, and a summary issue count is returned so the caller can decide
 * whether to fail the request. For a permissive search response we usually
 * ship the bundle anyway — one bad row shouldn't kill a query.
 */
export function validateBundle(bundle) {
  if (!bundle || bundle.resourceType !== 'Bundle') {
    return { valid: false, entryCount: 0, invalidCount: 0, issues: [] };
  }
  const issues = [];
  let invalidCount = 0;
  for (let i = 0; i < (bundle.entry ?? []).length; i++) {
    const entry = bundle.entry[i];
    const result = validateResource(entry.resource);
    if (!result.valid) {
      invalidCount++;
      for (const iss of result.issues) {
        issues.push({ ...iss, path: `entry[${i}]` });
      }
    }
  }
  if (invalidCount > 0) {
    logger.warn(`FHIR bundle has ${invalidCount} invalid entries: ${JSON.stringify(issues.slice(0, 5))}`);
  }
  return { valid: invalidCount === 0, entryCount: (bundle.entry ?? []).length, invalidCount, issues };
}

export default { validateResource, validatedFhirJson, validateBundle };
