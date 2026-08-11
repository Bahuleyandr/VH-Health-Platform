// src/routes/staff/phoneRoutes.js

import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { markRouterDomain } from '../../config/openapiDomain.js';
import {
  getRolePolicyHash,
  getRolePolicyVersion,
} from '../../config/rolePolicyGraph.js';
import { success, error } from '../../utils/responseHelper.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = express.Router();
const localIsoSql = (column) =>
  `to_char(((${column} AT TIME ZONE 'UTC') AT TIME ZONE current_setting('TimeZone')), 'YYYY-MM-DD"T"HH24:MI:SS.MS')`;

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function staffUidOf(req) {
  return req.user?.uid || req.user?.staff_uid || null;
}

function staffIdOf(req) {
  const id = Number.parseInt(String(req.user?.id || req.user?.staff_id || ''), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

async function getAttendanceStatus(req) {
  const staffId = staffIdOf(req);
  const staffUid = staffUidOf(req);
  if (!staffId && !staffUid) return null;
  const { start, end } = todayRange();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, attendance_status, type, check_in_time, check_out_time, timestamp, location,
            ${localIsoSql('check_in_time')} AS local_check_in_time,
            ${localIsoSql('check_out_time')} AS local_check_out_time
       FROM staff_attendance
      WHERE (($1::int IS NOT NULL AND staff_id = $1::int)
         OR ($2::uuid IS NOT NULL AND staff_uid = $2::uuid))
        AND timestamp >= $3::timestamp
        AND timestamp < $4::timestamp
      ORDER BY timestamp DESC
      LIMIT 1`,
    staffId,
    staffUid,
    start,
    end,
  );
  const row = rows[0];
  if (!row) {
    return {
      status: 'not_checked_in',
      is_checked_in: false,
      check_in_time: null,
      check_out_time: null,
    };
  }
  const checkedIn = !!row.check_in_time && !row.check_out_time;
  return {
    id: row.id,
    status: row.attendance_status || (checkedIn ? 'checked_in' : 'checked_out'),
    is_checked_in: checkedIn,
    check_in_time: row.local_check_in_time || row.check_in_time,
    check_out_time: row.local_check_out_time || row.check_out_time,
    location: row.location,
  };
}

async function unreadAlertCount(req) {
  const tenantId = tenantOf(req);
  const staffUid = staffUidOf(req);
  const staffId = staffIdOf(req);
  const role = String(req.user?.role || '').toUpperCase();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM notifications
      WHERE tenant_id = $1::uuid
        AND is_read = false
        AND (
          ($2::uuid IS NOT NULL AND uid = $2::uuid)
          OR ($3::int IS NOT NULL AND user_id = $3::int)
          OR (recipient_role IS NOT NULL AND UPPER(recipient_role) = $4)
        )`,
    tenantId,
    staffUid,
    staffId,
    role,
  );
  return Number(rows[0]?.count || 0);
}

async function unreadMessageCount(req) {
  const tenantId = tenantOf(req);
  const staffUid = staffUidOf(req);
  if (!staffUid) return 0;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM staff_messages
      WHERE tenant_id = $1::uuid
        AND recipient_uid = $2::uuid
        AND is_read = false`,
    tenantId,
    staffUid,
  );
  return Number(rows[0]?.count || 0);
}

async function pendingQueryCount(req) {
  const tenantId = tenantOf(req);
  const staffUid = staffUidOf(req);
  if (!staffUid) return 0;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM staff_queries
      WHERE tenant_id = $1::uuid
        AND staff_uid = $2::uuid
        AND status NOT IN ('closed', 'resolved', 'cancelled')`,
    tenantId,
    staffUid,
  );
  return Number(rows[0]?.count || 0);
}

router.get('/phone/home', async (req, res) => {
  try {
    const [attendance, unreadAlerts, unreadMessages, pendingQueries] = await Promise.all([
      getAttendanceStatus(req),
      unreadAlertCount(req),
      unreadMessageCount(req),
      pendingQueryCount(req),
    ]);

    return success(res, {
      mode: 'staff_phone',
      staff: {
        uid: staffUidOf(req),
        id: staffIdOf(req),
        role: req.user?.role || null,
      },
      attendance,
      shift: {
        label: 'Today shift',
        status: attendance?.is_checked_in ? 'on_duty' : 'not_checked_in',
      },
      counts: {
        unread_alerts: unreadAlerts,
        unread_messages: unreadMessages,
        pending_queries: pendingQueries,
        pending_reports: 0,
      },
      quick_actions: [
        'attendance',
        'message',
        'incident_report',
        'staff_grievance',
        'raise_query',
      ],
      policy_version: getRolePolicyVersion(),
      policy_hash: getRolePolicyHash(),
    }, 'Staff phone home retrieved');
  } catch (err) {
    logger.error('Staff phone home failed', err);
    return error(res, 'Failed to retrieve staff phone home', 500);
  }
});

router.get('/queries/my', async (req, res) => {
  try {
    const staffUid = staffUidOf(req);
    if (!staffUid) return error(res, 'Staff identity required', 401);
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || '30'), 10) || 30, 1), 100);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, category, subject, body, priority, status,
              assigned_to_uid, resolved_at, resolution, created_at, updated_at
         FROM staff_queries
        WHERE tenant_id = $1::uuid
          AND staff_uid = $2::uuid
        ORDER BY created_at DESC
        LIMIT $3::int`,
      tenantOf(req),
      staffUid,
      limit,
    );
    return success(res, { queries: rows }, 'Staff queries retrieved');
  } catch (err) {
    logger.error('Staff query list failed', err);
    return error(res, 'Failed to retrieve staff queries', 500);
  }
});

router.post('/queries', async (req, res) => {
  try {
    const staffUid = staffUidOf(req);
    if (!staffUid) return error(res, 'Staff identity required', 401);
    const category = String(req.body?.category || 'general').trim().slice(0, 80);
    const subject = String(req.body?.subject || '').trim();
    const body = String(req.body?.body || '').trim();
    const priority = String(req.body?.priority || 'normal').trim().toLowerCase();

    if (!subject || !body) {
      return error(res, 'subject and body are required', 400);
    }

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO staff_queries
         (tenant_id, staff_uid, category, subject, body, priority, status, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'submitted', $7::jsonb)
       RETURNING id, uid, category, subject, body, priority, status, created_at, updated_at`,
      tenantOf(req),
      staffUid,
      category || 'general',
      subject.slice(0, 200),
      body,
      ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal',
      JSON.stringify({
        device_type: req.user?.deviceType || null,
        ip: req.ip || null,
        user_agent: req.get?.('user-agent') || null,
      }),
    );
    return success(res, rows[0], 'Staff query submitted', 201);
  } catch (err) {
    logger.error('Staff query submission failed', err);
    return error(res, 'Failed to submit staff query', 500);
  }
});

// Employee self-service: the staff home aggregate (own attendance, shift, unread
// counts, quick actions incl. grievance) and the staff_queries workflow a staff
// member raises about their own employment. `phone` — what the file name
// bootstrapped — is a device form factor, not a domain.
markRouterDomain(router, 'hr');

export default router;
