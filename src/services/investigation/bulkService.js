// src/services/investigation/bulkService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';
import { INVESTIGATION_STATUS } from '../../config/investigationConfig.js';
import logger from '../../logging/logger.js';

export const bulkUpdateStatus = async (investigationIds, status, notes, updatedBy) => {
  if (!Object.values(INVESTIGATION_STATUS).includes(status)) {
    throw new Error('Invalid status');
  }

  const rows = await prisma.$queryRaw`
    UPDATE investigations
    SET status     = ${status},
        notes      = COALESCE(${notes ?? null}, notes),
        updated_at = NOW(),
        updated_by = ${updatedBy ?? null}
    WHERE id = ANY(${investigationIds}::int[])
    RETURNING id, patient_id, doctor_id, test_name, test_code, type, status,
      priority, notes, updated_at, updated_by
  `;

  logger.info(`Bulk updated ${rows.length} investigations to status ${status}`);
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
