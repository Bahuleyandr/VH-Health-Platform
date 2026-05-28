import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import {
  canManageRosterDepartment,
  copyPreviousRosterBoard,
  createRosterPreferenceRequest,
  getRosterBoardDepartment,
  getRosterSnapshot,
  listDepartmentRosterPreferenceRequests,
  listMyRosterPreferenceRequests,
  publishRosterBoard,
  reviewRosterPreferenceRequest,
  saveRosterBoard,
  saveRosterDay
} from '../../services/staff/rosterBoardService.js';
import { success, error } from '../../utils/responseHelper.js';

function forbidden(res) {
  return error(res, 'You are not allowed to manage this roster department', HTTP_STATUS.FORBIDDEN);
}

function statusFromError(err) {
  return err.statusCode || err.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

export async function getDepartmentRoster(req, res) {
  try {
    const { department } = req.params;
    if (!canManageRosterDepartment(req.user, department)) return forbidden(res);

    const rosterDate =
      req.query?.date || req.query?.roster_date || new Date().toISOString().slice(0, 10);
    const snapshot = await getRosterSnapshot({ department, rosterDate });
    success(res, snapshot, 'Roster board fetched');
  } catch (err) {
    logger.error('Get roster board failed:', err);
    error(res, err.message || 'Failed to fetch roster board', statusFromError(err));
  }
}

export async function saveDepartmentRoster(req, res) {
  try {
    const { department } = req.params;
    if (!canManageRosterDepartment(req.user, department)) return forbidden(res);

    const board = await saveRosterBoard({
      department,
      rosterDate: req.body?.roster_date,
      shiftId: req.body?.shift_id,
      shiftLabel: req.body?.shift_label,
      notes: req.body?.notes,
      assignments: req.body?.assignments,
      actorUser: req.user,
      reason: req.body?.reason || 'Saved from roster board'
    });
    success(res, board, 'Roster board saved');
  } catch (err) {
    logger.error('Save roster board failed:', err);
    error(res, err.message || 'Failed to save roster board', statusFromError(err));
  }
}

export async function saveDepartmentRosterDay(req, res) {
  try {
    const { department } = req.params;
    if (!canManageRosterDepartment(req.user, department)) return forbidden(res);

    const board = await saveRosterDay({
      department,
      rosterDate: req.body?.roster_date,
      boards: req.body?.boards,
      actorUser: req.user,
      reason: req.body?.reason || 'Saved from roster day grid'
    });
    success(res, board, 'Roster day saved');
  } catch (err) {
    logger.error('Save roster day failed:', err);
    error(res, err.message || 'Failed to save roster day', statusFromError(err));
  }
}

export async function publishDepartmentRoster(req, res) {
  try {
    const { id } = req.params;
    const department = await getRosterBoardDepartment(id);
    if (!department) return error(res, 'Roster board not found', HTTP_STATUS.NOT_FOUND);
    if (!canManageRosterDepartment(req.user, department)) return forbidden(res);

    const board = await publishRosterBoard({
      rosterId: id,
      actorUser: req.user,
      reason: req.body?.reason || 'Published from roster board'
    });
    success(res, board, 'Roster board published');
  } catch (err) {
    logger.error('Publish roster board failed:', err);
    error(res, err.message || 'Failed to publish roster board', statusFromError(err));
  }
}

export async function copyPreviousDepartmentRoster(req, res) {
  try {
    const { department } = req.params;
    if (!canManageRosterDepartment(req.user, department)) return forbidden(res);

    const board = await copyPreviousRosterBoard({
      department,
      targetDate: req.body?.target_date || req.body?.roster_date,
      shiftLabel: req.body?.shift_label,
      actorUser: req.user,
      reason: req.body?.reason || 'Copied previous shift roster'
    });
    success(res, board, 'Previous roster copied');
  } catch (err) {
    logger.error('Copy roster board failed:', err);
    error(res, err.message || 'Failed to copy previous roster', statusFromError(err));
  }
}

export async function createDutyPreferenceRequest(req, res) {
  try {
    const requestRow = await createRosterPreferenceRequest({
      department: req.body?.department,
      staffId: req.body?.staff_id,
      requestedStartDate: req.body?.requested_start_date || req.body?.date,
      requestedEndDate: req.body?.requested_end_date || req.body?.date,
      periodType: req.body?.period_type,
      requestType: req.body?.request_type,
      shiftId: req.body?.shift_id,
      shiftLabel: req.body?.shift_label,
      assignmentTargetType: req.body?.assignment_target_type,
      assignmentTargetId: req.body?.assignment_target_id,
      assignmentTargetLabel: req.body?.assignment_target_label,
      floor: req.body?.floor,
      building: req.body?.building,
      priority: req.body?.priority,
      reason: req.body?.reason,
      actorUser: req.user,
      metadata: req.body?.metadata
    });
    success(res, requestRow, 'Roster preference request submitted');
  } catch (err) {
    logger.error('Create roster preference request failed:', err);
    error(res, err.message || 'Failed to submit roster preference request', statusFromError(err));
  }
}

export async function getMyDutyPreferenceRequests(req, res) {
  try {
    const requests = await listMyRosterPreferenceRequests({
      actorUser: req.user,
      limit: req.query?.limit
    });
    success(res, requests, 'Roster preference requests fetched');
  } catch (err) {
    logger.error('Get my roster preference requests failed:', err);
    error(res, err.message || 'Failed to fetch roster preference requests', statusFromError(err));
  }
}

export async function getDepartmentDutyPreferenceRequests(req, res) {
  try {
    const { department } = req.params;
    if (!canManageRosterDepartment(req.user, department)) return forbidden(res);

    const requests = await listDepartmentRosterPreferenceRequests({
      department,
      rosterDate: req.query?.date || req.query?.roster_date,
      status: req.query?.status
    });
    success(res, requests, 'Department roster preference requests fetched');
  } catch (err) {
    logger.error('Get department roster preference requests failed:', err);
    error(res, err.message || 'Failed to fetch roster preference requests', statusFromError(err));
  }
}

export async function reviewDutyPreferenceRequest(req, res) {
  try {
    const requestRow = await reviewRosterPreferenceRequest({
      requestId: req.params.id,
      decision: req.body?.decision || req.body?.status,
      reviewNotes: req.body?.review_notes || req.body?.note,
      actorUser: req.user,
      reason: req.body?.reason
    });
    success(res, requestRow, 'Roster preference request reviewed');
  } catch (err) {
    logger.error('Review roster preference request failed:', err);
    error(res, err.message || 'Failed to review roster preference request', statusFromError(err));
  }
}
