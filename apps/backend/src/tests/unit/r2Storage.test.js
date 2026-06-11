/**
 * Unit tests for the security-critical helpers in src/utils/r2Storage.js:
 *   - verifyLocalToken — HMAC + expiry check on signed-URL tokens
 *   - resolveLocalKey  — path-traversal guard for local-disk fallback
 *
 * The HMAC token is the only thing keeping random callers from downloading
 * arbitrary files via /api/v1/storage/file/* (that route is mounted before
 * jwtAuth + validateApiKey to match Cloudflare R2 signed-URL semantics),
 * so a tampered/expired/forged token MUST be rejected. The path guard is
 * the only thing keeping a malicious key (`../../etc/passwd`, null bytes,
 * etc.) from escaping the storage dir.
 *
 * Tests assume R2_AVAILABLE is false (no CF_R2_* env vars in the test
 * environment) so the local-fallback code paths are active.
 */

import crypto from 'crypto';
import path from 'path';

// Tests need a JWT_SECRET set before r2Storage.js is imported (it's
// captured at module-load time as TOKEN_SECRET). Set a deterministic one
// so the HMAC outputs are reproducible across runs.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-r2storage-unit-tests';
// Force local-fallback mode by clearing any R2 env that might leak in
// from a developer's .env file.
delete process.env.CF_ACCOUNT_ID;
delete process.env.CF_R2_BUCKET;
delete process.env.CF_R2_URL;
delete process.env.CF_R2_ACCESS_KEY_ID;
delete process.env.CF_R2_SECRET_ACCESS_KEY;

// Pin the local dir to a temp path so tests don't pollute the real
// `apps/backend/storage/local-r2` directory.
const TEST_LOCAL_DIR = path.resolve(process.cwd(), '.test-storage-local-r2');
process.env.STORAGE_LOCAL_DIR = TEST_LOCAL_DIR;

const { verifyLocalToken, resolveLocalKey, getSignedFileUrl, isLocalStorage } =
  await import('../../utils/r2Storage.js');

// Helper: build a token the same way signLocalToken does so we can compare.
// Audit finding L3: the storage token secret is no longer JWT_SECRET itself —
// it's STORAGE_TOKEN_SECRET when set, else an HMAC-derived sub-key of
// JWT_SECRET with the domain-separation label below (mirrors r2Storage.js).
const STORAGE_SECRET = process.env.STORAGE_TOKEN_SECRET
  || crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update('vhhealth-storage-token-v1')
    .digest('hex');

function makeToken(key, expiryMs) {
  const sig = crypto
    .createHmac('sha256', STORAGE_SECRET)
    .update(`${key}|${expiryMs}`)
    .digest('base64url');
  return `${sig}.${expiryMs}`;
}

describe('verifyLocalToken', () => {
  const key = 'uploads/abc/xyz.pdf';

  it('module is in local-fallback mode without R2 env vars', () => {
    expect(isLocalStorage).toBe(true);
  });

  it('accepts a valid, non-expired token', () => {
    const future = Date.now() + 60 * 1000;
    const token = makeToken(key, future);
    expect(verifyLocalToken(key, token)).toBe(true);
  });

  it('rejects an expired token', () => {
    const past = Date.now() - 1000;
    const token = makeToken(key, past);
    expect(verifyLocalToken(key, token)).toBe(false);
  });

  it('rejects a token forged with the wrong secret', () => {
    const future = Date.now() + 60 * 1000;
    const sig = crypto
      .createHmac('sha256', 'wrong-secret')
      .update(`${key}|${future}`)
      .digest('base64url');
    expect(verifyLocalToken(key, `${sig}.${future}`)).toBe(false);
  });

  it('rejects a token signed for a different key (cross-key replay)', () => {
    const future = Date.now() + 60 * 1000;
    const otherKey = 'uploads/other-user/secret.pdf';
    const token = makeToken(otherKey, future);
    // Same token, but verifying against the original key — must fail
    // (otherwise an attacker who owned `otherKey` could download anything).
    expect(verifyLocalToken(key, token)).toBe(false);
  });

  it('rejects a token with a tampered signature', () => {
    const future = Date.now() + 60 * 1000;
    const token = makeToken(key, future);
    // Flip one character in the sig portion.
    const bad = (token.startsWith('A') ? 'B' : 'A') + token.slice(1);
    expect(verifyLocalToken(key, bad)).toBe(false);
  });

  it('rejects a token with a tampered expiry (extending the lifetime)', () => {
    const original = Date.now() + 1000;
    const token = makeToken(key, original);
    const sig = token.split('.')[0];
    // Same sig, much later expiry — must fail because the HMAC payload
    // includes the expiry.
    const tampered = `${sig}.${original + 60 * 60 * 1000}`;
    expect(verifyLocalToken(key, tampered)).toBe(false);
  });

  it('rejects malformed tokens (no separator, empty, undefined)', () => {
    expect(verifyLocalToken(key, '')).toBe(false);
    expect(verifyLocalToken(key, undefined)).toBe(false);
    expect(verifyLocalToken(key, null)).toBe(false);
    expect(verifyLocalToken(key, 'no-dot-here')).toBe(false);
    expect(verifyLocalToken(key, 'abc.not-a-number')).toBe(false);
  });
});

describe('resolveLocalKey (path-traversal guard)', () => {
  const baseDir = path.resolve(TEST_LOCAL_DIR);

  it('resolves a normal nested key under the local dir', () => {
    const full = resolveLocalKey('uploads/abc/x.pdf');
    expect(full.startsWith(baseDir)).toBe(true);
    expect(full.endsWith(path.normalize('uploads/abc/x.pdf'))).toBe(true);
  });

  it('strips a leading slash', () => {
    const full = resolveLocalKey('/uploads/abc/x.pdf');
    expect(full.startsWith(baseDir)).toBe(true);
  });

  it('rejects ../ traversal attempts', () => {
    expect(() => resolveLocalKey('../../../etc/passwd')).toThrow();
    expect(() => resolveLocalKey('uploads/../../../etc/passwd')).toThrow();
  });

  it('rejects null bytes in the key', () => {
    expect(() => resolveLocalKey('uploads/abc\0/x.pdf')).toThrow(/Invalid storage key/);
  });

  it('handles keys with only safe characters', () => {
    expect(() => resolveLocalKey('uploads/uid-123/1234567890_file.pdf')).not.toThrow();
    expect(() => resolveLocalKey('uploads/uid_with_underscores/abc.png')).not.toThrow();
  });
});

describe('getSignedFileUrl (local backend)', () => {
  const key = 'uploads/abc/xyz.pdf';

  it('returns a backend URL with token + the configured base by default', async () => {
    const url = await getSignedFileUrl(key, 60);
    expect(url).toMatch(/\/api\/v1\/storage\/file\/uploads\/abc\/xyz\.pdf\?token=/);
    // Default PUBLIC_BASE_URL falls back to http://localhost:5000 when env unset.
    expect(url.startsWith('http://')).toBe(true);
  });

  it('uses the provided baseUrl when given', async () => {
    const url = await getSignedFileUrl(key, 60, { baseUrl: 'http://10.0.2.2:5000' });
    expect(url.startsWith('http://10.0.2.2:5000/api/v1/storage/file/')).toBe(true);
  });

  it('produces a token that verifyLocalToken accepts', async () => {
    const url = await getSignedFileUrl(key, 60);
    const token = new URL(url).searchParams.get('token');
    expect(verifyLocalToken(key, token)).toBe(true);
  });

  it('encodes path segments containing reserved characters', async () => {
    const odd = 'uploads/with space/file?name.pdf';
    const url = await getSignedFileUrl(odd, 60);
    expect(url).toContain('with%20space');
    expect(url).toContain('file%3Fname.pdf');
  });
});
