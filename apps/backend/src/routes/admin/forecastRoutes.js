import express from 'express';
import { success } from '../../utils/responseHelper.js';
import {
  getBedForecast,
  getPharmacyStockoutForecast,
} from '../../services/ai/clinicalAiWorkflowService.js';

const router = express.Router();

router.get('/beds', async (req, res, next) => {
  try {
    const forecast = await getBedForecast({
      tenantId: req.tenantId,
      ward: req.query.ward || null,
      windowHours: req.query.window_hours || 24,
    });
    return success(res, forecast, 'Bed discharge forecast retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/pharmacy-stockouts', async (req, res, next) => {
  try {
    const forecast = await getPharmacyStockoutForecast({
      tenantId: req.tenantId,
      days: req.query.days || 7,
    });
    return success(res, forecast, 'Pharmacy stockout forecast retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
