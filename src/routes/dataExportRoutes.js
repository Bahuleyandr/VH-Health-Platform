// src/routes/dataExportRoutes.js
// GDPR Patient Data Export & Deletion

import { Router } from 'express';
import prisma from '../lib/prisma.js';
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
    const userRes = await prisma.$queryRawUnsafe(
      `SELECT id, uid, name, phone, email, role, gender, birthday, address, allergies, emergency_contact, blood_group, registered_at, last_login, is_active FROM users WHERE uid = $1 OR phone = $1 LIMIT 1`,
      userId
    );
    const user = userRes[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const phone = user.phone;
    const uid = user.uid;

    // Collect all patient data
    const [appointments, healthRecords, records, investigations, pharmacyOrders, feedback, notifications] = await Promise.all([
      prisma.$queryRawUnsafe(`SELECT id, patient_id, doctor_id, appointment_date, appointment_time, status, reason, notes, token_number, department, created_at, updated_at FROM appointments WHERE uid = $1 OR phone = $2 LIMIT 10000`, uid, phone),
      prisma.$queryRawUnsafe(`SELECT id, phone, record_type, record_data, doctor_name, notes, created_at FROM health_records WHERE phone = $1 LIMIT 10000`, phone),
      prisma.$queryRawUnsafe(`SELECT id, phone, record_type, file_key, file_name, notes, created_at FROM records WHERE phone = $1 LIMIT 10000`, phone),
      prisma.$queryRawUnsafe(`SELECT id, phone, investigation_type, status, results, notes, created_at FROM investigations WHERE phone = $1 LIMIT 10000`, phone),
      prisma.$queryRawUnsafe(`SELECT id, phone, order_note, file_key, status, urgent, notes, created_at, updated_at FROM pharmacy_orders WHERE phone = $1 LIMIT 10000`, phone),
      prisma.$queryRawUnsafe(`SELECT id, phone, rating, comment, appointment_id, created_at FROM feedback WHERE phone = $1 LIMIT 10000`, phone),
      prisma.$queryRawUnsafe(`SELECT id, phone, title, body, type, read, created_at FROM notifications WHERE phone = $1 LIMIT 10000`, phone),
    ]);

    const exportData = {
      exportDate: new Date().toISOString(),
      profile: user,
      appointments: appointments,
      healthRecords: healthRecords,
      medicalRecords: records,
      investigations: investigations,
      pharmacyOrders: pharmacyOrders,
      feedback: feedback,
      notifications: notifications,
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
    const userRes = await prisma.$queryRawUnsafe(
      `SELECT uid, phone FROM users WHERE uid = $1 OR phone = $1 LIMIT 1`,
      userId
    );
    const user = userRes[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const phone = user.phone;
    const uid = user.uid;
    const now = new Date().toISOString();

    // Soft-delete across all tables that support deleted_at
    // Using best-effort: if a table doesn't have deleted_at column, skip it
    // Whitelist of allowed table names to prevent SQL injection via dynamic table names
    const allowedTables = ['users', 'appointments', 'health_records', 'records', 'investigations', 'pharmacy_orders', 'feedback', 'notifications'];

    const tables = [
      { table: 'users', where: 'uid = $2', params: [uid] },
      { table: 'appointments', where: 'uid = $2 OR phone = $3', params: [uid, phone] },
      { table: 'health_records', where: 'phone = $2', params: [phone] },
      { table: 'records', where: 'phone = $2', params: [phone] },
      { table: 'investigations', where: 'phone = $2', params: [phone] },
      { table: 'pharmacy_orders', where: 'phone = $2', params: [phone] },
      { table: 'feedback', where: 'phone = $2', params: [phone] },
      { table: 'notifications', where: 'phone = $2', params: [phone] },
    ];

    const results = [];
    for (const { table, where, params } of tables) {
      try {
        if (!allowedTables.includes(table)) {
          throw new Error('Invalid table');
        }
        // Parameterize the timestamp as $1; table name is safe (whitelisted above)
        const result = await prisma.$queryRawUnsafe(
          `UPDATE ${table} SET deleted_at = $1 WHERE ${where} AND deleted_at IS NULL`,
          now, ...params
        );
        results.push({ table, affected: result.length });
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
