/**
 * Quality case controller — thin HTTP layer for the M&M/RCA standing queue.
 *
 * GET  /quality/cases              → list quality domain alerts
 * POST /quality/cases/:alertId/generate-packet  → generate RCA draft from alert
 *
 * RBAC is inherited from the parent router (requireClinicalAiControl).
 * Tenant is on req.tenantId (set by the admin middleware chain).
 */

import logger from '../../../logging/logger.js';
import { success, error } from '../../../utils/responseHelper.js';
import { AppError } from '../../../utils/AppError.js';
import { listOperationalAlerts } from '../../../services/ai/operationalAlertService.js';
import { generateRcaDraft } from '../../../services/ai/rcaDraftService.js';
import prisma from '../../../lib/prisma.js';

// ---------------------------------------------------------------------------
// GET /quality/cases
// ---------------------------------------------------------------------------
export async function listQualityCases(req, res, next) {
  try {
    const data = await listOperationalAlerts({
      tenantId: req.tenantId,
      domain: 'quality',
      severity: req.query.severity || null,
      systemStatus: req.query.system_status || null,
      reviewerDecision: req.query.reviewer_decision || null,
      limit: req.query.limit,
    });
    return success(res, data, 'Quality cases');
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /quality/cases/:alertId/generate-packet
//
// Resolves the alert's scope_key to determine case type, then calls
// generateRcaDraft. On success, writes the resulting rca_id into the alert's
// metadata column and returns the draft.
//
// Scope_key shapes:
//   readmission:<admission_id>           → caseType='readmission', admissionId extracted
//   quality_incident:<incident_id>       → no linked admission FK (noted limitation) → 422
// ---------------------------------------------------------------------------
export async function generateQualityPacket(req, res, next) {
  try {
    const alertId = Number.parseInt(req.params?.alertId, 10);
    if (!Number.isFinite(alertId) || alertId < 1) {
      return error(res, 'Invalid alertId', 400, { code: 'INVALID_ALERT_ID' });
    }

    // Load the alert — must be domain='quality' and tenant-scoped.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, domain, scope_key, module_key, system_status
         FROM clinical_ai_operational_alerts
        WHERE id = $1 AND tenant_id = $2::uuid`,
      alertId,
      req.tenantId,
    );
    const alert = rows?.[0];
    if (!alert) throw AppError.notFound('Quality alert not found');
    if (alert.domain !== 'quality') {
      return error(res, 'Alert is not a quality domain alert', 422, { code: 'WRONG_DOMAIN' });
    }

    const scopeKey = String(alert.scope_key || '');
    let rcaResult;

    if (scopeKey.startsWith('readmission:')) {
      // readmission:<admission_id>
      const admissionId = scopeKey.replace('readmission:', '');
      const admId = Number.parseInt(admissionId, 10);
      if (!Number.isFinite(admId) || admId < 1) {
        return error(res, 'Could not resolve admission_id from scope_key', 422,
          { code: 'INVALID_SCOPE_KEY', scope_key: scopeKey });
      }
      rcaResult = await generateRcaDraft({ req, admissionId: admId, caseType: 'readmission' });

    } else if (scopeKey.startsWith('quality_incident:')) {
      // quality_incidents has no admission_id FK — reported limitation.
      // Return a structured 422 rather than fabricating.
      return error(res, [
        'Quality incidents have no linked admission for automated RCA generation.',
        'Use the RCA draft endpoint directly with an admission_id if available,',
        'or attach an admission to the incident manually before generating a packet.',
      ].join(' '), 422, {
        code: 'NO_LINKED_ADMISSION',
        scope_key: scopeKey,
        hint: 'POST /admin/clinical-ai/rca-drafts with explicit admission_id',
      });
    } else {
      return error(res, `Unrecognised scope_key format: ${scopeKey}`, 422,
        { code: 'UNKNOWN_SCOPE_KEY' });
    }

    // Write rca_id into the alert metadata.
    if (rcaResult?.rca_id != null) {
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE clinical_ai_operational_alerts
              SET metadata = jsonb_set(
                    COALESCE(metadata, '{}')::jsonb,
                    '{rca_draft_id}',
                    to_jsonb($2::text)
                  ),
                  updated_at = NOW()
            WHERE id = $1`,
          alertId,
          String(rcaResult.rca_id),
        );
      } catch (stampErr) {
        // Non-fatal — the draft was generated, just log and continue.
        logger.warn('quality packet: failed to stamp rca_draft_id into alert metadata', {
          alertId, rca_id: rcaResult.rca_id, error: stampErr?.message,
        });
      }
    }

    return success(res, {
      alert_id: alertId,
      scope_key: scopeKey,
      rca_draft_id: rcaResult?.rca_id ?? null,
      draft: rcaResult,
    }, 'Quality RCA packet generated');

  } catch (err) {
    return next(err);
  }
}
