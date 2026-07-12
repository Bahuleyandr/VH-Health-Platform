// NL13-P1f — cath dose-audit rollups + complication registry, mounted at
// /api/v1/quality/cath (app.js) so the admin portal reaches it through the
// EXISTING api/v1/quality proxy family — no new allowlist/routePolicy entry.
// Rollups are read-only derivations; thresholds are owner-configured and the
// rollup fails closed to thresholds_pending when unset.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  getDoseAlertSettings,
  getDoseRollup,
  listRegistry,
  setDoseAlertSettings,
  updateRegistryReview
} from '../../services/clinical/cathSchedulingRegistryService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { ROLES, isAdmin, isLeadership } from '../../utils/roleHelpers.js';

const router = express.Router();

const canViewCathQuality = role => isAdmin(role) || isLeadership(role)
  || role === ROLES.QUALITY_OFFICER || role === ROLES.INFECTION_CONTROL_OFFICER
  || role === ROLES.CATH_LAB_INCHARGE || role === 'SUPER_ADMIN';

const canConfigureCathQuality = role => isAdmin(role) || isLeadership(role)
  || role === ROLES.QUALITY_OFFICER || role === 'SUPER_ADMIN';

function gate(req, res, predicate = canViewCathQuality) {
  const roles = [
    req.user?.rawRole,
    req.user?.role,
    ...(Array.isArray(req.user?.roles) ? req.user.roles : [])
  ];
  if (!roles.some(role => predicate(role))) {
    error(res, 'Cath quality views are limited to quality/leadership roles', HTTP_STATUS.FORBIDDEN);
    return false;
  }
  return true;
}

function contextOf(req) {
  return {
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || req.user?.rawRole || null,
    requestId: req.id || null
  };
}

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Cath quality ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

router.get('/dose-rollup', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const rollup = await getDoseRollup({
      tenantId: resolveTenantOrThrow(req),
      from: req.query.from,
      to: req.query.to,
      groupBy: req.query.group_by || req.query.groupBy || 'month'
    });
    return success(res, rollup, 'Cath dose rollup');
  } catch (err) {
    return handleFailure(res, err, 'compute dose rollup');
  }
});

router.get('/dose-settings', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const settings = await getDoseAlertSettings(resolveTenantOrThrow(req));
    return success(res, settings, 'Cath dose alert settings');
  } catch (err) {
    return handleFailure(res, err, 'load dose alert settings');
  }
});

router.put('/dose-settings', async (req, res) => {
  try {
    if (!gate(req, res, canConfigureCathQuality)) return undefined;
    const settings = await setDoseAlertSettings(
      resolveTenantOrThrow(req),
      req.body || {},
      contextOf(req)
    );
    return success(res, { settings }, 'Cath dose alert settings updated');
  } catch (err) {
    return handleFailure(res, err, 'update dose alert settings');
  }
});

router.get('/complication-registry', async (req, res) => {
  try {
    if (!gate(req, res)) return undefined;
    const entries = await listRegistry({
      tenantId: resolveTenantOrThrow(req),
      from: req.query.from || null,
      to: req.query.to || null,
      reviewStatus: req.query.review_status || req.query.reviewStatus || null,
      severity: req.query.severity || null,
      category: req.query.category || null,
      limit: req.query.limit || 100
    });
    return success(res, { entries, count: entries.length }, 'Cath complication registry');
  } catch (err) {
    return handleFailure(res, err, 'list complication registry');
  }
});

router.post('/complication-registry/:id/review', async (req, res) => {
  try {
    if (!gate(req, res, canConfigureCathQuality)) return undefined;
    const entry = await updateRegistryReview(
      req.params.id,
      { tenantId: resolveTenantOrThrow(req), ...req.body },
      contextOf(req)
    );
    return success(res, { entry }, 'Cath complication review updated');
  } catch (err) {
    return handleFailure(res, err, 'update complication review');
  }
});

export default router;
