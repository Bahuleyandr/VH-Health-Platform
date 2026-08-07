/**
 * middleware/appCheckMiddleware.js — Firebase App Check verification contract.
 *
 * Pins the staged-rollout behaviour:
 *   - APP_CHECK_MODE=off (or unknown) is a zero-overhead passthrough;
 *   - only patient/staff API clients are in scope (integration/admin surfaces
 *     exempt), unless mounted with assumeAppFacing on the pre-gate mobile
 *     entry mounts;
 *   - report mode NEVER rejects a request;
 *   - enforce mode rejects missing/invalid tokens with 401 but still FAILS
 *     OPEN on infrastructure failures (Firebase outage / not configured);
 *   - every acted-on request records exactly one app_check_requests_total
 *     outcome.
 */

import { jest } from '@jest/globals';

const verifyTokenMock = jest.fn();
jest.unstable_mockModule('../../utils/firebaseAdmin.js', () => ({
  default: { appCheck: () => ({ verifyToken: verifyTokenMock }) },
}));

const loggerDebug = jest.fn();
const loggerWarn = jest.fn();
const loggerError = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), debug: loggerDebug, warn: loggerWarn, error: loggerError },
}));

const recordAppCheckOutcomeMock = jest.fn();
jest.unstable_mockModule('../../middleware/prometheusMiddleware.js', () => ({
  recordAppCheckOutcome: recordAppCheckOutcomeMock,
}));

const { default: appCheckMiddleware } = await import('../../middleware/appCheckMiddleware.js');

function makeReq(overrides = {}) {
  const headers = overrides.headers || {};
  return {
    id: 'req-123',
    apiClient: 'patient',
    get: (name) => headers[String(name).toLowerCase()],
    ...overrides,
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

const TOKEN_HEADER = { 'x-firebase-appcheck': 'the-app-check-token' };

let savedMode;

beforeEach(() => {
  jest.clearAllMocks();
  savedMode = process.env.APP_CHECK_MODE;
});

afterEach(() => {
  if (savedMode === undefined) { delete process.env.APP_CHECK_MODE; } else { process.env.APP_CHECK_MODE = savedMode; }
});

describe('appCheckMiddleware — off mode', () => {
  it('passes through without verifying or recording anything', async () => {
    process.env.APP_CHECK_MODE = 'off';
    const next = jest.fn();

    await appCheckMiddleware()(makeReq({ headers: TOKEN_HEADER }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(verifyTokenMock).not.toHaveBeenCalled();
    expect(recordAppCheckOutcomeMock).not.toHaveBeenCalled();
  });

  it('treats an unknown APP_CHECK_MODE value as off', async () => {
    process.env.APP_CHECK_MODE = 'audit';
    const next = jest.fn();

    await appCheckMiddleware()(makeReq({ headers: TOKEN_HEADER }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(verifyTokenMock).not.toHaveBeenCalled();
    expect(recordAppCheckOutcomeMock).not.toHaveBeenCalled();
  });

  it('defaults to off when APP_CHECK_MODE is unset', async () => {
    delete process.env.APP_CHECK_MODE;
    const next = jest.fn();

    await appCheckMiddleware()(makeReq({ headers: TOKEN_HEADER }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });
});

describe('appCheckMiddleware — scope filter', () => {
  it('skips non-mobile API clients untouched (admin)', async () => {
    process.env.APP_CHECK_MODE = 'enforce';
    const next = jest.fn();

    await appCheckMiddleware()(makeReq({ apiClient: 'admin' }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(verifyTokenMock).not.toHaveBeenCalled();
    expect(recordAppCheckOutcomeMock).not.toHaveBeenCalled();
  });

  it('skips requests with no apiClient at all (integration surfaces)', async () => {
    process.env.APP_CHECK_MODE = 'enforce';
    const next = jest.fn();

    await appCheckMiddleware()(makeReq({ apiClient: undefined }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it('acts without an apiClient when assumeAppFacing is set (pre-gate mounts)', async () => {
    process.env.APP_CHECK_MODE = 'report';
    const next = jest.fn();

    await appCheckMiddleware({ assumeAppFacing: true })(
      makeReq({ apiClient: undefined }), makeRes(), next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('missing', undefined);
  });
});

describe('appCheckMiddleware — report mode', () => {
  beforeEach(() => { process.env.APP_CHECK_MODE = 'report'; });

  it('missing token → next(), records `missing`, never rejects', async () => {
    const next = jest.fn();
    const res = makeRes();

    await appCheckMiddleware()(makeReq(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('missing', 'patient');
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('invalid token → next(), records `invalid`, warns without token contents', async () => {
    const err = new Error('App check token has expired');
    err.code = 'app-check/invalid-argument';
    verifyTokenMock.mockRejectedValueOnce(err);
    const next = jest.fn();
    const res = makeRes();

    await appCheckMiddleware()(makeReq({ apiClient: 'staff', headers: TOKEN_HEADER }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('invalid', 'staff');
    expect(loggerWarn).toHaveBeenCalledWith('App Check token invalid', {
      requestId: 'req-123',
      client: 'staff',
      code: 'app-check/invalid-argument',
    });
    const warnPayload = JSON.stringify(loggerWarn.mock.calls);
    expect(warnPayload).not.toContain('the-app-check-token');
  });

  it('valid token → next(), sets req.appCheck, records `verified`', async () => {
    verifyTokenMock.mockResolvedValueOnce({ appId: '1:155620159512:android:abc', token: {} });
    const next = jest.fn();
    const req = makeReq({ headers: TOKEN_HEADER });

    await appCheckMiddleware()(req, makeRes(), next);

    expect(verifyTokenMock).toHaveBeenCalledWith('the-app-check-token');
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.appCheck).toEqual({ appId: '1:155620159512:android:abc', verified: true });
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('verified', 'patient');
  });
});

describe('appCheckMiddleware — enforce mode', () => {
  beforeEach(() => { process.env.APP_CHECK_MODE = 'enforce'; });

  it('missing token → 401, next NOT called', async () => {
    const next = jest.fn();
    const res = makeRes();

    await appCheckMiddleware()(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ success: false, message: 'App Check token required' });
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('missing', 'patient');
  });

  it('invalid token → 401, next NOT called', async () => {
    const err = new Error('Decoding App Check token failed');
    err.code = 'app-check/invalid-argument';
    verifyTokenMock.mockRejectedValueOnce(err);
    const next = jest.fn();
    const res = makeRes();

    await appCheckMiddleware()(makeReq({ headers: TOKEN_HEADER }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ success: false, message: 'App Check token invalid' });
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('invalid', 'patient');
  });

  it('valid token → next()', async () => {
    verifyTokenMock.mockResolvedValueOnce({ appId: '1:155620159512:ios:def', token: {} });
    const next = jest.fn();
    const res = makeRes();
    const req = makeReq({ headers: TOKEN_HEADER });

    await appCheckMiddleware()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(req.appCheck).toEqual({ appId: '1:155620159512:ios:def', verified: true });
  });

  it('infrastructure failure (no app-check/* code) → FAILS OPEN, records `unverifiable`', async () => {
    // The firebaseAdmin degradation stub rejects with exactly this shape.
    verifyTokenMock.mockRejectedValueOnce(new Error('Firebase not configured'));
    const next = jest.fn();
    const res = makeRes();

    await appCheckMiddleware()(makeReq({ headers: TOKEN_HEADER }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('unverifiable', 'patient');
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
