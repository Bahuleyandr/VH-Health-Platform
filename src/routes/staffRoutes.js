const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();

// Staff uploads consultation
router.post('/staff/consultations', async (req, res) => {
  const { phone, file_name, file_type } = req.body;
  if (!phone || !file_name || !file_type) {
    return res.status(400).json({ error: 'Phone, file name, and file type are required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO consultations (phone, file_name, file_type, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *`,
      [phone, file_name, file_type]
    );
    success(res, result.rows[0], 'Consultation uploaded.');
  } catch (err) {
    logger.error(err);
    error(res, 'Failed to upload consultation.');
  }
});

// Staff uploads investigation result
router.post('/staff/investigations', async (req, res) => {
  const { phone, test_name, result_file } = req.body;
  if (!phone || !test_name || !result_file) {
    return res.status(400).json({ error: 'Phone, test name, and result file are required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO investigations (phone, test_name, result_file, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *`,
      [phone, test_name, result_file]
    );
    success(res, result.rows[0], 'Investigation result uploaded.');
  } catch (err) {
    logger.error(err);
    error(res, 'Failed to upload investigation result.');
  }
});

// Staff fulfills pharmacy order
router.post('/staff/pharmacy-orders', async (req, res) => {
  const { phone, order_id, status, notes } = req.body;
  if (!phone || !order_id || !status) {
    return res.status(400).json({ error: 'Phone, order ID, and status are required.' });
  }

  try {
    const result = await pool.query(
      `UPDATE pharmacy_orders SET status = $1, notes = $2 WHERE id = $3 AND phone = $4 RETURNING *`,
      [status, notes || '', order_id, phone]
    );
    success(res, result.rows[0], 'Pharmacy order updated.');
  } catch (err) {
    logger.error(err);
    error(res, 'Failed to update pharmacy order.');
  }
});

module.exports = router;
