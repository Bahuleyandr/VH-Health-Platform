// src/routes/adminDepartmentRoutes.js

import express from 'express';
import pool from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();

/**
 * ✅ Admin-only Department Management
 * Centrally secured with RBAC, UID/Phone validators, rate limiting
 */
wrapAutoRBAC(router, 'adminDepartmentRoutes', {
  post: [
    ['/', async (req, res) => {
      const { name } = req.body;

      if (!name) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          error: RESPONSE_MESSAGES.VALIDATION_FAILED,
          details: 'Department name is required.'
        });
      }

      try {
        const result = await pool.query(
          `INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *`,
          [name]
        );

        const responseData = result.rows[0] || { message: 'Department already exists.' };
        success(res, responseData, 'Department saved successfully');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
      }
    }]
  ],
  delete: [
    ['/:deptId', async (req, res) => {
      const { deptId } = req.params;

      try {
        const deleteResult = await pool.query(
          'DELETE FROM departments WHERE id = $1 RETURNING *',
          [deptId]
        );

        if (deleteResult.rowCount === 0) {
          return res.status(HTTP_STATUS.NOT_FOUND).json({
            error: RESPONSE_MESSAGES.NOT_FOUND,
            details: 'Department not found or already deleted.'
          });
        }

        success(res, deleteResult.rows[0], 'Department deleted successfully');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
      }
    }]
  ]
}, {
  requireUID: false,
  requirePhone: false
});

export default router;
