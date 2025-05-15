const express = require('express');
const pool = require('../db');
const { success, error } = require('../utils/responseHelper');
const logger = require('../logging/logger');

const router = express.Router();

// Staff uploads consultation
router.post('/staff/consultations', async (req, res) => {
  const { phone, file_name, file_type } = req.body;
  if (!phone || !file_name || !file_type) {
    return res.status(400).json({ error: 'Phone, file name, and file type are required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO consultations (phone, file_name, file_type, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *`,
      [phone, file_name, file_type]
    );
    success(res, result.rows[0], 'Consultation uploaded.');
    } catch (err) {
    console.error('SQL Error:', err.stack || err.toString());
    logger.error(err.stack || err.toString());
    error(res, err.message || 'Database error');
  }
});

// Staff uploads investigation result
router.post('/staff/investigations', async (req, res) => {
  console.log('Incoming Investigation Request Body:', req.body);
  const { phone, test_name, result_file } = req.body;

  try {
    const query = `
      INSERT INTO investigations (phone, test_name, result_file, status, requested_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING *;
    `;
    const { rows } = await pool.query(query, [phone, test_name, result_file, 'pending']);

    console.log('Database Insert Result:', rows);

    if (!rows || rows.length === 0) {
      console.error('No rows returned from INSERT operation');
      return res.status(500).json({ success: false, message: 'No data returned after insert' });
    }

    console.log('Inserted Investigation:', rows[0]);
    res.json({ success: true, data: rows[0] });

  } catch (error) {
    console.error('Query Execution Error:', error);
    res.status(500).json({ success: false, message: 'Database error', error: error.message });
  }
});

// Staff fulfills pharmacy order
router.post('/staff/pharmacy-orders', async (req, res) => {
console.log('Incoming Pharmacy Order Request Body:', req.body);
  const { phone, order_id, status, notes } = req.body;
  if (!phone || !order_id || !status) {
    return res.status(400).json({ error: 'Phone, order ID, and status are required.' });
  }

  try {
    const result = await pool.query(
  `UPDATE pharmacy_orders SET status = $1, order_note = $2 WHERE id = $3 AND phone = $4 RETURNING *`,
  [status, notes || '', order_id, phone]
);
    if (result.rows.length === 0) {
  console.error('Database operation returned no rows:', result);
  return res.status(400).json({ error: 'No pharmacy order was updated.' });
}
success(res, result.rows[0], 'Pharmacy order updated.');

  } catch (err) {
    logger.error(err);
    error(res, 'Failed to update pharmacy order.');
  }
});

// Get staff attendance (dummy response for now)
router.get('/staff/attendance', async (req, res) => {
  // Replace with real attendance logic when available
  res.json({ message: 'Attendance feature not implemented yet' });
});

// Mark staff attendance (dummy response for now)
router.post('/staff/attendance', async (req, res) => {
  const { staffId, timestamp } = req.body;

  if (!staffId || !timestamp) {
    return res.status(400).json({ error: 'staffId and timestamp are required.' });
  }

  // Replace with real database storage logic when available
  res.json({ message: `Attendance marked for staffId ${staffId} at ${timestamp}` });
});

// Get staff roll-call status (dummy response for now)
router.get('/staff/roll-call', async (req, res) => {
  // Replace with real roll-call logic when available
  res.json({ message: 'Roll-call feature not implemented yet' });
});

module.exports = router;
