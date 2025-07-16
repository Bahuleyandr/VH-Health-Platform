// services/staff/hrService.js

/**
 * HR Service - Facade Pattern
 * 
 * This file now serves as a backward-compatibility layer.
 * All functions have been moved to their respective service files in the hr/ directory.
 * 
 * @deprecated Please import directly from specific hr/* services:
 * - ./hr/dashboardService.js for dashboard functions
 * - ./hr/performanceService.js for performance functions
 * - ./hr/onboardingService.js for onboarding functions
 * - ./hr/leaveService.js for leave management functions
 * - ./hr/departmentService.js for department analytics
 * - ./hr/reportingService.js for report generation
 */

// Re-export all functions from the modular services
export * from './hr/index.js';

// Log deprecation warning in development
if (process.env.NODE_ENV !== 'production') {
  console.warn(
    '\x1b[33m%s\x1b[0m',
    '[DEPRECATION WARNING] hrService.js is deprecated. Please import from specific hr/* services for better performance and maintainability.'
  );
}