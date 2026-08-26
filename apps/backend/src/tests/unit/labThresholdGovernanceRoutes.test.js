import express from 'express';
import { jest } from '@jest/globals';
import request from 'supertest';

const tenantId = '10000000-0000-4000-8000-000000000001';
const actorUid = '10000000-0000-4000-8000-000000000002';

const governance = {
  activateLabThresholdPolicyBundle: jest.fn(async args => args),
  addLabThresholdCatalogEntry: jest.fn(async args => args),
  approveLabThresholdPolicyBundle: jest.fn(async args => args),
  createLabThresholdPolicyBundle: jest.fn(async args => args),
  getLabThresholdPolicyCoverage: jest.fn(async args => args),
  listLabThresholdCatalog: jest.fn(async args => args),
  listLabThresholdPolicyBundles: jest.fn(async args => args),
  rejectLabThresholdPolicyBundle: jest.fn(async args => args),
  replaceLabThresholdPolicyRules: jest.fn(async args => args),
  retireLabThresholdCatalogEntry: jest.fn(async args => args),
  submitLabThresholdPolicyBundle: jest.fn(async args => args),
};

const reconciliation = {
  getLabThresholdException: jest.fn(async args => args),
  listLabThresholdExceptions: jest.fn(async args => args),
  reconcileLabThresholdException: jest.fn(async args => args),
};

jest.unstable_mockModule('../../services/lab/labThresholdGovernanceService.js', () => governance);
jest.unstable_mockModule('../../services/lab/labThresholdReconciliationService.js', () => reconciliation);

const { default: routes } = await import('../../routes/lab/labThresholdGovernanceRoutes.js');

function appFor(role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = tenantId;
    req.user = { uid: actorUid, role };
    next();
  });
  app.use('/api/v1/lab', routes);
  return app;
}

describe('lab threshold governance routes', () => {
  beforeEach(() => {
    for (const mock of [...Object.values(governance), ...Object.values(reconciliation)]) {
      mock.mockClear();
    }
  });

  test('limits catalogue authoring while keeping governed evidence readable to lab staff', async () => {
    await request(appFor('LAB_STAFF'))
      .get('/api/v1/lab/threshold-governance/catalog?facility_id=7')
      .expect(200);
    expect(governance.listLabThresholdCatalog).toHaveBeenCalledWith({
      tenantId,
      facilityId: '7',
    });

    await request(appFor('PATHOLOGIST'))
      .post('/api/v1/lab/threshold-governance/catalog')
      .send({ facility_id: 7, entry: {} })
      .expect(403);
    expect(governance.addLabThresholdCatalogEntry).not.toHaveBeenCalled();

    await request(appFor('LAB_INCHARGE'))
      .post('/api/v1/lab/threshold-governance/catalog')
      .send({ facility_id: 7, entry: { test_code: 'K' } })
      .expect(200);
    expect(governance.addLabThresholdCatalogEntry).toHaveBeenCalledWith(expect.objectContaining({
      tenantId,
      facilityId: 7,
      actorUid,
      actorRole: 'LAB_INCHARGE',
    }));
  });

  test('separates clinical approval from operational activation', async () => {
    const bundleId = '10000000-0000-4000-8000-000000000003';
    await request(appFor('ADMIN'))
      .post(`/api/v1/lab/threshold-governance/bundles/${bundleId}/approve`)
      .send({ reason: 'review', evidence_reference: 'ref', evidence_sha256: 'a'.repeat(64) })
      .expect(403);
    await request(appFor('PATHOLOGIST'))
      .post(`/api/v1/lab/threshold-governance/bundles/${bundleId}/approve`)
      .send({ reason: 'review', evidence_reference: 'ref', evidence_sha256: 'a'.repeat(64) })
      .expect(200);
    expect(governance.approveLabThresholdPolicyBundle).toHaveBeenCalledWith(expect.objectContaining({
      bundleId,
      actorRole: 'PATHOLOGIST',
    }));

    await request(appFor('PATHOLOGIST'))
      .post(`/api/v1/lab/threshold-governance/bundles/${bundleId}/activate`)
      .send({ reason: 'go live' })
      .expect(403);
    await request(appFor('SUPER_ADMIN'))
      .post(`/api/v1/lab/threshold-governance/bundles/${bundleId}/activate`)
      .send({ reason: 'go live' })
      .expect(200);
    expect(governance.activateLabThresholdPolicyBundle).toHaveBeenCalledWith(expect.objectContaining({
      bundleId,
      actorRole: 'SUPER_ADMIN',
    }));
  });

  test('limits manual exception reconciliation to laboratory operators', async () => {
    const exceptionId = '10000000-0000-4000-8000-000000000004';
    await request(appFor('PATHOLOGIST'))
      .post(`/api/v1/lab/threshold-governance/exceptions/${exceptionId}/reconcile`)
      .expect(403);
    await request(appFor('ADMIN'))
      .post(`/api/v1/lab/threshold-governance/exceptions/${exceptionId}/reconcile`)
      .expect(200);
    expect(reconciliation.reconcileLabThresholdException).toHaveBeenCalledWith({
      tenantId,
      exceptionId,
      source: 'lab_threshold_exception_manual_reconciliation',
      actorUid,
      actorRole: 'ADMIN',
    });
  });
});
