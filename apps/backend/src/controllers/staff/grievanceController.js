import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { ADMIN, SUPER_ADMIN, normalizeRole } from '../../utils/roles.js';

const VALID_GRIEVANCE_TYPES = [
  'harassment',
  'discrimination',
  'unfair_treatment',
  'unsafe_conditions',
  'workload',
  'pay_dispute',
  'schedule_conflict',
  'policy_violation',
  'other',
];
const VALID_STATUSES = [
  'submitted',
  'acknowledged',
  'under_review',
  'mediation',
  'resolved',
  'closed',
  'escalated',
];

const canRevealAnonymousReporter = (user) => {
  const roles = [user?.role, user?.rawRole].map(normalizeRole).filter(Boolean);
  return roles.includes(ADMIN) || roles.includes(SUPER_ADMIN);
};

const grievanceSelect = (revealAnonymousReporter = false) => {
  const reveal = revealAnonymousReporter ? 'TRUE' : 'FALSE';
  return `
  sg.id,
  sg.grievance_number,
  CASE
    WHEN sg.is_anonymous AND ${reveal} THEN sg.reporter_id
    WHEN sg.is_anonymous THEN NULL
    ELSE sg.reporter_id
  END as reporter_id,
  sg.grievance_type,
  sg.subject,
  sg.description,
  sg.against_whom,
  sg.department,
  sg.incident_date,
  sg.is_anonymous,
  sg.status,
  sg.priority,
  sg.assigned_to,
  sg.hr_notes,
  sg.resolution,
  sg.resolved_at,
  sg.confidential,
  sg.acknowledgement_sent,
  sg.created_at,
  sg.updated_at
`;
};

const parsePagingInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

// Staff: Submit grievance
export const submitGrievance = async (req, res) => {
  try {
    const reporterId = req.user?.uid;
    const {
      grievance_type,
      subject,
      description,
      against_whom,
      department,
      incident_date,
      is_anonymous = false,
    } = req.body;

    if (!grievance_type || !subject || !description) {
      return error(
        res,
        'grievance_type, subject, and description are required',
        HTTP_STATUS.BAD_REQUEST
      );
    }
    if (!VALID_GRIEVANCE_TYPES.includes(grievance_type)) {
      return error(
        res,
        `grievance_type must be one of: ${VALID_GRIEVANCE_TYPES.join(', ')}`,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const result = await prisma.$queryRawUnsafe(
      `
      INSERT INTO staff_grievances
        (reporter_id, grievance_type, subject, description, against_whom, department, incident_date, is_anonymous)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::date,$8)
      RETURNING id, grievance_number, reporter_id, grievance_type, subject, status,
        assigned_to, resolution, created_at, updated_at
    `,
      reporterId || null,
      grievance_type,
      subject,
      description,
      against_whom || null,
      department || null,
      incident_date || null,
      is_anonymous
    );

    const grievanceNumber = result[0].grievance_number;

    await prisma.$queryRawUnsafe(
      `
      INSERT INTO report_updates (report_type, report_id, author_role, message, is_internal)
      VALUES ('grievance', $1, 'system', $2, false)
    `,
      result[0].id,
      `Grievance ${grievanceNumber} received. ${
        is_anonymous ? 'Submitted anonymously.' : 'HR has been notified.'
      }`
    );

    success(
      res,
      {
        id: result[0].id,
        grievance_number: grievanceNumber,
        status: result[0].status,
        created_at: result[0].created_at,
      },
      `Grievance ${grievanceNumber} submitted. HR will acknowledge within 2 working days.`
    );
  } catch (err) {
    logger.error('Submit Grievance Error:', err);
    error(res, 'Failed to submit grievance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Staff: Get my grievances
export const getMyGrievances = async (req, res) => {
  try {
    const staffId = req.user?.uid;
    const grievances = await prisma.$queryRawUnsafe(
      `
      SELECT id, grievance_number, grievance_type, subject, status, is_anonymous, created_at,
             CASE WHEN status IN ('resolved','closed') THEN resolution ELSE NULL END as resolution
      FROM staff_grievances
      WHERE reporter_id = $1::uuid
      ORDER BY created_at DESC LIMIT 50
    `,
      staffId
    );
    success(res, grievances, 'Grievances fetched');
  } catch (err) {
    logger.error('Get My Grievances Error:', err);
    error(res, 'Failed to fetch grievances', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Staff: Get single grievance detail (limited fields - no internal HR notes)
export const getGrievanceDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.uid;

    const grievance = await prisma.$queryRawUnsafe(
      `
      SELECT id, grievance_number, grievance_type, subject, description, status,
             against_whom, department, incident_date, is_anonymous, priority, assigned_to, created_at,
             CASE WHEN status IN ('resolved','closed') THEN resolution ELSE NULL END as resolution
      FROM staff_grievances
      WHERE id = $1::int AND reporter_id = $2::uuid
    `,
      id,
      staffId
    );

    if (grievance.length === 0) {
      return error(res, 'Grievance not found', HTTP_STATUS.NOT_FOUND);
    }

    const updates = await prisma.$queryRawUnsafe(
      `
      SELECT ru.message, ru.created_at, ru.author_role
      FROM report_updates ru
      WHERE ru.report_type = 'grievance' AND ru.report_id = $1::int AND ru.is_internal = false
      ORDER BY ru.created_at ASC
    `,
      id
    );

    success(res, { ...grievance[0], updates }, 'Grievance detail fetched');
  } catch (err) {
    logger.error('Get Grievance Detail Error:', err);
    error(res, 'Failed to fetch grievance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin/HR: Get all grievances
export const getAllGrievances = async (req, res) => {
  try {
    const { status, grievance_type } = req.query;
    const revealAnonymousReporter = canRevealAnonymousReporter(req.user);
    const limit = parsePagingInt(req.query.limit, 50);
    const offset = parsePagingInt(req.query.offset, 0);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) {
      conditions.push(`sg.status = $${idx++}`);
      params.push(status);
    }
    if (grievance_type) {
      conditions.push(`sg.grievance_type = $${idx++}`);
      params.push(grievance_type);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const queryParams = [...params, limit, offset];

    const grievances = await prisma.$queryRawUnsafe(
      `
      SELECT ${grievanceSelect(revealAnonymousReporter)},
             CASE WHEN sg.is_anonymous THEN 'Anonymous' ELSE u.name END as reporter_name,
             CASE WHEN sg.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN u.name ELSE NULL END as anonymous_reporter_name,
             CASE WHEN sg.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN s.department ELSE NULL END as anonymous_reporter_department,
             CASE WHEN sg.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN u.uid ELSE NULL END as anonymous_reporter_uid,
             CASE WHEN sg.is_anonymous THEN NULL ELSE s.department END as reporter_department,
             u2.name as assigned_to_name
      FROM staff_grievances sg
      LEFT JOIN users u ON sg.reporter_id = u.uid
      LEFT JOIN staff s ON u.uid = s.user_id
      LEFT JOIN users u2 ON sg.assigned_to = u2.uid
      ${where}
      ORDER BY
        CASE sg.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
        sg.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `,
      ...queryParams
    );

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM staff_grievances sg ${where}`,
      ...params
    );

    success(
      res,
      {
        grievances,
        total: Number(countResult[0].count),
        limit,
        offset,
      },
      'Grievances fetched'
    );
  } catch (err) {
    logger.error('Get All Grievances Error:', err);
    error(res, 'Failed to fetch grievances', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin/HR: Get full grievance detail including internal notes
export const getGrievanceAdminDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const revealAnonymousReporter = canRevealAnonymousReporter(req.user);

    const grievance = await prisma.$queryRawUnsafe(
      `
      SELECT ${grievanceSelect(revealAnonymousReporter)},
             CASE WHEN sg.is_anonymous THEN 'Anonymous' ELSE u.name END as reporter_name,
             CASE WHEN sg.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN u.name ELSE NULL END as anonymous_reporter_name,
             CASE WHEN sg.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN s.department ELSE NULL END as anonymous_reporter_department,
             CASE WHEN sg.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN u.uid ELSE NULL END as anonymous_reporter_uid,
             CASE WHEN sg.is_anonymous THEN NULL ELSE s.department END as reporter_department,
             u2.name as assigned_to_name
      FROM staff_grievances sg
      LEFT JOIN users u ON sg.reporter_id = u.uid
      LEFT JOIN staff s ON u.uid = s.user_id
      LEFT JOIN users u2 ON sg.assigned_to = u2.uid
      WHERE sg.id = $1::int
    `,
      id
    );

    if (grievance.length === 0) {
      return error(res, 'Grievance not found', HTTP_STATUS.NOT_FOUND);
    }

    const updates = await prisma.$queryRawUnsafe(
      `
      SELECT ru.*, u.name as author_name
      FROM report_updates ru
      LEFT JOIN users u ON ru.author_id = u.uid
      WHERE ru.report_type = 'grievance' AND ru.report_id = $1::int
      ORDER BY ru.created_at ASC
    `,
      id
    );

    success(res, { ...grievance[0], updates }, 'Grievance detail fetched');
  } catch (err) {
    logger.error('Admin Get Grievance Error:', err);
    error(res, 'Failed to fetch grievance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin/HR: Update grievance
export const updateGrievance = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?.uid;
    const revealAnonymousReporter = canRevealAnonymousReporter(req.user);
    const {
      status,
      assigned_to,
      hr_notes,
      resolution,
      priority,
      public_update,
      internal_note,
    } = req.body;

    const existing = await prisma.$queryRawUnsafe(
      `
      SELECT id, grievance_number, reporter_id, grievance_type, subject, priority, status,
             assigned_to, hr_notes, resolution, created_at, updated_at
      FROM staff_grievances
      WHERE id = $1::int
    `,
      id
    );
    if (existing.length === 0) {
      return error(res, 'Grievance not found', HTTP_STATUS.NOT_FOUND);
    }

    const updates = [];
    const vals = [];
    let idx = 1;

    if (status && VALID_STATUSES.includes(status)) {
      updates.push(`status = $${idx++}`);
      vals.push(status);
      if (status === 'resolved' || status === 'closed') {
        updates.push('resolved_at = NOW()', `resolved_by = $${idx++}::uuid`);
        vals.push(adminId);
      }
      if (status === 'acknowledged') {
        updates.push('acknowledgement_sent = true');
      }
    }
    if (assigned_to) {
      updates.push(`assigned_to = $${idx++}::uuid`);
      vals.push(assigned_to);
    }
    if (hr_notes !== undefined) {
      updates.push(`hr_notes = $${idx++}`);
      vals.push(hr_notes);
    }
    if (resolution !== undefined) {
      updates.push(`resolution = $${idx++}`);
      vals.push(resolution);
    }
    if (priority) {
      updates.push(`priority = $${idx++}`);
      vals.push(priority);
    }
    updates.push('updated_at = NOW()');
    vals.push(id);

    if (updates.length > 1) {
      await prisma.$queryRawUnsafe(
        `UPDATE staff_grievances SET ${updates.join(', ')} WHERE id = $${idx}::int`,
        ...vals
      );
    }

    if (internal_note) {
      await prisma.$queryRawUnsafe(
        `
        INSERT INTO report_updates (report_type, report_id, author_id, author_role, message, is_internal)
        VALUES ('grievance',$1::int,$2::uuid,'hr',$3,true)
      `,
        id,
        adminId,
        internal_note
      );
    }
    if (public_update) {
      await prisma.$queryRawUnsafe(
        `
        INSERT INTO report_updates (report_type, report_id, author_id, author_role, message, is_internal)
        VALUES ('grievance',$1::int,$2::uuid,'hr',$3,false)
      `,
        id,
        adminId,
        public_update
      );
    }
    if (status && status !== existing[0].status) {
      await prisma.$queryRawUnsafe(
        `
        INSERT INTO report_updates (report_type, report_id, author_id, author_role, message, is_internal)
        VALUES ('grievance',$1::int,$2::uuid,'system',$3,false)
      `,
        id,
        adminId,
        `Status updated to: ${status.replace('_', ' ').toUpperCase()}`
      );
    }

    const updated = await prisma.$queryRawUnsafe(
      `
      SELECT ${grievanceSelect(revealAnonymousReporter)}, u.name as assigned_to_name
      FROM staff_grievances sg
      LEFT JOIN users u ON sg.assigned_to = u.uid
      WHERE sg.id = $1::int
    `,
      id
    );
    success(res, updated[0], 'Grievance updated');
  } catch (err) {
    logger.error('Update Grievance Error:', err);
    error(res, 'Failed to update grievance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getGrievanceStats = async (req, res) => {
  try {
    const stats = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'submitted') as new_count,
        COUNT(*) FILTER (WHERE status IN ('acknowledged','under_review','mediation')) as active_count,
        COUNT(*) FILTER (WHERE status IN ('resolved','closed')) as resolved_count,
        COUNT(*) FILTER (WHERE is_anonymous = true) as anonymous_count,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as this_month,
        COUNT(*) as total
      FROM staff_grievances
    `);
    const byType = await prisma.$queryRawUnsafe(`
      SELECT grievance_type, COUNT(*) as count FROM staff_grievances
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY grievance_type ORDER BY count DESC
    `);
    success(res, { summary: stats[0], by_type: byType }, 'Stats fetched');
  } catch (err) {
    logger.error('Grievance Stats Error:', err);
    error(res, 'Failed to fetch stats', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
