// src/routes/pharmacyRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

// Place a new pharmacy order
router.post('/pharmacy-orders', async (req, res) => {
  const { phone, order_note } = req.body;
  if (!phone || !order_note) {
    return res.status(400).json({ error: 'Missing phone or order note' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO pharmacy_orders (phone, order_note) VALUES ($1, $2) RETURNING *',
      [phone, order_note]
    );
    success(res, result.rows[0], 'Order placed successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Get all pharmacy orders for a user
router.get('/pharmacy-orders/:phone', async (req, res) => {
  const { phone } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM pharmacy_orders WHERE phone = $1 ORDER BY id DESC',
      [phone]
    );
    success(res, result.rows, 'Pharmacy orders fetched successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Get all pharmacy orders by phone number
router.get(`/pharmacy-orders/:phoneNumber`, async (req, res) => {
  const { phoneNumber } = req.params;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM pharmacy_orders WHERE phone = $1 ORDER BY created_at DESC', [phoneNumber]);
    success(res, result.rows, 'Pharmacy orders retrieved.');
  } catch (err) {
    logger.error(err);
    error(res, 'Failed to retrieve pharmacy orders.');
  }
});

module.exports = router;
