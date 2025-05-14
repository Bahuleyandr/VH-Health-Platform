// controllers/departmentController.js
const pool = require('../db');
const logger = require('../logger');
const { success, error } = require('../responseHelper');

exports.getAllDepartments = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY name ASC');
    success(res, result.rows, 'Departments fetched successfully');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

exports.getDepartmentById = async (req, res) => {
  try {
    const { departmentId } = req.params;
    const result = await pool.query('SELECT * FROM departments WHERE id = $1', [departmentId]);
    if (result.rows.length) {
      success(res, result.rows[0], 'Department found');
    } else {
      error(res, 'Department not found', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};
