// src/app/(with-auth)/dashboard/layout.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
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

// Treat a nav item as active if the pathname matches exactly OR is a nested route under it.
// e.g. '/dashboard/users/123' should mark '/dashboard/users' active, but '/dashboarding' should not.
function isItemActive(pathname: string, href: string) {
  if (pathname === href) return true;
  // Ensure we only match section roots, not similar prefixes.
  return pathname.startsWith(href + '/');
}

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

  // Close the mobile drawer when route changes.
  useEffect(() => {
    setIsSidebarOpen(false);
  }, [pathname]);

  // Allow Escape to close the mobile drawer.
  useEffect(() => {
    if (!isSidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsSidebarOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isSidebarOpen]);

  // Header height used everywhere to align columns
  const headerPx = 64; // 4rem
  const headerVar = { '--header-h': `${headerPx}px` } as React.CSSProperties;

  return (
    <div className="min-h-dvh bg-gray-100 overflow-hidden" style={headerVar}>
      {/* Skip link for a11y */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 bg-white rounded px-3 py-2 shadow"
      >
        Skip to content
      </a>

      {/* Grid: header row + content row; desktop adds sidebar column */}
      <div className="grid min-h-dvh grid-rows-[var(--header-h)_1fr] lg:grid-cols-[16rem_1fr] lg:grid-rows-[var(--header-h)_1fr]">
        {/* Header (spans both columns) */}
        <header role="banner" className="row-start-1 col-span-full sticky top-0 z-40 bg-white border-b">
          <div className="h-[var(--header-h)] flex items-center justify-between px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="lg:hidden rounded p-2 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                onClick={() => setIsSidebarOpen(true)}
                aria-label="Open navigation"
                aria-controls="mobile-sidebar"
                aria-expanded={isSidebarOpen}
              >
                <svg className="h-6 w-6" viewBox="0 0 24 24" stroke="currentColor" fill="none" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <Breadcrumbs />
            </div>

            <div className="flex items-center gap-3">
              {/* Discoverability for Command Palette */}
              <span className="hidden md:inline-flex items-center gap-1 text-xs text-gray-500">
                Press <kbd className="px-1.5 py-0.5 rounded border">⌘K</kbd>
              </span>
              <CommandPalette />
              <ThemeToggle />
              <button
                type="button"
                onClick={() => {
                  try {
                    localStorage.removeItem('adminToken');
                    localStorage.removeItem('adminUser');
                  } catch {}
                  router.push('/login');
                }}
                className="text-sm text-gray-700 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded px-2 py-1"
              >
                Logout
              </button>
            </div>
          </div>
        </header>

        {/* Sidebar (desktop) */}
        <aside
          aria-label="Primary navigation"
          role="navigation"
          className="hidden lg:block row-start-2 bg-gray-900 text-white sticky top-[var(--header-h)] h-[calc(100dvh-var(--header-h))] overflow-y-auto"
        >
          <div className="flex h-16 items-center justify-center bg-gray-800">
            <h1 className="text-xl font-bold">VH Admin Portal</h1>
          </div>
          <nav className="mt-2 pb-4">
            {visibleNav.map((item) => {
              const active = isItemActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`block px-6 py-3 text-sm transition-colors ${
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

        {/* Mobile drawer */}
        {isSidebarOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
              onClick={() => setIsSidebarOpen(false)}
              aria-hidden="true"
            />
            <div
              id="mobile-sidebar"
              role="dialog"
              aria-modal="true"
              aria-label="Mobile navigation"
              className="fixed inset-y-0 left-0 z-50 w-64 bg-gray-900 text-white shadow lg:hidden focus:outline-none"
            >
              <div className="flex h-[var(--header-h)] items-center justify-between px-4 bg-gray-800">
                <span className="font-semibold">VH Admin Portal</span>
                <button
                  type="button"
                  onClick={() => setIsSidebarOpen(false)}
                  className="rounded p-2 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-label="Close navigation"
                >
                  ✕
                </button>
              </div>
              <nav className="mt-2 pb-6">
                {visibleNav.map((item) => {
                  const active = isItemActive(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setIsSidebarOpen(false)}
                      aria-current={active ? 'page' : undefined}
                      className={`block px-6 py-3 text-sm transition-colors ${
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
            </div>
          </>
        )}

        {/* Main content area */}
        <main
          id="main-content"
          role="main"
          className="row-start-2 bg-gray-100 h-[calc(100dvh-var(--header-h))] overflow-y-auto px-4 sm:px-6 lg:px-8 py-6 lg:col-start-2"
        >
          {children}
        </main>
      </div>

      {/* Dev-only helper */}
      <AuthDebugger />
    </div>
  );
}
