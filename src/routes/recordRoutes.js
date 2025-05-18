const express = require('express');
const router = express.Router();
const recordController = require('../controllers/recordController');
const rbac = require('../middleware/rbacMiddleware');
const { PATIENT, NURSING_STAFF, DOCTOR } = require('../utils/roles');

// ✅ Get health records by UID (Patient, Doctor, Nursing Staff)
router.get('/uid/:uid', rbac([PATIENT, DOCTOR, NURSING_STAFF]), recordController.getRecordsByUID);

// ✅ Add health record (Nursing Staff, Doctor)
router.post('/health-records', rbac([NURSING_STAFF, DOCTOR]), recordController.addHealthRecord);

// ✅ Get health records by phone (Patient, Doctor, Nursing Staff)
router.get('/health-records/:phone', rbac([PATIENT, DOCTOR, NURSING_STAFF]), async (req, res) => {
  const pool = require('../db');
  const { success, error } = require('../utils/responseHelper');
  const logger = require('../logging/logger');

  try {
    const { phone } = req.params;
    const { type } = req.query;

    const result = await pool.query('SELECT * FROM health_records WHERE phone = $1', [phone]);
    let records = result.rows;

    if (type) {
      records = records.filter(r => r.file_type.toLowerCase() === type.toLowerCase());
    }

    success(res, records, 'Health records fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
});

// ✅ Get all consultations by phone number (Patient, Doctor, Nursing Staff)
router.get('/consultations/:phoneNumber', rbac([PATIENT, DOCTOR, NURSING_STAFF]), async (req, res) => {
  const pool = require('../db');
  const { success, error } = require('../utils/responseHelper');
  const logger = require('../logging/logger');

  const { phoneNumber } = req.params;
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM consultations WHERE phone = $1 ORDER BY created_at DESC', [phoneNumber]);
    success(res, result.rows, 'Consultations retrieved.');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Failed to retrieve consultations.');
  }
});

module.exports = router;
