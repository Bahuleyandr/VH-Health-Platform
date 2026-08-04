/**
 * utils/firebaseAdmin.js — initialisation + graceful-degradation contract.
 *
 * Added alongside the firebase-admin 13 → 14 migration. CLAUDE.md pins two
 * rules this module is the sole implementation of:
 *   "External services (R2, Firebase) must degrade gracefully — never crash at
 *    import time"
 *   "Firebase mock fallback: if Firebase credentials missing, rejects auth
 *    calls with clear error instead of crashing"
 *
 * Three suites mock this module and assume a `.auth()` / `.messaging()` facade
 * (patientAccountDeletion.deep, firebaseAuthService, firebaseAuthServiceCoverage),
 * but nothing exercised the real thing. v14 moved initialisation from
 * `admin.initializeApp` + `admin.credential.*` + `admin.apps` to the modular
 * firebase-admin/app entry point, so the wiring is pinned here.
 */

import { jest } from '@jest/globals';

const initializeApp = jest.fn();
const cert = jest.fn(options => ({ __credential: 'cert', options }));
const applicationDefault = jest.fn(() => ({ __credential: 'adc' }));
const getApps = jest.fn(() => []);
jest.unstable_mockModule('firebase-admin/app', () => ({
  initializeApp, cert, applicationDefault, getApps,
}));

const authInstance = { verifyIdToken: jest.fn(), revokeRefreshTokens: jest.fn(), listUsers: jest.fn() };
const getAuth = jest.fn(() => authInstance);
jest.unstable_mockModule('firebase-admin/auth', () => ({ getAuth }));

const messagingInstance = { send: jest.fn(), sendEachForMulticast: jest.fn() };
const getMessaging = jest.fn(() => messagingInstance);
jest.unstable_mockModule('firebase-admin/messaging', () => ({ getMessaging }));

const loggerWarn = jest.fn();
const loggerInfo = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: loggerInfo, warn: loggerWarn, error: jest.fn(), debug: jest.fn() },
}));

const FIREBASE_ENV_KEYS = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_USE_APPLICATION_DEFAULT',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

const savedEnv = {};

beforeEach(() => {
  jest.clearAllMocks();
  getApps.mockReturnValue([]);
  for (const k of FIREBASE_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of FIREBASE_ENV_KEYS) {
    if (savedEnv[k] === undefined) { delete process.env[k]; } else { process.env[k] = savedEnv[k]; }
  }
});

/** Re-executes the module so its import-time initialisation runs against current env. */
async function loadFirebaseAdmin() {
  jest.resetModules();
  const mod = await import('../../utils/firebaseAdmin.js');
  return mod.default;
}

describe('firebaseAdmin — credentials absent (graceful degradation)', () => {
  it('does not throw at import time', async () => {
    await expect(loadFirebaseAdmin()).resolves.toBeDefined();
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it('logs a warning rather than failing the boot', async () => {
    await loadFirebaseAdmin();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Firebase Admin not initialized'),
      'Missing Firebase Admin credentials',
    );
  });

  it('rejects auth calls at CALL time with a clear error', async () => {
    const firebaseAdmin = await loadFirebaseAdmin();
    await expect(firebaseAdmin.auth().verifyIdToken('token'))
      .rejects.toThrow('Firebase not configured');
    await expect(firebaseAdmin.auth().createUser({}))
      .rejects.toThrow('Firebase not configured');
  });

  it('rejects messaging calls at CALL time with a clear error', async () => {
    const firebaseAdmin = await loadFirebaseAdmin();
    await expect(firebaseAdmin.messaging().send({}))
      .rejects.toThrow('Firebase not configured');
  });

  it('never reaches the real SDK getters', async () => {
    const firebaseAdmin = await loadFirebaseAdmin();
    firebaseAdmin.auth();
    firebaseAdmin.messaging();
    expect(getAuth).not.toHaveBeenCalled();
    expect(getMessaging).not.toHaveBeenCalled();
  });

  it('exposes only the stub surface — revokeRefreshTokens/listUsers stay undefined', async () => {
    // Pre-existing v13 behaviour, deliberately preserved by the v14 migration.
    const firebaseAdmin = await loadFirebaseAdmin();
    const auth = firebaseAdmin.auth();
    expect(typeof auth.verifyIdToken).toBe('function');
    expect(typeof auth.createUser).toBe('function');
    expect(auth.revokeRefreshTokens).toBeUndefined();
    expect(auth.listUsers).toBeUndefined();
  });
});

describe('firebaseAdmin — cert credentials', () => {
  beforeEach(() => {
    process.env.FIREBASE_PROJECT_ID = 'vh-test';
    process.env.FIREBASE_CLIENT_EMAIL = 'svc@vh-test.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN KEY-----\\nline1\\nline2\\n-----END KEY-----';
  });

  it('initialises from a cert credential', async () => {
    await loadFirebaseAdmin();
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(cert).toHaveBeenCalledTimes(1);
    expect(applicationDefault).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith('Firebase Admin initialized from environment credentials');
  });

  it('unescapes literal \\n sequences in the private key', async () => {
    await loadFirebaseAdmin();
    expect(cert).toHaveBeenCalledWith({
      projectId: 'vh-test',
      clientEmail: 'svc@vh-test.iam.gserviceaccount.com',
      privateKey: '-----BEGIN KEY-----\nline1\nline2\n-----END KEY-----',
    });
  });

  it('delegates to the modular getters, resolved lazily per call', async () => {
    const firebaseAdmin = await loadFirebaseAdmin();
    expect(getAuth).not.toHaveBeenCalled();

    expect(firebaseAdmin.auth()).toBe(authInstance);
    expect(firebaseAdmin.messaging()).toBe(messagingInstance);
    expect(getAuth).toHaveBeenCalledTimes(1);
    expect(getMessaging).toHaveBeenCalledTimes(1);
  });
});

describe('firebaseAdmin — application default credentials', () => {
  it('initialises via applicationDefault when the flag is set', async () => {
    process.env.FIREBASE_PROJECT_ID = 'vh-test';
    process.env.FIREBASE_USE_APPLICATION_DEFAULT = 'true';

    await loadFirebaseAdmin();

    expect(applicationDefault).toHaveBeenCalledTimes(1);
    expect(cert).not.toHaveBeenCalled();
    expect(initializeApp).toHaveBeenCalledWith({
      projectId: 'vh-test',
      credential: { __credential: 'adc' },
    });
    expect(loggerInfo).toHaveBeenCalledWith('Firebase Admin initialized from application default credentials');
  });

  it('also triggers on GOOGLE_APPLICATION_CREDENTIALS', async () => {
    process.env.FIREBASE_PROJECT_ID = 'vh-test';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/etc/creds.json';

    await loadFirebaseAdmin();

    expect(applicationDefault).toHaveBeenCalledTimes(1);
  });

  it('degrades when the project id is missing, even with the flag set', async () => {
    process.env.FIREBASE_USE_APPLICATION_DEFAULT = 'true';

    const firebaseAdmin = await loadFirebaseAdmin();

    expect(initializeApp).not.toHaveBeenCalled();
    await expect(firebaseAdmin.auth().verifyIdToken('t')).rejects.toThrow('Firebase not configured');
  });
});

describe('firebaseAdmin — app already initialised', () => {
  it('does not initialise a second app', async () => {
    getApps.mockReturnValue([{ name: '[DEFAULT]' }]);
    process.env.FIREBASE_PROJECT_ID = 'vh-test';
    process.env.FIREBASE_CLIENT_EMAIL = 'svc@vh-test.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = 'key';

    const firebaseAdmin = await loadFirebaseAdmin();

    expect(initializeApp).not.toHaveBeenCalled();
    // Still the real facade, not the stub.
    expect(firebaseAdmin.auth()).toBe(authInstance);
  });
});
