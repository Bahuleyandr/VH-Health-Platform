import express from 'express';

import {
  createQueueDisplayProfile,
  getQueueDisplayBoard,
  getQueueDisplaySettings,
  listQueueDisplayProfiles,
  updateQueueDisplayProfile,
  updateQueueDisplaySettings,
} from '../../services/appointment/queueDisplayService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

router.get('/settings', async (req, res, next) => {
  try {
    const settings = await getQueueDisplaySettings(req.tenantId);
    return success(res, settings, 'Queue display settings retrieved');
  } catch (err) {
    return next(err);
  }
});

router.put('/settings', async (req, res, next) => {
  try {
    const settings = await updateQueueDisplaySettings(req.tenantId, req.body || {}, {
      actorUid: req.user?.uid || null,
    });
    return success(res, settings, 'Queue display settings updated');
  } catch (err) {
    return next(err);
  }
});

router.get('/profiles', async (req, res, next) => {
  try {
    const activeOnly = String(req.query.active_only || '').toLowerCase() === 'true';
    const profiles = await listQueueDisplayProfiles(req.tenantId, { activeOnly });
    return success(res, { profiles, count: profiles.length }, 'Queue display profiles retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/profiles', async (req, res, next) => {
  try {
    const profile = await createQueueDisplayProfile(req.tenantId, req.body || {}, {
      actorUid: req.user?.uid || null,
    });
    return success(res, profile, 'Queue display profile created', 201);
  } catch (err) {
    return next(err);
  }
});

router.patch('/profiles/:profileId', async (req, res, next) => {
  try {
    const profile = await updateQueueDisplayProfile(req.tenantId, req.params.profileId, req.body || {}, {
      actorUid: req.user?.uid || null,
    });
    return success(res, profile, 'Queue display profile updated');
  } catch (err) {
    return next(err);
  }
});

router.get('/profiles/:profileId/board', async (req, res, next) => {
  try {
    const board = await getQueueDisplayBoard(req.tenantId, req.params.profileId, {
      date: req.query.date || null,
      limit: req.query.limit || null,
    });
    res.setHeader('Cache-Control', `private, max-age=${board.settings.pollIntervalSeconds}`);
    return success(res, board, 'Queue display board retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
