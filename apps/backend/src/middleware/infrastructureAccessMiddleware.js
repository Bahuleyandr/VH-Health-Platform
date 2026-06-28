import crypto from 'crypto';
import jwtAuth from './jwtMiddleware.js';
import rbac from './rbacMiddleware.js';
import logger from '../logging/logger.js';
import { ADMIN, IT_ADMIN, SUPER_ADMIN, SYSTEM_ADMIN } from '../utils/roles.js';

const MONITORING_TOKEN_ENVS = [
  'MONITORING_TOKEN',
  'METRICS_TOKEN',
  'INTERNAL_MONITORING_TOKEN',
];

const MONITORING_TOKEN_HEADERS = [
  'x-monitoring-token',
  'x-internal-monitoring-token',
];

// CAN-054: the DB-free static downtime mirror (/downtime/static) serves PHI
// ward packs during an outage. It was gated by the SAME monitoring token as
// /metrics and /health/deep, so a single leaked metrics/scrape token would also
// unlock patient ward packs. These envs let an operator provision a DEDICATED,
// separately-rotated downtime token whose blast radius is the ward packs alone.
const DOWNTIME_TOKEN_ENVS = [
  'DOWNTIME_ACCESS_TOKEN',
  'DOWNTIME_PACK_TOKEN',
];

// Accept the dedicated token over its own header as well as the shared
// monitoring headers / Bearer transport, so existing outage tooling that only
// knows how to send `x-monitoring-token` / `Authorization: Bearer` still works
// once it is handed the new credential.
const DOWNTIME_TOKEN_HEADERS = [
  'x-downtime-token',
  ...MONITORING_TOKEN_HEADERS,
];

const INFRASTRUCTURE_ADMIN_ROLES = [
  ADMIN,
  SUPER_ADMIN,
  IT_ADMIN,
  SYSTEM_ADMIN,
];

export function isProductionRuntime(env = process.env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

function splitTokens(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function configuredMonitoringTokens(env = process.env) {
  return MONITORING_TOKEN_ENVS.flatMap((name) => splitTokens(env[name]));
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readHeader(req, header) {
  return typeof req.get === 'function' ? req.get(header) : req.headers?.[header];
}

// Extract a bearer-style token from a request, trying the supplied headers in
// order and then `Authorization: Bearer <token>`. Used for both the monitoring
// token and the dedicated downtime token (different header sets, same transport
// rationale: a Prometheus ServiceMonitor / outage tool can only send standard
// auth headers, so the Bearer fallback widens the transport, not the trust).
function tokenFromHeaders(req, headers) {
  for (const header of headers) {
    const value = readHeader(req, header);
    if (value) return String(value);
  }
  const auth = readHeader(req, 'authorization');
  if (auth) {
    const m = /^Bearer[ \t]+(.+)$/i.exec(String(auth).trim());
    if (m) return m[1].trim();
  }
  return null;
}

function requestMonitoringToken(req) {
  return tokenFromHeaders(req, MONITORING_TOKEN_HEADERS);
}

function configuredDowntimeTokens(env = process.env) {
  return DOWNTIME_TOKEN_ENVS.flatMap((name) => splitTokens(env[name]));
}

export function hasValidDowntimeToken(req, env = process.env) {
  const expectedTokens = configuredDowntimeTokens(env);
  if (expectedTokens.length === 0) return false;
  const suppliedToken = tokenFromHeaders(req, DOWNTIME_TOKEN_HEADERS);
  if (!suppliedToken) return false;
  return expectedTokens.some((expected) => constantTimeEqual(suppliedToken, expected));
}

export function hasValidMonitoringToken(req, env = process.env) {
  const expectedTokens = configuredMonitoringTokens(env);
  const suppliedToken = requestMonitoringToken(req);
  if (!suppliedToken || expectedTokens.length === 0) return false;
  return expectedTokens.some((expected) => constantTimeEqual(suppliedToken, expected));
}

export function requireProductionMonitoringAccess(req, res, next) {
  // Audit 2026-06-18 §4 Observability: this gate was a no-op whenever
  // NODE_ENV !== 'production', leaving /health/deep (DB host/port) and
  // /downtime/static (PHI packs) reachable UNAUTHENTICATED in dev, staging,
  // QA, and any env where NODE_ENV wasn't literally 'production'. Now it
  // ALWAYS requires a valid monitoring token and fails CLOSED when no token
  // is configured (hasValidMonitoringToken returns false on empty config),
  // regardless of NODE_ENV. (Name kept for call-site stability.)
  if (hasValidMonitoringToken(req)) return next();

  logger.warn('Monitoring endpoint denied without a valid monitoring token', {
    path: req.originalUrl || req.url,
    method: req.method,
    ip: req.ip,
  });

  return res.status(401).json({
    success: false,
    error: 'Monitoring access token required',
    code: 'MONITORING_AUTH_REQUIRED',
  });
}

export function requireDowntimeAccess(req, res, next) {
  // CAN-054: the static downtime mirror serves PHI ward packs. Prefer a
  // DEDICATED downtime token so a leaked metrics/scrape token can NOT also pull
  // ward packs. Posture:
  //   * A dedicated downtime token IS configured  → ONLY it is accepted; the
  //     monitoring token no longer unlocks the packs (the separation we want).
  //   * No dedicated downtime token configured     → fall back to the monitoring
  //     token (backward-compatible) with a loud warning, so outage packs stay
  //     reachable until the operator provisions DOWNTIME_ACCESS_TOKEN. This is
  //     an OUTAGE-CRITICAL, DB-free route — failing closed here on an unset
  //     token would make ward packs unreachable during the very incident they
  //     exist for, so the migration is opt-in rather than a hard cutover.
  if (configuredDowntimeTokens().length > 0) {
    if (hasValidDowntimeToken(req)) return next();

    logger.warn('Downtime pack denied without a valid dedicated downtime token', {
      path: req.originalUrl || req.url,
      method: req.method,
      ip: req.ip,
    });

    return res.status(401).json({
      success: false,
      error: 'Downtime access token required',
      code: 'DOWNTIME_AUTH_REQUIRED',
    });
  }

  logger.warn(
    'DOWNTIME_ACCESS_TOKEN is not configured — downtime packs are falling back '
      + 'to the shared monitoring token. Provision a dedicated downtime token to '
      + 'separate ward-pack PHI access from metrics/scrape access (CAN-054).',
  );
  return requireProductionMonitoringAccess(req, res, next);
}

export function requireProductionInfrastructureAdmin(req, res, next) {
  if (!isProductionRuntime()) return next();

  return jwtAuth(req, res, (authErr) => {
    if (authErr) return next(authErr);
    return rbac(INFRASTRUCTURE_ADMIN_ROLES)(req, res, next);
  });
}
