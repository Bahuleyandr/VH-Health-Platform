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

function requestMonitoringToken(req) {
  for (const header of MONITORING_TOKEN_HEADERS) {
    const value = typeof req.get === 'function' ? req.get(header) : req.headers?.[header];
    if (value) return String(value);
  }
  return null;
}

export function hasValidMonitoringToken(req, env = process.env) {
  const expectedTokens = configuredMonitoringTokens(env);
  const suppliedToken = requestMonitoringToken(req);
  if (!suppliedToken || expectedTokens.length === 0) return false;
  return expectedTokens.some((expected) => constantTimeEqual(suppliedToken, expected));
}

export function requireProductionMonitoringAccess(req, res, next) {
  if (!isProductionRuntime()) return next();

  if (hasValidMonitoringToken(req)) return next();

  logger.warn('Production monitoring endpoint denied without a valid monitoring token', {
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

export function requireProductionInfrastructureAdmin(req, res, next) {
  if (!isProductionRuntime()) return next();

  return jwtAuth(req, res, (authErr) => {
    if (authErr) return next(authErr);
    return rbac(INFRASTRUCTURE_ADMIN_ROLES)(req, res, next);
  });
}
