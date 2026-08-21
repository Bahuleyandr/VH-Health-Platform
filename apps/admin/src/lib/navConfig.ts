// src/lib/navConfig.ts
//
// THE single source of truth for the dashboard sidebar (R10, 2026-08-10 audit).
//
// History: the portal had TWO nav definitions — a ~50-entry inline array in
// (with-auth)/dashboard/layout.tsx (the one actually rendered) and a ~88-entry
// components/navigation/AdminNav.tsx that was actively maintained but imported
// by nothing. 64 of 114 dashboard pages (PCPNDT, death-certification, ICU,
// MAR, blood-bank, insurance, PM-JAY, tenants, the SOS emergency console, …)
// were reachable only by typing the URL. This module merges both lists,
// preserves the live nav's gating for every entry it already had, and gates
// newly surfaced entries to mirror src/lib/routePolicy.ts (the middleware's
// default-deny map). AdminNav.tsx is deleted.
//
// Invariants, enforced by src/__tests__/navigation/nav-reachability.test.ts:
//   - Every non-parameterised page.tsx under (with-auth)/dashboard is either
//     an exact NAV href or listed in NAV_EXCLUDED_PAGES with a reason.
//   - Every NAV href points at an existing page (no dead links).
//   - Nav gating must exactly mirror ROUTE_POLICY for the same path.
//
// Keep permission flags in sync with the per-admin permission-flag proxy
// enforcement in src/lib/proxyPermissions.ts (PR #828): the nav hides a module
// from a scoped-down ADMIN, the proxy actually denies the API calls.

import {
  CLINICAL_AI_CONTROL_ROLES,
  ORDER_SET_STUDIO_ROLES,
  ROLE_RANK,
} from "@/lib/routePolicy";

export type NavItem = {
  name: string;
  href: string;
  /** Optional role requirement (SUPER_ADMIN always allowed) */
  requiredRole?: "ADMIN" | "SUPER_ADMIN";
  /** Optional minimum portal tier (SUPER_ADMIN always allowed) */
  minRole?: "STAFF" | "DOCTOR" | "HR" | "ADMIN" | "SUPER_ADMIN";
  /** Optional permission requirements (ALL must be present; SUPER_ADMIN always allowed) */
  requiredPermissions?: string[];
  /** Permission requirements that scope ADMIN accounts but not lower clinical roles. */
  requiredAdminPermissions?: string[];
  /**
   * Optional explicit role allowlist that REPLACES the tier checks
   * (SUPER_ADMIN always allowed). Mirrors ROUTE_POLICY `roles` entries.
   */
  allowedRoles?: string[];
};

export type NavVisibilityContext = {
  rawRole: string | null;
  role: string | null;
  isSuperAdmin: boolean;
  hasAllPermissions: (permissions: string[]) => boolean;
};

export function isNavItemVisible(
  item: NavItem,
  context: NavVisibilityContext,
): boolean {
  if (context.isSuperAdmin) return true;
  if (item.allowedRoles)
    return item.allowedRoles.includes(context.rawRole ?? "");

  const roleOk = !item.requiredRole || context.role === item.requiredRole;
  const minRoleOk =
    !item.minRole ||
    (ROLE_RANK[context.role ?? ""] ?? -1) >= ROLE_RANK[item.minRole];
  const permissions = item.requiredPermissions ?? [];
  const permissionsOk =
    permissions.length === 0 || context.hasAllPermissions(permissions);
  const adminPermissions = item.requiredAdminPermissions ?? [];
  const adminPermissionsOk =
    context.role !== "ADMIN" ||
    adminPermissions.length === 0 ||
    context.hasAllPermissions(adminPermissions);
  return roleOk && minRoleOk && permissionsOk && adminPermissionsOk;
}

export type NavSection = {
  title: string;
  items: NavItem[];
};

export function visibleNavSections(
  context: NavVisibilityContext,
): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => isNavItemVisible(item, context)),
  })).filter((section) => section.items.length > 0);
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Overview",
    items: [{ name: "Dashboard", href: "/dashboard" }],
  },
  {
    // Staff self-service. Route policy: STAFF rank.
    title: "My Work",
    items: [
      {
        name: "My Appointments",
        href: "/dashboard/my-appointments",
        minRole: "STAFF",
      },
      {
        name: "My Attendance",
        href: "/dashboard/my-attendance",
        minRole: "STAFF",
      },
      { name: "My Leave", href: "/dashboard/my-leave", minRole: "STAFF" },
      { name: "My Payslips", href: "/dashboard/my-payslips", minRole: "STAFF" },
      {
        name: "My Replacements",
        href: "/dashboard/my-replacements",
        minRole: "STAFF",
      },
      {
        name: "Upload Prescription",
        href: "/dashboard/upload-prescription",
        minRole: "STAFF",
      },
    ],
  },
  {
    title: "Operations",
    items: [
      {
        name: "Appointments",
        href: "/dashboard/appointments",
        requiredAdminPermissions: ["appointmentManagement"],
      },
      {
        name: "Queue Displays",
        href: "/dashboard/queue-displays",
        minRole: "STAFF",
      },
      // AD-H2: Code Blue / Code STEMI live board (realtime staff:code-blue /
      // staff:code-stemi). Route policy allows all clinical staff (STAFF rank);
      // without this entry the board was unreachable from any UI.
      {
        name: "Clinical Alerts",
        href: "/dashboard/clinical-alerts",
        minRole: "STAFF",
      },
      // F1 (2026-08-10 audit): the SOS emergency console's only nav reference
      // lived in the phantom AdminNav. Route policy: any authenticated role.
      { name: "Emergency / SOS", href: "/dashboard/sos" },
      { name: "Housekeeping", href: "/dashboard/housekeeping" },
      {
        name: "Linen & Laundry",
        href: "/dashboard/linen-laundry",
        minRole: "STAFF",
      },
      { name: "CSSD", href: "/dashboard/cssd", minRole: "STAFF" },
      { name: "Cold Chain", href: "/dashboard/cold-chain", minRole: "STAFF" },
      {
        name: "Daily Ops Snapshot",
        href: "/dashboard/operations",
        requiredRole: "ADMIN",
      },
      {
        name: "BI Dashboards",
        href: "/dashboard/dashboards",
        requiredRole: "ADMIN",
      },
      {
        name: "MIS Report Emails",
        href: "/dashboard/mis-report-schedules",
        requiredRole: "ADMIN",
      },
      { name: "Devices", href: "/dashboard/devices", minRole: "STAFF" },
      {
        name: "Facility Assets",
        href: "/dashboard/facility-assets",
        requiredRole: "ADMIN",
        // Mirrors the proxy gate (proxyPermissions.ts): facility assets are
        // physical-infrastructure inventory, same class as beds/wards — a
        // flag-limited ADMIN without departmentManagement gets 403s on every
        // API call, so don't advertise a dead page.
        requiredAdminPermissions: ["departmentManagement"],
      },
    ],
  },
  {
    // Clinical boards. Route policy: STAFF rank unless noted.
    title: "Clinical Services",
    items: [
      { name: "Oncology", href: "/dashboard/oncology", minRole: "STAFF" },
      {
        name: "Nuclear Med & Radiotherapy",
        href: "/dashboard/radiation-oncology",
        minRole: "STAFF",
      },
      { name: "Transplant", href: "/dashboard/transplant", minRole: "STAFF" },
      { name: "Radiology", href: "/dashboard/radiology", minRole: "STAFF" },
      { name: "Pathology", href: "/dashboard/pathology", minRole: "STAFF" },
      { name: "Laboratory", href: "/dashboard/lab", minRole: "STAFF" },
      {
        name: "Microbiology",
        href: "/dashboard/microbiology",
        minRole: "STAFF",
      },
      {
        name: "Stroke Pathway",
        href: "/dashboard/stroke-pathway",
        minRole: "STAFF",
      },
      { name: "ED Tracker", href: "/dashboard/ed-tracker", minRole: "STAFF" },
      { name: "ICU Command Centre", href: "/dashboard/icu", minRole: "STAFF" },
      { name: "MAR (5-rights)", href: "/dashboard/mar", minRole: "STAFF" },
      {
        name: "Nursing Assessments",
        href: "/dashboard/nursing-assessments",
        minRole: "STAFF",
      },
      {
        name: "Anesthesia Chart",
        href: "/dashboard/anesthesia-chart",
        minRole: "STAFF",
      },
      { name: "Theatre", href: "/dashboard/theatre", minRole: "STAFF" },
      { name: "OR Board", href: "/dashboard/or-board", minRole: "STAFF" },
      { name: "Maternity", href: "/dashboard/maternity", minRole: "STAFF" },
      { name: "Dialysis Unit", href: "/dashboard/dialysis", minRole: "STAFF" },
      { name: "Blood Bank", href: "/dashboard/blood-bank", minRole: "STAFF" },
      {
        name: "Immunisations",
        href: "/dashboard/immunisations",
        minRole: "STAFF",
      },
      { name: "Dietary", href: "/dashboard/dietary", minRole: "STAFF" },
      {
        name: "Physiotherapy",
        href: "/dashboard/physiotherapy",
        minRole: "STAFF",
      },
      { name: "Referrals", href: "/dashboard/referral", minRole: "STAFF" },
      {
        name: "Referral Facilities",
        href: "/dashboard/referral-facilities",
        requiredRole: "ADMIN",
      },
      {
        name: "Productivity",
        href: "/dashboard/productivity",
        minRole: "STAFF",
      },
      { name: "Quality", href: "/dashboard/quality", minRole: "STAFF" },
      {
        name: "Cath Lab Quality",
        href: "/dashboard/quality/cath",
        minRole: "STAFF",
      },
      {
        name: "Order-Set Studio",
        href: "/dashboard/order-set-studio",
        allowedRoles: ORDER_SET_STUDIO_ROLES,
      },
      {
        name: "Patient Messages",
        href: "/dashboard/messaging",
        minRole: "STAFF",
      },
      {
        name: "Discharge Summaries",
        href: "/dashboard/discharge-summaries",
        minRole: "STAFF",
      },
      // Route policy: CLINICAL_LEAD (doctors and up).
      {
        name: "Death Certification",
        href: "/dashboard/death-certification",
        minRole: "DOCTOR",
      },
      {
        name: "Bed Management",
        href: "/dashboard/beds",
        minRole: "STAFF",
        requiredAdminPermissions: ["departmentManagement"],
      },
      {
        name: "Consent",
        href: "/dashboard/consent",
        minRole: "STAFF",
        requiredAdminPermissions: ["userManagement"],
      },
    ],
  },
  {
    // Clinical-AI control plane. Route policy: explicit allowlist
    // (ADMIN / SUPER_ADMIN / IT roles), not the tier ladder.
    title: "AI Governance",
    items: [
      {
        name: "Clinical AI",
        href: "/dashboard/clinical-ai",
        allowedRoles: CLINICAL_AI_CONTROL_ROLES,
      },
      {
        name: "Discharge Compose",
        href: "/dashboard/clinical-ai/discharge-compose",
        allowedRoles: CLINICAL_AI_CONTROL_ROLES,
      },
      {
        name: "AI Outcome Scoreboard",
        href: "/dashboard/clinical-ai/scoreboard",
        allowedRoles: CLINICAL_AI_CONTROL_ROLES,
      },
    ],
  },
  {
    title: "HR & Workforce",
    items: [
      { name: "Staff Roster", href: "/dashboard/staff-roster", minRole: "HR" },
      {
        name: "Credentialing",
        href: "/dashboard/credentialing",
        minRole: "HR",
      },
      {
        name: "Attendance",
        href: "/dashboard/attendance",
        requiredPermissions: ["userManagement"],
      },
      {
        name: "Attendance Disputes",
        href: "/dashboard/attendance/disputes",
        requiredPermissions: ["userManagement"],
      },
      {
        name: "Overtime Approvals",
        href: "/dashboard/attendance/overtime",
        requiredPermissions: ["userManagement"],
      },
      {
        name: "Attendance Bulk Correction",
        href: "/dashboard/attendance/bulk-correct",
        requiredPermissions: ["userManagement"],
      },
      {
        name: "Leave Approvals",
        href: "/dashboard/leave-approvals",
        minRole: "HR",
      },
      { name: "Shift Management", href: "/dashboard/shifts", minRole: "STAFF" },
      { name: "Grievances (HR)", href: "/dashboard/grievances", minRole: "HR" },
      { name: "Incident Reports", href: "/dashboard/incidents", minRole: "HR" },
      {
        name: "Payroll & HR Comp",
        href: "/dashboard/payroll",
        requiredRole: "ADMIN",
      },
      { name: "Reporting", href: "/dashboard/reporting", minRole: "HR" },
    ],
  },
  {
    title: "Patients & Front Office",
    items: [
      {
        name: "Users",
        href: "/dashboard/users",
        requiredPermissions: ["userManagement"],
      },
      {
        name: "Patient Dedupe",
        href: "/dashboard/patients/dedupe",
        requiredRole: "ADMIN",
      },
      {
        name: "Doctors",
        href: "/dashboard/doctors",
        requiredPermissions: ["doctorManagement"],
      },
      {
        name: "Departments",
        href: "/dashboard/departments",
        requiredPermissions: ["departmentManagement"],
      },
      // Route policy: HR_PLUS. Investigations admin API endpoints are
      // viewAuditLogs-gated at the proxy for flag-scoped ADMINs.
      {
        name: "Investigations",
        href: "/dashboard/investigations",
        minRole: "HR",
      },
      {
        name: "Pharmacy",
        href: "/dashboard/pharmacy",
        requiredPermissions: ["pharmacyAdminRoutes"],
      },
      {
        name: "Pharmacy Inventory",
        href: "/dashboard/pharmacy/inventory",
        requiredPermissions: ["pharmacyAdminRoutes"],
      },
      {
        name: "Drug Returns",
        href: "/dashboard/drug-returns",
        requiredRole: "ADMIN",
      },
      {
        name: "Notifications",
        href: "/dashboard/notifications",
        minRole: "STAFF",
        requiredAdminPermissions: ["notificationManagement"],
      },
      {
        name: "Feedback",
        href: "/dashboard/feedback",
        requiredPermissions: ["userManagement"],
      },
      { name: "Uploads", href: "/dashboard/uploads", requiredRole: "ADMIN" },
    ],
  },
  {
    title: "Billing & Revenue",
    items: [
      { name: "Billing", href: "/dashboard/billing", requiredRole: "ADMIN" },
      {
        name: "Cath Consumables",
        href: "/dashboard/billing/cath-consumables",
        requiredRole: "ADMIN",
      },
      {
        name: "Billing Denials",
        href: "/dashboard/billing/denials",
        requiredRole: "ADMIN",
      },
      {
        name: "Day-care Packages",
        href: "/dashboard/billing/packages",
        requiredRole: "ADMIN",
      },
      {
        name: "General Ledger",
        href: "/dashboard/billing/ledger",
        requiredRole: "ADMIN",
      },
      {
        name: "Insurance",
        href: "/dashboard/insurance",
        requiredRole: "ADMIN",
      },
      { name: "PM-JAY", href: "/dashboard/pmjay", requiredRole: "ADMIN" },
    ],
  },
  {
    title: "Analytics & Audit",
    items: [
      {
        name: "Analytics",
        href: "/dashboard/analytics",
        requiredPermissions: ["viewAuditLogs"],
      },
      {
        name: "Report Builder",
        href: "/dashboard/report-builder",
        requiredPermissions: ["viewAuditLogs"],
      },
      {
        name: "Reports Audit",
        href: "/dashboard/audit",
        requiredRole: "ADMIN",
      },
      {
        name: "System Audit Log",
        href: "/dashboard/system-audit",
        requiredRole: "ADMIN",
      },
      {
        name: "Audit Explorer",
        href: "/dashboard/audit-explorer",
        requiredRole: "ADMIN",
      },
      {
        name: "System Logs",
        href: "/dashboard/system-logs",
        requiredPermissions: ["viewAuditLogs"],
      },
      {
        name: "Attendance Audit",
        href: "/dashboard/attendance-audit",
        minRole: "HR",
      },
    ],
  },
  {
    title: "Governance & Compliance",
    items: [
      {
        name: "Clinical Governance",
        href: "/dashboard/clinical-governance",
        requiredRole: "ADMIN",
      },
      {
        name: "Continuity Reconciliation",
        href: "/dashboard/continuity-reconciliation",
        requiredRole: "ADMIN",
      },
      {
        name: "Care Pathway Evidence",
        href: "/dashboard/care-pathways",
        requiredRole: "ADMIN",
      },
      {
        name: "Compliance",
        href: "/dashboard/compliance",
        requiredRole: "ADMIN",
      },
      {
        name: "Compliance Indicators",
        href: "/dashboard/compliance/indicators",
        requiredRole: "ADMIN",
      },
      {
        name: "PCPNDT (Form F)",
        href: "/dashboard/pcpndt",
        requiredRole: "ADMIN",
      },
      { name: "BMW Register", href: "/dashboard/bmw", requiredRole: "ADMIN" },
    ],
  },
  {
    title: "Platform Administration",
    items: [
      {
        name: "Admin Management",
        href: "/dashboard/admin-management",
        requiredRole: "SUPER_ADMIN",
      },
      { name: "Settings", href: "/dashboard/settings", requiredRole: "ADMIN" },
      {
        name: "Entitlements",
        href: "/dashboard/entitlements",
        requiredRole: "SUPER_ADMIN",
      },
      {
        name: "Adoption & LMS",
        href: "/dashboard/adoption",
        requiredRole: "ADMIN",
      },
      {
        name: "Developer Portal",
        href: "/dashboard/developer-portal",
        requiredRole: "ADMIN",
      },
      { name: "ABDM", href: "/dashboard/abdm", requiredRole: "ADMIN" },
      {
        name: "Integrations",
        href: "/dashboard/integrations",
        requiredRole: "ADMIN",
      },
      // Slate C1: terminology spine + licensed drug-KB console. Mirrors
      // routePolicy `terminology` (ADMIN_ONLY); write endpoints are further
      // curator-role-gated on the backend.
      {
        name: "Terminology & Knowledge",
        href: "/dashboard/terminology",
        requiredRole: "ADMIN",
      },
    ],
  },
  {
    // Route policy: SUPER_ADMIN only.
    title: "Platform Operations",
    items: [
      {
        name: "Database",
        href: "/dashboard/database",
        requiredRole: "SUPER_ADMIN",
      },
      {
        name: "Feature Flags",
        href: "/dashboard/feature-flags",
        requiredRole: "SUPER_ADMIN",
      },
      {
        name: "Facility Context",
        href: "/dashboard/continuity-facility-context",
        requiredRole: "SUPER_ADMIN",
      },
      {
        name: "Tenant Operator Console",
        href: "/dashboard/tenants",
        requiredRole: "SUPER_ADMIN",
      },
      {
        name: "Integrations & Gates",
        href: "/dashboard/integration-gates",
        requiredRole: "SUPER_ADMIN",
      },
    ],
  },
];

/** Flat list of every nav item, for search/palette use and tests. */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/**
 * Non-parameterised dashboard pages deliberately absent from the sidebar.
 * Every entry MUST carry a reason; the nav-reachability test fails on any
 * dashboard page that is neither a nav href nor listed here, and on any entry
 * here that is stale (page gone, or page now also in the nav).
 */
export const NAV_EXCLUDED_PAGES: Record<string, string> = {
  "/dashboard/executive":
    "Leadership summary deliberately kept out of the operational nav (decision inherited " +
    "from the retired AdminNav). URL-reachable; route policy gates it to CLINICAL_LEAD+.",
  "/dashboard/discharge-summary":
    "Legacy route that permanentRedirect()s to /dashboard/discharge-summaries (AD-M1, 2026-08-09).",
  "/dashboard/patients":
    "Bare redirect page to /dashboard/users?role=PATIENT — linking it would duplicate Users.",
  "/dashboard/doctors/create":
    "Creation flow reached from the Doctors page, not top-level nav.",
  "/dashboard/payroll/comparison":
    "Drill-down reached from the Payroll page, not top-level nav.",
};
