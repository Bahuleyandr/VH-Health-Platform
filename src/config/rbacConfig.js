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
  ALL: [ADMIN],
  adminDepartmentRoutes: [ADMIN],
  adminDoctorRoutes: [ADMIN],
  adminRoutes: [ADMIN],
  adminRecordRoutes: [ADMIN],
  appointmentRoutes: [PATIENT, NURSING_STAFF, DOCTOR, ADMIN],
  doctorRoutes: [DOCTOR, ADMIN],
  feedbackRoutes: [PATIENT, GENERAL_STAFF, ADMIN],
  healthRoutes: [PATIENT, NURSING_STAFF, DOCTOR, ADMIN],
  healthRecordsRoutes: ['ADMIN', 'DOCTOR', 'NURSE'],
  investigationRoutes: [LAB_STAFF, NURSING_STAFF, DOCTOR, ADMIN],
  lookupRoutes: [ADMIN, GENERAL_STAFF],
  pharmacyRoutes: [PHARMACY_STAFF, DOCTOR, ADMIN],
  recordRoutes: [ADMIN, GENERAL_STAFF, DOCTOR, NURSING_STAFF],
  sosRoutes: [PATIENT, GENERAL_STAFF, ADMIN],
  staffRoutes: [ADMIN, GENERAL_STAFF],
  uploadRoutes: [LAB_STAFF, NURSING_STAFF, DOCTOR, ADMIN],
  medicalStaffRoutes: [DOCTOR, NURSING_STAFF, LAB_STAFF, ADMIN],
  userRoutes: [PATIENT, GENERAL_STAFF, ADMIN],
  authRoutes: [],
  firebaseAuthRoutes: [],
  otpRoutes: [],

  // otpAdminRoutes: [ADMIN],  
  debugRoutes: [ADMIN],
  versionRoutes: [ADMIN, DOCTOR, NURSING_STAFF, PHARMACY_STAFF, LAB_STAFF, HR_STAFF, GENERAL_STAFF],
  swaggerRoutes: [],
  rbacRoutes: [ADMIN, HR_STAFF],
  adminDocumentationRoutes: [ADMIN],
  departmentRoutes: [GENERAL_STAFF, ADMIN]
};
