// src/lib/api-config.ts
// Complete API endpoint mapping for VH Health Admin Portal

/**
 * Backend URL used by **server-side** Next.js routes (login, proxy, refresh,
 * MFA, realtime-ticket). Prefers `BACKEND_URL` so deployments where the pod
 * can't resolve the public hostname (e.g. dalekdefender k3s where the
 * Tailscale MagicDNS isn't visible to CoreDNS) can point at an in-cluster
 * Service like `http://vhhealth-backend.vhhealth.svc.cluster.local:5000`.
 * Falls back to NEXT_PUBLIC_API_URL so existing deployments work unchanged.
 */
export function getServerBackendUrl(): string {
  return (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "https://api.vhhealth.app"
  );
}

const SERVER_API_BASE_URL = getServerBackendUrl();

// Client-side requests must go through the Next.js proxy so the server can
// inject the backend API key and auth cookie.
export const API_BASE_URL =
  typeof window !== "undefined" ? "/api/proxy" : SERVER_API_BASE_URL;

// WebSocket URL configuration
export const WS_BASE_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  SERVER_API_BASE_URL.replace("https://", "wss://").replace("http://", "ws://");

// Origin header for API requests — uses browser origin client-side,
// falls back to the API base URL server-side (never localhost).
const DEFAULT_ORIGIN =
  (typeof window !== "undefined" && window.location.origin) || API_BASE_URL;

// Single WebSocket endpoint — backend uses channel subscriptions after connecting to /ws
export const WS_ENDPOINT = "/ws";

// Legacy alias — kept for any direct references
export const WS_ENDPOINTS = {
  admin: "/ws",
  notifications: "/ws",
  sos: "/ws",
  activity: "/ws",
};

export const API_ENDPOINTS = {
  // Health & System Status
  health: {
    check: "/api/v1/health/health-check", // GET
    system: "/api/v1/system/status", // GET
    appVersion: "/api/v1/health/app-version", // GET
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
      createAdmin: "/api/v1/auth/admin/create-admin", // POST (SUPER_ADMIN)
      deactivate: "/api/v1/auth/admin/deactivate", // POST (SUPER_ADMIN)
      reactivate: "/api/v1/auth/admin/reactivate", // POST (SUPER_ADMIN)
      updatePermissions: "/api/v1/auth/admin/update-permissions", // PUT (SUPER_ADMIN)
    },

    // Staff authentication (employee ID + password)
    staff: {
      login: "/api/v1/auth/staff/login", // POST { employeeId, password }
      profile: "/api/v1/auth/staff/profile", // GET
      logout: "/api/v1/auth/staff/logout", // POST
    },

    // OTP (test/secondary)
    generateOtp: "/api/v1/auth/otp/request-otp", // POST
    verifyOtp: "/api/v1/auth/otp/verify-otp", // POST
    stats: "/api/v1/auth/stats", // GET

    // Admin management (if present)
    adminManagement: "/api/v1/auth/admin/list", // GET list of admins (protected)

    // Tokens
    refreshToken: "/api/v1/auth/refresh-token", // POST
  },

  // Staff self-service endpoints
  myWork: {
    appointments: {
      todayQueue: "/api/v1/appointments/queue/today", // GET (filtered by token's staff_id)
      pending: "/api/v1/appointments/pending", // GET
      confirm: (id: number) => `/api/v1/appointments/${id}/confirm`, // POST
      complete: (id: number) => `/api/v1/appointments/${id}/complete`, // POST
      noShow: (id: number) => `/api/v1/appointments/${id}/no-show`, // POST
    },
    attendance: {
      myAttendance: "/api/v1/staff/attendance/my", // GET
      regularize: "/api/v1/staff/attendance/regularize", // POST
      dispute: "/api/v1/staff/attendance/dispute", // POST
    },
    leave: {
      myLeave: "/api/v1/staff/hr/leave/my", // GET
      apply: "/api/v1/staff/hr/leave/apply", // POST
      balance: "/api/v1/staff/hr/leave/balance", // GET
    },
    payslips: {
      list: "/api/v1/staff/hr/payroll/my-payslips", // GET
      download: (id: string) =>
        `/api/v1/staff/hr/payroll/my-payslips/${id}/download`, // GET
      password: (id: string) =>
        `/api/v1/staff/hr/payroll/my-payslips/${encodeURIComponent(id)}/password`, // POST
      taxSummary: "/api/v1/staff/hr/payroll/tax-summary", // GET
    },
    replacements: {
      list: "/api/v1/staff/replacements/my", // GET
      create: "/api/v1/staff/replacements", // POST
    },
    prescriptions: {
      completedAppointments: "/api/v1/appointments/completed/recent", // GET
      upload: "/api/v1/staff/prescriptions/upload", // POST (multipart)
      myUploads: "/api/v1/staff/prescriptions/my", // GET
    },
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
      appointmentSummary: "/api/v1/admin/appointments/summary", // GET - getAppointmentSummary()
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

    database: {
      overview: "/api/v1/admin/database/overview", // GET - schema, table inventory, contract status
      tableRows: (tableName: string) =>
        `/api/v1/admin/database/tables/${encodeURIComponent(tableName)}/rows`, // GET
    },

    // General Ledger reports (T2 ledger Phase 5; finance-gated, read-only)
    ledger: {
      trialBalance: "/api/v1/admin/ledger/trial-balance", // GET
      arAging: "/api/v1/admin/ledger/ar-aging", // GET
      insurerAging: "/api/v1/admin/ledger/insurer-aging", // GET
      cashPosition: "/api/v1/admin/ledger/cash-position", // GET
      dailyCollection: "/api/v1/admin/ledger/daily-collection", // GET ?from=&to=
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
      // No updateConfig: the backend endpoint never persisted anything and
      // nothing reads a SOS config, so it was removed (audit F1).
      broadcast: "/api/v1/admin/sos/broadcast", // POST - broadcastEmergencyAlert()
      escalate: (alertId: string | number) =>
        `/api/v1/admin/sos/escalate/${encodeURIComponent(String(alertId))}`, // POST - escalateAlert()
    },

    // Upload/File Management (matching uploadService.js)
    uploads: {
      summary: "/api/v1/admin/upload/summary", // GET - getUploadSummary()
      quarantined: "/api/v1/admin/upload/quarantine", // GET - listQuarantinedFiles()
      hipaaAudit: "/api/v1/admin/upload/hipaa/audit", // GET - getHipaaAuditReport()
      rescan: "/api/v1/admin/upload/rescan/:fileId", // POST - rescanFile()
      cleanup: "/api/v1/admin/upload/cleanup", // POST - cleanupExpiredFiles()
      bulkHipaa: "/api/v1/admin/upload/hipaa/bulk-protect", // POST - bulkUpdateHipaaProtection()
      purgeQuarantine: "/api/v1/admin/upload/quarantine/purge", // POST - purgeQuarantinedFiles()
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
    search: "/api/v1/users/search", // GET
    activity: "/api/v1/users/lookup/activity", // GET
    advancedSearch: "/api/v1/users/lookup/advanced", // GET
    bulkSearch: "/api/v1/users/lookup/bulk-search", // POST
  },

  // Doctors
  doctors: {
    list: "/api/v1/doctors", // GET
    byId: "/api/v1/doctors/:doctorId", // GET/DELETE
    profile: "/api/v1/doctors/profile", // POST
    profileById: "/api/v1/doctors/profile/:id", // GET
    updateProfile: "/api/v1/doctors/admin/:id/profile", // PUT
    availability: "/api/v1/doctors/admin/:id/availability", // PUT
    byDepartment: "/api/v1/doctors/department/:department", // GET
    workloadAnalysis: "/api/v1/doctors/admin/workload-analysis", // GET
    deactivate: "/api/v1/doctors/:id/deactivate", // DELETE
    deleteAccount: "/api/v1/doctors/admin/:id/account", // DELETE

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
    byId: "/api/v1/departments/:departmentId", // GET
    update: "/api/v1/departments/:departmentId", // PUT
    delete: "/api/v1/departments/:departmentId", // DELETE
    deactivate: "/api/v1/departments/:id/deactivate", // PUT

    withDoctors: "/api/v1/departments/departments-with-doctors", // GET
    availableNow: "/api/v1/departments/available/now", // GET
    manage: "/api/v1/departments/admin/manage", // GET
    overview: "/api/v1/departments/admin/overview", // GET

    // Analytics & Reports
    stats: "/api/v1/departments/stats/:id/stats", // GET
    analytics: "/api/v1/departments/stats/:id/analytics", // GET
    performance: "/api/v1/departments/stats/:id/performance", // GET
    trends: "/api/v1/departments/stats/:id/trends", // GET
    comparison: "/api/v1/departments/stats/comparison", // GET

    // Admin ops
    bulkOperations: "/api/v1/departments/admin/bulk-operations", // POST
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

    queue: "/api/v1/appointments/queue/today",
    pending: "/api/v1/appointments/pending",
    documents: "/api/v1/appointments/documents/upload",
    allDocuments: "/api/v1/appointments/admin/documents",
    slaDashboard: "/api/v1/appointments/admin/sla-dashboard",
    auditTrail: "/api/v1/appointments/admin/audit-trail",

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
  // NOTE: Backend mounts pharmacy at /api/v1/pharmacy-orders (not /pharmacy)
  pharmacy: {
    categories: "/api/v1/pharmacy-orders/catalog", // GET
    orders: "/api/v1/pharmacy-orders/orders/queue", // GET
    sla: "/api/v1/pharmacy-orders/orders/sla", // GET
    inventory: "/api/v1/pharmacy-orders/inventory", // GET
  },

  // Notifications
  notifications: {
    list: "/api/v1/notifications/my", // GET
    byUserId: "/api/v1/notifications/user/:user_id", // GET
    detail: "/api/v1/notifications/detail/:id", // GET
    markRead: "/api/v1/notifications/:id/read", // PATCH
    markAllRead: "/api/v1/notifications/my/mark-all-read", // PATCH
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
    list: "/api/v1/records/records", // GET/POST
    byId: "/api/v1/records/:id", // GET/PUT
    byPhone: "/api/v1/records/health-records/:phone", // GET
    create: "/api/v1/records/health-records", // POST
    consultations: "/api/v1/records/consultations/:phoneNumber", // GET

    // Admin
    adminAnalytics: "/api/v1/records/admin/analytics", // GET
    hipaaAudit: "/api/v1/records/admin/hipaa-audit", // GET
    exportExcel: "/api/v1/records/export/excel", // GET
    exportPdf: "/api/v1/records/export/pdf", // GET
  },

  // Staff
  staff: {
    search: "/api/v1/staff/admin/search", // GET
    attendance: "/api/v1/staff/attendance", // GET
    rollCall: "/api/v1/staff/roll-call", // GET

    medicalRoutes: "/api/v1/staff/medical/investigations", // POST (protected)
    medical: {
      consultations: "/api/v1/staff/medical/consultations", // POST
      investigations: "/api/v1/staff/medical/investigations", // POST/multipart
    },

    admin: {
      analytics: {
        attendance: "/api/v1/staff/admin/analytics/attendance",
      },
      dashboard: "/api/v1/staff/admin/dashboard",
      hr: {
        pendingReviews: "/api/v1/staff/admin/hr/pending-reviews",
      },
      attendance: {
        anomalies: "/api/v1/staff/admin/attendance/anomalies",
        absentReport: "/api/v1/staff/admin/attendance/absent-report",
      },
    },
  },

  // Investigations
  investigations: {
    list: "/api/v1/investigations/list",
    catalog: "/api/v1/investigations/catalog",
    slaDashboard: "/api/v1/investigations/sla-dashboard",
    pending: "/api/v1/investigations/status/pending",
    admin: {
      analytics: "/api/v1/admin/investigations/summary",
      pending: "/api/v1/investigations/status/pending",
    },
  },

  // ABDM
  abdm: {
    status: "/api/v1/abdm/status", // GET
    consentRequests: "/api/v1/abdm/consent-requests", // GET
    patientByAbha: "/api/v1/abdm/patient-by-abha/:abhaNumber", // GET
    registerAbha: "/api/v1/abdm/register-abha", // POST
    verifyAbha: "/api/v1/abdm/verify-abha", // POST
  },

  // Analytics (general) — mounted under /api/v1/admin/analytics
  analytics: {
    dashboard: "/api/v1/admin/analytics/dashboard", // GET
    userGrowth: "/api/v1/admin/analytics/trends", // GET — pass ?metric=users (no /registrations route exists)
    appointmentTrends: "/api/v1/admin/analytics/trends", // GET — pass ?metric=appointments
    departmentUtilization: "/api/v1/admin/analytics/departments", // GET
    satisfaction: "/api/v1/admin/analytics/satisfaction", // GET
    usage: "/api/v1/admin/analytics/usage", // GET
  },

  // Devices
  devices: {
    list: "/api/v1/devices/admin/list", // GET
    register: "/api/v1/devices/register", // POST
    byId: "/api/v1/devices/device/:deviceId", // GET/PUT/DELETE
    userDevices: "/api/v1/devices/my-devices", // GET
  },

  // Feedback
  feedback: {
    list: "/api/v1/feedback", // GET
    create: "/api/v1/feedback", // POST
    byId: "/api/v1/feedback/:feedbackId", // GET/PUT
    byUser: "/api/v1/feedback/uid/:uid", // GET
    statistics: "/api/v1/feedback/analytics", // GET
  },

  // Billing & Invoicing
  billing: {
    createInvoice: "/api/v1/billing/invoice", // POST
    invoiceDetail: (id: number) => `/api/v1/billing/invoice/${id}`, // GET
    patientInvoices: (patientUid: string) =>
      `/api/v1/billing/invoices/patient/${patientUid}`, // GET
    recordPayment: (id: number) => `/api/v1/billing/invoice/${id}/payment`, // POST
    revenue: "/api/v1/billing/revenue", // GET
    revenueCycle: {
      arAging: "/api/v1/billing/ar-aging", // GET
      claimQueue: "/api/v1/billing/claim-queue", // GET
    },
    insurance: {
      submitClaim: "/api/v1/billing/insurance/claim", // POST
      listClaims: "/api/v1/billing/insurance/claims", // GET
      updateClaim: (id: number) => `/api/v1/billing/insurance/claim/${id}`, // PUT
    },
  },

  // EMR (Electronic Medical Records)
  emr: {
    admissions: "/api/v1/emr/admissions", // GET - list active admissions
    admissionDetail: (id: number) => `/api/v1/emr/admission/${id}`, // GET - single admission
    admissionStats: "/api/v1/emr/admissions/stats", // GET - ?date_from=&date_to=
    timeline: (uid: string) => `/api/v1/emr/timeline/${uid}`, // GET - patient timeline
    clinicalAiConfig: "/api/v1/emr/clinical-ai/config", // GET - clinical AI provider status
    downtimeSnapshot: (uid: string) => `/api/v1/emr/downtime-snapshot/${uid}`, // POST
    notes: (uid: string) => `/api/v1/emr/notes/patient/${uid}`, // GET - clinical notes
    orders: (uid: string) => `/api/v1/emr/orders/patient/${uid}`, // GET - clinical orders
    diagnosis: (uid: string) => `/api/v1/emr/diagnosis/patient/${uid}`, // GET - active problem list
    cdsAlerts: (uid: string) => `/api/v1/emr/cds/alerts/${uid}`, // GET - clinical decision support alerts
    icd10Search: "/api/v1/emr/icd10/search", // GET - ?q=search_term
  },

  clinical: {
    handoverDraft: "/api/v1/clinical/handover/generate", // POST
  },

  // Infrastructure / Admin Tools
  infrastructure: {
    apiDocs: "/api-docs", // GET
    swagger: "/api-docs", // GET
    debug: "/api/v1/debug/routes", // GET (protected)
    auditLog: "/api/v1/logs/audit", // GET (protected) - served by logRoutes
    auditLogExport: "/api/v1/logs/audit/export", // GET - CSV export
    systemLog: "/api/v1/logs/system", // GET - system/admin activity logs
    systemLogExport: "/api/v1/logs/system/export", // GET - CSV export
    toggleUserStatus: "/api/v1/rbac/admin/toggle-user-status", // POST (protected)
  },
};

// Standard JSON headers for client-side requests.
// NOTE: x-api-key is intentionally omitted here — client-side fetch calls route
// through /api/proxy which injects the API key server-side from process.env.API_KEY.
export const getHeaders = (token?: string): HeadersInit => {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
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

export const ensureApiV1Path = (path: string) => {
  if (path.startsWith("/api/v1/")) return path;
  if (path.startsWith("/")) return `/api/v1${path}`;
  return `/api/v1/${path}`;
};

export const buildProxyUrl = (path: string) => buildUrl(ensureApiV1Path(path));
