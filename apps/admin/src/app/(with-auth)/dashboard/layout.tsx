// src/app/(with-auth)/dashboard/layout.tsx
'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CommandPalette } from '@/components/CommandPalette';
import { KeyboardShortcutsModal } from '@/components/KeyboardShortcutsModal';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { AuthDebugger } from '@/components/auth/AuthDebugger';
import { MenuIcon } from '@/components/icons';
import { usePermissions } from '@/hooks/usePermissions';
import { useIdleTimeout } from '@/hooks/useIdleTimeout';
import { useAuth } from '@/contexts/AuthContext';
import { useTenant } from '@/contexts/TenantContext';
import { AnnouncementBanner } from './notifications/components/AnnouncementBannerManager';
import { ROLE_RANK } from '@/lib/routePolicy';
import styles from './Dashboard.module.css';

type NavItem = {
  name: string;
  href: string;
  /** Optional role requirement (SUPER_ADMIN always allowed) */
  requiredRole?: 'ADMIN' | 'SUPER_ADMIN';
  /** Optional minimum portal tier (SUPER_ADMIN always allowed) */
  minRole?: 'STAFF' | 'DOCTOR' | 'HR' | 'ADMIN' | 'SUPER_ADMIN';
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
  { name: 'Reporting', href: '/dashboard/reporting', minRole: 'HR' },
  { name: 'Analytics', href: '/dashboard/analytics', requiredPermissions: ['viewAuditLogs'] },
  { name: 'Report Builder', href: '/dashboard/report-builder', requiredPermissions: ['viewAuditLogs'] },
  { name: 'Staff Roster', href: '/dashboard/staff-roster', minRole: 'HR' },
  { name: 'Attendance', href: '/dashboard/attendance', requiredPermissions: ['userManagement'] },
  { name: 'Leave Approvals', href: '/dashboard/leave-approvals', minRole: 'HR' },
  { name: 'Shift Management', href: '/dashboard/shifts', minRole: 'HR' },
  { name: 'Reports Audit', href: '/dashboard/audit', requiredRole: 'ADMIN' },
  { name: 'System Audit Log', href: '/dashboard/system-audit', requiredRole: 'ADMIN' },
  { name: 'Attendance Audit', href: '/dashboard/attendance-audit', requiredRole: 'ADMIN' },
  { name: 'Incident Reports', href: '/dashboard/incidents', minRole: 'HR' },
  { name: 'Housekeeping', href: '/dashboard/housekeeping', minRole: 'HR' },
  { name: 'Grievances (HR)', href: '/dashboard/grievances', minRole: 'HR' },
  { name: 'Bed Management', href: '/dashboard/beds', requiredPermissions: ['departmentManagement'] },
  { name: 'Notifications', href: '/dashboard/notifications', requiredPermissions: ['notificationManagement'] },
  { name: 'Payroll & HR Comp', href: '/dashboard/payroll', requiredRole: 'ADMIN' },
  { name: 'Admin Management', href: '/dashboard/admin-management', requiredRole: 'ADMIN', requiredPermissions: ['adminManagement'] },
  { name: 'System Logs', href: '/dashboard/system-logs', requiredPermissions: ['viewAuditLogs'] },
  { name: 'Database', href: '/dashboard/database', requiredRole: 'SUPER_ADMIN' },
  { name: 'Feature Flags', href: '/dashboard/feature-flags', requiredRole: 'ADMIN' },
  { name: 'Compliance', href: '/dashboard/compliance', requiredRole: 'ADMIN' },
  { name: 'Clinical AI', href: '/dashboard/clinical-ai', requiredRole: 'ADMIN' },
  { name: 'Consent', href: '/dashboard/consent', requiredPermissions: ['userManagement'] },
  { name: 'Feedback', href: '/dashboard/feedback', requiredPermissions: ['userManagement'] },
  { name: 'Devices', href: '/dashboard/devices', requiredRole: 'ADMIN' },
  { name: 'ABDM', href: '/dashboard/abdm', requiredRole: 'ADMIN' },
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

  // W5 S2: brand the chrome from the tenant's settings.branding; fall back to
  // the product name when unbranded / still loading (NO-OP for the default tenant).
  const { tenant } = useTenant();
  const brandName = tenant?.branding?.name || 'VH Admin Portal';
  const brandLogo = tenant?.branding?.logoUrl || null;

  // Auto-logout after 30 minutes of inactivity
  useIdleTimeout(30 * 60 * 1000);

  const visibleNav = useMemo(() => {
    return navigation.filter((item) => {
      const roleOk = !item.requiredRole || isSuperAdmin || role === item.requiredRole;
      const minRoleOk = !item.minRole || isSuperAdmin || (ROLE_RANK[role ?? ''] ?? -1) >= ROLE_RANK[item.minRole];
      const perms = item.requiredPermissions ?? [];
      const permsOk = perms.length === 0 || isSuperAdmin || hasAllPermissions(perms);
      return roleOk && minRoleOk && permsOk;
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
      <a key="skip-link" href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>

      <div key="dashboard-grid" className={styles.grid}>
        {/* Header */}
        <header key="dashboard-header" role="banner" className={styles.header}>
          <div className={styles.headerContent}>
            <div key="header-left" className={styles.headerLeft}>
              <button
                key="open-navigation"
                type="button"
                className={styles.menuButton}
                onClick={() => setIsSidebarOpen(true)}
                aria-label="Open navigation"
                aria-controls="mobile-sidebar"
                aria-expanded={isSidebarOpen}
              >
                <MenuIcon className="h-6 w-6" aria-hidden="true" />
              </button>
              <Breadcrumbs key="breadcrumbs" />
            </div>

            <div key="header-right" className={styles.headerRight}>
              <span key="keyboard-hint" className={styles.keyboardHint}>
                Press <kbd key="command-palette-shortcut" className={styles.kbd}>⌘K</kbd>
              </span>
              <CommandPalette key="command-palette" />
              <ThemeToggle key="theme-toggle" />
              <button
                key="logout"
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
        <aside
          key="desktop-sidebar"
          aria-label="Primary navigation"
          role="navigation"
          className={styles.sidebar}
        >
          <div key="sidebar-header" className={styles.sidebarHeader}>
            <h1 className={styles.sidebarTitle}>
              {brandLogo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={brandLogo}
                  alt=""
                  style={{ maxHeight: 24, marginRight: 8, verticalAlign: 'middle', display: 'inline-block' }}
                />
              )}
              {brandName}
            </h1>
          </div>
          <nav key="desktop-nav" className={styles.nav}>
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
          <Fragment key="mobile-sidebar">
            <div
              key="mobile-overlay"
              className={styles.mobileOverlay}
              onClick={() => setIsSidebarOpen(false)}
              aria-hidden="true"
            />
            <div
              key="mobile-drawer"
              id="mobile-sidebar"
              role="dialog"
              aria-modal="true"
              aria-label="Mobile navigation"
              className={styles.mobileDrawer}
            >
              <div key="mobile-header" className={styles.mobileHeader}>
                <span key="mobile-title" className={styles.sidebarTitle}>{brandName}</span>
                <button
                  key="mobile-close"
                  type="button"
                  onClick={() => setIsSidebarOpen(false)}
                  className={styles.closeButton}
                  aria-label="Close navigation"
                >
                  ✕
                </button>
              </div>
              <nav key="mobile-nav" className={styles.nav}>
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
          </Fragment>
        )}

        {/* Main Content */}
        <main key="main-content" id="main-content" role="main" className={styles.main}>
          <AnnouncementBanner key="announcement-banner" />
          <Fragment key="dashboard-page-content">{children}</Fragment>
        </main>
      </div>

      {/* Dev-only helper */}
      <AuthDebugger key="auth-debugger" />

      {/* Keyboard shortcuts help modal — press ? to open */}
      <KeyboardShortcutsModal key="keyboard-shortcuts" />
    </div>
  );
}
