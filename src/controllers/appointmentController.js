// src/controllers/appointmentController.js

import pool from '../db.js';
import db from '../db.js';
import { success, error } from '../utils/responseHelper.js';
import { resolvePhoneFromUID } from '../utils/resolveIdentity.js';

/**
 * ✅ Book Appointment
 */
export async function bookAppointment(req, res) {
  const { phone, doctor_name, date, time } = req.body;

  if (!phone || !doctor_name || !date || !time) {
    return error(res, 'All fields (phone, doctor_name, date, time) are required', 400);
  }

  try {
    const result = await pool.query(
      'INSERT INTO appointments (phone, doctor_name, date, time) VALUES ($1, $2, $3, $4) RETURNING *',
      [phone, doctor_name, date, time]
    );
    return success(res, result.rows[0], 'Appointment booked');
  } catch (err) {
    return error(res, err.message || 'Database error', 500);
  }
}

/**
 * ✅ Get Appointments by UID
 */
export async function getAppointmentsByUID(req, res) {
  const { uid } = req.params;

  if (!uid) {
    return res.status(400).json({ success: false, message: 'UID is required' });
  }

  try {
    const phone = await resolvePhoneFromUID(uid);
    if (!phone) {
      return res.status(404).json({ success: false, message: 'UID not found in users table' });
    }

    const result = await db.query('SELECT * FROM appointments WHERE phone = $1 ORDER BY date DESC', [phone]);

    return success(res, result.rows, result.rows.length ? 'Appointments found' : 'No appointments found');
  } catch (error) {
    console.error('Get Appointments By UID Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * ✅ Get Appointments by Phone (with optional filters)
 */
export async function getAppointmentsByPhone(req, res) {
  const { phone } = req.params;
  const { filter, doctor_name, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  try {
    let baseQuery = 'SELECT * FROM appointments WHERE phone = $1';
    const queryParams = [phone];

    if (doctor_name) {
      baseQuery += ' AND LOWER(doctor_name) LIKE $2';
      queryParams.push(`%${doctor_name.toLowerCase()}%`);
    }

    baseQuery += ` ORDER BY date DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(limit, offset);

    const result = await pool.query(baseQuery, queryParams);

    let appointments = result.rows;
    const now = new Date();

    if (filter === 'upcoming') {
      appointments = appointments.filter(a => new Date(a.date) >= now);
    } else if (filter === 'past') {
      appointments = appointments.filter(a => new Date(a.date) < now);
    }

    return success(res, { page: parseInt(page), limit: parseInt(limit), data: appointments }, 'Appointments fetched');
  } catch (err) {
    return error(res, err.message || 'Database error', 500);
  }
}
