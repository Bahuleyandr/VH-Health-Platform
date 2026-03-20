// src/controllers/recordController.js

import db from '../config/database.js';
import logger from '../logging/logger.js';
import { resolvePhoneFromUID } from '../utils/resolveIdentity.js';
import { success, error } from '../utils/responseHelper.js';

// ✅ Add Health Record with file_key, file_name, and file_type
export async function addHealthRecord(req, res) {
  const { phone, file_key, file_name, file_type } = req.body;

  if (!phone || !file_key || !file_name || !file_type) {
    return res.status(400).json({
      error: 'phone, file_key, file_name, and file_type are required'
    });
  }

  try {
    const result = await db.query(
      `INSERT INTO health_records (phone, file_key, file_name, file_type)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [phone, file_key, file_name, file_type]
    );
    success(res, result.rows[0], 'Health record added');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

// ✅ Get Health Records by Phone with optional type filtering
export async function getHealthRecordsByPhone(req, res) {
  try {
    const { phone } = req.params;
    const { type } = req.query;

    const result = await db.query('SELECT * FROM health_records WHERE phone = $1', [phone]);

    let records = result.rows;

    if (type && typeof type === 'string') {
      records = records.filter(
        r => r.file_type && r.file_type.toLowerCase() === type.toLowerCase()
      );
    }

    success(res, records, 'Health records fetched');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

// ✅ Get Health Records by UID (via resolved phone)
export async function getRecordsByUID(req, res) {
  const { uid } = req.params;

  if (!uid) {
    return res.status(400).json({
      success: false,
      message: 'UID is required'
    });
  }

  try {
    const resolvedPhone = await resolvePhoneFromUID(uid);

    if (!resolvedPhone) {
      return res.status(404).json({
        success: false,
        message: 'UID not found in users table'
      });
    }

    const result = await db.query('SELECT * FROM health_records WHERE phone = $1', [
      resolvedPhone
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No health records found for this phone'
      });
    }

    return res.status(200).json({
      success: true,
      records: result.rows
    });
  } catch (err) {
    logger.error('Get Records By UID Error:', err.stack || err.toString());
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
}
