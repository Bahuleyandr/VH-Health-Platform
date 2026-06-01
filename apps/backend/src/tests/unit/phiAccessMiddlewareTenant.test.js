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

function makeRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}

beforeEach(() => {
  logPhiAccessMock.mockReset();
});

describe('phiAccessLogger tenant context', () => {
  it('passes tenant and device context to generic PHI audit writes', () => {
    const req = {
      method: 'GET',
      params: {},
      query: { patient_uid: PATIENT },
      body: {},
      ip: '127.0.0.1',
      id: 'req-patient-search',
      tenantId: TENANT,
      user: {
        uid: ACTOR,
        role: 'RECEPTIONIST',
        tenant_id: TENANT,
        deviceType: 'desktop',
      },
    };
    const res = makeRes(200);
    const next = jest.fn();

    phiAccessLogger('PATIENT_SEARCH')(req, res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: ACTOR,
      userRole: 'RECEPTIONIST',
      patientId: PATIENT,
      recordType: 'PATIENT_SEARCH',
      action: 'VIEW',
      requestId: 'req-patient-search',
      actorUid: ACTOR,
      subjectUid: ACTOR,
      actingAsDependent: false,
      deviceType: 'desktop',
      tenantId: TENANT,
    }));
  });

  it('uses controller-attached patient context for appointment workflow PHI logs', () => {
    const req = {
      method: 'POST',
      params: { id: '42' },
      query: {},
      body: {},
      phiContext: {
        appointmentId: 42,
        patientId: 123,
      },
      ip: '127.0.0.1',
      id: 'req-appointment-complete',
      tenantId: TENANT,
      user: {
        uid: ACTOR,
        role: 'RECEPTIONIST',
        tenant_id: TENANT,
        deviceType: 'tablet',
      },
    };
    const res = makeRes(200);
    const next = jest.fn();

    phiAccessLogger('APPOINTMENT')(req, res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      patientId: '123',
      recordType: 'APPOINTMENT',
      action: 'CREATE',
      requestId: 'req-appointment-complete',
      deviceType: 'tablet',
    }));
  });

  it('recognizes front-office walk-in patient phone aliases as PHI subject context', () => {
    const req = {
      method: 'POST',
      params: {},
      query: {},
      body: { patient_phone: '+919999999999' },
      ip: '127.0.0.1',
      id: 'req-walk-in',
      tenantId: TENANT,
      user: {
        uid: ACTOR,
        role: 'RECEPTIONIST',
        tenant_id: TENANT,
        deviceType: 'desktop',
      },
    };
    const res = makeRes(200);
    const next = jest.fn();

    phiAccessLogger('APPOINTMENT')(req, res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(logPhiAccessMock).toHaveBeenCalledWith(expect.objectContaining({
      patientId: '+919999999999',
      recordType: 'APPOINTMENT',
      action: 'CREATE',
    }));
  });
});
