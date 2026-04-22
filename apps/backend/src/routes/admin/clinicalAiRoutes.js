import express from 'express';
import prisma from '../../lib/prisma.js';
import { success } from '../../utils/responseHelper.js';
import { getClinicalAiRuntimeStatus } from '../../services/ai/localLlmClient.js';
import {
  getClinicalAiUsageSummary,
  listClinicalAiModules,
  updateClinicalAiModule,
} from '../../services/ai/clinicalAiModuleService.js';

const router = express.Router();

router.get('/status', async (req, res, next) => {
  try {
    const live = String(req.query.live || '').toLowerCase() === 'true';
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const status = await getClinicalAiRuntimeStatus({ live, days });
    return success(res, status, 'Clinical AI status retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/modules', async (_req, res, next) => {
  try {
    const modules = await listClinicalAiModules({ refresh: true });
    return success(res, { modules, count: modules.length }, 'Clinical AI modules retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/modules/:moduleKey', async (req, res, next) => {
  try {
    const updatedBy = req.user?.uid || null;
    const module = await updateClinicalAiModule(req.params.moduleKey, req.body || {}, updatedBy);
    return success(res, module, 'Clinical AI module updated');
  } catch (err) {
    return next(err);
  }
});

router.get('/usage', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const usage = await getClinicalAiUsageSummary({ days });
    return success(res, usage, 'Clinical AI usage retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/generations', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const conditions = [];
    const params = [];
    let idx = 1;

    if (req.query.patient_uid) {
      conditions.push(`g.patient_uid = $${idx}::uuid`);
      params.push(req.query.patient_uid);
      idx++;
    }
    if (req.query.task_type) {
      conditions.push(`g.task_type = $${idx}`);
      params.push(req.query.task_type);
      idx++;
    }
    if (req.query.status) {
      conditions.push(`g.status = $${idx}`);
      params.push(req.query.status);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await prisma.$queryRawUnsafe(
      `SELECT g.id, g.patient_uid, u.name AS patient_name, g.admission_id,
              g.task_type, g.module_key, g.provider, g.model, g.prompt_version, g.source_hash,
              g.status, g.used_ai, g.safety_flags, g.generated_by, g.reviewed_by,
              g.signed_note_id, g.prompt_tokens, g.completion_tokens, g.total_tokens,
              g.estimated_cost_minor, g.latency_ms, g.provider_request_id,
              g.finish_reason, g.metadata, g.created_at, g.updated_at
       FROM clinical_ai_generations g
       LEFT JOIN users u ON u.uid = g.patient_uid
       ${where}
       ORDER BY g.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params,
      limit,
      offset
    );

    return success(res, { generations: rows, count: rows.length }, 'Clinical AI generations retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/safety-flags', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT g.id AS generation_id, g.patient_uid, u.name AS patient_name,
              g.admission_id, g.task_type, g.module_key, g.status,
              flag->>'severity' AS severity,
              flag->>'code' AS code,
              flag->>'message' AS message,
              g.created_at
       FROM clinical_ai_generations g
       LEFT JOIN users u ON u.uid = g.patient_uid
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(g.safety_flags, '[]'::jsonb)) AS flag
       ORDER BY
         CASE flag->>'severity'
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           ELSE 4
         END,
         g.created_at DESC
       LIMIT $1`,
      limit
    );

    return success(res, { flags: rows, count: rows.length }, 'Clinical AI safety flags retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
