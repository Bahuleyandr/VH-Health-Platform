/**
 * Absolute instants read back from Postgres.
 *
 * A `timestamptz` materialised by the pg driver is shifted by the DATABASE
 * SESSION timezone, so comparing one against the process clock is correct only
 * when that session happens to be UTC. A query that needs a clock comparison
 * therefore selects an epoch-millisecond twin next to the column —
 * `(EXTRACT(EPOCH FROM col) * 1000)::bigint AS col_epoch_ms` — which is the
 * absolute instant and is byte-identical in every session timezone.
 */

/**
 * Normalise such a column to milliseconds since the Unix epoch.
 *
 * Returns null for SQL NULL and for anything unparseable. Callers decide what
 * absence means, because it is deliberately not the same everywhere: a missing
 * consent expiry denies access, whereas a missing key-material expiry means
 * "no expiry was set".
 *
 * The null handling is the point. `Number(null)` is `0` — finite, and comparing
 * as "long ago" — so a bare `Number.isFinite(Number(value))` guard silently
 * turns a NULL expiry into an already-expired one. The driver hands these back
 * as BigInt, which `Number()` widens losslessly at millisecond magnitudes.
 *
 * @param {bigint|number|string|null|undefined} value
 * @returns {number|null}
 */
export function epochMsOrNull(value) {
  if (value == null) return null;
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : null;
}

export default { epochMsOrNull };
