// src/routes/doctorRoutes.js

const express = require('express');
const pool = require('../utils/db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();
const base = '/doctors';

// Get all doctors or search by name/specialty
router.get(`${base}`, async (req, res) => {
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

    success(res, result.rows, 'Doctors fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// Get doctor profile by ID
router.get(`${base}/:doctorId`, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM doctors WHERE id=$1', [req.params.doctorId]);
    if (result.rows.length) {
      success(res, result.rows[0], 'Doctor profile found');
    } else {
      error(res, 'Doctor not found', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

module.exports = router;
