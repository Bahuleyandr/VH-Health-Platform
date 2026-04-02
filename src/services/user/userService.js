// src/services/user/userService.js
// Migrated from raw pg to Prisma ORM

import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
import { USER_CONFIG } from '../../config/userConfig.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';

export class UserService {
  static async createOrUpdateProfile(data, createdBy) {
    const phone = normalizePhone(data.phone);
    try {
      const existing = await prisma.$queryRaw`SELECT uid, role FROM users WHERE phone = ${phone}`;

      if (existing.length > 0) {
        const rows = await prisma.$queryRaw`
          UPDATE users SET
            name               = COALESCE(${data.name ?? null}, name),
            email              = COALESCE(${data.email ?? null}, email),
            gender             = COALESCE(${data.gender ?? null}, gender),
            birthday           = COALESCE(${data.birthday ?? null}::date, birthday),
            anniversary        = COALESCE(${data.anniversary ?? null}::date, anniversary),
            address            = COALESCE(${data.address ?? null}, address),
            profile_picture    = COALESCE(${data.profile_picture ?? null}, profile_picture),
            updated_at         = NOW()
          WHERE phone = ${phone}
          RETURNING id, uid, phone, name, email, role, is_active, registered_at, updated_at
        `;
        logger.info(`User profile updated: ${phone} by ${createdBy}`);
        return { user: rows[0], isNew: false };
      } else {
        const rows = await prisma.$queryRaw`
          INSERT INTO users (
            phone, name, email, gender, birthday, anniversary,
            address, profile_picture, role, registered_at, updated_at
          ) VALUES (
            ${phone}, ${data.name ?? null}, ${data.email ?? null},
            ${data.gender ?? null}, ${data.birthday ?? null}::date,
            ${data.anniversary ?? null}::date, ${data.address ?? null},
            ${data.profile_picture ?? null},
            ${data.role || USER_CONFIG.ROLES.PATIENT},
            NOW(), NOW()
          )
          RETURNING id, uid, phone, name, email, role, is_active, registered_at, updated_at
        `;
        logger.info(`New user created: ${phone} by ${createdBy}`);
        return { user: rows[0], isNew: true };
      }
    } catch (error) {
      logger.error('Create/Update Profile Error:', error);
      throw error;
    }
  }

  static async listUsers(filters, userRole) {
    const {
      page = 1,
      limit = USER_CONFIG.DEFAULT_PAGE_SIZE,
      role, search, status, department,
      sortBy = USER_CONFIG.SEARCH.DEFAULT_SORT_BY,
      sortOrder = USER_CONFIG.SEARCH.DEFAULT_SORT_ORDER,
    } = filters;

    const offset = (page - 1) * limit;
    const conditions = [Prisma.sql`1=1`];

    if (role) conditions.push(Prisma.sql`u.role = ${role.toUpperCase()}`);
    if (search) {
      const s = `%${search}%`;
      conditions.push(Prisma.sql`(u.name ILIKE ${s} OR u.phone ILIKE ${s} OR u.email ILIKE ${s})`);
    }
    if (status === USER_CONFIG.USER_STATUS?.ACTIVE) {
      conditions.push(Prisma.sql`(s.is_active = true OR d.is_available = true OR (s.is_active IS NULL AND d.is_available IS NULL))`);
    } else if (status === USER_CONFIG.USER_STATUS?.INACTIVE) {
      conditions.push(Prisma.sql`(s.is_active = false OR d.is_available = false)`);
    }
    if (department) {
      conditions.push(Prisma.sql`(s.department = ${department} OR d.department = ${department})`);
    }
    if (userRole !== USER_CONFIG.ROLES.ADMIN) {
      conditions.push(Prisma.sql`u.role != ${USER_CONFIG.ROLES.ADMIN}`);
    }

    const whereClause = Prisma.join(conditions, ' AND ');

    const allowedSortFields = ['name', 'registered_at', 'last_login', 'role', 'phone'];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : USER_CONFIG.SEARCH.DEFAULT_SORT_BY;
    const order = sortOrder?.toUpperCase() === 'ASC' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const limitNum = Math.min(limit, USER_CONFIG.MAX_PAGE_SIZE);

    const [users, countRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          u.uid, u.id, u.phone, u.name, u.email, u.role, u.gender,
          u.registered_at, u.last_login, u.address, u.profile_picture,
          CASE
            WHEN s.is_active IS NOT NULL THEN s.is_active
            WHEN d.is_available IS NOT NULL THEN d.is_available
            ELSE true
          END AS is_active,
          COALESCE(s.department, d.department) AS department,
          d.specialty AS specialization
        FROM users u
        LEFT JOIN staff s ON u.id = s.user_id
        LEFT JOIN doctors d ON u.id = d.user_id
        WHERE ${whereClause}
        ORDER BY u.${Prisma.raw(sortField)} ${order}
        LIMIT ${limitNum} OFFSET ${offset}
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM users u
        LEFT JOIN staff s ON u.id = s.user_id
        LEFT JOIN doctors d ON u.id = d.user_id
        WHERE ${whereClause}
      `,
    ]);

    const totalCount = countRows[0].count;
    return {
      users,
      pagination: {
        page: parseInt(page), limit: parseInt(limit),
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasNext: page * limit < totalCount,
        hasPrev: page > 1,
      },
    };
  }

  static async getUserById(identifier, userRole) {
    let rows;
    if (/^\d+$/.test(identifier)) {
      rows = await prisma.$queryRaw`
        SELECT u.*,
               d.department AS doctor_department, d.specialty AS specialization,
               s.department AS staff_department, s.shift
        FROM users u
        LEFT JOIN doctors d ON u.id = d.user_id
        LEFT JOIN staff s ON u.id = s.user_id
        WHERE u.id = ${parseInt(identifier)}
      `;
    } else {
      rows = await prisma.$queryRaw`
        SELECT u.*,
               d.department AS doctor_department, d.specialty AS specialization,
               s.department AS staff_department, s.shift
        FROM users u
        LEFT JOIN doctors d ON u.id = d.user_id
        LEFT JOIN staff s ON u.id = s.user_id
        WHERE u.uid = ${identifier}::uuid
      `;
    }

    if (rows.length === 0) return null;
    const user = { ...rows[0] };

    if (userRole !== USER_CONFIG.ROLES.ADMIN) {
      delete user.address;
      if (!['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
        user.phone = user.phone
          ? user.phone.slice(0, -(USER_CONFIG.PRIVACY?.PHONE_MASK_LENGTH || 4)) + '****'
          : null;
      }
    }
    return user;
  }

  static async updateUser(identifier, updateData, updatedBy) {
    const user = await this.getUserById(identifier, USER_CONFIG.ROLES.ADMIN);
    if (!user) throw new Error('User not found');

    const allowedFields = [
      'name', 'email', 'gender', 'birthday', 'anniversary',
      'address', 'profile_picture',
    ];

    const sets = [];
    const params = [];
    let idx = 1;

    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        sets.push(`${field} = $${idx}`);
        params.push(updateData[field]);
        idx++;
      }
    }

    if (sets.length === 0) return user;

    sets.push('updated_at = NOW()');
    params.push(user.uid);

    const rows = await prisma.$queryRawUnsafe(
      `UPDATE users SET ${sets.join(', ')} WHERE uid = $${idx}
       RETURNING id, uid, phone, name, email, role, is_active, registered_at, updated_at`,
      ...params
    );

    logger.info(`User updated: ${user.uid} by ${updatedBy}`);
    return rows[0];
  }

  static async changeUserStatus(identifier, status, reason, changedBy) {
    const user = await this.getUserById(identifier, USER_CONFIG.ROLES.ADMIN);
    if (!user) throw new Error('User not found');

    const isActive = status === USER_CONFIG.USER_STATUS?.ACTIVE;

    if (['NURSE', 'PHARMACY_STAFF', 'LAB_STAFF', 'RECEPTIONIST'].includes(user.role)) {
      await prisma.$queryRaw`
        UPDATE staff SET is_active = ${isActive}, updated_at = NOW() WHERE user_id = ${user.id}
      `;
    } else if (user.role === USER_CONFIG.ROLES.DOCTOR) {
      await prisma.$queryRaw`
        UPDATE doctors SET is_available = ${isActive}, updated_at = NOW() WHERE user_id = ${user.id}
      `;
    }

    await prisma.audit_logs.create({
      data: {
        uid: changedBy || null,
        action: 'USER_STATUS_CHANGE',
        metadata: { status, reason, user_id: user.id },
      },
    });

    logger.info(`User status changed: ${user.uid} to ${status} by ${changedBy}`);
    return { ...user, status };
  }

  static async deactivateUser(identifier, reason, deactivatedBy) {
    return this.changeUserStatus(identifier, USER_CONFIG.USER_STATUS?.DEACTIVATED, reason, deactivatedBy);
  }

  static async getUsersByRole(role, filters = {}) {
    const normalizedRole = role.toUpperCase();
    if (!Object.values(USER_CONFIG.ROLES).includes(normalizedRole)) {
      throw new Error('Invalid role specified');
    }
    return this.listUsers({ ...filters, role: normalizedRole }, USER_CONFIG.ROLES.ADMIN);
  }

  static async getUsersByDepartment(department, filters = {}) {
    return this.listUsers({ ...filters, department }, USER_CONFIG.ROLES.ADMIN);
  }

  static async searchUsers(searchCriteria, userRole) {
    const {
      query: searchQuery, role, department,
      registeredAfter, registeredBefore, lastLoginAfter,
      ageMin, ageMax, hasProfilePicture,
      includeInactive = true,
      page = 1, limit = USER_CONFIG.DEFAULT_PAGE_SIZE,
    } = searchCriteria;

    const offset = (page - 1) * limit;
    const conditions = [Prisma.sql`1=1`];

    if (searchQuery) {
      const s = `%${searchQuery}%`;
      conditions.push(Prisma.sql`(u.name ILIKE ${s} OR u.phone ILIKE ${s} OR u.email ILIKE ${s})`);
    }
    if (role) conditions.push(Prisma.sql`u.role = ${role.toUpperCase()}`);
    if (department) conditions.push(Prisma.sql`d.department ILIKE ${'%' + department + '%'}`);
    if (registeredAfter) conditions.push(Prisma.sql`u.registered_at >= ${new Date(registeredAfter)}`);
    if (registeredBefore) conditions.push(Prisma.sql`u.registered_at <= ${new Date(registeredBefore)}`);
    if (lastLoginAfter) conditions.push(Prisma.sql`u.last_login >= ${new Date(lastLoginAfter)}`);
    if (ageMin !== undefined) conditions.push(Prisma.sql`EXTRACT(YEAR FROM AGE(u.birthday)) >= ${ageMin}`);
    if (ageMax !== undefined) conditions.push(Prisma.sql`EXTRACT(YEAR FROM AGE(u.birthday)) <= ${ageMax}`);
    if (hasProfilePicture === true) conditions.push(Prisma.sql`u.profile_picture IS NOT NULL`);
    else if (hasProfilePicture === false) conditions.push(Prisma.sql`u.profile_picture IS NULL`);
    if (!includeInactive) conditions.push(Prisma.sql`u.last_login > NOW() - INTERVAL '30 days'`);
    if (userRole !== USER_CONFIG.ROLES.ADMIN) conditions.push(Prisma.sql`u.role != ${USER_CONFIG.ROLES.ADMIN}`);

    const whereClause = Prisma.join(conditions, ' AND ');
    const limitNum = Math.min(limit, USER_CONFIG.MAX_SEARCH_RESULTS || 500);

    const users = await prisma.$queryRaw`
      SELECT
        u.uid, u.id, u.phone, u.name, u.email, u.role, u.gender,
        u.registered_at, u.last_login, u.birthday, u.profile_picture,
        EXTRACT(YEAR FROM AGE(u.birthday))::int AS age,
        d.department, d.specialty AS specialization
      FROM users u
      LEFT JOIN doctors d ON u.uid = d.user_uid
      WHERE ${whereClause}
      ORDER BY u.registered_at DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const filtered = users.map(user => {
      const u = { ...user };
      if (userRole !== USER_CONFIG.ROLES.ADMIN) {
        delete u.birthday;
        delete u.age;
        if (!['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
          u.phone = u.phone
            ? u.phone.slice(0, -(USER_CONFIG.PRIVACY?.PHONE_MASK_LENGTH || 4)) + '****'
            : null;
        }
      }
      return u;
    });

    return { users: filtered, totalFound: filtered.length, searchCriteria };
  }

  static async bulkImportUsers(usersData, importedBy) {
    if (usersData.length > (USER_CONFIG.MAX_BULK_IMPORT || 500)) {
      throw new Error(`Cannot import more than ${USER_CONFIG.MAX_BULK_IMPORT} users at once`);
    }

    const results = { successful: [], failed: [] };

    for (const userData of usersData) {
      try {
        const result = await this.createOrUpdateProfile(userData, importedBy);
        results.successful.push({
          phone: userData.phone,
          name: userData.name,
          status: result.isNew ? 'created' : 'updated',
        });
      } catch (error) {
        results.failed.push({ phone: userData.phone, name: userData.name, error: error.message });
      }
    }

    logger.info(`Bulk import completed: ${results.successful.length} successful, ${results.failed.length} failed`);
    return results;
  }
}
