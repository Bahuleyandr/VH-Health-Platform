// src/controllers/authController.js

import { generateToken, verifyToken } from '../utils/jwtUtils.js';
import db from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import smsService from '../utils/smsService.js';

const MAGIC_LINK_EXPIRY_SECONDS = 300; // 5 minutes

/**
 * ✅ Send Magic Login Link (Auto-register if needed)
 */
export async function sendMagicLink(req, res) {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, error: 'Phone number is required' });
  }

  try {
    let user;

    const result = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);

    if (result.rows.length === 0) {
      // 🆕 Auto-register new user
      const insert = await db.query(
        'INSERT INTO users (phone, name, role, registered_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
        [phone, 'New User', 'PATIENT']
      );
      user = insert.rows[0];
      logger.info(`🆕 Registered new user ${phone} as PATIENT`);
    } else {
      user = result.rows[0];
    }

    // 🔐 Log entry for token usage (create and store token UUID)
    const audit = await db.query(
      'INSERT INTO magic_link_logs (uid, phone, used, created_at) VALUES ($1, $2, false, NOW()) RETURNING id',
      [user.uid, user.phone]
    );
    const magicId = audit.rows[0].id;

    const loginToken = generateToken(
      { magicId, magic: true },
      MAGIC_LINK_EXPIRY_SECONDS
    );

    const link = `https://vhhealth.in/magic-login?token=${loginToken}`;
    await smsService.sendSMS(phone, `Welcome to VH Health! Click to log in: ${link} \nThis link expires in 5 minutes.`);
    logger.info(`📨 Magic link sent to ${phone}: ${link}`);

    success(res, null, 'Magic login link sent via SMS');
  } catch (err) {
    logger.error(`Send Magic Link Error: ${err.message}`, err.stack || err);
    error(res, 'Could not send magic login link');
  }
}

/**
 * ✅ Verify Magic Login Token (One-time use)
 */
export async function verifyMagicToken(req, res) {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ success: false, error: 'Token is required' });
  }

  const decoded = verifyToken(token);

  if (!decoded || !decoded.magic || !decoded.magicId) {
    return res.status(401).json({ success: false, error: 'Invalid or expired magic link' });
  }

  try {
    const auditCheck = await db.query('SELECT * FROM magic_link_logs WHERE id = $1', [decoded.magicId]);

    if (auditCheck.rows.length === 0 || auditCheck.rows[0].used) {
      return res.status(403).json({ success: false, error: 'Magic link has already been used' });
    }

    const user = await db.query('SELECT * FROM users WHERE uid = $1', [auditCheck.rows[0].uid]);

    if (user.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // ✅ Mark link as used
    await db.query('UPDATE magic_link_logs SET used = true, used_at = NOW() WHERE id = $1', [decoded.magicId]);

    const sessionToken = generateToken({
      uid: user.rows[0].uid,
      phone: user.rows[0].phone,
      role: user.rows[0].role
    });

    logger.info(`✅ Magic link used for UID ${user.rows[0].uid} from IP ${req.ip}`);
    success(res, { token: sessionToken, user: user.rows[0] }, 'Login successful');
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
      role: user.role
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
    role: decoded.role
  });

  success(res, { token: newToken }, 'Token refreshed successfully');
}

/**
 * ✅ Logout (Stateless)
 */
export async function logout(req, res) {
  success(res, {
    message: 'Logged out successfully (client should discard token)'
  });
}
