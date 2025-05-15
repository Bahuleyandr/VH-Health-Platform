// src/routes/recordRoutes.js

const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();
const base = '/health-records';

// Add health record
router.post(`${base}`, async (req, res) => {
  const { phone, file_name, file_type } = req.body;
  if (!phone || !file_name || !file_type) {
    return res.status(400).json({ error: 'All fields required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO health_records (phone, file_name, file_type) VALUES ($1, $2, $3) RETURNING *',
      [phone, file_name, file_type]
    );
    success(res, result.rows[0], 'Health record added');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Get health records by phone with optional type filter
router.get(`${base}/:phone`, async (req, res) => {
  try {
    const { phone } = req.params;
    const { type } = req.query;

    const result = await pool.query('SELECT * FROM health_records WHERE phone = $1', [phone]);
    let records = result.rows;

    if (type) {
      records = records.filter(r => r.file_type.toLowerCase() === type.toLowerCase());
    }

    success(res, records, 'Health records fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Get all health records by phone number
router.get(`${base}/:phoneNumber`, async (req, res) => {
  const { phoneNumber } = req.params;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM health_records WHERE phone = $1 ORDER BY created_at DESC', [phoneNumber]);
    success(res, result.rows, 'Health records retrieved.');
  } catch (err) {
    logger.error(err);
    error(res, 'Failed to retrieve health records.');
  }
});

// Get all consultations by phone number
router.get(`/consultations/:phoneNumber`, async (req, res) => {
  const { phoneNumber } = req.params;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM consultations WHERE phone = $1 ORDER BY created_at DESC', [phoneNumber]);
    success(res, result.rows, 'Consultations retrieved.');
  } catch (err) {
    logger.error(err);
    error(res, 'Failed to retrieve consultations.');
  }
});

module.exports = router;
