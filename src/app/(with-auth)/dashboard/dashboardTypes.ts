// Shared types for the main admin dashboard client + its sub-components.

export interface StatCard {
  id: string;
  title: string;
  value: number;
  change: number;
  icon: string;
  color: 'blue' | 'green' | 'yellow' | 'red';
  prefix?: string;
  suffix?: string;
}

export interface Notification {
  id: string;
  type: 'critical' | 'warning' | 'info' | 'success';
  title: string;
  message: string;
  time: Date;
  read: boolean;
}

export interface Activity {
  id: string;
  user: string;
  action: string;
  target: string;
  time: Date;
  department: string;
}

export interface ChartData {
  labels: string[];
  datasets: {
    label: string;
    data: number[];
    color: string;
  }[];
}

export interface DashboardData {
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

// Shape of an activity item as returned by the backend (before normalization
// into the local `Activity` type with a `Date`-typed `time`).
export interface ActivityApiItem {
  id: string;
  user: string;
  action: string;
  target: string;
  department: string;
  timestamp?: string | Date;
  time?: string | Date;
}
