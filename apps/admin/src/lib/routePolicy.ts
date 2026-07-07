// src/lib/routePolicy.ts
//
// DEFAULT-DENY route → role policy for the admin portal (audit finding
// H6/M8, 2026-06-10). The old middleware was an ALLOWLIST covering ~15 of
// ~95 routes; every unlisted page — including /dashboard/patients,
// /dashboard/database (live DB browser), /dashboard/tenants, /feature-flags,
// /audit-explorer, /system-logs — was open to ANY authenticated role.
//
// Model:
//   - Every first path segment under /dashboard MUST have an entry here.
//     A segment with no entry is DENIED (redirect to /dashboard) — new pages
//     fail closed until a policy is added.
//   - `minRank` is the minimum ROLE_RANK (see below). `roles` (optional)
//     is an explicit allowlist that REPLACES the rank check (used for the
//     clinical-AI control plane). SUPER_ADMIN always passes.
//   - Sub-path overrides (e.g. "patients/dedupe") win over the segment
//     entry when the pathname starts with them.
//   - src/__tests__/security/route-policy-coverage.test.ts FAILS THE BUILD
//     when a page.tsx exists without a policy entry — this is what prevents
//     H6-class regressions permanently.
//
// NOTE: middleware gating is the portal's first gate, not the load-bearing
// control — the backend enforces roles per-endpoint (verified for
// /api/v1/admin/* [ADMIN_ROUTE_ROLES at mount], /api/v1/users [admin
// sub-routes wrapped with ADMIN], /api/v1/records [RECORD_ROUTE_ROLES +
// patientAccessGuard]). Keep both in sync.

export const ROLE_RANK: Record<string, number> = {
  // Rank 0 — operational staff (portal self-service + clinical boards)
  STAFF: 0,
  GENERAL_STAFF: 0,
  NURSING_STAFF: 0,
  NURSING_INCHARGE: 0,
  OP_STAFF_NURSE: 0,
  OP_INCHARGE: 0,
  IP_STAFF_NURSE: 0,
  IP_INCHARGE: 0,
  ICU_NURSE: 0,
  ICU_INCHARGE: 0,
  ICU_STAFF: 0,
  ER_STAFF: 0,
  OT_NURSE: 0,
  OT_INCHARGE: 0,
  OT_STAFF: 0,
  CATH_LAB_STAFF: 0,
  CATH_LAB_INCHARGE: 0,
  PHARMACY_STAFF: 0,
  PHARMACY_INCHARGE: 0,
  PHARMACIST: 0,
  STORES_PURCHASE_INCHARGE: 0,
  LAB_STAFF: 0,
  LAB_INCHARGE: 0,
  LAB_TECHNICIAN: 0,
  TECHNICIAN: 0,
  PATHOLOGIST: 0,
  RADIOLOGIST: 0,
  RADIOLOGY_STAFF: 0,
  BLOOD_BANK_STAFF: 0,
  BLOOD_BANK_TECHNICIAN: 0,
  DIALYSIS_TECHNICIAN: 0,
  DIETITIAN: 0,
  DIETARY_STAFF: 0,
  HOUSEKEEPING_STAFF: 0,
  HOUSEKEEPING_INCHARGE: 0,
  RECEPTIONIST: 0,
  RECEPTION_INCHARGE: 0,
  ADMISSION_OFFICER: 0,
  IPD_COUNSELLOR: 0,
  BILLING_STAFF: 0,
  BILLING_INCHARGE: 0,
  FINANCE_INCHARGE: 0,
  INSURANCE_COORDINATOR: 0,
  CLAIMS_MANAGER: 0,
  MEDICAL_RECORDS: 0,
  DELIVERY_STAFF: 0,
  DRIVER: 0,
  SECURITY: 0,
  MAINTENANCE: 0,
  EMERGENCY_RESPONDER: 0,
  NURSE: 0,
  QUALITY_OFFICER: 0,
  INFECTION_CONTROL_OFFICER: 0,
  COMPLIANCE_OFFICER: 0,
  // Rank 1 — doctors + clinical leadership
  DOCTOR: 1,
  ANAESTHETIST: 1,
  ANESTHETIST: 1,
  DUTY_DOCTOR: 1,
  CONSULTANT: 1,
  SENIOR_DOCTOR: 1,
  JUNIOR_DOCTOR: 1,
  RESIDENT: 1,
  MEDICAL_SUPERINTENDENT: 1,
  CMO: 1,
  CNO: 1,
  // Rank 2 — HR
  HR: 2,
  HR_STAFF: 2,
  // Rank 3/4 — platform administration
  ADMIN: 3,
  SUPER_ADMIN: 4,
};

// Named rank levels (use these, not bare numbers, in the policy map).
export const ANY_AUTHENTICATED = -1; // any valid token, even unknown role
export const STAFF = 0;
export const CLINICAL_LEAD = 1;
export const HR_PLUS = 2;
export const ADMIN_ONLY = 3;
export const SUPER_ADMIN_ONLY = 4;

export const CLINICAL_AI_CONTROL_ROLES = [
  "ADMIN",
  "SUPER_ADMIN",
  "IT",
  "IT_ADMIN",
  "IT_STAFF",
  "SYSTEM_ADMIN",
];

export const ORDER_SET_STUDIO_ROLES = [
  "ADMIN",
  "SUPER_ADMIN",
  "DOCTOR",
  "DUTY_DOCTOR",
  "CONSULTANT",
  "JUNIOR_DOCTOR",
  "RESIDENT",
  "CMO",
  "MEDICAL_SUPERINTENDENT",
  "QUALITY_OFFICER",
  "PHARMACY_INCHARGE",
];

export interface RoutePolicy {
  /** Minimum ROLE_RANK value required (ignored when `roles` is set). */
  minRank?: number;
  /** Explicit role allowlist (replaces the rank check; SUPER_ADMIN always passes). */
  roles?: string[];
}

/**
 * Policy per first path segment under /dashboard. "" is the dashboard home.
 * Keys with "/" are sub-path overrides checked before the segment entry.
 */
export const ROUTE_POLICY: Record<string, RoutePolicy> = {
  // ── Home + universally available ──────────────────────────────────────────
  "": { minRank: ANY_AUTHENTICATED },
  appointments: { minRank: ANY_AUTHENTICATED },
  housekeeping: { minRank: ANY_AUTHENTICATED },
  sos: { minRank: ANY_AUTHENTICATED },
  notifications: { minRank: STAFF },

  // ── Staff self-service ("My Work") ────────────────────────────────────────
  "my-appointments": { minRank: STAFF },
  "my-attendance": { minRank: STAFF },
  "my-leave": { minRank: STAFF },
  "my-payslips": { minRank: STAFF },
  "my-replacements": { minRank: STAFF },
  "upload-prescription": { minRank: STAFF },
  shifts: { minRank: STAFF },

  // ── Clinical services (nurses + clinical staff + up) ─────────────────────
  radiology: { minRank: STAFF },
  pathology: { minRank: STAFF },
  lab: { minRank: STAFF },
  microbiology: { minRank: STAFF },
  "anesthesia-chart": { minRank: STAFF },
  dietary: { minRank: STAFF },
  theatre: { minRank: STAFF },
  "or-board": { minRank: STAFF },
  maternity: { minRank: STAFF },
  "blood-bank": { minRank: STAFF },
  quality: { minRank: STAFF },
  referral: { minRank: STAFF },
  productivity: { minRank: STAFF },
  "order-set-studio": { roles: ORDER_SET_STUDIO_ROLES },
  messaging: { minRank: STAFF },
  "discharge-summaries": { minRank: STAFF },
  "discharge-summary": { minRank: STAFF },
  "ed-tracker": { minRank: STAFF },
  mar: { minRank: STAFF },
  "nursing-assessments": { minRank: STAFF },
  beds: { minRank: STAFF },
  icu: { minRank: STAFF },
  oncology: { minRank: STAFF },
  "clinical-alerts": { minRank: STAFF },
  dialysis: { minRank: STAFF },
  immunisations: { minRank: STAFF },
  consent: { minRank: STAFF },
  devices: { minRank: STAFF },
  "death-certification": { minRank: CLINICAL_LEAD },

  // ── Clinical-AI control plane (explicit role allowlist) ──────────────────
  "clinical-ai": { roles: CLINICAL_AI_CONTROL_ROLES },

  // ── Leadership ────────────────────────────────────────────────────────────
  executive: { minRank: CLINICAL_LEAD },

  // ── HR management ─────────────────────────────────────────────────────────
  "leave-approvals": { minRank: HR_PLUS },
  grievances: { minRank: HR_PLUS },
  incidents: { minRank: HR_PLUS },
  "attendance-audit": { minRank: HR_PLUS },
  reporting: { minRank: HR_PLUS },
  investigations: { minRank: HR_PLUS },
  "staff-roster": { minRank: HR_PLUS },
  credentialing: { minRank: HR_PLUS },

  // ── Administration (ADMIN | SUPER_ADMIN) ──────────────────────────────────
  users: { minRank: ADMIN_ONLY },
  patients: { minRank: ADMIN_ONLY }, // covers /patients/dedupe too
  doctors: { minRank: ADMIN_ONLY },
  departments: { minRank: ADMIN_ONLY },
  "clinical-governance": { minRank: ADMIN_ONLY },
  payroll: { minRank: ADMIN_ONLY },
  analytics: { minRank: ADMIN_ONLY },
  operations: { minRank: ADMIN_ONLY },
  dashboards: { minRank: ADMIN_ONLY },
  insurance: { minRank: ADMIN_ONLY },
  pmjay: { minRank: ADMIN_ONLY },
  billing: { minRank: ADMIN_ONLY },
  pcpndt: { minRank: ADMIN_ONLY },
  bmw: { minRank: ADMIN_ONLY },
  "drug-returns": { minRank: ADMIN_ONLY },
  records: { minRank: ADMIN_ONLY },
  pharmacy: { minRank: ADMIN_ONLY },
  attendance: { minRank: ADMIN_ONLY },
  uploads: { minRank: ADMIN_ONLY },
  feedback: { minRank: ADMIN_ONLY },
  settings: { minRank: ADMIN_ONLY },
  "system-audit": { minRank: ADMIN_ONLY },
  audit: { minRank: ADMIN_ONLY },
  "audit-explorer": { minRank: ADMIN_ONLY },
  integrations: { minRank: ADMIN_ONLY },
  abdm: { minRank: ADMIN_ONLY },
  compliance: { minRank: ADMIN_ONLY },
  "system-logs": { minRank: ADMIN_ONLY },
  "report-builder": { minRank: ADMIN_ONLY },
  logs: { minRank: ADMIN_ONLY },
  database: { minRank: ADMIN_ONLY }, // live DB browser — admin only
  "admin-management": { minRank: ADMIN_ONLY },

  // ── Platform operations (SUPER_ADMIN only) ────────────────────────────────
  tenants: { minRank: SUPER_ADMIN_ONLY },
  "feature-flags": { minRank: SUPER_ADMIN_ONLY },
};

/**
 * Resolve the policy for a /dashboard pathname. Returns null when no entry
 * exists — the caller MUST treat null as DENY (default-deny).
 */
export function policyForPath(pathname: string): RoutePolicy | null {
  const rest = pathname.replace(/^\/dashboard\/?/, "");
  const segments = rest.split("/").filter(Boolean);

  // Sub-path overrides (longest match first), e.g. "patients/dedupe".
  for (let depth = Math.min(segments.length, 3); depth >= 2; depth--) {
    const key = segments.slice(0, depth).join("/");
    if (key in ROUTE_POLICY) return ROUTE_POLICY[key];
  }

  const segment = segments[0] ?? "";
  return segment in ROUTE_POLICY ? ROUTE_POLICY[segment] : null;
}

/** True when `role` satisfies `policy`. SUPER_ADMIN always passes. */
export function roleSatisfiesPolicy(role: string | null, policy: RoutePolicy): boolean {
  const normalized = (role ?? "").trim().toUpperCase();
  if (normalized === "SUPER_ADMIN") return true;

  if (policy.roles) return policy.roles.includes(normalized);

  const minRank = policy.minRank ?? ADMIN_ONLY; // missing rank ⇒ strictest sane default
  if (minRank === ANY_AUTHENTICATED) return true;
  const rank = normalized in ROLE_RANK ? ROLE_RANK[normalized] : -1;
  return rank >= minRank;
}
