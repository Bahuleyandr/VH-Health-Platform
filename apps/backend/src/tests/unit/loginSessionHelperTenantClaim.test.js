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

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $executeRawUnsafe: mockExecuteRaw,
    $queryRawUnsafe: mockQueryRaw,
  },
}));

jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  generateToken: jest.fn((payload) => `eyJ.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`),
}));

jest.unstable_mockModule('../../services/auth/userActiveSession.js', () => ({
  claimUserSession: jest.fn(async () => ({ revokedPrior: false, priorDeviceType: null })),
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
});

describe('issueAccessTokenAndClaimSession — tenant_id claim (Phase 1)', () => {
  it('resolves tenant_id from users.tenant_id when not in payload', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ tenant_id: SEEDED_TENANT }]);
    const { accessToken } = await issueAccessTokenAndClaimSession({
      userUid: 'a1111111-1111-4111-8111-111111111111',
      tokenPayload: { uid: 'a1111111-1111-4111-8111-111111111111', role: 'DOCTOR' },
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
    });
    const payload = decodePayload(accessToken);
    expect(payload.tenant_id).toBe(DEFAULT_TENANT);
  });

  it('falls back to DEFAULT_TENANT when the users row has no tenant_id', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ tenant_id: null }]);
    const { accessToken } = await issueAccessTokenAndClaimSession({
      userUid: 'a3333333-3333-4333-8333-333333333333',
      tokenPayload: { uid: 'a3333333-3333-4333-8333-333333333333', role: 'PATIENT' },
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
    });
    await issueAccessTokenAndClaimSession({
      userUid: uid,
      tokenPayload: { uid, role: 'DOCTOR' },
    });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });
});
