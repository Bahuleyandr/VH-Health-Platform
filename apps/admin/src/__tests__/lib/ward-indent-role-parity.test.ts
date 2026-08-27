// Ward-indent worklist role parity (backend PR #935).
//
// The nav entry and the route policy for /dashboard/ward-indents must carry
// the SAME explicit allowlist, and that allowlist must equal the backend's
// effective read gate for the worklist's API surface:
//
//   READ_ROLES = IP_FLOW_ROUTE_ROLES ∪ PHARMACY_ROUTE_ROLES     (route level,
//     apps/backend/src/routes/pharmacy/wardIndentRoutes.js)
//   ∩ PHARMACY_ORDER_ROUTE_ROLES                                 (mount gate,
//     app.js `/api/v1/pharmacy-orders`)
//   ∩ PORTAL_ROLE_VALUES                                         (PATIENT is in
//     the mount gate but must never hold a portal session)
//
// The expected list below is that derivation, evaluated against the backend
// role-policy graph on 2026-08-27. If the backend widens or narrows the
// ward-indent read surface, re-derive and update BOTH routePolicy.ts and this
// pin together.

import { NAV_ITEMS } from "@/lib/navConfig";
import {
  policyForPath,
  roleSatisfiesPolicy,
  WARD_INDENT_ROLES,
} from "@/lib/routePolicy";
import { normalizePortalRole } from "@/lib/roles";

const EXPECTED_BACKEND_READ_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "PHARMACY_STAFF",
  "PHARMACY_INCHARGE",
  "PHARMACIST",
  "DOCTOR",
  "DUTY_DOCTOR",
  "CONSULTANT",
  "JUNIOR_DOCTOR",
  "RESIDENT",
  "SENIOR_DOCTOR",
  "NURSING_STAFF",
  "NURSING_INCHARGE",
  "IP_STAFF_NURSE",
  "IP_INCHARGE",
  "ICU_NURSE",
  "ICU_INCHARGE",
  "ICU_STAFF",
  "ADMISSION_OFFICER",
  "IPD_COUNSELLOR",
];

describe("ward-indent worklist role parity", () => {
  const item = NAV_ITEMS.find((i) => i.href === "/dashboard/ward-indents");
  const policy = policyForPath("/dashboard/ward-indents");

  it("nav and route policy share the same explicit allowlist", () => {
    expect(item).toBeDefined();
    expect(policy).not.toBeNull();
    expect(item!.allowedRoles).toBe(WARD_INDENT_ROLES);
    expect(policy!.roles).toBe(WARD_INDENT_ROLES);
  });

  it("the allowlist equals the backend's effective read gate", () => {
    expect([...WARD_INDENT_ROLES].sort()).toEqual(
      [...EXPECTED_BACKEND_READ_ROLES].sort(),
    );
  });

  it("every allowed role is a real portal role", () => {
    for (const role of WARD_INDENT_ROLES) {
      expect(normalizePortalRole(role)).toBe(role);
    }
    // PATIENT sits in the backend mount gate but must never see the portal.
    expect(WARD_INDENT_ROLES).not.toContain("PATIENT");
  });

  it("allowed roles pass the middleware and excluded ward roles do not", () => {
    for (const role of WARD_INDENT_ROLES) {
      expect(roleSatisfiesPolicy(role, policy!)).toBe(true);
    }
    // ER_STAFF is a ward-receipt role on the /ipd alias but is NOT admitted by
    // the /api/v1/pharmacy-orders mount this page calls; LAB_STAFF and
    // HOUSEKEEPING_STAFF are ordinary STAFF-rank roles outside the surface.
    for (const role of ["ER_STAFF", "LAB_STAFF", "HOUSEKEEPING_STAFF"]) {
      expect(roleSatisfiesPolicy(role, policy!)).toBe(false);
    }
  });
});
