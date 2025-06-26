// src/config/recordConfig.js
export const VALID_RECORD_TYPES = [
  'CONSULTATION', 'PRESCRIPTION', 'LAB_RESULT', 'IMAGING', 
  'SURGERY', 'DISCHARGE', 'EMERGENCY', 'VACCINATION', 
  'FOLLOW_UP', 'REFERRAL', 'INSURANCE', 'BILLING'
];

export const PRIVACY_LEVELS = {
  PUBLIC: 0,          // Basic demographics
  RESTRICTED: 1,      // Medical history
  CONFIDENTIAL: 2,    // Mental health, sensitive conditions
  HIGHLY_CONFIDENTIAL: 3 // HIV, addiction, genetic data
};

export const PRIVACY_LEVEL_NAMES = {
  0: 'PUBLIC',
  1: 'RESTRICTED',
  2: 'CONFIDENTIAL',
  3: 'HIGHLY_CONFIDENTIAL'
};

export const DEFAULT_PAGINATION = {
  DEFAULT_LIMIT: 10,
  MAX_LIMIT: 100,
  DEFAULT_OFFSET: 0
};

export const AUDIT_ACTIONS = {
  CREATE_HEALTH_RECORD: 'CREATE_HEALTH_RECORD',
  CREATE_MEDICAL_RECORD: 'CREATE_MEDICAL_RECORD',
  UPDATE_MEDICAL_RECORD: 'UPDATE_MEDICAL_RECORD',
  DELETE_MEDICAL_RECORD: 'DELETE_MEDICAL_RECORD',
  VIEW_MEDICAL_RECORD: 'VIEW_MEDICAL_RECORD',
  ACCESS_DENIED: 'ACCESS_DENIED'
};

export const RECORD_MESSAGES = {
  NOT_FOUND: 'Medical record not found',
  ACCESS_DENIED: 'Access denied: Insufficient permissions',
  CREATE_SUCCESS: 'Medical record created successfully',
  UPDATE_SUCCESS: 'Medical record updated successfully',
  DELETE_SUCCESS: 'Medical record deleted successfully',
  PATIENT_NOT_FOUND: 'Patient not found',
  INVALID_PRIVACY_LEVEL: 'Invalid privacy level'
};