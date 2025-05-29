// src/controllers/authController.js

import { generateToken, verifyToken } from '../utils/jwtUtils.js';
import db from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';

/**
 * ✅ User Login
 */
export async function login(req, res) {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, error: 'Phone is required' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = result.rows[0];
    const token = generateToken({
      uid: user.uid,
      phone: user.phone,
      role: user.role
    });

    success(res, { token }, 'Login successful');
  } catch (err) {
    logger.error('Login Error:', err.stack || err.toString());
    error(res, 'Database error');
  }
}

/**
 * ✅ User Registration (with ADMIN override)
 */
export async function register(req, res) {
  const { phone, name } = req.body;

  if (!phone || !name) {
    return res.status(400).json({ success: false, error: 'Phone and name are required' });
  }

  try {
    const existing = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);

    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'User already exists' });
    }

    // 🛠️ Automatically assign ADMIN role if phone is 9962074440
    const role = phone === '9962074440' ? 'ADMIN' : 'PATIENT';

    const insert = await db.query(
      'INSERT INTO users (phone, name, role, registered_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [phone, name, role]
    );

    const user = insert.rows[0];
    const token = generateToken({
      uid: user.uid,
      phone: user.phone,
      role: user.role
    });

    success(res, { token, user }, 'Registration successful');
  } catch (err) {
    logger.error('Register Error:', err.stack || err.toString());
    error(res, 'Database error');
  }
}

/**
 * ✅ Refresh Token (Stateless JWT)
 */
export async function refreshToken(req, res) {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, error: 'Token is required' });
  }

  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }

  const newToken = generateToken({
    uid: decoded.uid,
    phone: decoded.phone,
    role: decoded.role
  });

  success(res, { token: newToken }, 'Token refreshed successfully');
}

/**
 * ✅ Logout (stateless)
 */
export async function logout(req, res) {
  success(res, {
    message: 'Logged out successfully (client should discard token)'
  });
}
