// src/routes/sosRoutes.js
const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();

/**
 * @route POST /api/v1/sos-alert
 * @desc  Post SOS alert with phone and location
 */
router.post('/', async (req, res) => {
  const { phone, latitude, longitude } = req.body;

  if (!phone || !latitude || !longitude) {
    return res.status(400).json({ error: 'Phone, latitude, and longitude are required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO sos_alerts (phone, latitude, longitude, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *`,
      [phone, latitude, longitude]
    );
    success(res, result.rows[0], 'SOS alert saved.');
  } catch (err) {
    console.error('SQL Error:', err.stack || err.toString());
    logger.error(err.stack || err.toString());
    error(res, err.message || 'Database error');
  }
});

module.exports = router;
