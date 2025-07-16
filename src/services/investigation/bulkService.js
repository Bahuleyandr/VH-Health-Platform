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
    
    const results = [];
    
    for (const id of investigationIds) {
      const result = await client.query(`
        UPDATE investigations 
        SET status = $1, 
            notes = COALESCE($2, notes),
            updated_at = NOW(),
            updated_by = $3
        WHERE id = $4
        RETURNING *
      `, [status, notes, updatedBy, id]);
      
      if (result.rows.length > 0) {
        results.push(result.rows[0]);
      }
    }
    
    await client.query('COMMIT');
    
    logger.info(`Bulk updated ${results.length} investigations to status ${status}`);
    
    return results;
    
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
    
    const results = [];
    
    for (const id of investigationIds) {
      // Check if can be cancelled
      const checkResult = await client.query(
        'SELECT status FROM investigations WHERE id = $1',
        [id]
      );
      
      if (checkResult.rows.length > 0 && 
          checkResult.rows[0].status === 'PENDING') {
        const result = await client.query(`
          UPDATE investigations 
          SET status = 'CANCELLED',
              cancellation_reason = $1,
              cancelled_at = NOW(),
              cancelled_by = $2,
              updated_at = NOW(),
              updated_by = $2
          WHERE id = $3
          RETURNING *
        `, [reason, cancelledBy, id]);
        
        results.push(result.rows[0]);
      }
    }
    
    await client.query('COMMIT');
    
    logger.info(`Bulk cancelled ${results.length} investigations`);
    
    return results;
    
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};