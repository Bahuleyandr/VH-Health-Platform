/**
 * middleware/appCheckMiddleware.js — Firebase App Check report contract.
 *
 * Pins the safe first rollout: only patient/staff traffic is observed, every
 * token is bound to that client's configured Firebase app IDs, and no outcome
 * can reject a request.
 */

import fs from 'node:fs';
import path from 'node:path';
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

const PATIENT_APP_ID = '1:155620159512:android:patient';
const STAFF_APP_ID = '1:155620159512:android:staff';
const TOKEN_HEADER = { 'x-firebase-appcheck': 'the-app-check-token' };

function makeReq(overrides = {}) {
  const headers = overrides.headers || {};
  return {
    id: 'req-123',
    apiClient: 'patient',
    get: name => headers[String(name).toLowerCase()],
    ...overrides,
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

let savedEnv;

beforeEach(() => {
  jest.clearAllMocks();
  savedEnv = {
    mode: process.env.APP_CHECK_MODE,
    patientAppIds: process.env.FIREBASE_APP_CHECK_PATIENT_APP_IDS,
    staffAppIds: process.env.FIREBASE_APP_CHECK_STAFF_APP_IDS,
  };
  process.env.FIREBASE_APP_CHECK_PATIENT_APP_IDS = PATIENT_APP_ID;
  process.env.FIREBASE_APP_CHECK_STAFF_APP_IDS = STAFF_APP_ID;
});

afterEach(() => {
  for (const [name, value] of [
    ['APP_CHECK_MODE', savedEnv.mode],
    ['FIREBASE_APP_CHECK_PATIENT_APP_IDS', savedEnv.patientAppIds],
    ['FIREBASE_APP_CHECK_STAFF_APP_IDS', savedEnv.staffAppIds],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

  it.each(['audit', 'enforce'])('treats unsupported mode %s as off', async mode => {
    process.env.APP_CHECK_MODE = mode;
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
  beforeEach(() => { process.env.APP_CHECK_MODE = 'report'; });

  it('skips non-app API clients untouched', async () => {
    const next = jest.fn();

    await appCheckMiddleware()(makeReq({ apiClient: 'admin' }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(verifyTokenMock).not.toHaveBeenCalled();
    expect(recordAppCheckOutcomeMock).not.toHaveBeenCalled();
  });

  it('skips requests with no apiClient', async () => {
    const next = jest.fn();

    await appCheckMiddleware()(makeReq({ apiClient: undefined }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it('uses an exact expected client on the pre-gate patient Firebase mount', async () => {
    const next = jest.fn();

    await appCheckMiddleware({ expectedClient: 'patient' })(
      makeReq({ apiClient: undefined }), makeRes(), next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('missing', 'patient');
  });
});

describe('appCheckMiddleware — report mode', () => {
  beforeEach(() => { process.env.APP_CHECK_MODE = 'report'; });

  it('records a missing token without rejecting', async () => {
    const next = jest.fn();
    const res = makeRes();

    await appCheckMiddleware()(makeReq(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('missing', 'patient');
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('records a Firebase-rejected token without logging its contents', async () => {
    const err = new Error('App check token has expired');
    err.code = 'app-check/invalid-argument';
    verifyTokenMock.mockRejectedValueOnce(err);
    const next = jest.fn();

    await appCheckMiddleware()(makeReq({ apiClient: 'staff', headers: TOKEN_HEADER }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('invalid', 'staff');
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('the-app-check-token');
  });

  it('records an infrastructure failure as unverifiable without rejecting', async () => {
    verifyTokenMock.mockRejectedValueOnce(new Error('Firebase not configured'));
    const next = jest.fn();
    const res = makeRes();

    await appCheckMiddleware()(makeReq({ headers: TOKEN_HEADER }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('unverifiable', 'patient');
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it('accepts and records a token from the configured app-ID set', async () => {
    process.env.FIREBASE_APP_CHECK_PATIENT_APP_IDS = `other-id, ${PATIENT_APP_ID}`;
    verifyTokenMock.mockResolvedValueOnce({ app_id: PATIENT_APP_ID });
    const next = jest.fn();
    const req = makeReq({ headers: TOKEN_HEADER });

    await appCheckMiddleware()(req, makeRes(), next);

    expect(verifyTokenMock).toHaveBeenCalledWith('the-app-check-token');
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.appCheck).toEqual({ appId: PATIENT_APP_ID, verified: true });
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('verified', 'patient');
  });

  it('records a valid token from the wrong Firebase app as invalid', async () => {
    verifyTokenMock.mockResolvedValueOnce({ app_id: STAFF_APP_ID });
    const next = jest.fn();
    const req = makeReq({ headers: TOKEN_HEADER });

    await appCheckMiddleware()(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.appCheck).toBeUndefined();
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('invalid', 'patient');
  });

  it('records a missing expected app-ID list as unverifiable', async () => {
    delete process.env.FIREBASE_APP_CHECK_PATIENT_APP_IDS;
    verifyTokenMock.mockResolvedValueOnce({ app_id: PATIENT_APP_ID });
    const next = jest.fn();

    await appCheckMiddleware()(makeReq({ headers: TOKEN_HEADER }), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(recordAppCheckOutcomeMock).toHaveBeenCalledWith('unverifiable', 'patient');
  });
});

describe('App Check mounts', () => {
  it('pre-gates only patient Firebase auth and leaves OTP and SSO outside the scope', () => {
    const appSource = fs.readFileSync(path.resolve(process.cwd(), 'src/app.js'), 'utf8');

    expect(appSource).toContain("app.use('/api/v1/auth', patientRateLimiter);");
    expect(appSource).toContain(
      "app.use('/api/v1/auth/firebase', appCheckMiddleware({ expectedClient: 'patient' }));",
    );
    expect(appSource).toContain("app.use('/api/v1/auth', routes.auth);");
    expect(appSource).toContain("app.use('/api/v1/otp', patientRateLimiter, routes.otp);");
    expect(appSource).not.toMatch(/app\.use\('\/api\/v1\/auth',[^;]*appCheckMiddleware/);
    expect(appSource).not.toMatch(/app\.use\('\/api\/v1\/otp',[^;]*appCheckMiddleware/);
  });
});
