/**
 * Ambulance live GPS tracking routes (migration 683). Mounted at
 * /api/v1/ambulance with AMBULANCE_TRACKING_ROUTE_ROLES — the ED clinical
 * roster plus DRIVER / EMERGENCY_RESPONDER, because the crew posting fixes
 * from the staff app is not an ED clinical role. Config-gated per tenant
 * (tenants.settings.ambulanceGpsTracking): ingest 403s with
 * AMBULANCE_GPS_TRACKING_DISABLED while reads return an explicit
 * { enabled: false } marker the UI can render.
 */

import express from 'express';

import { markRouterDomain } from '../../config/openapiDomain.js';
import { success } from '../../utils/responseHelper.js';
import {
  getAmbulanceTracking,
  listActiveAmbulanceTracking,
  recordAmbulancePosition,
} from '../../services/ed/ambulanceTrackingService.js';

const router = markRouterDomain(express.Router(), 'ambulance');

// Crew/driver position ingest — the reporter is ALWAYS the authenticated
// actor, never a body value.
router.post('/requests/:id/positions', async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await recordAmbulancePosition({
      tenantId: req.tenantId,
      ambulanceRequestId: req.params.id,
      latitude: b.latitude,
      longitude: b.longitude,
      speedKmh: b.speed_kmh,
      headingDeg: b.heading_deg,
      accuracyM: b.accuracy_m,
      recordedAt: b.recorded_at,
      reportedByUid: req.user?.uid || null,
    });
    return success(res, result, 'Ambulance position recorded', 201);
  } catch (err) { return next(err); }
});

// ED live view: latest fix + recent trail + prehospital ETA passthrough.
router.get('/requests/:id/tracking', async (req, res, next) => {
  try {
    const result = await getAmbulanceTracking({
      tenantId: req.tenantId,
      ambulanceRequestId: req.params.id,
      trailLimit: req.query.trail_limit,
    });
    return success(res, result, 'Ambulance tracking retrieved');
  } catch (err) { return next(err); }
});

// ED board: all actively-transporting requests with their latest fix.
router.get('/tracking/active', async (req, res, next) => {
  try {
    const result = await listActiveAmbulanceTracking({
      tenantId: req.tenantId,
      limit: req.query.limit,
    });
    return success(res, result, 'Active ambulance tracking retrieved');
  } catch (err) { return next(err); }
});

export default router;
