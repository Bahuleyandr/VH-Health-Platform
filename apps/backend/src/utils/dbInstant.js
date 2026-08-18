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
 * How to choose: if the value GATES ACCESS (consent, credential, approval,
 * token), absence must deny — `if (ms == null || ms < Date.now())`. If NULL
 * legitimately means "no expiry was configured", absence is permissive —
 * `if (ms != null && ms < Date.now())`. Converting a gate from the first form
 * to the second is how PR #881 shipped a fail-open on the nullable
 * `abdm_consents.expiry_date`; PR #882 restored the deny branch.
 * scripts/check-timestamptz-clock-comparisons.mjs points back here.
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
