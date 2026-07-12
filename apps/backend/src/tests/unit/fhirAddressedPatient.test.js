// Regression guard for Sol Ultra audit #2: SMART patient-context confinement
// (enforceSmartScopes) compares addressedPatientUid() to the token's patient,
// but for a write it returned the ?patient= QUERY selector while the FHIR write
// handlers write the BODY's subject/patient reference. So POST /Observation?
// patient=A with a token scoped to A and body subject=Patient/B passed the
// confinement check (addressed==A==token) yet wrote to patient B.
//
// addressedPatientUid() must, for writes, treat the body as the canonical target
// and reject a conflicting query selector.
import { addressedPatientUid } from '../../routes/fhir/fhirRoutes.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function req({ method, query = {}, body = {}, path = '/Observation' }) {
  return { method, query, body, path };
}

describe('addressedPatientUid — SMART cross-patient write (Sol Ultra #2)', () => {
  it('rejects a write whose ?patient query conflicts with the body subject', () => {
    let err;
    try {
      addressedPatientUid(req({ method: 'POST', query: { patient: A }, body: { subject: { reference: `Patient/${B}` } } }), 'Observation');
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).toBe('FHIR_SMART_PATIENT_SELECTOR_CONFLICT');
  });

  it('returns the BODY patient (write target) for a write, not the query', () => {
    // No conflicting query — the body is authoritative for the mutation.
    expect(addressedPatientUid(req({ method: 'POST', body: { subject: { reference: `Patient/${B}` } } }), 'Observation')).toBe(B);
    // Matching query + body is fine.
    expect(addressedPatientUid(req({ method: 'PUT', query: { patient: B }, body: { patient: { reference: `Patient/${B}` } } }), 'Observation')).toBe(B);
  });

  it('leaves GET search addressing unchanged (query patient wins)', () => {
    expect(addressedPatientUid(req({ method: 'GET', query: { patient: A } }), 'Observation')).toBe(A);
    expect(addressedPatientUid(req({ method: 'GET', query: {} }), 'Observation')).toBeNull();
  });
});
