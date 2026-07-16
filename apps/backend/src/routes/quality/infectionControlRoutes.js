// src/routes/quality/infectionControlRoutes.js
//
// Mounted at /api/v1/infection-control behind the IC/quality role gate.

import express from 'express';
import {
  isolationBoard,
  listIsolationOrders,
  createIsolationOrder,
  updateIsolationChecklistItem,
  discontinueIsolationOrder,
  requestIsolationTerminalClean,
  traceContacts,
  antibiogram,
  logDevicePresence,
  stopDevicePresence,
  calculateHaiRates,
  createHaiCase,
  snapshotHaiRates,
  createOutbreakEpisode,
  listOutbreakEpisodes,
  linkOutbreakCase,
  suggestOutbreakClusters,
  outbreakEpiCurve,
  createHandHygieneAudit,
  listHandHygieneAudits,
} from '../../services/quality/infectionControlWorkbenchService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, relayAppError } from '../../utils/responseHelper.js';

const router = express.Router();

function actor(req) {
  return {
    actorUid: req.user?.uid || req.user?.user_uid || null,
    actorRole: req.user?.role || null,
  };
}

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

router.get('/isolation-board', async (req, res) => {
  try {
    const cases = await isolationBoard({
      ward: req.query.ward || null,
      tenantId: req.tenantId,
    });
    return success(res, { cases, count: cases.length }, 'Isolation board');
  } catch (err) {
    return handleFailure(res, err, 'build isolation board');
  }
});

router.get('/isolation-orders', async (req, res) => {
  try {
    const orders = await listIsolationOrders({
      status: req.query.status || 'active',
      patientUid: req.query.patient_uid || null,
      admissionId: req.query.admission_id || null,
      tenantId: req.tenantId,
    });
    return success(res, { orders, count: orders.length }, 'Isolation orders');
  } catch (err) {
    return handleFailure(res, err, 'list isolation orders');
  }
});

router.post('/isolation-orders', async (req, res) => {
  try {
    const order = await createIsolationOrder({
      ...req.body,
      ...actor(req),
      tenantId: req.tenantId,
    });
    return success(res, { order }, 'Isolation order created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create isolation order');
  }
});

router.patch('/isolation-orders/:id/checklist/:itemKey', async (req, res) => {
  try {
    const item = await updateIsolationChecklistItem({
      orderId: req.params.id,
      itemKey: req.params.itemKey,
      status: req.body?.status,
      notes: req.body?.notes,
      ...actor(req),
      tenantId: req.tenantId,
    });
    return success(res, { item }, 'Isolation checklist updated');
  } catch (err) {
    return handleFailure(res, err, 'update isolation checklist');
  }
});

router.post('/isolation-orders/:id/discontinue', async (req, res) => {
  try {
    const order = await discontinueIsolationOrder({
      orderId: req.params.id,
      ...actor(req),
      tenantId: req.tenantId,
    });
    return success(res, { order }, 'Isolation order discontinued');
  } catch (err) {
    return handleFailure(res, err, 'discontinue isolation order');
  }
});

router.post('/isolation-orders/:id/terminal-clean', async (req, res) => {
  try {
    const result = await requestIsolationTerminalClean({
      isolationOrderId: req.params.id,
      ...actor(req),
      tenantId: req.tenantId,
    });
    return success(res, result, 'Isolation terminal clean requested');
  } catch (err) {
    return handleFailure(res, err, 'request isolation terminal clean');
  }
});

router.get('/contacts', async (req, res) => {
  try {
    const contacts = await traceContacts({
      patientUid: req.query.patient_uid,
      from: req.query.from,
      to: req.query.to,
      tenantId: req.tenantId,
    });
    return success(res, { contacts, count: contacts.length }, 'Ward-overlap contacts');
  } catch (err) {
    return handleFailure(res, err, 'trace contacts');
  }
});

router.get('/antibiogram', async (req, res) => {
  try {
    const result = await antibiogram({
      from: req.query.from,
      to: req.query.to,
      minIsolates: req.query.min_isolates,
      tenantId: req.tenantId,
    });
    return success(res, result, 'Antibiogram');
  } catch (err) {
    return handleFailure(res, err, 'compute antibiogram');
  }
});

router.post('/device-presence', async (req, res) => {
  try {
    const device = await logDevicePresence({
      ...req.body,
      ...actor(req),
      tenantId: req.tenantId,
    });
    return success(res, { device }, 'Device presence logged', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'log device presence');
  }
});

router.post('/device-presence/:id/stop', async (req, res) => {
  try {
    const device = await stopDevicePresence({
      id: req.params.id,
      stoppedAt: req.body?.stopped_at || req.body?.stoppedAt,
      ...actor(req),
      tenantId: req.tenantId,
    });
    return success(res, { device }, 'Device presence stopped');
  } catch (err) {
    return handleFailure(res, err, 'stop device presence');
  }
});

router.get('/hai-rates', async (req, res) => {
  try {
    const result = await calculateHaiRates({
      from: req.query.from,
      to: req.query.to,
      tenantId: req.tenantId,
    });
    return success(res, result, 'HAI rates');
  } catch (err) {
    return handleFailure(res, err, 'compute HAI rates');
  }
});

router.post('/hai-cases', async (req, res) => {
  try {
    const haiCase = await createHaiCase({
      ...req.body,
      ...actor(req),
      tenantId: req.tenantId,
    });
    return success(res, { hai_case: haiCase }, 'HAI case recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record HAI case');
  }
});

router.post('/hai-rates/snapshot', async (req, res) => {
  try {
    const result = await snapshotHaiRates({
      from: req.body?.from,
      to: req.body?.to,
      computedBy: req.user?.uid || null,
      tenantId: req.tenantId,
    });
    return success(res, result, 'HAI rates snapshotted to NABH indicators');
  } catch (err) {
    return handleFailure(res, err, 'snapshot HAI rates');
  }
});

router.get('/outbreaks/cluster-suggestions', async (req, res) => {
  try {
    const result = await suggestOutbreakClusters({
      from: req.query.from,
      to: req.query.to,
      minCases: req.query.min_cases,
      tenantId: req.tenantId,
    });
    return success(
      res,
      { suggestions: result.clusters, count: result.clusters.length, period: result.period },
      'Outbreak cluster suggestions',
    );
  } catch (err) {
    return handleFailure(res, err, 'suggest outbreak clusters');
  }
});

router.get('/outbreaks/:id/epi-curve', async (req, res) => {
  try {
    const points = await outbreakEpiCurve({
      episodeId: req.params.id,
      tenantId: req.tenantId,
    });
    return success(res, { points, count: points.length }, 'Outbreak epi curve');
  } catch (err) {
    return handleFailure(res, err, 'build outbreak epi curve');
  }
});

router.get('/outbreaks', async (req, res) => {
  try {
    const outbreaks = await listOutbreakEpisodes({
      status: req.query.status || 'all',
      tenantId: req.tenantId,
    });
    return success(res, { outbreaks, count: outbreaks.length }, 'Outbreak episodes');
  } catch (err) {
    return handleFailure(res, err, 'list outbreak episodes');
  }
});

router.post('/outbreaks', async (req, res) => {
  try {
    const outbreak = await createOutbreakEpisode({
      ...req.body,
      ...actor(req),
      tenantId: req.tenantId,
    });
    return success(res, { outbreak }, 'Outbreak episode created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create outbreak episode');
  }
});

router.post('/outbreaks/:id/cases', async (req, res) => {
  try {
    const link = await linkOutbreakCase({
      ...req.body,
      episodeId: req.params.id,
      ...actor(req),
      tenantId: req.tenantId,
    });
    return success(res, { link }, 'Outbreak case linked', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'link outbreak case');
  }
});

router.get('/hand-hygiene-audits', async (req, res) => {
  try {
    const audits = await listHandHygieneAudits({
      from: req.query.from || null,
      to: req.query.to || null,
      ward: req.query.ward || null,
      tenantId: req.tenantId,
    });
    return success(res, { audits, count: audits.length }, 'Hand hygiene audits');
  } catch (err) {
    return handleFailure(res, err, 'list hand hygiene audits');
  }
});

router.post('/hand-hygiene-audits', async (req, res) => {
  try {
    const audit = await createHandHygieneAudit({
      ...req.body,
      ...actor(req),
      tenantId: req.tenantId,
    });
    return success(res, { audit }, 'Hand hygiene audit recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record hand hygiene audit');
  }
});

export default router;
