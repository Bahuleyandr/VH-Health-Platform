import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as analyticsController from '../../controllers/investigation/analyticsController.js';

const router = express.Router();

// Admin & Management routes
wrapAutoRBAC(router, 'ALL', {
  get: [
    ['/summary', analyticsController.getInvestigationStatistics]
  ]
});

export default router;