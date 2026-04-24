// src/controllers/compliance/indicatorsController.js
//
// NABH/JCI compliance indicators derived from the tables we already have.
// This is a quality-of-care digest: each indicator is computed over the last
// 30 days and returned as a rate + absolute numerator/denominator so the
// admin dashboard can render both a tile and the underlying counts.
//
// Indicators that currently have no data source (hand-hygiene, HAI rate,
// surgical-site infection) are returned with `available: false` so the UI can
// show a "needs tracking integration" placeholder rather than misleading zero.

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

function rate(n, d) {
  return d > 0 ? Math.round((n / d) * 10000) / 100 : 0;
}

export async function getComplianceIndicators(req, res) {
  try {
    const windowDays = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 180));

    // Medication errors & patient-ID errors from the 5-rights audit columns we
    // landed for MAR. A "medication error" here is any MAR row with
    // all_rights_passed = false, regardless of whether override was used —
    // that's the conservative NABH definition.
    const [marRow] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE all_rights_passed IS FALSE)::int                    AS med_errors,
         COUNT(*) FILTER (WHERE (rights_passed->>'patient') = 'false')::int         AS patient_id_errors,
         COUNT(*) FILTER (WHERE override_reason IS NOT NULL)::int                   AS overrides
       FROM medication_administrations
       WHERE administered_at >= NOW() - ($1 || ' days')::interval`,
      String(windowDays),
    );

    // CDS overrides per prescription (allergy/duplicate conflicts pressed through).
    const [cdsRow] = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM e_prescriptions WHERE created_at >= NOW() - ($1 || ' days')::interval) AS prescriptions,
         (SELECT COUNT(*)::int FROM prescription_safety_overrides WHERE created_at >= NOW() - ($1 || ' days')::interval) AS overrides`,
      String(windowDays),
    );

    // Unacknowledged critical alerts — a strong proxy for response-time
    // compliance. Uses the clinical_alerts table that vitalSignMonitor writes.
    // Schema uses `acknowledged` (boolean) — the legacy `acknowledged_at`
    // column is not part of the canonical src/migrations/ tree, so we compare
    // against the boolean directly.
    const [alertRow] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int                                                                  AS total,
         COUNT(*) FILTER (WHERE severity = 'CRITICAL')::int                             AS critical_total,
         COUNT(*) FILTER (WHERE severity = 'CRITICAL' AND acknowledged = FALSE)::int    AS critical_unack
       FROM clinical_alerts
       WHERE created_at >= NOW() - ($1 || ' days')::interval`,
      String(windowDays),
    );

    const indicators = {
      windowDays,
      medicationErrorRate: {
        available: (marRow?.total ?? 0) > 0,
        numerator: marRow?.med_errors ?? 0,
        denominator: marRow?.total ?? 0,
        ratePct: rate(marRow?.med_errors ?? 0, marRow?.total ?? 0),
      },
      patientIdentificationErrorRate: {
        available: (marRow?.total ?? 0) > 0,
        numerator: marRow?.patient_id_errors ?? 0,
        denominator: marRow?.total ?? 0,
        ratePct: rate(marRow?.patient_id_errors ?? 0, marRow?.total ?? 0),
      },
      marOverrideRate: {
        available: (marRow?.total ?? 0) > 0,
        numerator: marRow?.overrides ?? 0,
        denominator: marRow?.total ?? 0,
        ratePct: rate(marRow?.overrides ?? 0, marRow?.total ?? 0),
      },
      cdsOverrideRate: {
        available: (cdsRow?.prescriptions ?? 0) > 0,
        numerator: cdsRow?.overrides ?? 0,
        denominator: cdsRow?.prescriptions ?? 0,
        ratePct: rate(cdsRow?.overrides ?? 0, cdsRow?.prescriptions ?? 0),
      },
      unacknowledgedCriticalAlerts: {
        available: true,
        numerator: alertRow?.critical_unack ?? 0,
        denominator: alertRow?.critical_total ?? 0,
        ratePct: rate(alertRow?.critical_unack ?? 0, alertRow?.critical_total ?? 0),
      },
      // Known gaps — flagged `available: false` so the UI can show the tile as
      // "needs tracking integration" rather than a misleading 0.
      handHygieneCompliance:        { available: false, reason: 'No audit source yet' },
      hospitalAcquiredInfectionRate:{ available: false, reason: 'No audit source yet' },
      surgicalSiteInfectionRate:    { available: false, reason: 'No audit source yet' },
    };

    return success(res, indicators, 'Compliance indicators');
  } catch (err) {
    logger.error('Compliance indicators error:', err);
    return error(res, 'Failed to load compliance indicators', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
