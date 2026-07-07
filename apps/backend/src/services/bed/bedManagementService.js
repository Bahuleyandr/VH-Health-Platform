// src/services/bed/bedManagementService.js
// Bed management: occupancy stats + admit/discharge/transfer workflows.
// Writes use prisma.$transaction for atomic multi-statement blocks (FOR
// UPDATE row lock → conditional INSERT/UPDATE → state commit). Reads use
// plain prisma.$queryRaw*.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import { requireTenantId } from '../tenant/tenantService.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { ICU_BED_TYPES, canAllocateIcu } from '../../utils/roleHelpers.js';
import { createBedCleaningRequest } from '../staff/housekeepingTaskDispatchService.js';
import { emitBedMarkedReady, emitFinalDischargeCompleted } from '../clinical/canonicalOperationalBridgeService.js';
import {
  completeWorkflowSla,
  startWorkflowSla,
} from '../clinical/canonicalClinicalPlatformService.js';
import { endActiveAssociationsForPatient } from '../devices/deviceAssociationService.js';

function tenantOf(options = {}) {
  return options.tenantId || getCurrentTenantId() || null;
}

// Start the canonical bed-cleaning-turnaround SLA, keyed to the BED, INSIDE the
// caller's bed-write transaction (`tx`). Audit §3: the cleaning-SLA start was
// previously only created post-commit + best-effort inside createBedCleaningRequest
// (keyed to the housekeeping_requests row) — so if that swallowed dispatch failed,
// a bed could go to 'cleaning' with NO turnaround clock running at all (an
// infection-control / throughput tracking gap). Anchoring an SLA instance to the
// bed itself makes the start atomic with the bed→cleaning flip: it commits with
// the bed write or rolls back with it. The post-commit housekeeping dispatch still
// starts its own request-keyed SLA for the fan-out/assignment workflow; this
// bed-keyed instance is the durable safety clock. Uses the SAME canonical rule
// (`bed_cleaning_turnaround`, migration 269, target 30 min) so both clocks agree.
async function startBedCleaningSlaInTx(tx, { tenantId, bedId, patientUid = null, trigger }) {
  return startWorkflowSla({
    tenantId,
    ruleCode: 'bed_cleaning_turnaround',
    patientUid,
    sourceTable: 'beds',
    sourceId: String(bedId),
    priority: 'high',
    metadata: { bed_id: bedId, trigger },
  }, { db: tx });
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
    const result = await setTenantTx(requireTenantId(tenantId), async (tx) => {
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
    const { updated, patientUid, admissionId } = await setTenantTx(requireTenantId(tenantId), async (tx) => {
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

      let closedAdmission = null;
      if (activeAdmission) {
        const closedRows = await tx.$queryRawUnsafe(
          `UPDATE admissions
              SET status = 'discharged',
                  discharged_at = NOW(),
                  discharge_type = COALESCE(discharge_type, 'home'),
                  updated_at = NOW()
            WHERE id = $1
              AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
          RETURNING id, tenant_id, patient_uid, encounter_id, status, discharge_type, discharged_at`,
          activeAdmission.id,
          tenantId,
        );
        closedAdmission = closedRows[0] || null;
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
        await endActiveAssociationsForPatient({
          tenantId: requireTenantId(tenantId),
          patientUid: dischargePatientUid,
          reason: 'discharge',
          actorUid: dischargedBy,
          actorRole: 'DISCHARGE',
        }, { db: tx });
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

      // Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
      // a bed-side discharge that closes an admission must persist the canonical
      // discharge.completed timeline + audit events in the SAME transaction as
      // the admission close + bed turnover — not just flip the bed. Emitted on
      // `tx` so a canonical-write failure rolls the whole discharge back rather
      // than leaving a discharged admission with no timeline/audit row. Only
      // fires when an admission was actually closed (a bedService-legacy bed with
      // no admission row has nothing to record here).
      if (closedAdmission) {
        await emitFinalDischargeCompleted({
          db: tx,
          admission: closedAdmission,
          actorUid: dischargedBy,
          actorRole: 'DISCHARGE',
          payload: { bed_id: bedId, discharge_path: 'bed_management' },
        });
      }

      // Atomic cleaning-SLA start (audit §3a): the bed just went to 'cleaning',
      // so start the bed-cleaning-turnaround clock in THIS tx — not post-commit
      // best-effort inside createBedCleaningRequest below.
      await startBedCleaningSlaInTx(tx, {
        tenantId: requireTenantId(tenantId),
        bedId,
        patientUid: dischargePatientUid,
        trigger: 'final_discharge',
      });

      return {
        updated: updated[0],
        patientUid: dischargePatientUid,
        admissionId: activeAdmission?.id || null,
      };
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
        admissionId,
        patientUid,
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
    const result = await setTenantTx(requireTenantId(tenantId), async (tx) => {
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
      await endActiveAssociationsForPatient({
        tenantId: requireTenantId(tenantId),
        patientUid,
        reason: 'transfer',
        actorUid: transferredBy,
        actorRole,
      }, { db: tx });

      // Atomic cleaning-SLA start (audit §3a): the vacated (from) bed just went
      // to 'cleaning', so start its turnaround clock in THIS tx rather than
      // relying on the post-commit best-effort createBedCleaningRequest below.
      await startBedCleaningSlaInTx(tx, {
        tenantId: requireTenantId(tenantId),
        bedId: fromBedId,
        patientUid,
        trigger: 'bed_transfer',
      });

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
  // Requires PROOF-OF-CLEANING (audit 2026-06-18 §4): a bed cannot go
  // cleaning → available unless the caller supplies either a `cleanerId` (a
  // direct attestation that a named cleaner did the turnover) OR a
  // `cleaningTicketId` that resolves to a housekeeping_requests row in a
  // RESOLVED state (completed/verified). Previously a bed could be readied with
  // no ticket and no cleaner — an infection-control proof gap.
  //
  // The bed flip + audit row are written SYNCHRONOUSLY in ONE transaction (was
  // a fire-and-forget setImmediate audit that could be lost on crash/exit), so
  // every bed that goes available carries a durable record of who closed the
  // cleaning loop with what proof.
  // Findings:
  //   2026-05-09-inpatient-admission-housekeeping-bed-ready-no-proof-required
  // =========================================================================
  async markBedReady(bedId, { actorUid = null, cleaningTicketId = null, cleanerId = null, notes = null, tenantId = null } = {}) {
    const effectiveTenantId = tenantOf({ tenantId });

    // Proof-of-cleaning gate. A cleanerId is direct attestation; otherwise the
    // cleaning ticket must exist and be resolved. Pre-flight on plain prisma so
    // a P2025/validation issue surfaces as a 4xx, not a 500 inside the tx.
    if (!cleanerId && !cleaningTicketId) {
      throw AppError.badRequest(
        'Proof of cleaning required to mark a bed ready — supply a resolved cleaning_ticket_id or the cleaner_id who performed the turnover.',
        'BED_READY_PROOF_REQUIRED',
      );
    }
    if (!cleanerId && cleaningTicketId) {
      // housekeeping_requests has no tenant_id column (it is keyed by
      // requester_id / zone), so the ticket id is the scope here.
      const ticketRows = await prisma.$queryRawUnsafe(
        `SELECT id, status, completed_at, verified_at
           FROM housekeeping_requests
          WHERE id = $1
          LIMIT 1`,
        Number(cleaningTicketId),
      );
      const ticket = ticketRows[0];
      // Resolved = a real completion signal. An 'open'/'assigned'/'in_progress'
      // ticket is NOT proof the room was actually cleaned.
      const resolved = ticket
        && (['completed', 'verified'].includes(String(ticket.status || '').toLowerCase())
          || ticket.completed_at != null
          || ticket.verified_at != null);
      if (!resolved) {
        throw AppError.badRequest(
          `Cleaning ticket ${cleaningTicketId} is not resolved — a bed can only be readied against a completed/verified cleaning ticket (or with a cleaner_id attestation).`,
          'BED_READY_PROOF_UNRESOLVED',
        );
      }
    }

    // Atomic: the bed flip + audit row commit together (synchronous, no
    // setImmediate). RLS-scoped under the beds tenant_isolation policy.
    const rows = await setTenantTx(requireTenantId(effectiveTenantId), async (tx) => {
      const updated = await tx.$queryRawUnsafe(
        `UPDATE beds
         SET status = 'available', updated_at = NOW()
         WHERE id = $1 AND status = 'cleaning'
           AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
         RETURNING id, bed_number, ward_id, status, patient_uid, assigned_at, created_at, updated_at`,
        bedId,
        effectiveTenantId,
      );

      if (!updated.length) {
        // Check if bed exists at all (still inside the tx — a read is harmless).
        const check = await tx.$queryRawUnsafe(
          `SELECT id, status FROM beds WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)`,
          bedId,
          effectiveTenantId,
        );
        if (!check.length) {
          throw AppError.notFound('Bed not found');
        }
        throw AppError.badRequest(
          `Bed is not in cleaning status (current status: ${check[0].status})`,
        );
      }

      // Synchronous audit write (audit 2026-06-18 §4): in-band + in-tx so it is
      // never lost to a deferred-callback race.
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (uid, action, resource, resource_id, metadata)
         VALUES ($1::uuid, 'BED_MARKED_READY', 'bed', $2, $3::jsonb)`,
        actorUid ? String(actorUid) : null,
        String(bedId),
        JSON.stringify({
          prior_status: 'cleaning',
          new_status: 'available',
          bed_number: updated[0].bed_number,
          ward_id: updated[0].ward_id,
          cleaning_ticket_id: cleaningTicketId || null,
          cleaner_id: cleanerId || null,
          notes: notes || null,
          transition_at: new Date().toISOString(),
        }),
      );

      // Complete the bed-keyed cleaning-turnaround SLA in the SAME tx as the
      // bed→available flip (audit §3a). This closes the durable clock started
      // atomically at discharge/transfer. completeWorkflowSla is a no-op when no
      // matching instance exists (e.g. a bed seeded directly into 'cleaning'),
      // so it is safe regardless of how the bed entered cleaning.
      await completeWorkflowSla({
        tenantId: requireTenantId(effectiveTenantId),
        ruleCode: 'bed_cleaning_turnaround',
        sourceTable: 'beds',
        sourceId: String(bedId),
        metadata: {
          marked_ready_by: actorUid || null,
          cleaning_ticket_id: cleaningTicketId || null,
          cleaner_id: cleanerId || null,
        },
      }, { db: tx });

      return updated;
    });

    logger.info(`Bed ${bedId} marked as available by ${actorUid || 'unknown'}`);
    // Canonical bed.ready timeline/audit + cleaning-SLA completion — best-effort
    // (the operational bridge swallows internally) and post-commit.
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
