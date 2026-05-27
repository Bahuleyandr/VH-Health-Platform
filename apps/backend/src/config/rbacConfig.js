// src/config/rbacConfig.js
import {
  ADMIN,
  PATIENT,
  NURSING_STAFF,
  PHARMACY_STAFF,
  LAB_STAFF,
  DOCTOR,
  GENERAL_STAFF,
  HOUSEKEEPING_STAFF,
  MAINTENANCE,
  HR_STAFF,
  BILLING_STAFF,
  INSURANCE_COORDINATOR,
  ADMISSION_OFFICER,
  IPD_COUNSELLOR
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
  // Bell-icon endpoints — every authenticated user (patient + every staff
  // role) needs `GET /notifications/my`. Pharmacy/Lab/HR previously got
  // 403 because they weren't listed; the staff app shows a perpetual
  // empty notifications panel until they're allowed. Stage-5 added the
  // billing / TPA / admission-counter desk roles — same treatment (the
  // role-workflow sweep caught all four 403ing on /notifications/my).
  notificationRoutes: [PATIENT, GENERAL_STAFF, HOUSEKEEPING_STAFF, MAINTENANCE, ADMIN, DOCTOR, NURSING_STAFF, PHARMACY_STAFF, LAB_STAFF, HR_STAFF, BILLING_STAFF, INSURANCE_COORDINATOR, ADMISSION_OFFICER, IPD_COUNSELLOR],
  pharmacyRoutes: [PHARMACY_STAFF, NURSING_STAFF, DOCTOR, ADMIN],
  // If you use a separate key for /pharmacy-orders in wrappers:
  pharmacyOrdersRoutes: [PATIENT, PHARMACY_STAFF, NURSING_STAFF, DOCTOR, ADMIN],
  pharmacyOrderRoutes: [PHARMACY_STAFF, NURSING_STAFF, DOCTOR, ADMIN],
  // Pharmacy lifecycle — patient can place + view own orders
  pharmacyPatientOrderRoutes: [PATIENT, PHARMACY_STAFF, NURSING_STAFF, DOCTOR, ADMIN],
  // Pharmacy staff/admin lifecycle actions
  pharmacyLifecycleRoutes: [PHARMACY_STAFF, ADMIN],
  // Pharmacy catalog management
  pharmacyCatalogRoutes: [PHARMACY_STAFF, ADMIN],

  recordRoutes: [ADMIN, GENERAL_STAFF, DOCTOR, NURSING_STAFF],
  // ✅ Fix: use NURSING_STAFF constant instead of string 'NURSE'
  healthRecordsRoutes: [PATIENT, ADMIN, DOCTOR, NURSING_STAFF],

  investigationRoutes: [PATIENT, LAB_STAFF, NURSING_STAFF, DOCTOR, ADMIN],
  medicalStaffRoutes: [DOCTOR, NURSING_STAFF, LAB_STAFF, ADMIN],

  // Mixed/utility
  feedbackRoutes: [PATIENT, GENERAL_STAFF, ADMIN],
  sosRoutes: [PATIENT, GENERAL_STAFF, ADMIN],
  // /api/v1/staff/* — staff profile (GET /:identifier), staff list,
  // staff by department/shift, staff statistics. Every staff role
  // needs to read their OWN profile (the staff app's Profile screen
  // calls GET /staff/:employeeId on launch). Authorisation is then
  // refined inside the controller (only ADMIN/HR_STAFF can read OTHER
  // staff's full PII; non-admins get the limited public-profile
  // shape). Including all staff roles here closes the 403-on-Profile
  // surface that NURSING_STAFF / DOCTOR / PHARMACY_STAFF / LAB_STAFF
  // / HR_STAFF were hitting on the freshly-installed staff app.
  staffRoutes: [ADMIN, GENERAL_STAFF, HOUSEKEEPING_STAFF, MAINTENANCE, NURSING_STAFF, DOCTOR, PHARMACY_STAFF, LAB_STAFF, HR_STAFF],
  // /api/v1/housekeeping/* — staff self-service (raise/complete tickets,
  // submit cleaning logs, view zones). Every operational role can use it
  // because the request workflow spans wards/labs/pharmacy. Admin
  // verification + zone administration is gated separately via
  // housekeepingAdminRoutes below.
  housekeepingRoutes: [ADMIN, HOUSEKEEPING_STAFF, NURSING_STAFF, DOCTOR, PHARMACY_STAFF, LAB_STAFF, HR_STAFF],
  housekeepingAdminRoutes: [ADMIN, HR_STAFF],
  lookupRoutes: [ADMIN, GENERAL_STAFF, HOUSEKEEPING_STAFF, MAINTENANCE],

  // Public / open routes
  authRoutes: [],
  firebaseAuthRoutes: [],
  otpRoutes: [],
  swaggerRoutes: [],

  // Infra / tooling
  debugRoutes: [ADMIN],
  versionRoutes: [ADMIN, DOCTOR, NURSING_STAFF, PHARMACY_STAFF, LAB_STAFF, HR_STAFF, GENERAL_STAFF, HOUSEKEEPING_STAFF, MAINTENANCE],
  rbacRoutes: [ADMIN, HR_STAFF],
  adminDocumentationRoutes: [ADMIN]
};
