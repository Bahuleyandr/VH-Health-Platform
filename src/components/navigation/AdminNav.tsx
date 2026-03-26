// src/components/navigation/AdminNav.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePermissions } from "@/hooks/usePermissions";

type NavItem = {
  name: string;
  href: string;
};

type NavSection = {
  title: string;
  /** Minimum role rank needed to see this section (inclusive) */
  minRole: "STAFF" | "HR" | "ADMIN" | "SUPER_ADMIN" | null;
  items: NavItem[];
};

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
      { name: "Doctors",         href: "/dashboard/doctors" },
      { name: "Departments",     href: "/dashboard/departments" },
      { name: "Payroll",         href: "/dashboard/payroll" },
      { name: "Analytics",       href: "/dashboard/analytics" },
      { name: "Medical Records", href: "/dashboard/records" },
      { name: "Pharmacy",        href: "/dashboard/pharmacy" },
      { name: "Notifications",   href: "/dashboard/notifications" },
      { name: "Attendance",      href: "/dashboard/attendance" },
      { name: "Uploads",         href: "/dashboard/uploads" },
      { name: "Feedback",        href: "/dashboard/feedback" },
      { name: "System Settings", href: "/dashboard/settings" },
      { name: "System Audit",    href: "/dashboard/system-audit" },
      { name: "Audit Logs",      href: "/dashboard/audit" },
    ],
  },
];

// Role rank for visibility checks (higher = more privileged)
const ROLE_RANK: Record<string, number> = {
  STAFF: 0,
  DOCTOR: 1,
  HR: 2,
  ADMIN: 3,
  SUPER_ADMIN: 4,
};

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

        return (
          <div key={section.title}>
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
              {section.title}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => {
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
