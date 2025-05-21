// src/controllers/doctorController.js

import pool from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';

/**
 * ✅ Get all doctors or search by name/specialty
 */
export async function getAllDoctors(req, res) {
  try {
    const { query } = req.query;

    if (!query) {
      const result = await pool.query(
        'SELECT * FROM doctors ORDER BY name ASC'
      );
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
    logger.error('[getAllDoctors]', err.stack || err.toString());
    error(res, 'Failed to fetch doctors');
  }
}

/**
 * ✅ Get doctor by ID
 */
export async function getDoctorById(req, res) {
  const { doctorId } = req.params;

  if (!doctorId) {
    return error(res, 'Doctor ID is required', 400);
  }

  try {
    const result = await pool.query(
      'SELECT * FROM doctors WHERE id = $1',
      [doctorId]
    );

    if (result.rows.length) {
      success(res, result.rows[0], 'Doctor profile found');
    } else {
      error(res, 'Doctor not found', 404);
    }
  } catch (err) {
    logger.error('[getDoctorById]', err.stack || err.toString());
    error(res, 'Failed to fetch doctor');
  }
}
