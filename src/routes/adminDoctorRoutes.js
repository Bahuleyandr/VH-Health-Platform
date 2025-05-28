// src/routes/adminDoctorRoutes.js

import express from 'express';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();

/**
 * ✅ Admin-only Doctor Management
 * Centrally secured with RBAC, UID/Phone validators, rate limiting
 */
wrapAutoRBAC(
  router,
  'adminDoctorRoutes',
  {
    post: [
      [
        '/',
        async (req, res) => {
          const { name, department, intro, imageUrl } = req.body;

          if (!name || !department) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              error: RESPONSE_MESSAGES.VALIDATION_FAILED,
              details: 'Doctor name and department are required.',
            });
          }

          try {
            const result = await pool.query(
              `INSERT INTO doctors (name, department, intro, image_url) VALUES ($1, $2, $3, $4) RETURNING *`,
              [name, department, intro, imageUrl],
            );
            success(res, result.rows[0], 'Doctor saved successfully');
          } catch (err) {
            logger.error(err.stack || err.toString());
            error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
          }
        },
      ],
    ],
    delete: [
      [
        '/:doctorId',
        async (req, res) => {
          const { doctorId } = req.params;

          try {
            const deleteResult = await pool.query(
              'DELETE FROM doctors WHERE id = $1 RETURNING *',
              [doctorId],
            );

            if (deleteResult.rowCount === 0) {
              return res.status(HTTP_STATUS.NOT_FOUND).json({
                error: RESPONSE_MESSAGES.NOT_FOUND,
                details: 'Doctor not found or already deleted.',
              });
            }

            success(res, deleteResult.rows[0], 'Doctor deleted successfully');
          } catch (err) {
            logger.error(err.stack || err.toString());
            error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
          }
        },
      ],
    ],
  },
  {
    requireUID: false,
    requirePhone: false,
  },
);

export default router;
