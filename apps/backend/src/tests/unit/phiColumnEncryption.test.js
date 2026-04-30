/**
 * Phase E3 follow-up — phiColumnEncryption helper unit tests.
 */

import crypto from 'crypto';
import { jest } from '@jest/globals';

const {
  resetKmsProviderForTesting,
} = await import('../../services/security/kmsProviderService.js');

const {
  decryptColumn,
  dualWritePhone,
  dualWriteValue,
  encryptColumn,
  readWithFallback,
  resetSearchHmacKeyForTesting,
  searchableHash,
} = await import('../../services/security/phiColumnEncryption.js');

const KMS_MASTER = crypto.randomBytes(32).toString('base64');
const SEARCH_KEY = crypto.randomBytes(32).toString('base64');

beforeAll(() => {
  process.env.KMS_PROVIDER = 'env';
  process.env.KMS_MASTER_KEY = KMS_MASTER;
  process.env.KMS_KEY_ID = 'col-test';
  process.env.PHI_SEARCH_HASH_KEY = SEARCH_KEY;
  resetKmsProviderForTesting();
  resetSearchHmacKeyForTesting();
});

afterAll(() => {
  delete process.env.KMS_PROVIDER;
  delete process.env.KMS_MASTER_KEY;
  delete process.env.KMS_KEY_ID;
  delete process.env.PHI_SEARCH_HASH_KEY;
  resetKmsProviderForTesting();
  resetSearchHmacKeyForTesting();
});

describe('encryptColumn / decryptColumn', () => {
  it('round-trips PHI text', () => {
    const env = encryptColumn('Mahalakshmi Subramanian');
    expect(env).not.toContain('Mahalakshmi');
    expect(decryptColumn(env)).toBe('Mahalakshmi Subramanian');
  });
  it('passes null/empty through unchanged', () => {
    expect(encryptColumn(null)).toBeNull();
    expect(encryptColumn('')).toBeNull();
    expect(decryptColumn(null)).toBeNull();
  });
  it('decryptColumn returns fallback when envelope is null', () => {
    expect(decryptColumn(null, 'PLAINTEXT')).toBe('PLAINTEXT');
  });
  it('throws on tampered envelope', () => {
    const env = encryptColumn('top-secret');
    const tampered = JSON.parse(env);
    const ctBuf = Buffer.from(tampered.ct, 'base64');
    ctBuf[0] ^= 0xff;
    tampered.ct = ctBuf.toString('base64');
    expect(() => decryptColumn(JSON.stringify(tampered))).toThrow();
  });
});

describe('searchableHash', () => {
  it('is deterministic for the same input', () => {
    const a = searchableHash('+919876543210');
    const b = searchableHash('+919876543210');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('normalises case + whitespace', () => {
    expect(searchableHash(' MahaLakshmi@Example.com '))
      .toBe(searchableHash('mahalakshmi@example.com'));
  });
  it('returns null for empty input', () => {
    expect(searchableHash(null)).toBeNull();
    expect(searchableHash('')).toBeNull();
  });
  it('produces different hashes for different inputs', () => {
    expect(searchableHash('+919876543210')).not.toBe(searchableHash('+919876543211'));
  });
});

describe('dualWriteValue', () => {
  it('returns plain + encrypted for a present value', () => {
    const out = dualWriteValue('Sundaram');
    expect(out.plain).toBe('Sundaram');
    expect(out.encrypted).not.toBeNull();
    expect(decryptColumn(out.encrypted)).toBe('Sundaram');
  });
  it('returns null for both when value is null', () => {
    expect(dualWriteValue(null)).toEqual({ plain: null, encrypted: null });
  });
  it('preserves undefined as undefined for plain (do-not-update sentinel)', () => {
    const out = dualWriteValue(undefined);
    expect(out.plain).toBeUndefined();
    expect(out.encrypted).toBeNull();
  });
});

describe('dualWritePhone', () => {
  it('returns plain + encrypted + search_hash', () => {
    const out = dualWritePhone('+919876543210');
    expect(out.plain).toBe('+919876543210');
    expect(out.encrypted).not.toBeNull();
    expect(out.search_hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('search_hash is stable across calls (enables equality lookup)', () => {
    const a = dualWritePhone('+919876543210').search_hash;
    const b = dualWritePhone('+919876543210').search_hash;
    expect(a).toBe(b);
  });
  it('handles null input cleanly', () => {
    expect(dualWritePhone(null)).toEqual({ plain: null, encrypted: null, search_hash: null });
  });
});

describe('readWithFallback', () => {
  it('prefers the encrypted column when present', () => {
    const env = encryptColumn('encrypted-version');
    expect(readWithFallback({ encryptedValue: env, plainValue: 'plain-version' }))
      .toBe('encrypted-version');
  });
  it('falls back to plain when encrypted is null', () => {
    expect(readWithFallback({ encryptedValue: null, plainValue: 'plain-version' }))
      .toBe('plain-version');
  });
  it('falls back to plain when envelope is corrupt (does not throw)', () => {
    expect(readWithFallback({ encryptedValue: '{not json', plainValue: 'plain' }))
      .toBe('plain');
  });
  it('returns null when both are null', () => {
    expect(readWithFallback({})).toBeNull();
  });
});
