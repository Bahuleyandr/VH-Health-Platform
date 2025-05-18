// src/routes/pharmacyRoutes.js

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');
const pharmacyController = require('../controllers/pharmacyController');

// ✅ Handle UID lookup
router.get('/uid/:uid', pharmacyController.getPharmacyOrdersByUID);

// ✅ Place a new pharmacy order with optional file_key
router.post('/', async (req, res) => {
  const { phone, order_note, file_key } = req.body;

  if (!phone || !order_note) {
    return res.status(400).json({ error: 'Missing phone or order note' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO pharmacy_orders (phone, order_note, file_key) VALUES ($1, $2, $3) RETURNING *',
      [phone, order_note, file_key || null]
    );
    success(res, result.rows[0], 'Order placed successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// ✅ Get all pharmacy orders for a user by phone number
router.get('/:phone', async (req, res) => {
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

module.exports = router;
