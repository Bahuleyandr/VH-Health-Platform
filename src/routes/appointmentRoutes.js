const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');
const appointmentController = require('../controllers/appointmentController');

const router = express.Router();

// ✅ Book appointment - POST /api/v1/appointments
router.post('/', async (req, res) => {
  const { phone, doctor_name, date, time } = req.body;
  if (!phone || !doctor_name || !date || !time) {
    return res.status(400).json({ error: 'All fields required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO appointments (phone, doctor_name, date, time) VALUES ($1, $2, $3, $4) RETURNING *',
      [phone, doctor_name, date, time]
    );
    success(res, result.rows[0], 'Appointment booked');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// ✅ Get appointments by phone - GET /api/v1/appointments/:phone
router.get('/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const result = await pool.query('SELECT * FROM appointments WHERE phone = $1 ORDER BY date DESC', [phone]);
    success(res, result.rows, 'Appointments fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// ✅ Get appointments by UID - GET /api/v1/appointments/uid/:uid
router.get('/uid/:uid', appointmentController.getAppointmentsByUID);

module.exports = router;
