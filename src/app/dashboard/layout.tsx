// src/app/dashboard/layout.tsx
"use client";

import { useState, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { CommandPalette } from "@/components/CommandPalette";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { AuthDebugger } from "@/components/auth/AuthDebugger";
import { usePermissions } from "@/hooks/usePermissions";

type NavItem = {
  name: string;
  href: string;
  /** Optional role requirement (SUPER_ADMIN always allowed) */
  requiredRole?: "ADMIN" | "SUPER_ADMIN";
  /** Optional permission requirements (ALL must be present; SUPER_ADMIN always allowed) */
  requiredPermissions?: string[];
};

const navigation: NavItem[] = [
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
    name: "Reporting",
    href: "/dashboard/reporting",
    requiredPermissions: ["viewAuditLogs"],
  },
  {
    name: "Notifications",
    href: "/dashboard/notifications",
    requiredPermissions: ["notificationManagement"],
  },

  // Admin-only sections
  {
    name: "Admin Management",
    href: "/dashboard/admin-management",
    requiredRole: "ADMIN",
    requiredPermissions: ["adminManagement"],
  },
  {
    name: "System Logs",
    href: "/dashboard/system-logs",
    requiredPermissions: ["viewAuditLogs"],
  },
  { name: "Settings", href: "/dashboard/settings", requiredRole: "ADMIN" },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Current user permissions/role
  const { role, isSuperAdmin, hasAllPermissions } = usePermissions();

  // Only show links current user can access
  const visibleNav = useMemo(() => {
    return navigation.filter((item) => {
      const roleOk =
        !item.requiredRole || isSuperAdmin || role === item.requiredRole;
      const perms = item.requiredPermissions ?? [];
      const permsOk =
        perms.length === 0 || isSuperAdmin || hasAllPermissions(perms);
      return roleOk && permsOk;
    });
  }, [role, isSuperAdmin, hasAllPermissions]);

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Mobile sidebar backdrop */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-gray-600/75 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar (fixed) */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-64 bg-gray-900 transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0 ${
          isSidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center justify-center bg-gray-800">
          <h1 className="text-xl font-bold text-white">VH Admin Portal</h1>
        </div>

        <nav className="mt-3 pb-8">
          {visibleNav.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={() => setIsSidebarOpen(false)}
                className={`block px-6 py-3 text-sm font-medium transition-colors ${
                  isActive
                    ? "border-l-4 border-blue-500 bg-gray-800 text-white"
                    : "text-gray-300 hover:bg-gray-800 hover:text-white"
                }`}
              >
                {item.name}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Right column (header + scrollable content) */}
      <div className="lg:pl-64 flex min-h-screen flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
          <div className="px-4 sm:px-6 lg:px-8">
            <div className="flex h-16 items-center justify-between">
              <button
                className="lg:hidden rounded p-2 hover:bg-gray-100"
                onClick={() => setIsSidebarOpen((v) => !v)}
                aria-label="Toggle sidebar"
              >
                <svg
                  className="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                </svg>
              </button>

              <Breadcrumbs />

              <div className="flex items-center gap-3">
                <CommandPalette />
                <ThemeToggle />
                <button
                  onClick={() => {
                    localStorage.removeItem("adminToken");
                    localStorage.removeItem("adminUser");
                    router.push("/login");
                  }}
                  className="text-sm text-gray-700 hover:text-gray-900"
                >
                  Logout
                </button>
              </div>
            </div>
          </div>
        </header>

        {/* Main scroll area */}
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>

      {/* Dev-only utility */}
      <AuthDebugger />
    </div>
  );
}
