// src/routes/appointmentRoutes.js

import express from 'express';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import * as appointmentController from '../controllers/appointmentController.js';
import { appointmentValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { validationResult } from 'express-validator';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

/**
 * ✅ Centralized appointment routes
 * Applies RBAC, audit log, identity check, and validation
 */
wrapAutoRBAC(router, 'appointmentRoutes', {
  post: [
    [
      '/',
      appointmentValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED,
          });
        }

        const phone = normalizePhone(req.body.phone || req.body.phoneNumber); // ✅ corrected
        const { doctor_name, date, time } = req.body;

        try {
          const result = await pool.query(
            'INSERT INTO appointments (phone, doctor_name, date, time) VALUES ($1, $2, $3, $4) RETURNING *',
            [phone, doctor_name, date, time],
          );
          success(res, result.rows[0], RESPONSE_MESSAGES.APPOINTMENT_BOOKED);
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
        }
      },
    ],
  ],
  get: [
    [
      '/:phone',
      async (req, res) => {
        try {
          const phone = normalizePhone(req.params.phone); // ✅ corrected
          const result = await pool.query(
            'SELECT * FROM appointments WHERE phone = $1 ORDER BY date DESC',
            [phone],
          );
          success(res, result.rows, 'Appointments fetched successfully');
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
        }
      },
    ],
    ['/uid/:uid', appointmentController.getAppointmentsByUID],
  ],
});

export default router;
