// src/controllers/investigationController.js

import pool from '../db.js';
import db from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { resolvePhoneFromUID } from '../utils/resolveIdentity.js';

// ✅ Add Investigation with optional file_key
export async function addInvestigation(req, res) {
  const { phone, test_name, file_key } = req.body;

  if (!phone || !test_name) {
    return res.status(400).json({ error: 'Phone and test_name are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO investigations (phone, test_name, file_key)
       VALUES ($1, $2, $3) RETURNING *`,
      [phone, test_name, file_key || null],
    );
    success(res, result.rows[0], 'Investigation requested');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

// ✅ Get Investigations by Phone
export async function getInvestigationsByPhone(req, res) {
  const { phone } = req.params;

  if (!phone) {
    return res.status(400).json({ error: 'Phone parameter is required' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM investigations WHERE phone = $1 ORDER BY requested_at DESC`,
      [phone],
    );

    success(
      res,
      result.rows,
      result.rows.length ? 'Investigations found' : 'No investigations found',
    );
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

// ✅ Get Investigations by UID
export async function getInvestigationsByUID(req, res) {
  const { uid } = req.params;

  if (!uid) {
    return res.status(400).json({ error: 'UID is required' });
  }

  try {
    const phone = await resolvePhoneFromUID(uid);
    if (!phone) {
      return res.status(404).json({ error: 'UID not found in users table' });
    }

    const result = await db.query(
      `SELECT * FROM investigations WHERE phone = $1 ORDER BY requested_at DESC`,
      [phone],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: 'No investigations found for this user' });
    }

    return res.status(200).json({ success: true, investigations: result.rows });
  } catch (error) {
    logger.error(
      'Get Investigations By UID Error:',
      error.stack || error.toString(),
    );
    return res.status(500).json({ error: 'Internal server error' });
  }
}
