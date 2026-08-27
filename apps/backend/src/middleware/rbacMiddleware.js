// src/middleware/rbacMiddleware.js
import { hasRole, normalizeRole, SUPER_ADMIN } from '../utils/roles.js';
import { logSecurityEvent } from '../utils/securityAuditLogger.js';

/**
 * RBAC Enforcement Middleware (factory)
 * Usage:
 *   app.use('/api/v1/admin', jwtAuth, requireRole('ADMIN', 'SUPER_ADMIN'), router)
 *   app.use('/ops', jwtAuth, requireAnyRole('ADMIN', 'OPS'), router)
 *
 * @param {string[]|string} allowedRoles
 * @returns {import('express').RequestHandler}
 */
export default function rbacMiddleware(allowedRoles = []) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    try {
      // Not authenticated
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      // Narrow-scope tokens (e.g. mfa_setup) must never satisfy role-gated
      // routes — their only legitimate uses are the first-time-enrollment
      // endpoints gated by `requireSetupScope`.
      if (req.user.scope && req.user.scope !== 'full') {
        logSecurityEvent('INSUFFICIENT_SCOPE', {
          userId: req.user.uid || req.user.id,
          userRole: req.user.role,
          ip: req.ip,
          userAgent: req.headers?.['user-agent'],
          path: req.originalUrl,
          method: req.method,
          reason: `Scope '${req.user.scope}' cannot access role-gated route`,
        });
        return res.status(403).json({
          success: false,
          error: 'Insufficient token scope',
          code: 'INSUFFICIENT_SCOPE',
        });
      }

      // No restriction applied -> allow
      if (roles.length === 0) return next();

      const userRole = normalizeRole(req.user.role);
      const rawUserRole = normalizeRole(req.user.rawRole);

      // SUPER_ADMIN bypass (also handled by hasRole, but explicit here for clarity).
      // NOTE: this is an UN-SCOPED master-key bypass — a SUPER_ADMIN satisfies any
      // requireRole() gate. Sensitive control planes (admin/system) must additionally
      // mount `requireSuperAdminStepUp` so that the bypass on those namespaces is only
      // granted to a 2FA-verified session (audit 2026-06-18 — SUPER_ADMIN un-scoped bypass).
      if (userRole === SUPER_ADMIN || rawUserRole === SUPER_ADMIN) return next();

      // Check role membership (case-insensitive)
      if (!hasRole(userRole, roles) && !hasRole(rawUserRole, roles)) {
        logSecurityEvent('PERMISSION_DENIED', {
          userId: req.user.uid || req.user.id,
          userName: req.user.email || req.user.phone,
          userRole,
          tenantId: req.tenantId
            || req.apiClientTenantId
            || req.user.tenant_id
            || req.user.tenantId
            || req.tenant?.id
            || null,
          ip: req.ip,
          userAgent: req.headers?.['user-agent'],
          path: req.originalUrl,
          method: req.method,
          reason: `Role '${userRole}' not in allowed roles: [${roles.join(', ')}]`,
        });
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/** Require one or more roles (variadic) */
export const requireRole = (...roles) => rbacMiddleware(roles);

/** Alias: require any of the provided roles */
export const requireAnyRole = (...roles) => rbacMiddleware(roles);

/**
 * Step-up gate for SUPER_ADMIN on sensitive namespaces (audit 2026-06-18 —
 * "SUPER_ADMIN un-scoped bypass" HIGH).
 *
 * `requireRole(...)` grants SUPER_ADMIN an un-scoped bypass of every role gate.
 * That is intentional for routine administration, but it means a single
 * compromised/over-broad super-admin token can act on the most sensitive
 * control planes (admin dashboards, system config, role/user management) with
 * no second factor. Mount this AFTER `requireRole(...)` on those namespaces:
 * the SUPER_ADMIN bypass is then only honoured for a session that completed the
 * admin 2FA challenge (the token carries `mfa: true`, surfaced onto
 * `req.user.mfa` by jwtMiddleware). Non-super users are unaffected — they have
 * already satisfied the upstream role check.
 *
 * Recovery / rollout: a super-admin without an `mfa` claim re-authenticates via
 * the admin 2FA challenge (`POST /api/v1/auth/admin/mfa/challenge/verify`),
 * which is mounted outside the guarded namespaces. Super-admins must therefore
 * have TOTP enrolled — see docs/GO_LIVE_ACTIVATION_CHECKLIST.md.
 *
 * @type {import('express').RequestHandler}
 */
export const requireSuperAdminStepUp = (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const isSuperAdmin =
      normalizeRole(req.user.role) === SUPER_ADMIN ||
      normalizeRole(req.user.rawRole) === SUPER_ADMIN;

    // Non-super users were already gated by the upstream requireRole(...) — pass through.
    if (!isSuperAdmin) return next();

    // SUPER_ADMIN must present a 2FA-verified session. Only an explicit boolean
    // true counts (never a coerced/forged value).
    if (req.user.mfa === true) return next();

    logSecurityEvent('SUPER_ADMIN_STEP_UP_REQUIRED', {
      userId: req.user.uid || req.user.id,
      userRole: req.user.rawRole || req.user.role,
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
      path: req.originalUrl,
      method: req.method,
      reason: 'SUPER_ADMIN accessed a sensitive namespace without a 2FA-verified (step-up) session',
    });
    return res.status(403).json({
      success: false,
      error: 'This sensitive operation requires a 2FA-verified super-admin session. Re-authenticate via the admin MFA challenge and retry.',
      code: 'SUPER_ADMIN_MFA_REQUIRED',
    });
  } catch (err) {
    return next(err);
  }
};
