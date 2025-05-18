// src/controllers/authController.js
const { generateToken, verifyToken } = require('../utils/jwtUtils');
const db = require('../db');
const logger = require('../logging/logger');
const { success, error } = require('../utils/responseHelper');

// ✅ User Login
exports.login = async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, error: 'Phone is required' });
  }

  try {
    const userResult = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = userResult.rows[0];
    const token = generateToken({ uid: user.uid, phone: user.phone });

    success(res, { token }, 'Login successful');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

// ✅ User Registration
exports.register = async (req, res) => {
  const { phone, name } = req.body;
  if (!phone || !name) {
    return res.status(400).json({ success: false, error: 'Phone and name are required' });
  }

  try {
    const existingUser = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'User already exists' });
    }

    const newUser = await db.query(
      'INSERT INTO users (phone, name, registered_at) VALUES ($1, $2, NOW()) RETURNING *',
      [phone, name]
    );

    const user = newUser.rows[0];
    const token = generateToken({ uid: user.uid, phone: user.phone });

    success(res, { token, user }, 'Registration successful');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

// ✅ Refresh Token (Stateless - Requires Same Token Verification)
exports.refreshToken = async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ success: false, error: 'Token is required' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }

  const newToken = generateToken({ uid: decoded.uid, phone: decoded.phone });
  success(res, { token: newToken }, 'Token refreshed successfully');
};

// ✅ Logout (Mock - Stateless)
exports.logout = async (req, res) => {
  // In stateless JWT, logout is typically handled on client-side by deleting the token.
  success(res, { message: 'Logged out successfully (client should discard token)' });
};
