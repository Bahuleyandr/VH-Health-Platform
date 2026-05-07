// src/components/navigation/AdminNav.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePermissions } from "@/hooks/usePermissions";

type NavItem = {
  name: string;
  href: string;
  allowedRoles?: string[];
};

type NavSection = {
  title: string;
  /** Minimum role rank needed to see this section (inclusive) */
  minRole: "STAFF" | "HR" | "ADMIN" | "SUPER_ADMIN" | null;
  items: NavItem[];
};

const CLINICAL_AI_CONTROL_ROLES = [
  "ADMIN",
  "SUPER_ADMIN",
  "IT",
  "IT_ADMIN",
  "IT_STAFF",
  "SYSTEM_ADMIN",
];

const navSections: NavSection[] = [
  {
    title: "Overview",
    minRole: null, // all authenticated users
    items: [
      { name: "Dashboard", href: "/dashboard" },
    ],
  },
  {
    title: "My Work",
    minRole: "STAFF", // STAFF | DOCTOR | HR | ADMIN | SUPER_ADMIN
    items: [
      { name: "My Appointments", href: "/dashboard/my-appointments" },
      { name: "My Attendance",   href: "/dashboard/my-attendance" },
      { name: "My Leave",        href: "/dashboard/my-leave" },
      { name: "My Payslips",     href: "/dashboard/my-payslips" },
      { name: "My Replacements", href: "/dashboard/my-replacements" },
      { name: "Upload Prescription", href: "/dashboard/upload-prescription" },
    ],
  },
  {
    title: "Operations",
    minRole: null, // all authenticated
    items: [
      { name: "Appointments",    href: "/dashboard/appointments" },
      { name: "Housekeeping",    href: "/dashboard/housekeeping" },
      { name: "Emergency / SOS", href: "/dashboard/sos" },
    ],
  },
  {
    title: "AI Governance",
    minRole: null,
    items: [
      {
        name: "Clinical AI",
        href: "/dashboard/clinical-ai",
        allowedRoles: CLINICAL_AI_CONTROL_ROLES,
      },
      {
        // Phase 5 of the clinical-AI rollout
        // (docs/CLINICAL_AI_ROLLOUT_PLAN.md). Surfaces the
        // discharge_summary_compose meta-workflow page that already
        // existed at /dashboard/clinical-ai/discharge-compose but had
        // no nav entry until now.
        name: "Discharge Compose",
        href: "/dashboard/clinical-ai/discharge-compose",
        allowedRoles: CLINICAL_AI_CONTROL_ROLES,
      },
    ],
  },
  {
    title: "Clinical Services",
    minRole: "STAFF", // all clinical staff
    items: [
      { name: "Radiology",   href: "/dashboard/radiology" },
      { name: "Laboratory",  href: "/dashboard/lab" },
      { name: "Microbiology", href: "/dashboard/microbiology" },
      { name: "Anesthesia chart", href: "/dashboard/anesthesia-chart" },
      { name: "Dietary",     href: "/dashboard/dietary" },
      { name: "Theatre",     href: "/dashboard/theatre" },
      { name: "OR Board",    href: "/dashboard/or-board" },
      { name: "Maternity",   href: "/dashboard/maternity" },
      { name: "Blood Bank",  href: "/dashboard/blood-bank" },
      { name: "Quality",     href: "/dashboard/quality" },
      { name: "Referrals",   href: "/dashboard/referral" },
      { name: "Productivity", href: "/dashboard/productivity" },
      { name: "Patient Messages", href: "/dashboard/messaging" },
      { name: "Discharge Summaries", href: "/dashboard/discharge-summaries" },
      { name: "ED Tracker",          href: "/dashboard/ed-tracker" },
      { name: "MAR (5-rights)",      href: "/dashboard/mar" },
      { name: "Nursing Assessments", href: "/dashboard/nursing-assessments" },
      { name: "Beds",                href: "/dashboard/beds" },
      { name: "ICU Command Centre",  href: "/dashboard/icu" },
      { name: "Immunisations",       href: "/dashboard/immunisations" },
    ],
  },
  {
    title: "HR Management",
    minRole: "HR", // HR | ADMIN | SUPER_ADMIN
    items: [
      { name: "Leave Approvals",  href: "/dashboard/leave-approvals" },
      { name: "Grievances",       href: "/dashboard/grievances" },
      { name: "Incidents",        href: "/dashboard/incidents" },
      { name: "Attendance Audit", href: "/dashboard/attendance-audit" },
      { name: "Report Audit",     href: "/dashboard/reporting" },
      { name: "Investigations",   href: "/dashboard/investigations" },
      { name: "Staff",            href: "/dashboard/staff-roster" },
    ],
  },
  {
    title: "Administration",
    minRole: "ADMIN", // ADMIN | SUPER_ADMIN only
    items: [
      { name: "Users",           href: "/dashboard/users" },
      { name: "Patient Dedupe",  href: "/dashboard/patients/dedupe" },
      { name: "Doctors",         href: "/dashboard/doctors" },
      { name: "Departments",     href: "/dashboard/departments" },
      { name: "Payroll",         href: "/dashboard/payroll" },
      { name: "Analytics",       href: "/dashboard/analytics" },
      { name: "Operations",      href: "/dashboard/operations" },
      { name: "Dashboards",      href: "/dashboard/dashboards" },
      { name: "Insurance",       href: "/dashboard/insurance" },
      { name: "PM-JAY",          href: "/dashboard/pmjay" },
      { name: "PCPNDT (Form F)", href: "/dashboard/pcpndt" },
      { name: "Medical Records", href: "/dashboard/records" },
      { name: "Pharmacy",        href: "/dashboard/pharmacy" },
      { name: "Notifications",   href: "/dashboard/notifications" },
      { name: "Attendance",      href: "/dashboard/attendance" },
      { name: "Uploads",         href: "/dashboard/uploads" },
      { name: "Feedback",        href: "/dashboard/feedback" },
      { name: "System Settings", href: "/dashboard/settings" },
      { name: "System Audit",    href: "/dashboard/system-audit" },
      { name: "Audit Logs",      href: "/dashboard/audit" },
      { name: "Audit Explorer",  href: "/dashboard/audit-explorer" },
      { name: "Integrations",    href: "/dashboard/integrations" },
    ],
  },
];

// Role rank for visibility checks (higher = more privileged)
const ROLE_RANK: Record<string, number> = {
  STAFF: 0,
  LAB_TECHNICIAN: 0,
  TECHNICIAN: 0,
  NURSE: 0,
  DOCTOR: 1,
  HR: 2,
  ADMIN: 3,
  SUPER_ADMIN: 4,
};

function canSeeItem(item: NavItem, role: string | null, isSuperAdmin: boolean) {
  if (!item.allowedRoles) return true;
  if (isSuperAdmin) return true;
  const normalized = (role ?? "").trim().toUpperCase();
  return item.allowedRoles.includes(normalized);
}

export default function AdminNav() {
  const pathname = usePathname();
  const { role, isSuperAdmin } = usePermissions();

  const userRank = isSuperAdmin
    ? 4
    : role
    ? (ROLE_RANK[role] ?? -1)
    : -1;

  return (
    <nav aria-label="Admin navigation" className="space-y-4">
      {navSections.map((section) => {
        // Determine if this section is visible to current user
        const minRank = section.minRole ? (ROLE_RANK[section.minRole] ?? 99) : -Infinity;
        if (userRank < minRank) return null;
        const visibleItems = section.items.filter((item) => canSeeItem(item, role, isSuperAdmin));
        if (visibleItems.length === 0) return null;

        return (
          <div key={section.title}>
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
              {section.title}
            </p>
            <div className="space-y-0.5">
              {visibleItems.map((item) => {
                const active =
                  item.href === "/dashboard"
                    ? pathname === item.href
                    : pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`block rounded px-3 py-2 text-sm transition-colors ${
                      active
                        ? "bg-background text-white"
                        : "text-muted-foreground hover:bg-muted hover:text-white"
                    }`}
                  >
                    {item.name}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

// Legacy export kept for backward compat
export const navigationItems = navSections.flatMap((s) => s.items);
