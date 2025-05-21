// src/controllers/firebaseAuthController.js

import db from '../db.js';

/**
 * ✅ Handle Firebase phone number login
 */
export async function firebaseLogin(req, res) {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number is required' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    const profileExists = result.rows.length > 0;

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      profileExists,
      user: profileExists
        ? {
            uid: result.rows[0].uid,
            phone: result.rows[0].phone,
            name: result.rows[0].name,
          }
        : null,
    });
  } catch (error) {
    console.error('Firebase Login Error:', error.stack || error.toString());
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * ✅ Handle user registration (idempotent)
 */
export async function registerUser(req, res) {
  const { phone, name, gender, email, birthday, anniversary, address } = req.body;

  if (!phone || !name) {
    return res.status(400).json({ success: false, message: 'Phone and name are required' });
  }

  try {
    const existing = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);

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
    const result = await db.query(insertQuery, values);

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
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
