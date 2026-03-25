// src/lib/api-config.ts
// Complete API endpoint mapping for VH Health Admin Portal

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://vh-health-backend.onrender.com";

// WebSocket URL configuration
export const WS_BASE_URL = 
  process.env.NEXT_PUBLIC_WS_URL || 
  API_BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://');

// Optional envs (fall back to sensible local defaults)
const DEFAULT_ORIGIN =
  (typeof window !== "undefined" && window.location.origin) ||
  "http://localhost:3000";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

if (!API_KEY && typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  console.warn("[api-config] NEXT_PUBLIC_API_KEY is not set. API requests may fail.");
}

// WebSocket endpoints
export const WS_ENDPOINTS = {
  admin: '/ws/admin',
  notifications: '/ws/notifications',
  sos: '/ws/emergency',
  activity: '/ws/activity',
};

export const API_ENDPOINTS = {
  // Health & System Status
  health: {
    check: "/api/v1/health-check", // GET
    system: "/api/v1/system/status", // GET
    appVersion: "/api/v1/app-version", // GET
  },

  // Authentication
  auth: {
    admin: {
      login: "/api/v1/auth/admin/login", // POST
      profile: "/api/v1/auth/admin/profile", // GET
      logout: "/api/v1/auth/admin/logout", // POST
      forgotPassword: "/api/v1/auth/admin/forgot-password", // POST
      resetPassword: "/api/v1/auth/admin/reset-password", // POST
      changePassword: "/api/v1/auth/admin/change-password", // POST
    },

    // OTP (test/secondary)
    generateOtp: "/api/v1/auth/generate-test-otp", // POST
    verifyOtp: "/api/v1/auth/verify-test-otp", // POST
    stats: "/api/v1/auth/stats", // GET

    // Admin management (if present)
    adminManagement: "/api/v1/auth/admin/list", // GET list of admins (protected)

    // Tokens & verification
    refreshToken: "/api/v1/auth/refresh-token", // POST
    verify: "/api/v1/verify", // GET
  },

  // Main Admin Dashboard Routes (corrected to match backend services)
  admin: {
    // Core Dashboard
    test: "/api/v1/admin/test", // GET
    dashboard: "/api/v1/admin/dashboard", // GET
    
    // Statistics Endpoints (matching statsService.js)
    stats: {
      quick: "/api/v1/admin/stats/quick", // GET - getQuickStats()
      users: "/api/v1/admin/stats/users", // GET - getUserStats()
      doctors: "/api/v1/admin/stats/doctors", // GET - getDoctorStats()
      departments: "/api/v1/admin/stats/departments", // GET - getDepartmentStats()
      appointments: "/api/v1/admin/stats/appointments", // GET - getAppointmentStats()
      records: "/api/v1/admin/stats/records", // GET - getRecordStats()
      emergency: "/api/v1/admin/stats/emergency", // GET - getEmergencyStats()
      staff: "/api/v1/admin/stats/staff", // GET - getStaffStats()
      appointmentSummary: "/api/v1/admin/stats/appointment-summary", // GET - getAppointmentSummary()
    },

    // Activity & Monitoring (matching activityService.js)
    activity: {
      recent: "/api/v1/admin/activity/recent", // GET with ?limit=50&offset=0
    },

    // System Alerts (matching alertsService.js)
    alerts: {
      system: "/api/v1/admin/alerts", // GET - getSystemAlerts()
    },

    // Health Monitoring (matching healthService.js)
    health: {
      modules: "/api/v1/admin/health/modules", // GET - getModuleHealth()
      system: "/api/v1/admin/health/system", // GET - getSystemHealth()
    },

    // Reports (matching reportService.js)
    reports: {
      refreshCache: "/api/v1/admin/refresh-cache", // POST - refreshDashboardCache()
      generate: "/api/v1/admin/export/report", // POST - generateDashboardReport()
    },

    // Attendance Management (matching attendanceService.js)
    attendance: {
      analytics: "/api/v1/admin/staff/attendance/analytics", // GET - getAttendanceAnalytics()
      anomalies: "/api/v1/admin/staff/attendance/anomalies", // GET - getAttendanceAnomalies()
      lateArrivals: "/api/v1/admin/staff/attendance/late-arrivals", // GET - getLateArrivals()
      earlyDepartures: "/api/v1/admin/staff/attendance/early-departures", // GET - getEarlyDepartures()
      absentReport: "/api/v1/admin/staff/attendance/absent-report", // GET - getAbsentReport()
    },

    // SOS/Emergency Management (matching sosService.js)
    sos: {
      analytics: "/api/v1/admin/sos/analytics", // GET - getSosAnalytics()
      alerts: "/api/v1/admin/sos/alerts", // GET - getAllAlerts()
      emergencyServices: "/api/v1/admin/sos/emergency-services", // GET - getEmergencyServices()
      performanceReport: "/api/v1/admin/sos/performance-report", // GET - getPerformanceReport()
      updateConfig: "/api/v1/admin/sos/update-config", // POST - updateSystemConfig()
      broadcast: "/api/v1/admin/sos/broadcast", // POST - broadcastEmergencyAlert()
      escalate: "/api/v1/admin/sos/escalate", // POST - escalateAlert()
    },

    // Upload/File Management (matching uploadService.js)
    uploads: {
      summary: "/api/v1/admin/upload/summary", // GET - getUploadSummary()
      quarantined: "/api/v1/admin/upload/quarantine", // GET - listQuarantinedFiles()
      hipaaAudit: "/api/v1/admin/upload/hipaa/audit", // POST - getHipaaAuditReport()
      rescan: "/api/v1/admin/upload/rescan", // POST - rescanFile()
      cleanup: "/api/v1/admin/upload/cleanup", // POST - cleanupExpiredFiles()
      bulkHipaa: "/api/v1/admin/upload/hipaa-bulk", // POST - bulkUpdateHipaaProtection()
      purgeQuarantine: "/api/v1/admin/upload/purge-quarantine", // POST - purgeQuarantinedFiles()
    },

    // Module entry points (kept for navigation)
    modules: {
      appointments: "/api/v1/admin/appointments",
      departments: "/api/v1/admin/departments",
      doctors: "/api/v1/admin/doctors",
      users: "/api/v1/admin/users",
      notifications: "/api/v1/admin/notifications",
      records: "/api/v1/admin/records",
      investigations: "/api/v1/admin/investigations",
      pharmacy: "/api/v1/admin/pharmacy",
      sos: "/api/v1/admin/sos",
      staff: "/api/v1/staff/admin",
      analytics: "/api/v1/admin/analytics",
      devices: "/api/v1/devices",
      feedback: "/api/v1/feedback",
    },
  },

  // Users
  users: {
    list: "/api/v1/users", // GET/POST/PUT/DELETE
    byRole: "/api/v1/users/role/:role", // GET
    byId: "/api/v1/users/:identifier", // GET/PUT/DELETE
    status: "/api/v1/users/:identifier/status", // PUT
    dashboard: "/api/v1/users/admin/dashboard", // GET
    analytics: "/api/v1/users/admin/analytics", // GET
    systemInfo: "/api/v1/users/system-info", // GET
    activityAudit: "/api/v1/users/admin/activity-audit", // GET
    inactiveUsers: "/api/v1/users/admin/inactive-users", // GET
    generateReport: "/api/v1/users/admin/generate-report", // POST
    bulkImport: "/api/v1/users/bulk-import", // POST
    reactivate: "/api/v1/users/admin/reactivate/:userId", // POST

    // Search & lookup
    search: "/api/v1/staff/search", // GET
    activity: "/api/v1/activity", // GET
    advancedSearch: "/api/v1/advanced", // GET
    bulkSearch: "/api/v1/bulk-search", // POST
  },

  // Doctors
  doctors: {
    list: "/api/v1/doctors", // GET
    byId: "/api/v1/doctors/:doctorId", // GET/DELETE
    profile: "/api/v1/doctors/profile", // POST
    profileById: "/api/v1/doctors/profile/:id", // GET
    updateProfile: "/api/v1/doctors/:id/profile", // PUT
    availability: "/api/v1/doctors/:id/availability", // PUT
    byDepartment: "/api/v1/doctors/department/:department", // GET
    workloadAnalysis: "/api/v1/doctors/workload-analysis", // GET
    deactivate: "/api/v1/doctors/:id/deactivate", // DELETE
    deleteAccount: "/api/v1/doctors/:id/account", // DELETE

    admin: {
      overview: "/api/v1/doctors/admin/overview", // GET
      manage: "/api/v1/doctors/admin/manage", // GET
      analyticsById: "/api/v1/doctors/admin/:id/analytics", // GET
      create: "/api/v1/doctors/admin/create", // POST
      bulkOperations: "/api/v1/doctors/admin/bulk-operations", // POST
    },
  },

  // Departments
  departments: {
    list: "/api/v1/departments", // GET
    create: "/api/v1/departments/create", // POST
    byId: "/api/v1/departments/:identifier", // GET
    update: "/api/v1/departments/:id", // PUT
    delete: "/api/v1/departments/:departmentId", // DELETE
    deactivate: "/api/v1/departments/:id/deactivate", // PUT

    withDoctors: "/api/v1/departments/departments-with-doctors", // GET
    availableNow: "/api/v1/departments/available/now", // GET
    manage: "/api/v1/departments/manage", // GET
    overview: "/api/v1/departments/overview", // GET

    // Analytics & Reports
    stats: "/api/v1/departments/:id/stats", // GET
    analytics: "/api/v1/departments/:id/analytics", // GET
    performance: "/api/v1/departments/:id/performance", // GET
    trends: "/api/v1/departments/:id/trends", // GET
    comparison: "/api/v1/departments/comparison", // GET

    // Admin ops
    bulkOperations: "/api/v1/departments/bulk-operations", // POST
    exportCsv: "/api/v1/departments/admin/export/csv", // GET
    exportReport: "/api/v1/departments/admin/:id/export/report", // GET
    recentActivities: "/api/v1/departments/admin/activities/recent", // GET
    financial: "/api/v1/departments/admin/:id/financial", // GET
    history: "/api/v1/departments/admin/:id/history", // GET
    staffAllocation: "/api/v1/departments/admin/:id/staff-allocation", // GET
  },

  // Appointments
  appointments: {
    list: "/api/v1/appointments/list", // GET
    book: "/api/v1/appointments/book", // POST
    todayList: "/api/v1/appointments/today/list", // GET
    byId: "/api/v1/appointments/:id", // GET/PUT/DELETE
    updateStatus: "/api/v1/appointments/:id/status", // PUT
    byDoctor: "/api/v1/appointments/doctor/:doctor_id", // GET
    byPatient: "/api/v1/appointments/patient/:patient_id", // GET
    byPhone: "/api/v1/appointments/phone/:phone", // GET
    byUid: "/api/v1/appointments/uid/:uid", // GET

    admin: {
      analytics: "/api/v1/appointments/admin/analytics",
      conflicts: "/api/v1/appointments/admin/conflicts",
      capacity: "/api/v1/appointments/admin/capacity",
      noShows: "/api/v1/appointments/admin/no-shows",
      bulkUpdateStatus: "/api/v1/appointments/admin/bulk-update-status",
      overrideBook: "/api/v1/appointments/admin/override-book",
      resolveConflict: "/api/v1/appointments/admin/resolve-conflict",
      sendReminders: "/api/v1/appointments/admin/send-reminders",
      bulkDelete: "/api/v1/appointments/admin/bulk-delete",
      search: "/api/v1/appointments/admin/search",
      export: "/api/v1/appointments/admin/export",
    },
  },

  // Pharmacy
  pharmacy: {
    categories: "/api/v1/pharmacy/categories/list", // GET

    // Admin/Staff routes
    adminRoutes: "/api/v1/pharmacy/admin", // GET (protected)
    orderRoutes: "/api/v1/pharmacy/orders", // GET/POST (protected)
    medicationRoutes: {
      staff: "/api/v1/pharmacy/medications/staff", // GET/PUT (protected)
      admin: "/api/v1/pharmacy/medications/admin", // POST/PUT/DELETE (protected)
    },
    inventoryRoutes: "/api/v1/pharmacy/inventory", // GET (protected)
    staffRoutes: "/api/v1/pharmacy/staff", // POST (protected)
  },

  // Notifications
  notifications: {
    list: "/api/v1/notifications/:phone", // GET
    byUserId: "/api/v1/notifications/user/:user_id", // GET
    detail: "/api/v1/notifications/detail/:id", // GET
    markRead: "/api/v1/notifications/:id/read", // PATCH
    markAllRead: "/api/v1/notifications/:phone/mark-all-read", // PATCH
    markAllReadByUser: "/api/v1/notifications/user/:user_id/read-all", // PATCH

    // Admin
    templates: "/api/v1/notifications/admin/templates", // GET/POST
    announcement: "/api/v1/notifications/admin/announcement", // POST
    targeted: "/api/v1/notifications/admin/targeted", // POST
    bulk: "/api/v1/notifications/admin/bulk-operations", // POST
    sendFromTemplate: "/api/v1/notifications/admin/send-from-template", // POST
    cleanup: "/api/v1/notifications/admin/cleanup", // DELETE

    // Stats & monitoring
    deliveryStats: "/api/v1/notifications/admin/delivery-stats", // GET
    statsSummary: "/api/v1/notifications/stats/summary", // GET
    emergencyActive: "/api/v1/notifications/emergency/active", // GET
    scheduledPending: "/api/v1/notifications/scheduled/pending", // GET
  },

  // Medical Records
  records: {
    list: "/api/v1/records", // GET/POST
    byId: "/api/v1/records/:id", // GET/PUT
    byPhone: "/api/v1/health-records/:phone", // GET
    create: "/api/v1/health-records", // POST
    consultations: "/api/v1/consultations/:phoneNumber", // GET

    // Admin
    adminAnalytics: "/api/v1/records/admin/analytics", // GET
    hipaaAudit: "/api/v1/records/admin/hipaa-audit", // GET
    exportExcel: "/api/v1/records/admin/export/excel", // GET
    exportPdf: "/api/v1/records/admin/export/pdf", // GET
  },

  // Staff
  staff: {
    search: "/api/v1/staff/search", // GET
    attendance: "/api/v1/staff/attendance", // GET
    rollCall: "/api/v1/staff/roll-call", // GET

    staffRoutes: "/api/v1/staff/routes", // GET/POST/PUT (protected)
    attendanceRoutes: "/api/v1/staff/attendance/routes", // GET/POST (protected)
    hrRoutes: "/api/v1/staff/hr/routes", // GET/POST/PUT (protected)
    medicalRoutes: "/api/v1/staff/medical/routes", // POST (protected)

    admin: {
      analytics: { 
        attendance: "/api/v1/staff/admin/analytics/attendance" 
      },
      dashboard: "/api/v1/staff/admin/dashboard",
      hr: { 
        pendingReviews: "/api/v1/staff/admin/hr/pending-reviews" 
      },
      attendance: {
        anomalies: "/api/v1/staff/admin/attendance/anomalies",
        absentReport: "/api/v1/staff/admin/attendance/absent-report",
      },
    },
  },

  // Investigations
  investigations: {
    routes: "/api/v1/investigations/routes", // GET/POST/PUT/DELETE (protected)
    admin: {
      analytics: "/api/v1/investigations/admin/analytics",
      pending: "/api/v1/investigations/admin/pending",
    },
  },

  // SOS/Emergency
  sos: {
    routes: "/api/v1/sos/routes", // GET/POST (protected)
    adminRoutes: "/api/v1/sos/admin/routes", // GET/POST (protected)
    emergencyRoutes: "/api/v1/sos/emergency/routes", // GET/POST (protected)
  },

  // Analytics (general) — mounted under /api/v1/admin/analytics
  analytics: {
    dashboard: "/api/v1/admin/analytics/dashboard", // GET
    userGrowth: "/api/v1/admin/analytics/registrations", // GET
    appointmentTrends: "/api/v1/admin/analytics/trends", // GET
    departmentUtilization: "/api/v1/admin/analytics/departments", // GET
    satisfaction: "/api/v1/admin/analytics/satisfaction", // GET
    usage: "/api/v1/admin/analytics/usage", // GET
    revenue: "/api/v1/admin/analytics/revenue", // GET
  },

  // Devices
  devices: {
    list: "/api/v1/devices", // GET
    register: "/api/v1/devices/register", // POST
    byId: "/api/v1/devices/:deviceId", // GET/PUT/DELETE
    userDevices: "/api/v1/devices/user/:userId", // GET
  },

  // Feedback
  feedback: {
    list: "/api/v1/feedback", // GET
    create: "/api/v1/feedback", // POST
    byId: "/api/v1/feedback/:feedbackId", // GET/PUT
    byUser: "/api/v1/feedback/user/:userId", // GET
    statistics: "/api/v1/feedback/statistics", // GET
  },

  // Infrastructure / Admin Tools
  infrastructure: {
    apiDocs: "/api/v1/api-docs", // GET
    swagger: "/api-docs", // GET
    debug: "/api/v1/debug/routes", // GET (protected)
    rbac: "/api/v1/rbac/routes", // GET/POST (protected)
    auditLog: "/api/v1/logs/audit", // GET (protected) - served by logRoutes
    auditLogExport: "/api/v1/logs/audit/export", // GET - CSV export
    systemLog: "/api/v1/logs/system", // GET - system/admin activity logs
    systemLogExport: "/api/v1/logs/system/export", // GET - CSV export
    toggleUserStatus: "/api/v1/rbac/admin/toggle-user-status", // POST (protected)
  },
};

// Protected routes - Updated to match backend services
export const PROTECTED_ROUTES: string[] = [
  // All admin routes
  "/api/v1/admin/*",
  "/api/v1/admin/stats/*",
  "/api/v1/admin/attendance/*",
  "/api/v1/admin/sos/*",
  "/api/v1/admin/uploads/*",
  "/api/v1/admin/health/*",
  "/api/v1/admin/alerts/*",
  "/api/v1/admin/activity/*",
  "/api/v1/admin/reports/*",
  
  // Staff admin routes
  "/api/v1/staff/admin/*",
  "/api/v1/staff/routes",
  "/api/v1/staff/attendance/routes",
  "/api/v1/staff/hr/routes",
  "/api/v1/staff/medical/routes",
  
  // Other protected routes
  "/api/v1/auth/adminManagement",
  "/api/v1/pharmacy/admin",
  "/api/v1/pharmacy/orders",
  "/api/v1/pharmacy/medications/*",
  "/api/v1/pharmacy/inventory",
  "/api/v1/pharmacy/staff",
  "/api/v1/investigations/routes",
  "/api/v1/investigations/admin/*",
  "/api/v1/sos/routes",
  "/api/v1/sos/admin/routes",
  "/api/v1/sos/emergency/routes",
  "/api/v1/debug/routes",
  "/api/v1/rbac/*",
  "/api/v1/appointments/admin/*",
  "/api/v1/notifications/admin",
  "/api/v1/records/admin/*",
  "/api/v1/analytics/*",
  "/api/v1/devices",
  "/api/v1/feedback",
];

// Standard JSON headers
export const getHeaders = (token?: string): HeadersInit => {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "x-api-key": API_KEY,
    Origin: DEFAULT_ORIGIN,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
};

// Build full URL and replace :params
export const buildUrl = (endpoint: string, params?: Record<string, string>) => {
  let url = `${API_BASE_URL}${endpoint}`;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url = url.replace(`:${k}`, encodeURIComponent(v));
    }
  }
  return url;
};

// Check if endpoint requires authentication
export const requiresAuth = (endpoint: string): boolean =>
  PROTECTED_ROUTES.some((route) => {
    if (route.endsWith("*")) return endpoint.startsWith(route.slice(0, -1));
    return endpoint === route;
  });

// Helper to build WebSocket URLs
export const buildWsUrl = (endpoint: string, token?: string): string => {
  const wsEndpoint = WS_ENDPOINTS[endpoint as keyof typeof WS_ENDPOINTS] || endpoint;
  const url = `${WS_BASE_URL}${wsEndpoint}`;
  if (token) {
    return `${url}?token=${encodeURIComponent(token)}`;
  }
  return url;
};

// Endpoint mapping for legacy compatibility
export const ENDPOINT_MAPPING: Record<string, string> = {
  // Map old endpoints to new ones if needed
  '/admin/upload/': '/admin/uploads/',
  '/admin/staff/attendance/': '/admin/attendance/',
};