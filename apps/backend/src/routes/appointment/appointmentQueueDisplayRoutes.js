import express from 'express';

import {
  getQueueDisplayBoard,
  getQueueDisplaySettings,
  listQueueDisplayProfiles,
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

router.get('/profiles', async (req, res, next) => {
  try {
    const activeOnly = String(req.query.active_only || 'true').toLowerCase() !== 'false';
    const profiles = await listQueueDisplayProfiles(req.tenantId, { activeOnly });
    return success(res, { profiles, count: profiles.length }, 'Queue display profiles retrieved');
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
