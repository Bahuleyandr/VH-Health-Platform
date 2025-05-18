const express = require('express');
const router = express.Router();
const pool = require('../db');
const logger = require('../logging/logger');
const { success, error } = require('../utils/responseHelper');
const rbac = require('../middleware/rbacMiddleware');
const { NURSING_STAFF, LAB_STAFF, PHARMACY_STAFF, GENERAL_STAFF, HR_STAFF, DOCTOR } = require('../utils/roles');

// ✅ Upload Consultation (Nursing Staff, Doctor)
router.post('/consultations', rbac([NURSING_STAFF, DOCTOR]), async (req, res) => {
  const { phone, file_key } = req.body;

  if (!phone || !file_key) {
    return res.status(400).json({ error: 'Phone and file_key are required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO consultations (phone, file_key, created_at) VALUES ($1, $2, NOW()) RETURNING *`,
      [phone, file_key]
    );
    success(res, result.rows[0], 'Consultation uploaded.');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// ✅ Upload Investigation Result (Lab Staff)
router.post('/investigations', rbac([LAB_STAFF]), async (req, res) => {
  const { phone, test_name, file_key } = req.body;

  if (!phone || !test_name || !file_key) {
    return res.status(400).json({ error: 'Phone, test_name, and file_key are required.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO investigations (phone, test_name, file_key, status, requested_at) VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP) RETURNING *`,
      [phone, test_name, file_key]
    );
    success(res, result.rows[0], 'Investigation requested.');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// ✅ Fulfill Pharmacy Order (Pharmacy Staff)
router.post('/pharmacy-orders', rbac([PHARMACY_STAFF]), async (req, res) => {
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
      return res.status(400).json({ error: 'No pharmacy order was updated.' });
    }

    success(res, result.rows[0], 'Pharmacy order updated.');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// ✅ Attendance Management (All Staff Roles)
router.get('/attendance', rbac([NURSING_STAFF, LAB_STAFF, PHARMACY_STAFF, GENERAL_STAFF, HR_STAFF, DOCTOR]), (req, res) => {
  res.json({ message: 'Attendance feature not implemented yet' });
});

router.post('/attendance', rbac([NURSING_STAFF, LAB_STAFF, PHARMACY_STAFF, GENERAL_STAFF, HR_STAFF, DOCTOR]), (req, res) => {
  const { staffId, timestamp } = req.body;
  if (!staffId || !timestamp) {
    return res.status(400).json({ error: 'staffId and timestamp are required.' });
  }
  res.json({ message: `Attendance marked for staffId ${staffId} at ${timestamp}` });
});

// ✅ Roll-call View (HR Staff)
router.get('/roll-call', rbac([HR_STAFF]), (req, res) => {
  res.json({ message: 'Roll-call feature not implemented yet' });
});

module.exports = router;
