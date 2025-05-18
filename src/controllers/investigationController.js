// controllers/investigationController.js
const pool = require('../db');
const logger = require('../logging/logger');
const { success, error } = require('../utils/responseHelper');
const db = require('../db');

// ✅ Add Investigation with optional file_key
exports.addInvestigation = async (req, res) => {
  const { phone, test_name, file_key } = req.body;
  if (!phone || !test_name) {
    return res.status(400).json({ error: 'Phone and test name are required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO investigations (phone, test_name, file_key) VALUES ($1, $2, $3) RETURNING *',
      [phone, test_name, file_key || null]
    );
    success(res, result.rows[0], 'Investigation requested');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

// ✅ Get Investigations by Phone
exports.getInvestigationsByPhone = async (req, res) => {
  try {
    const { phone } = req.params;

    const result = await pool.query(
      'SELECT * FROM investigations WHERE phone = $1',
      [phone]
    );

    success(res, result.rows, 'Investigations fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

// ✅ Get Investigations by UID
exports.getInvestigationsByUID = async (req, res) => {
  const { uid } = req.params;
  console.log('📌 UID received:', uid);

  if (!uid) {
    return res.status(400).json({ success: false, message: 'UID is required' });
  }

  try {
    console.log('🔍 Fetching investigations for UID:', uid);

    const phoneResult = await db.query('SELECT phone FROM users WHERE uid = $1', [uid]);
    console.log('🔍 Resolved phone for UID:', phoneResult.rows);

    if (phoneResult.rows.length === 0) {
      console.log('❌ UID not found in users table.');
      return res.status(404).json({ success: false, message: 'UID not found in users table' });
    }

    const resolvedPhone = phoneResult.rows[0].phone;
    console.log('✅ Using resolved phone:', resolvedPhone);

    const result = await db.query('SELECT * FROM investigations WHERE phone = $1', [resolvedPhone]);
    console.log('🔍 Investigations lookup result:', result.rows);

    if (result.rows.length === 0) {
      console.log('❌ No investigations found for this phone.');
      return res.status(404).json({ success: false, message: 'No investigations found for this phone' });
    }

    console.log('✅ Investigations found:', result.rows);
    return res.status(200).json({ success: true, investigations: result.rows });

  } catch (error) {
    console.error('Get Investigations By UID Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
