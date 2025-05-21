// src/routes/staffRoutes.js

import express from 'express';
import pool from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();

// ✅ Staff Upload + Fulfill + Attendance + Roll Call routes
wrapAutoRBAC(router, 'staffRoutes', {
  post: [
    ['/consultations', async (req, res) => {
      const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
      const file_key = req.body.file_key || req.body.result_file;
      const file_name = req.body.file_name || null;
      const file_type = req.body.file_type || null;

      if (!phone || !file_key || !file_name) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          error: 'Phone, file_key, and file_name are required.'
        });
      }

      try {
        const result = await pool.query(
          `INSERT INTO consultations (phone, file_key, file_name, file_type, created_at)
           VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
          [phone, file_key, file_name, file_type]
        );
        success(res, result.rows[0], 'Consultation uploaded.');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, 'Database error');
      }
    }],

    ['/investigations', async (req, res) => {
      const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
      const file_key = req.body.file_key || req.body.result_file;
      const { test_name } = req.body;

      if (!phone || !test_name || !file_key) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          error: 'Phone, test_name, and file_key are required.'
        });
      }

      try {
        const result = await pool.query(
          `INSERT INTO investigations (phone, test_name, file_key, status, requested_at)
           VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP) RETURNING *`,
          [phone, test_name, file_key]
        );
        success(res, result.rows[0], 'Investigation requested.');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, 'Database error');
      }
    }],

    ['/pharmacy-orders', async (req, res) => {
      const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
      const { order_id, status, notes } = req.body;

      if (!phone || !order_id || !status) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          error: 'Phone, order ID, and status are required.'
        });
      }

      try {
        const result = await pool.query(
          `UPDATE pharmacy_orders SET status = $1, order_note = $2 
           WHERE id = $3 AND phone = $4 RETURNING *`,
          [status, notes || '', order_id, phone]
        );

        if (result.rows.length === 0) {
  return res.status(HTTP_STATUS.BAD_REQUEST).json({
    error: 'No pharmacy order was updated. Please check order_id and phone combination.'
  });
        }

        success(res, result.rows[0], 'Pharmacy order updated.');
      } catch (err) {
        logger.error(err.stack || err.toString());
        error(res, 'Database error');
      }
    }],

    ['/attendance', (req, res) => {
      const { staffId, timestamp } = req.body;
      if (!staffId || !timestamp) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          error: 'staffId and timestamp are required.'
        });
      }
      res.json({ message: `Attendance marked for staffId ${staffId} at ${timestamp}` });
    }]
  ],
  get: [
    ['/attendance', (req, res) => {
      res.json({ message: 'Attendance feature not implemented yet' });
    }],
    ['/roll-call', (req, res) => {
      res.json({ message: 'Roll-call feature not implemented yet' });
    }]
  ]
});

export default router;
