// src/routes/clinical/encounterRoutes.js
// Canonical encounter lifecycle endpoints.

import express from 'express';
import {
  evaluateMedicationSafety,
  getClinicalDocumentationTemplates,
  getClinicalDowntimePolicy,
  getEncounter,
  listClinicalAuditEvents,
  listMedicationSafetyReviews,
  listWorkflowSlaInstances,
  transitionEncounter,
} from '../../services/clinical/canonicalClinicalPlatformService.js';
import { signDocument } from '../../services/clinical/documentIntegrityService.js';
import logger from '../../logging/logger.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

function actorContext(req) {
  return {
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null,
    reason: req.body?.reason || req.query?.reason || null,
    metadata: {
      request_id: req.id || null,
      source: 'api',
      body_metadata: req.body?.metadata || null,
    },
  };
}

function tenantContext(req) {
  return req.tenantId || req.user?.tenant_id || req.user?.tenantId || undefined;
}

router.get('/documentation/templates', async (req, res, next) => {
  try {
    return success(
      res,
      getClinicalDocumentationTemplates(req.query),
      'Clinical documentation templates retrieved',
    );
  } catch (err) {
    next(err);
  }
});

router.get('/downtime-policy', async (req, res, next) => {
  try {
    return success(
      res,
      getClinicalDowntimePolicy({
        ...req.query,
        role: req.query?.role || req.user?.role,
      }),
      'Clinical downtime policy retrieved',
    );
  } catch (err) {
    next(err);
  }
});

router.post('/medication-safety/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateMedicationSafety({
      ...req.body,
      tenantId: tenantContext(req),
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, result, 'Medication safety evaluated');
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const encounter = await getEncounter(req.params.id);
    return success(res, encounter, 'Encounter retrieved');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audit', async (req, res, next) => {
  try {
    const result = await listClinicalAuditEvents({
      ...req.query,
      tenantId: tenantContext(req),
      encounterId: req.params.id,
    });
    return success(res, result, 'Encounter audit events retrieved');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/slas', async (req, res, next) => {
  try {
    const result = await listWorkflowSlaInstances({
      ...req.query,
      tenantId: tenantContext(req),
      encounterId: req.params.id,
    });
    return success(res, result, 'Encounter workflow SLAs retrieved');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/medication-safety', async (req, res, next) => {
  try {
    const result = await listMedicationSafetyReviews({
      ...req.query,
      tenantId: tenantContext(req),
      encounterId: req.params.id,
    });
    return success(res, result, 'Encounter medication safety reviews retrieved');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/medication-safety/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateMedicationSafety({
      ...req.body,
      tenantId: tenantContext(req),
      encounterId: req.params.id,
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, result, 'Encounter medication safety evaluated');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/activate', async (req, res, next) => {
  try {
    const encounter = await transitionEncounter(req.params.id, 'active', actorContext(req));
    return success(res, encounter, 'Encounter activated');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/sign', async (req, res, next) => {
  try {
    const encounter = await transitionEncounter(req.params.id, 'signed', actorContext(req));
    // Roadmap C4 — attach an e-signature record (content hash of the
    // encounter's clinical body) to the sign transition. Best-effort: the
    // transition is already committed + audited; a signature failure is
    // logged, not rolled back.
    if (encounter?.id) {
      try {
        encounter.signature = await signDocument({
          documentType: 'encounter',
          documentId: encounter.id,
          statement: req.body?.signature_statement || 'Encounter clinical record attested at sign-off',
        }, {
          actorUid: req.user?.uid || null,
          actorRole: req.user?.role || null,
          actorName: req.user?.name || null,
        });
      } catch (sigErr) {
        logger.warn('Encounter signature record failed (transition stands)', {
          encounter_id: encounter.id, error: sigErr?.message,
        });
      }
    }
    return success(res, encounter, 'Encounter signed');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/amend', async (req, res, next) => {
  try {
    const encounter = await transitionEncounter(req.params.id, 'amended', actorContext(req));
    return success(res, encounter, 'Encounter opened for amendment');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/lock', async (req, res, next) => {
  try {
    const encounter = await transitionEncounter(req.params.id, 'locked', actorContext(req));
    return success(res, encounter, 'Encounter locked');
  } catch (err) {
    next(err);
  }
});

export default router;
