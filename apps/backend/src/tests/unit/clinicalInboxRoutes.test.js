/**
 * Security regression guard for the clinician results-inbox surface.
 *
 * The /api/v1/clinical-inbox mount (clinical-staff-gated) must expose ONLY the
 * two safety-net endpoints — NOT the full admin tasks/workflow/escalation-rules
 * router. A prior iteration mounted the whole admin router there, which let any
 * clinical-staff role read any task by id (cross-patient PHI) and disable
 * escalation rules. This test fails if that surface ever creeps back in.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const acknowledgeTaskMock = jest.fn();
const claimInboxTaskMock = jest.fn();
const listInboxTasksMock = jest.fn();
const acknowledgeCriticalAlertForInboxTaskMock = jest.fn();

jest.unstable_mockModule('../../services/idempotency/idempotencyService.js', () => ({
  isValidIdempotencyKey: (value) => (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && /^[A-Za-z0-9_.:-]+$/.test(value)
  ),
}));

jest.unstable_mockModule('../../services/lab/labResultsService.js', () => ({
  acknowledgeCriticalAlertForInboxTask: acknowledgeCriticalAlertForInboxTaskMock,
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  acknowledgeTask: acknowledgeTaskMock,
  claimInboxTask: claimInboxTaskMock,
  listInboxTasks: listInboxTasksMock,
}));

const { default: router } = await import('../../routes/clinicalInboxRoutes.js');

function registeredRoutes(expressRouter) {
  return expressRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m])
        .sort(),
    }));
}

describe('clinicalInboxRoutes — minimal clinician surface', () => {
  const routes = registeredRoutes(router);

  beforeEach(() => {
    acknowledgeTaskMock.mockReset();
    claimInboxTaskMock.mockReset();
    listInboxTasksMock.mockReset();
    acknowledgeCriticalAlertForInboxTaskMock.mockReset();
    acknowledgeCriticalAlertForInboxTaskMock.mockResolvedValue({ handled: false, task: null });
  });

  it('exposes only inbox, role claim, and acknowledgement', () => {
    expect(routes).toEqual([
      { path: '/tasks/inbox', methods: ['get'] },
      { path: '/tasks/:id/claim', methods: ['post'] },
      { path: '/tasks/:id/acknowledge', methods: ['post'] },
    ]);
  });

  it('does NOT expose the admin task/escalation surface (PHI + privilege escalation)', () => {
    const paths = routes.map((r) => r.path);
    // getTask by id — cross-patient PHI read.
    expect(paths).not.toContain('/tasks/:id');
    // listTasks — enumerate any tenant/patient tasks.
    expect(paths).not.toContain('/tasks');
    // upsertEscalationRule — disable the safety net itself.
    expect(paths).not.toContain('/escalation-rules');
    expect(paths).not.toContain('/sla-definitions');
    expect(paths).not.toContain('/automation-rules');
    // No mutation of arbitrary tasks (create / transition / assign).
    expect(paths.some((p) => p.includes('transition'))).toBe(false);
    expect(paths.some((p) => p.includes('assign'))).toBe(false);
  });

  it('forwards only a server-verified break-glass id, never caller reason text as authority', async () => {
    const patientUid = '44444444-4444-4444-8444-444444444444';
    let finishedPhiContext = null;
    acknowledgeTaskMock.mockResolvedValueOnce({
      id: 71,
      status: 'in_progress',
      patient_uid: patientUid,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantId = '00000000-0000-4000-8000-000000000001';
      req.user = {
        uid: '11111111-1111-4111-8111-111111111111',
        role: 'CMO',
        rawRole: 'CMO',
        roles: ['NURSING_STAFF'],
      };
      next();
    });
    app.use((req, res, next) => {
      res.on('finish', () => { finishedPhiContext = req.phiContext; });
      next();
    });
    app.use('/api/v1/clinical-inbox', router);

    const response = await request(app)
      .post('/api/v1/clinical-inbox/tasks/71/acknowledge')
      .send({
        break_glass_id: 41,
        override_reason: 'Caller-controlled text must not cross the authorization boundary',
      });

    expect(response.statusCode).toBe(200);
    expect(acknowledgeTaskMock).toHaveBeenCalledWith({
      tenantId: '00000000-0000-4000-8000-000000000001',
      id: '71',
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorRoles: ['NURSING_STAFF', 'CMO'],
      actorPrimaryRole: 'CMO',
      actorRawRole: 'CMO',
      breakGlassId: 41,
    });
    expect(acknowledgeCriticalAlertForInboxTaskMock).toHaveBeenCalledWith('71', {
      tenantId: '00000000-0000-4000-8000-000000000001',
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorName: null,
      actorRoles: ['NURSING_STAFF', 'CMO'],
      actorRole: 'CMO',
      actorRawRole: 'CMO',
      breakGlassId: 41,
      readBackMethod: null,
      notes: null,
    });
    expect(finishedPhiContext).toMatchObject({ patientUid });
  });

  it('returns the task-compatible row from the authoritative critical-alert transition', async () => {
    const patientUid = '55555555-5555-4555-8555-555555555555';
    acknowledgeCriticalAlertForInboxTaskMock.mockResolvedValueOnce({
      handled: true,
      task: { id: 72, status: 'in_progress', patient_uid: patientUid },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantId = '00000000-0000-4000-8000-000000000001';
      req.user = {
        uid: '11111111-1111-4111-8111-111111111111',
        name: 'Server Loaded Clinician',
        role: 'DOCTOR',
        rawRole: 'DOCTOR',
        roles: ['DOCTOR'],
      };
      next();
    });
    app.use('/api/v1/clinical-inbox', router);

    const response = await request(app)
      .post('/api/v1/clinical-inbox/tasks/72/acknowledge')
      .send({
        alert_id: 999999,
        result_id: 888888,
        acknowledged_by_name: 'Caller controlled actor',
        read_back_method: 'telephone',
        notes: 'Read back confirmed',
      });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      message: 'Task acknowledged',
      data: { id: 72, status: 'in_progress', patient_uid: patientUid },
    });
    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
    expect(acknowledgeCriticalAlertForInboxTaskMock).toHaveBeenCalledWith('72', {
      tenantId: '00000000-0000-4000-8000-000000000001',
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorName: 'Server Loaded Clinician',
      actorRoles: ['DOCTOR'],
      actorRole: 'DOCTOR',
      actorRawRole: 'DOCTOR',
      breakGlassId: null,
      readBackMethod: 'telephone',
      notes: 'Read back confirmed',
    });
  });

  it('forwards the exact raw role and idempotency key for an empty-body claim', async () => {
    claimInboxTaskMock.mockResolvedValueOnce({
      id: 73,
      status: 'open',
      patient_uid: '66666666-6666-4666-8666-666666666666',
      replayed: false,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantId = '00000000-0000-4000-8000-000000000001';
      req.user = {
        uid: '11111111-1111-4111-8111-111111111111',
        role: 'NURSING_STAFF',
        rawRole: 'NURSE',
        roles: ['NURSING_STAFF'],
      };
      next();
    });
    app.use('/api/v1/clinical-inbox', router);

    const response = await request(app)
      .post('/api/v1/clinical-inbox/tasks/73/claim')
      .set('Idempotency-Key', 'claim-73')
      .send({});

    expect(response.statusCode).toBe(200);
    expect(claimInboxTaskMock).toHaveBeenCalledWith({
      tenantId: '00000000-0000-4000-8000-000000000001',
      id: '73',
      actorUid: '11111111-1111-4111-8111-111111111111',
      actorRoles: ['NURSING_STAFF'],
      actorPrimaryRole: 'NURSING_STAFF',
      actorRawRole: 'NURSE',
      idempotencyKey: 'claim-73',
    });
    expect(response.body.message).toBe('Task claimed');
  });

  it.each([
    ['missing key', {}, null],
    ['nonempty body', { actor_uid: 'attacker' }, 'claim-74'],
  ])('rejects an invalid claim envelope: %s', async (_label, body, key) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantId = '00000000-0000-4000-8000-000000000001';
      req.user = {
        uid: '11111111-1111-4111-8111-111111111111',
        role: 'DOCTOR',
        rawRole: 'DOCTOR',
        roles: ['DOCTOR'],
      };
      next();
    });
    app.use('/api/v1/clinical-inbox', router);

    let pending = request(app).post('/api/v1/clinical-inbox/tasks/74/claim');
    if (key) pending = pending.set('Idempotency-Key', key);
    const response = await pending.send(body);

    expect(response.statusCode).toBe(400);
    expect(claimInboxTaskMock).not.toHaveBeenCalled();
  });

  it.each([403, 404])('maps claim service %i to the same generic 403', async (statusCode) => {
    claimInboxTaskMock.mockRejectedValueOnce(Object.assign(new Error('private detail'), { statusCode }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantId = '00000000-0000-4000-8000-000000000001';
      req.user = {
        uid: '11111111-1111-4111-8111-111111111111',
        role: 'DOCTOR',
        rawRole: 'DOCTOR',
        roles: ['DOCTOR'],
      };
      next();
    });
    app.use('/api/v1/clinical-inbox', router);

    const response = await request(app)
      .post('/api/v1/clinical-inbox/tasks/75/claim')
      .set('Idempotency-Key', 'claim-75')
      .send({});

    expect(response.statusCode).toBe(403);
    expect(response.text).not.toContain('private detail');
  });
});
