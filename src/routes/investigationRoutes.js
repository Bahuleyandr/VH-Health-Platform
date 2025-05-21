// src/routes/investigationRoutes.js

import express from 'express';
import { validationResult } from 'express-validator';
import pool from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { investigationRequestValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import * as investigationController from '../controllers/investigationController.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

wrapAutoRBAC(router, 'investigationRoutes', {
  post: [
    ['/', investigationRequestValidator, async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED,
        });
      }

      const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
      const { test_name, file_key } = req.body;

      if (!phone || !test_name) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          error: 'Phone and test name are required.',
        });
      }

      try {
        const result = await pool.query(
          'INSERT INTO investigations (phone, test_name, file_key) VALUES ($1, $2, $3) RETURNING *',
          [phone, test_name, file_key || null]
        );
        success(res, result.rows[0], RESPONSE_MESSAGES.INVESTIGATION_REQUESTED);
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
      }
    }]
  ],
  get: [
    ['/uid/:uid', investigationController.getInvestigationsByUID],
    ['/:phone', async (req, res) => {
      try {
        const phone = normalizePhone(req.params.phone);
        const result = await pool.query(
          'SELECT * FROM investigations WHERE phone = $1',
          [phone]
        );
        success(res, result.rows, 'Investigations fetched successfully');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
      }
    }]
  ]
});

export default router;
