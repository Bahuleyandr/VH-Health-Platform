import { jest } from '@jest/globals';

// Shared route-catch relay — the single implementation of the pattern #598
// (maternity) and #602 (paediatric) fixed file-locally. Every route/controller
// catch block that used to call `error(res, err.message, err.statusCode)` (and
// so dropped `err.code` + `err.details`) delegates here instead.
//
// Contract (mirrors the two reference fixes byte-for-byte in behaviour):
//   * AppError-shaped (statusCode set): relay message + status, lift `code` to
//     the response root via error()'s topLevel mechanism, nest `details`.
//     No `safe` flag — message sanitization identical to before.
//   * Anything else: logger.error(`<label>:`, err) server-side; client gets a
//     hand-written generic 500 — never raw err.message (sanitize only
//     genericises 5xx in production, so relaying would leak on non-prod).

const loggerErrorMock = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: loggerErrorMock },
}));

const { relayAppError } = await import('../../utils/responseHelper.js');
const { AppError } = await import('../../utils/AppError.js');

function mockRes() {
  const res = { req: { id: 'req-1', originalUrl: '/api/v1/test' } };
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => loggerErrorMock.mockReset());

describe('relayAppError', () => {
  test('AppError with code AND details: code at root, details nested', () => {
    const res = mockRes();
    relayAppError(res, AppError.conflict('link not exact', 'LINK_NOT_EXACT', { newborn_count: 2 }), 'Test error');

    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0][0];
    expect(body).toMatchObject({
      success: false,
      message: 'link not exact',
      code: 'LINK_NOT_EXACT',
      details: { newborn_count: 2 },
      requestId: 'req-1',
    });
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  test('AppError with code, no details: code at root, no details key', () => {
    const res = mockRes();
    relayAppError(res, new AppError('not configured', 422, 'IMMUNISATION_SCHEDULE_NOT_CONFIGURED'), 'Test error');

    expect(res.status).toHaveBeenCalledWith(422);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('IMMUNISATION_SCHEDULE_NOT_CONFIGURED');
    expect(body).not.toHaveProperty('details');
  });

  test('statusCode-bearing error WITHOUT a code (e.g. multer): relays status, adds no code key', () => {
    const res = mockRes();
    const err = new Error('File too large');
    err.statusCode = 413;
    relayAppError(res, err, 'Upload error');

    expect(res.status).toHaveBeenCalledWith(413);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe('File too large');
    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('details');
  });

  test('non-AppError: generic 500 with the caller label, raw message only in the server log', () => {
    const res = mockRes();
    relayAppError(res, new Error("Cannot read properties of undefined (reading 'uid')"), 'Dialysis error');

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe('Dialysis error');
    expect(body.message).not.toMatch(/uid/);
    // Server-side visibility is preserved.
    expect(loggerErrorMock).toHaveBeenCalledWith('Dialysis error:', expect.any(Error));
  });

  test('default label when the caller passes none', () => {
    const res = mockRes();
    relayAppError(res, new Error('boom'));

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].message).toBe('Request failed');
    expect(loggerErrorMock).toHaveBeenCalledWith('Request failed:', expect.any(Error));
  });
});
