import express from 'express';
import * as adminController from '../controllers/adminController.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { sendPushNotification } from '../utils/notifications/sendPushNotification.js';

const router = express.Router();

/**
 * ✅ Admin-only maintenance routes
 * Centrally protected with RBAC, audit logging, and optional identity guards
 */
wrapAutoRBAC(
  router,
  'adminRoutes',
  {
    get: [
      ['/r2/files', adminController.listR2Files],
      ['/logs/list', adminController.listLogs],
      [
        '/validate-jwt',
        (req, res) => {
          res.json({
            success: true,
            uid: req.user?.uid || null,
            role: req.user?.role || null,
            message: 'JWT and RBAC validation successful'
          });
        }
      ],
      ['/users/audit', adminController.viewRoleAudit],
      ['/audit/logs', adminController.getAuditLogs]
    ],
    post: [
      ['/r2/cleanup', adminController.cleanupR2Files],
      ['/r2/migrate-archive', adminController.migrateR2Archive],
      ['/db/backup', adminController.backupDatabase],
      ['/db/restore', adminController.restoreDatabase],
      ['/logs/cleanup', adminController.cleanupLogs],
      ['/logs/purge', adminController.purgeLogs],
      ['/fix-permissions', adminController.fixPermissions],
      ['/swagger/validate', adminController.validateSwagger],
      ['/push-test', adminController.sendTestNotification],

      // ✅ Admin-triggered push + DB save
      [
        '/notifications',
        async (req, res) => {
          const { phone, title, body, type = 'general' } = req.body;

          if (!phone || !title || !body) {
            return error(res, 'Missing required fields', 400);
          }

          try {
            // Save notification
            const saveResult = await pool.query(
              `INSERT INTO notifications (phone, title, body, type, created_at, read)
               VALUES ($1, $2, $3, $4, NOW(), false)
               RETURNING *`,
              [phone, title, body, type]
            );

            // Fetch device tokens
            const tokenResult = await pool.query(
              `SELECT token FROM device_tokens WHERE phone = $1 AND token IS NOT NULL`,
              [phone]
            );
            const tokens = tokenResult.rows.map(row => row.token).filter(Boolean);

            if (tokens.length === 0) {
              logger.warn(`📭 No device tokens found for ${phone}`);
            }

            // Send FCM push
            const fcmResponse = await sendPushNotification({
              tokens,
              title,
              body,
              data: {
                type,
                phone
              }
            });

            logger.info(`📢 Notification sent to ${phone} with ${fcmResponse.successCount} success`);

            success(res, {
              notification: saveResult.rows[0],
              fcm: fcmResponse
            }, 'Push notification sent and saved');
          } catch (err) {
            logger.error(err.stack || err.toString());
            error(res, 'Failed to send notification.');
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;
