// src/utils/urlRedaction.js
//
// Redacts secret-bearing query-string VALUES before a URL is written to a log
// line (security finding: Firebase idToken — and other bearer/refresh/API
// secrets — leaked into request + audit logs via `req.originalUrl`, which
// includes the raw `?idToken=...`). The endpoint contract is unchanged; only
// the LOGGED representation of the URL is scrubbed. Path + non-sensitive
// params are preserved so log lines stay useful for correlation. The HL7
// receive endpoint is the exception: its arbitrary query values are dropped.

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

export function isHl7ReceiveEndpoint(path) {
  if (typeof path !== 'string' || path.length === 0) return false;

  const queryStart = path.indexOf('?');
  const pathOnly = queryStart === -1 ? path : path.slice(0, queryStart);
  const normalized = pathOnly.replace(/\/+$/, '').toLowerCase();
  return normalized === '/api/v1/hl7/receive' || normalized === '/hl7/receive';
}

/**
 * Given a request URL (e.g. `req.originalUrl` or `req.url`), returns the same
 * URL with the values of any sensitive query params replaced by `[REDACTED]`.
 * The path and all non-sensitive params are left intact, except that the HL7
 * receive endpoint drops its entire query string. No query string -> the input
 * is returned unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
export function redactSensitiveQueryParams(url) {
  if (typeof url !== 'string' || url.length === 0) return url;

  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const path = url.slice(0, queryStart);
  // HL7 recovery query values are not part of the endpoint contract and can
  // carry arbitrary PHI. Preserve only the route for every shared log caller.
  if (isHl7ReceiveEndpoint(path)) return path;

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

export default { isHl7ReceiveEndpoint, redactSensitiveQueryParams };
