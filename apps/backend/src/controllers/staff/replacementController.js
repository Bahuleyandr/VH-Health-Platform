import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// Staff JWTs only carry { uid, role } (see staffAuthService.generateAccessToken).
// `replacement_requests.{requester_id,replacement_staff_id,hr_approved_by}` are
// all INT FKs to users.id, so every handler here needs to resolve the JWT
// uid → users.id before binding it as a SQL param. Doing the lookup
// centrally avoids the `invalid input syntax for type integer: "<uuid>"`
// 500s that surfaced for every clinical role when the controller passed
// `req.user.uid` straight into the FK column.
async function resolveUserIntId(req) {
  if (req.user?.id) return Number(req.user.id);
  const uid = req.user?.uid;
  if (!uid) return null;
  const row = await prisma.users.findUnique({ where: { uid: String(uid) }, select: { id: true } });
  return row?.id ?? null;
}

export const requestReplacement = async (req, res) => {
  try {
    const requesterId = await resolveUserIntId(req);
    if (!requesterId) {
      return error(res, 'Unable to resolve requester identity', HTTP_STATUS.UNAUTHORIZED);
    }
    const { replacement_staff_id, dates, message, leave_request_id } = req.body;

    if (!replacement_staff_id || !dates) {
      return error(res, 'replacement_staff_id and dates are required', HTTP_STATUS.BAD_REQUEST);
    }

    // Verify replacement staff exists
    const staffCheck = await prisma.$queryRawUnsafe(
      "SELECT id, name FROM users WHERE id = $1 AND role LIKE '%STAFF%'", replacement_staff_id);
    if (staffCheck.length === 0) {
      return error(res, 'Replacement staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO replacement_requests (leave_request_id, requester_id, replacement_staff_id, dates, status, requester_message, requested_at)
      VALUES ($1, $2, $3, $4, 'pending', $5, NOW()) RETURNING id, original_staff_id, replacement_staff_id, shift_date, status, reason, created_at
    `, leave_request_id || null, requesterId, replacement_staff_id, JSON.stringify(dates), message || null);

    success(res, result[0], 'Replacement request sent');
  } catch (err) {
    logger.error('Request Replacement Error:', err);
    error(res, 'Failed to send replacement request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const respondToReplacement = async (req, res) => {
  try {
    const { id } = req.params;
    const responderId = await resolveUserIntId(req);
    if (!responderId) {
      return error(res, 'Unable to resolve responder identity', HTTP_STATUS.UNAUTHORIZED);
    }
    const { status, message } = req.body;

    if (!['accepted', 'declined'].includes(status)) {
      return error(res, 'status must be accepted or declined', HTTP_STATUS.BAD_REQUEST);
    }

    // Verify this person is the designated replacement
    const reqCheck = await prisma.$queryRawUnsafe(
      'SELECT id, original_staff_id, replacement_staff_id, shift_date, status, reason, created_at FROM replacement_requests WHERE id = $1 AND replacement_staff_id = $2', id, responderId);
    if (reqCheck.length === 0) {
      return error(res, 'Replacement request not found or not authorized', HTTP_STATUS.NOT_FOUND);
    }

    const result = await prisma.$queryRawUnsafe(`
      UPDATE replacement_requests SET status=$1, responder_message=$2, responded_at=NOW()
      WHERE id=$3 RETURNING id, original_staff_id, replacement_staff_id, shift_date, status, reason, created_at
    `, status, message || null, id);

    success(res, result[0], `Replacement request ${status}`);
  } catch (err) {
    logger.error('Respond Replacement Error:', err);
    error(res, 'Failed to respond to replacement request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getPendingReplacements = async (req, res) => {
  try {
    const staffId = await resolveUserIntId(req);
    if (!staffId) {
      // No int id → no replacement assignments possible. Return empty
      // list rather than 500 so the Leave screen renders cleanly.
      return success(res, [], 'Pending replacement requests fetched');
    }
    const rows = await prisma.$queryRawUnsafe(`
      SELECT rr.id, rr.original_staff_id, rr.replacement_staff_id, rr.shift_date, rr.status, rr.reason, rr.created_at,
        u.name as requester_name, u2.name as replacement_name
      FROM replacement_requests rr
      JOIN users u ON rr.requester_id = u.id
      JOIN users u2 ON rr.replacement_staff_id = u2.id
      WHERE rr.replacement_staff_id = $1 AND rr.status = 'pending'
      ORDER BY rr.requested_at DESC
    `, staffId);
    success(res, rows, 'Pending replacement requests fetched');
  } catch (err) {
    logger.error('Get Pending Replacements Error:', err);
    error(res, 'Failed to fetch replacement requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getReplacementHistory = async (req, res) => {
  try {
    const staffId = await resolveUserIntId(req);
    if (!staffId) {
      return success(res, [], 'Replacement history fetched');
    }
    const rows = await prisma.$queryRawUnsafe(`
      SELECT rr.id, rr.original_staff_id, rr.replacement_staff_id, rr.shift_date, rr.status, rr.reason, rr.created_at,
        u.name as requester_name, u2.name as replacement_name
      FROM replacement_requests rr
      JOIN users u ON rr.requester_id = u.id
      JOIN users u2 ON rr.replacement_staff_id = u2.id
      WHERE rr.requester_id = $1 OR rr.replacement_staff_id = $1
      ORDER BY rr.requested_at DESC LIMIT 50
    `, staffId);
    success(res, rows, 'Replacement history fetched');
  } catch (err) {
    logger.error('Get Replacement History Error:', err);
    error(res, 'Failed to fetch replacement history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const hrApproveReplacement = async (req, res) => {
  try {
    const { id } = req.params;
    const hrId = await resolveUserIntId(req);
    if (!hrId) {
      return error(res, 'Unable to resolve HR identity', HTTP_STATUS.UNAUTHORIZED);
    }
    const result = await prisma.$queryRawUnsafe(`
      UPDATE replacement_requests SET status='hr_approved', hr_approved_at=NOW(), hr_approved_by=$1
      WHERE id=$2 AND status='accepted' RETURNING id, original_staff_id, replacement_staff_id, shift_date, status, reason, created_at
    `, hrId, id);
    if (result.length === 0) {
      return error(res, 'Replacement request not found or not in accepted state', HTTP_STATUS.NOT_FOUND);
    }
    success(res, result[0], 'Replacement HR approved');
  } catch (err) {
    logger.error('HR Approve Replacement Error:', err);
    error(res, 'Failed to approve replacement', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
