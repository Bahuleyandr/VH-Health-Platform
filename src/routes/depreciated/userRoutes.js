// src/routes/userRoutes.js
import express from 'express';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import pool from '../db.js';
import * as userController from '../controllers/userController.js';
import { userProfileValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();
console.log('✅ userRoutes loaded');

// ✅ FIXED: Changed from '/' to '/profile' to avoid root path conflicts
wrapAutoRBAC(
  router,
  'userRoutes',
  {
    post: [['/profile', userProfileValidator, userController.createOrUpdateUser]]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

// ✅ FIXED: Changed from '/' to '/list' and updated other paths
wrapAutoRBAC(router, 'userRoutes', {
  get: [
    ['/list', userController.getUsers], // Changed from '/' to '/list'
    ['/uid/:uid', userController.getUserByUID],
    [
      '/phone/:phone', // Changed from '/:phone' to '/phone/:phone' for clarity
      async (req, res) => {
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
      }
    ],
    [
      '/search',
      async (req, res) => {
        try {
          const page = parseInt(req.query.page) || 1;
          const limit = parseInt(req.query.limit) || 10;
          const offset = (page - 1) * limit;
          const queryRaw = req.query.query;
          const query = typeof queryRaw === 'string' ? `%${queryRaw.toLowerCase()}%` : null;
          
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
      }
    ]
  ],
  put: [
    ['/phone/:phone', userProfileValidator, userController.updateUser], // Changed from '/:phone' 
    ['/phone/:phone/role', userController.updateUserRole] // Changed from '/:phone/role'
  ]
});

export default router;