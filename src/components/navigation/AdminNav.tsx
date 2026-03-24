// src/components/navigation/AdminNav.tsx
"use client";

import { usePermissions } from "@/hooks/usePermissions";
import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  name: string;
  href: string;
  requiredRole?: "ADMIN" | "SUPER_ADMIN";
  requiredPermissions?: string[]; // all must be present (SUPER_ADMIN bypasses)
};

// Exported so it’s not “defined but never used”
export const navigationItems: NavItem[] = [
  { name: "Dashboard", href: "/dashboard" },

  {
    name: "Users",
    href: "/dashboard/users",
    requiredPermissions: ["userManagement"],
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
  {
    name: "Appointments",
    href: "/dashboard/appointments",
    requiredPermissions: ["appointmentManagement"],
  },

  {
    name: "Pharmacy",
    href: "/dashboard/pharmacy",
    requiredPermissions: ["pharmacyAdminRoutes"],
  },

  {
    name: "Notifications",
    href: "/dashboard/notifications",
    requiredPermissions: ["notificationManagement"],
  },

  { name: "Attendance", href: "/dashboard/attendance", requiredRole: "ADMIN" },
  { name: "Emergency/SOS", href: "/dashboard/sos" },
  { name: "Uploads", href: "/dashboard/uploads", requiredRole: "ADMIN" },
  {
    name: "Reporting",
    href: "/dashboard/reporting",
    requiredPermissions: ["viewAuditLogs"],
  },
  {
    name: "System Logs",
    href: "/dashboard/system-logs",
    requiredRole: "ADMIN",
  },
  {
    name: "Admin Management",
    href: "/dashboard/admin-management",
    requiredRole: "SUPER_ADMIN",
  },
  {
    name: "System Settings",
    href: "/dashboard/settings",
    requiredRole: "ADMIN",
  },
];

export default function AdminNav() {
  const pathname = usePathname();
  const { role, isSuperAdmin, hasAllPermissions } = usePermissions();

  const visible = navigationItems.filter((item) => {
    const roleOk =
      !item.requiredRole || isSuperAdmin || role === item.requiredRole;
    const perms = item.requiredPermissions ?? [];
    const permsOk =
      perms.length === 0 || isSuperAdmin || hasAllPermissions(perms);
    return roleOk && permsOk;
  });

  return (
    <nav aria-label="Admin navigation" className="space-y-1">
      {visible.map((item) => {
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
                ? "bg-gray-900 text-white"
                : "text-gray-300 hover:bg-gray-800 hover:text-white"
            }`}
          >
            {item.name}
          </Link>
        );
      })}
    </nav>
  );
}
