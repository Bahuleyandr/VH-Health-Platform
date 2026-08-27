// src/utils/urlRedaction.js
//
// Shared credential-query parsing for log-safe URLs and credential-free
// management projections. redactSensitiveQueryParams also removes known
// secret-bearing callback path segments and drops arbitrary HL7-receive/SMS
// callback queries; redactCredentialQueryValues only replaces recognized
// credential query values and preserves all other URL components.

import { isCredentialFieldName } from './credentialFieldRedaction.js';

const REDACTED = '[REDACTED]';

function isSensitiveQueryParam(rawName) {
  let decoded = String(rawName || '').replace(/\+/g, ' ');
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return isCredentialFieldName(decoded);
}

export function hasSensitiveQueryParameters(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return false;
  const queryAndHash = url.slice(queryStart + 1);
  const hashStart = queryAndHash.indexOf('#');
  const query = hashStart === -1 ? queryAndHash : queryAndHash.slice(0, hashStart);
  return query.split('&').some((pair) => {
    if (pair.length === 0) return false;
    const eq = pair.indexOf('=');
    return isSensitiveQueryParam(eq === -1 ? pair : pair.slice(0, eq));
  });
}

export function redactCredentialQueryValues(url, redactedValue = REDACTED) {
  if (typeof url !== 'string' || url.length === 0) return url;
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const path = url.slice(0, queryStart);
  const queryAndHash = url.slice(queryStart + 1);
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
      return isSensitiveQueryParam(rawName) ? `${rawName}=${redactedValue}` : pair;
    })
    .join('&');

  return `${path}?${redactedQuery}${hash}`;
}

function redactSensitivePathSegments(url) {
  return url
    .replace(
      /(\/webhooks\/sms\/(?:dlr|twilio-status)\/)[^/?#]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(\/webhooks\/payments\/)[^/?#]+/gi,
      `$1${REDACTED}`,
    );
}

export function isHl7ReceiveEndpoint(path) {
  if (typeof path !== 'string' || path.length === 0) return false;

  const queryStart = path.indexOf('?');
  const pathOnly = queryStart === -1 ? path : path.slice(0, queryStart);
  const normalized = pathOnly.replace(/\/+$/, '').toLowerCase();
  return normalized === '/api/v1/hl7/receive' || normalized === '/hl7/receive';
}

export function isSmsDeliveryStatusEndpoint(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  let pathOnly = path.split('?')[0];
  try {
    pathOnly = new URL(pathOnly).pathname;
  } catch {
    // Request paths are normally relative, so URL parsing is optional.
  }
  return /^\/webhooks\/sms\/(?:dlr|twilio-status)\//i.test(pathOnly);
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

  const redactedUrl = redactSensitivePathSegments(url);
  const queryStart = redactedUrl.indexOf('?');
  if (queryStart === -1) return redactedUrl;

  const path = redactedUrl.slice(0, queryStart);
  // HL7 recovery query values are not part of the endpoint contract and can
  // carry arbitrary PHI. Preserve only the route for every shared log caller.
  if (isHl7ReceiveEndpoint(path)) return path;
  // SMS providers can echo the destination MSISDN in callback query fields.
  // The route token is already redacted above; suppress the whole query so
  // arbitrary provider fields cannot put a phone number into shared logs.
  if (isSmsDeliveryStatusEndpoint(path)) return path;

  return redactCredentialQueryValues(redactedUrl);
}

export default {
  hasSensitiveQueryParameters,
  isHl7ReceiveEndpoint,
  redactCredentialQueryValues,
  redactSensitiveQueryParams,
};
