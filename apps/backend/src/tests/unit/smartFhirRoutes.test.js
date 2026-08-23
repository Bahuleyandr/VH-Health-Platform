// src/tests/unit/smartFhirRoutes.test.js
//
// The admin SMART-on-FHIR console (routes/admin/smartFhirRoutes.js) is
// SUPER_ADMIN-only. `req.user` is NOT the token payload: jwtMiddleware
// canonicalises the role claim first — `canonicalizeRequestRole` maps
// SUPER_ADMIN → ADMIN (utils/roles.js:219-222) and keeps the original claim on
// `rawRole` (jwtMiddleware.js:226, 280) — so a genuine super-admin bearer
// reaches this router as `{ role: 'ADMIN', rawRole: 'SUPER_ADMIN' }`, never as
// `role: 'SUPER_ADMIN'`. A hand-written `{ role: 'SUPER_ADMIN' }` fixture would
// certify a shape production cannot produce and would hide exactly the defect
// this suite now covers: `assertProductionApprovalAllowed` used to test
// `req.user.role !== 'SUPER_ADMIN'` and therefore refused production-app
// approval to every real super-admin token. So the harness signs real JWTs with
// the real `generateToken` and runs them through the real jwtMiddleware; only
// the OAuth service, the revocation stores, the DB client and the audit sink
// are stubbed, and the suite still needs no database.

import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SUPER_ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const ADMIN_UID = '33333333-3333-4333-8333-333333333333';

const issueAuthorizationCodeMock = jest.fn(async () => ({
  authz: { id: 1 },
  plaintext_code: 'vh_authz_test',
}));
const issueLaunchContextMock = jest.fn(async () => ({
  context: { id: 2 },
  launch: 'vh_launch_test',
}));
const registerSmartAppMock = jest.fn(async () => ({
  app: { id: 3 },
  plaintext_client_secret: null,
}));

jest.unstable_mockModule('../../services/smartFhir/smartOAuthService.js', () => ({
  exchangeAuthorizationCode: jest.fn(),
  issueAuthorizationCode: issueAuthorizationCodeMock,
  issueLaunchContext: issueLaunchContextMock,
  listAccessTokens: jest.fn(),
  listSmartApps: jest.fn(),
  refreshAccessToken: jest.fn(),
  registerSmartApp: registerSmartAppMock,
  revokeAccessToken: jest.fn(),
  verifyAccessToken: jest.fn(),
}));

// The router mounts the REAL requireRole('SUPER_ADMIN') gate, which emits a
// PERMISSION_DENIED security event on refusal. Stub the sink so this suite
// stays database-free.
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: jest.fn(),
}));

// jwtMiddleware is REAL. Its revocation gate is the only part that reaches an
// external store, and it resolves `users.uid → id` through Prisma for tokens
// that carry no int `id` claim (every admin-portal token). Stub both.
class RevocationCheckUnavailableError extends Error {}
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isDelegatedTupleRevoked: jest.fn(async () => false),
  isSubjectDelegationRevoked: jest.fn(async () => false),
  isTokenBlacklisted: jest.fn(async () => false),
  isUserTokensRevoked: jest.fn(async () => false),
  RevocationCheckUnavailableError,
}));
jest.unstable_mockModule('../../lib/prisma.js', () => {
  const client = { $queryRaw: jest.fn(), $queryRawUnsafe: jest.fn(async () => []) };
  return {
    default: client,
    prisma: client,
    prismaReadOnly: client,
    setTenant: async (_tenantId, fn) => fn(client),
    setTenantTx: async (_tenantId, fn) => fn(client),
    pickTenantClient: () => client,
    circuitBreakerStatus: () => ({ open: false }),
  };
});
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    http: jest.fn(), verbose: jest.fn(), silly: jest.fn(), log: jest.fn(),
  },
}));

const { default: smartFhirRouter } = await import('../../routes/admin/smartFhirRoutes.js');
const { default: jwtMiddleware } = await import('../../middleware/jwtMiddleware.js');
const { generateToken } = await import('../../utils/jwtUtils.js');

/**
 * Mints an admin-portal bearer the way the real admin realm does: the RAW
 * `admins.role` goes in the `role` claim, the audience is the admin realm, and
 * only the 2FA challenge-verify path stamps `mfa: true`
 * (controllers/auth/adminAuthController.js:582-591).
 */
function adminPortalToken(roleClaim, uid) {
  return generateToken({
    uid,
    role: roleClaim,
    email: `${roleClaim.toLowerCase()}@hospital.example`,
    sub: uid,
    iss: 'vh-health-backend',
    aud: 'vh-health-admin',
    tenant_id: TENANT_ID,
    mfa: true,
  }, '5m');
}

const SUPER_ADMIN_BEARER = adminPortalToken('SUPER_ADMIN', SUPER_ADMIN_UID);
const ADMIN_BEARER = adminPortalToken('ADMIN', ADMIN_UID);

// In production this router is mounted at /api/v1/admin/smart-fhir behind
// requireRole(...ADMIN_ROUTE_ROLES) + requireSuperAdminStepUp (app.js:1695,
// routes/admin/index.js:272); that parent chain is pinned by
// superAdminConsoleRoutesRbac.test.js. Here the router is mounted directly so
// the assertions are about its own behaviour, with the REAL jwtMiddleware in
// front of it and a stand-in for tenantContextMiddleware behind it.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(jwtMiddleware);
  app.use((req, _res, next) => {
    req.tenantId = TENANT_ID;
    next();
  });
  app.use('/smart-fhir', smartFhirRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ code: err.code, message: err.message });
  });
  return app;
}

const bearer = (token) => `Bearer ${token}`;

describe('the req.user shape this console actually receives', () => {
  it('hands a super-admin bearer to the router as role=ADMIN + rawRole=SUPER_ADMIN', async () => {
    const probe = express();
    probe.use(jwtMiddleware);
    probe.get('/whoami', (req, res) => res.json(req.user));

    const res = await request(probe).get('/whoami').set('Authorization', bearer(SUPER_ADMIN_BEARER));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      uid: SUPER_ADMIN_UID,
      role: 'ADMIN',
      rawRole: 'SUPER_ADMIN',
      scope: 'full',
    });
    // The shape `assertProductionApprovalAllowed` must NOT be written against.
    expect(res.body.role).not.toBe('SUPER_ADMIN');
  });
});

describe('admin SMART authorize helper gate', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFlag = process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED;

  beforeEach(() => {
    issueAuthorizationCodeMock.mockClear();
    issueLaunchContextMock.mockClear();
    registerSmartAppMock.mockClear();
    delete process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalFlag === undefined) delete process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED;
    else process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED = originalFlag;
  });

  it('blocks the helper in production unless explicitly enabled', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(buildApp())
      .post('/smart-fhir/authorize')
      .set('Authorization', bearer(SUPER_ADMIN_BEARER))
      .send({ client_id: 'app1', redirect_uri: 'https://app.example/cb', scope: 'patient/Patient.read' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SMART_ADMIN_AUTHORIZE_DISABLED');
    expect(issueAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it('blocks the helper outside production unless explicitly enabled', async () => {
    const res = await request(buildApp())
      .post('/smart-fhir/authorize')
      .set('Authorization', bearer(SUPER_ADMIN_BEARER))
      .send({ client_id: 'app1', redirect_uri: 'https://app.example/cb', scope: 'patient/Patient.read' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SMART_ADMIN_AUTHORIZE_DISABLED');
    expect(issueAuthorizationCodeMock).not.toHaveBeenCalled();
  });

  it('allows the helper only when explicitly enabled', async () => {
    process.env.SMART_FHIR_ADMIN_AUTHORIZE_ENABLED = 'true';
    const res = await request(buildApp())
      .post('/smart-fhir/authorize')
      .set('Authorization', bearer(SUPER_ADMIN_BEARER))
      .send({ client_id: 'app1', redirect_uri: 'https://app.example/cb', scope: 'patient/Patient.read' });
    expect(res.status).toBe(201);
    expect(issueAuthorizationCodeMock).toHaveBeenCalled();
  });
});

describe('admin SMART registration and launch helpers', () => {
  beforeEach(() => {
    issueLaunchContextMock.mockClear();
    registerSmartAppMock.mockClear();
  });

  it('blocks tenant admins from registering even a sandbox app', async () => {
    // Previously this asserted SMART_PRODUCTION_APPROVAL_ROLE_REQUIRED — the
    // only internal check, which let a plain ADMIN register sandbox apps. The
    // router-wide SUPER_ADMIN gate now refuses the ADMIN before the handler.
    // The payload is deliberately SANDBOX: a production payload would still be
    // refused by `assertProductionApprovalAllowed` even with the router-wide
    // gate deleted, so only a sandbox registration proves the gate is doing it.
    const res = await request(buildApp())
      .post('/smart-fhir/apps')
      .set('Authorization', bearer(ADMIN_BEARER))
      .send({
        client_id: 'sandbox-app',
        display_name: 'Sandbox App',
        environment: 'sandbox',
        redirect_uris: ['https://app.example.com/cb'],
      });
    expect(res.status).toBe(403);
    expect(registerSmartAppMock).not.toHaveBeenCalled();
  });

  it('blocks tenant admins from activating a production app', async () => {
    const res = await request(buildApp())
      .post('/smart-fhir/apps')
      .set('Authorization', bearer(ADMIN_BEARER))
      .send({
        client_id: 'prod-app',
        display_name: 'Prod App',
        environment: 'production',
        status: 'active',
        redirect_uris: ['https://app.example.com/cb'],
      });
    expect(res.status).toBe(403);
    expect(registerSmartAppMock).not.toHaveBeenCalled();
  });

  it('lets a real super-admin bearer activate a production app', async () => {
    // Regression guard for the latent 403: `assertProductionApprovalAllowed`
    // tested `req.user.role !== 'SUPER_ADMIN'`, which is true for EVERY genuine
    // super-admin token (jwtMiddleware canonicalises the claim to 'ADMIN'), so
    // production approval was refused to everyone. It now tests role OR
    // rawRole, the same pair requireRole tests.
    const res = await request(buildApp())
      .post('/smart-fhir/apps')
      .set('Authorization', bearer(SUPER_ADMIN_BEARER))
      .send({
        client_id: 'prod-app',
        display_name: 'Prod App',
        environment: 'production',
        status: 'active',
        registration_status: 'production_approved',
        redirect_uris: ['https://app.example.com/cb'],
      });
    expect(res.status).toBe(201);
    expect(res.body.code).toBeUndefined();
    expect(registerSmartAppMock).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'prod-app',
      environment: 'production',
      registrationStatus: 'production_approved',
      // The approver recorded on the app is the super-admin's uid.
      approvedBy: SUPER_ADMIN_UID,
    }));
  });

  it('issues admin-created launch contexts for public authorize', async () => {
    const res = await request(buildApp())
      .post('/smart-fhir/launch-contexts')
      .set('Authorization', bearer(SUPER_ADMIN_BEARER))
      .send({
        client_id: 'app1',
        requested_scopes: ['launch/patient', 'patient/Observation.read'],
        patient_uid: '22222222-2222-4222-8222-222222222222',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.launch).toBe('vh_launch_test');
    expect(issueLaunchContextMock).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'app1',
      patientUid: '22222222-2222-4222-8222-222222222222',
    }));
  });
});
