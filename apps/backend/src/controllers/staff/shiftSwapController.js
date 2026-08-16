import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import {
  cancelShiftSwap,
  listDepartmentShiftSwaps,
  listMyShiftSwaps,
  listSwapCandidates,
  proposeShiftSwap,
  respondToShiftSwap,
  reviewShiftSwap,
} from '../../services/staff/shiftSwapService.js';
import { success, error } from '../../utils/responseHelper.js';

function statusFromError(err) {
  return err.statusCode || err.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

export async function createShiftSwap(req, res) {
  try {
    const swap = await proposeShiftSwap({
      requesterAssignmentId: req.body?.requester_assignment_id ?? req.body?.my_assignment_id,
      counterpartyAssignmentId: req.body?.counterparty_assignment_id,
      reason: req.body?.reason,
      actorUser: req.user,
      tenantId: req.tenantId || null,
    });
    success(res, swap, 'Shift swap proposed', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Propose shift swap failed:', err);
    error(res, err.message || 'Failed to propose shift swap', statusFromError(err));
  }
}

export async function getMyShiftSwaps(req, res) {
  try {
    const rows = await listMyShiftSwaps({
      actorUser: req.user,
      limit: req.query?.limit,
    });
    success(res, rows, 'Shift swap requests fetched');
  } catch (err) {
    logger.error('List my shift swaps failed:', err);
    error(res, err.message || 'Failed to fetch shift swaps', statusFromError(err));
  }
}

export async function getSwapCandidates(req, res) {
  try {
    const rows = await listSwapCandidates({
      actorUser: req.user,
      limit: req.query?.limit,
    });
    success(res, rows, 'Swap candidates fetched');
  } catch (err) {
    logger.error('List swap candidates failed:', err);
    error(res, err.message || 'Failed to fetch swap candidates', statusFromError(err));
  }
}

export async function getDepartmentShiftSwaps(req, res) {
  try {
    const rows = await listDepartmentShiftSwaps({
      department: req.params.department,
      status: req.query?.status || null,
      actorUser: req.user,
      limit: req.query?.limit,
    });
    success(res, rows, 'Department shift swaps fetched');
  } catch (err) {
    logger.error('List department shift swaps failed:', err);
    error(res, err.message || 'Failed to fetch department shift swaps', statusFromError(err));
  }
}

export async function respondShiftSwap(req, res) {
  try {
    const swap = await respondToShiftSwap({
      swapId: req.params.id,
      decision: req.body?.decision,
      note: req.body?.note,
      actorUser: req.user,
    });
    success(res, swap, 'Shift swap response recorded');
  } catch (err) {
    logger.error('Respond to shift swap failed:', err);
    error(res, err.message || 'Failed to respond to shift swap', statusFromError(err));
  }
}

export async function cancelShiftSwapRequest(req, res) {
  try {
    const swap = await cancelShiftSwap({
      swapId: req.params.id,
      actorUser: req.user,
    });
    success(res, swap, 'Shift swap cancelled');
  } catch (err) {
    logger.error('Cancel shift swap failed:', err);
    error(res, err.message || 'Failed to cancel shift swap', statusFromError(err));
  }
}

export async function reviewShiftSwapRequest(req, res) {
  try {
    const swap = await reviewShiftSwap({
      swapId: req.params.id,
      decision: req.body?.decision,
      notes: req.body?.notes,
      actorUser: req.user,
    });
    success(res, swap, 'Shift swap reviewed');
  } catch (err) {
    logger.error('Review shift swap failed:', err);
    error(res, err.message || 'Failed to review shift swap', statusFromError(err));
  }
}
