// src/services/staff/hr/constants.js

/**
 * Shared constants for HR services
 */

// Performance rating levels
export const PERFORMANCE_LEVELS = {
  EXCELLENT: { min: 4.5, max: 5.0, label: 'excellent' },
  GOOD: { min: 4.0, max: 4.5, label: 'good' },
  SATISFACTORY: { min: 3.0, max: 4.0, label: 'satisfactory' },
  NEEDS_IMPROVEMENT: { min: 2.0, max: 3.0, label: 'needs_improvement' },
  UNSATISFACTORY: { min: 0, max: 2.0, label: 'unsatisfactory' }
};

// Leave application statuses
export const LEAVE_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED'
};

// Default onboarding tasks
export const DEFAULT_ONBOARDING_TASKS = [
  { 
    task_name: 'Complete employment paperwork', 
    description: 'Fill out tax forms, emergency contacts, etc.', 
    completed: false, 
    priority: 'high' 
  },
  { 
    task_name: 'System access setup', 
    description: 'Create user accounts and assign permissions', 
    completed: false, 
    priority: 'high' 
  },
  { 
    task_name: 'Department orientation', 
    description: 'Meet team members and understand workflows', 
    completed: false, 
    priority: 'medium' 
  },
  { 
    task_name: 'Safety training', 
    description: 'Complete workplace safety and emergency procedures', 
    completed: false, 
    priority: 'high' 
  },
  { 
    task_name: 'Job-specific training', 
    description: 'Role-specific skills and procedures training', 
    completed: false, 
    priority: 'medium' 
  },
  { 
    task_name: '30-day check-in', 
    description: 'Review progress and address any concerns', 
    completed: false, 
    priority: 'low' 
  }
];

// Attendance punctuality thresholds
export const PUNCTUALITY_THRESHOLDS = {
  ON_TIME: '09:00:00',
  SLIGHTLY_LATE: '09:30:00',
  LATE: '10:00:00'
};

// Report types
export const REPORT_TYPES = {
  ATTENDANCE: 'attendance',
  PERFORMANCE: 'performance',
  LEAVE: 'leave',
  PAYROLL: 'payroll'
};

// Experience ranges for analytics
export const EXPERIENCE_RANGES = [
  { label: '0-1 years', minYears: 0, maxYears: 1 },
  { label: '1-3 years', minYears: 1, maxYears: 3 },
  { label: '3-5 years', minYears: 3, maxYears: 5 },
  { label: '5-10 years', minYears: 5, maxYears: 10 },
  { label: '10+ years', minYears: 10, maxYears: null }
];

// Department staffing thresholds
export const STAFFING_THRESHOLDS = {
  ADEQUATE: 0.8,  // 80% or more staff present
  WARNING: 0.7    // Below 70% triggers warning
};

// Date format configurations
export const DATE_FORMATS = {
  GB_SHORT: {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  },
  GB_LONG: {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }
};