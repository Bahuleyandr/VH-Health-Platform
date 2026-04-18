// src/config/healthConfig.js
export const HEALTH_RECORD_TYPES = [
  'VITALS', 'MEDICATION', 'ALLERGY', 'CONDITION', 'SYMPTOM'
];

export const VITAL_SIGNS = {
  BLOOD_PRESSURE: 'blood_pressure',
  HEART_RATE: 'heart_rate',
  TEMPERATURE: 'temperature',
  OXYGEN_SATURATION: 'oxygen_saturation',
  RESPIRATORY_RATE: 'respiratory_rate',
  BLOOD_SUGAR: 'blood_sugar',
  WEIGHT: 'weight',
  HEIGHT: 'height'
};

export const DEFAULT_PAGINATION = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  DEFAULT_OFFSET: 0
};

export const SYSTEM_INFO = {
  VERSION: '2.0.0',
  UPDATED_AT: '24-06-2025',
  FEATURES: ['RBAC Protection', 'Health Records', 'System Monitoring']
};

export const REQUIRED_ENV_VARS = [
  'API_KEY', 'DATABASE_URL', 'ALLOWED_ORIGINS'
];

export const HEALTH_MESSAGES = {
  SERVICE_RUNNING: 'VH Health API is running.',
  HEALTH_CHECK_PASSED: 'Detailed health check passed',
  HEALTH_CHECK_FAILED: 'Health check failed - Database unreachable',
  MISSING_ENV: 'Missing environment variables',
  RECORD_NOT_FOUND: 'Health record not found',
  ACCESS_DENIED: 'Access denied',
  PATIENT_NOT_FOUND: 'Patient not found',
  INVALID_RECORD_TYPE: 'Invalid record type',
  UPDATE_FORBIDDEN: 'Can only update records you created'
};

export const MEDICAL_ROLES = ['ADMIN', 'DOCTOR', 'NURSE'];

export const TREND_PERIODS = {
  WEEK: 7,
  MONTH: 30,
  QUARTER: 90,
  YEAR: 365
};