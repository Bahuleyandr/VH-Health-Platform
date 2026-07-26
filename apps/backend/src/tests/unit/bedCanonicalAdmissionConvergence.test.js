import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const assignBedToAdmissionMock = jest.fn();
const transferAdmissionMock = jest.fn();
const updateBedMock = jest.fn();

jest.unstable_mockModule('../../services/emr/admissionService.js', () => ({
  default: {
    assignBedToAdmission: assignBedToAdmissionMock,
    transferPatient: transferAdmissionMock,
    markForDischarge: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/bed/bedService.js', () => ({
  default: {
    listWards: jest.fn(async () => ({ wards: [], scope: 'tenant' })),
    createWard: jest.fn(),
    updateWard: jest.fn(),
    deleteWard: jest.fn(),
    listBeds: jest.fn(async () => ({ beds: [], scope: 'tenant' })),
    getBedsByWard: jest.fn(async () => ({ beds: [], scope: 'tenant' })),
    getBedSummary: jest.fn(async () => ({ summary: {}, scope: 'tenant' })),
    createBed: jest.fn(),
    updateBed: updateBedMock,
    deleteBed: jest.fn(),
    updateBedNotes: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/bed/bedManagementService.js', () => ({
  default: {
    getBedOccupancy: jest.fn(),
    getAvailableBeds: jest.fn(),
    getActiveAdmissionForBed: jest.fn(),
    markBedReady: jest.fn(),
  },
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
  patientAccessGuardForResource: (_recordType, options = {}) => (req, res, next) => {
    if (
      options.resourceType === 'admission'
      && typeof options.idSelector === 'function'
      && !options.idSelector(req)
    ) {
      return res.status(403).json({
        success: false,
        code: 'PATIENT_RESOURCE_UNRESOLVED',
      });
    }
    return next();
  },
}));

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES: {
    PATIENT_BED_VIEW: 'PATIENT_BED_VIEW',
    PATIENT_BED_WRITE: 'PATIENT_BED_WRITE',
  },
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitBedEvent: jest.fn(),
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => {}),
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  prismaReadOnly: { $queryRawUnsafe: jest.fn(async () => []) },
  circuitBreakerStatus: jest.fn(() => ({})),
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
}));

const { bedRouter } = await import('../../routes/bed/bedRoutes.js');
const managementRouter = (await import('../../routes/bed/bedManagementRoutes.js')).default;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '11111111-1111-4111-8111-111111111111';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'bed-convergence-test';
  req.tenantId = TENANT_ID;
  req.user = {
    uid: ACTOR_UID,
    role: 'SUPER_ADMIN',
    tenant_id: TENANT_ID,
  };
  next();
});
app.use('/api/v1/beds', bedRouter);
app.use('/api/v1/beds', managementRouter);
app.use((err, _req, res, _next) => {
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message,
    ...(err.code ? { code: err.code } : {}),
  });
});

beforeEach(() => {
  assignBedToAdmissionMock.mockReset();
  transferAdmissionMock.mockReset();
  updateBedMock.mockReset();
});

describe('legacy bed routes converge on canonical admissions', () => {
  it('rejects the legacy patient-only quick-admit payload without creating an admission', async () => {
    const response = await request(app)
      .post('/api/v1/beds/12/admit')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222' });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('ADMISSION_ID_REQUIRED');
    expect(assignBedToAdmissionMock).not.toHaveBeenCalled();
  });

  it('treats quick-admit as late assignment of an existing canonical admission', async () => {
    assignBedToAdmissionMock.mockResolvedValueOnce({
      id: 73,
      bed_id: 12,
      status: 'admitted',
    });

    const response = await request(app)
      .post('/api/v1/beds/12/admit')
      .send({ admission_id: 73 });

    expect(response.statusCode).toBe(200);
    expect(assignBedToAdmissionMock).toHaveBeenCalledWith(
      73,
      12,
      ACTOR_UID,
      { tenantId: TENANT_ID, actorRole: 'SUPER_ADMIN' },
    );
    expect(response.body.data.admission).toEqual(expect.objectContaining({
      id: 73,
      bed_id: 12,
    }));
  });

  it('rejects generic occupied writes before the bed service is called', async () => {
    const response = await request(app)
      .put('/api/v1/beds/12')
      .send({ status: 'occupied', patient_id: 44, patient_name: 'Bypass' });

    expect(response.statusCode).toBe(400);
    expect(updateBedMock).not.toHaveBeenCalled();
  });

  it('passes tenant identity through for allowed bed-master updates', async () => {
    updateBedMock.mockResolvedValueOnce({
      id: 12,
      status: 'maintenance',
    });

    const response = await request(app)
      .put('/api/v1/beds/12')
      .send({ status: 'maintenance' });

    expect(response.statusCode).toBe(200);
    expect(updateBedMock).toHaveBeenCalledWith(
      '12',
      { status: 'maintenance' },
      { tenantId: TENANT_ID },
    );
  });

  it('rejects the legacy patient-only transfer payload', async () => {
    const response = await request(app)
      .post('/api/v1/beds/transfer')
      .send({
        patient_uid: '22222222-2222-4222-8222-222222222222',
        to_bed_id: 13,
      });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('ADMISSION_ID_REQUIRED');
    expect(transferAdmissionMock).not.toHaveBeenCalled();
  });

  it('rejects a transfer without a positive target bed before PHI resolution', async () => {
    const response = await request(app)
      .post('/api/v1/beds/transfer')
      .send({ admission_id: 73, to_bed_id: 0 });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('TO_BED_ID_REQUIRED');
    expect(transferAdmissionMock).not.toHaveBeenCalled();
  });

  it('delegates the legacy transfer URL to the canonical admission transfer', async () => {
    transferAdmissionMock.mockResolvedValueOnce({
      id: 73,
      bed_id: 13,
      status: 'transferred',
    });

    const response = await request(app)
      .post('/api/v1/beds/transfer')
      .send({
        admission_id: 73,
        to_bed_id: 13,
        to_ward_id: 9,
        reason: 'Clinical transfer',
        acknowledge_class_change: true,
      });

    expect(response.statusCode).toBe(200);
    expect(transferAdmissionMock).toHaveBeenCalledWith(
      73,
      null,
      13,
      'Clinical transfer',
      ACTOR_UID,
      {
        tenantId: TENANT_ID,
        actorRole: 'SUPER_ADMIN',
        acknowledgeClassChange: true,
      },
    );
  });
});
