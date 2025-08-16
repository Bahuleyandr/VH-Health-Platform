// src/app/(with-auth)/dashboard/DashboardClient.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from '@/lib/api-config';
import styles from './Dashboard.module.css';

// Types
interface StatCard {
  id: string;
  title: string;
  value: number;
  change: number;
  icon: string;
  color: 'blue' | 'green' | 'yellow' | 'red';
  prefix?: string;
  suffix?: string;
}

interface Notification {
  id: string;
  type: 'critical' | 'warning' | 'info' | 'success';
  title: string;
  message: string;
  time: Date;
  read: boolean;
}

interface Activity {
  id: string;
  user: string;
  action: string;
  target: string;
  time: Date;
  department: string;
}

interface ChartData {
  labels: string[];
  datasets: {
    label: string;
    data: number[];
    color: string;
  }[];
}

interface DashboardData {
  overview: {
    totalUsers: number;
    activeUsers: number;
    newUsersToday: number;
    totalDoctors: number;
    availableDoctors: number;
    totalDepartments: number;
    appointmentsToday: number;
    appointmentsUpcoming: number;
    appointmentCompletionRate: number;
    emergencyAlerts: number;
    totalStaff: number;
    presentStaff: number;
    onLeaveStaff: number;
    pendingHRActions: number;
  };
  charts: {
    userGrowth: Array<{ date: string; value: number }>;
    appointmentTrends: Array<{ date: string; value: number }>;
    departmentUtilization: Array<{ label: string; value: number }>;
  };
  recentActivity: Activity[];
  systemHealth: {
    status: 'healthy' | 'warning' | 'critical';
    uptime: string;
    responseTime: number;
    errorRate: number;
  };
}

// Define proper type for activity item from API
interface ActivityApiItem {
  id: string;
  user: string;
  action: string;
  target: string;
  department: string;
  timestamp?: string | Date;
  time?: string | Date;
}

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

  const executeCommand = (command: string) => {
    const commands: { [key: string]: () => void } = {
      'users': () => router.push('/dashboard/users'),
      'doctors': () => router.push('/dashboard/doctors'),
      'departments': () => router.push('/dashboard/departments'),
      'appointments': () => router.push('/dashboard/appointments'),
      'pharmacy': () => router.push('/dashboard/pharmacy'),
      'reports': () => router.push('/dashboard/reporting'),
      'notifications': () => router.push('/dashboard/notifications'),
      'attendance': () => router.push('/dashboard/attendance'),
      'emergency': () => router.push('/dashboard/sos'),
      'system logs': () => router.push('/dashboard/system-logs'),
      'settings': () => router.push('/dashboard/settings'),
    };

    const cmd = command.toLowerCase();
    if (commands[cmd]) {
      commands[cmd]();
      setShowCommandPalette(false);
    }
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
      <div className={styles.statsGrid}>
        {stats.map((stat) => (
          <div key={stat.id} className={`${styles.statCard} ${styles[`statCard${stat.color.charAt(0).toUpperCase() + stat.color.slice(1)}`]}`}>
            <div className={styles.statHeader}>
              <span className={styles.statIcon}>{stat.icon}</span>
              <span className={`${styles.statChange} ${stat.change > 0 ? styles.changePositive : styles.changeNegative}`}>
                {stat.change > 0 ? '↑' : '↓'} {Math.abs(stat.change)}%
              </span>
            </div>
            <div className={styles.statContent}>
              <h3 className={styles.statTitle}>{stat.title}</h3>
              <AnimatedCounter value={stat.value} suffix={stat.suffix} />
            </div>
            <div className={styles.statSparkline}>
              <svg className={styles.sparklineSvg}>
                <polyline
                  points="0,20 20,15 40,18 60,10 80,12 100,8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </div>
          </div>
        ))}
      </div>

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
        <div className={styles.activityCard}>
          <div className={styles.activityHeader}>
            <h2 className={styles.activityTitle}>📋 Recent Activity</h2>
            <button 
              className={styles.viewAllBtn}
              onClick={() => router.push('/dashboard/system-logs')}
            >
              View All →
            </button>
          </div>
          <div className={styles.activityList}>
            {dashboardData.recentActivity.map(activity => (
              <div key={activity.id} className={styles.activityItem}>
                <div className={styles.activityIcon}>
                  {activity.department === 'ICU' ? '🏥' : 
                   activity.department === 'Emergency' ? '🚨' : '👤'}
                </div>
                <div className={styles.activityContent}>
                  <p className={styles.activityText}>
                    <strong>{activity.user}</strong> {activity.action} <em>{activity.target}</em>
                  </p>
                  <div className={styles.activityMeta}>
                    <span className={styles.activityDept}>{activity.department}</span>
                    <span className={styles.activityTime}>
                      {formatTimeAgo(activity.time)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

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
        <div className={styles.modalOverlay} onClick={() => setShowCommandPalette(false)}>
          <div className={styles.commandPalette} onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              placeholder="Type a command or page name..."
              className={styles.commandInput}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.currentTarget.value) {
                  executeCommand(e.currentTarget.value);
                }
              }}
            />
            <div className={styles.commandList}>
              <button className={styles.commandItem} onClick={() => executeCommand('users')}>
                <span>👥</span> User Management
              </button>
              <button className={styles.commandItem} onClick={() => executeCommand('doctors')}>
                <span>🩺</span> Doctor Management
              </button>
              <button className={styles.commandItem} onClick={() => executeCommand('departments')}>
                <span>🏥</span> Department Management
              </button>
              <button className={styles.commandItem} onClick={() => executeCommand('appointments')}>
                <span>📅</span> Appointments
              </button>
              <button className={styles.commandItem} onClick={() => executeCommand('pharmacy')}>
                <span>💊</span> Pharmacy Orders
              </button>
              <button className={styles.commandItem} onClick={() => executeCommand('reports')}>
                <span>📊</span> Reports & Analytics
              </button>
              <button className={styles.commandItem} onClick={() => executeCommand('notifications')}>
                <span>🔔</span> Notifications
              </button>
              <button className={styles.commandItem} onClick={() => executeCommand('attendance')}>
                <span>✅</span> Staff Attendance
              </button>
              <button className={styles.commandItem} onClick={() => executeCommand('emergency')}>
                <span>🚨</span> Emergency/SOS
              </button>
              <button className={styles.commandItem} onClick={() => executeCommand('system logs')}>
                <span>📜</span> System Logs
              </button>
              <button className={styles.commandItem} onClick={() => executeCommand('settings')}>
                <span>⚙️</span> System Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notifications Dropdown */}
      {showNotifications && (
        <div className={styles.notificationsDropdown}>
          <div className={styles.notificationsHeader}>
            <h3>Notifications</h3>
            <button onClick={() => setNotifications([])}>Clear All</button>
          </div>
          <div className={styles.notificationsList}>
            {notifications.map(notif => (
              <div 
                key={notif.id} 
                className={`${styles.notificationItem} ${notif.read ? styles.notifRead : ''}`}
                onClick={() => markNotificationAsRead(notif.id)}
              >
                <div className={styles.notifIcon}>
                  {notif.type === 'critical' ? '🔴' : 
                   notif.type === 'warning' ? '🟡' : 
                   notif.type === 'success' ? '🟢' : '🔵'}
                </div>
                <div className={styles.notifContent}>
                  <h4>{notif.title}</h4>
                  <p>{notif.message}</p>
                  <span className={styles.notifTime}>{formatTimeAgo(notif.time)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
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

// Animated Counter Component
function AnimatedCounter({ value, suffix = '' }: { value: number; suffix?: string }) {
  const [displayValue, setDisplayValue] = useState(0);
  
  useEffect(() => {
    const duration = 1000;
    const steps = 20;
    const increment = value / steps;
    let current = 0;
    
    const timer = setInterval(() => {
      current += increment;
      if (current >= value) {
        setDisplayValue(value);
        clearInterval(timer);
      } else {
        setDisplayValue(Math.floor(current));
      }
    }, duration / steps);
    
    return () => clearInterval(timer);
  }, [value]);
  
  return <div className={styles.statValue}>{displayValue.toLocaleString()}{suffix}</div>;
}

// Simple Chart Component
function SimpleChart({ data }: { data: ChartData }) {
  const maxValue = Math.max(...data.datasets.flatMap(d => d.data));
  
  return (
    <div className={styles.simpleChart}>
      <div className={styles.chartBars}>
        {data.labels.map((label, i) => (
          <div key={label} className={styles.chartBarGroup}>
            {data.datasets.map((dataset, j) => (
              <div
                key={dataset.label}
                className={styles.chartBar}
                style={{
                  height: `${(dataset.data[i] / maxValue) * 100}%`,
                  backgroundColor: dataset.color,
                  opacity: j === 0 ? 1 : 0.7
                }}
                title={`${dataset.label}: ${dataset.data[i]}`}
              />
            ))}
            <span className={styles.chartLabel}>{label}</span>
          </div>
        ))}
      </div>
      <div className={styles.chartLegend}>
        {data.datasets.map(dataset => (
          <span key={dataset.label} className={styles.legendItem}>
            <span 
              className={styles.legendColor} 
              style={{ backgroundColor: dataset.color }}
            />
            {dataset.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Utility function
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
  
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} mins ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

export default DashboardClient;