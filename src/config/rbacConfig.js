// src/config/rbacConfig.js
import {
  ADMIN,
  PATIENT,
  NURSING_STAFF,
  PHARMACY_STAFF,
  LAB_STAFF,
  DOCTOR,
  GENERAL_STAFF,
  HR_STAFF
} from '../utils/roles.js';

export default {
  // Global/default buckets (used by some wrappers)
  ALL: [ADMIN],

  // ✅ Centralized Admin namespace (consistent with /api/v1/admin/*)
  adminDashboard: [ADMIN],              // used by routes/admin/index.js wrapAutoRBAC key
  adminRoutes: [ADMIN],                 // generic catch-all if some modules reference this
  adminDepartmentRoutes: [ADMIN],
  adminDoctorRoutes: [ADMIN],
  adminUserRoutes: [ADMIN],
  adminAppointmentRoutes: [ADMIN],
  adminNotificationRoutes: [ADMIN],
  adminRecordRoutes: [ADMIN],
  adminInvestigationRoutes: [ADMIN],
  adminPharmacyRoutes: [ADMIN],
  adminAnalyticsRoutes: [ADMIN],

  // 🔐 Authenticated (non-admin) module route keys
  appointmentRoutes: [PATIENT, NURSING_STAFF, DOCTOR, ADMIN],
  doctorRoutes: [DOCTOR, ADMIN],
  departmentRoutes: [GENERAL_STAFF, ADMIN],
  userRoutes: [PATIENT, GENERAL_STAFF, ADMIN],
  notificationRoutes: [GENERAL_STAFF, ADMIN],
  pharmacyRoutes: [PHARMACY_STAFF, DOCTOR, ADMIN],
  // If you use a separate key for /pharmacy-orders in wrappers:
  pharmacyOrdersRoutes: [PHARMACY_STAFF, DOCTOR, ADMIN],
  // Pharmacy lifecycle — patient can place + view own orders
  pharmacyPatientOrderRoutes: [PATIENT, PHARMACY_STAFF, DOCTOR, ADMIN],
  // Pharmacy staff/admin lifecycle actions
  pharmacyLifecycleRoutes: [PHARMACY_STAFF, ADMIN],
  // Pharmacy catalog management
  pharmacyCatalogRoutes: [PHARMACY_STAFF, ADMIN],

  recordRoutes: [ADMIN, GENERAL_STAFF, DOCTOR, NURSING_STAFF],
  // ✅ Fix: use NURSING_STAFF constant instead of string 'NURSE'
  healthRecordsRoutes: [ADMIN, DOCTOR, NURSING_STAFF],

  investigationRoutes: [LAB_STAFF, NURSING_STAFF, DOCTOR, ADMIN],
  medicalStaffRoutes: [DOCTOR, NURSING_STAFF, LAB_STAFF, ADMIN],

  // Mixed/utility
  feedbackRoutes: [PATIENT, GENERAL_STAFF, ADMIN],
  sosRoutes: [PATIENT, GENERAL_STAFF, ADMIN],
  staffRoutes: [ADMIN, GENERAL_STAFF],
  lookupRoutes: [ADMIN, GENERAL_STAFF],

  // Public / open routes
  authRoutes: [],
  firebaseAuthRoutes: [],
  otpRoutes: [],
  swaggerRoutes: [],

  // Infra / tooling
  debugRoutes: [ADMIN],
  versionRoutes: [ADMIN, DOCTOR, NURSING_STAFF, PHARMACY_STAFF, LAB_STAFF, HR_STAFF, GENERAL_STAFF],
  rbacRoutes: [ADMIN, HR_STAFF],
  adminDocumentationRoutes: [ADMIN]
};
