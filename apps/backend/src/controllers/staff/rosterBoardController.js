import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import {
  canManageRosterDepartment,
  copyPreviousRosterBoard,
  getRosterBoardDepartment,
  getRosterSnapshot,
  publishRosterBoard,
  saveRosterBoard
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
