// src/controllers/pharmacyController.js

import db from '../config/database.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { resolvePhoneFromUID } from '../utils/resolveIdentity.js';

// ✅ Place Pharmacy Order with optional file_key
export async function placePharmacyOrder(req, res) {
  const { phone, order_note, file_key } = req.body;

  if (!phone || !order_note) {
    return res.status(400).json({ error: 'Phone and order_note are required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO pharmacy_orders (phone, order_note, file_key)
       VALUES ($1, $2, $3) RETURNING *`,
      [phone, order_note, file_key || null]
    );
    success(res, result.rows[0], 'Pharmacy order placed');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

// ✅ Get Pharmacy Orders by Phone
export async function getPharmacyOrdersByPhone(req, res) {
  const { phone } = req.params;

  if (!phone) {
    return res.status(400).json({ error: 'Phone parameter is required' });
  }

  try {
    const result = await db.query(
      `SELECT * FROM pharmacy_orders WHERE phone = $1 ORDER BY created_at DESC`,
      [phone]
    );
    success(
      res,
      result.rows,
      result.rows.length ? 'Pharmacy orders fetched' : 'No pharmacy orders found'
    );
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

// ✅ Get Pharmacy Orders by UID
// ✅ Get Pharmacy Orders by UID
export async function getPharmacyOrdersByUID(req, res) {
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
      `SELECT * FROM pharmacy_orders WHERE phone = $1 ORDER BY created_at DESC`,
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No pharmacy orders found for this user' });
    }

    return res.status(200).json({ success: true, pharmacyOrders: result.rows });
  } catch (err) {
    logger.error('Get Pharmacy Orders By UID Error:', err); // ✅ correctly logs the error // ✅ fixed
    return res.status(500).json({ error: 'Internal server error' });
  }
}
