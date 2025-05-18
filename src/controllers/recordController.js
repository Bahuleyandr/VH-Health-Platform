// controllers/recordController.js
const pool = require('../db');
const logger = require('../logging/logger');
const { success, error } = require('../utils/responseHelper');
const db = require('../db');

// ✅ Add Health Record with file_key
exports.addHealthRecord = async (req, res) => {
  const { phone, file_key } = req.body;

  if (!phone || !file_key) {
    return res.status(400).json({ error: 'Phone and file_key are required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO health_records (phone, file_key) VALUES ($1, $2) RETURNING *',
      [phone, file_key]
    );
    success(res, result.rows[0], 'Health record added');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

// ✅ Get Health Records by Phone with optional type filtering
exports.getHealthRecordsByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    const { type } = req.query;

    const result = await pool.query('SELECT * FROM health_records WHERE phone = $1', [phone]);
    let records = result.rows;

    // Optional type filtering (kept if you still maintain file_type elsewhere)
    if (type) {
      records = records.filter(r => r.file_type && r.file_type.toLowerCase() === type.toLowerCase());
    }

    success(res, records, 'Health records fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

// ✅ Get Health Records by UID
exports.getRecordsByUID = async (req, res) => {
  const { uid } = req.params;
  console.log('📌 UID received:', uid);

  if (!uid) {
    return res.status(400).json({ success: false, message: 'UID is required' });
  }

  try {
    console.log('🔍 Fetching health records for UID:', uid);

    const phoneResult = await db.query('SELECT phone FROM users WHERE uid = $1', [uid]);
    console.log('🔍 Resolved phone for UID:', phoneResult.rows);

    if (phoneResult.rows.length === 0) {
      console.log('❌ UID not found in users table.');
      return res.status(404).json({ success: false, message: 'UID not found in users table' });
    }

    const resolvedPhone = phoneResult.rows[0].phone;
    console.log('✅ Using resolved phone:', resolvedPhone);

    const result = await db.query('SELECT * FROM health_records WHERE phone = $1', [resolvedPhone]);
    console.log('🔍 Health records lookup result:', result.rows);

    if (result.rows.length === 0) {
      console.log('❌ No health records found for this phone.');
      return res.status(404).json({ success: false, message: 'No health records found for this phone' });
    }

    console.log('✅ Health records found:', result.rows);
    return res.status(200).json({ success: true, records: result.rows });

  } catch (error) {
    console.error('Get Records By UID Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
