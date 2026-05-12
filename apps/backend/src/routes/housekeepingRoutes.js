// src/routes/housekeepingRoutes.js
//
// Top-level /api/v1/housekeeping/* surface. The controller has lived in
// src/controllers/staff/housekeepingController.js for a while and is
// mounted under /api/v1/staff/admin/housekeeping/* and
// /api/v1/staff/hr/housekeeping/* via the staffAdminRoutes / hrRoutes
// modules. The DB schema (housekeeping_requests, housekeeping_logs,
// housekeeping_zones, housekeeping_request_updates) is fully defined,
// but the canonical /api/v1/housekeeping/* path expected by the staff
// app, admin portal, and external integrations 404s. This module wires
// the canonical surface to the existing controller. Finding:
// 2026-05-09-inpatient-admission-housekeeping-api-routes-absent.
import express from 'express';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import * as housekeepingController from '../controllers/staff/housekeepingController.js';

const router = express.Router();

// Staff-facing reads + writes: any clinical or operational staff can
// raise/complete requests and view zones. Admin verification + zone
// administration is gated separately below.
wrapAutoRBAC(router, 'housekeepingRoutes', {
  get: [
    ['/zones', housekeepingController.getZones],
    ['/logs/my', housekeepingController.getMyCleaningLogs],
    ['/requests/my', housekeepingController.getMyRequests],
    ['/requests/:id', housekeepingController.getRequestDetail],
  ],
  post: [
    ['/logs', housekeepingController.submitCleaningLog],
    ['/requests', housekeepingController.raiseRequest],
    ['/requests/:id/complete', housekeepingController.completeRequest],
  ],
});

// Admin-facing list + verify + zone admin + emergency requests.
wrapAutoRBAC(router, 'housekeepingAdminRoutes', {
  get: [
    ['/logs', housekeepingController.getAllCleaningLogs],
    ['/requests', housekeepingController.getAllRequests],
    ['/stats', housekeepingController.getHousekeepingStats],
  ],
  post: [
    ['/zones', housekeepingController.createZone],
    ['/requests/create', housekeepingController.adminCreateRequest],
    ['/requests/:id/assign', housekeepingController.assignRequest],
    ['/requests/:id/verify', housekeepingController.verifyRequest],
    ['/logs/:id/verify', housekeepingController.verifyLog],
  ],
  put: [
    ['/zones/:id', housekeepingController.updateZone],
  ],
});

export default router;
