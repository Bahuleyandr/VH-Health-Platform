import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { jest } from '@jest/globals';

process.env.JWT_SECRET ||= 'test-jwt-secret-for-ci-must-be-at-least-32-chars';
process.env.TENANT_BASE_HOST = 'localhost';

const TENANT_A = '10000000-0000-4000-8000-00000000000a';
const TENANT_B = '10000000-0000-4000-8000-00000000000b';
const ADMIN_A = '20000000-0000-4000-8000-00000000000a';
const ADMIN_B = '20000000-0000-4000-8000-00000000000b';
const SUPER_ADMIN = '20000000-0000-4000-8000-0000000000ff';
const ISSUER = 'https://idp.test/realms/vh-admin';
const CLIENT_ID = 'vh-admin';
const PROVIDER_KEY = 'keycloak';

const setTenantMock = jest.fn();
const queryRawUnsafe = jest.fn();
const getTenantBySlug = jest.fn();
const issueAccessTokenAndClaimSession = jest.fn();
const generateRefreshToken = jest.fn();
const logSecurityEvent = jest.fn();

jest.unstable_mockModule('../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
  setTenant: setTenantMock,
}));

jest.unstable_mockModule('../services/tenant/tenantService.js', () => ({
  getTenantBySlug,
}));

jest.unstable_mockModule('../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession,
  generateRefreshToken,
}));

jest.unstable_mockModule('../utils/fieldEncryption.js', () => ({
  encryptField: (value) => `enc:${value}`,
  decryptField: () => 'client-secret',
}));

jest.unstable_mockModule('../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../utils/securityAuditLogger.js', () => ({
  logSecurityEvent,
}));

const {
  completeAdminOidcCallback,
  discoverAdminOidcProvidersForRequest,
  invalidateAdminOidcProviderCache,
  OIDC_STATE_COOKIE,
  startAdminOidcLogin,
} = await import('../services/auth/adminOidcSsoService.js');
const { requireSuperAdminStepUp } = await import('../middleware/rbacMiddleware.js');

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'kid-admin',
  alg: 'RS256',
  use: 'sig',
};

let scenario;
let auditEvents;
let issuedPayload;

function tenantProvider(tenantId = TENANT_A) {
  return {
    id: tenantId === TENANT_A ? 11 : 12,
    tenant_id: tenantId,
    is_platform_provider: false,
    realm: 'admin',
    protocol: 'oidc',
    provider_key: PROVIDER_KEY,
    display_name: 'Keycloak',
    status: 'active',
    oidc_issuer: ISSUER,
    oidc_discovery_url: null,
    oidc_jwks_uri: 'https://idp.test/jwks',
    oidc_authorization_endpoint: 'https://idp.test/auth',
    oidc_token_endpoint: 'https://idp.test/token',
    oidc_userinfo_endpoint: null,
    oidc_client_id: CLIENT_ID,
    oidc_client_secret_ciphertext: 'enc:client-secret',
    group_claim_name: 'groups',
    allowed_domains: [],
    required_claims: {},
    policy: {},
  };
}

function platformProvider() {
  return {
    ...tenantProvider(null),
    id: 99,
    tenant_id: null,
    is_platform_provider: true,
  };
}

function admin(uid, email, role = 'ADMIN', tenantId = TENANT_A) {
  return {
    uid,
    username: email,
    email,
    name: email.split('@')[0],
    role,
    status: 'active',
    tenant_id: tenantId,
  };
}

function resetScenario(overrides = {}) {
  auditEvents = [];
  issuedPayload = null;
  scenario = {
    provider: tenantProvider(TENANT_A),
    idPayload: {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'idp-subject-a',
      email: 'admin-a@example.test',
      groups: ['vh-admins'],
    },
    mappingRows: [{ idp_group: 'vh-admins', vh_role: 'ADMIN', priority: 100 }],
    adminByTenant: {
      [TENANT_A]: [admin(ADMIN_A, 'admin-a@example.test', 'ADMIN', TENANT_A)],
      [TENANT_B]: [admin(ADMIN_B, 'admin-b@example.test', 'ADMIN', TENANT_B)],
      platform: [admin(SUPER_ADMIN, 'super@example.test', 'SUPER_ADMIN', null)],
    },
    failAudit: false,
    ...overrides,
  };
  invalidateAdminOidcProviderCache();
}

function signIdToken(payload = scenario.idPayload) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: now - 10,
      exp: now + 300,
      nonce: scenario.nonce,
      ...payload,
    },
    pair.privateKey,
    { algorithm: 'RS256', keyid: 'kid-admin' },
  );
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function req({ adminHost = 'tenant-a-admin.localhost:3001', host = '127.0.0.1:5206', cookie = '', query = {} } = {}) {
  return {
    id: 'req-test',
    ip: '127.0.0.1',
    protocol: 'http',
    headers: {
      host,
      cookie,
      'user-agent': 'jest',
      'x-forwarded-proto': 'http',
    },
    query: {
      admin_host: adminHost,
      returnTo: '/dashboard',
      deviceType: 'web',
      ...query,
    },
  };
}

function stateCookieFrom(header) {
  const cookie = header.split(';', 1)[0];
  expect(cookie.startsWith(`${OIDC_STATE_COOKIE}=`)).toBe(true);
  return cookie;
}

function auditFromParams(params) {
  return {
    tenantId: params[0],
    providerId: params[1],
    providerKey: params[2],
    eventType: params[3],
    outcome: params[4],
    localUid: params[6],
    issuer: params[7],
    subjectHash: params[8],
    assertionHash: params[9],
    stateHash: params[10],
    details: params[14] ? JSON.parse(params[14]) : {},
  };
}

async function routeQuery(sql, ...params) {
  const compact = sql.replace(/\s+/g, ' ');
  if (compact.includes('FROM tenant_identity_providers')) {
    const platformQuery = compact.includes('tenant_id IS NULL');
    if (platformQuery !== Boolean(scenario.provider.is_platform_provider)) return [];
    if (compact.includes('provider_key') && !params.includes(PROVIDER_KEY)) return [];
    return [scenario.provider];
  }

  if (compact.includes('INSERT INTO identity_audit_events')) {
    if (scenario.failAudit) throw new Error('audit store down');
    auditEvents.push(auditFromParams(params));
    return [];
  }

  if (compact.includes('FROM tenant_idp_role_mappings')) {
    return scenario.mappingRows;
  }

  if (compact.includes('FROM federated_identities')) {
    return scenario.linkedAdmin ? [scenario.linkedAdmin] : [];
  }

  if (compact.includes('FROM admins')) {
    const [email, role, tenantId] = params;
    const key = tenantId ? String(tenantId) : 'platform';
    return (scenario.adminByTenant[key] || [])
      .filter((row) => row.email.toLowerCase() === String(email).toLowerCase())
      .filter((row) => row.role === role)
      .slice(0, 2);
  }

  if (compact.includes('INSERT INTO federated_identities')) return [];
  if (compact.includes('UPDATE federated_identities')) return [];
  if (compact.includes('UPDATE admins')) return [];
  return [];
}

async function startAndComplete({ startAdminHost = 'tenant-a-admin.localhost:3001', callbackHost = '127.0.0.1:5206' } = {}) {
  const start = await startAdminOidcLogin({
    req: req({ adminHost: startAdminHost }),
    providerKey: PROVIDER_KEY,
  });
  const redirectUrl = new URL(start.redirectUrl);
  scenario.nonce = redirectUrl.searchParams.get('nonce');
  const state = redirectUrl.searchParams.get('state');
  const cookie = stateCookieFrom(start.stateCookie);

  const idToken = signIdToken();
  global.fetch = jest.fn(async (url) => {
    if (String(url) === scenario.provider.oidc_token_endpoint) {
      return jsonResponse({ id_token: idToken });
    }
    if (String(url) === scenario.provider.oidc_jwks_uri) {
      return jsonResponse({ keys: [jwk] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  return completeAdminOidcCallback({
    req: req({ host: callbackHost, cookie, query: { admin_host: undefined } }),
    providerKey: PROVIDER_KEY,
    code: 'auth-code',
    state,
  });
}

function invokeStepUp(user) {
  const request = {
    user,
    ip: '127.0.0.1',
    method: 'POST',
    originalUrl: '/api/v1/admin/identity/sso/oidc/providers/keycloak',
    headers: { 'user-agent': 'jest' },
  };
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalled = false;
  requireSuperAdminStepUp(request, response, () => { nextCalled = true; });
  return { response, nextCalled };
}

describe('admin OIDC SSO broker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetScenario();
    getTenantBySlug.mockImplementation(async (slug) => {
      if (slug === 'tenant-a') return { id: TENANT_A, status: 'active' };
      if (slug === 'tenant-b') return { id: TENANT_B, status: 'active' };
      return null;
    });
    queryRawUnsafe.mockImplementation(routeQuery);
    setTenantMock.mockImplementation(async (_tenantId, fn) => fn({ $queryRawUnsafe: queryRawUnsafe }));
    issueAccessTokenAndClaimSession.mockImplementation(async ({ tokenPayload }) => {
      issuedPayload = tokenPayload;
      return { accessToken: 'vh-access-token' };
    });
    generateRefreshToken.mockReturnValue('vh-refresh-token');
    global.fetch = jest.fn();
    logSecurityEvent.mockClear();
  });

  it('discovers active providers for the tenant admin host', async () => {
    const result = await discoverAdminOidcProvidersForRequest(
      req({ adminHost: 'tenant-a-admin.localhost:3001' }),
    );

    expect(result.tenant).toMatchObject({ id: TENANT_A, slug: 'tenant-a', platform: false });
    expect(result.providers).toEqual([
      {
        provider_key: PROVIDER_KEY,
        display_name: 'Keycloak',
        start_url: '/api/v1/auth/admin/sso/oidc/keycloak/start',
      },
    ]);
  });

  it('accepts a valid tenant assertion, links only the existing admin, and hashes audit material', async () => {
    const result = await startAndComplete();

    expect(result).toMatchObject({
      token: 'vh-access-token',
      refreshToken: 'vh-refresh-token',
      admin: { uid: ADMIN_A, role: 'ADMIN' },
      returnTo: '/dashboard',
    });
    expect(issuedPayload).toMatchObject({
      uid: ADMIN_A,
      role: 'ADMIN',
      tenant_id: TENANT_A,
    });
    expect(issuedPayload.mfa).toBeUndefined();
    expect(auditEvents.map((event) => event.eventType)).toEqual([
      'SSO_START',
      'SSO_ASSERTION_ACCEPTED',
    ]);
    const accepted = auditEvents.find((event) => event.eventType === 'SSO_ASSERTION_ACCEPTED');
    expect(accepted.subjectHash).toHaveLength(64);
    expect(accepted.assertionHash).toHaveLength(64);
    expect(accepted.details.email_hash).toHaveLength(64);
  });

  it('fails closed when the callback arrives on the wrong tenant admin host', async () => {
    await expect(startAndComplete({ callbackHost: 'tenant-b-admin.localhost:3001' }))
      .rejects.toMatchObject({ code: 'SSO_TENANT_MISMATCH' });
    expect(auditEvents.some((event) => event.details.reason === 'tenant_host_mismatch')).toBe(true);
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('fails closed when IdP groups do not map to exactly one admin role', async () => {
    resetScenario({
      idPayload: {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: 'idp-subject-unmapped',
        email: 'admin-a@example.test',
        groups: ['unmapped'],
      },
      mappingRows: [],
    });

    await expect(startAndComplete()).rejects.toMatchObject({ code: 'SSO_ROLE_MAPPING_FAILED' });
    expect(auditEvents.some((event) => event.eventType === 'SSO_ROLE_MAPPING_FAILED')).toBe(true);
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('does not let a tenant A assertion session a tenant B admin by email', async () => {
    resetScenario({
      idPayload: {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: 'idp-subject-tenant-b',
        email: 'admin-b@example.test',
        groups: ['vh-admins'],
      },
      adminByTenant: {
        [TENANT_A]: [],
        [TENANT_B]: [admin(ADMIN_B, 'admin-b@example.test', 'ADMIN', TENANT_B)],
      },
    });

    await expect(startAndComplete()).rejects.toMatchObject({ code: 'SSO_LOCAL_IDENTITY_NOT_FOUND' });
    expect(auditEvents.some((event) => event.eventType === 'SSO_LOCAL_IDENTITY_LINK_FAILED')).toBe(true);
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('fails login closed when the identity audit write fails', async () => {
    resetScenario({ failAudit: true });

    await expect(startAdminOidcLogin({
      req: req({ adminHost: 'tenant-a-admin.localhost:3001' }),
      providerKey: PROVIDER_KEY,
    })).rejects.toMatchObject({ code: 'SSO_AUDIT_WRITE_FAILED' });
  });

  it('does not mint mfa:true for SUPER_ADMIN SSO, so local step-up still blocks', async () => {
    resetScenario({
      provider: platformProvider(),
      idPayload: {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: 'idp-subject-super',
        email: 'super@example.test',
        groups: ['vh-super-admins'],
      },
      mappingRows: [{ idp_group: 'vh-super-admins', vh_role: 'SUPER_ADMIN', priority: 100 }],
    });

    const result = await startAndComplete({ startAdminHost: 'localhost:3001' });

    expect(result.admin).toMatchObject({ uid: SUPER_ADMIN, role: 'SUPER_ADMIN' });
    expect(issuedPayload).toMatchObject({ uid: SUPER_ADMIN, role: 'SUPER_ADMIN' });
    expect(issuedPayload).not.toHaveProperty('tenant_id');
    expect(issuedPayload.mfa).toBeUndefined();

    const { response, nextCalled } = invokeStepUp({
      uid: SUPER_ADMIN,
      role: 'ADMIN',
      rawRole: 'SUPER_ADMIN',
      mfa: issuedPayload.mfa,
    });
    expect(nextCalled).toBe(false);
    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: 'SUPER_ADMIN_MFA_REQUIRED' });
  });
});
