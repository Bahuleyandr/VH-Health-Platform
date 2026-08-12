// Regression: every JWT issued by issueAccessTokenAndClaimSession must
// carry a `tenant_id` claim resolved from the users row, falling back to
// the default tenant when the lookup fails.
//
// Phase 1 of the tenant RLS rollout (docs/GAP_ANALYSIS_TENANT_RLS.md).

import { jest } from '@jest/globals';

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const SEEDED_TENANT = '11111111-1111-4111-8111-111111111111';

// Hoisted prisma mock so the import-cache returns it to loginSessionHelper.
const mockExecuteRaw = jest.fn();
const mockQueryRaw = jest.fn();
const claimUserSessionMock = jest.fn(async () => ({ revokedPrior: false, priorDeviceType: null }));

const __prismaDefaultMock = {
  $executeRawUnsafe: mockExecuteRaw,
  $queryRawUnsafe: mockQueryRaw,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  generateToken: jest.fn((payload) => `eyJ.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`),
}));

jest.unstable_mockModule('../../services/auth/userActiveSession.js', () => ({
  claimUserSession: claimUserSessionMock,
}));

// Lazy-load helper after mocks are wired.
const { issueAccessTokenAndClaimSession } = await import('../../services/auth/loginSessionHelper.js');

function decodePayload(token) {
  const [, body] = token.split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

beforeEach(() => {
  mockQueryRaw.mockReset();
  mockExecuteRaw.mockReset();
  claimUserSessionMock.mockClear();
});

describe('issueAccessTokenAndClaimSession — tenant_id claim (Phase 1)', () => {
  it('resolves tenant_id from users.tenant_id when not in payload', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ tenant_id: SEEDED_TENANT }]);
    const { accessToken } = await issueAccessTokenAndClaimSession({
      userUid: 'a1111111-1111-4111-8111-111111111111',
      tokenPayload: { uid: 'a1111111-1111-4111-8111-111111111111', role: 'DOCTOR' },
      tokenEpoch: 0,
    });
    const payload = decodePayload(accessToken);
    expect(payload.tenant_id).toBe(SEEDED_TENANT);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('falls back to DEFAULT_TENANT when the lookup throws (DB blip)', async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error('connection reset'));
    const { accessToken } = await issueAccessTokenAndClaimSession({
      userUid: 'a2222222-2222-4222-8222-222222222222',
      tokenPayload: { uid: 'a2222222-2222-4222-8222-222222222222', role: 'NURSING_STAFF' },
      tokenEpoch: 0,
    });
    const payload = decodePayload(accessToken);
    expect(payload.tenant_id).toBe(DEFAULT_TENANT);
  });

  it('falls back to DEFAULT_TENANT when the users row has no tenant_id', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ tenant_id: null }]);
    const { accessToken } = await issueAccessTokenAndClaimSession({
      userUid: 'a3333333-3333-4333-8333-333333333333',
      tokenPayload: { uid: 'a3333333-3333-4333-8333-333333333333', role: 'PATIENT' },
      tokenEpoch: 0,
    });
    expect(decodePayload(accessToken).tenant_id).toBe(DEFAULT_TENANT);
  });

  it('honours an explicit tenant_id in the payload over the lookup (refresh rotation)', async () => {
    // Even though we'd resolve to SEEDED_TENANT if asked, the payload's
    // value wins. Refresh-token rotation carries the prior tenant_id
    // forward to avoid a needless DB hit.
    mockQueryRaw.mockResolvedValueOnce([{ tenant_id: SEEDED_TENANT }]);
    const { accessToken } = await issueAccessTokenAndClaimSession({
      userUid: 'a4444444-4444-4444-8444-444444444444',
      tokenPayload: {
        uid: 'a4444444-4444-4444-8444-444444444444',
        role: 'ADMIN',
        tenant_id: '22222222-2222-4222-8222-222222222222',
      },
      tokenEpoch: 0,
    });
    expect(decodePayload(accessToken).tenant_id).toBe('22222222-2222-4222-8222-222222222222');
    // Lookup should NOT have happened because the payload already had it.
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('caches the resolution per uid for the process lifetime', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ tenant_id: SEEDED_TENANT }]);
    const uid = 'a5555555-5555-4555-8555-555555555555';
    await issueAccessTokenAndClaimSession({
      userUid: uid,
      tokenPayload: { uid, role: 'DOCTOR' },
      tokenEpoch: 0,
    });
    await issueAccessTokenAndClaimSession({
      userUid: uid,
      tokenPayload: { uid, role: 'DOCTOR' },
      tokenEpoch: 0,
    });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('stamps the supplied epoch snapshot on the access token and returns it to the paired minter', async () => {
    const uid = 'a6666666-6666-4666-8666-666666666666';
    const result = await issueAccessTokenAndClaimSession({
      userUid: uid,
      tokenPayload: { uid, role: 'PATIENT', tenant_id: SEEDED_TENANT },
      tokenEpoch: 7,
    });

    expect(decodePayload(result.accessToken).token_epoch).toBe(7);
    expect(result.tokenEpoch).toBe(7);
  });

  it('generates one stable session family and preserves an explicitly supplied family on refresh', async () => {
    const uid = 'a7777777-7777-4777-8777-777777777777';
    const first = await issueAccessTokenAndClaimSession({
      userUid: uid,
      tokenPayload: { uid, role: 'PATIENT', tenant_id: SEEDED_TENANT },
      tokenEpoch: 0,
    });

    expect(first.sessionFamilyId).toEqual(expect.any(String));
    expect(decodePayload(first.accessToken).sessionFamilyId).toBe(first.sessionFamilyId);

    const rotated = await issueAccessTokenAndClaimSession({
      userUid: uid,
      tokenPayload: { uid, role: 'PATIENT', tenant_id: SEEDED_TENANT },
      tokenEpoch: 0,
      sessionFamilyId: first.sessionFamilyId,
      pushRevoked: false,
    });

    expect(rotated.sessionFamilyId).toBe(first.sessionFamilyId);
    expect(decodePayload(rotated.accessToken).sessionFamilyId).toBe(first.sessionFamilyId);
  });

  it('persists the access token session family and stable device selectors', async () => {
    const uid = 'a8888888-8888-4888-8888-888888888888';
    const stableDeviceId = 'e69ab614-d313-4f14-904f-fbd966abb546';
    const sessionFamilyId = '3f814b18-cb21-44ea-b915-e91ea96f2b58';

    await issueAccessTokenAndClaimSession({
      userUid: uid,
      tokenPayload: { uid, role: 'NURSING_STAFF', tenant_id: SEEDED_TENANT },
      tokenEpoch: 0,
      stableDeviceId,
      sessionFamilyId,
    });

    expect(claimUserSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      userUid: uid,
      stableDeviceId,
      sessionFamilyId,
    }));
  });
});
