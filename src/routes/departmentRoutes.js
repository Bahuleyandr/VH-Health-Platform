const express = require('express');
const pool = require('../db');
const logger = require('../logging/logger');
const { success, error } = require('../utils/responseHelper');

const router = express.Router();

// Get all departments
router.get('/departments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY name ASC');
    success(res, result.rows, 'Departments fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Get department by ID
router.get('/departments/:departmentId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments WHERE id = $1', [req.params.departmentId]);
    if (result.rows.length) {
      success(res, result.rows[0], 'Department details found');
    } else {
      error(res, 'Department not found', 404);
    }
    } catch (err) {
    console.error('SQL Error:', err.stack || err.toString());
    logger.error(err.stack || err.toString());
    error(res, err.message || 'Database error');
  }
});

// Get all departments with doctors (example join query, adjust as needed)
router.get('/departments-with-doctors', async (req, res) => {
  try {
    const departmentsResult = await pool.query('SELECT * FROM departments ORDER BY name ASC');

    const departmentsWithDoctors = await Promise.all(
      departmentsResult.rows.map(async (dept) => {
        const doctorsResult = await pool.query('SELECT * FROM doctors WHERE department = $1', [dept.name]);
        return {
          ...dept,
          doctors: doctorsResult.rows
        };
      })
    );

    res.json(departmentsWithDoctors);
  } catch (err) {
    logger.error(err.stack || err.toString());
    res.status(500).json({ error: 'Failed to fetch departments with doctors' });
  }
});

module.exports = router;
