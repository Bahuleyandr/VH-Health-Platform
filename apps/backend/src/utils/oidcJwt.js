import crypto from 'crypto';

function base64urlDecode(input) {
  const value = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function parseJsonPart(part, label) {
  try {
    return JSON.parse(base64urlDecode(part).toString('utf8'));
  } catch {
    throw new Error(`Invalid OIDC ${label}`);
  }
}

function audContains(aud, expected) {
  if (Array.isArray(aud)) return aud.map(String).includes(expected);
  return String(aud || '') === expected;
}

function normalizePemOrJwk(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function timingSafeStringEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid OIDC JWT shape');
  return {
    header: parseJsonPart(parts[0], 'header'),
    payload: parseJsonPart(parts[1], 'payload'),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64urlDecode(parts[2]),
  };
}

export function verifyOidcIdToken({
  idToken,
  jwks,
  issuer,
  clientId,
  nonce,
  clockSkewSeconds = 60,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const parsed = decodeJwt(idToken);
  const { header, payload, signingInput, signature } = parsed;

  if (header.alg !== 'RS256') {
    throw new Error('Unsupported OIDC JWT algorithm');
  }
  if (!header.kid) {
    throw new Error('OIDC JWT missing kid');
  }
  const key = (jwks?.keys || []).find((candidate) => candidate.kid === header.kid);
  if (!key) {
    throw new Error('OIDC JWKS kid not found');
  }
  if (key.kty !== 'RSA') {
    throw new Error('OIDC JWKS key is not RSA');
  }

  const valid = crypto.verify('RSA-SHA256', Buffer.from(signingInput, 'utf8'), normalizePemOrJwk(key), signature);
  if (!valid) {
    throw new Error('OIDC JWT signature invalid');
  }

  if (!timingSafeStringEqual(payload.iss, issuer)) {
    throw new Error('OIDC issuer mismatch');
  }
  if (!audContains(payload.aud, clientId)) {
    throw new Error('OIDC audience mismatch');
  }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
    throw new Error('OIDC authorized party mismatch');
  }
  if (!timingSafeStringEqual(payload.nonce, nonce)) {
    throw new Error('OIDC nonce mismatch');
  }
  if (typeof payload.exp !== 'number' || payload.exp + clockSkewSeconds < nowSeconds) {
    throw new Error('OIDC token expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - clockSkewSeconds > nowSeconds) {
    throw new Error('OIDC token not yet valid');
  }
  if (typeof payload.iat === 'number' && payload.iat - clockSkewSeconds > nowSeconds) {
    throw new Error('OIDC token issued in the future');
  }

  return { header, payload };
}

export function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(String(input)).digest('base64url');
}
