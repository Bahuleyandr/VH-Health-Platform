import type {
  ActivityApiItem,
  ChartData,
  DashboardData,
  StatCard,
} from './dashboardTypes';
import { DASHBOARD_DEMO_DATA } from './dashboardDemoData';

type DashboardApiPayload = Partial<DashboardData['overview']> & {
  overview?: Partial<DashboardData['overview']>;
  charts?: Partial<DashboardData['charts']>;
  recentActivity?: ActivityApiItem[];
  systemHealth?: DashboardData['systemHealth'];
};

export function normalizeDashboardData(data: DashboardApiPayload): DashboardData {
  const overview = data.overview ?? {};

  return {
    overview: {
      ...DASHBOARD_DEMO_DATA.overview,
      ...overview,
      totalUsers: data.totalUsers ?? overview.totalUsers ?? DASHBOARD_DEMO_DATA.overview.totalUsers,
      activeUsers: data.activeUsers ?? overview.activeUsers ?? DASHBOARD_DEMO_DATA.overview.activeUsers,
      newUsersToday: data.newUsersToday ?? overview.newUsersToday ?? DASHBOARD_DEMO_DATA.overview.newUsersToday,
      totalDoctors: data.totalDoctors ?? overview.totalDoctors ?? DASHBOARD_DEMO_DATA.overview.totalDoctors,
      availableDoctors: data.availableDoctors ?? overview.availableDoctors ?? DASHBOARD_DEMO_DATA.overview.availableDoctors,
      totalDepartments: data.totalDepartments ?? overview.totalDepartments ?? DASHBOARD_DEMO_DATA.overview.totalDepartments,
      appointmentsToday: data.appointmentsToday ?? overview.appointmentsToday ?? DASHBOARD_DEMO_DATA.overview.appointmentsToday,
      appointmentsUpcoming: data.appointmentsUpcoming ?? overview.appointmentsUpcoming ?? DASHBOARD_DEMO_DATA.overview.appointmentsUpcoming,
      appointmentCompletionRate:
        data.appointmentCompletionRate ??
        overview.appointmentCompletionRate ??
        DASHBOARD_DEMO_DATA.overview.appointmentCompletionRate,
      emergencyAlerts: data.emergencyAlerts ?? overview.emergencyAlerts ?? DASHBOARD_DEMO_DATA.overview.emergencyAlerts,
      totalStaff: data.totalStaff ?? overview.totalStaff ?? DASHBOARD_DEMO_DATA.overview.totalStaff,
      presentStaff: data.presentStaff ?? overview.presentStaff ?? DASHBOARD_DEMO_DATA.overview.presentStaff,
      onLeaveStaff: data.onLeaveStaff ?? overview.onLeaveStaff ?? DASHBOARD_DEMO_DATA.overview.onLeaveStaff,
      pendingHRActions: data.pendingHRActions ?? overview.pendingHRActions ?? DASHBOARD_DEMO_DATA.overview.pendingHRActions,
    },
    charts: {
      userGrowth: data.charts?.userGrowth ?? DASHBOARD_DEMO_DATA.charts.userGrowth,
      appointmentTrends: data.charts?.appointmentTrends ?? DASHBOARD_DEMO_DATA.charts.appointmentTrends,
      departmentUtilization:
        data.charts?.departmentUtilization ?? DASHBOARD_DEMO_DATA.charts.departmentUtilization,
    },
    recentActivity: (data.recentActivity ?? DASHBOARD_DEMO_DATA.recentActivity).map((item) => {
      const activityTime = 'timestamp' in item ? item.timestamp : item.time;
      return {
        ...item,
        time: new Date(activityTime || new Date()),
      };
    }),
    systemHealth: data.systemHealth ?? DASHBOARD_DEMO_DATA.systemHealth,
  };
}

export function buildStatCards(dashboardData: DashboardData): StatCard[] {
  return [
    {
      id: '1',
      title: 'Total Patients',
      value: dashboardData.overview.totalUsers,
      change: 12,
      icon: '🏥',
      color: 'blue',
      suffix: ' patients',
    },
    {
      id: '2',
      title: 'Staff on Duty',
      value: dashboardData.overview.presentStaff,
      change: -2,
      icon: '👥',
      color: 'green',
      suffix: ' staff',
    },
    {
      id: '3',
      title: 'Available Doctors',
      value: dashboardData.overview.availableDoctors,
      change: -5,
      icon: '🩺',
      color: 'yellow',
      suffix: ' doctors',
    },
    {
      id: '4',
      title: "Today's Appointments",
      value: dashboardData.overview.appointmentsToday,
      change: 15,
      icon: '📋',
      color: 'red',
      suffix: ' appts',
    },
  ];
}

export function buildChartData(dashboardData: DashboardData): ChartData {
  return {
    labels: dashboardData.charts.userGrowth.map((d) => d.date),
    datasets: [
      {
        label: 'New Users',
        data: dashboardData.charts.userGrowth.map((d) => d.value),
        color: '#0891b2',
      },
      {
        label: 'Appointments',
        data: dashboardData.charts.appointmentTrends.map((d) => d.value),
        color: '#14b8a6',
      },
    ],
  };
}

export function getDashboardGreeting(userName: string, now = new Date()) {
  const hour = now.getHours();

  if (hour < 12) return `Good morning, ${userName}`;
  if (hour < 17) return `Good afternoon, ${userName}`;
  if (hour < 20) return `Good evening, ${userName}`;
  return `Good night, ${userName}`;
}
