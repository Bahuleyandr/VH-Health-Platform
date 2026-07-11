// src/routes/clinical/icuRoutes.js — Sprint 19

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as icu from '../../services/clinical/icuService.js';
import * as icuChart from '../../services/clinical/icuChartingService.js';
import * as nicuChart from '../../services/clinical/nicuPicuChartingService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { emitIcuBoardEvent } from '../../utils/websocket/realtimeEmitter.js';

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
      // AppError-shaped errors are intentionally surfaced (badRequest /
      // notFound / forbidden carry safe, caller-targeted messages).
      // Anything else is logged server-side and returned as a generic
      // 500 — raw `err.message` from Prisma / pg leaks SQL fragments,
      // bind-parameter shapes, and schema details. Security checklist.
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('icu route error:', err);
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

// Admissions
router.post(
  '/admissions',
  requireStaffOrAdmin,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.createAdmission({ tenantId, ...req.body });
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.createAdmissionFromEr({
      ...req.body,
      tenantId,
      emergencyVisitId: req.params.emergencyVisitId
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
  wrap(async req => icu.getAdmission({ tenantId: tenantOf(req), id: req.params.id }))
);

router.patch(
  '/admissions/:id/code-status',
  requireStaffOrAdmin,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.updateAdmissionCodeStatus({
      tenantId,
      id: req.params.id,
      code_status: req.body.code_status,
      set_by: req.user?.uid
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.dischargeAdmission({
      tenantId,
      id: req.params.id,
      disposition: req.body.disposition,
      outcome_notes: req.body.outcome_notes,
      actorUid: req.user?.uid
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
      tenantId: tenantOf(req),
      actorUid: req.user?.uid,
      ...req.body
    })
  )
);

router.get(
  '/admissions/:id/chart',
  requireStaffOrAdmin,
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.createVentilationEpisode({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
    });
    emitIcuBoardEvent('ventilation', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.patch(
  '/ventilation/:episodeId/stop',
  requireStaffOrAdmin,
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.recordWeaningTrial({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
    });
    emitIcuBoardEvent('weaning-trial', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/lines',
  requireStaffOrAdmin,
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.startLinePresence({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
    });
    emitIcuBoardEvent('line-presence', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.patch(
  '/lines/:lineEventId/stop',
  requireStaffOrAdmin,
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.recordScoringOutput({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
    });
    emitIcuBoardEvent('scoring-output', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.post(
  '/admissions/:id/device-observation-links',
  requireStaffOrAdmin,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icuChart.linkDeviceObservation({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
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
  requireStaffOrAdmin,
  wrap(async req =>
    nicuChart.setNicuChartSettings({
      tenantId: tenantOf(req),
      actorUid: req.user?.uid,
      ...req.body
    })
  )
);

router.get(
  '/admissions/:id/nicu-chart',
  requireStaffOrAdmin,
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordFeedFluidEntry({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
    });
    emitIcuBoardEvent('nicu-feed-fluid', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/feed-fluid/balance',
  requireStaffOrAdmin,
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordRespiratorySupportObservation({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordCardiorespiratoryEvent({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
    });
    emitIcuBoardEvent('nicu-cardioresp-event', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/jaundice-phototherapy',
  requireStaffOrAdmin,
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordJaundicePhototherapyEvent({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordThermalObservation({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
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
  requireStaffOrAdmin,
  wrap(async req =>
    nicuChart.upsertScoreDefinition({
      tenantId: tenantOf(req),
      actorUid: req.user?.uid,
      ...req.body
    })
  )
);

router.get(
  '/admissions/:id/nicu-scores',
  requireStaffOrAdmin,
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await nicuChart.recordScoreOutput({
      tenantId,
      icuAdmissionId: req.params.id,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      ...req.body
    });
    emitIcuBoardEvent('nicu-score-output', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/growth-snapshot',
  requireStaffOrAdmin,
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.logFlowsheet({
      tenantId,
      icu_admission_id: req.params.id,
      recorded_by: req.user?.uid,
      ...req.body
    });
    emitIcuBoardEvent('flowsheet', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/flowsheet',
  requireStaffOrAdmin,
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
  wrap(async req => icu.ioSummary({ tenantId: tenantOf(req), icu_admission_id: req.params.id }))
);

// Assessments
router.post(
  '/admissions/:id/assessments',
  requireStaffOrAdmin,
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.recordAssessment({
      tenantId,
      icu_admission_id: req.params.id,
      recorded_by: req.user?.uid,
      ...req.body
    });
    emitIcuBoardEvent('assessment', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/assessments',
  requireStaffOrAdmin,
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
  wrap(async req => {
    const tenantId = tenantOf(req);
    const row = await icu.upsertBundle({
      tenantId,
      icu_admission_id: req.params.id,
      recorded_by: req.user?.uid,
      ...req.body
    });
    emitIcuBoardEvent('bundle', { admissionId: Number(req.params.id), tenantId });
    return row;
  })
);

router.get(
  '/admissions/:id/bundle',
  requireStaffOrAdmin,
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
