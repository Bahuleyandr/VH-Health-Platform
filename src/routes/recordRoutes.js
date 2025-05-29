// src/routes/recordRoutes.js

import express from 'express';
import { validationResult } from 'express-validator';
import * as recordController from '../controllers/recordController.js';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { healthRecordValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

// ✅ Add health record with validation
wrapAutoRBAC(router, 'recordRoutes', {
  post: [
    [
      '/health-records',
      healthRecordValidator,
      (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        recordController.addHealthRecord(req, res);
      }
    ]
  ],
  get: [
    ['/uid/:uid', recordController.getRecordsByUID],
    [
      '/health-records/:phone',
      async (req, res) => {
        try {
          const phone = normalizePhone(req);
          const { type } = req.query;

          const result = await pool.query('SELECT * FROM health_records WHERE phone = $1', [phone]);
          let records = result.rows;

          if (type) {
            records = records.filter(
              r => r.file_type && r.file_type.toLowerCase() === type.toLowerCase()
            );
          }

          success(res, records, 'Health records fetched successfully');
        } catch (err) {
          logger.error(err.stack || err.toString());
          error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
        }
      }
    ],
    ['/consultations/:phoneNumber', recordController.getHealthRecordsByPhone]
  ]
});

export default router;
