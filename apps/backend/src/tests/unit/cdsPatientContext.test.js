import { jest } from '@jest/globals';

import cdsPatientContext, {
  cdsPatientUidFromRequest,
} from '../../middleware/cdsPatientContext.js';

const UID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = '11111111-2222-4333-8444-555566667777';

function reqOf(context) {
  return { body: context === undefined ? {} : { context } };
}

describe('cdsPatientUidFromRequest (#5 — CDS Hooks patient addressing bridge)', () => {
  // CDS Hooks carries the patient in the POST body's hook `context`, which the
  // generic patient-access resolver never inspects (it only knows
  // patient_uid-style param/query/body keys, not context.patientId).
  it('extracts a bare uuid from context.patientId', () => {
    expect(cdsPatientUidFromRequest(reqOf({ patientId: UID }))).toBe(UID);
  });

  it('extracts a Patient/<uuid> reference from context.patientId', () => {
    expect(cdsPatientUidFromRequest(reqOf({ patientId: `Patient/${UID}` }))).toBe(UID);
  });

  it('also accepts context.patient as the reference key', () => {
    expect(cdsPatientUidFromRequest(reqOf({ patient: `Patient/${UID}` }))).toBe(UID);
    expect(cdsPatientUidFromRequest(reqOf({ patient: UID }))).toBe(UID);
  });

  it('prefers context.patientId over context.patient when both present', () => {
    expect(cdsPatientUidFromRequest(reqOf({ patientId: UID, patient: OTHER }))).toBe(UID);
  });

  it('lowercases an upper-cased uuid so DB uuid comparison matches', () => {
    expect(cdsPatientUidFromRequest(reqOf({ patientId: UID.toUpperCase() }))).toBe(UID);
  });

  // Negative cases — no single patient → null (guard then passes through; the
  // tenant filter remains the guarantee, exactly as today).
  it('returns null when the body has no context', () => {
    expect(cdsPatientUidFromRequest(reqOf())).toBeNull();
  });

  it('returns null when context has no patient', () => {
    expect(cdsPatientUidFromRequest(reqOf({ encounterId: 'Encounter/abc' }))).toBeNull();
  });

  it('returns null for a malformed patient id', () => {
    expect(cdsPatientUidFromRequest(reqOf({ patientId: 'not-a-uuid' }))).toBeNull();
  });
});

describe('cdsPatientContext middleware', () => {
  it('stashes the resolved uid on req.phiContext.patientUid and calls next', () => {
    const req = reqOf({ patientId: UID });
    const next = jest.fn();
    cdsPatientContext(req, {}, next);
    expect(req.phiContext.patientUid).toBe(UID);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('preserves any pre-existing phiContext keys', () => {
    const req = { ...reqOf({ patient: `Patient/${UID}` }), phiContext: { foo: 'bar' } };
    cdsPatientContext(req, {}, jest.fn());
    expect(req.phiContext).toEqual({ foo: 'bar', patientUid: UID });
  });

  it('does not set patientUid (but still calls next) when no patient is addressable', () => {
    const req = reqOf({ encounterId: 'Encounter/abc' });
    const next = jest.fn();
    cdsPatientContext(req, {}, next);
    expect(req.phiContext?.patientUid).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('never throws on a malformed request shape', () => {
    const next = jest.fn();
    expect(() => cdsPatientContext({ body: null }, {}, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
