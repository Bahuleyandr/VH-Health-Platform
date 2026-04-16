// src/app/(with-auth)/dashboard/dashboardDemoData.ts
//
// Extracted from DashboardClient.tsx (P2 god-page split). Holds the
// deterministic demo/fallback payload the dashboard uses when the backend
// is unreachable AND when individual fields are missing from the API
// envelope. Keeping it here instead of inlining twice in the client:
//   * halves the DashboardClient LOC count (the previous inline blob was
//     duplicated between the try + catch branches of loadDashboardData)
//   * makes it obvious what "fallback" actually means so a reviewer can
//     compare against the real API response shape at a glance
//   * unblocks future unit tests that want to render DashboardClient
//     against a known payload without the network layer

import type { DashboardData, Notification } from "./dashboardTypes";

export const DASHBOARD_DEMO_DATA: DashboardData = {
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
    pendingHRActions: 5,
  },
  charts: {
    userGrowth: [
      { date: "Mon", value: 65 },
      { date: "Tue", value: 78 },
      { date: "Wed", value: 90 },
      { date: "Thu", value: 81 },
      { date: "Fri", value: 84 },
      { date: "Sat", value: 78 },
      { date: "Sun", value: 95 },
    ],
    appointmentTrends: [
      { date: "Mon", value: 58 },
      { date: "Tue", value: 68 },
      { date: "Wed", value: 77 },
      { date: "Thu", value: 89 },
      { date: "Fri", value: 76 },
      { date: "Sat", value: 77 },
      { date: "Sun", value: 88 },
    ],
    departmentUtilization: [
      { label: "Emergency", value: 85 },
      { label: "ICU", value: 92 },
      { label: "Surgery", value: 78 },
      { label: "Pediatrics", value: 65 },
      { label: "Radiology", value: 71 },
    ],
  },
  recentActivity: [
    { id: "1", user: "Nurse Kelly", action: "updated", target: "patient record #1234", time: new Date(), department: "ICU" },
    { id: "2", user: "Dr. Chen", action: "prescribed", target: "medication for #5678", time: new Date(), department: "Emergency" },
    { id: "3", user: "Admin Ross", action: "scheduled", target: "maintenance for MRI", time: new Date(), department: "Radiology" },
  ],
  systemHealth: {
    status: "healthy",
    uptime: "99.99%",
    responseTime: 45,
    errorRate: 0.1,
  },
};

export const DASHBOARD_DEMO_NOTIFICATIONS: Notification[] = [
  { id: "1", type: "critical", title: "Emergency Alert", message: "Code Blue - Room 302", time: new Date(), read: false },
  { id: "2", type: "warning", title: "Low Supplies", message: "Oxygen tanks below 20% in ICU", time: new Date(), read: false },
  { id: "3", type: "info", title: "Staff Update", message: "Dr. Johnson has arrived for shift", time: new Date(), read: true },
];
