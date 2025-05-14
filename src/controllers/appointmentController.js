// src/controllers/appointmentController.js
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');

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
