// src/modules/userModule/index.js - User Management Module Public API

/**
 * Hospital User Management Module
 * 
 * This index file exports all public interfaces from the user management module,
 * making it easy to import functionality from other parts of the application.
 */

// Configuration
export {
  HOSPITAL_ROLES,
  HOSPITAL_DEPARTMENTS,
  MEDICAL_SPECIALTIES,
  USER_STATUS,
  USER_ACTIONS,
  RISK_LEVELS,
  REPORT_TYPES,
  ACCESS_MATRIX,
  USER_PROFILE_FIELDS
} from '../../config/userConfig.js';

// Services
export * as userService from '../../services/userService.js';
export * as auditService from '../../services/userAuditService.js';
export * as analyticsService from '../../services/userAnalyticsService.js';
export * as userQueries from '../../services/userQueries.js';

// Utilities
export * as userUtils from '../../utils/userUtils.js';

// Validators
export * as validators from '../../validators/userValidators.js';

// Routes (default export)
export { default as userRoutes } from '../../routes/user/index.js';

/**
 * Usage Examples:
 * 
 * // Import the entire module
 * import * as userModule from './modules/userModule/index.js';
 * 
 * // Import specific services
 * import { userService, auditService } from './modules/userModule/index.js';
 * 
 * // Import configuration
 * import { HOSPITAL_ROLES, USER_STATUS } from './modules/userModule/index.js';
 * 
 * // Import routes for Express app
 * import { userRoutes } from './modules/userModule/index.js';
 * app.use('/api/users', userRoutes);
 * 
 * // Direct service usage
 * const user = await userService.getUserByIdentifier('user-uuid');
 * await auditService.logUserAction(userId, 'profile_viewed', targetId);
 */