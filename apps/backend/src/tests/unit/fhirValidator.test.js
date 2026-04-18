// Unit tests for the FHIR R4 informational validator.
//
// This is the conformance gate the audit asked for. It locks in:
//   - Required-element checks per resource type (R4 minimums).
//   - Bound value-set enforcement (status, intent enums).
//   - Resource-specific invariants (Observation.code.coding[*].system+code,
//     MedicationRequest.medication[x] choice).
//   - Bundle traversal: invalid entries are reported but don't drop the bundle.
//
// What this validator deliberately does NOT do (audit gap, see ROADMAP 3B):
//   - Slicing rules, profile-specific invariants, terminology validation.

import { validateBundle, validateResource } from '../../services/fhir/fhirValidator.js';

describe('validateResource — required elements', () => {
  it('rejects null / non-object input', () => {
    expect(validateResource(null).valid).toBe(false);
    expect(validateResource('not-an-object').valid).toBe(false);
  });

  it('rejects missing resourceType', () => {
    const r = validateResource({ id: 'p1' });
    expect(r.valid).toBe(false);
    expect(r.issues.find((i) => i.code === 'structure')).toBeDefined();
  });

  it('rejects mismatched expectedType', () => {
    const r = validateResource({ resourceType: 'Patient', id: 'p1' }, { expectedType: 'Observation' });
    expect(r.valid).toBe(false);
    expect(r.issues[0].message).toMatch(/Expected Observation, got Patient/);
  });

  it('passes Patient with id present', () => {
    expect(validateResource({ resourceType: 'Patient', id: 'p1' }).valid).toBe(true);
  });

  it('flags missing Observation.subject', () => {
    const r = validateResource({
      resourceType: 'Observation',
      id: 'o1',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] },
      // no subject
    });
    expect(r.valid).toBe(false);
    expect(r.issues.find((i) => i.message.includes('Observation.subject'))).toBeDefined();
  });
});

describe('validateResource — bound value sets', () => {
  it('accepts a canonical Observation.status', () => {
    const r = validateResource({
      resourceType: 'Observation',
      id: 'o1',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] },
      subject: { reference: 'Patient/p1' },
    });
    expect(r.valid).toBe(true);
  });

  it('rejects an Observation.status not in the R4 value set', () => {
    const r = validateResource({
      resourceType: 'Observation',
      id: 'o1',
      status: 'almost-final', // not a real R4 code
      code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] },
      subject: { reference: 'Patient/p1' },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.find((i) => i.code === 'code-invalid')).toBeDefined();
  });

  it('rejects MedicationRequest.intent that is not in the value set', () => {
    const r = validateResource({
      resourceType: 'MedicationRequest',
      id: 'm1',
      status: 'active',
      intent: 'guess', // not a real R4 code
      subject: { reference: 'Patient/p1' },
      medicationCodeableConcept: { text: 'Paracetamol 500mg' },
    });
    expect(r.valid).toBe(false);
  });
});

describe('validateResource — Observation.code.coding[*]', () => {
  it('rejects empty coding[]', () => {
    const r = validateResource({
      resourceType: 'Observation',
      id: 'o1',
      status: 'final',
      code: { coding: [] },
      subject: { reference: 'Patient/p1' },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.find((i) => i.message.includes('coding[] is empty'))).toBeDefined();
  });

  it('rejects coding entry with missing system or code', () => {
    const r = validateResource({
      resourceType: 'Observation',
      id: 'o1',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org' /* code missing */ }] },
      subject: { reference: 'Patient/p1' },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.find((i) => i.message.includes('code missing'))).toBeDefined();
  });
});

describe('validateResource — MedicationRequest.medication[x] choice', () => {
  it('rejects when neither medicationReference nor medicationCodeableConcept is present', () => {
    const r = validateResource({
      resourceType: 'MedicationRequest',
      id: 'm1',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
    });
    expect(r.valid).toBe(false);
    expect(r.issues.find((i) => i.message.includes('medication'))).toBeDefined();
  });

  it('accepts when medicationCodeableConcept is provided', () => {
    const r = validateResource({
      resourceType: 'MedicationRequest',
      id: 'm1',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
      medicationCodeableConcept: { text: 'Amoxicillin 500mg' },
    });
    expect(r.valid).toBe(true);
  });

  it('accepts when medicationReference is provided', () => {
    const r = validateResource({
      resourceType: 'MedicationRequest',
      id: 'm1',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/p1' },
      medicationReference: { reference: 'Medication/m99' },
    });
    expect(r.valid).toBe(true);
  });
});

describe('validateBundle', () => {
  it('rejects non-Bundle input', () => {
    const r = validateBundle({ resourceType: 'Patient', id: 'p1' });
    expect(r.valid).toBe(false);
  });

  it('passes an empty searchset Bundle', () => {
    const r = validateBundle({ resourceType: 'Bundle', type: 'searchset', entry: [] });
    expect(r.valid).toBe(true);
    expect(r.entryCount).toBe(0);
    expect(r.invalidCount).toBe(0);
  });

  it('counts invalid entries without dropping them', () => {
    const r = validateBundle({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p1' } },         // valid
        { resource: { resourceType: 'Patient' /* no id */ } },       // invalid
        { resource: { resourceType: 'Observation', id: 'o1' } },    // invalid (missing fields)
      ],
    });
    expect(r.valid).toBe(false);
    expect(r.entryCount).toBe(3);
    expect(r.invalidCount).toBe(2);
  });
});
