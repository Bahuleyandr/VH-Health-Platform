import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const queryUnsafeMock = jest.fn();
const prismaMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
  default: prismaMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../services/lab/labResultsService.js', () => ({
  acknowledgeCriticalAlertForInboxTask: async () => ({ handled: false, task: null }),
}));

jest.unstable_mockModule(
  '../../services/integrations/externalRecoveryCriticalReviewService.js',
  () => ({
    acknowledgeExternalRecoveryCriticalReviewForInboxTask: async () => ({ handled: false }),
  }),
);

const { default: clinicalInboxRoutes } = await import('../../routes/clinicalInboxRoutes.js');
const { errorHandlerMiddleware } = await import('../../middleware/errorHandlerMiddleware.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '11111111-1111-4111-8111-111111111111';
const OTHER_UID = '99999999-9999-4999-8999-999999999999';
const PATIENT_UID = '44444444-4444-4444-8444-444444444444';
const SLA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let finishedPhiContext = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'clinical-inbox-authz-test';
  req.tenantId = TENANT_ID;
  req.user = {
    uid: ACTOR_UID,
    role: 'NURSING_STAFF',
    rawRole: 'NURSING_STAFF',
    roles: ['NURSING_STAFF'],
  };
  next();
});
app.use((req, res, next) => {
  res.on('finish', () => { finishedPhiContext = req.phiContext || null; });
  next();
});
app.use('/api/v1/clinical-inbox', clinicalInboxRoutes);
app.use(errorHandlerMiddleware);

beforeEach(() => {
  queryUnsafeMock.mockReset();
  finishedPhiContext = null;
});

function currentActorRow() {
  return [{ uid: ACTOR_UID, role: 'NURSING_STAFF' }];
}

describe('POST /api/v1/clinical-inbox/tasks/:id/acknowledge authorization', () => {
  it('returns a generic 403 for an arbitrary override reason without updating the task or SLA', async () => {
    // The extra successful write responses make the vulnerable reason-only path
    // reach 200; the fixed path must reject immediately after the task read.
    queryUnsafeMock
      .mockResolvedValueOnce(currentActorRow())
      .mockResolvedValueOnce([{
        id: 71,
        status: 'open',
        title: 'Critical result for a different clinician',
        assigned_to_uid: OTHER_UID,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT_UID,
        workflow_sla_instance_id: SLA_ID,
        sla_completion_semantics: 'acknowledgement',
        metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 71,
        status: 'in_progress',
        patient_uid: PATIENT_UID,
        workflow_sla_instance_id: SLA_ID,
        sla_completion_semantics: 'acknowledgement',
        metadata: {},
      }])
      .mockResolvedValueOnce([{ id: SLA_ID, status: 'completed' }])
      .mockResolvedValueOnce([{ id: 15, body_kind: 'state_change' }]);

    const response = await request(app)
      .post('/api/v1/clinical-inbox/tasks/71/acknowledge')
      .send({ override_reason: 'I am covering for the on-call doctor' });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: 'FORBIDDEN',
      message: 'Not authorized to acknowledge this task',
      requestId: 'clinical-inbox-authz-test',
    });
    expect(JSON.stringify(response.body)).not.toMatch(/Critical result|patient|clinician/i);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/^SELECT[\s\S]+FROM users/i);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/^SELECT[\s\S]+FROM tasks/i);
    expect(finishedPhiContext).toMatchObject({ patientUid: PATIENT_UID });
  });

  it('normalizes a missing task to the same generic 403 instead of exposing a 404 oracle', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce(currentActorRow())
      .mockResolvedValueOnce([]);

    const response = await request(app)
      .post('/api/v1/clinical-inbox/tasks/404/acknowledge')
      .send({});

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: 'FORBIDDEN',
      message: 'Not authorized to acknowledge this task',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(finishedPhiContext).toBeNull();
  });

  it('authorizes before idempotent repair and cannot stop an unauthorized in-progress task SLA', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce(currentActorRow())
      .mockResolvedValueOnce([{
        id: 72,
        status: 'in_progress',
        title: 'Already acknowledged critical result for a different clinician',
        assigned_to_uid: OTHER_UID,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT_UID,
        workflow_sla_instance_id: SLA_ID,
        sla_completion_semantics: 'acknowledgement',
        metadata: { acknowledged_at: '2026-07-18T08:00:00.000Z' },
      }]);

    const response = await request(app)
      .post('/api/v1/clinical-inbox/tasks/72/acknowledge')
      .send({});

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: 'FORBIDDEN',
      message: 'Not authorized to acknowledge this task',
    });
    expect(JSON.stringify(response.body)).not.toMatch(/critical result|patient|clinician/i);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/^SELECT[\s\S]+FROM users/i);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/^SELECT[\s\S]+FROM tasks/i);
  });

  it('does not reveal pathway binding to an unauthorized task-id probe', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce(currentActorRow())
      .mockResolvedValueOnce([{
        id: 73,
        status: 'open',
        workflow_run_id: 9001,
        assigned_to_uid: OTHER_UID,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT_UID,
        metadata: {},
      }])
      // A vulnerable guard-before-authorization implementation reaches this
      // query and turns the probe into a distinct PATHWAY_EXECUTOR_REQUIRED 409.
      .mockResolvedValueOnce([{ '?column?': 1 }]);

    const response = await request(app)
      .post('/api/v1/clinical-inbox/tasks/73/acknowledge')
      .send({});

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: 'FORBIDDEN',
      message: 'Not authorized to acknowledge this task',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
  });
});
