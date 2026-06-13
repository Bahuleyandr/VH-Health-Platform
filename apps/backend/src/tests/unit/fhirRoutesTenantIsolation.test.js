import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000000002';
const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';
const ACTOR_UID = '33333333-3333-4333-8333-333333333333';

const queryRawUnsafeMock = jest.fn();
const recordVitalsMock = jest.fn();
const createProblemMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: TENANT_A,
}));

jest.unstable_mockModule('../../services/emr/vitalsChartService.js', () => ({
  recordVitals: recordVitalsMock,
}));

jest.unstable_mockModule('../../services/clinical/problemListService.js', () => ({
  createProblem: createProblemMock,
}));

jest.unstable_mockModule('../../services/terminology/clinicalCodeBindingService.js', () => ({
  attachResourceCodings: jest.fn(async (rows) => rows),
  normalizeClinicalCodings: jest.fn((codings) => codings),
  systemUriForKey: jest.fn((key) => key || 'urn:test-system'),
}));

const { default: fhirRouter } = await import('../../routes/fhir/fhirRoutes.js');

function buildApp(tenantId = TENANT_A) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = tenantId;
    req.user = { uid: ACTOR_UID, role: 'ADMIN', tenantId };
    next();
  });
  app.use('/fhir', fhirRouter);
  return app;
}

function observationFor(patientUid) {
  return {
    resourceType: 'Observation',
    status: 'final',
    code: {
      coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }],
    },
    subject: { reference: `Patient/${patientUid}` },
    effectiveDateTime: '2026-06-11T10:00:00.000Z',
    valueQuantity: { value: 72, unit: 'beats/min' },
  };
}

function installFhirQueryMock() {
  queryRawUnsafeMock.mockImplementation(async (sql, ...params) => {
    const compactSql = String(sql).replace(/\s+/g, ' ');

    if (compactSql.includes('FROM users') && compactSql.includes('WHERE uid = $1::uuid')) {
      const [patientUid, tenantId] = params;
      if (patientUid === PATIENT_A && tenantId === TENANT_A) {
        return [{
          uid: PATIENT_A,
          tenant_id: TENANT_A,
          phone: '9000000001',
          name: 'Tenant A Patient',
          gender: 'female',
          is_active: true,
        }];
      }
      if (patientUid === PATIENT_B && tenantId === TENANT_B) {
        return [{
          uid: PATIENT_B,
          tenant_id: TENANT_B,
          phone: '9000000002',
          name: 'Tenant B Patient',
          gender: 'male',
          is_active: true,
        }];
      }
      return [];
    }

    if (compactSql.includes('FROM vitals_chart v')) {
      return params[0] === TENANT_A
        ? [{
            id: 'vital-1-heart_rate',
            patient_uid: PATIENT_A,
            type: 'heart_rate',
            value: '72',
            unit: 'beats/min',
            recorded_date: '2026-06-11T10:00:00.000Z',
            recorded_by: ACTOR_UID,
          }]
        : [];
    }

    return [];
  });
}

describe('FHIR R4 tenant isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installFhirQueryMock();
    recordVitalsMock.mockResolvedValue({
      vitals: {
        id: 77,
        patient_uid: PATIENT_A,
        recorded_at: '2026-06-11T10:00:00.000Z',
      },
    });
  });

  it('tenant-bounds Observation search even when patient is omitted', async () => {
    const res = await request(buildApp(TENANT_A)).get('/fhir/Observation');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entry[0].resource.subject.reference).toBe(`Patient/${PATIENT_A}`);

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('v.tenant_id = $1::uuid');
    expect(params[0]).toBe(TENANT_A);
  });

  it('does not leak a Patient read for a cross-tenant patient id', async () => {
    const res = await request(buildApp(TENANT_A)).get(`/fhir/Patient/${PATIENT_B}`);

    expect(res.status).toBe(404);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue[0].code).toBe('not-found');

    const [sql, patientUid, tenantId] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('tenant_id = $2::uuid');
    expect(patientUid).toBe(PATIENT_B);
    expect(tenantId).toBe(TENANT_A);
  });

  it('blocks cross-tenant Observation creates before the vitals sink', async () => {
    const res = await request(buildApp(TENANT_A))
      .post('/fhir/Observation')
      .send(observationFor(PATIENT_B));

    expect(res.status).toBe(404);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(recordVitalsMock).not.toHaveBeenCalled();

    const [sql, patientUid, tenantId] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('tenant_id = $2::uuid');
    expect(patientUid).toBe(PATIENT_B);
    expect(tenantId).toBe(TENANT_A);
  });

  it('passes tenant id into tenant-local Observation creates', async () => {
    const res = await request(buildApp(TENANT_A))
      .post('/fhir/Observation')
      .send(observationFor(PATIENT_A));

    expect(res.status).toBe(201);
    expect(recordVitalsMock).toHaveBeenCalledWith(expect.objectContaining({
      patient_uid: PATIENT_A,
      tenant_id: TENANT_A,
      heart_rate: 72,
      recorded_by: ACTOR_UID,
      source: 'fhir',
    }));
  });
});
