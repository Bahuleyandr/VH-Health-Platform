import express from 'express';
import prisma, { setTenant } from '../../../lib/prisma.js';
import { rawQuery, clampIntParam } from '../../../lib/rawSql.js';
import { listTranslations } from '../../../services/ai/translationService.js';
import { success } from '../../../utils/responseHelper.js';
import { normalizeRole } from './shared.js';

const router = express.Router();

router.get('/translations', async (req, res, next) => {
  try {
    const result = await listTranslations({
      tenantId: req.tenantId,
      targetLanguage: req.query?.language || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Clinical AI translations retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/longitudinal-risk', async (req, res, next) => {
  try {
    const limit = clampIntParam(req.query.limit, { fallback: 50, max: 200 });
    const band = req.query.band ? String(req.query.band).toLowerCase() : null;
    const rows = await rawQuery(
      prisma,
      `SELECT DISTINCT ON (r.admission_id)
              r.id, r.admission_id, r.patient_uid, u.name AS patient_name,
              r.overall_score, r.band, r.adherence_score, r.adherence_source,
              r.readmission_score, r.comorbidity_score, r.abdm_enrichment,
              r.recommendations, r.created_at
       FROM clinical_longitudinal_risk r
       LEFT JOIN users u ON u.uid = r.patient_uid
       WHERE r.tenant_id = $1::uuid
         AND ($2::text IS NULL OR r.band = $2)
       ORDER BY r.admission_id, r.created_at DESC`,
      req.tenantId,
      band
    ).catch(() => []);
    const bandOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = rows
      .sort((a, b) => (bandOrder[a.band] ?? 4) - (bandOrder[b.band] ?? 4))
      .slice(0, limit);
    return success(res, { snapshots: sorted, count: sorted.length }, 'Longitudinal risk overview retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/dead-letter', async (req, res, next) => {
  try {
    const limit = clampIntParam(req.query.limit, { fallback: 50, max: 200 });
    const isSuperAdmin = normalizeRole(req.user?.role) === 'SUPER_ADMIN';
    const rows = await setTenant(req.tenantId, (tx) =>
      rawQuery(
        tx,
        `SELECT g.id, g.patient_uid, u.name AS patient_name, g.admission_id,
                g.task_type, g.module_key, g.provider, g.model, g.status,
                g.safety_flags, g.metadata, g.created_at
         FROM clinical_ai_generations g
         LEFT JOIN users u ON u.uid = g.patient_uid
         WHERE ($1::uuid IS NULL OR g.tenant_id = $1::uuid)
           AND g.status = 'failed'
         ORDER BY g.created_at DESC
         LIMIT $2`,
        isSuperAdmin ? null : req.tenantId,
        limit
      ),
    { superAdmin: isSuperAdmin });
    return success(res, { generations: rows, count: rows.length }, 'Clinical AI dead-letter queue retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
