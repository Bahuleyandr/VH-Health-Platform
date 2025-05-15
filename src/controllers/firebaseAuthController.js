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
};
