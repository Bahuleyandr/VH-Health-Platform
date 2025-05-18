// controllers/pharmacyController.js
const pool = require('../db');
const logger = require('../logging/logger');
const { success, error } = require('../utils/responseHelper');
const db = require('../db');

// ✅ Place Pharmacy Order with optional file_key
exports.placePharmacyOrder = async (req, res) => {
  const { phone, order_note, file_key } = req.body;
  if (!phone || !order_note) {
    return res.status(400).json({ error: 'Phone and order note are required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO pharmacy_orders (phone, order_note, file_key) VALUES ($1, $2, $3) RETURNING *',
      [phone, order_note, file_key || null]
    );
    success(res, result.rows[0], 'Pharmacy order placed');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

// ✅ Get Pharmacy Orders by Phone
exports.getPharmacyOrdersByPhone = async (req, res) => {
  try {
    const { phone } = req.params;

    const result = await pool.query(
      'SELECT * FROM pharmacy_orders WHERE phone = $1',
      [phone]
    );

    success(res, result.rows, 'Pharmacy orders fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
};

// ✅ Get Pharmacy Orders by UID
exports.getPharmacyOrdersByUID = async (req, res) => {
  const { uid } = req.params;
  console.log('📌 UID received:', uid);

  if (!uid) {
    return res.status(400).json({ success: false, message: 'UID is required' });
  }

  try {
    console.log('🔍 Fetching pharmacy orders for UID:', uid);

    const phoneResult = await db.query('SELECT phone FROM users WHERE uid = $1', [uid]);
    console.log('🔍 Resolved phone for UID:', phoneResult.rows);

    if (phoneResult.rows.length === 0) {
      console.log('❌ UID not found in users table.');
      return res.status(404).json({ success: false, message: 'UID not found in users table' });
    }

    const resolvedPhone = phoneResult.rows[0].phone;
    console.log('✅ Using resolved phone:', resolvedPhone);

    const result = await db.query('SELECT * FROM pharmacy_orders WHERE phone = $1', [resolvedPhone]);
    console.log('🔍 Pharmacy orders lookup result:', result.rows);

    if (result.rows.length === 0) {
      console.log('❌ No pharmacy orders found for this phone.');
      return res.status(404).json({ success: false, message: 'No pharmacy orders found for this phone' });
    }

    console.log('✅ Pharmacy orders found:', result.rows);
    return res.status(200).json({ success: true, pharmacyOrders: result.rows });

  } catch (error) {
    console.error('Get Pharmacy Orders By UID Error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
