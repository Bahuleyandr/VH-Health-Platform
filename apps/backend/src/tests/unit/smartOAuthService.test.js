/**
 * Phase D3 — smartOAuthService unit tests.
 *
 * Covers SMART scope parsing + intersection, app registration with
 * client-secret hashing, authorization-code grant with PKCE, code-replay
 * defenses, refresh-token rotation, and bearer-token verification.
 */

import { jest } from '@jest/globals';
import crypto from 'crypto';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  listAccessTokens,
  listSmartApps,
  parseSmartScope,
  refreshAccessToken,
  registerSmartApp,
  resolveScopes,
  revokeAccessToken,
  scopesAllow,
  verifyAccessToken,
  __testing__,
} = await import('../../services/smartFhir/smartOAuthService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

// ---------------------------------------------------------------------------
// Scope parsing + intersection
// ---------------------------------------------------------------------------

describe('parseSmartScope', () => {
  it('parses patient/Observation.read', () => {
    expect(parseSmartScope('patient/Observation.read')).toEqual({
      level: 'patient', resource: 'Observation', operation: 'read',
    });
  });

  it('parses user/*.write', () => {
    expect(parseSmartScope('user/*.write')).toEqual({
      level: 'user', resource: '*', operation: 'write',
    });
  });

  it('parses system/Patient.*', () => {
    expect(parseSmartScope('system/Patient.*')).toEqual({
      level: 'system', resource: 'Patient', operation: '*',
    });
  });

  it('returns null for non-resource scopes (openid / launch / fhirUser)', () => {
    expect(parseSmartScope('openid')).toBeNull();
    expect(parseSmartScope('launch/patient')).toBeNull();
    expect(parseSmartScope('fhirUser')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseSmartScope(null)).toBeNull();
    expect(parseSmartScope('garbage')).toBeNull();
  });
});

describe('resolveScopes intersection', () => {
  it('keeps requested scopes that are exactly allowed', () => {
    const granted = resolveScopes(
      ['patient/Observation.read', 'patient/Patient.read'],
      ['patient/Observation.read', 'patient/Patient.read', 'patient/MedicationRequest.read'],
    );
    expect(granted).toEqual(['patient/Observation.read', 'patient/Patient.read']);
  });

  it('honors wildcards in allowed scopes', () => {
    const granted = resolveScopes(
      ['patient/Observation.read', 'patient/Condition.write'],
      ['patient/*.read', 'patient/Condition.*'],
    );
    expect(granted).toEqual(['patient/Observation.read', 'patient/Condition.write']);
  });

  it('drops requested scopes not allowed', () => {
    const granted = resolveScopes(
      ['patient/Observation.read', 'system/Patient.write'],
      ['patient/*.read'],
    );
    expect(granted).toEqual(['patient/Observation.read']);
  });

  it('passes through identity scopes (openid, fhirUser, offline_access) when explicitly allowed', () => {
    const granted = resolveScopes(
      ['openid', 'fhirUser', 'offline_access', 'patient/*.read'],
      ['openid', 'fhirUser', 'offline_access', 'patient/*.read'],
    );
    expect(granted).toEqual(['openid', 'fhirUser', 'offline_access', 'patient/*.read']);
  });
});

describe('scopesAllow at resource boundary', () => {
  it('allows when scope matches level + resource + op exactly', () => {
    expect(scopesAllow(['patient/Observation.read'], { resource: 'Observation', operation: 'read' })).toBe(true);
  });

  it('honors wildcard resource', () => {
    expect(scopesAllow(['patient/*.read'], { resource: 'Observation', operation: 'read' })).toBe(true);
  });

  it('honors wildcard operation', () => {
    expect(scopesAllow(['patient/Observation.*'], { resource: 'Observation', operation: 'write' })).toBe(true);
  });

  it('rejects when level mismatches (patient vs user)', () => {
    expect(scopesAllow(['user/Observation.read'], { level: 'patient', resource: 'Observation' })).toBe(false);
  });

  it('rejects empty / malformed grants', () => {
    expect(scopesAllow([], { resource: 'Observation' })).toBe(false);
    expect(scopesAllow(['garbage'], { resource: 'Observation' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// App registration
// ---------------------------------------------------------------------------

describe('registerSmartApp', () => {
  it('rejects missing client_id', async () => {
    await expect(registerSmartApp({ tenantId: TENANT, displayName: 'X' }))
      .rejects.toThrow(/client_id is required/);
  });

  it('rejects missing display_name', async () => {
    await expect(registerSmartApp({ tenantId: TENANT, clientId: 'app1' }))
      .rejects.toThrow(/display_name is required/);
  });

  it('rejects public app without redirect URIs', async () => {
    await expect(registerSmartApp({
      tenantId: TENANT, clientId: 'app1', displayName: 'X', redirectUris: [],
    })).rejects.toThrow(/redirect_uris must include/);
  });

  it('inserts a public app, no client_secret returned', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, client_id: 'app1', app_kind: 'public', allowed_scopes: ['patient/*.read'],
    }]);
    const result = await registerSmartApp({
      tenantId: TENANT, clientId: 'app1', displayName: 'My App',
      redirectUris: ['https://example.com/cb'],
      allowedScopes: ['patient/*.read', 'launch', 'openid'],
    });
    expect(result.app.id).toBe(1);
    expect(result.plaintext_client_secret).toBeNull();
  });

  it('inserts a confidential app and returns plaintext_client_secret ONCE', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 2, client_id: 'svc1', app_kind: 'confidential',
    }]);
    const result = await registerSmartApp({
      tenantId: TENANT, clientId: 'svc1', displayName: 'Svc',
      appKind: 'confidential', redirectUris: ['https://example.com/cb'],
      allowedScopes: ['system/*.read'],
    });
    expect(result.plaintext_client_secret).toMatch(/^vh_smart_/);
    // Verify the encrypted value + hash flowed into the INSERT params, not the plaintext.
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params.some((p) => p === result.plaintext_client_secret)).toBe(false);
    // Encrypted with the field-encryption envelope (enc:v2: now; enc:v1: legacy).
    expect(params.some((p) => typeof p === 'string' && /^enc:v\d+:/.test(p))).toBe(true);
    expect(params.some((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p))).toBe(true); // hash
  });

  it('inserts a backend_service app without redirect URIs', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 3, app_kind: 'backend_service' }]);
    const result = await registerSmartApp({
      tenantId: TENANT, clientId: 'bs1', displayName: 'Backend Svc',
      appKind: 'backend_service', allowedScopes: ['system/*.read'],
    });
    expect(result.app.id).toBe(3);
  });

  it('throws conflict on duplicate (tenant, client_id, env)', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(registerSmartApp({
      tenantId: TENANT, clientId: 'app1', displayName: 'X',
      redirectUris: ['https://example.com/cb'],
    })).rejects.toThrow(/already exists/);
  });
});

describe('listSmartApps', () => {
  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "smart_apps" does not exist'));
    expect(await listSmartApps({ tenantId: TENANT })).toEqual({ apps: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Authorization code grant + PKCE
// ---------------------------------------------------------------------------

describe('issueAuthorizationCode + PKCE enforcement', () => {
  it('throws 404 when client_id unknown', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(issueAuthorizationCode({
      tenantId: TENANT, clientId: 'nope', redirectUri: 'https://x', requestedScopes: ['patient/Patient.read'],
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects when redirect_uri not registered', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'public',
      redirect_uris: ['https://app.example.com/cb'],
      allowed_scopes: ['patient/*.read'],
    }]);
    await expect(issueAuthorizationCode({
      tenantId: TENANT, clientId: 'app1',
      redirectUri: 'https://attacker.example/cb',
      requestedScopes: ['patient/Observation.read'],
      pkceCodeChallenge: 'x',
    })).rejects.toThrow(/redirect_uri is not registered/);
  });

  it('rejects when no requested scopes are allowed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'public',
      redirect_uris: ['https://app.example.com/cb'],
      allowed_scopes: ['patient/*.read'],
    }]);
    await expect(issueAuthorizationCode({
      tenantId: TENANT, clientId: 'app1',
      redirectUri: 'https://app.example.com/cb',
      requestedScopes: ['system/*.write'],
      pkceCodeChallenge: 'x',
    })).rejects.toThrow(/No requested scopes are allowed/);
  });

  it('requires PKCE for public clients', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'public',
      redirect_uris: ['https://app.example.com/cb'],
      allowed_scopes: ['patient/Observation.read'],
    }]);
    await expect(issueAuthorizationCode({
      tenantId: TENANT, clientId: 'app1',
      redirectUri: 'https://app.example.com/cb',
      requestedScopes: ['patient/Observation.read'],
    })).rejects.toThrow(/PKCE code_challenge is required/);
  });

  it('issues plaintext_code with PKCE attached', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'public',
      redirect_uris: ['https://app.example.com/cb'],
      allowed_scopes: ['patient/Observation.read', 'offline_access'],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, status: 'pending', granted_scopes: ['patient/Observation.read', 'offline_access'],
    }]);
    const result = await issueAuthorizationCode({
      tenantId: TENANT, clientId: 'app1',
      redirectUri: 'https://app.example.com/cb',
      requestedScopes: ['patient/Observation.read', 'offline_access'],
      pkceCodeChallenge: 'abc', pkceMethod: 'S256',
    });
    expect(result.plaintext_code).toMatch(/^vh_authz_/);
    expect(result.authz.id).toBe(50);
  });

  it('confidential client may skip PKCE', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'confidential',
      redirect_uris: ['https://app.example.com/cb'],
      allowed_scopes: ['patient/Observation.read'],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 51, status: 'pending' }]);
    const result = await issueAuthorizationCode({
      tenantId: TENANT, clientId: 'app1',
      redirectUri: 'https://app.example.com/cb',
      requestedScopes: ['patient/Observation.read'],
    });
    expect(result.plaintext_code).toMatch(/^vh_authz_/);
  });
});

// ---------------------------------------------------------------------------
// Token exchange + replay defense
// ---------------------------------------------------------------------------

describe('exchangeAuthorizationCode', () => {
  it('throws unauthorized on unknown client_id', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(exchangeAuthorizationCode({
      tenantId: TENANT, clientId: 'nope', code: 'x', redirectUri: 'https://x',
    })).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects confidential client without secret', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'confidential',
      redirect_uris: ['https://app.example.com/cb'],
      allowed_scopes: ['patient/*.read'],
      client_secret_hash: 'somehash',
    }]);
    await expect(exchangeAuthorizationCode({
      tenantId: TENANT, clientId: 'app1', code: 'x', redirectUri: 'https://app.example.com/cb',
    })).rejects.toMatchObject({ statusCode: 401 });
  });

  it('returns access_token + refresh_token when scope includes offline_access', async () => {
    const codeVerifier = 'verifier_string_123';
    const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'public',
      redirect_uris: ['https://app.example.com/cb'],
      allowed_scopes: ['patient/Observation.read', 'offline_access'],
      client_secret_hash: null,
    }]);
    // The atomic UPDATE consumes the code.
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, smart_app_id: 1, redirect_uri: 'https://app.example.com/cb',
      granted_scopes: ['patient/Observation.read', 'offline_access'],
      pkce_code_challenge: challenge, pkce_method: 'S256',
      patient_uid: PATIENT, encounter_id: 7, user_uid: USER, user_role: 'DOCTOR',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 99, granted_scopes: ['patient/Observation.read', 'offline_access'],
      access_expires_at: new Date(), refresh_expires_at: new Date(),
      patient_uid: PATIENT, encounter_id: 7, user_uid: USER, user_role: 'DOCTOR',
    }]);
    const result = await exchangeAuthorizationCode({
      tenantId: TENANT, clientId: 'app1', code: 'authcode',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier,
    });
    expect(result.access_token).toMatch(/^vh_access_/);
    expect(result.refresh_token).toMatch(/^vh_refresh_/);
    expect(result.token_type).toBe('Bearer');
    expect(result.scope).toBe('patient/Observation.read offline_access');
    expect(result.patient).toBe(PATIENT);
  });

  it('throws unauthorized when code already consumed (replay)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'public',
      redirect_uris: ['https://app.example.com/cb'],
      allowed_scopes: ['patient/*.read'],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // atomic update returns 0 rows
    await expect(exchangeAuthorizationCode({
      tenantId: TENANT, clientId: 'app1', code: 'x',
      redirectUri: 'https://app.example.com/cb',
    })).rejects.toThrow(/Invalid or expired authorization code/);
  });

  it('throws unauthorized on PKCE verifier mismatch', async () => {
    const challenge = crypto.createHash('sha256').update('right_verifier').digest('base64url');
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'public',
      redirect_uris: ['https://app.example.com/cb'],
      allowed_scopes: ['patient/*.read'],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 50, smart_app_id: 1, redirect_uri: 'https://app.example.com/cb',
      granted_scopes: ['patient/Observation.read'],
      pkce_code_challenge: challenge, pkce_method: 'S256',
    }]);
    await expect(exchangeAuthorizationCode({
      tenantId: TENANT, clientId: 'app1', code: 'x',
      redirectUri: 'https://app.example.com/cb',
      codeVerifier: 'wrong_verifier',
    })).rejects.toThrow(/PKCE verification failed/);
  });
});

// ---------------------------------------------------------------------------
// Refresh + verification
// ---------------------------------------------------------------------------

describe('refreshAccessToken rotation', () => {
  it('rotates the refresh token (parent_token_id pointer)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'public', client_secret_hash: null,
      redirect_uris: [], allowed_scopes: ['patient/*.read', 'offline_access'],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 99, granted_scopes: ['patient/*.read', 'offline_access'],
      patient_uid: PATIENT, encounter_id: null, user_uid: USER, user_role: 'DOCTOR',
      refresh_expires_at: new Date(Date.now() + 86400000),
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 100, access_expires_at: new Date(), refresh_expires_at: new Date() }]);
    const result = await refreshAccessToken({
      tenantId: TENANT, clientId: 'app1', refreshToken: 'rt',
    });
    expect(result.access_token).toMatch(/^vh_access_/);
    expect(result.refresh_token).toMatch(/^vh_refresh_/);
    const insertSql = queryUnsafeMock.mock.calls[2][0];
    expect(insertSql).toMatch(/parent_token_id/);
  });

  it('rejects expired/revoked refresh token', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'active', app_kind: 'public', client_secret_hash: null,
      redirect_uris: [], allowed_scopes: [],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // UPDATE returns 0 rows
    await expect(refreshAccessToken({
      tenantId: TENANT, clientId: 'app1', refreshToken: 'rt',
    })).rejects.toThrow(/Invalid or expired refresh token/);
  });
});

describe('verifyAccessToken', () => {
  it('returns null on missing token', async () => {
    expect(await verifyAccessToken({ tenantId: TENANT })).toBeNull();
  });

  it('returns null when not found / not active / expired', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    expect(await verifyAccessToken({
      tenantId: TENANT, accessToken: 'vh_access_x',
    })).toBeNull();
  });

  it('returns the token row + stamps last_used on hit', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, smart_app_id: 5, granted_scopes: ['patient/*.read'],
      client_id: 'app1', app_kind: 'public', app_status: 'active',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // last_used_at update
    const row = await verifyAccessToken({
      tenantId: TENANT, accessToken: 'vh_access_x', ipAddress: '10.0.0.1',
    });
    expect(row.id).toBe(1);
    const updateSql = queryUnsafeMock.mock.calls[1][0];
    expect(updateSql).toMatch(/last_used_at = NOW\(\)/);
  });

  it('returns null on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "smart_access_tokens" does not exist'));
    expect(await verifyAccessToken({
      tenantId: TENANT, accessToken: 'vh_access_x',
    })).toBeNull();
  });
});

describe('revokeAccessToken + listAccessTokens', () => {
  it('revokeAccessToken flips active -> revoked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'revoked' }]);
    const row = await revokeAccessToken({ tenantId: TENANT, id: 1, revokedReason: 'admin' });
    expect(row.status).toBe('revoked');
  });

  it('revokeAccessToken 404 when not active', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(revokeAccessToken({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('listAccessTokens degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "smart_access_tokens" does not exist'));
    expect(await listAccessTokens({ tenantId: TENANT })).toEqual({ tokens: [], count: 0 });
  });
});

describe('TTL constants', () => {
  it('sets access TTL = 1h, refresh TTL = 90d, authz code TTL = 5m', () => {
    expect(__testing__.ACCESS_TTL_SECONDS).toBe(3600);
    expect(__testing__.REFRESH_TTL_SECONDS).toBe(60 * 60 * 24 * 90);
    expect(__testing__.AUTHZ_CODE_TTL_SECONDS).toBe(300);
  });
});
