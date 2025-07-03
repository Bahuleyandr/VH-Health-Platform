// src/services/user/userService.js
import db from '../../config/database.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { USER_CONFIG } from '../../config/userConfig.js';
import logger from '../../logging/logger.js';

export class UserService {
  // Create or update user profile
  static async createOrUpdateProfile(data, createdBy) {
    const phone = normalizePhone(data.phone);
    
    try {
      // Check if user exists
      const existingUser = await db.query(
        'SELECT uid, role FROM users WHERE phone = $1',
        [phone]
      );
      
      if (existingUser.rows.length > 0) {
        // Update existing user
        const updateResult = await db.query(
          `UPDATE users SET 
            name = COALESCE($2, name),
            email = COALESCE($3, email),
            gender = COALESCE($4, gender),
            birthday = COALESCE($5, birthday),
            anniversary = COALESCE($6, anniversary),
            address = COALESCE($7, address),
            emergency_contact = COALESCE($8, emergency_contact),
            profile_picture = COALESCE($9, profile_picture),
            updated_at = NOW()
          WHERE phone = $1
          RETURNING *`,
          [
            phone, data.name, data.email, data.gender,
            data.birthday, data.anniversary, data.address,
            data.emergency_contact, data.profile_picture
          ]
        );
        
        logger.info(`User profile updated: ${phone} by ${createdBy}`);
        return { user: updateResult.rows[0], isNew: false };
      } else {
        // Create new user
        const insertResult = await db.query(
          `INSERT INTO users (
            phone, name, email, gender, birthday, anniversary,
            address, emergency_contact, profile_picture, role,
            registered_at, last_login
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
          RETURNING *`,
          [
            phone, data.name, data.email, data.gender,
            data.birthday, data.anniversary, data.address,
            data.emergency_contact, data.profile_picture,
            data.role || USER_CONFIG.ROLES.PATIENT
          ]
        );
        
        logger.info(`New user created: ${phone} by ${createdBy}`);
        return { user: insertResult.rows[0], isNew: true };
      }
    } catch (error) {
      logger.error('Create/Update Profile Error:', error);
      throw error;
    }
  }
  
  // List users with advanced filtering
  static async listUsers(filters, userRole) {
    const {
      page = 1,
      limit = USER_CONFIG.DEFAULT_PAGE_SIZE,
      role,
      search,
      status,
      department,
      sortBy = USER_CONFIG.SEARCH.DEFAULT_SORT_BY,
      sortOrder = USER_CONFIG.SEARCH.DEFAULT_SORT_ORDER
    } = filters;
    
    const offset = (page - 1) * limit;
    const params = [];
    let whereConditions = [];
    
    let query = `
      SELECT 
        u.uid, u.id, u.phone, u.name, u.email, u.role, u.gender,
        u.registered_at, u.last_login, u.address, u.profile_picture,
        CASE 
          WHEN s.is_active IS NOT NULL THEN s.is_active
          WHEN d.is_available IS NOT NULL THEN d.is_available
          ELSE true
        END as is_active,
        COALESCE(s.department, d.department) as department,
        d.specialization
      FROM users u
      LEFT JOIN staff s ON u.id = s.user_id
      LEFT JOIN doctors d ON u.id = d.user_id
    `;
    
    // Apply filters
    if (role) {
      whereConditions.push(`u.role = $${params.length + 1}`);
      params.push(role.toUpperCase());
    }
    
    if (search) {
      whereConditions.push(`(
        u.name ILIKE $${params.length + 1} OR 
        u.phone ILIKE $${params.length + 1} OR 
        u.email ILIKE $${params.length + 1}
      )`);
      params.push(`%${search}%`);
    }
    
    if (status === USER_CONFIG.USER_STATUS.ACTIVE) {
      whereConditions.push(`(
        s.is_active = true OR d.is_available = true OR 
        (s.is_active IS NULL AND d.is_available IS NULL)
      )`);
    } else if (status === USER_CONFIG.USER_STATUS.INACTIVE) {
      whereConditions.push(`(s.is_active = false OR d.is_available = false)`);
    }
    
    if (department) {
      whereConditions.push(`(s.department = $${params.length + 1} OR d.department = $${params.length + 1})`);
      params.push(department);
    }
    
    // Non-admin users cannot see admin accounts
    if (userRole !== USER_CONFIG.ROLES.ADMIN) {
      whereConditions.push(`u.role != '${USER_CONFIG.ROLES.ADMIN}'`);
    }
    
    if (whereConditions.length > 0) {
      query += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    // Add sorting
    const allowedSortFields = ['name', 'registered_at', 'last_login', 'role', 'phone'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : USER_CONFIG.SEARCH.DEFAULT_SORT_BY;
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    query += ` ORDER BY u.${sortField} ${order}`;
    
    // Add pagination
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Math.min(limit, USER_CONFIG.MAX_PAGE_SIZE), offset);
    
    // Execute main query
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = `
      SELECT COUNT(*) 
      FROM users u
      LEFT JOIN staff s ON u.id = s.user_id
      LEFT JOIN doctors d ON u.id = d.user_id
    `;
    
    if (whereConditions.length > 0) {
      countQuery += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    const countResult = await db.query(countQuery, params.slice(0, -2));
    const totalCount = parseInt(countResult.rows[0].count);
    
    return {
      users: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasNext: page * limit < totalCount,
        hasPrev: page > 1
      }
    };
  }
  
  // Get user by ID or UID
  static async getUserById(identifier, userRole) {
    let query;
    let params;
    
    // Check if identifier is numeric (ID) or UUID (UID)
    if (/^\d+$/.test(identifier)) {
      query = `
        SELECT u.*, 
               d.department as doctor_department, d.specialization,
               s.department as staff_department, s.shift
        FROM users u
        LEFT JOIN doctors d ON u.id = d.user_id
        LEFT JOIN staff s ON u.id = s.user_id
        WHERE u.id = $1
      `;
      params = [identifier];
    } else {
      query = `
        SELECT u.*, 
               d.department as doctor_department, d.specialization,
               s.department as staff_department, s.shift
        FROM users u
        LEFT JOIN doctors d ON u.id = d.user_id
        LEFT JOIN staff s ON u.id = s.user_id
        WHERE u.uid = $1
      `;
      params = [identifier];
    }
    
    const result = await db.query(query, params);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const user = result.rows[0];
    
    // Apply privacy filters for non-admin users
    if (userRole !== USER_CONFIG.ROLES.ADMIN) {
      delete user.address;
      delete user.emergency_contact;
      if (!['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
        // Mask phone for non-medical staff
        user.phone = user.phone ? 
          user.phone.slice(0, -USER_CONFIG.PRIVACY.PHONE_MASK_LENGTH) + '****' : null;
      }
    }
    
    return user;
  }
  
  // Update user
  static async updateUser(identifier, updateData, updatedBy) {
    const user = await this.getUserById(identifier, USER_CONFIG.ROLES.ADMIN);
    
    if (!user) {
      throw new Error('User not found');
    }
    
    const updateFields = [];
    const params = [];
    let paramIndex = 1;
    
    // Build dynamic update query
    const allowedFields = [
      'name', 'email', 'gender', 'birthday', 'anniversary',
      'address', 'emergency_contact', 'profile_picture'
    ];
    
    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        updateFields.push(`${field} = $${paramIndex}`);
        params.push(updateData[field]);
        paramIndex++;
      }
    }
    
    if (updateFields.length === 0) {
      return user; // No updates needed
    }
    
    updateFields.push('updated_at = NOW()');
    
    const updateQuery = `
      UPDATE users 
      SET ${updateFields.join(', ')}
      WHERE uid = $${paramIndex}
      RETURNING *
    `;
    params.push(user.uid);
    
    const result = await db.query(updateQuery, params);
    
    logger.info(`User updated: ${user.uid} by ${updatedBy}`);
    
    return result.rows[0];
  }
  
  // Change user status
  static async changeUserStatus(identifier, status, reason, changedBy) {
    const user = await this.getUserById(identifier, USER_CONFIG.ROLES.ADMIN);
    
    if (!user) {
      throw new Error('User not found');
    }
    
    // Update appropriate table based on user role
    if (['NURSE', 'PHARMACY_STAFF', 'LAB_STAFF', 'RECEPTIONIST'].includes(user.role)) {
      await db.query(
        `UPDATE staff 
         SET is_active = $1, notes = COALESCE($2, notes), updated_at = NOW() 
         WHERE user_id = $3`,
        [status === USER_CONFIG.USER_STATUS.ACTIVE, reason, user.id]
      );
    } else if (user.role === USER_CONFIG.ROLES.DOCTOR) {
      await db.query(
        `UPDATE doctors 
         SET is_available = $1, notes = COALESCE($2, notes), updated_at = NOW() 
         WHERE user_id = $3`,
        [status === USER_CONFIG.USER_STATUS.ACTIVE, reason, user.id]
      );
    }
    
    // Log status change
    await db.query(
      `INSERT INTO audit_logs (user_id, action, details, created_at, created_by)
       VALUES ($1, $2, $3, NOW(), $4)`,
      [user.id, 'USER_STATUS_CHANGE', JSON.stringify({ status, reason }), changedBy]
    );
    
    logger.info(`User status changed: ${user.uid} to ${status} by ${changedBy}`);
    
    return { ...user, status };
  }
  
  // Deactivate user (soft delete)
  static async deactivateUser(identifier, reason, deactivatedBy) {
    return this.changeUserStatus(
      identifier, 
      USER_CONFIG.USER_STATUS.DEACTIVATED, 
      reason, 
      deactivatedBy
    );
  }
  
  // Get users by role
  static async getUsersByRole(role, filters = {}) {
    const normalizedRole = role.toUpperCase();
    
    if (!Object.values(USER_CONFIG.ROLES).includes(normalizedRole)) {
      throw new Error('Invalid role specified');
    }
    
    return this.listUsers({ ...filters, role: normalizedRole }, USER_CONFIG.ROLES.ADMIN);
  }
  
  // Get users by department
  static async getUsersByDepartment(department, filters = {}) {
    return this.listUsers({ ...filters, department }, USER_CONFIG.ROLES.ADMIN);
  }
  
  // Search users with advanced filters
  static async searchUsers(searchCriteria, userRole) {
    const {
      query: searchQuery,
      role,
      department,
      registeredAfter,
      registeredBefore,
      lastLoginAfter,
      ageMin,
      ageMax,
      hasProfilePicture,
      includeInactive = true,
      page = 1,
      limit = USER_CONFIG.DEFAULT_PAGE_SIZE
    } = searchCriteria;
    
    const offset = (page - 1) * limit;
    const params = [];
    let whereConditions = [];
    
    let query = `
      SELECT 
        u.uid, u.id, u.phone, u.name, u.email, u.role, u.gender,
        u.registered_at, u.last_login, u.birthday, u.profile_picture,
        EXTRACT(YEAR FROM AGE(u.birthday)) as age,
        d.department, d.specialization
      FROM users u
      LEFT JOIN doctors d ON u.uid = d.user_uid
    `;
    
    // Apply search filters
    if (searchQuery) {
      whereConditions.push(`(
        u.name ILIKE $${params.length + 1} OR 
        u.phone ILIKE $${params.length + 1} OR 
        u.email ILIKE $${params.length + 1}
      )`);
      params.push(`%${searchQuery}%`);
    }
    
    if (role) {
      whereConditions.push(`u.role = $${params.length + 1}`);
      params.push(role.toUpperCase());
    }
    
    if (department) {
      whereConditions.push(`d.department ILIKE $${params.length + 1}`);
      params.push(`%${department}%`);
    }
    
    if (registeredAfter) {
      whereConditions.push(`u.registered_at >= $${params.length + 1}`);
      params.push(registeredAfter);
    }
    
    if (registeredBefore) {
      whereConditions.push(`u.registered_at <= $${params.length + 1}`);
      params.push(registeredBefore);
    }
    
    if (lastLoginAfter) {
      whereConditions.push(`u.last_login >= $${params.length + 1}`);
      params.push(lastLoginAfter);
    }
    
    if (ageMin !== undefined || ageMax !== undefined) {
      if (ageMin !== undefined) {
        whereConditions.push(`EXTRACT(YEAR FROM AGE(u.birthday)) >= $${params.length + 1}`);
        params.push(ageMin);
      }
      if (ageMax !== undefined) {
        whereConditions.push(`EXTRACT(YEAR FROM AGE(u.birthday)) <= $${params.length + 1}`);
        params.push(ageMax);
      }
    }
    
    if (hasProfilePicture !== undefined) {
      if (hasProfilePicture) {
        whereConditions.push(`u.profile_picture IS NOT NULL`);
      } else {
        whereConditions.push(`u.profile_picture IS NULL`);
      }
    }
    
    if (!includeInactive) {
      whereConditions.push(`u.last_login > NOW() - INTERVAL '30 days'`);
    }
    
    // Non-admin users cannot search for admin accounts
    if (userRole !== USER_CONFIG.ROLES.ADMIN) {
      whereConditions.push(`u.role != '${USER_CONFIG.ROLES.ADMIN}'`);
    }
    
    if (whereConditions.length > 0) {
      query += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    query += ' ORDER BY u.registered_at DESC';
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Math.min(limit, USER_CONFIG.MAX_SEARCH_RESULTS), offset);
    
    const result = await db.query(query, params);
    
    // Apply privacy filters
    const filteredResults = result.rows.map(user => {
      if (userRole !== USER_CONFIG.ROLES.ADMIN) {
        delete user.birthday;
        delete user.age;
        if (!['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
          user.phone = user.phone ? 
            user.phone.slice(0, -USER_CONFIG.PRIVACY.PHONE_MASK_LENGTH) + '****' : null;
        }
      }
      return user;
    });
    
    return {
      users: filteredResults,
      totalFound: filteredResults.length,
      searchCriteria
    };
  }
  
  // Bulk import users
  static async bulkImportUsers(usersData, importedBy) {
    if (usersData.length > USER_CONFIG.MAX_BULK_IMPORT) {
      throw new Error(`Cannot import more than ${USER_CONFIG.MAX_BULK_IMPORT} users at once`);
    }
    
    const results = {
      successful: [],
      failed: []
    };
    
    for (const userData of usersData) {
      try {
        const result = await this.createOrUpdateProfile(userData, importedBy);
        results.successful.push({
          phone: userData.phone,
          name: userData.name,
          status: result.isNew ? 'created' : 'updated'
        });
      } catch (error) {
        results.failed.push({
          phone: userData.phone,
          name: userData.name,
          error: error.message
        });
      }
    }
    
    logger.info(`Bulk import completed: ${results.successful.length} successful, ${results.failed.length} failed`);
    
    return results;
  }
}