// src/lib/api-config.ts
// Complete API endpoint mapping for VH Health Admin Portal

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://vh-health-backend.onrender.com';

// Actual working endpoints from your backend
export const API_ENDPOINTS = {
  // Health & System Status
  health: {
    check: '/api/v1/health-check',              // GET - Health check
    system: '/api/v1/system/status',            // GET - System status
    appVersion: '/api/v1/app-version',          // GET - App version
  },

  // Authentication
  auth: {
    // Admin authentication endpoints
    admin: {
      login: '/api/v1/auth/admin/login',        // POST - Admin username/password login
      profile: '/api/v1/auth/admin/profile',    // GET - Get admin profile
      logout: '/api/v1/auth/admin/logout',      // POST - Admin logout
      forgotPassword: '/api/v1/auth/admin/forgot-password', // POST
      resetPassword: '/api/v1/auth/admin/reset-password',   // POST
      changePassword: '/api/v1/auth/admin/change-password', // POST
    },
    
    // OTP-based auth endpoints (for testing/secondary)
    generateOtp: '/api/v1/auth/generate-test-otp',  // POST
    verifyOtp: '/api/v1/auth/verify-test-otp',      // POST
    stats: '/api/v1/auth/stats',                     // GET
    
    // Admin management (protected)
    adminManagement: '/api/v1/auth/adminManagement', // GET, POST, PUT (protected)
    
    // Token management
    refreshToken: '/api/v1/auth/refresh-token',      // POST
    
    // User verification
    verify: '/api/v1/verify',                        // GET
  },

  // Main Admin Dashboard Routes
  admin: {
    test: '/api/v1/admin/test',                      // GET - Test route
    dashboard: '/api/v1/admin/dashboard',            // GET - Main dashboard overview
    quickStats: '/api/v1/admin/stats/quick',         // GET - Quick statistics
    recentActivity: '/api/v1/admin/activity/recent', // GET - Recent activity feed
    alerts: '/api/v1/admin/alerts',                  // GET - System alerts
    moduleHealth: '/api/v1/admin/health/modules',    // GET - Module health status
    staffSummary: '/api/v1/admin/staff/summary',     // GET - Staff summary
    appointmentsSummary: '/api/v1/admin/appointments/summary', // GET - Appointments summary
    refreshCache: '/api/v1/admin/refresh-cache',     // POST - Refresh dashboard cache
    exportReport: '/api/v1/admin/export/report',     // POST - Export dashboard report
    
    // Admin module endpoints
    modules: {
      appointments: '/api/v1/appointments/admin',     // Admin appointment management
      departments: '/api/v1/admin/departments',       // Admin department management
      doctors: '/api/v1/admin/doctors',               // Admin doctor management
      users: '/api/v1/users/admin',                   // Admin user management
      notifications: '/api/v1/notifications/admin',   // Admin notification management
      records: '/api/v1/health-records/admin',        // Admin health records
      investigations: '/api/v1/investigations/admin', // Admin investigations
      pharmacy: '/api/v1/pharmacy/admin',             // Admin pharmacy management
      sos: '/api/v1/sos/admin',                       // Admin SOS/emergency
      staff: '/api/v1/staff/admin',                   // Admin staff management
      analytics: '/api/v1/analytics',                 // Analytics module
      devices: '/api/v1/devices',                     // Device management
      feedback: '/api/v1/feedback',                   // Feedback management
    }
  },

  // User Management
  users: {
    // Main user endpoints
    list: '/api/v1/users',                          // GET, POST, PUT, DELETE
    byRole: '/api/v1/users/role/:role',             // GET
    byId: '/api/v1/users/:identifier',              // GET, PUT, DELETE
    status: '/api/v1/users/:identifier/status',      // PUT
    
    // Admin user endpoints
    dashboard: '/api/v1/users/dashboard',            // GET - User dashboard
    analytics: '/api/v1/users/analytics',            // GET
    systemInfo: '/api/v1/users/system-info',         // GET
    activityAudit: '/api/v1/users/activity-audit',   // GET
    inactiveUsers: '/api/v1/users/inactive-users',   // GET
    generateReport: '/api/v1/users/generate-report', // POST
    bulkImport: '/api/v1/users/bulk-import',         // POST
    reactivate: '/api/v1/users/reactivate/:userId',  // POST
    
    // Search & lookup
    search: '/api/v1/staff/search',                  // GET
    activity: '/api/v1/activity',                    // GET
    advancedSearch: '/api/v1/advanced',              // GET
    bulkSearch: '/api/v1/bulk-search',               // POST
  },

  // Doctors
  doctors: {
    list: '/api/v1/doctors',                         // GET
    byId: '/api/v1/doctors/:doctorId',              // GET, DELETE
    profile: '/api/v1/doctors/profile',              // POST
    profileById: '/api/v1/doctors/profile/:id',      // GET
    updateProfile: '/api/v1/doctors/:id/profile',    // PUT
    availability: '/api/v1/doctors/:id/availability',// PUT
    byDepartment: '/api/v1/doctors/department/:department', // GET
    workloadAnalysis: '/api/v1/doctors/workload-analysis',  // GET
    deactivate: '/api/v1/doctors/:id/deactivate',   // DELETE
    deleteAccount: '/api/v1/doctors/:id/account',    // DELETE
  },

  // Departments
  departments: {
    list: '/api/v1/departments',                     // GET
    create: '/api/v1/departments/create',            // POST
    byId: '/api/v1/departments/:identifier',         // GET
    update: '/api/v1',                               // PUT with :id
    delete: '/api/v1/departments/:departmentId',     // DELETE
    deactivate: '/api/v1/departments/:id/deactivate',// PUT
    
    // Department specific
    withDoctors: '/api/v1/departments/departments-with-doctors', // GET
    availableNow: '/api/v1/departments/available/now',          // GET
    manage: '/api/v1/departments/manage',                        // GET
    overview: '/api/v1/departments/overview',                    // GET
    
    // Analytics & Reports
    stats: '/api/v1/:id/stats',                      // GET
    analytics: '/api/v1/:id/analytics',              // GET
    performance: '/api/v1/:id/performance',          // GET
    trends: '/api/v1/:id/trends',                    // GET
    comparison: '/api/v1/comparison',                // GET
    
    // Admin operations
    bulkOperations: '/api/v1/departments/bulk-operations',       // POST
    exportCsv: '/api/v1/departments/export/csv',                // GET
    exportReport: '/api/v1/departments/:id/export/report',      // GET
    recentActivities: '/api/v1/departments/activities/recent',  // GET
    financial: '/api/v1/departments/:id/financial',             // GET
    history: '/api/v1/departments/:id/history',                 // GET
    staffAllocation: '/api/v1/departments/:id/staff-allocation',// GET
  },

  // Appointments
  appointments: {
    list: '/api/v1/list',                            // GET
    book: '/api/v1/book',                            // POST
    todayList: '/api/v1/today/list',                 // GET
    byId: '/api/v1/:id',                             // GET, PUT, DELETE
    updateStatus: '/api/v1/:id/status',              // PUT
    byDoctor: '/api/v1/doctor/:doctor_id',           // GET
    byPatient: '/api/v1/patient/:patient_id',        // GET
    byPhone: '/api/v1/phone/:phone',                 // GET
    byUid: '/api/v1/uid/:uid',                       // GET
    
    // Admin appointment endpoints
    admin: {
      analytics: '/api/v1/appointments/admin/analytics',
      conflicts: '/api/v1/appointments/admin/conflicts',
      capacity: '/api/v1/appointments/admin/capacity',
      noShows: '/api/v1/appointments/admin/no-shows',
    }
  },

  // Pharmacy - Note: Many are protected routes
  pharmacy: {
    // Inventory
    categories: '/api/v1/categories/list',           // GET
    
    // These are protected endpoints with special naming
    adminRoutes: '/api/v1/admin/pharmacyAdminRoutes',// GET (protected)
    orderRoutes: '/api/v1/pharmacyOrderRoutes',      // GET, POST (protected)
    medicationRoutes: {
      staff: '/api/v1/pharmacyStaffMedicationRoutes',    // GET, PUT (protected)
      admin: '/api/v1/pharmacyAdminMedicationRoutes',    // POST, PUT, DELETE (protected)
    },
    inventoryRoutes: '/api/v1/pharmacyStaffInventoryRoutes', // GET (protected)
    staffRoutes: '/api/v1/pharmacy/staffPharmacyRoutes',     // POST (protected)
  },

  // Notifications
  notifications: {
    list: '/api/v1/notifications/:phone',             // GET
    byUserId: '/api/v1/notifications/user/:user_id', // GET
    detail: '/api/v1/notifications/detail/:id',       // GET
    markRead: '/api/v1/notifications/:id/read',       // PATCH
    markAllRead: '/api/v1/notifications/:phone/mark-all-read',    // PATCH
    markAllReadByUser: '/api/v1/notifications/user/:user_id/read-all', // PATCH
    
    // Admin notifications
    templates: '/api/v1/notifications/templates',     // GET, POST
    announcement: '/api/v1/notifications/announcement',// POST
    targeted: '/api/v1/notifications/targeted',       // POST
    bulk: '/api/v1/notifications/bulk',               // POST
    sendFromTemplate: '/api/v1/notifications/send-from-template', // POST
    cleanup: '/api/v1/notifications/cleanup',         // DELETE
    
    // Stats & monitoring
    deliveryStats: '/api/v1/notifications/delivery-stats',     // GET
    statsSummary: '/api/v1/notifications/stats/summary',       // GET
    emergencyActive: '/api/v1/notifications/emergency/active', // GET
    scheduledPending: '/api/v1/notifications/scheduled/pending',// GET
  },

  // Medical Records
  records: {
    list: '/api/v1/records',                          // GET, POST
    byId: '/api/v1/records/:id',                      // GET, PUT
    byPhone: '/api/v1/health-records/:phone',         // GET
    create: '/api/v1/health-records',                 // POST
    consultations: '/api/v1/consultations/:phoneNumber', // GET
    
    // Patient specific
    patientSummary: '/api/v1/patient/:patient_id/summary',   // GET
    patientAllergies: '/api/v1/patient/:patient_id/allergies',// GET
    patientConditions: '/api/v1/patient/:patient_id/conditions',// GET
    patientTrends: '/api/v1/patient/:patient_id/trends',     // GET
    
    // Admin routes
    adminAnalytics: '/api/v1/admin/admin/analytics',  // GET
    hipaaAudit: '/api/v1/admin/admin/hipaa-audit',   // GET
    exportExcel: '/api/v1/admin/export/excel',       // GET
    exportPdf: '/api/v1/admin/export/pdf',           // GET
  },

  // Staff Management
  staff: {
    search: '/api/v1/staff/search',                   // GET
    attendance: '/api/v1/attendance',                 // GET
    rollCall: '/api/v1/roll-call',                   // GET
    
    // Protected staff routes
    staffRoutes: '/api/v1/staff/staffRoutes',         // GET, POST, PUT (protected)
    attendanceRoutes: '/api/v1/staffAttendanceRoutes',// GET, POST (protected)
    hrRoutes: '/api/v1/staffHRRoutes',               // GET, POST, PUT (protected)
    medicalRoutes: '/api/v1/staffMedicalRoutes',     // POST (protected)
    
    // Admin staff endpoints
    admin: {
      analytics: {
        attendance: '/api/v1/staff/admin/analytics/attendance',
      },
      dashboard: '/api/v1/staff/admin/dashboard',
      hr: {
        pendingReviews: '/api/v1/staff/admin/hr/pending-reviews',
      },
      attendance: {
        anomalies: '/api/v1/staff/admin/attendance/anomalies',
        absentReport: '/api/v1/staff/admin/attendance/absent-report',
      }
    }
  },

  // Investigations
  investigations: {
    routes: '/api/v1/investigations/investigationRoutes', // GET, POST, PUT, DELETE (protected)
  },

  // SOS/Emergency
  sos: {
    routes: '/api/v1/sos/sosRoutes',                  // GET, POST (protected)
    adminRoutes: '/api/v1/sos/adminSosRoutes',       // GET, POST (protected)
    emergencyRoutes: '/api/v1/sos/emergencyResponderRoutes', // GET, POST (protected)
  },

  // Analytics
  analytics: {
    dashboard: '/api/v1/analytics',                   // GET - Main analytics
    userGrowth: '/api/v1/analytics/user-growth',      // GET
    appointmentTrends: '/api/v1/analytics/appointment-trends', // GET
    departmentUtilization: '/api/v1/analytics/department-utilization', // GET
    revenue: '/api/v1/analytics/revenue',             // GET
  },

  // Device Management
  devices: {
    list: '/api/v1/devices',                          // GET
    register: '/api/v1/devices/register',             // POST
    byId: '/api/v1/devices/:deviceId',                // GET, PUT, DELETE
    userDevices: '/api/v1/devices/user/:userId',      // GET
  },

  // Feedback
  feedback: {
    list: '/api/v1/feedback',                         // GET
    create: '/api/v1/feedback',                       // POST
    byId: '/api/v1/feedback/:feedbackId',             // GET, PUT
    byUser: '/api/v1/feedback/user/:userId',          // GET
    statistics: '/api/v1/feedback/statistics',        // GET
  },

  // Infrastructure
  infrastructure: {
    apiDocs: '/api/v1/api-docs',                      // USE
    swagger: '/api-docs/adminDocumentationRoutes',    // GET, POST (protected)
    debug: '/api/v1/debug/debugRoutes',               // GET (protected)
    rbac: '/api/v1/rbac/rbacRoutes',                  // GET, POST (protected)
    auditLog: '/api/v1/rbac/admin/audit-log',        // GET (protected)
    toggleUserStatus: '/api/v1/rbac/admin/toggle-user-status', // POST (protected)
  }
};

// Helper to identify protected routes
export const PROTECTED_ROUTES = [
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

// API configuration helpers
export const getHeaders = (token?: string) => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'x-api-key': 'vhhealth123',
    'Origin': typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  return headers;
};

// Helper function to build full URL
export const buildUrl = (endpoint: string, params?: Record<string, string>) => {
  let url = `${API_BASE_URL}${endpoint}`;
  
  // Replace path parameters
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url = url.replace(`:${key}`, value);
    });
  }
  
  return url;
};

// Helper function to check if a route requires authentication
export const requiresAuth = (endpoint: string): boolean => {
  return PROTECTED_ROUTES.some(route => {
    if (route.endsWith('*')) {
      return endpoint.startsWith(route.slice(0, -1));
    }
    return endpoint === route;
  });
};