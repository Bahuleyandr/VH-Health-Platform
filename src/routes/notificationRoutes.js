import express from 'express';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

wrapAutoRBAC(router, 'notificationRoutes', {
  get: [
    [
      '/:phone',
      async (req, res) => {
        try {
          const phone = normalizePhone(req.params.phone);
          const result = await pool.query(
            `SELECT * FROM notifications WHERE phone = $1 ORDER BY created_at DESC`,
            [phone]
          );
          success(res, result.rows, 'Notifications fetched');
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, 'Failed to fetch notifications.');
        }
      }
    ]
  ],

  patch: [
    [
      '/:id/read',
      async (req, res) => {
        try {
          const { id } = req.params;
          await pool.query(
            `UPDATE notifications SET is_read = TRUE WHERE id = $1`,
            [id]
          );
          success(res, null, 'Notification marked as read');
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, 'Failed to update notification.');
        }
      }
    ]
  ]
});

export default router;
