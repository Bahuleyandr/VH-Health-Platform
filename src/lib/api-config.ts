// src/lib/api-config.ts
// Complete API endpoint mapping for VH Health Admin Portal

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://vh-health-backend.onrender.com';

// Optional envs (fall back to sensible local defaults)
const DEFAULT_ORIGIN =
  (typeof window !== 'undefined' && window.location.origin) || 'http://localhost:3000';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || 'vhhealth123';

export const API_ENDPOINTS = {
  // Health & System Status
  health: {
    check: '/api/v1/health-check', // GET
    system: '/api/v1/system/status', // GET
    appVersion: '/api/v1/app-version', // GET
  },

  // Authentication
  auth: {
    admin: {
      login: '/api/v1/auth/admin/login', // POST
      profile: '/api/v1/auth/admin/profile', // GET
      logout: '/api/v1/auth/admin/logout', // POST
      forgotPassword: '/api/v1/auth/admin/forgot-password', // POST
      resetPassword: '/api/v1/auth/admin/reset-password', // POST
      changePassword: '/api/v1/auth/admin/change-password', // POST
    },

    // OTP (test/secondary)
    generateOtp: '/api/v1/auth/generate-test-otp', // POST
    verifyOtp: '/api/v1/auth/verify-test-otp', // POST
    stats: '/api/v1/auth/stats', // GET

    // Admin management (if present)
    adminManagement: '/api/v1/auth/adminManagement', // GET/POST/PUT (protected)

    // Tokens & verification
    refreshToken: '/api/v1/auth/refresh-token', // POST
    verify: '/api/v1/verify', // GET
  },

  // Main Admin Dashboard Routes (from src/routes/admin/index.js)
  admin: {
    test: '/api/v1/admin/test', // GET
    dashboard: '/api/v1/admin/dashboard', // GET
    quickStats: '/api/v1/admin/stats/quick', // GET
    recentActivity: '/api/v1/admin/activity/recent', // GET
    // alias to avoid breaking older code that used "activityRecent"
    activityRecent: '/api/v1/admin/activity/recent',
    alerts: '/api/v1/admin/alerts', // GET
    moduleHealth: '/api/v1/admin/health/modules', // GET
    staffSummary: '/api/v1/admin/staff/summary', // GET
    appointmentsSummary: '/api/v1/admin/appointments/summary', // GET
    refreshCache: '/api/v1/admin/refresh-cache', // POST
    exportReport: '/api/v1/admin/export/report', // POST

    // Module entry points advertised by /admin/test
    modules: {
      appointments: '/api/v1/appointments/admin',
      departments: '/api/v1/admin/departments',
      doctors: '/api/v1/admin/doctors',
      users: '/api/v1/users/admin', // note: as per /admin/test output
      notifications: '/api/v1/notifications/admin',
      records: '/api/v1/health-records/admin',
      investigations: '/api/v1/investigations/admin',
      pharmacy: '/api/v1/pharmacy/admin',
      sos: '/api/v1/sos/admin',
      staff: '/api/v1/staff/admin',
      analytics: '/api/v1/analytics',
      devices: '/api/v1/devices',
      feedback: '/api/v1/feedback',
    },
  },

  // Users
  users: {
    list: '/api/v1/users', // GET/POST/PUT/DELETE
    byRole: '/api/v1/users/role/:role', // GET
    byId: '/api/v1/users/:identifier', // GET/PUT/DELETE
    status: '/api/v1/users/:identifier/status', // PUT
    dashboard: '/api/v1/users/dashboard', // GET
    analytics: '/api/v1/users/analytics', // GET
    systemInfo: '/api/v1/users/system-info', // GET
    activityAudit: '/api/v1/users/activity-audit', // GET
    inactiveUsers: '/api/v1/users/inactive-users', // GET
    generateReport: '/api/v1/users/generate-report', // POST
    bulkImport: '/api/v1/users/bulk-import', // POST
    reactivate: '/api/v1/users/reactivate/:userId', // POST

    // Search & lookup
    search: '/api/v1/staff/search', // GET
    activity: '/api/v1/activity', // GET
    advancedSearch: '/api/v1/advanced', // GET
    bulkSearch: '/api/v1/bulk-search', // POST
  },

  // Doctors
  doctors: {
    list: '/api/v1/doctors', // GET
    byId: '/api/v1/doctors/:doctorId', // GET/DELETE
    profile: '/api/v1/doctors/profile', // POST
    profileById: '/api/v1/doctors/profile/:id', // GET
    updateProfile: '/api/v1/doctors/:id/profile', // PUT
    availability: '/api/v1/doctors/:id/availability', // PUT
    byDepartment: '/api/v1/doctors/department/:department', // GET
    workloadAnalysis: '/api/v1/doctors/workload-analysis', // GET
    deactivate: '/api/v1/doctors/:id/deactivate', // DELETE
    deleteAccount: '/api/v1/doctors/:id/account', // DELETE
  },

  // Departments
  departments: {
    list: '/api/v1/departments', // GET
    create: '/api/v1/departments/create', // POST
    byId: '/api/v1/departments/:identifier', // GET
    update: '/api/v1/departments/:id', // PUT (fixed)
    delete: '/api/v1/departments/:departmentId', // DELETE
    deactivate: '/api/v1/departments/:id/deactivate', // PUT

    withDoctors: '/api/v1/departments/departments-with-doctors', // GET
    availableNow: '/api/v1/departments/available/now', // GET
    manage: '/api/v1/departments/manage', // GET
    overview: '/api/v1/departments/overview', // GET

    // Analytics & Reports
    stats: '/api/v1/:id/stats', // GET
    analytics: '/api/v1/:id/analytics', // GET
    performance: '/api/v1/:id/performance', // GET
    trends: '/api/v1/:id/trends', // GET
    comparison: '/api/v1/comparison', // GET

    // Admin ops
    bulkOperations: '/api/v1/departments/bulk-operations', // POST
    exportCsv: '/api/v1/departments/export/csv', // GET
    exportReport: '/api/v1/departments/:id/export/report', // GET
    recentActivities: '/api/v1/departments/activities/recent', // GET
    financial: '/api/v1/departments/:id/financial', // GET
    history: '/api/v1/departments/:id/history', // GET
    staffAllocation: '/api/v1/departments/:id/staff-allocation', // GET
  },

  // Appointments
  appointments: {
    list: '/api/v1/list', // GET
    book: '/api/v1/book', // POST
    todayList: '/api/v1/today/list', // GET
    byId: '/api/v1/:id', // GET/PUT/DELETE
    updateStatus: '/api/v1/:id/status', // PUT
    byDoctor: '/api/v1/doctor/:doctor_id', // GET
    byPatient: '/api/v1/patient/:patient_id', // GET
    byPhone: '/api/v1/phone/:phone', // GET
    byUid: '/api/v1/uid/:uid', // GET

    admin: {
      analytics: '/api/v1/appointments/admin/analytics',
      conflicts: '/api/v1/appointments/admin/conflicts',
      capacity: '/api/v1/appointments/admin/capacity',
      noShows: '/api/v1/appointments/admin/no-shows',
    },
  },

  // Pharmacy
  pharmacy: {
    categories: '/api/v1/categories/list', // GET

    // Admin/Staff routes (varied mounts)
    adminRoutes: '/api/v1/admin/pharmacyAdminRoutes', // GET (protected)
    orderRoutes: '/api/v1/pharmacyOrderRoutes', // GET/POST (protected)
    medicationRoutes: {
      staff: '/api/v1/pharmacyStaffMedicationRoutes', // GET/PUT (protected)
      admin: '/api/v1/pharmacyAdminMedicationRoutes', // POST/PUT/DELETE (protected)
    },
    inventoryRoutes: '/api/v1/pharmacyStaffInventoryRoutes', // GET (protected)
    staffRoutes: '/api/v1/pharmacy/staffPharmacyRoutes', // POST (protected)
  },

  // Notifications
  notifications: {
    list: '/api/v1/notifications/:phone', // GET
    byUserId: '/api/v1/notifications/user/:user_id', // GET
    detail: '/api/v1/notifications/detail/:id', // GET
    markRead: '/api/v1/notifications/:id/read', // PATCH
    markAllRead: '/api/v1/notifications/:phone/mark-all-read', // PATCH
    markAllReadByUser: '/api/v1/notifications/user/:user_id/read-all', // PATCH

    // Admin
    templates: '/api/v1/notifications/templates', // GET/POST
    announcement: '/api/v1/notifications/announcement', // POST
    targeted: '/api/v1/notifications/targeted', // POST
    bulk: '/api/v1/notifications/bulk', // POST
    sendFromTemplate: '/api/v1/notifications/send-from-template', // POST
    cleanup: '/api/v1/notifications/cleanup', // DELETE

    // Stats & monitoring
    deliveryStats: '/api/v1/notifications/delivery-stats', // GET
    statsSummary: '/api/v1/notifications/stats/summary', // GET
    emergencyActive: '/api/v1/notifications/emergency/active', // GET
    scheduledPending: '/api/v1/notifications/scheduled/pending', // GET
  },

  // Medical Records
  records: {
    list: '/api/v1/records', // GET/POST
    byId: '/api/v1/records/:id', // GET/PUT
    byPhone: '/api/v1/health-records/:phone', // GET
    create: '/api/v1/health-records', // POST
    consultations: '/api/v1/consultations/:phoneNumber', // GET

    // Admin (double "admin" is as in the original mapping; update if needed)
    adminAnalytics: '/api/v1/admin/admin/analytics', // GET
    hipaaAudit: '/api/v1/admin/admin/hipaa-audit', // GET
    exportExcel: '/api/v1/admin/export/excel', // GET
    exportPdf: '/api/v1/admin/export/pdf', // GET
  },

  // Staff
  staff: {
    search: '/api/v1/staff/search', // GET
    attendance: '/api/v1/attendance', // GET
    rollCall: '/api/v1/roll-call', // GET

    staffRoutes: '/api/v1/staff/staffRoutes', // GET/POST/PUT (protected)
    attendanceRoutes: '/api/v1/staffAttendanceRoutes', // GET/POST (protected)
    hrRoutes: '/api/v1/staffHRRoutes', // GET/POST/PUT (protected)
    medicalRoutes: '/api/v1/staffMedicalRoutes', // POST (protected)

    admin: {
      analytics: {
        attendance: '/api/v1/staff/admin/analytics/attendance',
      },
      dashboard: '/api/v1/staff/admin/dashboard',
      hr: { pendingReviews: '/api/v1/staff/admin/hr/pending-reviews' },
      attendance: {
        anomalies: '/api/v1/staff/admin/attendance/anomalies',
        absentReport: '/api/v1/staff/admin/attendance/absent-report',
      },
    },
  },

  // Investigations
  investigations: {
    routes: '/api/v1/investigations/investigationRoutes', // GET/POST/PUT/DELETE (protected)
  },

  // SOS/Emergency
  sos: {
    routes: '/api/v1/sos/sosRoutes', // GET/POST (protected)
    adminRoutes: '/api/v1/sos/adminSosRoutes', // GET/POST (protected)
    emergencyRoutes: '/api/v1/sos/emergencyResponderRoutes', // GET/POST (protected)
  },

  // Analytics (general)
  analytics: {
    dashboard: '/api/v1/analytics', // GET
    userGrowth: '/api/v1/analytics/user-growth', // GET
    appointmentTrends: '/api/v1/analytics/appointment-trends', // GET
    departmentUtilization: '/api/v1/analytics/department-utilization', // GET
    revenue: '/api/v1/analytics/revenue', // GET
  },

  // Devices
  devices: {
    list: '/api/v1/devices', // GET
    register: '/api/v1/devices/register', // POST
    byId: '/api/v1/devices/:deviceId', // GET/PUT/DELETE
    userDevices: '/api/v1/devices/user/:userId', // GET
  },

  // Feedback
  feedback: {
    list: '/api/v1/feedback', // GET
    create: '/api/v1/feedback', // POST
    byId: '/api/v1/feedback/:feedbackId', // GET/PUT
    byUser: '/api/v1/feedback/user/:userId', // GET
    statistics: '/api/v1/feedback/statistics', // GET
  },

  // Infrastructure / Admin Tools
  infrastructure: {
    apiDocs: '/api/v1/api-docs', // USE
    swagger: '/api-docs/adminDocumentationRoutes', // GET/POST (protected)
    debug: '/api/v1/debug/debugRoutes', // GET (protected)
    rbac: '/api/v1/rbac/rbacRoutes', // GET/POST (protected)
    auditLog: '/api/v1/rbac/admin/audit-log', // GET (protected)
    toggleUserStatus: '/api/v1/rbac/admin/toggle-user-status', // POST (protected)
  },
};

// Mark protected routes (simple matcher)
export const PROTECTED_ROUTES: string[] = [
  '/api/v1/admin/*',
  '/api/v1/admin/pharmacyAdminRoutes',
  '/api/v1/pharmacyOrderRoutes',
  '/api/v1/pharmacyStaffMedicationRoutes',
  '/api/v1/pharmacyAdminMedicationRoutes',
  '/api/v1/pharmacyStaffInventoryRoutes',
  '/api/v1/pharmacy/staffPharmacyRoutes',
  '/api/v1/auth/adminManagement',
  '/api/v1/staff/staffRoutes',
  '/api/v1/staffAttendanceRoutes',
  '/api/v1/staffHRRoutes',
  '/api/v1/staffMedicalRoutes',
  '/api/v1/investigations/investigationRoutes',
  '/api/v1/sos/sosRoutes',
  '/api/v1/sos/adminSosRoutes',
  '/api/v1/sos/emergencyResponderRoutes',
  '/api/v1/debug/debugRoutes',
  '/api/v1/rbac/rbacRoutes',
  '/api-docs/adminDocumentationRoutes',
  '/api/v1/users/admin',
  '/api/v1/appointments/admin/*',
  '/api/v1/notifications/admin',
  '/api/v1/health-records/admin',
  '/api/v1/investigations/admin',
  '/api/v1/pharmacy/admin',
  '/api/v1/staff/admin/*',
  '/api/v1/analytics',
  '/api/v1/devices',
  '/api/v1/feedback',
];

// Standard JSON headers. Add Origin + API key for servers that enforce them.
export const getHeaders = (token?: string): HeadersInit => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    Origin: DEFAULT_ORIGIN,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
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

export const requiresAuth = (endpoint: string): boolean =>
  PROTECTED_ROUTES.some((route) => {
    if (route.endsWith('*')) return endpoint.startsWith(route.slice(0, -1));
    return endpoint === route;
  });

// Back-compat remaps (fill as needed)
export const ENDPOINT_MAPPING: Record<string, string> = {
  // '/old-endpoint': '/new-endpoint'
};
