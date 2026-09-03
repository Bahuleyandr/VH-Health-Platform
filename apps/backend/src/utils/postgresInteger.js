export const PG_INT4_MAX = 2147483647;

export function exactPositiveInt4OrNull(value) {
  let text = value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    text = String(value);
  } else if (typeof value === 'bigint') {
    text = value.toString();
  }
  if (typeof text !== 'string' || !/^[1-9][0-9]*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed <= PG_INT4_MAX ? parsed : null;
}

export default { exactPositiveInt4OrNull, PG_INT4_MAX };
