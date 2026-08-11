import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000000002';
const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';
const ACTOR_UID = '33333333-3333-4333-8333-333333333333';

const queryRawUnsafeMock = jest.fn();
const ingestFhirVitalObservationMock = jest.fn();
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
  resolveTenantOrThrow: (req) => req?.tenantId || TENANT_A,
  requireTenantId: (tenantId) => tenantId || TENANT_A,
}));

jest.unstable_mockModule('../../services/fhir/fhirVitalObservationIngestService.js', () => ({
  ingestFhirVitalObservation: ingestFhirVitalObservationMock,
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
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
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
    ingestFhirVitalObservationMock.mockResolvedValue({
      vitalsChartId: 77,
      patientUid: PATIENT_A,
      recordedAt: '2026-06-11T10:00:00.000Z',
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

    // Audit 2026-06-18 §3 finding #1 (enumeration oracle): a present-but-
    // unresolvable patient ref — including a cross-tenant id — now returns 403
    // (not 404). A 404-for-unresolvable / 403-for-no-relationship split is itself
    // a patient-existence oracle; the fix collapses it to "403-both". The read is
    // still blocked before any demographic row is returned.
    expect(res.status).toBe(403);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue[0].code).toBe('forbidden');
  });

  it('blocks cross-tenant Observation creates before the vitals sink', async () => {
    const res = await request(buildApp(TENANT_A))
      .post('/fhir/Observation')
      .send(observationFor(PATIENT_B));

    expect(res.status).toBe(404);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(ingestFhirVitalObservationMock).not.toHaveBeenCalled();

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
    expect(ingestFhirVitalObservationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'Observation',
        subject: { reference: `Patient/${PATIENT_A}` },
      }),
      ACTOR_UID,
      { tenantId: TENANT_A },
    );
  });

  it('returns the same FHIR identity after a lost response is retried', async () => {
    ingestFhirVitalObservationMock
      .mockResolvedValueOnce({
        status: 'imported',
        deduplicated: false,
        vitalsChartId: 91,
        patientUid: PATIENT_A,
        recordedAt: '2026-06-11T10:00:00.000Z',
      })
      .mockResolvedValueOnce({
        status: 'deduplicated',
        deduplicated: true,
        vitalsChartId: 91,
        patientUid: PATIENT_A,
        recordedAt: '2026-06-11T10:00:00.000Z',
        clinicalEffectsReconciled: true,
      });

    const first = await request(buildApp(TENANT_A))
      .post('/fhir/Observation')
      .send(observationFor(PATIENT_A));
    const retry = await request(buildApp(TENANT_A))
      .post('/fhir/Observation')
      .send(observationFor(PATIENT_A));

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(first.headers.location).toBe('Observation/vitals-91');
    expect(retry.headers.location).toBe(first.headers.location);
    expect(retry.body.id).toBe(first.body.id);
  });

  it('preserves retryable service status without exposing internal diagnostics', async () => {
    const internalMarker = 'postgresql://private-host/internal-query';
    const serviceError = Object.assign(
      new Error('FHIR Observation ingestion is temporarily unavailable'),
      {
        statusCode: 503,
        code: 'FHIR_OBSERVATION_RECOVERY_UNAVAILABLE',
        cause: new Error(internalMarker),
      },
    );
    ingestFhirVitalObservationMock.mockRejectedValueOnce(serviceError);

    const res = await request(buildApp(TENANT_A))
      .post('/fhir/Observation')
      .send(observationFor(PATIENT_A));

    expect(res.status).toBe(503);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue[0].diagnostics).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain(internalMarker);
  });

  it.each(['preliminary', 'cancelled', 'entered-in-error'])(
    'rejects %s Observation status before the vitals sink',
    async (status) => {
      const body = observationFor(PATIENT_A);
      body.status = status;
      const res = await request(buildApp(TENANT_A)).post('/fhir/Observation').send(body);
      expect(res.status).toBe(400);
      expect(ingestFhirVitalObservationMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing effectiveDateTime', (body) => { delete body.effectiveDateTime; }],
    ['missing vital category', (body) => { delete body.category; }],
    ['systemless vital category', (body) => { delete body.category[0].coding[0].system; }],
    ['systemless clinical code', (body) => { delete body.code.coding[0].system; }],
    ['mixed supported and unsupported components', (body) => {
      body.code = { coding: [{ system: 'http://loinc.org', code: '85354-9' }] };
      delete body.valueQuantity;
      body.component = [{
        code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] },
        valueQuantity: { value: 120, code: 'mm[Hg]' },
      }, {
        code: { coding: [{ system: 'http://loinc.org', code: '99999-9' }] },
        valueQuantity: { value: 42, code: '1' },
      }];
    }],
  ])('rejects %s before the vitals sink', async (_label, mutate) => {
    const body = observationFor(PATIENT_A);
    mutate(body);
    const res = await request(buildApp(TENANT_A)).post('/fhir/Observation').send(body);
    expect(res.status).toBe(400);
    expect(ingestFhirVitalObservationMock).not.toHaveBeenCalled();
  });

  it('derives supplemental oxygen from an explicit FHIR oxygen-flow Observation', async () => {
    const body = observationFor(PATIENT_A);
    body.code.coding[0].code = '3151-8';
    body.valueQuantity = {
      value: 2,
      system: 'http://unitsofmeasure.org',
      code: 'L/min',
    };
    const res = await request(buildApp(TENANT_A)).post('/fhir/Observation').send(body);
    expect(res.status).toBe(201);
    expect(ingestFhirVitalObservationMock).toHaveBeenCalledWith(
      expect.objectContaining({ valueQuantity: expect.objectContaining({ value: 2 }) }),
      ACTOR_UID,
      { tenantId: TENANT_A },
    );
  });
});
