// src/lib/api/index.ts
// Barrel file — re-exports from all domain-specific API modules
// so existing imports continue to work unchanged

// Use import+re-export so symbols are in local scope for the `api` namespace below

// Core types & helpers
import {
  APIError,
  getJSON,
  postJSON,
  putJSON,
  deleteJSON,
  fetchAdminAPI,
  API_ENDPOINTS,
} from "./core";
export type { APIResponse, QueryParams } from "./core";
export { APIError, getJSON, postJSON, putJSON, deleteJSON, fetchAdminAPI, API_ENDPOINTS };

// Auth
import { generateOTP, verifyOTP, loginAdmin, getAuthStats } from "./auth";
export { generateOTP, verifyOTP, loginAdmin, getAuthStats };

// Dashboard & Analytics
import {
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
export {
  getDashboardData, getUserAnalytics, getSystemInfo, getActivityAudit,
  getRecentActivities, getAdminDashboard, getQuickStats, getUserStats,
  getDoctorStats, getDepartmentStats, getAppointmentStats, getRecordStats,
  getEmergencyStats, getStaffStats, getAppointmentSummary, getRecentActivity,
  getSystemAlerts, getModuleHealth, getSystemHealth, refreshDashboardCache,
  generateDashboardReport,
};

// Attendance
import {
  getAttendanceAnalytics, getAttendanceAnomalies, getLateArrivals,
  getEarlyDepartures, getAbsentReport,
} from "./attendance";
export { getAttendanceAnalytics, getAttendanceAnomalies, getLateArrivals, getEarlyDepartures, getAbsentReport };

// SOS/Emergency
import {
  getSosAnalytics, getSosAlerts, getEmergencyServices, getSosPerformanceReport,
  updateSosConfig, broadcastEmergencyAlert, escalateAlert,
} from "./sos";
export { getSosAnalytics, getSosAlerts, getEmergencyServices, getSosPerformanceReport, updateSosConfig, broadcastEmergencyAlert, escalateAlert };

// Uploads
import {
  getUploadSummary, getQuarantinedFiles, getHipaaAuditReport, rescanFile,
  cleanupExpiredFiles, bulkUpdateHipaaProtection, purgeQuarantinedFiles,
} from "./uploads";
export { getUploadSummary, getQuarantinedFiles, getHipaaAuditReport, rescanFile, cleanupExpiredFiles, bulkUpdateHipaaProtection, purgeQuarantinedFiles };

// Users
import { getUsers, getUsersByRole, updateUserStatus, getInactiveUsers, reactivateUser } from "./users";
export { getUsers, getUsersByRole, updateUserStatus, getInactiveUsers, reactivateUser };

// Departments
import {
  getDepartments, createDepartment, updateDepartment, deleteDepartment,
  getDepartmentStaffAllocation, getDepartmentHistory, exportDepartmentsCsv,
} from "./departments";
export {
  getDepartments, createDepartment, updateDepartment, deleteDepartment,
  getDepartmentStaffAllocation, getDepartmentHistory, exportDepartmentsCsv,
};

// Doctors
import {
  getDoctors, deleteDoctor, getDoctorProfile, updateDoctorAvailability,
  getDoctorOverview, getDoctorManagementList, getDoctorAnalytics,
  createDoctor, doctorBulkOperations, getDoctorWorkloadAnalysis,
} from "./doctors";
export {
  getDoctors, deleteDoctor, getDoctorProfile, updateDoctorAvailability,
  getDoctorOverview, getDoctorManagementList, getDoctorAnalytics,
  createDoctor, doctorBulkOperations, getDoctorWorkloadAnalysis,
};

// Appointments
import {
  getAppointments, getAppointmentAnalytics, getAppointmentConflicts,
  getAppointmentCapacity, getNoShows,
  bulkUpdateAppointmentStatus, overrideBookAppointment, resolveAppointmentConflict,
  sendAppointmentReminders, bulkDeleteAppointments, searchAppointments, exportAppointments,
} from "./appointments";
export {
  getAppointments, getAppointmentAnalytics, getAppointmentConflicts, getAppointmentCapacity, getNoShows,
  bulkUpdateAppointmentStatus, overrideBookAppointment, resolveAppointmentConflict,
  sendAppointmentReminders, bulkDeleteAppointments, searchAppointments, exportAppointments,
};

// Analytics
import {
  getAnalyticsDashboard, getUserGrowthAnalytics, getAppointmentTrends,
  getDepartmentUtilization, getPatientSatisfaction, getUsageAnalytics,
} from "./analytics";
export {
  getAnalyticsDashboard, getUserGrowthAnalytics, getAppointmentTrends,
  getDepartmentUtilization, getPatientSatisfaction, getUsageAnalytics,
};

// Staff
import { getStaffByShift, bulkShiftAssignment } from "./staff";
export { getStaffByShift, bulkShiftAssignment };

// Notifications
import { getNotificationTemplates, sendAnnouncement, sendTargetedNotification, getNotificationStats } from "./notifications";
export { getNotificationTemplates, sendAnnouncement, sendTargetedNotification, getNotificationStats };

// Admin Management
import { createAdminUser, deactivateAdmin, reactivateAdmin, updateAdminPermissions } from "./admin";
export { createAdminUser, deactivateAdmin, reactivateAdmin, updateAdminPermissions };

// Settings
import { updateSystemSetting, getSystemSettings } from "./settings";
export { updateSystemSetting, getSystemSettings };

// Infrastructure & Logs
import { getAuditLogs, toggleUserStatus } from "./infrastructure";
export { getAuditLogs, toggleUserStatus };

// Billing & Invoicing
import {
  createInvoice, getPatientInvoices, getInvoiceDetail, recordPayment,
  getRevenueStats, getARAging, getClaimQueue,
  submitInsuranceClaim, getInsuranceClaims, updateInsuranceClaimStatus,
} from "./billing";
export type {
  Invoice, InvoiceDetail, InvoiceLineItem, CreateInvoicePayload,
  PaymentTransaction, RecordPaymentPayload, PaymentResult,
  InsuranceClaim, SubmitClaimPayload, UpdateClaimPayload,
  RevenueStats, RevenueSummary, ARAgingSummary, ARAgingBucket,
  ARAgingInvoice, ClaimQueueResponse, ClaimQueueSummary, ClaimQueueItem,
  Pagination,
} from "./billing";
export {
  createInvoice, getPatientInvoices, getInvoiceDetail, recordPayment,
  getRevenueStats, getARAging, getClaimQueue,
  submitInsuranceClaim, getInsuranceClaims, updateInsuranceClaimStatus,
};

// EMR (Electronic Medical Records)
import {
  getActiveAdmissions, getAdmissionDetail, getAdmissionStats,
  getPatientTimeline, getPatientNotes, getPatientOrders,
  getActiveProblemList, getActiveAlerts, searchICD10,
  getClinicalAiConfig, generateHandoverDraft, createDowntimeSnapshot,
  getClinicalAiGenerations, getClinicalAiSafetyFlags,
  generateDischargeSummary, saveDischargeSummary, signDischargeSummary,
} from "./emr";
export type {
  Admission, ClinicalNote, ClinicalOrder, AdmissionStats, ClinicalAiConfig,
  ClinicalAiGeneration, ClinicalAiSafetyFlag, DischargeSummary,
} from "./emr";
export {
  getActiveAdmissions, getAdmissionDetail, getAdmissionStats,
  getPatientTimeline, getPatientNotes, getPatientOrders,
  getActiveProblemList, getActiveAlerts, searchICD10,
  getClinicalAiConfig, generateHandoverDraft, createDowntimeSnapshot,
  getClinicalAiGenerations, getClinicalAiSafetyFlags,
  generateDischargeSummary, saveDischargeSummary, signDischargeSummary,
};

// Convenience namespace export (back-compat for `import { api } from "@/lib/api"`)
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
  getRecentActivities,
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
  getDepartmentStaffAllocation,
  getDepartmentHistory,
  exportDepartmentsCsv,

  // Doctors
  getDoctors,
  deleteDoctor,
  getDoctorProfile,
  updateDoctorAvailability,
  getDoctorOverview,
  getDoctorManagementList,
  getDoctorAnalytics,
  createDoctor,
  doctorBulkOperations,
  getDoctorWorkloadAnalysis,

  // Appointments
  getAppointments,
  getAppointmentAnalytics,
  getAppointmentConflicts,
  bulkUpdateAppointmentStatus,
  overrideBookAppointment,
  resolveAppointmentConflict,
  sendAppointmentReminders,
  bulkDeleteAppointments,
  searchAppointments,
  exportAppointments,

  // Analytics
  getAnalyticsDashboard,
  getUserGrowthAnalytics,
  getAppointmentTrends,
  getDepartmentUtilization,
  getPatientSatisfaction,
  getUsageAnalytics,

  // Staff
  getStaffByShift,
  bulkShiftAssignment,

  // Notifications
  getNotificationTemplates,
  sendAnnouncement,
  sendTargetedNotification,

  // Admin Management
  createAdminUser,
  deactivateAdmin,
  reactivateAdmin,
  updateAdminPermissions,

  // EMR
  getActiveAdmissions,
  getAdmissionDetail,
  getAdmissionStats,
  getPatientTimeline,
  getPatientNotes,
  getPatientOrders,
  getActiveProblemList,
  getActiveAlerts,
  searchICD10,
  getClinicalAiConfig,
  generateHandoverDraft,
  createDowntimeSnapshot,
  getClinicalAiGenerations,
  getClinicalAiSafetyFlags,
  generateDischargeSummary,
  saveDischargeSummary,
  signDischargeSummary,

  // Billing & Invoicing
  createInvoice,
  getPatientInvoices,
  getInvoiceDetail,
  recordPayment,
  getRevenueStats,
  getARAging,
  getClaimQueue,
  submitInsuranceClaim,
  getInsuranceClaims,
  updateInsuranceClaimStatus,
};
