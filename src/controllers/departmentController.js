// src/controllers/departmentController.js

import pool from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';

/**
 * ✅ Fetch all departments (alphabetical)
 */
export async function getAllDepartments(req, res) {
  try {
    const result = await pool.query(
      'SELECT * FROM departments ORDER BY name ASC'
    );
    success(res, result.rows, 'Departments fetched successfully');
  } catch (err) {
    logger.error('[getAllDepartments]', err.stack || err.toString());
    error(res, 'Failed to fetch departments');
  }
}

/**
 * ✅ Fetch department by ID
 */
export async function getDepartmentById(req, res) {
  const { departmentId } = req.params;

  if (!departmentId) {
    return error(res, 'Department ID is required', 400);
  }

  try {
    const result = await pool.query(
      'SELECT * FROM departments WHERE id = $1',
      [departmentId]
    );

    if (result.rows.length > 0) {
      success(res, result.rows[0], 'Department found');
    } else {
      error(res, 'Department not found', 404);
    }
  } catch (err) {
    logger.error('[getDepartmentById]', err.stack || err.toString());
    error(res, 'Failed to fetch department');
  }
}

/**
 * ✅ Fetch departments with their doctors
 */
export async function getDepartmentsWithDoctors(req, res) {
  try {
    const result = await pool.query(
      `SELECT d.id AS department_id, d.name AS department_name,
              json_agg(json_build_object('id', doc.id, 'name', doc.name)) AS doctors
       FROM departments d
       LEFT JOIN doctors doc ON doc.department_id = d.id
       GROUP BY d.id, d.name
       ORDER BY d.name ASC`
    );
    success(res, result.rows, 'Departments with doctors fetched');
  } catch (err) {
    logger.error('[getDepartmentsWithDoctors]', err.stack || err.toString());
    error(res, 'Failed to fetch department-doctor data');
  }
}
