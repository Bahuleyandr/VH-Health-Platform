// apps/backend/src/utils/money.js
//
// Integer-paise money util. The DB stores ledger amounts as BIGINT paise and
// all ledger arithmetic is exact integer math — JS floats never touch a money
// value. Rupee<->paise conversion parses the decimal STRING digit-wise so
// 0.1/0.3/19.99 never lose a paisa to binary-float representation.

/** Throw if n is not a safe integer; return it otherwise. */
export function assertWholePaise(n) {
  if (!Number.isInteger(n)) {
    throw new Error(`Expected whole paise (integer), got ${n}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Paise value ${n} exceeds safe integer range`);
  }
  return n;
}

function signed(sign, whole, frac) {
  const paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  const value = sign === '-' ? -paise : paise;
  return assertWholePaise(value);
}

/**
 * Convert a rupee amount (number or string like "19.99") to integer paise.
 * Parses the string form to avoid float drift; rejects >2 significant decimals.
 */
export function toPaise(rupees) {
  const str = typeof rupees === 'number' ? rupees.toFixed(2) : String(rupees).trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(str);
  if (m) {
    return signed(m[1], m[2], m[3] || '0');
  }
  // Allow more than 2 decimal places only when the extra digits are all zeros;
  // anything else is sub-paisa precision and is rejected.
  const m2 = /^(-?)(\d+)\.(\d+)$/.exec(str);
  if (m2 && /^0*$/.test(m2[3].slice(2))) {
    return signed(m2[1], m2[2], m2[3].slice(0, 2));
  }
  throw new Error(`Invalid rupee amount (sub-paisa precision?): ${rupees}`);
}

/** Convert integer paise back to a 2dp rupee string. */
export function fromPaise(paise) {
  assertWholePaise(paise);
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  return `${neg ? '-' : ''}${rupees}.${String(p).padStart(2, '0')}`;
}

export default { toPaise, fromPaise, assertWholePaise };
