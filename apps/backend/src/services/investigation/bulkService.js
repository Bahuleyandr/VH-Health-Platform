// src/services/investigation/bulkService.js
// Migrated from raw pg to Prisma ORM

import { INVESTIGATION_STATUS } from '../../config/investigationConfig.js';
import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';

async function recordRequiredBulkEvent(tx, row, previous, {
  eventType,
  actorUid,
  actorRole,
  summary,
  payload = {},
}) {
  const event = await recordCanonicalClinicalEvent({
    tenantId: row.tenant_id,
    patientUid: row.patient_uid,
    eventType,
    eventSubtype: row.test_type || row.type || null,
    eventStatus: row.status,
    sourceTable: 'investigations',
    sourceId: row.id,
    resourceType: 'investigation',
    resourceId: row.id,
    actorUid,
    actorRole,
    summary,
    payload,
    beforeState: previous,
    afterState: row,
    timelineIdempotencyKey: `investigations:${row.id}:${eventType}:${row.updated_at?.toISOString?.() || 'now'}`,
    auditIdempotencyKey: `investigations:${row.id}:audit:${eventType}:${row.updated_at?.toISOString?.() || 'now'}`,
  }, { db: tx });
  if (!event?.timeline?.id || !event?.audit?.id) {
    throw AppError.internal(
      'Bulk investigation write requires canonical timeline and audit events',
      'INVESTIGATION_CANONICAL_EVENT_REQUIRED',
    );
  }
}

async function lockInvestigations(tx, investigationIds, tenantId) {
  return tx.$queryRaw`
    SELECT id, tenant_id, patient_uid, test_name, test_code, test_type, type,
           status, priority, notes, assigned_technician_id, scheduled_date,
           time_slot, cancellation_reason, updated_at
      FROM investigations
     WHERE id = ANY(${investigationIds}::int[])
       AND tenant_id = ${tenantId}::uuid
     FOR UPDATE
  `;
}

export const bulkUpdateStatus = async (
  investigationIds,
  status,
  notes,
  updatedBy,
  tenantId,
  actorRole = null,
) => {
  const normalizedStatus = String(status || '').toUpperCase();
  if (!Object.values(INVESTIGATION_STATUS).includes(normalizedStatus)) {
    throw new Error('Invalid status');
  }
  const effectiveTenantId = requireTenantId(tenantId);

  const rows = await setTenantTx(effectiveTenantId, async (tx) => {
    const previousRows = await lockInvestigations(tx, investigationIds, effectiveTenantId);
    const previousById = new Map(previousRows.map((row) => [row.id, row]));
    const updatedRows = await tx.$queryRaw`
      UPDATE investigations
      SET status     = ${normalizedStatus},
          notes      = COALESCE(${notes ?? null}, notes),
          updated_at = NOW(),
          updated_by = ${updatedBy ?? null}::uuid,
          collected_at = CASE
            WHEN ${normalizedStatus} = 'COLLECTED' THEN COALESCE(collected_at, NOW())
            ELSE collected_at
          END,
          collected_by = CASE
            WHEN ${normalizedStatus} = 'COLLECTED' THEN COALESCE(collected_by, ${updatedBy ?? null}::uuid)
            ELSE collected_by
          END,
          collected_notes = CASE
            WHEN ${normalizedStatus} = 'COLLECTED' THEN COALESCE(${notes ?? null}, collected_notes)
            ELSE collected_notes
          END,
          sample_barcode = CASE
            WHEN ${normalizedStatus} = 'COLLECTED' THEN COALESCE(
              sample_barcode,
              'INV-' || UPPER(TO_HEX(id)) || '-' ||
                UPPER(SUBSTRING(MD5(id::text || CLOCK_TIMESTAMP()::text || RANDOM()::text), 1, 6))
            )
            ELSE sample_barcode
          END,
          completed_at = CASE
            WHEN ${normalizedStatus} = 'COMPLETED' THEN COALESCE(completed_at, NOW())
            ELSE completed_at
          END,
          verified_at = CASE
            WHEN ${normalizedStatus} = 'COMPLETED' THEN COALESCE(verified_at, NOW())
            ELSE verified_at
          END,
          verified_by = CASE
            WHEN ${normalizedStatus} = 'COMPLETED' THEN COALESCE(verified_by, ${updatedBy ?? null}::uuid)
            ELSE verified_by
          END
      WHERE id = ANY(${investigationIds}::int[])
        AND tenant_id = ${effectiveTenantId}::uuid
      RETURNING id, tenant_id, patient_uid, patient_id, doctor_id, test_name,
        test_code, test_type, type, status, priority, notes, collected_at,
        collected_by, collected_notes, sample_barcode, completed_at,
        verified_at, verified_by, updated_at, updated_by
    `;
    for (const row of updatedRows) {
      await recordRequiredBulkEvent(tx, row, previousById.get(row.id), {
        eventType: 'investigation.status_changed',
        actorUid: updatedBy,
        actorRole,
        summary: `${row.test_name} status changed to ${row.status}`,
        payload: { previous_status: previousById.get(row.id)?.status || null, notes: notes || null },
      });
    }
    return updatedRows;
  });

  logger.info(`Bulk updated ${rows.length} investigations to status ${normalizedStatus}`);
  return rows;
};

export const bulkCancel = async (
  investigationIds,
  reason,
  cancelledBy,
  tenantId,
  actorRole = null,
) => {
  const effectiveTenantId = requireTenantId(tenantId);
  const rows = await setTenantTx(effectiveTenantId, async (tx) => {
    const previousRows = await lockInvestigations(tx, investigationIds, effectiveTenantId);
    const previousById = new Map(previousRows.map((row) => [row.id, row]));
    const updatedRows = await tx.$queryRaw`
      UPDATE investigations
      SET status              = 'CANCELLED',
          cancellation_reason = ${reason ?? null},
          cancelled_at        = NOW(),
          cancelled_by        = ${cancelledBy ?? null}::uuid,
          updated_at          = NOW(),
          updated_by          = ${cancelledBy ?? null}::uuid
      WHERE id = ANY(${investigationIds}::int[])
        AND tenant_id = ${effectiveTenantId}::uuid
        AND status = 'PENDING'
      RETURNING id, tenant_id, patient_uid, patient_id, doctor_id, test_name,
        test_code, test_type, type, status, cancellation_reason, cancelled_at,
        cancelled_by, updated_at, updated_by
    `;
    for (const row of updatedRows) {
      await recordRequiredBulkEvent(tx, row, previousById.get(row.id), {
        eventType: 'investigation.cancelled',
        actorUid: cancelledBy,
        actorRole,
        summary: `${row.test_name} investigation cancelled`,
        payload: { cancellation_reason: reason },
      });
    }
    return updatedRows;
  });

  logger.info(`Bulk cancelled ${rows.length} investigations`);
  return rows;
};

export const bulkAssignTechnician = async (
  investigationIds,
  technicianId,
  assignedBy,
  tenantId,
  actorRole = null,
) => {
  const effectiveTenantId = requireTenantId(tenantId);
  try {
    const rows = await setTenantTx(effectiveTenantId, async (tx) => {
      const previousRows = await lockInvestigations(tx, investigationIds, effectiveTenantId);
      const previousById = new Map(previousRows.map((row) => [row.id, row]));
      const updatedRows = await tx.$queryRaw`
        UPDATE investigations
        SET assigned_technician_id = ${technicianId}::uuid,
            updated_by             = ${assignedBy ?? null}::uuid,
            updated_at             = NOW()
        WHERE id = ANY(${investigationIds}::int[])
          AND tenant_id = ${effectiveTenantId}::uuid
        RETURNING id, tenant_id, patient_uid, test_name, test_type, type,
          status, assigned_technician_id, updated_at, updated_by
      `;
      for (const row of updatedRows) {
        await recordRequiredBulkEvent(tx, row, previousById.get(row.id), {
          eventType: 'investigation.technician_assigned',
          actorUid: assignedBy,
          actorRole,
          summary: `${row.test_name} assigned to a technician`,
          payload: { assigned_technician_id: row.assigned_technician_id },
        });
      }
      return updatedRows;
    });

    logger.info(`Assigned ${rows.length} investigations to technician ${technicianId}`);
    return rows;
  } catch (err) {
    logger.error('Bulk assign error:', err);
    throw err;
  }
};

export const bulkSchedule = async (
  investigationIds,
  scheduledDate,
  timeSlot,
  scheduledBy,
  tenantId,
  actorRole = null,
) => {
  const effectiveTenantId = requireTenantId(tenantId);
  try {
    const rows = await setTenantTx(effectiveTenantId, async (tx) => {
      const previousRows = await lockInvestigations(tx, investigationIds, effectiveTenantId);
      const previousById = new Map(previousRows.map((row) => [row.id, row]));
      const updatedRows = await tx.$queryRaw`
        UPDATE investigations
        SET scheduled_date = ${scheduledDate}::date,
            time_slot      = ${timeSlot ?? null},
            updated_by     = ${scheduledBy ?? null}::uuid,
            updated_at     = NOW(),
            status         = 'SCHEDULED'
        WHERE id = ANY(${investigationIds}::int[])
          AND tenant_id = ${effectiveTenantId}::uuid
          AND status = 'PENDING'
        RETURNING id, tenant_id, patient_uid, test_name, test_type, type, status,
          scheduled_date, time_slot, updated_at, updated_by
      `;
      for (const row of updatedRows) {
        await recordRequiredBulkEvent(tx, row, previousById.get(row.id), {
          eventType: 'investigation.scheduled',
          actorUid: scheduledBy,
          actorRole,
          summary: `${row.test_name} scheduled`,
          payload: { scheduled_date: row.scheduled_date, time_slot: row.time_slot },
        });
      }
      return updatedRows;
    });

    logger.info(`Scheduled ${rows.length} investigations for ${scheduledDate}`);
    return rows;
  } catch (err) {
    logger.error('Bulk schedule error:', err);
    throw err;
  }
};
