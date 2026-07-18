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
const listInboxTasksMock = jest.fn();

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  acknowledgeTask: acknowledgeTaskMock,
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

  it('exposes ONLY GET /tasks/inbox and POST /tasks/:id/acknowledge', () => {
    expect(routes).toEqual([
      { path: '/tasks/inbox', methods: ['get'] },
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
        roles: ['CMO'],
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
      actorRoles: ['CMO'],
      breakGlassId: 41,
    });
    expect(finishedPhiContext).toMatchObject({ patientUid });
  });
});
