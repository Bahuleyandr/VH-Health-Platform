// src/routes/dataExportRoutes.js
// GDPR Patient Data Export & Deletion

import { Router } from 'express';
import db from '../config/database.js';
import logger from '../logging/logger.js';

const router = Router();

/**
 * GET /api/v1/data-export/my-data
 * Export all patient data as a JSON download.
 */
router.get('/my-data', async (req, res) => {
  const userId = req.user?.uid || req.user?.phone;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Lookup user by uid or phone
    const userRes = await db.query(
      `SELECT * FROM users WHERE uid = $1 OR phone = $1 LIMIT 1`,
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const phone = user.phone;
    const uid = user.uid;

    // Collect all patient data
    const [appointments, healthRecords, records, investigations, pharmacyOrders, feedback, notifications] = await Promise.all([
      db.query(`SELECT * FROM appointments WHERE uid = $1 OR phone = $2`, [uid, phone]),
      db.query(`SELECT * FROM health_records WHERE phone = $1`, [phone]),
      db.query(`SELECT * FROM records WHERE phone = $1`, [phone]),
      db.query(`SELECT * FROM investigations WHERE phone = $1`, [phone]),
      db.query(`SELECT * FROM pharmacy_orders WHERE phone = $1`, [phone]),
      db.query(`SELECT * FROM feedback WHERE phone = $1`, [phone]),
      db.query(`SELECT * FROM notifications WHERE phone = $1`, [phone]),
    ]);

    const exportData = {
      exportDate: new Date().toISOString(),
      profile: user,
      appointments: appointments.rows,
      healthRecords: healthRecords.rows,
      medicalRecords: records.rows,
      investigations: investigations.rows,
      pharmacyOrders: pharmacyOrders.rows,
      feedback: feedback.rows,
      notifications: notifications.rows,
    };

    // Audit log
    logger.info(`📦 Data export requested by user ${uid} (${phone})`);

    res.setHeader('Content-Disposition', `attachment; filename="patient-data-${uid}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.json(exportData);
  } catch (err) {
    logger.error(`Data export failed for ${userId}: ${err.message}`);
    return res.status(500).json({ error: 'Failed to export data' });
  }
});

/**
 * DELETE /api/v1/data-export/my-data
 * Soft-delete all patient data (GDPR right to erasure).
 * Marks records with deleted_at timestamp for legal retention.
 */
router.delete('/my-data', async (req, res) => {
  const userId = req.user?.uid || req.user?.phone;

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const userRes = await db.query(
      `SELECT uid, phone FROM users WHERE uid = $1 OR phone = $1 LIMIT 1`,
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const phone = user.phone;
    const uid = user.uid;
    const now = new Date().toISOString();

    // Soft-delete across all tables that support deleted_at
    // Using best-effort: if a table doesn't have deleted_at column, skip it
    const tables = [
      { table: 'users', where: 'uid = $1', params: [uid] },
      { table: 'appointments', where: 'uid = $1 OR phone = $2', params: [uid, phone] },
      { table: 'health_records', where: 'phone = $1', params: [phone] },
      { table: 'records', where: 'phone = $1', params: [phone] },
      { table: 'investigations', where: 'phone = $1', params: [phone] },
      { table: 'pharmacy_orders', where: 'phone = $1', params: [phone] },
      { table: 'feedback', where: 'phone = $1', params: [phone] },
      { table: 'notifications', where: 'phone = $1', params: [phone] },
    ];

    const results = [];
    for (const { table, where, params } of tables) {
      try {
        const result = await db.query(
          `UPDATE ${table} SET deleted_at = '${now}' WHERE ${where} AND deleted_at IS NULL`,
          params
        );
        results.push({ table, affected: result.rowCount });
      } catch (err) {
        // Table might not have deleted_at column — that's OK
        logger.warn(`Soft-delete skipped for ${table}: ${err.message}`);
        results.push({ table, skipped: true, reason: err.message });
      }
    }

    logger.info(`🗑️ Data deletion requested by user ${uid} (${phone}) — soft-deleted across ${results.length} tables`);

    return res.json({
      message: 'Your data has been marked for deletion. It will be retained for the legally required period before permanent removal.',
      details: results,
    });
  } catch (err) {
    logger.error(`Data deletion failed for ${userId}: ${err.message}`);
    return res.status(500).json({ error: 'Failed to process deletion request' });
  }
});

export default router;
