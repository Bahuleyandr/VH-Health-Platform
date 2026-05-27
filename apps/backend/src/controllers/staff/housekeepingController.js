import crypto from 'crypto';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// ─── SLA durations (minutes) ─────────────────────────────────────────────────
const SLA_MINUTES = { urgent: 30, high: 120, normal: 240, low: 1440 };
const ACTIVE_REQUEST_STATUSES = ['open', 'pending', 'assigned', 'in_progress'];
const HOUSEKEEPING_ASSIGNABLE_ROLES = ['HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE'];

// ─── Signature hash for proof of work ────────────────────────────────────────
function generateSignature(staffId, zoneId, timestamp, photoKey) {
  return crypto
    .createHash('sha256')
    .update(`${staffId}:${zoneId || 'none'}:${timestamp}:${photoKey || 'none'}`)
    .digest('hex');
}

async function resolveCurrentUserRef(req) {
  if (!req.user?.uid) return null;
  return prisma.users.findUnique({
    where: { uid: req.user.uid },
    select: { id: true, uid: true }
  });
}

function hasZoneAdminRole(req) {
  const role = String(req.user?.rawRole || req.user?.role || '').toUpperCase();
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

function requireZoneAdmin(req, res) {
  if (hasZoneAdminRole(req)) return true;
  error(res, 'Admin role required to manage housekeeping zones', HTTP_STATUS.FORBIDDEN);
  return false;
}

function extractLinkedBedId(requestRow = {}) {
  const haystack = [requestRow.description, requestRow.notes, requestRow.location_text]
    .filter(Boolean)
    .join('\n');
  const match = haystack.match(/\bbed_id\s*=\s*(\d+)\b/i);
  if (!match) return null;
  const bedId = Number.parseInt(match[1], 10);
  return Number.isInteger(bedId) && bedId > 0 ? bedId : null;
}

async function markLinkedDirtyBedCleaning(requestRow, actorUid) {
  const bedId = extractLinkedBedId(requestRow);
  if (!bedId) return;

  const updated = await prisma.$queryRawUnsafe(
    `UPDATE beds
        SET status = 'cleaning', updated_at = NOW()
      WHERE id = $1::int AND status = 'dirty'
      RETURNING id, status`,
    bedId
  );

  if (!updated.length) return;

  await prisma.$queryRawUnsafe(
    `INSERT INTO housekeeping_request_updates (request_id, author_uid, author_role, message, is_internal)
     VALUES ($1::int, $2::uuid, 'system', $3, false)`,
    requestRow.id,
    actorUid || null,
    `Linked bed ${bedId} moved from dirty to cleaning when housekeeping work was assigned.`
  );
}

async function findActiveZoneAssignee(zoneId) {
  if (!zoneId) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT hfa.staff_id, hfa.staff_uid, u.name,
            COUNT(hr.id)::int AS active_requests
       FROM housekeeping_floor_assignments hfa
       JOIN users u ON u.id = hfa.staff_id
       LEFT JOIN housekeeping_requests hr
         ON hr.assigned_to = hfa.staff_id
        AND COALESCE(hr.status, 'open') = ANY($2::text[])
      WHERE hfa.zone_id = $1::int
        AND hfa.status = 'active'
        AND hfa.effective_from <= NOW()
        AND (hfa.effective_to IS NULL OR hfa.effective_to > NOW())
        AND u.is_active = true
      GROUP BY hfa.id, hfa.staff_id, hfa.staff_uid, u.name, hfa.created_at
      ORDER BY CASE WHEN hfa.assignment_kind = 'redeploy' OR hfa.is_temporary = true THEN 0 ELSE 1 END,
               active_requests ASC,
               hfa.created_at ASC
      LIMIT 1`,
    zoneId,
    ACTIVE_REQUEST_STATUSES
  );
  return rows[0] || null;
}

async function resolveHousekeepingZone(zoneId) {
  if (!zoneId) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, name, floor, building
       FROM housekeeping_zones
      WHERE id = $1::int AND is_active = true`,
    zoneId
  );
  return rows[0] || null;
}

async function resolveAssignableHousekeepingStaff({ staffId, staffUid }) {
  const conditions = [];
  const params = [];
  let idx = 1;
  if (staffId) {
    conditions.push(`u.id = $${idx++}::int`);
    params.push(staffId);
  }
  if (staffUid) {
    conditions.push(`u.uid = $${idx++}::uuid`);
    params.push(staffUid);
  }
  if (!conditions.length) return null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT u.id, u.uid, u.name, u.role, s.employee_id, s.department, s.position
       FROM users u
       LEFT JOIN staff s ON s.user_id = u.uid
      WHERE (${conditions.join(' OR ')})
        AND u.is_active = true
        AND u.role = ANY($${idx}::text[])
      LIMIT 1`,
    ...params,
    HOUSEKEEPING_ASSIGNABLE_ROLES
  );
  return rows[0] || null;
}

// ─── GET /zones — list all active zones ──────────────────────────────────────
export const getZones = async (req, res) => {
  try {
    const zones = await prisma.$queryRawUnsafe(
      `SELECT id, name, zone_type, floor, building, is_active, created_at, updated_at
         FROM housekeeping_zones
        WHERE is_active = true
        ORDER BY COALESCE(building, ''), COALESCE(floor, ''), zone_type, name`
    );
    success(res, zones, 'Zones fetched');
  } catch (err) {
    logger.error('Get Zones Error:', err);
    error(res, 'Failed to fetch zones', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: GET /zones — include inactive zones for setup screens ────────────
export const getAdminZones = async (req, res) => {
  try {
    if (!requireZoneAdmin(req, res)) return;

    const zones = await prisma.$queryRawUnsafe(
      `SELECT id, name, zone_type, floor, building, is_active, created_at, updated_at
         FROM housekeeping_zones
        ORDER BY is_active DESC, COALESCE(building, ''), COALESCE(floor, ''), zone_type, name`
    );
    success(res, zones, 'Zones fetched');
  } catch (err) {
    logger.error('Get Admin Zones Error:', err);
    error(res, 'Failed to fetch zones', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── POST /log — submit cleaning completion log ───────────────────────────────
export const submitCleaningLog = async (req, res) => {
  try {
    const staff = await resolveCurrentUserRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }
    const {
      zone_id,
      location_text,
      latitude,
      longitude,
      cleaning_type = 'routine',
      notes,
      photo_key,
      photo_url
    } = req.body;

    if (!location_text && !zone_id) {
      return error(res, 'zone_id or location_text is required', HTTP_STATUS.BAD_REQUEST);
    }

    const timestamp = new Date().toISOString();
    const signature = generateSignature(staff.uid, zone_id, timestamp, photo_key);

    const result = await prisma.$queryRawUnsafe(
      `
      INSERT INTO housekeeping_logs
        (staff_id, staff_uid, zone_id, location_text, latitude, longitude, cleaning_type,
         notes, photo_key, photo_url, signature_hash, logged_at)
      VALUES ($1::int,$2::uuid,$3::int,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz)
      RETURNING id, staff_id, staff_uid, zone_id, location_text, cleaning_type, notes,
        photo_url, signature_hash, log_number, logged_at, status, created_at
    `,
      staff.id,
      staff.uid,
      zone_id || null,
      location_text || null,
      latitude || null,
      longitude || null,
      cleaning_type,
      notes || null,
      photo_key || null,
      photo_url || null,
      signature,
      timestamp
    );

    success(res, result[0], `Cleaning log ${result[0].log_number} submitted`);
  } catch (err) {
    logger.error('Submit Cleaning Log Error:', err);
    error(res, 'Failed to submit cleaning log', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── GET /logs/my — staff's own cleaning logs ────────────────────────────────
export const getMyCleaningLogs = async (req, res) => {
  try {
    const staff = await resolveCurrentUserRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }
    const { limit = 50 } = req.query;

    const logs = await prisma.$queryRawUnsafe(
      `
      SELECT hl.*, hz.name as zone_name, hz.zone_type
      FROM housekeeping_logs hl
      LEFT JOIN housekeeping_zones hz ON hl.zone_id = hz.id
      WHERE hl.staff_id = $1
      ORDER BY hl.logged_at DESC LIMIT $2::int
    `,
      staff.id,
      parseInt(limit)
    );

    success(res, logs, 'Cleaning logs fetched');
  } catch (err) {
    logger.error('Get My Cleaning Logs Error:', err);
    error(res, 'Failed to fetch logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── POST /request — raise a housekeeping request ───────────────────────────
export const raiseRequest = async (req, res) => {
  try {
    const requester = await resolveCurrentUserRef(req);
    if (!requester) {
      return error(res, 'Requester not found', HTTP_STATUS.NOT_FOUND);
    }
    const {
      zone_id,
      location_text,
      latitude,
      longitude,
      request_type = 'cleaning',
      urgency = 'normal',
      description,
      photo_key,
      photo_url
    } = req.body;

    if (!location_text && !zone_id) {
      return error(res, 'zone_id or location_text is required', HTTP_STATUS.BAD_REQUEST);
    }

    const validUrgency = ['low', 'normal', 'high', 'urgent'];
    if (!validUrgency.includes(urgency)) {
      return error(res, `urgency must be: ${validUrgency.join(', ')}`, HTTP_STATUS.BAD_REQUEST);
    }

    const slaMinutes = SLA_MINUTES[urgency] || 240;
    const slaDueAt = new Date(Date.now() + slaMinutes * 60000).toISOString();
    const activeAssignee = await findActiveZoneAssignee(zone_id);

    const result = await prisma.$queryRawUnsafe(
      `
      INSERT INTO housekeeping_requests
        (requester_id, requester_uid, zone_id, location_text, latitude, longitude,
         request_type, urgency, description, photo_key, photo_url, assigned_to,
         assigned_to_uid, assigned_at, status, sla_due_at)
      VALUES ($1::int,$2::uuid,$3::int,$4,$5,$6,$7,$8,$9,$10,$11,$12::int,
              $13::uuid,$14::timestamptz,$15,$16::timestamptz)
      RETURNING id, request_number, requester_id, requester_uid, zone_id, assigned_to,
        request_type, request_type as task_type, urgency, description, description as notes,
        status, completed_at, created_at, sla_due_at
    `,
      requester.id,
      requester.uid,
      zone_id || null,
      location_text || '',
      latitude || null,
      longitude || null,
      request_type,
      urgency,
      description || null,
      photo_key || null,
      photo_url || null,
      activeAssignee?.staff_id || null,
      activeAssignee?.staff_uid || null,
      activeAssignee ? new Date().toISOString() : null,
      activeAssignee ? 'assigned' : 'open',
      slaDueAt
    );

    // System update
    await prisma.$queryRawUnsafe(
      `
      INSERT INTO housekeeping_request_updates (request_id, author_role, message, is_internal)
      VALUES ($1, 'system', $2, false)
    `,
      result[0].id,
      `Request ${result[0].request_number} raised. Urgency: ${urgency.toUpperCase()}. SLA: ${slaMinutes < 60 ? `${slaMinutes}min` : `${slaMinutes / 60}h`}.${activeAssignee ? ` Routed to ${activeAssignee.name || 'assigned housekeeping staff'}.` : ''}`
    );

    success(res, result[0], `Request ${result[0].request_number} raised`);
  } catch (err) {
    logger.error('Raise HK Request Error:', err);
    error(res, 'Failed to raise request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── GET /requests/my — staff's own requests and assigned requests ───────────
export const getMyRequests = async (req, res) => {
  try {
    const staff = await resolveCurrentUserRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    const raised = await prisma.$queryRawUnsafe(
      `
      SELECT hr.id, hr.request_number, hr.requester_id, hr.zone_id, hr.location_text,
        hr.assigned_to, hr.request_type, hr.request_type as task_type,
        hr.urgency, hr.description, hr.description as notes, hr.status,
        hr.completed_at, hr.created_at, hr.sla_due_at,
        hz.name as zone_name, u.name as assigned_to_name
      FROM housekeeping_requests hr
      LEFT JOIN housekeeping_zones hz ON hr.zone_id = hz.id
      LEFT JOIN users u ON hr.assigned_to = u.id
      WHERE hr.requester_id = $1
      ORDER BY hr.created_at DESC LIMIT 30
    `,
      staff.id
    );

    const assigned = await prisma.$queryRawUnsafe(
      `
      SELECT hr.id, hr.request_number, hr.requester_id, hr.zone_id, hr.location_text,
        hr.assigned_to, hr.request_type, hr.request_type as task_type,
        hr.urgency, hr.description, hr.description as notes, hr.status,
        hr.completed_at, hr.created_at, hr.sla_due_at,
        hz.name as zone_name, u.name as requester_name
      FROM housekeeping_requests hr
      LEFT JOIN housekeeping_zones hz ON hr.zone_id = hz.id
      LEFT JOIN users u ON hr.requester_id = u.id
      WHERE hr.assigned_to = $1 AND hr.status NOT IN ('completed','verified','closed','cancelled')
      ORDER BY hr.urgency DESC, hr.created_at ASC LIMIT 20
    `,
      staff.id
    );

    const completed = await prisma.$queryRawUnsafe(
      `
      SELECT hr.id, hr.request_number, hr.requester_id, hr.zone_id, hr.location_text,
        hr.assigned_to, hr.request_type, hr.request_type as task_type,
        hr.urgency, hr.description, hr.description as notes, hr.status,
        hr.completed_at, hr.created_at, hr.sla_due_at,
        hz.name as zone_name, u.name as requester_name
      FROM housekeeping_requests hr
      LEFT JOIN housekeeping_zones hz ON hr.zone_id = hz.id
      LEFT JOIN users u ON hr.requester_id = u.id
      WHERE hr.assigned_to = $1 AND hr.status IN ('completed','verified','closed')
      ORDER BY COALESCE(hr.completed_at, hr.updated_at, hr.created_at) DESC LIMIT 20
    `,
      staff.id
    );

    success(res, { raised: raised, assigned: assigned, completed: completed }, 'Requests fetched');
  } catch (err) {
    logger.error('Get My HK Requests Error:', err);
    error(res, 'Failed to fetch requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── POST /requests/:id/start — assigned HK staff starts work ───────────────
export const startRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await resolveCurrentUserRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    const result = await prisma.$queryRawUnsafe(
      `
      UPDATE housekeeping_requests
         SET status = 'in_progress',
             updated_at = NOW()
       WHERE id = $1::int
         AND assigned_to = $2
         AND status = 'assigned'
      RETURNING id, request_number, requester_id, zone_id, assigned_to,
        request_type, request_type as task_type, urgency, status, description,
        description as notes, completed_at, created_at, sla_due_at
    `,
      id,
      staff.id
    );

    if (result.length === 0) {
      return error(res, 'Request not found or not ready to start', HTTP_STATUS.NOT_FOUND);
    }

    await markLinkedDirtyBedCleaning(result[0], staff.uid);

    await prisma.$queryRawUnsafe(
      `
      INSERT INTO housekeeping_request_updates (request_id, author_id, author_uid, author_role, message, is_internal)
      VALUES ($1::int, $2, $3::uuid, 'hk_staff', 'Task started by housekeeping staff.', false)
    `,
      id,
      staff.id,
      staff.uid
    );

    success(res, result[0], 'Request started');
  } catch (err) {
    logger.error('Start HK Request Error:', err);
    error(res, 'Failed to start request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── POST /requests/:id/complete — mark request done with optional photo ─────
export const completeRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await resolveCurrentUserRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }
    const { completion_notes, completion_photo_key, completion_photo_url } = req.body;

    const reqCheck = await prisma.$queryRawUnsafe(
      `SELECT id, zone_id, assigned_to, request_type, request_type as task_type,
        status, description, description as notes, completed_at, created_at
       FROM housekeeping_requests
       WHERE id = $1::int AND assigned_to = $2`,
      id,
      staff.id
    );
    if (reqCheck.length === 0) {
      return error(res, 'Request not found or not assigned to you', HTTP_STATUS.NOT_FOUND);
    }

    const timestamp = new Date().toISOString();
    const signatureHash = generateSignature(
      staff.uid,
      reqCheck[0].zone_id,
      timestamp,
      completion_photo_key
    );

    const result = await prisma.$queryRawUnsafe(
      `
      UPDATE housekeeping_requests SET
        status = 'completed',
        completed_at = NOW(),
        completion_notes = $1,
        completion_photo_key = $2,
        completion_photo_url = $3,
        completion_signature_hash = $4,
        updated_at = NOW()
      WHERE id = $5::int
      RETURNING id, request_number, requester_id, zone_id, assigned_to,
        request_type, request_type as task_type, status, description,
        description as notes, completed_at, created_at
    `,
      completion_notes || null,
      completion_photo_key || null,
      completion_photo_url || null,
      signatureHash,
      id
    );

    await prisma.$queryRawUnsafe(
      `
      INSERT INTO housekeeping_request_updates (request_id, author_id, author_uid, author_role, message, is_internal)
      VALUES ($1::int, $2, $3::uuid, 'hk_staff', $4, false)
    `,
      id,
      staff.id,
      staff.uid,
      `Task completed by housekeeping staff${completion_notes ? ': ' + completion_notes : '.'}`
    );

    success(res, result[0], 'Request marked as completed');
  } catch (err) {
    logger.error('Complete HK Request Error:', err);
    error(res, 'Failed to complete request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: GET all logs with filters ────────────────────────────────────────
export const getAllCleaningLogs = async (req, res) => {
  try {
    const { staff_id, zone_id, status, from, to, limit = 100, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (staff_id) {
      conditions.push(`hl.staff_id = $${idx++}::int`);
      params.push(staff_id);
    }
    if (zone_id) {
      conditions.push(`hl.zone_id = $${idx++}::int`);
      params.push(zone_id);
    }
    if (status) {
      conditions.push(`hl.status = $${idx++}`);
      params.push(status);
    }
    if (from) {
      conditions.push(`hl.logged_at >= $${idx++}::timestamptz`);
      params.push(from);
    }
    if (to) {
      conditions.push(`hl.logged_at <= $${idx++}::timestamptz`);
      params.push(to);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit), 500), parseInt(offset));

    const logs = await prisma.$queryRawUnsafe(
      `
      SELECT hl.*, u.name as staff_name, s.department,
             hz.name as zone_name, hz.zone_type,
             u2.name as verified_by_name
      FROM housekeeping_logs hl
      LEFT JOIN users u ON hl.staff_id = u.id
      LEFT JOIN staff s ON u.uid = s.user_id
      LEFT JOIN housekeeping_zones hz ON hl.zone_id = hz.id
      LEFT JOIN users u2 ON hl.verified_by = u2.id
      ${where}
      ORDER BY hl.logged_at DESC
      LIMIT $${idx++}::int OFFSET $${idx}::int
    `,
      ...params
    );

    const total = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM housekeeping_logs hl ${where}`,
      ...params.slice(0, -2)
    );

    success(res, { logs: logs, total: parseInt(total[0].count) }, 'Logs fetched');
  } catch (err) {
    logger.error('Get All HK Logs Error:', err);
    error(res, 'Failed to fetch logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: GET all requests with filters ────────────────────────────────────
export const getAllRequests = async (req, res) => {
  try {
    const { status, urgency, assigned_to, from, to, limit = 100, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) {
      conditions.push(`hr.status = $${idx++}`);
      params.push(status);
    }
    if (urgency) {
      conditions.push(`hr.urgency = $${idx++}`);
      params.push(urgency);
    }
    if (assigned_to) {
      conditions.push(`hr.assigned_to = $${idx++}::int`);
      params.push(assigned_to);
    }
    if (from) {
      conditions.push(`hr.created_at >= $${idx++}::timestamptz`);
      params.push(from);
    }
    if (to) {
      conditions.push(`hr.created_at <= $${idx++}::timestamptz`);
      params.push(to);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit), 500), parseInt(offset));

    // Two bugs surfaced as one finding (7a73a9b5):
    //   (a) the SELECT exposed only the stored `hr.sla_breached` flag —
    //       the column is set by an async breach-detector job, so a
    //       ticket past its SLA deadline can still show sla_breached=false
    //       between job runs. Stats said "8 currently breached" while
    //       the queue showed sla_breached:false on every row.
    //       Fix: compute the live breach at read time as well, and
    //       surface it as `sla_breached` (overriding the stored value).
    //       Keep the stored value as `sla_breached_stored` for forensics.
    //   (b) ORDER BY was urgency tier THEN newest-first — so older
    //       dirty-bed tickets past SLA sank below newer ones and were
    //       invisible to the housekeeping staff. Re-order so live-
    //       breached tickets surface FIRST, then urgency, then
    //       OLDEST-FIRST (the worklist convention). The discharge
    //       throughput depends on cleaning the most-overdue bed next,
    //       not the newest ticket.
    // Finding: 2026-05-22-inpatient-admission-housekeeping-7a73a9b5.
    const requests = await prisma.$queryRawUnsafe(
      `
      SELECT hr.id, hr.request_number, hr.requester_id, hr.zone_id, hr.location_text,
             hr.assigned_to, hr.request_type, hr.request_type as task_type,
             hr.urgency, hr.description, hr.description as notes, hr.status,
             hr.completed_at, hr.created_at, hr.sla_due_at,
             (
               hr.sla_breached OR (
                 hr.sla_due_at IS NOT NULL
                 AND hr.sla_due_at < NOW()
                 AND COALESCE(hr.status, '') NOT IN ('completed', 'cancelled')
               )
             ) AS sla_breached,
             hr.sla_breached AS sla_breached_stored,
             hz.name as zone_name,
             u.name as requester_name, s.department as requester_dept,
             u2.name as assigned_to_name
      FROM housekeeping_requests hr
      LEFT JOIN housekeeping_zones hz ON hr.zone_id = hz.id
      LEFT JOIN users u ON hr.requester_id = u.id
      LEFT JOIN staff s ON u.uid = s.user_id
      LEFT JOIN users u2 ON hr.assigned_to = u2.id
      ${where}
      ORDER BY
        (
          hr.sla_breached OR (
            hr.sla_due_at IS NOT NULL
            AND hr.sla_due_at < NOW()
            AND COALESCE(hr.status, '') NOT IN ('completed', 'cancelled')
          )
        ) DESC,
        CASE hr.urgency WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        hr.sla_due_at ASC NULLS LAST,
        hr.created_at ASC
      LIMIT $${idx++}::int OFFSET $${idx}::int
    `,
      ...params
    );

    const total = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM housekeeping_requests hr ${where}`,
      ...params.slice(0, -2)
    );

    success(res, { requests: requests, total: parseInt(total[0].count) }, 'Requests fetched');
  } catch (err) {
    logger.error('Get All HK Requests Error:', err);
    error(res, 'Failed to fetch requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── INCHARGE: floor/zone workload + active staff assignments ───────────────
export const getDelegationOverview = async (req, res) => {
  try {
    const [zones, assignments, staff] = await Promise.all([
      prisma.$queryRawUnsafe(
        `
        SELECT hz.id, hz.name, hz.zone_type, hz.floor, hz.building,
               COUNT(hr.id) FILTER (
                 WHERE COALESCE(hr.status, 'open') = ANY($1::text[])
               )::int AS active_requests,
               COUNT(hr.id) FILTER (
                 WHERE COALESCE(hr.status, 'open') = ANY($1::text[])
                   AND hr.urgency = 'urgent'
               )::int AS urgent_requests,
               COUNT(hr.id) FILTER (
                 WHERE COALESCE(hr.status, 'open') = ANY($1::text[])
                   AND hr.urgency = 'high'
               )::int AS high_requests,
               MIN(hr.created_at) FILTER (
                 WHERE COALESCE(hr.status, 'open') = ANY($1::text[])
               ) AS oldest_opened_at
          FROM housekeeping_zones hz
          LEFT JOIN housekeeping_requests hr ON hr.zone_id = hz.id
         WHERE hz.is_active = true
         GROUP BY hz.id, hz.name, hz.zone_type, hz.floor, hz.building
         ORDER BY COALESCE(hz.floor, ''), hz.name
      `,
        ACTIVE_REQUEST_STATUSES
      ),
      prisma.$queryRawUnsafe(`
        SELECT hfa.*, u.name AS staff_name, u.role AS staff_role,
               s.employee_id, hz.name AS current_zone_name
          FROM housekeeping_floor_assignments hfa
          JOIN users u ON u.id = hfa.staff_id
          LEFT JOIN staff s ON s.user_id = u.uid
          LEFT JOIN housekeeping_zones hz ON hz.id = hfa.zone_id
         WHERE hfa.status = 'active'
           AND hfa.effective_from <= NOW()
           AND (hfa.effective_to IS NULL OR hfa.effective_to > NOW())
         ORDER BY COALESCE(hfa.floor, ''), COALESCE(hz.name, hfa.zone_name, ''), u.name
      `),
      prisma.$queryRawUnsafe(
        `
        SELECT u.id, u.uid, u.name, u.role, s.employee_id, s.department, s.position,
               current_assignment.zone_id, current_assignment.zone_name,
               current_assignment.floor, current_assignment.building,
               current_assignment.shift_label,
               COUNT(hr.id) FILTER (
                 WHERE COALESCE(hr.status, 'open') = ANY($1::text[])
               )::int AS active_requests
          FROM users u
          LEFT JOIN staff s ON s.user_id = u.uid
          LEFT JOIN LATERAL (
            SELECT hfa.zone_id, COALESCE(hz.name, hfa.zone_name) AS zone_name,
                   hfa.floor, hfa.building, hfa.shift_label
              FROM housekeeping_floor_assignments hfa
              LEFT JOIN housekeeping_zones hz ON hz.id = hfa.zone_id
             WHERE hfa.staff_id = u.id
               AND hfa.status = 'active'
               AND hfa.effective_from <= NOW()
               AND (hfa.effective_to IS NULL OR hfa.effective_to > NOW())
             ORDER BY hfa.created_at DESC
             LIMIT 1
          ) current_assignment ON true
          LEFT JOIN housekeeping_requests hr ON hr.assigned_to = u.id
         WHERE u.is_active = true
           AND u.role = ANY($2::text[])
         GROUP BY u.id, u.uid, u.name, u.role, s.employee_id, s.department, s.position,
                  current_assignment.zone_id, current_assignment.zone_name,
                  current_assignment.floor, current_assignment.building,
                  current_assignment.shift_label
         ORDER BY u.role DESC, u.name
      `,
        ACTIVE_REQUEST_STATUSES,
        HOUSEKEEPING_ASSIGNABLE_ROLES
      )
    ]);

    success(res, { zones, assignments, staff }, 'Housekeeping delegation overview fetched');
  } catch (err) {
    logger.error('Get HK Delegation Overview Error:', err);
    error(
      res,
      'Failed to fetch housekeeping delegation overview',
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    );
  }
};

// ─── INCHARGE: assign/redeploy staff to another floor or zone ────────────────
export const delegateFloorAssignment = async (req, res) => {
  try {
    const incharge = await resolveCurrentUserRef(req);
    if (!incharge) {
      return error(res, 'Housekeeping incharge not found', HTTP_STATUS.NOT_FOUND);
    }

    const {
      staff_id,
      staff_uid,
      zone_id,
      floor,
      building,
      shift_label = 'current',
      effective_from,
      effective_to,
      reason,
      is_temporary = true,
      close_existing = true,
      reassign_unassigned_requests = false
    } = req.body;

    const staff = await resolveAssignableHousekeepingStaff({
      staffId: staff_id,
      staffUid: staff_uid
    });
    if (!staff) {
      return error(res, 'Assignable housekeeping staff not found', HTTP_STATUS.NOT_FOUND);
    }

    const parsedZoneId = zone_id ? Number.parseInt(zone_id, 10) : null;
    if (zone_id && (!Number.isInteger(parsedZoneId) || parsedZoneId <= 0)) {
      return error(res, 'zone_id must be a valid zone id', HTTP_STATUS.BAD_REQUEST);
    }

    const zone = await resolveHousekeepingZone(parsedZoneId);
    if (parsedZoneId && !zone) {
      return error(res, 'Housekeeping zone not found or inactive', HTTP_STATUS.NOT_FOUND);
    }

    if (!parsedZoneId && !floor) {
      return error(res, 'zone_id or floor is required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$transaction(async tx => {
      let sourceAssignment = null;
      if (close_existing) {
        const existing = await tx.$queryRawUnsafe(
          `UPDATE housekeeping_floor_assignments
              SET status = 'redeployed', effective_to = NOW(), updated_at = NOW()
            WHERE staff_id = $1::int
              AND status = 'active'
              AND effective_from <= NOW()
              AND (effective_to IS NULL OR effective_to > NOW())
            RETURNING id, zone_id, floor, building`,
          staff.id
        );
        sourceAssignment = existing[0] || null;
      }

      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO housekeeping_floor_assignments
           (staff_id, staff_uid, zone_id, zone_name, floor, building, shift_label,
            assigned_by, assigned_by_uid, reason, source_assignment_id,
            is_temporary, effective_from, effective_to, status)
         VALUES ($1::int,$2::uuid,$3::int,$4,$5,$6,$7,$8::int,$9::uuid,$10,$11::int,
                 $12::boolean,COALESCE($13::timestamptz, NOW()),$14::timestamptz,'active')
         RETURNING *`,
        staff.id,
        staff.uid,
        zone?.id || null,
        zone?.name || null,
        floor || zone?.floor || null,
        building || zone?.building || null,
        shift_label || 'current',
        incharge.id,
        incharge.uid,
        reason || null,
        sourceAssignment?.id || null,
        Boolean(is_temporary),
        effective_from || null,
        effective_to || null
      );

      let reassigned = [];
      if (reassign_unassigned_requests && zone?.id) {
        reassigned = await tx.$queryRawUnsafe(
          `UPDATE housekeeping_requests
              SET assigned_to = $1::int,
                  assigned_to_uid = $2::uuid,
                  assigned_at = NOW(),
                  assigned_by = $3::int,
                  assigned_by_uid = $4::uuid,
                  status = 'assigned',
                  updated_at = NOW()
            WHERE zone_id = $5::int
              AND assigned_to IS NULL
              AND COALESCE(status, 'open') = ANY($6::text[])
            RETURNING id, request_number`,
          staff.id,
          staff.uid,
          incharge.id,
          incharge.uid,
          zone.id,
          ACTIVE_REQUEST_STATUSES
        );

        for (const row of reassigned) {
          await tx.$executeRawUnsafe(
            `INSERT INTO housekeeping_request_updates
               (request_id, author_id, author_uid, author_role, message, is_internal)
             VALUES ($1::int,$2::int,$3::uuid,'housekeeping_incharge',$4,false)`,
            row.id,
            incharge.id,
            incharge.uid,
            `Delegated to ${staff.name || 'housekeeping staff'} for ${zone.name}${reason ? ': ' + reason : '.'}`
          );
        }
      }

      return { assignment: inserted[0], reassigned_count: reassigned.length };
    });

    success(res, result, 'Housekeeping staff delegated');
  } catch (err) {
    logger.error('Delegate HK Floor Assignment Error:', err);
    error(res, 'Failed to delegate housekeeping staff', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── INCHARGE: end an active floor/zone assignment ──────────────────────────
export const endFloorAssignment = async (req, res) => {
  try {
    const incharge = await resolveCurrentUserRef(req);
    if (!incharge) {
      return error(res, 'Housekeeping incharge not found', HTTP_STATUS.NOT_FOUND);
    }

    const { id } = req.params;
    const { reason } = req.body || {};

    const result = await prisma.$queryRawUnsafe(
      `UPDATE housekeeping_floor_assignments
          SET status = 'ended',
              effective_to = NOW(),
              reason = COALESCE($1, reason),
              updated_at = NOW()
        WHERE id = $2::int
          AND status = 'active'
        RETURNING *`,
      reason || null,
      id
    );

    if (!result.length) {
      return error(res, 'Active assignment not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result[0], 'Housekeeping assignment ended');
  } catch (err) {
    logger.error('End HK Floor Assignment Error:', err);
    error(res, 'Failed to end housekeeping assignment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: Assign request to HK staff ───────────────────────────────────────
export const assignRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const admin = await resolveCurrentUserRef(req);
    if (!admin) {
      return error(res, 'Admin user not found', HTTP_STATUS.NOT_FOUND);
    }
    const { assigned_to, note } = req.body;

    if (!assigned_to) return error(res, 'assigned_to is required', HTTP_STATUS.BAD_REQUEST);
    const assignedToId = Number.parseInt(assigned_to, 10);
    if (!Number.isInteger(assignedToId) || assignedToId <= 0) {
      return error(res, 'assigned_to must be a valid staff user id', HTTP_STATUS.BAD_REQUEST);
    }

    const assignedUser = await prisma.users.findUnique({
      where: { id: assignedToId },
      select: { id: true, uid: true, name: true }
    });
    if (!assignedUser) return error(res, 'Assigned staff not found', HTTP_STATUS.NOT_FOUND);

    const result = await prisma.$queryRawUnsafe(
      `
      UPDATE housekeeping_requests SET
        assigned_to = $1, assigned_to_uid = $2::uuid,
        assigned_at = NOW(), assigned_by = $3, assigned_by_uid = $4::uuid,
        status = 'assigned', updated_at = NOW()
      WHERE id = $5::int AND status IN ('open','assigned')
      RETURNING id, request_number, zone_id, assigned_to, assigned_to_uid,
        location_text, request_type, request_type as task_type, status, description,
        description as notes, completed_at, created_at
    `,
      assignedToId,
      assignedUser.uid,
      admin.id,
      admin.uid,
      id
    );

    if (result.length === 0)
      return error(res, 'Request not found or already in progress', HTTP_STATUS.NOT_FOUND);

    await markLinkedDirtyBedCleaning(result[0], admin.uid);

    await prisma.$queryRawUnsafe(
      `
      INSERT INTO housekeeping_request_updates (request_id, author_id, author_uid, author_role, message, is_internal)
      VALUES ($1::int, $2, $3::uuid, 'admin', $4, false)
    `,
      id,
      admin.id,
      admin.uid,
      `Assigned to ${assignedUser.name || 'staff'}${note ? '. Note: ' + note : '.'}`
    );

    success(res, result[0], 'Request assigned');
  } catch (err) {
    logger.error('Assign HK Request Error:', err);
    error(res, 'Failed to assign request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: Verify log ────────────────────────────────────────────────────────
export const verifyLog = async (req, res) => {
  try {
    const { id } = req.params;
    const verifier = await resolveCurrentUserRef(req);
    if (!verifier) {
      return error(res, 'Verifier not found', HTTP_STATUS.NOT_FOUND);
    }
    const { flag_reason } = req.body;
    const action = flag_reason ? 'flagged' : 'verified';

    const result = await prisma.$queryRawUnsafe(
      `
      UPDATE housekeeping_logs
      SET status = $1, verified_by = $2, verified_by_uid = $3::uuid,
        verified_at = NOW(), flag_reason = $4, updated_at = NOW()
      WHERE id = $5::int
      RETURNING id, staff_id, staff_uid, zone_id, status, verified_by, verified_at,
        flag_reason, logged_at, created_at
    `,
      action,
      verifier.id,
      verifier.uid,
      flag_reason || null,
      id
    );

    if (result.length === 0) return error(res, 'Log not found', HTTP_STATUS.NOT_FOUND);
    success(res, result[0], `Log ${action}`);
  } catch (err) {
    logger.error('Verify HK Log Error:', err);
    error(res, 'Failed to verify log', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: Verify request ────────────────────────────────────────────────────
export const verifyRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const verifier = await resolveCurrentUserRef(req);
    if (!verifier) {
      return error(res, 'Verifier not found', HTTP_STATUS.NOT_FOUND);
    }

    const result = await prisma.$queryRawUnsafe(
      `
      UPDATE housekeeping_requests
      SET status = 'verified', verified_by = $1, verified_by_uid = $2::uuid,
        verified_at = NOW(), updated_at = NOW()
      WHERE id = $3::int AND status = 'completed'
      RETURNING id, request_number, zone_id, assigned_to, request_type,
        request_type as task_type, status, description, description as notes,
        completed_at, created_at
    `,
      verifier.id,
      verifier.uid,
      id
    );

    if (result.length === 0)
      return error(res, 'Request not found or not yet completed', HTTP_STATUS.NOT_FOUND);

    await prisma.$queryRawUnsafe(
      `
      INSERT INTO housekeeping_request_updates (request_id, author_id, author_uid, author_role, message, is_internal)
      VALUES ($1::int, $2, $3::uuid, 'supervisor', 'Completion verified ✓', false)
    `,
      id,
      verifier.id,
      verifier.uid
    );

    success(res, result[0], 'Request verified');
  } catch (err) {
    logger.error('Verify HK Request Error:', err);
    error(res, 'Failed to verify request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: Stats dashboard ───────────────────────────────────────────────────
export const getHousekeepingStats = async (req, res) => {
  try {
    const [logStats, requestStats, slaStats, topStaff, recentFlags] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '24 hours') as today,
          COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '7 days') as this_week,
          COUNT(*) FILTER (WHERE status = 'flagged') as flagged,
          COUNT(*) FILTER (WHERE status = 'verified') as verified,
          COUNT(*) as total
        FROM housekeeping_logs
      `),
      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'open') as open,
          COUNT(*) FILTER (WHERE status = 'assigned') as assigned,
          COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE urgency = 'urgent' AND status NOT IN ('completed','verified','closed','cancelled')) as urgent_open,
          COUNT(*) FILTER (WHERE sla_breached = true) as sla_breached,
          COUNT(*) as total
        FROM housekeeping_requests
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `),
      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND completed_at <= sla_due_at) as completed_within_sla,
          COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND completed_at > sla_due_at) as completed_over_sla,
          COUNT(*) FILTER (WHERE completed_at IS NULL AND NOW() > sla_due_at) as currently_breached,
          ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/60) FILTER (WHERE completed_at IS NOT NULL)::NUMERIC, 0) as avg_completion_minutes
        FROM housekeeping_requests
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `),
      prisma.$queryRawUnsafe(`
        SELECT u.id, u.name, COUNT(*) as completions,
               ROUND(AVG(EXTRACT(EPOCH FROM (hr.completed_at - hr.assigned_at))/60) FILTER (WHERE hr.completed_at IS NOT NULL)::NUMERIC, 0) as avg_minutes
        FROM housekeeping_requests hr
        JOIN users u ON hr.assigned_to = u.id
        WHERE hr.status IN ('completed','verified','closed')
          AND hr.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY u.id, u.name ORDER BY completions DESC LIMIT 10
      `),
      prisma.$queryRawUnsafe(`
        SELECT hl.*, u.name as staff_name, hz.name as zone_name
        FROM housekeeping_logs hl
        LEFT JOIN users u ON hl.staff_id = u.id
        LEFT JOIN housekeeping_zones hz ON hl.zone_id = hz.id
        WHERE hl.status = 'flagged'
        ORDER BY hl.logged_at DESC LIMIT 10
      `)
    ]);

    success(
      res,
      {
        logs: logStats[0],
        requests: requestStats[0],
        sla: slaStats[0],
        top_staff: topStaff,
        recent_flags: recentFlags
      },
      'Housekeeping stats fetched'
    );
  } catch (err) {
    logger.error('HK Stats Error:', err);
    error(res, 'Failed to fetch stats', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── GET request detail with updates ─────────────────────────────────────────
export const getRequestDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const staff = await resolveCurrentUserRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    const req_ = await prisma.$queryRawUnsafe(
      `
      SELECT hr.id, hr.request_number, hr.requester_id, hr.zone_id, hr.location_text,
             hr.assigned_to, hr.request_type, hr.request_type as task_type,
             hr.urgency, hr.description, hr.description as notes,
             hr.status, hr.completed_at, hr.created_at, hr.sla_due_at,
             hz.name as zone_name, u.name as requester_name,
             u2.name as assigned_to_name, u3.name as verified_by_name
      FROM housekeeping_requests hr
      LEFT JOIN housekeeping_zones hz ON hr.zone_id = hz.id
      LEFT JOIN users u ON hr.requester_id = u.id
      LEFT JOIN users u2 ON hr.assigned_to = u2.id
      LEFT JOIN users u3 ON hr.verified_by = u3.id
      WHERE hr.id = $1::int AND (hr.requester_id = $2 OR hr.assigned_to = $2)
    `,
      id,
      staff.id
    );

    if (req_.length === 0) return error(res, 'Request not found', HTTP_STATUS.NOT_FOUND);

    const updates = await prisma.$queryRawUnsafe(
      `
      SELECT ru.*, u.name as author_name FROM housekeeping_request_updates ru
      LEFT JOIN users u ON ru.author_id = u.id
      WHERE ru.request_id = $1::int AND ru.is_internal = false
      ORDER BY ru.created_at ASC
    `,
      id
    );

    success(res, { ...req_[0], updates: updates }, 'Request detail fetched');
  } catch (err) {
    logger.error('Get HK Request Detail Error:', err);
    error(res, 'Failed to fetch request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── POST /zones — admin create zone ─────────────────────────────────────────
export const createZone = async (req, res) => {
  try {
    if (!requireZoneAdmin(req, res)) return;

    const { name, zone_type = 'general', floor, building } = req.body;

    const zoneName = String(name || '').trim();
    if (!zoneName) return error(res, 'name is required', HTTP_STATUS.BAD_REQUEST);

    const result = await prisma.$queryRawUnsafe(
      `
      INSERT INTO housekeeping_zones (name, zone_type, floor, building, is_active)
      VALUES ($1, $2, $3, $4, true)
      RETURNING id, name, zone_type, is_active, floor, building, created_at, updated_at
    `,
      zoneName,
      String(zone_type || 'general').trim() || 'general',
      floor ? String(floor).trim() : null,
      building ? String(building).trim() : null
    );

    success(res, result[0], 'Zone created');
  } catch (err) {
    logger.error('Create Zone Error:', err);
    error(res, 'Failed to create zone', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── PUT /zones/:id — admin update zone ──────────────────────────────────────
export const updateZone = async (req, res) => {
  try {
    if (!requireZoneAdmin(req, res)) return;

    const { id } = req.params;
    const { name, zone_type, floor, building, is_active } = req.body;

    const result = await prisma.$queryRawUnsafe(
      `
      UPDATE housekeeping_zones
      SET
        name = COALESCE($1, name),
        zone_type = COALESCE($2, zone_type),
        floor = COALESCE($3, floor),
        building = COALESCE($4, building),
        is_active = COALESCE($5, is_active),
        updated_at = NOW()
      WHERE id = $6::int
      RETURNING id, name, zone_type, is_active, floor, building, created_at, updated_at
    `,
      name === undefined ? null : String(name).trim() || null,
      zone_type === undefined ? null : String(zone_type).trim() || null,
      floor === undefined ? null : String(floor).trim() || null,
      building === undefined ? null : String(building).trim() || null,
      is_active !== undefined ? is_active : null,
      id
    );

    if (result.length === 0) return error(res, 'Zone not found', HTTP_STATUS.NOT_FOUND);

    success(res, result[0], 'Zone updated');
  } catch (err) {
    logger.error('Update Zone Error:', err);
    error(res, 'Failed to update zone', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── DELETE /zones/:id — admin soft-removes an unused zone ──────────────────
export const deleteZone = async (req, res) => {
  try {
    if (!requireZoneAdmin(req, res)) return;

    const { id } = req.params;

    const activeRequests = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM housekeeping_requests
        WHERE zone_id = $1::int
          AND COALESCE(status, 'open') = ANY($2::text[])`,
      id,
      ACTIVE_REQUEST_STATUSES
    );
    const activeAssignments = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM housekeeping_floor_assignments
        WHERE zone_id = $1::int
          AND status = 'active'
          AND effective_from <= NOW()
          AND (effective_to IS NULL OR effective_to > NOW())`,
      id
    );

    const requestCount = Number(activeRequests[0]?.count || 0);
    const assignmentCount = Number(activeAssignments[0]?.count || 0);
    if (requestCount > 0 || assignmentCount > 0) {
      return error(
        res,
        'Zone has active housekeeping requests or staff assignments',
        HTTP_STATUS.CONFLICT
      );
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE housekeeping_zones
          SET is_active = false, updated_at = NOW()
        WHERE id = $1::int
        RETURNING id, name, zone_type, is_active, floor, building, created_at, updated_at`,
      id
    );

    if (result.length === 0) return error(res, 'Zone not found', HTTP_STATUS.NOT_FOUND);

    success(res, result[0], 'Zone removed');
  } catch (err) {
    logger.error('Delete Zone Error:', err);
    error(res, 'Failed to remove zone', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── POST /requests/create — admin create emergency request ──────────────────
export const adminCreateRequest = async (req, res) => {
  try {
    const admin = await resolveCurrentUserRef(req);
    if (!admin) {
      return error(res, 'Admin user not found', HTTP_STATUS.NOT_FOUND);
    }
    const {
      zone_id,
      location_text,
      request_type = 'cleaning',
      urgency = 'normal',
      description,
      assigned_to
    } = req.body;

    if (!location_text && !zone_id) {
      return error(res, 'zone_id or location_text is required', HTTP_STATUS.BAD_REQUEST);
    }

    let assignedUser = null;
    if (assigned_to) {
      const assignedToId = Number.parseInt(assigned_to, 10);
      if (!Number.isInteger(assignedToId) || assignedToId <= 0) {
        return error(res, 'assigned_to must be a valid staff user id', HTTP_STATUS.BAD_REQUEST);
      }
      assignedUser = await prisma.users.findUnique({
        where: { id: assignedToId },
        select: { id: true, uid: true }
      });
      if (!assignedUser) return error(res, 'Assigned staff not found', HTTP_STATUS.NOT_FOUND);
    }

    const slaMinutes = { urgent: 30, high: 60, normal: 120, low: 240 }[urgency] ?? 120;
    const sla_due_at = new Date(Date.now() + slaMinutes * 60 * 1000).toISOString();

    const result = await prisma.$queryRawUnsafe(
      `
      INSERT INTO housekeeping_requests
        (requester_id, requester_uid, zone_id, location_text, request_type, urgency, description,
         status, assigned_to, assigned_to_uid, assigned_at, assigned_by, assigned_by_uid, sla_due_at)
      VALUES ($1, $2::uuid, $3::int, $4, $5, $6, $7,
              $8, $9, $10::uuid, $11::timestamptz, $12, $13::uuid, $14::timestamptz)
      RETURNING id, request_number, requester_id, requester_uid, zone_id, assigned_to,
        request_type, request_type as task_type, urgency, description, description as notes,
        status, completed_at, created_at, sla_due_at
    `,
      admin.id,
      admin.uid,
      zone_id || null,
      location_text || '',
      request_type,
      urgency,
      description || null,
      assigned_to ? 'assigned' : 'open',
      assignedUser?.id || null,
      assignedUser?.uid || null,
      assigned_to ? new Date().toISOString() : null,
      assigned_to ? admin.id : null,
      assigned_to ? admin.uid : null,
      sla_due_at
    );

    success(res, result[0], `Request ${result[0].request_number} created`);
  } catch (err) {
    logger.error('Admin Create Request Error:', err);
    error(res, 'Failed to create request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
