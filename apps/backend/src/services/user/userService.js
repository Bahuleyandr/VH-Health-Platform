import { Prisma } from '@prisma/client';
import { USER_CONFIG } from '../../config/userConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { encryptColumn, searchableHash } from '../../services/security/phiColumnEncryption.js';

const USER_SELECT = {
  id: true,
  uid: true,
  phone: true,
  name: true,
  email: true,
  role: true,
  is_active: true,
  registered_at: true,
  updated_at: true
};

const PROFILE_FIELDS_IN_SCHEMA = [
  'name',
  'email',
  'gender',
  'birthday',
  'anniversary',
  'address',
  'profile_picture',
  // Phase 0.5: clinical PHI fields the users table actually has.
  // Previously omitted here, so updateUser silently dropped them while
  // returning HTTP 200 — see finding
  // 2026-05-08-walk-in-opd-receptionist-blood-group-silently-dropped.
  'blood_group',
  'allergies',
  'medical_history',
  'emergency_contact',
  // E-9 — guardian fields for paediatric / minor patients (migration 189).
  // Walk-in registration sets them; later updates flow through here.
  'guardian_name',
  'guardian_phone',
  'guardian_relationship'
];
const PROFILE_DATE_FIELDS = new Set(['birthday', 'anniversary']);
const PROFILE_JSON_FIELDS = new Set(['emergency_contact']);

function coerceProfileField(field, value) {
  if (PROFILE_DATE_FIELDS.has(field)) {
    if (value === null || value === undefined) return value;
    if (value instanceof Date) return value;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Date(`${value}T00:00:00.000Z`);
    }
    return new Date(value);
  }
  if (PROFILE_JSON_FIELDS.has(field)) {
    if (value === null || value === undefined) return value;
    // Pre-stringify JSON so the raw-SQL ::jsonb cast has a text payload
    // to coerce. If the caller passed a string we trust it's already JSON.
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return value;
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
    updated_at: user.updated_at
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
      ...params
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
        select: { uid: true, role: true }
      });

      if (existingUser) {
        const updateData = {
          ...buildProfileUpdateData(data),
          updated_at: new Date()
        };

        const updatedUser = await prisma.users.update({
          where: { phone },
          data: updateData,
          select: USER_SELECT
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
          updated_at: new Date()
        },
        select: USER_SELECT
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
    const allowedSortFields = {
      name: 'u.name',
      registered_at: 'u.registered_at',
      last_login: 'COALESCE(u.updated_at, u.registered_at)',
      role: 'u.role',
      phone: 'u.phone',
      email: 'u.email',
      department: 'COALESCE(s.department, d.department)',
      status: `CASE
        WHEN s.is_active IS NOT NULL THEN s.is_active
        WHEN d.is_available IS NOT NULL THEN d.is_available
        ELSE true
      END`
    };

    const {
      role,
      status,
      department,
      phone,
    } = filters;
    const { page, limit, offset, search, sortBy, sortOrder } = parseListQuery(filters, {
      defaultLimit: USER_CONFIG.DEFAULT_PAGE_SIZE,
      maxLimit: USER_CONFIG.MAX_PAGE_SIZE,
      defaultSortBy: USER_CONFIG.SEARCH.DEFAULT_SORT_BY,
      defaultSortOrder: USER_CONFIG.SEARCH.DEFAULT_SORT_ORDER,
      allowedSortFields: Object.keys(allowedSortFields),
    });

    const conditions = [];

    if (role) {
      const upper = role.toUpperCase();
      // For DOCTOR, accept either users.role='DOCTOR' OR a present, active
      // doctors row. Some seeded clinicians have users.role='PATIENT' with
      // their actual identity in the `doctors` table — without this branch
      // the receptionist's `/users?role=DOCTOR` lookup omits most of the
      // active roster, breaking paediatric/ANC handoff. Finding:
      // 2026-05-09-pediatric-opd-receptionist-no-paediatric-doctor-in-users-api.
      if (upper === 'DOCTOR') {
        conditions.push(Prisma.sql`(u.role = 'DOCTOR' OR (d.id IS NOT NULL AND d.is_active = true))`);
      } else {
        conditions.push(Prisma.sql`u.role = ${upper}`);
      }
    }

    // Receptionist duplicate-detection lookup. Match both the E.164 form
    // (`+91…`) and the bare 10-digit national form so callers can pass
    // either. Previously this param was silently dropped — see finding
    // 2026-05-08-follow-up-opd-receptionist-users-phone-filter-ignored.
    if (phone) {
      const trimmed = String(phone).trim();
      const normalized = normalizePhone(trimmed);
      const national = normalized?.startsWith('+91')
        ? normalized.slice(3)
        : trimmed.replace(/[^\d]/g, '');
      const candidates = [trimmed];
      if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
      if (national && !candidates.includes(national)) candidates.push(national);
      conditions.push(Prisma.sql`(
        u.phone IN (${Prisma.join(candidates)})
        OR u.guardian_phone IN (${Prisma.join(candidates)})
      )`);
    }

    if (search) {
      const searchTerm = `%${search}%`;
      conditions.push(Prisma.sql`(
        u.name ILIKE ${searchTerm} OR
        u.phone ILIKE ${searchTerm} OR
        u.guardian_phone ILIKE ${searchTerm} OR
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

    const sortField = allowedSortFields[sortBy] || allowedSortFields[USER_CONFIG.SEARCH.DEFAULT_SORT_BY];

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
        ORDER BY ${Prisma.raw(sortField)} ${Prisma.raw(sortOrder)}
        LIMIT ${limit} OFFSET ${offset}
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM users u
        LEFT JOIN staff s ON u.uid = s.user_id
        LEFT JOIN doctors d ON u.id = d.user_id
        ${whereClause}
      `
    ]);

    const totalCount = countRows[0]?.count || 0;

    return {
      users,
      pagination: buildPagination(totalCount, page, limit),
      filters: {
        ...filters,
        search: search || null,
        sortBy,
        sortOrder,
      }
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

    // `u.*` already exposes the real `emergency_contact / blood_group /
    // allergies` columns. The dead `insurance_details` /
    // `preferred_hospital` names don't exist on the table but some clients
    // still expect them in the payload; keep the hardcoded NULL casts only
    // for those two so we don't break the response shape.
    const result = await prisma.$queryRaw`
      SELECT
        u.*,
        COALESCE(hn.identifier_value, 'VH-' || LPAD(u.id::text, 6, '0')) AS hospital_number,
        COALESCE(u.updated_at, u.registered_at) AS last_login,
        NULL::jsonb AS insurance_details,
        NULL::text AS preferred_hospital,
        d.department AS doctor_department,
        d.specialty AS specialization,
        s.department AS staff_department,
        s.shift
      FROM users u
      LEFT JOIN LATERAL (
        SELECT pi.identifier_value
        FROM patient_identifiers pi
        WHERE pi.tenant_id = u.tenant_id
          AND pi.patient_uid = u.uid
          AND pi.identifier_type IN ('mrn', 'uhid')
          AND pi.status = 'active'
        ORDER BY pi.is_primary DESC,
          CASE pi.identifier_type WHEN 'mrn' THEN 0 WHEN 'uhid' THEN 1 ELSE 2 END,
          pi.created_at ASC
        LIMIT 1
      ) hn ON TRUE
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

    // Single source of truth: only fields confirmed present on `users`. Two
    // dead names (`insurance_details`, `preferred_hospital`) were previously
    // listed and silently dropped — they don't exist on the table.
    const allowedFields = PROFILE_FIELDS_IN_SCHEMA;

    const setClauses = [];

    for (const field of allowedFields) {
      if (updateData[field] === undefined) continue;
      const value = coerceProfileField(field, updateData[field]);
      if (PROFILE_DATE_FIELDS.has(field)) {
        setClauses.push(Prisma.sql`${Prisma.raw(field)} = ${value}::date`);
      } else if (PROFILE_JSON_FIELDS.has(field)) {
        setClauses.push(Prisma.sql`${Prisma.raw(field)} = ${value}::jsonb`);
      } else {
        setClauses.push(Prisma.sql`${Prisma.raw(field)} = ${value}`);
      }
    }

    if (setClauses.length === 0) {
      return user;
    }

    // RETURNING includes the profile + clinical PHI fields the caller may
    // have just SET so the response is self-verifying. Before this list was
    // extended, callers received HTTP 200 with no signal that blood_group /
    // emergency_contact / allergies had been silently dropped — see finding
    // 2026-05-08-walk-in-opd-receptionist-blood-group-silently-dropped.
    // Sensitive credential columns (encrypted_password, pwd, pin_hash) are
    // intentionally excluded per the no-SELECT-* convention.
    const result = await prisma.$queryRaw`
      UPDATE users
      SET ${Prisma.join([...setClauses, Prisma.sql`updated_at = NOW()`], ', ')}
      WHERE uid = ${user.uid}::uuid
      RETURNING
        id, uid, phone, name, email, role,
        gender, birthday, anniversary, address, profile_picture,
        blood_group, allergies, medical_history, emergency_contact,
        guardian_name, guardian_phone, guardian_relationship,
        registered_at AS created_at,
        updated_at
    `;

    logger.info(`User updated: ${user.uid} by ${updatedBy}`);

    return {
      ...result[0],
      status: user.is_active ? USER_CONFIG.USER_STATUS.ACTIVE : USER_CONFIG.USER_STATUS.INACTIVE
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
          ...(reason !== undefined ? { notes: reason } : {})
        }
      });
    } else if (user.role === USER_CONFIG.ROLES.DOCTOR) {
      await prisma.doctors.updateMany({
        where: { user_id: user.id },
        data: {
          is_available: isActive
        }
      });
    }

    await prisma.audit_logs.create({
      data: {
        uid: user.uid,
        role: user.role,
        action: 'USER_STATUS_CHANGE',
        resource: 'users',
        resource_id: user.uid,
        metadata: { status, reason, changedBy }
      }
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
      limit = USER_CONFIG.DEFAULT_PAGE_SIZE
    } = searchCriteria;

    const parsedPage = parseInt(page, 10);
    const parsedLimit = Math.min(
      parseInt(limit, 10) || USER_CONFIG.DEFAULT_PAGE_SIZE,
      USER_CONFIG.MAX_SEARCH_RESULTS
    );
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
      conditions.push(
        Prisma.sql`COALESCE(u.updated_at, u.registered_at) >= ${lastLoginAfter}::timestamp`
      );
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
      conditions.push(
        Prisma.sql`COALESCE(u.updated_at, u.registered_at) > NOW() - INTERVAL '30 days'`
      );
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

    const filteredResults = result.map(user => {
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

    logger.info(
      `Bulk import completed: ${results.successful.length} successful, ${results.failed.length} failed`
    );

    return results;
  }
}
