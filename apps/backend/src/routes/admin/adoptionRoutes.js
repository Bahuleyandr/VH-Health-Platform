import express from 'express';

import {
  getAdminAdoptionSummary,
  listTrainingEvidence,
  trainingEvidenceToCsv,
  upsertHelpCategory,
  upsertLearningModule,
  upsertTourDefinition,
} from '../../services/adoption/adoptionService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const summary = await getAdminAdoptionSummary({ tenantId: req.tenantId });
    return success(res, summary, 'Adoption workspace retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/help-categories', async (req, res, next) => {
  try {
    const row = await upsertHelpCategory({
      tenantId: req.tenantId,
      payload: req.body || {},
      actorUid: req.user?.uid || null,
    });
    return success(res, row, 'Help category saved');
  } catch (err) {
    return next(err);
  }
});

router.put('/modules', async (req, res, next) => {
  try {
    const row = await upsertLearningModule({
      tenantId: req.tenantId,
      payload: req.body || {},
      actorUid: req.user?.uid || null,
    });
    return success(res, row, 'Learning module saved');
  } catch (err) {
    return next(err);
  }
});

router.put('/tours', async (req, res, next) => {
  try {
    const row = await upsertTourDefinition({
      tenantId: req.tenantId,
      payload: req.body || {},
      actorUid: req.user?.uid || null,
    });
    return success(res, row, 'Tour definition saved');
  } catch (err) {
    return next(err);
  }
});

router.get('/evidence-ledger', async (req, res, next) => {
  try {
    const result = await listTrainingEvidence({
      tenantId: req.tenantId,
      controlCode: req.query.control_code || null,
      status: req.query.status || null,
      from: req.query.from || null,
      to: req.query.to || null,
      limit: req.query.limit || 200,
    });
    if (String(req.query.format || '').toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="training-evidence-ledger.csv"');
      return res.send(trainingEvidenceToCsv(result.evidence));
    }
    return success(res, result, 'Training evidence ledger retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
