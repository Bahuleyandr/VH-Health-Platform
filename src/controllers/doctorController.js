// controllers/doctorController.js
const pool = require('../db');
const logger = require('../logger');
const { success, error } = require('../responseHelper');

exports.getAllDoctors = async (req, res) => {
  try {
    const { query } = req.query;

    if (!query) {
      const result = await pool.query('SELECT * FROM doctors ORDER BY name ASC');
      return success(res, result.rows, 'Doctors fetched successfully');
    }

    const searchPattern = `%${query.toLowerCase()}%`;
    const result = await pool.query(
      `SELECT * FROM doctors 
       WHERE LOWER(name) LIKE $1 OR LOWER(specialty) LIKE $1 
       ORDER BY name ASC`,
      [searchPattern]
    );

    success(res, result.rows, 'Doctor search results');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

exports.getDoctorById = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const result = await pool.query('SELECT * FROM doctors WHERE id = $1', [doctorId]);
    if (result.rows.length) {
      success(res, result.rows[0], 'Doctor profile found');
    } else {
      error(res, 'Doctor not found', 404);
    }
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};
