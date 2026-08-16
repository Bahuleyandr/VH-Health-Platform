import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import {
  createOnCallAssignment,
  endOnCallAssignment,
  getWhoIsOnCall,
  listDepartmentOnCallAssignments,
  listMyOnCallAssignments,
} from '../../services/staff/onCallRosterService.js';
import { success, error } from '../../utils/responseHelper.js';

function statusFromError(err) {
  return err.statusCode || err.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

export async function getMyOnCall(req, res) {
  try {
    const rows = await listMyOnCallAssignments({
      actorUser: req.user,
      tenantId: req.tenantId || null,
      limit: req.query?.limit,
    });
    success(res, rows, 'My on-call assignments fetched');
  } catch (err) {
    logger.error('List my on-call assignments failed:', err);
    error(res, err.message || 'Failed to fetch on-call assignments', statusFromError(err));
  }
}

export async function getOnCallNow(req, res) {
  try {
    const rows = await getWhoIsOnCall({
      tenantId: req.tenantId || null,
      department: req.query?.department || null,
      tier: req.query?.tier ?? null,
      at: req.query?.at || null,
    });
    success(res, rows, 'Current on-call staff fetched');
  } catch (err) {
    logger.error('Who-is-on-call lookup failed:', err);
    error(res, err.message || 'Failed to fetch current on-call staff', statusFromError(err));
  }
}

export async function getDepartmentOnCall(req, res) {
  try {
    const rows = await listDepartmentOnCallAssignments({
      department: req.params.department,
      tenantId: req.tenantId || null,
      includeEnded: String(req.query?.include_ended || '') === 'true',
      actorUser: req.user,
      limit: req.query?.limit,
    });
    success(res, rows, 'Department on-call roster fetched');
  } catch (err) {
    logger.error('List department on-call roster failed:', err);
    error(res, err.message || 'Failed to fetch on-call roster', statusFromError(err));
  }
}

export async function createDepartmentOnCall(req, res) {
  try {
    const created = await createOnCallAssignment({
      department: req.params.department,
      specialty: req.body?.specialty ?? null,
      tier: req.body?.tier ?? 1,
      staffId: req.body?.staff_id,
      startAt: req.body?.start_at,
      endAt: req.body?.end_at,
      notes: req.body?.notes ?? null,
      actorUser: req.user,
      tenantId: req.tenantId || null,
    });
    success(res, created, 'On-call assignment created', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Create on-call assignment failed:', err);
    error(res, err.message || 'Failed to create on-call assignment', statusFromError(err));
  }
}

export async function endOnCall(req, res) {
  try {
    const ended = await endOnCallAssignment({
      id: req.params.id,
      reason: req.body?.reason ?? null,
      actorUser: req.user,
      tenantId: req.tenantId || null,
    });
    success(res, ended, 'On-call assignment ended');
  } catch (err) {
    logger.error('End on-call assignment failed:', err);
    error(res, err.message || 'Failed to end on-call assignment', statusFromError(err));
  }
}
