/**
 * Attendance Audit Controller
 * Super-admin oversight of all attendance-related HR actions.
 * Covers: leave approvals, regularization, disputes, overtime, bulk corrections, geofence breaches.
 * Read-only — no mutations.
 */
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// ─── SLA thresholds (hours) ──────────────────────────────────────────────────
const ATTENDANCE_SLA = {
  leave_approval:      { action: 48  },  // leave request should be actioned within 2 days
  regularization:      { action: 24  },  // corrections actioned within 24h
  dispute:             { action: 24  },  // disputes actioned within 24h
  overtime:            { action: 72  },  // overtime approved within 3 days
  replacement:         { respond: 24 },  // replacement staff should respond within 24h
};

// ─── Overview dashboard ──────────────────────────────────────────────────────
export const getAttendanceAuditDashboard = async (req, res) => {
  try {
    const [leaveSummary, regularizationSummary, disputeSummary, overtimeSummary, geofenceSummary, pendingActions] = await Promise.all([

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
          COUNT(*) FILTER (WHERE status = 'pending' AND created_at < NOW() - INTERVAL '48 hours') as overdue_count,
          COUNT(*) FILTER (WHERE status = 'approved') as approved_count,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as this_month,
          ROUND(AVG(EXTRACT(EPOCH FROM (reviewed_at - created_at))/3600) FILTER (WHERE reviewed_at IS NOT NULL)::NUMERIC, 1) as avg_action_hours
        FROM leave_applications
      `),

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
          COUNT(*) FILTER (WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours') as overdue_count,
          COUNT(*) FILTER (WHERE status = 'approved') as approved_count,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as this_month
        FROM attendance_regularization
      `),

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
          COUNT(*) FILTER (WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours') as overdue_count,
          COUNT(*) FILTER (WHERE status = 'approved') as approved_count,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as this_month
        FROM attendance_disputes
      `),

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
          COUNT(*) FILTER (WHERE status = 'pending' AND created_at < NOW() - INTERVAL '72 hours') as overdue_count,
          COUNT(*) FILTER (WHERE status = 'approved') as approved_count,
          COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as this_month
        FROM overtime_requests
      `),

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) as total_breaches,
          COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '7 days') as this_week,
          COUNT(DISTINCT staff_id) as unique_staff,
          COUNT(*) FILTER (WHERE alerted = false) as unalerted
        FROM geofence_breaches
      `),

      // Combined pending items needing action
      prisma.$queryRawUnsafe(`
        SELECT 'leave' as type, id, staff_id, 'Leave Request' as subject, created_at,
          EXTRACT(EPOCH FROM (NOW() - created_at))/3600 as hours_pending
        FROM leave_applications WHERE status = 'pending' AND created_at < NOW() - INTERVAL '48 hours'
        UNION ALL
        SELECT 'regularization' as type, id, staff_id, 'Regularization Request' as subject, created_at,
          EXTRACT(EPOCH FROM (NOW() - created_at))/3600 as hours_pending
        FROM attendance_regularization WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'
        UNION ALL
        SELECT 'dispute' as type, id, staff_id, dispute_type as subject, created_at,
          EXTRACT(EPOCH FROM (NOW() - created_at))/3600 as hours_pending
        FROM attendance_disputes WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'
        UNION ALL
        SELECT 'overtime' as type, id, staff_id, reason as subject, created_at,
          EXTRACT(EPOCH FROM (NOW() - created_at))/3600 as hours_pending
        FROM overtime_requests WHERE status = 'pending' AND created_at < NOW() - INTERVAL '72 hours'
        ORDER BY hours_pending DESC LIMIT 30
      `),
    ]);

    success(res, {
      leave: leaveSummary[0],
      regularization: regularizationSummary[0],
      disputes: disputeSummary[0],
      overtime: overtimeSummary[0],
      geofence: geofenceSummary[0],
      overdue_items: pendingActions,
      sla_config: ATTENDANCE_SLA,
    }, 'Attendance audit dashboard fetched');
  } catch (err) {
    logger.error('Attendance Audit Dashboard Error:', err);
    error(res, 'Failed to fetch attendance audit dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── HR activity on attendance ───────────────────────────────────────────────
export const getAttendanceHRActivity = async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const interval = `${parseInt(days)} days`;

    // Who approved/rejected what
    const [leaveActions, regularizationActions, disputeActions, overtimeActions, bulkCorrections] = await Promise.all([

      prisma.$queryRawUnsafe(`
        SELECT
          u.id, u.name, u.role,
          COUNT(*) FILTER (WHERE lr.status = 'approved') as approved,
          COUNT(*) FILTER (WHERE lr.status = 'rejected') as rejected,
          COUNT(*) as total,
          ROUND(AVG(EXTRACT(EPOCH FROM (lr.reviewed_at - lr.created_at))/3600)::NUMERIC, 1) as avg_response_hours,
          MAX(lr.reviewed_at) as last_action
        FROM leave_applications lr
        JOIN users u ON lr.reviewed_by = u.uid
        WHERE lr.reviewed_at >= NOW() - $1::INTERVAL
          AND lr.status != 'pending'
        GROUP BY u.id, u.name, u.role
        ORDER BY total DESC
      `, interval),

      prisma.$queryRawUnsafe(`
        SELECT
          u.id, u.name, u.role,
          COUNT(*) FILTER (WHERE ar.status = 'approved') as approved,
          COUNT(*) FILTER (WHERE ar.status = 'rejected') as rejected,
          COUNT(*) as total,
          MAX(ar.reviewed_at) as last_action
        FROM attendance_regularization ar
        JOIN users u ON ar.reviewed_by = u.uid
        WHERE ar.reviewed_at >= NOW() - $1::INTERVAL
        GROUP BY u.id, u.name, u.role
        ORDER BY total DESC
      `, interval),

      prisma.$queryRawUnsafe(`
        SELECT
          u.id, u.name, u.role,
          COUNT(*) FILTER (WHERE ad.status = 'approved') as approved,
          COUNT(*) FILTER (WHERE ad.status = 'rejected') as rejected,
          COUNT(*) as total,
          MAX(ad.reviewed_at) as last_action
        FROM attendance_disputes ad
        JOIN users u ON ad.reviewed_by = u.id
        WHERE ad.reviewed_at >= NOW() - $1::INTERVAL
        GROUP BY u.id, u.name, u.role
        ORDER BY total DESC
      `, interval),

      prisma.$queryRawUnsafe(`
        SELECT
          u.id, u.name, u.role,
          COUNT(*) FILTER (WHERE ot.status = 'approved') as approved,
          COUNT(*) FILTER (WHERE ot.status = 'rejected') as rejected,
          COUNT(*) as total,
          MAX(ot.approved_at) as last_action
        FROM overtime_requests ot
        JOIN users u ON ot.approved_by = u.id
        WHERE ot.approved_at >= NOW() - $1::INTERVAL
        GROUP BY u.id, u.name, u.role
        ORDER BY total DESC
      `, interval),

      // Bulk corrections — potentially sensitive, full log
      prisma.$queryRawUnsafe(`
        SELECT
          ar.id, ar.staff_id, ar.date, ar.reason, ar.status,
          ar.reviewed_by, ar.reviewed_at, ar.requested_check_in, ar.requested_check_out,
          u.name as staff_name, u2.name as reviewed_by_name
        FROM attendance_regularization ar
        LEFT JOIN users u ON ar.staff_id = u.id
        LEFT JOIN users u2 ON ar.reviewed_by = u2.uid
        WHERE ar.reason ILIKE '%bulk%' OR ar.reason ILIKE '%admin correction%'
        ORDER BY ar.reviewed_at DESC NULLS LAST LIMIT 50
      `),
    ]);

    // Build combined per-person summary
    const actorMap = {};

    for (const row of leaveActions) {
      if (!actorMap[row.id]) actorMap[row.id] = { id: row.id, name: row.name, role: row.role, leave: 0, regularization: 0, disputes: 0, overtime: 0, last_action: null };
      actorMap[row.id].leave = parseInt(row.total);
      if (!actorMap[row.id].last_action || row.last_action > actorMap[row.id].last_action) actorMap[row.id].last_action = row.last_action;
    }
    for (const row of regularizationActions) {
      if (!actorMap[row.id]) actorMap[row.id] = { id: row.id, name: row.name, role: row.role, leave: 0, regularization: 0, disputes: 0, overtime: 0, last_action: null };
      actorMap[row.id].regularization = parseInt(row.total);
    }
    for (const row of disputeActions) {
      if (!actorMap[row.id]) actorMap[row.id] = { id: row.id, name: row.name, role: row.role, leave: 0, regularization: 0, disputes: 0, overtime: 0, last_action: null };
      actorMap[row.id].disputes = parseInt(row.total);
    }
    for (const row of overtimeActions) {
      if (!actorMap[row.id]) actorMap[row.id] = { id: row.id, name: row.name, role: row.role, leave: 0, regularization: 0, disputes: 0, overtime: 0, last_action: null };
      actorMap[row.id].overtime = parseInt(row.total);
    }

    success(res, {
      period_days: parseInt(days),
      actors: Object.values(actorMap).sort((a, b) =>
        (b.leave + b.regularization + b.disputes + b.overtime) - (a.leave + a.regularization + a.disputes + a.overtime)
      ),
      leave_detail: leaveActions,
      regularization_detail: regularizationActions,
      dispute_detail: disputeActions,
      overtime_detail: overtimeActions,
      bulk_corrections: bulkCorrections,
    }, 'HR activity fetched');
  } catch (err) {
    logger.error('Attendance HR Activity Error:', err);
    error(res, 'Failed to fetch HR activity', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Geofence breach log ─────────────────────────────────────────────────────
export const getGeofenceBreachLog = async (req, res) => {
  try {
    const { limit = 100, staff_id } = req.query;

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const whereClause = staff_id ? 'WHERE gb.staff_id = $2::int' : '';
    const params = staff_id ? [safeLimit, Number(staff_id)] : [safeLimit];

    const breaches = await prisma.$queryRawUnsafe(`
      SELECT gb.*, u.name as staff_name, s.department, u.role as staff_role
      FROM geofence_breaches gb
      JOIN users u ON gb.staff_id = u.id
      LEFT JOIN staff s ON u.uid = s.user_id
      ${whereClause}
      ORDER BY gb.occurred_at DESC
      LIMIT $1::int
    `, ...params);

    // Summary stats
    const stats = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) as total,
        COUNT(DISTINCT staff_id) as unique_staff,
        COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '7 days') as this_week,
        COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '24 hours') as today,
        COUNT(*) FILTER (WHERE action = 'checkin_outside') as checkin_outside,
        COUNT(*) FILTER (WHERE action = 'checkout_outside') as checkout_outside
      FROM geofence_breaches
    `);

    // Most frequent offenders
    const frequent = await prisma.$queryRawUnsafe(`
      SELECT gb.staff_id, u.name, s.department, COUNT(*) as breach_count, MAX(gb.occurred_at) as last_breach
      FROM geofence_breaches gb
      JOIN users u ON gb.staff_id = u.id
      LEFT JOIN staff s ON u.uid = s.user_id
      WHERE gb.occurred_at >= NOW() - INTERVAL '30 days'
      GROUP BY gb.staff_id, u.name, s.department
      ORDER BY breach_count DESC LIMIT 10
    `);

    success(res, {
      breaches: breaches,
      stats: stats[0],
      frequent_offenders: frequent,
    }, 'Geofence breach log fetched');
  } catch (err) {
    logger.error('Geofence Breach Log Error:', err);
    error(res, 'Failed to fetch breach log', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Leave approval audit trail for a specific request ──────────────────────
export const getLeaveAuditTrail = async (req, res) => {
  try {
    const { id } = req.params;
    const leaveId = Number.parseInt(id, 10);

    if (!Number.isInteger(leaveId) || leaveId <= 0) {
      return error(res, 'Invalid leave id', HTTP_STATUS.BAD_REQUEST);
    }

    const leave = await prisma.$queryRawUnsafe(`
      SELECT lr.*, u.name as staff_name, s.department,
             u2.name as reviewed_by_name,
             rr.status as replacement_status, u3.name as replacement_name
      FROM leave_applications lr
      JOIN users u ON lr.staff_id = u.id
      LEFT JOIN staff s ON u.uid = s.user_id
      LEFT JOIN users u2 ON lr.reviewed_by = u2.uid
      LEFT JOIN replacement_requests rr ON rr.leave_request_id = lr.id
      LEFT JOIN users u3 ON rr.replacement_staff_id = u3.id
      WHERE lr.id = $1::int
    `, leaveId);

    if (leave.length === 0) return error(res, 'Leave request not found', HTTP_STATUS.NOT_FOUND);

    const hoursToAction = leave[0].reviewed_at && leave[0].status !== 'pending'
      ? (new Date(leave[0].reviewed_at).getTime() - new Date(leave[0].created_at).getTime()) / 3600000
      : null;

    success(res, {
      leave: leave[0],
      sla: {
        threshold_hours: ATTENDANCE_SLA.leave_approval.action,
        hours_to_action: hoursToAction ? Math.round(hoursToAction * 10) / 10 : null,
        within_sla: hoursToAction ? hoursToAction <= ATTENDANCE_SLA.leave_approval.action : null,
        still_pending: leave[0].status === 'pending',
        hours_pending: leave[0].status === 'pending'
          ? Math.round((Date.now() - new Date(leave[0].created_at).getTime()) / 360000) / 10
          : null,
      },
    }, 'Leave audit trail fetched');
  } catch (err) {
    logger.error('Leave Audit Trail Error:', err);
    error(res, 'Failed to fetch leave audit trail', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Attendance SLA report ───────────────────────────────────────────────────
export const getAttendanceSLAReport = async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const interval = `${parseInt(days)} days`;

    const [leaveSLA, regularizationSLA, disputeSLA, overtimeSLA] = await Promise.all([

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status != 'pending') as actioned,
          COUNT(*) FILTER (WHERE status = 'pending' AND created_at < NOW() - INTERVAL '48 hours') as overdue,
          COUNT(*) FILTER (WHERE reviewed_at IS NOT NULL AND EXTRACT(EPOCH FROM (reviewed_at - created_at))/3600 <= 48) as within_sla,
          ROUND(AVG(EXTRACT(EPOCH FROM (reviewed_at - created_at))/3600) FILTER (WHERE reviewed_at IS NOT NULL)::NUMERIC, 1) as avg_hours
        FROM leave_applications
        WHERE created_at >= NOW() - $1::INTERVAL
      `, interval),

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status != 'pending') as actioned,
          COUNT(*) FILTER (WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours') as overdue,
          COUNT(*) FILTER (WHERE reviewed_at IS NOT NULL AND EXTRACT(EPOCH FROM (reviewed_at - created_at))/3600 <= 24) as within_sla,
          ROUND(AVG(EXTRACT(EPOCH FROM (reviewed_at - created_at))/3600) FILTER (WHERE reviewed_at IS NOT NULL)::NUMERIC, 1) as avg_hours
        FROM attendance_regularization
        WHERE created_at >= NOW() - $1::INTERVAL
      `, interval),

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status != 'pending') as actioned,
          COUNT(*) FILTER (WHERE status = 'pending' AND created_at < NOW() - INTERVAL '24 hours') as overdue,
          COUNT(*) FILTER (WHERE reviewed_at IS NOT NULL AND EXTRACT(EPOCH FROM (reviewed_at - created_at))/3600 <= 24) as within_sla,
          ROUND(AVG(EXTRACT(EPOCH FROM (reviewed_at - created_at))/3600) FILTER (WHERE reviewed_at IS NOT NULL)::NUMERIC, 1) as avg_hours
        FROM attendance_disputes
        WHERE created_at >= NOW() - $1::INTERVAL
      `, interval),

      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status != 'pending') as actioned,
          COUNT(*) FILTER (WHERE status = 'pending' AND created_at < NOW() - INTERVAL '72 hours') as overdue,
          COUNT(*) FILTER (WHERE approved_at IS NOT NULL AND EXTRACT(EPOCH FROM (approved_at - created_at))/3600 <= 72) as within_sla,
          ROUND(AVG(EXTRACT(EPOCH FROM (approved_at - created_at))/3600) FILTER (WHERE approved_at IS NOT NULL)::NUMERIC, 1) as avg_hours
        FROM overtime_requests
        WHERE created_at >= NOW() - $1::INTERVAL
      `, interval),
    ]);

    success(res, {
      period_days: parseInt(days),
      leave:           { ...leaveSLA[0],          sla_hours: 48,  label: 'Leave Approvals' },
      regularization:  { ...regularizationSLA[0], sla_hours: 24,  label: 'Regularization' },
      disputes:        { ...disputeSLA[0],         sla_hours: 24,  label: 'Attendance Disputes' },
      overtime:        { ...overtimeSLA[0],        sla_hours: 72,  label: 'Overtime Requests' },
    }, 'Attendance SLA report fetched');
  } catch (err) {
    logger.error('Attendance SLA Error:', err);
    error(res, 'Failed to fetch SLA report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
