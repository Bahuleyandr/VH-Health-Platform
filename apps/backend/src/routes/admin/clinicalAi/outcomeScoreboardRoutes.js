import express from 'express';
import { computeAiOutcomeScoreboard } from '../../../services/ai/aiOutcomeScoreboardService.js';
import { success } from '../../../utils/responseHelper.js';

const router = express.Router();

// G3 outcome instrumentation — per-module AI evidence scoreboard.
//
// Read-only aggregation over EXISTING generation/review/safety tables
// (acceptance rate, edit distance, override rate, time-to-sign vs baseline,
// safety-flag precision). This is the artifact NABH assessors and the
// hospital board review for enable/disable and stage-promotion decisions;
// control-plane gated at the mount (CLINICAL_AI_CONTROL_ROLES + IP
// allowlist), same as every other governance read.
router.get('/outcome-scoreboard', async (req, res, next) => {
  try {
    const scoreboard = await computeAiOutcomeScoreboard({
      tenantId: req.tenantId,
      periodDays: req.query.period_days,
      moduleKey: req.query.module_key || null,
    });
    return success(res, scoreboard, 'AI outcome scoreboard computed');
  } catch (err) {
    return next(err);
  }
});

export default router;
