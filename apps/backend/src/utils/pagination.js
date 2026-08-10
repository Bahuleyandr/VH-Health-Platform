export function boundedInteger(value, {
  fallback,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
}) {
  const numericInput = typeof value === 'number'
    || (typeof value === 'string' && value.trim() !== '');
  const parsed = numericInput ? Number(value) : Number.NaN;
  const fallbackNumber = Number(fallback);
  const normalizedFallback = Number.isFinite(fallbackNumber)
    ? Math.trunc(fallbackNumber)
    : min;
  const integer = Number.isFinite(parsed) ? Math.trunc(parsed) : normalizedFallback;
  const normalized = integer === 0 && min > 0 ? normalizedFallback : integer;
  return Math.min(Math.max(normalized, min), max);
}

export default { boundedInteger };
