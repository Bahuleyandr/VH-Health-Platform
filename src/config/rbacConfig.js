// src/config/rbacConfig.js

import {
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF,
  LAB_STAFF, DOCTOR, GENERAL_STAFF, HR_STAFF
} from '../utils/roles.js';

export default {
  'ALL': [ADMIN],
  'adminDepartmentRoutes': [ADMIN],
  'adminDoctorRoutes': [ADMIN],
  'adminRoutes': [ADMIN],
  'appointmentRoutes': [PATIENT, NURSING_STAFF, DOCTOR, ADMIN],
  'doctorRoutes': [PATIENT, DOCTOR, ADMIN],
  'feedbackRoutes': [PATIENT, GENERAL_STAFF, ADMIN],
  'healthRoutes': [PATIENT, NURSING_STAFF, DOCTOR, ADMIN],
  'investigationRoutes': [LAB_STAFF, NURSING_STAFF, DOCTOR, ADMIN],
  'lookupRoutes': [ADMIN, GENERAL_STAFF],
  'pharmacyRoutes': [PHARMACY_STAFF, DOCTOR, ADMIN],
  'recordRoutes': [ADMIN, GENERAL_STAFF, DOCTOR, NURSING_STAFF],
  'sosRoutes': [PATIENT, GENERAL_STAFF, ADMIN],
  'staffRoutes': [ADMIN, GENERAL_STAFF],
  'uploadRoutes': [LAB_STAFF, NURSING_STAFF, DOCTOR, ADMIN],
  'userRoutes': [PATIENT, GENERAL_STAFF, ADMIN],
  'versionRoutes': [],
  'authRoutes': [],
  'firebaseAuthRoutes': [],
  'otpRoutes': [],
  'debugRoutes': [ADMIN],
  'departmentRoutes': [GENERAL_STAFF, ADMIN],
  'swaggerRoutes': [],
};
