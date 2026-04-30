// Unit tests for the Phase 0 route + RBAC split.
//
// What this covers:
//   * requireClinicalAiUse middleware (the inner gate at the clinical
//     plane router) — accepts clinical roles + ADMIN/SUPER_ADMIN, rejects
//     unauthenticated, rejects non-clinical roles.
//   * requireClinicalAiControl middleware (unchanged from before; tested
//     here for symmetry so the two stay in lockstep).
//   * The CLINICAL_AI_USER_ROLES_LIST constant — every role in any module's
//     reviewRoles[] must be on the allowlist (catches drift between module
//     config and the route guard).
//
// Express-level mount tests (does /api/v1/clinical-ai/clinical/* actually
// route to the clinician router?) need supertest + the full app + DB and
// live in the integration suite. Those run in CI when Postgres is up; we
// don't duplicate them here.

import { jest } from '@jest/globals';
import {
  CLINICAL_AI_USER_ROLES_LIST,
  normalizeRole,
  requireClinicalAiControl,
  requireClinicalAiUse,
} from '../../routes/admin/clinicalAi/shared.js';
import { CLINICAL_AI_MODULES } from '../../services/ai/clinicalAiModuleService.js';

function makeMocks(role) {
  // role === null encodes "no user attached at all" (tests the 401 path).
  // role === '' encodes "user attached but role is blank" (tests the
  // 403 path with a falsy-but-present role).
  const req = role === null ? { user: null } : { user: { role } };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

function statusOf(res) {
  return res.status.mock.calls[0]?.[0] ?? null;
}

describe('requireClinicalAiUse', () => {
  it('rejects 401 when no user is attached to the request', () => {
    const { req, res, next } = makeMocks(null);
    requireClinicalAiUse(req, res, next);
    expect(statusOf(res)).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(CLINICAL_AI_USER_ROLES_LIST)('admits clinical role: %s', (role) => {
    const { req, res, next } = makeMocks(role);
    requireClinicalAiUse(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // Rejection list focuses on the roles that absolutely should NOT touch
  // clinical AI — patients, courier/delivery staff, and unknown / blank
  // role strings. IT_ADMIN / IT / IT_STAFF / SYSTEM_ADMIN are NOT on this
  // list because some modules (AI lifecycle, dataset labeling, federation
  // coordinator) legitimately have them as reviewers. The real filtering
  // happens at the per-module reviewRoles inside the service layer.
  it.each([
    'PATIENT',
    'DELIVERY_STAFF',
    'UNKNOWN_ROLE',
    'WRONG_ROLE',
    '',
  ])('rejects 403 for non-clinical role: %s', (role) => {
    const { req, res, next } = makeMocks(role);
    requireClinicalAiUse(req, res, next);
    expect(statusOf(res)).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('normalizes lowercase role input before checking', () => {
    const { req, res, next } = makeMocks('doctor');
    requireClinicalAiUse(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireClinicalAiControl (unchanged; tested for symmetry)', () => {
  it.each(['ADMIN', 'SUPER_ADMIN', 'IT', 'IT_ADMIN', 'IT_STAFF', 'SYSTEM_ADMIN'])(
    'admits control role: %s',
    (role) => {
      const { req, res, next } = makeMocks(role);
      requireClinicalAiControl(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'PATIENT'])(
    'rejects 403 for clinical-only role: %s',
    (role) => {
      const { req, res, next } = makeMocks(role);
      requireClinicalAiControl(req, res, next);
      expect(statusOf(res)).toBe(403);
      expect(next).not.toHaveBeenCalled();
    }
  );

  it('rejects 401 when unauthenticated', () => {
    const { req, res, next } = makeMocks(null);
    requireClinicalAiControl(req, res, next);
    expect(statusOf(res)).toBe(401);
  });
});

describe('control + clinical role sets are appropriately disjoint', () => {
  // Pure clinical roles must NOT be control-plane (otherwise a doctor
  // could quietly hit governance endpoints).
  it('DOCTOR is clinical-only, not control', () => {
    const { req, res, next } = makeMocks('DOCTOR');
    requireClinicalAiControl(req, res, next);
    expect(statusOf(res)).toBe(403);
  });

  // PATIENT must NOT be on the clinical-use allowlist — the only
  // user-facing role that should never touch clinical AI endpoints.
  it('PATIENT is rejected from clinical-use', () => {
    const { req, res, next } = makeMocks('PATIENT');
    requireClinicalAiUse(req, res, next);
    expect(statusOf(res)).toBe(403);
  });

  // Symmetric check: PATIENT must also not be on the control-plane
  // allowlist — so a misconfigured token can't even pass the looser
  // gate.
  it('PATIENT is rejected from control-plane', () => {
    const { req, res, next } = makeMocks('PATIENT');
    requireClinicalAiControl(req, res, next);
    expect(statusOf(res)).toBe(403);
  });

  // ADMIN and SUPER_ADMIN appear on BOTH lists by design — admins are
  // legit reviewers for several modules (blood bank, obstetric, etc.)
  // and SUPER_ADMIN is a system-wide override.
  it.each(['ADMIN', 'SUPER_ADMIN'])('%s appears on both lists by design', (role) => {
    const ctrl = makeMocks(role);
    const use = makeMocks(role);
    requireClinicalAiControl(ctrl.req, ctrl.res, ctrl.next);
    requireClinicalAiUse(use.req, use.res, use.next);
    expect(ctrl.next).toHaveBeenCalled();
    expect(use.next).toHaveBeenCalled();
  });
});

describe('CLINICAL_AI_USER_ROLES_LIST drift guard', () => {
  // Every role mentioned in any module.settings.reviewRoles[] must also
  // be on the route allowlist — otherwise the per-module review check
  // is unreachable because the route would 403 first. This catches the
  // class of bug where someone adds a new module with a new reviewer
  // role and forgets to update the route guard.
  it('every reviewRole across all modules is on the user-roles allowlist', () => {
    const allowlist = new Set(CLINICAL_AI_USER_ROLES_LIST.map(normalizeRole));
    const reviewRoles = new Set();
    for (const module of CLINICAL_AI_MODULES) {
      const roles = module.settings?.reviewRoles || [];
      for (const role of roles) reviewRoles.add(normalizeRole(role));
    }

    const missing = [...reviewRoles].filter((role) => !allowlist.has(role));
    if (missing.length) {
      throw new Error(
        `Module reviewRoles include role(s) NOT on CLINICAL_AI_USER_ROLES_LIST: ${missing.join(', ')}. ` +
          `Add them to apps/backend/src/routes/admin/clinicalAi/shared.js or remove from the module config.`
      );
    }
    expect(missing).toEqual([]);
  });
});
