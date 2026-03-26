import db from '../../config/database.js';
import crypto from 'crypto';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';

// ─── SLA durations (minutes) ─────────────────────────────────────────────────
const SLA_MINUTES = { urgent: 30, high: 120, normal: 240, low: 1440 };

// ─── Signature hash for proof of work ────────────────────────────────────────
function generateSignature(staffId, zoneId, timestamp, photoKey) {
  return crypto
    .createHash('sha256')
    .update(`${staffId}:${zoneId || 'none'}:${timestamp}:${photoKey || 'none'}`)
    .digest('hex');
}

// ─── GET /zones — list all active zones ──────────────────────────────────────
export const getZones = async (req, res) => {
  try {
    const zones = await db.query(
      'SELECT * FROM housekeeping_zones WHERE is_active = true ORDER BY zone_type, name'
    );
    success(res, zones.rows, 'Zones fetched');
  } catch (err) {
    logger.error('Get Zones Error:', err);
    error(res, 'Failed to fetch zones', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── POST /log — submit cleaning completion log ───────────────────────────────
export const submitCleaningLog = async (req, res) => {
  try {
    const staffId = req.user?.uid;
    const {
      zone_id, location_text, latitude, longitude,
      cleaning_type = 'routine', notes,
      photo_key, photo_url,
    } = req.body;

    if (!location_text && !zone_id) {
      return error(res, 'zone_id or location_text is required', HTTP_STATUS.BAD_REQUEST);
    }

    const timestamp = new Date().toISOString();
    const signature = generateSignature(staffId, zone_id, timestamp, photo_key);

    const result = await db.query(`
      INSERT INTO housekeeping_logs
        (staff_id, zone_id, location_text, latitude, longitude, cleaning_type,
         notes, photo_key, photo_url, signature_hash, logged_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      staffId, zone_id || null, location_text || null,
      latitude || null, longitude || null,
      cleaning_type, notes || null,
      photo_key || null, photo_url || null,
      signature, timestamp,
    ]);

    success(res, result.rows[0], `Cleaning log ${result.rows[0].log_number} submitted`);
  } catch (err) {
    logger.error('Submit Cleaning Log Error:', err);
    error(res, 'Failed to submit cleaning log', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── GET /logs/my — staff's own cleaning logs ────────────────────────────────
export const getMyCleaningLogs = async (req, res) => {
  try {
    const staffId = req.user?.uid;
    const { limit = 50 } = req.query;

    const logs = await db.query(`
      SELECT hl.*, hz.name as zone_name, hz.zone_type
      FROM housekeeping_logs hl
      LEFT JOIN housekeeping_zones hz ON hl.zone_id = hz.id
      WHERE hl.staff_id = $1
      ORDER BY hl.logged_at DESC LIMIT $2
    `, [staffId, parseInt(limit)]);

    success(res, logs.rows, 'Cleaning logs fetched');
  } catch (err) {
    logger.error('Get My Cleaning Logs Error:', err);
    error(res, 'Failed to fetch logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── POST /request — raise a housekeeping request ───────────────────────────
export const raiseRequest = async (req, res) => {
  try {
    const requesterId = req.user?.uid;
    const {
      zone_id, location_text, latitude, longitude,
      request_type = 'cleaning', urgency = 'normal',
      description, photo_key, photo_url,
    } = req.body;

    if (!location_text && !zone_id) {
      return error(res, 'zone_id or location_text is required', HTTP_STATUS.BAD_REQUEST);
    }

    const validUrgency = ['low','normal','high','urgent'];
    if (!validUrgency.includes(urgency)) {
      return error(res, `urgency must be: ${validUrgency.join(', ')}`, HTTP_STATUS.BAD_REQUEST);
    }

    const slaMinutes = SLA_MINUTES[urgency] || 240;
    const slaDueAt = new Date(Date.now() + slaMinutes * 60000).toISOString();

    const result = await db.query(`
      INSERT INTO housekeeping_requests
        (requester_id, zone_id, location_text, latitude, longitude,
         request_type, urgency, description, photo_key, photo_url, sla_due_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      requesterId, zone_id || null, location_text || '',
      latitude || null, longitude || null,
      request_type, urgency, description || null,
      photo_key || null, photo_url || null, slaDueAt,
    ]);

    // System update
    await db.query(`
      INSERT INTO housekeeping_request_updates (request_id, author_role, message, is_internal)
      VALUES ($1, 'system', $2, false)
    `, [result.rows[0].id, `Request ${result.rows[0].request_number} raised. Urgency: ${urgency.toUpperCase()}. SLA: ${slaMinutes < 60 ? `${slaMinutes}min` : `${slaMinutes/60}h`}.`]);

    success(res, result.rows[0], `Request ${result.rows[0].request_number} raised`);
  } catch (err) {
    logger.error('Raise HK Request Error:', err);
    error(res, 'Failed to raise request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── GET /requests/my — staff's own requests and assigned requests ───────────
export const getMyRequests = async (req, res) => {
  try {
    const staffId = req.user?.uid;

    const raised = await db.query(`
      SELECT hr.*, hz.name as zone_name, u.name as assigned_to_name
      FROM housekeeping_requests hr
      LEFT JOIN housekeeping_zones hz ON hr.zone_id = hz.id
      LEFT JOIN users u ON hr.assigned_to = u.id
      WHERE hr.requester_id = $1
      ORDER BY hr.created_at DESC LIMIT 30
    `, [staffId]);

    const assigned = await db.query(`
      SELECT hr.*, hz.name as zone_name, u.name as requester_name
      FROM housekeeping_requests hr
      LEFT JOIN housekeeping_zones hz ON hr.zone_id = hz.id
      LEFT JOIN users u ON hr.requester_id = u.id
      WHERE hr.assigned_to = $1 AND hr.status NOT IN ('completed','verified','closed','cancelled')
      ORDER BY hr.urgency DESC, hr.created_at ASC LIMIT 20
    `, [staffId]);

    success(res, { raised: raised.rows, assigned: assigned.rows }, 'Requests fetched');
  } catch (err) {
    logger.error('Get My HK Requests Error:', err);
    error(res, 'Failed to fetch requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── POST /requests/:id/complete — mark request done with optional photo ─────
export const completeRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.uid;
    const { completion_notes, completion_photo_key, completion_photo_url } = req.body;

    const reqCheck = await db.query(
      'SELECT * FROM housekeeping_requests WHERE id = $1 AND assigned_to = $2',
      [id, staffId]
    );
    if (reqCheck.rows.length === 0) {
      return error(res, 'Request not found or not assigned to you', HTTP_STATUS.NOT_FOUND);
    }

    const timestamp = new Date().toISOString();
    const signatureHash = generateSignature(staffId, reqCheck.rows[0].zone_id, timestamp, completion_photo_key);

    const result = await db.query(`
      UPDATE housekeeping_requests SET
        status = 'completed',
        completed_at = NOW(),
        completion_notes = $1,
        completion_photo_key = $2,
        completion_photo_url = $3,
        completion_signature_hash = $4,
        updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `, [completion_notes || null, completion_photo_key || null, completion_photo_url || null, signatureHash, id]);

    await db.query(`
      INSERT INTO housekeeping_request_updates (request_id, author_id, author_role, message, is_internal)
      VALUES ($1, $2, 'hk_staff', $3, false)
    `, [id, staffId, `Task completed by housekeeping staff${completion_notes ? ': ' + completion_notes : '.'}`]);

    success(res, result.rows[0], 'Request marked as completed');
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

    if (staff_id) { conditions.push(`hl.staff_id = $${idx++}`); params.push(staff_id); }
    if (zone_id)  { conditions.push(`hl.zone_id = $${idx++}`); params.push(zone_id); }
    if (status)   { conditions.push(`hl.status = $${idx++}`); params.push(status); }
    if (from)     { conditions.push(`hl.logged_at >= $${idx++}`); params.push(from); }
    if (to)       { conditions.push(`hl.logged_at <= $${idx++}`); params.push(to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit), 500), parseInt(offset));

    const logs = await db.query(`
      SELECT hl.*, u.name as staff_name, u.department,
             hz.name as zone_name, hz.zone_type,
             u2.name as verified_by_name
      FROM housekeeping_logs hl
      LEFT JOIN users u ON hl.staff_id = u.id
      LEFT JOIN housekeeping_zones hz ON hl.zone_id = hz.id
      LEFT JOIN users u2 ON hl.verified_by = u2.id
      ${where}
      ORDER BY hl.logged_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `, params);

    const total = await db.query(
      `SELECT COUNT(*) FROM housekeeping_logs hl ${where}`,
      params.slice(0, -2)
    );

    success(res, { logs: logs.rows, total: parseInt(total.rows[0].count) }, 'Logs fetched');
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

    if (status)      { conditions.push(`hr.status = $${idx++}`); params.push(status); }
    if (urgency)     { conditions.push(`hr.urgency = $${idx++}`); params.push(urgency); }
    if (assigned_to) { conditions.push(`hr.assigned_to = $${idx++}`); params.push(assigned_to); }
    if (from)        { conditions.push(`hr.created_at >= $${idx++}`); params.push(from); }
    if (to)          { conditions.push(`hr.created_at <= $${idx++}`); params.push(to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit), 500), parseInt(offset));

    const requests = await db.query(`
      SELECT hr.*, hz.name as zone_name,
             u.name as requester_name, u.department as requester_dept,
             u2.name as assigned_to_name
      FROM housekeeping_requests hr
      LEFT JOIN housekeeping_zones hz ON hr.zone_id = hz.id
      LEFT JOIN users u ON hr.requester_id = u.id
      LEFT JOIN users u2 ON hr.assigned_to = u2.id
      ${where}
      ORDER BY
        CASE hr.urgency WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        hr.created_at DESC
      LIMIT $${idx++} OFFSET $${idx}
    `, params);

    const total = await db.query(
      `SELECT COUNT(*) FROM housekeeping_requests hr ${where}`,
      params.slice(0, -2)
    );

    success(res, { requests: requests.rows, total: parseInt(total.rows[0].count) }, 'Requests fetched');
  } catch (err) {
    logger.error('Get All HK Requests Error:', err);
    error(res, 'Failed to fetch requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: Assign request to HK staff ───────────────────────────────────────
export const assignRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?.uid;
    const { assigned_to, note } = req.body;

    if (!assigned_to) return error(res, 'assigned_to is required', HTTP_STATUS.BAD_REQUEST);

    const result = await db.query(`
      UPDATE housekeeping_requests SET
        assigned_to = $1, assigned_at = NOW(), assigned_by = $2,
        status = 'assigned', updated_at = NOW()
      WHERE id = $3 AND status IN ('open','assigned')
      RETURNING *
    `, [assigned_to, adminId, id]);

    if (result.rows.length === 0) return error(res, 'Request not found or already in progress', HTTP_STATUS.NOT_FOUND);

    const staff = await db.query('SELECT name FROM users WHERE id = $1', [assigned_to]);
    await db.query(`
      INSERT INTO housekeeping_request_updates (request_id, author_id, author_role, message, is_internal)
      VALUES ($1, $2, 'admin', $3, false)
    `, [id, adminId, `Assigned to ${staff.rows[0]?.name || 'staff'}${note ? '. Note: ' + note : '.'}`]);

    success(res, result.rows[0], 'Request assigned');
  } catch (err) {
    logger.error('Assign HK Request Error:', err);
    error(res, 'Failed to assign request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: Verify log ────────────────────────────────────────────────────────
export const verifyLog = async (req, res) => {
  try {
    const { id } = req.params;
    const verifierId = req.user?.uid;
    const { flag_reason } = req.body;
    const action = flag_reason ? 'flagged' : 'verified';

    const result = await db.query(`
      UPDATE housekeeping_logs SET status = $1, verified_by = $2, verified_at = NOW(),
        flag_reason = $3 WHERE id = $4 RETURNING *
    `, [action, verifierId, flag_reason || null, id]);

    if (result.rows.length === 0) return error(res, 'Log not found', HTTP_STATUS.NOT_FOUND);
    success(res, result.rows[0], `Log ${action}`);
  } catch (err) {
    logger.error('Verify HK Log Error:', err);
    error(res, 'Failed to verify log', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: Verify request ────────────────────────────────────────────────────
export const verifyRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const verifierId = req.user?.uid;

    const result = await db.query(`
      UPDATE housekeeping_requests SET status = 'verified', verified_by = $1, verified_at = NOW(),
        updated_at = NOW() WHERE id = $2 AND status = 'completed' RETURNING *
    `, [verifierId, id]);

    if (result.rows.length === 0) return error(res, 'Request not found or not yet completed', HTTP_STATUS.NOT_FOUND);

    await db.query(`
      INSERT INTO housekeeping_request_updates (request_id, author_id, author_role, message, is_internal)
      VALUES ($1, $2, 'supervisor', 'Completion verified ✓', false)
    `, [id, verifierId]);

    success(res, result.rows[0], 'Request verified');
  } catch (err) {
    logger.error('Verify HK Request Error:', err);
    error(res, 'Failed to verify request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── ADMIN: Stats dashboard ───────────────────────────────────────────────────
export const getHousekeepingStats = async (req, res) => {
  try {
    const [logStats, requestStats, slaStats, topStaff, recentFlags] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '24 hours') as today,
          COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '7 days') as this_week,
          COUNT(*) FILTER (WHERE status = 'flagged') as flagged,
          COUNT(*) FILTER (WHERE status = 'verified') as verified,
          COUNT(*) as total
        FROM housekeeping_logs
      `),
      db.query(`
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
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND completed_at <= sla_due_at) as completed_within_sla,
          COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND completed_at > sla_due_at) as completed_over_sla,
          COUNT(*) FILTER (WHERE completed_at IS NULL AND NOW() > sla_due_at) as currently_breached,
          ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/60) FILTER (WHERE completed_at IS NOT NULL)::NUMERIC, 0) as avg_completion_minutes
        FROM housekeeping_requests
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `),
      db.query(`
        SELECT u.id, u.name, COUNT(*) as completions,
               ROUND(AVG(EXTRACT(EPOCH FROM (hr.completed_at - hr.assigned_at))/60) FILTER (WHERE hr.completed_at IS NOT NULL)::NUMERIC, 0) as avg_minutes
        FROM housekeeping_requests hr
        JOIN users u ON hr.assigned_to = u.id
        WHERE hr.status IN ('completed','verified','closed')
          AND hr.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY u.id, u.name ORDER BY completions DESC LIMIT 10
      `),
      db.query(`
        SELECT hl.*, u.name as staff_name, hz.name as zone_name
        FROM housekeeping_logs hl
        LEFT JOIN users u ON hl.staff_id = u.id
        LEFT JOIN housekeeping_zones hz ON hl.zone_id = hz.id
        WHERE hl.status = 'flagged'
        ORDER BY hl.logged_at DESC LIMIT 10
      `),
    ]);

    success(res, {
      logs: logStats.rows[0],
      requests: requestStats.rows[0],
      sla: slaStats.rows[0],
      top_staff: topStaff.rows,
      recent_flags: recentFlags.rows,
    }, 'Housekeeping stats fetched');
  } catch (err) {
    logger.error('HK Stats Error:', err);
    error(res, 'Failed to fetch stats', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── GET request detail with updates ─────────────────────────────────────────
export const getRequestDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const staffId = req.user?.uid;

    const req_ = await db.query(`
      SELECT hr.*, hz.name as zone_name, u.name as requester_name,
             u2.name as assigned_to_name, u3.name as verified_by_name
      FROM housekeeping_requests hr
      LEFT JOIN housekeeping_zones hz ON hr.zone_id = hz.id
      LEFT JOIN users u ON hr.requester_id = u.id
      LEFT JOIN users u2 ON hr.assigned_to = u2.id
      LEFT JOIN users u3 ON hr.verified_by = u3.id
      WHERE hr.id = $1 AND (hr.requester_id = $2 OR hr.assigned_to = $2)
    `, [id, staffId]);

    if (req_.rows.length === 0) return error(res, 'Request not found', HTTP_STATUS.NOT_FOUND);

    const updates = await db.query(`
      SELECT ru.*, u.name as author_name FROM housekeeping_request_updates ru
      LEFT JOIN users u ON ru.author_id = u.id
      WHERE ru.request_id = $1 AND ru.is_internal = false
      ORDER BY ru.created_at ASC
    `, [id]);

    success(res, { ...req_.rows[0], updates: updates.rows }, 'Request detail fetched');
  } catch (err) {
    logger.error('Get HK Request Detail Error:', err);
    error(res, 'Failed to fetch request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
