/**
 * Beckn/DHP signature helpers for the UHI adapter (migration 705).
 *
 * Pure crypto — no DB, no mocks. Generates a real ed25519 keypair, exercises
 * the sign → verify roundtrip over exact raw bytes, and pins the fail-closed
 * behaviours: tampered body, wrong key, stale/oversized validity window,
 * malformed header, malformed key material.
 */
import crypto from 'node:crypto';
import {
  buildBecknSigningString,
  computeBecknDigest,
  parseBecknAuthorizationHeader,
  signBecknRequest,
  verifyBecknSignature,
} from '../../utils/uhiSignature.js';

function generateKeypairBase64() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  return {
    publicKeyBase64: Buffer.from(pubJwk.x, 'base64url').toString('base64'),
    privateKeyBase64: Buffer.from(privJwk.d, 'base64url').toString('base64'),
  };
}

const { publicKeyBase64, privateKeyBase64 } = generateKeypairBase64();
const rawBody = JSON.stringify({
  context: { transaction_id: 'txn-1', message_id: 'msg-1', action: 'search' },
  message: { intent: {} },
});

describe('uhiSignature (beckn ed25519 over BLAKE-512 digest)', () => {
  it('parses a beckn Authorization Signature header into its parameters', () => {
    const parsed = parseBecknAuthorizationHeader(
      'Signature keyId="hsp.vh|key1|ed25519",algorithm="ed25519",created="1700000000",expires="1700000600",headers="(created) (expires) digest",signature="c2ln"',
    );
    expect(parsed).toMatchObject({
      keyId: 'hsp.vh|key1|ed25519',
      algorithm: 'ed25519',
      created: '1700000000',
      expires: '1700000600',
      signature: 'c2ln',
    });
    // Non-Signature schemes and empty headers are null, not throws.
    expect(parseBecknAuthorizationHeader('Bearer abc')).toBeNull();
    expect(parseBecknAuthorizationHeader('')).toBeNull();
    expect(parseBecknAuthorizationHeader(undefined)).toBeNull();
  });

  it('builds the pinned signing-string shape over the BLAKE-512 digest', () => {
    const digest = computeBecknDigest('{}');
    expect(digest).toBe(crypto.createHash('blake2b512').update('{}').digest('base64'));
    expect(buildBecknSigningString({ created: 1, expires: 2, digest: 'D' }))
      .toBe('(created): 1\n(expires): 2\ndigest: BLAKE-512=D');
  });

  it('roundtrips: our signer produces a header the verifier accepts over the same bytes', () => {
    const header = signBecknRequest({
      rawBody,
      privateKeyBase64,
      keyId: 'hsp.vh|key1|ed25519',
    });
    const result = verifyBecknSignature({
      authorizationHeader: header,
      rawBody,
      publicKeyBase64,
    });
    expect(result.keyId).toBe('hsp.vh|key1|ed25519');
    expect(result.expires).toBeGreaterThan(result.created);
  });

  it('rejects a tampered body (digest binds the exact raw bytes)', () => {
    const header = signBecknRequest({ rawBody, privateKeyBase64, keyId: 'eua.example|k|ed25519' });
    expect(() => verifyBecknSignature({
      authorizationHeader: header,
      rawBody: rawBody.replace('msg-1', 'msg-2'),
      publicKeyBase64,
    })).toThrow(expect.objectContaining({ code: 'UHI_SIGNATURE_INVALID', statusCode: 401 }));
  });

  it('rejects a signature from a different key', () => {
    const other = generateKeypairBase64();
    const header = signBecknRequest({
      rawBody,
      privateKeyBase64: other.privateKeyBase64,
      keyId: 'eua.example|k|ed25519',
    });
    expect(() => verifyBecknSignature({
      authorizationHeader: header,
      rawBody,
      publicKeyBase64,
    })).toThrow(expect.objectContaining({ code: 'UHI_SIGNATURE_INVALID' }));
  });

  it('rejects stale signatures and absurd validity windows', () => {
    const header = signBecknRequest({
      rawBody,
      privateKeyBase64,
      keyId: 'eua.example|k|ed25519',
      validitySeconds: 600,
      nowMs: Date.now() - 60 * 60 * 1000, // signed an hour ago, 10-min validity
    });
    expect(() => verifyBecknSignature({
      authorizationHeader: header,
      rawBody,
      publicKeyBase64,
    })).toThrow(expect.objectContaining({ code: 'UHI_SIGNATURE_STALE' }));

    const oversized = signBecknRequest({
      rawBody,
      privateKeyBase64,
      keyId: 'eua.example|k|ed25519',
      validitySeconds: 7 * 24 * 3600, // a week — sender cannot mint long-lived replays
    });
    expect(() => verifyBecknSignature({
      authorizationHeader: oversized,
      rawBody,
      publicKeyBase64,
    })).toThrow(expect.objectContaining({ code: 'UHI_SIGNATURE_WINDOW_INVALID' }));
  });

  it('fails closed on missing header or unconfigured/malformed key material', () => {
    expect(() => verifyBecknSignature({
      authorizationHeader: undefined,
      rawBody,
      publicKeyBase64,
    })).toThrow(expect.objectContaining({ code: 'UHI_SIGNATURE_REQUIRED' }));

    const header = signBecknRequest({ rawBody, privateKeyBase64, keyId: 'eua.example|k|ed25519' });
    expect(() => verifyBecknSignature({
      authorizationHeader: header,
      rawBody,
      publicKeyBase64: '',
    })).toThrow(expect.objectContaining({ code: 'UHI_SIGNATURE_KEY_NOT_CONFIGURED', statusCode: 503 }));
    expect(() => verifyBecknSignature({
      authorizationHeader: header,
      rawBody,
      publicKeyBase64: Buffer.from('short').toString('base64'),
    })).toThrow(expect.objectContaining({ code: 'UHI_SIGNATURE_KEY_INVALID' }));
  });

  it('binds keyId signer identity to the authenticated counterparty', () => {
    const header = signBecknRequest({
      rawBody,
      privateKeyBase64,
      keyId: 'eua.example|key1|ed25519',
    });
    expect(() => verifyBecknSignature({
      authorizationHeader: header,
      rawBody,
      publicKeyBase64,
      expectedSignerId: 'attacker.example',
    })).toThrow(expect.objectContaining({ code: 'UHI_SIGNATURE_SENDER_MISMATCH' }));
    expect(verifyBecknSignature({
      authorizationHeader: header,
      rawBody,
      publicKeyBase64,
      expectedSignerId: 'eua.example',
    })).toMatchObject({ keyId: 'eua.example|key1|ed25519' });
  });
});
