import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — wrap-sweep sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602).
//
// orBoardRoutes.js wraps every handler in a local `wrap()` whose catch
// branch must relay a thrown AppError as the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). Before the
// relayAppError port the catch dropped `err.code`/`err.details` AND relayed
// raw `err.message` on the 500 branch (`err.message || 'OR board error'`).
// The port hardens the 500 to the generic message only. A booking conflict
// carrying its clash details is exactly the case a scheduling client needs
// to branch on.

const scheduleWithConflictCheckMock = jest.fn();
const getOrBoardMock = jest.fn();

jest.unstable_mockModule('../../services/theatre/orBoardService.js', () => ({
  listOrRooms: jest.fn(async () => []),
  upsertOrRoom: jest.fn(async () => ({})),
  listProcedures: jest.fn(async () => []),
  findConflicts: jest.fn(async () => []),
  scheduleWithConflictCheck: scheduleWithConflictCheckMock,
  getOrBoard: getOrBoardMock,
  getDailyThroughput: jest.fn(async () => ({})),
  getWeeklySafetyCompliance: jest.fn(async () => ({})),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

// realtimeEmitter pulls in prisma + wsServer — keep the unit test DB-free.
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitOrBoardEvent: jest.fn(),
}));

const { default: orBoardRoutes } = await import('../../routes/theatre/orBoardRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'OT_NURSE' };
  next();
});
app.use('/api/v1/theatre', orBoardRoutes);

beforeEach(() => {
  scheduleWithConflictCheckMock.mockReset();
  getOrBoardMock.mockReset();
});

describe('OR board route wrap() surfaces AppError code + details', () => {
  test('an AppError conflict relays statusCode, code, and details over HTTP', async () => {
    scheduleWithConflictCheckMock.mockRejectedValueOnce(AppError.conflict(
      'OT-3 is already booked for the requested slot',
      'OR_BOOKING_CONFLICT',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/theatre/bookings')
      .send({
        patient_uid: '22222222-2222-4222-8222-222222222222',
        ot_room: 'OT-3',
        scheduled_date: '2026-07-20',
        scheduled_time: '10:00',
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('OR_BOOKING_CONFLICT');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old catch relayed `err.message || 'OR board error'` — this pins
    // the hardened generic-only behaviour.
    getOrBoardMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'ot_schedule')"),
    );

    const response = await request(app).get('/api/v1/theatre/board');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('OR board error');
    expect(response.body.message).not.toMatch(/ot_schedule/);
  });
});
