import { jest } from '@jest/globals';

// The records router's per-route guard has to resolve THE SAME patient the
// handler goes on to serve. That is harder here than on the sibling routers
// because :patient_id is not one identifier space:
//
//   recordService#resolvePatientFilterToUuid accepts EITHER a users.id integer
//   OR a patient uuid, discriminating on the uuid shape. So
//   GET /api/v1/records/patient/<uuid> genuinely returns that patient's
//   records — the param name and patientIdValidator's isInt() both suggest
//   otherwise, and both are wrong.
//
//   patientIdValidator cannot save it: nothing in the chain reads
//   validationResult, so the isInt() failure is recorded and never enforced.
//
// A selector bound to the int alone therefore resolves NO patient on the uuid
// form, and with no patient there is no policy evaluation at all — the exact
// defect the guard was added to close, left open on the URL an attacker would
// reach for. These tests pin the discrimination in both directions.
//
// Rather than drive HTTP (which would need the whole access engine and a
// database), capture the selector the router hands to routePatientGuard and
// exercise it directly. That is the unit actually at issue.

let capturedSelector = null;

jest.unstable_mockModule('../../middleware/routePatientAccessGuards.js', () => ({
  routePatientGuard: (_recordType, { patientSelector }) => {
    capturedSelector = patientSelector;
    return (_req, _res, next) => next();
  },
}));

await import('../../routes/record/medicalStaffRoutes.js');

const UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('records :patient_id guard selector matches the handler identifier space', () => {
  test('the router registered a selector at all', () => {
    expect(typeof capturedSelector).toBe('function');
  });

  test('a numeric id selects on users.id', () => {
    expect(capturedSelector({ params: { patient_id: '4821' } })).toEqual({ id: '4821' });
  });

  test('a uuid selects on uid — the branch resolvePatientFilterToUuid serves', () => {
    expect(capturedSelector({ params: { patient_id: UUID } })).toEqual({ uid: UUID });
  });

  test('uuid matching is case-insensitive, as the service regex is', () => {
    const upper = UUID.toUpperCase();
    expect(capturedSelector({ params: { patient_id: upper } })).toEqual({ uid: upper });
  });

  test('the loose shape is used, not the strict v1-5 form', () => {
    // resolvePatientFilterToUuid accepts any 8-4-4-4-12 hex string, so a uuid
    // with a non-v1-5 version nibble still reaches the handler's uuid branch.
    // Classifying it as an int here would put the guard and the handler on
    // different identifiers again.
    const loose = '7c9e6679-7425-90de-044b-e07fc1f90ae7';
    expect(capturedSelector({ params: { patient_id: loose } })).toEqual({ uid: loose });
  });

  test('junk never becomes a uid — it falls to the int branch and resolves nothing', () => {
    for (const raw of ['not-a-uuid', '', '12x', '../../etc/passwd']) {
      expect(capturedSelector({ params: { patient_id: raw } })).toEqual({ id: raw });
    }
  });

  test('a missing param does not throw — the selector contract forbids it', () => {
    expect(() => capturedSelector({ params: {} })).not.toThrow();
    expect(() => capturedSelector({})).not.toThrow();
    expect(capturedSelector({ params: {} })).toEqual({ id: undefined });
  });
});
