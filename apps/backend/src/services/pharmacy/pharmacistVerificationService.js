// src/services/pharmacy/pharmacistVerificationService.js
//
// Roadmap B1 — pharmacist clinical verification of pharmacy orders.
//
// The pharmacy lifecycle had no state where a pharmacist reviews the order
// against allergies/interactions before PREPARING. This service owns that
// gate:
//
//   * verifyOrder()  — runs the full prescription-safety engine
//     (allergy stores + B2 drug KB + B7 problem list) against the order's
//     item list, persists the verdict on pharmacy_orders, records
//     medication_safety_reviews rows + a canonical timeline/audit event in
//     the same transaction, and enforces override-with-reason when blockers
//     are present.
//   * assertVerificationCleared() — shared gate used by the PREPARING /
//     DISPATCH / counter-dispense controllers.
//   * ensurePackBarcode() / getPackLabel() — platform-issued med-pack
//     barcode + printable label payload; the MAR drug-right scan matches
//     this barcode exactly (marFiveRightsService).

import { randomBytes } from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import { evaluateDrugKb } from '../clinical/drugKnowledgeBaseService.js';
import {
  recordCanonicalClinicalEvent,
  recordMedicationSafetyReviews,
} from '../clinical/canonicalClinicalPlatformService.js';
import {
  BCMA_CONFIG,
  CLINICAL_VERIFICATION_STATUS,
  VERIFICATION_CLEARED_STATUSES,
} from '../../config/pharmacyConfig.js';

const VERIFIABLE_ORDER_STATUSES = ['PENDING', 'CONFIRMED'];
const MIN_OVERRIDE_REASON_LENGTH = 10;

export function orderItemsToMedications(itemsList) {
  if (!Array.isArray(itemsList)) return [];
  return itemsList
    .map((item) => ({
      name: item?.name || item?.medication_name || item?.item_name || null,
      dose: item?.dose || item?.dosage || item?.strength || null,
      frequency: item?.frequency || item?.freq || null,
      route: item?.route || null,
      days: item?.days || item?.duration_days || null,
    }))
    .filter((m) => m.name);
}

async function loadOrder(orderId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT po.id, po.order_number, po.status, po.patient_id, po.patient_name,
            po.items_list, po.tenant_id, po.total_amount,
            po.clinical_verification_status, po.clinically_verified_by,
            po.clinically_verified_at, po.clinical_verification_notes, po.pack_barcode,
            u.uid AS patient_uid
       FROM pharmacy_orders po
       LEFT JOIN users u ON u.id = po.patient_id
      WHERE po.id = $1
      LIMIT 1`,
    orderId,
  );
  return rows[0] || null;
}

/**
 * Gate helper for lifecycle controllers: throws 409 when the order has not
 * cleared pharmacist clinical verification (and enforcement is on).
 */
export async function assertVerificationCleared(orderId) {
  if (!BCMA_CONFIG.requirePharmacistVerification) return { enforced: false };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT clinical_verification_status FROM pharmacy_orders WHERE id = $1 LIMIT 1`,
    orderId,
  );
  if (!rows.length) throw AppError.notFound('Pharmacy order not found');
  const status = rows[0].clinical_verification_status || CLINICAL_VERIFICATION_STATUS.PENDING;
  if (!VERIFICATION_CLEARED_STATUSES.includes(status)) {
    throw AppError.conflict(
      status === CLINICAL_VERIFICATION_STATUS.REJECTED
        ? 'Order was rejected at pharmacist clinical verification — it cannot progress'
        : 'Pharmacist clinical verification is required before this order can progress',
      'PHARMACY_VERIFICATION_REQUIRED',
      { clinical_verification_status: status, verify_endpoint: `/api/v1/pharmacy/orders/${orderId}/verify` },
    );
  }
  return { enforced: true, status };
}

/**
 * Run pharmacist clinical verification on a pharmacy order.
 *
 * decision:
 *   'verified' — only allowed when the safety engine reports no blockers.
 *   'override' — blockers acknowledged; requires overrideReason (≥10 chars).
 *   'rejected' — pharmacist refuses the order (sends it back to prescriber).
 */
export async function verifyOrder(orderId, {
  decision = CLINICAL_VERIFICATION_STATUS.VERIFIED,
  overrideReason = null,
  notes = null,
  actorUid = null,
  actorRole = null,
} = {}) {
  // Phase 0 — pre-flight.
  if (!Object.values(CLINICAL_VERIFICATION_STATUS).includes(decision)
    || decision === CLINICAL_VERIFICATION_STATUS.PENDING) {
    throw AppError.badRequest('decision must be verified|override|rejected', 'PHARMACY_VERIFY_BAD_DECISION');
  }
  const order = await loadOrder(orderId);
  if (!order) throw AppError.notFound('Pharmacy order not found');
  if (!VERIFIABLE_ORDER_STATUSES.includes(order.status)) {
    throw AppError.conflict(
      `Order is ${order.status} — clinical verification happens before preparation/dispense`,
      'PHARMACY_VERIFY_WRONG_STATUS',
      { status: order.status },
    );
  }
  const medications = orderItemsToMedications(order.items_list);
  if (medications.length === 0) {
    throw AppError.conflict(
      'Order has no structured item list yet — confirm the order (capturing items) before verification',
      'PHARMACY_VERIFY_NO_ITEMS',
    );
  }

  // Safety evaluation: full engine when the order is linked to a patient
  // record; KB-only (interactions/dose) for unlinked walk-ins.
  let safety;
  let patientContext = false;
  if (order.patient_id) {
    patientContext = true;
    safety = await validatePrescriptionSafety(order.patient_id, medications);
  } else {
    const kb = await evaluateDrugKb({ medications });
    safety = {
      safe: !kb.findings.some((f) => ['contraindicated', 'major', 'high'].includes(f.severity)),
      warnings: kb.findings.filter((f) => !['contraindicated', 'major', 'high'].includes(f.severity))
        .map((f) => ({ type: 'DRUG_KB_FINDING', severity: String(f.severity).toUpperCase(), message: f.message })),
      blockers: kb.findings.filter((f) => ['contraindicated', 'major', 'high'].includes(f.severity))
        .map((f) => ({ type: 'DRUG_KB_FINDING', severity: String(f.severity).toUpperCase(), message: f.message })),
    };
  }

  const trimmedReason = (overrideReason || '').trim();
  if (decision === CLINICAL_VERIFICATION_STATUS.VERIFIED && safety.blockers.length > 0) {
    throw AppError.conflict(
      `Safety engine reports ${safety.blockers.length} blocker(s) — verify is not allowed; use decision=override with a reason, or reject`,
      'PHARMACY_VERIFY_BLOCKERS_PRESENT',
      { blockers: safety.blockers, warnings: safety.warnings },
    );
  }
  if (decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE && trimmedReason.length < MIN_OVERRIDE_REASON_LENGTH) {
    throw AppError.badRequest(
      `override requires a reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters`,
      'PHARMACY_VERIFY_OVERRIDE_REASON_REQUIRED',
    );
  }

  const findings = [
    ...safety.blockers.map((b) => ({ ...b, disposition: 'blocker' })),
    ...safety.warnings.map((w) => ({ ...w, disposition: 'warning' })),
  ];

  // Phase 1 — atomic verdict + safety reviews + canonical event.
  const updated = await setTenantTx(order.tenant_id || DEFAULT_TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_orders SET
         clinical_verification_status = $2,
         clinically_verified_by = $3::uuid,
         clinically_verified_at = NOW(),
         clinical_verification_notes = $4,
         clinical_verification_findings = $5::jsonb,
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, order_number, status, patient_id, patient_name, tenant_id,
                 clinical_verification_status, clinically_verified_by,
                 clinically_verified_at, clinical_verification_notes, pack_barcode`,
      orderId,
      decision,
      actorUid,
      [notes, decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE ? `OVERRIDE: ${trimmedReason}` : null]
        .filter(Boolean).join(' | ') || null,
      JSON.stringify({
        patient_context: patientContext,
        blockers: safety.blockers,
        warnings: safety.warnings,
        decided_at: new Date().toISOString(),
      }),
    );
    const row = rows[0];

    if (order.patient_uid && (findings.length > 0 || decision !== CLINICAL_VERIFICATION_STATUS.VERIFIED)) {
      // recordMedicationSafetyReviews consumes the { blockers, warnings }
      // shape directly (one review row per issue; blocked rows flip to
      // 'overridden' when an override reason is supplied).
      await recordMedicationSafetyReviews({
        tenantId: order.tenant_id,
        patientUid: order.patient_uid,
        patientId: order.patient_id,
        safety: { safe: safety.safe, blockers: safety.blockers, warnings: safety.warnings },
        override: decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE
          ? { reason: trimmedReason, approvedBy: actorUid }
          : null,
        actorUid,
      }, { db: tx });
    }

    const eventType = decision === CLINICAL_VERIFICATION_STATUS.VERIFIED ? 'pharmacy.order_clinically_verified'
      : decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE ? 'pharmacy.order_verification_override'
        : 'pharmacy.order_verification_rejected';
    if (order.patient_uid) {
      await recordCanonicalClinicalEvent({
        tenantId: order.tenant_id,
        patientUid: order.patient_uid,
        eventType,
        eventStatus: decision,
        sourceTable: 'pharmacy_orders',
        sourceId: String(orderId),
        resourceType: 'pharmacy_order',
        resourceId: String(orderId),
        actorUid,
        actorRole,
        summary: `Pharmacist verification ${decision} for order ${order.order_number || orderId}` +
          (safety.blockers.length ? ` (${safety.blockers.length} blocker(s))` : ''),
        payload: {
          order_id: orderId,
          order_number: order.order_number || null,
          decision,
          blocker_count: safety.blockers.length,
          warning_count: safety.warnings.length,
          override_reason: decision === CLINICAL_VERIFICATION_STATUS.OVERRIDE ? trimmedReason : null,
          medication_names: medications.map((m) => m.name),
        },
        beforeState: { clinical_verification_status: order.clinical_verification_status },
        afterState: { clinical_verification_status: decision },
        tags: ['pharmacy', 'medication', 'verification'],
        timelineIdempotencyKey: `pharmacy_orders:${orderId}:${eventType}:${Date.now()}`,
        auditIdempotencyKey: `pharmacy_orders:${orderId}:audit:${eventType}:${Date.now()}`,
      }, { db: tx });
    }

    return row;
  });

  logger.info('Pharmacist clinical verification recorded', {
    order_id: orderId, decision, blockers: safety.blockers.length, warnings: safety.warnings.length,
  });

  return {
    order: updated,
    safety: { safe: safety.safe, blockers: safety.blockers, warnings: safety.warnings },
    patient_context: patientContext,
  };
}

/** Generate (idempotently) the platform med-pack barcode for an order. */
export async function ensurePackBarcode(orderId) {
  const token = randomBytes(4).toString('hex').toUpperCase();
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE pharmacy_orders
        SET pack_barcode = COALESCE(pack_barcode, $2),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, pack_barcode`,
    orderId,
    `VHMP-${orderId}-${token}`,
  );
  if (!rows.length) throw AppError.notFound('Pharmacy order not found');
  return rows[0].pack_barcode;
}

/**
 * Printable med-pack label payload. Requires cleared verification when
 * enforcement is on (a pack label is the artefact of a verified dispense).
 */
export async function getPackLabel(orderId) {
  const order = await loadOrder(orderId);
  if (!order) throw AppError.notFound('Pharmacy order not found');
  if (BCMA_CONFIG.requirePharmacistVerification
    && !VERIFICATION_CLEARED_STATUSES.includes(order.clinical_verification_status)) {
    throw AppError.conflict(
      'Pharmacist clinical verification is required before printing the pack label',
      'PHARMACY_VERIFICATION_REQUIRED',
      { clinical_verification_status: order.clinical_verification_status },
    );
  }
  const packBarcode = order.pack_barcode || await ensurePackBarcode(orderId);
  return {
    order_id: order.id,
    order_number: order.order_number || null,
    pack_barcode: packBarcode,
    patient: {
      id: order.patient_id || null,
      uid: order.patient_uid || null,
      name: order.patient_name || null,
    },
    items: orderItemsToMedications(order.items_list),
    verification: {
      status: order.clinical_verification_status,
      verified_by: order.clinically_verified_by || null,
      verified_at: order.clinically_verified_at || null,
    },
    generated_at: new Date().toISOString(),
  };
}

export default {
  verifyOrder,
  assertVerificationCleared,
  ensurePackBarcode,
  getPackLabel,
  orderItemsToMedications,
};
