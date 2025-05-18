// src/routes/adminDoctorRoutes.js

const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();

// ✅ Add or update a doctor
router.post('/', async (req, res) => {
  const { name, department, intro, imageUrl } = req.body;
  if (!name || !department) {
    return res.status(400).json({ error: 'Doctor name and department are required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO doctors (name, department, intro, image_url) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, department, intro, imageUrl]
    );
    success(res, result.rows[0], 'Doctor saved.');
  } catch (err) {
    console.error('SQL Error:', err.stack || err.toString());
    logger.error(err.stack || err.toString());
    error(res, err.message || 'Database error');
  }
});

// ✅ Delete a doctor by ID
router.delete('/:doctorId', async (req, res) => {
  const { doctorId } = req.params;
  try {
    await pool.query('DELETE FROM doctors WHERE id = $1', [doctorId]);
    success(res, null, 'Doctor deleted.');
  } catch (err) {
    logger.error(err);
    error(res, 'Failed to delete doctor.');
  }
});

module.exports = router;
