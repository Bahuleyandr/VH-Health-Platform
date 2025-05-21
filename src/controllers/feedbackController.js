// src/controllers/feedbackController.js

import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import db from '../db.js';
import { resolvePhoneFromRequest, resolvePhoneFromUID } from '../utils/resolveIdentity.js';

// ✅ Submit Feedback using resolved phone
export async function submitFeedback(req, res) {
  try {
    const phone = resolvePhoneFromRequest(req);
    const { rating, comment } = req.body;

    if (!phone || !rating) {
      return res.status(400).json({ error: 'Phone and rating are required' });
    }

    const result = await db.query(
      'INSERT INTO feedback (phonenumber, rating, comment) VALUES ($1, $2, $3) RETURNING *',
      [phone, rating, comment || null]
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

    const result = await db.query('SELECT * FROM feedback WHERE phonenumber = $1', [resolvedPhone]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No feedback found for this phone' });
    }

    return res.status(200).json({ success: true, feedback: result.rows });
  } catch (error) {
    logger.error('Get Feedback By UID Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
