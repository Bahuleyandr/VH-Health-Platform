// src/app/(with-auth)/dashboard/hooks/useDashboardData.types.ts
// Shared types for the admin Dashboard and its sub-components.

export type HealthStatus = 'healthy' | 'warning' | 'critical';

export type Quick = {
  totalUsers?: number;
  presentStaff?: number;
  availableDoctors?: number;
  appointmentsToday?: number;
};

export type ActivityItem = {
  id: string;
  user: string;
  action: string;
  target: string;
  department?: string;
  timestamp?: string;
};

export type SystemHealth = {
  status: HealthStatus;
  uptime: string;
  responseTime: number; // ms
  errorRate: number; // %
  modules?: Array<{ name: string; status: HealthStatus }>;
};

export type AppointmentQueue = {
  waiting: number;
  inProgress: number;
  completed: number;
};

export type InfraHealthCheck = {
  status?: string;
  latency_ms?: number;
  error?: string;
  note?: string;
  pending?: number;
  sent?: number;
  failed_permanent?: number;
  appointments?: number;
  pharmacy?: number;
  investigations?: number;
  uptime_hours?: number;
  memory_mb?: number;
  memory_total_mb?: number;
  memory_percent?: number;
  node_version?: string;
  environment?: string;
  provider?: string;
};

export type InfraHealthData = {
  status: string;
  timestamp: string;
  checks: Record<string, InfraHealthCheck>;
};

export type DashboardResponse = {
  overview?: Quick;
  charts?: {
    userGrowth?: Array<{ date: string; value: number }>;
    appointmentTrends?: Array<{ date: string; value: number }>;
    departmentUtilization?: Array<{ label: string; value: number }>;
  };
  recentActivity?: ActivityItem[];
  systemHealth?: SystemHealth;
};

export type ChartsState = {
  labels: string[];
  users: number[];
  appts: number[];
};
