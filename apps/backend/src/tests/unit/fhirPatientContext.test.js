import { jest } from '@jest/globals';

import fhirPatientContext, {
  fhirPatientUidFromRequest,
} from '../../middleware/fhirPatientContext.js';

const UID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = '11111111-2222-4333-8444-555566667777';

function reqOf({ path = '/', query = {}, body = {} } = {}) {
  return { path, query, body };
}

describe('fhirPatientUidFromRequest (#4 — FHIR patient addressing bridge)', () => {
  // (1) Instance reads — patient uid lives in the URL path, which the generic
  // resolver never inspects (it only knows patient_uid-style param keys).
  it('extracts the uid from /Patient/<uuid>', () => {
    expect(fhirPatientUidFromRequest(reqOf({ path: `/Patient/${UID}` }))).toBe(UID);
  });

  it('extracts the uid from /Patient/<uuid>/$everything', () => {
    expect(fhirPatientUidFromRequest(reqOf({ path: `/Patient/${UID}/$everything` }))).toBe(UID);
  });

  it('tolerates the un-stripped /api/v1/fhir mount prefix on the path', () => {
    expect(fhirPatientUidFromRequest(reqOf({ path: `/api/v1/fhir/Patient/${UID}` }))).toBe(UID);
  });

  // (2) Searches — patient is a ?patient= reference (bare uuid OR Patient/<uuid>).
  it('extracts a bare uuid from ?patient=', () => {
    expect(fhirPatientUidFromRequest(reqOf({ path: '/Observation', query: { patient: UID } }))).toBe(UID);
  });

  it('extracts a Patient/<uuid> reference from ?patient=', () => {
    expect(
      fhirPatientUidFromRequest(reqOf({ path: '/Condition', query: { patient: `Patient/${UID}` } })),
    ).toBe(UID);
  });

  it('also accepts ?subject= as the search reference', () => {
    expect(fhirPatientUidFromRequest(reqOf({ path: '/Encounter', query: { subject: UID } }))).toBe(UID);
  });

  // (3) Writes — nested subject.reference / patient.reference in the body.
  it('extracts subject.reference from a write body', () => {
    expect(
      fhirPatientUidFromRequest(reqOf({ path: '/Observation', body: { subject: { reference: `Patient/${UID}` } } })),
    ).toBe(UID);
  });

  it('extracts patient.reference from a write body (AllergyIntolerance)', () => {
    expect(
      fhirPatientUidFromRequest(reqOf({ path: '/AllergyIntolerance', body: { patient: { reference: `Patient/${UID}` } } })),
    ).toBe(UID);
  });

  // Negative cases — no single patient → null (guard then passes through; the
  // tenant filter remains the guarantee, exactly as today).
  it('returns null for the capability statement', () => {
    expect(fhirPatientUidFromRequest(reqOf({ path: '/metadata' }))).toBeNull();
  });

  it('returns null for a name/phone Patient search (no single patient)', () => {
    expect(fhirPatientUidFromRequest(reqOf({ path: '/Patient', query: { name: 'Asha' } }))).toBeNull();
  });

  it('returns null for a malformed patient id', () => {
    expect(fhirPatientUidFromRequest(reqOf({ path: '/Patient/not-a-uuid' }))).toBeNull();
  });

  it('lowercases an upper-cased uuid so DB uuid comparison matches', () => {
    expect(fhirPatientUidFromRequest(reqOf({ path: `/Patient/${UID.toUpperCase()}` }))).toBe(UID);
  });
});

describe('fhirPatientContext middleware', () => {
  it('stashes the resolved uid on req.phiContext.patientUid and calls next', () => {
    const req = reqOf({ path: `/Patient/${UID}` });
    const next = jest.fn();
    fhirPatientContext(req, {}, next);
    expect(req.phiContext.patientUid).toBe(UID);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('preserves any pre-existing phiContext keys', () => {
    const req = { ...reqOf({ path: '/Observation', query: { patient: UID } }), phiContext: { foo: 'bar' } };
    fhirPatientContext(req, {}, jest.fn());
    expect(req.phiContext).toEqual({ foo: 'bar', patientUid: UID });
  });

  it('does not set patientUid (but still calls next) when no patient is addressable', () => {
    const req = reqOf({ path: '/metadata' });
    const next = jest.fn();
    fhirPatientContext(req, {}, next);
    expect(req.phiContext?.patientUid).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('never throws on a malformed request shape', () => {
    const next = jest.fn();
    expect(() => fhirPatientContext({ path: `/Patient/${OTHER}`, query: null, body: null }, {}, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
