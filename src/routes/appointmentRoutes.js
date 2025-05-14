// src/routes/appointmentRoutes.js

const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();
const base = '/appointments';

// Book appointment
router.post(`${base}`, async (req, res) => {
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

// Get appointments by phone with filters
router.get(`${base}/:phone`, async (req, res) => {
  try {
    const { phone } = req.params;
    const { filter, doctor_name, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let queryText = 'SELECT * FROM appointments WHERE phone = $1';
    const queryParams = [phone];

    if (doctor_name) {
      queryText += ' AND LOWER(doctor_name) LIKE $2';
      queryParams.push(`%${doctor_name.toLowerCase()}%`);
    }

    queryText += ' ORDER BY date DESC LIMIT $3 OFFSET $4';
    queryParams.push(limit, offset);

    const result = await pool.query(queryText, queryParams);

    let appointments = result.rows;
    if (filter === 'upcoming') {
      appointments = appointments.filter(a => new Date(a.date) >= new Date());
    } else if (filter === 'past') {
      appointments = appointments.filter(a => new Date(a.date) < new Date());
    }

    success(res, { page: parseInt(page), limit: parseInt(limit), data: appointments }, 'Appointments fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

module.exports = router;
