// src/controllers/user/lookupController.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { LookupService } from '../../services/user/lookupService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { logAudit } from '../../utils/logAudit.js';
import { parseListQuery } from '../../utils/listQuery.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function safeSearchCriteria({ phone, uid, name, email }) {
  return {
    phone: Boolean(phone),
    uid: Boolean(uid),
    name: Boolean(name),
    email: Boolean(email),
  };
}

export class LookupController {
  // Basic user lookup (legacy - used by /legacy route)
  static async lookupUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }

      const users = await LookupService.lookupUser(
        req.query,
        req.user?.role,
        req.user?.uid
      );

      success(res, {
        users,
        totalFound: users.length,
        searchCriteria: req.query,
        accessLevel: req.user?.role,
        requestedBy: req.user?.uid
      }, users.length > 0 ? `Found ${users.length} matching user(s)` : 'No matching users found');

    } catch (err) {
      logger.error('Lookup User Controller Error:', err);

      if (err.message.includes('rate limit')) {
        return error(res, err.message, HTTP_STATUS.TOO_MANY_REQUESTS);
      }

      return relayAppError(res, err, 'User lookup failed');
    }
  }

  // Quick user verification (legacy - used by /legacy route)
  static async verifyUser(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }

      const result = await LookupService.verifyUser(
        req.query,
        req.user?.role,
        req.user?.uid
      );

      success(res, {
        ...result,
        searchedBy: req.query.phone ? 'phone' : 'uid',
        requestedBy: req.user?.uid
      }, result.verified ? 'User verified successfully' : 'User not found');

    } catch (err) {
      logger.error('Verify User Controller Error:', err);
      error(res, 'User verification failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  // Get user statistics (legacy)
  static async getUserStats(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }

      const stats = await LookupService.getUserStatistics(
        req.query.detailed === 'true',
        req.user?.role
      );

      success(res, {
        ...stats,
        accessLevel: req.user?.role,
        generatedAt: new Date().toISOString(),
        requestedBy: req.user?.uid
      }, 'User statistics retrieved successfully');

    } catch (err) {
      logger.error('Get User Stats Controller Error:', err);
      error(res, err.message || 'Failed to fetch user statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  // Get recent activity (legacy)
  static async getRecentActivity(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }

      const activity = await LookupService.getRecentActivity(
        req.query.days,
        req.query.limit
      );

      success(res, {
        recentActivity: activity,
        periodDays: parseInt(req.query.days || 7),
        totalRecords: activity.length,
        generatedBy: req.user?.uid,
        generatedAt: new Date().toISOString()
      }, 'Recent user activity retrieved');

    } catch (err) {
      logger.error('Get Recent Activity Controller Error:', err);
      error(res, err.message || 'Failed to fetch user activity', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  // Bulk search (legacy)
  static async bulkSearch(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED
        });
      }

      const users = await LookupService.bulkSearch(
        req.body.criteria,
        req.body.options
      );

      success(res, {
        users,
        totalFound: users.length,
        searchCriteria: req.body.criteria,
        searchOptions: req.body.options,
        executedBy: req.user?.uid,
        executedAt: new Date().toISOString()
      }, 'Bulk user search completed');

    } catch (err) {
      logger.error('Bulk Search Controller Error:', err);
      error(res, err.message || 'Bulk search operation failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  // Enhanced user lookup with comprehensive filtering and privacy controls
  static async enhancedLookup(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const { phone, uid, name, email } = req.query;
      const userRole = req.user?.role?.toUpperCase();
      const requestedBy = req.user?.uid;
      const tenantId = tenantOf(req);
      const listQuery = parseListQuery(req.query, {
        defaultLimit: 10,
        maxLimit: userRole === 'ADMIN' ? 50 : 20,
        defaultSortBy: 'registered_at'
      });

      if (!phone && !uid && !name && !email) {
        return error(res, 'Provide phone, uid, name, or email to search', HTTP_STATUS.BAD_REQUEST);
      }

      // Rate limiting for lookup requests to prevent enumeration
      const recentLookups = await prisma.$queryRawUnsafe(
        'SELECT COUNT(*) FROM audit_logs WHERE uid = $1 AND action = $2 AND created_at > NOW() - INTERVAL \'1 hour\'',
        requestedBy, 'user-lookup'
      );

      const lookupCount = parseInt(recentLookups[0].count);
      const maxLookupsPerHour = userRole === 'ADMIN' ? 1000 : userRole === 'DOCTOR' ? 100 : 50;

      if (lookupCount >= maxLookupsPerHour) {
        await logAudit(req, 'user-lookup-rate-limited', { count: lookupCount });
        return error(res, 'Lookup rate limit exceeded. Please try again later.', HTTP_STATUS.TOO_MANY_REQUESTS);
      }

      // Build query with role-based field selection
      let baseFields = 'u.uid, u.phone, u.name, u.registered_at, u.role';

      // Admin gets full access, others get limited fields
      if (userRole === 'ADMIN') {
        baseFields = 'u.uid, u.phone, u.name, u.email, u.role, u.registered_at, u.last_sign_in_at AS last_login, u.profile_picture, u.address, u.birthday, u.anniversary';
      } else if (['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
        baseFields = 'u.uid, u.phone, u.name, u.email, u.role, u.registered_at';
      }

      let query = `SELECT ${baseFields} FROM users u WHERE u.tenant_id = $1::uuid AND (`;
      const params = [tenantId];
      const conditions = [];

      if (phone) {
        conditions.push(`u.phone = $${params.length + 1}`);
        params.push(normalizePhone(phone));
      }

      if (uid) {
        conditions.push(`u.uid = $${params.length + 1}::uuid`);
        params.push(uid);
      }

      if (name) {
        conditions.push(`LOWER(u.name) LIKE $${params.length + 1}`);
        params.push(`%${name.toLowerCase()}%`);
      }

      if (email && ['ADMIN', 'DOCTOR'].includes(userRole)) {
        conditions.push(`LOWER(u.email) LIKE $${params.length + 1}`);
        params.push(`%${email.toLowerCase()}%`);
      }

      if (conditions.length === 0) {
        return error(res, 'No searchable criteria are available for your access level', HTTP_STATUS.BAD_REQUEST);
      }

      query += `${conditions.join(' OR ')})`;

      // Non-admin users cannot search for admin accounts
      if (userRole !== 'ADMIN') {
        query += ` AND u.role NOT IN ('ADMIN', 'SUPER_ADMIN')`;
      }

      query += ` ORDER BY u.registered_at DESC LIMIT $${params.length + 1}`;
      params.push(listQuery.limit);

      const result = await prisma.$queryRawUnsafe(query, ...params);

      // Additional privacy filtering for non-admin users
      const filteredResults = result.map(user => {
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
          searchCriteria: safeSearchCriteria({ phone, uid, name, email }),
          accessLevel: userRole,
          requestedBy
        }, 'No matching users found');
      }

      success(res, {
        users: filteredResults,
        totalFound: filteredResults.length,
        searchCriteria: safeSearchCriteria({ phone, uid, name, email }),
        accessLevel: userRole,
        requestedBy,
        privacyNote: userRole !== 'ADMIN' ? 'Results filtered based on your access level' : null
      }, `Found ${filteredResults.length} matching user(s)`);

    } catch (dbError) {
      logger.error('User Lookup Error:', dbError);
      error(res, 'User lookup failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  // Advanced user search (Admin and senior medical staff only)
  static async advancedSearch(req, res) {
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
      } = req.query;
      const listQuery = parseListQuery(req.query, {
        defaultLimit: 25,
        maxLimit: 100,
        defaultSortBy: 'registered_at',
        allowedSortFields: ['name', 'registered_at', 'last_login', 'role']
      });

      let query = `
        SELECT u.uid, u.phone, u.name, u.email, u.role, u.registered_at, u.last_sign_in_at AS last_login,
               u.profile_picture, u.address, u.birthday, u.gender,
               d.department, d.specialty AS specialization
        FROM users u
        LEFT JOIN doctors d ON u.id = d.user_id
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
        query += ` AND u.last_sign_in_at >= $${params.length + 1}`;
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
        query += ` AND u.last_sign_in_at > NOW() - INTERVAL '30 days'`;
      }

      // Validate and apply sorting
      const allowedSortFields = ['name', 'registered_at', 'last_login', 'role'];
      const sortField = allowedSortFields.includes(listQuery.sortBy) ? listQuery.sortBy : 'registered_at';
      const order = listQuery.sortOrder;

      query += ` ORDER BY u.${sortField} ${order} LIMIT $${params.length + 1}`;
      params.push(listQuery.limit);

      const result = await prisma.$queryRawUnsafe(query, ...params);

      await logAudit(req, 'user-advanced-search', {
        criteria: { role, registeredAfter, registeredBefore, lastLoginAfter, ageMin, ageMax, department },
        resultsCount: result.length
      });

      success(res, {
        users: result,
        totalFound: result.length,
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

  // User statistics (Admin and senior medical staff only)
  static async enhancedStats(req, res) {
    try {
      const userRole = req.user?.role?.toUpperCase();
      const requestedBy = req.user?.uid;
      const tenantId = tenantOf(req);

      if (!['ADMIN', 'DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
        return error(res, 'Access denied: Statistics require medical staff privileges', HTTP_STATUS.FORBIDDEN);
      }

      const { detailed = false } = req.query;

      // Basic statistics available to all authorized users
      const basicStats = await prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) as total_users,
          COUNT(*) FILTER (WHERE registered_at > NOW() - INTERVAL '30 days') as new_users_30d,
          COUNT(*) FILTER (WHERE last_sign_in_at > NOW() - INTERVAL '7 days') as active_users_7d,
          COUNT(*) FILTER (WHERE last_sign_in_at > NOW() - INTERVAL '30 days') as active_users_30d,
          COUNT(DISTINCT role) as unique_roles,
          MIN(registered_at) as first_registration,
          MAX(registered_at) as latest_registration
        FROM users
        WHERE tenant_id = $1::uuid
      `, tenantId);

      const roleDistribution = await prisma.$queryRawUnsafe(`
        SELECT role, COUNT(*) as count
        FROM users
        WHERE tenant_id = $1::uuid
        GROUP BY role
        ORDER BY count DESC
      `, tenantId);

      const responseData = {
        overallStats: basicStats[0],
        roleDistribution: roleDistribution,
        accessLevel: userRole,
        generatedAt: new Date().toISOString(),
        requestedBy
      };

      // Detailed statistics only for admin
      if (detailed === 'true' && userRole === 'ADMIN') {
        const [registrationTrends, loginActivity, ageDistribution, departmentStats] = await Promise.all([
          // Registration trends (last 30 days)
          prisma.$queryRawUnsafe(`
            SELECT DATE(registered_at) as date, COUNT(*) as registrations
            FROM users
            WHERE tenant_id = $1::uuid
              AND registered_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(registered_at)
            ORDER BY date DESC
          `, tenantId),

          // Login activity analysis
          prisma.$queryRawUnsafe(`
            SELECT
              COUNT(*) FILTER (WHERE last_sign_in_at > NOW() - INTERVAL '1 day') as logins_1d,
              COUNT(*) FILTER (WHERE last_sign_in_at > NOW() - INTERVAL '7 days') as logins_7d,
              COUNT(*) FILTER (WHERE last_sign_in_at > NOW() - INTERVAL '30 days') as logins_30d,
              COUNT(*) FILTER (WHERE last_sign_in_at IS NULL) as never_logged_in,
              AVG(EXTRACT(EPOCH FROM (NOW() - last_sign_in_at))/86400) as avg_days_since_login
            FROM users
            WHERE tenant_id = $1::uuid
          `, tenantId),

          // Age distribution (for patients)
          prisma.$queryRawUnsafe(`
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
            WHERE tenant_id = $1::uuid
              AND role = 'PATIENT'
              AND birthday IS NOT NULL
            GROUP BY age_group
            ORDER BY count DESC
          `, tenantId),

          // Department statistics
          prisma.$queryRawUnsafe(`
            SELECT d.department, d.specialty AS specialization, COUNT(u.uid) as staff_count
            FROM doctors d
            LEFT JOIN users u ON d.user_id = u.id
            WHERE u.tenant_id = $1::uuid
            GROUP BY d.department, d.specialty
            ORDER BY staff_count DESC
          `, tenantId)
        ]);

        responseData.detailedStats = {
          registrationTrends: registrationTrends,
          loginActivity: loginActivity[0],
          ageDistribution: ageDistribution,
          departmentStats: departmentStats
        };
      }

      await logAudit(req, 'user-stats-viewed', { detailed: detailed === 'true' });

      success(res, responseData, 'User statistics retrieved successfully');

    } catch (dbError) {
      logger.error('Lookup Stats Error:', dbError);
      error(res, 'Failed to fetch user statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  // Quick user verification (for staff workflows)
  static async enhancedVerify(req, res) {
    try {
      const { phone, uid } = req.query;
      const userRole = req.user?.role?.toUpperCase();
      const requestedBy = req.user?.uid;
      const tenantId = tenantOf(req);

      if (!['DOCTOR', 'NURSING_STAFF', 'PHARMACY_STAFF', 'LAB_STAFF', 'ADMIN'].includes(userRole)) {
        return error(res, 'Access denied: Staff privileges required', HTTP_STATUS.FORBIDDEN);
      }

      if (!phone && !uid) {
        return error(res, 'Provide phone or uid for verification', HTTP_STATUS.BAD_REQUEST);
      }

      let query, params;
      if (uid) {
        query = 'SELECT uid, phone, name, role, registered_at FROM users WHERE uid = $1::uuid AND tenant_id = $2::uuid';
        params = [uid, tenantId];
      } else {
        query = 'SELECT uid, phone, name, role, registered_at FROM users WHERE phone = $1 AND tenant_id = $2::uuid';
        params = [normalizePhone(phone), tenantId];
      }

      const result = await prisma.$queryRawUnsafe(query, ...params);

      if (result.length === 0) {
        await logAudit(req, 'user-verification-failed', { phone, uid });
        return success(res, {
          verified: false,
          exists: false,
          searchedBy: phone ? 'phone' : 'uid',
          requestedBy
        }, 'User not found');
      }

      const user = result[0];

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

  // Recent activity lookup (Admin only)
  static async enhancedActivity(req, res) {
    try {
      const userRole = req.user?.role?.toUpperCase();
      const requestedBy = req.user?.uid;
      const tenantId = tenantOf(req);

      if (userRole !== 'ADMIN') {
        return error(res, 'Access denied: Admin privileges required', HTTP_STATUS.FORBIDDEN);
      }

      const { days = 7 } = req.query;
      const listQuery = parseListQuery(req.query, {
        defaultLimit: 50,
        maxLimit: 100,
        defaultSortBy: 'last_login'
      });

      const recentActivity = await prisma.$queryRawUnsafe(`
        SELECT
          u.uid, u.phone, u.name, u.role,
          u.last_sign_in_at AS last_login,
          u.registered_at,
          CASE
            WHEN u.last_sign_in_at > NOW() - INTERVAL '1 day' THEN 'Very Active'
            WHEN u.last_sign_in_at > NOW() - INTERVAL '7 days' THEN 'Active'
            WHEN u.last_sign_in_at > NOW() - INTERVAL '30 days' THEN 'Inactive'
            ELSE 'Long Inactive'
          END as activity_status
        FROM users u
        WHERE u.tenant_id = $3::uuid
          AND (
            u.registered_at > NOW() - make_interval(days => $2)
            OR u.last_sign_in_at > NOW() - make_interval(days => $2)
          )
        ORDER BY COALESCE(u.last_sign_in_at, u.registered_at) DESC
        LIMIT $1
      `, listQuery.limit, parseInt(days), tenantId);

      await logAudit(req, 'user-activity-report-viewed', { days, recordCount: recentActivity.length });

      success(res, {
        recentActivity: recentActivity,
        periodDays: parseInt(days),
        totalRecords: recentActivity.length,
        generatedBy: requestedBy,
        generatedAt: new Date().toISOString()
      }, 'Recent user activity retrieved');

    } catch (dbError) {
      logger.error('User Activity Lookup Error:', dbError);
      error(res, 'Failed to fetch user activity', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }

  // Bulk user search (Admin only)
  static async enhancedBulkSearch(req, res) {
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
      const tenantId = tenantOf(req);

      if (userRole !== 'ADMIN') {
        return error(res, 'Access denied: Admin privileges required for bulk operations', HTTP_STATUS.FORBIDDEN);
      }

      const { criteria, options = {} } = req.body;
      const { includeInactive = true } = options;
      const listQuery = parseListQuery(options, {
        defaultLimit: 100,
        maxLimit: 500,
        defaultSortBy: 'registered_at',
        allowedSortFields: ['name', 'registered_at', 'last_login', 'role', 'phone']
      });

      let query = `SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.role,
        NULL::text AS department, NULL::text AS specialty, NULL::text AS employee_id,
        u.is_active, u.status, u.registered_at, u.updated_at, u.last_sign_in_at AS last_login
        FROM users u
        WHERE u.tenant_id = $1::uuid`;
      const params = [tenantId];

      // Build dynamic query based on criteria
      if (criteria.role) {
        query += ` AND u.role = $${params.length + 1}`;
        params.push(criteria.role.toUpperCase());
      }

      if (criteria.registeredAfter) {
        query += ` AND u.registered_at >= $${params.length + 1}`;
        params.push(criteria.registeredAfter);
      }

      if (criteria.registeredBefore) {
        query += ` AND u.registered_at <= $${params.length + 1}`;
        params.push(criteria.registeredBefore);
      }

      if (criteria.namePattern) {
        query += ` AND LOWER(u.name) LIKE $${params.length + 1}`;
        params.push(`%${criteria.namePattern.toLowerCase()}%`);
      }

      if (criteria.phonePattern) {
        query += ` AND u.phone LIKE $${params.length + 1}`;
        params.push(`%${criteria.phonePattern}%`);
      }

      if (!includeInactive) {
        query += ` AND u.last_sign_in_at > NOW() - INTERVAL '30 days'`;
      }

      // Apply sorting and limiting
      const allowedSortFields = {
        name: 'u.name',
        registered_at: 'u.registered_at',
        last_login: 'u.last_sign_in_at',
        role: 'u.role',
        phone: 'u.phone',
      };
      const sortField = allowedSortFields[listQuery.sortBy] || allowedSortFields.registered_at;
      const order = listQuery.sortOrder;

      query += ` ORDER BY ${sortField} ${order} LIMIT $${params.length + 1}`;
      params.push(listQuery.limit);

      const result = await prisma.$queryRawUnsafe(query, ...params);

      await logAudit(req, 'user-bulk-search', {
        criteria,
        options,
        resultsCount: result.length
      });

      success(res, {
        users: result,
        totalFound: result.length,
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
}
