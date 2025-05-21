// src/routes/userRoutes.js

import express from 'express';
import pool from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import * as userController from '../controllers/userController.js';
import { userProfileValidator } from '../config/validationSchemas.js';
import { validationResult } from 'express-validator';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

console.log('✅ userRoutes loaded');

// ✅ POST: Create or update user profile with validation (no UID/Phone enforcement)
wrapAutoRBAC(router, 'userRoutes', {
  post: [
    ['/', userProfileValidator, async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          errors: errors.array(),
          message: RESPONSE_MESSAGES.VALIDATION_FAILED,
        });
      }

      const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
      const { name, gender, address, email, birthday, anniversary, profilePicture } = req.body;

      try {
        const result = await pool.query(
          `INSERT INTO users (phone, name, gender, address, email, birthday, anniversary, profile_picture, registered_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (phone) DO UPDATE SET
             name = EXCLUDED.name,
             gender = EXCLUDED.gender,
             address = EXCLUDED.address,
             email = EXCLUDED.email,
             birthday = EXCLUDED.birthday,
             anniversary = EXCLUDED.anniversary,
             profile_picture = EXCLUDED.profile_picture
           RETURNING *`,
          [phone, name, gender, address, email, birthday, anniversary, profilePicture]
        );
        success(res, result.rows[0], 'User saved');
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

// ✅ GET + PUT: User lookups and update (with UID/Phone enforcement)
wrapAutoRBAC(router, 'userRoutes', {
  get: [
    ['/uid/:uid', userController.getUserByUID],
    ['/:phone', async (req, res) => {
      try {
        const phone = normalizePhone(req.params.phone);
        const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
        if (result.rows.length) {
          success(res, result.rows[0], 'User found');
        } else {
          error(res, RESPONSE_MESSAGES.USER_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
        }
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
      }
    }],
    ['/search', async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;
        const query = req.query.query ? `%${req.query.query.toLowerCase()}%` : null;

        let result;
        if (query) {
          result = await pool.query(
            `SELECT * FROM users 
             WHERE LOWER(name) LIKE $1 OR phone LIKE $1 
             ORDER BY registered_at DESC 
             LIMIT $2 OFFSET $3`,
            [query, limit, offset]
          );
        } else {
          result = await pool.query(
            'SELECT * FROM users ORDER BY registered_at DESC LIMIT $1 OFFSET $2',
            [limit, offset]
          );
        }

        success(res, { page, limit, data: result.rows }, 'User list fetched');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
      }
    }]
  ],
  put: [
    ['/:phone', async (req, res) => {
      const phone = normalizePhone(req.params.phone);
      const { name, gender, address, email, birthday, anniversary, profilePicture } = req.body;

      try {
        const result = await pool.query(
          `UPDATE users SET name = $1, gender = $2, address = $3, email = $4, birthday = $5, anniversary = $6, profile_picture = $7
           WHERE phone = $8 RETURNING *`,
          [name, gender, address, email, birthday, anniversary, profilePicture, phone]
        );
        if (result.rows.length) {
          success(res, result.rows[0], 'User updated');
        } else {
          error(res, RESPONSE_MESSAGES.USER_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
        }
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
      }
    }]
  ]
});

export default router;
