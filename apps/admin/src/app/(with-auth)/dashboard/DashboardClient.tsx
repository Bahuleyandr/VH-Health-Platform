// src/app/(with-auth)/dashboard/DashboardClient.tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_BASE_URL, API_ENDPOINTS, getHeaders } from '@/lib/api-config';
import styles from './Dashboard.module.css';
import { DashboardHeader } from './components/DashboardHeader';
import { DashboardMainGrid } from './components/DashboardMainGrid';
import { DashboardSkeleton } from './components/DashboardSkeleton';
import { DepartmentTabs } from './components/DepartmentTabs';
import { StatsGrid } from './components/StatsGrid';
import { CommandPalette } from './components/CommandPalette';
import { NotificationsDropdown } from './components/NotificationsDropdown';
import type { DashboardData, Notification } from './dashboardTypes';
import {
  DASHBOARD_DEMO_DATA,
  DASHBOARD_DEMO_NOTIFICATIONS,
} from './dashboardDemoData';
import {
  buildChartData,
  buildStatCards,
  getDashboardGreeting,
  normalizeDashboardData,
} from './dashboardDataAdapter';

function readAdminName() {
  const adminUser = localStorage.getItem('adminUser');
  if (!adminUser) return 'Admin';

  try {
    const user = JSON.parse(adminUser) as { name?: string; username?: string };
    return user.name || user.username || 'Admin';
  } catch {
    return 'Admin';
  }
}

function DashboardClient() {
  const router = useRouter();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [userName, setUserName] = useState('Admin');

  useEffect(() => {
    setUserName(readAdminName());
  }, []);

  const loadDashboardData = useCallback(async () => {
    setIsLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.admin.dashboard}`, {
        headers: getHeaders(),
      });

      if (!response.ok) throw new Error('Failed to fetch dashboard data');

      const json = await response.json();
      const data = json.data || json;

      setDashboardData(normalizeDashboardData(data));
      setNotifications(DASHBOARD_DEMO_NOTIFICATIONS);
    } catch (error) {
      console.error('Dashboard data fetch error:', error);
      setDashboardData(DASHBOARD_DEMO_DATA);
      setNotifications(DASHBOARD_DEMO_NOTIFICATIONS);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setupKeyboardShortcuts = useCallback(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setShowCommandPalette((prev) => !prev);
      }

      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
      }

      if (event.key === 'Escape') {
        setShowCommandPalette(false);
        setShowNotifications(false);
      }
    };

    document.addEventListener('keydown', handleKeyPress);
    return () => document.removeEventListener('keydown', handleKeyPress);
  }, []);

  const checkThemePreference = useCallback(() => {
    const savedTheme = localStorage.getItem('vh:theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldUseDark = savedTheme === 'dark' || (!savedTheme && prefersDark);

    setIsDarkMode(shouldUseDark);
    document.documentElement.classList.toggle('dark', shouldUseDark);
  }, []);

  useEffect(() => {
    void loadDashboardData();
    const cleanupKeyboardShortcuts = setupKeyboardShortcuts();
    checkThemePreference();

    const interval = setInterval(() => {
      void loadDashboardData();
    }, 30000);

    return () => {
      cleanupKeyboardShortcuts();
      clearInterval(interval);
    };
  }, [checkThemePreference, loadDashboardData, setupKeyboardShortcuts]);

  const toggleTheme = useCallback(() => {
    setIsDarkMode((currentTheme) => {
      const nextTheme = !currentTheme;
      localStorage.setItem('vh:theme', nextTheme ? 'dark' : 'light');
      document.documentElement.classList.toggle('dark', nextTheme);
      return nextTheme;
    });
  }, []);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'warning' | 'info') => {
    const toast = document.createElement('div');
    toast.className = `${styles.toast} ${styles[`toast${type.charAt(0).toUpperCase() + type.slice(1)}`]}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add(styles.toastShow);
    }, 100);

    setTimeout(() => {
      toast.classList.remove(styles.toastShow);
      setTimeout(() => {
        if (document.body.contains(toast)) document.body.removeChild(toast);
      }, 300);
    }, 3000);
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadDashboardData();
    setRefreshing(false);
    showToast('Dashboard refreshed', 'success');
  }, [loadDashboardData, showToast]);

  const markNotificationAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((notification) =>
        notification.id === id ? { ...notification, read: true } : notification,
      ),
    );
  }, []);

  const unreadNotifications = useMemo(
    () => notifications.filter((notification) => !notification.read).length,
    [notifications],
  );

  const greeting = useMemo(() => getDashboardGreeting(userName), [userName]);
  const stats = useMemo(
    () => (dashboardData ? buildStatCards(dashboardData) : []),
    [dashboardData],
  );
  const chartData = useMemo(
    () => (dashboardData ? buildChartData(dashboardData) : null),
    [dashboardData],
  );

  if (!dashboardData || !chartData) {
    return <DashboardSkeleton />;
  }

  return (
    <div className={`${styles.dashboardContainer} ${isDarkMode ? styles.dark : ''}`}>
      <DashboardHeader
        greeting={greeting}
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        dashboardData={dashboardData}
        onShowCommandPalette={() => setShowCommandPalette(true)}
        showNotifications={showNotifications}
        onToggleNotifications={() => setShowNotifications((prev) => !prev)}
        unreadNotifications={unreadNotifications}
        isDarkMode={isDarkMode}
        onToggleTheme={toggleTheme}
        refreshing={refreshing}
        onRefresh={handleRefresh}
      />

      <DepartmentTabs
        selectedDepartment={selectedDepartment}
        onSelectDepartment={setSelectedDepartment}
      />

      <StatsGrid stats={stats} />

      <DashboardMainGrid
        chartData={chartData}
        dashboardData={dashboardData}
        onExport={() => router.push('/dashboard/reporting')}
      />

      {showCommandPalette && (
        <CommandPalette onClose={() => setShowCommandPalette(false)} />
      )}

      {showNotifications && (
        <NotificationsDropdown
          notifications={notifications}
          onMarkAsRead={markNotificationAsRead}
          onClearAll={() => setNotifications([])}
        />
      )}

      {isLoading && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingSpinner}>
            <div className={styles.hospitalLogo}>🏥</div>
            <p>Loading Dashboard...</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default DashboardClient;
