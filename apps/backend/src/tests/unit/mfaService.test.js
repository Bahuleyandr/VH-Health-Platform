/**
 * Phase B4 — mfaService unit tests.
 *
 * Covers the RFC 6238 TOTP crypto helpers (round-trip + replay window),
 * enrollment + verification flow, replay prevention via last_step,
 * backup-code consumption, and the disabled-module guards.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  authenticateTotp,
  computeTotpCode,
  consumeBackupCode,
  currentStep,
  enrollTotpDevice,
  generateTotpSecret,
  listMfaDevices,
  revokeDevice,
  verifyAndActivateDevice,
  verifyTotpCode,
  __testing__,
} = await import('../../services/auth/mfaService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('TOTP crypto round-trip', () => {
  it('generateTotpSecret returns >= 16 char base32', () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it('computeTotpCode is deterministic for the same step', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const c1 = computeTotpCode({ secret, step: 12345 });
    const c2 = computeTotpCode({ secret, step: 12345 });
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^\d{6}$/);
  });

  it('verifyTotpCode accepts the code at center step', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const at = Date.now();
    const step = currentStep({ at });
    const code = computeTotpCode({ secret, step });
    const got = verifyTotpCode({ secret, code, at });
    expect(got).toBe(step);
  });

  it('verifyTotpCode accepts +/- 1 step within window', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const at = Date.now();
    const step = currentStep({ at });
    const code = computeTotpCode({ secret, step: step - 1 });
    const got = verifyTotpCode({ secret, code, at });
    expect(got).toBe(step - 1);
  });

  it('verifyTotpCode rejects wrong code', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(verifyTotpCode({ secret, code: '000000' })).toBeNull();
  });

  it('base32 encode/decode round-trip', () => {
    const random = Buffer.from('abc123');
    const encoded = __testing__.base32Encode(random);
    const decoded = __testing__.base32Decode(encoded);
    expect(decoded.toString()).toBe('abc123');
  });
});

describe('enrollTotpDevice', () => {
  it('rejects missing user_uid', async () => {
    await expect(enrollTotpDevice({ tenantId: TENANT }))
      .rejects.toThrow(/user_uid is required/);
  });

  it('inserts a pending device + returns otpauth URL', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', algorithm: 'sha1', digits: 6, period_seconds: 30,
    }]);
    const result = await enrollTotpDevice({
      tenantId: TENANT, userUid: USER, displayName: 'admin@vh',
    });
    expect(result.device.status).toBe('pending');
    expect(result.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
    expect(result.otpauth_url).toContain('secret=');
    const storedSecret = queryUnsafeMock.mock.calls[0][4];
    expect(storedSecret).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i);
    expect(result.otpauth_url).not.toContain(encodeURIComponent(storedSecret));
  });

  it('throws conflict when user already has a verified TOTP device', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(enrollTotpDevice({ tenantId: TENANT, userUid: USER }))
      .rejects.toThrow(/already has a verified TOTP device/);
  });
});

describe('verifyAndActivateDevice', () => {
  it('throws 404 when device missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(verifyAndActivateDevice({
      tenantId: TENANT, deviceId: 1, code: '123456',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects when device status != pending', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'verified', secret_ciphertext: 'JBSWY3DPEHPK3PXP',
      algorithm: 'sha1', digits: 6, period_seconds: 30, user_uid: USER,
    }]);
    await expect(verifyAndActivateDevice({
      tenantId: TENANT, deviceId: 1, code: '123456',
    })).rejects.toThrow(/not pending/);
  });

  it('rejects invalid TOTP code (and persists failure challenge)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', secret_ciphertext: 'JBSWY3DPEHPK3PXP',
      algorithm: 'sha1', digits: 6, period_seconds: 30, user_uid: USER,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'failure' }]); // challenge insert
    await expect(verifyAndActivateDevice({
      tenantId: TENANT, deviceId: 1, code: '000000',
    })).rejects.toMatchObject({ statusCode: 401 });
  });

  it('activates + returns backup codes on valid TOTP', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const at = Date.now();
    const step = currentStep({ at });
    const code = computeTotpCode({ secret, step });
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', secret_ciphertext: secret,
      algorithm: 'sha1', digits: 6, period_seconds: 30, user_uid: USER,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'success', step }]); // challenge insert
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'verified', verified_at: new Date() }]); // update device
    // 10 backup-code inserts
    for (let i = 0; i < 10; i += 1) queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await verifyAndActivateDevice({
      tenantId: TENANT, deviceId: 1, code,
    });
    expect(result.device.status).toBe('verified');
    expect(result.backup_codes).toHaveLength(10);
    expect(result.next_step_after).toBe(step);
  });
});

describe('authenticateTotp replay prevention', () => {
  it('throws unauthorized when user has no verified device', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(authenticateTotp({
      tenantId: TENANT, userUid: USER, code: '123456',
    })).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects when step <= last_step (replay)', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const step = currentStep({});
    const code = computeTotpCode({ secret, step });
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, secret_ciphertext: secret, algorithm: 'sha1', digits: 6,
      period_seconds: 30, last_step: String(step + 1),
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]); // failure challenge insert
    await expect(authenticateTotp({
      tenantId: TENANT, userUid: USER, code,
    })).rejects.toThrow(/already used/);
  });

  it('rejects when challenge insert hits unique violation (concurrent replay)', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const step = currentStep({});
    const code = computeTotpCode({ secret, step });
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, secret_ciphertext: secret, algorithm: 'sha1', digits: 6,
      period_seconds: 30, last_step: null,
    }]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value'));
    await expect(authenticateTotp({
      tenantId: TENANT, userUid: USER, code,
    })).rejects.toThrow(/already used/);
  });

  it('succeeds + bumps last_step', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const step = currentStep({});
    const code = computeTotpCode({ secret, step });
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, secret_ciphertext: secret, algorithm: 'sha1', digits: 6,
      period_seconds: 30, last_step: null,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'success' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await authenticateTotp({
      tenantId: TENANT, userUid: USER, code,
    });
    expect(result.authenticated).toBe(true);
    expect(result.step).toBe(step);
  });
});

describe('consumeBackupCode', () => {
  it('rejects empty code', async () => {
    await expect(consumeBackupCode({
      tenantId: TENANT, userUid: USER, code: '   ',
    })).rejects.toThrow(/code is required/);
  });

  it('returns 401 when no backup code matches', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(consumeBackupCode({
      tenantId: TENANT, userUid: USER, code: 'WRONG-CODE',
    })).rejects.toMatchObject({ statusCode: 401 });
  });

  it('marks the matching backup code as used', async () => {
    const salt = '11111111111111111111111111111111';
    const code = 'TESTCODE12';
    const hash = __testing__.hashBackupCode(code, salt);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, code_hash: hash, code_salt: salt }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const result = await consumeBackupCode({
      tenantId: TENANT, userUid: USER, code,
    });
    expect(result.authenticated).toBe(true);
    expect(result.code_id).toBe(5);
  });
});

describe('revokeDevice + listMfaDevices', () => {
  it('revokeDevice flips status to revoked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'revoked' }]);
    const row = await revokeDevice({ tenantId: TENANT, deviceId: 1 });
    expect(row.status).toBe('revoked');
  });

  it('revokeDevice can self-scope by user_uid to prevent guessed device IDs', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'revoked', user_uid: USER }]);
    await revokeDevice({ tenantId: TENANT, deviceId: 1, userUid: USER });

    const [sql, ...params] = queryUnsafeMock.mock.calls[0];
    expect(sql).toContain('id = $1');
    expect(sql).toContain('tenant_id = $2::uuid');
    expect(sql).toContain('status <>');
    expect(sql).toContain('user_uid = $3::uuid');
    expect(params).toEqual([1, TENANT, USER]);
  });

  it('revokeDevice 404 when already revoked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(revokeDevice({ tenantId: TENANT, deviceId: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('listMfaDevices degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "mfa_devices" does not exist'));
    expect(await listMfaDevices({ tenantId: TENANT })).toEqual({ devices: [], count: 0 });
  });
});
