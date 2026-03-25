import db from '../../config/database.js';
import logger from '../../logging/logger.js';

/**
 * Get staff's current shift assignment
 */
export async function getStaffShift(staffId) {
  const res = await db.query(`
    SELECT ss.* FROM staff_shifts ss
    JOIN staff_shift_assignments ssa ON ss.id = ssa.shift_id
    WHERE ssa.staff_id = $1
      AND ssa.effective_from <= CURRENT_DATE
      AND (ssa.effective_to IS NULL OR ssa.effective_to >= CURRENT_DATE)
    ORDER BY ssa.effective_from DESC LIMIT 1
  `, [staffId]);
  return res.rows[0] || null;
}

/**
 * Calculate attendance status given shift and check-in time
 */
export function classifyAttendance(shift, checkInTime) {
  if (!shift || !checkInTime) return { status: 'unclassified', minutesLate: null };
  
  const checkIn = new Date(checkInTime);
  const shiftDate = checkIn.toISOString().split('T')[0];
  
  // Build shift start as datetime
  const [sh, sm] = shift.start_time.split(':').map(Number);
  const shiftStart = new Date(`${shiftDate}T${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}:00`);
  
  const minutesLate = Math.round((checkIn - shiftStart) / 60000);
  
  if (minutesLate <= shift.grace_period_minutes) {
    return { status: 'on_time', minutesLate: Math.max(0, minutesLate) };
  }
  if (minutesLate <= shift.late_threshold_minutes) {
    return { status: 'late', minutesLate };
  }
  if (minutesLate <= shift.absent_threshold_minutes) {
    return { status: 'very_late', minutesLate };
  }
  return { status: 'absent_late', minutesLate };
}

/**
 * Calculate overtime given shift end and check-out time
 */
export function calculateOvertime(shift, checkInTime, checkOutTime) {
  if (!shift || !checkOutTime || !checkInTime) return 0;
  
  const checkOut = new Date(checkOutTime);
  const checkIn = new Date(checkInTime);
  const shiftDate = checkIn.toISOString().split('T')[0];
  
  const [eh, em] = shift.end_time.split(':').map(Number);
  let shiftEnd = new Date(`${shiftDate}T${String(eh).padStart(2,'0')}:${String(em).padStart(2,'0')}:00`);
  
  // Night shift: end is next day if end time < start time
  if (shiftEnd < checkIn) shiftEnd.setDate(shiftEnd.getDate() + 1);
  
  const overtimeMs = checkOut - shiftEnd;
  if (overtimeMs <= 0) return 0;
  return Math.round((overtimeMs / 3600000) * 100) / 100; // hours, 2dp
}

/**
 * List all active shifts
 */
export async function getAllShifts() {
  const res = await db.query('SELECT * FROM staff_shifts WHERE is_active = true ORDER BY start_time');
  return res.rows;
}

/**
 * Assign shift to staff
 */
export async function assignShift(staffId, shiftId, effectiveFrom) {
  const res = await db.query(`
    INSERT INTO staff_shift_assignments (staff_id, shift_id, effective_from)
    VALUES ($1, $2, $3)
    ON CONFLICT (staff_id, effective_from) DO UPDATE SET shift_id = $2
    RETURNING *
  `, [staffId, shiftId, effectiveFrom || new Date().toISOString().split('T')[0]]);
  return res.rows[0];
}
