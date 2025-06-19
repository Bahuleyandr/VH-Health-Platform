// src/controllers/authController.js

import { generateToken, verifyToken } from '../utils/jwtUtils.js';
import db from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import smsService from '../utils/smsService.js'; // 📱 Custom SMS service module

const MAGIC_LINK_EXPIRY_SECONDS = 600; // 10 minutes

/**
 * ✅ Send Magic Login Link (OTP-Free)
 */
export async function sendMagicLink(req, res) {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, error: 'Phone number is required' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = result.rows[0];

    // 🔐 Generate short-lived token for magic login
    const loginToken = generateToken(
      { uid: user.uid, phone: user.phone, role: user.role, magic: true },
      MAGIC_LINK_EXPIRY_SECONDS
    );

    const link = `https://vhhealth.in/magic-login?token=${loginToken}`;
    await smsService.sendSMS(phone, `Tap to login securely: ${link}`);

    success(res, null, 'Magic login link sent via SMS');
  } catch (err) {
    logger.error('Send Magic Link Error:', err.stack || err.toString());
    error(res, 'Could not send magic login link');
  }
}

/**
 * ✅ Verify Magic Login Token (OTP-Free)
 */
export async function verifyMagicToken(req, res) {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ success: false, error: 'Token is required' });
  }

  const decoded = verifyToken(token);

  if (!decoded || !decoded.magic) {
    return res.status(401).json({ success: false, error: 'Invalid or expired magic link' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = result.rows[0];
    const sessionToken = generateToken({
      uid: user.uid,
      phone: user.phone,
      role: user.role,
    });

    success(res, { token: sessionToken, user }, 'Login successful');
  } catch (err) {
    logger.error('Verify Magic Token Error:', err.stack || err.toString());
    error(res, 'Could not verify magic link');
  }
}

/**
 * ✅ Traditional User Registration
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

    const role = phone === '9962074440' ? 'ADMIN' : 'PATIENT';

    const insert = await db.query(
      'INSERT INTO users (phone, name, role, registered_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [phone, name, role]
    );

    const user = insert.rows[0];
    const token = generateToken({
      uid: user.uid,
      phone: user.phone,
      role: user.role,
    });

    success(res, { token, user }, 'Registration successful');
  } catch (err) {
    logger.error('Register Error:', err.stack || err.toString());
    error(res, 'Database error');
  }
}

/**
 * ✅ Refresh Token
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
    role: decoded.role,
  });

  success(res, { token: newToken }, 'Token refreshed successfully');
}

/**
 * ✅ Logout (Stateless)
 */
export async function logout(req, res) {
  success(res, {
    message: 'Logged out successfully (client should discard token)',
  });
}
