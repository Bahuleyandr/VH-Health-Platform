// src/lib/api-config.ts
// Correct API endpoint mapping based on your backend routes

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://vh-health-backend.onrender.com';

// Actual working endpoints from your backend
export const API_ENDPOINTS = {
  // Health & System Status
  health: {
    check: '/api/v1/health-check',              // GET - Health check
    system: '/api/v1/system/status',            // GET - System status
    appVersion: '/api/v1/app-version',          // GET - App version
  },

  // Authentication - These seem to be OTP-based
  auth: {
    // OTP-based auth endpoints
    generateOtp: '/api/v1/auth/generate-test-otp',  // POST
    verifyOtp: '/api/v1/auth/verify-test-otp',      // POST
    stats: '/api/v1/auth/stats',                     // GET
    
    // Admin management (protected)
    adminManagement: '/api/v1/auth/adminManagement', // GET, POST, PUT (protected)
    
    // User verification
    verify: '/api/v1/verify',                        // GET
  },

  // User Management
  users: {
    // Main user endpoints
    list: '/api/v1/users',                          // GET, POST, PUT, DELETE
    byRole: '/api/v1/users/role/:role',             // GET
    byId: '/api/v1/users/:identifier',              // GET, PUT, DELETE
    status: '/api/v1/users/:identifier/status',      // PUT
    
    // Admin user endpoints
    dashboard: '/api/v1/users/dashboard',            // GET - This is your dashboard!
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
  // Add more as needed
];

// Mapping of what your frontend expects vs what actually exists
export const ENDPOINT_MAPPING = {
  // What you're trying → What actually exists
  '/api/v1/admin/dashboard': '/api/v1/users/dashboard',
  '/api/v1/admin/statistics': '/api/v1/users/analytics',
  '/api/v1/admin/me': '/api/v1/users/system-info', // or use OTP verification
  '/api/v1/admin/users': '/api/v1/users',
  '/api/v1/admin/doctors': '/api/v1/doctors',
  '/api/v1/admin/departments': '/api/v1/departments',
  '/api/v1/pharmacy/analytics': '/api/v1/admin/pharmacyAdminRoutes',
  '/api/v1/pharmacy/orders': '/api/v1/pharmacyOrderRoutes',
  '/api/v1/pharmacy/inventory': '/api/v1/pharmacyStaffInventoryRoutes',
  '/api/v1/pharmacy/medicines': '/api/v1/pharmacyStaffMedicationRoutes',
};