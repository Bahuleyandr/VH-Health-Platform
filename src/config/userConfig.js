// src/config/userConfig.js - Hospital User Management Configuration

export const HOSPITAL_ROLES = {
  // Administrative
  'ADMIN': { level: 1, description: 'System Administrator', department: 'Administration' },
  'HR_MANAGER': { level: 2, description: 'Human Resources Manager', department: 'Human Resources' },
  
  // Medical Staff
  'CHIEF_DOCTOR': { level: 2, description: 'Chief Medical Officer', department: 'Medical' },
  'DOCTOR': { level: 3, description: 'Medical Doctor', department: 'Medical' },
  'SPECIALIST': { level: 3, description: 'Medical Specialist', department: 'Medical' },
  'RESIDENT': { level: 4, description: 'Medical Resident', department: 'Medical' },
  
  // Nursing Staff
  'HEAD_NURSE': { level: 3, description: 'Head of Nursing', department: 'Nursing' },
  'NURSING_STAFF': { level: 4, description: 'Registered Nurse', department: 'Nursing' },
  'NURSE_ASSISTANT': { level: 5, description: 'Nursing Assistant', department: 'Nursing' },
  
  // Support Staff
  'PHARMACIST': { level: 4, description: 'Licensed Pharmacist', department: 'Pharmacy' },
  'PHARMACY_STAFF': { level: 5, description: 'Pharmacy Technician', department: 'Pharmacy' },
  'LAB_TECHNICIAN': { level: 4, description: 'Laboratory Technician', department: 'Laboratory' },
  'LAB_STAFF': { level: 5, description: 'Laboratory Assistant', department: 'Laboratory' },
  'RADIOLOGIST': { level: 3, description: 'Radiologist', department: 'Radiology' },
  'RADIOLOGY_TECH': { level: 4, description: 'Radiology Technician', department: 'Radiology' },
  
  // Other Staff
  'RECEPTIONIST': { level: 5, description: 'Front Desk Receptionist', department: 'Administration' },
  'SECURITY': { level: 6, description: 'Security Personnel', department: 'Security' },
  'MAINTENANCE': { level: 6, description: 'Maintenance Staff', department: 'Facilities' },
  'CLEANER': { level: 6, description: 'Cleaning Staff', department: 'Housekeeping' },
  
  // Patients and External
  'PATIENT': { level: 7, description: 'Hospital Patient', department: 'Patient Care' },
  'VISITOR': { level: 8, description: 'Hospital Visitor', department: 'External' },
  'CONTRACTOR': { level: 8, description: 'External Contractor', department: 'External' }
};

export const HOSPITAL_DEPARTMENTS = [
  'Administration', 'Human Resources', 'Medical', 'Nursing', 'Pharmacy', 
  'Laboratory', 'Radiology', 'Emergency', 'Surgery', 'ICU', 'Pediatrics',
  'Cardiology', 'Oncology', 'Neurology', 'Orthopedics', 'Security',
  'Facilities', 'Housekeeping', 'Patient Care', 'External'
];

export const MEDICAL_SPECIALTIES = [
  'General Medicine', 'Cardiology', 'Neurology', 'Orthopedics', 'Pediatrics',
  'Oncology', 'Emergency Medicine', 'Anesthesiology', 'Surgery', 'Psychiatry',
  'Radiology', 'Pathology', 'Dermatology', 'Ophthalmology', 'ENT',
  'Gynecology', 'Urology', 'Endocrinology', 'Gastroenterology', 'Pulmonology'
];

export const USER_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  SUSPENDED: 'suspended',
  TERMINATED: 'terminated'
};

export const USER_ACTIONS = {
  LOGIN: 'user_login',
  LOGOUT: 'user_logout',
  CREATED: 'user_created',
  UPDATED: 'user_updated',
  DELETED: 'user_deleted',
  DEACTIVATED: 'user_deactivated',
  REACTIVATED: 'user_reactivated',
  STATUS_CHANGED: 'status_changed',
  ROLE_CHANGED: 'role_changed',
  PROFILE_VIEWED: 'user_profile_viewed',
  BULK_CREATED: 'bulk_user_created',
  REPORT_GENERATED: 'report_generated'
};

export const RISK_LEVELS = {
  CRITICAL: ['ADMIN', 'CHIEF_DOCTOR', 'HEAD_NURSE'],
  HIGH: ['DOCTOR', 'SPECIALIST', 'PHARMACIST'],
  MEDIUM: ['NURSING_STAFF', 'LAB_TECHNICIAN'],
  LOW: ['RECEPTIONIST', 'PATIENT', 'VISITOR']
};

export const REPORT_TYPES = {
  DEPARTMENT: 'department',
  ROLE: 'role',
  ACTIVITY: 'activity',
  COMPLIANCE: 'compliance',
  COMPREHENSIVE: 'comprehensive'
};

// Access control matrix
export const ACCESS_MATRIX = {
  ADMIN: {
    canView: ['*'],
    canEdit: ['*'],
    canDelete: ['*'],
    canChangeRole: true,
    canViewSensitive: true,
    canGenerateReports: true
  },
  HR_MANAGER: {
    canView: ['*'],
    canEdit: ['*'],
    canDelete: [],
    canChangeRole: true,
    canViewSensitive: true,
    canGenerateReports: true
  },
  CHIEF_DOCTOR: {
    canView: ['DOCTOR', 'SPECIALIST', 'RESIDENT', 'NURSING_STAFF', 'PATIENT'],
    canEdit: ['PATIENT'],
    canDelete: [],
    canChangeRole: false,
    canViewSensitive: false,
    canGenerateReports: false
  },
  DOCTOR: {
    canView: ['NURSING_STAFF', 'NURSE_ASSISTANT', 'PATIENT'],
    canEdit: ['PATIENT'],
    canDelete: [],
    canChangeRole: false,
    canViewSensitive: false,
    canGenerateReports: false
  },
  HEAD_NURSE: {
    canView: ['NURSING_STAFF', 'NURSE_ASSISTANT', 'PATIENT'],
    canEdit: ['PATIENT'],
    canDelete: [],
    canChangeRole: false,
    canViewSensitive: false,
    canGenerateReports: false
  },
  NURSING_STAFF: {
    canView: ['PATIENT'],
    canEdit: ['PATIENT'],
    canDelete: [],
    canChangeRole: false,
    canViewSensitive: false,
    canGenerateReports: false
  },
  DEFAULT: {
    canView: ['PATIENT'],
    canEdit: [],
    canDelete: [],
    canChangeRole: false,
    canViewSensitive: false,
    canGenerateReports: false
  }
};

// Configuration for user profile fields
export const USER_PROFILE_FIELDS = {
  basic: ['name', 'email', 'gender', 'birthday', 'phone'],
  contact: ['address', 'emergency_contact'],
  professional: ['role', 'department', 'specialty', 'employee_id', 'license_number'],
  medical: ['blood_group', 'allergies', 'medical_history'],
  metadata: ['status', 'registered_at', 'last_login', 'updated_at']
};