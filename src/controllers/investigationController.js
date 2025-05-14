// controllers/investigationController.js
const pool = require('../db');
const logger = require('../logger');
const { success, error } = require('../responseHelper');

exports.addInvestigation = async (req, res) => {
  const { phone, test_name } = req.body;
  if (!phone || !test_name) {
    return res.status(400).json({ error: 'Phone and test name are required' });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO investigations (phone, test_name)
      VALUES ($1, $2)
      RETURNING *;
      `,
      [phone, test_name]
    );
    success(res, result.rows[0], 'Investigation requested');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

exports.getInvestigationsByPhone = async (req, res) => {
  try {
    const { phone } = req.params;

    const result = await pool.query(
      `
      SELECT * FROM investigations
      WHERE phone = $1;
      `,
      [phone]
    );

    success(res, result.rows, 'Investigations fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};
