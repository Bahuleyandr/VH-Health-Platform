import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mutationResult = async () => ({ id: 1 });
const serviceMocks = {
  acknowledgeTask: jest.fn(mutationResult),
  createApproval: jest.fn(mutationResult),
  createTask: jest.fn(mutationResult),
  createWorkflowDefinition: jest.fn(mutationResult),
  getTask: jest.fn(mutationResult),
  listApprovals: jest.fn(async () => ({ approvals: [], count: 0 })),
  listAutomationRules: jest.fn(async () => ({ rules: [], count: 0 })),
  listEscalationRules: jest.fn(async () => ({ rules: [], count: 0 })),
  listInboxTasks: jest.fn(async () => ({ tasks: [], count: 0 })),
  listSlaDefinitions: jest.fn(async () => ({ definitions: [], count: 0 })),
  listTaskComments: jest.fn(async () => ({ comments: [], count: 0 })),
  listTasks: jest.fn(async () => ({ tasks: [], count: 0 })),
  listWorkflowDefinitions: jest.fn(async () => ({ definitions: [], count: 0 })),
  listWorkflowRuns: jest.fn(async () => ({ runs: [], count: 0 })),
  listWorkflowSteps: jest.fn(async () => ({ steps: [], count: 0 })),
  postTaskComment: jest.fn(mutationResult),
  reassignTask: jest.fn(mutationResult),
  recordApprovalDecision: jest.fn(mutationResult),
  startWorkflowRun: jest.fn(mutationResult),
  transitionTask: jest.fn(mutationResult),
  transitionWorkflowRun: jest.fn(mutationResult),
  transitionWorkflowStep: jest.fn(mutationResult),
  upsertAutomationRule: jest.fn(mutationResult),
  upsertEscalationRule: jest.fn(mutationResult),
  upsertSlaDefinition: jest.fn(mutationResult),
};

jest.unstable_mockModule('../../services/workflow/taskService.js', () => serviceMocks);

const { default: tasksWorkflowRoutes } = await import('../../routes/admin/tasksWorkflowRoutes.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const SPOOFED = '99999999-9999-4999-8999-999999999999';

let requestUser = { uid: ACTOR, roles: ['ADMIN'] };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.tenantId = TENANT;
  req.user = requestUser;
  next();
});
app.use('/api/v1/admin/workflow', tasksWorkflowRoutes);
app.use((err, _req, res, _next) => {
  res.status(err.statusCode || 500).json({ code: err.code, message: err.message });
});

beforeEach(() => {
  requestUser = { uid: ACTOR, roles: ['ADMIN'] };
  for (const mock of Object.values(serviceMocks)) mock.mockClear();
});

describe('tasks/workflow admin actor context', () => {
  it('ignores body.created_by when creating a task', async () => {
    const response = await request(app)
      .post('/api/v1/admin/workflow/tasks')
      .send({ title: 'Review result', created_by: SPOOFED });

    expect(response.statusCode).toBe(201);
    expect(serviceMocks.createTask).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      createdBy: ACTOR,
    }));
  });

  it('passes the authenticated actor into task, run and step transitions', async () => {
    const taskResponse = await request(app)
      .patch('/api/v1/admin/workflow/tasks/1/transition')
      .send({ next_status: 'completed', actor_uid: SPOOFED });
    const runResponse = await request(app)
      .patch('/api/v1/admin/workflow/workflow-runs/2/transition')
      .send({ next_status: 'running', actor_uid: SPOOFED });
    const stepResponse = await request(app)
      .patch('/api/v1/admin/workflow/workflow-runs/2/steps/review/transition')
      .send({ next_status: 'in_progress', actor_uid: SPOOFED });

    expect([taskResponse.statusCode, runResponse.statusCode, stepResponse.statusCode])
      .toEqual([200, 200, 200]);
    expect(serviceMocks.transitionTask).toHaveBeenCalledWith(expect.objectContaining({ actorUid: ACTOR }));
    expect(serviceMocks.transitionWorkflowRun)
      .toHaveBeenCalledWith(expect.objectContaining({ actorUid: ACTOR }));
    expect(serviceMocks.transitionWorkflowStep)
      .toHaveBeenCalledWith(expect.objectContaining({ actorUid: ACTOR }));
  });

  it('ignores body.approver_uid and passes server roles into approval decisions', async () => {
    const response = await request(app)
      .post('/api/v1/admin/workflow/approvals/3/decide')
      .send({ decision: 'approve', approver_uid: SPOOFED });

    expect(response.statusCode).toBe(200);
    expect(serviceMocks.recordApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      actorUid: ACTOR,
      actorRoles: ['ADMIN'],
    }));
  });

  it('uses the canonical single role when the roles collection is empty', async () => {
    requestUser = { uid: ACTOR, role: 'ADMIN', roles: [] };

    await request(app)
      .post('/api/v1/admin/workflow/approvals/3/decide')
      .send({ decision: 'approve' });

    expect(serviceMocks.recordApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      actorRoles: ['ADMIN'],
    }));
  });

  it('pins definition and run creators to the authenticated actor', async () => {
    const definitionResponse = await request(app)
      .post('/api/v1/admin/workflow/workflow-definitions')
      .send({ workflow_key: 'diagnostics', created_by: SPOOFED });
    const runResponse = await request(app)
      .post('/api/v1/admin/workflow/workflow-runs')
      .send({ workflow_definition_id: 1, initiated_by: SPOOFED });

    expect([definitionResponse.statusCode, runResponse.statusCode]).toEqual([201, 201]);
    expect(serviceMocks.createWorkflowDefinition)
      .toHaveBeenCalledWith(expect.objectContaining({ createdBy: ACTOR }));
    expect(serviceMocks.startWorkflowRun)
      .toHaveBeenCalledWith(expect.objectContaining({ initiatedBy: ACTOR }));
  });

  it('rejects a missing authenticated actor before invoking a mutation service', async () => {
    requestUser = null;

    const response = await request(app)
      .post('/api/v1/admin/workflow/tasks')
      .send({ title: 'Review result', created_by: SPOOFED });

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toBe('Authenticated actor is required');
    expect(serviceMocks.createTask).not.toHaveBeenCalled();
  });

  it('does not restore approval authority from body.approver_uid when the actor is missing', async () => {
    requestUser = null;

    const response = await request(app)
      .post('/api/v1/admin/workflow/approvals/3/decide')
      .send({ decision: 'approve', approver_uid: SPOOFED });

    expect(response.statusCode).toBe(401);
    expect(response.body.message).toBe('Authenticated actor is required');
    expect(serviceMocks.recordApprovalDecision).not.toHaveBeenCalled();
  });
});
