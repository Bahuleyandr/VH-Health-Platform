/**
 * Phase E3 — phiEnvelopeService unit tests.
 * Round-trip + tamper detection + KEK rotation.
 */

import crypto from 'crypto';
import { jest } from '@jest/globals';

const {
  EnvKmsProvider,
  resetKmsProviderForTesting,
} = await import('../../services/security/kmsProviderService.js');

const {
  decryptField,
  encryptField,
  isPhiEnvelope,
  rotateEnvelopeKek,
} = await import('../../services/security/phiEnvelopeService.js');

const MASTER_KEY_BASE64 = crypto.randomBytes(32).toString('base64');

beforeAll(() => {
  process.env.KMS_PROVIDER = 'env';
  process.env.KMS_MASTER_KEY = MASTER_KEY_BASE64;
  process.env.KMS_KEY_ID = 'k1';
  resetKmsProviderForTesting();
});

afterAll(() => {
  delete process.env.KMS_PROVIDER;
  delete process.env.KMS_MASTER_KEY;
  delete process.env.KMS_KEY_ID;
  resetKmsProviderForTesting();
});

describe('encryptField / decryptField round-trip', () => {
  it('encrypts a string and decrypts back to the same plaintext', () => {
    const ciphertext = encryptField('Mrs Mahalakshmi Subramanian — flagged for follow-up');
    expect(ciphertext).not.toContain('Mahalakshmi');
    const back = decryptField(ciphertext);
    expect(back).toBe('Mrs Mahalakshmi Subramanian — flagged for follow-up');
  });

  it('passes through null/empty input', () => {
    expect(encryptField(null)).toBeNull();
    expect(encryptField('')).toBeNull();
    expect(decryptField(null)).toBeNull();
    expect(decryptField('')).toBeNull();
  });

  it('produces a different ciphertext for the same plaintext on each call (fresh DEK + IV)', () => {
    const a = encryptField('hello');
    const b = encryptField('hello');
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe('hello');
    expect(decryptField(b)).toBe('hello');
  });

  it('throws on tampered ciphertext (AES-GCM auth tag fails)', () => {
    const env = JSON.parse(encryptField('top-secret'));
    const ctBuf = Buffer.from(env.ct, 'base64');
    ctBuf[0] ^= 0xff;
    env.ct = ctBuf.toString('base64');
    expect(() => decryptField(JSON.stringify(env))).toThrow();
  });

  it('rejects an envelope from a different KEK kid', () => {
    const ciphertext = encryptField('hello');
    const env = JSON.parse(ciphertext);
    env.kid = 'wrong-kid';
    expect(() => decryptField(JSON.stringify(env))).toThrow(/kid mismatch/);
  });

  it('rejects a malformed envelope', () => {
    expect(() => decryptField('{not json')).toThrow(/PHI envelope is not valid JSON/);
  });

  it('rejects a future envelope version', () => {
    const ciphertext = encryptField('hello');
    const env = JSON.parse(ciphertext);
    env.v = 999;
    expect(() => decryptField(JSON.stringify(env))).toThrow(/version mismatch/);
  });
});

describe('isPhiEnvelope', () => {
  it('detects a valid envelope', () => {
    expect(isPhiEnvelope(encryptField('x'))).toBe(true);
  });

  it('returns false for non-envelope strings', () => {
    expect(isPhiEnvelope('hello')).toBe(false);
    expect(isPhiEnvelope('{"foo":"bar"}')).toBe(false);
    expect(isPhiEnvelope(null)).toBe(false);
  });
});

describe('rotateEnvelopeKek', () => {
  it('re-wraps the DEK under a new KEK without re-encrypting payload', () => {
    const newKey = crypto.randomBytes(32).toString('base64');
    const oldProvider = new EnvKmsProvider({ masterKeyBase64: MASTER_KEY_BASE64, keyId: 'k1' });
    const newProvider = new EnvKmsProvider({ masterKeyBase64: newKey, keyId: 'k2' });
    const ciphertext = encryptField('high-PHI-content', { provider: oldProvider });

    const rotated = rotateEnvelopeKek(ciphertext, {
      fromProvider: oldProvider, toProvider: newProvider,
    });
    expect(rotated).not.toBe(ciphertext);

    // Original payload bytes should still match (DEK changed, ct didn't).
    const origEnv = JSON.parse(ciphertext);
    const newEnv = JSON.parse(rotated);
    expect(newEnv.ct).toBe(origEnv.ct);
    expect(newEnv.iv).toBe(origEnv.iv);
    expect(newEnv.tag).toBe(origEnv.tag);
    expect(newEnv.edek).not.toBe(origEnv.edek);
    expect(newEnv.kid).toBe('k2');

    // Old provider can no longer decrypt; new provider can.
    expect(() => decryptField(rotated, { provider: oldProvider })).toThrow();
    expect(decryptField(rotated, { provider: newProvider })).toBe('high-PHI-content');
  });
});
