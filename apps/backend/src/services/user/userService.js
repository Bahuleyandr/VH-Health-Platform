import { Prisma } from '@prisma/client';
import { USER_CONFIG } from '../../config/userConfig.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { maskPhoneForLog } from '../../utils/logMasking.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import admin from '../../utils/firebaseAdmin.js';
import { AppError } from '../../utils/AppError.js';
import {
  persistRevokeAllUserTokens as persistIdentityRevocation,
  publishRevokeAllUserTokens,
} from '../../utils/tokenBlacklist.js';
import * as tokenBlacklist from '../../utils/tokenBlacklist.js';
import { encryptColumn, searchableHash } from '../../services/security/phiColumnEncryption.js';

if (
  process.env.NODE_ENV !== 'test'
  && typeof tokenBlacklist.withAuthIdentityLifecycleLocks !== 'function'
) {
  throw new Error('Auth identity lifecycle locking is unavailable');
}
const withAuthIdentityLifecycleLocks = tokenBlacklist.withAuthIdentityLifecycleLocks
  ?? ((_client, _uids, fn) => fn(_client));

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
const FRESH_REAUTH_MAX_AGE_SECONDS = 5 * 60;

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

function normalizeRoleForDeletion(role) {
  return String(role || '')
    .trim()
    .toUpperCase();
}

function normalizeClientIp(value) {
  const first = String(value || '')
    .split(',')[0]
    .trim();
  return /^[0-9a-f:.]+$/i.test(first) ? first : null;
}

function hasIdentityValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

async function verifyFreshFirebaseReauthToken(firebaseIdToken, user, { now = new Date() } = {}) {
  if (!firebaseIdToken || typeof firebaseIdToken !== 'string') {
    throw AppError.badRequest(
      'Fresh OTP re-authentication token is required',
      'FRESH_REAUTH_REQUIRED'
    );
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(firebaseIdToken, true);
  } catch {
    throw AppError.unauthorized('Fresh OTP re-authentication failed', 'FRESH_REAUTH_INVALID');
  }

  const tokenFirebaseUid = decodedToken?.uid || null;
  const tokenPhone = decodedToken?.phone_number ? normalizePhone(decodedToken.phone_number) : null;
  const userPhone = user?.phone ? normalizePhone(user.phone) : null;
  const firebaseUidMatches =
    hasIdentityValue(user?.firebase_uid) && tokenFirebaseUid === user.firebase_uid;
  const phoneMatches = hasIdentityValue(userPhone) && tokenPhone === userPhone;

  if (hasIdentityValue(user?.firebase_uid) ? !firebaseUidMatches : !phoneMatches) {
    throw AppError.forbidden(
      'Fresh OTP token does not match this account',
      'FRESH_REAUTH_ACCOUNT_MISMATCH'
    );
  }

  const authTime = Number(decodedToken?.auth_time);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !Number.isFinite(authTime) ||
    authTime > nowSeconds + 60 ||
    nowSeconds - authTime > FRESH_REAUTH_MAX_AGE_SECONDS
  ) {
    throw AppError.unauthorized('Fresh OTP re-authentication has expired', 'FRESH_REAUTH_EXPIRED');
  }

  return decodedToken;
}

async function revokeFirebaseRefreshTokens(firebaseUid) {
  if (!firebaseUid) return;
  try {
    await admin.auth().revokeRefreshTokens(firebaseUid);
  } catch (err) {
    logger.warn('Firebase refresh-token revocation failed during account deletion', {
      firebaseUid,
      error: err?.message
    });
  }
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
  static async createOrUpdateProfile(data, createdBy, opts = {}) {
    const isPrivilegedActor = !!opts.isPrivilegedActor;
    const phone = normalizePhone(data.phone || data.phoneNumber);

    try {
      // phone is unique per-tenant now (mig 333: @@unique([tenant_id, phone])),
      // so findUnique/update keyed on phone alone are invalid. findFirst to
      // locate, then update by the unique uid.
      //
      // CAN-001/CAN-002: self-service identity is bound by the controller from
      // the verified token (req.user) — `phone` here is the caller's own (or,
      // for a privileged actor, an explicitly targeted) number. Fall back to
      // the caller's uid when a self-service token is uid-only; never resolve a
      // body phone we were not handed.
      let existingUser = null;
      if (!isPrivilegedActor && opts.callerUid) {
        // HEAD-002 / CAN-001/CAN-002: a self-service write is bound to the verified
        // token uid and NEVER resolves a caller-supplied body phone — a uid-only
        // token (e.g. staff password login, no phone claim) could otherwise submit
        // another user's phone and overwrite that user's row.
        existingUser = await prisma.users.findFirst({
          where: { uid: opts.callerUid },
          select: { uid: true, role: true }
        });
      } else if (phone) {
        // Privileged actor (admin / registration) may target a user by phone.
        existingUser = await prisma.users.findFirst({
          where: { phone },
          select: { uid: true, role: true }
        });
      }

      if (existingUser) {
        const updateData = {
          ...buildProfileUpdateData(data),
          updated_at: new Date()
        };

        const updatedUser = await prisma.users.update({
          where: { uid: existingUser.uid },
          data: updateData,
          select: USER_SELECT
        });

        // Phase E3 follow-up — write the *_encrypted shadow columns.
        await writePhiShadows(updatedUser.id, data);

        logger.info(`User profile updated: ${maskPhoneForLog(phone)} by ${createdBy}`);
        return { user: mapUserSummary(updatedUser), isNew: false };
      }

      if (!phone) {
        // Self-service create with no resolvable identity phone — refuse rather
        // than insert a row with a null/forged phone.
        throw new Error('Cannot create profile without a phone number');
      }

// A bare `prisma.$transaction` hands back the raw itx client, which skips the
// prisma proxy's tenant wrapper — so `app.current_tenant_id` stays unset for
// every statement inside it. `public.users` carries the RESTRICTIVE
// `explicit_tenant_context_753` policy (migration 758) whose WITH CHECK
// requires that GUC, so an unscoped insert is rejected 42501 rather than
// filed anywhere. Scope the transaction when a tenant is in ambient context;
// callers with none (scripts, the pre-auth realm) keep the previous shape.
      const ambientTenantId = getCurrentTenantId();
      const runIdentityCreate = (fn) => (ambientTenantId
        ? setTenantTx(ambientTenantId, fn)
        : prisma.$transaction(fn));

      const createdUser = await runIdentityCreate(async (tx) => {
        const identity = await tx.users.create({
          data: {
            phone,
            ...buildProfileUpdateData(data),
            // CAN-001: role is NEVER taken from the request body for self-service.
            // Only a privileged actor (admin/super-admin) may set a non-default
            // role here; every other caller is forced to PATIENT.
            role: isPrivilegedActor
              ? data.role || USER_CONFIG.ROLES.PATIENT
              : USER_CONFIG.ROLES.PATIENT,
            registered_at: new Date(),
            updated_at: new Date()
          },
          select: USER_SELECT
        });
        await withAuthIdentityLifecycleLocks(tx, [identity.uid], async () => identity);
        return identity;
      });

      // Phase E3 follow-up — write encrypted shadows + phone_search_hash.
      await writePhiShadows(createdUser.id, { ...data, phone }, { isCreate: true });

      logger.info(`New user created: ${maskPhoneForLog(phone)} by ${createdBy}`);
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

    const { role, status, department, phone } = filters;
    const { page, limit, offset, search, sortBy, sortOrder } = parseListQuery(filters, {
      defaultLimit: USER_CONFIG.DEFAULT_PAGE_SIZE,
      maxLimit: USER_CONFIG.MAX_PAGE_SIZE,
      defaultSortBy: USER_CONFIG.SEARCH.DEFAULT_SORT_BY,
      defaultSortOrder: USER_CONFIG.SEARCH.DEFAULT_SORT_ORDER,
      allowedSortFields: Object.keys(allowedSortFields)
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
        conditions.push(
          Prisma.sql`(u.role = 'DOCTOR' OR (d.id IS NOT NULL AND d.is_active = true))`
        );
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

    const sortField =
      allowedSortFields[sortBy] || allowedSortFields[USER_CONFIG.SEARCH.DEFAULT_SORT_BY];

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
      // CAN-055: mask PII for non-admin callers (phone for non-DOCTOR/NURSING,
      // address/emergency_contact for everyone non-admin) — same policy the
      // single-user reads use, applied here so the directory list cannot leak
      // unmasked PII to broad staff roles.
      users: users.map(u => applyPrivacyFilters(u, userRole)),
      pagination: buildPagination(totalCount, page, limit),
      filters: {
        ...filters,
        search: search || null,
        sortBy,
        sortOrder
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
    if (!user.tenant_id) {
      throw new Error('User status change requires a tenant-bound identity');
    }
    const revokedAt = await setTenantTx(String(user.tenant_id), async (tx) => {
      await withAuthIdentityLifecycleLocks(tx, [user.uid], async () => {});
      const updated = await tx.$executeRaw`
        UPDATE users
        SET is_active = ${isActive},
            status = ${status},
            updated_at = NOW()
        WHERE uid = ${user.uid}::uuid
          AND tenant_id = ${user.tenant_id}::uuid
      `;
      if (Number(updated) !== 1) throw new Error('User status change did not update the identity');

      if (['NURSE', 'PHARMACY_STAFF', 'LAB_STAFF', 'RECEPTIONIST'].includes(user.role)) {
        await tx.staff.updateMany({
          where: { user_id: user.uid },
          data: {
            is_active: isActive,
            ...(reason !== undefined ? { notes: reason } : {})
          }
        });
      } else if (user.role === USER_CONFIG.ROLES.DOCTOR) {
        await tx.doctors.updateMany({
          where: { user_id: user.id },
          data: {
            is_available: isActive
          }
        });
      }

      await tx.audit_logs.create({
        data: {
          uid: user.uid,
          role: user.role,
          action: 'USER_STATUS_CHANGE',
          resource: 'users',
          resource_id: user.uid,
          metadata: { status, reason, changedBy }
        }
      });

      if (isActive) return null;
      return persistIdentityRevocation(user.uid, {
        client: tx,
        requireEvidence: true,
        reason: 'user_deactivated',
        notificationTenantId: String(user.tenant_id),
      });
    });

    if (revokedAt != null && Number.isFinite(Number(revokedAt))) {
      await publishRevokeAllUserTokens(user.uid, revokedAt, { reason: 'user_deactivated' });
    }

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

  static async deleteOwnAccount({
    user: requestUser,
    firebaseIdToken,
    requestId = null,
    ipAddress = null,
    userAgent = null,
    reason = 'patient_self_service',
    now = new Date(),
    verifyFreshReauth = verifyFreshFirebaseReauthToken
  } = {}) {
    const callerUid = requestUser?.uid;
    if (!callerUid) {
      throw AppError.unauthorized(
        'Authenticated patient is required',
        'AUTHENTICATED_PATIENT_REQUIRED'
      );
    }

    const role = normalizeRoleForDeletion(requestUser?.role);
    if (role !== USER_CONFIG.ROLES.PATIENT) {
      throw AppError.forbidden(
        'Only patients can delete their own account through self-service',
        'ACCOUNT_DELETE_PATIENT_ONLY'
      );
    }

    if (requestUser?.acting || requestUser?.actingAsUid) {
      throw AppError.forbidden(
        'Dependent acting-as sessions cannot delete accounts',
        'ACCOUNT_DELETE_ACTING_AS_NOT_ALLOWED'
      );
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, tenant_id, phone, name, email, address, role, is_active,
              status, firebase_uid, COALESCE(is_deleted, false) AS is_deleted,
              deleted_at, phone_search_hash
         FROM users
        WHERE uid = $1::uuid
        LIMIT 1`,
      callerUid
    );
    const user = rows[0];
    if (!user) {
      throw AppError.notFound('User account not found', 'ACCOUNT_NOT_FOUND');
    }
    if (user.is_deleted || String(user.status || '').toLowerCase() === 'deleted') {
      throw AppError.conflict('Account is already deleted', 'ACCOUNT_ALREADY_DELETED');
    }

    const decodedReauth = await verifyFreshReauth(firebaseIdToken, user, { now });
    const tombstoneFirebaseUid = user.firebase_uid || decodedReauth?.uid || null;

    const admissionRows = await prisma.$queryRawUnsafe(
      `SELECT id, status
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND discharged_at IS NULL
          AND LOWER(COALESCE(status, 'admitted')) IN (
            'active',
            'admitted',
            'bed_assigned',
            'discharge_initiated',
            'discharge_pending',
            'pending_discharge',
            'transferred'
          )
        LIMIT 1`,
      user.tenant_id,
      user.uid
    );
    if (admissionRows.length > 0) {
      throw AppError.conflict(
        'Cannot delete account while an active admission is open',
        'ACTIVE_ADMISSION_BLOCKS_ACCOUNT_DELETION',
        {
          admissionId: admissionRows[0].id,
          status: admissionRows[0].status || 'admitted'
        }
      );
    }

    const beforeState = {
      hadPhone: hasIdentityValue(user.phone),
      hadName: hasIdentityValue(user.name),
      hadEmail: hasIdentityValue(user.email),
      hadAddress: hasIdentityValue(user.address),
      hadPhoneSearchHash: hasIdentityValue(user.phone_search_hash),
      activeAdmissionChecked: true
    };
    const afterState = {
      is_deleted: true,
      status: 'deleted',
      direct_identity_fields_cleared: true,
      clinical_records_retained: true
    };
    const metadata = {
      reason,
      retention_basis:
        'DPDP data minimization plus medical-record, audit, safety, and billing retention',
      firebase_refresh_revoke_attempted: Boolean(tombstoneFirebaseUid),
      local_sessions_revoked: true
    };
    const sanitizedIp = normalizeClientIp(ipAddress);
    const idempotencyKey = `patient-account-deletion:${user.uid}`;

    const revokedAt = await setTenantTx(user.tenant_id, async tx => {
      await withAuthIdentityLifecycleLocks(tx, [user.uid], async () => {});
      await tx.$executeRawUnsafe(
        `UPDATE user_devices
            SET fcm_token = NULL,
                updated_at = NOW(),
                last_active = NOW()
          WHERE user_uid = $1::uuid
            AND tenant_id = $2::uuid`,
        user.uid,
        user.tenant_id
      );

      await tx.$executeRawUnsafe(
        `UPDATE users
            SET phone = NULL,
                name = NULL,
                address = NULL,
                email = NULL,
                phone_search_hash = NULL,
                phone_encrypted = NULL,
                name_encrypted = NULL,
                address_encrypted = NULL,
                device_token = NULL,
                profile_picture = NULL,
                emergency_contact = NULL,
                guardian_name = NULL,
                guardian_phone = NULL,
                guardian_relationship = NULL,
                guardian_id_type = NULL,
                guardian_id_reference = NULL,
                pan_number = NULL,
                abha_address = NULL,
                abha_number = NULL,
                is_active = FALSE,
                is_deleted = TRUE,
                deleted_at = NOW(),
                deleted_reason = $2,
                status = 'deleted',
                status_reason = $2,
                status_updated_at = NOW(),
                status_updated_by = $1::uuid,
                firebase_tokens_revoked_at = NOW(),
                firebase_uid = COALESCE(firebase_uid, $3),
                updated_at = NOW()
          WHERE uid = $1::uuid
            AND COALESCE(is_deleted, FALSE) = FALSE`,
        user.uid,
        reason,
        tombstoneFirebaseUid
      );

      await tx.$executeRawUnsafe(
        `INSERT INTO clinical_audit_events (
           tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
           resource_type, resource_table, resource_id, request_id, ip_address,
           user_agent, before_state, after_state, metadata, idempotency_key,
           occurred_at, created_at
         )
         VALUES (
           $1::uuid, $2::uuid, 'PATIENT_ACCOUNT_DELETED', 'success',
           $2::uuid, 'PATIENT', 'USER_ACCOUNT', 'users', $2::text,
           $3, $4::inet, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9,
           NOW(), NOW()
         )
         ON CONFLICT (idempotency_key) WHERE (idempotency_key IS NOT NULL) DO NOTHING`,
        user.tenant_id,
        user.uid,
        requestId,
        sanitizedIp,
        userAgent,
        JSON.stringify(beforeState),
        JSON.stringify(afterState),
        JSON.stringify(metadata),
        idempotencyKey
      );

      return persistIdentityRevocation(user.uid, {
        client: tx,
        requireEvidence: true,
        reason: 'account_deleted'
      });
    });

    try {
      await publishRevokeAllUserTokens(user.uid, revokedAt, { reason: 'account_deleted' });
    } catch (err) {
      logger.warn('Account-deletion session:revoked push failed', {
        uid: user.uid,
        error: err?.message
      });
    }
    await revokeFirebaseRefreshTokens(tombstoneFirebaseUid);

    logger.info('Patient account deleted via self-service', {
      uid: user.uid,
      tenantId: user.tenant_id,
      requestId
    });

    return {
      uid: user.uid,
      deleted: true,
      clinicalRecordsRetained: true
    };
  }

  // Get users by role
  static async getUsersByRole(role, filters = {}, callerRole = USER_CONFIG.ROLES.ADMIN) {
    const normalizedRole = role.toUpperCase();

    if (!Object.values(USER_CONFIG.ROLES).includes(normalizedRole)) {
      throw new Error('Invalid role specified');
    }

    // CAN-055: pass the caller's REAL role so listUsers' privacy masking applies
    // (previously hardcoded ADMIN, which bypassed masking for non-admin callers).
    return this.listUsers({ ...filters, role: normalizedRole }, callerRole);
  }

  // Get users by department
  static async getUsersByDepartment(
    department,
    filters = {},
    callerRole = USER_CONFIG.ROLES.ADMIN
  ) {
    return this.listUsers({ ...filters, department }, callerRole);
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
