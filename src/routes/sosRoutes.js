// src/routes/sosRoutes.js

import express from 'express';
import pool from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

/**
 * ✅ POST /api/v1/sos
 * ✅ Secure + normalized + IP-logged + audit-enabled SOS alert route
 */
wrapAutoRBAC(router, 'sosRoutes', {
  post: [
    [
      '/',
      async (req, res) => {
        const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
        const latitude = req.body.latitude
          ? parseFloat(req.body.latitude)
          : null;
        const longitude = req.body.longitude
          ? parseFloat(req.body.longitude)
          : null;
        const ip_address =
          req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;

        if (!phone) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            error: 'Phone number is required',
          });
        }

        try {
          const result = await pool.query(
            `INSERT INTO sos_alerts (phone, latitude, longitude, ip_address, created_at)
           VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
            [phone, latitude, longitude, ip_address],
          );

          success(res, result.rows[0], RESPONSE_MESSAGES.SOS_ALERT_SAVED);
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
        }
      },
    ],
  ],
});

export default router;
