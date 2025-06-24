// ========================================
// src/routes/deviceRoutes.js - CORRECTED  
// ========================================
import express from 'express';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { HTTP_STATUS } from '../config/responseCodes.js'; // ✅ Added missing import

const router = express.Router(); // ✅ Fixed: was deviceRouter

wrapAutoRBAC(router, 'deviceRoutes', {
  post: [
    // 📱 Register Device
    [
      '/register',
      async (req, res) => {
        const { 
          phone, fcmToken, deviceId, deviceName, 
          platform, appVersion, osVersion 
        } = req.body;

        if (!phone || !fcmToken) {
          return error(res, 'Phone and FCM token are required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const normalizedPhone = normalizePhone(phone);

          // Get user UID
          const userResult = await pool.query(
            'SELECT uid FROM users WHERE phone = $1',
            [normalizedPhone]
          );

          if (userResult.rows.length === 0) {
            return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
          }

          const userUid = userResult.rows[0].uid;

          // Register/update device
          const result = await pool.query(
            `INSERT INTO user_devices (
              user_uid, device_id, device_name, platform, app_version, 
              os_version, fcm_token, last_active, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
            ON CONFLICT (user_uid, device_id) 
            DO UPDATE SET 
              device_name = EXCLUDED.device_name,
              platform = EXCLUDED.platform,
              app_version = EXCLUDED.app_version,
              os_version = EXCLUDED.os_version,
              fcm_token = EXCLUDED.fcm_token,
              last_active = NOW()
            RETURNING id`,
            [userUid, deviceId, deviceName, platform, appVersion, osVersion, fcmToken]
          );

          logger.info(`📱 Device registered: ${deviceName} for ${normalizedPhone}`);

          success(res, {
            deviceRegistrationId: result.rows[0].id,
            phone: normalizedPhone,
            deviceId,
            registeredAt: new Date().toISOString()
          }, 'Device registered successfully');

        } catch (err) {
          logger.error('Device Registration Error:', err);
          error(res, 'Failed to register device', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 Update Device Activity
    [
      '/heartbeat',
      async (req, res) => {
        const { phone, deviceId } = req.body;

        if (!phone || !deviceId) {
          return error(res, 'Phone and device ID are required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const normalizedPhone = normalizePhone(phone);

          await pool.query(
            `UPDATE user_devices 
             SET last_active = NOW() 
             WHERE device_id = $1 
               AND user_uid = (SELECT uid FROM users WHERE phone = $2)`,
            [deviceId, normalizedPhone]
          );

          success(res, { 
            phone: normalizedPhone,
            deviceId,
            lastActive: new Date().toISOString()
          }, 'Device activity updated');

        } catch (err) {
          logger.error('Device Heartbeat Error:', err);
          error(res, 'Failed to update device activity', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  get: [
    // 📱 Get My Devices
    [
      '/my-devices',
      async (req, res) => {
        const phone = normalizePhone(req.user?.phone || req.query.phone);

        if (!phone) {
          return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const devices = await pool.query(
            `SELECT 
              device_id, device_name, platform, app_version, os_version,
              last_active, created_at,
              CASE 
                WHEN last_active > NOW() - INTERVAL '7 days' THEN 'active'
                WHEN last_active > NOW() - INTERVAL '30 days' THEN 'inactive'
                ELSE 'dormant'
              END as status
             FROM user_devices 
             WHERE user_uid = (SELECT uid FROM users WHERE phone = $1)
             ORDER BY last_active DESC`,
            [phone]
          );

          success(res, {
            devices: devices.rows,
            totalDevices: devices.rows.length,
            activeDevices: devices.rows.filter(d => d.status === 'active').length
          }, 'User devices retrieved');

        } catch (err) {
          logger.error('Get User Devices Error:', err);
          error(res, 'Failed to fetch devices', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  delete: [
    // 🗑️ Unregister Device
    [
      '/unregister',
      async (req, res) => {
        const { phone, deviceId } = req.body;

        if (!phone || !deviceId) {
          return error(res, 'Phone and device ID are required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const normalizedPhone = normalizePhone(phone);

          const result = await pool.query(
            `DELETE FROM user_devices 
             WHERE device_id = $1 
               AND user_uid = (SELECT uid FROM users WHERE phone = $2)
             RETURNING device_name`,
            [deviceId, normalizedPhone]
          );

          if (result.rows.length === 0) {
            return error(res, 'Device not found', HTTP_STATUS.NOT_FOUND);
          }

          logger.info(`🗑️ Device unregistered: ${result.rows[0].device_name} for ${normalizedPhone}`);

          success(res, {
            phone: normalizedPhone,
            deviceId,
            deviceName: result.rows[0].device_name,
            unregisteredAt: new Date().toISOString()
          }, 'Device unregistered successfully');

        } catch (err) {
          logger.error('Device Unregister Error:', err);
          error(res, 'Failed to unregister device', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

export default router;