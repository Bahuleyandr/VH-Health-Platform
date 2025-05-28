// src/routes/pharmacyRoutes.js

import express from 'express';
import pool from '../db.js';
import { validationResult } from 'express-validator';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import * as pharmacyController from '../controllers/pharmacyController.js';
import { pharmacyOrderValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

// ✅ Secure and validate pharmacy order routes with RBAC
wrapAutoRBAC(router, 'pharmacyRoutes', {
  post: [
    [
      '/',
      pharmacyOrderValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED,
          });
        }

        const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
        const { order_note, file_key } = req.body;

        if (!phone || !order_note) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            error: 'Phone and order note are required.',
          });
        }

        try {
          const result = await pool.query(
            'INSERT INTO pharmacy_orders (phone, order_note, file_key) VALUES ($1, $2, $3) RETURNING *',
            [phone, order_note, file_key || null],
          );
          success(res, result.rows[0], RESPONSE_MESSAGES.ORDER_PLACED);
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
        }
      },
    ],
  ],
  get: [
    ['/uid/:uid', pharmacyController.getPharmacyOrdersByUID],
    [
      '/:phone',
      async (req, res) => {
        try {
          const phone = normalizePhone(req.params.phone);
          const result = await pool.query(
            'SELECT * FROM pharmacy_orders WHERE phone = $1 ORDER BY id DESC',
            [phone],
          );
          success(res, result.rows, 'Pharmacy orders fetched successfully');
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
        }
      },
    ],
  ],
});

export default router;
