const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();

// Post SOS alert with phone and location
router.post('/sos-alert', async (req, res) => {
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
    logger.error(err);
    error(res, 'Failed to save SOS alert.');
  }
});

module.exports = router;
