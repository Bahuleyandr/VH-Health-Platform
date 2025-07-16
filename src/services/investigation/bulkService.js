import db from '../../config/database.js';
import { INVESTIGATION_STATUS } from '../../config/investigationConfig.js';
import logger from '../../logging/logger.js';

export const bulkUpdateStatus = async (investigationIds, status, notes, updatedBy) => {
  if (!Object.values(INVESTIGATION_STATUS).includes(status)) {
    throw new Error('Invalid status');
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // ✅ More efficient: Update all records in a single query
    const result = await client.query(`
      UPDATE investigations 
      SET status = $1, 
          notes = COALESCE($2, notes),
          updated_at = NOW(),
          updated_by = $3
      WHERE id = ANY($4)
      RETURNING *
    `, [status, notes, updatedBy, investigationIds]);

    await client.query('COMMIT');
    logger.info(`Bulk updated ${result.rows.length} investigations to status ${status}`);
    return result.rows;

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const bulkCancel = async (investigationIds, reason, cancelledBy) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    
    // ✅ More efficient: Update all cancellable records in a single query
    const result = await client.query(`
      UPDATE investigations 
      SET status = 'CANCELLED',
          cancellation_reason = $1,
          cancelled_at = NOW(),
          cancelled_by = $2,
          updated_at = NOW(),
          updated_by = $2
      WHERE id = ANY($3) AND status = 'PENDING'
      RETURNING *
    `, [reason, cancelledBy, investigationIds]);

    await client.query('COMMIT');
    logger.info(`Bulk cancelled ${result.rows.length} investigations`);
    return result.rows;

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * ✅ ADDED: Bulk assigns investigations to a technician.
 * @returns {Array} - Array of investigation rows that were successfully assigned.
 */
export const bulkAssignTechnician = async (investigation_ids, technician_id, assignedBy) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE investigations
      SET assigned_technician_id = $1,
          updated_by = $2,
          updated_at = NOW()
      WHERE id = ANY($3)
      RETURNING id, assigned_technician_id
    `, [technician_id, assignedBy, investigation_ids]);

    await client.query('COMMIT');
    logger.info(`Assigned ${result.rows.length} investigations to technician ${technician_id}`);
    return result.rows;

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Bulk assign error:', err);
    throw err;
  } finally {
    client.release();
  }
};

/**
 * ✅ ADDED: Bulk schedules investigations for a specific date and time slot.
 * @returns {Array} - Array of investigation rows that were successfully scheduled.
 */
export const bulkSchedule = async (investigation_ids, scheduled_date, time_slot, scheduledBy) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE investigations
      SET scheduled_date = $1,
          time_slot = $2,
          updated_by = $3,
          updated_at = NOW(),
          status = 'SCHEDULED'
      WHERE id = ANY($4) AND status = 'PENDING'
      RETURNING id, scheduled_date, time_slot
    `, [scheduled_date, time_slot, scheduledBy, investigation_ids]);

    await client.query('COMMIT');
    logger.info(`Scheduled ${result.rows.length} investigations for ${scheduled_date}`);
    return result.rows;

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Bulk schedule error:', err);
    throw err;
  } finally {
    client.release();
  }
};