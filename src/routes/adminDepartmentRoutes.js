const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();

// Add or update a department
router.post('/admin/departments', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Department name is required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *`,
      [name]
    );
    success(res, result.rows[0] || { message: 'Department already exists.' }, 'Department saved.');
  } catch (err) {
    logger.error(err);
    error(res, 'Failed to save department.');
  }
});

// Delete a department by ID
router.delete('/admin/departments/:deptId', async (req, res) => {
  const { deptId } = req.params;
  try {
    await pool.query('DELETE FROM departments WHERE id = $1', [deptId]);
    success(res, null, 'Department deleted.');
  } catch (err) {
    logger.error(err);
    error(res, 'Failed to delete department.');
  }
});

module.exports = router;
