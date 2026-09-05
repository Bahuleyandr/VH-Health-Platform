// src/middleware/routePatientAccessGuards.js
//
// Re-audit M (mount-guard defect class): app.js used to wrap whole routers in
// patientAccessGuard(...) at the MOUNT. A mount-level middleware runs before
// Express matches the route, so req.params is empty there; when a router
// carries the patient only in a path param, resolvePatientForAccess finds
// nothing and authorizePatientAccessRequest returns no_patient_context WITHOUT
// evaluating a policy — in shadow AND in enforce. Those guards never decided
// anything.
//
// Nothing else on those chains covers for it: requireRole/requireStaffOrAdmin
// are role-scoped, specialtyDepartmentGuard is department-scoped, and
// phiAccessLogger is a passive writer. A patient-access decision is its own
// axis, and on a mount-undecidable route it simply never ran.
//
// POSTURE — routePatientGuard sets careTeamModeGoverned, so a guard built
// here resolves to the per-tenant care_team_enforcement_mode, default SHADOW.
// It blocks nobody today; it records what a future enforce decision would
// need. Do NOT swap one for a bare patientAccessGuard without that option —
// that is a legacy always-ENFORCE site and would change behaviour on merge.
//
// The fix (same shape as routes/clinical/bcmaRoutes.js#guardWristbandView and
// routes/abdm/abdmHiuRoutes.js selector factories): move the guard INTO the
// router, per route, with an async patientSelector that resolves THE ROW THE
// HANDLER IS ABOUT TO SERVE, tenant-scoped. This module is the tiny shared
// toolkit those routers use; the concrete selectors stay inline in each router
// next to the routes they protect.
//
// Contract for every selector built with these helpers:
//   * It resolves the patient from the SAME identifier the handler uses.
//     resolvePatientForAccess consults req.phiContext FIRST and earlier guards
//     write it unconditionally, so a guard without an explicit selector can
//     authorise patient B while the handler serves patient A. An explicit
//     selector makes the decision, the audit row and the disclosure the same
//     patient by construction.
//   * It never throws on malformed input — a bad id returns null and the
//     guard refuses cleanly via requirePatientContext (enforce) or records the
//     unresolved attempt (shadow). A genuine DB failure still propagates so
//     the guard fails closed (500), which is the engine's existing contract.
//   * It carries an explicit tenant predicate in its own SQL (or defers to
//     resolvePatientForAccess's tenant-scoped users lookup for body-supplied
//     patient uids).

import { patientAccessGuard } from './phiAccessMiddleware.js';
import { resolveTenantOrThrow } from '../services/tenant/tenantService.js';

// Postgres int4 / int8 upper bounds — same rationale as
// accessDecisionService#cleanInt/cleanBigInt: an out-of-range value (e.g. a
// phone parsed as an id) must become null, never a 22003 from the bind.
export const PG_INT4_MAX = 2147483647;
export const PG_INT8_MAX = 9223372036854775807n;

/**
 * Tenant for a selector query — identical resolution to the handlers' own
 * tenantOf(req) (resolveTenantOrThrow, including the single-tenant default
 * fallback), except it returns null instead of throwing so a selector can
 * never 500 a request on its own. With no tenant the selector yields no
 * patient and the guard refuses/records; the handler's own tenantOf() then
 * raises the canonical TENANT_CONTEXT_REQUIRED where the request proceeds.
 */
export function selectorTenantOf(req) {
  try {
    return resolveTenantOrThrow(req);
  } catch {
    return null;
  }
}

/** Positive int4 or null — never throws, never lets an overflow reach `::int`. */
export function positiveIntOrNull(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= PG_INT4_MAX ? parsed : null;
}

/**
 * Positive int8 as its canonical digit string (binds safely to `::bigint`),
 * or null — never throws.
 */
export function positiveBigIntTextOrNull(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  let parsed;
  try {
    parsed = BigInt(text);
  } catch {
    return null;
  }
  return parsed > 0n && parsed <= PG_INT8_MAX ? text : null;
}

/**
 * A per-route patient access guard that preserves the mount's governance
 * semantics exactly: same record type, careTeamModeGoverned: true (the
 * per-tenant care_team_enforcement_mode flag governs, default shadow), no
 * policyCode override (policyCodeForRecordType supplies the same family
 * policy the mount resolved). requirePatientContext is on because every
 * route that gets one of these serves a single patient subject.
 *
 * `tag` is introspection-only (unit tests assert each route carries the
 * intended selector binding); it has no runtime effect.
 */
export function routePatientGuard(recordType, { tag, patientSelector }) {
  const guard = patientAccessGuard(recordType, {
    careTeamModeGoverned: true,
    requirePatientContext: true,
    patientSelector,
  });
  guard.patientGuardTag = tag ?? null;
  guard.patientGuardRecordType = recordType;
  return guard;
}
