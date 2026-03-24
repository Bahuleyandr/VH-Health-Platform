// src/app/(with-auth)/dashboard/layout.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CommandPalette } from '@/components/CommandPalette';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { AuthDebugger } from '@/components/auth/AuthDebugger';
import { usePermissions } from '@/hooks/usePermissions';
import { useAuth } from '@/contexts/AuthContext';
import { AnnouncementBanner } from './notifications/components/AnnouncementBannerManager';
import styles from './Dashboard.module.css';

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
  { name: 'Analytics', href: '/dashboard/analytics', requiredPermissions: ['viewAuditLogs'] },
  { name: 'Staff Roster', href: '/dashboard/staff-roster', requiredPermissions: ['userManagement'] },
  { name: 'Bed Management', href: '/dashboard/beds', requiredPermissions: ['departmentManagement'] },
  { name: 'Notifications', href: '/dashboard/notifications', requiredPermissions: ['notificationManagement'] },
  { name: 'Admin Management', href: '/dashboard/admin-management', requiredRole: 'ADMIN', requiredPermissions: ['adminManagement'] },
  { name: 'System Logs', href: '/dashboard/system-logs', requiredPermissions: ['viewAuditLogs'] },
  { name: 'Settings', href: '/dashboard/settings', requiredRole: 'ADMIN' },
];

function isItemActive(pathname: string, href: string) {
  if (pathname === href) return true;
  return pathname.startsWith(href + '/');
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const { role, isSuperAdmin, hasAllPermissions } = usePermissions();
  const { logout } = useAuth();

  const visibleNav = useMemo(() => {
    return navigation.filter((item) => {
      const roleOk = !item.requiredRole || isSuperAdmin || role === item.requiredRole;
      const perms = item.requiredPermissions ?? [];
      const permsOk = perms.length === 0 || isSuperAdmin || hasAllPermissions(perms);
      return roleOk && permsOk;
    });
  }, [role, isSuperAdmin, hasAllPermissions]);

  useEffect(() => {
    setIsSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isSidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsSidebarOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isSidebarOpen]);

  return (
    <div className={styles.container}>
      {/* Skip link for accessibility */}
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>

      <div className={styles.grid}>
        {/* Header */}
        <header role="banner" className={styles.header}>
          <div className={styles.headerContent}>
            <div className={styles.headerLeft}>
              <button
                type="button"
                className={styles.menuButton}
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

            <div className={styles.headerRight}>
              <span className={styles.keyboardHint}>
                Press <kbd className={styles.kbd}>⌘K</kbd>
              </span>
              <CommandPalette />
              <ThemeToggle />
              <button
                type="button"
                onClick={() => void logout()}
                className={styles.logoutButton}
              >
                Logout
              </button>
            </div>
          </div>
        </header>

        {/* Desktop Sidebar */}
        <aside aria-label="Primary navigation" role="navigation" className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <h1 className={styles.sidebarTitle}>VH Admin Portal</h1>
          </div>
          <nav className={styles.nav}>
            {visibleNav.map((item) => {
              const active = isItemActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                >
                  {item.name}
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* Mobile Drawer */}
        {isSidebarOpen && (
          <>
            <div
              className={styles.mobileOverlay}
              onClick={() => setIsSidebarOpen(false)}
              aria-hidden="true"
            />
            <div
              id="mobile-sidebar"
              role="dialog"
              aria-modal="true"
              aria-label="Mobile navigation"
              className={styles.mobileDrawer}
            >
              <div className={styles.mobileHeader}>
                <span className={styles.sidebarTitle}>VH Admin Portal</span>
                <button
                  type="button"
                  onClick={() => setIsSidebarOpen(false)}
                  className={styles.closeButton}
                  aria-label="Close navigation"
                >
                  ✕
                </button>
              </div>
              <nav className={styles.nav}>
                {visibleNav.map((item) => {
                  const active = isItemActive(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setIsSidebarOpen(false)}
                      aria-current={active ? 'page' : undefined}
                      className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                    >
                      {item.name}
                    </Link>
                  );
                })}
              </nav>
            </div>
          </>
        )}

        {/* Main Content */}
        <main id="main-content" role="main" className={styles.main}>
          <AnnouncementBanner />
          {children}
        </main>
      </div>

      {/* Dev-only helper */}
      <AuthDebugger />
    </div>
  );
}