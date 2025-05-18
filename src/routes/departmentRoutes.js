// src/routes/departmentRoutes.js

const express = require('express');
const pool = require('../db');
const logger = require('../logging/logger');
const { success, error } = require('../utils/responseHelper');

const router = express.Router();

/**
 * @route GET /api/v1/departments/departments-with-doctors
 * @desc  Get all departments with their associated doctors
 */
router.get('/departments-with-doctors', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.id as department_id, d.name as department_name,
             json_agg(json_build_object('id', doc.id, 'name', doc.name, 'specialty', doc.specialty)) as doctors
      FROM departments d
      LEFT JOIN doctors doc ON doc.department_id = d.id
      GROUP BY d.id, d.name
      ORDER BY d.name ASC;
    `);

    success(res, result.rows, 'Departments with doctors fetched successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error while fetching departments with doctors');
  }
});

/**
 * @route GET /api/v1/departments
 * @desc  Get all departments
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY name ASC');
    success(res, result.rows, 'Departments fetched successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error while fetching departments');
  }
});

/**
 * @route GET /api/v1/departments/:departmentId
 * @desc  Get a single department by ID
 */
router.get('/:departmentId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments WHERE id = $1', [req.params.departmentId]);
    if (result.rows.length > 0) {
      success(res, result.rows[0], 'Department details found');
    } else {
      error(res, 'Department not found', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error while fetching department');
  }
});

module.exports = router;
