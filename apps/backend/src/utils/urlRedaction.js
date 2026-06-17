// src/utils/urlRedaction.js
//
// Redacts secret-bearing query-string VALUES before a URL is written to a log
// line (security finding: Firebase idToken — and other bearer/refresh/API
// secrets — leaked into request + audit logs via `req.originalUrl`, which
// includes the raw `?idToken=...`). The endpoint contract is unchanged; only
// the LOGGED representation of the URL is scrubbed. Path + non-sensitive
// params are preserved so log lines stay useful for correlation.

// Query-param names whose VALUES must never appear in logs. Compared
// case-insensitively against the param name.
const SENSITIVE_QUERY_PARAMS = new Set([
  'idtoken',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'api_key',
  'apikey',
]);

const REDACTED = '[REDACTED]';

/**
 * Given a request URL (e.g. `req.originalUrl` or `req.url`), returns the same
 * URL with the values of any sensitive query params replaced by `[REDACTED]`.
 * The path and all non-sensitive params are left intact. No query string ->
 * the input is returned unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
export function redactSensitiveQueryParams(url) {
  if (typeof url !== 'string' || url.length === 0) return url;

  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const path = url.slice(0, queryStart);
  const queryAndHash = url.slice(queryStart + 1);

  // Preserve any fragment (defensive — request URLs rarely carry one).
  const hashStart = queryAndHash.indexOf('#');
  const query = hashStart === -1 ? queryAndHash : queryAndHash.slice(0, hashStart);
  const hash = hashStart === -1 ? '' : queryAndHash.slice(hashStart);

  if (query.length === 0) return url;

  const redactedQuery = query
    .split('&')
    .map((pair) => {
      if (pair.length === 0) return pair;
      const eq = pair.indexOf('=');
      const rawName = eq === -1 ? pair : pair.slice(0, eq);
      if (SENSITIVE_QUERY_PARAMS.has(rawName.toLowerCase())) {
        return `${rawName}=${REDACTED}`;
      }
      return pair;
    })
    .join('&');

  return `${path}?${redactedQuery}${hash}`;
}

export default { redactSensitiveQueryParams };
