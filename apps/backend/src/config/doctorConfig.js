// src/config/doctorConfig.js
export const DOCTOR_CONFIG = {
  // Departments
  DEPARTMENTS: [
    'GENERAL_MEDICINE',
    'CARDIOLOGY',
    'ORTHOPEDICS',
    'PEDIATRICS',
    'GYNECOLOGY',
    'DERMATOLOGY',
    'PSYCHIATRY',
    'NEUROLOGY',
    'ONCOLOGY',
    'RADIOLOGY'
  ],

  // Specializations
  SPECIALIZATIONS: {
    GENERAL_MEDICINE: ['General Practitioner', 'Internal Medicine'],
    CARDIOLOGY: ['Interventional Cardiology', 'Pediatric Cardiology', 'Electrophysiology'],
    ORTHOPEDICS: ['Joint Replacement', 'Sports Medicine', 'Spine Surgery'],
    PEDIATRICS: ['Neonatology', 'Pediatric Surgery', 'Developmental Pediatrics'],
    GYNECOLOGY: ['Obstetrics', 'Reproductive Medicine', 'Gynecologic Oncology'],
    DERMATOLOGY: ['Cosmetic Dermatology', 'Pediatric Dermatology', 'Dermatopathology'],
    PSYCHIATRY: ['Child Psychiatry', 'Addiction Psychiatry', 'Geriatric Psychiatry'],
    NEUROLOGY: ['Epilepsy', 'Movement Disorders', 'Neuromuscular Medicine'],
    ONCOLOGY: ['Medical Oncology', 'Surgical Oncology', 'Radiation Oncology'],
    RADIOLOGY: ['Diagnostic Radiology', 'Interventional Radiology', 'Nuclear Medicine']
  },

  // Experience levels
  EXPERIENCE_LEVELS: {
    JUNIOR: { min: 0, max: 5, label: 'Junior Doctor' },
    MID: { min: 5, max: 10, label: 'Mid-level Doctor' },
    SENIOR: { min: 10, max: 20, label: 'Senior Doctor' },
    EXPERT: { min: 20, max: null, label: 'Expert Doctor' }
  },

  // Consultation fee ranges (in currency units)
  FEE_RANGES: {
    MIN: 500,
    MAX: 5000,
    AVERAGE: 1500
  },

  // Working hours
  WORKING_HOURS: {
    MORNING: '09:00-13:00',
    AFTERNOON: '14:00-18:00',
    EVENING: '18:00-21:00',
    FULL_DAY: '09:00-18:00'
  },

  // Workload levels
  WORKLOAD_LEVELS: {
    LOW: { max: 25, label: 'Low Workload' },
    MEDIUM: { min: 25, max: 50, label: 'Medium Workload' },
    HIGH: { min: 50, label: 'High Workload' }
  },

  // Availability days
  WEEK_DAYS: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],

  // Analytics periods
  ANALYTICS_PERIODS: {
    WEEK: 7,
    MONTH: 30,
    QUARTER: 90,
    HALF_YEAR: 180,
    YEAR: 365
  },

  // Pagination defaults
  PAGINATION: {
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 100,
    DEFAULT_PAGE: 1
  },

  // Date format
  DATE_FORMAT: 'DD-MM-YYYY',

  // Time format
  TIME_FORMAT: 'HH:mm',

  // Bulk operation limits
  BULK_OPERATION_LIMIT: 50
};

export const DOCTOR_MESSAGES = {
  NOT_FOUND: 'Doctor not found',
  PROFILE_EXISTS: 'Doctor profile already exists',
  PROFILE_NOT_FOUND: 'Doctor profile not found',
  ACCOUNT_CREATED: 'Doctor account created successfully',
  PROFILE_CREATED: 'Doctor profile created successfully',
  PROFILE_UPDATED: 'Doctor profile updated successfully',
  AVAILABILITY_UPDATED: 'Doctor availability updated successfully',
  DEACTIVATED: 'Doctor profile deactivated successfully',
  INVALID_DEPARTMENT: 'Invalid department specified',
  INVALID_SPECIALIZATION: 'Invalid specialization for the selected department',
  ACTIVE_APPOINTMENTS: 'Cannot deactivate doctor with active appointments',
  BULK_OPERATION_SUCCESS: 'Bulk operation completed successfully',
  BULK_OPERATION_FAILED: 'Bulk operation failed',
  UNAUTHORIZED_ACCESS: 'Unauthorized access to doctor information',
  INVALID_EXPERIENCE: 'Invalid experience years',
  INVALID_FEE: 'Invalid consultation fee',
  INVALID_WORKING_HOURS: 'Invalid working hours format'
};