// controllers/recordController.js
const pool = require('../db');
const logger = require('../logging/logger');
const { success, error } = require('../responseHelper');

exports.addHealthRecord = async (req, res) => {
  const { phone, file_name, file_type } = req.body;
  if (!phone || !file_name || !file_type) {
    return res.status(400).json({ error: 'All fields required' });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO health_records (phone, file_name, file_type)
      VALUES ($1, $2, $3)
      RETURNING *;
      `,
      [phone, file_name, file_type]
    );
    success(res, result.rows[0], 'Health record added');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

exports.getHealthRecordsByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    const { type } = req.query;

    const result = await pool.query(
      `
      SELECT * FROM health_records
      WHERE phone = $1;
      `,
      [phone]
    );

    let records = result.rows;

    if (type) {
      records = records.filter(r => r.file_type.toLowerCase() === type.toLowerCase());
    }

    success(res, records, 'Health records fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};
