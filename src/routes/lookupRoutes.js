// src/routes/lookupRoutes.js - ENHANCED VERSION WITH FULL RBAC
import express from 'express';
import { validationResult , body, query } from 'express-validator';
import db from '../config/database.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../config/routeWrapper.js';
import * as userController from '../controllers/user/userController.js';
import logger from '../logging/logger.js';
import { logAudit } from '../utils/logAudit.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { success, error } from '../utils/responseHelper.js';

const router = express.Router();
logger.info('✅ Enhanced lookupRoutes loaded with full RBAC protection and privacy controls');

// ✅ Input validation schemas
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

// ✅ STAFF & ADMIN - Basic user lookup with role-based access
wrapAutoRBAC(router, 'lookupRoutes', {
  get: [
    // Enhanced user lookup with comprehensive filtering and privacy controls
    [
      '/',
      lookupValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { phone, uid, name, email, limit = 10 } = req.query;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          if (!phone && !uid && !name && !email) {
            return error(res, 'Provide phone, uid, name, or email to search', HTTP_STATUS.BAD_REQUEST);
          }

          // Rate limiting for lookup requests to prevent enumeration
          const recentLookups = await db.query(
            'SELECT COUNT(*) FROM audit_logs WHERE uid = $1 AND action = $2 AND created_at > NOW() - INTERVAL \'1 hour\'',
            [requestedBy, 'user-lookup']
          );

          const lookupCount = parseInt(recentLookups.rows[0].count);
          const maxLookupsPerHour = userRole === 'ADMIN' ? 1000 : userRole === 'DOCTOR' ? 100 : 50;

          if (lookupCount >= maxLookupsPerHour) {
            await logAudit(req, 'user-lookup-rate-limited', { count: lookupCount });
            return error(res, 'Lookup rate limit exceeded. Please try again later.', HTTP_STATUS.TOO_MANY_REQUESTS);
          }

          // Build query with role-based field selection
          let baseFields = 'uid, phone, name, registered_at, role';
          
          // Admin gets full access, others get limited fields
          if (userRole === 'ADMIN') {
            baseFields = 'uid, phone, name, email, role, registered_at, last_login, profile_picture, address, birthday, anniversary';
          } else if (['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
            baseFields = 'uid, phone, name, email, role, registered_at';
          }

          let query = `SELECT ${baseFields} FROM users WHERE `;
          const params = [];
          const conditions = [];

          if (phone) {
            conditions.push(`phone = $${params.length + 1}`);
            params.push(normalizePhone(phone));
          }

          if (uid) {
            conditions.push(`uid = $${params.length + 1}`);
            params.push(uid);
          }

          if (name) {
            conditions.push(`LOWER(name) LIKE $${params.length + 1}`);
            params.push(`%${name.toLowerCase()}%`);
          }

          if (email && ['ADMIN', 'DOCTOR'].includes(userRole)) {
            conditions.push(`LOWER(email) LIKE $${params.length + 1}`);
            params.push(`%${email.toLowerCase()}%`);
          }

          // Non-admin users cannot search for admin accounts
          if (userRole !== 'ADMIN') {
            conditions.push(`role != 'ADMIN'`);
          }

          query += conditions.join(' OR ');
          query += ` ORDER BY registered_at DESC LIMIT $${params.length + 1}`;
          params.push(Math.min(parseInt(limit), userRole === 'ADMIN' ? 50 : 20));

          const result = await db.query(query, params);

          // Additional privacy filtering for non-admin users
          const filteredResults = result.rows.map(user => {
            if (userRole !== 'ADMIN') {
              // Remove sensitive info for non-admin users
              delete user.last_login;
              delete user.address;
              delete user.birthday;
              delete user.anniversary;
              
              // Mask phone numbers partially for non-medical staff
              if (!['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole)) {
                user.phone = user.phone ? user.phone.slice(0, -4) + '****' : null;
              }
            }
            return user;
          });

          await logAudit(req, 'user-lookup', {
            searchCriteria: { phone: !!phone, uid: !!uid, name: !!name, email: !!email },
            resultsCount: filteredResults.length,
            lookupType: 'basic'
          });

          if (filteredResults.length === 0) {
            return success(res, {
              users: [],
              totalFound: 0,
              searchCriteria: { phone, uid, name, email },
              accessLevel: userRole,
              requestedBy
            }, 'No matching users found');
          }

          success(res, {
            users: filteredResults,
            totalFound: filteredResults.length,
            searchCriteria: { phone, uid, name, email },
            accessLevel: userRole,
            requestedBy,
            privacyNote: userRole !== 'ADMIN' ? 'Results filtered based on your access level' : null
          }, `Found ${filteredResults.length} matching user(s)`);

        } catch (dbError) {
          logger.error('User Lookup Error:', dbError);
          error(res, 'User lookup failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Advanced user search (Admin and senior medical staff only)
    [
      '/advanced',
      async (req, res) => {
        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          // Restrict advanced search to admin and senior staff
          if (!['ADMIN', 'DOCTOR'].includes(userRole)) {
            return error(res, 'Access denied: Advanced search requires elevated privileges', HTTP_STATUS.FORBIDDEN);
          }

          const { 
            role, registeredAfter, registeredBefore, lastLoginAfter, 
            ageMin, ageMax, hasProfilePicture, department, includeInactive = true,
            sortBy = 'registered_at', sortOrder = 'DESC', limit = 25 
          } = req.query;

          let query = `
            SELECT u.uid, u.phone, u.name, u.email, u.role, u.registered_at, u.last_login,
                   u.profile_picture, u.address, u.birthday, u.gender,
                   d.department, d.specialization
            FROM users u
            LEFT JOIN doctors d ON u.uid = d.user_uid
            WHERE 1=1
          `;
          const params = [];

          if (role) {
            query += ` AND u.role = $${params.length + 1}`;
            params.push(role.toUpperCase());
          }

          if (registeredAfter) {
            query += ` AND u.registered_at >= $${params.length + 1}`;
            params.push(registeredAfter);
          }

          if (registeredBefore) {
            query += ` AND u.registered_at <= $${params.length + 1}`;
            params.push(registeredBefore);
          }

          if (lastLoginAfter) {
            query += ` AND u.last_login >= $${params.length + 1}`;
            params.push(lastLoginAfter);
          }

          if (ageMin || ageMax) {
            if (ageMin) {
              query += ` AND DATE_PART('year', AGE(u.birthday)) >= $${params.length + 1}`;
              params.push(ageMin);
            }
            if (ageMax) {
              query += ` AND DATE_PART('year', AGE(u.birthday)) <= $${params.length + 1}`;
              params.push(ageMax);
            }
          }

          if (hasProfilePicture !== undefined) {
            if (hasProfilePicture === 'true') {
              query += ` AND u.profile_picture IS NOT NULL`;
            } else {
              query += ` AND u.profile_picture IS NULL`;
            }
          }

          if (department && userRole === 'ADMIN') {
            query += ` AND d.department ILIKE $${params.length + 1}`;
            params.push(`%${department}%`);
          }

          if (!includeInactive) {
            query += ` AND u.last_login > NOW() - INTERVAL '30 days'`;
          }

          // Validate and apply sorting
          const allowedSortFields = ['name', 'registered_at', 'last_login', 'role'];
          const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'registered_at';
          const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
          
          query += ` ORDER BY u.${sortField} ${order} LIMIT $${params.length + 1}`;
          params.push(Math.min(parseInt(limit), 100));

          const result = await db.query(query, params);

          await logAudit(req, 'user-advanced-search', {
            criteria: { role, registeredAfter, registeredBefore, lastLoginAfter, ageMin, ageMax, department },
            resultsCount: result.rows.length
          });

          success(res, {
            users: result.rows,
            totalFound: result.rows.length,
            searchCriteria: { role, registeredAfter, registeredBefore, lastLoginAfter, ageMin, ageMax, department },
            sorting: { field: sortField, order },
            accessLevel: userRole,
            requestedBy
          }, 'Advanced user search completed');

        } catch (dbError) {
          logger.error('Advanced User Search Error:', dbError);
          error(res, 'Advanced search failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // User statistics (Admin and senior medical staff only)
    [
      '/stats',
      async (req, res) => {
        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          if (!['ADMIN', 'DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
            return error(res, 'Access denied: Statistics require medical staff privileges', HTTP_STATUS.FORBIDDEN);
          }

          const { detailed = false } = req.query;

          // Basic statistics available to all authorized users
          const basicStats = await db.query(`
            SELECT 
              COUNT(*) as total_users,
              COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '30 days') as new_users_30d,
              COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as active_users_7d,
              COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '30 days') as active_users_30d,
              COUNT(DISTINCT role) as unique_roles,
              MIN(registered_at) as first_registration,
              MAX(registered_at) as latest_registration
            FROM users
          `);

          const roleDistribution = await db.query(`
            SELECT role, COUNT(*) as count
            FROM users 
            GROUP BY role 
            ORDER BY count DESC
          `);

          const responseData = {
            overallStats: basicStats.rows[0],
            roleDistribution: roleDistribution.rows,
            accessLevel: userRole,
            generatedAt: new Date().toISOString(),
            requestedBy
          };

          // Detailed statistics only for admin
          if (detailed === 'true' && userRole === 'ADMIN') {
            const [registrationTrends, loginActivity, ageDistribution, departmentStats] = await Promise.all([
              // Registration trends (last 30 days)
              db.query(`
                SELECT DATE(registered_at) as date, COUNT(*) as registrations
                FROM users 
                WHERE registered_at > NOW() - INTERVAL '30 days'
                GROUP BY DATE(registered_at)
                ORDER BY date DESC
              `),
              
              // Login activity analysis
              db.query(`
                SELECT 
                  COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '1 day') as logins_1d,
                  COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as logins_7d,
                  COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '30 days') as logins_30d,
                  COUNT(*) FILTER (WHERE last_login IS NULL) as never_logged_in,
                  AVG(EXTRACT(EPOCH FROM (NOW() - last_login))/86400) as avg_days_since_login
                FROM users
              `),
              
              // Age distribution (for patients)
              db.query(`
                SELECT 
                  CASE 
                    WHEN DATE_PART('year', AGE(birthday)) < 18 THEN 'Under 18'
                    WHEN DATE_PART('year', AGE(birthday)) BETWEEN 18 AND 30 THEN '18-30'
                    WHEN DATE_PART('year', AGE(birthday)) BETWEEN 31 AND 50 THEN '31-50'
                    WHEN DATE_PART('year', AGE(birthday)) BETWEEN 51 AND 70 THEN '51-70'
                    WHEN DATE_PART('year', AGE(birthday)) > 70 THEN 'Over 70'
                    ELSE 'Unknown'
                  END as age_group,
                  COUNT(*) as count
                FROM users 
                WHERE role = 'PATIENT' AND birthday IS NOT NULL
                GROUP BY age_group
                ORDER BY count DESC
              `),
              
              // Department statistics
              db.query(`
                SELECT d.department, d.specialization, COUNT(u.uid) as staff_count
                FROM doctors d
                LEFT JOIN users u ON d.user_uid = u.uid
                GROUP BY d.department, d.specialization
                ORDER BY staff_count DESC
              `)
            ]);

            responseData.detailedStats = {
              registrationTrends: registrationTrends.rows,
              loginActivity: loginActivity.rows[0],
              ageDistribution: ageDistribution.rows,
              departmentStats: departmentStats.rows
            };
          }

          await logAudit(req, 'user-stats-viewed', { detailed: detailed === 'true' });

          success(res, responseData, 'User statistics retrieved successfully');

        } catch (dbError) {
          logger.error('Lookup Stats Error:', dbError);
          error(res, 'Failed to fetch user statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Quick user verification (for staff workflows)
    [
      '/verify',
      async (req, res) => {
        try {
          const { phone, uid } = req.query;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          if (!['DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF', 'ADMIN'].includes(userRole)) {
            return error(res, 'Access denied: Staff privileges required', HTTP_STATUS.FORBIDDEN);
          }

          if (!phone && !uid) {
            return error(res, 'Provide phone or uid for verification', HTTP_STATUS.BAD_REQUEST);
          }

          let query, params;
          if (uid) {
            query = 'SELECT uid, phone, name, role, registered_at FROM users WHERE uid = $1';
            params = [uid];
          } else {
            query = 'SELECT uid, phone, name, role, registered_at FROM users WHERE phone = $1';
            params = [normalizePhone(phone)];
          }

          const result = await db.query(query, params);

          if (result.rows.length === 0) {
            await logAudit(req, 'user-verification-failed', { phone, uid });
            return success(res, {
              verified: false,
              exists: false,
              searchedBy: phone ? 'phone' : 'uid',
              requestedBy
            }, 'User not found');
          }

          const user = result.rows[0];
          
          await logAudit(req, 'user-verification-success', { 
            phone, 
            uid, 
            foundUser: user.uid 
          });

          success(res, {
            verified: true,
            exists: true,
            user: {
              uid: user.uid,
              phone: userRole === 'ADMIN' ? user.phone : user.phone.slice(0, -4) + '****',
              name: user.name,
              role: user.role,
              registered_at: user.registered_at
            },
            searchedBy: phone ? 'phone' : 'uid',
            requestedBy
          }, 'User verified successfully');

        } catch (dbError) {
          logger.error('User Verification Error:', dbError);
          error(res, 'User verification failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Recent activity lookup (Admin only)
    [
      '/activity',
      async (req, res) => {
        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          if (userRole !== 'ADMIN') {
            return error(res, 'Access denied: Admin privileges required', HTTP_STATUS.FORBIDDEN);
          }

          const { days = 7, limit = 50 } = req.query;

          const recentActivity = await db.query(`
            SELECT 
              u.uid, u.phone, u.name, u.role,
              u.last_login,
              u.registered_at,
              CASE 
                WHEN u.last_login > NOW() - INTERVAL '1 day' THEN 'Very Active'
                WHEN u.last_login > NOW() - INTERVAL '7 days' THEN 'Active'
                WHEN u.last_login > NOW() - INTERVAL '30 days' THEN 'Inactive'
                ELSE 'Long Inactive'
              END as activity_status
            FROM users u
            WHERE u.registered_at > NOW() - INTERVAL '${parseInt(days)} days' 
               OR u.last_login > NOW() - INTERVAL '${parseInt(days)} days'
            ORDER BY COALESCE(u.last_login, u.registered_at) DESC
            LIMIT $1
          `, [Math.min(parseInt(limit), 100)]);

          await logAudit(req, 'user-activity-report-viewed', { days, recordCount: recentActivity.rows.length });

          success(res, {
            recentActivity: recentActivity.rows,
            periodDays: parseInt(days),
            totalRecords: recentActivity.rows.length,
            generatedBy: requestedBy,
            generatedAt: new Date().toISOString()
          }, 'Recent user activity retrieved');

        } catch (dbError) {
          logger.error('User Activity Lookup Error:', dbError);
          error(res, 'Failed to fetch user activity', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  // ✅ ADMIN ONLY - Bulk user operations
  post: [
    [
      '/bulk-search',
      advancedSearchValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          if (userRole !== 'ADMIN') {
            return error(res, 'Access denied: Admin privileges required for bulk operations', HTTP_STATUS.FORBIDDEN);
          }

          const { criteria, options = {} } = req.body;
          const { includeInactive = true, sortBy = 'registered_at', sortOrder = 'DESC', limit = 100 } = options;

          let query = 'SELECT * FROM users WHERE 1=1';
          const params = [];

          // Build dynamic query based on criteria
          if (criteria.role) {
            query += ` AND role = $${params.length + 1}`;
            params.push(criteria.role.toUpperCase());
          }

          if (criteria.registeredAfter) {
            query += ` AND registered_at >= $${params.length + 1}`;
            params.push(criteria.registeredAfter);
          }

          if (criteria.registeredBefore) {
            query += ` AND registered_at <= $${params.length + 1}`;
            params.push(criteria.registeredBefore);
          }

          if (criteria.namePattern) {
            query += ` AND LOWER(name) LIKE $${params.length + 1}`;
            params.push(`%${criteria.namePattern.toLowerCase()}%`);
          }

          if (criteria.phonePattern) {
            query += ` AND phone LIKE $${params.length + 1}`;
            params.push(`%${criteria.phonePattern}%`);
          }

          if (!includeInactive) {
            query += ` AND last_login > NOW() - INTERVAL '30 days'`;
          }

          // Apply sorting and limiting
          const allowedSortFields = ['name', 'registered_at', 'last_login', 'role', 'phone'];
          const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'registered_at';
          const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
          
          query += ` ORDER BY ${sortField} ${order} LIMIT $${params.length + 1}`;
          params.push(Math.min(parseInt(limit), 500));

          const result = await db.query(query, params);

          await logAudit(req, 'user-bulk-search', {
            criteria,
            options,
            resultsCount: result.rows.length
          });

          success(res, {
            users: result.rows,
            totalFound: result.rows.length,
            searchCriteria: criteria,
            searchOptions: options,
            executedBy: requestedBy,
            executedAt: new Date().toISOString()
          }, 'Bulk user search completed');

        } catch (dbError) {
          logger.error('Bulk User Search Error:', dbError);
          error(res, 'Bulk search operation failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
}, {
  requireUID: false,
  requirePhone: false
});

// ✅ BACKWARD COMPATIBILITY - Legacy lookup support
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
            // Delegate to the enhanced userController for backward compatibility
            await userController.lookupUser(req, res);
          } catch (error) {
            logger.error('Legacy lookup error:', error);
            error(res, 'Legacy lookup failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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