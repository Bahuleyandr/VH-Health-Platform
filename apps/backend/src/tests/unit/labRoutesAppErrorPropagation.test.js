import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of labRoutes'
// wrap() catch. The old catch built `err.details ?? (err.code ? { code:
// err.code } : null)` (code buried under details when no details were set)
// and relayed `err.message || 'Lab error'` on the 500 tail. relayAppError
// lifts err.code to the envelope root, nests err.details, and hardens the
// 500 tail to the generic-only 'Lab error'.

const ingestOruMessageMock = jest.fn();
const ingestInterfaceMessageMock = jest.fn();
const acknowledgeAlertMock = jest.fn();
const phiPatientUids = [];

jest.unstable_mockModule('../../services/lab/labResultsService.js', () => ({
  ingestOruMessage: ingestOruMessageMock,
  acknowledgeAlert: acknowledgeAlertMock,
}));

jest.unstable_mockModule('../../services/lab/labClosedLoopService.js', () => ({
  ingestInterfaceMessage: ingestInterfaceMessageMock,
}));

jest.unstable_mockModule('../../services/integrations/externalLabRecoveryService.js', () => ({
  ingestSequencedAstmRecovery: jest.fn(),
  ingestSequencedOruRecovery: jest.fn(),
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (req, res, next) => {
    res.on('finish', () => phiPatientUids.push(req.phiContext?.patientUid ?? null));
    next();
  },
}));

jest.unstable_mockModule('../../services/investigation/investigationService.js', () => ({}));

jest.unstable_mockModule('../../services/investigation/orderService.js', () => ({}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: labRoutes } = await import('../../routes/lab/labRoutes.js');
const { default: labIngestRoutes } = await import('../../routes/lab/labIngestRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.get('x-test-role') || 'ADMIN';
  req.id = 'test-request-id';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    name: 'Authenticated Pathologist',
    role,
    roles: role === 'ADMIN' ? ['ADMIN', 'PATHOLOGIST'] : [role],
  };
  req.apiClient = req.get('x-test-api-client') || 'test-api-client';
  req.apiClientId = 77;
  req.apiClientTenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/lab', labIngestRoutes);
app.use('/api/v1/lab', labRoutes);

beforeEach(() => {
  ingestOruMessageMock.mockReset();
  ingestInterfaceMessageMock.mockReset();
  acknowledgeAlertMock.mockReset();
  phiPatientUids.length = 0;
});

describe('lab wrap() relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    ingestOruMessageMock.mockRejectedValueOnce(AppError.conflict(
      'Duplicate ORU message for accession',
      'LAB_ORU_DUPLICATE',
      { accession_number: 'ACC-1' },
    ));

    const response = await request(app)
      .post('/api/v1/lab/oru/ingest')
      .send({ message: 'MSH|^~\\&|ANALYZER', source: 'test' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('LAB_ORU_DUPLICATE');
    expect(response.body.details).toEqual({ accession_number: 'ACC-1' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('AppError without details produces root code and NO details key (R7 builder shape)', async () => {
    // The old builder produced `details: { code: ... }` for a details-less
    // AppError; the relay lifts the code to the root and must not emit a
    // spurious details object.
    ingestOruMessageMock.mockRejectedValueOnce(new AppError(
      'ORU message failed validation',
      422,
      'LAB_ORU_INVALID',
    ));

    const response = await request(app)
      .post('/api/v1/lab/oru/ingest')
      .send({ message: 'MSH|^~\\&|ANALYZER', source: 'test' });

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe('LAB_ORU_INVALID');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-AppError returns generic-only 500 (err.message no longer relayed)', async () => {
    // Old tail: `error(res, err.message || 'Lab error', 500)` leaked the raw
    // message; the port hardens this to the generic label only.
    ingestOruMessageMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app)
      .post('/api/v1/lab/oru/ingest')
      .send({ message: 'MSH|^~\\&|ANALYZER', source: 'test' });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Lab error');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });

  test.each([
    'LAB_STAFF',
    'LAB_INCHARGE',
    'PATHOLOGIST',
    'ADMIN',
    'SUPER_ADMIN',
    'WEBHOOK_CLIENT',
    'DEVICE_GATEWAY',
  ])('ORU ingestion admits the narrow analyzer-ingest role %s', async (role) => {
    ingestOruMessageMock.mockResolvedValueOnce({ results: [], alerts: [], replayed: false });

    const response = await request(app)
      .post('/api/v1/lab/oru/ingest')
      .set('x-test-role', role)
      .set('x-test-api-client', 'analyzer-channel')
      .send({ message: 'trusted raw message', source: 'forged-body-source' });

    expect(response.statusCode).toBe(200);
    expect(ingestOruMessageMock).toHaveBeenCalledWith('trusted raw message', {
      tenantId: '00000000-0000-4000-8000-000000000001',
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorRole: role,
      actorRoles: role === 'ADMIN' ? ['ADMIN', 'PATHOLOGIST'] : [role],
      apiClient: 'analyzer-channel',
      apiClientId: 77,
      apiClientTenantId: '00000000-0000-4000-8000-000000000001',
    });
    expect(ingestOruMessageMock.mock.calls[0][1]).not.toHaveProperty('source');
  });

  test('ORU ingestion binds the resolved single patient to the transport PHI audit', async () => {
    ingestOruMessageMock.mockResolvedValueOnce({
      results: [{ patient_uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
      alerts: [],
      replayed: false,
    });

    const response = await request(app)
      .post('/api/v1/lab/oru/ingest')
      .set('x-test-role', 'LAB_STAFF')
      .send({ message: 'trusted raw message' });

    expect(response.statusCode).toBe(200);
    expect(phiPatientUids).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  });

  test.each(['DOCTOR', 'NURSING_STAFF', 'GENERAL_STAFF'])(
    'ORU ingestion denies unrelated clinical/staff role %s before the service',
    async (role) => {
      const response = await request(app)
        .post('/api/v1/lab/oru/ingest')
        .set('x-test-role', role)
        .send({ message: 'raw message' });

      expect(response.statusCode).toBe(403);
      expect(ingestOruMessageMock).not.toHaveBeenCalled();
    },
  );

  test('ASTM interface ingestion forwards the full authenticated actor/channel context', async () => {
    ingestInterfaceMessageMock.mockResolvedValueOnce({ status: 'ingested' });

    const response = await request(app)
      .post('/api/v1/lab/interface/ingest')
      .set('x-test-role', 'DEVICE_GATEWAY')
      .set('x-test-api-client', 'gateway-a')
      .send({ protocol: 'astm_e1394', message: 'raw ASTM', analyzer_code: 'ANALYZER-A' });

    expect(response.statusCode).toBe(200);
    expect(ingestInterfaceMessageMock).toHaveBeenCalledWith({
      protocol: 'astm_e1394',
      rawMessage: 'raw ASTM',
      analyzerCode: 'ANALYZER-A',
      tenantId: '00000000-0000-4000-8000-000000000001',
    }, {
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorRole: 'DEVICE_GATEWAY',
      actorRoles: ['DEVICE_GATEWAY'],
      apiClient: 'gateway-a',
      apiClientId: 77,
      apiClientTenantId: '00000000-0000-4000-8000-000000000001',
    });
  });

  test('generic interface rejects HL7 before calling the split receipt service path', async () => {
    const response = await request(app)
      .post('/api/v1/lab/interface/ingest')
      .set('x-test-role', 'DEVICE_GATEWAY')
      .set('x-test-api-client', 'gateway-a')
      .send({ protocol: 'hl7v2', message: 'raw HL7', analyzer_code: 'ANALYZER-A' });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'LAB_INTERFACE_HL7_ROUTE_REQUIRED' });
    expect(ingestInterfaceMessageMock).not.toHaveBeenCalled();
  });

  test('machine roles cannot pass through to ordinary lab read routes', async () => {
    const response = await request(app)
      .get('/api/v1/lab/results/booking/1')
      .set('x-test-role', 'DEVICE_GATEWAY');

    expect(response.statusCode).toBe(403);
  });

  test('critical-alert acknowledgement forwards authenticated identity, roles, and break-glass authority', async () => {
    acknowledgeAlertMock.mockResolvedValueOnce({ id: 55, acknowledged_at: '2026-07-19T04:00:00.000Z' });

    const response = await request(app)
      .post('/api/v1/lab/alerts/critical/55/ack')
      .send({
        break_glass_id: 44,
        acknowledged_by_name: 'Ignored caller text',
        read_back_method: 'phone',
      });

    expect(response.statusCode).toBe(200);
    expect(acknowledgeAlertMock).toHaveBeenCalledWith('55', {
      tenantId: '00000000-0000-4000-8000-000000000001',
      acknowledged_by: '11111111-1111-4111-8111-111111111111',
      acknowledged_by_name: 'Authenticated Pathologist',
      actorRoles: ['ADMIN', 'PATHOLOGIST'],
      actorRole: 'ADMIN',
      actorRawRole: null,
      breakGlassId: 44,
      read_back_method: 'phone',
      notes: undefined,
    });
  });

  test('critical-alert acknowledgement admits SUPER_ADMIN through its narrow task-administrator gate', async () => {
    acknowledgeAlertMock.mockResolvedValueOnce({ id: 55, acknowledged_at: '2026-07-19T04:00:00.000Z' });

    const response = await request(app)
      .post('/api/v1/lab/alerts/critical/55/ack')
      .set('x-test-role', 'SUPER_ADMIN')
      .send({ read_back_method: 'phone' });

    expect(response.statusCode).toBe(200);
    expect(acknowledgeAlertMock).toHaveBeenCalledWith('55', {
      tenantId: '00000000-0000-4000-8000-000000000001',
      acknowledged_by: '11111111-1111-4111-8111-111111111111',
      acknowledged_by_name: 'Authenticated Pathologist',
      actorRoles: ['SUPER_ADMIN'],
      actorRole: 'SUPER_ADMIN',
      actorRawRole: null,
      breakGlassId: null,
      read_back_method: 'phone',
      notes: undefined,
    });
  });
});
