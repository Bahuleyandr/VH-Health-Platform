import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { jest } from '@jest/globals';
import {
  CANONICAL_LIMITS,
  CanonicalizationError,
  ED25519_SIGNATURE_BASE64_LENGTH,
  FRESHNESS_LIMITS_MS,
  FRESHNESS_STATES,
  KEY_STATES,
  MAX_RENDER_UTF8_BYTES,
  PACK_ENVELOPE_VERSION,
  SIGNATURE_ALGORITHM,
  VERIFICATION_REASONS,
  assessMonotonicVersions,
  assessPackFreshness,
  assessSigningKey,
  canonicalizeJson,
  completeSignedPackEnvelope,
  createSignedPackEnvelope,
  hashCanonicalValue,
  hashRenderedOutput,
  normalizeGovernanceVersion,
  prepareSignedPackEnvelope,
  sha256Hex,
  signCanonicalValue,
  verifyCanonicalValue,
  verifySignedPackEnvelope,
} from '../../services/downtime/continuityPackCanonical.js';

describe('continuity pack RFC 8785 canonical JSON', () => {
  test('matches the RFC 8785 serialization vector', () => {
    const value = {
      numbers: [
        Number('333333333.33333329'),
        1E30,
        4.50,
        2e-3,
        0.000000000000000000000000001,
      ],
      string: `€$\u000f\nA'B"\\\\"/`,
      literals: [null, true, false],
    };
    const expected = [
      '{"literals":[null,true,false],',
      '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],',
      '"string":"€$\\u000f\\n',
      'A\'B\\"',
      '\\\\\\\\',
      '\\"/"}',
    ].join('');

    expect(canonicalizeJson(value)).toBe(expected);
  });

  test('sorts object keys by UTF-16 code units at every depth', () => {
    const value = {
      '€': 'euro',
      '\r': 'carriage',
      'דּ': 'hebrew',
      1: 'one',
      '😀': 'emoji',
      '\u0080': 'control',
      ö: 'latin',
      nested: { z: 1, a: 2 },
    };

    expect(canonicalizeJson(value)).toBe(
      '{"\\r":"carriage","1":"one","nested":{"a":2,"z":1},'
      + '"\u0080":"control","ö":"latin","€":"euro","😀":"emoji","דּ":"hebrew"}',
    );
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe(canonicalizeJson({ a: 2, b: 1 }));
  });

  test('uses ECMAScript JSON number serialization without coercion', () => {
    expect(canonicalizeJson([
      -0,
      1e+30,
      1e-7,
      0.000001,
      Number('333333333.33333329'),
    ])).toBe('[0,1e+30,1e-7,0.000001,333333333.3333333]');
  });

  test.each([
    ['undefined', undefined],
    ['function', () => null],
    ['symbol', Symbol('not-json')],
    ['bigint', 1n],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s instead of silently changing it', (_label, value) => {
    expect(() => canonicalizeJson({ value })).toThrow(CanonicalizationError);
  });

  test('rejects cycles, sparse arrays, accessors, symbol keys, and non-JSON objects', () => {
    const cycle = {};
    cycle.self = cycle;
    const sparse = [];
    sparse.length = 1;
    const accessor = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => 1,
    });
    const symbolKey = { okay: true };
    symbolKey[Symbol('hidden')] = 'not-json';

    expect(() => canonicalizeJson(cycle)).toThrow(
      expect.objectContaining({ code: 'CANONICAL_CYCLE' }),
    );
    expect(() => canonicalizeJson(sparse)).toThrow(
      expect.objectContaining({ code: 'CANONICAL_SPARSE_ARRAY' }),
    );
    expect(() => canonicalizeJson(accessor)).toThrow(
      expect.objectContaining({ code: 'CANONICAL_ACCESSOR' }),
    );
    expect(() => canonicalizeJson(symbolKey)).toThrow(
      expect.objectContaining({ code: 'CANONICAL_SYMBOL_KEY' }),
    );
    expect(() => canonicalizeJson(new Date())).toThrow(
      expect.objectContaining({ code: 'CANONICAL_UNSUPPORTED_OBJECT' }),
    );
  });

  test('rejects lone UTF-16 surrogates in values and object keys', () => {
    expect(() => canonicalizeJson('\ud800')).toThrow(
      expect.objectContaining({ code: 'CANONICAL_LONE_SURROGATE' }),
    );
    expect(() => canonicalizeJson('\udc00')).toThrow(
      expect.objectContaining({ code: 'CANONICAL_LONE_SURROGATE' }),
    );
    expect(() => canonicalizeJson({ ['bad\ud800']: true })).toThrow(
      expect.objectContaining({ code: 'CANONICAL_LONE_SURROGATE' }),
    );
    expect(canonicalizeJson('😀')).toBe('"😀"');
  });

  test('enforces configurable depth, node, and UTF-8 byte ceilings', () => {
    expect(() => canonicalizeJson(
      { first: { second: { third: true } } },
      { ...CANONICAL_LIMITS, maxDepth: 1 },
    )).toThrow(expect.objectContaining({ code: 'CANONICAL_DEPTH_LIMIT' }));

    expect(() => canonicalizeJson(
      [1, 2],
      { ...CANONICAL_LIMITS, maxNodes: 2 },
    )).toThrow(expect.objectContaining({ code: 'CANONICAL_NODE_LIMIT' }));

    expect(canonicalizeJson(
      'é',
      { ...CANONICAL_LIMITS, maxUtf8Bytes: 4 },
    )).toBe('"é"');
    expect(() => canonicalizeJson(
      'é',
      { ...CANONICAL_LIMITS, maxUtf8Bytes: 3 },
    )).toThrow(expect.objectContaining({ code: 'CANONICAL_BYTE_LIMIT' }));
    expect(canonicalizeJson(
      '\u0000',
      { ...CANONICAL_LIMITS, maxUtf8Bytes: 8 },
    )).toBe('"\\u0000"');
    expect(() => canonicalizeJson(
      '\u0000',
      { ...CANONICAL_LIMITS, maxUtf8Bytes: 7 },
    )).toThrow(expect.objectContaining({ code: 'CANONICAL_BYTE_LIMIT' }));
  });

  test('produces full lowercase SHA-256 hashes for bytes and canonical values', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashCanonicalValue({ b: 2, a: 1 })).toBe(
      hashCanonicalValue({ a: 1, b: 2 }),
    );
    expect(hashRenderedOutput('<html>safe</html>')).toMatch(/^[a-f0-9]{64}$/);
    expect(() => hashRenderedOutput('xx', { maxUtf8Bytes: 1 })).toThrow(RangeError);
  });

  test('normalizes governance BIGINT values explicitly before canonicalization', () => {
    expect(normalizeGovernanceVersion(9_007_199_254_740_993n))
      .toBe('9007199254740993');
    expect(normalizeGovernanceVersion(0n, { allowZero: true })).toBe('0');
    expect(() => normalizeGovernanceVersion(0n)).toThrow(RangeError);
    expect(() => canonicalizeJson(9_007_199_254_740_993n))
      .toThrow(CanonicalizationError);
  });
});

describe('continuity pack Ed25519 signatures and envelopes', () => {
  const ISSUED_AT = '2026-07-29T00:00:00.000Z';
  const EXPIRES_AT = '2026-07-30T00:00:00.000Z';
  const RENDERED = '<!doctype html><title>Signed continuity pack</title>';
  const AUDIENCE = {
    tenantId: '52e31913-c846-4458-a21b-31cd2f457e9b',
    facilityId: 41,
  };
  const CONTENT = {
    facilityId: 'facility-1',
    generatedAt: ISSUED_AT,
    patients: [{ uid: 'patient-1', allergyStatus: 'unknown' }],
  };

  let currentKeys;
  let wrongKeys;

  beforeAll(() => {
    currentKeys = generateKeyPairSync('ed25519');
    wrongKeys = generateKeyPairSync('ed25519');
  });

  function makeEnvelope(overrides = {}) {
    return createSignedPackEnvelope({
      content: CONTENT,
      rendered: RENDERED,
      audience: AUDIENCE,
      keyId: 'continuity-current-1',
      privateKey: currentKeys.privateKey,
      manifestVersion: 7,
      policyVersion: 3,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      ...overrides,
    });
  }

  function prepareEnvelope(overrides = {}) {
    return prepareSignedPackEnvelope({
      content: CONTENT,
      rendered: RENDERED,
      audience: AUDIENCE,
      keyId: 'continuity-current-1',
      manifestVersion: 7,
      policyVersion: 3,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      ...overrides,
    });
  }

  function verify(envelope, overrides = {}) {
    return verifySignedPackEnvelope(envelope, {
      rendered: RENDERED,
      requireRendered: true,
      trustedKeys: {
        'continuity-current-1': {
          publicKey: currentKeys.publicKey,
          state: KEY_STATES.CURRENT,
        },
      },
      expectedAudience: AUDIENCE,
      minimumManifestVersion: 7,
      minimumPolicyVersion: 3,
      minimumRevocationEpoch: 0,
      trustedNow: '2026-07-29T00:05:00.000Z',
      clockTrusted: true,
      ...overrides,
    });
  }

  test('signs and verifies canonical values with Ed25519 KeyObjects and PEM', () => {
    const privatePem = currentKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicPem = currentKeys.publicKey.export({ type: 'spki', format: 'pem' });
    const signature = signCanonicalValue({ z: 2, a: 1 }, privatePem);

    expect(verifyCanonicalValue({ a: 1, z: 2 }, signature, currentKeys.publicKey))
      .toBe(true);
    expect(verifyCanonicalValue({ a: 1, z: 2 }, signature, publicPem)).toBe(true);
    expect(verifyCanonicalValue({ a: 1, z: 3 }, signature, publicPem)).toBe(false);
    expect(verifyCanonicalValue({ a: 1, z: 2 }, signature, wrongKeys.publicKey))
      .toBe(false);
    expect(signature).toHaveLength(ED25519_SIGNATURE_BASE64_LENGTH);
    expect(verifyCanonicalValue(
      { a: 1, z: 2 },
      'A'.repeat(ED25519_SIGNATURE_BASE64_LENGTH * 100),
      publicPem,
    )).toBe(false);
  });

  test('creates a self-describing signed envelope with content and render hashes', () => {
    const envelope = makeEnvelope();

    expect(envelope.envelopeVersion).toBe(PACK_ENVELOPE_VERSION);
    expect(envelope.algorithm).toBe(SIGNATURE_ALGORITHM);
    expect(envelope.contentHash).toBe(hashCanonicalValue(CONTENT));
    expect(envelope.renderHash).toBe(hashRenderedOutput(RENDERED));

    const result = verify(envelope);
    expect(result).toMatchObject({
      ok: true,
      content: CONTENT,
      audience: {
        tenantId: AUDIENCE.tenantId,
        facilityId: '41',
      },
      keyId: 'continuity-current-1',
      keyState: KEY_STATES.CURRENT,
      manifestVersion: '7',
      policyVersion: '3',
      revocationEpoch: '0',
      renderVerified: true,
      freshness: {
        state: FRESHNESS_STATES.CURRENT,
        packAccess: { display: true, print: true },
      },
      fallback: { paper: false, phone: false },
    });
  });

  test('supports asynchronous external signing and remains offline-verifiable', async () => {
    const prepared = prepareEnvelope();
    const externalSigner = jest.fn(async (signingBytes) => (
      cryptoSign(null, signingBytes, currentKeys.privateKey).toString('base64')
    ));

    const signature = await externalSigner(prepared.signingBytes);
    const envelope = completeSignedPackEnvelope(prepared, signature);

    expect(externalSigner).toHaveBeenCalledTimes(1);
    expect(prepared.signingBytes).toEqual(
      Buffer.from(canonicalizeJson(prepared.unsignedEnvelope), 'utf8'),
    );
    expect(envelope).toEqual(makeEnvelope());
    expect(verify(envelope)).toMatchObject({
      ok: true,
      content: CONTENT,
      renderVerified: true,
    });
  });

  test('snapshots prepared fields and returns isolated signing-byte copies', () => {
    const callerContent = structuredClone(CONTENT);
    const prepared = prepareEnvelope({ content: callerContent });
    const originalBytes = prepared.signingBytes;

    callerContent.patients[0].uid = 'mutated-after-prepare';
    prepared.signingBytes.fill(0);

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.unsignedEnvelope)).toBe(true);
    expect(Object.isFrozen(prepared.unsignedEnvelope.content.patients[0])).toBe(true);
    expect(prepared.unsignedEnvelope.content.patients[0].uid).toBe('patient-1');
    expect(prepared.signingBytes).toEqual(originalBytes);
    expect(() => {
      prepared.unsignedEnvelope.content.patients[0].uid = 'mutated';
    }).toThrow(TypeError);
  });

  test('rejects malformed signatures and cannot complete signatures over altered bytes', () => {
    const prepared = prepareEnvelope();
    const alteredBytes = prepared.signingBytes;
    alteredBytes[0] ^= 1;
    const alteredSignature = cryptoSign(
      null,
      alteredBytes,
      currentKeys.privateKey,
    ).toString('base64');
    const envelope = completeSignedPackEnvelope(prepared, alteredSignature);

    expect(verify(envelope)).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.SIGNATURE_INVALID,
    });
    expect(() => completeSignedPackEnvelope(prepared, 'not-base64')).toThrow(
      'Ed25519 signature must be canonical base64',
    );
    expect(() => completeSignedPackEnvelope(
      prepared,
      'A'.repeat(ED25519_SIGNATURE_BASE64_LENGTH),
    )).toThrow('Ed25519 signature must be a 64-byte canonical base64 value');
    expect(() => completeSignedPackEnvelope(
      {
        unsignedEnvelope: prepared.unsignedEnvelope,
        signingBytes: prepared.signingBytes,
      },
      makeEnvelope().signature,
    )).toThrow('prepared must be an envelope signing request');
  });

  test('returns an immutable signed content snapshot rather than the caller reference', () => {
    const callerContent = structuredClone(CONTENT);
    const envelope = makeEnvelope({ content: callerContent });
    callerContent.facilityId = 'mutated-after-signing';

    expect(envelope.content.facilityId).toBe('facility-1');
    expect(envelope.content).not.toBe(callerContent);
    expect(Object.isFrozen(envelope.content)).toBe(true);
    expect(Object.getPrototypeOf(envelope.content)).toBeNull();

    const result = verify(envelope);
    expect(result.ok).toBe(true);
    expect(result.content).not.toBe(envelope.content);
    expect(Object.isFrozen(result.content.patients[0])).toBe(true);
    expect(() => {
      result.content.patients[0].allergyStatus = 'mutated-after-verification';
    }).toThrow(TypeError);
    expect(result.content.patients[0].allergyStatus).toBe('unknown');

    const inherited = Object.create(Object.assign(Object.create(null), {
      unsignedClinicalField: 'must-not-pass',
    }));
    inherited.signedField = 'okay';
    expect(() => canonicalizeJson(inherited)).toThrow(
      expect.objectContaining({ code: 'CANONICAL_UNSUPPORTED_OBJECT' }),
    );
  });

  test('normalizes BIGINT-backed versions to lossless canonical decimal strings', () => {
    const manifestVersion = 9_007_199_254_740_993n;
    const policyVersion = 9_007_199_254_740_992n;
    const revocationEpoch = 9_007_199_254_740_991n;
    const envelope = makeEnvelope({
      manifestVersion,
      policyVersion,
      revocationEpoch,
    });

    expect(envelope.manifestVersion).toBe('9007199254740993');
    expect(envelope.policyVersion).toBe('9007199254740992');
    expect(envelope.revocationEpoch).toBe('9007199254740991');
    expect(verify(envelope, {
      minimumManifestVersion: manifestVersion,
      minimumPolicyVersion: policyVersion,
      minimumRevocationEpoch: revocationEpoch,
    })).toMatchObject({
      ok: true,
      manifestVersion: '9007199254740993',
      policyVersion: '9007199254740992',
      revocationEpoch: '9007199254740991',
    });
  });

  test('rejects content, hash, render, signature, wrong-key, and key-id tampering', () => {
    const envelope = makeEnvelope();

    const contentTamper = structuredClone(envelope);
    contentTamper.content.patients[0].allergyStatus = 'none-known';
    expect(verify(contentTamper)).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.CONTENT_HASH_MISMATCH,
    });

    const contentAndHashTamper = structuredClone(envelope);
    contentAndHashTamper.content.patients[0].allergyStatus = 'none-known';
    contentAndHashTamper.contentHash = hashCanonicalValue(contentAndHashTamper.content);
    expect(verify(contentAndHashTamper)).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.SIGNATURE_INVALID,
    });

    expect(verify(envelope, { rendered: `${RENDERED}tampered` })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.RENDER_HASH_MISMATCH,
    });
    expect(verify(envelope, {
      rendered: undefined,
      requireRendered: true,
    })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.RENDER_REQUIRED,
    });

    const replacement = envelope.signature[0] === 'A' ? 'B' : 'A';
    const signatureTamper = {
      ...envelope,
      signature: `${replacement}${envelope.signature.slice(1)}`,
    };
    expect(verify(signatureTamper)).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.SIGNATURE_INVALID,
    });

    expect(verify(envelope, {
      trustedKeys: {
        'continuity-current-1': {
          publicKey: wrongKeys.publicKey,
          state: KEY_STATES.CURRENT,
        },
      },
    })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.SIGNATURE_INVALID,
    });

    expect(verify(envelope, { expectedKeyId: 'another-key-id' })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.KEY_ID_MISMATCH,
    });

    expect(verify(envelope, {
      expectedAudience: {
        tenantId: AUDIENCE.tenantId,
        facilityId: 42,
      },
    })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.AUDIENCE_MISMATCH,
    });

    const algorithmTamper = { ...envelope, algorithm: 'EdDSA' };
    expect(verify(algorithmTamper)).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.UNSUPPORTED_ALGORITHM,
    });
  });

  test('rejects malformed envelopes without evaluating accessors or hostile proxies', () => {
    const invalidCalendarDate = {
      ...makeEnvelope(),
      issuedAt: '2026-02-30T00:00:00.000Z',
    };
    expect(verify(invalidCalendarDate)).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.INVALID_ENVELOPE,
    });

    const numericTimestamp = {
      ...makeEnvelope(),
      issuedAt: Date.parse(ISSUED_AT),
    };
    expect(verify(numericTimestamp)).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.INVALID_ENVELOPE,
    });

    const throwingHash = {
      ...makeEnvelope(),
      contentHash: {
        [Symbol.toPrimitive]() {
          throw new Error('must be contained');
        },
      },
    };
    expect(() => verify(throwingHash)).not.toThrow();
    expect(verify(throwingHash)).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.INVALID_ENVELOPE,
    });

    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error('must be contained');
      },
    });
    expect(() => verify(hostile)).not.toThrow();
    expect(verify(hostile)).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.INVALID_ENVELOPE,
    });

    expect(() => makeEnvelope({ keyId: 123 })).toThrow(TypeError);
  });

  test('never exposes clinical content on a failed envelope decision', () => {
    const tampered = structuredClone(makeEnvelope());
    tampered.content.facilityId = 'facility-attacker';

    const result = verify(tampered);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('content');
    expect(result.fallback).toEqual({ paper: true, phone: true });
  });

  test('requires explicit persisted anti-rollback floors', () => {
    const envelope = makeEnvelope();
    const result = verifySignedPackEnvelope(envelope, {
      rendered: RENDERED,
      trustedKeys: {
        'continuity-current-1': {
          publicKey: currentKeys.publicKey,
          state: KEY_STATES.CURRENT,
        },
      },
      expectedAudience: AUDIENCE,
      trustedNow: '2026-07-29T00:05:00.000Z',
      clockTrusted: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.ROLLBACK_STATE_REQUIRED,
      fallback: { paper: true, phone: true },
    });
    expect(result).not.toHaveProperty('content');
  });

  test('requires the caller to pin the expected tenant and facility audience', () => {
    const result = verify(makeEnvelope(), { expectedAudience: undefined });

    expect(result).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.AUDIENCE_REQUIRED,
      fallback: { paper: true, phone: true },
    });
    expect(result).not.toHaveProperty('content');
  });
});

describe('continuity key rotation and anti-rollback decisions', () => {
  const ISSUED_AT = '2026-07-29T00:00:00.000Z';
  const EXPIRES_AT = '2026-07-30T00:00:00.000Z';
  const RENDERED = '<html>rotation</html>';
  const AUDIENCE = {
    tenantId: '885a7ad1-09a8-43fb-8229-d7a139c0de81',
    facilityId: 7,
  };
  const CONTENT = { facilityId: 'facility-rotation', patients: [] };

  let current;
  let next;

  beforeAll(() => {
    current = generateKeyPairSync('ed25519');
    next = generateKeyPairSync('ed25519');
  });

  function envelopeFor(keyId, privateKey) {
    return createSignedPackEnvelope({
      content: CONTENT,
      rendered: RENDERED,
      audience: AUDIENCE,
      keyId,
      privateKey,
      manifestVersion: 11,
      policyVersion: 5,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    });
  }

  function verify(envelope, trustedKeys, overrides = {}) {
    return verifySignedPackEnvelope(envelope, {
      rendered: RENDERED,
      trustedKeys,
      expectedAudience: AUDIENCE,
      minimumManifestVersion: 11,
      minimumPolicyVersion: 5,
      minimumRevocationEpoch: 0,
      trustedNow: '2026-07-29T00:01:00.000Z',
      clockTrusted: true,
      ...overrides,
    });
  }

  test('accepts current and next keys during a governed rotation overlap', () => {
    const trustedKeys = new Map([
      ['key-current', { publicKey: current.publicKey, state: KEY_STATES.CURRENT }],
      ['key-next', { publicKey: next.publicKey, state: KEY_STATES.NEXT }],
    ]);

    expect(verify(envelopeFor('key-current', current.privateKey), trustedKeys))
      .toMatchObject({ ok: true, keyState: KEY_STATES.CURRENT });
    expect(verify(envelopeFor('key-next', next.privateKey), trustedKeys))
      .toMatchObject({ ok: true, keyState: KEY_STATES.NEXT });
  });

  test.each([
    [KEY_STATES.REVOKED, VERIFICATION_REASONS.KEY_REVOKED],
    [KEY_STATES.COMPROMISED, VERIFICATION_REASONS.KEY_COMPROMISED],
  ])('rejects a correctly signed pack when its key is %s', (state, reason) => {
    const envelope = envelopeFor('key-current', current.privateKey);
    const result = verify(envelope, {
      'key-current': { publicKey: current.publicKey, state },
    });

    expect(result).toMatchObject({
      ok: false,
      reason,
      fallback: { paper: true, phone: true },
    });
    expect(result).not.toHaveProperty('content');
  });

  test('rejects unknown, mismatched, and unsupported key records', () => {
    expect(assessSigningKey({
      keyId: 'key-current',
      algorithm: SIGNATURE_ALGORITHM,
      trustedKeys: {},
    })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.KEY_NOT_TRUSTED,
    });

    expect(assessSigningKey({
      keyId: 'key-current',
      algorithm: SIGNATURE_ALGORITHM,
      trustedKeys: {
        'key-current': {
          keyId: 'different-key',
          publicKey: current.publicKey,
          state: KEY_STATES.CURRENT,
        },
      },
    })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.KEY_ID_MISMATCH,
    });

    expect(assessSigningKey({
      keyId: 'key-current',
      algorithm: SIGNATURE_ALGORITHM,
      trustedKeys: {
        'key-current': { publicKey: current.publicKey, state: 'retired' },
      },
    })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.KEY_STATE_UNSUPPORTED,
    });

    expect(assessSigningKey({
      keyId: 'key-current',
      algorithm: SIGNATURE_ALGORITHM,
      trustedKeys: {
        'key-current': { publicKey: current.publicKey },
      },
    })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.KEY_STATE_UNSUPPORTED,
    });

    expect(assessSigningKey({
      keyId: 'key-current',
      algorithm: SIGNATURE_ALGORITHM,
      trustedKeys: { 'key-current': current.publicKey },
    })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.KEY_STATE_UNSUPPORTED,
    });
  });

  test('enforces policy and manifest floors independently and accepts equality', () => {
    expect(assessMonotonicVersions(
      { policyVersion: 5, manifestVersion: 11, revocationEpoch: 4 },
      {
        minimumPolicyVersion: 5,
        minimumManifestVersion: 11,
        minimumRevocationEpoch: 4,
      },
    )).toMatchObject({ ok: true });

    const envelope = envelopeFor('key-current', current.privateKey);
    const trustedKeys = {
      'key-current': { publicKey: current.publicKey, state: KEY_STATES.CURRENT },
    };
    expect(verify(envelope, trustedKeys, { minimumPolicyVersion: 6 })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.POLICY_ROLLBACK,
    });
    expect(verify(envelope, trustedKeys, { minimumManifestVersion: 12 })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.MANIFEST_ROLLBACK,
    });
    expect(verify(envelope, trustedKeys, { minimumRevocationEpoch: 1 })).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.REVOCATION_EPOCH_ROLLBACK,
    });
  });
});

describe('trusted-clock continuity pack freshness', () => {
  const ISSUED_AT = '2026-07-29T00:00:00.000Z';
  const EXPIRES_AT = '2026-07-30T00:00:00.000Z';

  test('uses inclusive 15-minute CURRENT and exclusive 24-hour AGED boundaries', () => {
    expect(assessPackFreshness({
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      trustedNow: new Date(Date.parse(ISSUED_AT) + FRESHNESS_LIMITS_MS.current),
      clockTrusted: true,
    })).toMatchObject({
      state: FRESHNESS_STATES.CURRENT,
      ageMs: FRESHNESS_LIMITS_MS.current,
      packAccess: { display: true, print: true },
      fallback: { paper: false, phone: false },
    });

    expect(assessPackFreshness({
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      trustedNow: Date.parse(ISSUED_AT) + FRESHNESS_LIMITS_MS.current + 1,
      clockTrusted: true,
    })).toMatchObject({
      state: FRESHNESS_STATES.AGED,
      ageMs: FRESHNESS_LIMITS_MS.current + 1,
      packAccess: { display: true, print: true },
      fallback: { paper: false, phone: false },
    });

    expect(assessPackFreshness({
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      trustedNow: Date.parse(ISSUED_AT) + FRESHNESS_LIMITS_MS.expires - 1,
      clockTrusted: true,
    })).toMatchObject({
      state: FRESHNESS_STATES.AGED,
      packAccess: { display: true, print: true },
    });
  });

  test('expires at 24 hours or an earlier signed expiry', () => {
    expect(assessPackFreshness({
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      trustedNow: Date.parse(ISSUED_AT) + FRESHNESS_LIMITS_MS.expires,
      clockTrusted: true,
    })).toMatchObject({
      state: FRESHNESS_STATES.EXPIRED,
      ageMs: FRESHNESS_LIMITS_MS.expires,
      packAccess: { display: false, print: false },
      fallback: { paper: true, phone: true },
    });

    expect(assessPackFreshness({
      issuedAt: ISSUED_AT,
      expiresAt: '2026-07-29T01:00:00.000Z',
      trustedNow: '2026-07-29T01:00:00.000Z',
      clockTrusted: true,
    })).toMatchObject({
      state: FRESHNESS_STATES.EXPIRED,
      fallback: { paper: true, phone: true },
    });
  });

  test('fails closed when the clock is untrusted, missing, rolled back, or inconsistent', () => {
    for (const input of [
      {
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        trustedNow: '2026-07-29T00:01:00.000Z',
        clockTrusted: false,
      },
      {
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        trustedNow: '2026-07-29T00:01:00.000Z',
        clockTrusted: 'false',
      },
      {
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        trustedNow: undefined,
        clockTrusted: true,
      },
      {
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        trustedNow: '2026-07-28T23:59:59.999Z',
        clockTrusted: true,
      },
      {
        issuedAt: ISSUED_AT,
        expiresAt: ISSUED_AT,
        trustedNow: ISSUED_AT,
        clockTrusted: true,
      },
      {
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        trustedNow: '2026-07-29T00:05:00.000Z',
        minimumTrustedNow: '2026-07-29T00:06:00.000Z',
        clockTrusted: true,
      },
    ]) {
      expect(assessPackFreshness(input)).toMatchObject({
        state: FRESHNESS_STATES.CLOCK_UNCERTAIN,
        ageMs: null,
        packAccess: { display: false, print: false },
        fallback: { paper: true, phone: true },
      });
    }
  });

  test('the envelope verifier withholds expired and clock-uncertain content', () => {
    const keys = generateKeyPairSync('ed25519');
    const audience = {
      tenantId: '99342157-46a7-47a9-9012-a841cd9c20e9',
      facilityId: 3,
    };
    const envelope = createSignedPackEnvelope({
      content: { patients: [{ uid: 'patient-sensitive' }] },
      rendered: '<html>clinical</html>',
      audience,
      keyId: 'freshness-key',
      privateKey: keys.privateKey,
      manifestVersion: 1,
      policyVersion: 1,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    });
    const baseOptions = {
      rendered: '<html>clinical</html>',
      trustedKeys: {
        'freshness-key': { publicKey: keys.publicKey, state: KEY_STATES.CURRENT },
      },
      expectedAudience: audience,
      minimumManifestVersion: 0,
      minimumPolicyVersion: 0,
      minimumRevocationEpoch: 0,
    };

    const expired = verifySignedPackEnvelope(envelope, {
      ...baseOptions,
      trustedNow: EXPIRES_AT,
      clockTrusted: true,
    });
    expect(expired).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.PACK_EXPIRED,
      freshness: { state: FRESHNESS_STATES.EXPIRED },
      fallback: { paper: true, phone: true },
    });
    expect(expired).not.toHaveProperty('content');

    const uncertain = verifySignedPackEnvelope(envelope, {
      ...baseOptions,
      trustedNow: '2026-07-29T00:01:00.000Z',
      clockTrusted: false,
    });
    expect(uncertain).toMatchObject({
      ok: false,
      reason: VERIFICATION_REASONS.CLOCK_UNCERTAIN,
      freshness: { state: FRESHNESS_STATES.CLOCK_UNCERTAIN },
      fallback: { paper: true, phone: true },
    });
    expect(uncertain).not.toHaveProperty('content');
  });

  test('exports bounded production defaults for downstream tests and clients', () => {
    expect(CANONICAL_LIMITS).toEqual({
      maxDepth: 64,
      maxNodes: 100_000,
      maxUtf8Bytes: 2 * 1024 * 1024,
    });
    expect(MAX_RENDER_UTF8_BYTES).toBe(4 * 1024 * 1024);
    expect(FRESHNESS_LIMITS_MS).toEqual({
      current: 15 * 60 * 1000,
      expires: 24 * 60 * 60 * 1000,
    });
  });
});
