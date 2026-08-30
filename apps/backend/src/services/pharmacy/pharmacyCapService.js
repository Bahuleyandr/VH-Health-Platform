// src/services/pharmacy/pharmacyCapService.js
//
// TPA pharmacy-cap probe at dispense time.
// See finding 2026-05-09-tpa-insurance-claim-billing-pharmacy-cap-not-enforced.
//
// The legacy pharmacy dispense paths (markCounterDispensed,
// markDelivered) decremented stock and stamped DELIVERED with zero
// awareness of the patient's TPA pharmacy cap. For an admitted patient
// whose insurer approved (say) INR 15,000 for pharmacy, staff could
// silently dispense INR 20,000 worth of medicines; the overshoot only
// surfaced at discharge reconciliation, by which time the medicines
// were already gone and the hospital had to write off the gap.
//
// Probe shape:
//   - No active admission ⇒ unscoped (walk-in / OPD). Skip the cap.
//   - Admission has no TPA claim or preauth ⇒ no cap to enforce.
//   - Admission has cap data ⇒ compute current pharmacy spend +
//     proposed dispense; return { level: 'ok'|'warn'|'critical' }.
//
// Phase 1 = hard block at level='critical' unless allowOverride.
// Phase 1.5 = warn at level='warn' (caller logs; we do not block).

import { createHash } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { clinicalOrderItemsSha256 } from './pharmacistVerificationService.js';

export const PHARMACY_CAP_WARN_PCT = 80;
export const PHARMACY_CAP_CRITICAL_PCT = 100;

const CAP_RESERVATION_ROLES = new Set([
  'PHARMACY_STAFF', 'PHARMACIST', 'PHARMACY_INCHARGE',
  'DELIVERY_STAFF',
  'BILLING_INCHARGE', 'FINANCE_INCHARGE', 'ADMIN', 'SUPER_ADMIN',
]);
const CAP_RELEASE_ROLES = new Set([
  'PHARMACY_STAFF', 'PHARMACIST', 'PHARMACY_INCHARGE',
  'BILLING_INCHARGE', 'FINANCE_INCHARGE',
  'INSURANCE_COORDINATOR', 'CLAIMS_MANAGER',
  'ADMIN', 'SUPER_ADMIN',
]);

function canonicalCapEvidence(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalCapEvidence);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalCapEvidence(value[key])]),
    );
  }
  return value;
}

function sameCapEvidence(left, right) {
  return JSON.stringify(canonicalCapEvidence(left))
    === JSON.stringify(canonicalCapEvidence(right));
}

function capReservationResponse(row) {
  return canonicalCapEvidence({
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    facility_id: Number(row.facility_id),
    pharmacy_order_id: Number(row.pharmacy_order_id),
    admission_id: Number(row.admission_id),
    reserved_amount: Number(row.reserved_amount),
    funding_source: row.funding_source ?? null,
    funding_reference: row.funding_reference ?? null,
    funding_tpa_claim_id: row.funding_tpa_claim_id == null
      ? null : Number(row.funding_tpa_claim_id),
    authorised_funding_amount: Number(row.authorised_funding_amount || 0),
    status: String(row.status),
    command_key_sha256: String(row.command_key_sha256),
    authority_evidence: row.authority_evidence || {},
    reserved_by: String(row.reserved_by),
    released_by: row.released_by == null ? null : String(row.released_by),
    released_at: row.released_at ?? null,
    release_reason: row.release_reason ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  });
}

export async function resolvePharmacyFundingPatientUidTx(tx, {
  tenantId,
  orderId = null,
  admissionId = null,
  patientId = null,
  patientUid = null,
}) {
  const tid = requireTenantId(tenantId);
  if (orderId == null && admissionId == null && patientId == null && patientUid == null) {
    throw AppError.badRequest(
      'At least one patient, order, or admission identity is required',
      'PHARMACY_FUNDING_PATIENT_IDENTITY_REQUIRED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT patient.uid
       FROM users patient
      WHERE patient.tenant_id=$1::uuid AND patient.role='PATIENT'
        AND patient.is_active=TRUE AND patient.status='active'
        AND patient.is_deleted=FALSE AND patient.merged_into_uid IS NULL
        AND ($2::int IS NULL OR patient.id=$2::int)
        AND ($3::uuid IS NULL OR patient.uid=$3::uuid)
        AND (
          $4::int IS NULL OR EXISTS (
            SELECT 1 FROM pharmacy_orders pharmacy_order
             WHERE pharmacy_order.tenant_id=patient.tenant_id
               AND pharmacy_order.id=$4::int
               AND pharmacy_order.patient_id=patient.id
          )
        )
        AND (
          $5::int IS NULL OR EXISTS (
            SELECT 1 FROM admissions admission
             WHERE admission.tenant_id=patient.tenant_id
               AND admission.id=$5::int
               AND admission.patient_uid=patient.uid
          )
        )
      LIMIT 2`,
    tid,
    patientId == null ? null : Number(patientId),
    patientUid == null ? null : String(patientUid),
    orderId == null ? null : Number(orderId),
    admissionId == null ? null : Number(admissionId),
  );
  if (rows.length !== 1 || !rows[0].uid) {
    throw AppError.conflict(
      'The supplied funding identities do not resolve to one active tenant patient',
      'PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH',
    );
  }
  return String(rows[0].uid);
}

export async function lockPharmacyFundingAuthorityTx(tx, { tenantId, patientUid }) {
  const tid = requireTenantId(tenantId);
  const uid = String(patientUid || '').trim();
  if (!uid) {
    throw AppError.badRequest(
      'A canonical patient UID is required for funding serialization',
      'PHARMACY_FUNDING_PATIENT_IDENTITY_REQUIRED',
    );
  }
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(
         'vh:pharmacy_funding_authority:' || $1::uuid::text || ':' || $2::uuid::text,
         753
       )
     )::text AS lock_acquired`,
    tid,
    uid,
  );
  return { tenantId: tid, patientUid: uid };
}

export async function lockPharmacyFundingAdmissionTx(tx, {
  tenantId,
  admissionId,
  patientUid,
}) {
  const tid = requireTenantId(tenantId);
  const id = Number(admissionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest(
      'admissionId must be a positive integer',
      'PHARMACY_FUNDING_ADMISSION_REQUIRED',
    );
  }
  const uid = String(patientUid || '').trim();
  await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid: uid });
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, status
       FROM admissions
      WHERE tenant_id=$1::uuid AND id=$2::int AND patient_uid=$3::uuid
      FOR UPDATE`,
    tid,
    id,
    uid,
  );
  if (!rows.length) {
    throw AppError.conflict(
      'The admission no longer belongs to the locked funding patient',
      'PHARMACY_FUNDING_ADMISSION_PATIENT_MISMATCH',
    );
  }
  return rows[0];
}

async function assertCapActorTx(tx, { tenantId, actorUid, actorRole, allowedRoles }) {
  const uid = String(actorUid || '').trim();
  const assertedRole = String(actorRole || '').trim().toUpperCase() || null;
  if (!uid) {
    throw AppError.forbidden(
      'The authenticated role cannot mutate pharmacy-cap authority',
      'TPA_PHARMACY_CAP_ACTOR_FORBIDDEN',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, UPPER(role) AS role
       FROM users
      WHERE tenant_id=$1::uuid AND uid=$2::uuid
        AND is_active=TRUE AND status='active' AND is_deleted=FALSE
        AND merged_into_uid IS NULL
      FOR KEY SHARE`,
    requireTenantId(tenantId),
    uid,
  );
  const durableRole = rows.length ? String(rows[0].role).toUpperCase() : null;
  if (!durableRole || !allowedRoles.has(durableRole)
      || (assertedRole != null && assertedRole !== durableRole)) {
    throw AppError.forbidden(
      'The cap actor identity and role do not match an active tenant user',
      'TPA_PHARMACY_CAP_ACTOR_FORBIDDEN',
    );
  }
  return { uid, role: durableRole };
}

/**
 * @param {Object} args
 * @param {number} [args.patientId]   pharmacy_orders.patient_id (int FK to users.id)
 * @param {string} [args.patientUid]  alternate entry — users.uid
 * @param {number} args.additionalAmount  rupees the caller is about to dispense
 * @returns {Promise<{
 *   hasCap: boolean,
 *   admissionId: number|null,
 *   pharmacyCap: number|null,
 *   currentSpend: number,
 *   projectedTotal: number,
 *   utilisationPct: number,
 *   level: 'ok'|'warn'|'critical',
 *   message: string|null,
 * }>}
 */
export async function probePharmacyCap({
  tenantId, patientId, patientUid, admissionId = null, tpaClaimId = null,
  additionalAmount = 0,
}) {
  return probePharmacyCapWithDb(prisma, {
    tenantId,
    patientId,
    patientUid,
    exactAdmissionId: admissionId,
    exactFundingTpaClaimId: tpaClaimId,
    additionalAmount,
    lockAdmission: false,
  });
}

export async function probePharmacyCapTx(tx, {
  tenantId, patientId, patientUid, additionalAmount = 0, currentOrderId = null,
  admissionId = null, fundingTpaClaimId = null,
}) {
  const canonicalPatientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId,
    orderId: currentOrderId,
    patientId,
    patientUid,
  });
  await lockPharmacyFundingAuthorityTx(tx, { tenantId, patientUid: canonicalPatientUid });
  return probePharmacyCapWithDb(tx, {
    tenantId,
    patientId,
    patientUid: canonicalPatientUid,
    additionalAmount,
    currentOrderId,
    exactAdmissionId: admissionId,
    exactFundingTpaClaimId: fundingTpaClaimId,
    lockAdmission: true,
  });
}

export async function assertPharmacyCapForDispenseTx(tx, {
  tenantId,
  patientId,
  patientUid,
  additionalAmount,
  allowOverride = false,
  orderId = null,
  facilityId = null,
  actorUid = null,
  actorRole = null,
  commandKeySha256 = null,
  fundingSource = null,
  fundingReference = null,
  fundingTpaClaimId = null,
  authorisedFundingAmount = 0,
}) {
  const probe = await probePharmacyCapTx(tx, {
    tenantId,
    patientId,
    patientUid,
    additionalAmount,
    currentOrderId: orderId,
    fundingTpaClaimId,
  });
  if (shouldBlockDispense(probe, { allowOverride })) {
    throw AppError.badRequest(
      probe.message,
      'TPA_PHARMACY_CAP_EXCEEDED',
      {
        cap_amount: probe.pharmacyCap,
        current_spend: probe.currentSpend,
        projected_total: probe.projectedTotal,
        utilisation_pct: probe.utilisationPct,
      },
    );
  }
  if (probe.hasCap) {
    if (!orderId || !facilityId || !actorUid || !commandKeySha256) {
      throw AppError.conflict(
        'A durable pharmacy-cap reservation requires exact order, facility, actor, and command identity',
        'TPA_PHARMACY_CAP_RESERVATION_AUTHORITY_REQUIRED',
      );
    }
    await reservePharmacyCapReservationTx(tx, {
      tenantId,
      facilityId,
      orderId,
      admissionId: probe.admissionId,
      reservedAmount: additionalAmount,
      fundingSource,
      fundingReference,
      fundingTpaClaimId,
      authorisedFundingAmount,
      actorUid,
      actorRole,
      commandKeySha256,
      authorityEvidence: {},
    });
  }
  return probe;
}

export async function resolveAuthoritativeCounterFundingTx(tx, {
  tenantId,
  patientId,
  orderId,
  paymentMode,
  totalAmount,
  orderVersion,
  orderItemsSha256,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = Number(orderId);
  const exactPatientId = Number(patientId);
  const exactAmount = Number(totalAmount);
  const exactVersion = Number(orderVersion);
  const exactItemsSha256 = String(orderItemsSha256 || '').trim().toLowerCase();
  const suppliedMode = String(paymentMode || '').trim().toLowerCase();
  if (!Number.isInteger(exactOrderId) || exactOrderId <= 0
      || !Number.isInteger(exactPatientId) || exactPatientId <= 0
      || !Number.isFinite(exactAmount) || exactAmount < 0
      || !Number.isInteger(exactVersion) || exactVersion <= 0
      || !/^[0-9a-f]{64}$/.test(exactItemsSha256)
      || !suppliedMode) {
    throw AppError.badRequest(
      'Exact order, patient, amount, version, item hash, and payment mode are required',
      'COUNTER_FUNDING_AUTHORITY_REQUIRED',
    );
  }
  const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
    patientId: exactPatientId,
  });
  await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       'vh:pharmacy_funding_event_chain:' || $1::uuid::text || ':'
         || $2::int::text || ':' || $3::int::text || ':' || $4,
       753
     ))::text AS lock_acquired`,
    tid,
    exactOrderId,
    exactVersion,
    exactItemsSha256,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT event.id AS funding_event_id,event.admission_id,event.invoice_id,
            event.invoice_item_id,event.tpa_claim_id,event.task_id,event.amount,
            event.evidence,event.command_key_sha256,
            pharmacy_order.facility_id,pharmacy_order.total_amount,
            pharmacy_order.inventory_authority_version,pharmacy_order.items_list,
            pharmacy_order.payment_mode,pharmacy_order.payment_metadata,
            pharmacy_order.funding_admission_id,pharmacy_order.status,
            invoice.patient_uid,invoice.admission_id AS invoice_admission_id,
            invoice.status AS invoice_status,item.line_total,item.source_authority_version,
            item.source_authority_sha256
       FROM pharmacy_funding_decision_events event
       JOIN pharmacy_orders pharmacy_order
         ON pharmacy_order.tenant_id=event.tenant_id
        AND pharmacy_order.id=event.pharmacy_order_id
       JOIN users patient
         ON patient.tenant_id=pharmacy_order.tenant_id
        AND patient.id=pharmacy_order.patient_id AND patient.uid=$4::uuid
        AND patient.role='PATIENT' AND patient.is_active=TRUE
        AND patient.status='active' AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
       JOIN billing_invoice_items item
         ON item.tenant_id=event.tenant_id AND item.id=event.invoice_item_id
        AND item.invoice_id=event.invoice_id
       JOIN billing_invoices invoice
         ON invoice.tenant_id=item.tenant_id AND invoice.id=item.invoice_id
      WHERE event.tenant_id=$1::uuid AND event.pharmacy_order_id=$2::int
        AND pharmacy_order.patient_id=$3::int
        AND event.event_type='FUNDING_RESOLVED'
        AND event.authority_generation IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_funding_decision_events successor
           WHERE successor.tenant_id=event.tenant_id
             AND successor.supersedes_event_id=event.id
        )
        AND event.source_authority_version=$5::int
        AND event.source_authority_sha256=$6
        AND item.source_ref_type='pharmacy_order'
        AND item.source_ref_id=pharmacy_order.id::bigint
        AND item.source_ref_active=TRUE
        AND item.source_authority_version=event.source_authority_version
        AND item.source_authority_sha256=event.source_authority_sha256
        AND invoice.patient_uid=patient.uid
        AND invoice.admission_id IS NOT DISTINCT FROM event.admission_id
        AND pharmacy_order.funding_admission_id IS NOT DISTINCT FROM event.admission_id
      ORDER BY event.recorded_at DESC,event.id DESC
      FOR UPDATE OF pharmacy_order,item,invoice`,
    tid,
    exactOrderId,
    exactPatientId,
    patientUid,
    exactVersion,
    exactItemsSha256,
  );
  const orderRows = rows;
  if (orderRows.length === 0) {
    const recoveryRows = await tx.$queryRawUnsafe(
      `SELECT task.id AS task_id,task.status,task.assigned_to_role,task.metadata,
              item.id AS invoice_item_id
         FROM tasks task
         LEFT JOIN billing_invoice_items item
           ON item.tenant_id=task.tenant_id
          AND item.id=(task.metadata->>'invoice_item_id')::int
        WHERE task.tenant_id=$1::uuid
          AND task.related_resource_id=$2
          AND task.related_resource_type IN ('pharmacy_tpa_line_decision','pharmacy_posted_payment')
          AND task.status IN ('open','in_progress','blocked','overdue')
        ORDER BY task.id DESC
        LIMIT 2
        FOR UPDATE OF task`,
      tid,
      String(exactOrderId),
    );
    const recovery = recoveryRows.length === 1 ? recoveryRows[0] : null;
    throw AppError.conflict(
      'No durable posted-payment and TPA authority resolves the exact pharmacy order version',
      'COUNTER_FUNDING_POSTED_AUTHORITY_REQUIRED',
      {
        next_action: recovery ? 'open_exact_pharmacy_funding_task' : 'materialize_pharmacy_funding',
        materialize_path: `/api/v1/billing/v2/pharmacy-funding/orders/${exactOrderId}/materialize`,
        funding_recovery: recovery ? {
          task_id: Number(recovery.task_id),
          status: String(recovery.status).toLowerCase(),
          owner_role: recovery.assigned_to_role,
          pharmacy_order_id: exactOrderId,
          invoice_item_id: Number(recovery.invoice_item_id),
          tpa_claim_id: recovery.metadata?.tpa_claim_id == null
            ? null : Number(recovery.metadata.tpa_claim_id),
          order_version: Number(recovery.metadata?.order_version),
          order_items_sha256: recovery.metadata?.order_items_sha256,
          deep_link: recovery.metadata?.action_url,
        } : null,
      },
    );
  }
  const activeFundingTargets = new Set(orderRows.map((row) => (
    `${Number(row.invoice_id)}:${Number(row.invoice_item_id)}`
  )));
  if (activeFundingTargets.size !== 1) {
    throw AppError.conflict(
      'More than one active invoice line claims the current pharmacy order authority',
      'COUNTER_FUNDING_LINE_AUTHORITY_AMBIGUOUS',
    );
  }
  const currentOrderAuthority = orderRows[0];
  const canonicalItemsSha256 = clinicalOrderItemsSha256(currentOrderAuthority.items_list);
  const durableMode = String(
    currentOrderAuthority.payment_mode
      || currentOrderAuthority.payment_metadata?.payment_mode
      || '',
  ).trim().toLowerCase();
  const actionableStatuses = new Set([
    'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED', 'PARTIALLY_DISPENSED',
  ]);
  if (!actionableStatuses.has(String(currentOrderAuthority.status || '').toUpperCase())
      || Number(currentOrderAuthority.inventory_authority_version) !== exactVersion
      || canonicalItemsSha256 !== exactItemsSha256
      || Math.abs(Number(currentOrderAuthority.total_amount || 0) - exactAmount) > 0.001
      || Math.abs(Number(currentOrderAuthority.line_total || 0) - exactAmount) > 0.001
      || durableMode !== suppliedMode
      || String(currentOrderAuthority.patient_uid) !== patientUid
      || String(currentOrderAuthority.source_authority_sha256) !== exactItemsSha256
      || Number(currentOrderAuthority.source_authority_version) !== exactVersion) {
    throw AppError.conflict(
      'The durable funding event is stale relative to the exact order, invoice, or line authority',
      'COUNTER_FUNDING_AUTHORITY_STALE',
    );
  }
  if (currentOrderAuthority.admission_id != null) {
    await lockPharmacyFundingAdmissionTx(tx, {
      tenantId: tid,
      admissionId: Number(currentOrderAuthority.admission_id),
      patientUid,
    });
  }
  const allocationRows = await tx.$queryRawUnsafe(
    `SELECT allocation.id AS allocation_id,allocation.billing_payment_id,
            (allocation.allocated_amount-COALESCE(SUM(reversal.reversed_amount),0))::numeric
              AS net_amount
       FROM pharmacy_payment_allocations allocation
       JOIN billing_payments payment
         ON payment.tenant_id=allocation.tenant_id
        AND payment.id=allocation.billing_payment_id
        AND payment.invoice_id=allocation.invoice_id
        AND payment.patient_uid=$7::uuid AND payment.reversed=FALSE
       LEFT JOIN pharmacy_payment_allocation_reversals reversal
         ON reversal.tenant_id=allocation.tenant_id
        AND reversal.allocation_id=allocation.id
      WHERE allocation.tenant_id=$1::uuid
        AND allocation.pharmacy_order_id=$2::int
        AND allocation.invoice_id=$3::int
        AND allocation.invoice_item_id=$4::int
        AND allocation.source_authority_version=$5::int
        AND allocation.source_authority_sha256=$6
      GROUP BY allocation.id,allocation.billing_payment_id,allocation.allocated_amount
      HAVING allocation.allocated_amount-COALESCE(SUM(reversal.reversed_amount),0)>0.001
      ORDER BY allocation.id`,
    tid,
    exactOrderId,
    Number(currentOrderAuthority.invoice_id),
    Number(currentOrderAuthority.invoice_item_id),
    exactVersion,
    exactItemsSha256,
    patientUid,
  );
  const allocatedAmount = Number(allocationRows
    .reduce((sum, allocation) => sum + Number(allocation.net_amount || 0), 0)
    .toFixed(2));
  const decisionRows = await tx.$queryRawUnsafe(
    `SELECT decision.approved_amount,decision.id AS decision_id,claim.id AS claim_id
       FROM tpa_claim_line_decisions decision
       JOIN tpa_claims claim
         ON claim.tenant_id=decision.tenant_id AND claim.id=decision.claim_id
        AND claim.invoice_id=$2::int
        AND claim.admission_id IS NOT DISTINCT FROM $3::int
        AND claim.patient_uid=$4::uuid
        AND claim.status IN ('approved','partially_approved','paid')
      WHERE decision.tenant_id=$1::uuid
        AND decision.invoice_item_id=$5::int AND decision.invalidated_at IS NULL
        AND decision.source_authority_version=$6::int
        AND decision.source_authority_sha256=$7
      ORDER BY decision.id
      FOR UPDATE OF claim,decision`,
    tid,
    Number(currentOrderAuthority.invoice_id),
    currentOrderAuthority.admission_id == null
      ? null : Number(currentOrderAuthority.admission_id),
    patientUid,
    Number(currentOrderAuthority.invoice_item_id),
    exactVersion,
    exactItemsSha256,
  );
  if (decisionRows.length > 1) {
    throw AppError.conflict(
      'More than one live TPA decision claims the current pharmacy authority',
      'COUNTER_FUNDING_TPA_AUTHORITY_AMBIGUOUS',
    );
  }
  const currentDecision = decisionRows[0] || null;
  const approvedTpaAmount = Number(currentDecision?.approved_amount || 0);
  const combinedAuthority = Number((approvedTpaAmount + allocatedAmount).toFixed(2));
  const paymentIds = allocationRows.map((allocation) => Number(allocation.billing_payment_id));
  if (combinedAuthority + 0.001 < exactAmount) {
    throw AppError.conflict(
      'Posted funding was reversed or changed after its durable authority event',
      'COUNTER_FUNDING_POSTED_AUTHORITY_STALE',
    );
  }
  const currentTpaClaimId = currentDecision == null ? null : Number(currentDecision.claim_id);
  const matchingEvents = orderRows.filter((candidate) => {
    const evidence = candidate.evidence || {};
    const evidencePaymentIds = (evidence.payment_ids || []).map(Number);
    const candidateTpaClaimId = candidate.tpa_claim_id == null
      ? null : Number(candidate.tpa_claim_id);
    const evidenceTpaClaimId = evidence.tpa_claim_id == null
      ? null : Number(evidence.tpa_claim_id);
    return Math.abs(Number(candidate.amount || 0) - exactAmount) <= 0.001
      && candidateTpaClaimId === currentTpaClaimId
      && evidenceTpaClaimId === currentTpaClaimId
      && evidence.contract === 'pharmacy_funding_authority_v1'
      && Number(evidence.pharmacy_order_id) === exactOrderId
      && Number(evidence.invoice_id) === Number(candidate.invoice_id)
      && Number(evidence.invoice_item_id) === Number(candidate.invoice_item_id)
      && Number(evidence.order_version) === exactVersion
      && String(evidence.order_items_sha256) === exactItemsSha256
      && Math.abs(Number(evidence.authoritative_amount || 0) - exactAmount) <= 0.001
      && Math.abs(Number(evidence.approved_tpa_amount || 0) - approvedTpaAmount) <= 0.001
      && Math.abs(Number(evidence.allocated_payment_amount || 0) - allocatedAmount) <= 0.001
      && Math.abs(Number(evidence.combined_authority_amount || 0) - combinedAuthority) <= 0.001
      && JSON.stringify(evidencePaymentIds) === JSON.stringify(paymentIds);
  });
  if (matchingEvents.length !== 1) {
    throw AppError.conflict(
      'No single durable funding event matches the current live payment and TPA authority',
      'COUNTER_FUNDING_CURRENT_AUTHORITY_AMBIGUOUS',
    );
  }
  const authority = matchingEvents[0];
  const tpaFunded = authority.tpa_claim_id != null;
  const fundingSource = tpaFunded && allocatedAmount > 0.001
    ? 'mixed'
    : tpaFunded ? 'tpa_claim' : 'billing_payment';
  return {
    collectedAmount: allocatedAmount,
    fundedAmount: exactAmount,
    fundingSource,
    fundingReference: [
      tpaFunded ? `tpa:${Number(authority.tpa_claim_id)}` : null,
      paymentIds.length ? `payments:${paymentIds.join(',')}` : null,
    ].filter(Boolean).join(';'),
    fundingTpaClaimId: tpaFunded ? Number(authority.tpa_claim_id) : null,
    invoiceId: Number(authority.invoice_id),
    invoiceItemId: Number(authority.invoice_item_id),
    paymentIds,
    orderVersion: exactVersion,
    orderItemsSha256: exactItemsSha256,
    fundingEventId: Number(authority.funding_event_id),
    authorityEvidence: authority.evidence,
  };
}

async function probePharmacyCapWithDb(db, {
  tenantId, patientId, patientUid, additionalAmount = 0, lockAdmission = false,
  currentOrderId = null, exactAdmissionId = null, exactFundingTpaClaimId = null,
}) {
  const tid = requireTenantId(tenantId);
  const extra = Math.max(0, Number(additionalAmount) || 0);
  const noCap = {
    hasCap: false,
    admissionId: null,
    pharmacyCap: null,
    currentSpend: 0,
    projectedTotal: extra,
    utilisationPct: 0,
    level: 'ok',
    message: null,
  };
  if (!patientId && !patientUid) return noCap;

  // Resolve the patient identity under an explicit tenant predicate even when
  // the caller already has a uid. Cap enforcement must not depend on ambient
  // RLS or admit a cross-tenant patient reference.
  const identityRows = await db.$queryRawUnsafe(
    `SELECT id,uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND role = 'PATIENT'
        AND is_active=TRUE AND status='active' AND is_deleted=FALSE
        AND merged_into_uid IS NULL
        AND ($2::int IS NULL OR id = $2::int)
        AND ($3::uuid IS NULL OR uid = $3::uuid)
      LIMIT 2`,
    tid,
    patientId ? Number(patientId) : null,
    patientUid ? String(patientUid) : null,
  );
  if (identityRows.length !== 1 || !identityRows[0].uid) {
    throw AppError.conflict(
      'The supplied pharmacy patient identities do not resolve to one exact tenant patient',
      'PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH',
    );
  }
  const uid = String(identityRows[0].uid);

  let admissionId = exactAdmissionId == null ? null : Number(exactAdmissionId);
  if (currentOrderId != null) {
    const orderRows = await db.$queryRawUnsafe(
      `SELECT id,patient_id,uid,inventory_authority_version,items_list,
              funding_admission_id,funding_admission_order_version,
              funding_admission_items_sha256
         FROM pharmacy_orders
        WHERE tenant_id=$1::uuid AND id=$2::int AND patient_id=$3::int
          AND (uid IS NULL OR uid=$4::uuid)
        ${lockAdmission ? 'FOR UPDATE' : ''}`,
      tid,
      Number(currentOrderId),
      Number(identityRows[0].id || patientId),
      uid,
    );
    if (!orderRows.length) {
      throw AppError.conflict(
        'The cap probe order no longer belongs to the locked tenant patient',
        'TPA_PHARMACY_CAP_ORDER_SCOPE_MISMATCH',
      );
    }
    const order = orderRows[0];
    if (order.funding_admission_id == null) {
      if (exactFundingTpaClaimId != null) {
        throw AppError.conflict(
          'TPA cap authority requires the order to be pinned to an exact admission',
          'TPA_PHARMACY_CAP_ADMISSION_REQUIRED',
        );
      }
      return noCap;
    }
    const canonicalItemsSha256 = clinicalOrderItemsSha256(order.items_list);
    if (Number(order.funding_admission_order_version) !== Number(order.inventory_authority_version)
        || String(order.funding_admission_items_sha256) !== canonicalItemsSha256) {
      throw AppError.conflict(
        'The order-to-admission cap authority is stale for the current order version',
        'TPA_PHARMACY_CAP_ORDER_AUTHORITY_STALE',
      );
    }
    admissionId = Number(order.funding_admission_id);
    if (exactAdmissionId != null && admissionId !== Number(exactAdmissionId)) {
      throw AppError.conflict(
        'The supplied admission does not match the order funding admission',
        'TPA_PHARMACY_CAP_ADMISSION_MISMATCH',
      );
    }
  }
  if (!Number.isInteger(admissionId) || admissionId <= 0) return noCap;
  if (lockAdmission) {
    await lockPharmacyFundingAdmissionTx(db, {
      tenantId: tid,
      admissionId,
      patientUid: uid,
    });
  } else {
    const admRows = await db.$queryRawUnsafe(
      `SELECT id FROM admissions
        WHERE tenant_id=$1::uuid AND id=$2::int AND patient_uid=$3::uuid
          AND status='admitted'`,
      tid,
      admissionId,
      uid,
    );
    if (!admRows.length) {
      throw AppError.conflict(
        'The exact cap admission is not active for the tenant patient',
        'TPA_PHARMACY_CAP_ADMISSION_PATIENT_MISMATCH',
      );
    }
  }

  if (exactFundingTpaClaimId == null) return { ...noCap, admissionId };
  const pharmacyCap = await resolvePharmacyCap(
    db,
    admissionId,
    tid,
    Number(exactFundingTpaClaimId),
    uid,
  );
  if (pharmacyCap == null) return { ...noCap, admissionId };

  const billedSpend = await sumAdmissionPharmacySpend(
    db,
    admissionId,
    tid,
    currentOrderId,
  );
  const reservedSpend = await sumAdmissionPharmacyReservations(
    db,
    admissionId,
    tid,
    currentOrderId,
  );
  const currentSpend = billedSpend + reservedSpend;
  const projectedTotal = currentSpend + extra;
  const utilisationPct = pharmacyCap > 0
    ? Math.round((projectedTotal / pharmacyCap) * 1000) / 10
    : projectedTotal > 0 ? 100 : 0;

  let level = 'ok';
  if (utilisationPct >= PHARMACY_CAP_CRITICAL_PCT) level = 'critical';
  else if (utilisationPct >= PHARMACY_CAP_WARN_PCT) level = 'warn';

  const message = level === 'critical'
    ? `Pharmacy dispense would push admission ${admissionId} to INR ${projectedTotal.toFixed(2)} ` +
      `against TPA pharmacy cap INR ${pharmacyCap.toFixed(2)} (${utilisationPct}%). ` +
      `Collect patient liability or raise enhancement preauth before continuing.`
    : level === 'warn'
      ? `Pharmacy dispense will reach INR ${projectedTotal.toFixed(2)} of the ` +
        `INR ${pharmacyCap.toFixed(2)} TPA pharmacy cap (${utilisationPct}%). ` +
        `Warn patient + consider enhancement preauth.`
      : null;

  return {
    hasCap: true,
    admissionId,
    tpaClaimId: Number(exactFundingTpaClaimId),
    pharmacyCap,
    currentSpend,
    projectedTotal,
    utilisationPct,
    level,
    message,
  };
}

/**
 * Resolve the live pharmacy cap (INR) for an admission, checking the
 * structured caps table first (insurance_claim_caps, category='pharmacy'),
 * then falling back to the latest preauth response's raw_response.caps.
 * Returns null when no pharmacy cap is set for this admission.
 */
async function resolvePharmacyCap(db, admissionId, tenantId, tpaClaimId, patientUid) {
  // 1. Structured cap on the admission's TPA claim (insurance_claim_caps).
  const capRows = await db.$queryRawUnsafe(
    `SELECT cap.max_amount
       FROM insurance_claim_caps cap
       JOIN tpa_claims c
         ON c.id = cap.tpa_claim_id
        AND c.tenant_id = cap.tenant_id
       LEFT JOIN insurance_preauth p
         ON p.id = c.preauth_id
        AND p.tenant_id = c.tenant_id
       WHERE c.admission_id = $1::int
         AND c.tenant_id = $2::uuid
         AND c.id = $3::int
         AND c.patient_uid = $4::uuid
         AND cap.tenant_id = $2::uuid
         AND cap.category = 'pharmacy'
         AND c.status IN ('approved', 'partially_approved', 'paid')
         AND (
           p.id IS NULL
           OR (
             p.status IN ('approved', 'partially_approved')
             AND (p.validity_until IS NULL OR p.validity_until >= NOW())
           )
         )
      ORDER BY cap.updated_at DESC, cap.id DESC
      LIMIT 2`,
    Number(admissionId),
    tenantId,
    Number(tpaClaimId),
    String(patientUid),
  );
  if (capRows.length && capRows[0].max_amount != null) {
    return Number(capRows[0].max_amount);
  }
  // 2. Raw cap inside the latest preauth response for this admission.
  const respRows = await db.$queryRawUnsafe(
    `SELECT r.raw_response
       FROM insurance_preauth_responses r
       JOIN insurance_preauth p
         ON p.id = r.preauth_id
        AND p.tenant_id = r.tenant_id
       JOIN tpa_claims c
         ON c.tenant_id=p.tenant_id AND c.preauth_id=p.id
       WHERE p.admission_id = $1::int
         AND p.tenant_id = $2::uuid
         AND c.id = $3::int
         AND c.patient_uid = $4::uuid
         AND r.tenant_id = $2::uuid
         AND p.status IN ('approved', 'partially_approved')
         AND r.response_type IN ('approved', 'partially_approved')
         AND (p.validity_until IS NULL OR p.validity_until >= NOW())
      ORDER BY r.decided_at DESC, r.id DESC
      LIMIT 2`,
    Number(admissionId),
    tenantId,
    Number(tpaClaimId),
    String(patientUid),
  );
  if (!respRows.length) return null;
  return extractPharmacyCapFromRaw(respRows[0].raw_response);
}

/**
 * Pull the pharmacy max_amount out of an insurer raw_response payload.
 * Supports the nested `caps.pharmacy.max_amount` shape and the flat
 * `pharmacy_cap` legacy field. Returns null when no usable number is
 * present. Exported for unit testing.
 */
export function extractPharmacyCapFromRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pharm = raw.caps?.pharmacy?.max_amount ?? raw.pharmacy_cap;
  if (pharm == null) return null;
  const n = Number(pharm);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sum the pharmacy-category line items already billed for this
 * admission. Discounts and refunds are ignored at the dispense check —
 * the cap is gross-of-discount; settlement reconciles later.
 */
async function sumAdmissionPharmacySpend(db, admissionId, tenantId, currentOrderId = null) {
  const rows = await db.$queryRawUnsafe(
    `SELECT COALESCE(SUM(it.line_total), 0)::numeric AS spend
       FROM billing_invoice_items it
       JOIN billing_invoices inv
         ON inv.id = it.invoice_id
        AND inv.tenant_id = it.tenant_id
      WHERE inv.admission_id = $1::int
        AND inv.tenant_id = $2::uuid
        AND it.tenant_id = $2::uuid
        AND inv.status <> 'VOID'
        AND it.category = 'pharmacy'
        AND NOT (
          $3::int IS NOT NULL
          AND it.source_ref_type = 'pharmacy_order'
          AND it.source_ref_active = TRUE
          AND it.source_ref_id = $3::bigint
        )
        AND NOT EXISTS (
         SELECT 1
            FROM pharmacy_cap_reservations reservation
           WHERE reservation.tenant_id = it.tenant_id
             AND reservation.status = 'ACTIVE'
             AND it.source_ref_type = 'pharmacy_order'
             AND it.source_ref_active = TRUE
             AND reservation.pharmacy_order_id::text = it.source_ref_id
        )`,
    Number(admissionId),
    tenantId,
    currentOrderId == null ? null : Number(currentOrderId),
  );
  return Number(rows[0]?.spend ?? 0);
}

async function sumAdmissionPharmacyReservations(db, admissionId, tenantId, currentOrderId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT COALESCE(SUM(reserved_amount), 0)::numeric AS spend
       FROM pharmacy_cap_reservations
      WHERE tenant_id = $1::uuid
        AND admission_id = $2::int
        AND status = 'ACTIVE'
        AND ($3::int IS NULL OR pharmacy_order_id <> $3::int)`,
    tenantId,
    Number(admissionId),
    currentOrderId ? Number(currentOrderId) : null,
  );
  return Number(rows[0]?.spend ?? 0);
}

export async function reservePharmacyCapReservationTx(tx, {
  tenantId,
  facilityId,
  admissionId,
  orderId,
  reservedAmount,
  fundingSource = null,
  fundingReference = null,
  fundingTpaClaimId = null,
  authorisedFundingAmount = 0,
  actorUid,
  actorRole,
  commandKeySha256,
  authorityEvidence = {},
}) {
  const tid = requireTenantId(tenantId);
  const amount = Number(reservedAmount);
  const authorised = Number(authorisedFundingAmount || 0);
  const source = fundingSource == null
    ? null
    : String(fundingSource).trim().toLowerCase();
  const reference = fundingReference == null ? null : String(fundingReference).trim();
  const claimId = fundingTpaClaimId == null ? null : Number(fundingTpaClaimId);
  const command = String(commandKeySha256 || '').trim().toLowerCase();
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(authorised) || authorised < 0
      || authorised > amount + 0.001) {
    throw AppError.badRequest(
      'Reservation and authorised funding amounts must be valid absolute order totals',
      'TPA_PHARMACY_CAP_RESERVATION_AMOUNT_INVALID',
    );
  }
  if (!/^[0-9a-f]{64}$/.test(command)) {
    throw AppError.badRequest(
      'A SHA-256 command identity is required for a cap reservation',
      'TPA_PHARMACY_CAP_COMMAND_REQUIRED',
    );
  }
  if (authorised > 0 && (!['tpa_claim', 'billing_payment', 'mixed'].includes(source)
      || !reference)) {
    throw AppError.conflict(
      'Authorised funding requires durable source and reference evidence',
      'TPA_PHARMACY_CAP_FUNDING_EVIDENCE_REQUIRED',
    );
  }
  if ((source === 'tpa_claim' || source === 'mixed') !== (claimId != null)) {
    throw AppError.conflict(
      'TPA and mixed cap authority require one exact claim; payment-only authority forbids one',
      'TPA_PHARMACY_CAP_CLAIM_AUTHORITY_REQUIRED',
    );
  }
  const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId: tid,
    orderId,
    admissionId,
  });
  await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
  const actor = await assertCapActorTx(tx, {
    tenantId: tid,
    actorUid,
    actorRole,
    allowedRoles: CAP_RESERVATION_ROLES,
  });
  const orderRows = await tx.$queryRawUnsafe(
    `SELECT id,patient_id,uid,facility_id,status,inventory_authority_version,items_list,
            funding_admission_id,funding_admission_order_version,
            funding_admission_items_sha256
       FROM pharmacy_orders
      WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$3::int
      FOR UPDATE`,
    tid,
    Number(orderId),
    Number(facilityId),
  );
  if (!orderRows.length) {
    throw AppError.conflict(
      'The cap reservation order is outside the exact tenant/facility scope',
      'TPA_PHARMACY_CAP_ORDER_SCOPE_MISMATCH',
    );
  }
  const order = orderRows[0];
  if (Number(order.funding_admission_id) !== Number(admissionId)
      || Number(order.funding_admission_order_version) !== Number(order.inventory_authority_version)
      || String(order.funding_admission_items_sha256) !== clinicalOrderItemsSha256(order.items_list)) {
    throw AppError.conflict(
      'The cap reservation does not match the order pinned admission and current item authority',
      'TPA_PHARMACY_CAP_ORDER_AUTHORITY_STALE',
    );
  }
  const admission = await lockPharmacyFundingAdmissionTx(tx, {
    tenantId: tid,
    admissionId,
    patientUid,
  });
  const patientRows = await tx.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id=$1::uuid AND id=$2::int AND role='PATIENT'`,
    tid,
    Number(orderRows[0].patient_id),
  );
  if (!patientRows.length || String(patientRows[0].uid) !== String(admission.patient_uid)) {
    throw AppError.conflict(
      'The cap reservation order patient does not own the locked admission',
      'TPA_PHARMACY_CAP_ADMISSION_PATIENT_MISMATCH',
    );
  }
  if (claimId != null) {
    const claimRows = await tx.$queryRawUnsafe(
      `SELECT id FROM tpa_claims
        WHERE tenant_id=$1::uuid AND id=$2::int AND admission_id=$3::int
          AND patient_uid=$4::uuid
          AND status IN ('approved','partially_approved','paid')
        FOR UPDATE`,
      tid,
      claimId,
      Number(admissionId),
      patientUid,
    );
    if (claimRows.length !== 1) {
      throw AppError.conflict(
        'The cap reservation claim no longer owns the exact order admission and patient',
        'TPA_PHARMACY_CAP_CLAIM_AUTHORITY_STALE',
      );
    }
  }

  const reserveRequest = canonicalCapEvidence({
    operation: 'reserve',
    tenant_id: tid,
    facility_id: Number(facilityId),
    pharmacy_order_id: Number(orderId),
    admission_id: Number(admissionId),
    reserved_amount: amount,
    funding_source: source,
    funding_reference: reference,
    funding_tpa_claim_id: claimId,
    authorised_funding_amount: authorised,
    actor_uid: String(actor.uid),
    actor_role: actor.role,
    authority_evidence: authorityEvidence || {},
  });

  const replayRows = await tx.$queryRawUnsafe(
    `SELECT event.id,event.event_type,event.reservation_id,event.evidence
       FROM pharmacy_cap_reservation_events event
      WHERE event.tenant_id=$1::uuid AND event.command_key_sha256=$2
      FOR KEY SHARE`,
    tid,
    command,
  );
  if (replayRows.length) {
    const replayEvidence = replayRows[0].evidence || {};
    if (!['RESERVED', 'UPDATED'].includes(replayRows[0].event_type)
        || !sameCapEvidence(replayEvidence.request, reserveRequest)
        || !replayEvidence.response) {
      throw AppError.conflict(
        'The cap reservation idempotency key was already used for different authority',
        'TPA_PHARMACY_CAP_IDEMPOTENCY_CONFLICT',
      );
    }
    return { ...replayEvidence.response, replayed: true };
  }

  const existingRows = await tx.$queryRawUnsafe(
    `SELECT * FROM pharmacy_cap_reservations
      WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
      FOR UPDATE`,
    tid,
    Number(orderId),
  );
  const existing = existingRows[0] || null;
  if (existing?.status === 'RELEASED') {
    throw AppError.conflict(
      'A released cap reservation cannot be reactivated',
      'TPA_PHARMACY_CAP_RESERVATION_RELEASED',
    );
  }
  const eventType = existing ? 'UPDATED' : 'RESERVED';
  const rows = existing
    ? await tx.$queryRawUnsafe(
      `UPDATE pharmacy_cap_reservations
          SET facility_id=$3::int, admission_id=$4::int, reserved_amount=$5::numeric,
              funding_source=$6, funding_reference=$7, funding_tpa_claim_id=$8::int,
              authorised_funding_amount=$9::numeric, command_key_sha256=$10,
              authority_evidence=$11::jsonb, reserved_by=$12::uuid, updated_at=NOW()
        WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int AND status='ACTIVE'
        RETURNING *`,
      tid, Number(orderId), Number(facilityId), Number(admissionId), amount,
      source, reference,
      claimId, authorised,
      command, JSON.stringify({
        ...(authorityEvidence || {}),
        actor_role: actor.role,
        funding_source: source,
        funding_tpa_claim_id: claimId,
      }), actor.uid,
    )
    : await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_cap_reservations
        (tenant_id, facility_id, pharmacy_order_id, admission_id, reserved_amount,
         funding_source, funding_reference, funding_tpa_claim_id,
         authorised_funding_amount, status, command_key_sha256,
         authority_evidence, reserved_by)
       VALUES ($1::uuid,$2::int,$3::int,$4::int,$5::numeric,$6,$7,$8::int,
               $9::numeric,'ACTIVE',$10,$11::jsonb,$12::uuid)
       RETURNING *`,
      tid, Number(facilityId), Number(orderId), Number(admissionId), amount,
      source, reference,
      claimId, authorised,
      command, JSON.stringify({
        ...(authorityEvidence || {}),
        actor_role: actor.role,
        funding_source: source,
        funding_tpa_claim_id: claimId,
      }), actor.uid,
    );
  const reservation = rows[0];
  const response = capReservationResponse(reservation);
  await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_cap_reservation_events
      (tenant_id,reservation_id,pharmacy_order_id,admission_id,event_type,
       prior_amount,resulting_amount,command_key_sha256,evidence,recorded_by)
     VALUES ($1::uuid,$2::bigint,$3::int,$4::int,$5,$6::numeric,$7::numeric,
             $8,$9::jsonb,$10::uuid)
     RETURNING id`,
    tid, Number(reservation.id), Number(orderId), Number(admissionId), eventType,
    existing ? Number(existing.reserved_amount) : null, amount, command,
    JSON.stringify({
      contract: 'pharmacy_cap_reservation_command_v1',
      request: reserveRequest,
      response,
      actor_role: actor.role,
      funding_source: source,
      funding_tpa_claim_id: claimId,
    }), actor.uid,
  );
  return { ...response, replayed: false };
}

export async function releasePharmacyCapReservationTx(tx, {
  tenantId,
  facilityId,
  admissionId,
  orderId,
  actorUid,
  actorRole,
  commandKeySha256,
  reason,
}) {
  const tid = requireTenantId(tenantId);
  let exactFacilityId = facilityId == null ? null : Number(facilityId);
  let exactAdmissionId = admissionId == null ? null : Number(admissionId);
  let command = String(commandKeySha256 || '').trim().toLowerCase();
  const releaseReason = String(reason || '').trim().slice(0, 255);
  if (!command && facilityId == null && admissionId == null) {
    const canonicalPatientUid = await resolvePharmacyFundingPatientUidTx(tx, {
      tenantId: tid,
      orderId,
    });
    await lockPharmacyFundingAuthorityTx(tx, {
      tenantId: tid,
      patientUid: canonicalPatientUid,
    });
    const terminalRows = await tx.$queryRawUnsafe(
      `SELECT id,facility_id,status FROM pharmacy_orders
        WHERE tenant_id=$1::uuid AND id=$2::int
        FOR UPDATE`,
      tid,
      Number(orderId),
    );
    if (!terminalRows.length
        || !['CANCELLED', 'UNAVAILABLE', 'REJECTED'].includes(terminalRows[0].status)) {
      throw AppError.conflict(
        'Cap release requires the exact order to be CANCELLED, UNAVAILABLE, or REJECTED',
        'TPA_PHARMACY_CAP_RELEASE_ORDER_NOT_TERMINAL',
      );
    }
    const activeRows = await tx.$queryRawUnsafe(
      `SELECT admission_id FROM pharmacy_cap_reservations
        WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int AND status='ACTIVE'
        FOR UPDATE`,
      tid,
      Number(orderId),
    );
    if (!activeRows.length) return null;
    exactFacilityId = Number(terminalRows[0].facility_id);
    exactAdmissionId = Number(activeRows[0].admission_id);
    command = createHash('sha256').update(JSON.stringify({
      event_type: 'TERMINAL_CAP_RELEASE',
      tenant_id: tid,
      pharmacy_order_id: Number(orderId),
      admission_id: exactAdmissionId,
      terminal_status: terminalRows[0].status,
    })).digest('hex');
  }
  if (!/^[0-9a-f]{64}$/.test(command)) {
    throw AppError.badRequest(
      'A SHA-256 command identity is required for cap release',
      'TPA_PHARMACY_CAP_COMMAND_REQUIRED',
    );
  }
  if (!Number.isInteger(exactFacilityId) || exactFacilityId <= 0
      || !Number.isInteger(exactAdmissionId) || exactAdmissionId <= 0) {
    throw AppError.badRequest(
      'Cap release requires exact facility and admission identity',
      'TPA_PHARMACY_CAP_RELEASE_AUTHORITY_REQUIRED',
    );
  }
  if (!releaseReason) {
    throw AppError.badRequest(
      'A reservation release reason is required',
      'TPA_PHARMACY_CAP_RELEASE_REASON_REQUIRED',
    );
  }
  const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId: tid,
    orderId,
    admissionId: exactAdmissionId,
  });
  await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
  const actor = await assertCapActorTx(tx, {
    tenantId: tid,
    actorUid,
    actorRole,
    allowedRoles: CAP_RELEASE_ROLES,
  });
  const orderRows = await tx.$queryRawUnsafe(
    `SELECT id, status FROM pharmacy_orders
      WHERE tenant_id=$1::uuid AND id=$2::int AND facility_id=$3::int
      FOR UPDATE`,
    tid,
    Number(orderId),
    exactFacilityId,
  );
  if (!orderRows.length || !['CANCELLED', 'UNAVAILABLE', 'REJECTED'].includes(orderRows[0].status)) {
    throw AppError.conflict(
      'Cap release requires the exact order to be CANCELLED, UNAVAILABLE, or REJECTED',
      'TPA_PHARMACY_CAP_RELEASE_ORDER_NOT_TERMINAL',
    );
  }
  await lockPharmacyFundingAdmissionTx(tx, {
    tenantId: tid,
    admissionId: exactAdmissionId,
    patientUid,
  });
  const stockRows = await tx.$queryRawUnsafe(
    `SELECT id FROM pharmacy_stock_movements
      WHERE tenant_id=$1::uuid AND metadata->>'order_id'=$2
      LIMIT 1 FOR UPDATE`,
    tid,
    String(Number(orderId)),
  );
  if (stockRows.length) {
    throw AppError.conflict(
      'Cap release is forbidden after stock movement authority exists for the order',
      'TPA_PHARMACY_CAP_RELEASE_STOCK_EXISTS',
    );
  }
  const releaseRequest = canonicalCapEvidence({
    operation: 'release',
    tenant_id: tid,
    facility_id: exactFacilityId,
    pharmacy_order_id: Number(orderId),
    admission_id: exactAdmissionId,
    actor_uid: String(actor.uid),
    actor_role: actor.role,
    reason: releaseReason,
    terminal_order_status: String(orderRows[0].status),
  });
  const replayRows = await tx.$queryRawUnsafe(
    `SELECT event.id,event.event_type,event.reservation_id,event.evidence
       FROM pharmacy_cap_reservation_events event
      WHERE event.tenant_id=$1::uuid AND event.command_key_sha256=$2
      FOR KEY SHARE`,
    tid,
    command,
  );
  if (replayRows.length) {
    const replayEvidence = replayRows[0].evidence || {};
    if (replayRows[0].event_type !== 'RELEASED'
        || !sameCapEvidence(replayEvidence.request, releaseRequest)
        || !replayEvidence.response) {
      throw AppError.conflict(
        'The cap release idempotency key was already used for another order',
        'TPA_PHARMACY_CAP_IDEMPOTENCY_CONFLICT',
      );
    }
    return { ...replayEvidence.response, replayed: true };
  }
  const reservationRows = await tx.$queryRawUnsafe(
    `SELECT * FROM pharmacy_cap_reservations
      WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
        AND admission_id=$3::int
      FOR UPDATE`,
    tid,
    Number(orderId),
    exactAdmissionId,
  );
  if (!reservationRows.length) return null;
  const reservation = reservationRows[0];
  if (reservation.status !== 'ACTIVE') {
    throw AppError.conflict(
      'The cap reservation was released by a different command',
      'TPA_PHARMACY_CAP_RESERVATION_ALREADY_RELEASED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `UPDATE pharmacy_cap_reservations
        SET status='RELEASED', released_by=$3::uuid, released_at=NOW(),
            release_reason=$4, command_key_sha256=$5, updated_at=NOW()
      WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int AND status='ACTIVE'
      RETURNING *`,
    tid,
    Number(orderId),
    actor.uid,
    releaseReason,
    command,
  );
  const released = rows[0];
  const response = capReservationResponse(released);
  await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_cap_reservation_events
      (tenant_id,reservation_id,pharmacy_order_id,admission_id,event_type,
       prior_amount,resulting_amount,command_key_sha256,reason,evidence,recorded_by)
     VALUES ($1::uuid,$2::bigint,$3::int,$4::int,'RELEASED',$5::numeric,
             0,$6,$7,$8::jsonb,$9::uuid)
     RETURNING id`,
    tid, Number(released.id), Number(orderId), exactAdmissionId,
    Number(released.reserved_amount), command, releaseReason,
    JSON.stringify({
      contract: 'pharmacy_cap_reservation_command_v1',
      request: releaseRequest,
      response,
      actor_role: actor.role,
      terminal_order_status: orderRows[0].status,
    }), actor.uid,
  );
  return { ...response, replayed: false };
}

/**
 * Hard-block decision: critical level blocks unless the caller passed
 * an explicit override flag (typically gated by RBAC at the route layer).
 */
export function shouldBlockDispense(probe, { allowOverride = false } = {}) {
  if (!probe?.hasCap) return false;
  if (probe.level !== 'critical') return false;
  return !allowOverride;
}
