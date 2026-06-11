// src/services/bed/bedManagementService.js
// Bed management: occupancy stats + admit/discharge/transfer workflows.
// Writes use prisma.$transaction for atomic multi-statement blocks (FOR
// UPDATE row lock → conditional INSERT/UPDATE → state commit). Reads use
// plain prisma.$queryRaw*.

import prisma from '../../lib/prisma.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { ICU_BED_TYPES, canAllocateIcu } from '../../utils/roleHelpers.js';
import { createBedCleaningRequest } from '../staff/housekeepingTaskDispatchService.js';
import { emitBedMarkedReady } from '../clinical/canonicalOperationalBridgeService.js';

function tenantOf(options = {}) {
  return options.tenantId || getCurrentTenantId() || null;
}

class BedManagementService {
  // =========================================================================
  // getBedOccupancy — Dashboard stats: total, occupied, available, by ward/type
  // =========================================================================
  async getBedOccupancy(options = {}) {
    const tenantId = tenantOf(options);
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
      WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
    `, tenantId);

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
      WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
      GROUP BY ward_id, ward_name, floor
      ORDER BY ward_name NULLS LAST
    `, tenantId);

    // By bed type
    const byType = await prisma.$queryRawUnsafe(`
      SELECT
        bed_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'occupied')::int AS occupied,
        COUNT(*) FILTER (WHERE status = 'available')::int AS available
      FROM beds
      WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
      GROUP BY bed_type
      ORDER BY bed_type
    `, tenantId);

    const overall = totals[0] || { total: 0, occupied: 0, available: 0, reserved: 0, maintenance: 0, cleaning: 0 };
    overall.occupancy_rate = overall.total > 0
      ? Math.round((overall.occupied / overall.total) * 100 * 100) / 100
      : 0;

    return { overall, by_ward: byWard, by_type: byType };
  }

  // =========================================================================
  // admitPatient — Admit patient to a specific bed (transaction)
  // =========================================================================
  async admitPatient(bedId, patientUid, expectedDischarge, actorRole = null, options = {}) {
    const tenantId = tenantOf(options);
    // prisma.$transaction runs the callback inside BEGIN/COMMIT — thrown
    // errors (including AppError) trigger automatic ROLLBACK before
    // propagating to the caller.
    const result = await prisma.$transaction(async (tx) => {
      const bedRows = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, status, bed_number, bed_type FROM beds
          WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
          FOR UPDATE`,
        bedId,
        tenantId,
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
        `SELECT id, bed_number FROM beds
          WHERE patient_uid = $1::uuid
            AND status = 'occupied'
            AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
        patientUid,
        tenantId,
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
           AND ($4::uuid IS NULL OR tenant_id = $4::uuid)
         RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
        patientUid, expectedDischarge, bedId, tenantId,
      );

      await tx.$executeRawUnsafe(
        `INSERT INTO bed_transfers (tenant_id, patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
         VALUES ($1::uuid, $2::uuid, NULL, $3, 'Admission', $4::uuid)`,
        bedRows[0].tenant_id,
        patientUid,
        bedId,
        patientUid,
      );

      return updated[0];
    });

    logger.info(`Patient ${patientUid} admitted to bed ${bedId}`);
    return result;
  }

  // =========================================================================
  // dischargePatient — Discharge and hand bed to housekeeping.
  // =========================================================================
  async dischargePatient(bedId, dischargedBy, options = {}) {
    const tenantId = tenantOf(options);
    const { updated, patientUid, admissionId } = await prisma.$transaction(async (tx) => {
      const bedRows = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, status, patient_uid, bed_number FROM beds
          WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
          FOR UPDATE`,
        bedId,
        tenantId,
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

      const activeAdmissionRows = patientUid
        ? await tx.$queryRawUnsafe(
          `SELECT id, patient_uid, status
             FROM admissions
            WHERE status IN ('admitted', 'transferred')
              AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
              AND (bed_id = $1 OR patient_uid = $2::uuid)
            ORDER BY CASE WHEN bed_id = $1 THEN 0 ELSE 1 END,
                     admitted_at DESC NULLS LAST,
                     id DESC
            LIMIT 1
            FOR UPDATE`,
          bedId,
          patientUid,
          tenantId,
        )
        : await tx.$queryRawUnsafe(
          `SELECT id, patient_uid, status
             FROM admissions
            WHERE bed_id = $1
              AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
              AND status IN ('admitted', 'transferred')
            ORDER BY admitted_at DESC NULLS LAST, id DESC
            LIMIT 1
            FOR UPDATE`,
          bedId,
          tenantId,
        );
      const activeAdmission = activeAdmissionRows[0] || null;
      const dischargePatientUid = patientUid || activeAdmission?.patient_uid || null;

      if (activeAdmission) {
        await tx.$executeRawUnsafe(
          `UPDATE admissions
              SET status = 'discharged',
                  discharged_at = NOW(),
                  discharge_type = COALESCE(discharge_type, 'home'),
                  updated_at = NOW()
            WHERE id = $1
              AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
          activeAdmission.id,
          tenantId,
        );
      }

      // bed_transfers.patient_uid is NOT NULL; skip the audit row for beds
      // admitted via the legacy bedService path (which never writes patient_uid).
      if (dischargePatientUid) {
        await tx.$executeRawUnsafe(
          `INSERT INTO bed_transfers (tenant_id, patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
           VALUES ($1::uuid, $2::uuid, $3, $3, 'Discharge', $4::uuid)`,
          bedRows[0].tenant_id,
          dischargePatientUid,
          bedId,
          dischargedBy,
        );
      }

      const updated = await tx.$queryRawUnsafe(
        `UPDATE beds
         SET status = 'cleaning',
             patient_id = NULL,
             patient_name = NULL,
             patient_uid = NULL,
             admission_id = NULL,
             admitted_at = NULL,
             expected_discharge = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
         RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
        bedId,
        tenantId,
      );

      return { updated: updated[0], patientUid: dischargePatientUid, admissionId: activeAdmission?.id || null };
    });

    logger.info(
      `Patient ${patientUid || 'unknown'} discharged from bed ${bedId}, `
      + `admission ${admissionId || 'none'} ended, bed set to cleaning`,
    );
    try {
      await createBedCleaningRequest({
        bedId,
        requesterUid: dischargedBy,
        trigger: 'final_discharge',
        urgency: 'high',
        description: `Discharge cleaning required after direct bed discharge. bed_id=${bedId}.`,
      });
    } catch (e) {
      logger.warn(`dischargePatient: housekeeping dispatch failed for bed ${bedId} (continuing): ${e.message}`);
    }
    return updated;
  }

  async getActiveAdmissionForBed(bedId, options = {}) {
    const tenantId = tenantOf(options);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT b.id AS bed_id,
              b.tenant_id,
              b.bed_number,
              b.status AS bed_status,
              b.patient_uid AS bed_patient_uid,
              a.id AS admission_id,
              a.patient_uid AS admission_patient_uid,
              a.status AS admission_status,
              a.discharge_initiated_at
         FROM beds b
         LEFT JOIN LATERAL (
           SELECT id, patient_uid, status, discharge_initiated_at, admitted_at
             FROM admissions
            WHERE status IN ('admitted', 'transferred')
              AND tenant_id = b.tenant_id
              AND (
                bed_id = b.id
                OR (b.patient_uid IS NOT NULL AND patient_uid = b.patient_uid)
              )
            ORDER BY CASE WHEN bed_id = b.id THEN 0 ELSE 1 END,
                     admitted_at DESC NULLS LAST,
                     id DESC
            LIMIT 1
         ) a ON true
        WHERE b.id = $1
          AND ($2::uuid IS NULL OR b.tenant_id = $2::uuid)`,
      bedId,
      tenantId,
    );

    if (!rows.length) {
      throw AppError.notFound('Bed not found');
    }
    const row = rows[0];
    if (String(row.bed_status || '').toLowerCase() !== 'occupied') {
      throw AppError.badRequest(
        `Bed ${row.bed_number} is not occupied (current status: ${row.bed_status})`,
      );
    }
    if (!row.admission_id) {
      throw AppError.badRequest('No active admission is linked to this occupied bed');
    }
    return row;
  }

  // =========================================================================
  // transferPatient — Move patient from current bed to a new bed
  // =========================================================================
  async transferPatient(patientUid, toBedId, reason, transferredBy, actorRole = null, options = {}) {
    const { acknowledgeClassChange = false } = options;
    const tenantId = tenantOf(options);
    const result = await prisma.$transaction(async (tx) => {
      const currentBedRows = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, bed_number, bed_type, ward_id
           FROM beds
          WHERE patient_uid = $1::uuid
            AND status = 'occupied'
            AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
          FOR UPDATE`,
        patientUid,
        tenantId,
      );

      if (!currentBedRows.length) {
        throw AppError.notFound('Patient is not currently admitted to any bed');
      }

      const fromBed = currentBedRows[0];
      const fromBedId = fromBed.id;

      const targetBedRows = await tx.$queryRawUnsafe(
        `SELECT b.id, b.tenant_id, b.status, b.bed_number, b.bed_type, b.ward_id, w.name AS ward_name
           FROM beds b
         LEFT JOIN wards w ON w.id = b.ward_id
        WHERE b.id = $1
          AND ($2::uuid IS NULL OR b.tenant_id = $2::uuid)
        FOR UPDATE OF b`,
        toBedId,
        tenantId,
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

      const admissionRows = await tx.$queryRawUnsafe(
        `SELECT id, tenant_id, patient_uid, admitted_at, expected_los_days
           FROM admissions
          WHERE patient_uid = $1::uuid
            AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
            AND status IN ('admitted', 'transferred')
          ORDER BY admitted_at DESC NULLS LAST, id DESC
          LIMIT 1
          FOR UPDATE`,
        patientUid,
        tenantId,
      );
      if (!admissionRows.length) {
        throw AppError.badRequest('No active admission is linked to this patient');
      }
      const admission = admissionRows[0];

      const patientRows = await tx.$queryRawUnsafe(
        `SELECT id, name FROM users
          WHERE uid = $1::uuid
            AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
          LIMIT 1`,
        patientUid,
        tenantId,
      );
      const patientUser = patientRows[0] || {};
      const expectedDischarge = admission.expected_los_days
        ? new Date(
          new Date(admission.admitted_at || Date.now()).getTime()
          + Number(admission.expected_los_days) * 86400000,
        )
        : null;

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
         SET status = 'cleaning',
             patient_id = NULL,
             patient_name = NULL,
             patient_uid = NULL,
             admission_id = NULL,
             admitted_at = NULL,
             expected_discharge = NULL, updated_at = NOW()
         WHERE id = $1
           AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
        fromBedId,
        tenantId,
      );

      // Occupy new bed
      const newBed = await tx.$queryRawUnsafe(
        `UPDATE beds
         SET status = 'occupied',
             patient_id = $1,
             patient_name = $2,
             patient_uid = $3::uuid,
             admission_id = $4,
             admitted_at = NOW(),
             assigned_at = NOW(),
             expected_discharge = $5,
             updated_at = NOW()
         WHERE id = $6
           AND ($7::uuid IS NULL OR tenant_id = $7::uuid)
         RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at, bed_type`,
        patientUser.id || null,
        patientUser.name || null,
        patientUid,
        admission.id,
        expectedDischarge,
        toBedId,
        tenantId,
      );

      const VALID_ROOM_CATEGORIES = new Set(['general', 'semi_private', 'private', 'deluxe', 'icu', 'day_care']);
      const targetRoomCategory = toBed.bed_type && VALID_ROOM_CATEGORIES.has(toBed.bed_type)
        ? toBed.bed_type
        : null;
      await tx.$executeRawUnsafe(
        `UPDATE admissions
            SET bed_id = $1,
                bed_number = $2,
                ward = COALESCE($3, ward),
                status = 'transferred',
                room_category = COALESCE($4, room_category),
                updated_at = NOW()
          WHERE id = $5
            AND ($6::uuid IS NULL OR tenant_id = $6::uuid)`,
        toBedId,
        toBed.bed_number,
        toBed.ward_name || null,
        targetRoomCategory,
        admission.id,
        tenantId,
      );

      // Record transfer
      await tx.$executeRawUnsafe(
        `INSERT INTO bed_transfers (tenant_id, patient_uid, admission_id, from_bed_id, to_bed_id, reason, transferred_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)`,
        admission.tenant_id || fromBed.tenant_id,
        patientUid, admission.id, fromBedId, toBedId, reason, transferredBy
      );

      return {
        fromBedId,
        fromBedType: fromBed.bed_type,
        admissionId: admission.id,
        toBed: newBed[0],
        isUpgrade,
      };
    });

    logger.info(`Patient ${patientUid} transferred from bed ${result.fromBedId} to bed ${toBedId}`);
    try {
      await createBedCleaningRequest({
        bedId: result.fromBedId,
        requesterUid: transferredBy,
        trigger: 'bed_transfer',
        urgency: 'high',
        description: `Transfer cleaning required after patient moved to bed ${toBedId}. bed_id=${result.fromBedId}.`,
      });
    } catch (e) {
      logger.warn(`transferPatient: housekeeping dispatch failed for bed ${result.fromBedId} (continuing): ${e.message}`);
    }

    return {
      from_bed_id: result.fromBedId,
      from_bed_type: result.fromBedType,
      admission_id: result.admissionId,
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
  async getAvailableBeds(wardId, bedType, options = {}) {
    const tenantId = tenantOf(options);
    // F-2 — defensive filter: status='available' alone trusted a column
    // legacy paths (bedService.dischargePatient pre-2026-05-12) didn't
    // always clear alongside the stale occupant FKs. The combined check
    // means a bed only appears available when no occupant identifiers
    // and no active admissions row references it. Finding:
    // 2026-05-10-dynamic-acute-abdomen-admission-available-bed-retains-active-patient.
    const conditions = [
      `($1::uuid IS NULL OR tenant_id = $1::uuid)`,
      "status = 'available'",
      'patient_uid IS NULL',
      'patient_id IS NULL',
      'patient_name IS NULL',
      'admission_id IS NULL',
      "NOT EXISTS (SELECT 1 FROM admissions a WHERE a.bed_id = beds.id AND a.tenant_id = beds.tenant_id AND a.discharged_at IS NULL)",
    ];
    const params = [tenantId];
    let idx = 2;

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
  async markBedReady(bedId, { actorUid = null, cleaningTicketId = null, cleanerId = null, notes = null, tenantId = null } = {}) {
    const effectiveTenantId = tenantOf({ tenantId });
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE beds
       SET status = 'available', updated_at = NOW()
       WHERE id = $1 AND status = 'cleaning'
         AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
       RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
      bedId,
      effectiveTenantId,
    );

    if (!rows.length) {
      // Check if bed exists at all
      const check = await prisma.$queryRawUnsafe(
        `SELECT id, status FROM beds WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
        bedId,
        effectiveTenantId,
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
    await emitBedMarkedReady({
      bed: rows[0],
      bedId,
      actorUid,
      actorRole: 'HOUSEKEEPING',
      cleaningTicketId,
      cleanerId,
      notes,
    });
    return rows[0];
  }

  // =========================================================================
  // getBedHistory — Transfer and admission history for a specific bed
  // =========================================================================
  async getBedHistory(bedId, options = {}) {
    const tenantId = tenantOf(options);
    // Verify bed exists
    const bedCheck = await prisma.$queryRawUnsafe(
      `SELECT id, bed_number FROM beds WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
      bedId,
      tenantId,
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
       LEFT JOIN beds fb ON bt.from_bed_id = fb.id AND fb.tenant_id = bt.tenant_id
       LEFT JOIN beds tb ON bt.to_bed_id = tb.id AND tb.tenant_id = bt.tenant_id
       LEFT JOIN users u ON bt.patient_uid = u.uid AND u.tenant_id = bt.tenant_id
       WHERE (bt.from_bed_id = $1 OR bt.to_bed_id = $1)
         AND ($2::uuid IS NULL OR bt.tenant_id = $2::uuid)
       ORDER BY bt.transferred_at DESC
       LIMIT 200`,
      bedId,
      tenantId,
    );

    return rows;
  }
}

export default new BedManagementService();
