// src/routes/investigationRoutes.js

const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();
const base = '/investigations';

// Create investigation request
router.post(`${base}`, async (req, res) => {
  const { phone, test_name } = req.body;

  if (!phone || !test_name) {
    return res.status(400).json({ error: 'Missing test/phone' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO investigations (phone, test_name) VALUES ($1, $2) RETURNING *',
      [phone, test_name]
    );
    success(res, result.rows[0], 'Investigation requested');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Fetch investigations by phone
router.get(`${base}/:phone`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM investigations WHERE phone = $1', [req.params.phone]);
    success(res, result.rows, 'Investigations fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Get all investigation requests by phone number
router.get(`${base}/:phoneNumber`, async (req, res) => {
  const { phoneNumber } = req.params;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM investigations WHERE phone = $1 ORDER BY created_at DESC', [phoneNumber]);
    success(res, result.rows, 'Investigations retrieved.');
  } catch (err) {
    logger.error(err);
    error(res, 'Failed to retrieve investigations.');
  }
});

module.exports = router;
