// Reusable CDS-alert surfacing primitive.
//
// Several built-but-invisible clinical signals compute a risk but only persist to
// their own table / return to the API caller — they never reach the clinician's
// CDS dashboard (patient-view / encounter-start read `cds_alerts`). This raises a
// cds_alert via the canonical tenant-correct `persistCdsAlert`, with escalation-
// only de-dup (keyed on patient + alert_type) so repeated evaluations don't spam
// the dashboard. Callers should invoke it best-effort (their own try/catch).
//
// (NEWS2's surfaceNews2Cds predates this helper and keeps its own inline de-dup;
// it can adopt this later — left as-is to avoid churning shipped, tested code.)

import prisma from '../../lib/prisma.js';

const SEV_RANK = { info: 0, warning: 1, critical: 2 };

/**
 * Raise a cds_alert if it escalates beyond the standing unacknowledged alert of
 * the same type for the patient.
 *
 * @param {object} params
 * @param {string} params.patientUid
 * @param {number|null} [params.encounterId=null]
 * @param {string} params.alertType   - stable type, e.g. 'POLYPHARMACY_RISK'.
 * @param {'info'|'warning'|'critical'} params.severity
 * @param {string} params.title
 * @param {string} params.description
 * @param {object} [params.sourceData]
 * @returns {Promise<{ raised: boolean, reason?: string }>}
 */
export async function raiseCdsAlert({ patientUid, encounterId = null, alertType, severity, title, description, sourceData } = {}) {
  if (!patientUid || !alertType || !severity) return { raised: false, reason: 'missing_args' };
  if (!(severity in SEV_RANK)) return { raised: false, reason: 'bad_severity' };

  const standing = await prisma.$queryRawUnsafe(
    `SELECT severity FROM cds_alerts
       WHERE patient_uid = $1::uuid AND alert_type = $2 AND acknowledged = false
       ORDER BY created_at DESC LIMIT 1`,
    patientUid, alertType,
  );
  const standingRank = standing?.[0] ? (SEV_RANK[standing[0].severity] ?? -1) : -1;
  if (SEV_RANK[severity] <= standingRank) return { raised: false, reason: 'deduped' };

  // Lazy import so cdsEngine's heavy import graph isn't pulled at module load
  // (and so suites mocking prisma.js aren't broken by an eager pull-in).
  const { persistCdsAlert } = await import('../emr/cdsEngine.js');
  const outcome = await persistCdsAlert({ patientUid, encounterId, alertType, severity, title, description, sourceData });
  if (!outcome?.persisted) {
    // persistCdsAlert has already audited the drop; report the failure so
    // callers don't treat the alert as surfaced.
    return { raised: false, reason: outcome?.reason || 'persist_failed' };
  }
  return { raised: true, reason: 'raised' };
}

export default { raiseCdsAlert };
