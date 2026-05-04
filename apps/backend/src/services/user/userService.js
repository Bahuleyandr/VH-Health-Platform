import { Prisma } from '@prisma/client';
import { USER_CONFIG } from '../../config/userConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import {
  encryptColumn,
  searchableHash,
} from '../../services/security/phiColumnEncryption.js';

const USER_SELECT = {
  id: true,
  uid: true,
  phone: true,
  name: true,
  email: true,
  role: true,
  is_active: true,
  registered_at: true,
  updated_at: true,
};

const PROFILE_FIELDS_IN_SCHEMA = [
  'name',
  'email',
  'gender',
  'birthday',
  'anniversary',
  'address',
  'profile_picture',
];
const PROFILE_DATE_FIELDS = new Set(['birthday', 'anniversary']);

function coerceProfileField(field, value) {
  if (!PROFILE_DATE_FIELDS.has(field) || value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  return new Date(value);
}

function mapUserSummary(user) {
  if (!user) return user;

  return {
    id: user.id,
    uid: user.uid,
    phone: user.phone,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.is_active ? USER_CONFIG.USER_STATUS.ACTIVE : USER_CONFIG.USER_STATUS.INACTIVE,
    created_at: user.registered_at,
    updated_at: user.updated_at,
  };
}

function buildProfileUpdateData(data, includeRole = false) {
  const updateData = {};

  for (const field of PROFILE_FIELDS_IN_SCHEMA) {
    if (data[field] !== undefined) {
      updateData[field] = coerceProfileField(field, data[field]);
    }
  }

  if (includeRole && data.role !== undefined) {
    updateData.role = data.role;
  }

  return updateData;
}

/**
 * Phase E3 follow-up — best-effort write of encrypted shadow columns
 * after a successful Prisma write. Kept in a separate raw UPDATE so the
 * generated Prisma client doesn't need to know about migration 132's
 * shadow columns. Schema-missing degrades silently.
 */
async function writePhiShadows(userId, data, { isCreate = false } = {}) {
  if (!userId) return;
  const sets = [];
  const params = [];
  const tryEncrypt = (field, val) => {
    try {
      const enc = encryptColumn(val);
      params.push(enc);
      sets.push(`${field} = $${params.length}`);
    } catch (err) {
      // KMS_MASTER_KEY missing — skip silently in dev.
      logger.warn('PHI shadow-column encrypt skipped:', { field, error: err.message });
    }
  };

  if (data.name !== undefined) tryEncrypt('name_encrypted', data.name);
  if (data.address !== undefined) tryEncrypt('address_encrypted', data.address);
  if (isCreate && data.phone !== undefined) {
    tryEncrypt('phone_encrypted', data.phone);
    try {
      params.push(searchableHash(data.phone));
      sets.push(`phone_search_hash = $${params.length}`);
    } catch (err) {
      logger.warn('phone_search_hash skipped:', { error: err.message });
    }
  }

  if (sets.length === 0) return;
  params.push(userId);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`,
      ...params,
    );
  } catch (err) {
    if (!/does not exist/i.test(String(err.message))) {
      logger.warn('PHI shadow-column write failed:', { error: err.message });
    }
  }
}

function applyPrivacyFilters(user, userRole) {
  if (!user) return user;

  if (userRole !== USER_CONFIG.ROLES.ADMIN) {
    delete user.address;
    delete user.emergency_contact;

    if (!['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
      user.phone = user.phone
        ? user.phone.slice(0, -USER_CONFIG.PRIVACY.PHONE_MASK_LENGTH) + '****'
        : null;
    }
  }

  return user;
}

export class UserService {
  // Create or update user profile
  static async createOrUpdateProfile(data, createdBy) {
    const phone = normalizePhone(data.phone || data.phoneNumber);

    try {
      const existingUser = await prisma.users.findUnique({
        where: { phone },
        select: { uid: true, role: true },
      });

      if (existingUser) {
        const updateData = {
          ...buildProfileUpdateData(data),
          updated_at: new Date(),
        };

        const updatedUser = await prisma.users.update({
          where: { phone },
          data: updateData,
          select: USER_SELECT,
        });

        // Phase E3 follow-up — write the *_encrypted shadow columns.
        await writePhiShadows(updatedUser.id, data);

        logger.info(`User profile updated: ${phone} by ${createdBy}`);
        return { user: mapUserSummary(updatedUser), isNew: false };
      }

      const createdUser = await prisma.users.create({
        data: {
          phone,
          ...buildProfileUpdateData(data, true),
          role: data.role || USER_CONFIG.ROLES.PATIENT,
          registered_at: new Date(),
          updated_at: new Date(),
        },
        select: USER_SELECT,
      });

      // Phase E3 follow-up — write encrypted shadows + phone_search_hash.
      await writePhiShadows(createdUser.id, { ...data, phone }, { isCreate: true });

      logger.info(`New user created: ${phone} by ${createdBy}`);
      return { user: mapUserSummary(createdUser), isNew: true };
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
      sortOrder = USER_CONFIG.SEARCH.DEFAULT_SORT_ORDER,
    } = filters;

    const parsedPage = parseInt(page, 10);
    const parsedLimit = Math.min(parseInt(limit, 10) || USER_CONFIG.DEFAULT_PAGE_SIZE, USER_CONFIG.MAX_PAGE_SIZE);
    const offset = (parsedPage - 1) * parsedLimit;

    const conditions = [];

    if (role) {
      conditions.push(Prisma.sql`u.role = ${role.toUpperCase()}`);
    }

    if (search) {
      const searchTerm = `%${search}%`;
      conditions.push(Prisma.sql`(
        u.name ILIKE ${searchTerm} OR
        u.phone ILIKE ${searchTerm} OR
        u.email ILIKE ${searchTerm}
      )`);
    }

    if (status === USER_CONFIG.USER_STATUS.ACTIVE) {
      conditions.push(Prisma.sql`(
        s.is_active = true OR d.is_available = true OR
        (s.is_active IS NULL AND d.is_available IS NULL)
      )`);
    } else if (status === USER_CONFIG.USER_STATUS.INACTIVE) {
      conditions.push(Prisma.sql`(s.is_active = false OR d.is_available = false)`);
    }

    if (department) {
      conditions.push(Prisma.sql`(s.department = ${department} OR d.department = ${department})`);
    }

    if (userRole !== USER_CONFIG.ROLES.ADMIN) {
      conditions.push(Prisma.sql`u.role != ${USER_CONFIG.ROLES.ADMIN}`);
    }

    const whereClause = conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;

    const allowedSortFields = {
      name: 'u.name',
      registered_at: 'u.registered_at',
      last_login: 'COALESCE(u.updated_at, u.registered_at)',
      role: 'u.role',
      phone: 'u.phone',
    };
    const sortField = allowedSortFields[sortBy] || allowedSortFields[USER_CONFIG.SEARCH.DEFAULT_SORT_BY];
    const order = sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const [users, countRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          u.uid, u.id, u.phone, u.name, u.email, u.role, u.gender,
          u.registered_at,
          COALESCE(u.updated_at, u.registered_at) AS last_login,
          u.address, u.profile_picture,
          CASE
            WHEN s.is_active IS NOT NULL THEN s.is_active
            WHEN d.is_available IS NOT NULL THEN d.is_available
            ELSE true
          END AS is_active,
          COALESCE(s.department, d.department) AS department,
          d.specialty AS specialization
        FROM users u
        LEFT JOIN staff s ON u.uid = s.user_id
        LEFT JOIN doctors d ON u.id = d.user_id
        ${whereClause}
        ORDER BY ${Prisma.raw(sortField)} ${Prisma.raw(order)}
        LIMIT ${parsedLimit} OFFSET ${offset}
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM users u
        LEFT JOIN staff s ON u.uid = s.user_id
        LEFT JOIN doctors d ON u.id = d.user_id
        ${whereClause}
      `,
    ]);

    const totalCount = countRows[0]?.count || 0;

    return {
      users,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / parsedLimit),
        hasNext: parsedPage * parsedLimit < totalCount,
        hasPrev: parsedPage > 1,
      },
    };
  }

  // Get user by ID, UID, or phone (E.164). Patient app's /users/:phone
  // route hits this endpoint with `+91…` strings — those aren't UUIDs
  // and aren't numeric IDs, so we treat anything starting with `+` (or
  // matching the bare 10-digit Indian phone form) as a phone lookup.
  static async getUserById(identifier, userRole) {
    const id = String(identifier);
    const looksLikePhone = id.startsWith('+') || /^\d{10}$/.test(id);
    const isNumericId = /^\d+$/.test(id) && !looksLikePhone;
    let identifierCondition;
    if (isNumericId) {
      identifierCondition = Prisma.sql`u.id = ${parseInt(id, 10)}`;
    } else if (looksLikePhone) {
      const normalizedPhone = normalizePhone(id);
      const nationalPhone = normalizedPhone?.startsWith('+91')
        ? normalizedPhone.slice(3)
        : id.replace(/[^\d]/g, '');
      identifierCondition = Prisma.sql`u.phone IN (${normalizedPhone}, ${nationalPhone})`;
    } else {
      identifierCondition = Prisma.sql`u.uid = ${id}::uuid`;
    }

    const result = await prisma.$queryRaw`
      SELECT
        u.*,
        COALESCE(u.updated_at, u.registered_at) AS last_login,
        NULL::jsonb AS emergency_contact,
        NULL::text AS blood_group,
        NULL::text AS allergies,
        NULL::jsonb AS insurance_details,
        NULL::text AS preferred_hospital,
        d.department AS doctor_department,
        d.specialty AS specialization,
        s.department AS staff_department,
        s.shift
      FROM users u
      LEFT JOIN doctors d ON u.id = d.user_id
      LEFT JOIN staff s ON u.uid = s.user_id
      WHERE ${identifierCondition}
    `;

    if (result.length === 0) {
      return null;
    }

    const user = result[0];
    return applyPrivacyFilters(user, userRole);
  }

  // Update user
  static async updateUser(identifier, updateData, updatedBy) {
    const user = await this.getUserById(identifier, USER_CONFIG.ROLES.ADMIN);

    if (!user) {
      throw new Error('User not found');
    }

    const allowedFields = [
      'name',
      'email',
      'gender',
      'birthday',
      'anniversary',
      'address',
      'emergency_contact',
      'profile_picture',
      'blood_group',
      'allergies',
      'insurance_details',
      'preferred_hospital',
    ];

    const setClauses = [];

    for (const field of allowedFields) {
      if (updateData[field] !== undefined && PROFILE_FIELDS_IN_SCHEMA.includes(field)) {
        const value = coerceProfileField(field, updateData[field]);
        setClauses.push(PROFILE_DATE_FIELDS.has(field)
          ? Prisma.sql`${Prisma.raw(field)} = ${value}::date`
          : Prisma.sql`${Prisma.raw(field)} = ${value}`);
      }
    }

    if (setClauses.length === 0) {
      return user;
    }

    const result = await prisma.$queryRaw`
      UPDATE users
      SET ${Prisma.join([...setClauses, Prisma.sql`updated_at = NOW()`], ', ')}
      WHERE uid = ${user.uid}::uuid
      RETURNING
        id, uid, phone, name, email, role,
        registered_at AS created_at,
        updated_at
    `;

    logger.info(`User updated: ${user.uid} by ${updatedBy}`);

    return {
      ...result[0],
      status: user.is_active ? USER_CONFIG.USER_STATUS.ACTIVE : USER_CONFIG.USER_STATUS.INACTIVE,
    };
  }

  // Change user status
  static async changeUserStatus(identifier, status, reason, changedBy) {
    const user = await this.getUserById(identifier, USER_CONFIG.ROLES.ADMIN);

    if (!user) {
      throw new Error('User not found');
    }

    const isActive = status === USER_CONFIG.USER_STATUS.ACTIVE;
    await prisma.$executeRaw`
      UPDATE users
      SET is_active = ${isActive},
          status = ${status},
          updated_at = NOW()
      WHERE uid = ${user.uid}::uuid
    `;

    if (['NURSE', 'PHARMACY_STAFF', 'LAB_STAFF', 'RECEPTIONIST'].includes(user.role)) {
      await prisma.staff.updateMany({
        where: { user_id: user.uid },
        data: {
          is_active: isActive,
          ...(reason !== undefined ? { notes: reason } : {}),
        },
      });
    } else if (user.role === USER_CONFIG.ROLES.DOCTOR) {
      await prisma.doctors.updateMany({
        where: { user_id: user.id },
        data: {
          is_available: isActive,
        },
      });
    }

    await prisma.audit_logs.create({
      data: {
        uid: user.uid,
        role: user.role,
        action: 'USER_STATUS_CHANGE',
        resource: 'users',
        resource_id: user.uid,
        metadata: { status, reason, changedBy },
      },
    });

    logger.info(`User status changed: ${user.uid} to ${status} by ${changedBy}`);

    return { ...user, is_active: isActive, status };
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
      limit = USER_CONFIG.DEFAULT_PAGE_SIZE,
    } = searchCriteria;

    const parsedPage = parseInt(page, 10);
    const parsedLimit = Math.min(parseInt(limit, 10) || USER_CONFIG.DEFAULT_PAGE_SIZE, USER_CONFIG.MAX_SEARCH_RESULTS);
    const offset = (parsedPage - 1) * parsedLimit;
    const conditions = [];

    if (searchQuery) {
      const term = `%${searchQuery}%`;
      conditions.push(Prisma.sql`(
        u.name ILIKE ${term} OR
        u.phone ILIKE ${term} OR
        u.email ILIKE ${term}
      )`);
    }

    if (role) {
      conditions.push(Prisma.sql`u.role = ${role.toUpperCase()}`);
    }

    if (department) {
      conditions.push(Prisma.sql`d.department ILIKE ${`%${department}%`}`);
    }

    if (registeredAfter) {
      conditions.push(Prisma.sql`u.registered_at >= ${registeredAfter}::timestamp`);
    }

    if (registeredBefore) {
      conditions.push(Prisma.sql`u.registered_at <= ${registeredBefore}::timestamp`);
    }

    if (lastLoginAfter) {
      conditions.push(Prisma.sql`COALESCE(u.updated_at, u.registered_at) >= ${lastLoginAfter}::timestamp`);
    }

    if (ageMin !== undefined) {
      conditions.push(Prisma.sql`EXTRACT(YEAR FROM AGE(u.birthday)) >= ${parseInt(ageMin, 10)}`);
    }

    if (ageMax !== undefined) {
      conditions.push(Prisma.sql`EXTRACT(YEAR FROM AGE(u.birthday)) <= ${parseInt(ageMax, 10)}`);
    }

    if (hasProfilePicture !== undefined) {
      conditions.push(
        hasProfilePicture
          ? Prisma.sql`u.profile_picture IS NOT NULL`
          : Prisma.sql`u.profile_picture IS NULL`
      );
    }

    if (!includeInactive) {
      conditions.push(Prisma.sql`COALESCE(u.updated_at, u.registered_at) > NOW() - INTERVAL '30 days'`);
    }

    if (userRole !== USER_CONFIG.ROLES.ADMIN) {
      conditions.push(Prisma.sql`u.role != ${USER_CONFIG.ROLES.ADMIN}`);
    }

    const whereClause = conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;

    const result = await prisma.$queryRaw`
      SELECT
        u.uid, u.id, u.phone, u.name, u.email, u.role, u.gender,
        u.registered_at,
        COALESCE(u.updated_at, u.registered_at) AS last_login,
        u.birthday, u.profile_picture,
        EXTRACT(YEAR FROM AGE(u.birthday)) AS age,
        d.department,
        d.specialty AS specialization
      FROM users u
      LEFT JOIN doctors d ON u.id = d.user_id
      ${whereClause}
      ORDER BY u.registered_at DESC
      LIMIT ${parsedLimit} OFFSET ${offset}
    `;

    const filteredResults = result.map((user) => {
      if (userRole !== USER_CONFIG.ROLES.ADMIN) {
        delete user.birthday;
        delete user.age;
        if (!['DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
          user.phone = user.phone
            ? user.phone.slice(0, -USER_CONFIG.PRIVACY.PHONE_MASK_LENGTH) + '****'
            : null;
        }
      }
      return user;
    });

    return {
      users: filteredResults,
      totalFound: filteredResults.length,
      searchCriteria,
    };
  }

  // Bulk import users
  static async bulkImportUsers(usersData, importedBy) {
    if (usersData.length > USER_CONFIG.MAX_BULK_IMPORT) {
      throw new Error(`Cannot import more than ${USER_CONFIG.MAX_BULK_IMPORT} users at once`);
    }

    const results = {
      successful: [],
      failed: [],
    };

    for (const userData of usersData) {
      try {
        const result = await this.createOrUpdateProfile(userData, importedBy);
        results.successful.push({
          phone: userData.phone,
          name: userData.name,
          status: result.isNew ? 'created' : 'updated',
        });
      } catch (error) {
        results.failed.push({
          phone: userData.phone,
          name: userData.name,
          error: error.message,
        });
      }
    }

    logger.info(`Bulk import completed: ${results.successful.length} successful, ${results.failed.length} failed`);

    return results;
  }
}
