/**
 * Admin routes for the dedupe + merge workflow (Phase A2 PR2).
 *
 *   POST   /patient-merges/detect              — run a fresh dedupe pass
 *   GET    /patient-merges/candidates          — list candidates by status
 *   GET    /patient-merges/candidates/:id      — fetch one candidate
 *   PATCH  /patient-merges/candidates/:id/reject
 *                                              — mark "not duplicate"
 *   GET    /patient-merges                     — list merge requests
 *   POST   /patient-merges                     — request a merge
 *   GET    /patient-merges/:id                 — fetch one merge request
 *   PATCH  /patient-merges/:id/approve         — approve (different user)
 *   PATCH  /patient-merges/:id/reject          — reject
 *   PATCH  /patient-merges/:id/cancel          — cancel
 *   POST   /patient-merges/:id/execute         — execute the merge
 *
 * Mounted at /api/v1/admin/patient-merges via routes/admin/index.js.
 */

import express from 'express';

import { error, success } from '../../utils/responseHelper.js';
import {
  detectIdentifierCollisions,
  getDuplicateCandidate,
  listDuplicateCandidates,
  markCandidateNotDuplicate,
} from '../../services/patient/patientDedupeService.js';
import {
  approveMerge,
  cancelMerge,
  executeMerge,
  getMergeRequest,
  listMergeRequests,
  rejectMerge,
  requestMerge,
} from '../../services/patient/patientMergeService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

router.post('/detect', async (req, res, next) => {
  try {
    const result = await detectIdentifierCollisions({
      tenantId: req.tenantId,
      limit: req.body?.limit,
    });
    return success(res, result, 'Duplicate detection complete', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/candidates', async (req, res, next) => {
  try {
    const result = await listDuplicateCandidates({
      tenantId: req.tenantId,
      status: req.query.status || 'open',
      detectionRunId: req.query.detection_run_id || null,
      minConfidence: req.query.min_confidence || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Duplicate candidates retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/candidates/:id', async (req, res, next) => {
  try {
    const row = await getDuplicateCandidate({
      tenantId: req.tenantId,
      id: req.params.id,
    });
    return success(res, row, 'Duplicate candidate retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/candidates/:id/reject', async (req, res, next) => {
  try {
    const row = await markCandidateNotDuplicate({
      tenantId: req.tenantId,
      id: req.params.id,
      decidedBy: req.user?.uid || null,
      decisionNote: req.body?.decision_note || null,
    });
    return success(res, row, 'Duplicate candidate marked as not-a-duplicate');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Merge requests
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const result = await listMergeRequests({
      tenantId: req.tenantId,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Merge requests retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    if (!req.body?.primary_uid || !req.body?.secondary_uid) {
      return error(res, 'primary_uid and secondary_uid are required', 400);
    }
    const row = await requestMerge({
      tenantId: req.tenantId,
      candidateId: req.body?.candidate_id || null,
      primaryUid: req.body.primary_uid,
      secondaryUid: req.body.secondary_uid,
      requestedBy: req.user?.uid || null,
      requesterNote: req.body?.requester_note || null,
      metadata: req.body?.metadata || {},
    });
    return success(res, row, 'Merge requested', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const row = await getMergeRequest({
      tenantId: req.tenantId,
      id: req.params.id,
    });
    return success(res, row, 'Merge request retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/approve', async (req, res, next) => {
  try {
    const row = await approveMerge({
      tenantId: req.tenantId,
      id: req.params.id,
      approverUid: req.user?.uid || null,
      approverNote: req.body?.approver_note || null,
    });
    return success(res, row, 'Merge request approved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/reject', async (req, res, next) => {
  try {
    const row = await rejectMerge({
      tenantId: req.tenantId,
      id: req.params.id,
      approverUid: req.user?.uid || null,
      rejectionReason: req.body?.rejection_reason || null,
    });
    return success(res, row, 'Merge request rejected');
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/cancel', async (req, res, next) => {
  try {
    const row = await cancelMerge({
      tenantId: req.tenantId,
      id: req.params.id,
      cancelledBy: req.user?.uid || null,
      reason: req.body?.reason || null,
    });
    return success(res, row, 'Merge request cancelled');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/execute', async (req, res, next) => {
  try {
    const row = await executeMerge({
      tenantId: req.tenantId,
      id: req.params.id,
      executorUid: req.user?.uid || null,
    });
    return success(res, row, 'Merge executed', 201);
  } catch (err) {
    return next(err);
  }
});

export default router;
