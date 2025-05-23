// src/controllers/userController.js

import pool from '../db.js';
import db from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { ADMIN, PATIENT, DOCTOR, HR_STAFF, GENERAL_STAFF } from '../utils/roles.js';

export async function createOrUpdateUser(req, res) {
  const {
    phone,
    name,
    gender,
    address,
    email,
    birthday,
    anniversary,
    profilePicture,
    role: requestedRole
  } = req.body;

  logger.info('✅ createOrUpdateUser invoked');
  logger.info(`🔎 Processing user with phone=${phone}`);

  if (!phone || !name || !gender) {
    return res.status(400).json({ error: 'Required fields missing.' });
  }

  const allowedRoles = [PATIENT, DOCTOR, ADMIN, HR_STAFF, GENERAL_STAFF];
  let role = PATIENT;

  if (req.user?.role === ADMIN && allowedRoles.includes(requestedRole)) {
    role = requestedRole;
  }

  logger.info(`👤 User ${phone} saved with role '${role}' by ${req.user?.role || 'anonymous'} (${req.user?.uid || 'unknown'})`);

  try {
    const result = await pool.query(
      `INSERT INTO users (phone, name, gender, address, email, birthday, anniversary, profile_picture, role, registered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         name = EXCLUDED.name,
         gender = EXCLUDED.gender,
         address = EXCLUDED.address,
         email = EXCLUDED.email,
         birthday = EXCLUDED.birthday,
         anniversary = EXCLUDED.anniversary,
         profile_picture = EXCLUDED.profile_picture,
         role = EXCLUDED.role
       RETURNING *`,
      [phone, name, gender, address, email, birthday, anniversary, profilePicture, role]
    );
    success(res, result.rows[0], 'User saved');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

export async function getUserByPhone(req, res) {
  try {
    const { phone } = req.params;
    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (result.rows.length > 0) {
      success(res, result.rows[0], 'User found');
    } else {
      error(res, 'User not found', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

export async function updateUser(req, res) {
  const phone = req.params.phone;
  const {
    name,
    gender,
    address,
    email,
    birthday,
    anniversary,
    profilePicture,
    role: requestedRole
  } = req.body;

  const allowedRoles = [PATIENT, DOCTOR, ADMIN, HR_STAFF, GENERAL_STAFF];
  let roleUpdateClause = '';
  let roleParam = null;

  if (req.user?.role === ADMIN && allowedRoles.includes(requestedRole)) {
    roleUpdateClause = ', role = $9';
    roleParam = requestedRole;
  }

  try {
    const query = `UPDATE users
       SET name = $1, gender = $2, address = $3, email = $4, birthday = $5, anniversary = $6, profile_picture = $7${roleUpdateClause}
       WHERE phone = $8
       RETURNING *`;

    const values = roleParam
      ? [name, gender, address, email, birthday, anniversary, profilePicture, phone, roleParam]
      : [name, gender, address, email, birthday, anniversary, profilePicture, phone];

    const result = await pool.query(query, values);

    if (result.rows.length > 0) {
      success(res, result.rows[0], 'User updated');
    } else {
      error(res, 'User not found', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

export async function getUsers(req, res) {
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
        `SELECT * FROM users
         ORDER BY registered_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
    }

    success(res, { page, limit, data: result.rows }, 'User list fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

export async function getUserByUID(req, res) {
  try {
    const { uid } = req.params;
    const result = await pool.query('SELECT * FROM users WHERE uid = $1', [uid]);
    if (result.rows.length > 0) {
      success(res, result.rows[0], 'User found by UID');
    } else {
      error(res, 'User not found by UID', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

export async function lookupUser(req, res) {
  const { phone, uid, name } = req.query;

  if (!phone && !uid && !name) {
    return res.status(400).json({ success: false, message: 'Provide phone, uid, or name to search' });
  }

  try {
    let result;

    if (phone) {
      result = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    } else if (uid) {
      result = await db.query('SELECT * FROM users WHERE uid = $1', [uid]);
    } else if (name) {
      result = await db.query(
        'SELECT * FROM users WHERE LOWER(name) LIKE $1',
        [`%${name.toLowerCase()}%`]
      );
    }

    if (!result || result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No matching users found' });
    }

    return res.status(200).json({ success: true, users: result.rows });
  } catch (err) {
    console.error('User Lookup Error:', err.stack || err.toString());
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
