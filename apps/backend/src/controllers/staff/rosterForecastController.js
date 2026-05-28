import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import {
  createRosterLeaveForecast,
  getLatestRosterLeaveForecast,
  listRosterCalendarEvents,
  listRosterForecastAudit,
  listRosterWeatherSignals,
  listStaffCommuteProfiles,
  reviewRosterLeaveForecast,
  upsertRosterCalendarEvent,
  upsertRosterWeatherSignal,
  upsertStaffCommuteProfile,
} from '../../services/ai/staffLeaveForecastService.js';
import { canManageRosterDepartment } from '../../services/staff/rosterBoardService.js';
import { success, error } from '../../utils/responseHelper.js';

const ADMIN_CONFIG_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'HR_STAFF']);

function statusFromError(err) {
  return err.statusCode || err.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

function forbidden(res, message = 'You are not allowed to manage roster forecasting') {
  return error(res, message, HTTP_STATUS.FORBIDDEN);
}

function canManageForecastConfig(user) {
  const role = String(user?.rawRole || user?.role || '').toUpperCase();
  return ADMIN_CONFIG_ROLES.has(role);
}

export async function createDepartmentForecast(req, res) {
  try {
    const { department } = req.params;
    if (!canManageRosterDepartment(req.user, department)) return forbidden(res);
    const startDate =
      req.body?.start_date ||
      req.body?.startDate ||
      req.query?.start_date ||
      new Date().toISOString().slice(0, 10);
    const result = await createRosterLeaveForecast({
      tenantId: req.tenantId,
      department,
      startDate,
      endDate: req.body?.end_date || req.body?.endDate || null,
      actorUser: req.user,
    });
    success(res, result, 'Roster leave forecast generated', result.run_id ? HTTP_STATUS.CREATED : HTTP_STATUS.OK);
  } catch (err) {
    logger.error('Create roster leave forecast failed:', err);
    error(res, err.message || 'Failed to generate roster leave forecast', statusFromError(err));
  }
}

export async function getDepartmentForecast(req, res) {
  try {
    const { department } = req.params;
    if (!canManageRosterDepartment(req.user, department)) return forbidden(res);
    const result = await getLatestRosterLeaveForecast({
      tenantId: req.tenantId,
      department,
      rosterDate: req.query?.date || req.query?.roster_date || null,
      includeStaffScores: true,
    });
    success(res, result, 'Roster leave forecast fetched');
  } catch (err) {
    logger.error('Get roster leave forecast failed:', err);
    error(res, err.message || 'Failed to fetch roster leave forecast', statusFromError(err));
  }
}

export async function reviewForecast(req, res) {
  try {
    const result = await reviewRosterLeaveForecast({
      tenantId: req.tenantId,
      runId: req.params.id,
      decision: req.body?.decision,
      reviewerNotes: req.body?.reviewer_notes || req.body?.notes || null,
      actorUser: req.user,
    });
    success(res, result, 'Roster leave forecast reviewed');
  } catch (err) {
    logger.error('Review roster leave forecast failed:', err);
    error(res, err.message || 'Failed to review roster leave forecast', statusFromError(err));
  }
}

export async function getForecastAudit(req, res) {
  try {
    const result = await listRosterForecastAudit({
      tenantId: req.tenantId,
      runId: req.params.id,
    });
    success(res, result, 'Roster leave forecast audit fetched');
  } catch (err) {
    logger.error('Get roster leave forecast audit failed:', err);
    error(res, err.message || 'Failed to fetch roster leave forecast audit', statusFromError(err));
  }
}

export async function listCalendarEvents(req, res) {
  try {
    if (!canManageForecastConfig(req.user)) return forbidden(res);
    const result = await listRosterCalendarEvents({
      tenantId: req.tenantId,
      startDate: req.query?.start_date || null,
      endDate: req.query?.end_date || null,
      department: req.query?.department || null,
    });
    success(res, result, 'Roster calendar events fetched');
  } catch (err) {
    logger.error('List roster calendar events failed:', err);
    error(res, err.message || 'Failed to fetch roster calendar events', statusFromError(err));
  }
}

export async function saveCalendarEvent(req, res) {
  try {
    if (!canManageForecastConfig(req.user)) return forbidden(res);
    const result = await upsertRosterCalendarEvent({
      tenantId: req.tenantId,
      eventId: req.params.id || null,
      payload: req.body || {},
      actorUser: req.user,
    });
    success(res, result, 'Roster calendar event saved', req.params.id ? HTTP_STATUS.OK : HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Save roster calendar event failed:', err);
    error(res, err.message || 'Failed to save roster calendar event', statusFromError(err));
  }
}

export async function listCommuteProfiles(req, res) {
  try {
    if (!canManageForecastConfig(req.user)) return forbidden(res);
    const result = await listStaffCommuteProfiles({
      tenantId: req.tenantId,
      staffId: req.query?.staff_id || null,
    });
    success(res, result, 'Staff commute profiles fetched');
  } catch (err) {
    logger.error('List staff commute profiles failed:', err);
    error(res, err.message || 'Failed to fetch commute profiles', statusFromError(err));
  }
}

export async function saveCommuteProfile(req, res) {
  try {
    if (!canManageForecastConfig(req.user)) return forbidden(res);
    const result = await upsertStaffCommuteProfile({
      tenantId: req.tenantId,
      payload: req.body || {},
      actorUser: req.user,
    });
    success(res, result, 'Staff commute profile saved', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Save staff commute profile failed:', err);
    error(res, err.message || 'Failed to save commute profile', statusFromError(err));
  }
}

export async function listWeatherSignals(req, res) {
  try {
    if (!canManageForecastConfig(req.user)) return forbidden(res);
    const result = await listRosterWeatherSignals({
      tenantId: req.tenantId,
      startDate: req.query?.start_date || null,
      endDate: req.query?.end_date || null,
    });
    success(res, result, 'Roster weather signals fetched');
  } catch (err) {
    logger.error('List roster weather signals failed:', err);
    error(res, err.message || 'Failed to fetch weather signals', statusFromError(err));
  }
}

export async function saveWeatherSignal(req, res) {
  try {
    if (!canManageForecastConfig(req.user)) return forbidden(res);
    const result = await upsertRosterWeatherSignal({
      tenantId: req.tenantId,
      payload: req.body || {},
      actorUser: req.user,
    });
    success(res, result, 'Roster weather signal saved', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Save roster weather signal failed:', err);
    error(res, err.message || 'Failed to save weather signal', statusFromError(err));
  }
}
