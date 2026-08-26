// src/routes/clinical/icuRoutes.js — Sprint 19

import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import * as icu from '../../services/clinical/icuService.js';
import * as icuChart from '../../services/clinical/icuChartingService.js';
import * as nicuChart from '../../services/clinical/nicuPicuChartingService.js';
import { VERIFIABLE_RESOURCES } from '../../services/clinical/nicuPicuChartingService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff, isLeadership } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { emitIcuBoardEvent } from '../../utils/websocket/realtimeEmitter.js';
import {
  positiveBigIntTextOrNull,
  positiveIntOrNull,
  routePatientGuard,
  selectorTenantOf,
} from '../../middleware/routePatientAccessGuards.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

// ── Re-audit M: per-route patient access guards ──────────────────────
// The /api/v1/icu mount used to wrap this router in patientAccessGuard('ICU'),
// which ran before Express matched a route, saw an empty req.params, and
// returned no_patient_context without ever evaluating a policy. The guard now
// lives on each single-patient route with a selector that resolves the exact
// row the handler serves. This is a bedside surface: every selector is one
// indexed lookup (pk + tenant predicate) and never throws on malformed input
// (bad ids resolve to null, which the guard refuses cleanly).
//
// Deliberately NOT guarded (no single patient subject — role gate only):
// GET /admissions (unit census), GET+PUT /chart-settings,
// GET+PUT /nicu-chart-settings, GET+PUT /nicu-score-definitions (tenant-level
// governance), GET /bundle-compliance (30-day aggregate).

// The ICU admission row every /admissions/:id* handler loads.
export async function selectIcuAdmissionPatient(req, rawAdmissionId) {
  const tenantId = selectorTenantOf(req);
  const admissionId = positiveIntOrNull(rawAdmissionId);
  if (tenantId == null || admissionId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM icu_admissions
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantId,
    admissionId,
  );
  return rows[0] ?? null;
}

// POST /admissions/from-er/:emergencyVisitId admits the ER visit's patient —
// createAdmissionFromEr takes patient_uid from the visit row, never the body.
export async function selectErVisitPatient(req, rawVisitId) {
  const tenantId = selectorTenantOf(req);
  const visitId = positiveIntOrNull(rawVisitId);
  if (tenantId == null || visitId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM emergency_visits
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantId,
    visitId,
  );
  return rows[0] ?? null;
}

// PATCH /ventilation/:episodeId/stop — the episode's admission owns the
// patient; resolve through the join the service's own emit relies on.
export async function selectVentilationEpisodePatient(req, rawEpisodeId) {
  const tenantId = selectorTenantOf(req);
  const episodeId = positiveBigIntTextOrNull(rawEpisodeId);
  if (tenantId == null || episodeId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.patient_uid AS uid
       FROM icu_ventilation_episodes e
       JOIN icu_admissions a
         ON a.id = e.icu_admission_id
        AND a.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1::uuid AND e.id = $2::bigint
      LIMIT 1`,
    tenantId,
    episodeId,
  );
  return rows[0] ?? null;
}

// PATCH /lines/:lineEventId/stop — same shape over the line/tube/drain event.
export async function selectLineEventPatient(req, rawLineEventId) {
  const tenantId = selectorTenantOf(req);
  const lineEventId = positiveBigIntTextOrNull(rawLineEventId);
  if (tenantId == null || lineEventId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.patient_uid AS uid
       FROM icu_line_tube_drain_events e
       JOIN icu_admissions a
         ON a.id = e.icu_admission_id
        AND a.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1::uuid AND e.id = $2::bigint
      LIMIT 1`,
    tenantId,
    lineEventId,
  );
  return rows[0] ?? null;
}

// PATCH /nicu/:resource/:id/verify — the resource key maps to a physical
// table via the service's own allowlist (imported, so it cannot drift); an
// unknown resource resolves to null and is refused before the service's 400.
export async function selectNicuObservationPatient(req, rawResource, rawId) {
  const resourceKey = String(rawResource ?? '');
  // Own-key check: bare brackets resolve prototype keys ('constructor',
  // '__proto__') to functions that would interpolate into FROM and 500.
  const table = Object.hasOwn(VERIFIABLE_RESOURCES, resourceKey)
    ? VERIFIABLE_RESOURCES[resourceKey]
    : undefined;
  const tenantId = selectorTenantOf(req);
  const rowId = positiveBigIntTextOrNull(rawId);
  if (!table || tenantId == null || rowId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.patient_uid AS uid
       FROM ${table} t
       JOIN icu_admissions a
         ON a.id = t.icu_admission_id
        AND a.tenant_id = t.tenant_id
      WHERE t.tenant_id = $1::uuid AND t.id = $2::bigint
      LIMIT 1`,
    tenantId,
    rowId,
  );
  return rows[0] ?? null;
}

const guardIcuAdmissionParam = routePatientGuard('ICU', {
  tag: 'icu:admission-param',
  patientSelector: (req) => selectIcuAdmissionPatient(req, req.params?.id),
});
const guardIcuAdmissionCreate = routePatientGuard('ICU', {
  tag: 'icu:body-patient-uid',
  patientSelector: (req) => ({ uid: req.body?.patient_uid }),
});
const guardIcuErVisitParam = routePatientGuard('ICU', {
  tag: 'icu:er-visit-param',
  patientSelector: (req) => selectErVisitPatient(req, req.params?.emergencyVisitId),
});
const guardIcuVentilationEpisode = routePatientGuard('ICU', {
  tag: 'icu:ventilation-episode-param',
  patientSelector: (req) => selectVentilationEpisodePatient(req, req.params?.episodeId),
});
const guardIcuLineEvent = routePatientGuard('ICU', {
  tag: 'icu:line-event-param',
  patientSelector: (req) => selectLineEventPatient(req, req.params?.lineEventId),
});
const guardIcuNicuVerify = routePatientGuard('ICU', {
  tag: 'icu:nicu-verify-param',
  patientSelector: (req) => selectNicuObservationPatient(req, req.params?.resource, req.params?.id),
});

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'An internal server error occurred. Please try again later.');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Sol Ultra Wave-E (NICU): enabling the tenant-wide NICU/PICU feature, replacing
// its scoring governance, or activating a decision-support score definition is a
// clinical-GOVERNANCE action — not something any bedside ICU role should do.
// Gate those writes to clinical leadership / admin (reads stay staff-level).
function requireGovernanceAuthority(req, res, next) {
  if (!isLeadership(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Clinical leadership or admin authority required', 403);
  }
  next();
}

// Admissions
router.post(
  '/admissions',
  requireStaffOrAdmin,
  guardIcuAdmissionCreate,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.createAdmission({
      ...req.body,
      tenantId,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('admitted', { admissionId: row?.id, status: row?.status, tenantId });
    return row;
  })
);

// Admit a patient to ICU directly from an emergency visit — the new
// admission inherits the ER patient context, links back via er_visit_id,
// and carries the ER's active medication orders into the ICU MAR.
// Findings:
//   2026-05-08-emergency-walk-in-doctor-er-to-icu-no-continuation
//   2026-05-08-emergency-walk-in-nurse-no-fasting-no-io-no-mar-handoff
router.post(
  '/admissions/from-er/:emergencyVisitId',
  requireStaffOrAdmin,
  guardIcuErVisitParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.createAdmissionFromEr({
      ...req.body,
      tenantId,
      emergencyVisitId: req.params.emergencyVisitId,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('admitted', { admissionId: row?.id, status: row?.status, tenantId });
    return row;
  })
);

router.get(
  '/admissions',
  requireStaffOrAdmin,
  wrap(async req =>
    icu.listAdmissions({
      tenantId: tenantOf(req),
      status: req.query.status,
      unit_code: req.query.unit_code,
      limit: req.query.limit
    })
  )
);

router.get(
  '/admissions/:id',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => icu.getAdmission({ tenantId: tenantOf(req), id: req.params.id }))
);

router.patch(
  '/admissions/:id/code-status',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.updateAdmissionCodeStatus({
      tenantId,
      id: req.params.id,
      code_status: req.body.code_status,
      set_by: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('code-status', {
      admissionId: Number(req.params.id),
      status: req.body.code_status,
      tenantId
    });
    return row;
  })
);

router.patch(
  '/admissions/:id/monitoring-interval',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    icu.updateMonitoringInterval({
      tenantId: tenantOf(req),
      id: req.params.id,
      monitoring_interval_minutes: req.body.monitoring_interval_minutes
    })
  )
);

// Update the pre-op / fasting window on a live ICU admission. NPO orders
// are placed after admit, so the npo_from / fasting_until / pre_op_status
// fields need a mutation path — without one they were dead columns.
// An omitted body key leaves its column untouched; an explicit null
// clears it. Finding:
// 2026-05-09-emergency-walk-in-nurse-icu-no-npo-patch-route.
router.patch(
  '/admissions/:id',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    icu.updateAdmissionFasting({
      tenantId: tenantOf(req),
      id: req.params.id,
      npo_from: req.body.npo_from,
      fasting_until: req.body.fasting_until,
      pre_op_status: req.body.pre_op_status
    })
  )
);

router.post(
  '/admissions/:id/discharge',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.dischargeAdmission({
      tenantId,
      id: req.params.id,
      disposition: req.body.disposition,
      outcome_notes: req.body.outcome_notes,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('discharged', {
      admissionId: Number(req.params.id),
      status: row?.status,
      tenantId
    });
    return row;
  })
);

// ICU chart depth
router.get(
  '/chart-settings',
  requireStaffOrAdmin,
  wrap(async req => icuChart.getChartSettings({ tenantId: tenantOf(req) }))
);

router.put(
  '/chart-settings',
  requireStaffOrAdmin,
  wrap(async req =>
    icuChart.setChartSettings({
      ...req.body,
      tenantId: tenantOf(req),
      actorUid: req.user?.uid
    })
  )
);

router.get(
  '/admissions/:id/chart',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    icuChart.getIcuChartView({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      hours: req.query.hours,
      at: req.query.at
    })
  )
);

router.get(
  '/admissions/:id/ventilation',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    icuChart.listVentilationEpisodes({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id
    })
  )
);

router.post(
  '/admissions/:id/ventilation',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.createVentilationEpisode({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('ventilation', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.patch(
  '/ventilation/:episodeId/stop',
  requireStaffOrAdmin,
  guardIcuVentilationEpisode,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.stopVentilationEpisode({
      tenantId,
      episodeId: req.params.episodeId,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      stopped_at: req.body.stopped_at,
      stop_reason: req.body.stop_reason
    });
    emitIcuBoardEvent('ventilation', { admissionId: Number(row?.icu_admission_id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/weaning-trials',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    icuChart.listWeaningTrials({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id
    })
  )
);

router.post(
  '/admissions/:id/weaning-trials',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.recordWeaningTrial({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('weaning-trial', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/lines',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    icuChart.listLinePresence({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      activeOnly: req.query.active === 'true'
    })
  )
);

router.post(
  '/admissions/:id/lines',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.startLinePresence({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('line-presence', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.patch(
  '/lines/:lineEventId/stop',
  requireStaffOrAdmin,
  guardIcuLineEvent,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.stopLinePresence({
      tenantId,
      lineEventId: req.params.lineEventId,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      stopped_at: req.body.stopped_at,
      stop_reason: req.body.stop_reason
    });
    emitIcuBoardEvent('line-presence', { admissionId: Number(row?.icu_admission_id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/scoring-outputs',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    icuChart.listScoringOutputs({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      scoringKind: req.query.scoring_kind
    })
  )
);

router.post(
  '/admissions/:id/scoring-outputs',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.recordScoringOutput({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('scoring-output', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.post(
  '/admissions/:id/device-observation-links',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.linkDeviceObservation({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('device-observation-link', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

// ── NL-14 P3: NICU/PICU specialty views over the ICU chart substrate ──

router.get(
  '/nicu-chart-settings',
  requireStaffOrAdmin,
  wrap(async req => nicuChart.getNicuChartSettings({ tenantId: tenantOf(req) }))
);

router.put(
  '/nicu-chart-settings',
  requireGovernanceAuthority,
  wrap(async req =>
    nicuChart.setNicuChartSettings({
      ...req.body,
      tenantId: tenantOf(req),
      actorUid: req.user?.uid
    })
  )
);

router.get(
  '/admissions/:id/nicu-chart',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    nicuChart.getNicuPicuChartView({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      hours: req.query.hours,
      at: req.query.at
    })
  )
);

router.get(
  '/admissions/:id/feed-fluid',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    nicuChart.listFeedFluidEntries({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      kind: req.query.kind,
      hours: req.query.hours,
      at: req.query.at
    })
  )
);

router.post(
  '/admissions/:id/feed-fluid',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordFeedFluidEntry({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('nicu-feed-fluid', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/feed-fluid/balance',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    nicuChart.getFeedFluidBalance({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      hours: req.query.hours,
      at: req.query.at
    })
  )
);

router.get(
  '/admissions/:id/respiratory-support',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    nicuChart.listRespiratorySupportObservations({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      hours: req.query.hours,
      at: req.query.at
    })
  )
);

router.post(
  '/admissions/:id/respiratory-support',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordRespiratorySupportObservation({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('nicu-respiratory-support', {
      admissionId: Number(req.params.id),
      tenantId
    });
    return row;
  })
);

router.get(
  '/admissions/:id/cardioresp-events',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    nicuChart.listCardiorespiratoryEvents({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      hours: req.query.hours,
      at: req.query.at
    })
  )
);

router.post(
  '/admissions/:id/cardioresp-events',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordCardiorespiratoryEvent({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('nicu-cardioresp-event', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/jaundice-phototherapy',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    nicuChart.listJaundicePhototherapyEvents({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      hours: req.query.hours,
      at: req.query.at
    })
  )
);

router.post(
  '/admissions/:id/jaundice-phototherapy',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordJaundicePhototherapyEvent({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('nicu-jaundice-phototherapy', {
      admissionId: Number(req.params.id),
      tenantId
    });
    return row;
  })
);

router.get(
  '/admissions/:id/thermal-observations',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    nicuChart.listThermalObservations({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      hours: req.query.hours,
      at: req.query.at
    })
  )
);

router.post(
  '/admissions/:id/thermal-observations',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordThermalObservation({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('nicu-thermal-observation', {
      admissionId: Number(req.params.id),
      tenantId
    });
    return row;
  })
);

// Clinician review of device-sourced NICU rows (unverified → verified).
router.patch(
  '/nicu/:resource/:id/verify',
  requireStaffOrAdmin,
  guardIcuNicuVerify,
  wrap(async req =>
    nicuChart.verifyNicuObservation({
      tenantId: tenantOf(req),
      resource: req.params.resource,
      id: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    })
  )
);

router.get(
  '/admissions/:id/newborn-context',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    nicuChart.getNewbornContext({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id
    })
  )
);

router.post(
  '/admissions/:id/newborn-link',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.linkNewbornToAdmission({
      tenantId,
      icuAdmissionId: req.params.id,
      newbornId: req.body.newborn_id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      metadata: req.body.metadata
    });
    emitIcuBoardEvent('nicu-newborn-link', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/nicu-score-definitions',
  requireStaffOrAdmin,
  wrap(async req =>
    nicuChart.listScoreDefinitions({
      tenantId: tenantOf(req),
      includeInactive: req.query.include_inactive === 'true'
    })
  )
);

router.put(
  '/nicu-score-definitions',
  requireGovernanceAuthority,
  wrap(async req =>
    nicuChart.upsertScoreDefinition({
      ...req.body,
      tenantId: tenantOf(req),
      actorUid: req.user?.uid
    })
  )
);

router.get(
  '/admissions/:id/nicu-scores',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    nicuChart.listScoreOutputs({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id,
      scoreKind: req.query.score_kind
    })
  )
);

router.post(
  '/admissions/:id/nicu-scores',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordScoreOutput({
      ...req.body,
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role
    });
    emitIcuBoardEvent('nicu-score-output', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/growth-snapshot',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    nicuChart.getGrowthSnapshot({
      tenantId: tenantOf(req),
      icuAdmissionId: req.params.id
    })
  )
);

// Flowsheet
router.post(
  '/admissions/:id/flowsheet',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.logFlowsheet({
      ...req.body,
      tenantId,
      icu_admission_id: req.params.id,
      recorded_by: req.user?.uid
    });
    emitIcuBoardEvent('flowsheet', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/flowsheet',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    icu.listFlowsheet({
      tenantId: tenantOf(req),
      icu_admission_id: req.params.id,
      hours: req.query.hours
    })
  )
);

router.get(
  '/admissions/:id/io-summary',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => icu.ioSummary({ tenantId: tenantOf(req), icu_admission_id: req.params.id }))
);

// Assessments
router.post(
  '/admissions/:id/assessments',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.recordAssessment({
      ...req.body,
      tenantId,
      icu_admission_id: req.params.id,
      recorded_by: req.user?.uid
    });
    emitIcuBoardEvent('assessment', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/assessments',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    icu.listAssessments({
      tenantId: tenantOf(req),
      icu_admission_id: req.params.id,
      kind: req.query.kind,
      limit: req.query.limit
    })
  )
);

// ABCDEF Bundle
router.post(
  '/admissions/:id/bundle',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.upsertBundle({
      ...req.body,
      tenantId,
      icu_admission_id: req.params.id,
      recorded_by: req.user?.uid
    });
    emitIcuBoardEvent('bundle', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/bundle',
  requireStaffOrAdmin,
  guardIcuAdmissionParam,
  wrap(async req =>
    icu.getBundle({
      tenantId: tenantOf(req),
      icu_admission_id: req.params.id,
      bundle_date: req.query.bundle_date
    })
  )
);

router.get(
  '/bundle-compliance',
  requireStaffOrAdmin,
  wrap(async req => icu.bundle30dCompliance({ tenantId: tenantOf(req) }))
);

export default router;
