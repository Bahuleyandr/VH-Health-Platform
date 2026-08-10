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
import { NAV_SECTIONS, type NavItem, type NavSection } from '@/lib/navConfig';
import styles from './Dashboard.module.css';

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
  const supportEmail = tenant?.branding?.supportEmail || null;
  const helpCenterUrl = tenant?.branding?.helpCenterUrl || null;
  const legalFooter = tenant?.branding?.legalFooter || null;

  // Auto-logout after 30 minutes of inactivity
  useIdleTimeout(30 * 60 * 1000);

  const visibleSections = useMemo<NavSection[]>(() => {
    const itemVisible = (item: NavItem) => {
      if (isSuperAdmin) return true;
      // An explicit role allowlist replaces the tier checks (mirrors
      // ROUTE_POLICY `roles` entries, e.g. the clinical-AI control plane).
      if (item.allowedRoles) return item.allowedRoles.includes(role ?? '');
      const roleOk = !item.requiredRole || role === item.requiredRole;
      const minRoleOk = !item.minRole || (ROLE_RANK[role ?? ''] ?? -1) >= ROLE_RANK[item.minRole];
      const perms = item.requiredPermissions ?? [];
      const permsOk = perms.length === 0 || hasAllPermissions(perms);
      return roleOk && minRoleOk && permsOk;
    };
    return NAV_SECTIONS.map((section) => ({
      ...section,
      items: section.items.filter(itemVisible),
    })).filter((section) => section.items.length > 0);
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
            {visibleSections.map((section) => (
              <Fragment key={section.title}>
                <p className={styles.navSectionTitle}>{section.title}</p>
                {section.items.map((item) => {
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
              </Fragment>
            ))}
          </nav>
          {(supportEmail || helpCenterUrl || legalFooter) && (
            <div className={styles.sidebarFooter}>
              {helpCenterUrl && (
                <a className={styles.sidebarFooterLink} href={helpCenterUrl} target="_blank" rel="noreferrer">
                  Help
                </a>
              )}
              {supportEmail && (
                <a className={styles.sidebarFooterLink} href={`mailto:${supportEmail}`}>
                  {supportEmail}
                </a>
              )}
              {legalFooter && <p className={styles.sidebarLegal}>{legalFooter}</p>}
            </div>
          )}
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
                {visibleSections.map((section) => (
                  <Fragment key={section.title}>
                    <p className={styles.navSectionTitle}>{section.title}</p>
                    {section.items.map((item) => {
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
                  </Fragment>
                ))}
              </nav>
              {(supportEmail || helpCenterUrl || legalFooter) && (
                <div className={styles.sidebarFooter}>
                  {helpCenterUrl && (
                    <a className={styles.sidebarFooterLink} href={helpCenterUrl} target="_blank" rel="noreferrer">
                      Help
                    </a>
                  )}
                  {supportEmail && (
                    <a className={styles.sidebarFooterLink} href={`mailto:${supportEmail}`}>
                      {supportEmail}
                    </a>
                  )}
                  {legalFooter && <p className={styles.sidebarLegal}>{legalFooter}</p>}
                </div>
              )}
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
