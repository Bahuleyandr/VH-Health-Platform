// src/routes/feedbackRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

// Submit feedback
router.post('/feedback', async (req, res) => {
  const { phoneNumber, rating, comment } = req.body;
  if (!phoneNumber || !rating) {
    return res.status(400).json({ error: 'Required: phoneNumber & rating' });
  }

  try {
    const result = await pool.query(
  'INSERT INTO feedback (phonenumber, rating, comment) VALUES ($1, $2, $3) RETURNING *',
  [phoneNumber, rating, comment || null]
);
    success(res, result.rows[0], 'Feedback submitted successfully');
    } catch (err) {
    console.error('SQL Error:', err.stack || err.toString());
    logger.error(err.stack || err.toString());
    error(res, err.message || 'Database error');
  }
});

module.exports = router;
