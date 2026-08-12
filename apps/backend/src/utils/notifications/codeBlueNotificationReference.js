import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const PURPOSE = 'vhhealth-code-blue-notification-reference-v1';
const MAX_REFERENCE_LENGTH = 2048;

function key() {
  const secret = process.env.CODE_BLUE_NOTIFICATION_SECRET || process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('Code Blue notification reference secret is not configured');
  }
  return createHash('sha256').update(`${PURPOSE}\0${secret}`).digest();
}

export function createCodeBlueNotificationReference({
  tenantId,
  userUid,
  deviceId,
  registrationEpoch,
  sessionEpoch,
  authorizationEpoch,
  eventId,
  expiresAtUnix,
}) {
  if (!/^\d+$/.test(String(eventId || ''))) return '';
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(Number(expiresAtUnix), issuedAt + 60);
  if (!Number.isInteger(expiresAt) || expiresAt <= issuedAt) return '';
  const plaintext = Buffer.from(JSON.stringify({
    v: 1,
    t: String(tenantId),
    u: String(userUid),
    d: String(deviceId),
    r: String(registrationEpoch),
    s: String(sessionEpoch),
    a: String(authorizationEpoch),
    e: String(eventId),
    i: issuedAt,
    x: expiresAt,
  }));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(PURPOSE));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

export function readCodeBlueNotificationReference(reference, expected, now = new Date()) {
  try {
    const encoded = String(reference || '');
    if (!encoded || encoded.length > MAX_REFERENCE_LENGTH) return null;
    const [version, ivEncoded, ciphertextEncoded, tagEncoded, extra] = encoded.split('.');
    if (version !== 'v1' || !ivEncoded || !ciphertextEncoded || !tagEncoded || extra) return null;
    const iv = Buffer.from(ivEncoded, 'base64url');
    const ciphertext = Buffer.from(ciphertextEncoded, 'base64url');
    const tag = Buffer.from(tagEncoded, 'base64url');
    if (
      iv.length !== 12
      || tag.length !== 16
      || iv.toString('base64url') !== ivEncoded
      || ciphertext.toString('base64url') !== ciphertextEncoded
      || tag.toString('base64url') !== tagEncoded
    ) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAAD(Buffer.from(PURPOSE));
    decipher.setAuthTag(tag);
    const claims = JSON.parse(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8'));
    const nowUnix = Math.floor(now.getTime() / 1000);
    if (
      claims?.v !== 1
      || !Number.isInteger(claims.i)
      || !Number.isInteger(claims.x)
      || claims.i > nowUnix + 5
      || claims.x <= nowUnix
      || claims.x > claims.i + 60
      || !/^\d+$/.test(String(claims.e || ''))
      || String(claims.t) !== String(expected.tenantId)
      || String(claims.u) !== String(expected.userUid)
      || String(claims.d) !== String(expected.deviceId)
      || String(claims.r) !== String(expected.registrationEpoch)
      || String(claims.s) !== String(expected.sessionEpoch)
      || String(claims.a) !== String(expected.authorizationEpoch)
    ) return null;
    return { eventId: String(claims.e), expiresAtUnix: claims.x };
  } catch {
    return null;
  }
}
