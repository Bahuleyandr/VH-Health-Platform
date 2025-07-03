// src/services/user/lookupService.js
import db from '../../config/database.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { USER_CONFIG } from '../../config/userConfig.js';
import logger from '../../logging/logger.js';

export class LookupService {
  // Basic user lookup
  static async lookupUser(searchParams, userRole, requestedBy) {
    const { phone, uid, name, email, limit = 10 } = searchParams;
    
    if (!phone && !uid && !name && !email) {
      throw new Error('Provide at least one search parameter');
    }
    
    // Check rate limiting
    const recentLookups = await db.query(
      'SELECT COUNT(*) FROM audit_logs WHERE uid = $1 AND action = $2 AND created_at > NOW() - INTERVAL \'1 hour\'',
      [requestedBy, 'user-lookup']
    );
    
    const lookupCount = parseInt(recentLookups.rows[0].count);
    const maxLookups = USER_CONFIG.PRIVACY.MAX_LOOKUPS_PER_HOUR[userRole] || 
                      USER_CONFIG.PRIVACY.MAX_LOOKUPS_PER_HOUR.DEFAULT;
    
    if (lookupCount >= maxLookups) {
      throw new Error('Lookup rate limit exceeded. Please try again later.');
    }
    
    // Build query with role-based field selection
    let baseFields = 'uid, phone, name, registered_at, role';
    
    if (userRole === USER_CONFIG.ROLES.ADMIN) {
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
    if (userRole !== USER_CONFIG.ROLES.ADMIN) {
      conditions.push(`role != 'ADMIN'`);
    }
    
    query += conditions.join(' OR ');
    query += ` ORDER BY registered_at DESC LIMIT $${params.length + 1}`;
    params.push(Math.min(parseInt(limit), userRole === 'ADMIN' ? 50 : 20));
    
    const result = await db.query(query, params);
    
    // Apply privacy filtering
    const filteredResults = result.rows.map(user => {
      if (userRole !== USER_CONFIG.ROLES.ADMIN) {
        delete user.last_login;
        delete user.address;
        delete user.birthday;
        delete user.anniversary;
        
        // Mask phone numbers for non-medical staff
        if (!['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole)) {
          user.phone = user.phone ? 
            user.phone.slice(0, -USER_CONFIG.PRIVACY.PHONE_MASK_LENGTH) + '****' : null;
        }
      }
      return user;
    });
    
    // Log the lookup
    await db.query(
      'INSERT INTO audit_logs (uid, action, details, created_at) VALUES ($1, $2, $3, NOW())',
      [requestedBy, 'user-lookup', JSON.stringify({ searchParams, resultsCount: filteredResults.length })]
    );
    
    return filteredResults;
  }
  
  // Quick user verification
  static async verifyUser(identifier, userRole, requestedBy) {
    const { phone, uid } = identifier;
    
    if (!phone && !uid) {
      throw new Error('Provide phone or uid for verification');
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
      // Log failed verification
      await db.query(
        'INSERT INTO audit_logs (uid, action, details, created_at) VALUES ($1, $2, $3, NOW())',
        [requestedBy, 'user-verification-failed', JSON.stringify(identifier)]
      );
      
      return { verified: false, exists: false };
    }
    
    const user = result.rows[0];
    
    // Apply privacy filtering
    if (userRole !== USER_CONFIG.ROLES.ADMIN && !['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
      user.phone = user.phone.slice(0, -USER_CONFIG.PRIVACY.PHONE_MASK_LENGTH) + '****';
    }
    
    // Log successful verification
    await db.query(
      'INSERT INTO audit_logs (uid, action, details, created_at) VALUES ($1, $2, $3, NOW())',
      [requestedBy, 'user-verification-success', JSON.stringify({ foundUser: user.uid })]
    );
    
    return {
      verified: true,
      exists: true,
      user
    };
  }
  
  // Get user statistics
  static async getUserStatistics(detailed = false, userRole) {
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
    
    let responseData = {
      overallStats: basicStats.rows[0],
      roleDistribution: roleDistribution.rows
    };
    
    // Detailed statistics only for admin
    if (detailed && userRole === USER_CONFIG.ROLES.ADMIN) {
      const [registrationTrends, loginActivity, ageDistribution, departmentStats] = await Promise.all([
        // Registration trends
        db.query(`
          SELECT DATE(registered_at) as date, COUNT(*) as registrations
          FROM users 
          WHERE registered_at > NOW() - INTERVAL '30 days'
          GROUP BY DATE(registered_at)
          ORDER BY date DESC
        `),
        
        // Login activity
        db.query(`
          SELECT 
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '1 day') as logins_1d,
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '7 days') as logins_7d,
            COUNT(*) FILTER (WHERE last_login > NOW() - INTERVAL '30 days') as logins_30d,
            COUNT(*) FILTER (WHERE last_login IS NULL) as never_logged_in,
            AVG(EXTRACT(EPOCH FROM (NOW() - last_login))/86400) as avg_days_since_login
          FROM users
        `),
        
        // Age distribution
        db.query(`
          SELECT 
            CASE 
              WHEN EXTRACT(YEAR FROM AGE(birthday)) < 18 THEN 'Under 18'
              WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 18 AND 30 THEN '18-30'
              WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 31 AND 50 THEN '31-50'
              WHEN EXTRACT(YEAR FROM AGE(birthday)) BETWEEN 51 AND 70 THEN '51-70'
              WHEN EXTRACT(YEAR FROM AGE(birthday)) > 70 THEN 'Over 70'
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
    
    return responseData;
  }
  
  // Get recent user activity
  static async getRecentActivity(days = 7, limit = 50) {
    const result = await db.query(`
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
    
    return result.rows;
  }
  
  // Bulk user search
  static async bulkSearch(criteria, options = {}) {
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
    
    // Apply sorting
    const allowedSortFields = ['name', 'registered_at', 'last_login', 'role', 'phone'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'registered_at';
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    
    query += ` ORDER BY ${sortField} ${order} LIMIT $${params.length + 1}`;
    params.push(Math.min(parseInt(limit), 500));
    
    const result = await db.query(query, params);
    
    return result.rows;
  }
}