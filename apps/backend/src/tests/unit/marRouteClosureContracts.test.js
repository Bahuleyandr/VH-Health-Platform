import { readFileSync } from 'node:fs';

import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

const PATIENT = '10000000-0000-4000-8000-000000000001';
const ACTOR = '10000000-0000-4000-8000-000000000002';
const TENANT = '10000000-0000-4000-8000-000000000003';

const recordMissedMock = jest.fn();
const holdMedicationMock = jest.fn();
const reconcileMarSupplyOverrideMock = jest.fn();
const replayReceipts = new Map();

function passThroughWithMetadata(metadata) {
  const middleware = (_req, _res, next) => next();
  middleware.__patientGuard = metadata;
  return middleware;
}

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: (recordType, options = {}) =>
    passThroughWithMetadata({
      recordType,
      ...options
    }),
  patientAccessGuardForResource: (recordType, options = {}) =>
    passThroughWithMetadata({
      recordType,
      ...options
    })
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey:
    ({ required = false, scope = 'test' } = {}) =>
    (req, res, next) => {
      const requestKey = req.get('idempotency-key');
      if (required && !requestKey) {
        return res.status(400).json({
          success: false,
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header is required'
        });
      }
      const receiptKey = `${scope}:${requestKey}:${JSON.stringify(req.body || {})}`;
      if (replayReceipts.has(receiptKey)) {
        const replay = replayReceipts.get(receiptKey);
        return res.status(replay.status).json(replay.body);
      }
      req.idempotencyClaim = {
        id: `claim:${scope}:${requestKey}`,
        requestKey,
        requestBodyHash: `hash:${JSON.stringify(req.body || {})}`
      };
      const originalJson = res.json.bind(res);
      res.json = body => {
        if (requestKey && res.statusCode < 500) {
          replayReceipts.set(receiptKey, { status: res.statusCode, body });
        }
        return originalJson(body);
      };
      return next();
    }
}));

jest.unstable_mockModule('../../middleware/rejectMobileClinicalWriteMiddleware.js', () => ({
  enforceStaffClinicalWriteDevicePosture: (req, res, next) =>
    req.user?.deviceType === 'mobile'
      ? res.status(403).json({
          success: false,
          code: 'CLINICAL_WRITE_DESKTOP_REQUIRED',
          message: 'Use a managed desktop or tablet'
        })
      : next()
}));

jest.unstable_mockModule('../../services/clinical/marService.js', () => ({
  recordMissed: recordMissedMock,
  holdMedication: holdMedicationMock
}));
jest.unstable_mockModule('../../services/clinical/marSupplyService.js', () => ({
  getMarSupplyState: jest.fn(),
  reconcileMarSupplyOverride: reconcileMarSupplyOverrideMock
}));
for (const modulePath of [
  '../../services/clinical/handoverService.js',
  '../../services/clinical/marFiveRightsService.js',
  '../../services/clinical/drugChartService.js',
  '../../services/clinical/news2Service.js',
  '../../services/ai/voiceSoapService.js'
]) {
  jest.unstable_mockModule(modulePath, () => ({}));
}
jest.unstable_mockModule('../../services/ai/sttService.js', () => ({
  describeSttConfig: jest.fn()
}));
jest.unstable_mockModule('../../services/ai/polypharmacyAiService.js', () => ({
  reviewPolypharmacy: jest.fn()
}));
jest.unstable_mockModule('../../services/ai/deteriorationEarlyWarningService.js', () => ({
  scoreDeterioration: jest.fn()
}));
jest.unstable_mockModule('../../services/ai/ambientDocumentationService.js', () => ({
  createAmbientEncounter: jest.fn(),
  listAmbientEncounters: jest.fn()
}));

const { default: clinicalRouter } = await import('../../routes/clinical/clinicalRoutes.js');

function mountedClinicalApp({ deviceType = 'desktop', role = 'NURSING_STAFF' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'mar-route-contract-request';
    req.user = { uid: ACTOR, role, deviceType };
    req.tenantId = TENANT;
    next();
  });
  app.use('/clinical', clinicalRouter);
  app.use((err, _req, res, _next) =>
    res.status(err.statusCode || 500).json({
      success: false,
      code: err.code,
      message: err.message
    })
  );
  return app;
}

describe('mounted MAR route closure contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    replayReceipts.clear();
    recordMissedMock.mockResolvedValue({ id: 41, status: 'missed' });
    holdMedicationMock.mockResolvedValue({ id: 41, status: 'held' });
    reconcileMarSupplyOverrideMock.mockResolvedValue({ reconciled_quantity: 1 });
  });

  test('manual scheduling is readiness-only and directs non-empty intake to CPOE', async () => {
    const ready = await request(mountedClinicalApp())
      .post('/clinical/mar/schedule')
      .send({ patient_uid: PATIENT, medications: [] });
    expect(ready.statusCode).toBe(201);
    expect(ready.body.data).toEqual([]);

    const rejected = await request(mountedClinicalApp())
      .post('/clinical/mar/schedule')
      .send({ patient_uid: PATIENT, medications: [{}] });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.body.details).toMatchObject({
      code: 'MAR_SCHEDULE_REQUIRES_CLINICAL_ORDER_WORKFLOW',
      order_endpoint: '/api/v1/emr/orders'
    });
    expect(recordMissedMock).not.toHaveBeenCalled();
  });

  test.each([
    ['miss', recordMissedMock, 'missed'],
    ['hold', holdMedicationMock, 'held']
  ])(
    '%s requires a key, binds its receipt claim, and replays without another mutation',
    async (path, mutation, expectedStatus) => {
      const app = mountedClinicalApp();
      const missing = await request(app)
        .post(`/clinical/mar/41/${path}`)
        .send({ reason: 'Clinically documented reason' });
      expect(missing.statusCode).toBe(400);
      expect(mutation).not.toHaveBeenCalled();

      const first = await request(app)
        .post(`/clinical/mar/41/${path}`)
        .set('Idempotency-Key', `mar-${path}-contract`)
        .send({ reason: 'Clinically documented reason' });
      expect(first.statusCode).toBe(200);
      expect(first.body.data).toMatchObject({ id: 41, status: expectedStatus });
      expect(mutation).toHaveBeenCalledWith(
        41,
        'Clinically documented reason',
        ACTOR,
        expect.objectContaining({
          commandKey: `mar-${path}-contract`,
          httpIdempotencyClaimId: `claim:mar_${path}:mar-${path}-contract`,
          tenantId: TENANT
        })
      );

      const replay = await request(app)
        .post(`/clinical/mar/41/${path}`)
        .set('Idempotency-Key', `mar-${path}-contract`)
        .send({ reason: 'Clinically documented reason' });
      expect(replay.statusCode).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(mutation).toHaveBeenCalledTimes(1);
    }
  );

  test('mobile supply reconciliation is denied before request validation or mutation', async () => {
    const response = await request(
      mountedClinicalApp({
        deviceType: 'mobile',
        role: 'PHARMACY_INCHARGE'
      })
    )
      .post('/clinical/mar/41/supply-overrides/7/reconcile')
      .send({ allocations: 'deliberately-invalid-after-device-gate' });
    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe('CLINICAL_WRITE_DESKTOP_REQUIRED');
    expect(reconcileMarSupplyOverrideMock).not.toHaveBeenCalled();
  });
});

describe('generated CPOE and terminal receipt contract', () => {
  test('OpenAPI publishes atomic order-set receipts and exact medication authority', () => {
    const specText = readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8');
    const spec = JSON.parse(specText);
    for (const action of ['complete', 'cancel', 'discontinue']) {
      expect(spec.paths[`/api/v1/emr/orders/{id}/${action}`].put.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Idempotency-Key',
            in: 'header',
            required: true
          })
        ])
      );
    }
    for (const path of [
      '/api/v1/emr/orders',
      '/api/v1/emr/orders/bulk',
      '/api/v1/emr/orders/apply-set',
    ]) {
      const operation = spec.paths[path].post;
      expect(operation.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true })
        ])
      );
      expect(operation.responses['201']).toBeDefined();
      expect(operation.responses['200']).toBeUndefined();
    }

    expect(spec.components.schemas.ApplyOrderSetResult).toEqual({
      $ref: '#/components/schemas/ClinicalOrderCreateResult'
    });
    const createSchema = spec.components.schemas.EmrCreateOrderRequest;
    const inpatientMedication = createSchema.oneOf.find(variant =>
      variant.properties?.order_type?.enum?.includes('medication')
    );
    expect(inpatientMedication.required).toEqual(
      expect.arrayContaining(['encounter_id', 'details'])
    );
    expect(inpatientMedication.properties.details.required).toEqual([
      'catalog_id',
      'dose',
      'route',
      'quantity_requested',
      'unit',
    ]);
    expect(
      createSchema.oneOf.some(
        variant =>
          variant.required?.includes('er_visit_id') &&
          variant.properties?.order_type?.enum?.includes('medication')
      )
    ).toBe(false);
    expect(
      createSchema.oneOf.find(
        variant => variant.title === 'Flat or nested investigation or radiology order'
      ).anyOf
    ).toEqual(
      expect.arrayContaining([
        { required: ['details'] },
        { required: ['investigation'] },
        { required: ['test_name'] }
      ])
    );
    expect(
      createSchema.oneOf.find(variant => variant.title === 'Flat or nested consultation order')
        .anyOf
    ).toEqual(
      expect.arrayContaining([
        { required: ['details'] },
        { required: ['specialty'] },
        { required: ['reason'] }
      ])
    );
    expect(
      createSchema.oneOf.find(variant => variant.title === 'Flat or nested nursing order').anyOf
    ).toEqual(
      expect.arrayContaining([
        { required: ['details'] },
        { required: ['description'] },
        { required: ['frequency'] },
        { required: ['instructions'] }
      ])
    );

    const bulkSchema = spec.components.schemas.EmrBulkOrderRequest;
    expect(bulkSchema.properties.orders.items).toBeUndefined();
    expect(
      bulkSchema.oneOf.find(variant => variant.title === 'Batch-level inpatient encounter')
        .properties.orders.items
    ).toEqual({ $ref: '#/components/schemas/EmrEncounterBoundOrderRequest' });
    expect(
      bulkSchema.oneOf.find(variant => variant.title === 'Per-item encounter context').properties
        .orders.items
    ).toEqual({ $ref: '#/components/schemas/EmrCreateOrderRequest' });

    const encounterMedication = spec.components.schemas.EmrEncounterBoundOrderRequest.oneOf.find(
      variant => variant.properties?.order_type?.enum?.includes('medication')
    );
    expect(encounterMedication.required).toContain('details');
    expect(encounterMedication.properties.details.required).toEqual([
      'catalog_id',
      'dose',
      'route',
      'quantity_requested',
      'unit'
    ]);
    const marRecovery = spec.paths['/api/v1/emr/orders/{id}/retry-mar-scheduling'].post;
    expect(marRecovery.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    const mirror = readFileSync(
      new URL('../../../../../packages/vhhealth_core/swagger/openapi.json', import.meta.url),
      'utf8',
    );
    expect(mirror).toBe(specText);
  });
});
