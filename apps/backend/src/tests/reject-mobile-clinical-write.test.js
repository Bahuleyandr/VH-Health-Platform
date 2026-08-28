import {
  jest,
} from '@jest/globals';

const recordClinicalAuditEvent = jest.fn().mockResolvedValue(null);

jest.unstable_mockModule(
  '../services/clinical/canonicalClinicalPlatformService.js',
  () => ({ recordClinicalAuditEvent }),
);

const {
  enforceStaffClinicalWriteDevicePosture,
  rejectMobileClinicalWrite,
} = await import('../middleware/rejectMobileClinicalWriteMiddleware.js');

function createResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function createRequest(deviceType) {
  return {
    id: 'test-request',
    method: 'POST',
    originalUrl: '/api/v1/emr/notes',
    path: '/api/v1/emr/notes',
    ip: '127.0.0.1',
    body: { patient_uid: '11111111-1111-4111-8111-111111111111' },
    params: {},
    query: {},
    user: {
      uid: '22222222-2222-4222-8222-222222222222',
      role: 'DOCTOR',
      deviceType,
      tenant_id: '00000000-0000-4000-8000-000000000001',
    },
    get(name) {
      return name === 'user-agent' ? 'jest' : null;
    },
  };
}

describe('rejectMobileClinicalWrite', () => {
  it('denies mobile Staff clinical writes with the desktop-only code', () => {
    const req = createRequest('mobile');
    const res = createResponse();
    const next = jest.fn();

    rejectMobileClinicalWrite(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      code: 'CLINICAL_WRITE_DESKTOP_ONLY',
    });
    expect(recordClinicalAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mobile_clinical_write.denied',
        actionStatus: 'denied',
      }),
    );
  });

  it('denies clinical writes from stale tokens without a device type claim', () => {
    const req = createRequest(undefined);
    delete req.user.deviceType;
    const res = createResponse();
    const next = jest.fn();

    rejectMobileClinicalWrite(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      code: 'DEVICE_TYPE_MISSING',
    });
  });

  it('allows desktop Staff clinical writes to continue to existing guards', () => {
    const req = createRequest('desktop');
    const res = createResponse();
    const next = jest.fn();

    rejectMobileClinicalWrite(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeNull();
  });

  it('exempts non-staff (patient) actors from the staff device gate', () => {
    // A PATIENT booking from the mobile patient app is not a staff clinical
    // write. RBAC governs who may reach each route; this guard only constrains
    // the Staff app's device posture, so it must let patients through
    // regardless of deviceType (mobile or a stale token with none).
    for (const deviceType of ['mobile', undefined]) {
      const req = createRequest(deviceType);
      req.user.role = 'PATIENT';
      if (deviceType === undefined) delete req.user.deviceType;
      const res = createResponse();
      const next = jest.fn();

      rejectMobileClinicalWrite(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBeNull();
    }
  });

  it.each(['ICU_NURSE', 'ICU_INCHARGE', 'PHARMACIST'])(
    'strict verifier posture denies %s on mobile even when the global staff classifier is stale',
    (role) => {
      const req = createRequest('mobile');
      req.user.role = role;
      const res = createResponse();
      const next = jest.fn();

      enforceStaffClinicalWriteDevicePosture(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        code: 'CLINICAL_WRITE_DESKTOP_ONLY',
      });
    },
  );

  it.each(['ICU_NURSE', 'ICU_INCHARGE', 'PHARMACIST'])(
    'strict verifier posture denies %s when deviceType is missing',
    (role) => {
      const req = createRequest(undefined);
      req.user.role = role;
      delete req.user.deviceType;
      const res = createResponse();
      const next = jest.fn();

      enforceStaffClinicalWriteDevicePosture(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({
        success: false,
        code: 'DEVICE_TYPE_MISSING',
      });
    },
  );

  it.each(['ICU_NURSE', 'ICU_INCHARGE', 'PHARMACIST'])(
    'strict verifier posture allows %s on desktop',
    (role) => {
      const req = createRequest('desktop');
      req.user.role = role;
      const res = createResponse();
      const next = jest.fn();

      enforceStaffClinicalWriteDevicePosture(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBeNull();
    },
  );
});
