import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

/**
 * Get staff's current shift assignment
 */
export async function getStaffShift(staffId) {
  const res = await prisma.$queryRawUnsafe(`
    SELECT ss.id, ss.name, ss.start_time, ss.end_time, ss.is_active, ss.is_preset, ss.grace_minutes, ss.created_at FROM staff_shifts ss
    JOIN staff_shift_assignments ssa ON ss.id = ssa.shift_id
    WHERE ssa.staff_id = $1
      AND ssa.effective_from <= CURRENT_DATE
      AND (ssa.effective_to IS NULL OR ssa.effective_to >= CURRENT_DATE)
    ORDER BY ssa.effective_from DESC LIMIT 1
  `, [staffId]);
  return res[0] || null;
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
 * List all active shifts — presets first, then custom sorted by name
 */
export async function getAllShifts() {
  const res = await prisma.$queryRawUnsafe(`
    SELECT id, name, start_time, end_time, is_active, is_preset, grace_minutes, created_at FROM staff_shifts
    WHERE is_active = true
    ORDER BY is_preset DESC, start_time ASC
  `);
  return res.rows;
}

/**
 * Get preset shifts only
 */
export async function getPresetShifts() {
  const res = await prisma.$queryRawUnsafe(`
    SELECT id, name, start_time, end_time, is_active, is_preset, grace_minutes, created_at FROM staff_shifts WHERE is_active = true AND is_preset = true ORDER BY start_time
  `);
  return res.rows;
}

/**
 * Create a custom shift (non-preset)
 */
export async function createCustomShift({ name, start_time, end_time, grace_period_minutes, late_threshold_minutes, absent_threshold_minutes, department }) {
  if (!name || !start_time || !end_time) throw new Error('name, start_time, and end_time are required');

  // Validate time format HH:MM
  const timeRegex = /^\d{2}:\d{2}$/;
  if (!timeRegex.test(start_time) || !timeRegex.test(end_time)) {
    throw new Error('Times must be in HH:MM format');
  }

  const res = await prisma.$queryRawUnsafe(`
    INSERT INTO staff_shifts (name, start_time, end_time, grace_period_minutes, late_threshold_minutes, absent_threshold_minutes, department, is_preset, is_active)
    VALUES ($1, $2, $3, $4, $5, $6, $7, false, true)
    RETURNING id, name, start_time, end_time, is_active, is_preset, grace_minutes, created_at
  `, [
    name.trim(),
    start_time,
    end_time,
    grace_period_minutes ?? 15,
    late_threshold_minutes ?? 30,
    absent_threshold_minutes ?? 60,
    department || null,
  ]);
  return res[0];
}

/**
 * Update a custom shift (presets cannot be edited — update their fields would affect all staff)
 */
export async function updateCustomShift(shiftId, updates) {
  // Don't allow editing preset shifts
  const existing = await prisma.$queryRawUnsafe('SELECT is_preset FROM staff_shifts WHERE id = $1', [shiftId]);
  if (!existing.rows.length) throw new Error('Shift not found');
  if (existing[0].is_preset) throw new Error('Preset shifts cannot be edited. Create a custom shift instead.');

  const allowed = ['name', 'start_time', 'end_time', 'grace_period_minutes', 'late_threshold_minutes', 'absent_threshold_minutes', 'department'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (!fields.length) throw new Error('No valid fields to update');

  const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map(f => updates[f]);

  const res = await prisma.$queryRawUnsafe(
    `UPDATE staff_shifts SET ${setClauses} WHERE id = $1 RETURNING id, name, start_time, end_time, is_active, is_preset, grace_minutes, created_at`,
    [shiftId, ...values]
  );
  return res[0];
}

/**
 * Deactivate a custom shift (soft delete)
 */
export async function deactivateShift(shiftId) {
  const existing = await prisma.$queryRawUnsafe('SELECT is_preset FROM staff_shifts WHERE id = $1', [shiftId]);
  if (!existing.rows.length) throw new Error('Shift not found');
  if (existing[0].is_preset) throw new Error('Preset shifts cannot be deleted');

  const res = await prisma.$queryRawUnsafe(
    'UPDATE staff_shifts SET is_active = false WHERE id = $1 RETURNING id, name, start_time, end_time, is_active, is_preset, grace_minutes, created_at',
    [shiftId]
  );
  return res[0];
}

/**
 * Assign shift to staff
 */
export async function assignShift(staffId, shiftId, effectiveFrom) {
  const res = await prisma.$queryRawUnsafe(`
    INSERT INTO staff_shift_assignments (staff_id, shift_id, effective_from)
    VALUES ($1, $2, $3)
    ON CONFLICT (staff_id, effective_from) DO UPDATE SET shift_id = $2
    RETURNING id, staff_id, shift_id, effective_from
  `, [staffId, shiftId, effectiveFrom || new Date().toISOString().split('T')[0]]);
  return res[0];
}
