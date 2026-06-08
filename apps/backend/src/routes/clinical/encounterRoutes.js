// src/routes/clinical/encounterRoutes.js
// Canonical encounter lifecycle endpoints.

import express from 'express';
import {
  getEncounter,
  transitionEncounter,
} from '../../services/clinical/canonicalClinicalPlatformService.js';
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

router.get('/:id', async (req, res, next) => {
  try {
    const encounter = await getEncounter(req.params.id);
    return success(res, encounter, 'Encounter retrieved');
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
