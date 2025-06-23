// src/routes/userRoutes.js - EMERGENCY SIMPLE VERSION (NO WRAPPER)
import express from 'express';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import pool from '../db.js';
import * as userController from '../controllers/userController.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();
console.log('✅ userRoutes loaded');

// ✅ SIMPLE ROUTES - No validation wrapper for now
router.post('/profile', (req, res) => {
  console.log('Create/Update user profile route hit');
  return userController.createOrUpdateUser(req, res);
});

router.get('/list', (req, res) => {
  console.log('Get users list route hit');
  return userController.getUsers(req, res);
});

router.get('/uid/:uid', (req, res) => {
  console.log('Get user by UID route hit');
  return userController.getUserByUID(req, res);
});

router.get('/phone/:phone', async (req, res) => {
  console.log('Get user by phone route hit');
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
});

router.get('/search', async (req, res) => {
  console.log('Search users route hit');
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
});

router.put('/phone/:phone', (req, res) => {
  console.log('Update user route hit');
  return userController.updateUser(req, res);
});

router.put('/phone/:phone/role', (req, res) => {
  console.log('Update user role route hit');
  return userController.updateUserRole(req, res);
});

// Test route
router.get('/test', (req, res) => {
  res.json({ message: 'User routes are working!' });
});

export default router;