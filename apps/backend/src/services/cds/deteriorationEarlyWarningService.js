// Deterioration Early Warning — surface the EXISTING NEWS2 score onto the
// CDS-Hooks card pipeline.
//
// NEWS2 itself is computed + persisted by services/clinical/news2Service.js. That
// service writes a news2_scores row + a notification but never reaches cds_alerts,
// so a high score is invisible on the clinician's CDS dashboard (patient-view /
// encounter-start). This module adds that surfacing — gated on the
// `deterioration_early_warning` module, adult-only, escalation-only de-dup — by
// reusing the canonical tenant-correct `persistCdsAlert`. Deterministic, no LLM.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { getClinicalAiModule } from '../ai/clinicalAiModuleService.js';
import { resolvePatientContext } from '../../utils/clinical/vitalSignMonitor.js';

const MODULE_KEY = 'deterioration_early_warning';
const SEV_RANK = { info: 0, warning: 1, critical: 2 };

/**
 * Persist a NEWS2 deterioration alert to cds_alerts when the score escalates,
 * for an adult patient, while the module is enabled — with escalation-only
 * de-dup so repeated observations don't spam the dashboard.
 *
 * @param {object} params
 * @param {string} params.patientUid
 * @param {number|null} [params.encounterId=null]
 * @param {{ totalScore:number, clinicalRisk:string, escalationAction?:string,
 *           scores?:object, anyParamThree?:boolean }} params.news2
 * @returns {Promise<{ raised: boolean, reason?: string, severity?: string }>}
 */
export async function surfaceNews2Cds({ patientUid, encounterId = null, news2 } = {}) {
  const {
    totalScore,
    clinicalRisk,
    escalationAction,
    scores,
    anyParamThree,
    news2ScoreId = null,
    vitalsChartId = null,
  } = news2 || {};

  // Escalating set only: aggregate >= 5 OR any single parameter scored 3.
  if (!(Number(totalScore) >= 5 || anyParamThree)) {
    return { raised: false, reason: 'below_threshold' };
  }

  const u = await prisma.users.findUnique({ where: { uid: patientUid }, select: { id: true, tenant_id: true } });
  if (!u) return { raised: false, reason: 'patient_not_found' };

  // Module gate (tenant 3-layer via the patient's owning tenant).
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId: u.tenant_id });
  if (!module?.enabled) return { raised: false, reason: 'module_disabled' };

  // Adult-only — NEWS2 isn't validated for paediatrics/pregnancy.
  const ctx = await resolvePatientContext(u.id);
  if (ctx?.isPaediatric || ctx?.isPregnant) return { raised: false, reason: 'not_adult' };

  const severity = Number(totalScore) >= 7 ? 'critical' : 'warning';

  // Escalation-only de-dup: only raise if there is no standing unacknowledged
  // NEWS2 alert, or the new severity outranks the standing one.
  const standing = await prisma.$queryRawUnsafe(
    `SELECT severity FROM cds_alerts
       WHERE patient_uid = $1::uuid AND alert_type = 'NEWS2_DETERIORATION' AND acknowledged = false
       ORDER BY created_at DESC LIMIT 1`,
    patientUid,
  );
  const standingRank = standing?.[0] ? (SEV_RANK[standing[0].severity] ?? -1) : -1;
  if ((SEV_RANK[severity] ?? -1) <= standingRank) return { raised: false, reason: 'deduped' };

  // Lazy import so cdsEngine's heavy import graph isn't pulled at module load
  // (and so suites mocking prisma.js aren't broken by an eager pull-in).
  const { persistCdsAlert } = await import('../emr/cdsEngine.js');
  const outcome = await persistCdsAlert({
    patientUid,
    encounterId,
    alertType: 'NEWS2_DETERIORATION',
    severity,
    title: `NEWS2 ${totalScore} — ${String(clinicalRisk || '').replace(/_/g, ' ')}`,
    description: escalationAction || '',
    sourceData: {
      total_score: totalScore,
      clinical_risk: clinicalRisk,
      scores: scores || {},
      any_param_three: !!anyParamThree,
      news2_score_id: news2ScoreId == null ? null : String(news2ScoreId),
      vitals_chart_id: vitalsChartId == null ? null : Number(vitalsChartId),
      source: 'news2Service.recordNEWS2',
    },
  });
  if (!outcome?.persisted) {
    // persistCdsAlert has already audited the drop; surface the failure to
    // the caller instead of claiming the alert was raised. (No patient
    // identifiers in this log line.)
    logger.error('NEWS2 CDS alert persistence failed', {
      severity,
      reason: outcome?.reason || 'persist_failed',
    });
    return { raised: false, reason: outcome?.reason || 'persist_failed', severity };
  }
  logger.info(`NEWS2 CDS alert raised for patient ${patientUid}: score=${totalScore}, severity=${severity}`);
  return { raised: true, severity };
}

export default { surfaceNews2Cds };
