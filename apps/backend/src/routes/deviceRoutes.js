// src/routes/deviceRoutes.js - COMPLETE PRODUCTION VERSION WITH RBAC
import express from 'express';
import { HTTP_STATUS } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { registerDevice } from '../controllers/deviceController.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { maskPhoneForLog } from '../utils/logMasking.js';
import jwtMiddleware from '../middleware/jwtMiddleware.js';
import validateApiKey from '../middleware/validateApiKey.js';
import { resolveTenantOrThrow } from '../services/tenant/tenantService.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { success, error } from '../utils/responseHelper.js';

const router = express.Router();
logger.info('✅ deviceRoutes loaded with RBAC protection');

const ADMIN_DEVICE_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

function isAdminDeviceUser(user) {
  return ADMIN_DEVICE_ROLES.has(normalizeRole(user?.role));
}

async function findDeviceUserByUid(uid, tenantId) {
  if (!uid) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, phone, name, tenant_id
       FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    uid,
    tenantId,
  );
  return rows[0] || null;
}

async function findDeviceUserByPhone(phone, tenantId) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, phone, name, tenant_id
       FROM users
      WHERE phone = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizedPhone,
    tenantId,
  );
  return rows[0] || null;
}

async function resolveDeviceTargetUser(req, requestedPhone) {
  const tenantId = tenantOf(req);
  const normalizedRequestedPhone = normalizePhone(requestedPhone || '');

  if (isAdminDeviceUser(req.user) && normalizedRequestedPhone) {
    const target = await findDeviceUserByPhone(normalizedRequestedPhone, tenantId);
    if (!target) {
      const err = new Error('User not found');
      err.statusCode = HTTP_STATUS.NOT_FOUND;
      throw err;
    }
    return {
      uid: target.uid,
      phone: normalizePhone(target.phone),
      name: target.name,
      tenantId,
    };
  }

  const current = await findDeviceUserByUid(req.user?.uid, tenantId);
  if (!current) {
    const err = new Error('Authenticated user not found');
    err.statusCode = HTTP_STATUS.UNAUTHORIZED;
    throw err;
  }

  const currentPhone = normalizePhone(current.phone);
  if (normalizedRequestedPhone && normalizedRequestedPhone !== currentPhone) {
    const err = new Error('Can only manage your own devices');
    err.statusCode = HTTP_STATUS.FORBIDDEN;
    throw err;
  }

  return {
    uid: current.uid,
    phone: currentPhone,
    name: current.name,
    tenantId,
  };
}

function sendDeviceTargetError(res, err) {
  return error(
    res,
    err.message || 'Device target user could not be resolved',
    err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR,
  );
}

async function unregisterDeviceHandler(req, res) {
  const phone = req.body?.phone || req.query?.phone || req.user?.phone;
  const deviceId = req.body?.deviceId || req.query?.deviceId;

  if (!deviceId) {
    return error(res, 'Device ID is required', HTTP_STATUS.BAD_REQUEST);
  }

  try {
    const targetUser = await resolveDeviceTargetUser(req, phone);

    const result = await prisma.$queryRawUnsafe(
      `DELETE FROM user_devices
       WHERE device_id = $1
         AND user_uid = $2::uuid
         AND tenant_id = $3::uuid
       RETURNING device_name, platform`,
      deviceId,
      targetUser.uid,
      targetUser.tenantId,
    );

    if (result.length === 0) {
      return error(res, 'Device not found or access denied', HTTP_STATUS.NOT_FOUND);
    }

    const deviceInfo = result[0];

    logger.info(`🗑️ Device unregistered: ${deviceInfo.device_name} (${deviceInfo.platform}) for ${maskPhoneForLog(targetUser.phone)} by ${req.user?.name || 'system'}`);

    success(res, {
      phone: targetUser.phone,
      deviceId,
      deviceName: deviceInfo.device_name,
      platform: deviceInfo.platform,
      unregisteredBy: req.user?.name,
      unregisteredAt: new Date().toISOString()
    }, 'Device unregistered successfully');

  } catch (err) {
    if (err.statusCode) return sendDeviceTargetError(res, err);
    logger.error('Device Unregister Error:', err);
    error(res, 'Failed to unregister device', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * ✅ Device Routes with RBAC protection
 * Comprehensive device management and FCM token handling
 * RBAC-controlled via `deviceRoutes` config
 */
wrapAutoRBAC(
  router,
  'deviceRoutes',
  {
    get: [
      // Test route
      [
        '/test',
        (req, res) => {
          success(res, { 
            message: 'Device routes working!',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            user: req.user?.name || 'Unknown'
          }, 'Device routes operational');
        }
      ],

      // 📱 Get My Devices
      [
        '/my-devices',
        async (req, res) => {
          let targetUser;
          let devices;
          try {
            targetUser = await resolveDeviceTargetUser(req, req.query.phone);

            devices = await prisma.$queryRawUnsafe(
              `SELECT 
                device_id, device_name, platform, app_version, os_version,
                last_active, created_at, fcm_token,
                CASE 
                  WHEN last_active > NOW() - INTERVAL '7 days' THEN 'active'
                  WHEN last_active > NOW() - INTERVAL '30 days' THEN 'inactive'
                  ELSE 'dormant'
                END as status
               FROM user_devices 
               WHERE user_uid = $1::uuid
                 AND tenant_id = $2::uuid
               ORDER BY last_active DESC`,
              targetUser.uid,
              targetUser.tenantId,
            );
          } catch (err) {
            if (err.statusCode) return sendDeviceTargetError(res, err);
            logger.error('Get User Devices Error:', err);
            return error(res, 'Failed to retrieve user devices', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }

          const devicesData = devices.map(device => ({
            ...device,
            fcm_token: isAdminDeviceUser(req.user) ? device.fcm_token :
                      (device.fcm_token ? device.fcm_token.substring(0, 10) + '...[REDACTED]' : null)
          }));

          return success(res, {
            devices: devicesData,
            totalDevices: devices.length,
            activeDevices: devices.filter(d => d.status === 'active').length,
            inactiveDevices: devices.filter(d => d.status === 'inactive').length,
            dormantDevices: devices.filter(d => d.status === 'dormant').length,
            requestedBy: req.user?.name
          }, 'User devices retrieved successfully');
        }
      ],

      // 📋 All devices for admin dashboard
      [
        '/admin/list',
        async (req, res) => {
          let devices;
          try {
            if (!isAdminDeviceUser(req.user)) {
              return error(res, 'Admin access required to view all devices', HTTP_STATUS.FORBIDDEN);
            }

            const { search } = req.query;
            const params = [];
            let whereClause = '';

            if (search) {
              params.push(`%${search}%`);
              whereClause = `
                WHERE (
                  u.name ILIKE $1 OR
                  u.phone ILIKE $1 OR
                  ud.device_id ILIKE $1 OR
                  ud.device_name ILIKE $1 OR
                  ud.platform ILIKE $1
                )
              `;
            }

            devices = await prisma.$queryRawUnsafe(
              `SELECT
                ud.id,
                ud.device_id,
                u.uid as user_id,
                u.name as user_name,
                LOWER(COALESCE(u.role, 'patient')) as user_type,
                COALESCE(ud.device_type, ud.platform) as device_type,
                ud.device_name,
                ud.platform,
                ud.os_version,
                ud.app_version,
                ud.fcm_token,
                CASE
                  WHEN ud.last_active > NOW() - INTERVAL '7 days' THEN 'active'
                  WHEN ud.last_active > NOW() - INTERVAL '30 days' THEN 'inactive'
                  ELSE 'expired'
                END as fcm_status,
                ud.last_active,
                ud.ip_address,
                ud.created_at,
                ud.updated_at
              FROM user_devices ud
              JOIN users u
                ON u.uid = ud.user_uid
               AND u.tenant_id = ud.tenant_id
              ${whereClause || 'WHERE u.tenant_id = $1::uuid'}
              ${whereClause ? ` AND u.tenant_id = $${params.length + 1}::uuid` : ''}
                AND ud.tenant_id = u.tenant_id
              ORDER BY ud.last_active DESC NULLS LAST, ud.created_at DESC NULLS LAST
              LIMIT 200`,
              ...params,
              tenantOf(req),
            );

          } catch (err) {
            if (err.statusCode) return sendDeviceTargetError(res, err);
            logger.error('Admin Device List Error:', err);
            return error(res, 'Failed to retrieve devices', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
          return success(res, devices, 'Devices retrieved successfully');
        }
      ],

      // 📊 Device Statistics (Admin only)
      [
        '/stats',
        async (req, res) => {
          try {
            // Role-based access control
            if (!isAdminDeviceUser(req.user)) {
              return error(res, 'Admin access required for device statistics', HTTP_STATUS.FORBIDDEN);
            }

            const tenantId = tenantOf(req);
            const [deviceStats, platformStats, activityStats] = await Promise.all([
              // Overall device statistics
              prisma.$queryRawUnsafe(`
                SELECT 
                  COUNT(*) as total_devices,
                  COUNT(DISTINCT ud.user_uid) as unique_users,
                  COUNT(CASE WHEN ud.last_active > NOW() - INTERVAL '7 days' THEN 1 END) as active_7_days,
                  COUNT(CASE WHEN ud.last_active > NOW() - INTERVAL '30 days' THEN 1 END) as active_30_days,
                  COUNT(CASE WHEN ud.created_at > NOW() - INTERVAL '7 days' THEN 1 END) as new_registrations_7_days
                FROM user_devices ud
                JOIN users u
                  ON u.uid = ud.user_uid
                 AND u.tenant_id = ud.tenant_id
                WHERE ud.tenant_id = $1::uuid
              `, tenantId),
              
              // Platform distribution
              prisma.$queryRawUnsafe(`
                SELECT 
                  ud.platform,
                  COUNT(*) as device_count,
                  COUNT(CASE WHEN ud.last_active > NOW() - INTERVAL '7 days' THEN 1 END) as active_count
                FROM user_devices ud
                JOIN users u
                  ON u.uid = ud.user_uid
                 AND u.tenant_id = ud.tenant_id
                WHERE ud.tenant_id = $1::uuid
                GROUP BY ud.platform
                ORDER BY device_count DESC
              `, tenantId),
              
              // Activity over time (last 30 days)
              prisma.$queryRawUnsafe(`
                SELECT 
                  DATE(ud.last_active) as activity_date,
                  COUNT(DISTINCT ud.device_id) as active_devices,
                  COUNT(DISTINCT ud.user_uid) as active_users
                FROM user_devices ud
                JOIN users u
                  ON u.uid = ud.user_uid
                 AND u.tenant_id = ud.tenant_id
                WHERE ud.tenant_id = $1::uuid
                  AND ud.last_active > NOW() - INTERVAL '30 days'
                GROUP BY DATE(ud.last_active)
                ORDER BY activity_date DESC
              `, tenantId)
            ]);

            success(res, {
              overview: deviceStats[0],
              platformDistribution: platformStats,
              activityTrend: activityStats,
              requestedBy: req.user?.name,
              generatedAt: new Date().toISOString()
            }, 'Device statistics retrieved successfully');

          } catch (err) {
            logger.error('Device Stats Error:', err);
            return error(res, 'Device statistics unavailable', HTTP_STATUS.INTERNAL_SERVER_ERROR, {
              source: 'user_devices',
              generatedAt: new Date().toISOString()
            });
          }
        }
      ],

      // 🔍 Get Device by ID (Admin only)
      [
        '/device/:deviceId',
        async (req, res) => {
          try {
            const { deviceId } = req.params;
            
            // Role-based access control
            if (!isAdminDeviceUser(req.user)) {
              return error(res, 'Admin access required to view device details', HTTP_STATUS.FORBIDDEN);
            }

            const result = await prisma.$queryRawUnsafe(
              `SELECT 
                ud.*, u.name as user_name, u.phone as user_phone, u.role as user_role
               FROM user_devices ud
               JOIN users u
                 ON ud.user_uid = u.uid
                AND ud.tenant_id = u.tenant_id
               WHERE ud.device_id = $1
                 AND ud.tenant_id = $2::uuid`,
              deviceId,
              tenantOf(req),
            );

            if (result.length === 0) {
              return error(res, 'Device not found', HTTP_STATUS.NOT_FOUND);
            }

            success(res, {
              device: result[0],
              requestedBy: req.user?.name
            }, 'Device details retrieved successfully');

          } catch (err) {
            logger.error('Get Device Error:', err);
            error(res, 'Failed to retrieve device details', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    post: [
      // 📱 Register Device (Enhanced with legacy support)
      [
        '/register',
        async (req, res) => {
          const { 
            phone, fcmToken, deviceId, deviceName, 
            platform, appVersion, osVersion 
          } = req.body;

          if (!fcmToken || !deviceId) {
            return error(res, 'Device ID and FCM token are required', HTTP_STATUS.BAD_REQUEST);
          }

          try {
            const user = await resolveDeviceTargetUser(req, phone);

            // Register/update device with enhanced conflict resolution
            const result = await prisma.$queryRawUnsafe(
              `INSERT INTO user_devices (
                tenant_id, user_uid, device_id, device_name, platform, app_version,
                os_version, fcm_token, last_active, created_at
              ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, NOW(), NOW())
              ON CONFLICT (tenant_id, user_uid, device_id)
              DO UPDATE SET 
                device_name = EXCLUDED.device_name,
                platform = EXCLUDED.platform,
                app_version = EXCLUDED.app_version,
                os_version = EXCLUDED.os_version,
                fcm_token = EXCLUDED.fcm_token,
                last_active = NOW()
              RETURNING id, (xmax = 0) as is_new_registration`,
              user.tenantId, user.uid, deviceId, deviceName, platform,
              appVersion, osVersion, fcmToken
            );

            const isNewRegistration = result[0].is_new_registration;
            
            logger.info(`📱 Device ${isNewRegistration ? 'registered' : 'updated'}: ${deviceName} for ${maskPhoneForLog(user.phone)} by ${req.user?.name || 'system'}`);

            success(res, {
              deviceRegistrationId: result[0].id,
              phone: user.phone,
              deviceId,
              deviceName,
              isNewRegistration,
              registeredBy: req.user?.name,
              registeredAt: new Date().toISOString()
            }, `Device ${isNewRegistration ? 'registered' : 'updated'} successfully`);

          } catch (err) {
            if (err.statusCode) return sendDeviceTargetError(res, err);
            logger.error('Device Registration Error:', err);
            error(res, 'Failed to register device', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Legacy controller-based registration (from deprecated version)
      [
        '/legacy-register',
        validateApiKey,
        jwtMiddleware,
        registerDevice
      ],

      // 📊 Update Device Activity / Heartbeat
      [
        '/heartbeat',
        async (req, res) => {
          const { phone, deviceId, additionalData = {} } = req.body;

          if (!deviceId) {
            return error(res, 'Device ID is required', HTTP_STATUS.BAD_REQUEST);
          }

          try {
            const targetUser = await resolveDeviceTargetUser(req, phone);

            // Update device activity with optional additional data
            const updateQuery = `
              UPDATE user_devices 
              SET last_active = NOW(),
                  app_version = COALESCE($3, app_version),
                  os_version = COALESCE($4, os_version)
              WHERE device_id = $1 
                AND user_uid = $2::uuid
                AND tenant_id = $5::uuid
              RETURNING device_name, last_active
            `;

            const result = await prisma.$queryRawUnsafe(updateQuery, 
              deviceId, 
              targetUser.uid,
              additionalData.appVersion,
              additionalData.osVersion,
              targetUser.tenantId
            );

            if (result.length === 0) {
              return error(res, 'Device not found or access denied', HTTP_STATUS.NOT_FOUND);
            }

            success(res, { 
              phone: targetUser.phone,
              deviceId,
              deviceName: result[0].device_name,
              lastActive: result[0].last_active,
              updatedBy: req.user?.name
            }, 'Device activity updated successfully');

          } catch (err) {
            if (err.statusCode) return sendDeviceTargetError(res, err);
            logger.error('Device Heartbeat Error:', err);
            error(res, 'Failed to update device activity', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🔄 Update FCM Token
      [
        '/update-token',
        async (req, res) => {
          const { phone, deviceId, fcmToken } = req.body;

          if (!deviceId || !fcmToken) {
            return error(res, 'Device ID and FCM token are required', HTTP_STATUS.BAD_REQUEST);
          }

          try {
            const targetUser = await resolveDeviceTargetUser(req, phone);

            const result = await prisma.$queryRawUnsafe(
              `UPDATE user_devices 
               SET fcm_token = $1, last_active = NOW()
               WHERE device_id = $2 
                 AND user_uid = $3::uuid
                 AND tenant_id = $4::uuid
               RETURNING device_name`,
              fcmToken, deviceId, targetUser.uid, targetUser.tenantId
            );

            if (result.length === 0) {
              return error(res, 'Device not found or access denied', HTTP_STATUS.NOT_FOUND);
            }

            logger.info(`🔄 FCM token updated for device: ${result[0].device_name} (${deviceId}) by ${req.user?.name || 'system'}`);

            success(res, {
              phone: targetUser.phone,
              deviceId,
              deviceName: result[0].device_name,
              tokenUpdated: true,
              updatedBy: req.user?.name,
              updatedAt: new Date().toISOString()
            }, 'FCM token updated successfully');

          } catch (err) {
            if (err.statusCode) return sendDeviceTargetError(res, err);
            logger.error('FCM Token Update Error:', err);
            error(res, 'Failed to update FCM token', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🗑️ Unregister Device (body-bearing alias used by mobile clients)
      [
        '/unregister',
        unregisterDeviceHandler
      ]
    ],

    delete: [
      // 🗑️ Unregister Device
      [
        '/unregister',
        unregisterDeviceHandler
      ],

      // 🧹 Cleanup Inactive Devices (Admin only)
      [
        '/cleanup-inactive',
        async (req, res) => {
          try {
            const { olderThanDays = 90 } = req.body;

            // Role-based access control
            if (req.user?.role !== 'ADMIN') {
              return error(res, 'Admin access required for device cleanup', HTTP_STATUS.FORBIDDEN);
            }

            // Validate and clamp to safe integer range
            const days = Math.max(1, Math.min(parseInt(olderThanDays, 10) || 90, 3650));

            const result = await prisma.$queryRawUnsafe(
              `DELETE FROM user_devices
               USING users u
               WHERE user_devices.user_uid = u.uid
                 AND user_devices.tenant_id = u.tenant_id
                 AND u.tenant_id = $2::uuid
                 AND user_devices.last_active < NOW() - make_interval(days => $1)
               RETURNING user_devices.device_name, user_devices.platform, user_devices.last_active`,
              days,
              tenantOf(req),
            );

            const cleanedDevices = result;
            
            logger.info(`🧹 Cleaned up ${cleanedDevices.length} inactive devices (older than ${olderThanDays} days) by ${req.user?.name}`);

            success(res, {
              cleanedDevices: cleanedDevices.length,
              olderThanDays,
              devices: cleanedDevices,
              cleanedBy: req.user?.name,
              cleanedAt: new Date().toISOString()
            }, `Cleaned up ${cleanedDevices.length} inactive devices`);

          } catch (err) {
            logger.error('Device Cleanup Error:', err);
            error(res, 'Failed to cleanup inactive devices', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,        // Require user authentication
    requirePhone: false,     // Phone not required for all operations (extracted from JWT)
    auditLog: true,         // Enable audit logging
    rateLimiting: true,     // Enable rate limiting
    roles: ['ADMIN', 'DOCTOR', 'PATIENT', 'NURSE'] // All authenticated users can manage devices
  }
);

export default router;
