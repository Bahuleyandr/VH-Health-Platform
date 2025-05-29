import express from 'express';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

wrapAutoRBAC(router, 'adminNotificationRoutes', {
  post: [
    [
      '/',
      async (req, res) => {
        try {
          const {
            phones,     // array of phone numbers
            title,
            body,
            type = 'general' // optional, default to 'general'
          } = req.body;

          if (!Array.isArray(phones) || phones.length === 0) {
            return error(res, 'At least one phone number is required.', 400);
          }

          if (!title || !body) {
            return error(res, 'Title and body are required.', 400);
          }

          const createdBy = req.user?.uid || 'admin';

          const inserts = phones.map(phone => {
            const normalized = normalizePhone(phone);
            return pool.query(
              `INSERT INTO notifications (phone, title, body, type, created_at, is_read, created_by)
               VALUES ($1, $2, $3, $4, NOW(), false, $5)`,
              [normalized, title, body, type, createdBy]
            );
          });

          await Promise.all(inserts);

          logger.info(`📣 Admin Notification sent to ${phones.length} user(s) by ${createdBy}`);
          success(res, null, `Notifications sent to ${phones.length} user(s)`);
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, 'Failed to send notifications.');
        }
      }
    ]
  ]
});

export default router;
