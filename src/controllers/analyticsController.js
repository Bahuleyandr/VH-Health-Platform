import db from '../config/database.js';
import { success, error } from '../utils/responseHelper.js';

/**
 * 📈 Daily user registrations (last 30 days)
 */
export async function getUserRegistrations(req, res) {
  try {
    const result = await db.query(`
      SELECT DATE(registered_at) as date, COUNT(*) as count
      FROM users
      WHERE registered_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(registered_at)
      ORDER BY DATE(registered_at) ASC
    `);
    success(res, result.rows, 'User registrations by day');
  } catch (err) {
    error(res, 'Failed to fetch registration stats');
  }
}

/**
 * 🔢 Counts of key entities
 */
export async function getEntityCounts(req, res) {
  try {
    const queries = await Promise.all([
      db.query('SELECT COUNT(*) FROM appointments'),
      db.query('SELECT COUNT(*) FROM health_records'),
      db.query('SELECT COUNT(*) FROM investigations')
    ]);
    const [appointments, records, investigations] = queries.map(r => parseInt(r.rows[0].count, 10));

    success(res, { appointments, records, investigations }, 'Entity counts');
  } catch (err) {
    error(res, 'Failed to fetch counts');
  }
}

/**
 * 🔥 Most active users (by appointment count)
 */
export async function getActiveUsers(req, res) {
  try {
    const result = await db.query(`
      SELECT phone, COUNT(*) as appointment_count
      FROM appointments
      GROUP BY phone
      ORDER BY appointment_count DESC
      LIMIT 10
    `);
    success(res, result.rows, 'Most active users');
  } catch (err) {
    error(res, 'Failed to fetch active user stats');
  }
}

/**
 * 🏥 Most active departments
 */
export async function getActiveDepartments(req, res) {
  try {
    const result = await db.query(`
      SELECT d.name AS department, COUNT(a.id) AS appointment_count
      FROM appointments a
      JOIN doctors doc ON a.doctor_id = doc.id
      JOIN departments d ON doc.department_id = d.id
      GROUP BY d.name
      ORDER BY appointment_count DESC
      LIMIT 10
    `);
    success(res, result.rows, 'Most active departments');
  } catch (err) {
    error(res, 'Failed to fetch department stats');
  }
}
