// src/controllers/appointmentController.js
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const db = require('../db');

exports.bookAppointment = async (req, res) => {
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
};

exports.getAppointmentsByUID = async (req, res) => {
  const { uid } = req.params;

  if (!uid) {
    return res.status(400).json({ success: false, message: 'UID is required' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM appointments WHERE phone = (SELECT phone FROM users WHERE uid = $1)',
      [uid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No appointments found for this UID' });
    }

    return res.status(200).json({ success: true, appointments: result.rows });
  } catch (error) {
    console.error('Get Appointments By UID Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

exports.getAppointmentsByPhone = async (req, res) => {
  const { phone } = req.params;
  const { filter, doctor_name, page = 1, limit = 10 } = req.query;
  const offset = (page - 1) * limit;

  let baseQuery = 'SELECT * FROM appointments WHERE phone = $1';
  const queryParams = [phone];

  if (doctor_name) {
    baseQuery += ' AND LOWER(doctor_name) LIKE $2';
    queryParams.push(`%${doctor_name.toLowerCase()}%`);
  }

  baseQuery += ' ORDER BY date DESC LIMIT $3 OFFSET $4';
  queryParams.push(limit, offset);

  try {
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
};
