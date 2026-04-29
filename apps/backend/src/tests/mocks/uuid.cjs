const crypto = require('node:crypto');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parse(uuid) {
  if (!validate(uuid)) {
    throw new TypeError('Invalid UUID');
  }
  return Uint8Array.from(uuid.replace(/-/g, '').match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
}

function stringify(bytes, offset = 0) {
  const slice = Array.from(bytes.slice(offset, offset + 16));
  if (slice.length !== 16) {
    throw new TypeError('Invalid byte array length');
  }
  const hex = slice.map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function validate(uuid) {
  return typeof uuid === 'string' && UUID_RE.test(uuid);
}

function version(uuid) {
  if (!validate(uuid)) {
    throw new TypeError('Invalid UUID');
  }
  return Number(uuid[14]);
}

function v4(_options, buf, offset = 0) {
  const uuid = crypto.randomUUID();
  if (!buf) {
    return uuid;
  }
  const bytes = parse(uuid);
  for (let i = 0; i < bytes.length; i += 1) {
    buf[offset + i] = bytes[i];
  }
  return buf;
}

module.exports = {
  NIL: '00000000-0000-0000-0000-000000000000',
  MAX: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  parse,
  stringify,
  validate,
  version,
  v4,
};
