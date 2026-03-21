// src/lib/api/index.ts
// Barrel file — re-exports from all domain-specific API modules
// so existing imports continue to work unchanged

// Core types & helpers
export {
  APIError,
  APIResponse,
  getJSON,
  postJSON,
  putJSON,
  deleteJSON,
  fetchAdminAPI,
  API_ENDPOINTS,
} from "./core";
export type { QueryParams } from "./core";

// Auth
export {
  generateOTP,
  verifyOTP,
  loginAdmin,
  getAuthStats,
} from "./auth";

// Dashboard & Analytics
export {
  getDashboardData,
  getUserAnalytics,
  getSystemInfo,
  getActivityAudit,
  getRecentActivities,
  getAdminDashboard,
  getQuickStats,
  getUserStats,
  getDoctorStats,
  getDepartmentStats,
  getAppointmentStats,
  getRecordStats,
  getEmergencyStats,
  getStaffStats,
  getAppointmentSummary,
  getRecentActivity,
  getSystemAlerts,
  getModuleHealth,
  getSystemHealth,
  refreshDashboardCache,
  generateDashboardReport,
} from "./dashboard";

// Attendance
export {
  getAttendanceAnalytics,
  getAttendanceAnomalies,
  getLateArrivals,
  getEarlyDepartures,
  getAbsentReport,
} from "./attendance";

// SOS/Emergency
export {
  getSosAnalytics,
  getSosAlerts,
  getEmergencyServices,
  getSosPerformanceReport,
  updateSosConfig,
  broadcastEmergencyAlert,
  escalateAlert,
} from "./sos";

// Uploads
export {
  getUploadSummary,
  getQuarantinedFiles,
  getHipaaAuditReport,
  rescanFile,
  cleanupExpiredFiles,
  bulkUpdateHipaaProtection,
  purgeQuarantinedFiles,
} from "./uploads";

// Users
export {
  getUsers,
  getUsersByRole,
  updateUserStatus,
  getInactiveUsers,
  reactivateUser,
} from "./users";

// Departments
export {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} from "./departments";

// Doctors
export {
  getDoctors,
  deleteDoctor,
  getDoctorProfile,
  updateDoctorAvailability,
} from "./doctors";

// Appointments
export {
  getAppointments,
  getAppointmentAnalytics,
  getAppointmentConflicts,
  getAppointmentCapacity,
  getNoShows,
} from "./appointments";

// Notifications
export {
  getNotificationTemplates,
  sendAnnouncement,
  sendTargetedNotification,
  getNotificationStats,
} from "./notifications";

// Admin Management
export {
  createAdminUser,
  deactivateAdmin,
  reactivateAdmin,
  updateAdminPermissions,
} from "./admin";

// Settings
export {
  updateSystemSetting,
  getSystemSettings,
} from "./settings";

// Infrastructure & Logs
export {
  getAuditLogs,
  toggleUserStatus,
} from "./infrastructure";

// Convenience namespace export (back-compat)
export const api = {
  // Auth
  loginAdmin,
  generateOTP,
  verifyOTP,
  
  // Dashboard
  getDashboardData,
  getQuickStats,
  getUserStats,
  getDoctorStats,
  getDepartmentStats,
  getAppointmentStats,
  getStaffStats,
  
  // Activity & Monitoring
  getRecentActivity,
  getRecentActivities, // back-compat alias
  getSystemAlerts,
  getModuleHealth,
  
  // Attendance
  getAttendanceAnalytics,
  getAttendanceAnomalies,
  getLateArrivals,
  getEarlyDepartures,
  getAbsentReport,
  
  // SOS/Emergency
  getSosAnalytics,
  getSosAlerts,
  getEmergencyServices,
  broadcastEmergencyAlert,
  escalateAlert,
  
  // Uploads
  getUploadSummary,
  getQuarantinedFiles,
  getHipaaAuditReport,
  cleanupExpiredFiles,
  
  // Users
  getUsers,
  updateUserStatus,
  reactivateUser,
  
  // Departments
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  
  // Doctors
  getDoctors,
  deleteDoctor,
  getDoctorProfile,
  updateDoctorAvailability,
  
  // Appointments
  getAppointments,
  getAppointmentAnalytics,
  getAppointmentConflicts,
  
  // Notifications
  getNotificationTemplates,
  sendAnnouncement,
  sendTargetedNotification,
  
  // Admin Management
  createAdminUser,
  deactivateAdmin,
  reactivateAdmin,
  updateAdminPermissions,
};
