// src/routes/departmentRoutes.js

import express from 'express';
import pool from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();

/**
 * ✅ Department Routes (RBAC-controlled via `departmentRoutes`)
 * Includes:
 *  - All departments
 *  - Departments with doctors
 *  - Single department by ID
 */
wrapAutoRBAC(router, 'departmentRoutes', {
  get: [
    ['/departments-with-doctors', async (req, res) => {
      try {
        const result = await pool.query(`
          SELECT d.id as department_id, d.name as department_name,
                 json_agg(json_build_object('id', doc.id, 'name', doc.name, 'specialty', doc.specialty)) as doctors
          FROM departments d
          LEFT JOIN doctors doc ON doc.department_id = d.id
          GROUP BY d.id, d.name
          ORDER BY d.name ASC;
        `);
        success(res, result.rows, RESPONSE_MESSAGES.DEPARTMENTS_WITH_DOCTORS_FETCHED);
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }],
    ['/', async (req, res) => {
      try {
        const result = await pool.query('SELECT * FROM departments ORDER BY name ASC');
        success(res, result.rows, RESPONSE_MESSAGES.DEPARTMENTS_FETCHED);
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }],
    ['/:departmentId', async (req, res) => {
      try {
        const result = await pool.query('SELECT * FROM departments WHERE id = $1', [req.params.departmentId]);
        if (result.rows.length > 0) {
          success(res, result.rows[0], RESPONSE_MESSAGES.DEPARTMENT_DETAILS_FOUND);
        } else {
          error(res, RESPONSE_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
        }
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }]
  ]
});

export default router;
