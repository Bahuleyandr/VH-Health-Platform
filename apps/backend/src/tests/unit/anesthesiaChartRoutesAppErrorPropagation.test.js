import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — wrap-sweep sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602).
//
// anesthesiaChartRoutes.js wraps every handler in a local `wrap()` whose
// catch branch must relay a thrown AppError as the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). Before the
// relayAppError port the catch dropped `err.code`/`err.details` AND relayed
// raw `err.message` on the 500 branch (`err.message || 'Anesthesia error'`).
// The port hardens the 500 to the generic message only.

const recordEntryMock = jest.fn();
const listForCaseMock = jest.fn();

jest.unstable_mockModule('../../services/theatre/anesthesiaChartService.js', () => ({
  recordEntry: recordEntryMock,
  listForCase: listForCaseMock,
  totalsForCase: jest.fn(async () => ({})),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: anesthesiaChartRoutes } = await import('../../routes/theatre/anesthesiaChartRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ANESTHETIST' };
  next();
});
app.use('/api/v1/anesthesia', anesthesiaChartRoutes);

beforeEach(() => {
  recordEntryMock.mockReset();
  listForCaseMock.mockReset();
});

describe('anesthesia chart route wrap() surfaces AppError code + details', () => {
  test('an AppError conflict relays statusCode, code, and details over HTTP', async () => {
    recordEntryMock.mockRejectedValueOnce(AppError.conflict(
      'The anaesthesia record for this case is already signed',
      'ANESTHESIA_RECORD_SIGNED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/anesthesia/entries')
      .send({ ot_schedule_id: 12, hr: 78, spo2: 99 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('ANESTHESIA_RECORD_SIGNED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old catch relayed `err.message || 'Anesthesia error'` — this pins
    // the hardened generic-only behaviour.
    listForCaseMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'anesthesia_chart_entries')"),
    );

    const response = await request(app).get('/api/v1/anesthesia/entries/case/12');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Anesthesia error');
    expect(response.body.message).not.toMatch(/anesthesia_chart_entries/);
  });
});
