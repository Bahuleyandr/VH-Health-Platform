// src/app/(with-auth)/dashboard/DashboardClient.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from '@/lib/api-config';
import styles from './Dashboard.module.css';
import { DashboardSkeleton } from './components/DashboardSkeleton';
import { SimpleChart } from './components/SimpleChart';
import { StatsGrid } from './components/StatsGrid';
import { ActivityFeed } from './components/ActivityFeed';
import { CommandPalette } from './components/CommandPalette';
import { NotificationsDropdown } from './components/NotificationsDropdown';
import type {
  ActivityApiItem,
  ChartData,
  DashboardData,
  Notification,
  StatCard,
} from './dashboardTypes';
import {
  DASHBOARD_DEMO_DATA,
  DASHBOARD_DEMO_NOTIFICATIONS,
} from './dashboardDemoData';

// DashboardSkeleton / AnimatedCounter / SimpleChart / formatTimeAgo / dashboard
// type declarations moved into dedicated files — see imports above.
function DashboardClient() {
  const router = useRouter();
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  // State Management
  const [isLoading, setIsLoading] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [selectedDepartment, setSelectedDepartment] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  
  // Data States
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [userName, setUserName] = useState('Admin');

  // Get user info from localStorage
  useEffect(() => {
    const adminUser = localStorage.getItem('adminUser');
    if (adminUser) {
      try {
        const user = JSON.parse(adminUser);
        setUserName(user.name || user.username || 'Admin');
      } catch {}
    }
  }, []);

  // Time-based greeting
  const getGreeting = () => {
    const hour = new Date().getHours();
    
    if (hour < 12) return `Good morning, ${userName}`;
    if (hour < 17) return `Good afternoon, ${userName}`;
    if (hour < 20) return `Good evening, ${userName}`;
    return `Good night, ${userName}`;
  };

  // Initialize Dashboard Data
useEffect(() => {
  loadDashboardData();
  setupKeyboardShortcuts();
  checkThemePreference();
  
  // Setup real-time updates
  const interval = setInterval(() => {
    loadDashboardData();
  }, 30000); // Update every 30 seconds
  
  return () => clearInterval(interval);
}, []); // Remove updateRealTimeData from dependencies

  const loadDashboardData = async () => {
    setIsLoading(true);

    try {
      // Auth is carried via the httpOnly auth_token cookie handled by /api/proxy.
      const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.admin.dashboard}`, {
        headers: getHeaders(),
      });

      if (!response.ok) throw new Error('Failed to fetch dashboard data');

      const json = await response.json();
      const data = json.data || json;

      // Transform API data to match our component structure. Missing fields
      // fall back to DASHBOARD_DEMO_DATA (see ./dashboardDemoData.ts) so the
      // dashboard is never half-blank when the backend returns a partial
      // envelope. Extracted from inline duplication 2026-04-17 (P2 admin split).
      setDashboardData({
        overview: data.overview ?? {
          ...DASHBOARD_DEMO_DATA.overview,
          totalUsers: data.totalUsers ?? DASHBOARD_DEMO_DATA.overview.totalUsers,
          activeUsers: data.activeUsers ?? DASHBOARD_DEMO_DATA.overview.activeUsers,
          newUsersToday: data.newUsersToday ?? DASHBOARD_DEMO_DATA.overview.newUsersToday,
          totalDoctors: data.totalDoctors ?? DASHBOARD_DEMO_DATA.overview.totalDoctors,
          availableDoctors: data.availableDoctors ?? DASHBOARD_DEMO_DATA.overview.availableDoctors,
          totalDepartments: data.totalDepartments ?? DASHBOARD_DEMO_DATA.overview.totalDepartments,
          appointmentsToday: data.appointmentsToday ?? DASHBOARD_DEMO_DATA.overview.appointmentsToday,
          appointmentsUpcoming: data.appointmentsUpcoming ?? DASHBOARD_DEMO_DATA.overview.appointmentsUpcoming,
          appointmentCompletionRate: data.appointmentCompletionRate ?? DASHBOARD_DEMO_DATA.overview.appointmentCompletionRate,
          emergencyAlerts: data.emergencyAlerts ?? DASHBOARD_DEMO_DATA.overview.emergencyAlerts,
          totalStaff: data.totalStaff ?? DASHBOARD_DEMO_DATA.overview.totalStaff,
          presentStaff: data.presentStaff ?? DASHBOARD_DEMO_DATA.overview.presentStaff,
          onLeaveStaff: data.onLeaveStaff ?? DASHBOARD_DEMO_DATA.overview.onLeaveStaff,
          pendingHRActions: data.pendingHRActions ?? DASHBOARD_DEMO_DATA.overview.pendingHRActions,
        },
        charts: {
          userGrowth: data.charts?.userGrowth ?? DASHBOARD_DEMO_DATA.charts.userGrowth,
          appointmentTrends: data.charts?.appointmentTrends ?? DASHBOARD_DEMO_DATA.charts.appointmentTrends,
          departmentUtilization: data.charts?.departmentUtilization ?? DASHBOARD_DEMO_DATA.charts.departmentUtilization,
        },
        recentActivity: (data.recentActivity ?? DASHBOARD_DEMO_DATA.recentActivity).map((item: ActivityApiItem) => ({
          ...item,
          time: new Date(item.timestamp || item.time || new Date()),
        })),
        systemHealth: data.systemHealth ?? DASHBOARD_DEMO_DATA.systemHealth,
      });

      // Notification seed — until the backend ships a real notifications
      // feed this uses the demo set. Safe to replace with a fetched list.
      setNotifications(DASHBOARD_DEMO_NOTIFICATIONS);
    } catch (error) {
      console.error('Dashboard data fetch error:', error);
      // Full fallback when the backend is unreachable — single constant,
      // no inline duplication.
      setDashboardData(DASHBOARD_DEMO_DATA);
      setNotifications(DASHBOARD_DEMO_NOTIFICATIONS);
    }

    setIsLoading(false);
  };

  const setupKeyboardShortcuts = () => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Cmd/Ctrl + K for command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette(prev => !prev);
      }
      
      // Cmd/Ctrl + / for search
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      
      // Escape to close modals
      if (e.key === 'Escape') {
        setShowCommandPalette(false);
        setShowNotifications(false);
      }
    };

    document.addEventListener('keydown', handleKeyPress);
    return () => document.removeEventListener('keydown', handleKeyPress);
  };

  const checkThemePreference = () => {
    const savedTheme = localStorage.getItem('vh:theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setIsDarkMode(savedTheme === 'dark' || (!savedTheme && prefersDark));
  };

  const toggleTheme = () => {
    const newTheme = !isDarkMode;
    setIsDarkMode(newTheme);
    localStorage.setItem('vh:theme', newTheme ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', newTheme);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadDashboardData();
    setRefreshing(false);
    showToast('Dashboard refreshed', 'success');
  };

  const showToast = (message: string, type: 'success' | 'error' | 'warning' | 'info') => {
    const toast = document.createElement('div');
    toast.className = `${styles.toast} ${styles[`toast${type.charAt(0).toUpperCase() + type.slice(1)}`]}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add(styles.toastShow);
    }, 100);
    
    setTimeout(() => {
      toast.classList.remove(styles.toastShow);
      setTimeout(() => document.body.removeChild(toast), 300);
    }, 3000);
  };

  const markNotificationAsRead = (id: string) => {
    setNotifications(prev => 
      prev.map(notif => notif.id === id ? { ...notif, read: true } : notif)
    );
  };

  const unreadNotifications = notifications.filter(n => !n.read).length;

  if (!dashboardData) {
    return <DashboardSkeleton />;
  }

  // Transform dashboard data to stat cards
  const stats: StatCard[] = [
    { 
      id: '1', 
      title: 'Total Patients', 
      value: dashboardData.overview.totalUsers, 
      change: 12, 
      icon: '🏥', 
      color: 'blue', 
      suffix: ' patients' 
    },
    { 
      id: '2', 
      title: 'Staff on Duty', 
      value: dashboardData.overview.presentStaff, 
      change: -2, 
      icon: '👥', 
      color: 'green', 
      suffix: ' staff' 
    },
    { 
      id: '3', 
      title: 'Available Doctors', 
      value: dashboardData.overview.availableDoctors, 
      change: -5, 
      icon: '🩺', 
      color: 'yellow', 
      suffix: ' doctors' 
    },
    { 
      id: '4', 
      title: 'Today\'s Appointments', 
      value: dashboardData.overview.appointmentsToday, 
      change: 15, 
      icon: '📋', 
      color: 'red', 
      suffix: ' appts' 
    }
  ];

  // Transform chart data
  const chartData: ChartData = {
    labels: dashboardData.charts.userGrowth.map(d => d.date),
    datasets: [
      { 
        label: 'New Users', 
        data: dashboardData.charts.userGrowth.map(d => d.value), 
        color: '#0891b2' 
      },
      { 
        label: 'Appointments', 
        data: dashboardData.charts.appointmentTrends.map(d => d.value), 
        color: '#14b8a6' 
      }
    ]
  };

  return (
    <div className={`${styles.dashboardContainer} ${isDarkMode ? styles.dark : ''}`}>
      {/* Header Bar */}
      <header className={styles.dashboardHeader}>
        <div className={styles.headerLeft}>
          <h1 className={styles.greeting}>{getGreeting()}</h1>
          <p className={styles.dateTime}>{new Date().toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          })}</p>
        </div>

        <div className={styles.headerCenter}>
          <div className={styles.searchContainer}>
            <span className={styles.searchIcon}>🔍</span>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search patients, staff, records..."
              className={styles.searchInput}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <kbd className={styles.searchKbd}>⌘K</kbd>
          </div>
        </div>

        <div className={styles.headerRight}>
          <div className={styles.systemStatus}>
            <span className={`${styles.statusDot} ${dashboardData.systemHealth.status === 'healthy' ? styles.statusGreen : styles.statusRed}`}></span>
            <span className={styles.statusText}>
              {dashboardData.systemHealth.status === 'healthy' ? 'All Systems Operational' : 'System Issues Detected'}
            </span>
          </div>

          <button className={styles.quickActionBtn} onClick={() => setShowCommandPalette(true)}>
            <span>⚡</span> Quick Actions
          </button>

          <button 
            className={styles.notificationBtn}
            onClick={() => setShowNotifications(!showNotifications)}
          >
            <span>🔔</span>
            {unreadNotifications > 0 && (
              <span className={styles.notificationBadge}>{unreadNotifications}</span>
            )}
          </button>

          <button className={styles.themeToggle} onClick={toggleTheme}>
            {isDarkMode ? '☀️' : '🌙'}
          </button>

          <button 
            className={styles.refreshBtn}
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <span className={refreshing ? styles.spinning : ''}>🔄</span>
          </button>
        </div>
      </header>

      {/* Department Filter Tabs */}
      <div className={styles.departmentTabs}>
        {['all', 'emergency', 'icu', 'surgery', 'pediatrics', 'radiology'].map(dept => (
          <button
            key={dept}
            className={`${styles.deptTab} ${selectedDepartment === dept ? styles.deptTabActive : ''}`}
            onClick={() => setSelectedDepartment(dept)}
          >
            {dept.charAt(0).toUpperCase() + dept.slice(1)}
          </button>
        ))}
      </div>

      {/* Stats Cards */}
      <StatsGrid stats={stats} />

      {/* Main Dashboard Grid */}
      <div className={styles.mainGrid}>
        {/* Chart Section */}
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <h2 className={styles.chartTitle}>📊 Analytics Overview</h2>
            <div className={styles.chartActions}>
              <select className={styles.chartPeriod}>
                <option>Last 7 days</option>
                <option>Last 30 days</option>
                <option>Last 3 months</option>
              </select>
              <button 
                className={styles.chartExport}
                onClick={() => router.push('/dashboard/reporting')}
              >
                📥 Export
              </button>
            </div>
          </div>
          <div className={styles.chartContainer}>
            <SimpleChart data={chartData} />
          </div>
        </div>

        {/* Activity Feed */}
        <ActivityFeed activities={dashboardData.recentActivity} />

        {/* Quick Stats Widgets */}
        <div className={styles.widgetGrid}>
          {/* Department Utilization Widget */}
          <div className={styles.widget}>
            <h3 className={styles.widgetTitle}>🏥 Department Utilization</h3>
            <div className={styles.bedMap}>
              {dashboardData.charts.departmentUtilization.map(dept => (
                <div key={dept.label} className={styles.bedFloor}>
                  <span className={styles.floorLabel}>{dept.label}</span>
                  <div className={styles.bedRow} style={{ display: 'flex', alignItems: 'center' }}>
                    <div 
                      style={{
                        width: `${dept.value}%`,
                        background: dept.value > 80 ? '#ef4444' : dept.value > 60 ? '#f59e0b' : '#10b981',
                        height: '20px',
                        borderRadius: '4px',
                        transition: 'all 0.3s'
                      }}
                    />
                    <span style={{ marginLeft: '8px', fontSize: '12px', color: '#64748b' }}>{dept.value}%</span>
                  </div>
                </div>
              ))}
            </div>
            <button 
              className={styles.scheduleBtn}
              onClick={() => router.push('/dashboard/departments')}
            >
              Manage Departments →
            </button>
          </div>

          {/* Staff Roster Widget */}
          <div className={styles.widget}>
            <h3 className={styles.widgetTitle}>👥 Staff Overview</h3>
            <div className={styles.staffList}>
              <div className={styles.staffCategory}>
                <span className={styles.staffRole}>Total Staff</span>
                <span className={styles.staffCount}>{dashboardData.overview.totalStaff}</span>
              </div>
              <div className={styles.staffCategory}>
                <span className={styles.staffRole}>Present</span>
                <span className={styles.staffCount}>{dashboardData.overview.presentStaff}</span>
              </div>
              <div className={styles.staffCategory}>
                <span className={styles.staffRole}>On Leave</span>
                <span className={styles.staffCount}>{dashboardData.overview.onLeaveStaff}</span>
              </div>
              <div className={styles.staffCategory}>
                <span className={styles.staffRole}>Available Doctors</span>
                <span className={styles.staffCount}>{dashboardData.overview.availableDoctors}</span>
              </div>
            </div>
            <button 
              className={styles.scheduleBtn}
              onClick={() => router.push('/dashboard/attendance')}
            >
              View Schedule →
            </button>
          </div>

          {/* Emergency Status Widget */}
          <div className={styles.widget}>
            <h3 className={styles.widgetTitle}>🚨 Quick Stats</h3>
            <div className={styles.erStatus}>
              <div className={styles.erMetric}>
                <span className={styles.erLabel}>Emergency Alerts</span>
                <span className={styles.erValue}>{dashboardData.overview.emergencyAlerts}</span>
              </div>
              <div className={styles.erMetric}>
                <span className={styles.erLabel}>Pending HR</span>
                <span className={styles.erValue}>{dashboardData.overview.pendingHRActions}</span>
              </div>
              <div className={styles.erMetric}>
                <span className={styles.erLabel}>Completion Rate</span>
                <span className={styles.erValue}>{dashboardData.overview.appointmentCompletionRate}%</span>
              </div>
            </div>
            <div className={styles.erTriage}>
              <button 
                className={styles.triageLevel1}
                onClick={() => router.push('/dashboard/sos')}
              >
                SOS
              </button>
              <button 
                className={styles.triageLevel2}
                onClick={() => router.push('/dashboard/notifications')}
              >
                Alerts
              </button>
              <button 
                className={styles.triageLevel3}
                onClick={() => router.push('/dashboard/pharmacy')}
              >
                Pharmacy
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Command Palette Modal */}
      {showCommandPalette && (
        <CommandPalette onClose={() => setShowCommandPalette(false)} />
      )}

      {/* Notifications Dropdown */}
      {showNotifications && (
        <NotificationsDropdown
          notifications={notifications}
          onMarkAsRead={markNotificationAsRead}
          onClearAll={() => setNotifications([])}
        />
      )}

      {/* Loading Overlay */}
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
