// src/routes/lookupRoutes.js - ENHANCED VERSION WITH FULL RBAC
import express from 'express';
import { query, body } from 'express-validator';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../config/routeWrapper.js';
import { LookupController } from '../controllers/user/lookupController.js';
import logger from '../logging/logger.js';

const router = express.Router();
logger.info('✅ Enhanced lookupRoutes loaded with full RBAC protection and privacy controls');

// Input validation schemas
const lookupValidator = [
  query('phone').optional().isLength({ min: 10, max: 15 }).withMessage('Invalid phone number'),
  query('uid').optional().isUUID().withMessage('Invalid UID format'),
  query('name').optional().isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters'),
  query('email').optional().isEmail().withMessage('Invalid email format'),
  query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1-50')
];

const advancedSearchValidator = [
  body('criteria').isObject().withMessage('Search criteria must be an object'),
  body('criteria.role').optional().isIn(['ADMIN', 'DOCTOR', 'PATIENT', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF']).withMessage('Invalid role'),
  body('criteria.registeredAfter').optional().isISO8601().withMessage('Invalid date format'),
  body('criteria.registeredBefore').optional().isISO8601().withMessage('Invalid date format'),
  body('options.includeInactive').optional().isBoolean().withMessage('includeInactive must be boolean'),
  body('options.sortBy').optional().isIn(['name', 'registered_at', 'last_login', 'role']).withMessage('Invalid sort field'),
  body('options.sortOrder').optional().isIn(['ASC', 'DESC']).withMessage('Sort order must be ASC or DESC')
];

// STAFF & ADMIN - Basic user lookup with role-based access
wrapAutoRBAC(router, 'lookupRoutes', {
  get: [
    // Enhanced user lookup with comprehensive filtering and privacy controls
    ['/', lookupValidator, LookupController.enhancedLookup],

    // Advanced user search (Admin and senior medical staff only)
    ['/advanced', LookupController.advancedSearch],

    // User statistics (Admin and senior medical staff only)
    ['/stats', LookupController.enhancedStats],

    // Quick user verification (for staff workflows)
    ['/verify', LookupController.enhancedVerify],

    // Recent activity lookup (Admin only)
    ['/activity', LookupController.enhancedActivity]
  ],

  // ADMIN ONLY - Bulk user operations
  post: [
    ['/bulk-search', advancedSearchValidator, LookupController.enhancedBulkSearch]
  ]
}, {
  requireUID: false,
  requirePhone: false
});

// BACKWARD COMPATIBILITY - Legacy lookup support
wrapRoutesWithValidation(
  router,
  [],
  {
    get: [
      [
        '/legacy',
        lookupValidator,
        async (req, res) => {
          try {
            // Delegate to the enhanced LookupController for backward compatibility
            await LookupController.lookupUser(req, res);
          } catch (legacyError) {
            logger.error('Legacy lookup error:', legacyError);
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: false
  }
);

export default router;
