import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { jest } from '@jest/globals';

process.env.JWT_SECRET ||= 'test-jwt-secret-for-ci-must-be-at-least-32-chars';

const TENANT_A = '10000000-0000-4000-8000-0000000000a1';
const TENANT_B = '10000000-0000-4000-8000-0000000000b1';
const STAFF_UID = '30000000-0000-4000-8000-0000000000a1';
const STAFF_INSTALLATION_ID = '33333333-3333-4333-8333-333333333333';
const ISSUER = 'https://idp.test/realms/vh-staff';
const CLIENT_ID = 'vh-staff';
const PROVIDER_KEY = 'keycloak-staff';
const STAFF_REDIRECT_URI = 'vhhealthstaff://auth/sso/oidc/callback';

const setTenantMock = jest.fn();
const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn();
const resolveTenantForRequest = jest.fn();
const issueAccessTokenAndClaimSession = jest.fn();
const generateRefreshToken = jest.fn();
const bindStaffInstallation = jest.fn();

jest.unstable_mockModule('../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: executeRawUnsafe },
  setTenant: setTenantMock,
}));

jest.unstable_mockModule('../services/tenant/tenantService.js', () => ({
  resolveTenantForRequest,
}));

jest.unstable_mockModule('../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession,
}));

jest.unstable_mockModule('../services/auth/staffAuthService.js', () => ({
  StaffAuthService: {
    bindStaffInstallation,
    generateRefreshToken,
  },
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

const {
  completeStaffOidcCallback,
  discoverStaffOidcProvidersForRequest,
  getStaffOidcProviderConfig,
  invalidateStaffOidcProviderCache,
  replaceStaffOidcRoleMappings,
  startStaffOidcLogin,
  upsertStaffOidcProvider,
} = await import('../services/auth/staffOidcSsoService.js');

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'kid-staff',
  alg: 'RS256',
  use: 'sig',
};

let scenario;
let auditEvents;
let issuedArgs;
let tokenRequestBody;

function provider(tenantId = TENANT_A) {
  return {
    id: tenantId === TENANT_A ? 51 : 52,
    tenant_id: tenantId,
    is_platform_provider: false,
    realm: 'staff',
    protocol: 'oidc',
    provider_key: PROVIDER_KEY,
    display_name: 'Keycloak Staff',
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
    policy: {
      staff_redirect_uris: [STAFF_REDIRECT_URI],
      staff_employee_id_claim: 'employee_id',
    },
  };
}

function staff(overrides = {}) {
  return {
    id: 42,
    uid: STAFF_UID,
    name: 'Nurse Priya',
    email: 'priya@example.test',
    role: 'NURSING_STAFF',
    user_status: 'active',
    user_is_active: true,
    is_deleted: false,
    tenant_id: TENANT_A,
    employee_id: 'EMP-42',
    staff_name: 'Nurse Priya',
    department: 'Nursing',
    position: 'RN',
    staff_is_active: true,
    archived: false,
    archived_at: null,
    ...overrides,
  };
}

function resetScenario(overrides = {}) {
  auditEvents = [];
  issuedArgs = null;
  tokenRequestBody = null;
  scenario = {
    provider: provider(TENANT_A),
    idPayload: {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'idp-staff-subject-a',
      email: 'priya@example.test',
      employee_id: 'EMP-42',
      groups: ['vh-nursing'],
    },
    mappingRows: [{ idp_group: 'vh-nursing', vh_role: 'NURSING_STAFF', priority: 100 }],
    staffByEmail: [staff()],
    staffByEmployee: [staff()],
    linkedStaff: null,
    existingLocalLink: [],
    activeSessions: [],
    savedProvider: null,
    savedMappingRows: null,
    ...overrides,
  };
  invalidateStaffOidcProviderCache();
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
    { algorithm: 'RS256', keyid: 'kid-staff' },
  );
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function req({ host = 'tenant-a-api.localhost:5206', query = {} } = {}) {
  return {
    id: 'req-test',
    ip: '127.0.0.1',
    protocol: 'http',
    hostname: host.split(':')[0],
    headers: {
      host,
      'user-agent': 'jest',
      'x-forwarded-proto': 'http',
    },
    query: {
      redirect_uri: STAFF_REDIRECT_URI,
      deviceType: 'tablet',
      deviceId: STAFF_INSTALLATION_ID,
      ...query,
    },
  };
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
    const tenantId = String(params[0]);
    if (tenantId !== String(scenario.provider.tenant_id)) return [];
    if (compact.includes('provider_key') && !params.includes(PROVIDER_KEY)) return [];
    return [scenario.provider];
  }

  if (compact.includes('UPDATE tenant_identity_providers')) {
    scenario.savedProvider = {
      ...scenario.provider,
      display_name: params[0],
      status: params[1],
      oidc_issuer: params[2],
      oidc_discovery_url: params[3],
      oidc_jwks_uri: params[4],
      oidc_authorization_endpoint: params[5],
      oidc_token_endpoint: params[6],
      oidc_userinfo_endpoint: params[7],
      oidc_client_id: params[8],
      oidc_client_secret_ciphertext: params[9] || scenario.provider.oidc_client_secret_ciphertext,
      group_claim_name: params[10],
      allowed_domains: params[11],
      required_claims: JSON.parse(params[12]),
      policy: JSON.parse(params[13]),
      updated_by: params[14],
    };
    scenario.provider = scenario.savedProvider;
    return [scenario.savedProvider];
  }

  if (compact.includes('INSERT INTO tenant_identity_providers')) {
    scenario.savedProvider = {
      ...scenario.provider,
      tenant_id: params[0],
      provider_key: params[1],
      display_name: params[2],
      status: params[3],
      oidc_issuer: params[4],
      oidc_discovery_url: params[5],
      oidc_jwks_uri: params[6],
      oidc_authorization_endpoint: params[7],
      oidc_token_endpoint: params[8],
      oidc_userinfo_endpoint: params[9],
      oidc_client_id: params[10],
      oidc_client_secret_ciphertext: params[11],
      group_claim_name: params[12],
      allowed_domains: params[13],
      required_claims: JSON.parse(params[14]),
      policy: JSON.parse(params[15]),
      created_by: params[16],
      updated_by: params[16],
    };
    scenario.provider = scenario.savedProvider;
    return [scenario.savedProvider];
  }

  if (compact.includes('INSERT INTO identity_audit_events')) {
    auditEvents.push(auditFromParams(params));
    return [];
  }

  if (compact.includes('DELETE FROM tenant_idp_role_mappings')) {
    scenario.savedMappingRows = [];
    return [];
  }

  if (compact.includes('INSERT INTO tenant_idp_role_mappings')) {
    const nextId = 700 + (scenario.savedMappingRows?.length || 0);
    const row = {
      id: nextId,
      idp_group: params[2],
      vh_role: params[3],
      status: params[4],
      priority: params[5],
    };
    scenario.savedMappingRows = [...(scenario.savedMappingRows || []), row];
    return [];
  }

  if (compact.includes('FROM tenant_idp_role_mappings')) {
    return scenario.savedMappingRows || scenario.mappingRows;
  }

  if (compact.includes('FROM federated_identities fi')) {
    return scenario.linkedStaff ? [scenario.linkedStaff] : [];
  }

  if (compact.includes('FROM users u') && compact.includes('lower(u.email)')) {
    return scenario.staffByEmail;
  }

  if (compact.includes('FROM users u') && compact.includes('s.employee_id')) {
    return scenario.staffByEmployee;
  }

  if (compact.includes('FROM federated_identities') && compact.includes('local_uid')) {
    return scenario.existingLocalLink;
  }

  if (compact.includes('INSERT INTO federated_identities')) return [];
  if (compact.includes('UPDATE federated_identities')) return [];
  if (compact.includes('UPDATE users')) return [];

  if (compact.includes('FROM staff_auth_sessions')) {
    return scenario.activeSessions;
  }

  return [];
}

async function startAndComplete({ startHost = 'tenant-a-api.localhost:5206', callbackHost = 'tenant-a-api.localhost:5206' } = {}) {
  const start = await startStaffOidcLogin({
    req: req({ host: startHost }),
    providerKey: PROVIDER_KEY,
  });
  const redirectUrl = new URL(start.redirectUrl);
  scenario.nonce = redirectUrl.searchParams.get('nonce');
  const state = redirectUrl.searchParams.get('state');
  const codeChallenge = redirectUrl.searchParams.get('code_challenge');

  const idToken = signIdToken();
  global.fetch = jest.fn(async (url, options = {}) => {
    if (String(url) === scenario.provider.oidc_token_endpoint) {
      tokenRequestBody = String(options.body || '');
      const body = new URLSearchParams(tokenRequestBody);
      const verifier = body.get('code_verifier');
      expect(sha256Base64Url(verifier)).toBe(codeChallenge);
      expect(body.get('redirect_uri')).toBe(STAFF_REDIRECT_URI);
      return jsonResponse({ id_token: idToken });
    }
    if (String(url) === scenario.provider.oidc_jwks_uri) {
      return jsonResponse({ keys: [jwk] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const result = await completeStaffOidcCallback({
    req: req({ host: callbackHost }),
    providerKey: PROVIDER_KEY,
    code: 'auth-code',
    state,
    redirectUri: STAFF_REDIRECT_URI,
  });
  return { result, redirectUrl, state };
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(String(value)).digest('base64url');
}

describe('staff OIDC SSO broker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetScenario();
    resolveTenantForRequest.mockImplementation(async (request) => (
      String(request?.headers?.host || '').startsWith('tenant-b-api') ? TENANT_B : TENANT_A
    ));
    queryRawUnsafe.mockImplementation(routeQuery);
    executeRawUnsafe.mockResolvedValue(1);
    setTenantMock.mockImplementation(async (_tenantId, fn) => fn({
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: executeRawUnsafe,
    }));
    issueAccessTokenAndClaimSession.mockImplementation(async (args) => {
      issuedArgs = args;
      return { accessToken: 'vh-staff-access-token' };
    });
    generateRefreshToken.mockReturnValue('vh-staff-refresh-token');
    bindStaffInstallation.mockResolvedValue(STAFF_INSTALLATION_ID);
    global.fetch = jest.fn();
  });

  it('discovers active staff providers for the API tenant host', async () => {
    const result = await discoverStaffOidcProvidersForRequest(req());

    expect(result.tenant).toEqual({ id: TENANT_A });
    expect(result.providers).toEqual([
      {
        provider_key: PROVIDER_KEY,
        display_name: 'Keycloak Staff',
        start_url: '/api/v1/auth/staff/sso/oidc/keycloak-staff/start',
        redirect_uris: [STAFF_REDIRECT_URI],
      },
    ]);
  });

  it('saves staff provider config with registered deep links and write-only secrets', async () => {
    const saved = await upsertStaffOidcProvider({
      tenantId: TENANT_A,
      providerKey: PROVIDER_KEY,
      actorUid: STAFF_UID,
      input: {
        display_name: 'Staff Keycloak',
        status: 'active',
        oidc_issuer: ISSUER,
        oidc_jwks_uri: 'https://idp.test/jwks',
        oidc_authorization_endpoint: 'https://idp.test/auth',
        oidc_token_endpoint: 'https://idp.test/token',
        oidc_client_id: CLIENT_ID,
        oidc_client_secret: 'new-secret',
        group_claim_name: 'groups',
        allowed_domains: ['example.test'],
        policy: {
          staff_redirect_uris: [STAFF_REDIRECT_URI],
          staff_employee_id_claim: 'employee_id',
        },
      },
    });

    expect(saved).toEqual(expect.objectContaining({
      provider_key: PROVIDER_KEY,
      realm: 'staff',
      status: 'active',
      has_oidc_client_secret: true,
      policy: expect.objectContaining({
        staff_redirect_uris: [STAFF_REDIRECT_URI],
        staff_employee_id_claim: 'employee_id',
      }),
    }));
    expect(saved.oidc_client_secret_ciphertext).toBeUndefined();
    expect(scenario.savedProvider.oidc_client_secret_ciphertext).toBe('enc:new-secret');

    const fetched = await getStaffOidcProviderConfig({ tenantId: TENANT_A, providerKey: PROVIDER_KEY });
    expect(fetched.has_oidc_client_secret).toBe(true);
    expect(fetched.oidc_client_secret_ciphertext).toBeUndefined();
  });

  it('rejects staff provider config without a registered app deep-link redirect', async () => {
    await expect(upsertStaffOidcProvider({
      tenantId: TENANT_A,
      providerKey: PROVIDER_KEY,
      actorUid: STAFF_UID,
      input: {
        display_name: 'Staff Keycloak',
        status: 'active',
        oidc_issuer: ISSUER,
        oidc_jwks_uri: 'https://idp.test/jwks',
        oidc_authorization_endpoint: 'https://idp.test/auth',
        oidc_token_endpoint: 'https://idp.test/token',
        oidc_client_id: CLIENT_ID,
        policy: { staff_redirect_uris: ['https://staff.example.test/sso/callback'] },
      },
    })).rejects.toMatchObject({ code: 'SSO_REDIRECT_URI_NOT_DEEP_LINK' });
  });

  it('allows staff mappings only to staff roles', async () => {
    await expect(replaceStaffOidcRoleMappings({
      tenantId: TENANT_A,
      providerKey: PROVIDER_KEY,
      actorUid: STAFF_UID,
      mappings: [{ idp_group: 'vh-admins', vh_role: 'ADMIN', status: 'active' }],
    })).rejects.toMatchObject({ code: 'SSO_MAPPING_ROLE_INVALID' });

    const mappings = await replaceStaffOidcRoleMappings({
      tenantId: TENANT_A,
      providerKey: PROVIDER_KEY,
      actorUid: STAFF_UID,
      mappings: [
        { idp_group: 'vh-nursing', vh_role: 'NURSING_STAFF', status: 'active', priority: 100 },
      ],
    });
    expect(mappings).toEqual([
      { id: 700, idp_group: 'vh-nursing', vh_role: 'NURSING_STAFF', status: 'active', priority: 100 },
    ]);
  });

  it('round-trips server PKCE, links an existing staff identity, audits accept, and propagates deviceType', async () => {
    const { result, redirectUrl } = await startAndComplete();

    expect(redirectUrl.searchParams.get('redirect_uri')).toBe(STAFF_REDIRECT_URI);
    expect(redirectUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(tokenRequestBody).toContain('code_verifier=');
    expect(result).toMatchObject({
      accessToken: 'vh-staff-access-token',
      refreshToken: 'vh-staff-refresh-token',
      staff: { uid: STAFF_UID, employeeId: 'EMP-42', role: 'NURSING_STAFF' },
    });
    expect(issuedArgs).toEqual(expect.objectContaining({
      userUid: STAFF_UID,
      deviceType: 'tablet',
      stableDeviceId: STAFF_INSTALLATION_ID,
      tokenPayload: expect.objectContaining({
        id: 42,
        uid: STAFF_UID,
        role: 'NURSING_STAFF',
        tenant_id: TENANT_A,
      }),
    }));
    expect(executeRawUnsafe.mock.calls.some((call) => String(call[0]).includes('INSERT INTO staff_auth_sessions'))).toBe(true);
    expect(auditEvents.map((event) => event.eventType)).toEqual([
      'SSO_START',
      'SSO_ASSERTION_ACCEPTED',
    ]);
    const accepted = auditEvents.find((event) => event.eventType === 'SSO_ASSERTION_ACCEPTED');
    expect(accepted.subjectHash).toHaveLength(64);
    expect(accepted.assertionHash).toHaveLength(64);
    expect(accepted.details.email_hash).toHaveLength(64);
    expect(accepted.details.employee_id_hash).toHaveLength(64);
  });

  it('rejects redirect URIs outside the provider allowlist before contacting the IdP', async () => {
    await expect(startStaffOidcLogin({
      req: req({ query: { redirect_uri: 'vhhealthstaff://evil/callback' } }),
      providerKey: PROVIDER_KEY,
    })).rejects.toMatchObject({ code: 'SSO_REDIRECT_URI_NOT_ALLOWED' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(auditEvents).toEqual([]);
  });

  it('fails closed when callback tenant binding differs from the state tenant', async () => {
    await expect(startAndComplete({ callbackHost: 'tenant-b-api.localhost:5206' }))
      .rejects.toMatchObject({ code: 'SSO_TENANT_MISMATCH' });

    expect(auditEvents.some((event) => event.details.reason === 'tenant_host_mismatch')).toBe(true);
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('denies realm escape when a staff provider maps a group to ADMIN', async () => {
    resetScenario({
      mappingRows: [{ idp_group: 'vh-admins', vh_role: 'ADMIN', priority: 100 }],
      idPayload: {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: 'idp-staff-admin',
        email: 'priya@example.test',
        employee_id: 'EMP-42',
        groups: ['vh-admins'],
      },
    });

    await expect(startAndComplete()).rejects.toMatchObject({ code: 'SSO_ROLE_MAPPING_FAILED' });
    expect(auditEvents.some((event) => event.eventType === 'SSO_ROLE_MAPPING_FAILED')).toBe(true);
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('fails closed when IdP groups are unmapped', async () => {
    resetScenario({
      mappingRows: [],
      idPayload: {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: 'idp-staff-unmapped',
        email: 'priya@example.test',
        employee_id: 'EMP-42',
        groups: ['unmapped'],
      },
    });

    await expect(startAndComplete()).rejects.toMatchObject({ code: 'SSO_ROLE_MAPPING_FAILED' });
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('fails closed for a disabled or deprovisioned local staff identity', async () => {
    resetScenario({
      staffByEmail: [staff({ staff_is_active: false })],
      staffByEmployee: [staff({ staff_is_active: false })],
    });

    await expect(startAndComplete()).rejects.toMatchObject({ code: 'SSO_LOCAL_IDENTITY_DENIED' });
    expect(auditEvents.some((event) => event.eventType === 'SSO_LOCAL_IDENTITY_LINK_FAILED')).toBe(true);
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('fails closed for an unlinked principal with no existing matching staff row', async () => {
    resetScenario({
      staffByEmail: [],
      staffByEmployee: [],
    });

    await expect(startAndComplete()).rejects.toMatchObject({ code: 'SSO_LOCAL_IDENTITY_NOT_FOUND' });
    expect(auditEvents.some((event) => event.eventType === 'SSO_LOCAL_IDENTITY_LINK_FAILED')).toBe(true);
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });
});
