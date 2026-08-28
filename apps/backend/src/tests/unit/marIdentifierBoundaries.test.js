import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

const getMarSupplyStateMock = jest.fn();
const reconcileMarSupplyOverrideMock = jest.fn();

function passThroughWithMetadata(metadata) {
  const middleware = (_req, _res, next) => next();
  middleware.__patientGuard = metadata;
  return middleware;
}

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: (recordType, options = {}) => passThroughWithMetadata({
    recordType,
    ...options,
  }),
  patientAccessGuardForResource: (recordType, options = {}) => passThroughWithMetadata({
    recordType,
    ...options,
  }),
}));
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (req, _res, next) => {
    req.idempotencyClaim = { requestKey: req.get('idempotency-key') };
    next();
  },
}));
jest.unstable_mockModule('../../middleware/rejectMobileClinicalWriteMiddleware.js', () => ({
  enforceStaffClinicalWriteDevicePosture: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../services/clinical/marSupplyService.js', () => ({
  getMarSupplyState: getMarSupplyStateMock,
  reconcileMarSupplyOverride: reconcileMarSupplyOverrideMock,
}));

for (const modulePath of [
  '../../services/clinical/handoverService.js',
  '../../services/clinical/marService.js',
  '../../services/clinical/marFiveRightsService.js',
  '../../services/clinical/drugChartService.js',
  '../../services/clinical/news2Service.js',
  '../../services/ai/voiceSoapService.js',
]) {
  jest.unstable_mockModule(modulePath, () => ({}));
}
jest.unstable_mockModule('../../services/ai/sttService.js', () => ({
  describeSttConfig: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/polypharmacyAiService.js', () => ({
  reviewPolypharmacy: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/deteriorationEarlyWarningService.js', () => ({
  scoreDeterioration: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/ambientDocumentationService.js', () => ({
  createAmbientEncounter: jest.fn(),
  listAmbientEncounters: jest.fn(),
}));

const { default: router } = await import('../../routes/clinical/clinicalRoutes.js');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = {
      uid: '10000000-0000-4000-8000-000000000001',
      role: 'PHARMACY_INCHARGE',
      deviceType: 'desktop',
    };
    req.tenantId = '10000000-0000-4000-8000-000000000002';
    next();
  });
  instance.use('/clinical', router);
  instance.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({
    code: err.code,
    message: err.message,
  }));
  return instance;
}

describe('MAR external identifier boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getMarSupplyStateMock.mockResolvedValue({ status: 'available' });
    reconcileMarSupplyOverrideMock.mockResolvedValue({ reconciled_quantity: 1 });
  });

  test('accepts the PostgreSQL INTEGER medication-administration maximum', async () => {
    await request(app()).get('/clinical/mar/2147483647/supply').expect(200);
    expect(getMarSupplyStateMock).toHaveBeenCalledWith(2147483647, expect.any(Object));
  });

  test.each(['0', '01', '2147483648'])('rejects out-of-contract maId %s with 400', async (id) => {
    await request(app()).get(`/clinical/mar/${id}/supply`).expect(400);
    expect(getMarSupplyStateMock).not.toHaveBeenCalled();
  });

  test('accepts signed-64 decimal-string reconciliation identifiers at the boundary', async () => {
    await request(app())
      .post('/clinical/mar/2147483647/supply-overrides/9223372036854775807/reconcile')
      .set('Idempotency-Key', 'id-boundary-max')
      .send({
        allocations: [{
          inventory_allocation_id: '9223372036854775807',
          quantity: 1,
        }],
      })
      .expect(200);

    expect(reconcileMarSupplyOverrideMock).toHaveBeenCalledWith(
      '9223372036854775807',
      [{ inventory_allocation_id: '9223372036854775807', quantity: 1 }],
      expect.objectContaining({ expectedMedicationAdministrationId: 2147483647 }),
    );
  });

  test.each([
    ['consumption overflow', '9223372036854775808', '7'],
    ['allocation overflow', '7', '9223372036854775808'],
    ['numeric allocation wire value', '7', 7],
  ])('rejects %s with governed 400 before service mutation', async (
    _case,
    consumptionId,
    allocationId,
  ) => {
    await request(app())
      .post(`/clinical/mar/42/supply-overrides/${consumptionId}/reconcile`)
      .set('Idempotency-Key', 'id-boundary-reject')
      .send({ allocations: [{ inventory_allocation_id: allocationId, quantity: 1 }] })
      .expect(400);
    expect(reconcileMarSupplyOverrideMock).not.toHaveBeenCalled();
  });
});
