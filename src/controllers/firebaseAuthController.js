// src/controllers/firebaseAuthController.js

const db = require('../db');
const { normalizePhone } = require('../utils/phoneUtils');

/**
 * Handle Firebase phone number login
 */
exports.firebaseLogin = async (req, res) => {
  const phone = normalizePhone(req.body.phone);

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number is required' });
  }

  try {
    const queryResult = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    const profileExists = queryResult.rows.length > 0;

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      profileExists,
      user: profileExists ? {
        uid: queryResult.rows[0].uid,
        phone: queryResult.rows[0].phone,
        name: queryResult.rows[0].name,
      } : null,
    });
  } catch (error) {
    console.error('Firebase Login Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

/**
 * Handle user registration
 */
exports.registerUser = async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const { name, gender, email, birthday, anniversary, address } = req.body;

  if (!phone || !name) {
    return res.status(400).json({ success: false, message: 'Phone and Name are required' });
  }

  try {
    const existingUser = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (existingUser.rows.length > 0) {
      console.log('User already exists, returning existing user.');
      return res.status(200).json({
        success: true,
        message: 'User already exists',
        user: {
          uid: existingUser.rows[0].uid,
          phone: existingUser.rows[0].phone,
          name: existingUser.rows[0].name,
        },
      });
    }

    const insertQuery = `
      INSERT INTO users (phone, name, gender, email, birthday, anniversary, address)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;
    `;
    const values = [phone, name, gender, email, birthday, anniversary, address];
    const queryResult = await db.query(insertQuery, values);

    return res.status(201).json({
      success: true,
      message: 'User profile created',
      user: {
        uid: queryResult.rows[0].uid,
        phone: queryResult.rows[0].phone,
        name: queryResult.rows[0].name,
      },
    });
  } catch (error) {
    console.error('Register User Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};
