// /src/routes/departmentRoutes.js
const express = require('express');
const pool = require('../db');
const logger = require('../logger');
const { success, error } = require('../utils/responseHelper');

const router = express.Router();
const base = '/api/v1';

// Get all departments
router.get(`${base}/departments`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY name ASC');
    success(res, result.rows, 'Departments fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Get department by ID
router.get(`${base}/departments/:departmentId`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments WHERE id = $1', [req.params.departmentId]);
    if (result.rows.length) {
      success(res, result.rows[0], 'Department details found');
    } else {
      error(res, 'Department not found', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

module.exports = router;
