/**
 * SEC-4 — fieldEncryption.js unit tests.
 *
 * Covers:
 *   - enc:v2: envelope encrypt -> decrypt round-trip
 *   - enc:v1: LEGACY decrypt still works (both a hard-coded on-disk fixture and
 *     a runtime-generated one) — proves we never broke data at rest
 *   - KEK rotation re-wraps the DEK (payload ct/iv/tag unchanged, edek changes,
 *     keyId changes) and the value still decrypts under the new keyId
 *   - GCM tamper (ciphertext + wrapped-DEK) -> throws
 *   - searchableHash determinism, separate-key behavior, and legacy back-compat
 *
 * The jest.setup.cjs harness pins FIELD_ENCRYPTION_KEY='test-field-encryption-key-32chars!!'
 * and leaves FIELD_ENCRYPTION_KEK / FIELD_SEARCH_HMAC_KEY UNSET — i.e. the exact
 * compatibility-fallback configuration that an un-migrated production deploy runs.
 */

import crypto from 'crypto';
import { jest } from '@jest/globals';

const fe = await import('../../utils/fieldEncryption.js');
const {
  encryptField,
  decryptField,
  rewrapField,
  isEncrypted,
  getKeyId,
  searchableHash,
  encryptFields,
  decryptFields,
  resetKeyCacheForTesting,
  __testing__,
} = fe;

const {
  LocalKekProvider,
  deriveKekFromMaterial,
  resetKekProviderForTesting,
  setKekProvider,
  DEFAULT_KEK_ID,
} = await import('../../utils/fieldKeyProvider.js');

// === Faithful re-implementation of the PRE-envelope (v1) scheme ===
// We deliberately DO NOT call the module under test here — these helpers mirror
// the original fieldEncryption.js byte-for-byte (scrypt KDF + AES-256-GCM, hex
// payload, HMAC over the same derived key). Computing fixtures this way proves
// genuine backward-compat against whatever FIELD_ENCRYPTION_KEY the environment
// resolves (real .env on a dev box, placeholder in CI) — not a self-referential
// round-trip, and not tied to one machine's key.
const LEGACY_KDF_SALT = 'vh-field-encryption-v1';
function legacyDerivedKey() {
  const masterKey = process.env.FIELD_ENCRYPTION_KEY;
  return crypto.scryptSync(masterKey, LEGACY_KDF_SALT, 32);
}
function legacyEncryptV1(plaintext) {
  const key = legacyDerivedKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(String(plaintext), 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `enc:v1:${iv.toString('hex')}:${tag}:${enc}`;
}
function legacySearchHash(plaintext) {
  const key = legacyDerivedKey();
  return crypto.createHmac('sha256', key).update(String(plaintext).toLowerCase().trim()).digest('hex');
}

const V1_FIXTURE_PLAINTEXT = 'Ramesh Iyer — MRN 88421';
const V1_FIXTURE = legacyEncryptV1(V1_FIXTURE_PLAINTEXT);

// Legacy searchableHash('9876543210') under the SAME derived key — proves the
// new separate-key default reproduces old hashes byte-for-byte.
const LEGACY_PHONE_HASH = legacySearchHash('9876543210');

beforeEach(() => {
  resetKekProviderForTesting();
  resetKeyCacheForTesting();
});

afterEach(() => {
  // Make sure no test leaks an injected provider or env override.
  resetKekProviderForTesting();
  resetKeyCacheForTesting();
  delete process.env.FIELD_ENCRYPTION_KEK;
  delete process.env.FIELD_ENCRYPTION_KEK_ID;
  delete process.env.FIELD_ENCRYPTION_KEK_OLD;
  delete process.env.FIELD_ENCRYPTION_KEK_OLD_ID;
  delete process.env.FIELD_SEARCH_HMAC_KEY;
  resetKekProviderForTesting();
  resetKeyCacheForTesting();
});

describe('enc:v2 envelope round-trip', () => {
  it('encrypts to an enc:v2: payload and decrypts back to plaintext', () => {
    const pt = 'Mrs Lakshmi Narayanan — diagnosis: T2DM, flagged';
    const ct = encryptField(pt);
    expect(ct.startsWith('enc:v2:')).toBe(true);
    expect(ct).not.toContain('Lakshmi');
    expect(ct).not.toContain('T2DM');
    expect(decryptField(ct)).toBe(pt);
  });

  it('stamps the active KEK keyId into the payload', () => {
    const ct = encryptField('x');
    expect(getKeyId(ct)).toBe(DEFAULT_KEK_ID); // 'local-v1' from the fallback KEK
  });

  it('produces a different ciphertext each call (fresh DEK + IV) but same plaintext', () => {
    const a = encryptField('repeat-me');
    const b = encryptField('repeat-me');
    expect(a).not.toBe(b);
    expect(decryptField(a)).toBe('repeat-me');
    expect(decryptField(b)).toBe('repeat-me');
  });

  it('passes null/undefined/empty through unchanged (both directions)', () => {
    expect(encryptField(null)).toBeNull();
    expect(encryptField('')).toBe('');
    expect(encryptField(undefined)).toBeUndefined();
    expect(decryptField(null)).toBeNull();
    expect(decryptField('')).toBe('');
    expect(decryptField(undefined)).toBeUndefined();
  });

  it('returns non-encrypted strings as-is on decrypt (back-compat with plaintext rows)', () => {
    expect(decryptField('just a plain string')).toBe('just a plain string');
  });

  it('round-trips multibyte / unicode content', () => {
    const pt = 'நோயாளி குறிப்பு — ✅ 日本語 — emoji 🩺';
    expect(decryptField(encryptField(pt))).toBe(pt);
  });

  it('handles long values (PHI free-text note)', () => {
    const pt = 'A'.repeat(20000) + ' end';
    expect(decryptField(encryptField(pt))).toBe(pt);
  });
});

describe('enc:v1 legacy backward compatibility', () => {
  it('decrypts a hard-coded enc:v1: fixture written by the old single-key scheme', () => {
    expect(decryptField(V1_FIXTURE)).toBe(V1_FIXTURE_PLAINTEXT);
  });

  it('decrypts a runtime-generated v1 ciphertext (helper mirrors the old impl)', () => {
    const v1 = __testing__.encryptV1ForTest('legacy secret value');
    expect(v1.startsWith('enc:v1:')).toBe(true);
    expect(decryptField(v1)).toBe('legacy secret value');
  });

  it('isEncrypted recognises BOTH v1 and v2 (so writers never double-encrypt)', () => {
    expect(isEncrypted(V1_FIXTURE)).toBe(true);
    expect(isEncrypted(encryptField('y'))).toBe(true);
    expect(isEncrypted('plain')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });

  it('getKeyId reports "v1" for legacy rows', () => {
    expect(getKeyId(V1_FIXTURE)).toBe('v1');
    expect(getKeyId('plain')).toBeNull();
  });

  it('v1 GCM tamper throws (auth tag still enforced on the legacy path)', () => {
    // Flip the last ciphertext hex nibble — GCM auth must reject it.
    const last = V1_FIXTURE.slice(-1);
    const flipped = last === '0' ? '1' : '0';
    const tampered = V1_FIXTURE.slice(0, -1) + flipped;
    expect(() => decryptField(tampered)).toThrow(/Decryption failed/);
  });
});

describe('GCM tamper detection (enc:v2)', () => {
  function parseV2(payload) {
    const b64 = payload.slice('enc:v2:'.length);
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  }
  function packV2(obj) {
    return 'enc:v2:' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  }

  it('throws when the ciphertext is tampered', () => {
    const env = parseV2(encryptField('top-secret-phi'));
    const ct = Buffer.from(env.ct, 'base64');
    ct[0] ^= 0xff;
    env.ct = ct.toString('base64');
    expect(() => decryptField(packV2(env))).toThrow(/Decryption failed/);
  });

  it('throws when the wrapped DEK is tampered (KEK-level GCM tag fails)', () => {
    const env = parseV2(encryptField('top-secret-phi'));
    const edek = Buffer.from(env.edek, 'base64');
    edek[0] ^= 0xff;
    env.edek = edek.toString('base64');
    expect(() => decryptField(packV2(env))).toThrow(/Decryption failed/);
  });

  it('throws when the data auth tag is tampered', () => {
    const env = parseV2(encryptField('top-secret-phi'));
    const tag = Buffer.from(env.tag, 'base64');
    tag[0] ^= 0xff;
    env.tag = tag.toString('base64');
    expect(() => decryptField(packV2(env))).toThrow(/Decryption failed/);
  });

  it('throws on an unknown KEK keyId', () => {
    const env = parseV2(encryptField('x'));
    env.kid = 'no-such-kek';
    expect(() => decryptField(packV2(env))).toThrow(/Decryption failed/);
  });

  it('throws on a future envelope version', () => {
    const env = parseV2(encryptField('x'));
    env.v = 99;
    expect(() => decryptField(packV2(env))).toThrow(/Decryption failed/);
  });
});

describe('KEK rotation via rewrapField', () => {
  it('re-wraps the DEK under a new keyId without re-encrypting the field', () => {
    const oldKek = deriveKekFromMaterial('old-kek-material-for-rotation-test');
    const newKek = deriveKekFromMaterial('new-kek-material-for-rotation-test');
    const oldProvider = new LocalKekProvider({ activeKeyId: 'k-old', keks: { 'k-old': oldKek } });

    // Encrypt under the OLD provider.
    setKekProvider(oldProvider);
    const original = encryptField('high-PHI-content under old KEK');
    expect(getKeyId(original)).toBe('k-old');

    // Rotation provider knows BOTH keys, active = new.
    const rotationProvider = new LocalKekProvider({
      activeKeyId: 'k-new',
      keks: { 'k-new': newKek, 'k-old': oldKek },
    });
    const rewrapped = rewrapField(original, { provider: rotationProvider });
    expect(rewrapped).not.toBe(original);
    expect(getKeyId(rewrapped)).toBe('k-new');

    // The PHI ciphertext/iv/tag are IDENTICAL — only the wrapped DEK changed.
    const decodeV2 = (p) => JSON.parse(Buffer.from(p.slice('enc:v2:'.length), 'base64url').toString('utf8'));
    const a = decodeV2(original);
    const b = decodeV2(rewrapped);
    expect(b.ct).toBe(a.ct);
    expect(b.iv).toBe(a.iv);
    expect(b.tag).toBe(a.tag);
    expect(b.edek).not.toBe(a.edek);

    // New-only provider can decrypt the rewrapped value; old-only cannot.
    const newOnly = new LocalKekProvider({ activeKeyId: 'k-new', keks: { 'k-new': newKek } });
    setKekProvider(newOnly);
    expect(decryptField(rewrapped)).toBe('high-PHI-content under old KEK');
    expect(() => decryptField(original)).toThrow(/Decryption failed/); // old keyId unknown to newOnly
  });

  it('leaves enc:v1: values unchanged (no separable DEK to re-wrap)', () => {
    expect(rewrapField(V1_FIXTURE)).toBe(V1_FIXTURE);
  });

  it('leaves null/empty/plaintext unchanged', () => {
    expect(rewrapField(null)).toBeNull();
    expect(rewrapField('')).toBe('');
    expect(rewrapField('plain')).toBe('plain');
  });

  it('rewrap under the SAME active keyId still produces a valid (re-wrapped) payload', () => {
    const provider = new LocalKekProvider({
      activeKeyId: 'k1',
      keks: { k1: deriveKekFromMaterial('same-key') },
    });
    setKekProvider(provider);
    const original = encryptField('value');
    const rewrapped = rewrapField(original);
    // Same keyId, but a fresh wrap IV means the payload differs and still decrypts.
    expect(getKeyId(rewrapped)).toBe('k1');
    expect(decryptField(rewrapped)).toBe('value');
  });
});

describe('LocalKekProvider behavior', () => {
  it('falls back to FIELD_ENCRYPTION_KEY when FIELD_ENCRYPTION_KEK is unset', () => {
    // Default env: KEK unset. Provider must still construct and wrap/unwrap.
    const provider = new LocalKekProvider();
    expect(provider.activeKeyId).toBe(DEFAULT_KEK_ID);
    const dek = provider.generateDek();
    const wrapped = provider.wrapDek(dek);
    const unwrapped = provider.unwrapDek(wrapped);
    expect(Buffer.compare(unwrapped, dek)).toBe(0);
  });

  it('derives the KEK from FIELD_ENCRYPTION_KEK when set (distinct from FIELD_ENCRYPTION_KEY)', () => {
    const kekFromKey = deriveKekFromMaterial(process.env.FIELD_ENCRYPTION_KEY);
    const kekFromKek = deriveKekFromMaterial('a-totally-separate-kek-secret-value');
    expect(Buffer.compare(kekFromKey, kekFromKek)).not.toBe(0);

    process.env.FIELD_ENCRYPTION_KEK = 'a-totally-separate-kek-secret-value';
    process.env.FIELD_ENCRYPTION_KEK_ID = 'kek-explicit';
    const provider = new LocalKekProvider();
    expect(provider.activeKeyId).toBe('kek-explicit');
    expect(Buffer.compare(provider.getKek('kek-explicit'), kekFromKek)).toBe(0);
  });

  it('registers an OLD KEK so one process can unwrap retired-keyId DEKs', () => {
    process.env.FIELD_ENCRYPTION_KEK = 'new-active-kek-material-value!!';
    process.env.FIELD_ENCRYPTION_KEK_ID = 'new-id';
    process.env.FIELD_ENCRYPTION_KEK_OLD = 'old-retired-kek-material-value';
    process.env.FIELD_ENCRYPTION_KEK_OLD_ID = 'old-id';
    const provider = new LocalKekProvider();
    expect(provider.listKeyIds().sort()).toEqual(['new-id', 'old-id']);
    expect(provider.activeKeyId).toBe('new-id');
  });

  it('throws when asked for an unknown keyId', () => {
    const provider = new LocalKekProvider();
    expect(() => provider.getKek('does-not-exist')).toThrow(/Unknown KEK keyId/);
  });

  it('rejects a DEK that is not 32 bytes', () => {
    const provider = new LocalKekProvider();
    expect(() => provider.wrapDek(Buffer.alloc(16))).toThrow(/32-byte Buffer/);
  });
});

describe('searchableHash', () => {
  it('is deterministic and case/whitespace-normalised', () => {
    const a = searchableHash('  Patient@Example.COM ');
    const b = searchableHash('patient@example.com');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null for null/undefined input', () => {
    expect(searchableHash(null)).toBeNull();
    expect(searchableHash(undefined)).toBeNull();
  });

  it('with FIELD_SEARCH_HMAC_KEY UNSET, reproduces the legacy hash byte-for-byte (back-compat)', () => {
    // Default fallback == legacy derived key. Existing DB hashes MUST still match.
    expect(searchableHash('9876543210')).toBe(LEGACY_PHONE_HASH);
  });

  it('with a NEW FIELD_SEARCH_HMAC_KEY, produces a DIFFERENT hash (key is actually separate)', () => {
    const legacy = searchableHash('9876543210');
    expect(legacy).toBe(LEGACY_PHONE_HASH);

    process.env.FIELD_SEARCH_HMAC_KEY = 'a-brand-new-dedicated-search-hmac-key!!';
    resetKeyCacheForTesting();
    const rotated = searchableHash('9876543210');
    expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated).not.toBe(legacy); // proves rotating the key changes output -> backfill required
  });

  it('the search HMAC key is independent of the v2 ENCRYPTION key path', () => {
    // searchableHash must NOT depend on the KEK provider at all.
    setKekProvider(new LocalKekProvider({ activeKeyId: 'whatever', keks: { whatever: deriveKekFromMaterial('zzz') } }));
    expect(searchableHash('9876543210')).toBe(LEGACY_PHONE_HASH);
  });
});

describe('encryptFields / decryptFields object helpers', () => {
  it('encrypts only listed fields and decrypts them back, skipping already-encrypted + non-listed', () => {
    const preEncrypted = encryptField('already');
    const obj = {
      address: '12 MG Road, Chennai',
      blood_group: 'O+',
      name: 'unchanged-not-listed',
      emergency_contact: preEncrypted, // already encrypted -> left as-is
    };
    const enc = encryptFields(obj, ['address', 'blood_group', 'emergency_contact']);
    expect(isEncrypted(enc.address)).toBe(true);
    expect(isEncrypted(enc.blood_group)).toBe(true);
    expect(enc.emergency_contact).toBe(preEncrypted); // not double-encrypted
    expect(enc.name).toBe('unchanged-not-listed'); // not in list

    const dec = decryptFields(enc, ['address', 'blood_group', 'emergency_contact']);
    expect(dec.address).toBe('12 MG Road, Chennai');
    expect(dec.blood_group).toBe('O+');
    expect(dec.emergency_contact).toBe('already');
  });
});

describe('does not collide with the independent mfaService TOTP secret format', () => {
  it('enc:v2 payload is never a 3-part all-hex string (mfa isEncryptedTotpSecret check)', () => {
    const ct = encryptField('totp-like');
    const parts = ct.split(':');
    // mfaService treats exactly 3 colon-parts of all-hex as its own format.
    const looksLikeMfa = parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
    expect(looksLikeMfa).toBe(false);
  });
});

// Keep the explicit jest import referenced so eslint's no-unused-vars is happy
// even though these suites don't use jest.fn().
void jest;
