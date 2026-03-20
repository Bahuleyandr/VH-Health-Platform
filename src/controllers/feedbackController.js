// src/controllers/feedbackController.js

import db from '../config/database.js';
import logger from '../logging/logger.js';
import { resolvePhoneFromRequest, resolvePhoneFromUID } from '../utils/resolveIdentity.js';
import { success, error } from '../utils/responseHelper.js';

// ✅ Submit Feedback using resolved phone
// Supports both star-rating feedback and "Ask a Doubt" (question) from Flutter app.
// NOTE: DB migration required for question column:
//   ALTER TABLE feedback ADD COLUMN IF NOT EXISTS question TEXT;
export async function submitFeedback(req, res) {
  try {
    const phone = resolvePhoneFromRequest(req);
    const { rating, comment, question } = req.body;

    // phone is required; rating and question are both optional (at least one is expected)
    if (!phone) {
      return res.status(400).json({ error: 'Phone is required' });
    }

    // INSERT includes `question` column — requires DB migration if column doesn't exist yet
    const result = await db.query(
      'INSERT INTO feedback (phone, rating, comment, question) VALUES ($1, $2, $3, $4) RETURNING id, phone, rating, comment, question, created_at',
      [phone, rating || null, comment || null, question || null]
    );

    success(res, result.rows[0], 'Feedback submitted successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Failed to submit feedback');
  }
}

// ✅ Fetch Feedback by UID → resolved to phone
export async function getFeedbackByUID(req, res) {
  try {
    const uid = req.params.uid;
    const resolvedPhone = await resolvePhoneFromUID(uid);

    if (!resolvedPhone) {
      return res.status(404).json({ success: false, message: 'UID not found in users table' });
    }

    const result = await db.query('SELECT id, phone, rating, comment, created_at FROM feedback WHERE phone = $1', [resolvedPhone]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No feedback found for this phone' });
    }

    return res.status(200).json({ success: true, feedback: result.rows });
  } catch (error) {
    logger.error('Get Feedback By UID Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
