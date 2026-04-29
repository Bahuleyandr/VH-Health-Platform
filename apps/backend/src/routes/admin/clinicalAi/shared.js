import { error } from '../../../utils/responseHelper.js';

const CLINICAL_AI_CONTROL_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'IT',
  'IT_ADMIN',
  'IT_STAFF',
  'SYSTEM_ADMIN',
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

export function requireClinicalAiControl(req, res, next) {
  if (!req.user) {
    return error(res, 'Authentication required', 401, { safe: true });
  }

  const role = normalizeRole(req.user.role);
  if (!CLINICAL_AI_CONTROL_ROLES.has(role)) {
    return error(res, 'Clinical AI controls require Admin or IT privileges', 403, {
      safe: true,
    });
  }

  return next();
}

export function uuidOrNull(value) {
  const text = String(value || '').trim();
  return UUID_RE.test(text) ? text : null;
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).trim();
  }
  return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || null;
}

export function parseClinicalAiWindowDays(value, fallback = 7) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), 90);
}
