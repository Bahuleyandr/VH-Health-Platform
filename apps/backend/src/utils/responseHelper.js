// src/utils/responseHelper.js

import logger from '../logging/logger.js';

const IS_PROD = (process.env.NODE_ENV || '').toLowerCase() === 'production';

/**
 * Patterns that suggest a message contains leaked internals (stack frames,
 * raw DB errors, driver output, file paths, prisma noise). Anything matching
 * gets replaced with a generic message in production.
 *
 * Keep this list defensive — false positives just give a generic message,
 * false negatives leak internals. Tune toward stricter over time.
 *
 * Exported for unit-test coverage so new patterns don't regress.
 */
export const LEAK_PATTERNS = [
  /\n\s{4}at\s/,          // stack frames: "    at Object.<anonymous>"
  /^Error:/i,             // raw Error.toString()
  /SequelizeError|PrismaClient|prisma|pg_|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,
  /\/(home|root|usr|opt)\//,        // absolute Unix filesystem paths
  // F-1 — also catch Windows developer machine paths (`D:\Dev\...`,
  // `C:\Users\foo\...`). Finding:
  // 2026-05-08-emergency-walk-in-admission-beds-available-prisma-leak.
  /[A-Z]:\\(Users|Dev|Projects|Program Files)\\/i,
  /\bnode_modules[\\/]@?prisma/i,
  /\bsyntax error\b/i,
  /\bunexpected token\b/i,
  /\bconnection refused\b/i,
  // Postgres schema leaks — "relation/column/table/constraint "foo" does not
  // exist" prints the internal object name verbatim. HIPAA concern: exposes
  // schema surface to attackers / end users.
  /\b(relation|column|table|constraint|type|index)\s+"[^"]+"\s+(does\s+not\s+exist|already\s+exists)/i,
  /\bduplicate\s+key\s+value\s+violates\s+unique\s+constraint\b/i,
  /\bviolates\s+foreign\s+key\s+constraint\b/i,
  /\bnull\s+value\s+in\s+column\s+"[^"]+"\s+violates\s+not-null/i,
  // Prisma-style invocation banner: "Invalid `prisma.$queryRawUnsafe(...)`"
  /Invalid\s+`?prisma\.\$/i,
  // Postgres type-mismatch leaks:
  //   "operator does not exist: uuid = text"
  //   "operator does not exist: uuid = text[]"
  // Emitted when a query binds wrong-typed parameters (e.g. passing a JS
  // array where a scalar is expected, or missing a ::uuid cast).
  /\boperator\s+does\s+not\s+exist:\s+[a-z_]+\s*=\s*[a-z_]+(\[\])?/i,
  // Postgres undefined-function / argument-mismatch hints
  /\bNo\s+operator\s+matches\s+the\s+given\s+name\b/i,
];

const GENERIC_5XX = 'An internal server error occurred. Please try again later.';
const GENERIC_4XX = 'Request could not be processed.';

/**
 * Scrubs a client-bound error message. In production strips anything that
 * looks like raw internals and always generalises 5xx messages unless the
 * caller explicitly marked the message as `safe`.
 *
 * Always logs the original server-side (via logger.warn) so operators keep
 * visibility.
 *
 * @param {string} message
 * @param {number} statusCode
 * @param {{ safe?: boolean, context?: string }} opts
 * @returns {string}
 */
export function sanitizeErrorMessage(message, statusCode, opts = {}) {
  const raw = typeof message === 'string' ? message : String(message ?? '');
  const safe = opts.safe === true;

  // F-1 — even in non-prod, scrub messages that match leak patterns
  // (stack frames, Prisma internals, filesystem paths). Devs can still
  // see the full stack in the structured server log; only the response
  // body gets the generic message. Prevents the leaked Prisma stack +
  // dev filesystem path from surfacing on test deployments where the
  // tenant runs without NODE_ENV=production.
  if (!IS_PROD) {
    if (raw && LEAK_PATTERNS.some((re) => re.test(raw))) {
      logger.warn('responseHelper: scrubbed leaky error message (non-prod)', {
        original: raw,
        statusCode,
        context: opts.context,
      });
      return statusCode >= 500 ? GENERIC_5XX : GENERIC_4XX;
    }
    return raw || (statusCode >= 500 ? GENERIC_5XX : GENERIC_4XX);
  }

  // In production: never leak for 5xx unless explicitly safe.
  if (statusCode >= 500 && !safe) {
    if (raw && raw !== GENERIC_5XX) {
      logger.warn('responseHelper: scrubbed 5xx message before sending', {
        original: raw,
        context: opts.context,
      });
    }
    return GENERIC_5XX;
  }

  // 4xx (and opted-in 5xx): strip if it smells like leaked internals.
  if (LEAK_PATTERNS.some((re) => re.test(raw))) {
    logger.warn('responseHelper: scrubbed leaky error message', {
      original: raw,
      statusCode,
      context: opts.context,
    });
    return statusCode >= 500 ? GENERIC_5XX : GENERIC_4XX;
  }

  return raw || (statusCode >= 500 ? GENERIC_5XX : GENERIC_4XX);
}

/**
 * Standard success response.
 * @param {Response} res - Express response
 * @param {*} data - Response payload
 * @param {string} message - Human-readable message
 * @param {number} status - HTTP status (default 200)
 * @param {Object} meta - Optional metadata (pagination, etc.)
 */
export function success(res, data, message = 'Success', status = 200, meta = {}) {
  const response = {
    success: true,
    message,
    data,
  };

  // Include request ID for correlation if available
  if (res.req?.id) {
    response.requestId = res.req.id;
  }

  // Merge optional metadata (pagination, etc.)
  if (Object.keys(meta).length > 0) {
    response.meta = meta;
  }

  res.status(status).json(response);
}

/**
 * Standard error response.
 *
 * In production, messages are automatically scrubbed (see
 * `sanitizeErrorMessage`). Callers that have a safe, hand-written message
 * for a 5xx can opt out by passing `{ safe: true }` as the 4th arg *or* by
 * passing a details object with `safe: true`.
 *
 * @param {Response} res - Express response
 * @param {string} message - Error message (generic, safe for clients)
 * @param {number} statusCode - HTTP status (default 500)
 * @param {*} details - Optional error details (validation errors, etc.)
 *                      May be `{ safe: true, ...rest }` to opt out of
 *                      5xx scrubbing when the message is confirmed safe.
 */
export function error(res, message = 'Internal server error', statusCode = 500, details = null) {
  let safeFlag = false;
  let outDetails = details;
  if (details && typeof details === 'object' && details.safe === true) {
    safeFlag = true;
    const { safe: _safe, ...rest } = details;
    outDetails = Object.keys(rest).length > 0 ? rest : null;
  }

  const finalMessage = sanitizeErrorMessage(message, statusCode, {
    safe: safeFlag,
    context: res.req?.originalUrl,
  });

  const response = {
    success: false,
    message: finalMessage,
  };

  if (res.req?.id) {
    response.requestId = res.req.id;
  }

  if (outDetails) {
    response.details = outDetails;
  }

  res.status(statusCode).json(response);
}
