/**
 * Report Audit Controller
 * Super-admin oversight of incident reports and grievances.
 * Tracks SLA compliance, HR/admin activity, unresolved items, and action history.
 * All queries are read-only — no mutations here.
 */
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// ─── SLA thresholds (hours) ──────────────────────────────────────────────────
const SLA = {
  incident: {
    low:      { acknowledge: 48, resolve: 168 },  // 2d / 7d
    moderate: { acknowledge: 24, resolve: 72  },  // 1d / 3d
    severe:   { acknowledge: 4,  resolve: 24  },  // 4h / 24h
    sentinel: { acknowledge: 1,  resolve: 24  },  // 1h / 24h
  },
  grievance: {
    normal: { acknowledge: 48, resolve: 336 },    // 2d / 14d
    high:   { acknowledge: 24, resolve: 168 },    // 1d / 7d
    urgent: { acknowledge: 4,  resolve: 72  },    // 4h / 3d
  },
};

// ─── Overall audit dashboard ─────────────────────────────────────────────────
export const getAuditDashboard = async (req, res) => {
  try {
    const [incidentSummary, grievanceSummary, slaBreaches, recentActivity, unassigned] = await Promise.all([

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed')) as open_count,
          COUNT(*) FILTER (WHERE status = 'submitted' AND created_at < NOW() - INTERVAL '24 hours') as overdue_new,
          COUNT(*) FILTER (WHERE severity = 'sentinel' AND status NOT IN ('resolved','closed')) as open_sentinel,
          COUNT(*) FILTER (WHERE severity = 'severe'   AND status NOT IN ('resolved','closed')) as open_severe,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as this_week,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as this_month,
          AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL) as avg_resolution_hours
        FROM incident_reports
      `),

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed')) as open_count,
          COUNT(*) FILTER (WHERE status = 'submitted' AND created_at < NOW() - INTERVAL '48 hours') as overdue_new,
          COUNT(*) FILTER (WHERE is_anonymous = true AND status NOT IN ('resolved','closed')) as open_anonymous,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as this_week,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as this_month,
          AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL) as avg_resolution_hours
        FROM staff_grievances
      `),

      // SLA breaches — incidents past acknowledge threshold with no update
      prisma.$queryRawUnsafe(`
        SELECT
          'incident' as type,
          ir.id,
          ir.report_number,
          ir.severity,
          ir.title,
          ir.status,
          ir.created_at,
          ir.assigned_to,
          u.name as assigned_to_name,
          EXTRACT(EPOCH FROM (NOW() - ir.created_at))/3600 as hours_open,
          (SELECT COUNT(*) FROM report_updates ru WHERE ru.report_type='incident' AND ru.report_id=ir.id AND ru.author_role != 'system') as admin_action_count
        FROM incident_reports ir
        LEFT JOIN users u ON ir.assigned_to = u.uid
        WHERE ir.status NOT IN ('resolved','closed')
          AND ir.created_at < NOW() - (
            CASE ir.severity
              WHEN 'sentinel' THEN INTERVAL '1 hour'
              WHEN 'severe'   THEN INTERVAL '4 hours'
              WHEN 'moderate' THEN INTERVAL '24 hours'
              ELSE                 INTERVAL '48 hours'
            END
          )
        ORDER BY
          CASE ir.severity WHEN 'sentinel' THEN 1 WHEN 'severe' THEN 2 WHEN 'moderate' THEN 3 ELSE 4 END,
          ir.created_at ASC
        LIMIT 20
      `),

      // Recent admin/HR activity
      prisma.$queryRawUnsafe(`
        SELECT
          ru.id,
          ru.report_type,
          ru.report_id,
          ru.author_role,
          ru.message,
          ru.is_internal,
          ru.created_at,
          u.name as author_name,
          CASE ru.report_type
            WHEN 'incident' THEN (SELECT report_number FROM incident_reports WHERE id = ru.report_id)
            ELSE (SELECT grievance_number FROM staff_grievances WHERE id = ru.report_id)
          END as report_number
        FROM report_updates ru
        LEFT JOIN users u ON ru.author_id = u.uid
        WHERE ru.author_role IN ('admin','hr')
        ORDER BY ru.created_at DESC
        LIMIT 30
      `),

      // Unassigned open reports
      prisma.$queryRawUnsafe(`
        SELECT 'incident' as type, id, report_number, severity as priority_indicator, title as subject, created_at
        FROM incident_reports
        WHERE assigned_to IS NULL AND status NOT IN ('resolved','closed')
        UNION ALL
        SELECT 'grievance' as type, id, grievance_number, priority as priority_indicator, subject, created_at
        FROM staff_grievances
        WHERE assigned_to IS NULL AND status NOT IN ('resolved','closed')
        ORDER BY created_at ASC
        LIMIT 20
      `),
    ]);

    success(res, {
      incidents: incidentSummary[0],
      grievances: grievanceSummary[0],
      sla_breaches: slaBreaches,
      recent_activity: recentActivity,
      unassigned: unassigned,
      sla_config: SLA,
    }, 'Audit dashboard fetched');
  } catch (err) {
    logger.error('Audit Dashboard Error:', err);
    error(res, 'Failed to fetch audit dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Full audit trail for a specific report ──────────────────────────────────
export const getReportAuditTrail = async (req, res) => {
  try {
    const { type, id } = req.params;

    if (!['incident', 'grievance'].includes(type)) {
      return error(res, 'type must be incident or grievance', HTTP_STATUS.BAD_REQUEST);
    }

    const reportQuery = type === 'incident'
      ? `SELECT ir.*, u.name as reporter_name, s.department as reporter_dept,
                u2.name as assigned_to_name, u3.name as resolved_by_name
         FROM incident_reports ir
         LEFT JOIN users u ON ir.reporter_id = u.uid
         LEFT JOIN staff s ON u.uid = s.user_id
         LEFT JOIN users u2 ON ir.assigned_to = u2.uid
         LEFT JOIN users u3 ON ir.resolved_by = u3.uid
         WHERE ir.id = $1`
      : `SELECT sg.*,
                CASE WHEN sg.is_anonymous THEN 'Anonymous' ELSE u.name END as reporter_name,
                CASE WHEN sg.is_anonymous THEN NULL ELSE s.department END as reporter_dept,
                u2.name as assigned_to_name, u3.name as resolved_by_name
         FROM staff_grievances sg
         LEFT JOIN users u ON sg.reporter_id = u.uid
         LEFT JOIN staff s ON u.uid = s.user_id
         LEFT JOIN users u2 ON sg.assigned_to = u2.uid
         LEFT JOIN users u3 ON sg.resolved_by = u3.uid
         WHERE sg.id = $1`;

    const report = await prisma.$queryRawUnsafe(reportQuery, id);
    if (report.length === 0) return error(res, 'Report not found', HTTP_STATUS.NOT_FOUND);

    // All updates including internal (audit view sees everything)
    const trail = await prisma.$queryRawUnsafe(`
      SELECT ru.*, u.name as author_name, u.role as author_db_role
      FROM report_updates ru
      LEFT JOIN users u ON ru.author_id = u.uid
      WHERE ru.report_type = $1 AND ru.report_id = $2
      ORDER BY ru.created_at ASC
    `, type, id);

    // SLA calculation
    const reportData = report[0];
    const createdAt = new Date(reportData.created_at);
    const resolvedAt = reportData.resolved_at ? new Date(reportData.resolved_at) : null;
    const hoursOpen = (Date.now() - createdAt.getTime()) / 3600000;
    const hoursToResolve = resolvedAt ? (resolvedAt - createdAt) / 3600000 : null;

    const _severityOrPriority = reportData.severity || reportData.priority || 'normal';
    const slaKey = type === 'incident' ? reportData.severity : reportData.priority;
    const slaThresholds = type === 'incident'
      ? SLA.incident[slaKey] || SLA.incident.moderate
      : SLA.grievance[slaKey] || SLA.grievance.normal;

    const slaStatus = {
      acknowledge_threshold_hours: slaThresholds.acknowledge,
      resolve_threshold_hours: slaThresholds.resolve,
      hours_open: Math.round(hoursOpen * 10) / 10,
      hours_to_resolve: hoursToResolve ? Math.round(hoursToResolve * 10) / 10 : null,
      acknowledge_breached: hoursOpen > slaThresholds.acknowledge && trail.filter(r => r.author_role !== 'system' && r.author_role !== 'reporter').length === 0,
      resolve_breached: !resolvedAt && hoursOpen > slaThresholds.resolve,
      resolved_within_sla: resolvedAt ? hoursToResolve <= slaThresholds.resolve : null,
    };

    success(res, {
      report: reportData,
      audit_trail: trail,
      sla: slaStatus,
    }, 'Audit trail fetched');
  } catch (err) {
    logger.error('Audit Trail Error:', err);
    error(res, 'Failed to fetch audit trail', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── HR/Admin activity report ─────────────────────────────────────────────────
export const getAdminActivityReport = async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const interval = `${parseInt(days)} days`;

    // Per-admin action counts
    const adminActivity = await prisma.$queryRawUnsafe(`
      SELECT
        u.id,
        u.name,
        u.role,
        COUNT(*) FILTER (WHERE ru.report_type = 'incident') as incident_actions,
        COUNT(*) FILTER (WHERE ru.report_type = 'grievance') as grievance_actions,
        COUNT(*) FILTER (WHERE ru.is_internal = true) as internal_notes,
        COUNT(*) FILTER (WHERE ru.is_internal = false) as public_updates,
        MIN(ru.created_at) as first_action,
        MAX(ru.created_at) as last_action,
        COUNT(*) as total_actions
      FROM report_updates ru
      JOIN users u ON ru.author_id = u.uid
      WHERE ru.author_role IN ('admin','hr')
        AND ru.created_at >= NOW() - $1::INTERVAL
      GROUP BY u.id, u.name, u.role
      ORDER BY total_actions DESC
    `, interval);

    // Reports that had NO admin action in expected window
    const neglected = await prisma.$queryRawUnsafe(`
      SELECT
        'incident' as type,
        ir.id,
        ir.report_number,
        ir.severity,
        ir.title as subject,
        ir.status,
        ir.created_at,
        ir.assigned_to,
        u.name as assigned_to_name,
        EXTRACT(EPOCH FROM (NOW() - ir.created_at))/3600 as hours_open,
        (SELECT COUNT(*) FROM report_updates ru WHERE ru.report_type='incident' AND ru.report_id=ir.id AND ru.author_role NOT IN ('system','reporter')) as admin_actions
      FROM incident_reports ir
      LEFT JOIN users u ON ir.assigned_to = u.uid
      WHERE ir.status NOT IN ('resolved','closed')
        AND (
          SELECT COUNT(*) FROM report_updates ru
          WHERE ru.report_type='incident' AND ru.report_id=ir.id AND ru.author_role NOT IN ('system','reporter')
        ) = 0
        AND ir.created_at >= NOW() - $1::INTERVAL
      UNION ALL
      SELECT
        'grievance' as type,
        sg.id,
        sg.grievance_number,
        sg.priority,
        sg.subject,
        sg.status,
        sg.created_at,
        sg.assigned_to,
        u.name as assigned_to_name,
        EXTRACT(EPOCH FROM (NOW() - sg.created_at))/3600 as hours_open,
        (SELECT COUNT(*) FROM report_updates ru WHERE ru.report_type='grievance' AND ru.report_id=sg.id AND ru.author_role NOT IN ('system','reporter')) as admin_actions
      FROM staff_grievances sg
      LEFT JOIN users u ON sg.assigned_to = u.uid
      WHERE sg.status NOT IN ('resolved','closed')
        AND (
          SELECT COUNT(*) FROM report_updates ru
          WHERE ru.report_type='grievance' AND ru.report_id=sg.id AND ru.author_role NOT IN ('system','reporter')
        ) = 0
        AND sg.created_at >= NOW() - $1::INTERVAL
      ORDER BY hours_open DESC
    `, interval);

    // Resolution rate
    const resolutionStats = await prisma.$queryRawUnsafe(`
      SELECT
        'incident' as type,
        COUNT(*) FILTER (WHERE status IN ('resolved','closed')) as resolved,
        COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed')) as open,
        COUNT(*) as total,
        ROUND(COUNT(*) FILTER (WHERE status IN ('resolved','closed'))::NUMERIC / NULLIF(COUNT(*),0) * 100, 1) as resolution_rate_pct,
        ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL)::NUMERIC, 1) as avg_hours_to_resolve
      FROM incident_reports
      WHERE created_at >= NOW() - $1::INTERVAL
      UNION ALL
      SELECT
        'grievance' as type,
        COUNT(*) FILTER (WHERE status IN ('resolved','closed')) as resolved,
        COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed')) as open,
        COUNT(*) as total,
        ROUND(COUNT(*) FILTER (WHERE status IN ('resolved','closed'))::NUMERIC / NULLIF(COUNT(*),0) * 100, 1) as resolution_rate_pct,
        ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL)::NUMERIC, 1) as avg_hours_to_resolve
      FROM staff_grievances
      WHERE created_at >= NOW() - $1::INTERVAL
    `, interval);

    success(res, {
      period_days: parseInt(days),
      admin_activity: adminActivity,
      neglected_reports: neglected,
      resolution_stats: resolutionStats,
    }, 'Admin activity report fetched');
  } catch (err) {
    logger.error('Admin Activity Report Error:', err);
    error(res, 'Failed to fetch activity report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── SLA compliance report ───────────────────────────────────────────────────
export const getSLAReport = async (req, res) => {
  try {
    const { days = 30 } = req.query;

    const incidentSLA = await prisma.$queryRawUnsafe(`
      SELECT
        severity,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status IN ('resolved','closed')) as resolved,
        COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND EXTRACT(EPOCH FROM (resolved_at - created_at))/3600 <=
          CASE severity WHEN 'sentinel' THEN 24 WHEN 'severe' THEN 24 WHEN 'moderate' THEN 72 ELSE 168 END
        ) as resolved_within_sla,
        COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed') AND EXTRACT(EPOCH FROM (NOW() - created_at))/3600 >
          CASE severity WHEN 'sentinel' THEN 24 WHEN 'severe' THEN 24 WHEN 'moderate' THEN 72 ELSE 168 END
        ) as currently_breached,
        ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL)::NUMERIC, 1) as avg_resolution_hours
      FROM incident_reports
      WHERE created_at >= NOW() - $1::INTERVAL
      GROUP BY severity
      ORDER BY CASE severity WHEN 'sentinel' THEN 1 WHEN 'severe' THEN 2 WHEN 'moderate' THEN 3 ELSE 4 END
    `, `${parseInt(days)} days`);

    const grievanceSLA = await prisma.$queryRawUnsafe(`
      SELECT
        priority,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status IN ('resolved','closed')) as resolved,
        COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed') AND EXTRACT(EPOCH FROM (NOW() - created_at))/3600 >
          CASE priority WHEN 'urgent' THEN 72 WHEN 'high' THEN 168 ELSE 336 END
        ) as currently_breached,
        ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL)::NUMERIC, 1) as avg_resolution_hours
      FROM staff_grievances
      WHERE created_at >= NOW() - $1::INTERVAL
      GROUP BY priority
    `, `${parseInt(days)} days`);

    success(res, {
      period_days: parseInt(days),
      incident_sla: incidentSLA,
      grievance_sla: grievanceSLA,
      sla_thresholds: SLA,
    }, 'SLA report fetched');
  } catch (err) {
    logger.error('SLA Report Error:', err);
    error(res, 'Failed to fetch SLA report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
