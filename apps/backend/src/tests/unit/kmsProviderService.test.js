/**
 * Phase E3 — KMS provider unit tests.
 * Verifies the EnvKmsProvider DEK wrap/unwrap round-trip + tamper +
 * kid-mismatch behaviour.
 */

import crypto from 'crypto';
import { jest } from '@jest/globals';

const {
  EnvKmsProvider,
  resetKmsProviderForTesting,
  getKmsProvider,
} = await import('../../services/security/kmsProviderService.js');

const MASTER_KEY_BASE64 = crypto.randomBytes(32).toString('base64');

beforeEach(() => {
  resetKmsProviderForTesting();
  process.env.KMS_PROVIDER = 'env';
  process.env.KMS_MASTER_KEY = MASTER_KEY_BASE64;
  process.env.KMS_KEY_ID = 'test-key-1';
});

afterAll(() => {
  delete process.env.KMS_PROVIDER;
  delete process.env.KMS_MASTER_KEY;
  delete process.env.KMS_KEY_ID;
  resetKmsProviderForTesting();
});

describe('EnvKmsProvider', () => {
  it('throws when KMS_MASTER_KEY is missing', () => {
    expect(() => new EnvKmsProvider({ masterKeyBase64: null }))
      .not.toThrow(); // env var is set in beforeEach
    delete process.env.KMS_MASTER_KEY;
    expect(() => new EnvKmsProvider({}))
      .toThrow(/KMS_MASTER_KEY/);
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => new EnvKmsProvider({ masterKeyBase64: 'YWJj' }))
      .toThrow(/32 bytes/);
  });

  it('wraps and unwraps a DEK losslessly', () => {
    const provider = new EnvKmsProvider({ masterKeyBase64: MASTER_KEY_BASE64, keyId: 'k1' });
    const dek = provider.generateDek();
    const wrapped = provider.wrapDek(dek);
    expect(wrapped.kid).toBe('k1');
    expect(wrapped.edek).not.toEqual(dek);
    const unwrapped = provider.unwrapDek(wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it('throws on tampered ciphertext', () => {
    const provider = new EnvKmsProvider({ masterKeyBase64: MASTER_KEY_BASE64, keyId: 'k1' });
    const dek = provider.generateDek();
    const wrapped = provider.wrapDek(dek);
    const tampered = Buffer.from(wrapped.edek);
    tampered[0] ^= 0xff;
    expect(() => provider.unwrapDek({ ...wrapped, edek: tampered }))
      .toThrow();
  });

  it('refuses to unwrap a DEK from a different kid', () => {
    const provider1 = new EnvKmsProvider({ masterKeyBase64: MASTER_KEY_BASE64, keyId: 'k1' });
    const provider2 = new EnvKmsProvider({ masterKeyBase64: MASTER_KEY_BASE64, keyId: 'k2' });
    const wrapped = provider1.wrapDek(provider1.generateDek());
    expect(() => provider2.unwrapDek(wrapped))
      .toThrow(/kid mismatch/);
  });
});

describe('getKmsProvider', () => {
  it('caches the active provider', () => {
    const a = getKmsProvider();
    const b = getKmsProvider();
    expect(a).toBe(b);
  });

  it('rebuilds when refresh is true', () => {
    const a = getKmsProvider();
    const b = getKmsProvider({ refresh: true });
    expect(a).not.toBe(b);
  });

  it('throws on unknown provider name', () => {
    process.env.KMS_PROVIDER = 'magic';
    expect(() => getKmsProvider({ refresh: true })).toThrow(/Unknown KMS_PROVIDER/);
  });
});
