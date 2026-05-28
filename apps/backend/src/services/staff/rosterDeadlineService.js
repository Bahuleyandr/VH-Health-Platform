import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { ROSTER_DEPARTMENT_POLICIES } from '../../config/rosterDepartmentConfig.js';

const DEFAULT_DEADLINE_WEEKDAY = 5; // Friday, before the following Monday roster week.
const DEFAULT_DEADLINE_HOUR = 17;
const ROSTER_DEADLINE_TYPE = 'ROSTER_DEADLINE';

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function getNextRosterWeekWindow(now = new Date()) {
  const base = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  const day = base.getUTCDay();
  const daysUntilMonday = ((8 - day) % 7) || 7;
  const start = addDays(base, daysUntilMonday);
  return {
    weekStart: dateOnly(start),
    weekEnd: dateOnly(addDays(start, 6)),
  };
}

export function isRosterDeadlineDue(now = new Date()) {
  const weekday = parseInteger(
    process.env.ROSTER_NEXT_WEEK_DEADLINE_WEEKDAY,
    DEFAULT_DEADLINE_WEEKDAY
  );
  const hour = parseInteger(
    process.env.ROSTER_NEXT_WEEK_DEADLINE_HOUR,
    DEFAULT_DEADLINE_HOUR
  );
  return now.getDay() === weekday && now.getHours() >= hour;
}

async function listMissingRosterDays(department, weekStart, weekEnd) {
  return prisma.$queryRawUnsafe(
    `WITH days AS (
       SELECT generate_series($2::date, $3::date, INTERVAL '1 day')::date AS roster_date
     ),
     coverage AS (
       SELECT d.roster_date,
              COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'published')::int AS board_count,
              COUNT(a.id) FILTER (WHERE b.status = 'published' AND a.status = 'published')::int AS assignment_count
         FROM days d
         LEFT JOIN staff_shift_roster_boards b
           ON b.department = $1
          AND b.roster_date = d.roster_date
         LEFT JOIN staff_shift_roster_assignments a ON a.roster_id = b.id
        GROUP BY d.roster_date
     )
     SELECT roster_date::text AS roster_date, board_count, assignment_count
       FROM coverage
      WHERE board_count = 0 OR assignment_count = 0
      ORDER BY roster_date`,
    department,
    weekStart,
    weekEnd
  );
}

function escalationRolesForDepartment(department) {
  const policy = ROSTER_DEPARTMENT_POLICIES[department];
  return [
    ...new Set([
      ...(policy?.hrProcessRoles || ['HR_STAFF']),
      'ADMIN',
      'SUPER_ADMIN',
    ]),
  ];
}

async function findEscalationRecipients(department) {
  const roles = escalationRolesForDepartment(department);
  return prisma.$queryRawUnsafe(
    `SELECT id, uid, name, phone, role
       FROM users
      WHERE is_active = true
        AND role = ANY($1::text[])
        AND phone IS NOT NULL
        AND TRIM(phone) <> ''
      ORDER BY CASE role
                 WHEN 'HR_STAFF' THEN 0
                 WHEN 'ADMIN' THEN 1
                 WHEN 'SUPER_ADMIN' THEN 2
                 ELSE 3
               END,
               name NULLS LAST,
               id`,
    roles
  );
}

async function deadlineNotificationExists(department, weekStart) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM notifications
      WHERE type = $1
        AND data->>'department' = $2
        AND data->>'week_start' = $3
      LIMIT 1`,
    ROSTER_DEADLINE_TYPE,
    department,
    weekStart
  );
  return rows.length > 0;
}

async function notifyRosterDeadline({
  department,
  weekStart,
  weekEnd,
  missingDays,
}) {
  if (await deadlineNotificationExists(department, weekStart)) {
    return { notification_count: 0, skipped_duplicate: true };
  }

  const recipients = await findEscalationRecipients(department);
  if (!recipients.length) {
    return { notification_count: 0, skipped_no_recipients: true };
  }

  const policy = ROSTER_DEPARTMENT_POLICIES[department];
  const title = `Roster missing: ${policy?.label || department}`;
  const body = `Next week roster is incomplete for ${weekStart} to ${weekEnd}. Missing ${missingDays.length} day(s).`;
  const data = {
    department,
    department_label: policy?.label || department,
    week_start: weekStart,
    week_end: weekEnd,
    missing_days: missingDays.map(row => row.roster_date),
    source: 'weekly_roster_deadline',
  };

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO notifications
       (uid, user_id, phone, title, body, type, priority, data, is_read,
        created_at, updated_at, recipient_role)
     SELECT u.uid,
            u.id,
            u.phone,
            $1,
            $2,
            $3,
            'HIGH',
            $4::jsonb,
            false,
            NOW(),
            NOW(),
            u.role
       FROM users u
      WHERE u.id = ANY($5::int[])
      RETURNING id`,
    title,
    body,
    ROSTER_DEADLINE_TYPE,
    JSON.stringify(data),
    recipients.map(row => row.id)
  );

  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO audit_logs
         (action, resource, resource_id, metadata, created_at)
       VALUES ('ROSTER_DEADLINE_ESCALATED', 'staff_shift_roster_boards', $1, $2::jsonb, NOW())`,
      department,
      JSON.stringify(data)
    );
  } catch (err) {
    logger.warn('Roster deadline audit insert failed', { error: err.message });
  }

  return { notification_count: rows.length };
}

export async function checkNextWeekRosterDeadline({
  now = new Date(),
  force = false,
  departments = Object.keys(ROSTER_DEPARTMENT_POLICIES),
} = {}) {
  if (!force && !isRosterDeadlineDue(now)) {
    return { checked: false, reason: 'deadline_not_due', escalations: [] };
  }

  const { weekStart, weekEnd } = getNextRosterWeekWindow(now);
  const escalations = [];
  for (const department of departments) {
    if (!ROSTER_DEPARTMENT_POLICIES[department]) continue;
    const missingDays = await listMissingRosterDays(department, weekStart, weekEnd);
    if (!missingDays.length) {
      escalations.push({
        department,
        week_start: weekStart,
        week_end: weekEnd,
        status: 'complete',
        missing_days: [],
        notification_count: 0,
      });
      continue;
    }

    const notification = await notifyRosterDeadline({
      department,
      weekStart,
      weekEnd,
      missingDays,
    });
    escalations.push({
      department,
      week_start: weekStart,
      week_end: weekEnd,
      status: 'missing',
      missing_days: missingDays.map(row => row.roster_date),
      ...notification,
    });
  }

  return {
    checked: true,
    week_start: weekStart,
    week_end: weekEnd,
    escalations,
  };
}

export async function runRosterDeadlineEscalation(options = {}) {
  try {
    const result = await checkNextWeekRosterDeadline(options);
    if (result.checked) {
      const missing = result.escalations.filter(row => row.status === 'missing').length;
      logger.info(`Roster deadline escalation checked ${result.escalations.length} department(s); ${missing} incomplete.`);
    }
    return result;
  } catch (err) {
    logger.error('Roster deadline escalation failed', { error: err.message });
    throw err;
  }
}

export default {
  checkNextWeekRosterDeadline,
  getNextRosterWeekWindow,
  isRosterDeadlineDue,
  runRosterDeadlineEscalation,
};
