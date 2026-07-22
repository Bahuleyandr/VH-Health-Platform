import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

const setHoldMock = jest.fn();
const releaseNowMock = jest.fn();

jest.unstable_mockModule('../../services/portal/portalAccessService.js', () => ({
  setStructuredDiagnosticReleaseHold: setHoldMock,
  releaseStructuredDiagnosticResultNow: releaseNowMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../utils/roleHelpers.js', () => ({
  getAuthenticatedActorRoles: (user) => user?.roles || [user?.role].filter(Boolean),
}));

const { default: routes } = await import(
  '../../routes/diagnostics/structuredDiagnosticReleaseRoutes.js'
);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: 'RADIOLOGIST',
    roles: ['RADIOLOGIST'],
  };
  next();
});
app.use('/api/v1/diagnostic-results/release', routes);
app.use((err, _req, res, _next) => {
  res.status(err.statusCode || 500).json({
    success: false,
    message: err.message,
    code: err.code,
  });
});

const GENERATION_ID = '33333333-3333-4333-8333-333333333333';

describe('structured diagnostic release routes', () => {
  beforeEach(() => {
    setHoldMock.mockReset();
    releaseNowMock.mockReset();
  });

  it('rejects body actor fields before the release service runs', async () => {
    const response = await request(app)
      .patch(`/api/v1/diagnostic-results/release/${GENERATION_ID}/hold`)
      .send({
        hold: true,
        reason: 'Specialist review',
        actor_uid: '99999999-9999-4999-8999-999999999999',
      });

    expect(response.statusCode).toBe(400);
    expect(setHoldMock).not.toHaveBeenCalled();
  });

  it('derives the actor from authentication and sets patient audit context', async () => {
    setHoldMock.mockResolvedValueOnce({
      generation_id: GENERATION_ID,
      patient_uid: '22222222-2222-4222-8222-222222222222',
      release_hold: true,
    });

    const response = await request(app)
      .patch(`/api/v1/diagnostic-results/release/${GENERATION_ID}/hold`)
      .send({ hold: true, reason: 'Specialist review' });

    expect(response.statusCode).toBe(200);
    expect(setHoldMock).toHaveBeenCalledWith(
      GENERATION_ID,
      { hold: true, reason: 'Specialist review' },
      expect.objectContaining({
        actorUid: '11111111-1111-4111-8111-111111111111',
        actorRole: 'RADIOLOGIST',
        actorRoles: ['RADIOLOGIST'],
      }),
    );
  });

  it('maps missing and forbidden generations to the same generic denial', async () => {
    setHoldMock.mockRejectedValueOnce(AppError.notFound('Secret PHI-bearing reason'));

    const response = await request(app)
      .patch(`/api/v1/diagnostic-results/release/${GENERATION_ID}/hold`)
      .send({ hold: false });

    expect(response.statusCode).toBe(403);
    expect(response.body.message).toBe(
      'Not authorized to control this diagnostic result release',
    );
    expect(response.text).not.toContain('Secret PHI-bearing reason');
  });

  it('requires an empty early-release body', async () => {
    const response = await request(app)
      .post(`/api/v1/diagnostic-results/release/${GENERATION_ID}/release-now`)
      .send({ reason: 'not supported' });

    expect(response.statusCode).toBe(400);
    expect(releaseNowMock).not.toHaveBeenCalled();
  });
});
