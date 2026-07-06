import crypto from 'crypto';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET ||= 'test-jwt-secret-for-ci-must-be-at-least-32-chars';

const { verifyOidcIdToken } = await import('../../utils/oidcJwt.js');
const jwtMiddleware = (await import('../../middleware/jwtMiddleware.js')).default;

const ISSUER = 'https://idp.test/realms/vh-admin';
const CLIENT_ID = 'vh-admin';
const NONCE = 'nonce-123';
const NOW = 1_800_000_000;

function keyPair(kid) {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
  };
}

const keyA = keyPair('kid-a');
const keyB = keyPair('kid-b');

function signIdToken(overrides = {}, key = keyA) {
  return jwt.sign(
    {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'admin-subject',
      nonce: NONCE,
      iat: NOW - 10,
      exp: NOW + 300,
      ...overrides,
    },
    key.privateKey,
    { algorithm: 'RS256', keyid: key.kid },
  );
}

function verify(token, jwks = { keys: [keyA.jwk] }) {
  return verifyOidcIdToken({
    idToken: token,
    jwks,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    nonce: NONCE,
    nowSeconds: NOW,
  });
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('verifyOidcIdToken', () => {
  it('validates signature, issuer, audience, nonce, and lifetime', () => {
    const verified = verify(signIdToken());
    expect(verified.header.kid).toBe('kid-a');
    expect(verified.payload.sub).toBe('admin-subject');
  });

  it('rejects issuer mismatch', () => {
    expect(() => verify(signIdToken({ iss: 'https://other-idp.test' }))).toThrow(/issuer/i);
  });

  it('rejects audience mismatch', () => {
    expect(() => verify(signIdToken({ aud: 'other-client' }))).toThrow(/audience/i);
  });

  it('rejects nonce mismatch', () => {
    expect(() => verify(signIdToken({ nonce: 'wrong-nonce' }))).toThrow(/nonce/i);
  });

  it('handles JWKS kid rotation by requiring the matching kid', () => {
    const rotated = signIdToken({}, keyB);
    expect(() => verify(rotated, { keys: [keyA.jwk] })).toThrow(/kid/i);
    expect(verify(rotated, { keys: [keyA.jwk, keyB.jwk] }).header.kid).toBe('kid-b');
  });

  it('rejects an expired token', () => {
    expect(() => verify(signIdToken({ exp: NOW - 120 }))).toThrow(/expired/i);
  });
});

describe('jwtMiddleware REST bearer boundary', () => {
  it('rejects an IdP RS256 token as a VH REST bearer token', async () => {
    const idpToken = signIdToken({
      sub: 'a0000000-0000-4000-8000-000000000099',
      role: 'ADMIN',
    });
    const req = {
      headers: { authorization: `Bearer ${idpToken}` },
      connection: { remoteAddress: '127.0.0.1' },
    };
    const res = makeRes();
    let nextCalled = false;

    await jwtMiddleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ success: false, code: 'TOKEN_INVALID' });
  });
});
