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

// Alias sets are matched against BOTH the doctor-record department (normalized
// via doctors.department_id -> departments.name — the reliable path) and the
// free-text staff.department / doctors.department columns. Everything is
// compared lowercased with punctuation collapsed.
//
// Transplant has no department of its own; the owner-approved interim mapping
// is the renal/surgical services that run the programme. Adjust here — this
// map is the single source of truth.
export const SPECIALTY_DEPARTMENT_ALIASES = {
  dental: ['dentistry', 'dental'],
  oncology: ['oncology', 'medical oncology', 'clinical oncology'],
  radiation_oncology: ['oncology', 'radiation oncology', 'radiotherapy'],
  ophthalmology: ['ophthalmology'],
  transplant: ['nephrology', 'general surgery', 'urology', 'transplant'],
};

// Leadership/administrative bypass: these roles supervise every specialty.
// Without it, enforce mode would lock the CMO out of every specialty module.
export const SPECIALTY_GATE_BYPASS_ROLES = new Set([
  'SUPER_ADMIN',
  'ADMIN',
  'CMO',
  'CNO',
  'MEDICAL_SUPERINTENDENT',
]);

export function specialtyGateMode(env = process.env) {
  const raw = String(env.SPECIALTY_DEPARTMENT_GATE_MODE || 'report').trim().toLowerCase();
  return ['off', 'report', 'enforce'].includes(raw) ? raw : 'report';
}

export function normalizeDepartment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function departmentsMatchSpecialty(departments, specialtyKey) {
  const aliases = SPECIALTY_DEPARTMENT_ALIASES[specialtyKey] || [];
  const normalizedAliases = new Set(aliases.map(normalizeDepartment));
  return [...departments].some((dept) => normalizedAliases.has(dept));
}

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
