/**
 * Unit tests for admin prior-auth appeal chain control-plane routes.
 *
 * Mirrors dischargeComposeRoutes.test.js in structure and coverage.
 *
 * Locked contracts:
 *   POST /prior-auth/:id/appeal  → 202 when service returns paused; 201 when completed
 *   POST /prior-auth-appeal/:runId/resume → 200 on success
 *   POST /prior-auth-appeal/:runId/fail   → 200 paused→failed; 409 non-paused; 404 wrong tenant
 *   GET  /prior-auth-appeal/:runId        → 200 with run+children; 404 when missing
 *   Auth gating: non-admin role → 403 (requireClinicalAiControl at mount)
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
const composeMock = jest.fn();
const resumeWorkflowMock = jest.fn();
const getPriorAuthAppealGraphMock = jest.fn(() => ({}));

jest.unstable_mockModule('../../services/ai/priorAuthAppealChainService.js', () => ({
  composePriorAuthAppeal: composeMock,
  getPriorAuthAppealGraph: getPriorAuthAppealGraphMock,
  WORKFLOW_KEY: 'prior_auth_appeal_chain',
}));

jest.unstable_mockModule('../../services/ai/workflowCheckpointStore.js', () => ({
  getDefaultCheckpointStore: jest.fn(() => storeMock),
}));

jest.unstable_mockModule('../../services/ai/workflowGraphRunner.js', () => ({
  resumeWorkflow: resumeWorkflowMock,
}));

jest.unstable_mockModule('../../routes/admin/clinicalAi/audit.js', () => ({
  logClinicalAiAudit: auditMock,
}));

// Don't mock shared.js — we want requireClinicalAiControl to run for the
// role-gating assertion. It only reads req.user, so no DB/mock needed.

const __prismaDefaultMock = { $queryRawUnsafe: jest.fn(() => Promise.resolve([])) };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const router = (await import('../../routes/admin/clinicalAi/priorAuthAppealRoutes.js')).default;
const { requireClinicalAiControl } = await import('../../routes/admin/clinicalAi/shared.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function makeApp({ role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: 'admin-uid', role };
    next();
  });
  // Mirror the real mount: apply role gate before the router.
  app.use('/clinical-ai', requireClinicalAiControl, router);
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
    id: 42,
    tenant_id: TENANT,
    workflow_key: 'prior_auth_appeal_chain',
    status: 'paused',
    pause_reason: 'await_appeal_human_disposition',
    state: { priorAuthId: 7, appealId: 99 },
    ...overrides,
  };
}

beforeEach(() => {
  storeMock.getRun.mockReset();
  storeMock.listChildren.mockReset().mockResolvedValue([]);
  storeMock.markFailed.mockReset().mockResolvedValue(undefined);
  auditMock.mockReset().mockResolvedValue(undefined);
  composeMock.mockReset();
  resumeWorkflowMock.mockReset();
  getPriorAuthAppealGraphMock.mockReset().mockReturnValue({});
});

// ---------------------------------------------------------------------------
// POST /prior-auth/:id/appeal
// ---------------------------------------------------------------------------
describe('POST /prior-auth/:id/appeal', () => {
  it('returns 202 with run_id and pause_reason when service returns a paused result', async () => {
    composeMock.mockResolvedValue({
      status: 'paused',
      run_id: 42,
      pause_reason: 'await_appeal_human_disposition',
    });

    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth/7/appeal')
      .send({});

    expect(res.statusCode).toBe(202);
    expect(res.body.data).toMatchObject({
      status: 'paused',
      run_id: 42,
      pause_reason: 'await_appeal_human_disposition',
    });
    expect(composeMock).toHaveBeenCalledWith(7, expect.objectContaining({ startedBy: 'admin-uid' }));
    expect(auditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'CLINICAL_AI_PRIOR_AUTH_APPEAL_STARTED',
      '7',
      null,
      expect.objectContaining({ status: 'paused', run_id: 42 })
    );
  });

  it('returns 201 when service completes synchronously (no pause)', async () => {
    composeMock.mockResolvedValue({
      prior_auth_id: 7,
      appeal_id: 99,
      outcome: 'approved',
    });

    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth/7/appeal')
      .send({});

    expect(res.statusCode).toBe(201);
    expect(res.body.data).toMatchObject({
      prior_auth_id: 7,
      appeal_id: 99,
    });
  });

  it('rejects a non-numeric priorAuthId with 400', async () => {
    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth/abc/appeal')
      .send({});

    expect(res.statusCode).toBe(400);
    expect(composeMock).not.toHaveBeenCalled();
  });

  it('forwards service AppError (e.g. 404 prior auth not found)', async () => {
    const { AppError } = await import('../../utils/AppError.js');
    composeMock.mockRejectedValue(AppError.notFound('Prior auth not found', 'PRIOR_AUTH_NOT_FOUND'));

    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth/999/appeal')
      .send({});

    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('PRIOR_AUTH_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// GET /prior-auth-appeal/:runId
// ---------------------------------------------------------------------------
describe('GET /prior-auth-appeal/:runId', () => {
  it('returns 200 with run and children', async () => {
    const run = pausedRun();
    storeMock.getRun.mockResolvedValue(run);
    storeMock.listChildren.mockResolvedValue([{ id: 100 }]);

    const res = await request(makeApp()).get('/clinical-ai/prior-auth-appeal/42');

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      run: expect.objectContaining({ id: 42 }),
      children: [{ id: 100 }],
      child_count: 1,
    });
  });

  it('returns 404 when the run is missing', async () => {
    storeMock.getRun.mockResolvedValue(null);

    const res = await request(makeApp()).get('/clinical-ai/prior-auth-appeal/42');

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a different tenant\'s run', async () => {
    storeMock.getRun.mockResolvedValue(
      pausedRun({ tenant_id: '00000000-0000-4000-8000-000000000099' })
    );

    const res = await request(makeApp()).get('/clinical-ai/prior-auth-appeal/42');

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the run belongs to a different workflow', async () => {
    storeMock.getRun.mockResolvedValue(
      pausedRun({ workflow_key: 'discharge_summary_compose' })
    );

    const res = await request(makeApp()).get('/clinical-ai/prior-auth-appeal/42');

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /prior-auth-appeal/:runId/resume
// ---------------------------------------------------------------------------
describe('POST /prior-auth-appeal/:runId/resume', () => {
  it('resumes a paused run and returns 200', async () => {
    storeMock.getRun.mockResolvedValue(pausedRun());
    resumeWorkflowMock.mockResolvedValue({ status: 'completed' });

    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth-appeal/42/resume')
      .send({});

    expect(res.statusCode).toBe(200);
    expect(resumeWorkflowMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 42 })
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'CLINICAL_AI_PRIOR_AUTH_APPEAL_RESUMED',
      '42',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('returns 404 when run is not found', async () => {
    storeMock.getRun.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth-appeal/42/resume')
      .send({});

    expect(res.statusCode).toBe(404);
    expect(resumeWorkflowMock).not.toHaveBeenCalled();
  });

  it('blocks cross-tenant resume', async () => {
    storeMock.getRun.mockResolvedValue(
      pausedRun({ tenant_id: '00000000-0000-4000-8000-000000000099' })
    );

    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth-appeal/42/resume')
      .send({});

    expect(res.statusCode).toBe(404);
    expect(resumeWorkflowMock).not.toHaveBeenCalled();
  });

  it('blocks resume of a run from a different workflow', async () => {
    storeMock.getRun.mockResolvedValue(
      pausedRun({ workflow_key: 'discharge_summary_compose' })
    );

    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth-appeal/42/resume')
      .send({});

    expect(res.statusCode).toBe(400);
    expect(resumeWorkflowMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /prior-auth-appeal/:runId/fail
// ---------------------------------------------------------------------------
describe('POST /prior-auth-appeal/:runId/fail', () => {
  it('marks a paused run failed and records audit', async () => {
    storeMock.getRun.mockResolvedValue(pausedRun());

    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth-appeal/42/fail')
      .send({ reason: 'Appeal window expired' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'failed',
      runId: 42,
      reason: 'Appeal window expired',
    });
    expect(storeMock.markFailed).toHaveBeenCalledWith(
      42,
      { priorAuthId: 7, appealId: 99 },
      { node: 'manual_fail', message: 'Appeal window expired' }
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.any(Object),
      'CLINICAL_AI_PRIOR_AUTH_APPEAL_MANUALLY_FAILED',
      '42',
      { status_before: 'paused', pause_reason: 'await_appeal_human_disposition' },
      { status_after: 'failed', manual_reason: 'Appeal window expired' }
    );
  });

  it('does not leak cross-tenant runs', async () => {
    storeMock.getRun.mockResolvedValue(
      pausedRun({ tenant_id: '00000000-0000-4000-8000-000000000099' })
    );

    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth-appeal/42/fail')
      .send({ reason: 'wrong tenant' });

    expect(res.statusCode).toBe(404);
    expect(storeMock.markFailed).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('rejects non-paused runs with a conflict (409)', async () => {
    storeMock.getRun.mockResolvedValue(pausedRun({ status: 'completed', pause_reason: null }));

    const res = await request(makeApp())
      .post('/clinical-ai/prior-auth-appeal/42/fail')
      .send({ reason: 'already completed' });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('APPEAL_RUN_NOT_PAUSED');
    expect(storeMock.markFailed).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Role gating (requireClinicalAiControl is applied at mount)
// ---------------------------------------------------------------------------
describe('Role gating', () => {
  it('rejects a DOCTOR role (non-control-plane) with 403', async () => {
    composeMock.mockResolvedValue({ status: 'paused', run_id: 1, pause_reason: 'x' });

    const res = await request(makeApp({ role: 'DOCTOR' }))
      .post('/clinical-ai/prior-auth/7/appeal')
      .send({});

    expect(res.statusCode).toBe(403);
    expect(composeMock).not.toHaveBeenCalled();
  });
});
