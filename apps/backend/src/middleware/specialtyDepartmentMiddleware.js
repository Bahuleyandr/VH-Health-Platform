// src/middleware/specialtyDepartmentMiddleware.js
//
// Department-based gate for the specialty clinical modules (dental, oncology,
// radiation-oncology, ophthalmology, transplant).
//
// WHY: those mounts are role-gated on the broad clinical-staff group, so 25
// roles — every doctor of every specialty, pharmacy staff, OT nurses,
// admission officers, medical records — could read specialty PHI, and every
// doctor saw all five tiles (2026-08-22 audit, owner-approved direction:
// gate by department, enforced server-side).
//
// WHY NOT A ROLE: the platform has no DENTIST/ONCOLOGIST role, and inventing
// one per specialty would ripple through auth config, seeds and both apps.
// Department is per-USER data that already exists.
//
// DATA REALITY (the reason for the report-first rollout): staff.department is
// free text mixing clinical specialties with operational units, and clinical
// deployments may not yet stamp specialists with a matching department — a
// naive fail-closed gate would make a module unreachable for everyone. So:
//
//   SPECIALTY_DEPARTMENT_GATE_MODE = 'off' | 'report' (default) | 'enforce'
//
// 'report' logs a SPECIALTY_DEPARTMENT_MISMATCH security event for every
// request that WOULD be denied and lets it through — giving the operator a
// ledger of who would lose access before anyone does. Flipping to 'enforce'
// is an explicit operator action, in keeping with the platform's other
// shadow→enforce rollouts (care-team oracle, money ledger).
//
// The mode is read per REQUEST so tests and operators never need a restart.

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { error } from '../utils/responseHelper.js';
import { logSecurityEvent } from '../utils/securityAuditLogger.js';
import { normalizeRole } from '../utils/roles.js';
import {
  SPECIALTY_DEPARTMENT_ALIASES,
  SPECIALTY_GATE_BYPASS_ROLES,
  specialtyGateMode,
  normalizeDepartment,
  departmentsMatchSpecialty,
} from '../config/specialtyDepartmentPolicy.js';

// The alias map, bypass roles, and normalization live in the dependency-free
// config/specialtyDepartmentPolicy.js (single declaration shared with the
// staff-app contract generator, which runs where @prisma/client is not
// installed). Re-exported here so existing consumers keep one import site.
export {
  SPECIALTY_DEPARTMENT_ALIASES,
  SPECIALTY_GATE_BYPASS_ROLES,
  specialtyGateMode,
  normalizeDepartment,
  departmentsMatchSpecialty,
};

// Collect every department signal the platform holds for this caller:
// the normalized doctor-record link, the doctor free-text column, and the
// staff free-text column. Any match admits.
async function resolveCallerDepartments({ userId, userUid }) {
  const departments = new Set();
  const id = Number.parseInt(String(userId ?? ''), 10);

  if (Number.isInteger(id) && id > 0) {
    const doctorRows = await prisma.$queryRawUnsafe(
      `SELECT dep.name AS linked_department, d.department AS text_department
         FROM doctors d
         LEFT JOIN departments dep ON dep.id = d.department_id
        WHERE d.user_id = $1::int`,
      id,
    );
    for (const row of doctorRows) {
      if (row.linked_department) departments.add(normalizeDepartment(row.linked_department));
      if (row.text_department) departments.add(normalizeDepartment(row.text_department));
    }

    // staff.user_id is a UUID linking users.uid (doctors.user_id is the INT
    // users.id — the two tables use different link conventions).
    const staffRows = await prisma.$queryRawUnsafe(
      `SELECT s.department
         FROM staff s
         JOIN users u ON s.user_id = u.uid
        WHERE u.id = $1::int`,
      id,
    );
    for (const row of staffRows) {
      if (row.department) departments.add(normalizeDepartment(row.department));
    }
  } else if (userUid) {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT department FROM staff WHERE user_id = $1::uuid',
      String(userUid),
    );
    for (const row of rows) {
      if (row.department) departments.add(normalizeDepartment(row.department));
    }
  }

  departments.delete('');
  return departments;
}

/**
 * Gate a specialty mount by the caller's department.
 * Mount AFTER requireRole (identity + coarse role are already settled).
 */
export function specialtyDepartmentGuard(specialtyKey, { resolveDepartments = resolveCallerDepartments } = {}) {
  if (!SPECIALTY_DEPARTMENT_ALIASES[specialtyKey]) {
    throw new Error(`Unknown specialty key for department gate: ${specialtyKey}`);
  }

  return async function specialtyDepartmentGuardMiddleware(req, res, next) {
    const mode = specialtyGateMode();
    if (mode === 'off') return next();

    const role = normalizeRole(req.user?.role);
    const rawRole = normalizeRole(req.user?.rawRole);
    if (SPECIALTY_GATE_BYPASS_ROLES.has(role) || SPECIALTY_GATE_BYPASS_ROLES.has(rawRole)) {
      return next();
    }

    let matched = false;
    let resolvedCount = 0;
    try {
      const departments = await resolveDepartments({
        userId: req.user?.id,
        userUid: req.user?.uid,
      });
      resolvedCount = departments.size;
      matched = departmentsMatchSpecialty(departments, specialtyKey);
    } catch (err) {
      if (mode === 'enforce') {
        logger.error('Specialty department gate failed to resolve caller departments', {
          specialty: specialtyKey,
          error: err.message,
        });
        return error(res, 'Specialty access check failed', 500);
      }
      // Shadow mode never breaks traffic on a resolution error — it reports.
      logger.warn('Specialty department gate (report mode) resolution error', {
        specialty: specialtyKey,
        error: err.message,
      });
      return next();
    }

    if (matched) return next();

    logSecurityEvent('SPECIALTY_DEPARTMENT_MISMATCH', {
      userId: req.user?.uid || req.user?.id,
      userRole: role,
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
      reason: `Caller has no ${specialtyKey} department (${resolvedCount} department signal(s) resolved; mode=${mode})`,
    });

    if (mode === 'enforce') {
      return error(res, 'Access to this specialty module is restricted to its department', 403, {
        topLevel: { code: 'SPECIALTY_DEPARTMENT_REQUIRED', specialty: specialtyKey },
      });
    }
    return next();
  };
}
