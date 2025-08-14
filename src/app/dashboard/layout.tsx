// src/app/dashboard/layout.tsx
'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { CommandPalette } from '@/components/CommandPalette';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { AuthDebugger } from '@/components/auth/AuthDebugger';
import { usePermissions } from '@/hooks/usePermissions';

type Role = 'ADMIN' | 'SUPER_ADMIN';

type NavItem = {
  name: string;
  href: string;
  requiredRole?: Role;            // SUPER_ADMIN bypasses
  requiredPermissions?: string[]; // all must be present; SUPER_ADMIN bypasses
};

const NAV_ITEMS: NavItem[] = [
  { name: 'Dashboard', href: '/dashboard' },

  { name: 'Users', href: '/dashboard/users', requiredPermissions: ['userManagement'] },
  { name: 'Doctors', href: '/dashboard/doctors', requiredPermissions: ['doctorManagement'] },
  { name: 'Departments', href: '/dashboard/departments', requiredPermissions: ['departmentManagement'] },
  { name: 'Appointments', href: '/dashboard/appointments', requiredPermissions: ['appointmentManagement'] },
  { name: 'Pharmacy', href: '/dashboard/pharmacy', requiredPermissions: ['pharmacyAdminRoutes'] },

  { name: 'Reporting', href: '/dashboard/reporting', requiredPermissions: ['viewAuditLogs'] },
  { name: 'Notifications', href: '/dashboard/notifications', requiredPermissions: ['notificationManagement'] },

  { name: 'Admin Management', href: '/dashboard/admin-management', requiredRole: 'ADMIN', requiredPermissions: ['adminManagement'] },
  { name: 'System Logs', href: '/dashboard/system-logs', requiredPermissions: ['viewAuditLogs'] },
  { name: 'Settings', href: '/dashboard/settings', requiredRole: 'ADMIN' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);

  const { role, isSuperAdmin, hasAllPermissions } = usePermissions();

  const visibleNav: NavItem[] = useMemo(() => {
    return NAV_ITEMS.filter((item) => {
      const roleOk = !item.requiredRole || isSuperAdmin || role === item.requiredRole;
      const perms = item.requiredPermissions ?? [];
      const permsOk = perms.length === 0 || isSuperAdmin || hasAllPermissions(perms);
      return roleOk && permsOk;
    });
  }, [role, isSuperAdmin, hasAllPermissions]);

  return (
    <div className="flex min-h-screen bg-gray-100">
      {/* Mobile overlay */}
      {isSidebarOpen && (
        <button
          aria-label="Close sidebar"
          className="fixed inset-0 z-20 bg-black/40 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-64 transform bg-gray-900 transition-transform duration-300 ease-in-out lg:static lg:translate-x-0 ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-center bg-gray-800">
          <span className="text-xl font-bold text-white">VH Admin Portal</span>
        </div>

        <nav className="mt-4 space-y-1">
          {visibleNav.map((item: NavItem) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-6 py-3 text-sm font-medium transition-colors ${
                  active
                    ? 'border-l-4 border-blue-500 bg-gray-800 text-white'
                    : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                }`}
              >
                {item.name}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main column */}
      <div className="flex min-h-screen flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-10 bg-white shadow">
          <div className="mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex h-16 items-center justify-between">
              <button
                aria-label="Open sidebar"
                className="lg:hidden"
                onClick={() => setIsSidebarOpen((v) => !v)}
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>

              <Breadcrumbs />

              <div className="flex items-center gap-3">
                <CommandPalette />
                <ThemeToggle />
                <button
                  className="text-sm text-gray-700 hover:text-gray-900"
                  onClick={() => {
                    localStorage.removeItem('adminToken');
                    localStorage.removeItem('adminUser');
                    router.push('/login');
                  }}
                >
                  Logout
                </button>
              </div>
            </div>
          </div>
        </header>

        {/* Scroll area */}
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>

      {/* Dev helper */}
      <AuthDebugger />
    </div>
  );
}
