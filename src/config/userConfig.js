// src/config/userConfig.js

export const USER_CONFIG = {
  // Pagination
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  MAX_BULK_IMPORT: 500,
  MAX_SEARCH_RESULTS: 50,
  
  // User roles
  ROLES: {
    ADMIN: 'ADMIN',
    PATIENT: 'PATIENT', 
    DOCTOR: 'DOCTOR',
    NURSING_STAFF: 'NURSING_STAFF',
    PHARMACY_STAFF: 'PHARMACY_STAFF',
    LAB_STAFF: 'LAB_STAFF',
    HR_STAFF: 'HR_STAFF',
    GENERAL_STAFF: 'GENERAL_STAFF',
    RECEPTIONIST: 'RECEPTIONIST',
    SECURITY: 'SECURITY',
    EMERGENCY_RESPONDER: 'EMERGENCY_RESPONDER'
  },
  
  // Privacy settings
  PRIVACY: {
    PHONE_MASK_LENGTH: 4,
    MAX_LOOKUPS_PER_HOUR: {
      ADMIN: 1000,
      DOCTOR: 100,
      DEFAULT: 50
    }
  },
  
  // User status
  USER_STATUS: {
    ACTIVE: 'active',
    INACTIVE: 'inactive',
    SUSPENDED: 'suspended',
    DEACTIVATED: 'deactivated'
  },
  
  // Search limits
  SEARCH: {
    MIN_QUERY_LENGTH: 2,
    MAX_QUERY_LENGTH: 100,
    DEFAULT_SORT_BY: 'registered_at',
    DEFAULT_SORT_ORDER: 'DESC'
  },
  
  // Activity tracking
  ACTIVITY_STATUS: {
    VERY_ACTIVE: { label: 'Very Active', days: 1 },
    ACTIVE: { label: 'Active', days: 7 },
    INACTIVE: { label: 'Inactive', days: 30 },
    LONG_INACTIVE: { label: 'Long Inactive', days: null }
  },
  
  // Age groups for analytics
  AGE_GROUPS: [
    { label: 'Under 18', min: 0, max: 17 },
    { label: '18-30', min: 18, max: 30 },
    { label: '31-50', min: 31, max: 50 },
    { label: '51-70', min: 51, max: 70 },
    { label: 'Over 70', min: 71, max: null }
  ]
};

export const ACCESS_MATRIX = {
  ADMIN: {
    users: ['create', 'read', 'update', 'delete'],
    appointments: ['create', 'read', 'update', 'delete'],
    records: ['create', 'read', 'update', 'delete'],
    pharmacy: ['create', 'read', 'update', 'delete'],
    investigations: ['create', 'read', 'update', 'delete']
  },
  DOCTOR: {
    users: ['read'],
    appointments: ['create', 'read', 'update'],
    records: ['create', 'read', 'update'],
    pharmacy: ['create', 'read'],
    investigations: ['create', 'read', 'update']
  },
  NURSING_STAFF: {
    users: ['read'],
    appointments: ['read', 'update'],
    records: ['read', 'update'],
    pharmacy: ['read'],
    investigations: ['read', 'update']
  },
  PHARMACY_STAFF: {
    users: ['read'],
    appointments: ['read'],
    records: ['read'],
    pharmacy: ['create', 'read', 'update'],
    investigations: []
  },
  LAB_STAFF: {
    users: ['read'],
    appointments: ['read'],
    records: ['read'],
    pharmacy: [],
    investigations: ['create', 'read', 'update']
  },
  RECEPTIONIST: {
    users: ['create', 'read'],
    appointments: ['create', 'read', 'update'],
    records: ['read'],
    pharmacy: [],
    investigations: ['read']
  },
  PATIENT: {
    users: ['read'], // only own profile
    appointments: ['read'], // only own appointments
    records: ['read'], // only own records
    pharmacy: ['read'], // only own prescriptions
    investigations: ['read'] // only own results
  },
  HR_STAFF: {
    users: ['create', 'read', 'update'],
    appointments: [],
    records: [],
    pharmacy: [],
    investigations: []
  },
  GENERAL_STAFF: {
    users: ['read'],
    appointments: ['read'],
    records: [],
    pharmacy: [],
    investigations: []
  },
  SECURITY: {
    users: ['read'],
    appointments: [],
    records: [],
    pharmacy: [],
    investigations: []
  },
  EMERGENCY_RESPONDER: {
    users: ['read'],
    appointments: ['read', 'update'],
    records: ['read', 'update'],
    pharmacy: ['read'],
    investigations: ['read', 'update']
  }
};

// Gender options
export const GENDER_OPTIONS = {
  MALE: 'MALE',
  FEMALE: 'FEMALE',
  OTHER: 'OTHER',
  PREFER_NOT_TO_SAY: 'PREFER_NOT_TO_SAY'
};

// Blood groups
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

// Emergency contact relationship types
export const RELATIONSHIP_TYPES = {
  SPOUSE: 'SPOUSE',
  PARENT: 'PARENT',
  CHILD: 'CHILD',
  SIBLING: 'SIBLING',
  GUARDIAN: 'GUARDIAN',
  FRIEND: 'FRIEND',
  OTHER: 'OTHER'
};

// Appointment status
export const APPOINTMENT_STATUS = {
  SCHEDULED: 'SCHEDULED',
  CONFIRMED: 'CONFIRMED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
  RESCHEDULED: 'RESCHEDULED'
};

// User actions for audit logging
export const USER_ACTIONS = {
  // Authentication actions
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  LOGIN_FAILED: 'LOGIN_FAILED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  
  // User management actions
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  USER_ACTIVATED: 'USER_ACTIVATED',
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  USER_SUSPENDED: 'USER_SUSPENDED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  
  // Patient actions
  PATIENT_REGISTERED: 'PATIENT_REGISTERED',
  PATIENT_UPDATED: 'PATIENT_UPDATED',
  PATIENT_VIEWED: 'PATIENT_VIEWED',
  
  // Appointment actions
  APPOINTMENT_CREATED: 'APPOINTMENT_CREATED',
  APPOINTMENT_UPDATED: 'APPOINTMENT_UPDATED',
  APPOINTMENT_CANCELLED: 'APPOINTMENT_CANCELLED',
  APPOINTMENT_COMPLETED: 'APPOINTMENT_COMPLETED',
  
  // Medical record actions
  RECORD_CREATED: 'RECORD_CREATED',
  RECORD_UPDATED: 'RECORD_UPDATED',
  RECORD_VIEWED: 'RECORD_VIEWED',
  RECORD_DELETED: 'RECORD_DELETED',
  
  // Prescription actions
  PRESCRIPTION_CREATED: 'PRESCRIPTION_CREATED',
  PRESCRIPTION_UPDATED: 'PRESCRIPTION_UPDATED',
  PRESCRIPTION_DISPENSED: 'PRESCRIPTION_DISPENSED',
  
  // Investigation actions
  INVESTIGATION_ORDERED: 'INVESTIGATION_ORDERED',
  INVESTIGATION_COMPLETED: 'INVESTIGATION_COMPLETED',
  RESULTS_UPLOADED: 'RESULTS_UPLOADED',
  
  // Administrative actions
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
  REPORT_GENERATED: 'REPORT_GENERATED',
  DATA_EXPORTED: 'DATA_EXPORTED',
  BULK_IMPORT: 'BULK_IMPORT'
};

// Report types for analytics
export const REPORT_TYPES = {
  USER_ACTIVITY: 'USER_ACTIVITY',
  PATIENT_DEMOGRAPHICS: 'PATIENT_DEMOGRAPHICS',
  APPOINTMENT_SUMMARY: 'APPOINTMENT_SUMMARY',
  REVENUE_REPORT: 'REVENUE_REPORT',
  STAFF_PERFORMANCE: 'STAFF_PERFORMANCE',
  INVENTORY_STATUS: 'INVENTORY_STATUS',
  DISEASE_STATISTICS: 'DISEASE_STATISTICS',
  LAB_UTILIZATION: 'LAB_UTILIZATION',
  EMERGENCY_RESPONSE: 'EMERGENCY_RESPONSE',
  AUDIT_LOG: 'AUDIT_LOG'
};

// Export USER_STATUS as a direct export (in addition to being in USER_CONFIG)
export const USER_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  SUSPENDED: 'suspended',
  DEACTIVATED: 'deactivated'
};

// Hospital departments
export const HOSPITAL_DEPARTMENTS = {
  EMERGENCY: 'EMERGENCY',
  GENERAL_MEDICINE: 'GENERAL_MEDICINE',
  SURGERY: 'SURGERY',
  PEDIATRICS: 'PEDIATRICS',
  OBSTETRICS_GYNECOLOGY: 'OBSTETRICS_GYNECOLOGY',
  CARDIOLOGY: 'CARDIOLOGY',
  NEUROLOGY: 'NEUROLOGY',
  ORTHOPEDICS: 'ORTHOPEDICS',
  RADIOLOGY: 'RADIOLOGY',
  PATHOLOGY: 'PATHOLOGY',
  PHARMACY: 'PHARMACY',
  ICU: 'ICU',
  ONCOLOGY: 'ONCOLOGY',
  PSYCHIATRY: 'PSYCHIATRY',
  DERMATOLOGY: 'DERMATOLOGY',
  ENT: 'ENT',
  OPHTHALMOLOGY: 'OPHTHALMOLOGY',
  PHYSIOTHERAPY: 'PHYSIOTHERAPY',
  ADMINISTRATION: 'ADMINISTRATION'
};

// Medical specialties
export const MEDICAL_SPECIALTIES = {
  GENERAL_PRACTITIONER: 'GENERAL_PRACTITIONER',
  CARDIOLOGIST: 'CARDIOLOGIST',
  NEUROLOGIST: 'NEUROLOGIST',
  SURGEON: 'SURGEON',
  ORTHOPEDIC_SURGEON: 'ORTHOPEDIC_SURGEON',
  PEDIATRICIAN: 'PEDIATRICIAN',
  OBSTETRICIAN_GYNECOLOGIST: 'OBSTETRICIAN_GYNECOLOGIST',
  PSYCHIATRIST: 'PSYCHIATRIST',
  RADIOLOGIST: 'RADIOLOGIST',
  PATHOLOGIST: 'PATHOLOGIST',
  ANESTHESIOLOGIST: 'ANESTHESIOLOGIST',
  EMERGENCY_PHYSICIAN: 'EMERGENCY_PHYSICIAN',
  ONCOLOGIST: 'ONCOLOGIST',
  DERMATOLOGIST: 'DERMATOLOGIST',
  ENT_SPECIALIST: 'ENT_SPECIALIST',
  OPHTHALMOLOGIST: 'OPHTHALMOLOGIST',
  UROLOGIST: 'UROLOGIST',
  NEPHROLOGIST: 'NEPHROLOGIST',
  PULMONOLOGIST: 'PULMONOLOGIST',
  GASTROENTEROLOGIST: 'GASTROENTEROLOGIST',
  ENDOCRINOLOGIST: 'ENDOCRINOLOGIST',
  RHEUMATOLOGIST: 'RHEUMATOLOGIST',
  HEMATOLOGIST: 'HEMATOLOGIST',
  INFECTIOUS_DISEASE_SPECIALIST: 'INFECTIOUS_DISEASE_SPECIALIST',
  PHYSICAL_THERAPIST: 'PHYSICAL_THERAPIST',
  NURSE_PRACTITIONER: 'NURSE_PRACTITIONER'
};

// Hospital roles export - mapping role names to their identifiers
export const HOSPITAL_ROLES = {
  ADMIN: 'ADMIN',
  PATIENT: 'PATIENT',
  DOCTOR: 'DOCTOR',
  NURSING_STAFF: 'NURSING_STAFF',
  PHARMACY_STAFF: 'PHARMACY_STAFF',
  LAB_STAFF: 'LAB_STAFF',
  HR_STAFF: 'HR_STAFF',
  GENERAL_STAFF: 'GENERAL_STAFF',
  RECEPTIONIST: 'RECEPTIONIST',
  SECURITY: 'SECURITY',
  EMERGENCY_RESPONDER: 'EMERGENCY_RESPONDER'
};

// Role hierarchy for permission inheritance
export const ROLE_HIERARCHY = {
  ADMIN: ['DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF', 'HR_STAFF', 'RECEPTIONIST', 'GENERAL_STAFF', 'SECURITY', 'EMERGENCY_RESPONDER'],
  DOCTOR: ['NURSING_STAFF'],
  HR_STAFF: ['GENERAL_STAFF'],
  RECEPTIONIST: ['GENERAL_STAFF']
};

// Default role assignments
export const DEFAULT_ROLE = 'PATIENT';

// Admin roles that have elevated privileges
export const ADMIN_ROLES = ['ADMIN', 'HR_STAFF'];

// Medical staff roles
export const MEDICAL_ROLES = ['DOCTOR', 'NURSING_STAFF', 'EMERGENCY_RESPONDER'];

// Support staff roles
export const SUPPORT_ROLES = ['PHARMACY_STAFF', 'LAB_STAFF', 'RECEPTIONIST', 'GENERAL_STAFF', 'SECURITY'];

// Risk levels for patient classification
export const RISK_LEVELS = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL'
};

// Risk level configurations
export const RISK_LEVEL_CONFIG = {
  LOW: {
    label: 'Low Risk',
    color: 'green',
    priority: 1,
    description: 'Routine care, no immediate concerns'
  },
  MEDIUM: {
    label: 'Medium Risk',
    color: 'yellow',
    priority: 2,
    description: 'Requires monitoring, potential complications'
  },
  HIGH: {
    label: 'High Risk',
    color: 'orange',
    priority: 3,
    description: 'Needs frequent monitoring, significant health concerns'
  },
  CRITICAL: {
    label: 'Critical Risk',
    color: 'red',
    priority: 4,
    description: 'Requires immediate attention, life-threatening conditions'
  }
};