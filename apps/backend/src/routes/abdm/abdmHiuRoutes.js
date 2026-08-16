// src/routes/abdm/abdmHiuRoutes.js
//
// Thin HIU surface (migration 703 + the 124 abdmFull consent layer), mounted
// at /api/v1/abdm/hiu behind clinical-staff RBAC and phiAccessLogger('ABDM').
//
// Consent requests ride abdm_consent_requests (flow_kind='hiu'); fetches ride
// abdm_hiu_fetch_sessions; received bundles are R2 REFERENCES rendered
// transiently — each bundle read is PHI access (logPhiAccess), never a
// clinical write (no clinical_timeline_events row; see the 703 header).

import { Router } from 'express';
import { markRouterDomain } from '../../config/openapiDomain.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { CLINICAL_STAFF_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import {
  createHiuConsentRequest,
  getFetchSession,
  getReceivedBundleContent,
  listFetchSessions,
  listReceivedBundles,
  startHiuFetch,
} from '../../services/abdm/abdmHiuService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

const router = Router();
markRouterDomain(router, 'abdm');
router.use(requireRole(...CLINICAL_STAFF_ROUTE_ROLES));

function handle(label, run) {
  return async (req, res, next) => {
    try {
      return await run(req, res);
    } catch (err) {
      if (err.isOperational) {
        return relayAppError(res, err, label);
      }
      logger.error(label, { error: err.message });
      return next(err);
    }
  };
}

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

router.post('/consent-requests', handle('Failed to create ABDM HIU consent request', async (req, res) => {
  const body = req.body || {};
  const row = await createHiuConsentRequest({
    tenantId: req.tenantId,
    patientUid: body.patient_uid ?? body.patientUid ?? null,
    abhaAddress: body.abha_address ?? body.abhaAddress,
    purposeCode: body.purpose ?? body.purpose_code ?? 'CAREMGT',
    hiTypes: body.hi_types ?? body.hiTypes ?? [],
    dataFrom: body.date_from ?? body.dataFrom,
    dataTo: body.date_to ?? body.dataTo,
    expiryAt: body.expiry ?? body.expiryAt ?? null,
    requesterUid: req.user?.uid,
    requesterName: req.user?.name ?? null,
  });
  return success(res, { consent_request: row }, 'HIU consent request initiated', 201);
}));

router.get('/consent-requests', handle('Failed to list ABDM HIU consent requests', async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 50, 1), 200);
  const status = req.query?.status ? String(req.query.status).trim().toLowerCase() : null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, request_id, flow_kind, patient_uid, requester_uid, hi_types,
            permission_kind, data_from, data_to, expiry_at, purpose_code,
            status, requested_at, decided_at, environment, metadata
       FROM abdm_consent_requests
      WHERE tenant_id = $1::uuid AND flow_kind = 'hiu'
        AND ($2::text IS NULL OR status = $2::text)
      ORDER BY requested_at DESC LIMIT $3::int`,
    req.tenantId, status, limit,
  );
  return success(res, { consent_requests: rows, count: rows.length }, 'HIU consent requests retrieved', 200);
}));

router.get('/consents', handle('Failed to list ABDM HIU consent artifacts', async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 50, 1), 200);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.consent_request_id, a.artifact_id, a.patient_uid, a.hi_types,
            a.permission_kind, a.data_from, a.data_to, a.expiry_at, a.status,
            a.granted_at, a.revoked_at, a.environment
       FROM abdm_consent_artifacts a
       JOIN abdm_consent_requests r ON r.id = a.consent_request_id
      WHERE a.tenant_id = $1::uuid AND r.flow_kind = 'hiu'
      ORDER BY a.granted_at DESC LIMIT $2::int`,
    req.tenantId, limit,
  );
  return success(res, { artifacts: rows, count: rows.length }, 'HIU consent artifacts retrieved', 200);
}));

router.post('/consents/:artifactId/fetch', handle('Failed to start ABDM HIU fetch', async (req, res) => {
  const artifactId = positiveInt(req.params.artifactId);
  if (artifactId === null) return error(res, 'A numeric artifact id is required', 400);
  const session = await startHiuFetch({
    tenantId: req.tenantId,
    artifactId,
    initiatedBy: req.user?.uid,
  });
  return success(res, { session }, 'HIU fetch session started', 201);
}));

router.get('/sessions', handle('Failed to list ABDM HIU fetch sessions', async (req, res) => {
  const result = await listFetchSessions({
    tenantId: req.tenantId,
    status: req.query?.status || null,
    limit: req.query?.limit,
  });
  return success(res, result, 'HIU fetch sessions retrieved', 200);
}));

router.get('/sessions/:id', handle('Failed to get ABDM HIU fetch session', async (req, res) => {
  const id = positiveInt(req.params.id);
  if (id === null) return error(res, 'A numeric session id is required', 400);
  const session = await getFetchSession({ tenantId: req.tenantId, sessionId: id });
  return success(res, { session }, 'HIU fetch session retrieved', 200);
}));

router.get('/sessions/:id/bundles', handle('Failed to list ABDM HIU bundles', async (req, res) => {
  const id = positiveInt(req.params.id);
  if (id === null) return error(res, 'A numeric session id is required', 400);
  const result = await listReceivedBundles({ tenantId: req.tenantId, sessionId: id });
  return success(res, result, 'HIU received bundles retrieved', 200);
}));

router.get('/sessions/:id/bundles/:bundleId', handle('Failed to read ABDM HIU bundle', async (req, res) => {
  const id = positiveInt(req.params.id);
  const bundleId = positiveInt(req.params.bundleId);
  if (id === null || bundleId === null) {
    return error(res, 'Numeric session and bundle ids are required', 400);
  }
  const session = await getFetchSession({ tenantId: req.tenantId, sessionId: id });
  const result = await getReceivedBundleContent({
    tenantId: req.tenantId,
    sessionId: id,
    bundleId,
  });
  // Transient render of an HIU-fetched record = PHI ACCESS (703 posture).
  logPhiAccess({
    userId: req.user?.uid,
    userRole: req.user?.role,
    patientId: session.patient_uid,
    recordType: 'abdm_hiu_bundle',
    action: 'VIEW',
    ip: req.ip,
    requestId: req.id,
    tenantId: req.tenantId,
  });
  return success(res, result, 'HIU received bundle retrieved', 200);
}));

export default router;
