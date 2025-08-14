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

type NavItem = {
  name: string;
  href: string;
  /** Optional role requirement (SUPER_ADMIN always allowed) */
  requiredRole?: 'ADMIN' | 'SUPER_ADMIN';
  /** Optional permission requirements (ALL must be present; SUPER_ADMIN always allowed) */
  requiredPermissions?: string[];
};

const navigation: NavItem[] = [
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const { role, isSuperAdmin, hasAllPermissions } = usePermissions();

  const visibleNav = useMemo(() => {
    return navigation.filter((item) => {
      const roleOk = !item.requiredRole || isSuperAdmin || role === item.requiredRole;
      const perms = item.requiredPermissions ?? [];
      const permsOk = perms.length === 0 || isSuperAdmin || hasAllPermissions(perms);
      return roleOk && permsOk;
    });
  }, [role, isSuperAdmin, hasAllPermissions]);

  // Header height used everywhere to align columns
  const headerPx = 64; // 4rem
  const headerVar = { '--header-h': `${headerPx}px` } as React.CSSProperties;

  return (
    <div className="min-h-dvh bg-gray-100 overflow-hidden" style={headerVar}>
      {/* Grid: header row + content row; desktop adds sidebar column */}
      <div className="grid min-h-dvh grid-rows-[var(--header-h)_1fr] lg:grid-cols-[16rem_1fr] lg:grid-rows-[var(--header-h)_1fr]">

        {/* Header (spans both columns) */}
        <header className="row-start-1 col-span-full sticky top-0 z-40 bg-white shadow">
          <div className="h-[var(--header-h)] flex items-center justify-between px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <button
                className="lg:hidden rounded p-2 hover:bg-gray-100"
                onClick={() => setIsSidebarOpen(true)}
                aria-label="Open navigation"
              >
                <svg className="h-6 w-6" viewBox="0 0 24 24" stroke="currentColor" fill="none">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <Breadcrumbs />
            </div>

            <div className="flex items-center gap-3">
              <CommandPalette />
              <ThemeToggle />
              <button
                onClick={() => {
                  try {
                    localStorage.removeItem('adminToken');
                    localStorage.removeItem('adminUser');
                  } catch {}
                  router.push('/login');
                }}
                className="text-sm text-gray-700 hover:text-gray-900"
              >
                Logout
              </button>
            </div>
          </div>
        </header>

        {/* Sidebar (desktop) */}
        <aside className="hidden lg:block row-start-2 bg-gray-900 text-white sticky top-[var(--header-h)] h-[calc(100dvh-var(--header-h))] overflow-y-auto">
          <div className="flex h-16 items-center justify-center bg-gray-800">
            <h1 className="text-xl font-bold">VH Admin Portal</h1>
          </div>
          <nav className="mt-2 pb-4">
            {visibleNav.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`block px-6 py-3 text-sm transition-colors ${
                    isActive
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

        {/* Mobile drawer */}
        {isSidebarOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
              onClick={() => setIsSidebarOpen(false)}
              aria-hidden="true"
            />
            <div className="fixed inset-y-0 left-0 z-50 w-64 bg-gray-900 text-white shadow lg:hidden">
              <div className="flex h-[var(--header-h)] items-center justify-between px-4 bg-gray-800">
                <span className="font-semibold">VH Admin Portal</span>
                <button
                  onClick={() => setIsSidebarOpen(false)}
                  className="rounded p-2 hover:bg-gray-700"
                  aria-label="Close navigation"
                >
                  ✕
                </button>
              </div>
              <nav className="mt-2 pb-6">
                {visibleNav.map((item) => {
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setIsSidebarOpen(false)}
                      className={`block px-6 py-3 text-sm transition-colors ${
                        isActive
                          ? 'border-l-4 border-blue-500 bg-gray-800 text-white'
                          : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                      }`}
                    >
                      {item.name}
                    </Link>
                  );
                })}
              </nav>
            </div>
          </>
        )}

        {/* Main content area */}
        <main className="row-start-2 bg-gray-100 h-[calc(100dvh-var(--header-h))] overflow-y-auto px-4 sm:px-6 lg:px-8 py-6 lg:col-start-2">
          {children}
        </main>
      </div>

      {/* Dev-only helper */}
      <AuthDebugger />
    </div>
  );
}