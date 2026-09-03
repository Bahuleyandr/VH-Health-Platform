// Pre-auth identity paths must work on an RLS-subject connection.
//
// Background (measured 2026-09-03 on a 762-tip database): migration 758 put
// the RESTRICTIVE policy `explicit_tenant_context_753` on public.users (and
// 166 other FORCE-RLS tables carry one). With app.current_tenant_id unset
// those tables return ZERO rows to an RLS-subject role and reject every
// INSERT/UPDATE with 42501, even when tenant_id is named in the statement.
// Production connects as vhhealth_runtime (NOSUPERUSER, NOBYPASSRLS, not the
// owner), so every statement outside setTenant/setTenantTx runs that way. CI
// connects as a superuser, which bypasses RLS even under FORCE, so a superuser
// connection proves nothing here.
//
// Before the fix the pre-auth handlers under /api/v1/auth had no tenant
// context at all: the first Firebase login of a new patient failed on the
// users INSERT, a returning patient was invisible to the lookup and treated as
// new, and the hospital-number helper could not see the row it had just
// created. This suite makes the connection RLS-subject the way production is
// (pool pinned to ONE connection, SET ROLE to the non-owner, non-superuser
// rls_test_app role that ci-setup-db.mjs provisions), then:
//   1. pins the hazard at the SQL layer (bare INSERT rejected);
//   2. the control (same INSERT inside setTenantTx accepted);
//   3. drives the REAL HTTP path — POST /api/v1/auth/firebase/firebase-login —
//      through preAuthTenantContextMiddleware for a new patient;
//   4. logs the same patient in again and expects the existing row, not a
//      duplicate INSERT;
//   5. drives the legacy registration service under the same tenant context
//      the middleware provides.

import { jest } from '@jest/globals';
import request from 'supertest';

const BASE_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const DB_CONFIGURED = Boolean(BASE_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const APP_ROLE = 'rls_test_app';
const API_KEY = process.env.API_KEY || 'test-api-key';
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const FIREBASE_UID = `preauth-rls-${Date.now()}`;
const suffix = String(Date.now() % 1000000).padStart(6, '0');
const PHONE_FIREBASE = `+91777${suffix}1`;
const PHONE_LEGACY = `+91777${suffix}2`;

function singleConnectionUrl(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '1');
  parsed.searchParams.set('pool_timeout', '20');
  return parsed.toString();
}

// Firebase Admin is the only external dependency of the first-login path.
const verifyIdTokenMock = jest.fn();
jest.unstable_mockModule('../utils/firebaseAdmin.js', () => ({
  default: { auth: () => ({ verifyIdToken: verifyIdTokenMock }) },
}));

let prisma;
let setTenantTx;
let runInTenantContext;
let app;
let legacyRegisterUser;
let savedEnv;

const INSERT_NEW_PATIENT = `INSERT INTO users (
  tenant_id, phone, firebase_uid, role, registered_at, updated_at, last_sign_in_at,
  name, email, email_verified
) VALUES ($1::uuid, $2, $3, $4, NOW(), NOW(), NOW(), $5, $6, $7)
RETURNING id, uid`;

async function selectByPhone(phone) {
  return setTenantTx(DEFAULT_TENANT_ID, (tx) => tx.$queryRawUnsafe(
    'SELECT uid, phone, tenant_id, last_sign_in_at FROM users WHERE phone = $1',
    phone,
  ));
}

function firebaseLogin(userAgent) {
  return request(app)
    .post('/api/v1/auth/firebase/firebase-login')
    .set('Host', 'localhost')
    .set('X-API-Key', API_KEY)
    .set('User-Agent', userAgent)
    .send({ idToken: 'firebase-id-token', deviceType: 'mobile' });
}

d('pre-auth identity paths under an RLS-subject connection', () => {
  beforeAll(async () => {
    savedEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      AUTH_ENFORCE_TENANT_RLS: process.env.AUTH_ENFORCE_TENANT_RLS,
      AUTH_TENANT_RLS_RUNTIME_ROLE: process.env.AUTH_TENANT_RLS_RUNTIME_ROLE,
      AUTH_TENANT_RLS_TEST_ROLE: process.env.AUTH_TENANT_RLS_TEST_ROLE,
    };
    // Mirror production: enforcement on, tenant transactions SET LOCAL ROLE to
    // the runtime role. The single-connection pool is what lets a session-level
    // SET ROLE below make the BARE path RLS-subject as well.
    process.env.DATABASE_URL = singleConnectionUrl(BASE_DATABASE_URL);
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;
    delete process.env.AUTH_TENANT_RLS_TEST_ROLE;

    ({ default: prisma, setTenantTx } = await import('../lib/prisma.js'));
    ({ runInTenantContext } = await import('../lib/tenantContext.js'));
    ({ legacyRegisterUser } = await import('../services/auth/firebaseAuthService.js'));
    ({ default: app } = await import('../app.js'));

    await prisma.$executeRawUnsafe(`SET ROLE ${APP_ROLE}`);
    const [who] = await prisma.$queryRawUnsafe(
      'SELECT current_user::text AS current_role, session_user::text AS session_role',
    );
    expect(who.current_role).toBe(APP_ROLE);
  }, 120_000);

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.$executeRawUnsafe('RESET ROLE');
      // The text[] parameter is a real array argument (bound to $1), not the
      // spread-params mistake the raw-params lint guards against.
      const probePhones = [PHONE_FIREBASE, PHONE_LEGACY, `+91777${suffix}8`, `+91777${suffix}9`];
      await prisma.$executeRawUnsafe(
        'DELETE FROM users WHERE phone = ANY($1::text[]) OR firebase_uid LIKE $2',
        probePhones,
        `${FIREBASE_UID}%`,
      );
    } catch (err) {
      // Best-effort cleanup; a superuser session_user can always RESET ROLE.
      console.warn('preauth RLS cleanup failed:', err?.message);
    }
    await prisma.$disconnect();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 60_000);

  beforeEach(() => {
    verifyIdTokenMock.mockReset();
    verifyIdTokenMock.mockResolvedValue({
      uid: FIREBASE_UID,
      phone_number: PHONE_FIREBASE,
      email: null,
      email_verified: false,
    });
  });

  test('the hazard: a users INSERT outside a tenant transaction is rejected by explicit_tenant_context_753', async () => {
    let failure = null;
    try {
      await prisma.$transaction((tx) => tx.$queryRawUnsafe(
        INSERT_NEW_PATIENT,
        DEFAULT_TENANT_ID,
        `+91777${suffix}9`,
        `${FIREBASE_UID}-bare`,
        'PATIENT',
        'Bare Transaction Probe',
        null,
        false,
      ));
    } catch (err) {
      failure = err;
    }
    expect(failure).not.toBeNull();
    const text = `${failure?.message || ''} ${failure?.meta?.message || ''} ${failure?.meta?.code || ''}`;
    expect(text).toMatch(/explicit_tenant_context_753|42501/);
  }, 30_000);

  test('a same-tenant INSERT inside setTenantTx is accepted (control for the hazard)', async () => {
    const rows = await setTenantTx(DEFAULT_TENANT_ID, async (tx) => {
      const inserted = await tx.$queryRawUnsafe(
        INSERT_NEW_PATIENT,
        DEFAULT_TENANT_ID,
        `+91777${suffix}8`,
        `${FIREBASE_UID}-scoped`,
        'PATIENT',
        'Scoped Transaction Probe',
        null,
        false,
      );
      await tx.$queryRawUnsafe('DELETE FROM users WHERE uid = $1::uuid', inserted[0].uid);
      return inserted;
    });
    expect(rows).toHaveLength(1);
  }, 30_000);

  test('first Firebase login of a new patient registers through the real HTTP path', async () => {
    const res = await firebaseLogin('preauth-rls-deep-first-login');

    expect(res.status).toBe(200);
    expect(res.body?.data?.isNewUser).toBe(true);
    expect(res.body?.data?.user).toMatchObject({ phone: PHONE_FIREBASE, role: 'PATIENT' });
    const rows = await selectByPhone(PHONE_FIREBASE);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].tenant_id)).toBe(DEFAULT_TENANT_ID);
  }, 60_000);

  test('the same patient logging in again is recognised, not re-registered', async () => {
    const before = await selectByPhone(PHONE_FIREBASE);
    expect(before).toHaveLength(1);

    const res = await firebaseLogin('preauth-rls-deep-second-login');

    expect(res.status).toBe(200);
    expect(res.body?.data?.isNewUser).toBe(false);
    expect(res.body?.data?.user?.uid).toBe(before[0].uid);
    const after = await selectByPhone(PHONE_FIREBASE);
    expect(after).toHaveLength(1);
    expect(new Date(after[0].last_sign_in_at).getTime())
      .toBeGreaterThanOrEqual(new Date(before[0].last_sign_in_at).getTime());
  }, 60_000);

  test('legacy registration of a new patient completes under the pre-auth tenant context', async () => {
    const result = await runInTenantContext(DEFAULT_TENANT_ID, () => legacyRegisterUser(
      {
        phone: PHONE_LEGACY,
        name: 'Preauth RLS Legacy',
        gender: 'OTHER',
        email: null,
        birthday: '1990-01-01',
        anniversary: null,
        address: null,
      },
      {
        hostname: 'localhost',
        headers: { host: 'localhost', 'user-agent': 'preauth-rls-deep-legacy' },
        connection: { remoteAddress: '127.0.0.1' },
        ip: '127.0.0.1',
        body: {},
      },
      { deviceType: 'web' },
    ));

    expect(result.user).toMatchObject({ phone: PHONE_LEGACY, role: 'PATIENT' });
    const rows = await selectByPhone(PHONE_LEGACY);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].tenant_id)).toBe(DEFAULT_TENANT_ID);
  }, 60_000);
});
