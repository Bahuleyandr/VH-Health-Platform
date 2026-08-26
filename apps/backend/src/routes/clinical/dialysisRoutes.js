// src/routes/clinical/dialysisRoutes.js — Sprint 22 + roadmap D7 depth

import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import * as svc from '../../services/clinical/dialysisService.js';
import { ingestMachineObservations } from '../../services/clinical/dialysisMachineService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { isAdmin, isStaff, isDoctor } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { emitDialysisEvent } from '../../utils/websocket/realtimeEmitter.js';
import {
  positiveIntOrNull,
  routePatientGuard,
  selectorTenantOf,
} from '../../middleware/routePatientAccessGuards.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

// ── Re-audit M: per-route patient access guards ──────────────────────
// The /api/v1/dialysis mount used to wrap this router in
// patientAccessGuard('DIALYSIS'), which ran before Express matched a route,
// saw an empty req.params, and returned no_patient_context without ever
// evaluating a policy. The guard now lives on each single-patient route with
// a selector that resolves the exact roster/session/access row the handler
// serves. Bedside surface: each selector is one indexed lookup with an
// explicit tenant predicate (mirroring the service's own *_InTenant helpers)
// and never throws on malformed input.
//
// Deliberately NOT guarded (no single patient subject — role gate only):
// GET /patients (unit roster), GET /sessions (schedule list), GET /today
// (today board), POST+GET /machine-qa (machine QA logs), and
// POST /machines/ingest (device payload matched to a session by machine_no
// server-side — the request carries no patient identifier, and a guard here
// would break the device path the B3 inbox depends on).

// The roster row /patients/:id* handlers load (dialysis_patients.:id).
export async function selectDialysisRosterPatient(req, rawRosterId) {
  const tenantId = selectorTenantOf(req);
  const rosterId = positiveIntOrNull(rawRosterId);
  if (tenantId == null || rosterId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM dialysis_patients
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantId,
    rosterId,
  );
  return rows[0] ?? null;
}

// The session row /sessions/:id* handlers load — same join and tenant
// predicate as the service's getDialysisSessionInTenant.
export async function selectDialysisSessionPatient(req, rawSessionId) {
  const tenantId = selectorTenantOf(req);
  const sessionId = positiveIntOrNull(rawSessionId);
  if (tenantId == null || sessionId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.patient_uid AS uid
       FROM dialysis_sessions s
       JOIN dialysis_patients p
         ON p.id = s.dialysis_patient_id
        AND p.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1::uuid AND s.id = $2::int
      LIMIT 1`,
    tenantId,
    sessionId,
  );
  return rows[0] ?? null;
}

// The vascular-access row POST /access/:id/abandon serves — tenant-scoped
// through the roster join exactly like the service's getAccessInTenant.
export async function selectVascularAccessPatient(req, rawAccessId) {
  const tenantId = selectorTenantOf(req);
  const accessId = positiveIntOrNull(rawAccessId);
  if (tenantId == null || accessId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.patient_uid AS uid
       FROM vascular_access va
       JOIN dialysis_patients p
         ON p.id = va.dialysis_patient_id
      WHERE va.id = $2::int AND p.tenant_id = $1::uuid
      LIMIT 1`,
    tenantId,
    accessId,
  );
  return rows[0] ?? null;
}

const guardDialysisRosterParam = routePatientGuard('DIALYSIS', {
  tag: 'dialysis:roster-param',
  patientSelector: (req) => selectDialysisRosterPatient(req, req.params?.id),
});
// POST /patients enrols body.patient_uid — the same value enrolPatient
// persists; resolvePatientForAccess verifies it against the tenant's users.
const guardDialysisEnrolCreate = routePatientGuard('DIALYSIS', {
  tag: 'dialysis:body-patient-uid',
  patientSelector: (req) => ({ uid: req.body?.patient_uid }),
});
// POST /sessions schedules for body.dialysis_patient_id — resolve the roster
// row the service will load for it.
const guardDialysisSessionCreate = routePatientGuard('DIALYSIS', {
  tag: 'dialysis:body-roster-id',
  patientSelector: (req) => selectDialysisRosterPatient(req, req.body?.dialysis_patient_id),
});
const guardDialysisSessionParam = routePatientGuard('DIALYSIS', {
  tag: 'dialysis:session-param',
  patientSelector: (req) => selectDialysisSessionPatient(req, req.params?.id),
});
const guardDialysisAccessParam = routePatientGuard('DIALYSIS', {
  tag: 'dialysis:access-param',
  patientSelector: (req) => selectVascularAccessPatient(req, req.params?.id),
});

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Dialysis error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Patients
router.post('/patients', requireStaffOrAdmin, guardDialysisEnrolCreate, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.enrolPatient({ tenantId, ...req.body });
  emitDialysisEvent('patient-enrolled', { tenantId });
  return row;
}));

router.get('/patients', requireStaffOrAdmin, wrap(async (req) =>
  svc.listPatients({
    tenantId: tenantOf(req),
    status: req.query.status, limit: req.query.limit,
  })));

router.get('/patients/:id', requireStaffOrAdmin, guardDialysisRosterParam, wrap(async (req) =>
  svc.getPatient({ tenantId: tenantOf(req), id: req.params.id })));

router.patch('/patients/:id/dry-weight', requireStaffOrAdmin, guardDialysisRosterParam, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.updateDryWeight({
    tenantId, id: req.params.id,
    dry_weight_kg: req.body.dry_weight_kg,
  });
  emitDialysisEvent('dry-weight-updated', { tenantId });
  return row;
}));

// Prescriptions (roadmap D7) — the standing order sessions inherit from.
router.post('/patients/:id/prescription', requireStaffOrAdmin, guardDialysisRosterParam, wrap(async (req) => {
  if (!isDoctor(req.user?.role) && !isAdmin(req.user?.role)) {
    throw AppError.forbidden('Only doctors/admin prescribe dialysis');
  }
  const tenantId = tenantOf(req);
  const row = await svc.prescribe({
    ...req.body,
    tenantId, dialysis_patient_id: req.params.id,
    prescribed_by: req.user?.uid,
  });
  emitDialysisEvent('prescription-created', { tenantId });
  return row;
}));

router.get('/patients/:id/prescription', requireStaffOrAdmin, guardDialysisRosterParam, wrap(async (req) =>
  svc.getPrescriptions({ tenantId: tenantOf(req), dialysis_patient_id: req.params.id })));

// Vascular access
router.post('/patients/:id/access', requireStaffOrAdmin, guardDialysisRosterParam, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.addAccess({
    ...req.body,
    tenantId,
    dialysis_patient_id: req.params.id,
  });
  emitDialysisEvent('access-created', { tenantId });
  return row;
}));

router.post('/access/:id/abandon', requireStaffOrAdmin, guardDialysisAccessParam, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.abandonAccess({
    tenantId,
    id: req.params.id,
    reason: req.body.reason,
  });
  emitDialysisEvent('access-abandoned', { tenantId });
  return row;
}));

// Sessions
router.post('/sessions', requireStaffOrAdmin, guardDialysisSessionCreate, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.scheduleSession({
    ...req.body,
    tenantId, conducted_by: req.user?.uid,
  });
  emitDialysisEvent('session-scheduled', { tenantId });
  return row;
}));

router.get('/sessions', requireStaffOrAdmin, wrap(async (req) =>
  svc.listSessions({
    tenantId: tenantOf(req),
    date: req.query.date, status: req.query.status,
    dialysis_patient_id: req.query.dialysis_patient_id,
    limit: req.query.limit,
  })));

router.get('/today', requireStaffOrAdmin, wrap(async (req) =>
  svc.todayBoard({ tenantId: tenantOf(req) })));

router.post('/sessions/:id/start', requireStaffOrAdmin, guardDialysisSessionParam, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.startSession({
    ...req.body,
    tenantId, id: req.params.id,
  });
  emitDialysisEvent('session-started', { tenantId });
  return row;
}));

router.post('/sessions/:id/complete', requireStaffOrAdmin, guardDialysisSessionParam, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.completeSession({
    ...req.body,
    tenantId, id: req.params.id, completed_by: req.user?.uid, actorRole: req.user?.role,
  });
  emitDialysisEvent('session-completed', { tenantId });
  return row;
}));

router.post('/sessions/:id/reuse-register', requireStaffOrAdmin, guardDialysisSessionParam, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.recordReuseRegister({
    ...req.body,
    tenantId,
    session_id: req.params.id,
    processed_by: req.user?.uid,
  });
  emitDialysisEvent('reuse-register-updated', { tenantId });
  return row;
}));

router.get('/sessions/:id/reuse-register', requireStaffOrAdmin, guardDialysisSessionParam, wrap(async (req) =>
  svc.listReuseRegister({
    tenantId: tenantOf(req),
    session_id: req.params.id,
    limit: req.query.limit,
  })));

router.post('/sessions/:id/cancel', requireStaffOrAdmin, guardDialysisSessionParam, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.cancelSession({
    tenantId, id: req.params.id,
    reason: req.body.reason, mark_no_show: req.body.mark_no_show,
  });
  emitDialysisEvent('session-cancelled', { tenantId });
  return row;
}));

// Intra-dialysis observations
router.post('/sessions/:id/obs', requireStaffOrAdmin, guardDialysisSessionParam, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.logObservation({
    ...req.body,
    tenantId, session_id: req.params.id, recorded_by: req.user?.uid,
  });
  emitDialysisEvent('observation-logged', { tenantId });
  return row;
}));

router.get('/sessions/:id/obs', requireStaffOrAdmin, guardDialysisSessionParam, wrap(async (req) =>
  svc.listObservations({ tenantId: tenantOf(req), session_id: req.params.id })));

// Structured complications (roadmap D7)
router.post('/sessions/:id/events', requireStaffOrAdmin, guardDialysisSessionParam, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.recordSessionEvent({
    ...req.body,
    tenantId, session_id: req.params.id,
    recorded_by: req.user?.uid, actorRole: req.user?.role,
  });
  emitDialysisEvent('session-event-recorded', { tenantId });
  return row;
}));

router.get('/sessions/:id/events', requireStaffOrAdmin, guardDialysisSessionParam, wrap(async (req) =>
  svc.listSessionEvents({ tenantId: tenantOf(req), session_id: req.params.id })));

router.post('/machine-qa', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.recordMachineQaLog({
    ...req.body,
    tenantId,
    recorded_by: req.user?.uid,
  });
  emitDialysisEvent('machine-qa-recorded', { tenantId });
  return row;
}));

router.get('/machine-qa', requireStaffOrAdmin, wrap(async (req) =>
  svc.listMachineQaLogs({
    tenantId: tenantOf(req),
    machine_no: req.query.machine_no,
    session_id: req.query.session_id,
    limit: req.query.limit,
  })));

// Machine-data ingestion (roadmap D7) — raw payloads hit the B3 inbox
// first; observations land source='device' on the in-progress session
// matched by machine_no. Mirrors C5 /devices/vitals/ingest.
router.post('/machines/ingest', requireStaffOrAdmin, wrap(async (req, res) => {
  const result = await ingestMachineObservations({
    payload: req.body,
    machineCode: req.body.machine_no || req.query.machine_no || null,
    tenantId: tenantOf(req),
  }, { actorUid: req.user?.uid || null });
  return success(res, result, 'Dialysis machine observations ingested', 201);
}));

// Serology
router.post('/patients/:id/serology', requireStaffOrAdmin, guardDialysisRosterParam, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.recordSerology({
    ...req.body,
    tenantId, dialysis_patient_id: req.params.id, reported_by: req.user?.uid,
  });
  emitDialysisEvent('serology-recorded', { tenantId });
  return row;
}));

export default router;
