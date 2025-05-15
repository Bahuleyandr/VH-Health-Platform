// src/controllers/firebaseAuthController.js

const db = require('../db'); // Assuming you have a database connection utility

/**
 * Handle Firebase phone number login
 */
exports.firebaseLogin = async (req, res) => {
  const { phone } = req.body;

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
      user: profileExists ? queryResult.rows[0] : null,
    });
  } catch (error) {
    console.error('Firebase Login Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
exports.registerUser = async (req, res) => {
  const { phone, name, gender, email, birthday, anniversary, address } = req.body;

  if (!phone || !name) {
    return res.status(400).json({ success: false, message: 'Phone and Name are required' });
  }

  try {
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
      user: queryResult.rows[0],
    });
  } catch (error) {
    console.error('Register User Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
