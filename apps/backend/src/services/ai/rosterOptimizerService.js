/**
 * Staff roster optimizer.
 *
 * Solver-backed scheduler. For a department + date range, we compute each
 * day's staffing demand (from historical shift counts), pull the staff
 * pool with their preferences, and assign shifts while
 * respecting:
 *
 *   - unavailable dates (hard constraint)
 *   - max_shifts_per_week (hard constraint)
 *   - min_rest_hours between shifts (hard constraint)
 *   - preferred_shifts (soft — prefer matches)
 *
 * The default planner uses a mixed-integer solver with a greedy fallback.
 * Coverage gaps + preference conflicts are surfaced as structured
 * findings so the manager sees what the heuristic couldn't satisfy.
 * The output is a suggestion — never auto-publishes. Published rosters
 * go through staff_roster_runs.status='published'.
 */

import solver from 'javascript-lp-solver';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const SHIFT_DEFINITIONS = [
  { code: 'morning', start_hour: 7, end_hour: 15 },
  { code: 'evening', start_hour: 15, end_hour: 23 },
  { code: 'night', start_hour: 23, end_hour: 7 },
];

const SHIFT_ORDER = { morning: 0, evening: 1, night: 2 };
const SOLVER_COVERAGE_SCORE = 10000;
const SOLVER_PREFERENCE_SCORE = 150;
const SOLVER_GENERALIST_SCORE = 20;
const DEFAULT_SOLVER_TIMEOUT_MS = 750;
const DEFAULT_SOLVER_MAX_VARIABLES = 2500;

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function daysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const days = [];
  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function weekKeyOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  // ISO-ish week: Monday-anchored.
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function shiftForCode(code) {
  return SHIFT_DEFINITIONS.find((s) => s.code === code) || null;
}

function shiftStartMs(day, shift) {
  return new Date(`${day}T${String(shift.start_hour).padStart(2, '0')}:00:00Z`).getTime();
}

function shiftEndMs(day, shift) {
  const base = new Date(`${day}T${String(shift.end_hour).padStart(2, '0')}:00:00Z`).getTime();
  return shift.end_hour <= shift.start_hour ? base + 24 * 60 * 60 * 1000 : base;
}

function restHoursBetween(firstSlot, secondSlot) {
  const firstShift = shiftForCode(firstSlot.shift_code);
  const secondShift = shiftForCode(secondSlot.shift_code);
  if (!firstShift || !secondShift) return Number.POSITIVE_INFINITY;
  const firstStart = shiftStartMs(firstSlot.date, firstShift);
  const secondStart = shiftStartMs(secondSlot.date, secondShift);
  const orderedFirst = firstStart <= secondStart
    ? { slot: firstSlot, shift: firstShift }
    : { slot: secondSlot, shift: secondShift };
  const orderedSecond = firstStart <= secondStart
    ? { slot: secondSlot, shift: secondShift }
    : { slot: firstSlot, shift: firstShift };
  const firstEnd = shiftEndMs(orderedFirst.slot.date, orderedFirst.shift);
  const nextStart = shiftStartMs(orderedSecond.slot.date, orderedSecond.shift);
  return (nextStart - firstEnd) / (60 * 60 * 1000);
}

function normalizePlannerStrategy(strategy = null) {
  const raw = String(strategy || process.env.ROSTER_OPTIMIZER_STRATEGY || 'solver').toLowerCase();
  if (['greedy', 'heuristic'].includes(raw)) return 'greedy';
  if (['solver', 'mip', 'ilp', 'auto'].includes(raw)) return 'solver';
  return 'solver';
}

function demandTotal(demand) {
  return demand.reduce((sum, d) => sum + Number(d.slots_needed || 0), 0);
}

function sortRosterAssignments(assignments) {
  return [...assignments].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const shiftDelta = (SHIFT_ORDER[a.shift_code] ?? 3) - (SHIFT_ORDER[b.shift_code] ?? 3);
    if (shiftDelta !== 0) return shiftDelta;
    return String(a.staff_name || a.staff_uid).localeCompare(String(b.staff_name || b.staff_uid));
  });
}

/**
 * Pure scheduler. Takes demand (per day+shift slot count), staff (with
 * preferences), and produces an assignment matrix + gap/conflict lists.
 *
 * `demand`: [{ date, shift_code, slots_needed }]
 * `staff`:  [{ staff_uid, name, preferred_shifts:[], unavailable_dates:[],
 *             max_shifts_per_week, min_rest_hours }]
 */
export function planRosterGreedy({ demand = [], staff = [] } = {}) {
  const assignments = [];
  const coverageGaps = [];
  const preferenceConflicts = [];

  // Working counters keyed by staff_uid.
  const weeklyShifts = new Map();
  const lastShiftEnd = new Map();

  function canAssign(staffRow, day, shift) {
    if (staffRow.unavailable_dates?.includes(day)) {
      return { ok: false, reason: 'unavailable' };
    }
    const weekKey = `${staffRow.staff_uid}:${weekKeyOf(day)}`;
    const currentWeekCount = weeklyShifts.get(weekKey) || 0;
    if (currentWeekCount >= (staffRow.max_shifts_per_week ?? 5)) {
      return { ok: false, reason: 'weekly_limit' };
    }
    const lastEnd = lastShiftEnd.get(staffRow.staff_uid);
    if (lastEnd) {
      const shiftStart = new Date(`${day}T${String(shift.start_hour).padStart(2, '0')}:00:00Z`).getTime();
      const restHours = (shiftStart - lastEnd) / (60 * 60 * 1000);
      if (restHours < (staffRow.min_rest_hours ?? 10)) {
        return { ok: false, reason: 'insufficient_rest' };
      }
    }
    return { ok: true };
  }

  function recordAssignment(staffRow, day, shift) {
    assignments.push({
      date: day,
      shift_code: shift.code,
      start_hour: shift.start_hour,
      end_hour: shift.end_hour,
      staff_uid: staffRow.staff_uid,
      staff_name: staffRow.name || null,
      preferred: staffRow.preferred_shifts?.includes(shift.code) || false,
    });
    const weekKey = `${staffRow.staff_uid}:${weekKeyOf(day)}`;
    weeklyShifts.set(weekKey, (weeklyShifts.get(weekKey) || 0) + 1);
    // Night shifts wrap to next morning — end time ~7am next day.
    const endsNextDay = shift.code === 'night';
    const endTime = endsNextDay
      ? new Date(`${day}T${String(shift.end_hour).padStart(2, '0')}:00:00Z`).getTime() + 24 * 60 * 60 * 1000
      : new Date(`${day}T${String(shift.end_hour).padStart(2, '0')}:00:00Z`).getTime();
    lastShiftEnd.set(staffRow.staff_uid, endTime);
  }

  // Sort demand so we schedule in chronological order, then prioritise
  // shifts with the fewest candidates (greedy improves coverage).
  const sortedDemand = [...demand].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (SHIFT_ORDER[a.shift_code] ?? 3) - (SHIFT_ORDER[b.shift_code] ?? 3);
  });

  for (const slot of sortedDemand) {
    const shift = shiftForCode(slot.shift_code);
    if (!shift) continue;
    let filled = 0;

    // Rank candidates: (preferred_shift match) > (lowest current weekly count).
    const ranked = [...staff].sort((a, b) => {
      const prefA = a.preferred_shifts?.includes(shift.code) ? 0 : 1;
      const prefB = b.preferred_shifts?.includes(shift.code) ? 0 : 1;
      if (prefA !== prefB) return prefA - prefB;
      const wkA = weeklyShifts.get(`${a.staff_uid}:${weekKeyOf(slot.date)}`) || 0;
      const wkB = weeklyShifts.get(`${b.staff_uid}:${weekKeyOf(slot.date)}`) || 0;
      return wkA - wkB;
    });

    const reasonsWhenSkipped = new Map();
    for (const staffRow of ranked) {
      if (filled >= slot.slots_needed) break;
      const check = canAssign(staffRow, slot.date, shift);
      if (!check.ok) {
        reasonsWhenSkipped.set(staffRow.staff_uid, check.reason);
        continue;
      }
      // Soft-preference: record conflict if we had to assign someone who
      // doesn't have this shift in their preferences.
      const prefers = staffRow.preferred_shifts?.includes(shift.code);
      if (!prefers && staffRow.preferred_shifts?.length) {
        preferenceConflicts.push({
          staff_uid: staffRow.staff_uid,
          staff_name: staffRow.name || null,
          date: slot.date,
          shift_code: shift.code,
          preferred: staffRow.preferred_shifts,
          message: `Assigned to ${shift.code} but prefers ${staffRow.preferred_shifts.join(', ')}`,
        });
      }
      recordAssignment(staffRow, slot.date, shift);
      filled += 1;
    }

    if (filled < slot.slots_needed) {
      coverageGaps.push({
        date: slot.date,
        shift_code: shift.code,
        needed: slot.slots_needed,
        filled,
        shortfall: slot.slots_needed - filled,
        reasons_sample: [...reasonsWhenSkipped.entries()].slice(0, 5).map(([uid, reason]) => ({ staff_uid: uid, reason })),
      });
    }
  }

  return {
    assignments: sortRosterAssignments(assignments),
    coverage_gaps: coverageGaps,
    preference_conflicts: preferenceConflicts,
    total_slots: demandTotal(demand),
    filled_slots: assignments.length,
    optimizer: 'greedy',
    solver_status: 'not_used',
  };
}

function buildSolverFallback({ demand, staff, reason }) {
  return {
    ...planRosterGreedy({ demand, staff }),
    optimizer: 'greedy',
    solver_status: 'fallback',
    solver_fallback_reason: reason,
  };
}

function explainSolverGap({ slot, staff, assignments }) {
  const reasons = [];
  for (const staffRow of staff) {
    const assignedForStaff = assignments.filter((a) => a.staff_uid === staffRow.staff_uid);
    const reason = (() => {
      if (staffRow.unavailable_dates?.includes(slot.date)) return 'unavailable';
      const weekAssignments = assignedForStaff.filter((a) => weekKeyOf(a.date) === weekKeyOf(slot.date));
      if (weekAssignments.length >= (staffRow.max_shifts_per_week ?? 5)) return 'weekly_limit';
      const restConflict = assignedForStaff.some((assignment) => (
        restHoursBetween(
          { date: assignment.date, shift_code: assignment.shift_code },
          { date: slot.date, shift_code: slot.shift_code }
        ) < (staffRow.min_rest_hours ?? 10)
      ));
      if (restConflict) return 'insufficient_rest';
      return assignedForStaff.some((a) => a.date === slot.date) ? 'allocated_same_day' : 'allocated_elsewhere';
    })();
    reasons.push({ staff_uid: staffRow.staff_uid, reason });
  }
  return reasons.slice(0, 5);
}

function buildPreferenceConflicts(assignments, staffByUid) {
  return assignments
    .filter((assignment) => {
      const staffRow = staffByUid.get(assignment.staff_uid);
      return staffRow?.preferred_shifts?.length && !staffRow.preferred_shifts.includes(assignment.shift_code);
    })
    .map((assignment) => {
      const staffRow = staffByUid.get(assignment.staff_uid);
      return {
        staff_uid: assignment.staff_uid,
        staff_name: assignment.staff_name || null,
        date: assignment.date,
        shift_code: assignment.shift_code,
        preferred: staffRow.preferred_shifts,
        message: `Assigned to ${assignment.shift_code} but prefers ${staffRow.preferred_shifts.join(', ')}`,
      };
    });
}

function buildCoverageGaps({ demand, staff, assignments }) {
  return demand
    .map((slot) => {
      const filled = assignments.filter((a) => a.date === slot.date && a.shift_code === slot.shift_code).length;
      const needed = Number(slot.slots_needed || 0);
      if (filled >= needed) return null;
      return {
        date: slot.date,
        shift_code: slot.shift_code,
        needed,
        filled,
        shortfall: needed - filled,
        reasons_sample: explainSolverGap({ slot, staff, assignments }),
      };
    })
    .filter(Boolean);
}

function addSolverConstraint(model, name, bound) {
  if (!model.constraints[name]) {
    model.constraints[name] = bound;
  }
}

function addVariableCoefficient(model, variableName, constraintName, value = 1) {
  model.variables[variableName][constraintName] = value;
}

function normalizeDemandForSolver(demand) {
  return demand
    .map((slot, index) => ({
      ...slot,
      index,
      slots_needed: Math.max(0, Number(slot.slots_needed || 0)),
      shift: shiftForCode(slot.shift_code),
    }))
    .filter((slot) => slot.shift && slot.slots_needed > 0);
}

export function planRosterWithLinearProgramming({
  demand = [],
  staff = [],
  timeoutMs = DEFAULT_SOLVER_TIMEOUT_MS,
  maxVariables = DEFAULT_SOLVER_MAX_VARIABLES,
} = {}) {
  if (!staff.length || !demand.length) {
    return buildSolverFallback({ demand, staff, reason: 'insufficient_input' });
  }

  const normalizedDemand = normalizeDemandForSolver(demand);
  if (!normalizedDemand.length) {
    return buildSolverFallback({ demand, staff, reason: 'no_valid_demand' });
  }

  const estimatedVariableCount = normalizedDemand.length * staff.length;
  if (estimatedVariableCount > maxVariables) {
    return buildSolverFallback({ demand, staff, reason: 'solver_problem_too_large' });
  }

  const model = {
    optimize: 'score',
    opType: 'max',
    constraints: {},
    variables: {},
    binaries: {},
    timeout: timeoutMs,
  };
  const variableMetadata = new Map();
  const variablesByStaff = new Map();

  normalizedDemand.forEach((slot) => {
    addSolverConstraint(model, `slot_${slot.index}`, { max: slot.slots_needed });
  });

  staff.forEach((staffRow, staffIndex) => {
    normalizedDemand.forEach((slot) => {
      if (staffRow.unavailable_dates?.includes(slot.date)) return;
      const variableName = `x_${staffIndex}_${slot.index}`;
      const weekConstraint = `week_${staffIndex}_${weekKeyOf(slot.date)}`;
      addSolverConstraint(model, weekConstraint, { max: staffRow.max_shifts_per_week ?? 5 });
      model.variables[variableName] = {
        score: SOLVER_COVERAGE_SCORE
          + (staffRow.preferred_shifts?.includes(slot.shift_code) ? SOLVER_PREFERENCE_SCORE : 0)
          + (staffRow.preferred_shifts?.length ? 0 : SOLVER_GENERALIST_SCORE)
          + ((normalizedDemand.length - slot.index) / 1000)
          + ((staff.length - staffIndex) / 10000),
        [`slot_${slot.index}`]: 1,
        [weekConstraint]: 1,
      };
      model.binaries[variableName] = 1;
      variableMetadata.set(variableName, { staffRow, slot });
      if (!variablesByStaff.has(staffIndex)) variablesByStaff.set(staffIndex, []);
      variablesByStaff.get(staffIndex).push({ variableName, slot });
    });
  });

  for (const [staffIndex, staffVariables] of variablesByStaff.entries()) {
    const staffRow = staff[staffIndex];
    for (let i = 0; i < staffVariables.length; i += 1) {
      for (let j = i + 1; j < staffVariables.length; j += 1) {
        const first = staffVariables[i];
        const second = staffVariables[j];
        if (restHoursBetween(first.slot, second.slot) >= (staffRow.min_rest_hours ?? 10)) continue;
        const constraintName = `rest_${staffIndex}_${first.slot.index}_${second.slot.index}`;
        addSolverConstraint(model, constraintName, { max: 1 });
        addVariableCoefficient(model, first.variableName, constraintName);
        addVariableCoefficient(model, second.variableName, constraintName);
      }
    }
  }

  if (Object.keys(model.variables).length === 0) {
    return {
      assignments: [],
      coverage_gaps: buildCoverageGaps({ demand: normalizedDemand, staff, assignments: [] }),
      preference_conflicts: [],
      total_slots: demandTotal(demand),
      filled_slots: 0,
      optimizer: 'mip',
      solver_status: 'no_feasible_variables',
    };
  }

  let result;
  try {
    result = solver.Solve(model);
  } catch (err) {
    logger.debug('Roster solver failed; falling back to greedy', { error: err.message });
    return buildSolverFallback({ demand, staff, reason: 'solver_exception' });
  }

  if (!result?.feasible) {
    return buildSolverFallback({ demand, staff, reason: 'infeasible_model' });
  }

  const assignments = sortRosterAssignments(
    [...variableMetadata.entries()]
      .filter(([variableName]) => Number(result[variableName] || 0) >= 0.5)
      .map(([, meta]) => ({
        date: meta.slot.date,
        shift_code: meta.slot.shift_code,
        start_hour: meta.slot.shift.start_hour,
        end_hour: meta.slot.shift.end_hour,
        staff_uid: meta.staffRow.staff_uid,
        staff_name: meta.staffRow.name || null,
        preferred: meta.staffRow.preferred_shifts?.includes(meta.slot.shift_code) || false,
      }))
  );
  const staffByUid = new Map(staff.map((staffRow) => [staffRow.staff_uid, staffRow]));

  return {
    assignments,
    coverage_gaps: buildCoverageGaps({ demand: normalizedDemand, staff, assignments }),
    preference_conflicts: buildPreferenceConflicts(assignments, staffByUid),
    total_slots: demandTotal(demand),
    filled_slots: assignments.length,
    optimizer: 'mip',
    solver_status: 'optimal',
    solver_metadata: {
      variables: Object.keys(model.variables).length,
      constraints: Object.keys(model.constraints).length,
      result: Number(result.result || 0),
      timeout_ms: timeoutMs,
    },
  };
}

export function planRoster({ demand = [], staff = [], strategy = null, timeoutMs = DEFAULT_SOLVER_TIMEOUT_MS } = {}) {
  const planner = normalizePlannerStrategy(strategy);
  if (planner === 'greedy') return planRosterGreedy({ demand, staff });
  return planRosterWithLinearProgramming({ demand, staff, timeoutMs });
}

async function inferHistoricalDemand({ tenantId, department, startDate, endDate }) {
  // Default: 4 morning / 3 evening / 2 night per day per department.
  const days = daysBetween(startDate, endDate);
  const baseline = [
    { code: 'morning', slots: 4 },
    { code: 'evening', slots: 3 },
    { code: 'night', slots: 2 },
  ];
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT shift_code, AVG(shift_count)::numeric(10,2) AS avg_count
       FROM (
         SELECT
           CASE
             WHEN EXTRACT(HOUR FROM start_time) BETWEEN 7 AND 14 THEN 'morning'
             WHEN EXTRACT(HOUR FROM start_time) BETWEEN 15 AND 22 THEN 'evening'
             ELSE 'night'
           END AS shift_code,
           DATE(start_time) AS shift_date,
           COUNT(*) AS shift_count
         FROM shifts
         WHERE department = $1
           AND start_time >= NOW() - INTERVAL '30 days'
         GROUP BY shift_code, DATE(start_time)
       ) historical
       GROUP BY shift_code`,
      department
    ).catch(() => []);

    if (rows.length > 0) {
      const map = new Map(rows.map((r) => [r.shift_code, Math.max(1, Math.round(Number(r.avg_count)))]));
      return days.flatMap((date) => baseline.map((b) => ({
        date,
        shift_code: b.code,
        slots_needed: map.get(b.code) ?? b.slots,
      })));
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.debug('Historical demand inference skipped', { error: err.message });
    }
  }
  void tenantId;
  return days.flatMap((date) => baseline.map((b) => ({
    date,
    shift_code: b.code,
    slots_needed: b.slots,
  })));
}

async function loadStaffPool({ tenantId, department }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.uid AS staff_uid, s.name,
            COALESCE(p.preferred_shifts, '[]'::jsonb) AS preferred_shifts,
            COALESCE(p.unavailable_dates, '{}'::date[]) AS unavailable_dates,
            COALESCE(p.max_shifts_per_week, 5) AS max_shifts_per_week,
            COALESCE(p.min_rest_hours, 10) AS min_rest_hours
     FROM users s
     LEFT JOIN staff_roster_preferences p ON p.staff_uid = s.uid AND p.tenant_id = $1::uuid
     WHERE s.is_active = true
       AND s.tenant_id = $1::uuid
       AND (s.department = $2 OR $2 = '')
       AND s.role IN ('DOCTOR', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'OP_STAFF_NURSE', 'PHARMACY_STAFF', 'OT_NURSE', 'OT_INCHARGE', 'OT_STAFF', 'LAB_STAFF')
     ORDER BY s.name`,
    tenantId,
    department || ''
  ).catch(async () => {
    // Fallback for the legacy users table that may not have tenant_id /
    // department columns yet.
    return prisma.$queryRawUnsafe(
      `SELECT uid AS staff_uid, name,
              '[]'::jsonb AS preferred_shifts,
              '{}'::date[] AS unavailable_dates,
              5 AS max_shifts_per_week,
              10 AS min_rest_hours
       FROM users
       WHERE is_active = true
         AND role IN ('DOCTOR', 'NURSING_STAFF')
       LIMIT 50`
    ).catch(() => []);
  });
  return rows.map((r) => ({
    staff_uid: r.staff_uid,
    name: r.name,
    preferred_shifts: Array.isArray(r.preferred_shifts)
      ? r.preferred_shifts
      : (typeof r.preferred_shifts === 'string' ? JSON.parse(r.preferred_shifts || '[]') : []),
    unavailable_dates: Array.isArray(r.unavailable_dates)
      ? r.unavailable_dates.map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d)))
      : [],
    max_shifts_per_week: Number(r.max_shifts_per_week) || 5,
    min_rest_hours: Number(r.min_rest_hours) || 10,
  }));
}

export async function generateRoster({
  req,
  department,
  startDate,
  endDate,
  demandOverride = null,
  staffOverride = null,
  strategy = null,
  solverTimeoutMs = DEFAULT_SOLVER_TIMEOUT_MS,
} = {}) {
  if (!department) throw AppError.badRequest('department is required');
  if (!startDate || !endDate) throw AppError.badRequest('start_date + end_date required');
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });

  const demand = demandOverride || await inferHistoricalDemand({ tenantId, department, startDate, endDate });
  const staff = staffOverride || await loadStaffPool({ tenantId, department });

  if (staff.length === 0) {
    return {
      run_id: null,
      department,
      start_date: startDate,
      end_date: endDate,
      assignments: [],
      coverage_gaps: demand.map((d) => ({
        date: d.date,
        shift_code: d.shift_code,
        needed: d.slots_needed,
        filled: 0,
        shortfall: d.slots_needed,
        reasons_sample: [{ reason: 'no_staff_in_pool' }],
      })),
      preference_conflicts: [],
      total_slots: demand.reduce((sum, d) => sum + Number(d.slots_needed || 0), 0),
      filled_slots: 0,
      staff_pool_size: 0,
      module_key: 'staff_roster_optimizer',
      decision_support_only: true,
    };
  }

  const plan = planRoster({ demand, staff, strategy, timeoutMs: solverTimeoutMs });

  let runId = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO staff_roster_runs
         (tenant_id, department, start_date, end_date, requested_by, status,
          total_slots, filled_slots, coverage_gap_count, preference_conflict_count,
          suggestion, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::date, $4::date, $5::uuid, 'suggested',
               $6, $7, $8, $9, $10::jsonb, $11::jsonb, NOW(), NOW())
       RETURNING id, created_at`,
      tenantId,
      department,
      startDate,
      endDate,
      req?.user?.uid || null,
      plan.total_slots,
      plan.filled_slots,
      plan.coverage_gaps.length,
      plan.preference_conflicts.length,
      JSON.stringify(plan),
      JSON.stringify({
        staff_pool_size: staff.length,
        demand_source: demandOverride ? 'override' : 'historical',
        optimizer: plan.optimizer,
        solver_status: plan.solver_status,
        solver_fallback_reason: plan.solver_fallback_reason || null,
        solver_metadata: plan.solver_metadata || null,
      })
    );
    runId = rows[0]?.id || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Roster run persist failed', { error: err.message });
    }
  }

  return {
    run_id: runId,
    department,
    start_date: startDate,
    end_date: endDate,
    ...plan,
    staff_pool_size: staff.length,
    module_key: 'staff_roster_optimizer',
    status: 'suggested',
    decision_support_only: true,
  };
}

export async function publishRoster({ runId, publishedBy = null, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE staff_roster_runs
     SET status = 'published', published_at = NOW(), published_by = $2::uuid, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $3::uuid AND status IN ('suggested', 'edited')
     RETURNING id, status, published_at, published_by`,
    Number.parseInt(runId, 10),
    publishedBy,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Suggested roster not found');
  return rows[0];
}

export async function discardRoster({ runId, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE staff_roster_runs
     SET status = 'discarded', updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status IN ('suggested', 'edited')
     RETURNING id, status`,
    Number.parseInt(runId, 10),
    tid
  );
  if (!rows[0]) throw AppError.notFound('Roster not found');
  return rows[0];
}

export async function listRosterRuns({ tenantId = null, department = null, status = null, limit = 30 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, department, start_date, end_date, status, total_slots, filled_slots,
              coverage_gap_count, preference_conflict_count, published_at, created_at
       FROM staff_roster_runs
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR department = $2)
         AND ($3::text IS NULL OR status = $3)
       ORDER BY created_at DESC
       LIMIT $4`,
      tid,
      department,
      status,
      safeLimit
    );
    return { runs: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { runs: [], count: 0 };
    throw err;
  }
}

export default {
  discardRoster,
  generateRoster,
  listRosterRuns,
  planRoster,
  publishRoster,
};
