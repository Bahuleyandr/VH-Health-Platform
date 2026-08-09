// src/services/auth/firebaseAuthService.js - Firebase Authentication Service

import { AUTH_ACTIONS } from '../../config/authConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { maskPhoneForLog } from '../../utils/logMasking.js';
import admin from '../../utils/firebaseAdmin.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { OTPService } from '../otpService.js';
import { ensureHospitalNumber } from '../patient/patientIdentifierService.js';
import { DEFAULT_TENANT_ID, resolveTenantForRequest } from '../tenant/tenantService.js';
import { issueAccessTokenAndClaimSession, generateRefreshToken } from './loginSessionHelper.js';

// Local pg-shape shim: returns the raw `rows` array directly for any
// query that produces rows (SELECT / WITH / `… RETURNING …`), so call
// sites can use array semantics (`result.length`, `result[0]`).
//
// Earlier this returned `{ rows, rowCount }` which mixed object and
// array-like access patterns across the file — half the callers used
// `result.rows[0]`, the other half `result[0]` / `result.length`.
// The latter group silently failed (object has no `length`), which
// was the root cause of the new-user signup flow being broken at
// completeUserProfile + linkFirebaseAccount.
const query = async (sql, params = [], client = prisma) => {
  const normalizedSql = sql.trim();
  const upperSql = normalizedSql.toUpperCase();
  const usesReturning = /\bRETURNING\b/i.test(normalizedSql);
  const isReadQuery = upperSql.startsWith('SELECT') || upperSql.startsWith('WITH') || usesReturning;

  if (isReadQuery) {
    const rows = await client.$queryRawUnsafe(normalizedSql, ...params);
    return Array.isArray(rows) ? rows : [];
  }

  await client.$executeRawUnsafe(normalizedSql, ...params);
  return [];
};

async function attachHospitalNumber(user) {
  if (!user?.uid || String(user.role || '').toUpperCase() !== 'PATIENT') return user;
  const hospitalNumber = await ensureHospitalNumber({
    tenantId: user.tenant_id || null,
    patientUid: user.uid,
    createdBy: user.uid
  });
  return { ...user, hospital_number: hospitalNumber };
}

// Authenticate with Firebase ID token
export const authenticateWithFirebase = async (idToken, deviceInfo, req, { deviceType } = {}) => {
  // Verify Firebase ID token
  const decodedToken = await admin.auth().verifyIdToken(idToken);

  const firebasePhone = decodedToken.phone_number;
  if (!firebasePhone) {
    const error = new Error('Phone number not found in Firebase token');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  const phone = normalizePhone(firebasePhone);
  const firebaseUid = decodedToken.uid;

  // SEC-5 / W4: resolve the tenant from the REQUEST before we look up identity.
  // This runs before tenantContextMiddleware (no req.user yet), so we derive the
  // tenant from the request HOST subdomain (trust-by-topology — client x-tenant-*
  // headers are not trusted), falling back to the single-tenant default for the
  // bare host. Scoping the lookup by tenant prevents a phone that exists in two
  // tenants from resolving arbitrarily and minting a JWT bound to the wrong tenant.
  const tenantId = await resolveTenantForRequest(req);

  // Check if user exists in our database — scoped to the resolved tenant.
  // Merged-away duplicate records sort last so a phone shared by a merged
  // record and its survivor resolves to the survivor.
  const userResult = await query(
    `SELECT id, uid, tenant_id, name, phone, email, role, firebase_uid,
            gender, email_verified, is_active, status, merged_into_uid,
            COALESCE(is_deleted, false) AS is_deleted,
            deleted_at, last_sign_in_at AS last_login
       FROM users
      WHERE tenant_id = $1::uuid
        AND (phone = $2 OR firebase_uid = $3)
      ORDER BY CASE WHEN merged_into_uid IS NOT NULL OR status = 'merged' THEN 1 ELSE 0 END, id`,
    [tenantId, phone, firebaseUid]
  );

  let user;
  let isNewUser = false;

  if (userResult.length === 0) {
    // Create new user — set tenant_id explicitly rather than relying on the
    // column DEFAULT, so SaaS registrations land in the right tenant.
    const insertResult = await query(
      `INSERT INTO users (
        tenant_id, phone, firebase_uid, role, registered_at, updated_at, last_sign_in_at,
        name, email, email_verified
      ) VALUES ($1::uuid, $2, $3, $4, NOW(), NOW(), NOW(), $5, $6, $7)
      RETURNING id, uid, tenant_id, name, phone, email, role, firebase_uid,
                gender, email_verified, is_active, status,
                COALESCE(is_deleted, false) AS is_deleted,
                deleted_at, last_sign_in_at AS last_login`,
      [
        tenantId,
        phone,
        firebaseUid,
        'PATIENT', // Default role
        decodedToken.name || null,
        decodedToken.email || null,
        decodedToken.email_verified || false
      ]
    );
    user = insertResult[0];
    isNewUser = true;
    logger.info(`🔥 New Firebase user created: ${maskPhoneForLog(phone)} (${firebaseUid})`);
  } else {
    user = userResult[0];

    if (user.is_deleted || String(user.status || '').toLowerCase() === 'deleted') {
      const error = new Error('This account has been deleted');
      error.statusCode = HTTP_STATUS.FORBIDDEN;
      error.code = 'ACCOUNT_DELETED';
      throw error;
    }

    // A record merged into a surviving patient record must not mint new
    // sessions — its clinical data now lives on the survivor.
    if (user.merged_into_uid || String(user.status || '').toLowerCase() === 'merged') {
      const error = new Error('This account has been merged into another patient record');
      error.statusCode = HTTP_STATUS.FORBIDDEN;
      error.code = 'ACCOUNT_MERGED';
      throw error;
    }

    // Update Firebase UID if missing
    if (!user.firebase_uid) {
      await query(
        'UPDATE users SET firebase_uid = $1, last_sign_in_at = NOW(), updated_at = NOW() WHERE uid = $2',
        [firebaseUid, user.uid]
      );
    } else {
      await query('UPDATE users SET last_sign_in_at = NOW(), updated_at = NOW() WHERE uid = $1', [
        user.uid
      ]);
    }

    logger.info(`🔥 Existing Firebase user logged in: ${maskPhoneForLog(phone)}`);
  }
  user = await attachHospitalNumber(user);

  // Generate our JWT token + register it as this user's single active session.
  // Any previously-active patient access token for this user is blacklisted
  // and a `session:revoked` event is pushed to that user_uid's WS sockets.
  const { accessToken } = await issueAccessTokenAndClaimSession({
    userUid: user.uid,
    tokenPayload: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      role: user.role,
      firebaseUid: firebaseUid
    },
    deviceType,
    req
  });

  // C-9 companion (audit 2026-06-18): mint a SEPARATE type:'refresh' token for
  // the primary patient login path. Without it the client holds only the short
  // access token and its old bearer-rotation now 401s at /refresh-token (which
  // accepts type:'refresh' only) — forcing a re-login every hour.
  const refreshToken = generateRefreshToken({
    uid: user.uid,
    id: user.id,
    phone: user.phone,
    role: user.role
  });

  // Store device info if provided
  if (deviceInfo) {
    await storeDeviceInfo(user.uid, deviceInfo, tenantId);
  }

  // Log authentication
  await logFirebaseAuth(
    phone,
    isNewUser ? AUTH_ACTIONS.FIREBASE_REGISTER : AUTH_ACTIONS.FIREBASE_LOGIN,
    true,
    null,
    req
  );

  return {
    accessToken,
    refreshToken,
    isNewUser,
    user: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      name: user.name,
      hospital_number: user.hospital_number || null,
      email: user.email,
      role: user.role,
      isNewUser,
      profileComplete: !!(user.name && user.gender),
      emailVerified: user.email_verified
    }
  };
};

// Complete user profile
export const completeUserProfile = async (profileData, req = null) => {
  const { phone, name, gender, email, birthday, anniversary, address, emergency_contact } =
    profileData;
  const normalizedPhone = normalizePhone(phone);

  // SEC-5: scope the profile update to the request's tenant so a phone
  // shared across tenants only ever updates the row in the resolved tenant.
  const tenantId = req ? await resolveTenantForRequest(req) : DEFAULT_TENANT_ID;

  // Update user profile. Explicit ::date casts on birthday/anniversary
  // so a `null`-coerced-to-text bind doesn't crash with the
  // "column is of type date but expression is of type text" error
  // Postgres throws when the JS-side value is a string.
  const result = await query(
    `UPDATE users SET
      name = $1, gender = $2, email = $3, birthday = $4::date,
      anniversary = $5::date, address = $6, emergency_contact = $7,
      profile_completed_at = NOW(), updated_at = NOW()
    WHERE tenant_id = $8::uuid AND phone = $9
    RETURNING id, uid, tenant_id, name, phone, email, role, gender, is_active`,
    [
      name,
      gender,
      email,
      birthday || null,
      anniversary || null,
      address || null,
      emergency_contact || null,
      tenantId,
      normalizedPhone
    ]
  );

  if (result.length === 0) {
    const error = new Error('User not found');
    error.statusCode = HTTP_STATUS.NOT_FOUND;
    throw error;
  }

  const user = await attachHospitalNumber(result[0]);

  logger.info(`👤 Profile completed for user: ${maskPhoneForLog(normalizedPhone)}`);

  return {
    user: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      name: user.name,
      hospital_number: user.hospital_number || null,
      gender: user.gender,
      email: user.email,
      role: user.role,
      profileComplete: true
    }
  };
};

// Link Firebase account to existing user
export const linkFirebaseAccount = async (phone, idToken, otp, req, { deviceType } = {}) => {
  if (!idToken || !otp) {
    const error = new Error('Firebase ID token and OTP are required');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  // Verify Firebase ID token
  const decodedToken = await admin.auth().verifyIdToken(idToken);
  const firebaseUid = decodedToken.uid;
  const normalizedPhone = normalizePhone(phone);

  // SEC-5: pin the tenant from the request before the identity lookup.
  const tenantId = await resolveTenantForRequest(req);

  // Verify OTP using the OTP service
  const otpResult = await OTPService.verifyOTP(normalizedPhone, otp, 'account_linking');
  if (!otpResult.valid) {
    const error = new Error(otpResult.message || 'Invalid or expired OTP');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  // Check if user exists — scoped to the resolved tenant.
  const userResult = await query(
    `SELECT id, uid, tenant_id, name, phone, email, role, firebase_uid, is_active
       FROM users
      WHERE tenant_id = $1::uuid AND phone = $2`,
    [tenantId, normalizedPhone]
  );

  if (userResult.length === 0) {
    const error = new Error('User not found');
    error.statusCode = HTTP_STATUS.NOT_FOUND;
    throw error;
  }

  const user = await attachHospitalNumber(userResult[0]);

  // Link Firebase UID to existing user
  await query('UPDATE users SET firebase_uid = $1, updated_at = NOW() WHERE uid = $2', [
    firebaseUid,
    user.uid
  ]);

  // Generate new token with Firebase UID + register as the single active session.
  const { accessToken } = await issueAccessTokenAndClaimSession({
    userUid: user.uid,
    tokenPayload: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      role: user.role,
      firebaseUid: firebaseUid
    },
    deviceType,
    req
  });

  // C-9 companion (audit 2026-06-18): a separate type:'refresh' token, so an
  // account-link login can refresh through /refresh-token like every other path.
  const refreshToken = generateRefreshToken({
    uid: user.uid,
    id: user.id,
    phone: user.phone,
    role: user.role
  });

  logger.info(`🔗 Firebase account linked to existing user: ${maskPhoneForLog(normalizedPhone)}`);

  return {
    accessToken,
    refreshToken,
    user: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      name: user.name,
      hospital_number: user.hospital_number || null,
      role: user.role,
      linkedToFirebase: true
    }
  };
};

// Update FCM token
export const updateFcmToken = async (phone, fcmToken, deviceId, req = null) => {
  if (!phone || !fcmToken) {
    const error = new Error('Phone and FCM token are required');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  const normalizedPhone = normalizePhone(phone);
  const tenantId = req
    ? await resolveTenantForRequest(req)
    : DEFAULT_TENANT_ID;

  // Update or insert FCM token
  await setTenant(tenantId, tx => query(
    `INSERT INTO user_devices (
       tenant_id, user_uid, device_id, fcm_token, last_active, created_at
     )
     SELECT tenant_id, uid, $3, $4, NOW(), NOW()
       FROM users
      WHERE tenant_id = $1::uuid
        AND phone = $2
     ON CONFLICT (tenant_id, user_uid, device_id)
     DO UPDATE SET fcm_token = EXCLUDED.fcm_token, last_active = NOW()`,
    [tenantId, normalizedPhone, deviceId || 'default', fcmToken],
    tx
  ));

  logger.info(`📱 FCM token updated for user: ${maskPhoneForLog(normalizedPhone)}`);

  return {
    phone: normalizedPhone,
    fcmToken: fcmToken.substring(0, 10) + '...[REDACTED]',
    deviceId
  };
};

// Revoke Firebase session
export const revokeFirebaseSession = async firebaseUid => {
  if (!firebaseUid) {
    const error = new Error('Firebase UID is required');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  // Revoke Firebase tokens
  await admin.auth().revokeRefreshTokens(firebaseUid);

  // Log the revocation
  await query(
    `UPDATE users SET firebase_tokens_revoked_at = NOW() 
     WHERE firebase_uid = $1`,
    [firebaseUid]
  );

  logger.info(`🔐 Firebase session revoked for UID: ${firebaseUid}`);

  return {
    firebaseUid,
    revokedAt: new Date().toISOString()
  };
};

// Self-service counterpart to revokeFirebaseSession, for a user signing
// themselves out.
//
// revokeFirebaseSession above takes the target UID as an argument, which is why
// its route is ADMIN-gated: it is a force-logout primitive, and letting a caller
// name the victim would be an IDOR. This function closes that hole by
// construction — the ONLY identity input is `userUid`, the verified JWT subject,
// and the Firebase UID is resolved from that user's own row. There is no
// parameter a caller could point at somebody else.
//
// `users.uid` is globally unique, so the uid predicate alone is the ownership
// binding; no extra tenant scoping is needed to make it safe (same lookup shape
// as resolveTenantIdForUid in loginSessionHelper.js).
export const revokeOwnFirebaseSession = async userUid => {
  if (!userUid) {
    const error = new Error('Authenticated user is required');
    error.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw error;
  }

  const rows = await query(
    `SELECT firebase_uid
       FROM users
      WHERE uid = $1::uuid
      LIMIT 1`,
    [String(userUid)]
  );

  const firebaseUid = rows[0]?.firebase_uid;

  // Staff/admin identities and pre-Firebase patient accounts have no linked
  // Firebase credential. That is not an error — but say so plainly rather than
  // reporting a revocation that never happened.
  if (!firebaseUid) {
    logger.info('🔐 Self-revoke requested for a user with no linked Firebase UID');
    return { revoked: false, reason: 'NO_FIREBASE_SESSION' };
  }

  const result = await revokeFirebaseSession(firebaseUid);

  return { revoked: true, ...result };
};

// Verify token status
export const verifyTokenStatus = async idToken => {
  const decodedToken = await admin.auth().verifyIdToken(idToken, true);

  // Check if user exists in our system
  const userResult = await query(
    'SELECT uid, phone, name, role FROM users WHERE firebase_uid = $1',
    [decodedToken.uid]
  );

  const userExists = userResult.length > 0;

  return {
    valid: true,
    userExists,
    tokenInfo: {
      uid: decodedToken.uid,
      phone: decodedToken.phone_number,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified,
      issuedAt: new Date(decodedToken.iat * 1000),
      expiresAt: new Date(decodedToken.exp * 1000)
    },
    user: userExists ? userResult[0] : null
  };
};

// Get health status
export const getHealthStatus = async () => {
  // Test Firebase Admin connection
  await admin.auth().listUsers(1);

  // Get Firebase auth statistics
  const stats = await query(`
    SELECT 
      COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL) as firebase_users,
      COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL AND last_sign_in_at > NOW() - INTERVAL '24 hours') as active_firebase_users_24h,
      COUNT(*) FILTER (WHERE firebase_uid IS NOT NULL AND profile_completed_at IS NOT NULL) as completed_profiles,
      COUNT(*) as total_users
    FROM users
  `);

  const tenantRows = await query('SELECT id::text FROM tenants ORDER BY id');
  const deviceStats = (
    await Promise.all(tenantRows.map(({ id }) => setTenant(
      id,
      tx => query(
        `SELECT platform,
                COUNT(*) AS device_count,
                COUNT(*) FILTER (
                  WHERE last_active > NOW() - INTERVAL '24 hours'
                ) AS active_24h
           FROM user_devices
          WHERE tenant_id = $1::uuid
          GROUP BY platform`,
        [id],
        tx
      ),
      { readOnly: true }
    )))
  ).flat();

  return {
    status: 'healthy',
    firebaseConnection: 'connected',
    statistics: stats[0],
    deviceStatistics: deviceStats,
    timestamp: new Date().toISOString()
  };
};

// Store device information
const storeDeviceInfo = async (userUid, deviceInfo, tenantId) => {
  try {
    await setTenant(tenantId, tx => query(
      `INSERT INTO user_devices (
        tenant_id, user_uid, device_id, device_name, platform, app_version,
        fcm_token, last_active, created_at
      ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, NOW(), NOW())
      ON CONFLICT (tenant_id, user_uid, device_id)
      DO UPDATE SET 
        device_name = EXCLUDED.device_name,
        platform = EXCLUDED.platform,
        app_version = EXCLUDED.app_version,
        fcm_token = EXCLUDED.fcm_token,
        last_active = NOW()`,
      [
        tenantId,
        userUid,
        deviceInfo.deviceId,
        deviceInfo.deviceName,
        deviceInfo.platform,
        deviceInfo.appVersion,
        deviceInfo.fcmToken
      ],
      tx
    ));
  } catch (deviceErr) {
    logger.warn('Failed to store device info:', deviceErr.message);
  }
};

// Log Firebase authentication
const logFirebaseAuth = async (phone, action, success, failureReason, req) => {
  try {
    await query(
      `INSERT INTO auth_logs (
        phone, action, success, auth_method, ip_address, user_agent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        phone,
        action,
        success,
        'firebase',
        req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
        req.headers['user-agent']
      ]
    );
  } catch (logErr) {
    logger.warn('Failed to log authentication:', logErr.message);
  }
};

// Legacy register user (for backward compatibility)
export const legacyRegisterUser = async (userData, req, { deviceType } = {}) => {
  const { phone, name, gender, email, birthday, anniversary, address } = userData;
  const normalizedPhone = normalizePhone(phone);

  // SEC-5: pin the tenant from the request before identity, so the
  // existence check and the new row are both scoped to the right tenant.
  const tenantId = await resolveTenantForRequest(req);

  // Check if user already exists — within the resolved tenant.
  const existingUser = await query(
    'SELECT id, uid, phone FROM users WHERE tenant_id = $1::uuid AND phone = $2',
    [tenantId, normalizedPhone]
  );

  if (existingUser.length > 0) {
    const error = new Error('User already exists');
    error.statusCode = HTTP_STATUS.CONFLICT;
    throw error;
  }

  // Create new user — tenant_id set explicitly.
  const insertResult = await query(
    `INSERT INTO users (
      tenant_id, phone, name, gender, email, birthday, anniversary, address,
      role, registered_at, updated_at
    ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    RETURNING id, uid, name, phone, email, role, is_active`,
    [tenantId, normalizedPhone, name, gender, email, birthday, anniversary, address, 'PATIENT']
  );

  const user = insertResult[0];

  // Generate token + register as the user's single active session.
  const { accessToken: token } = await issueAccessTokenAndClaimSession({
    userUid: user.uid,
    tokenPayload: {
      uid: user.uid,
      phone: user.phone,
      role: user.role,
      id: user.id
    },
    deviceType,
    req
  });

  // C-9 companion (audit 2026-06-18): a separate type:'refresh' token so the
  // legacy register path is refreshable through /refresh-token too.
  const refreshToken = generateRefreshToken({
    uid: user.uid,
    id: user.id,
    phone: user.phone,
    role: user.role
  });

  return {
    token,
    refreshToken,
    user: {
      uid: user.uid,
      id: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role
    }
  };
};
