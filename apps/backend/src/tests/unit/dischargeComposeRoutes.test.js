/**
 * Unit tests for admin discharge-compose route escape hatches.
 *
 * The compose service and workflow runner own generation/resume behavior.
 * These tests lock the HTTP contract for manually failing a paused run:
 * tenant scoped, compose-workflow-only, paused-only, and audited.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const storeMock = {
  getRun: jest.fn(),
  listChildren: jest.fn(),
  markFailed: jest.fn(),
};
const auditMock = jest.fn();

jest.unstable_mockModule('../../services/ai/dischargeComposeService.js', () => ({
  composeDischargePackage: jest.fn(),
  getComposeGraph: jest.fn(),
  DISCHARGE_COMPOSE_WORKFLOW_KEY: 'discharge_summary_compose',
}));

jest.unstable_mockModule('../../services/ai/workflowCheckpointStore.js', () => ({
  getDefaultCheckpointStore: jest.fn(() => storeMock),
}));

jest.unstable_mockModule('../../services/ai/workflowGraphRunner.js', () => ({
  resumeWorkflow: jest.fn(),
}));

jest.unstable_mockModule('../../routes/admin/clinicalAi/audit.js', () => ({
  logClinicalAiAudit: auditMock,
}));

const __prismaDefaultMock = { $queryRawUnsafe: jest.fn(() => Promise.resolve([])) };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const router = (await import('../../routes/admin/clinicalAi/dischargeComposeRoutes.js')).default;

const TENANT = '00000000-0000-4000-8000-000000000001';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: 'admin-uid', role: 'ADMIN' };
    next();
  });
  app.use('/clinical-ai', router);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message,
      code: err.code || 'INTERNAL_ERROR',
      details: err.details || null,
    });
  });
  return app;
}

function pausedRun(overrides = {}) {
  return {
    id: 77,
    tenant_id: TENANT,
    workflow_key: 'discharge_summary_compose',
    status: 'paused',
    pause_reason: 'await_governance',
    state: { admission_id: 123 },
    ...overrides,
  };
}

beforeEach(() => {
  storeMock.getRun.mockReset();
  storeMock.listChildren.mockReset();
  storeMock.markFailed.mockReset().mockResolvedValue(undefined);
  auditMock.mockReset().mockResolvedValue(undefined);
});

describe('POST /discharge-compose/:runId/fail', () => {
  it('marks a tenant-scoped paused compose run failed and records audit', async () => {
    storeMock.getRun.mockResolvedValue(pausedRun());

    const res = await request(makeApp())
      .post('/clinical-ai/discharge-compose/77/fail')
      .send({ reason: 'Pilot approval expired before rollout' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'failed',
      runId: 77,
      reason: 'Pilot approval expired before rollout',
    });
    expect(storeMock.markFailed).toHaveBeenCalledWith(77, { admission_id: 123 }, {
      node: 'manual_fail',
      message: 'Pilot approval expired before rollout',
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'CLINICAL_AI_DISCHARGE_COMPOSE_MANUALLY_FAILED',
      '77',
      { status_before: 'paused', pause_reason: 'await_governance' },
      {
        status_after: 'failed',
        manual_reason: 'Pilot approval expired before rollout',
      }
    );
  });

  it('does not leak cross-tenant runs', async () => {
    storeMock.getRun.mockResolvedValue(
      pausedRun({ tenant_id: '00000000-0000-4000-8000-000000000099' })
    );

    const res = await request(makeApp())
      .post('/clinical-ai/discharge-compose/77/fail')
      .send({ reason: 'wrong tenant' });

    expect(res.statusCode).toBe(404);
    expect(storeMock.markFailed).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('rejects non-paused runs with a conflict', async () => {
    storeMock.getRun.mockResolvedValue(pausedRun({ status: 'completed', pause_reason: null }));

    const res = await request(makeApp())
      .post('/clinical-ai/discharge-compose/77/fail')
      .send({ reason: 'already completed' });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('COMPOSE_RUN_NOT_PAUSED');
    expect(storeMock.markFailed).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
