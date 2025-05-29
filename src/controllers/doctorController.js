import pool from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { logAudit } from '../utils/logAudit.js';

/**
 * ✅ Get all doctors or search by name/specialty
 */
export async function getAllDoctors(req, res) {
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
    const result = await pool.query('SELECT * FROM doctors WHERE id = $1', [doctorId]);

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

/**
 * ✅ Add a new doctor (ADMIN only)
 */
export async function addDoctor(req, res) {
  const { name, specialty, department_id } = req.body;

  if (!name || !specialty || !department_id) {
    return error(res, 'Name, specialty, and department_id are required', 400);
  }

  if (req.user?.role !== 'ADMIN') {
    return error(res, 'Only admins can add doctors', 403);
  }

  try {
    const result = await pool.query(
      `INSERT INTO doctors (name, specialty, department_id) 
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), specialty.trim(), department_id]
    );
    success(res, result.rows[0], 'Doctor added successfully');
  } catch (err) {
    logger.error('[addDoctor]', err.stack || err.toString());
    error(res, 'Failed to add doctor');
  }
}

/**
 * ✅ Delete doctor by ID (ADMIN only) with audit logging
 */
export async function deleteDoctor(req, res) {
  const { doctorId } = req.params;

  if (!doctorId) {
    return error(res, 'Doctor ID is required', 400);
  }

  if (req.user?.role !== 'ADMIN') {
    return error(res, 'Only admins can delete doctors', 403);
  }

  try {
    const result = await pool.query('DELETE FROM doctors WHERE id = $1 RETURNING *', [doctorId]);

    if (result.rows.length) {
      const deleted = result.rows[0];

      // ✅ Audit the deletion
      await logAudit(req, 'delete-doctor', {
        doctorId,
        name: deleted.name,
        specialty: deleted.specialty,
        department_id: deleted.department_id
      });

      success(res, deleted, 'Doctor deleted successfully');
    } else {
      error(res, 'Doctor not found', 404);
    }
  } catch (err) {
    logger.error('[deleteDoctor]', err.stack || err.toString());
    error(res, 'Failed to delete doctor');
  }
}
