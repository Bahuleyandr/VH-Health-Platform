// src/routes/dashboards/misReportScheduleRoutes.js
//
// Admin CRUD for scheduled MIS report email delivery (migration 679).
// Mounted from dashboardsRoutes at /api/v1/dashboards/mis-report-schedules, so
// it inherits the mount's network-tier controls (requireRole(ADMIN_ROUTE_ROLES),
// adminIpAllowlist, adminRateLimiter) plus the dashboards router's admin gate.

import { Router } from 'express';

import {
  createMisReportSchedule,
  deleteMisReportSchedule,
  listMisReportCatalog,
  listMisReportSchedules,
  runMisReportScheduleNow,
  updateMisReportSchedule,
} from '../../services/dashboards/misReportScheduleService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success } from '../../utils/responseHelper.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const schedules = await listMisReportSchedules(resolveTenantOrThrow(req));
    return success(res, {
      schedules,
      reports: listMisReportCatalog(),
      count: schedules.length,
    }, 'MIS report schedules retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const schedule = await createMisReportSchedule(resolveTenantOrThrow(req), req.body || {}, {
      actorUid: req.user?.uid || null,
    });
    return success(res, schedule, 'MIS report schedule created', 201);
  } catch (err) {
    return next(err);
  }
});

router.patch('/:scheduleId', async (req, res, next) => {
  try {
    const schedule = await updateMisReportSchedule(
      resolveTenantOrThrow(req),
      req.params.scheduleId,
      req.body || {},
      { actorUid: req.user?.uid || null },
    );
    return success(res, schedule, 'MIS report schedule updated');
  } catch (err) {
    return next(err);
  }
});

router.delete('/:scheduleId', async (req, res, next) => {
  try {
    const result = await deleteMisReportSchedule(resolveTenantOrThrow(req), req.params.scheduleId);
    return success(res, result, 'MIS report schedule deleted');
  } catch (err) {
    return next(err);
  }
});

router.post('/:scheduleId/run-now', async (req, res, next) => {
  try {
    const result = await runMisReportScheduleNow(resolveTenantOrThrow(req), req.params.scheduleId);
    return success(res, result, 'MIS report schedule run finished');
  } catch (err) {
    return next(err);
  }
});

export default router;
