// src/routes/gamification/gamificationRoutes.js
// Patient-facing gamification routes — health points, milestones, vouchers

import { Router } from 'express';
import * as gamificationController from '../../controllers/gamification/gamificationController.js';

const router = Router();

// GET /summary — gamification summary (points, tier, vouchers, recent activity)
router.get('/summary', gamificationController.getSummary);

// GET /history — paginated point ledger (?page=1&limit=20)
router.get('/history', gamificationController.getHistory);

// GET /milestones — all active milestones with user claim status
router.get('/milestones', gamificationController.getMilestones);

// POST /milestones/:id/claim — claim a milestone reward
router.post('/milestones/:id/claim', gamificationController.claimMilestone);

export default router;
