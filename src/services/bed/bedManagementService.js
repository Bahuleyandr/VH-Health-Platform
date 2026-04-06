// src/services/bed/bedManagementService.js
// Enhanced bed management: occupancy stats, admit/discharge/transfer workflows
// Uses raw pg queries (project convention — Prisma schema is documentation only)

import db from '../../config/database.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

class BedManagementService {
  // =========================================================================
  // getBedOccupancy — Dashboard stats: total, occupied, available, by ward/type
  // =========================================================================
  async getBedOccupancy() {
    // Overall counts
    const { rows: totals } = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'occupied')::int AS occupied,
        COUNT(*) FILTER (WHERE status = 'available')::int AS available,
        COUNT(*) FILTER (WHERE status = 'reserved')::int AS reserved,
        COUNT(*) FILTER (WHERE status = 'maintenance')::int AS maintenance,
        COUNT(*) FILTER (WHERE status = 'cleaning')::int AS cleaning
      FROM beds
    `);

    // By ward
    const { rows: byWard } = await prisma.$queryRawUnsafe(`
      SELECT
        ward_id,
        ward_name,
        floor,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'occupied')::int AS occupied,
        COUNT(*) FILTER (WHERE status = 'available')::int AS available
      FROM beds
      GROUP BY ward_id, ward_name, floor
      ORDER BY ward_name NULLS LAST
    `);

    // By bed type
    const { rows: byType } = await prisma.$queryRawUnsafe(`
      SELECT
        bed_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'occupied')::int AS occupied,
        COUNT(*) FILTER (WHERE status = 'available')::int AS available
      FROM beds
      GROUP BY bed_type
      ORDER BY bed_type
    `);

    const overall = totals[0] || { total: 0, occupied: 0, available: 0, reserved: 0, maintenance: 0, cleaning: 0 };
    overall.occupancy_rate = overall.total > 0
      ? Math.round((overall.occupied / overall.total) * 100 * 100) / 100
      : 0;

    return { overall, by_ward: byWard, by_type: byType };
  }

  // =========================================================================
  // admitPatient — Admit patient to a specific bed (transaction)
  // =========================================================================
  async admitPatient(bedId, patientUid, expectedDischarge) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the bed row
      const { rows: bedRows } = await client.query(
        `SELECT id, status, bed_number FROM beds WHERE id = $1 FOR UPDATE`,
        [bedId]
      );

      if (!bedRows.length) {
        throw AppError.notFound('Bed not found');
      }

      if (bedRows[0].status !== 'available') {
        throw AppError.badRequest(
          `Bed ${bedRows[0].bed_number} is not available (current status: ${bedRows[0].status})`
        );
      }

      // Check patient is not already admitted to another bed
      const { rows: existingAdmission } = await client.query(
        `SELECT id, bed_number FROM beds WHERE patient_uid = $1 AND status = 'occupied'`,
        [patientUid]
      );

      if (existingAdmission.length > 0) {
        throw AppError.conflict(
          `Patient is already admitted to bed ${existingAdmission[0].bed_number}`
        );
      }

      // Admit
      const { rows: updated } = await client.query(
        `UPDATE beds
         SET status = 'occupied',
             patient_uid = $1,
             admitted_at = NOW(),
             expected_discharge = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
        [patientUid, expectedDischarge, bedId]
      );

      // Record in bed_transfers as an admission (from_bed_id = NULL)
      await client.query(
        `INSERT INTO bed_transfers (patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
         VALUES ($1, NULL, $2, 'Admission', $3)`,
        [patientUid, bedId, patientUid]
      );

      await client.query('COMMIT');
      logger.info(`Patient ${patientUid} admitted to bed ${bedId}`);
      return updated[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // dischargePatient — Discharge and set bed status to "cleaning"
  // =========================================================================
  async dischargePatient(bedId, dischargedBy) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: bedRows } = await client.query(
        `SELECT id, status, patient_uid, bed_number FROM beds WHERE id = $1 FOR UPDATE`,
        [bedId]
      );

      if (!bedRows.length) {
        throw AppError.notFound('Bed not found');
      }

      if (bedRows[0].status !== 'occupied') {
        throw AppError.badRequest(
          `Bed ${bedRows[0].bed_number} is not occupied (current status: ${bedRows[0].status})`
        );
      }

      const patientUid = bedRows[0].patient_uid;

      // Record discharge in bed_transfers (to_bed_id stays same, reason = Discharge)
      await client.query(
        `INSERT INTO bed_transfers (patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
         VALUES ($1, $2, $2, 'Discharge', $3)`,
        [patientUid, bedId, dischargedBy]
      );

      // Set bed to cleaning
      const { rows: updated } = await client.query(
        `UPDATE beds
         SET status = 'cleaning',
             patient_uid = NULL,
             admitted_at = NULL,
             expected_discharge = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
        [bedId]
      );

      await client.query('COMMIT');
      logger.info(`Patient ${patientUid} discharged from bed ${bedId}, bed set to cleaning`);
      return updated[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // transferPatient — Move patient from current bed to a new bed
  // =========================================================================
  async transferPatient(patientUid, toBedId, reason, transferredBy) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Find current bed
      const { rows: currentBedRows } = await client.query(
        `SELECT id, bed_number FROM beds WHERE patient_uid = $1 AND status = 'occupied' FOR UPDATE`,
        [patientUid]
      );

      if (!currentBedRows.length) {
        throw AppError.notFound('Patient is not currently admitted to any bed');
      }

      const fromBedId = currentBedRows[0].id;

      // Lock and check target bed
      const { rows: targetBedRows } = await client.query(
        `SELECT id, status, bed_number FROM beds WHERE id = $1 FOR UPDATE`,
        [toBedId]
      );

      if (!targetBedRows.length) {
        throw AppError.notFound('Target bed not found');
      }

      if (targetBedRows[0].status !== 'available') {
        throw AppError.badRequest(
          `Target bed ${targetBedRows[0].bed_number} is not available (current status: ${targetBedRows[0].status})`
        );
      }

      // Vacate old bed (set to cleaning)
      await client.query(
        `UPDATE beds
         SET status = 'cleaning', patient_uid = NULL, admitted_at = NULL,
             expected_discharge = NULL, updated_at = NOW()
         WHERE id = $1`,
        [fromBedId]
      );

      // Occupy new bed
      const { rows: newBed } = await client.query(
        `UPDATE beds
         SET status = 'occupied', patient_uid = $1, admitted_at = NOW(), updated_at = NOW()
         WHERE id = $2
         RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
        [patientUid, toBedId]
      );

      // Record transfer
      await client.query(
        `INSERT INTO bed_transfers (patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [patientUid, fromBedId, toBedId, reason, transferredBy]
      );

      await client.query('COMMIT');
      logger.info(`Patient ${patientUid} transferred from bed ${fromBedId} to bed ${toBedId}`);

      return {
        from_bed_id: fromBedId,
        to_bed: newBed[0],
        reason,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // =========================================================================
  // getAvailableBeds — List available beds with optional ward/type filters
  // =========================================================================
  async getAvailableBeds(wardId, bedType) {
    const conditions = ["status = 'available'"];
    const params = [];
    let idx = 1;

    if (wardId) {
      conditions.push(`ward_id = $${idx}`);
      params.push(wardId);
      idx++;
    }

    if (bedType) {
      conditions.push(`bed_type = $${idx}`);
      params.push(bedType);
      idx++;
    }

    const where = conditions.join(' AND ');

    const { rows } = await prisma.$queryRawUnsafe(
      `SELECT id, bed_number, ward_id, ward_name, floor, bed_type, notes, created_at
       FROM beds
       WHERE ${where}
       ORDER BY ward_name NULLS LAST, bed_number`,
      params
    );

    return rows;
  }

  // =========================================================================
  // markBedReady — Cleaning complete, set bed to available
  // =========================================================================
  async markBedReady(bedId) {
    const { rows } = await prisma.$queryRawUnsafe(
      `UPDATE beds
       SET status = 'available', updated_at = NOW()
       WHERE id = $1 AND status = 'cleaning'
       RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
      [bedId]
    );

    if (!rows.length) {
      // Check if bed exists at all
      const { rows: check } = await prisma.$queryRawUnsafe(
        `SELECT id, status FROM beds WHERE id = $1`,
        [bedId]
      );
      if (!check.length) {
        throw AppError.notFound('Bed not found');
      }
      throw AppError.badRequest(
        `Bed is not in cleaning status (current status: ${check[0].status})`
      );
    }

    logger.info(`Bed ${bedId} marked as available`);
    return rows[0];
  }

  // =========================================================================
  // getBedHistory — Transfer and admission history for a specific bed
  // =========================================================================
  async getBedHistory(bedId) {
    // Verify bed exists
    const { rows: bedCheck } = await prisma.$queryRawUnsafe(
      `SELECT id, bed_number FROM beds WHERE id = $1`,
      [bedId]
    );

    if (!bedCheck.length) {
      throw AppError.notFound('Bed not found');
    }

    const { rows } = await prisma.$queryRawUnsafe(
      `SELECT bt.id, bt.patient_uid, bt.from_bed_id, bt.to_bed_id,
              bt.reason, bt.transferred_by, bt.transferred_at,
              fb.bed_number AS from_bed_number,
              tb.bed_number AS to_bed_number,
              u.name AS patient_name
       FROM bed_transfers bt
       LEFT JOIN beds fb ON bt.from_bed_id = fb.id
       LEFT JOIN beds tb ON bt.to_bed_id = tb.id
       LEFT JOIN users u ON bt.patient_uid = u.uid
       WHERE bt.from_bed_id = $1 OR bt.to_bed_id = $1
       ORDER BY bt.transferred_at DESC
       LIMIT 200`,
      [bedId]
    );

    return rows;
  }
}

export default new BedManagementService();
