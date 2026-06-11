// src/routes/gamification/gamificationRoutes.js
// Patient-facing gamification routes — health points, milestones, vouchers

import { Router } from 'express';
import * as gamificationController from '../../controllers/gamification/gamificationController.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { scoreAdherenceRisk } from '../../services/gamification/adherenceRiskService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = Router();

// GET /adherence-risk/:patientId — heuristic adherence risk (placeholder for
// a trained ML model). Returns 0–100 + contributing factors.
router.get('/adherence-risk/:patientId', patientAccessGuard('CLINICAL_WORKFLOW', { requirePatientContext: true }), async (req, res) => {
  try {
    const pid = parseInt(req.params.patientId, 10);
    if (!Number.isFinite(pid)) return error(res, 'Invalid patientId', 400);
    const result = await scoreAdherenceRisk(pid);
    if (!result) return error(res, 'Patient not found', 404);
    return success(res, result, 'Adherence risk score');
  } catch (_e) {
    return error(res, 'Failed to compute adherence risk', 500);
  }
});

// GET /summary — gamification summary (points, tier, vouchers, recent activity)
router.get('/summary', gamificationController.getSummary);

// GET /history — paginated point ledger (?page=1&limit=20)
router.get('/history', gamificationController.getHistory);

// GET /milestones — all active milestones with user claim status
router.get('/milestones', gamificationController.getMilestones);

// POST /milestones/:id/claim — claim a milestone reward
router.post('/milestones/:id/claim', gamificationController.claimMilestone);

// GET /wellness-score — personal wellness score (0-100) with dimension breakdown
router.get('/wellness-score', gamificationController.getWellnessScore);

// GET /insights — prioritised smart insight cards for dashboard
router.get('/insights', gamificationController.getInsights);

// GET /checkin/status — whether user has checked in today + current streak
router.get('/checkin/status', gamificationController.getCheckInStatus);

// POST /checkin — record today's daily mood check-in (awards 10 pts)
router.post('/checkin', gamificationController.recordCheckIn);

export default router;
