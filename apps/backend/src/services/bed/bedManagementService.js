// src/services/bed/bedManagementService.js
// Bed management: occupancy stats + admit/discharge/transfer workflows.
// Writes use prisma.$transaction for atomic multi-statement blocks (FOR
// UPDATE row lock → conditional INSERT/UPDATE → state commit). Reads use
// plain prisma.$queryRaw*.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { ICU_BED_TYPES, canAllocateIcu } from '../../utils/roleHelpers.js';

class BedManagementService {
  // =========================================================================
  // getBedOccupancy — Dashboard stats: total, occupied, available, by ward/type
  // =========================================================================
  async getBedOccupancy() {
    // Overall counts
    const totals = await prisma.$queryRawUnsafe(`
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
    const byWard = await prisma.$queryRawUnsafe(`
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
    const byType = await prisma.$queryRawUnsafe(`
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
  async admitPatient(bedId, patientUid, expectedDischarge, actorRole = null) {
    // prisma.$transaction runs the callback inside BEGIN/COMMIT — thrown
    // errors (including AppError) trigger automatic ROLLBACK before
    // propagating to the caller.
    const result = await prisma.$transaction(async (tx) => {
      const bedRows = await tx.$queryRawUnsafe(
        `SELECT id, status, bed_number, bed_type FROM beds WHERE id = $1 FOR UPDATE`,
        bedId
      );

      if (!bedRows.length) {
        throw AppError.notFound('Bed not found');
      }

      // Stage-4-C — same tier gate as bedService.admitPatient.
      // Finding: 2026-05-09-emergency-walk-in-admission-no-icu-rbac-tier
      if (ICU_BED_TYPES.has(bedRows[0].bed_type) && !canAllocateIcu(actorRole)) {
        throw AppError.forbidden('ICU/CCU bed allocation requires physician or admission-officer authorisation');
      }

      if (bedRows[0].status !== 'available') {
        throw AppError.badRequest(
          `Bed ${bedRows[0].bed_number} is not available (current status: ${bedRows[0].status})`
        );
      }

      const existingAdmission = await tx.$queryRawUnsafe(
        `SELECT id, bed_number FROM beds WHERE patient_uid = $1::uuid AND status = 'occupied'`,
        patientUid
      );

      if (existingAdmission.length > 0) {
        throw AppError.conflict(
          `Patient is already admitted to bed ${existingAdmission[0].bed_number}`
        );
      }

      const updated = await tx.$queryRawUnsafe(
        `UPDATE beds
         SET status = 'occupied',
             patient_uid = $1::uuid,
             admitted_at = NOW(),
             expected_discharge = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
        patientUid, expectedDischarge, bedId
      );

      await tx.$executeRawUnsafe(
        `INSERT INTO bed_transfers (patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
         VALUES ($1::uuid, NULL, $2, 'Admission', $3::uuid)`,
        patientUid, bedId, patientUid
      );

      return updated[0];
    });

    logger.info(`Patient ${patientUid} admitted to bed ${bedId}`);
    return result;
  }

  // =========================================================================
  // dischargePatient — Discharge and set bed status to "dirty"
  // =========================================================================
  async dischargePatient(bedId, dischargedBy) {
    const { updated, patientUid } = await prisma.$transaction(async (tx) => {
      const bedRows = await tx.$queryRawUnsafe(
        `SELECT id, status, patient_uid, bed_number FROM beds WHERE id = $1 FOR UPDATE`,
        bedId
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

      // bed_transfers.patient_uid is NOT NULL; skip the audit row for beds
      // admitted via the legacy bedService path (which never writes patient_uid).
      if (patientUid) {
        await tx.$executeRawUnsafe(
          `INSERT INTO bed_transfers (patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
           VALUES ($1::uuid, $2, $2, 'Discharge', $3::uuid)`,
          patientUid, bedId, dischargedBy
        );
      }

      const updated = await tx.$queryRawUnsafe(
        `UPDATE beds
         SET status = 'dirty',
             patient_uid = NULL,
             admitted_at = NULL,
             expected_discharge = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
        bedId
      );

      return { updated: updated[0], patientUid };
    });

    logger.info(`Patient ${patientUid} discharged from bed ${bedId}, bed set to dirty`);
    return updated;
  }

  // =========================================================================
  // transferPatient — Move patient from current bed to a new bed
  // =========================================================================
  async transferPatient(patientUid, toBedId, reason, transferredBy, actorRole = null, options = {}) {
    const { acknowledgeClassChange = false } = options;
    const result = await prisma.$transaction(async (tx) => {
      const currentBedRows = await tx.$queryRawUnsafe(
        `SELECT id, bed_number, bed_type FROM beds WHERE patient_uid = $1::uuid AND status = 'occupied' FOR UPDATE`,
        patientUid
      );

      if (!currentBedRows.length) {
        throw AppError.notFound('Patient is not currently admitted to any bed');
      }

      const fromBed = currentBedRows[0];
      const fromBedId = fromBed.id;

      const targetBedRows = await tx.$queryRawUnsafe(
        `SELECT id, status, bed_number, bed_type FROM beds WHERE id = $1 FOR UPDATE`,
        toBedId
      );

      if (!targetBedRows.length) {
        throw AppError.notFound('Target bed not found');
      }
      const toBed = targetBedRows[0];

      // Stage-4-C — transferring INTO ICU/CCU is an allocation event and
      // must enforce the same tier as direct admit.
      if (ICU_BED_TYPES.has(toBed.bed_type) && !canAllocateIcu(actorRole)) {
        throw AppError.forbidden('Transfer to ICU/CCU requires physician or admission-officer authorisation');
      }

      if (toBed.status !== 'available') {
        throw AppError.badRequest(
          `Target bed ${toBed.bed_number} is not available (current status: ${toBed.status})`
        );
      }

      // D34 — Class-change reconciliation. Moving a patient from
      // general → private (or general → deluxe) is a tariff event:
      // billing must re-stamp the room_category on the admission so
      // downstream invoice line items get the right rate, and the
      // patient must consent to the upgrade (the price differential
      // matters). Pre-fix this transfer happened silently — the
      // admission's `room_category` stayed 'general' even after the
      // patient moved to a private bed, and billing kept emitting
      // general-rate line items.
      //
      // Strategy: when the new bed maps to a HIGHER tier than the
      // current bed, require the caller to pass
      // `acknowledgeClassChange: true` (the staff app prompts the
      // operator with the price-difference dialog before doing so).
      // ICU/CCU transfers (already gated above) and DOWNGRADES skip
      // the gate — moving a private patient to a general bed is a
      // billing benefit, not a hazard.
      // Finding 19030e9a.
      const CLASS_RANK = { general: 1, semi_private: 2, private: 3, deluxe: 4, icu: 5, day_care: 1 };
      const fromRank = CLASS_RANK[fromBed.bed_type] || 0;
      const toRank = CLASS_RANK[toBed.bed_type] || 0;
      const isUpgrade = toRank > fromRank
        && fromBed.bed_type !== toBed.bed_type
        // ICU upgrade already enforced by canAllocateIcu above.
        && !ICU_BED_TYPES.has(toBed.bed_type);
      if (isUpgrade && !acknowledgeClassChange) {
        throw AppError.badRequest(
          `Bed transfer ${fromBed.bed_type} → ${toBed.bed_type} changes the room class and tariff. `
          + 'The patient/guardian must consent to the upgrade and the cost difference. '
          + 'Re-submit with `acknowledge_class_change: true` after the consent is recorded.',
          'BED_TRANSFER_CLASS_CHANGE_UNACKNOWLEDGED',
          {
            from_bed_type: fromBed.bed_type,
            to_bed_type: toBed.bed_type,
          },
        );
      }

      // Vacate old bed
      await tx.$executeRawUnsafe(
        `UPDATE beds
         SET status = 'cleaning', patient_uid = NULL, admitted_at = NULL,
             expected_discharge = NULL, updated_at = NOW()
         WHERE id = $1`,
        fromBedId
      );

      // Occupy new bed
      const newBed = await tx.$queryRawUnsafe(
        `UPDATE beds
         SET status = 'occupied', patient_uid = $1::uuid, admitted_at = NOW(), updated_at = NOW()
         WHERE id = $2
         RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at, bed_type`,
        patientUid, toBedId
      );

      // D34 — Re-stamp the admission's room_category to match the new
      // bed's type when the bed_type maps to a recognised category.
      // Without this, billing tariff stays anchored to the OLD class
      // even after the move. Best-effort: a missing admission row
      // (patient_uid mismatch between beds + admissions) is logged
      // and skipped, never blocks the bed move itself.
      const VALID_ROOM_CATEGORIES = new Set(['general', 'semi_private', 'private', 'deluxe', 'icu', 'day_care']);
      if (toBed.bed_type && VALID_ROOM_CATEGORIES.has(toBed.bed_type)) {
        try {
          await tx.$executeRawUnsafe(
            `UPDATE admissions
                SET room_category = $1, updated_at = NOW()
              WHERE patient_uid = $2::uuid AND status IN ('admitted', 'transferred')`,
            toBed.bed_type, patientUid,
          );
        } catch (categoryErr) {
          logger.warn(`transferPatient: room_category re-stamp failed for patient ${patientUid}: ${categoryErr.message}`);
        }
      }

      // Record transfer
      await tx.$executeRawUnsafe(
        `INSERT INTO bed_transfers (patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
         VALUES ($1::uuid, $2, $3, $4, $5::uuid)`,
        patientUid, fromBedId, toBedId, reason, transferredBy
      );

      return { fromBedId, fromBedType: fromBed.bed_type, toBed: newBed[0], isUpgrade };
    });

    logger.info(`Patient ${patientUid} transferred from bed ${result.fromBedId} to bed ${toBedId}`);

    return {
      from_bed_id: result.fromBedId,
      from_bed_type: result.fromBedType,
      to_bed: result.toBed,
      reason,
      class_change: result.isUpgrade ? {
        from: result.fromBedType,
        to: result.toBed.bed_type,
        acknowledged: true,
      } : null,
    };
  }

  // =========================================================================
  // getAvailableBeds — List available beds with optional ward/type filters
  // =========================================================================
  async getAvailableBeds(wardId, bedType) {
    // F-2 — defensive filter: status='available' alone trusted a column
    // legacy paths (bedService.dischargePatient pre-2026-05-12) didn't
    // always clear alongside the stale occupant FKs. The combined check
    // means a bed only appears available when no occupant identifiers
    // and no active admissions row references it. Finding:
    // 2026-05-10-dynamic-acute-abdomen-admission-available-bed-retains-active-patient.
    const conditions = [
      "status = 'available'",
      'patient_uid IS NULL',
      'patient_id IS NULL',
      'patient_name IS NULL',
      'admission_id IS NULL',
      "NOT EXISTS (SELECT 1 FROM admissions a WHERE a.bed_id = beds.id AND a.discharged_at IS NULL)",
    ];
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

    // F-2 — params must be SPREAD, not passed as a single array arg.
    // The Phase 0.5 convention (CLAUDE.md) is enforced by
    // lint:raw-params, but the linter regex missed this site because
    // the variable was named `params` (plural) inside a class method,
    // not at module top-level. Surfaced by the smoke test of
    // /api/v1/beds/available which 500'd with `42P18 — could not
    // determine data type of parameter $1`.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, bed_number, ward_id, ward_name, floor, bed_type, notes, created_at
       FROM beds
       WHERE ${where}
       ORDER BY ward_name NULLS LAST, bed_number`,
      ...params,
    );

    return rows;
  }

  // =========================================================================
  // markBedReady — Cleaning complete, set bed to available
  //
  // Writes an audit_logs row capturing actor + optional cleaning evidence
  // (ticket, cleaner, free-text notes) so a later auditor can prove who
  // closed the cleaning loop. Finding:
  //   2026-05-09-inpatient-admission-housekeeping-bed-ready-no-proof-required
  // =========================================================================
  async markBedReady(bedId, { actorUid = null, cleaningTicketId = null, cleanerId = null, notes = null } = {}) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE beds
       SET status = 'available', updated_at = NOW()
       WHERE id = $1 AND status = 'cleaning'
       RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
      bedId
    );

    if (!rows.length) {
      // Check if bed exists at all
      const check = await prisma.$queryRawUnsafe(
        `SELECT id, status FROM beds WHERE id = $1`,
        bedId
      );
      if (!check.length) {
        throw AppError.notFound('Bed not found');
      }
      throw AppError.badRequest(
        `Bed is not in cleaning status (current status: ${check[0].status})`
      );
    }

    // Fire-and-forget audit log — failure must not block bed availability.
    setImmediate(async () => {
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO audit_logs (uid, action, resource, resource_id, metadata)
           VALUES ($1::uuid, 'BED_MARKED_READY', 'bed', $2, $3::jsonb)`,
          actorUid ? String(actorUid) : null,
          String(bedId),
          JSON.stringify({
            prior_status: 'cleaning',
            new_status: 'available',
            bed_number: rows[0].bed_number,
            ward_id: rows[0].ward_id,
            cleaning_ticket_id: cleaningTicketId || null,
            cleaner_id: cleanerId || null,
            notes: notes || null,
            transition_at: new Date().toISOString(),
          })
        );
      } catch (err) {
        logger.warn(`markBedReady: audit log failed for bed ${bedId}: ${err.message}`);
      }
    });

    logger.info(`Bed ${bedId} marked as available by ${actorUid || 'unknown'}`);
    return rows[0];
  }

  // =========================================================================
  // getBedHistory — Transfer and admission history for a specific bed
  // =========================================================================
  async getBedHistory(bedId) {
    // Verify bed exists
    const bedCheck = await prisma.$queryRawUnsafe(
      `SELECT id, bed_number FROM beds WHERE id = $1`,
      bedId
    );

    if (!bedCheck.length) {
      throw AppError.notFound('Bed not found');
    }

    const rows = await prisma.$queryRawUnsafe(
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
      bedId
    );

    return rows;
  }
}

export default new BedManagementService();
