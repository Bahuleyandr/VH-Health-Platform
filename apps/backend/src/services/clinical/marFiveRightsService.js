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
//   - drug:    scan resolves exactly to the tenant/order/ward catalog product
//              and one eligible inventory batch; free-text names never match.
//   - dose:    MAR dose matches the committed clinical-order dose.
//   - route:   MAR route matches the committed clinical-order route.
//   - time:    MA has a scheduled_time within the acceptable window
//              (±60 minutes by default). If scheduled_time is null we treat
//              `time` as a pass (SOS/STAT/unscheduled admins).

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  recordCanonicalClinicalEvent,
  recordMedicationSafetyReviews,
} from './canonicalClinicalPlatformService.js';
import {
  duplicateAdministrationError,
  MAR_ADMINISTRATION_MODES,
} from './marService.js';
import {
  assertMedicationOrdersExecutionReadyTx,
  consumeMarSupplyTx,
  evaluateMarScanIdentityTx,
} from './marSupplyService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  finaliseMarHttpIdempotencyTx,
  findMarAdministrationCommandReplayTx,
  fingerprintMarAdministrationRequest,
  recordMarAdministrationCommandReceiptTx,
} from './marAdministrationCommandService.js';

const DEFAULT_WINDOW_MINUTES = 60;

async function evaluate5RightsTx(tx, {
  ma_id,
  scanned_patient_uid,
  scanned_barcode,
  tenantId,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
  at = null,
  lockEvidence = false,
}) {
  if (!ma_id) throw AppError.badRequest('ma_id is required');
  if (!scanned_patient_uid) throw AppError.badRequest('scanned_patient_uid is required');
  if (!scanned_barcode) throw AppError.badRequest('scanned_barcode is required');
  const tid = requireTenantId(tenantId);

  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid::text, medication_name, dose, dosage, route,
            scheduled_time, status, tenant_id::text, clinical_order_id,
            supply_quantity_per_dose,
            CASE
              WHEN scheduled_time IS NULL THEN NULL
              ELSE ROUND(EXTRACT(EPOCH FROM (
                COALESCE($3::timestamptz, CURRENT_TIMESTAMP) - scheduled_time
              )) / 60)::int
            END AS minutes_from_scheduled
       FROM medication_administrations
      WHERE id = $1::integer
        AND tenant_id = $2::uuid`,
    ma_id,
    tid,
    at || null,
  );
  if (rows.length === 0) throw AppError.notFound('Medication administration record not found');
  const ma = rows[0];
  if (!ma.clinical_order_id) {
    throw AppError.conflict(
      'Medication administration is not linked to a verified clinical order',
      'MEDICATION_ORDER_EXECUTION_ORDER_REQUIRED',
      { medication_administration_id: Number(ma.id) },
    );
  }
  await assertMedicationOrdersExecutionReadyTx(tx, {
    tenantId: tid,
    clinicalOrderIds: [ma.clinical_order_id],
    lock: false,
  });

  const status = String(ma.status || '').toLowerCase();
  if (status === 'held') {
    throw AppError.conflict(
      'Held medication requires a prescriber-governed release before verification or administration',
      'MAR_HOLD_RELEASE_REQUIRED',
    );
  }
  if (status !== 'scheduled') throw AppError.conflict(`Cannot verify — status is ${ma.status}`);

  const rightPatient = String(ma.patient_uid).toLowerCase()
    === String(scanned_patient_uid).trim().toLowerCase();
  const identity = await evaluateMarScanIdentityTx(tx, {
    tenantId: tid,
    administration: ma,
    scannedBarcode: scanned_barcode,
    lock: lockEvidence,
  });

  let rightTime = true;
  let minutesFromScheduled = null;
  if (ma.scheduled_time) {
    minutesFromScheduled = Number(ma.minutes_from_scheduled ?? 0);
    rightTime = Math.abs(minutesFromScheduled) <= windowMinutes;
  }
  const rights = {
    patient: rightPatient,
    drug: identity.rightDrug,
    dose: identity.rightDose,
    route: identity.rightRoute,
    time: rightTime,
  };
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
      clinical_order_id: ma.clinical_order_id,
      supply_quantity_per_dose: ma.supply_quantity_per_dose == null
        ? null : Number(ma.supply_quantity_per_dose),
    },
    rights,
    allPassed: Object.values(rights).every(Boolean),
    context: {
      minutesFromScheduled,
      windowMinutes,
      ...identity.context,
      controlled: identity.controlled,
      scannedInventoryBatchId: identity.scannedInventoryBatchId,
    },
  };
}

/**
 * Compute the 5-rights result for a medication_administrations row.
 * Does not write anything.
 */
export async function evaluate5Rights(params) {
  const tid = requireTenantId(params.tenantId);
  return setTenantTx(tid, (tx) => evaluate5RightsTx(tx, { ...params, tenantId: tid }), {
    readOnly: true,
  });
}

function assertEvaluationAllowsAdministration(evaluation, overrideReason) {
  if (!evaluation.rights.patient) {
    const err = AppError.conflict(
      'Patient identity mismatch: the scanned wristband does not match this order. Re-scan the correct patient — this cannot be overridden.',
      'MAR_PATIENT_MISMATCH',
    );
    err.details = {
      rights: evaluation.rights,
      context: evaluation.context,
      hardStop: true,
      failedRight: 'patient',
    };
    throw err;
  }
  if (!evaluation.rights.drug) {
    const batchFailure = String(evaluation.context?.identityFailure || '').startsWith('batch_')
      || String(evaluation.context?.identityFailure || '').includes('expired')
      || String(evaluation.context?.identityFailure || '').includes('recalled')
      || String(evaluation.context?.identityFailure || '').includes('quarantined');
    const err = AppError.conflict(
      batchFailure
        ? 'Medication batch is expired, recalled, quarantined, inactive, or otherwise unavailable.'
        : 'Medication mismatch: the scan must resolve exactly to the ordered catalog product and one eligible ward-custody batch.',
      batchFailure ? 'MAR_BATCH_UNAVAILABLE' : 'MAR_DRUG_MISMATCH',
    );
    err.details = {
      rights: evaluation.rights,
      context: evaluation.context,
      hardStop: true,
      failedRight: 'drug',
    };
    throw err;
  }
  if (!evaluation.rights.dose) {
    const err = AppError.conflict(
      'Dose mismatch: the MAR dose must exactly match the structured prescriber order and cannot be overridden at bedside.',
      'MAR_DOSE_MISMATCH',
    );
    err.details = {
      rights: evaluation.rights,
      context: evaluation.context,
      hardStop: true,
      failedRight: 'dose',
    };
    throw err;
  }
  if (!evaluation.rights.route) {
    const err = AppError.conflict(
      'Route mismatch: the MAR route, prescriber order, and catalog route must agree and cannot be overridden at bedside.',
      'MAR_ROUTE_MISMATCH',
    );
    err.details = {
      rights: evaluation.rights,
      context: evaluation.context,
      hardStop: true,
      failedRight: 'route',
    };
    throw err;
  }
  if (!evaluation.allPassed && !overrideReason) {
    const err = AppError.conflict('5-rights check failed');
    err.details = { rights: evaluation.rights, context: evaluation.context };
    throw err;
  }
  return evaluation.rights.patient && evaluation.rights.drug;
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
export async function administerWithScan({
  ma_id,
  scanned_patient_uid,
  scanned_barcode,
  administeredBy,
  witnessUid = null,
  overrideReason = null,
  supplyOverrideReason = null,
  supplyQuantity = null,
  commandKey = null,
  requestFingerprint = null,
  httpIdempotencyClaimId = null,
  requestId = null,
  tenantId = null,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
  administeredAt = null,
}) {
  if (administeredAt != null && administeredAt !== '') {
    throw AppError.badRequest(
      'Online barcode administration cannot accept a retrospective administered_at; use the governed paper reconciliation workflow',
      'MAR_RETROSPECTIVE_PATH_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const commandIdentity = commandKey ? {
    tenantId: tid,
    medicationAdministrationId: ma_id,
    actorUid: administeredBy,
    commandScope: 'mar_administer_scan',
    commandKey,
    requestBodySha256: requestFingerprint || fingerprintMarAdministrationRequest({
      scanned_patient_uid,
      scanned_barcode,
      witness_uid: witnessUid,
      override_reason: overrideReason,
      supply_override_reason: supplyOverrideReason,
      supply_quantity: supplyQuantity,
    }),
    administrationMode: MAR_ADMINISTRATION_MODES.ONLINE_BARCODE_SCAN,
  } : null;

  const finaliseHttpTx = (tx, responseData) => finaliseMarHttpIdempotencyTx(tx, {
    claimId: httpIdempotencyClaimId,
    tenantId: tid,
    actorUid: administeredBy,
    commandKey,
    requestBodySha256: commandIdentity?.requestBodySha256,
    responseData,
    requestId,
  });

  if (commandIdentity) {
    const replay = await setTenantTx(tid, async (tx) => {
      const existing = await findMarAdministrationCommandReplayTx(tx, commandIdentity);
      if (existing) await finaliseHttpTx(tx, existing);
      return existing;
    });
    if (replay) return replay;
  }
  // Prefer the threaded tenant (req.tenantId — the canonical source), fall back
  // to the MA row's tenant_id surfaced by evaluate5Rights, then the single-tenant
  // floor. The UPDATE + canonical audit run inside setTenantTx so the
  // tenant_isolation policy (migrations 239/304, FORCE) applies to both.
  const record = await setTenantTx(tid, async (tx) => {
    if (commandIdentity) {
      const replay = await findMarAdministrationCommandReplayTx(tx, commandIdentity);
      if (replay) {
        await finaliseHttpTx(tx, replay);
        return replay;
      }
    }
    const orderContextRows = await tx.$queryRawUnsafe(
      `SELECT clinical_order_id
         FROM medication_administrations
        WHERE id = $1::integer
          AND tenant_id = $2::uuid
        LIMIT 1`,
      ma_id,
      tid,
    );
    if (!orderContextRows[0]) {
      throw AppError.notFound('Medication administration record not found');
    }
    if (!orderContextRows[0].clinical_order_id) {
      throw AppError.conflict(
        'Medication administration is not linked to a verified clinical order',
        'MEDICATION_ORDER_EXECUTION_ORDER_REQUIRED',
        { medication_administration_id: Number(ma_id) },
      );
    }
    await assertMedicationOrdersExecutionReadyTx(tx, {
      tenantId: tid,
      clinicalOrderIds: [orderContextRows[0].clinical_order_id],
    });

    // Lock the target only after locking its execution-authority order. This
    // lock order matches cancellation/discontinuation and makes a concurrent
    // terminal transition serialize before inventory or administration.
    const lockedRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid::text, medication_name, dose, dosage, route,
              scheduled_time, status, tenant_id::text, clinical_order_id,
              supply_quantity_per_dose
         FROM medication_administrations
        WHERE id = $1 AND tenant_id = $2::uuid
        FOR UPDATE`,
      ma_id,
      tid,
    );
    const locked = lockedRows[0];
    if (!locked) throw AppError.notFound('Medication administration record not found');
    if (Number(locked.clinical_order_id) !== Number(orderContextRows[0].clinical_order_id)) {
      throw AppError.conflict(
        'Medication administration order context changed',
        'MAR_INSPECTION_CONTEXT_MISMATCH',
      );
    }
    if (String(locked.status || '').toLowerCase() !== 'scheduled') {
      if (commandIdentity) {
        const replay = await findMarAdministrationCommandReplayTx(tx, commandIdentity);
        if (replay) {
          await finaliseHttpTx(tx, replay);
          return replay;
        }
      }
      if (String(locked.status || '').toLowerCase() === 'held') {
        throw AppError.conflict(
          'Held medication requires a prescriber-governed release before administration',
          'MAR_HOLD_RELEASE_REQUIRED',
        );
      }
      throw AppError.conflict('Medication state changed', 'MAR_ADMINISTRATION_STATE_CONFLICT');
    }

    // Re-run every right after locking the MAR row. Product identity and exact
    // batch eligibility are therefore checked in the same transaction that
    // consumes ward custody and records administration; a recall/quarantine or
    // order correction that committed after the dry-run cannot ride through.
    const evaluation = await evaluate5RightsTx(tx, {
      ma_id,
      scanned_patient_uid,
      scanned_barcode,
      tenantId: tid,
      windowMinutes,
      lockEvidence: true,
    });
    const twoScanOk = assertEvaluationAllowsAdministration(evaluation, overrideReason);

    const supply = await consumeMarSupplyTx(tx, {
      tenantId: tid,
      administration: locked,
      recordedBy: administeredBy,
      witnessUid,
      administrationMode: MAR_ADMINISTRATION_MODES.ONLINE_BARCODE_SCAN,
      commandKey,
      supplyQuantity,
      supplyOverrideReason,
      scannedInventoryBatchId: evaluation.context.scannedInventoryBatchId,
    });

    let rows;
    try {
      rows = await tx.$queryRawUnsafe(
        `UPDATE medication_administrations
           SET status                = 'administered',
               administered_at       = NOW(),
               administered_by       = $2::uuid,
               witness_uid           = $8::uuid,
               scanned_patient_uid   = $3::uuid,
               scanned_barcode       = $4,
               rights_passed         = $5::jsonb,
               all_rights_passed     = $6,
               override_reason       = $7,
               patient_scanned_at    = NOW(),
               medication_scanned_at = NOW()
         WHERE id = $1 AND tenant_id = $9::uuid
           AND lower(status) = 'scheduled'
         RETURNING id, patient_uid, medication_name, dose, dosage, route, scheduled_time,
                   status, notes, tenant_id, created_at, updated_at,
                   administered_at, administered_by, rights_passed,
                   witness_uid, all_rights_passed, override_reason,
                   patient_scanned_at, medication_scanned_at,
                   clinical_order_id, supply_quantity_per_dose`,
        ma_id,
        administeredBy,
        scanned_patient_uid,
        scanned_barcode,
        JSON.stringify(evaluation.rights),
        evaluation.allPassed,
        overrideReason,
        witnessUid,
        tid,
      );
    } catch (err) {
      // A sibling MAR row for the same dose already administered trips the
      // uniq_mar_administered_dose unique index. Surface it as the same clean
      // 409 marService throws, not a raw 500.
      if (err?.meta?.code === '23505' || /23505|duplicate key value/i.test(err?.message || '')) {
        throw duplicateAdministrationError();
      }
      throw err;
    }
    // Lost race: the status guard above matched 0 rows because another
    // administration committed first between our lock and this UPDATE. Reject
    // rather than return a null record (same shape as recordMedicationAdministrationTx).
    if (rows.length !== 1) {
      throw AppError.conflict('Medication state changed', 'MAR_ADMINISTRATION_STATE_CONFLICT');
    }

    const updated = { ...rows[0], supply_state: supply };
    if (updated?.id && overrideReason && !evaluation.allPassed) {
      // Canonical invariant item 5 (docs/CANONICAL_CLINICAL_TIMELINE.md): an
      // override of a failed medication-safety check must persist
      // medication_safety_reviews rows in the SAME transaction as the detail
      // write — one blocked finding per failed soft right (only time can reach
      // here; patient/drug/dose/route mismatches hard-stop above). With the
      // override reason present the helper stores them status='overridden'
      // with override_required=true. Skipped entirely when all rights passed
      // (nothing was overridden — mirrors pharmacistVerificationService's
      // "only when notable" guard). The helper swallows per-row insert
      // failures, so verify every finding landed and abort (rolling the
      // administration back) when one did not: an unrecorded safety override
      // must not commit.
      const failedRights = Object.entries(evaluation.rights)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
      const reviews = await recordMedicationSafetyReviews({
        tenantId: tid,
        patientUid: updated.patient_uid,
        safety: {
          safe: false,
          blockers: failedRights.map((name) => ({
            type: `bcma_right_${name}`,
            severity: 'high',
            medication_name: updated.medication_name,
            message: `5-rights ${name} check failed and was overridden: ${overrideReason}`,
            medication_administration_id: updated.id,
            ...(name === 'time'
              ? {
                minutes_from_scheduled: evaluation.context.minutesFromScheduled,
                window_minutes: evaluation.context.windowMinutes,
              }
              : {}),
          })),
          warnings: [],
        },
        override: { reason: overrideReason, approvedBy: administeredBy },
        actorUid: administeredBy,
      }, { db: tx });
      if (reviews.length !== failedRights.length) {
        throw AppError.internal(
          'Medication safety review write failed for 5-rights override',
          'MEDICATION_SAFETY_REVIEW_WRITE_FAILED',
        );
      }
    }
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
          witness_uid: updated.witness_uid || null,
          scan_identity: evaluation.context,
          scanner_used: true,
          mar_supply: supply,
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
          witness_uid: updated.witness_uid || null,
          inventory_batch_id: evaluation.context.inventoryBatchId || null,
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
    let committedResponse = updated;
    if (commandIdentity) {
      committedResponse = await recordMarAdministrationCommandReceiptTx(tx, {
        ...commandIdentity,
        responseData: updated,
      });
      await finaliseHttpTx(tx, committedResponse);
    }
    return committedResponse;
  });

  return record;
}

export default { evaluate5Rights, administerWithScan };
