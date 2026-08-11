import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const generateTokenMock = jest.fn(() => 'signed-ws-ticket');
jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  generateToken: generateTokenMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: realtimeTicketRoutes } = await import('../../routes/realtime/realtimeTicketRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.tenantId = 'tenant-1';
  req.user = {
    uid: 'user-1',
    role: 'PATIENT',
    jti: 'access-jti-after-refresh',
    sessionFamilyId: 'session-family-1',
    stableDeviceId: 'device-1',
  };
  next();
});
app.use('/api/v1/realtime', realtimeTicketRoutes);

describe('POST /api/v1/realtime/ticket session binding', () => {
  beforeEach(() => {
    generateTokenMock.mockClear();
  });

  it('binds the short-lived ticket to the parent access-token session', async () => {
    const response = await request(app).post('/api/v1/realtime/ticket');

    expect(response.status).toBe(200);
    expect(generateTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'ws',
        sessionFamilyId: 'session-family-1',
        stableDeviceId: 'device-1',
      }),
      '60s',
    );
  });
});
