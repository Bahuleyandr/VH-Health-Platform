// Roadmap C1 follow-up — ABDM FIDELIUS-equivalent payload crypto.
//
// Anchors: the X25519 agreement is checked against the RFC 7748 §6.1 test
// vector; the salt/iv layout is checked against hand-computed nonce XOR;
// the end-to-end path is checked against an independent re-derivation using
// Node primitives directly (HKDF-SHA256 + AES-256-GCM), plus tamper and
// negative-path cases. Final byte-level interop sign-off happens against
// the ABDM sandbox HIU (docs/ABDM_READINESS.md).

import crypto from 'crypto';
import {
  generateKeyMaterial,
  decodePublicKey,
  privateKeyFromRaw,
  deriveSharedSecret,
  deriveSessionKey,
  encryptPayload,
  decryptPayload,
  encryptFhirBundle,
  decryptFhirBundle,
} from '../../services/abdm/abdmCrypto.js';

// RFC 7748 §6.1 Diffie-Hellman test vector.
const ALICE_PRIV = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
const ALICE_PUB = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
const BOB_PRIV = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
const BOB_PUB = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
const RFC7748_SHARED = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');

describe('abdmCrypto X25519 agreement (RFC 7748 vector)', () => {
  test('derives the RFC 7748 shared secret from raw keys', () => {
    const alice = privateKeyFromRaw(ALICE_PRIV);
    const shared = deriveSharedSecret({ privateKey: alice, peerPublicKeyB64: b64(BOB_PUB) });
    expect(shared.toString('hex')).toBe(RFC7748_SHARED);

    const bob = privateKeyFromRaw(BOB_PRIV);
    const shared2 = deriveSharedSecret({ privateKey: bob, peerPublicKeyB64: b64(ALICE_PUB) });
    expect(shared2.toString('hex')).toBe(RFC7748_SHARED);
  });

  test('accepts both raw-32 and DER SPKI-44 public key encodings', () => {
    const alice = privateKeyFromRaw(ALICE_PRIV);
    const rawB64 = b64(BOB_PUB);
    const derB64 = Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      Buffer.from(BOB_PUB, 'hex'),
    ]).toString('base64');

    const viaRaw = deriveSharedSecret({ privateKey: alice, peerPublicKeyB64: rawB64 });
    const viaDer = deriveSharedSecret({ privateKey: alice, peerPublicKeyB64: derB64 });
    expect(viaRaw.equals(viaDer)).toBe(true);
  });

  test('rejects unsupported key encodings with a structured error', () => {
    expect(() => decodePublicKey(Buffer.alloc(16).toString('base64')))
      .toThrow(/Unsupported ABDM DH public key encoding/);
    expect(() => decodePublicKey(null)).toThrow(/required/);
  });
});

describe('abdmCrypto session key derivation (FIDELIUS layout)', () => {
  test('salt = first 20 bytes, iv = last 12 bytes of nonce XOR; HKDF-SHA256 key', () => {
    const alice = privateKeyFromRaw(ALICE_PRIV);
    const nonceA = Buffer.alloc(32, 0x01).toString('base64');
    const nonceB = Buffer.alloc(32, 0x02).toString('base64');

    const { aesKey, iv } = deriveSessionKey({
      privateKey: alice,
      peerPublicKeyB64: b64(BOB_PUB),
      senderNonceB64: nonceA,
      receiverNonceB64: nonceB,
    });

    // 0x01 ^ 0x02 = 0x03 in every byte.
    expect(iv.equals(Buffer.alloc(12, 0x03))).toBe(true);

    // Independent re-derivation with Node primitives only.
    const expectedKey = Buffer.from(crypto.hkdfSync(
      'sha256',
      Buffer.from(RFC7748_SHARED, 'hex'),
      Buffer.alloc(20, 0x03),
      Buffer.alloc(0),
      32,
    ));
    expect(aesKey.equals(expectedKey)).toBe(true);
  });

  test('nonce order does not matter (XOR commutes)', () => {
    const alice = privateKeyFromRaw(ALICE_PRIV);
    const nonceA = crypto.randomBytes(32).toString('base64');
    const nonceB = crypto.randomBytes(32).toString('base64');
    const k1 = deriveSessionKey({
      privateKey: alice, peerPublicKeyB64: b64(BOB_PUB),
      senderNonceB64: nonceA, receiverNonceB64: nonceB,
    });
    const k2 = deriveSessionKey({
      privateKey: alice, peerPublicKeyB64: b64(BOB_PUB),
      senderNonceB64: nonceB, receiverNonceB64: nonceA,
    });
    expect(k1.aesKey.equals(k2.aesKey)).toBe(true);
    expect(k1.iv.equals(k2.iv)).toBe(true);
  });

  test('rejects nonces that are not 32 bytes', () => {
    const alice = privateKeyFromRaw(ALICE_PRIV);
    expect(() => deriveSessionKey({
      privateKey: alice,
      peerPublicKeyB64: b64(BOB_PUB),
      senderNonceB64: Buffer.alloc(8).toString('base64'),
      receiverNonceB64: Buffer.alloc(32).toString('base64'),
    })).toThrow(/nonces must be 32 bytes/);
  });
});

describe('abdmCrypto payload encryption', () => {
  test('matches an independent AES-256-GCM computation byte-for-byte', () => {
    const alice = privateKeyFromRaw(ALICE_PRIV);
    const nonceA = Buffer.alloc(32, 0x0a).toString('base64');
    const nonceB = Buffer.alloc(32, 0x05).toString('base64');
    const plaintext = '{"resourceType":"Bundle","total":1}';

    const out = encryptPayload({
      plaintext,
      senderPrivateKey: alice,
      senderNonce: nonceA,
      receiverPublicKey: b64(BOB_PUB),
      receiverNonce: nonceB,
    });

    // Independent: shared secret from the RFC vector, salt/iv from XOR
    // (0x0a ^ 0x05 = 0x0f), HKDF, then AES-256-GCM with appended tag.
    const key = Buffer.from(crypto.hkdfSync(
      'sha256', Buffer.from(RFC7748_SHARED, 'hex'), Buffer.alloc(20, 0x0f), Buffer.alloc(0), 32,
    ));
    const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.alloc(12, 0x0f));
    const expected = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');

    expect(out).toBe(expected);
  });

  test('full HIP→HIU round-trip with generated key material', () => {
    const hiu = generateKeyMaterial();
    const bundle = {
      resourceType: 'Bundle',
      type: 'collection',
      total: 2,
      entry: [{ resourceType: 'Observation' }, { resourceType: 'Condition' }],
    };

    const { content, checksum, senderKeyMaterial } = encryptFhirBundle(bundle, hiu.keyMaterial);

    expect(content).not.toContain('Observation');
    expect(checksum).toMatch(/^[0-9a-f]{32}$/);
    expect(senderKeyMaterial.cryptoAlg).toBe('ECDH');
    expect(senderKeyMaterial.curve).toBe('Curve25519');
    expect(senderKeyMaterial.dhPublicKey.parameters).toBe('Curve25519/32byte random key');
    expect(Buffer.from(senderKeyMaterial.dhPublicKey.keyValue, 'base64')).toHaveLength(32);
    expect(Buffer.from(senderKeyMaterial.nonce, 'base64')).toHaveLength(32);
    expect(new Date(senderKeyMaterial.dhPublicKey.expiry).getTime()).toBeGreaterThan(Date.now());

    const decrypted = decryptFhirBundle({
      content,
      senderKeyMaterial,
      receiverPrivateKey: hiu.privateKey,
      receiverNonce: hiu.nonce,
    });
    expect(decrypted).toEqual(bundle);
  });

  test('detects tampering via the GCM tag', () => {
    const hiu = generateKeyMaterial();
    const { content, senderKeyMaterial } = encryptFhirBundle({ a: 1 }, hiu.keyMaterial);

    const tampered = Buffer.from(content, 'base64');
    tampered[0] ^= 0xff;

    expect(() => decryptFhirBundle({
      content: tampered.toString('base64'),
      senderKeyMaterial,
      receiverPrivateKey: hiu.privateKey,
      receiverNonce: hiu.nonce,
    })).toThrow(/failed authentication/);
  });

  test('fails with the wrong receiver key or nonce', () => {
    const hiu = generateKeyMaterial();
    const other = generateKeyMaterial();
    const { content, senderKeyMaterial } = encryptFhirBundle({ a: 1 }, hiu.keyMaterial);

    expect(() => decryptFhirBundle({
      content,
      senderKeyMaterial,
      receiverPrivateKey: other.privateKey,
      receiverNonce: hiu.nonce,
    })).toThrow(/failed authentication/);

    expect(() => decryptFhirBundle({
      content,
      senderKeyMaterial,
      receiverPrivateKey: hiu.privateKey,
      receiverNonce: other.nonce,
    })).toThrow(/failed authentication/);
  });

  test('refuses incomplete receiver key material', () => {
    expect(() => encryptFhirBundle({ a: 1 }, { nonce: Buffer.alloc(32).toString('base64') }))
      .toThrow(/Receiver key material incomplete/);
    expect(() => encryptFhirBundle({ a: 1 }, {
      dhPublicKey: { keyValue: Buffer.alloc(32).toString('base64') },
    })).toThrow(/Receiver key material incomplete/);
  });

  test('rejects payloads shorter than a GCM tag', () => {
    const hiu = generateKeyMaterial();
    const sender = generateKeyMaterial();
    expect(() => decryptPayload({
      encrypted: Buffer.alloc(8).toString('base64'),
      receiverPrivateKey: hiu.privateKey,
      receiverNonce: hiu.nonce,
      senderPublicKey: sender.keyMaterial.dhPublicKey.keyValue,
      senderNonce: sender.nonce,
    })).toThrow(/too short/);
  });
});
