import crypto from 'crypto';
import zlib from 'zlib';
import { promisify } from 'util';

import { SignedXml } from 'xml-crypto';
import { jest } from '@jest/globals';

process.env.JWT_SECRET ||= 'test-jwt-secret-for-ci-must-be-at-least-32-chars';
process.env.TENANT_BASE_HOST = 'localhost';
process.env.SSO_SAML_MAX_ASSERTION_BYTES ||= '262144';

const inflateRaw = promisify(zlib.inflateRaw);

const TENANT_A = '10000000-0000-4000-8000-0000000000a1';
const TENANT_B = '10000000-0000-4000-8000-0000000000b1';
const ADMIN_UID = '20000000-0000-4000-8000-0000000000a1';
const STAFF_UID = '30000000-0000-4000-8000-0000000000a1';
const STAFF_INSTALLATION_ID = '33333333-3333-4333-8333-333333333333';
const PROVIDER_KEY = 'hospital-saml';
const ISSUER_A = 'https://idp-a.example.test/saml';
const ISSUER_B = 'https://idp-b.example.test/saml';
const SP_A = 'https://vh.example.test/saml/sp/a';
const SP_B = 'https://vh.example.test/saml/sp/b';
const ADMIN_ACS_A = `http://tenant-a-admin.localhost:5206/api/v1/auth/admin/sso/saml/${PROVIDER_KEY}/acs`;
const STAFF_ACS_A = `http://tenant-a-api.localhost:5206/api/v1/auth/staff/sso/saml/${PROVIDER_KEY}/acs`;
const NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

const setTenantMock = jest.fn();
const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn();
const getTenantBySlug = jest.fn();
const resolveTenantForRequest = jest.fn();
const issueAccessTokenAndClaimSession = jest.fn();
const generateRefreshToken = jest.fn();
const staffRefreshToken = jest.fn();
const bindStaffInstallation = jest.fn();

jest.unstable_mockModule('../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: executeRawUnsafe },
  setTenant: setTenantMock,
}));

jest.unstable_mockModule('../services/tenant/tenantService.js', () => ({
  getTenantBySlug,
  resolveTenantForRequest,
}));

jest.unstable_mockModule('../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession,
  generateRefreshToken,
}));

jest.unstable_mockModule('../services/auth/staffAuthService.js', () => ({
  StaffAuthService: {
    bindStaffInstallation,
    generateRefreshToken: staffRefreshToken,
  },
}));

jest.unstable_mockModule('../utils/fieldEncryption.js', () => ({
  encryptField: (value) => `enc:${value}`,
  decryptField: (value) => String(value || '').replace(/^enc:/, ''),
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
  completeSamlAcs,
  startSamlLogin,
} = await import('../services/auth/samlSsoService.js');
const jwtMiddleware = (await import('../middleware/jwtMiddleware.js')).default;

const idpA = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const idpB = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const IDP_A_PRIVATE_KEY = idpA.privateKey.export({ type: 'pkcs8', format: 'pem' });
const IDP_A_PUBLIC_KEY = idpA.publicKey.export({ type: 'spki', format: 'pem' });
const IDP_B_PRIVATE_KEY = idpB.privateKey.export({ type: 'pkcs8', format: 'pem' });
const IDP_B_PUBLIC_KEY = idpB.publicKey.export({ type: 'spki', format: 'pem' });

let scenario;
let auditEvents;
let issuedArgs;
let replayCache;

function adminProvider(overrides = {}) {
  return {
    id: 71,
    tenant_id: TENANT_A,
    is_platform_provider: false,
    realm: 'admin',
    protocol: 'saml',
    provider_key: PROVIDER_KEY,
    display_name: 'Hospital SAML',
    status: 'active',
    saml_entity_id: ISSUER_A,
    saml_sp_entity_id: SP_A,
    saml_acs_url: ADMIN_ACS_A,
    saml_sso_url: 'https://idp-a.example.test/sso',
    saml_idp_signing_certs_ciphertext: `enc:${JSON.stringify([IDP_A_PUBLIC_KEY])}`,
    saml_nameid_format: NAME_ID_FORMAT,
    saml_require_signed_response: false,
    saml_require_signed_assertion: false,
    group_claim_name: 'groups',
    allowed_domains: [],
    required_claims: {},
    policy: {},
    ...overrides,
  };
}

function staffProvider(overrides = {}) {
  return {
    ...adminProvider({
      id: 81,
      realm: 'staff',
      saml_acs_url: STAFF_ACS_A,
    }),
    policy: { staff_employee_id_claim: 'employee_id' },
    ...overrides,
  };
}

function admin(overrides = {}) {
  return {
    uid: ADMIN_UID,
    username: 'admin-a@example.test',
    email: 'admin-a@example.test',
    name: 'Admin A',
    role: 'ADMIN',
    status: 'active',
    tenant_id: TENANT_A,
    ...overrides,
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
  replayCache = new Map();
  scenario = {
    provider: adminProvider(),
    mappingRows: [{ idp_group: 'vh-admins', vh_role: 'ADMIN', priority: 100 }],
    admins: [admin()],
    staffByEmail: [staff()],
    staffByEmployee: [staff()],
    linkedAdmin: null,
    linkedStaff: null,
    existingLocalLink: [],
    activeSessions: [],
    ...overrides,
  };
}

function request({ realm = 'admin', host, body = {}, query = {} } = {}) {
  const defaultHost = realm === 'staff' ? 'tenant-a-api.localhost:5206' : 'tenant-a-admin.localhost:5206';
  return {
    id: 'req-saml',
    ip: '127.0.0.1',
    protocol: 'http',
    hostname: (host || defaultHost).split(':')[0],
    headers: {
      host: host || defaultHost,
      'user-agent': 'jest',
      'x-forwarded-proto': 'http',
    },
    query,
    body,
  };
}

function auditFromParams(params) {
  return {
    tenantId: params[0],
    realm: params[1],
    providerId: params[2],
    providerKey: params[3],
    eventType: params[4],
    outcome: params[5],
    localUid: params[7],
    issuer: params[8],
    subjectHash: params[9],
    assertionHash: params[10],
    stateHash: params[11],
    details: params[15] ? JSON.parse(params[15]) : {},
  };
}

function cacheKey(providerId, kind, key) {
  return `${providerId}:${kind}:${key}`;
}

async function routeQuery(sql, ...params) {
  const compact = sql.replace(/\s+/g, ' ');
  if (compact.includes('FROM tenant_identity_providers')) {
    if (!compact.includes("protocol = 'saml'")) return [];
    if (compact.includes('provider_key') && !params.includes(PROVIDER_KEY)) return [];
    const row = scenario.provider;
    if (compact.includes("realm = 'admin'") && row.realm !== 'admin') return [];
    if (compact.includes("realm = 'staff'") && row.realm !== 'staff') return [];
    if (compact.includes('realm = $') && !params.includes(row.realm)) return [];
    if (row.tenant_id && !params.includes(row.tenant_id)) return [];
    return [row];
  }

  if (compact.includes('INSERT INTO identity_saml_replay_cache') && compact.includes('DO UPDATE')) {
    const [, , providerId, kind, key, value] = params;
    replayCache.set(cacheKey(providerId, kind, key), value);
    return [];
  }

  if (compact.includes('SELECT cache_value FROM identity_saml_replay_cache')) {
    const [providerId, , kind, key] = params;
    const value = replayCache.get(cacheKey(providerId, kind, key));
    return value ? [{ cache_value: value }] : [];
  }

  if (compact.includes('DELETE FROM identity_saml_replay_cache')) {
    const [providerId, , kind, key] = params;
    const keyName = cacheKey(providerId, kind, key);
    const value = replayCache.get(keyName);
    replayCache.delete(keyName);
    return value ? [{ cache_value: value }] : [];
  }

  if (compact.includes('INSERT INTO identity_saml_replay_cache') && compact.includes('DO NOTHING')) {
    const [, , providerId, kind, key] = params;
    const keyName = cacheKey(providerId, kind, key);
    if (replayCache.has(keyName)) return [];
    replayCache.set(keyName, key);
    return [{ id: BigInt(replayCache.size) }];
  }

  if (compact.includes('INSERT INTO identity_audit_events')) {
    auditEvents.push(auditFromParams(params));
    return [];
  }

  if (compact.includes('FROM tenant_idp_role_mappings')) {
    return scenario.mappingRows;
  }

  if (compact.includes('FROM federated_identities fi') && compact.includes('JOIN admins')) {
    return scenario.linkedAdmin ? [scenario.linkedAdmin] : [];
  }

  if (compact.includes('FROM admins')) {
    const [email, role, tenantId] = params;
    return scenario.admins
      .filter((row) => row.email.toLowerCase() === String(email).toLowerCase())
      .filter((row) => row.role === role)
      .filter((row) => String(row.tenant_id) === String(tenantId))
      .slice(0, 2);
  }

  if (compact.includes('FROM federated_identities fi') && compact.includes('JOIN users')) {
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
  if (compact.includes('UPDATE admins')) return [];
  if (compact.includes('UPDATE users')) return [];
  if (compact.includes('FROM staff_auth_sessions')) return scenario.activeSessions;
  return [];
}

function signXml(xml, xpath, privateKey = IDP_A_PRIVATE_KEY, publicCert = IDP_A_PUBLIC_KEY) {
  const sig = new SignedXml({
    privateKey,
    publicCert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(xml, { location: { reference: xpath, action: 'append' } });
  return sig.getSignedXml();
}

function buildResponseXml({
  responseId = `_${crypto.randomUUID()}`,
  assertionId = `_${crypto.randomUUID()}`,
  inResponseTo,
  issuer = ISSUER_A,
  audience = SP_A,
  destination = ADMIN_ACS_A,
  recipient = ADMIN_ACS_A,
  nameId = 'admin-a@example.test',
  email = 'admin-a@example.test',
  employeeId = null,
  groups = ['vh-admins'],
  notBefore = new Date(Date.now() - 60_000),
  notOnOrAfter = new Date(Date.now() + 5 * 60_000),
} = {}) {
  const now = new Date().toISOString();
  const attributes = [
    `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>`,
    `<saml:Attribute Name="groups">${groups.map((group) => `<saml:AttributeValue>${group}</saml:AttributeValue>`).join('')}</saml:Attribute>`,
    employeeId ? `<saml:Attribute Name="employee_id"><saml:AttributeValue>${employeeId}</saml:AttributeValue></saml:Attribute>` : '',
  ].join('');
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${now}" Destination="${destination}" InResponseTo="${inResponseTo}">
    <saml:Issuer>${issuer}</saml:Issuer>
    <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
    <saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now}">
      <saml:Issuer>${issuer}</saml:Issuer>
      <saml:Subject>
        <saml:NameID Format="${NAME_ID_FORMAT}">${nameId}</saml:NameID>
        <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
          <saml:SubjectConfirmationData InResponseTo="${inResponseTo}" Recipient="${recipient}" NotOnOrAfter="${notOnOrAfter.toISOString()}"/>
        </saml:SubjectConfirmation>
      </saml:Subject>
      <saml:Conditions NotBefore="${notBefore.toISOString()}" NotOnOrAfter="${notOnOrAfter.toISOString()}">
        <saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>
      </saml:Conditions>
      <saml:AuthnStatement AuthnInstant="${now}" SessionIndex="idp-session-1"/>
      <saml:AttributeStatement>${attributes}</saml:AttributeStatement>
    </saml:Assertion>
  </samlp:Response>`;
}

function signedResponse(options = {}, signatureTarget = 'response') {
  const xml = buildResponseXml(options);
  if (signatureTarget === 'none') return xml;
  if (signatureTarget === 'assertion') return signXml(xml, "//*[local-name(.)='Assertion']");
  return signXml(xml, "//*[local-name(.)='Response']");
}

async function startForRealm(realm = 'admin') {
  const start = await startSamlLogin({
    req: request({
      realm,
      query: realm === 'admin'
        ? { admin_host: 'tenant-a-admin.localhost:5206', returnTo: '/dashboard' }
        : {
          deviceId: STAFF_INSTALLATION_ID,
          deviceType: 'mobile',
        },
    }),
    realm,
    providerKey: PROVIDER_KEY,
  });
  const url = new URL(start.redirectUrl);
  const requestXml = await inflateRaw(Buffer.from(url.searchParams.get('SAMLRequest'), 'base64'));
  const requestId = /ID="([^"]+)"/.exec(requestXml.toString('utf8'))?.[1];
  return { relayState: url.searchParams.get('RelayState'), requestId };
}

async function completeWithResponse({
  realm = 'admin',
  signatureTarget = 'response',
  overrides = {},
} = {}) {
  const { relayState, requestId } = await startForRealm(realm);
  const xml = signedResponse({
    inResponseTo: requestId,
    destination: realm === 'staff' ? STAFF_ACS_A : ADMIN_ACS_A,
    recipient: realm === 'staff' ? STAFF_ACS_A : ADMIN_ACS_A,
    nameId: realm === 'staff' ? 'priya@example.test' : 'admin-a@example.test',
    email: realm === 'staff' ? 'priya@example.test' : 'admin-a@example.test',
    employeeId: realm === 'staff' ? 'EMP-42' : null,
    groups: realm === 'staff' ? ['vh-nursing'] : ['vh-admins'],
    ...overrides,
  }, signatureTarget);
  return completeSamlAcs({
    req: request({
      realm,
      body: {
        SAMLResponse: Buffer.from(xml).toString('base64'),
        RelayState: relayState,
      },
    }),
    realm,
    providerKey: PROVIDER_KEY,
  });
}

describe('SAML SSO broker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetScenario();
    getTenantBySlug.mockImplementation(async (slug) => {
      if (slug === 'tenant-a') return { id: TENANT_A, status: 'active' };
      if (slug === 'tenant-b') return { id: TENANT_B, status: 'active' };
      return null;
    });
    resolveTenantForRequest.mockImplementation(async (req) => (
      String(req?.headers?.host || '').startsWith('tenant-b-api') ? TENANT_B : TENANT_A
    ));
    queryRawUnsafe.mockImplementation(routeQuery);
    executeRawUnsafe.mockResolvedValue(1);
    setTenantMock.mockImplementation(async (_tenantId, fn) => fn({
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: executeRawUnsafe,
    }));
    issueAccessTokenAndClaimSession.mockImplementation(async (args) => {
      issuedArgs = args;
      return {
        accessToken: 'vh-access-token',
        tokenEpoch: 0,
        sessionFamilyId: 'sso-session-family',
      };
    });
    generateRefreshToken.mockReturnValue('vh-refresh-token');
    staffRefreshToken.mockReturnValue('vh-staff-refresh-token');
    bindStaffInstallation.mockResolvedValue(STAFF_INSTALLATION_ID);
  });

  it('accepts a response-signed admin assertion and issues the normal admin session without MFA step-up', async () => {
    const result = await completeWithResponse({ signatureTarget: 'response' });

    expect(result).toMatchObject({
      token: 'vh-access-token',
      refreshToken: 'vh-refresh-token',
      admin: { uid: ADMIN_UID, role: 'ADMIN' },
    });
    expect(issuedArgs.tokenPayload).toMatchObject({
      uid: ADMIN_UID,
      role: 'ADMIN',
      tenant_id: TENANT_A,
    });
    expect(issuedArgs.tokenPayload.mfa).toBeUndefined();
    expect(generateRefreshToken).toHaveBeenCalledWith(expect.objectContaining({
      sessionFamilyId: 'sso-session-family',
    }));
    expect(auditEvents.map((event) => event.eventType)).toEqual([
      'SSO_START',
      'SSO_ASSERTION_ACCEPTED',
    ]);
    expect(auditEvents[1]).toMatchObject({ realm: 'admin', outcome: 'accepted' });
    expect(auditEvents[1].assertionHash).toHaveLength(64);
  });

  it('accepts an assertion-signed staff assertion, links an existing SCIM-created staff row, and issues staff sessions', async () => {
    scenario.provider = staffProvider();
    scenario.mappingRows = [{ idp_group: 'vh-nursing', vh_role: 'NURSING_STAFF', priority: 100 }];

    const result = await completeWithResponse({ realm: 'staff', signatureTarget: 'assertion' });

    expect(result).toMatchObject({
      accessToken: 'vh-access-token',
      refreshToken: 'vh-staff-refresh-token',
      staff: { uid: STAFF_UID, employeeId: 'EMP-42', role: 'NURSING_STAFF' },
    });
    expect(issuedArgs).toEqual(expect.objectContaining({
      userUid: STAFF_UID,
      stableDeviceId: STAFF_INSTALLATION_ID,
      tokenPayload: expect.objectContaining({ tenant_id: TENANT_A, role: 'NURSING_STAFF' }),
    }));
    expect(staffRefreshToken).toHaveBeenCalledWith(
      expect.any(Object),
      STAFF_INSTALLATION_ID,
      0,
      'sso-session-family',
    );
    expect(executeRawUnsafe.mock.calls.some((call) => String(call[0]).includes('INSERT INTO staff_auth_sessions'))).toBe(true);
  });

  it('rejects unsigned SAML responses before issuing a session', async () => {
    await expect(completeWithResponse({ signatureTarget: 'none' }))
      .rejects.toMatchObject({ code: 'SSO_ASSERTION_REJECTED' });
    expect(auditEvents.some((event) => event.eventType === 'SSO_ASSERTION_DENIED')).toBe(true);
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it.each([
    ['audience', { audience: SP_B }],
    ['recipient', { recipient: 'http://tenant-a-admin.localhost:5206/wrong/acs' }],
    ['ACS destination', { destination: 'http://tenant-a-admin.localhost:5206/wrong/acs' }],
  ])('rejects %s mismatch', async (_label, overrides) => {
    await expect(completeWithResponse({ overrides }))
      .rejects.toMatchObject({ code: 'SSO_ASSERTION_REJECTED' });
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it.each([
    ['expired assertion', { notOnOrAfter: new Date(Date.now() - 60_000) }, 'SSO_ASSERTION_REJECTED'],
    ['future NotBefore', { notBefore: new Date(Date.now() + 5 * 60_000) }, 'SSO_ASSERTION_REJECTED'],
  ])('rejects %s', async (_label, overrides, code) => {
    await expect(completeWithResponse({ overrides }))
      .rejects.toMatchObject({ code });
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('rejects oversized SAML assertions by SSO_SAML_MAX_ASSERTION_BYTES', async () => {
    const previous = process.env.SSO_SAML_MAX_ASSERTION_BYTES;
    process.env.SSO_SAML_MAX_ASSERTION_BYTES = '4096';
    await expect(completeWithResponse({
      overrides: { groups: ['x'.repeat(6000)] },
    })).rejects.toMatchObject({ code: 'SSO_SAML_ASSERTION_TOO_LARGE' });
    process.env.SSO_SAML_MAX_ASSERTION_BYTES = previous;
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('rejects response/assertion ID replay even when a new AuthnRequest is valid', async () => {
    const responseId = '_fixed-response';
    const assertionId = '_fixed-assertion';
    await completeWithResponse({ overrides: { responseId, assertionId } });

    await expect(completeWithResponse({ overrides: { responseId, assertionId } }))
      .rejects.toMatchObject({ code: 'SSO_SAML_REPLAY' });
  });

  it('does not let tenant A consume tenant B metadata or entity IDs', async () => {
    await expect(completeWithResponse({
      overrides: {
        issuer: ISSUER_B,
        audience: SP_B,
      },
    })).rejects.toMatchObject({ code: 'SSO_ASSERTION_REJECTED' });
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('fails closed when SAML groups do not map to exactly one local role', async () => {
    scenario.mappingRows = [];
    await expect(completeWithResponse({ overrides: { groups: ['unmapped'] } }))
      .rejects.toMatchObject({ code: 'SSO_ROLE_MAPPING_FAILED' });
    expect(auditEvents.some((event) => event.eventType === 'SSO_ROLE_MAPPING_FAILED')).toBe(true);
    expect(issueAccessTokenAndClaimSession).not.toHaveBeenCalled();
  });

  it('keeps jwtMiddleware from accepting a SAML artifact as a REST bearer token', async () => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    let nextCalled = false;
    await jwtMiddleware(
      { headers: { authorization: `Bearer ${Buffer.from('<samlp:Response/>').toString('base64')}` } },
      res,
      () => { nextCalled = true; },
    );

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_INVALID' });
  });
});
