import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const tenantId = '00000000-0000-4000-8000-000000000001';
const authenticatedActor = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
const forgedActor = { uid: '22222222-2222-4222-8222-222222222222', role: 'SUPER_ADMIN' };
const services = {
  scheduleSession: jest.fn(),
  startSession: jest.fn(),
  completeSession: jest.fn(),
  cancelSession: jest.fn(),
  recordReuseRegister: jest.fn(),
};

jest.unstable_mockModule('../../services/clinical/dialysisService.js', () => services);
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../../services/clinical/dialysisMachineService.js', () => ({
  ingestMachineObservations: jest.fn(),
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitDialysisEvent: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => tenantId,
}));
jest.unstable_mockModule('../../middleware/routePatientAccessGuards.js', () => ({
  routePatientGuard: () => (_req, _res, next) => next(),
  selectorTenantOf: () => null,
  positiveIntOrNull: () => null,
}));

const { default: dialysisRoutes } = await import('../../routes/clinical/dialysisRoutes.js');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'trusted-actor-request';
  req.user = authenticatedActor;
  next();
});
app.use('/api/v1/dialysis', dialysisRoutes);

beforeEach(() => {
  for (const service of Object.values(services)) {
    service.mockReset().mockResolvedValue({ id: 23, status: 'recorded' });
  }
});

describe('dialysis existing-handler authenticated actor bridge', () => {
  test.each([
    ['scheduleSession', '/sessions', 'conducted_by'],
    ['startSession', '/sessions/23/start', 'started_by'],
    ['completeSession', '/sessions/23/complete', 'completed_by'],
    ['cancelSession', '/sessions/23/cancel', 'cancelled_by'],
    ['recordReuseRegister', '/sessions/23/reuse-register', 'processed_by'],
  ])('%s discards forged body actor and role while preserving its response', async (serviceName, path, attributionField) => {
    const response = await request(app).post(`/api/v1/dialysis${path}`).send({
      actor: forgedActor,
      actorRole: forgedActor.role,
      role: forgedActor.role,
      [attributionField]: forgedActor.uid,
      dialysis_patient_id: 7,
      session_date: '2026-09-08',
      tenantId: '33333333-3333-4333-8333-333333333333',
      reason: 'clinical reason',
      not_connected: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      message: 'Success',
      data: { id: 23, status: 'recorded' },
      requestId: 'trusted-actor-request',
    });
    expect(services[serviceName]).toHaveBeenCalledTimes(1);
    const [input] = services[serviceName].mock.calls[0];
    expect(input.actor).toEqual(authenticatedActor);
    expect(input.actorRole).toBe(authenticatedActor.role);
    expect(input.role).toBe(authenticatedActor.role);
    expect(input[attributionField]).toBe(authenticatedActor.uid);
    expect(input.tenantId).toBe(tenantId);
    expect(input.reason).toBe('clinical reason');
    expect(input.not_connected).toBe(true);
  });
});
