// src/routes/userRoutes.js

const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();
const base = '/users';

// Create or update user profile
router.post(`${base}`, async (req, res) => {
  const { phoneNumber, name, gender, address, email, birthday, anniversary, profilePicture } = req.body;
  if (!phoneNumber || !name || !gender) {
    return res.status(400).json({ error: 'Required fields missing.' });
  }

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
      [phoneNumber, name, gender, address, email, birthday, anniversary, profilePicture]
    );
    success(res, result.rows[0], 'User saved');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Get user profile by phone
router.get(`${base}/:phone`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [req.params.phone]);
    if (result.rows.length) {
      success(res, result.rows[0], 'User found');
    } else {
      error(res, 'User not found', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Update user profile by phone
router.put(`${base}/:phone`, async (req, res) => {
  const { name, gender, address, email, birthday, anniversary, profilePicture } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users SET name = $1, gender = $2, address = $3, email = $4, birthday = $5, anniversary = $6, profile_picture = $7
       WHERE phone = $8 RETURNING *`,
      [name, gender, address, email, birthday, anniversary, profilePicture, req.params.phone]
    );
    if (result.rows.length) {
      success(res, result.rows[0], 'User updated');
    } else {
      error(res, 'User not found', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// List users with optional search
router.get(`${base}`, async (req, res) => {
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
    error(res, 'Database error');
  }
});

module.exports = router;
