// controllers/feedbackController.js
const logger = require('../logging/logger');
const { success, error } = require('../utils/responseHelper');
const db = require('../db');

exports.submitFeedback = async (req, res) => {
  const { phoneNumber, rating, comment } = req.body;

  if (!phoneNumber || !rating) {
    return res.status(400).json({ error: 'phoneNumber and rating are required' });
  }

  try {
    const result = await db.query(
      'INSERT INTO feedback (phonenumber, rating, comment) VALUES ($1, $2, $3) RETURNING *',
      [phoneNumber, rating, comment || null]
    );
    success(res, result.rows[0], 'Feedback submitted successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Failed to submit feedback');
  }
};

exports.getFeedbackByUID = async (req, res) => {
  const { uid } = req.params;
console.log('📌 UID received:', uid);

const phoneResult = await db.query('SELECT phone FROM users WHERE uid = $1', [uid]);
console.log('📌 Phone resolved:', phoneResult.rows);

  if (!uid) {
    return res.status(400).json({ success: false, message: 'UID is required' });
  }

  try {
    console.log('🔍 Fetching feedback for UID:', uid);

    const phoneResult = await db.query('SELECT phone FROM users WHERE uid = $1', [uid]);
    console.log('🔍 Resolved phone for UID:', phoneResult.rows);

    if (phoneResult.rows.length === 0) {
      console.log('❌ UID not found in users table.');
      return res.status(404).json({ success: false, message: 'UID not found in users table' });
    }

    const resolvedPhone = phoneResult.rows[0].phone;
    console.log('✅ Using resolved phone:', resolvedPhone);

    const result = await db.query('SELECT * FROM feedback WHERE phonenumber = $1', [resolvedPhone]);
    console.log('🔍 Feedback lookup result:', result.rows);

    if (result.rows.length === 0) {
      console.log('❌ No feedback found for this phone.');
      return res.status(404).json({ success: false, message: 'No feedback found for this phone' });
    }

    console.log('✅ Feedback found:', result.rows);
    return res.status(200).json({ success: true, feedback: result.rows });

  } catch (error) {
    console.error('Get Feedback By UID Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
