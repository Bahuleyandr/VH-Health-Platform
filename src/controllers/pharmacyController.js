// src/controllers/pharmacyController.js

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { resolvePhoneFromUID } from '../utils/resolveIdentity.js';
import { success, error } from '../utils/responseHelper.js';

// ✅ Place Pharmacy Order with optional file_key
export async function placePharmacyOrder(req, res) {
  const { phone, order_note, file_key } = req.body;

  if (!phone || !order_note) {
    return error(res, 'Phone and order_note are required', 400);
  }

  if (req.user?.role === 'PATIENT') {
    const userPhone = normalizePhone(req.user?.phone);
    if (userPhone && userPhone !== phone) {
      return error(res, 'You can only place orders for yourself', 403);
    }
  }

  try {
    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (phone, order_note, file_key)
       VALUES ($1, $2, $3) RETURNING id, phone, order_note, file_key, status, created_at`,
      [phone, order_note, file_key || null]
    );
    success(res, result[0], 'Pharmacy order placed');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Database error');
  }
}

// ✅ Get Pharmacy Orders by Phone
export async function getPharmacyOrdersByPhone(req, res) {
  const { phone } = req.params;

  if (!phone) {
    return error(res, 'Phone parameter is required', 400);
  }

  if (req.user?.role === 'PATIENT') {
    const userPhone = normalizePhone(req.user?.phone);
    if (userPhone && userPhone !== phone) {
      return error(res, 'You can only view your own orders', 403);
    }
  }

  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT id, phone, order_note, file_key, prescription_id, urgent, status, notes, created_at, updated_at FROM pharmacy_orders WHERE phone = $1 ORDER BY created_at DESC`, phone);
    success(
      res,
      result,
      result.length ? 'Pharmacy orders fetched' : 'No pharmacy orders found'
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
    return error(res, 'UID is required', 400);
  }

  try {
    const phone = await resolvePhoneFromUID(uid);

    if (!phone) {
      return error(res, 'UID not found in users table', 404);
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, phone, order_note, file_key, prescription_id, urgent, status, notes, created_at, updated_at FROM pharmacy_orders WHERE phone = $1 ORDER BY created_at DESC`, phone);

    if (result.length === 0) {
      return error(res, 'No pharmacy orders found for this user', 404);
    }

    return success(res, { pharmacyOrders: result }, 'Pharmacy orders retrieved successfully');
  } catch (err) {
    logger.error('Get Pharmacy Orders By UID Error:', err);
    return error(res, 'Internal server error');
  }
}
