// src/routes/doctorRoutes.js

const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();

/**
 * @route GET /api/v1/doctors
 * @desc  Get all doctors or search by name/specialty using ?query=
 */
router.get('/', async (req, res) => {
  try {
    const { query } = req.query;
    let result;

    if (query) {
      const search = `%${query.toLowerCase()}%`;
      result = await pool.query(
        `SELECT * FROM doctors 
         WHERE LOWER(name) LIKE $1 OR LOWER(specialty) LIKE $1 
         ORDER BY name ASC`,
        [search]
      );
    } else {
      result = await pool.query('SELECT * FROM doctors ORDER BY name ASC');
    }

    success(res, result.rows, 'Doctors fetched successfully');
  } catch (err) {
    console.error('SQL Error:', err.stack || err.toString());
    logger.error(err.stack || err.toString());
    error(res, err.message || 'Database error while fetching doctors');
  }
});

/**
 * @route GET /api/v1/doctors/:doctorId
 * @desc  Get doctor profile by ID
 */
router.get('/:doctorId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM doctors WHERE id = $1', [req.params.doctorId]);
    if (result.rows.length) {
      success(res, result.rows[0], 'Doctor profile found');
    } else {
      error(res, 'Doctor not found', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error while fetching doctor profile');
  }
});

module.exports = router;
