// src/routes/clinical/resuscitationRoutes.js
//
// NL-14 P2 — durable code-blue / resuscitation documentation surface.
//
// The durable resuscitation_events row is the source of truth; the
// staff:code-blue WS channel stays notification-only (emitted post-commit by
// the service, at-most-once). GET /events/recent is the dashboard reconnect
// hydration path — persisted events WITH ward/bed/reason context, replacing
// reliance on the live-only banner
// (2026-06-29-realtime-dashboards-clinical-alerts-design.md:25, :186).
//
// Cross-patient operational emergency board — no patientAccessGuard, matching
// the clinical-alerts sibling mount. Reads work with the feature flag off
// (they simply return no rows); every write is fail-closed behind the
// per-tenant resuscitation_settings.enabled flag inside the service.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as resus from '../../services/clinical/resuscitationEventService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      // AppError-shaped errors carry safe caller-targeted messages; anything
      // else is logged server-side and returned generic (no err.message leak).
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('resuscitation route error:', err);
      return error(res, 'An internal server error occurred. Please try again later.', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) {
    return error(res, 'Admin role required', 403);
  }
  next();
}

// Per-tenant flag surface (operator-gated; enabling requires acceptance evidence)
router.get('/settings', requireStaffOrAdmin, wrap(async req =>
  resus.getResuscitationSettings({ tenantId: tenantOf(req) })));

router.put('/settings', requireAdmin, wrap(async req =>
  resus.setResuscitationSettings({
    tenantId: tenantOf(req),
    enabled: req.body.enabled,
    charting_policy: req.body.charting_policy,
    trigger_policy: req.body.trigger_policy,
    policy_source: req.body.policy_source,
    acceptance_snapshot: req.body.acceptance_snapshot,
    actorUid: req.user?.uid
  })));

// Explicit code-blue / rapid-response trigger: creates the DURABLE event and
// (post-commit, best-effort) the realtime notification.
router.post('/events', requireStaffOrAdmin, wrap(async (req, res) => {
  const row = await resus.createResuscitationEvent({
    ...req.body,
    tenantId: tenantOf(req),
    actorUid: req.user?.uid,
    actorRole: req.user?.role
  });
  return success(res, row, 'Resuscitation event created', 201);
}));

// Dashboard reconnect hydration: persisted code-blue history with
// ward/bed/reason context (NOT the live-only banner).
router.get('/events/recent', requireStaffOrAdmin, wrap(async req =>
  resus.listResuscitationEvents({
    tenantId: tenantOf(req),
    patientUid: req.query.patient_uid || null,
    status: req.query.status || null,
    hours: req.query.hours,
    limit: req.query.limit
  })));

router.get('/events/:id', requireStaffOrAdmin, wrap(async req =>
  resus.getResuscitationEvent({ tenantId: tenantOf(req), eventId: req.params.id })));

// Append-only timeline (immutable rows; corrections are new entries)
router.post('/events/:id/timeline', requireStaffOrAdmin, wrap(async (req, res) => {
  const row = await resus.appendTimelineEntry({
    ...req.body,
    tenantId: tenantOf(req),
    eventId: req.params.id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role
  });
  return success(res, row, 'Timeline entry appended', 201);
}));

// Team roles + signature capture
router.post('/events/:id/roles', requireStaffOrAdmin, wrap(async req =>
  resus.upsertTeamRole({
    ...req.body,
    tenantId: tenantOf(req),
    eventId: req.params.id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role
  })));

router.post('/events/:id/end', requireStaffOrAdmin, wrap(async req =>
  resus.endResuscitationEvent({
    tenantId: tenantOf(req),
    eventId: req.params.id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    ended_at: req.body.ended_at,
    outcome: req.body.outcome,
    outcome_note: req.body.outcome_note
  })));

router.post('/events/:id/finalize', requireStaffOrAdmin, wrap(async req =>
  resus.finalizeResuscitationEvent({
    tenantId: tenantOf(req),
    eventId: req.params.id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role
  })));

// Misfire reconciliation (code-blue-misfire runbook): audited status-cancel,
// never a delete.
router.post('/events/:id/cancel-misfire', requireStaffOrAdmin, wrap(async req =>
  resus.cancelMisfire({
    tenantId: tenantOf(req),
    eventId: req.params.id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    reason: req.body.reason
  })));

// Post-event QA / debrief (fail-closed until governance supplies a template)
router.put('/events/:id/qa-review', requireStaffOrAdmin, wrap(async req =>
  resus.upsertQaReview({
    ...req.body,
    tenantId: tenantOf(req),
    eventId: req.params.id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role
  })));

export default router;
