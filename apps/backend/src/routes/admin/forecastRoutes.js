import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success } from '../../utils/responseHelper.js';
import {
  getBedForecast,
  getPharmacyStockoutForecast,
} from '../../services/ai/clinicalAiWorkflowService.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrNull(value) {
  const text = String(value || '').trim();
  return UUID_RE.test(text) ? text.toLowerCase() : null;
}

async function safeAudit(req, action, resourceId, after) {
  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (uid, role, action, resource, resource_id, metadata, ip_address, user_agent, created_at)
       VALUES ($1::uuid, $2, $3, 'clinical_ai', $4, $5::jsonb, $6, $7, NOW())`,
      uuidOrNull(req.user?.uid),
      req.user?.role || null,
      action,
      String(resourceId),
      JSON.stringify({
        before: null,
        after,
        actor: {
          uid: req.user?.uid || null,
          role: req.user?.role || null,
        },
      }),
      req.ip || null,
      String(req.headers['user-agent'] || '').slice(0, 500) || null
    );
  } catch (err) {
    logger.warn('Clinical AI forecast audit write failed', { action, resourceId, error: err?.message });
  }
}

router.get('/beds', async (req, res, next) => {
  try {
    const forecast = await getBedForecast({
      tenantId: req.tenantId,
      ward: req.query.ward || null,
      windowHours: req.query.window_hours || 24,
    });
    await safeAudit(req, 'CLINICAL_AI_BED_FORECAST_GENERATED', 'bed_discharge_forecast', {
      ward: forecast.ward,
      forecast_window_hours: forecast.forecast_window_hours,
      admitted_count: forecast.admitted_count,
      likely_discharges_24h: forecast.likely_discharges_24h,
      likely_discharges_48h: forecast.likely_discharges_48h,
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
    await safeAudit(req, 'CLINICAL_AI_PHARMACY_STOCKOUT_FORECAST_GENERATED', 'pharmacy_stockout_predictor', {
      window_days: forecast.window_days,
      high_usage_count: forecast.high_usage_meds.length,
      stockout_risk_count: forecast.stockout_risks.length,
    });
    return success(res, forecast, 'Pharmacy stockout forecast retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
