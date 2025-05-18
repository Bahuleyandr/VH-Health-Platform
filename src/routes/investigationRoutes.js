// src/routes/investigationRoutes.js

const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');
const router = express.Router();
const investigationController = require('../controllers/investigationController');

// ✅ Fetch investigations by UID
router.get('/uid/:uid', investigationController.getInvestigationsByUID);

// ✅ Create investigation request with optional file_key
router.post('/', async (req, res) => {
  const { phone, test_name, file_key } = req.body;

  if (!phone || !test_name) {
    return res.status(400).json({ error: 'Missing phone or test name' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO investigations (phone, test_name, file_key) VALUES ($1, $2, $3) RETURNING *',
      [phone, test_name, file_key || null]
    );
    success(res, result.rows[0], 'Investigation requested successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// ✅ Fetch investigations by phone
router.get('/:phone', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM investigations WHERE phone = $1',
      [req.params.phone]
    );
    success(res, result.rows, 'Investigations fetched successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

module.exports = router;
