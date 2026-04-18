// src/config/departmentConfig.js
export const DEPARTMENT_CONFIG = {
  // Pagination
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,

  // Validation
  NAME_MIN_LENGTH: 3,
  NAME_MAX_LENGTH: 100,
  DESCRIPTION_MIN_LENGTH: 10,
  DESCRIPTION_MAX_LENGTH: 1000,
  CONTACT_NUMBER_PATTERN: /^(\+91[-\s]?)?[6-9]\d{9}$/,
  LOCATION_MAX_LENGTH: 200,

  // Financial
  MIN_BUDGET: 0,
  MAX_BUDGET: 10000000, // 10 million
  DEFAULT_CURRENCY: 'INR',

  // Statistics
  DEFAULT_STATS_PERIOD_DAYS: 30,
  MAX_STATS_PERIOD_DAYS: 365,

  // Performance thresholds
  APPOINTMENT_COMPLETION_TARGET: 0.85, // 85%
  MIN_DOCTORS_FOR_ACTIVE: 1,
  
  // Date format
  DATE_FORMAT: 'DD-MM-YYYY',
  TIME_FORMAT: 'HH:mm',
  
  // Bulk operations
  MAX_BULK_OPERATIONS: 50,
  VALID_BULK_OPERATIONS: ['activate', 'deactivate', 'update_budget', 'reassign_head']
};

export const DEPARTMENT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  ALL: 'all'
};

export const DEPARTMENT_MESSAGES = {
  // Success messages
  DEPARTMENT_CREATED: 'Department created successfully',
  DEPARTMENT_UPDATED: 'Department updated successfully',
  DEPARTMENT_DELETED: 'Department deleted successfully',
  DEPARTMENT_DEACTIVATED: 'Department deactivated successfully',
  DEPARTMENT_RETRIEVED: 'Department retrieved successfully',
  DEPARTMENTS_RETRIEVED: 'Departments retrieved successfully',
  STATS_RETRIEVED: 'Department statistics retrieved successfully',
  OVERVIEW_RETRIEVED: 'Department overview retrieved successfully',
  FINANCIAL_RETRIEVED: 'Department financial overview retrieved successfully',
  STAFF_ALLOCATION_RETRIEVED: 'Department staff allocation retrieved successfully',
  BULK_OPERATION_SUCCESS: 'Bulk operation completed successfully',

  // Error messages
  DEPARTMENT_NOT_FOUND: 'Department not found',
  DEPARTMENT_EXISTS: 'Department with this name already exists',
  INVALID_DEPARTMENT_ID: 'Invalid department ID',
  NAME_REQUIRED: 'Department name is required',
  DESCRIPTION_REQUIRED: 'Department description is required',
  HEAD_DOCTOR_NOT_FOUND: 'Head doctor not found',
  HEAD_DOCTOR_INVALID_ROLE: 'Head doctor must have DOCTOR role',
  HEAD_DOCTOR_ALREADY_ASSIGNED: 'Doctor is already head of another department',
  CANNOT_DEACTIVATE_WITH_ACTIVE_STAFF: 'Cannot deactivate department with active staff',
  DEPARTMENT_ALREADY_INACTIVE: 'Department is already inactive',
  TARGET_DEPARTMENT_NOT_FOUND: 'Target department for reassignment not found',
  INVALID_OPERATION: 'Invalid bulk operation',
  OPERATION_REQUIRED: 'Operation type is required',
  DEPARTMENT_IDS_REQUIRED: 'Department IDs array is required',
  BUDGET_REQUIRED: 'Budget is required for update_budget operation',
  HEAD_DOCTOR_ID_REQUIRED: 'Head doctor ID is required for reassign_head operation',
  INSUFFICIENT_PERMISSIONS: 'Insufficient permissions for this operation',

  // Validation messages
  INVALID_NAME_LENGTH: `Department name must be between ${DEPARTMENT_CONFIG.NAME_MIN_LENGTH} and ${DEPARTMENT_CONFIG.NAME_MAX_LENGTH} characters`,
  INVALID_DESCRIPTION_LENGTH: `Description must be between ${DEPARTMENT_CONFIG.DESCRIPTION_MIN_LENGTH} and ${DEPARTMENT_CONFIG.DESCRIPTION_MAX_LENGTH} characters`,
  INVALID_CONTACT_NUMBER: 'Invalid contact number format',
  INVALID_BUDGET: 'Budget must be a positive number',
  INVALID_DATE_RANGE: 'Invalid date range',
  INVALID_STATUS: 'Invalid status. Must be active, inactive, or all',

  // Fallback messages
  DEPARTMENTS_TABLE_NOT_EXIST: 'Departments table may not exist',
  LIMITED_DATA_FALLBACK: 'Limited data - create departments table for full functionality'
};

export const DEPARTMENT_ROLES = {
  ADMIN: 'ADMIN',
  DOCTOR: 'DOCTOR',
  NURSE: 'NURSE',
  PATIENT: 'PATIENT'
};