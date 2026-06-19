// src/services/clinical/marFiveRightsService.js
//
// Layer on top of the existing marService that adds 5-rights barcode
// verification for bedside medication administration. Flow:
//
//   1. Nurse scans patient wristband (encodes users.uid — UUID).
//   2. Nurse scans drug barcode / NDC.
//   3. Client POSTs /clinical/mar/verify { ma_id, scanned_patient_uid, scanned_barcode }
//      → this module runs the five rights check and returns the structured
//        result. Nothing is written.
//   4. If all five pass (or nurse supplies override_reason), client POSTs
//      /clinical/mar/:id/administer-with-scan to commit the MAR row AND the
//      5-rights audit trail.
//
// The five rights:
//   - patient: scanned wristband maps to the MA's patient_uid.
//   - drug:    scanned barcode matches the MA's medication_name (substring,
//              case-insensitive — a proper drug DB with NDC lookup is a
//              known future upgrade, noted in marFiveRightsService.js).
//   - dose:    MA row has a non-empty dose/dosage.
//   - route:   MA row has a non-empty route.
//   - time:    MA has a scheduled_time within the acceptable window
//              (±60 minutes by default). If scheduled_time is null we treat
//              `time` as a pass (SOS/STAT/unscheduled admins).

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import logger from '../../logging/logger.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_WINDOW_MINUTES = 60;

function _norm(s) {
  return (s ?? '').toString().toLowerCase().trim();
}

/**
 * Compute the 5-rights result for a medication_administrations row.
 * Does not write anything.
 */
export async function evaluate5Rights({ ma_id, scanned_patient_uid, scanned_barcode, windowMinutes = DEFAULT_WINDOW_MINUTES }) {
  if (!ma_id) throw AppError.badRequest('ma_id is required');
  if (!scanned_patient_uid) throw AppError.badRequest('scanned_patient_uid is required');
  if (!scanned_barcode) throw AppError.badRequest('scanned_barcode is required');

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, medication_name, dose, dosage, route,
            scheduled_time, status, tenant_id,
            CASE
              WHEN scheduled_time IS NULL THEN NULL
              ELSE ROUND(
                EXTRACT(EPOCH FROM (
                  (CURRENT_TIMESTAMP AT TIME ZONE current_setting('TimeZone')) - scheduled_time
                )) / 60
              )::int
            END AS minutes_from_scheduled
       FROM medication_administrations
      WHERE id = $1`,
    ma_id,
  );
  if (rows.length === 0) throw AppError.notFound('Medication administration record not found');
  const ma = rows[0];

  if (ma.status !== 'scheduled' && ma.status !== 'held') {
    throw AppError.conflict(`Cannot verify — status is ${ma.status}`);
  }

  const rightPatient = _norm(ma.patient_uid) === _norm(scanned_patient_uid);

  const medName = ma.medication_name || '';
  let drugMatchMode = null;
  let rightDrug =
    _norm(medName).length > 0 &&
    (_norm(medName).includes(_norm(scanned_barcode))
      || _norm(scanned_barcode).includes(_norm(medName)));
  if (rightDrug) drugMatchMode = 'name';

  // B1 — platform med-pack barcode (pharmacy_orders.pack_barcode, issued at
  // dispense). An exact pack match for the SAME patient whose item list
  // carries this medication beats substring name matching. Best-effort:
  // lookup failure falls back to the name verdict above.
  if (!rightDrug && /^vhmp-/i.test(String(scanned_barcode || ''))) {
    try {
      const packRows = await prisma.$queryRawUnsafe(
        `SELECT po.id
           FROM pharmacy_orders po
           JOIN users u ON u.id = po.patient_id
          WHERE UPPER(po.pack_barcode) = UPPER($1)
            AND u.uid = $2::uuid
            AND EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements(COALESCE(po.items_list, '[]'::jsonb)) item
                   WHERE lower(COALESCE(item->>'name', item->>'medication_name', '')) LIKE '%' || lower($3) || '%'
                      OR lower($3) LIKE '%' || lower(COALESCE(item->>'name', item->>'medication_name', '~none~')) || '%'
                )
          LIMIT 1`,
        scanned_barcode,
        ma.patient_uid,
        medName,
      );
      if (packRows.length > 0) {
        rightDrug = true;
        drugMatchMode = 'pack_barcode';
      }
    } catch (err) {
      logger.warn('Pack-barcode drug-right lookup failed (falling back to name match)', {
        error: err?.message || String(err),
      });
    }
  }

  const rightDose = Boolean(ma.dose || ma.dosage);
  const rightRoute = Boolean(ma.route);

  let rightTime = true;
  let minutesFromScheduled = null;
  if (ma.scheduled_time) {
    minutesFromScheduled = Number(ma.minutes_from_scheduled ?? 0);
    rightTime = Math.abs(minutesFromScheduled) <= windowMinutes;
  }

  const rights = {
    patient: rightPatient,
    drug:    rightDrug,
    dose:    rightDose,
    route:   rightRoute,
    time:    rightTime,
  };
  const allPassed = Object.values(rights).every(Boolean);

  return {
    ma: {
      id: ma.id,
      patient_uid: ma.patient_uid,
      medication_name: ma.medication_name,
      dose: ma.dose || ma.dosage || null,
      route: ma.route,
      scheduled_time: ma.scheduled_time,
      status: ma.status,
      tenant_id: ma.tenant_id,
    },
    rights,
    allPassed,
    context: {
      minutesFromScheduled,
      windowMinutes,
      drugMatchMode,
    },
  };
}

/**
 * Commit the MAR row with rights audit. Transitions status to 'administered'
 * the same way the plain marService.recordAdministration does, but additionally
 * writes the scanned identifiers, rights_passed jsonb, override_reason, and the
 * two bedside-scan timestamps.
 *
 * B4.2 — BCMA server-side two-scan enforcement. The bedside loop is a TWO-scan
 * gate: the patient-wristband scan ("right patient") AND the medication-barcode
 * scan ("right drug") must BOTH match before a dose is charted. This is enforced
 * server-side here (in addition to the broader 5-rights check), so a tampered or
 * partial client cannot chart a dose without a real two-scan match — or, when a
 * scan genuinely can't happen (dead scanner, damaged wristband / barcode), an
 * explicit override_reason that is persisted on the row and audited.
 *
 * @param {Object} params
 * @param {number} params.ma_id medication_administrations.id
 * @param {string} params.scanned_patient_uid wristband UUID
 * @param {string} params.scanned_barcode medication / pack barcode
 * @param {string} params.administeredBy acting staff UID
 * @param {string|null} [params.overrideReason] documented reason a right failed
 * @param {string|null} [params.tenantId] canonical tenant (req.tenantId). Falls
 *   back to the MA row's tenant_id, then DEFAULT_TENANT_ID. The write + audit
 *   run inside setTenantTx(tenantId) so they are provably tenant-isolated.
 * @param {number} [params.windowMinutes] right-time tolerance
 */
export async function administerWithScan({ ma_id, scanned_patient_uid, scanned_barcode, administeredBy, overrideReason = null, tenantId = null, windowMinutes = DEFAULT_WINDOW_MINUTES }) {
  const evaluation = await evaluate5Rights({ ma_id, scanned_patient_uid, scanned_barcode, windowMinutes });

  // B4.2 — explicit two-scan gate. The "right patient" (wristband) and "right
  // drug" (medication barcode) scans must BOTH match. This is the specific
  // bedside-safety contract and fails with its own code BEFORE the broader
  // 5-rights check below, so the client can distinguish "your two scans don't
  // match" from a dose/route/time mismatch and drive the right override modal.
  const twoScanOk = evaluation.rights.patient && evaluation.rights.drug;
  if (!twoScanOk && !overrideReason) {
    const err = AppError.conflict(
      'Both patient-wristband and medication barcode must scan-match before administration',
      'MAR_TWO_SCAN_REQUIRED',
    );
    err.details = { rights: evaluation.rights, context: evaluation.context };
    throw err;
  }

  // Existing broader gate: any of the five rights (incl. dose/route/time) may
  // still fail. Without an override that is also a 409 the client must resolve.
  if (!evaluation.allPassed && !overrideReason) {
    // Surface the failing rights so the client can drive the override modal.
    const err = AppError.conflict('5-rights check failed');
    err.details = { rights: evaluation.rights, context: evaluation.context };
    throw err;
  }

  // Prefer the threaded tenant (req.tenantId — the canonical source), fall back
  // to the MA row's tenant_id surfaced by evaluate5Rights, then the single-tenant
  // floor. The UPDATE + canonical audit run inside setTenantTx so the
  // tenant_isolation policy (migrations 239/304, FORCE) applies to both — a bare
  // prisma.$queryRawUnsafe leaves the GUC unset and falls through to the policy's
  // permissive branch (i.e. not provably tenant-scoped).
  const tid = requireTenantId(tenantId || evaluation.ma?.tenant_id);

  const record = await setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE medication_administrations
         SET status                = 'administered',
             administered_at       = NOW(),
             administered_by       = $2::uuid,
             scanned_patient_uid   = $3::uuid,
             scanned_barcode       = $4,
             rights_passed         = $5::jsonb,
             all_rights_passed     = $6,
             override_reason       = $7,
             patient_scanned_at    = NOW(),
             medication_scanned_at = NOW()
       WHERE id = $1 AND tenant_id = $8::uuid
       RETURNING id, patient_uid, medication_name, dose, dosage, route, scheduled_time,
                 status, notes, tenant_id, created_at, updated_at,
                 administered_at, administered_by, rights_passed,
                 all_rights_passed, override_reason,
                 patient_scanned_at, medication_scanned_at`,
      ma_id,
      administeredBy,
      scanned_patient_uid,
      scanned_barcode,
      JSON.stringify(evaluation.rights),
      evaluation.allPassed,
      overrideReason,
      tid,
    );

    const updated = rows[0];
    if (updated?.id) {
      // Canonical timeline + audit on the SAME tx so the audit row is
      // tenant-scoped and atomic with the administration. The helper guards its
      // own writes internally (returns null on failure), so a benign canonical
      // miss does not abort the administration transaction.
      await recordCanonicalClinicalEvent({
        tenantId: updated.tenant_id,
        patientUid: updated.patient_uid,
        eventType: 'mar.administered',
        eventStatus: updated.status,
        sourceTable: 'medication_administrations',
        sourceId: String(updated.id),
        resourceType: 'mar',
        resourceId: String(updated.id),
        actorUid: administeredBy,
        summary: `${updated.medication_name || 'Medication'} administered with scan`,
        payload: {
          medication_administration_id: updated.id,
          medication_name: updated.medication_name || null,
          dose: updated.dose || updated.dosage || null,
          route: updated.route || null,
          scheduled_time: updated.scheduled_time || null,
          administered_at: updated.administered_at || null,
          rights_passed: updated.rights_passed || evaluation.rights,
          all_rights_passed: updated.all_rights_passed,
          override_reason: updated.override_reason || null,
          two_scan_override: !twoScanOk,
          patient_scanned_at: updated.patient_scanned_at || null,
          medication_scanned_at: updated.medication_scanned_at || null,
          scanner_used: true,
        },
        // The audit row's metadata column is sourced from `metadata` (the
        // timeline's payload is separate), so carry the override facts here too
        // — an override must leave a complete, queryable audit trail (B4.2 §e).
        metadata: {
          two_scan_override: !twoScanOk,
          override_reason: updated.override_reason || null,
          rights_passed: updated.rights_passed || evaluation.rights,
          all_rights_passed: updated.all_rights_passed,
          patient_scanned_at: updated.patient_scanned_at || null,
          medication_scanned_at: updated.medication_scanned_at || null,
        },
        beforeState: { status: evaluation.ma?.status || 'scheduled' },
        afterState: {
          status: updated.status,
          rights_passed: updated.rights_passed || evaluation.rights,
        },
        tags: ['mar', 'medication', 'barcode'],
        timelineIdempotencyKey: `medication_administrations:${updated.id}:mar.administered:scan:${updated.administered_at?.toISOString?.() || Date.now()}`,
        auditIdempotencyKey: `medication_administrations:${updated.id}:audit:mar.administered:scan:${updated.administered_at?.toISOString?.() || Date.now()}`,
      }, { db: tx });
    }
    return updated;
  });

  return record;
}

export default { evaluate5Rights, administerWithScan };
