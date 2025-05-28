// src/controllers/firebaseAuthController.js

import pool from '../db.js';
import admin from '../utils/firebaseAdmin.js';
import { generateToken } from '../utils/jwtUtils.js';

/**
 * ✅ Handle secure Firebase OTP login using ID token
 */
export async function firebaseLogin(req, res) {
  const { idToken } = req.body;

  if (!idToken) {
    return res
      .status(400)
      .json({ success: false, message: 'Firebase ID token is required' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const phone = decoded.phone_number;

    if (!phone) {
      return res
        .status(400)
        .json({ success: false, message: 'Phone number missing in ID token' });
    }

    const result = await pool.query('SELECT * FROM users WHERE phone = $1', [
      phone,
    ]);

    let user;
    if (result.rows.length === 0) {
      const insert = await pool.query(
        `INSERT INTO users (phone, created_at) VALUES ($1, NOW()) RETURNING *`,
        [phone],
      );
      user = insert.rows[0];
    } else {
      user = result.rows[0];
    }

    const accessToken = generateToken({ uid: user.uid, role: user.role });

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      accessToken,
      profile: {
        uid: user.uid,
        phone: user.phone,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('Firebase Login Error:', error.stack || error.toString());
    return res
      .status(401)
      .json({ success: false, message: 'Invalid Firebase ID token' });
  }
}

/**
 * ✅ Handle user registration (idempotent)
 */
export async function registerUser(req, res) {
  const { phone, name, gender, email, birthday, anniversary, address } =
    req.body;

  if (!phone || !name) {
    return res
      .status(400)
      .json({ success: false, message: 'Phone and name are required' });
  }

  try {
    const existing = await pool.query('SELECT * FROM users WHERE phone = $1', [
      phone,
    ]);

    if (existing.rows.length > 0) {
      return res.status(200).json({
        success: true,
        message: 'User already exists',
        user: {
          uid: existing.rows[0].uid,
          phone: existing.rows[0].phone,
          name: existing.rows[0].name,
        },
      });
    }

    const insertQuery = `
      INSERT INTO users (phone, name, gender, email, birthday, anniversary, address)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const values = [phone, name, gender, email, birthday, anniversary, address];
    const result = await pool.query(insertQuery, values);

    return res.status(201).json({
      success: true,
      message: 'User profile created',
      user: {
        uid: result.rows[0].uid,
        phone: result.rows[0].phone,
        name: result.rows[0].name,
      },
    });
  } catch (error) {
    console.error('Register User Error:', error.stack || error.toString());
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' });
  }
}
