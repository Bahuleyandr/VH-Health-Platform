// src/services/investigation/bulkService.js
// Migrated from raw pg to Prisma ORM

import { INVESTIGATION_STATUS } from '../../config/investigationConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

export const bulkUpdateStatus = async (investigationIds, status, notes, updatedBy) => {
  const normalizedStatus = String(status || '').toUpperCase();
  if (!Object.values(INVESTIGATION_STATUS).includes(normalizedStatus)) {
    throw new Error('Invalid status');
  }

  const rows = await prisma.$queryRaw`
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
    RETURNING id, patient_id, doctor_id, test_name, test_code, type, status,
      priority, notes, collected_at, collected_by, collected_notes,
      sample_barcode, completed_at, verified_at, verified_by, updated_at, updated_by
  `;

  logger.info(`Bulk updated ${rows.length} investigations to status ${normalizedStatus}`);
  return rows;
};

export const bulkCancel = async (investigationIds, reason, cancelledBy) => {
  const rows = await prisma.$queryRaw`
    UPDATE investigations
    SET status              = 'CANCELLED',
        cancellation_reason = ${reason ?? null},
        cancelled_at        = NOW(),
        cancelled_by        = ${cancelledBy ?? null},
        updated_at          = NOW(),
        updated_by          = ${cancelledBy ?? null}
    WHERE id = ANY(${investigationIds}::int[]) AND status = 'PENDING'
    RETURNING id, patient_id, doctor_id, test_name, test_code, type, status,
      cancellation_reason, cancelled_at, cancelled_by, updated_at, updated_by
  `;

  logger.info(`Bulk cancelled ${rows.length} investigations`);
  return rows;
};

export const bulkAssignTechnician = async (investigation_ids, technician_id, assignedBy) => {
  try {
    const rows = await prisma.$queryRaw`
      UPDATE investigations
      SET assigned_technician_id = ${parseInt(technician_id)},
          updated_by             = ${assignedBy ?? null},
          updated_at             = NOW()
      WHERE id = ANY(${investigation_ids}::int[])
      RETURNING id, assigned_technician_id
    `;

    logger.info(`Assigned ${rows.length} investigations to technician ${technician_id}`);
    return rows;
  } catch (err) {
    logger.error('Bulk assign error:', err);
    throw err;
  }
};

export const bulkSchedule = async (investigation_ids, scheduled_date, time_slot, scheduledBy) => {
  try {
    const rows = await prisma.$queryRaw`
      UPDATE investigations
      SET scheduled_date = ${scheduled_date}::date,
          time_slot      = ${time_slot ?? null},
          updated_by     = ${scheduledBy ?? null},
          updated_at     = NOW(),
          status         = 'SCHEDULED'
      WHERE id = ANY(${investigation_ids}::int[]) AND status = 'PENDING'
      RETURNING id, scheduled_date, time_slot
    `;

    logger.info(`Scheduled ${rows.length} investigations for ${scheduled_date}`);
    return rows;
  } catch (err) {
    logger.error('Bulk schedule error:', err);
    throw err;
  }
};
