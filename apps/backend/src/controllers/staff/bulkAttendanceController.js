import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * Apply bulk attendance corrections
 * POST body: { corrections: [{ staff_id, date, check_in_time?, check_out_time?, reason }], reason?: string }
 */
export const bulkCorrectAttendance = async (req, res) => {
  try {
    const { corrections, reason: globalReason } = req.body;
    const adminId = req.user?.uid;

    if (!Array.isArray(corrections) || corrections.length === 0) {
      return error(res, 'corrections array is required', HTTP_STATUS.BAD_REQUEST);
    }

    if (corrections.length > 500) {
      return error(res, 'Maximum 500 corrections per request', HTTP_STATUS.BAD_REQUEST);
    }

    const results = { applied: 0, skipped: 0, errors: [] };

    // Process in batches of 50
    for (let i = 0; i < corrections.length; i += 50) {
      const batch = corrections.slice(i, i + 50);
      for (const c of batch) {
        try {
          if (!c.staff_id || !c.date) {
            results.skipped++;
            continue;
          }

          const existing = await prisma.$queryRawUnsafe(
            'SELECT id FROM staff_attendance WHERE staff_id=$1 AND DATE(check_in_time)=$2',
            c.staff_id, c.date
          );

          if (existing.length > 0) {
            // Update existing
            const updates = [];
            const vals = [];
            let idx = 1;

            if (c.check_in_time !== undefined) {
              updates.push(`check_in_time=$${idx++}`);
              vals.push(c.check_in_time || null);
            }
            if (c.check_out_time !== undefined) {
              updates.push(`check_out_time=$${idx++}`);
              vals.push(c.check_out_time || null);
            }

            if (updates.length) {
              vals.push(existing[0].id);
              await prisma.$queryRawUnsafe(
                `UPDATE staff_attendance SET ${updates.join(', ')} WHERE id=$${idx}`,
                ...vals
              );
            }
          } else if (c.check_in_time) {
            // Insert new record
            await prisma.$queryRawUnsafe(
              `INSERT INTO staff_attendance (staff_id, check_in_time, check_out_time, location)
               VALUES ($1, $2, $3, $4)`,
              
                c.staff_id,
                c.check_in_time,
                c.check_out_time || null,
                JSON.stringify({ bulk_correction: true, reason: c.reason || globalReason || 'Admin correction' })
              
            );
          }

          // Log the correction in attendance_regularization
          await prisma.$queryRawUnsafe(
            `INSERT INTO attendance_regularization (staff_id, date, reason, requested_check_in, requested_check_out, status, reviewed_by, reviewed_at)
             VALUES ($1, $2, $3, $4, $5, 'approved', $6, NOW())
             ON CONFLICT (staff_id, date) DO UPDATE SET status='approved', reviewed_by=$6, reviewed_at=NOW()`,
            
              c.staff_id,
              c.date,
              c.reason || globalReason || 'Bulk admin correction',
              c.check_in_time || null,
              c.check_out_time || null,
              adminId
            
          ).catch(e => logger.warn('Bulk attendance correction insert failed:', e.message));

          results.applied++;
        } catch (e) {
          results.errors.push({
            staff_id: c.staff_id,
            date: c.date,
            error: e.message
          });
        }
      }
    }

    success(res, results, `Bulk correction: ${results.applied} applied, ${results.skipped} skipped, ${results.errors.length} errors`);
  } catch (err) {
    logger.error('Bulk Correction Error:', err);
    error(res, 'Failed to apply bulk corrections', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get CSV template for bulk attendance correction
 */
export const getBulkTemplate = async (req, res) => {
  const csv = `staff_id,date,check_in_time,check_out_time,reason
1,2026-03-26,2026-03-26 08:00:00,2026-03-26 17:00:00,Network outage
2,2026-03-26,2026-03-26 08:30:00,2026-03-26 17:30:00,Lateness due to traffic
`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance_bulk_template.csv"');
  res.send(csv);
};
