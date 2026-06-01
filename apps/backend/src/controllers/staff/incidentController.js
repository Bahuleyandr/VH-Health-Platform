import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { ADMIN, SUPER_ADMIN, normalizeRole } from '../../utils/roles.js';

const VALID_INCIDENT_TYPES = [
  'patient_fall',
  'medication_error',
  'needle_stick',
  'equipment_failure',
  'near_miss',
  'infection',
  'fire_safety',
  'patient_aggression',
  'security_breach',
  'other',
];
const VALID_SEVERITIES = ['low', 'moderate', 'severe', 'sentinel'];
const VALID_STATUSES = [
  'submitted',
  'under_review',
  'investigating',
  'resolved',
  'closed',
];

const canRevealAnonymousReporter = (user) => {
  const roles = [user?.role, user?.rawRole].map(normalizeRole).filter(Boolean);
  return roles.includes(ADMIN) || roles.includes(SUPER_ADMIN);
};

const incidentSelect = (revealAnonymousReporter = false) => {
  const reveal = revealAnonymousReporter ? 'TRUE' : 'FALSE';
  return `
  ir.id,
  ir.report_number,
  CASE
    WHEN ir.is_anonymous AND ${reveal} THEN ir.reporter_id
    WHEN ir.is_anonymous THEN NULL
    ELSE ir.reporter_id
  END as reporter_id,
  ir.incident_type,
  ir.severity,
  ir.title,
  ir.description,
  ir.location,
  ir.incident_date,
  ir.patient_involved,
  ir.patient_name,
  ir.witnesses,
  ir.immediate_action_taken,
  ir.status,
  ir.priority,
  ir.assigned_to,
  ir.admin_notes,
  ir.resolution,
  ir.resolved_at,
  ir.is_anonymous,
  ir.created_at,
  ir.updated_at
`;
};

const parsePagingInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

// Staff: Submit incident report
export const submitIncident = async (req, res) => {
  try {
    const reporterId = req.user?.uid;
    const {
      incident_type,
      severity = 'moderate',
      title,
      description,
      location,
      incident_date,
      patient_involved = false,
      patient_name,
      witnesses,
      immediate_action_taken,
      is_anonymous = false,
    } = req.body;

    if (!incident_type || !title || !description || !incident_date) {
      return error(
        res,
        'incident_type, title, description, and incident_date are required',
        HTTP_STATUS.BAD_REQUEST
      );
    }
    if (!VALID_INCIDENT_TYPES.includes(incident_type)) {
      return error(
        res,
        `incident_type must be one of: ${VALID_INCIDENT_TYPES.join(', ')}`,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    if (!VALID_SEVERITIES.includes(severity)) {
      return error(
        res,
        `severity must be one of: ${VALID_SEVERITIES.join(', ')}`,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const priority =
      severity === 'sentinel' || severity === 'severe'
        ? 'urgent'
        : severity === 'moderate'
          ? 'high'
          : 'normal';

    const result = await prisma.$queryRawUnsafe(
      `
      INSERT INTO incident_reports
        (reporter_id, incident_type, severity, title, description, location, incident_date,
         patient_involved, patient_name, witnesses, immediate_action_taken, is_anonymous, priority)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12,$13)
      RETURNING id, report_number, reporter_id, incident_type, severity, title, status, priority,
        location, incident_date, patient_involved, is_anonymous, created_at, updated_at
    `,
      reporterId || null,
      incident_type,
      severity,
      title,
      description,
      location || null,
      incident_date,
      patient_involved,
      patient_name || null,
      witnesses || null,
      immediate_action_taken || null,
      is_anonymous,
      priority
    );

    const reportNumber = result[0].report_number;

    await prisma.$queryRawUnsafe(
      `
      INSERT INTO report_updates (report_type, report_id, author_role, message, is_internal)
      VALUES ('incident', $1, 'system', $2, false)
    `,
      result[0].id,
      `Incident report ${reportNumber} submitted. Severity: ${severity.toUpperCase()}.`
    );

    success(res, result[0], `Incident report ${reportNumber} submitted successfully`);
  } catch (err) {
    logger.error('Submit Incident Error:', err);
    error(res, 'Failed to submit incident report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Staff: Get my incident reports
export const getMyIncidents = async (req, res) => {
  try {
    const staffId = req.user?.uid;
    const incidents = await prisma.$queryRawUnsafe(
      `
      SELECT id, report_number, incident_type, severity, title, status, priority,
             incident_date, created_at, is_anonymous
      FROM incident_reports
      WHERE reporter_id = $1::uuid
      ORDER BY created_at DESC LIMIT 50
    `,
      staffId
    );
    success(res, incidents, 'Incidents fetched');
  } catch (err) {
    logger.error('Get My Incidents Error:', err);
    error(res, 'Failed to fetch incidents', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Staff: Get single incident with updates thread
export const getIncidentDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.uid;

    const incident = await prisma.$queryRawUnsafe(
      `
      SELECT ${incidentSelect(false)},
        CASE WHEN ir.is_anonymous THEN 'Anonymous' ELSE u.name END as reporter_name,
        u2.name as assigned_to_name
      FROM incident_reports ir
      LEFT JOIN users u ON ir.reporter_id = u.uid
      LEFT JOIN users u2 ON ir.assigned_to = u2.uid
      WHERE ir.id = $1::int AND ir.reporter_id = $2::uuid
    `,
      id,
      staffId
    );

    if (incident.length === 0) {
      return error(res, 'Incident not found', HTTP_STATUS.NOT_FOUND);
    }

    const updates = await prisma.$queryRawUnsafe(
      `
      SELECT ru.*, u.name as author_name
      FROM report_updates ru
      LEFT JOIN users u ON ru.author_id = u.uid
      WHERE ru.report_type = 'incident' AND ru.report_id = $1::int AND ru.is_internal = false
      ORDER BY ru.created_at ASC
    `,
      id
    );

    success(res, { ...incident[0], updates }, 'Incident detail fetched');
  } catch (err) {
    logger.error('Get Incident Detail Error:', err);
    error(res, 'Failed to fetch incident', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin: Get all incidents with filters
export const getAllIncidents = async (req, res) => {
  try {
    const { status, severity, incident_type } = req.query;
    const revealAnonymousReporter = canRevealAnonymousReporter(req.user);
    const limit = parsePagingInt(req.query.limit, 50);
    const offset = parsePagingInt(req.query.offset, 0);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) {
      conditions.push(`ir.status = $${idx++}`);
      params.push(status);
    }
    if (severity) {
      conditions.push(`ir.severity = $${idx++}`);
      params.push(severity);
    }
    if (incident_type) {
      conditions.push(`ir.incident_type = $${idx++}`);
      params.push(incident_type);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const queryParams = [...params, limit, offset];

    const incidents = await prisma.$queryRawUnsafe(
      `
      SELECT ${incidentSelect(revealAnonymousReporter)},
        CASE WHEN ir.is_anonymous THEN 'Anonymous' ELSE u.name END as reporter_name,
        CASE WHEN ir.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN u.name ELSE NULL END as anonymous_reporter_name,
        CASE WHEN ir.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN s.department ELSE NULL END as anonymous_reporter_department,
        CASE WHEN ir.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN u.uid ELSE NULL END as anonymous_reporter_uid,
        CASE WHEN ir.is_anonymous THEN NULL ELSE s.department END as reporter_department,
        u2.name as assigned_to_name
      FROM incident_reports ir
      LEFT JOIN users u ON ir.reporter_id = u.uid
      LEFT JOIN staff s ON u.uid = s.user_id
      LEFT JOIN users u2 ON ir.assigned_to = u2.uid
      ${where}
      ORDER BY
        CASE ir.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
        ir.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `,
      ...queryParams
    );

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM incident_reports ir ${where}`,
      ...params
    );

    success(
      res,
      {
        incidents,
        total: Number(countResult[0].count),
        limit,
        offset,
      },
      'Incidents fetched'
    );
  } catch (err) {
    logger.error('Get All Incidents Error:', err);
    error(res, 'Failed to fetch incidents', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin: Get single incident detail with all updates
export const getAdminIncidentDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const revealAnonymousReporter = canRevealAnonymousReporter(req.user);

    const incident = await prisma.$queryRawUnsafe(
      `
      SELECT ${incidentSelect(revealAnonymousReporter)},
        CASE WHEN ir.is_anonymous THEN 'Anonymous' ELSE u.name END as reporter_name,
        CASE WHEN ir.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN u.name ELSE NULL END as anonymous_reporter_name,
        CASE WHEN ir.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN s.department ELSE NULL END as anonymous_reporter_department,
        CASE WHEN ir.is_anonymous AND ${revealAnonymousReporter ? 'TRUE' : 'FALSE'} THEN u.uid ELSE NULL END as anonymous_reporter_uid,
        CASE WHEN ir.is_anonymous THEN NULL ELSE s.department END as reporter_department,
        u2.name as assigned_to_name
      FROM incident_reports ir
      LEFT JOIN users u ON ir.reporter_id = u.uid
      LEFT JOIN staff s ON u.uid = s.user_id
      LEFT JOIN users u2 ON ir.assigned_to = u2.uid
      WHERE ir.id = $1::int
    `,
      id
    );

    if (incident.length === 0) {
      return error(res, 'Incident not found', HTTP_STATUS.NOT_FOUND);
    }

    const updates = await prisma.$queryRawUnsafe(
      `
      SELECT ru.*, u.name as author_name
      FROM report_updates ru
      LEFT JOIN users u ON ru.author_id = u.uid
      WHERE ru.report_type = 'incident' AND ru.report_id = $1::int
      ORDER BY ru.created_at ASC
    `,
      id
    );

    success(res, { ...incident[0], updates }, 'Incident detail fetched');
  } catch (err) {
    logger.error('Get Admin Incident Detail Error:', err);
    error(res, 'Failed to fetch incident', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin: Update incident status / assign / add notes
export const updateIncident = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?.uid;
    const revealAnonymousReporter = canRevealAnonymousReporter(req.user);
    const {
      status,
      assigned_to,
      admin_notes,
      resolution,
      priority,
      internal_note,
      public_update,
    } = req.body;

    const existing = await prisma.$queryRawUnsafe(
      `
      SELECT id, report_number, reporter_id, incident_type, severity, title, status, priority,
             assigned_to, admin_notes, resolution, created_at, updated_at
      FROM incident_reports
      WHERE id = $1::int
    `,
      id
    );
    if (existing.length === 0) {
      return error(res, 'Incident not found', HTTP_STATUS.NOT_FOUND);
    }

    const updates = [];
    const vals = [];
    let idx = 1;

    if (status && VALID_STATUSES.includes(status)) {
      updates.push(`status = $${idx++}`);
      vals.push(status);
      if (status === 'resolved') {
        updates.push('resolved_at = NOW()', `resolved_by = $${idx++}::uuid`);
        vals.push(adminId);
      }
    }
    if (assigned_to) {
      updates.push(`assigned_to = $${idx++}::uuid`);
      vals.push(assigned_to);
    }
    if (admin_notes !== undefined) {
      updates.push(`admin_notes = $${idx++}`);
      vals.push(admin_notes);
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
        `UPDATE incident_reports SET ${updates.join(', ')} WHERE id = $${idx}::int`,
        ...vals
      );
    }

    if (internal_note) {
      await prisma.$queryRawUnsafe(
        `
        INSERT INTO report_updates (report_type, report_id, author_id, author_role, message, is_internal)
        VALUES ('incident',$1::int,$2::uuid,'admin',$3,true)
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
        VALUES ('incident',$1::int,$2::uuid,'admin',$3,false)
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
        VALUES ('incident',$1::int,$2::uuid,'system',$3,false)
      `,
        id,
        adminId,
        `Status updated to: ${status.replace('_', ' ').toUpperCase()}`
      );
    }

    const updated = await prisma.$queryRawUnsafe(
      `
      SELECT ${incidentSelect(revealAnonymousReporter)}, u.name as assigned_to_name
      FROM incident_reports ir
      LEFT JOIN users u ON ir.assigned_to = u.uid
      WHERE ir.id = $1::int
    `,
      id
    );
    success(res, updated[0], 'Incident updated');
  } catch (err) {
    logger.error('Update Incident Error:', err);
    error(res, 'Failed to update incident', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin: Stats summary
export const getIncidentStats = async (req, res) => {
  try {
    const stats = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'submitted') as new_count,
        COUNT(*) FILTER (WHERE status = 'under_review' OR status = 'investigating') as active_count,
        COUNT(*) FILTER (WHERE severity = 'sentinel') as sentinel_count,
        COUNT(*) FILTER (WHERE severity = 'severe') as severe_count,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as this_week,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as this_month,
        COUNT(*) as total
      FROM incident_reports
    `);

    const byType = await prisma.$queryRawUnsafe(`
      SELECT incident_type, COUNT(*) as count
      FROM incident_reports
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY incident_type ORDER BY count DESC
    `);

    success(res, { summary: stats[0], by_type: byType }, 'Stats fetched');
  } catch (err) {
    logger.error('Incident Stats Error:', err);
    error(res, 'Failed to fetch stats', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
