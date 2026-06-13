// SEC-6: attempted unauthorized PHI access (403/404 against a resolved
// patient context) must be auditable for HIPAA breach detection. The
// phiAccessLogger used to drop every >=400 response; it now emits an
// ACCESS_DENIED audit row on denials while leaving the success path and
// other 4xx/5xx untouched.

import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

const logPhiAccessMock = jest.fn();

jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: logPhiAccessMock,
}));

const { phiAccessLogger } = await import('../../middleware/phiAccessMiddleware.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';

function makeRes(statusCode) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}

function baseReq(overrides = {}) {
  return {
    method: 'GET',
    params: {},
    query: {},
    body: {},
    ip: '127.0.0.1',
    id: 'req-1',
    tenantId: TENANT,
    user: { uid: ACTOR, role: 'NURSING_STAFF', tenant_id: TENANT },
    ...overrides,
  };
}

beforeEach(() => {
  logPhiAccessMock.mockReset();
});

describe('phiAccessLogger denied-access audit (SEC-6)', () => {
  it('logs ACCESS_DENIED on a 403 against a resolved patient (from access decision)', () => {
    const req = baseReq({
      method: 'GET',
      patientAccessDecision: { patient_uid: PATIENT, patient_id: 123 },
    });
    const res = makeRes(403);
    phiAccessLogger('CLINICAL_NOTE')(req, res, jest.fn());
    res.emit('finish');

    expect(logPhiAccessMock).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: ACTOR,
      patientId: PATIENT,
      recordType: 'CLINICAL_NOTE',
      action: 'ACCESS_DENIED',
      tenantId: TENANT,
    }));
  });

  it('logs ACCESS_DENIED on a 404 against a resolved patient (from request params)', () => {
    const req = baseReq({
      method: 'DELETE',
      params: { patient_uid: PATIENT },
    });
    const res = makeRes(404);
    phiAccessLogger('MEDICAL_RECORD')(req, res, jest.fn());
    res.emit('finish');

    expect(logPhiAccessMock).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      patientId: PATIENT,
      recordType: 'MEDICAL_RECORD',
      action: 'ACCESS_DENIED',
    }));
  });

  it('does NOT log a 404 when no patient context was ever resolved', () => {
    // Bad id / typo'd path that never identified a patient is not a PHI-access
    // attempt and must not pollute the breach-detection trail.
    const req = baseReq({ method: 'GET' }); // no params/query/body patient, no decision
    const res = makeRes(404);
    phiAccessLogger('MEDICAL_RECORD')(req, res, jest.fn());
    res.emit('finish');

    expect(logPhiAccessMock).not.toHaveBeenCalled();
  });

  it('does NOT double-log auth-layer 401s (no authenticated actor)', () => {
    const req = baseReq({ user: undefined, patientAccessDecision: { patient_uid: PATIENT } });
    const res = makeRes(401);
    phiAccessLogger('MEDICAL_RECORD')(req, res, jest.fn());
    res.emit('finish');

    expect(logPhiAccessMock).not.toHaveBeenCalled();
  });

  it('does NOT log non-decision 4xx/5xx (400/429/500) even with a resolved patient', () => {
    for (const code of [400, 429, 500]) {
      logPhiAccessMock.mockReset();
      const req = baseReq({ patientAccessDecision: { patient_uid: PATIENT } });
      const res = makeRes(code);
      phiAccessLogger('MEDICAL_RECORD')(req, res, jest.fn());
      res.emit('finish');
      expect(logPhiAccessMock).not.toHaveBeenCalled();
    }
  });

  it('keeps the success path unchanged — logs VIEW on a 200', () => {
    const req = baseReq({ method: 'GET', query: { patient_uid: PATIENT } });
    const res = makeRes(200);
    phiAccessLogger('MEDICAL_RECORD')(req, res, jest.fn());
    res.emit('finish');

    expect(logPhiAccessMock).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      patientId: PATIENT,
      action: 'VIEW',
    }));
  });
});
