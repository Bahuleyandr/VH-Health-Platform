// src/routes/doctorRoutes.js

import express from 'express';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();

/**
 * ✅ Doctor Routes (RBAC-controlled via `doctorRoutes`)
 * - List doctors or search by name/specialty
 * - Fetch single doctor by ID
 */
wrapAutoRBAC(router, 'doctorRoutes', {
  get: [
    ['/', async (req, res) => {
      try {
        const { query } = req.query;

        const result = query
          ? await pool.query(
              `SELECT * FROM doctors 
               WHERE LOWER(name) LIKE $1 OR LOWER(specialty) LIKE $1 
               ORDER BY name ASC`,
              [`%${query.toLowerCase()}%`]
            )
          : await pool.query('SELECT * FROM doctors ORDER BY name ASC');

        success(res, result.rows, 'Doctors fetched successfully');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
      }
    }],
    ['/:doctorId', async (req, res) => {
      try {
        const result = await pool.query('SELECT * FROM doctors WHERE id = $1', [req.params.doctorId]);

        if (result.rows.length > 0) {
          success(res, result.rows[0], 'Doctor profile found');
        } else {
          error(res, RESPONSE_MESSAGES.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
        }
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
      }
    }]
  ]
});

export default router;
