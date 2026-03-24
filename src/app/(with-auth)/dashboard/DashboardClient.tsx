// src/app/(with-auth)/dashboard/DashboardClient.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from '@/lib/api-config';
import styles from './Dashboard.module.css';

// Types & utils
import type { StatCard, ChartData, DashboardData, Notification, ActivityApiItem } from './components/types';

// Components
import { DashboardHeader } from './components/DashboardHeader';
import { StatsGrid } from './components/StatsGrid';
import { SimpleChart } from './components/SimpleChart';
import { ActivityFeed } from './components/ActivityFeed';
import { WidgetGrid } from './components/WidgetGrid';
import { CommandPalette } from './components/CommandPalette';
import { NotificationsDropdown } from './components/NotificationsDropdown';

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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDashboardData = async () => {
    setIsLoading(true);
    
    try {
      const token = localStorage.getItem('adminToken');
      
      // Fetch real dashboard data from API
      const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.admin.dashboard}`, {
        headers: getHeaders(token || undefined),
      });
      
      if (!response.ok) throw new Error('Failed to fetch dashboard data');
      
      const json = await response.json();
      const data = json.data || json;
      
      // Transform API data to match our component structure
      setDashboardData({
        overview: data.overview || {
          totalUsers: data.totalUsers || 1284,
          activeUsers: data.activeUsers || 892,
          newUsersToday: data.newUsersToday || 12,
          totalDoctors: data.totalDoctors || 48,
          availableDoctors: data.availableDoctors || 23,
          totalDepartments: data.totalDepartments || 12,
          appointmentsToday: data.appointmentsToday || 67,
          appointmentsUpcoming: data.appointmentsUpcoming || 134,
          appointmentCompletionRate: data.appointmentCompletionRate || 87,
          emergencyAlerts: data.emergencyAlerts || 2,
          totalStaff: data.totalStaff || 89,
          presentStaff: data.presentStaff || 76,
          onLeaveStaff: data.onLeaveStaff || 13,
          pendingHRActions: data.pendingHRActions || 5
        },
        charts: {
          userGrowth: data.charts?.userGrowth || [
            { date: 'Mon', value: 65 },
            { date: 'Tue', value: 78 },
            { date: 'Wed', value: 90 },
            { date: 'Thu', value: 81 },
            { date: 'Fri', value: 84 },
            { date: 'Sat', value: 78 },
            { date: 'Sun', value: 95 }
          ],
          appointmentTrends: data.charts?.appointmentTrends || [
            { date: 'Mon', value: 58 },
            { date: 'Tue', value: 68 },
            { date: 'Wed', value: 77 },
            { date: 'Thu', value: 89 },
            { date: 'Fri', value: 76 },
            { date: 'Sat', value: 77 },
            { date: 'Sun', value: 88 }
          ],
          departmentUtilization: data.charts?.departmentUtilization || [
            { label: 'Emergency', value: 85 },
            { label: 'ICU', value: 92 },
            { label: 'Surgery', value: 78 },
            { label: 'Pediatrics', value: 65 },
            { label: 'Radiology', value: 71 }
          ]
        },
        recentActivity: (data.recentActivity || [
          { id: '1', user: 'Nurse Kelly', action: 'updated', target: 'patient record #1234', department: 'ICU' },
          { id: '2', user: 'Dr. Chen', action: 'prescribed', target: 'medication for #5678', department: 'Emergency' },
          { id: '3', user: 'Admin Ross', action: 'scheduled', target: 'maintenance for MRI', department: 'Radiology' }
        ]).map((item: ActivityApiItem) => ({
          ...item,
          time: new Date(item.timestamp || item.time || new Date())
        })),
        systemHealth: data.systemHealth || {
          status: 'healthy',
          uptime: '99.99%',
          responseTime: 45,
          errorRate: 0.1
        }
      });

      // Set notifications
      setNotifications([
        { id: '1', type: 'critical', title: 'Emergency Alert', message: 'Code Blue - Room 302', time: new Date(), read: false },
        { id: '2', type: 'warning', title: 'Low Supplies', message: 'Oxygen tanks below 20% in ICU', time: new Date(), read: false },
        { id: '3', type: 'info', title: 'Staff Update', message: 'Dr. Johnson has arrived for shift', time: new Date(), read: true }
      ]);

    } catch (error) {
      console.error('Dashboard data fetch error:', error);
      // Use fallback demo data if API fails
      setDashboardData({
        overview: {
          totalUsers: 1284,
          activeUsers: 892,
          newUsersToday: 12,
          totalDoctors: 48,
          availableDoctors: 23,
          totalDepartments: 12,
          appointmentsToday: 67,
          appointmentsUpcoming: 134,
          appointmentCompletionRate: 87,
          emergencyAlerts: 2,
          totalStaff: 89,
          presentStaff: 76,
          onLeaveStaff: 13,
          pendingHRActions: 5
        },
        charts: {
          userGrowth: [
            { date: 'Mon', value: 65 },
            { date: 'Tue', value: 78 },
            { date: 'Wed', value: 90 },
            { date: 'Thu', value: 81 },
            { date: 'Fri', value: 84 },
            { date: 'Sat', value: 78 },
            { date: 'Sun', value: 95 }
          ],
          appointmentTrends: [
            { date: 'Mon', value: 58 },
            { date: 'Tue', value: 68 },
            { date: 'Wed', value: 77 },
            { date: 'Thu', value: 89 },
            { date: 'Fri', value: 76 },
            { date: 'Sat', value: 77 },
            { date: 'Sun', value: 88 }
          ],
          departmentUtilization: [
            { label: 'Emergency', value: 85 },
            { label: 'ICU', value: 92 },
            { label: 'Surgery', value: 78 },
            { label: 'Pediatrics', value: 65 },
            { label: 'Radiology', value: 71 }
          ]
        },
        recentActivity: [
          { id: '1', user: 'Nurse Kelly', action: 'updated', target: 'patient record #1234', time: new Date(), department: 'ICU' },
          { id: '2', user: 'Dr. Chen', action: 'prescribed', target: 'medication for #5678', time: new Date(), department: 'Emergency' },
          { id: '3', user: 'Admin Ross', action: 'scheduled', target: 'maintenance for MRI', time: new Date(), department: 'Radiology' }
        ],
        systemHealth: {
          status: 'healthy',
          uptime: '99.99%',
          responseTime: 45,
          errorRate: 0.1
        }
      });

      setNotifications([
        { id: '1', type: 'critical', title: 'Emergency Alert', message: 'Code Blue - Room 302', time: new Date(), read: false },
        { id: '2', type: 'warning', title: 'Low Supplies', message: 'Oxygen tanks below 20% in ICU', time: new Date(), read: false },
        { id: '3', type: 'info', title: 'Staff Update', message: 'Dr. Johnson has arrived for shift', time: new Date(), read: true }
      ]);
    }

    setIsLoading(false);
  };

  const setupKeyboardShortcuts = () => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette(prev => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
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
    return (
      <div className={styles.loadingOverlay}>
        <div className={styles.loadingSpinner}>
          <div className={styles.hospitalLogo}>🏥</div>
          <p>Loading Dashboard...</p>
        </div>
      </div>
    );
  }

  // Transform dashboard data to stat cards
  const stats: StatCard[] = [
    { id: '1', title: 'Total Patients', value: dashboardData.overview.totalUsers, change: 12, icon: '🏥', color: 'blue', suffix: ' patients' },
    { id: '2', title: 'Staff on Duty', value: dashboardData.overview.presentStaff, change: -2, icon: '👥', color: 'green', suffix: ' staff' },
    { id: '3', title: 'Available Doctors', value: dashboardData.overview.availableDoctors, change: -5, icon: '🩺', color: 'yellow', suffix: ' doctors' },
    { id: '4', title: 'Today\'s Appointments', value: dashboardData.overview.appointmentsToday, change: 15, icon: '📋', color: 'red', suffix: ' appts' }
  ];

  // Transform chart data
  const chartData: ChartData = {
    labels: dashboardData.charts.userGrowth.map(d => d.date),
    datasets: [
      { label: 'New Users', data: dashboardData.charts.userGrowth.map(d => d.value), color: '#0891b2' },
      { label: 'Appointments', data: dashboardData.charts.appointmentTrends.map(d => d.value), color: '#14b8a6' }
    ]
  };

  return (
    <div className={`${styles.dashboardContainer} ${isDarkMode ? styles.dark : ''}`}>
      <DashboardHeader
        greeting={getGreeting()}
        searchInputRef={searchInputRef}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        dashboardData={dashboardData}
        onShowCommandPalette={() => setShowCommandPalette(true)}
        showNotifications={showNotifications}
        onToggleNotifications={() => setShowNotifications(!showNotifications)}
        unreadNotifications={unreadNotifications}
        isDarkMode={isDarkMode}
        onToggleTheme={toggleTheme}
        refreshing={refreshing}
        onRefresh={handleRefresh}
      />

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

        <ActivityFeed activities={dashboardData.recentActivity} />

        <WidgetGrid dashboardData={dashboardData} />
      </div>

      {/* Modals & Overlays */}
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
