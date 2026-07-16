import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for theatreRoutes.js (relayAppError port).
//
// Every catch in theatreRoutes.js guards on `err.isOperational` and relayed
// AppErrors via `error(res, err.message, err.statusCode)` with no 4th arg,
// dropping `err.code` and `err.details` on the wire — so the WHO time-out /
// pre-op-blocker 400s were anonymous to clients. The port swaps only the
// operational branch for the shared relay (responseHelper.relayAppError) and
// keeps the non-operational tail (logger + next(err)) byte-identical — these
// are gateway surfaces where global-handler/Sentry visibility is deliberate.

const updateStatusMock = jest.fn();
const getTodayScheduleMock = jest.fn();
const cancelSurgeryMock = jest.fn();

jest.unstable_mockModule('../../services/theatre/theatreService.js', () => ({
  default: {
    scheduleSurgery: jest.fn(),
    getTodaySchedule: getTodayScheduleMock,
    getAvailableRooms: jest.fn(),
    updateStatus: updateStatusMock,
    completeChecklist: jest.fn(),
    cancelSurgery: cancelSurgeryMock,
  },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitOrBoardEvent: jest.fn(),
}));

const { default: theatreRoutes } = await import('../../routes/theatre/theatreRoutes.js');

const tailSpy = jest.fn();

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/theatre', theatreRoutes);
// Stand-in for the global error handler — pins the preserved next(err) tail.
app.use((err, _req, res, _next) => {
  tailSpy(err);
  res.status(500).json({ success: false, message: 'Handled by global error middleware' });
});

beforeEach(() => {
  updateStatusMock.mockReset();
  getTodayScheduleMock.mockReset();
  cancelSurgeryMock.mockReset();
  tailSpy.mockReset();
});

describe('theatre route catches relay AppError code + details', () => {
  test('operational AppError carries code and details over HTTP', async () => {
    updateStatusMock.mockRejectedValueOnce(AppError.conflict('msg', 'SOME_CODE', { reason: 'x' }));

    const response = await request(app)
      .put('/api/v1/theatre/12/status')
      .send({ status: 'in_progress' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('msg');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    expect(tailSpy).not.toHaveBeenCalled();
  });

  test('operational AppError without details produces no details key', async () => {
    getTodayScheduleMock.mockRejectedValueOnce(
      AppError.notFound('No OT schedule exists for this date', 'OT_SCHEDULE_NOT_FOUND'),
    );

    const response = await request(app).get('/api/v1/theatre/today');

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('OT_SCHEDULE_NOT_FOUND');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-operational error keeps the next(err) tail — global handler receives it, nothing leaks', async () => {
    const boom = new Error("Cannot read properties of undefined (reading 'ot_room')");
    cancelSurgeryMock.mockRejectedValueOnce(boom);

    const response = await request(app).delete('/api/v1/theatre/12');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Handled by global error middleware');
    expect(response.body.message).not.toMatch(/ot_room/);
    expect(tailSpy).toHaveBeenCalledTimes(1);
    expect(tailSpy.mock.calls[0][0]).toBe(boom);
  });
});
