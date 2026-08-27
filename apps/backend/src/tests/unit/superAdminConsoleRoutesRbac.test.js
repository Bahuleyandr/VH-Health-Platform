// src/tests/unit/superAdminConsoleRoutesRbac.test.js
//
// Re-audit finding G (authz). The admin portal declared six consoles
// SUPER_ADMIN-only (apps/admin/src/lib/routePolicy.ts + navConfig.ts — "GDPR
// Erasure", "Encryption Keys", "Migration Toolkit", "SMART-on-FHIR Apps",
// "Feature Flags", "Facility Context") but the backend accepted a plain tenant
// ADMIN on every one of them:
//
//   * `/api/v1/admin` mounts with requireRole(...ADMIN_ROUTE_ROLES), which
//     resolves to ['SUPER_ADMIN', 'ADMIN'] (config/routeRolePolicy.js);
//   * requireSuperAdminStepUp passes non-supers straight through
//     (middleware/rbacMiddleware.js:117), so it narrows nothing for an ADMIN;
//   * encryptionKeyRoutes.js and migrationToolkitRoutes.js had ZERO internal
//     role checks, gdprRoutes.js gated on ADMIN_ROUTE_ROLES in-route,
//     smartFhirRoutes.js gated only production-app approval, and the
//     continuity facility-context routes inside deviceRegistryRoutes.js gated on
//     `requireManage` → `canManage` → `isAdmin`, i.e. the ADMIN device-registry
//     tier.
//
// Net effect before the fix: a plain tenant ADMIN could run an irreversible
// GDPR erasure, commit a migration-toolkit import, rotate/retire/mark-
// compromised the PHI encryption keys, register or revoke SMART apps, and
// enrol or revoke clinical-continuity facility-context capture grants.
//
// (The sixth console, feature flags, was retired outright — migration 742
// dropped the inert `feature_flags` table and the CRUD routes with it, per the
// docs/ROADMAP.md retirement entry — so this suite now pins the five that
// remain.)
//
// This suite pins the in-route SUPER_ADMIN gate on all five, using the REAL
// rbacMiddleware. Sensitive reads are pinned too — the erasure evidence ledger,
// the key registry, the staged-import reports, the live PHI-scoped token list,
// and the capture-grant ledger are each sensitive in their own right, so the
// gate is router-wide (route-wide over the whole continuity prefix, for the
// device registry) rather than mutation-only.
//
// The device registry is the one console where the gate is a PREFIX rather than
// the whole router, so it carries an anti-lockout obligation as well: the rest
// of /api/v1/admin/devices is the STAFF-visible device-registry console
// (routePolicy.ts "devices" → STAFF) and must stay reachable by an ADMIN. The
// final describe pins that in the same run.
//
// ── Why the harness signs real tokens ────────────────────────────────────────
// `req.user` is NOT the token payload. jwtMiddleware canonicalises the role
// claim before any RBAC layer sees it: `canonicalizeRequestRole` maps
// SUPER_ADMIN → ADMIN (utils/roles.js:219-222) and the original claim is kept
// on `rawRole` (jwtMiddleware.js:226, 280). A genuine super-admin bearer
// therefore arrives as `{ role: 'ADMIN', rawRole: 'SUPER_ADMIN' }` and NEVER as
// `role: 'SUPER_ADMIN'`, which is exactly what makes these gates subtle: on
// `role` alone a super-admin and a plain tenant ADMIN are indistinguishable.
// A hand-written `{ role: 'SUPER_ADMIN' }` fixture would certify a shape no
// production request can have, so this suite mints real JWTs with the real
// `generateToken` and runs them through the real jwtMiddleware instead. Only
// the revocation stores, the DB client, and the audit sinks are stubbed, so the
// suite still needs no database.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SUPER_ADMIN_UID = '11111111-1111-4111-8111-111111111111';
const ADMIN_UID = '33333333-3333-4333-8333-333333333333';
const SUBJECT_UID = '22222222-2222-4222-8222-222222222222';

/* ------------------------------ collaborators ----------------------------- */
// Every service is stubbed, so this suite needs no database.

const executeErasure = jest.fn();
const checkLegalHold = jest.fn();
jest.unstable_mockModule('../../services/gdpr/dataErasureService.js', () => ({
  executeErasure,
  checkLegalHold,
}));
jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  deriveTenantIdFromRequest: () => TENANT_ID,
}));

const listEncryptionKeys = jest.fn();
const markKeyCompromised = jest.fn();
const registerEncryptionKey = jest.fn();
const retireEncryptionKey = jest.fn();
const rotateActiveKey = jest.fn();
jest.unstable_mockModule('../../services/security/encryptionKeyRegistryService.js', () => ({
  listEncryptionKeys,
  markKeyCompromised,
  registerEncryptionKey,
  retireEncryptionKey,
  rotateActiveKey,
}));

const commitImportJob = jest.fn();
const createImportJob = jest.fn();
const getAcceptanceReport = jest.fn();
const getRehearsalReport = jest.fn();
const importHl7AdtBatch = jest.fn();
const listImportJobs = jest.fn();
const listMappingProfiles = jest.fn();
const profileSourceFile = jest.fn();
const rehearseImportJob = jest.fn();
const upsertMappingProfile = jest.fn();
jest.unstable_mockModule('../../services/migrationToolkit/migrationToolkitService.js', () => ({
  commitImportJob,
  createImportJob,
  getAcceptanceReport,
  getRehearsalReport,
  importHl7AdtBatch,
  listImportJobs,
  listMappingProfiles,
  profileSourceFile,
  rehearseImportJob,
  upsertMappingProfile,
}));

const exchangeAuthorizationCode = jest.fn();
const issueAuthorizationCode = jest.fn();
const issueLaunchContext = jest.fn();
const listAccessTokens = jest.fn();
const listSmartApps = jest.fn();
const refreshAccessToken = jest.fn();
const registerSmartApp = jest.fn();
const revokeAccessToken = jest.fn();
const verifyAccessToken = jest.fn();
jest.unstable_mockModule('../../services/smartFhir/smartOAuthService.js', () => ({
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  issueLaunchContext,
  listAccessTokens,
  listSmartApps,
  refreshAccessToken,
  registerSmartApp,
  revokeAccessToken,
  verifyAccessToken,
}));

const createDevice = jest.fn();
const getDeviceById = jest.fn();
const listDevices = jest.fn();
const rotateDeviceCredential = jest.fn();
const updateDevice = jest.fn();
jest.unstable_mockModule('../../services/devices/deviceRegistryService.js', () => ({
  createDevice,
  getDeviceById,
  listDevices,
  rotateDeviceCredential,
  updateDevice,
}));

const listAssociations = jest.fn();
jest.unstable_mockModule('../../services/devices/deviceAssociationService.js', () => ({
  listAssociations,
}));
jest.unstable_mockModule('../../services/emr/deviceVitalsService.js', () => ({
  ingestDeviceVitals: jest.fn(),
}));

const enrollClinicalContinuityFacilityGrant = jest.fn();
const listClinicalContinuityFacilityGrants = jest.fn();
const revokeClinicalContinuityFacilityGrant = jest.fn();
jest.unstable_mockModule(
  '../../services/downtime/clinicalContinuityFacilityContextService.js',
  () => ({
    enrollClinicalContinuityFacilityGrant,
    listClinicalContinuityFacilityGrants,
    revokeClinicalContinuityFacilityGrant,
  }),
);
jest.unstable_mockModule(
  '../../services/downtime/clinicalContinuityDeviceLossService.js',
  () => ({
    assertClinicalContinuityDeviceLossActivated: jest.fn(),
    orchestrateClinicalContinuityDeviceLoss: jest.fn(),
  }),
);

const queryRawUnsafe = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => {
  const client = { $queryRaw: jest.fn(), $queryRawUnsafe: queryRawUnsafe };
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

// jwtMiddleware is REAL. Its revocation gate is the only part that reaches an
// external store, so stub the five names it imports (the error class must be a
// real constructor — the middleware does `err instanceof ...`).
class RevocationCheckUnavailableError extends Error {}
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isDelegatedTupleRevoked: jest.fn(async () => false),
  isSubjectDelegationRevoked: jest.fn(async () => false),
  isTokenBlacklisted: jest.fn(async () => false),
  isUserTokensRevoked: jest.fn(async () => false),
  RevocationCheckUnavailableError,
}));

// rbacMiddleware is REAL — only its security-event sink is stubbed, so a denial
// does not try to reach the audit_log table.
const logSecurityEvent = jest.fn();
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({ logSecurityEvent }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

const { default: gdprRoutes } = await import('../../routes/gdprRoutes.js');
const { default: encryptionKeyRoutes } = await import('../../routes/admin/encryptionKeyRoutes.js');
const { default: migrationToolkitRoutes } = await import('../../routes/admin/migrationToolkitRoutes.js');
const { default: smartFhirRoutes } = await import('../../routes/admin/smartFhirRoutes.js');
const { default: deviceRegistryRoutes } = await import('../../routes/admin/deviceRegistryRoutes.js');
const { default: jwtMiddleware } = await import('../../middleware/jwtMiddleware.js');
const { requireRole, requireSuperAdminStepUp } = await import('../../middleware/rbacMiddleware.js');
const { ADMIN_ROUTE_ROLES } = await import('../../config/routeRolePolicy.js');
const { generateToken } = await import('../../utils/jwtUtils.js');

/* --------------------------------- tokens --------------------------------- */

/**
 * Mints an admin-portal bearer the way the real admin realm does.
 *
 * Both admin mints put the RAW `admins.role` in the `role` claim and stamp the
 * admin audience — password login (services/auth/authService.js:448-455) and
 * the 2FA challenge-verify (controllers/auth/adminAuthController.js:582-591).
 * Only the challenge-verify path stamps `mfa: true`; that is the one claim
 * `requireSuperAdminStepUp` accepts as proof of step-up.
 *
 * Admin tokens deliberately carry no int `id` claim, so jwtMiddleware falls
 * back to its cached `users.uid → id` lookup (a `$queryRawUnsafe`, stubbed to
 * return no row here — admins are not `users` rows).
 */
function adminPortalToken(roleClaim, { uid, mfa = false } = {}) {
  return generateToken({
    uid,
    role: roleClaim,
    email: `${roleClaim.toLowerCase()}@hospital.example`,
    sub: uid,
    iss: 'vh-health-backend',
    aud: 'vh-health-admin',
    tenant_id: TENANT_ID,
    ...(mfa ? { mfa: true } : {}),
  }, '5m');
}

// The two bearers that can reach these consoles in production. Note they are
// distinguishable ONLY by `rawRole` once jwtMiddleware has run.
const SUPER_ADMIN_BEARER = adminPortalToken('SUPER_ADMIN', { uid: SUPER_ADMIN_UID, mfa: true });
const ADMIN_BEARER = adminPortalToken('ADMIN', { uid: ADMIN_UID });
// An SSO-issued super-admin bearer: adminOidcSsoService.js:1060 deliberately
// omits `mfa: true`, so it never satisfies the step-up gate.
const SUPER_ADMIN_NO_STEPUP_BEARER = adminPortalToken('SUPER_ADMIN', { uid: SUPER_ADMIN_UID });

/* --------------------------------- harness -------------------------------- */

// Mirrors the production chain: the REAL jwtMiddleware builds req.user from the
// bearer, then tenantContextMiddleware (stood in for here — it is not under
// test) sets req.tenantId. `/api/v1/gdpr` is mounted on its own (app.js:1182);
// the other three are children of the admin barrel (routes/admin/index.js:227,
// 272-273) behind the parent chain at app.js:1695, whose role gate and step-up
// gate are mounted here for real. adminIpAllowlist + adminRateLimiter are the
// remaining parent middleware and are orthogonal to role.
function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.id = 'test-request-id';
    next();
  });
  instance.use(jwtMiddleware);
  instance.use((req, _res, next) => {
    req.tenantId = TENANT_ID;
    next();
  });
  instance.use('/api/v1/gdpr', gdprRoutes);

  const adminBarrel = express.Router();
  // Harness-only sibling with NO in-route gate of its own. It makes the ADMIN
  // refusals below meaningful: it proves the parent chain admits a plain tenant
  // ADMIN, so every 403 on a console can only have come from that console's own
  // requireRole('SUPER_ADMIN').
  adminBarrel.get('/parent-chain-probe', (_req, res) => res.json({ reached: true }));
  adminBarrel.use('/encryption-keys', encryptionKeyRoutes);
  adminBarrel.use('/migration-toolkit', migrationToolkitRoutes);
  adminBarrel.use('/smart-fhir', smartFhirRoutes);
  // routes/admin/index.js:224 — mounted whole. Only its continuity-* prefixes
  // are SUPER_ADMIN; the device-registry routes around them stay ADMIN-tier.
  adminBarrel.use('/devices', deviceRegistryRoutes);
  instance.use(
    '/api/v1/admin',
    requireRole(...ADMIN_ROUTE_ROLES),
    requireSuperAdminStepUp,
    adminBarrel,
  );

  instance.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ code: err.code, message: err.message });
  });
  return instance;
}

const bearer = (token) => `Bearer ${token}`;

// The middleware's uid→id fallback also goes through `$queryRawUnsafe`, so
// "the route never queried" has to be asserted on the route's own SQL.
function sqlCallsMatching(fragment) {
  return queryRawUnsafe.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

beforeEach(() => {
  jest.clearAllMocks();
  checkLegalHold.mockResolvedValue({ hasHold: false });
  executeErasure.mockResolvedValue({ tables_processed: 12, duration_ms: 4 });
  rotateActiveKey.mockResolvedValue({ id: 'key-2', status: 'active' });
  listEncryptionKeys.mockResolvedValue({ keys: [] });
  commitImportJob.mockResolvedValue({ batch_id: 'batch-1', accepted: 3 });
  listImportJobs.mockResolvedValue({ jobs: [] });
  revokeAccessToken.mockResolvedValue({ id: 9, status: 'revoked' });
  listAccessTokens.mockResolvedValue({ tokens: [] });
  listDevices.mockResolvedValue([{ id: 'dev-1', device_code: 'ICU-MON-1', status: 'active' }]);
  createDevice.mockResolvedValue({ id: 'dev-2', device_code: 'ICU-MON-2' });
  updateDevice.mockResolvedValue({ id: 'dev-1', status: 'revoked' });
  listAssociations.mockResolvedValue([]);
  queryRawUnsafe.mockResolvedValue([]);
});

/* ------------------- the shapes jwtMiddleware really emits ---------------- */

describe('the req.user shape these gates actually receive', () => {
  async function userFor(token) {
    const probe = express();
    probe.use(jwtMiddleware);
    probe.get('/whoami', (req, res) => res.json(req.user));
    const res = await request(probe).get('/whoami').set('Authorization', bearer(token));
    expect(res.status).toBe(200);
    return res.body;
  }

  it('collapses a SUPER_ADMIN claim to role=ADMIN and keeps rawRole=SUPER_ADMIN', async () => {
    const user = await userFor(SUPER_ADMIN_BEARER);

    expect(user).toMatchObject({
      uid: SUPER_ADMIN_UID,
      role: 'ADMIN',
      rawRole: 'SUPER_ADMIN',
      scope: 'full',
      mfa: true,
    });
    // The shape the gates must NOT be written against.
    expect(user.role).not.toBe('SUPER_ADMIN');
  });

  it('gives a plain tenant ADMIN the same role, differing only in rawRole', async () => {
    const user = await userFor(ADMIN_BEARER);

    expect(user).toMatchObject({
      uid: ADMIN_UID,
      role: 'ADMIN',
      rawRole: 'ADMIN',
      scope: 'full',
      mfa: false,
    });
  });

  it('leaves ADMIN_ROUTE_ROLES admitting both, so the parent mount narrows nothing', () => {
    expect(ADMIN_ROUTE_ROLES).toEqual(['SUPER_ADMIN', 'ADMIN']);
  });
});

/* ------------------------- mutations: ADMIN is refused -------------------- */

describe('a plain tenant ADMIN is refused on every SUPER_ADMIN console mutation', () => {
  it('clears the parent /api/v1/admin chain, so the refusals below are the consoles own', async () => {
    // requireRole(...ADMIN_ROUTE_ROLES) admits ADMIN and requireSuperAdminStepUp
    // passes non-supers through (rbacMiddleware.js:117) — the parent mount
    // narrows nothing. Without this, a 403 from a broken parent gate would make
    // every refusal below pass for the wrong reason.
    const res = await request(app())
      .get('/api/v1/admin/parent-chain-probe')
      .set('Authorization', bearer(ADMIN_BEARER));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it('403s POST /api/v1/gdpr/erase — irreversible erasure', async () => {
    const res = await request(app())
      .post('/api/v1/gdpr/erase')
      .set('Authorization', bearer(ADMIN_BEARER))
      .send({ uid: SUBJECT_UID, reason: 'data subject request' });

    expect(res.status).toBe(403);
    expect(checkLegalHold).not.toHaveBeenCalled();
    expect(executeErasure).not.toHaveBeenCalled();
  });

  it('403s POST /api/v1/admin/encryption-keys/rotate — PHI key rotation', async () => {
    const res = await request(app())
      .post('/api/v1/admin/encryption-keys/rotate')
      .set('Authorization', bearer(ADMIN_BEARER))
      .send({ new_key_id: 'key-2', provider: 'aws_kms' });

    expect(res.status).toBe(403);
    expect(rotateActiveKey).not.toHaveBeenCalled();
  });

  it('403s POST /api/v1/admin/migration-toolkit/jobs/:jobId/commits — import commit', async () => {
    const res = await request(app())
      .post('/api/v1/admin/migration-toolkit/jobs/job-1/commits')
      .set('Authorization', bearer(ADMIN_BEARER))
      .send({ files: [], idempotency_key: 'idem-1' });

    expect(res.status).toBe(403);
    expect(commitImportJob).not.toHaveBeenCalled();
  });

  it('403s PATCH /api/v1/admin/smart-fhir/tokens/:id/revoke — SMART token revocation', async () => {
    const res = await request(app())
      .patch('/api/v1/admin/smart-fhir/tokens/9/revoke')
      .set('Authorization', bearer(ADMIN_BEARER))
      .send({ revoked_reason: 'rotation' });

    expect(res.status).toBe(403);
    expect(revokeAccessToken).not.toHaveBeenCalled();
  });

  it('403s POST /api/v1/admin/smart-fhir/apps for a SANDBOX app', async () => {
    // Deliberately sandbox: `assertProductionApprovalAllowed` inside the handler
    // refuses production approvals on its own, so a production payload would
    // still 403 with the router-wide gate deleted. A sandbox registration can
    // only be stopped by the gate, which is what this pins.
    const res = await request(app())
      .post('/api/v1/admin/smart-fhir/apps')
      .set('Authorization', bearer(ADMIN_BEARER))
      .send({
        client_id: 'sandbox-app',
        display_name: 'Sandbox App',
        environment: 'sandbox',
        redirect_uris: ['https://app.example.com/cb'],
      });

    expect(res.status).toBe(403);
    expect(registerSmartApp).not.toHaveBeenCalled();
  });

  it('403s POST /api/v1/admin/devices/continuity-facility-context/enroll', async () => {
    const res = await request(app())
      .post('/api/v1/admin/devices/continuity-facility-context/enroll')
      .set('Authorization', bearer(ADMIN_BEARER))
      .send({
        facility_id: 1,
        grant_purpose: 'capture_fixed_device',
        device_id: 'dev-1',
        device_public_key_base64: 'AAAA',
        valid_from: '2026-08-24T00:00:00.000Z',
        valid_until: '2026-08-25T00:00:00.000Z',
      });

    expect(res.status).toBe(403);
    expect(enrollClinicalContinuityFacilityGrant).not.toHaveBeenCalled();
    // The role gate runs AHEAD of requireContinuityEnrollmentEnabled, so an
    // ADMIN never even learns the activation state of the console.
    expect(res.body.code).not.toBe('CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE');
  });

  it('403s POST /api/v1/admin/devices/continuity-facility-context/revoke', async () => {
    const res = await request(app())
      .post('/api/v1/admin/devices/continuity-facility-context/revoke')
      .set('Authorization', bearer(ADMIN_BEARER))
      .send({ facility_id: 1, grant_id: 'grant-1', reason: 'device retired' });

    expect(res.status).toBe(403);
    expect(revokeClinicalContinuityFacilityGrant).not.toHaveBeenCalled();
  });

  it('records the refusal as a PERMISSION_DENIED security event', async () => {
    await request(app())
      .post('/api/v1/admin/encryption-keys/rotate')
      .set('Authorization', bearer(ADMIN_BEARER))
      .send({ new_key_id: 'key-2' });

    expect(logSecurityEvent).toHaveBeenCalledWith('PERMISSION_DENIED', expect.objectContaining({
      userId: ADMIN_UID,
      userRole: 'ADMIN',
      path: '/api/v1/admin/encryption-keys/rotate',
    }));
  });
});

/* --------------------- sensitive reads: ADMIN is refused ------------------ */

describe('a plain tenant ADMIN is refused on the sensitive console reads', () => {
  it('403s GET /api/v1/gdpr/erasure-log — erased-subject identifiers', async () => {
    const res = await request(app())
      .get('/api/v1/gdpr/erasure-log')
      .set('Authorization', bearer(ADMIN_BEARER));

    expect(res.status).toBe(403);
    expect(sqlCallsMatching('gdpr_erasure_log')).toHaveLength(0);
  });

  it('403s GET /api/v1/admin/encryption-keys — the PHI key registry', async () => {
    const res = await request(app())
      .get('/api/v1/admin/encryption-keys')
      .set('Authorization', bearer(ADMIN_BEARER));

    expect(res.status).toBe(403);
    expect(listEncryptionKeys).not.toHaveBeenCalled();
  });

  it('403s GET /api/v1/admin/migration-toolkit/jobs — staged patient-record imports', async () => {
    const res = await request(app())
      .get('/api/v1/admin/migration-toolkit/jobs')
      .set('Authorization', bearer(ADMIN_BEARER));

    expect(res.status).toBe(403);
    expect(listImportJobs).not.toHaveBeenCalled();
  });

  it('403s GET /api/v1/admin/smart-fhir/tokens — live PHI-scoped tokens', async () => {
    const res = await request(app())
      .get('/api/v1/admin/smart-fhir/tokens')
      .set('Authorization', bearer(ADMIN_BEARER));

    expect(res.status).toBe(403);
    expect(listAccessTokens).not.toHaveBeenCalled();
  });

  it('403s GET .../continuity-facility-context/grants — the capture-grant ledger', async () => {
    const res = await request(app())
      .get('/api/v1/admin/devices/continuity-facility-context/grants')
      .set('Authorization', bearer(ADMIN_BEARER));

    expect(res.status).toBe(403);
    expect(listClinicalContinuityFacilityGrants).not.toHaveBeenCalled();
  });
});

/* --------------------------- SUPER_ADMIN still passes --------------------- */

describe('a real SUPER_ADMIN bearer still reaches every console', () => {
  it('200s POST /api/v1/gdpr/erase', async () => {
    const res = await request(app())
      .post('/api/v1/gdpr/erase')
      .set('Authorization', bearer(SUPER_ADMIN_BEARER))
      .send({ uid: SUBJECT_UID, reason: 'data subject request' });

    expect(res.status).toBe(200);
    expect(executeErasure).toHaveBeenCalledWith(expect.objectContaining({
      uid: SUBJECT_UID,
      requestedBy: SUPER_ADMIN_UID,
      tenantId: TENANT_ID,
    }));
  });

  it('201s POST /api/v1/admin/encryption-keys/rotate', async () => {
    const res = await request(app())
      .post('/api/v1/admin/encryption-keys/rotate')
      .set('Authorization', bearer(SUPER_ADMIN_BEARER))
      .send({ new_key_id: 'key-2', provider: 'aws_kms' });

    expect(res.status).toBe(201);
    expect(rotateActiveKey).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      newKeyId: 'key-2',
    }));
  });

  it('201s POST /api/v1/admin/migration-toolkit/jobs/:jobId/commits', async () => {
    const res = await request(app())
      .post('/api/v1/admin/migration-toolkit/jobs/job-1/commits')
      .set('Authorization', bearer(SUPER_ADMIN_BEARER))
      .send({ files: [], idempotency_key: 'idem-1' });

    expect(res.status).toBe(201);
    expect(commitImportJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      jobId: 'job-1',
      idempotencyKey: 'idem-1',
    }));
  });

  it('200s PATCH /api/v1/admin/smart-fhir/tokens/:id/revoke', async () => {
    const res = await request(app())
      .patch('/api/v1/admin/smart-fhir/tokens/9/revoke')
      .set('Authorization', bearer(SUPER_ADMIN_BEARER))
      .send({ revoked_reason: 'rotation' });

    expect(res.status).toBe(200);
    expect(revokeAccessToken).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      id: '9',
    }));
  });

  it('200s the sensitive reads', async () => {
    const instance = app();
    const get = (path) => request(instance).get(path).set('Authorization', bearer(SUPER_ADMIN_BEARER));

    expect((await get('/api/v1/gdpr/erasure-log')).status).toBe(200);
    expect((await get('/api/v1/admin/encryption-keys')).status).toBe(200);
    expect((await get('/api/v1/admin/migration-toolkit/jobs')).status).toBe(200);
    expect((await get('/api/v1/admin/smart-fhir/tokens')).status).toBe(200);
  });

  it('reaches the continuity activation gate instead of a role refusal', async () => {
    // The real behaviour of this console today: CLINICAL_CONTINUITY_C_D14_APPROVED
    // is a compile-time `false` (config/downtimeConfig.js:41), so
    // requireContinuityEnrollmentEnabled answers 503 for EVERY caller. A
    // SUPER_ADMIN therefore sees the same typed absence as before this gate
    // existed — the distinguishing fact is that they got past the role check
    // to see it, where the ADMIN above did not.
    const instance = app();
    const authed = (req) => req.set('Authorization', bearer(SUPER_ADMIN_BEARER));

    const grants = await authed(
      request(instance).get('/api/v1/admin/devices/continuity-facility-context/grants'),
    );
    expect(grants.status).toBe(503);
    expect(grants.body).toMatchObject({
      success: false,
      code: 'CONTINUITY_FACILITY_ENROLLMENT_UNAVAILABLE',
    });

    const enroll = await authed(
      request(instance).post('/api/v1/admin/devices/continuity-facility-context/enroll'),
    ).send({ facility_id: 1 });
    expect(enroll.status).toBe(503);

    const revoke = await authed(
      request(instance).post('/api/v1/admin/devices/continuity-facility-context/revoke'),
    ).send({ facility_id: 1, grant_id: 'grant-1', reason: 'device retired' });
    expect(revoke.status).toBe(503);

    // Activation-locked, so nothing reached the grant service either way.
    expect(listClinicalContinuityFacilityGrants).not.toHaveBeenCalled();
    expect(enrollClinicalContinuityFacilityGrant).not.toHaveBeenCalled();
    expect(revokeClinicalContinuityFacilityGrant).not.toHaveBeenCalled();
  });

  it('still needs the 2FA step-up on the admin-mounted consoles', async () => {
    // The parent mount's `requireSuperAdminStepUp` is unchanged by finding G
    // and applies only to super-admins. An SSO-issued super-admin bearer (no
    // `mfa` claim) is refused there — the documented recovery is the local TOTP
    // challenge (rbacMiddleware.js:99-102).
    const res = await request(app())
      .get('/api/v1/admin/encryption-keys')
      .set('Authorization', bearer(SUPER_ADMIN_NO_STEPUP_BEARER));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUPER_ADMIN_MFA_REQUIRED');
    expect(listEncryptionKeys).not.toHaveBeenCalled();

    // /api/v1/gdpr is NOT under /api/v1/admin (app.js:1182), so it inherits no
    // step-up — the same bearer still reaches the erasure ledger there.
    const gdpr = await request(app())
      .get('/api/v1/gdpr/erasure-log')
      .set('Authorization', bearer(SUPER_ADMIN_NO_STEPUP_BEARER));
    expect(gdpr.status).toBe(200);
  });
});

/* ----------------- anti-lockout: the device registry stays ADMIN ---------- */

describe('the device-registry console around the continuity prefix stays ADMIN-reachable', () => {
  // deviceRegistryRoutes is the one router where the SUPER_ADMIN gate is a
  // PREFIX, not the whole file. routePolicy.ts declares "devices" STAFF-rank and
  // /dashboard/devices is a live ADMIN-visible console, so widening the gate to
  // `router.use(requireRole('SUPER_ADMIN'))` would be a lockout. These pin the
  // boundary: everything outside continuity-* keeps its `requireManage`
  // (canManage → isAdmin) tier.
  const adminReq = (method, path) =>
    request(app())[method](path).set('Authorization', bearer(ADMIN_BEARER));

  it('200s GET /api/v1/admin/devices — the registry list', async () => {
    const res = await adminReq('get', '/api/v1/admin/devices');

    expect(res.status).toBe(200);
    expect(listDevices).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID }));
  });

  it('200s GET /api/v1/admin/devices/associations', async () => {
    const res = await adminReq('get', '/api/v1/admin/devices/associations');

    expect(res.status).toBe(200);
    expect(listAssociations).toHaveBeenCalled();
  });

  it('201s POST /api/v1/admin/devices — a requireManage mutation', async () => {
    const res = await adminReq('post', '/api/v1/admin/devices')
      .send({ device_code: 'ICU-MON-2', kind: 'monitor' });

    expect(res.status).toBe(201);
    expect(createDevice).toHaveBeenCalled();
  });

  it('200s POST /api/v1/admin/devices/:id/revoke — a requireManage mutation', async () => {
    const res = await adminReq('post', '/api/v1/admin/devices/dev-1/revoke').send({});

    expect(res.status).toBe(200);
    expect(updateDevice).toHaveBeenCalledWith(expect.objectContaining({
      id: 'dev-1',
      patch: { status: 'revoked' },
    }));
  });

  it('does not let the /:id route swallow the continuity prefix', async () => {
    // '/continuity-facility-context' would match `router.get('/:id')` — which is
    // ungated — if the specific routes were ever moved below it. Registration
    // order is what keeps the gate reachable, so pin it.
    const res = await adminReq('get', '/api/v1/admin/devices/continuity-facility-context/grants');

    expect(res.status).toBe(403);
    expect(getDeviceById).not.toHaveBeenCalled();
  });
});
