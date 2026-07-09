import express from 'express';

import {
  getAdoptionCatalog,
  recordLearningCompletion,
  recordTourEvent,
} from '../../services/adoption/adoptionService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

router.get('/catalog', async (req, res, next) => {
  try {
    const catalog = await getAdoptionCatalog({
      tenantId: req.tenantId,
      role: req.user?.role || null,
      includeDrafts: false,
    });
    return success(res, catalog, 'Adoption catalog retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/learning-completions', async (req, res, next) => {
  try {
    const result = await recordLearningCompletion({
      tenantId: req.tenantId,
      moduleId: req.body?.module_id ?? req.body?.moduleId,
      moduleKey: req.body?.module_key ?? req.body?.moduleKey,
      actorUid: req.user?.uid,
      actorRole: req.user?.role || null,
      assignmentId: req.body?.assignment_id ?? req.body?.assignmentId,
      status: req.body?.status || 'completed',
      completionSource: 'in_app',
      attestationText: req.body?.attestation_text ?? req.body?.attestationText,
      evidenceMetadata: req.body?.metadata || {},
    });
    return success(res, result, 'Learning completion recorded', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/tour-events', async (req, res, next) => {
  try {
    const result = await recordTourEvent({
      tenantId: req.tenantId,
      tourId: req.body?.tour_id ?? req.body?.tourId,
      tourKey: req.body?.tour_key ?? req.body?.tourKey,
      actorUid: req.user?.uid,
      actorRole: req.user?.role || null,
      eventType: req.body?.event_type ?? req.body?.eventType,
      stepKey: req.body?.step_key ?? req.body?.stepKey,
      metadata: req.body?.metadata || {},
    });
    return success(res, result, 'Tour event recorded', 201);
  } catch (err) {
    return next(err);
  }
});

export default router;
