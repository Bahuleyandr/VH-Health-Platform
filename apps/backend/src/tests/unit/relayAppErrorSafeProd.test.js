import { jest } from '@jest/globals';

// The behavioural pin for relayAppError's opts.safe — it only matters for 5xx
// in PRODUCTION, where sanitizeErrorMessage genericises any 5xx message unless
// the caller marks it confirmed-safe. responseHelper captures NODE_ENV at
// module load, so this file sets production BEFORE the import (do not merge
// these cases into relayAppErrorHelper.test.js, which imports under test env
// and would pass vacuously — that vacuity is exactly the bug this file avoids).
process.env.NODE_ENV = 'production';

const loggerWarnMock = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: loggerWarnMock, error: jest.fn() },
}));

const { relayAppError } = await import('../../utils/responseHelper.js');
const { AppError } = await import('../../utils/AppError.js');

const GENERIC_5XX = 'An internal server error occurred. Please try again later.';

function mockRes() {
  const res = { req: { id: 'req-1', originalUrl: '/api/v1/test' } };
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

afterAll(() => { process.env.NODE_ENV = 'test'; });

describe('relayAppError opts.safe under NODE_ENV=production', () => {
  test('5xx AppError WITHOUT safe: message genericised (baseline)', () => {
    const res = mockRes();
    relayAppError(res, new AppError('Bed sync backend unavailable', 503, 'BED_SYNC_DOWN'), 'Bed error');

    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe(GENERIC_5XX);
    // code still propagates — genericisation touches only the message.
    expect(body.code).toBe('BED_SYNC_DOWN');
  });

  test('5xx AppError WITH opts.safe: hand-written message survives', () => {
    const res = mockRes();
    relayAppError(res, new AppError('Bed sync backend unavailable', 503, 'BED_SYNC_DOWN'), 'Bed error', { safe: true });

    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe('Bed sync backend unavailable');
    expect(body.code).toBe('BED_SYNC_DOWN');
    expect(body).not.toHaveProperty('safe');
  });

  test('4xx AppError: safe is irrelevant, message relays either way', () => {
    const res = mockRes();
    relayAppError(res, AppError.conflict('Bed already occupied', 'BED_OCCUPIED'), 'Bed error', { safe: true });
    expect(res.json.mock.calls[0][0].message).toBe('Bed already occupied');
  });
});
