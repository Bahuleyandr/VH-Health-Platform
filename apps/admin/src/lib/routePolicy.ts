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

import { normalizePortalRole, PORTAL_ROLE_RANK } from "./roles";

export const ROLE_RANK: Readonly<Record<string, number>> = PORTAL_ROLE_RANK;

// Named rank levels (use these, not bare numbers, in the policy map).
export const ANY_AUTHENTICATED = -1; // any valid, recognized human portal role
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

// Exact backend `staffAdminRoutes` allowlist. Shift Management must use raw
// role identity rather than a portal-rank approximation: HR/HR_MANAGER are not
// admitted server-side, while housekeeping and clinical leadership are.
export const SHIFT_MANAGEMENT_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "HR_STAFF",
  "HOUSEKEEPING_INCHARGE",
  "CMO",
  "CNO",
  "MEDICAL_SUPERINTENDENT",
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
  "queue-displays": { minRank: STAFF },
  housekeeping: { minRank: ANY_AUTHENTICATED },
  "linen-laundry": { minRank: STAFF },
  sos: { minRank: ANY_AUTHENTICATED },
  notifications: { minRank: STAFF },

  // ── Staff self-service ("My Work") ────────────────────────────────────────
  "my-appointments": { minRank: STAFF },
  "my-attendance": { minRank: STAFF },
  "my-leave": { minRank: STAFF },
  "my-payslips": { minRank: STAFF },
  "my-replacements": { minRank: STAFF },
  "upload-prescription": { minRank: STAFF },
  // Exact raw-role parity with wrapAutoRBAC('staffAdminRoutes').
  shifts: { roles: SHIFT_MANAGEMENT_ROLES },

  // ── Clinical services (nurses + clinical staff + up) ─────────────────────
  radiology: { minRank: STAFF },
  pathology: { minRank: STAFF },
  lab: { minRank: STAFF },
  microbiology: { minRank: STAFF },
  "anesthesia-chart": { minRank: STAFF },
  dietary: { minRank: STAFF },
  physiotherapy: { minRank: STAFF },
  theatre: { minRank: STAFF },
  cssd: { minRank: STAFF },
  "or-board": { minRank: STAFF },
  maternity: { minRank: STAFF },
  "blood-bank": { minRank: STAFF },
  "cold-chain": { minRank: STAFF },
  quality: { minRank: STAFF },
  referral: { minRank: STAFF },
  "referral-facilities": { minRank: ADMIN_ONLY },
  "facility-assets": { minRank: ADMIN_ONLY },
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
  "radiation-oncology": { minRank: STAFF },
  "stroke-pathway": { minRank: STAFF },
  transplant: { minRank: STAFF },
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
  "care-pathways": { minRank: ADMIN_ONLY },
  "continuity-reconciliation": { minRank: ADMIN_ONLY },
  payroll: { minRank: ADMIN_ONLY },
  analytics: { minRank: ADMIN_ONLY },
  operations: { minRank: ADMIN_ONLY },
  dashboards: { minRank: ADMIN_ONLY },
  "mis-report-schedules": { minRank: ADMIN_ONLY },
  insurance: { minRank: ADMIN_ONLY },
  pmjay: { minRank: ADMIN_ONLY },
  billing: { minRank: ADMIN_ONLY },
  pcpndt: { minRank: ADMIN_ONLY },
  bmw: { minRank: ADMIN_ONLY },
  "drug-returns": { minRank: ADMIN_ONLY },
  pharmacy: { minRank: ADMIN_ONLY },
  attendance: { minRank: ADMIN_ONLY },
  uploads: { minRank: ADMIN_ONLY },
  feedback: { minRank: ADMIN_ONLY },
  settings: { minRank: ADMIN_ONLY },
  "system-audit": { minRank: ADMIN_ONLY },
  audit: { minRank: ADMIN_ONLY },
  "audit-explorer": { minRank: ADMIN_ONLY },
  integrations: { minRank: ADMIN_ONLY },
  adoption: { minRank: ADMIN_ONLY },
  "developer-portal": { minRank: ADMIN_ONLY },
  abdm: { minRank: ADMIN_ONLY },
  compliance: { minRank: ADMIN_ONLY },
  "system-logs": { minRank: ADMIN_ONLY },
  "report-builder": { minRank: ADMIN_ONLY },
  // Terminology & Knowledge console (slate C1): code-system imports, binding
  // curation, tenant coding settings, drug-KB sources, lab code mappings.
  // Backend gates writes to curator roles; the console itself is ADMIN+.
  terminology: { minRank: ADMIN_ONLY },

  // ── Platform operations (SUPER_ADMIN only) ────────────────────────────────
  // live DB browser — backend databaseRoutes.js is SUPER_ADMIN-only too
  database: { minRank: SUPER_ADMIN_ONLY },
  tenants: { minRank: SUPER_ADMIN_ONLY },
  "feature-flags": { minRank: SUPER_ADMIN_ONLY },
  // Dark-gate console: reads/flips the most sensitive per-tenant toggles
  // (payment gateway, SMS/DLT, ABDM) — SUPER_ADMIN-only end to end
  // (backend requireRole + proxy sentinel gate + this policy + nav).
  "integration-gates": { minRank: SUPER_ADMIN_ONLY },
  "continuity-facility-context": { minRank: SUPER_ADMIN_ONLY },
  // entitlements edit tenant license/package/status — a tenant ADMIN must not
  // self-upgrade; matches the SUPER_ADMIN-only backend gate (entitlementRoutes).
  entitlements: { minRank: SUPER_ADMIN_ONLY },
  // admin account lifecycle is SUPER_ADMIN-only + step-up on the backend.
  "admin-management": { minRank: SUPER_ADMIN_ONLY },

  // ── Once-over train E (2026-08-23): previously curl-only surfaces ─────────
  // Escalation-rule CRUD pages clinicians on breached SLAs; backend is ADMIN+.
  "workflow-escalations": { minRank: ADMIN_ONLY },
  // Facility/location/room/service masters mirror facilityRoutes (ADMIN+).
  "facility-masters": { minRank: ADMIN_ONLY },
  // Campaign authoring is ADMIN+; send authority stays backend-gated
  // (dry-run → approve → materialize order enforced server-side).
  engagement: { minRank: ADMIN_ONLY },
  // Accreditation evidence reads mirror the compliance surfaces (ADMIN+).
  "nabh-packs": { minRank: ADMIN_ONLY },
  // PHI key registry ops change live decryption paths — SUPER_ADMIN only.
  // Enforcement is layered and this entry is only the first layer: it gates
  // /dashboard navigation, the proxy's PLATFORM_SUPER_ADMIN sentinel gates
  // api/v1/admin/encryption-keys (middleware checks rank in the /dashboard
  // branch ONLY, so nav hiding is not enforcement), and encryptionKeyRoutes
  // must carry the backend rank check — it mounts under the ADMIN-tier
  // /api/v1/admin barrel, which is not a SUPER_ADMIN gate.
  "encryption-keys": { minRank: SUPER_ADMIN_ONLY },
  // App registry + token revocation for the LIVE public OAuth surface.
  "smart-fhir": { minRank: SUPER_ADMIN_ONLY },
  // Data-subject erasure execution is destructive and audit-bound.
  "gdpr-erasure": { minRank: SUPER_ADMIN_ONLY },
  // Two-phase hospital-data import (rehearsal/commit) — operator ceremony.
  "migration-toolkit": { minRank: SUPER_ADMIN_ONLY },
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
export function roleSatisfiesPolicy(
  role: string | null,
  policy: RoutePolicy,
): boolean {
  const normalized = normalizePortalRole(role);
  if (!normalized) return false;
  if (normalized === "SUPER_ADMIN") return true;

  if (policy.roles) return policy.roles.includes(normalized);

  const minRank = policy.minRank ?? ADMIN_ONLY; // missing rank ⇒ strictest sane default
  if (minRank === ANY_AUTHENTICATED) return true;
  const rank = ROLE_RANK[normalized] ?? -1;
  return rank >= minRank;
}
