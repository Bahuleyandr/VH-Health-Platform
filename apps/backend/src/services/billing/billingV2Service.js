// src/services/billing/billingV2Service.js
//
// Sprint 1 — Billing core. The pre-existing billingService.js handles
// a one-line invoice surface; this v2 module owns the line-item +
// GST + advance + refund + receipts lifecycle introduced in
// migration 149_billing_core.sql.
//
// All raw queries use prisma.$queryRawUnsafe with spread params (per
// Phase 0.5 conventions documented in apps/backend/CLAUDE.md). All
// monetary maths is performed server-side with NUMERIC(12,2) so the
// app never sends a calculated total — it sends the inputs and the
// service is the source of truth.

import { createHash } from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { istDateString } from '../../utils/dateUtils.js';
import { boundedInteger } from '../../utils/pagination.js';
import { toPaise } from '../../utils/money.js';
import {
  assertTenantPatientMergeStabilityLease,
  lockTenantPatientMergeStability,
} from '../../utils/patientMergeStabilityLock.js';
import {
  postInvoiceIssueEntry, postPaymentEntry,
  postAdvanceCollectEntry, postAdvanceSettleEntry, postPaymentReversalEntry,
  postRefundApproveEntry, postRefundPaidEntry,
} from './ledger/ledgerPostings.js';
import { resolveLedgerWiring } from './ledger/ledgerAuthoritativeMode.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  advanceBillingCreditNoteRefundPayoutObligationTx,
  completeBillingCreditNoteRefundObligationTx,
} from '../ipd/wardIndentObligationService.js';
import {
  REFUND_APPROVAL_IDEMPOTENCY_PATH,
  refundApprovalRequestFingerprint,
} from './billingRefundApprovalCommand.js';
import { hashRequestBody } from '../idempotency/idempotencyService.js';
import {
  lockCounterFundingSubstitutionAuthorityTx,
  lockPharmacyFundingAdmissionTx,
  lockPharmacyFundingAuthorityTx,
  releasePharmacyCapReservationTx,
  resolvePharmacyFundingPatientUidTx,
} from '../pharmacy/pharmacyCapService.js';
import { clinicalOrderItemsSha256 } from '../pharmacy/pharmacistVerificationService.js';

export {
  REFUND_APPROVAL_IDEMPOTENCY_PATH,
  refundApprovalIdempotencyBody,
} from './billingRefundApprovalCommand.js';

const VALID_INVOICE_TYPES = ['OP', 'IP', 'PHARMACY', 'EMERGENCY'];
const VALID_PAYMENT_MODES = [
  'CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET', 'INSURANCE',
];
const VALID_INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PARTIAL', 'PAID', 'VOID'];
const VALID_REFUND_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PAID'];
const OFFLINE_ELECTRONIC_REFUND_MODES = ['CARD', 'UPI', 'NETBANKING', 'WALLET'];
const MANUAL_REFUND_MODES = ['CASH', 'CHEQUE', 'DD'];
const VALID_REFUND_MODES = [
  ...MANUAL_REFUND_MODES,
  ...OFFLINE_ELECTRONIC_REFUND_MODES,
];
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HIGH_VALUE_DISCOUNT_APPROVER_ROLES = ['FINANCE_INCHARGE', 'ADMIN', 'SUPER_ADMIN'];
const INVOICE_DETAIL_COLUMNS = `
  id, invoice_number, patient_uid, patient_name, patient_phone,
  admission_id, doctor_uid, department, invoice_type,
  patient_state, hospital_state, subtotal, cgst_amount, sgst_amount,
  igst_amount, discount_amount, discount_reason, discount_approved_by,
  total_amount, credit_note_amount, amount_paid, amount_due, status, notes, created_by,
  issued_at, voided_at, voided_by, void_reason, tenant_id, created_at, updated_at
`;
const REFUND_PUBLIC_COLUMNS = `
  id, patient_uid, invoice_id, advance_id, amount, reason, mode, reference,
  approval_status, raised_by, raised_at, approved_by, approved_at,
  rejected_by, rejected_at, rejection_reason, paid_at, paid_by, tenant_id,
  payout_rail, payout_rail_claimed_at, gateway_refund_id,
  cash_drawer_session_id, counter_sale_void_request_id,
  offline_electronic_evidence_id, created_at, updated_at
`;

// Mirrors VALID_CATEGORIES in claimCapsService — the bucket set TPA caps
// match against. addInvoiceItem rejects unknown categories so ad-hoc
// pharmacy/room/etc lines stay enforceable by /claims/:id/caps/apply.
export const VALID_INVOICE_LINE_CATEGORIES = new Set([
  'room_rent', 'pharmacy', 'investigations', 'consultation',
  'procedure', 'implants', 'radiology', 'physiotherapy', 'other',
]);

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const DISCOUNT_APPROVAL_AMOUNT_THRESHOLD = envNumber(
  'BILLING_DISCOUNT_APPROVAL_AMOUNT_THRESHOLD',
  500,
);
export const DISCOUNT_APPROVAL_PERCENT_THRESHOLD = envNumber(
  'BILLING_DISCOUNT_APPROVAL_PERCENT_THRESHOLD',
  5,
);

export const REFUND_MANUAL_PAYOUT_IDEMPOTENCY_PATH = '/api/v1/billing/v2/refunds/pay';
export const REFUND_OFFLINE_ELECTRONIC_PAYOUT_IDEMPOTENCY_PATH =
  '/api/v1/billing/v2/refunds/pay/offline-electronic';
export const REFUND_REJECTION_IDEMPOTENCY_PATH = '/api/v1/billing/v2/refunds/reject';
export const REFUND_RAISE_IDEMPOTENCY_PATH = '/api/v1/billing/v2/refunds';

function canonicalCommandText(value) {
  return value == null ? null : String(value).trim();
}

export function refundManualPayoutIdempotencyBody(refundId, body = {}) {
  return {
    action: 'pay_refund_manual',
    refund_id: String(refundId),
    cash_drawer_session_id: canonicalCommandText(body.cash_drawer_session_id),
    reference: canonicalCommandText(body.reference),
  };
}

export function refundOfflineElectronicPayoutIdempotencyBody(refundId, body = {}) {
  return {
    action: 'pay_refund_offline_electronic',
    refund_id: String(refundId),
    original_payment_reference: canonicalCommandText(body.original_payment_reference),
    provider_name: canonicalCommandText(body.provider_name),
    provider_refund_reference: canonicalCommandText(body.provider_refund_reference),
    provider_refunded_at: canonicalCommandText(body.provider_refunded_at),
  };
}

export function refundRejectionIdempotencyBody(refundId, body = {}) {
  return {
    action: 'reject_refund',
    refund_id: String(refundId),
    rejection_reason: canonicalCommandText(body.rejection_reason),
  };
}

export function refundRaiseIdempotencyBody(body = {}) {
  return {
    action: 'raise_refund',
    patient_uid: canonicalCommandText(body.patient_uid),
    invoice_id: canonicalCommandText(body.invoice_id),
    advance_id: canonicalCommandText(body.advance_id),
    amount: canonicalCommandText(body.amount),
    reason: canonicalCommandText(body.reason),
    mode: canonicalCommandText(body.mode),
  };
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

export function fiscalYearOf(date = new Date()) {
  // Indian FY: Apr 1 → Mar 31. Apr-Dec returns the calendar year;
  // Jan-Mar returns previous calendar year.
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  return month >= 4 ? year : year - 1;
}

function toFixed2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Validate a caller-supplied money amount at a payment/advance/refund entry
 * point. A bare `Number(amount) <= 0` guard is NaN-bypassable — every NaN
 * comparison is false, so `Number('abc')` sails past it AND past the
 * over-payment / refund-headroom bound checks further down, and Postgres
 * `numeric` accepts NaN, which wedges recomputeInvoicePaymentStateTx and the
 * discharge billing gate. Reject non-finite input BEFORE any comparison.
 * Sub-paisa precision is rejected too (all billing math is 2dp with 0.005
 * epsilons, so a 3+dp amount silently gains/loses money in the ledger).
 */
function requireValidAmount(amount, label = 'amount') {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) {
    throw AppError.badRequest(`${label} must be a finite number`);
  }
  if (parsed <= 0) throw AppError.badRequest(`${label} must be > 0`);
  if (typeof amount === 'number') {
    // JSON numbers can carry harmless IEEE-754 representation dust (for
    // example, 0.1 + 0.2). Keep that compatibility while rejecting a real
    // third decimal such as 100.001.
    if (Math.abs(parsed - toFixed2(parsed)) > 1e-9) {
      throw AppError.badRequest(`${label} must have at most 2 decimal places`);
    }
  } else {
    try {
      toPaise(String(amount).trim());
    } catch {
      throw AppError.badRequest(`${label} must have at most 2 decimal places`);
    }
  }
  return parsed;
}

function normalizeTenantId(tenantId) {
  return tenantId ? String(tenantId) : null;
}

function normalizeRefundApprovalCommand(refundId, {
  approved_by,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId,
} = {}) {
  const supplied = [commandKey, requestFingerprint, httpIdempotencyClaimId]
    .some((value) => value != null);
  if (!supplied) return null;

  const actor = String(approved_by || '').trim();
  const key = String(commandKey || '');
  const fingerprint = String(requestFingerprint || '');
  const claimId = Number(httpIdempotencyClaimId);
  const expectedFingerprint = refundApprovalRequestFingerprint(refundId);
  if (
    !UUID_PATTERN.test(actor)
    || !Number.isSafeInteger(claimId)
    || claimId < 1
    || key.length < 1
    || key.length > 200
    || key !== key.trim()
    || !IDEMPOTENCY_KEY_PATTERN.test(key)
    || !SHA256_PATTERN.test(fingerprint)
  ) {
    throw AppError.badRequest(
      'Refund approval idempotency identity is invalid',
      'BILLING_REFUND_APPROVAL_IDEMPOTENCY_INVALID',
    );
  }
  if (fingerprint !== expectedFingerprint) {
    throw AppError.unprocessable(
      'Idempotency-Key is bound to a different refund approval command',
      'BILLING_REFUND_APPROVAL_COMMAND_MISMATCH',
      { refund_id: String(refundId) },
    );
  }
  return {
    actor,
    claimId,
    commandKey: key,
    requestFingerprint: fingerprint,
    requestId: requestId ? String(requestId) : null,
  };
}

function normalizeRefundApprovalAuditContext(auditContext, {
  approvedBy,
  command,
} = {}) {
  if (auditContext == null) {
    if (command) {
      throw AppError.internal(
        'Refund approval audit context is required',
        'BILLING_REFUND_APPROVAL_AUDIT_CONTEXT_MISSING',
      );
    }
    return null;
  }
  if (typeof auditContext !== 'object' || Array.isArray(auditContext)) {
    throw AppError.internal(
      'Refund approval audit context is invalid',
      'BILLING_REFUND_APPROVAL_AUDIT_CONTEXT_INVALID',
    );
  }

  const actorUid = String(auditContext.actorUid || '').trim().toLowerCase();
  const subjectUid = auditContext.subjectUid == null
    ? null
    : String(auditContext.subjectUid).trim().toLowerCase();
  const actorRole = auditContext.actorRole == null
    ? null
    : String(auditContext.actorRole).trim();
  const requestId = auditContext.requestId == null
    ? null
    : String(auditContext.requestId).trim();
  const deviceType = auditContext.deviceType == null
    ? null
    : String(auditContext.deviceType).trim();
  const ipAddress = auditContext.ipAddress == null
    ? null
    : String(auditContext.ipAddress).trim();
  const userAgent = auditContext.userAgent == null
    ? null
    : String(auditContext.userAgent).trim();
  const expectedActor = String(approvedBy || '').trim().toLowerCase();
  const invalid = !UUID_PATTERN.test(actorUid)
    || actorUid !== expectedActor
    || (subjectUid != null && !UUID_PATTERN.test(subjectUid))
    || typeof auditContext.actingAsDependent !== 'boolean'
    || (actorRole != null && (actorRole.length < 1 || actorRole.length > 50))
    || (requestId != null && (requestId.length < 1 || requestId.length > 200))
    || (deviceType != null && (deviceType.length < 1 || deviceType.length > 80))
    || (ipAddress != null && (ipAddress.length < 1 || ipAddress.length > 45))
    || (userAgent != null && (userAgent.length < 1 || userAgent.length > 500));
  if (
    invalid
    || (!auditContext.actingAsDependent && subjectUid !== actorUid)
    || (command && (
      !subjectUid
      || !actorRole
      || !requestId
      || requestId !== command.requestId
    ))
  ) {
    throw AppError.internal(
      'Refund approval audit context is invalid',
      'BILLING_REFUND_APPROVAL_AUDIT_CONTEXT_INVALID',
    );
  }
  return {
    actorUid,
    subjectUid,
    actorRole,
    actingAsDependent: auditContext.actingAsDependent,
    requestId,
    deviceType,
    ipAddress,
    userAgent,
  };
}

async function insertRefundApprovalAuditTx(tx, {
  tenantId,
  refund,
  auditContext,
}) {
  if (!auditContext) return null;
  const metadata = {
    request_id: auditContext.requestId,
    device_type: auditContext.deviceType,
    tenant_id: tenantId,
    actor_role: auditContext.actorRole,
    refund_id: Number(refund.id),
    ...(refund.invoice_id != null ? { invoice_id: Number(refund.invoice_id) } : {}),
    ...(refund.advance_id != null ? { advance_id: Number(refund.advance_id) } : {}),
    ...(refund.patient_uid ? { patient_uid: String(refund.patient_uid) } : {}),
    approval_status: String(refund.approval_status),
    source: 'billing_v2',
  };
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO audit_logs
       (uid, role, action, resource, resource_id, ip_address, user_agent, metadata,
        actor_uid, subject_uid, acting_as_dependent, tenant_id)
     VALUES ($1::uuid, $2, 'FRONT_OFFICE_BILLING_REFUND_APPROVED',
             'billing_refund', $3, $4, $5, $6::jsonb,
             $1::uuid, $7::uuid, $8, $9::uuid)
     RETURNING id`,
    auditContext.actorUid,
    auditContext.actorRole,
    String(refund.id),
    auditContext.ipAddress,
    auditContext.userAgent,
    JSON.stringify(metadata),
    auditContext.subjectUid,
    auditContext.actingAsDependent,
    tenantId,
  );
  if (!rows[0]) {
    throw AppError.internal(
      'Refund approval audit evidence was not persisted',
      'BILLING_REFUND_APPROVAL_AUDIT_MISSING',
    );
  }
  return rows[0];
}

async function finaliseRefundApprovalIdempotencyTx(tx, {
  tenantId,
  command,
  refund,
}) {
  if (!command) return null;
  const responseBody = {
    success: true,
    message: 'Success',
    data: refund,
    ...(command.requestId ? { requestId: command.requestId } : {}),
  };
  const rows = await tx.$queryRawUnsafe(
    `UPDATE idempotency_keys
        SET status = 'complete',
            response_status = 200,
            response_body = $6::jsonb,
            expires_at = 'infinity'::timestamptz,
            updated_at = NOW()
      WHERE id = $1::int
        AND tenant_id = $2::uuid
        AND user_uid = $3::uuid
        AND request_key = $4::text
        AND request_body_hash = $5::char(64)
        AND request_method = 'POST'
        AND request_path = $7::text
        AND status = 'in_flight'
      RETURNING id, status, response_status, response_body`,
    command.claimId,
    tenantId,
    command.actor,
    command.commandKey,
    command.requestFingerprint,
    JSON.stringify(responseBody),
    REFUND_APPROVAL_IDEMPOTENCY_PATH,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Refund approval idempotency claim changed before commit',
      'BILLING_REFUND_APPROVAL_IDEMPOTENCY_CHANGED',
    );
  }
  return rows[0];
}

function normalizeRefundMutationCommand({
  actorUid,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId,
  expectedBody,
  path,
  invalidCode,
  mismatchCode,
  label,
}) {
  const supplied = [commandKey, requestFingerprint, httpIdempotencyClaimId]
    .some((value) => value != null);
  if (!supplied) return null;

  const actor = String(actorUid || '').trim();
  const key = String(commandKey || '');
  const fingerprint = String(requestFingerprint || '');
  const claimId = Number(httpIdempotencyClaimId);
  const expectedFingerprint = hashRequestBody(expectedBody);
  if (
    !UUID_PATTERN.test(actor)
    || !Number.isSafeInteger(claimId)
    || claimId < 1
    || key.length < 1
    || key.length > 200
    || key !== key.trim()
    || !IDEMPOTENCY_KEY_PATTERN.test(key)
    || !SHA256_PATTERN.test(fingerprint)
  ) {
    throw AppError.badRequest(`${label} idempotency identity is invalid`, invalidCode);
  }
  if (fingerprint !== expectedFingerprint) {
    throw AppError.unprocessable(
      `Idempotency-Key is bound to a different ${label.toLowerCase()} command`,
      mismatchCode,
      { refund_id: expectedBody.refund_id },
    );
  }
  return {
    actor,
    claimId,
    commandKey: key,
    requestFingerprint: fingerprint,
    requestId: requestId ? String(requestId) : null,
    path,
  };
}

function normalizeRefundMutationAuditContext(auditContext, {
  actorUid,
  command,
  invalidCode,
  missingCode,
  label,
}) {
  if (auditContext == null) {
    if (command) {
      throw AppError.internal(`${label} audit context is required`, missingCode);
    }
    return null;
  }
  if (typeof auditContext !== 'object' || Array.isArray(auditContext)) {
    throw AppError.internal(`${label} audit context is invalid`, invalidCode);
  }

  const normalizedActorUid = String(auditContext.actorUid || '').trim().toLowerCase();
  const subjectUid = auditContext.subjectUid == null
    ? null
    : String(auditContext.subjectUid).trim().toLowerCase();
  const actorRole = auditContext.actorRole == null
    ? null
    : String(auditContext.actorRole).trim();
  const requestId = auditContext.requestId == null
    ? null
    : String(auditContext.requestId).trim();
  const deviceType = auditContext.deviceType == null
    ? null
    : String(auditContext.deviceType).trim();
  const ipAddress = auditContext.ipAddress == null
    ? null
    : String(auditContext.ipAddress).trim();
  const userAgent = auditContext.userAgent == null
    ? null
    : String(auditContext.userAgent).trim();
  const expectedActor = String(actorUid || '').trim().toLowerCase();
  const invalid = !UUID_PATTERN.test(normalizedActorUid)
    || normalizedActorUid !== expectedActor
    || (subjectUid != null && !UUID_PATTERN.test(subjectUid))
    || typeof auditContext.actingAsDependent !== 'boolean'
    || (actorRole != null && (actorRole.length < 1 || actorRole.length > 50))
    || (requestId != null && (requestId.length < 1 || requestId.length > 200))
    || (deviceType != null && (deviceType.length < 1 || deviceType.length > 80))
    || (ipAddress != null && (ipAddress.length < 1 || ipAddress.length > 45))
    || (userAgent != null && (userAgent.length < 1 || userAgent.length > 500));
  if (
    invalid
    || (!auditContext.actingAsDependent && subjectUid !== normalizedActorUid)
    || (command && (
      !subjectUid
      || !actorRole
      || !requestId
      || requestId !== command.requestId
    ))
  ) {
    throw AppError.internal(`${label} audit context is invalid`, invalidCode);
  }
  return {
    actorUid: normalizedActorUid,
    subjectUid,
    actorRole,
    actingAsDependent: auditContext.actingAsDependent,
    requestId,
    deviceType,
    ipAddress,
    userAgent,
  };
}

async function insertRefundMutationAuditTx(tx, {
  tenantId,
  refund,
  auditContext,
  action,
  missingCode,
}) {
  if (!auditContext) return null;
  const metadata = {
    request_id: auditContext.requestId,
    device_type: auditContext.deviceType,
    tenant_id: tenantId,
    actor_role: auditContext.actorRole,
    refund_id: Number(refund.id),
    ...(refund.invoice_id != null ? { invoice_id: Number(refund.invoice_id) } : {}),
    ...(refund.advance_id != null ? { advance_id: Number(refund.advance_id) } : {}),
    ...(refund.patient_uid ? { patient_uid: String(refund.patient_uid) } : {}),
    ...(refund.cash_drawer_session_id != null
      ? { cash_drawer_session_id: String(refund.cash_drawer_session_id) }
      : {}),
    ...(refund.offline_electronic_evidence_id != null
      ? { offline_electronic_evidence_id: String(refund.offline_electronic_evidence_id) }
      : {}),
    approval_status: String(refund.approval_status),
    payout_rail: refund.payout_rail ? String(refund.payout_rail) : null,
    reference_present: Boolean(refund.reference),
    source: 'billing_v2',
  };
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO audit_logs
       (uid, role, action, resource, resource_id, ip_address, user_agent, metadata,
        actor_uid, subject_uid, acting_as_dependent, tenant_id)
     VALUES ($1::uuid, $2, $3,
             'billing_refund', $4, $5, $6, $7::jsonb,
             $1::uuid, $8::uuid, $9, $10::uuid)
     RETURNING id`,
    auditContext.actorUid,
    auditContext.actorRole,
    action,
    String(refund.id),
    auditContext.ipAddress,
    auditContext.userAgent,
    JSON.stringify(metadata),
    auditContext.subjectUid,
    auditContext.actingAsDependent,
    tenantId,
  );
  if (!rows[0]) {
    throw AppError.internal('Refund audit evidence was not persisted', missingCode);
  }
  return rows[0];
}

async function finaliseRefundMutationIdempotencyTx(tx, {
  tenantId,
  command,
  refund,
  changedCode,
  label,
}) {
  if (!command) return null;
  const responseBody = {
    success: true,
    message: 'Success',
    data: refund,
    ...(command.requestId ? { requestId: command.requestId } : {}),
  };
  const rows = await tx.$queryRawUnsafe(
    `UPDATE idempotency_keys
        SET status = 'complete',
            response_status = 200,
            response_body = $6::jsonb,
            expires_at = 'infinity'::timestamptz,
            updated_at = NOW()
      WHERE id = $1::int
        AND tenant_id = $2::uuid
        AND user_uid = $3::uuid
        AND request_key = $4::text
        AND request_body_hash = $5::char(64)
        AND request_method = 'POST'
        AND request_path = $7::text
        AND status = 'in_flight'
      RETURNING id, status, response_status, response_body`,
    command.claimId,
    tenantId,
    command.actor,
    command.commandKey,
    command.requestFingerprint,
    JSON.stringify(responseBody),
    command.path,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      `${label} idempotency claim changed before commit`,
      changedCode,
    );
  }
  return rows[0];
}

function normalizeSourceRefId(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw AppError.badRequest(
      'source_ref_id must be sent as a decimal string above the JavaScript safe-integer range',
    );
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw AppError.badRequest('source_ref_id must be an integer when provided');
  }
  const parsed = BigInt(text);
  if (parsed < 1n) {
    throw AppError.badRequest('source_ref_id must be a positive integer when provided');
  }
  if (parsed > 9_223_372_036_854_775_807n) {
    throw AppError.badRequest('source_ref_id exceeds the supported BIGINT range');
  }
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : text;
}

function normalizeBigIntForResponse(value) {
  if (typeof value !== 'bigint') return value;
  if (
    value >= BigInt(Number.MIN_SAFE_INTEGER)
    && value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return value.toString();
}

function normalizeBillingItemForResponse(item) {
  if (!item) return item;
  const normalized = {
    ...item,
    source_ref_id: normalizeBigIntForResponse(item.source_ref_id),
    source_ref_reconciliation_case_id: normalizeBigIntForResponse(
      item.source_ref_reconciliation_case_id,
    ),
  };
  delete normalized.source_ref_active;
  return normalized;
}

function appendTenantPredicate(params, tenantId, column = 'tenant_id') {
  const tenant = normalizeTenantId(tenantId);
  if (!tenant) return '';
  params.push(tenant);
  return ` AND ${column} = $${params.length}::uuid`;
}

function pushTenantWhere(where, params, tenantId, column = 'tenant_id') {
  const tenant = normalizeTenantId(tenantId);
  if (!tenant) return;
  params.push(tenant);
  where.push(`${column} = $${params.length}::uuid`);
}

const BILLING_INVOICE_PUBLIC_COLUMNS = `
  id, invoice_number, patient_uid, patient_name, patient_phone,
  admission_id, doctor_uid, department, invoice_type,
  patient_state, hospital_state, subtotal, cgst_amount, sgst_amount,
  igst_amount, discount_amount, discount_reason, discount_approved_by,
  total_amount, credit_note_amount, amount_paid, amount_due, status, notes, created_by,
  issued_at, voided_at, voided_by, void_reason, tenant_id,
  created_at, updated_at
`;

async function findBillingInvoice(invoiceId, tenantId, columns = BILLING_INVOICE_PUBLIC_COLUMNS, db = prisma) {
  const params = [Number(invoiceId)];
  const tenantSql = appendTenantPredicate(params, tenantId);
  const rows = await db.$queryRawUnsafe(
    `SELECT ${columns}
       FROM billing_invoices
      WHERE id = $1::int${tenantSql}
      LIMIT 1`,
    ...params,
  );
  return rows[0] || null;
}

/**
 * Lock + read a billing invoice row FOR UPDATE inside an open transaction.
 * Used by the money-mutation critical sections (collectPayment, settleAdvance,
 * raiseRefund) so the balance check + recompute see a row no concurrent tx can
 * mutate until this tx commits. Must be called with a `tx` client from
 * setTenantTx — a bare `prisma` would not hold the lock across statements.
 */
async function lockBillingInvoice(tx, invoiceId, tenantId, columns = '*') {
  const params = [Number(invoiceId)];
  const tenantSql = appendTenantPredicate(params, tenantId);
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${columns}
       FROM billing_invoices
      WHERE id = $1::int${tenantSql}
      LIMIT 1
      FOR UPDATE`,
    ...params,
  );
  return rows[0] || null;
}

const BILLING_ADVANCE_FUNDING_COLUMNS = `
  id, patient_uid, admission_id, amount, balance, mode, reference,
  status, tenant_id, collected_by, collected_at,
  ipd_advance_deposit_id, ipd_advance_deposit_collected_at,
  ipd_advance_deposit_payment_method, updated_at
`;

async function lockBillingAdvance(
  tx,
  advanceId,
  tenantId,
  columns = BILLING_ADVANCE_FUNDING_COLUMNS,
) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${columns}
       FROM billing_advances
      WHERE tenant_id = $1::uuid
        AND id = $2::int
      FOR UPDATE`,
    requireTenantId(tenantId),
    Number(advanceId),
  );
  return rows[0] || null;
}

const BILLING_FUNDING_PATIENT_MERGE_MAX_DEPTH = 16;

// ★ THE ANONYMOUS COUNTER IS A FUNDING IDENTITY, NOT A PATIENT. Walk-in
// pharmacy sales have no registered patient, but billing_invoices.patient_uid
// is NOT NULL, so migration 684 anchors them on one per-tenant synthetic
// 'PHARMACY_WALKIN' users row (counterSaleService.ensureWalkInAnchorUid — no
// phone, no password, no firebase identity, is_unidentified). That row is
// deliberately NOT role='PATIENT': pharmacyOrderPatientGuards depends on it
// resolving to no patient so an anonymous sale stays role-gated instead of
// minting a bogus care-relationship decision.
//
// The merge chain below therefore admits it as a chain SEED only. It is
// terminal by construction and cannot be otherwise: patientMergeService's
// loadMergePatients refuses any non-PATIENT row in either merge position, so
// no merge can ever set the anchor's merged_into_uid, and no row can ever
// point at it. Nothing downstream is relaxed — the recursive step stays
// PATIENT-only, and an anchor carrying a pointer still finds no successor and
// still fails the one-terminal-row check below. Without the seed, every
// walk-in payment, refund and void 409s on a merge history that by design
// does not exist.
async function resolveBillingFundingPatientIdentityTx(tx, { tenantId, patientUid }) {
  const tenant = requireTenantId(tenantId);
  const storedPatientUid = String(patientUid || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(storedPatientUid)) {
    throw AppError.conflict(
      'Billing funding history does not reference a valid tenant patient',
      'BILLING_FUNDING_PATIENT_IDENTITY_INVALID',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `WITH RECURSIVE patient_chain AS (
       SELECT patient.uid,
              patient.merged_into_uid,
              ARRAY[patient.uid]::uuid[] AS path,
              0 AS depth,
              FALSE AS cycle
         FROM users patient
        WHERE patient.tenant_id = $1::uuid
          AND patient.uid = $2::uuid
          AND (
            patient.role = 'PATIENT'
            OR (patient.role = 'PHARMACY_WALKIN' AND patient.is_unidentified)
          )
       UNION ALL
       SELECT successor.uid,
              successor.merged_into_uid,
              chain.path || successor.uid,
              chain.depth + 1,
              successor.uid = ANY(chain.path) AS cycle
         FROM patient_chain chain
         JOIN users successor
           ON successor.tenant_id = $1::uuid
          AND successor.uid = chain.merged_into_uid
          AND successor.role = 'PATIENT'
        WHERE chain.merged_into_uid IS NOT NULL
          AND chain.depth < $3::int
          AND chain.cycle = FALSE
     )
     SELECT uid::text AS uid,
            merged_into_uid::text AS merged_into_uid,
            depth,
            cycle
       FROM patient_chain
      ORDER BY depth`,
    tenant,
    storedPatientUid,
    BILLING_FUNDING_PATIENT_MERGE_MAX_DEPTH,
  );
  const terminal = rows[rows.length - 1];
  const terminalRows = rows.filter((row) => row.merged_into_uid == null);
  if (!rows.length
      || rows.some((row) => row.cycle === true)
      || terminalRows.length !== 1
      || terminalRows[0].uid !== terminal?.uid
      || terminal?.merged_into_uid != null) {
    throw AppError.conflict(
      'Billing funding patient merge history does not resolve to one terminal tenant patient',
      'BILLING_FUNDING_PATIENT_MERGE_CHAIN_INVALID',
    );
  }
  return {
    storedPatientUid: String(rows[0].uid),
    fundingPatientUid: String(terminal.uid),
  };
}

async function lockBillingPatientFundingAfterMergeTx(tx, { tenantId, patientUid }) {
  const tenant = requireTenantId(tenantId);
  const identity = await resolveBillingFundingPatientIdentityTx(tx, {
    tenantId: tenant,
    patientUid,
  });
  await lockPharmacyFundingAuthorityTx(tx, {
    tenantId: tenant,
    patientUid: identity.fundingPatientUid,
  });
  return identity;
}

async function assertBillingFundingPatientMatchTx(tx, {
  tenantId,
  requestedPatientUid,
  parentIdentity,
  message,
  code,
}) {
  if (!requestedPatientUid) return;
  const requestedIdentity = await resolveBillingFundingPatientIdentityTx(tx, {
    tenantId,
    patientUid: requestedPatientUid,
  });
  if (requestedIdentity.fundingPatientUid !== parentIdentity.fundingPatientUid) {
    throw AppError.forbidden(message, code);
  }
}

export async function lockBillingRefundFundingAuthorityTx(tx, {
  tenantId,
  refundId,
  mergeStabilityHeld = false,
}) {
  const tenant = requireTenantId(tenantId);
  const id = Number(refundId);
  if (!mergeStabilityHeld) await lockTenantPatientMergeStability(tx, tenant);
  const candidates = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, invoice_id, advance_id, approval_status
       FROM billing_refunds
      WHERE tenant_id = $1::uuid
        AND id = $2::int
      LIMIT 1`,
    tenant,
    id,
  );
  const candidate = candidates[0];
  if (!candidate) throw AppError.notFound('Refund not found');

  const identity = await lockBillingPatientFundingAfterMergeTx(tx, {
    tenantId: tenant,
    patientUid: candidate.patient_uid,
  });
  let parent;
  if (candidate.invoice_id != null) {
    parent = await lockBillingInvoice(
      tx,
      candidate.invoice_id,
      tenant,
      'id, patient_uid, status, total_amount, credit_note_amount, amount_paid, amount_due',
    );
  } else if (candidate.advance_id != null) {
    parent = await lockBillingAdvance(tx, candidate.advance_id, tenant);
  }
  if (!parent
      || String(parent.patient_uid).toLowerCase()
        !== String(candidate.patient_uid).toLowerCase()) {
    throw AppError.conflict(
      'Refund and its parent no longer share the exact stored patient identity',
      'BILLING_REFUND_PARENT_AUTHORITY_MISMATCH',
    );
  }

  const rows = await tx.$queryRawUnsafe(
    `SELECT ${REFUND_PUBLIC_COLUMNS}
       FROM billing_refunds
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND patient_uid = $3::uuid
        AND invoice_id IS NOT DISTINCT FROM $4::int
        AND advance_id IS NOT DISTINCT FROM $5::int
      FOR UPDATE`,
    tenant,
    id,
    String(candidate.patient_uid),
    candidate.invoice_id == null ? null : Number(candidate.invoice_id),
    candidate.advance_id == null ? null : Number(candidate.advance_id),
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Refund funding authority changed concurrently',
      'BILLING_REFUND_FUNDING_AUTHORITY_CHANGED',
    );
  }
  return {
    refund: rows[0],
    parent,
    storedPatientUid: String(candidate.patient_uid),
    fundingPatientUid: identity.fundingPatientUid,
  };
}

async function assertPatientInTenant(patientUid, tenantId, db = prisma) {
  const tenant = normalizeTenantId(tenantId);
  if (!tenant || !patientUid) return;
  const rows = await db.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE uid = $1::uuid
        AND tenant_id = $2::uuid
      LIMIT 1`,
    String(patientUid),
    tenant,
  );
  if (!rows.length) throw AppError.notFound('Patient not found');
}

export function parseDiscountAmount(amount) {
  if (amount === undefined || amount === null || amount === '') {
    throw AppError.badRequest('amount is required');
  }
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) throw AppError.badRequest('amount must be numeric');
  if (parsed < 0) throw AppError.badRequest('Discount cannot be negative');
  return toFixed2(parsed);
}

export function canApproveHighValueDiscount(role) {
  return HIGH_VALUE_DISCOUNT_APPROVER_ROLES.includes(String(role || '').trim().toUpperCase());
}

export function requiresDiscountApproval({ amount, invoiceGross }) {
  const discountAmount = Number(amount);
  const gross = Number(invoiceGross || 0);
  return discountAmount > DISCOUNT_APPROVAL_AMOUNT_THRESHOLD ||
    (gross > 0 && discountAmount > toFixed2((gross * DISCOUNT_APPROVAL_PERCENT_THRESHOLD) / 100));
}

/**
 * Compute GST split for a single line.
 *
 * Indian rule: when patient_state === hospital_state, the tax is split
 * evenly between CGST + SGST. Otherwise it's a single IGST line. State
 * is compared case-insensitively after trim.
 */
export function splitGst({ subtotal, gstRate, patientState, hospitalState }) {
  const taxable = toFixed2(subtotal);
  const taxAmount = toFixed2((taxable * Number(gstRate || 0)) / 100);
  const sameState = (patientState || '').trim().toLowerCase() ===
                    (hospitalState || '').trim().toLowerCase();
  if (taxAmount <= 0) {
    return { cgst: 0, sgst: 0, igst: 0, lineTotal: taxable };
  }
  if (sameState) {
    const half = toFixed2(taxAmount / 2);
    // Avoid 0.01 rounding drift between halves: assign drift to SGST.
    const cgst = half;
    const sgst = toFixed2(taxAmount - half);
    return { cgst, sgst, igst: 0, lineTotal: toFixed2(taxable + cgst + sgst) };
  }
  return { cgst: 0, sgst: 0, igst: taxAmount, lineTotal: toFixed2(taxable + taxAmount) };
}

async function nextInvoiceNumber(tenantId, db = prisma) {
  // Atomic UPSERT-and-increment on (tenant, fiscal_year). Postgres
  // RETURNING gives us the just-claimed value. If two requests race
  // they take different rows because of the FOR UPDATE on the
  // existing row.
  const fy = fiscalYearOf();
  const rows = await db.$queryRawUnsafe(
    `INSERT INTO billing_invoice_counter (tenant_id, fiscal_year, next_value)
     VALUES ($1::uuid, $2, 2)
     ON CONFLICT (tenant_id, fiscal_year)
     DO UPDATE SET next_value = billing_invoice_counter.next_value + 1
     RETURNING next_value`,
    String(tenantId),
    fy,
  );
  // On INSERT we returned 2; the issued number is 1.
  // On UPDATE the returned next_value is the just-incremented "next",
  // so the issued number is next_value - 1.
  const inserted = rows[0]?.next_value === 2;
  const issuedSeq = inserted ? 1 : rows[0].next_value - 1;
  const padded = String(issuedSeq).padStart(6, '0');
  return `INV-${fy}-${padded}`;
}

export async function recomputeInvoiceTotals(invoiceId, db = prisma, { emitTpaAlert = true } = {}) {
  const aggregates = await db.$queryRawUnsafe(
    `SELECT
       COALESCE(SUM(line_subtotal), 0)::numeric AS subtotal,
       COALESCE(SUM(cgst_amount), 0)::numeric   AS cgst,
       COALESCE(SUM(sgst_amount), 0)::numeric   AS sgst,
       COALESCE(SUM(igst_amount), 0)::numeric   AS igst
     FROM billing_invoice_items
     WHERE invoice_id = $1::int AND source_ref_active=TRUE`,
    invoiceId,
  );
  const a = aggregates[0];
  const subtotal = Number(a.subtotal);
  const cgst = Number(a.cgst);
  const sgst = Number(a.sgst);
  const igst = Number(a.igst);
  // discount preserved from the existing row; we read it back so we
  // can recompute total + due correctly.
  const inv = await db.$queryRawUnsafe(
    `SELECT discount_amount, credit_note_amount, amount_paid
       FROM billing_invoices WHERE id = $1::int`,
    invoiceId,
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
  const discount = Number(inv[0].discount_amount || 0);
  const total = toFixed2(subtotal + cgst + sgst + igst - discount);
  const credited = Number(inv[0].credit_note_amount || 0);
  const paid = Number(inv[0].amount_paid || 0);
  const due = toFixed2(Math.max(0, total - credited - paid));

  await db.$executeRawUnsafe(
    `UPDATE billing_invoices
        SET subtotal = $1::numeric,
            cgst_amount = $2::numeric,
            sgst_amount = $3::numeric,
            igst_amount = $4::numeric,
            total_amount = $5::numeric,
            amount_due = $6::numeric,
            updated_at = NOW()
      WHERE id = $7::int`,
    subtotal, cgst, sgst, igst, total, due, invoiceId,
  );

  // TPA cap-proximity alert. The new total_amount may have crossed
  // the 80% / 100% rungs of the admission's approved cap — surface
  // it as a clinical alert so the cashier sees a flag at the next
  // dashboard refresh. Idempotent (won't double-emit while the prior
  // alert is unacknowledged). Errors are caught + logged but never
  // bubble up — the invoice update is authoritative.
  const meta = await db.$queryRawUnsafe(
    `SELECT admission_id, patient_uid, tenant_id
       FROM billing_invoices WHERE id = $1::int`,
    invoiceId,
  );
  if (emitTpaAlert && meta.length && meta[0].admission_id && meta[0].patient_uid) {
    try {
      await maybeEmitTpaCapAlerts({
        admissionId: meta[0].admission_id,
        patientUid: meta[0].patient_uid,
        tenantId: meta[0].tenant_id,
        totalAmount: total,
      });
    } catch (alertErr) {
      logger.error('Failed to emit TPA cap proximity alert', {
        invoice_id: invoiceId,
        error: alertErr.message,
      });
    }
  }

  return { subtotal, cgst, sgst, igst, discount, total, credited, paid, due };
}

/**
 * Recompute amount_paid / amount_due / status from the live payment +
 * advance-settlement rows. MUST run inside an open transaction (`tx`) that has
 * already `SELECT … FOR UPDATE`-locked the invoice row, so two concurrent
 * payments can't both read a stale `amount_due` and both succeed → overpayment.
 * The aggregate sum is computed under the same lock the caller holds.
 */
async function recomputeInvoicePaymentStateTx(tx, invoiceId) {
  const normalizedInvoiceId = Number(invoiceId);
  const aggr = await tx.$queryRawUnsafe(
    `SELECT (
            SELECT COALESCE(SUM(amount), 0)::numeric
              FROM billing_payments
             WHERE invoice_id = $1::int AND reversed = false
          ) + (
            SELECT COALESCE(SUM(amount), 0)::numeric
              FROM billing_advance_settlements
             WHERE invoice_id = $1::int
          ) AS paid`,
    normalizedInvoiceId,
  );
  const paid = Number(aggr[0].paid);
  const inv = await tx.$queryRawUnsafe(
    `SELECT total_amount, credit_note_amount FROM billing_invoices WHERE id = $1::int`,
    normalizedInvoiceId,
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
  const total = Number(inv[0].total_amount);
  const credited = Number(inv[0].credit_note_amount || 0);
  const due = toFixed2(Math.max(0, total - credited - paid));
  let status = 'PARTIAL';
  if (due <= 0.005) status = 'PAID';
  else if (paid <= 0.005) status = 'ISSUED';
  await tx.$executeRawUnsafe(
    `UPDATE billing_invoices
        SET amount_paid = $1::numeric, amount_due = $2::numeric, status = $3, updated_at = NOW()
      WHERE id = $4::int`,
    paid, due, status, normalizedInvoiceId,
  );
  return { paid, due, status };
}

/**
 * Phase 4-3 (enforce): derive the invoice's cached amount_paid / amount_due /
 * status FROM the ledger — amount_due = (PATIENT_AR + INSURANCE_AR) balance for
 * the invoice — instead of the legacy Σ(billing_payments)+Σ(settlements)
 * recompute. MUST run AFTER the movement's ledger post so ledger_balances
 * already reflects it. Uses the IDENTICAL status thresholds as
 * recomputeInvoicePaymentStateTx, so enforce and shadow agree whenever the
 * ledger and the event tables are consistent. The (PATIENT_AR + INSURANCE_AR)
 * sum preserves legacy semantics across the insurance two-step (approval shifts
 * AR -> INSURANCE_AR without changing the patient's due).
 */
export async function deriveInvoicePaymentStateFromLedgerTx(tx, invoiceId) {
  const normalizedInvoiceId = Number(invoiceId);
  const arRows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(b.balance_paise), 0)::bigint AS due_paise
       FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id
      WHERE a.code IN ('PATIENT_AR', 'INSURANCE_AR') AND b.invoice_id = $1::int`,
    normalizedInvoiceId,
  );
  const inv = await tx.$queryRawUnsafe(
    `SELECT total_amount, credit_note_amount FROM billing_invoices WHERE id = $1::int`,
    normalizedInvoiceId,
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
  const total = Number(inv[0].total_amount);
  const credited = Number(inv[0].credit_note_amount || 0);
  const due = toFixed2(Number(arRows[0].due_paise) / 100);
  const paid = toFixed2(Math.max(0, total - credited - due));
  let status = 'PARTIAL';
  if (due <= 0.005) status = 'PAID';
  else if (paid <= 0.005) status = 'ISSUED';
  await tx.$executeRawUnsafe(
    `UPDATE billing_invoices
        SET amount_paid = $1::numeric, amount_due = $2::numeric, status = $3, updated_at = NOW()
      WHERE id = $4::int`,
    paid, due, status, normalizedInvoiceId,
  );
  return { paid, due, status };
}

/**
 * Phase 4-3 (enforce): derive an advance's cached balance FROM the ledger
 * (PATIENT_ADVANCE balance for the advance_id), instead of the legacy in-place
 * decrement. MUST run AFTER the movement's ledger post. Advance STATUS is
 * operation-specific (EXHAUSTED on settle, REFUNDED on refund, ACTIVE on
 * collect) and is NOT a pure function of the balance, so the caller passes the
 * status to apply when the balance reaches zero; a non-zero balance keeps the
 * current status.
 */
export async function deriveAdvanceBalanceFromLedgerTx(tx, advanceId, { exhaustedStatus = 'EXHAUSTED' } = {}) {
  const normalizedAdvanceId = Number(advanceId);
  const rows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(b.balance_paise), 0)::bigint AS bal_paise
       FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id
      WHERE a.code = 'PATIENT_ADVANCE' AND b.advance_id = $1::int`,
    normalizedAdvanceId,
  );
  const balance = toFixed2(Number(rows[0].bal_paise) / 100);
  await tx.$executeRawUnsafe(
    `UPDATE billing_advances
        SET balance = $1::numeric,
            status = CASE WHEN $1::numeric <= 0.005 THEN $2 ELSE status END,
            updated_at = NOW()
      WHERE id = $3::int`,
    balance, exhaustedStatus, normalizedAdvanceId,
  );
  return { balance };
}

async function syncUnusedAdmissionAdvancesForInvoice(invoiceId, paymentState, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, admission_id
       FROM billing_invoices
      WHERE id = $1::int
      LIMIT 1`,
    Number(invoiceId),
  );
  const invoice = rows[0] ?? null;
  if (!invoice?.admission_id) return;

  if (paymentState?.status === 'PAID') {
    await db.$executeRawUnsafe(
      `UPDATE billing_advances
          SET status = 'REFUND_DUE',
              notes = CONCAT_WS(' | ', NULLIF(notes, ''), $2::text),
              updated_at = NOW()
        WHERE admission_id = $1::int
          AND status = 'ACTIVE'
          AND balance > 0.005`,
      Number(invoice.admission_id),
      `Invoice ${Number(invoiceId)} paid without consuming this advance; refund or reallocate after finance review.`,
    );
    return;
  }

  await db.$executeRawUnsafe(
    `UPDATE billing_advances
        SET status = 'ACTIVE',
            updated_at = NOW()
      WHERE admission_id = $1::int
        AND status = 'REFUND_DUE'
        AND balance > 0.005`,
    Number(invoice.admission_id),
  );
}

// ───────────────────────────────────────────────────────────────────────
// Service master
// ───────────────────────────────────────────────────────────────────────

export async function listServiceMaster({ category, search, includeInactive = false } = {}) {
  const filters = [];
  const params = [];
  if (!includeInactive) filters.push('is_active = true');
  if (category) {
    params.push(category);
    filters.push(`category = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    filters.push(`(LOWER(code) LIKE $${params.length} OR LOWER(description) LIKE $${params.length})`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return prisma.$queryRawUnsafe(
    `SELECT id, code, description, category, default_price, gst_rate, hsn_sac, is_active
       FROM billing_service_master
       ${where}
       ORDER BY category, code
       LIMIT 500`,
    ...params,
  );
}

export async function createServiceMaster({ code, description, category, default_price, gst_rate, hsn_sac }) {
  if (!code || !description || !category) {
    throw AppError.badRequest('code, description, category are required');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_service_master (code, description, category, default_price, gst_rate, hsn_sac)
     VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6)
     RETURNING id, code, description, category, default_price, gst_rate, hsn_sac, is_active`,
    code, description, category, Number(default_price ?? 0), Number(gst_rate ?? 0), hsn_sac || null,
  );
  return rows[0];
}

export async function updateServiceMaster(id, patch) {
  const allowed = ['description', 'category', 'default_price', 'gst_rate', 'hsn_sac', 'is_active'];
  const fields = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!fields.length) throw AppError.badRequest('No valid fields to update');
  const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map((f) => patch[f]);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE billing_service_master
        SET ${setClauses}, updated_at = NOW()
      WHERE id = $1::int
      RETURNING id, code, description, category, default_price, gst_rate, hsn_sac, is_active`,
    Number(id), ...values,
  );
  if (!rows.length) throw AppError.notFound('Service not found');
  return rows[0];
}

// ───────────────────────────────────────────────────────────────────────
// Invoice lifecycle
// ───────────────────────────────────────────────────────────────────────

/**
 * Hard billing-close enforcement (B-1). Once D2's discharge cascade
 * stamps `admissions.billing_closed_at`, any further write against
 * that admission's invoices is a 409 Conflict. This guards every
 * write path: createDraftInvoice, addInvoiceItem, removeInvoiceItem,
 * applyDiscount, voidInvoice, etc. Read paths stay unchanged.
 *
 * Companion to D2 (migration 173) — D2 set the flag, B-1 enforces it.
 * Finding pattern: closed-admission invoice writes corrupt the
 * settled balance and ripple through TPA reconciliation.
 */
async function assertAdmissionBillingOpen(
  admissionId,
  db = prisma,
  {
    tenantId = null,
    lock = false,
    patientUid = null,
    requireAdmission = false,
  } = {},
) {
  if (admissionId == null || admissionId === '') return null;
  const id = Number(admissionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('admission_id must be a positive integer');
  }
  const params = [id];
  const tenantSql = appendTenantPredicate(params, tenantId);
  const rows = await db.$queryRawUnsafe(
    `SELECT patient_uid, billing_closed_at
       FROM admissions
      WHERE id = $1::int${tenantSql}
      ${lock ? 'FOR SHARE' : ''}`,
    ...params,
  );
  if (!rows.length) {
    if (requireAdmission) throw AppError.notFound('Admission not found');
    return null;
  }
  if (patientUid && String(rows[0].patient_uid) !== String(patientUid)) {
    throw AppError.conflict(
      `Admission ${id} belongs to a different patient`,
      'BILLING_ADMISSION_PATIENT_MISMATCH',
    );
  }
  if (rows.length && rows[0].billing_closed_at) {
    throw AppError.conflict(
      `Billing is closed for admission ${id} (closed at ${rows[0].billing_closed_at.toISOString?.() ?? rows[0].billing_closed_at}). ` +
      'Reopen the admission via the discharge cascade before further invoice writes.',
      'BILLING_CLOSED',
    );
  }
  return rows[0];
}

export async function createDraftInvoice({
  patient_uid, patient_name, patient_phone, admission_id, doctor_uid,
  department, invoice_type = 'OP', patient_state, hospital_state,
  notes, created_by, tenantId,
}, { db = prisma } = {}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!VALID_INVOICE_TYPES.includes(invoice_type)) {
    throw AppError.badRequest(`Invalid invoice_type. Allowed: ${VALID_INVOICE_TYPES.join(', ')}`);
  }
  const tenant = requireTenantId(normalizeTenantId(tenantId));
  const createWithClient = async (client) => {
    // Hold the admission share lock until the invoice insert commits so the
    // discharge close cannot pass between this check and the write.
    await assertAdmissionBillingOpen(admission_id, client, {
      tenantId: tenant,
      lock: true,
      patientUid: patient_uid,
      requireAdmission: admission_id != null && admission_id !== '',
    });
    if (tenantId) await assertPatientInTenant(patient_uid, tenant, client);
    const rows = await client.$queryRawUnsafe(
      `INSERT INTO billing_invoices
        (patient_uid, patient_name, patient_phone, admission_id, doctor_uid,
         department, invoice_type, patient_state, hospital_state, notes, created_by, tenant_id)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11::uuid, $12::uuid)
       RETURNING id, invoice_number, patient_uid, patient_name, patient_phone,
                 admission_id, doctor_uid, department, invoice_type,
                  patient_state, hospital_state, subtotal, cgst_amount, sgst_amount,
                  igst_amount, discount_amount, total_amount, credit_note_amount, amount_paid,
                  amount_due, status, notes, tenant_id, created_at`,
      String(patient_uid),
      patient_name || null,
      patient_phone || null,
      admission_id ? Number(admission_id) : null,
      doctor_uid ? String(doctor_uid) : null,
      department || null,
      invoice_type,
      patient_state || null,
      hospital_state || null,
      notes || null,
      created_by ? String(created_by) : null,
      tenant,
    );
    return rows[0];
  };
  return db === prisma
    ? setTenantTx(tenant, createWithClient)
    : createWithClient(db);
}

// Allowed source-ref types. Anything outside this list is rejected at
// the API surface so the audit-trail vocabulary stays bounded. 'manual'
// is the default for free-text cashier entries (and the backfill value
// for pre-migration-199 historicals); 'package' covers packaged
// bundles that legitimately have no source row. Migration 199.
// Finding: 2026-05-10-inpatient-admission-billing-final-bill-untraceable-package-line.
const VALID_SOURCE_REF_TYPES = new Set([
  'appointment',
  'teleconsultation',
  'lab_order',
  'radiology_order',
  'pharmacy_order',
  'ward_indent',
  'room_day',
  'discharge_consult',
  'theatre_case',
  'dialysis_session',
  'cath_procedure_log',
  'cath_consumable_usage',
  'pharmacy_counter_sale',
  'admission_package',
  'package',
  'manual',
]);

// Source_ref_types that legitimately have no originating source row: a
// cashier-typed manual line, and packaged bundles (the package/admission is
// itself the "source"). Every other type is order/day/event-backed and must
// carry a source_ref_id so the itemised charge is auditable.
// Finding: 2026-05-20-tpa-insurance-claim-billing-013275c3.
const SOURCE_REF_ID_OPTIONAL = new Set(['manual', 'package', 'admission_package']);

const TENANT_PATIENT_SOURCE_REF_SQL = Object.freeze({
  pharmacy_order: `SELECT po.id
    FROM pharmacy_orders po
    JOIN users patient
      ON patient.tenant_id = po.tenant_id
     AND patient.id = po.patient_id
     AND patient.role = 'PATIENT'
     AND patient.is_active = TRUE
     AND patient.status = 'active'
     AND patient.is_deleted = FALSE
     AND patient.merged_into_uid IS NULL
    LEFT JOIN admissions admission
      ON admission.tenant_id = po.tenant_id
     AND admission.id = $4::int
     AND admission.patient_uid = patient.uid
   WHERE po.id = $1::bigint
     AND po.tenant_id = $2::uuid
     AND patient.uid = $3::uuid
     AND (po.uid IS NULL OR po.uid = patient.uid)
     AND (
       ($4::int IS NULL AND po.funding_admission_id IS NULL)
       OR
       ($4::int IS NOT NULL AND admission.id IS NOT NULL
        AND po.funding_admission_id=admission.id)
     )
     AND po.status IN ('DISPENSED','DELIVERED')
     AND COALESCE(po.dispensed_at,po.delivered_at) IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pharmacy_stock_movements movement
        WHERE movement.tenant_id=po.tenant_id
          AND movement.metadata->>'order_id'=po.id::text
          AND movement.movement_kind='issue'
          AND movement.quantity_delta < 0
          AND movement.metadata->>'contract' IN (
            'pharmacy_order_inventory_allocation_v1',
            'pharmacy_dispense_substitution_v1'
          )
     )
   LIMIT 1`,
  ward_indent: `SELECT wi.id
    FROM ward_indents wi
    LEFT JOIN admissions a
      ON a.id = wi.admission_id
     AND a.tenant_id = wi.tenant_id
   WHERE wi.id = $1::bigint
     AND wi.tenant_id = $2::uuid
     AND (
       (wi.patient_uid = $3::uuid AND (a.id IS NULL OR a.patient_uid = wi.patient_uid))
       OR (wi.patient_uid IS NULL AND a.patient_uid = $3::uuid)
     )
   LIMIT 1`,
  dialysis_session: `SELECT s.id
    FROM dialysis_sessions s
    JOIN dialysis_patients p
      ON p.id = s.dialysis_patient_id
     AND p.tenant_id = s.tenant_id
   WHERE s.id = $1::bigint
     AND s.tenant_id = $2::uuid
     AND p.patient_uid = $3::uuid
   LIMIT 1`,
  cath_procedure_log: `SELECT p.id
    FROM cath_procedure_logs p
   WHERE p.id = $1::bigint
     AND p.tenant_id = $2::uuid
     AND p.patient_uid = $3::uuid
   LIMIT 1`,
  cath_consumable_usage: `SELECT u.id
    FROM cath_case_consumable_usage u
   WHERE u.id = $1::bigint
     AND u.tenant_id = $2::uuid
     AND u.patient_uid = $3::uuid
   LIMIT 1`,
});

async function assertSourceReferenceBelongsToInvoice({
  sourceRefType,
  sourceRefId,
  invoiceTenantId,
  invoicePatientUid,
  invoiceAdmissionId = null,
  db = prisma,
}) {
  const ownershipSql = TENANT_PATIENT_SOURCE_REF_SQL[sourceRefType];
  if (!ownershipSql) return;
  const ownershipParams = [sourceRefId, invoiceTenantId, String(invoicePatientUid)];
  if (sourceRefType === 'pharmacy_order') {
    ownershipParams.push(invoiceAdmissionId == null ? null : Number(invoiceAdmissionId));
  }
  const rows = await db.$queryRawUnsafe(ownershipSql, ...ownershipParams);
  if (!rows.length) {
    throw AppError.badRequest(
      'Billing source reference does not belong to this invoice patient and tenant',
      'BILLING_SOURCE_REF_MISMATCH',
      { source_ref_type: sourceRefType },
    );
  }
}

export async function addInvoiceItem(invoiceId, {
  service_code, description, category, quantity = 1, unit_price, gst_rate, notes,
  source_ref_type, source_ref_id, tenantId,
}) {
  // Ad-hoc lines (no service_code) may carry a caller-supplied category
  // so per-category TPA caps (`insurance_claim_caps`) and pharmacy/cap
  // probes can match them. service_code branch still wins — the master
  // row is the canonical source when it exists.
  if (category != null && !VALID_INVOICE_LINE_CATEGORIES.has(String(category))) {
    throw AppError.badRequest(
      `Invalid category "${category}". Allowed: ${Array.from(VALID_INVOICE_LINE_CATEGORIES).join(', ')}`,
    );
  }
  const resolved = {
    description,
    category: category != null ? String(category) : null,
    hsn_sac: null,
    unit_price,
    gst_rate,
  };
  if (!service_code && !resolved.description) {
    throw AppError.badRequest('description (or valid service_code) is required');
  }
  if (!service_code && resolved.unit_price == null) {
    throw AppError.badRequest('unit_price is required for ad-hoc lines');
  }

  // source_ref_type defaults to 'manual' (cashier-typed line, no source
  // record). Callers that produce a line from a completed lab/order/
  // indent/etc must pass the source pair so the bill stays auditable.
  // Permits 'package' / 'admission_package' with null id for bundles.
  const resolvedSourceRefType = source_ref_type ? String(source_ref_type).toLowerCase() : 'manual';
  if (!VALID_SOURCE_REF_TYPES.has(resolvedSourceRefType)) {
    throw AppError.badRequest(
      `Invalid source_ref_type "${source_ref_type}". Allowed: ${Array.from(VALID_SOURCE_REF_TYPES).join(', ')}`,
    );
  }
  const resolvedSourceRefId = normalizeSourceRefId(source_ref_id);
  // Source-backed line types must carry the originating record's id so an
  // itemised charge stays auditable back to its room-day / order / event —
  // closing the gap where a ₹65k room_rent line could be pushed against a
  // TPA cap with no traceable source.
  // Finding: 2026-05-20-tpa-insurance-claim-billing-013275c3.
  if (!SOURCE_REF_ID_OPTIONAL.has(resolvedSourceRefType) && resolvedSourceRefId == null) {
    throw AppError.badRequest(
      `source_ref_id is required for source_ref_type "${resolvedSourceRefType}" so the bill line is auditable to its originating record.`,
      'SOURCE_REF_ID_REQUIRED',
      { source_ref_type: resolvedSourceRefType },
    );
  }

  let invoiceTenantId = normalizeTenantId(tenantId);
  if (!invoiceTenantId) {
    const tenantRow = await findBillingInvoice(invoiceId, null, 'tenant_id');
    if (!tenantRow) throw AppError.notFound('Invoice not found');
    invoiceTenantId = normalizeTenantId(tenantRow.tenant_id);
  }
  invoiceTenantId = requireTenantId(invoiceTenantId);

  const mutation = await setTenantTx(invoiceTenantId, async (tx) => {
    const invoice = await lockBillingInvoice(
      tx,
      invoiceId,
      invoiceTenantId,
      'status, patient_state, hospital_state, admission_id, patient_uid, tenant_id',
    );
    if (!invoice) throw AppError.notFound('Invoice not found');
    if (invoice.status !== 'DRAFT') {
      throw AppError.badRequest('Cannot add items to an issued/voided invoice');
    }
    await assertAdmissionBillingOpen(invoice.admission_id, tx, {
      tenantId: invoiceTenantId,
      lock: true,
    });

    if (service_code) {
      const sm = await tx.$queryRawUnsafe(
        `SELECT description, category, hsn_sac, default_price, gst_rate
           FROM billing_service_master
          WHERE code = $1
            AND tenant_id = $2::uuid
            AND is_active = true
          LIMIT 1`,
        service_code,
        invoiceTenantId,
      );
      if (sm.length) {
        resolved.description = description || sm[0].description;
        resolved.category = sm[0].category;
        resolved.hsn_sac = sm[0].hsn_sac;
        if (resolved.unit_price == null) resolved.unit_price = Number(sm[0].default_price);
        if (resolved.gst_rate == null) resolved.gst_rate = Number(sm[0].gst_rate);
      }
    }
    if (!resolved.description) {
      throw AppError.badRequest('description (or valid service_code) is required');
    }
    if (resolved.unit_price == null) {
      throw AppError.badRequest('unit_price is required for ad-hoc lines');
    }

    await assertSourceReferenceBelongsToInvoice({
      sourceRefType: resolvedSourceRefType,
      sourceRefId: resolvedSourceRefId,
      invoiceTenantId,
      invoicePatientUid: invoice.patient_uid,
      invoiceAdmissionId: invoice.admission_id,
      db: tx,
    });

    const qty = Number(quantity) || 1;
    const price = Number(resolved.unit_price);
    const rate = Number(resolved.gst_rate || 0);
    const lineSub = toFixed2(qty * price);
    const split = splitGst({
      subtotal: lineSub,
      gstRate: rate,
      patientState: invoice.patient_state,
      hospitalState: invoice.hospital_state,
    });
    const insertSql = `INSERT INTO billing_invoice_items
        (invoice_id, service_code, description, category, hsn_sac, quantity,
         unit_price, gst_rate, line_subtotal, cgst_amount, sgst_amount,
         igst_amount, line_total, notes, source_ref_type, source_ref_id, tenant_id,
         source_ref_active)
       VALUES ($1::int, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric,
               $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14, $15, $16,
               $17::uuid, TRUE)`;
    const rows = await tx.$queryRawUnsafe(
      `${insertSql} RETURNING *`,
      Number(invoiceId), service_code || null, resolved.description, resolved.category,
      resolved.hsn_sac, qty, price, rate, lineSub,
      split.cgst, split.sgst, split.igst, split.lineTotal, notes || null,
      resolvedSourceRefType, resolvedSourceRefId, invoiceTenantId,
    );
    const totals = await recomputeInvoiceTotals(
      Number(invoiceId),
      tx,
      { emitTpaAlert: false },
    );
    return { item: rows[0], invoice, totals };
  });

  if (mutation.invoice.admission_id && mutation.invoice.patient_uid) {
    try {
      await maybeEmitTpaCapAlerts({
        admissionId: mutation.invoice.admission_id,
        patientUid: mutation.invoice.patient_uid,
        tenantId: invoiceTenantId,
        totalAmount: mutation.totals.total,
      });
    } catch (alertErr) {
      logger.error('Failed to emit TPA cap proximity alert', {
        invoice_id: invoiceId,
        error: alertErr.message,
      });
    }
  }
  return normalizeBillingItemForResponse(mutation.item);
}

export async function removeInvoiceItem(invoiceId, itemId, { tenantId } = {}) {
  let invoiceTenantId = normalizeTenantId(tenantId);
  if (!invoiceTenantId) {
    const tenantRow = await findBillingInvoice(invoiceId, null, 'tenant_id');
    if (!tenantRow) throw AppError.notFound('Invoice not found');
    invoiceTenantId = normalizeTenantId(tenantRow.tenant_id);
  }
  invoiceTenantId = requireTenantId(invoiceTenantId);
  return setTenantTx(invoiceTenantId, async (tx) => {
    const invoice = await lockBillingInvoice(
      tx,
      invoiceId,
      invoiceTenantId,
      'status, admission_id',
    );
    if (!invoice) throw AppError.notFound('Invoice not found');
    if (invoice.status !== 'DRAFT') {
      throw AppError.badRequest('Cannot remove items from an issued/voided invoice');
    }
    await assertAdmissionBillingOpen(invoice.admission_id, tx, {
      tenantId: invoiceTenantId,
      lock: true,
    });
    await tx.$executeRawUnsafe(
      `DELETE FROM billing_invoice_items
        WHERE invoice_id = $1::int
          AND id = $2::int
          AND tenant_id = $3::uuid`,
      Number(invoiceId),
      Number(itemId),
      invoiceTenantId,
    );
    return recomputeInvoiceTotals(
      Number(invoiceId),
      tx,
      { emitTpaAlert: false },
    );
  });
}

export async function applyDiscount(invoiceId, { amount, reason, approved_by, approved_by_role, tenantId }) {
  const discountAmount = parseDiscountAmount(amount);
  let invoiceTenantId = normalizeTenantId(tenantId);
  if (!invoiceTenantId) {
    const tenantRow = await findBillingInvoice(invoiceId, null, 'tenant_id');
    if (!tenantRow) throw AppError.notFound('Invoice not found');
    invoiceTenantId = normalizeTenantId(tenantRow.tenant_id);
  }
  invoiceTenantId = requireTenantId(invoiceTenantId);
  return setTenantTx(invoiceTenantId, async (tx) => {
    const invoice = await lockBillingInvoice(
      tx,
      invoiceId,
      invoiceTenantId,
      'status, subtotal, cgst_amount, sgst_amount, igst_amount, admission_id',
    );
    if (!invoice) throw AppError.notFound('Invoice not found');
    if (invoice.status !== 'DRAFT') {
      throw AppError.conflict(
        'Discounts can only change a draft invoice; use an auditable credit workflow after issue',
        'BILLING_DISCOUNT_REQUIRES_DRAFT_INVOICE',
      );
    }
    await assertAdmissionBillingOpen(invoice.admission_id, tx, {
      tenantId: invoiceTenantId,
      lock: true,
    });
    const invoiceGross = toFixed2(
      Number(invoice.subtotal || 0)
      + Number(invoice.cgst_amount || 0)
      + Number(invoice.sgst_amount || 0)
      + Number(invoice.igst_amount || 0),
    );
    if (
      requiresDiscountApproval({ amount: discountAmount, invoiceGross })
      && !canApproveHighValueDiscount(approved_by_role)
    ) {
      throw AppError.forbidden(
        `Discounts above INR ${DISCOUNT_APPROVAL_AMOUNT_THRESHOLD} or ${DISCOUNT_APPROVAL_PERCENT_THRESHOLD}% `
          + 'require FINANCE_INCHARGE, ADMIN, or SUPER_ADMIN approval',
        'DISCOUNT_APPROVAL_REQUIRED',
      );
    }

    await tx.$executeRawUnsafe(
      `UPDATE billing_invoices
          SET discount_amount = $1::numeric,
              discount_reason = $2,
              discount_approved_by = $3::uuid,
              updated_at = NOW()
        WHERE id = $4::int
          AND tenant_id = $5::uuid`,
      discountAmount,
      reason || null,
      approved_by ? String(approved_by) : null,
      Number(invoiceId),
      invoiceTenantId,
    );
    return recomputeInvoiceTotals(
      Number(invoiceId),
      tx,
      { emitTpaAlert: false },
    );
  });
}

export async function issueInvoiceTx(tx, { invoiceId, tenantId, wiring }) {
  const tenant = requireTenantId(tenantId);
  // GST compliance: backfill recipient name/phone and (for IP) issuing
  // doctor + department at issue time. These are statutory snapshot
  // fields — a B2C tax invoice with null recipient name is not a valid
  // tax document, and joining at read time loses the value if the
  // patient/admission row changes later. Finding:
  //   2026-05-09-inpatient-admission-billing-invoice-missing-patient-fields
  // The DRAFT→ISSUED update runs under the same row lock as the state recheck.
  const doIssueUpdate = (number) => tx.$executeRawUnsafe(
    `UPDATE billing_invoices
        SET invoice_number = $1,
            status = 'ISSUED',
            issued_at = NOW(),
            updated_at = NOW(),
            patient_name = COALESCE(
              billing_invoices.patient_name,
              (SELECT u.name FROM users u
                WHERE u.uid = billing_invoices.patient_uid
                  AND u.tenant_id = billing_invoices.tenant_id
                LIMIT 1)
            ),
            patient_phone = COALESCE(
              billing_invoices.patient_phone,
              (SELECT u.phone FROM users u
                WHERE u.uid = billing_invoices.patient_uid
                  AND u.tenant_id = billing_invoices.tenant_id
                LIMIT 1)
            ),
            doctor_uid = COALESCE(
              billing_invoices.doctor_uid,
              (SELECT a.attending_doctor FROM admissions a
                WHERE a.id = billing_invoices.admission_id
                  AND a.tenant_id = billing_invoices.tenant_id
                LIMIT 1),
              (SELECT a.admitting_doctor FROM admissions a
                WHERE a.id = billing_invoices.admission_id
                  AND a.tenant_id = billing_invoices.tenant_id
                LIMIT 1)
            ),
            department = COALESCE(
              billing_invoices.department,
              (SELECT a.department FROM admissions a
                WHERE a.id = billing_invoices.admission_id
                  AND a.tenant_id = billing_invoices.tenant_id
                LIMIT 1)
            )
      WHERE id = $2::int
        AND tenant_id = $3::uuid`,
    number, Number(invoiceId), tenant,
  );
  // Issuing transitions DRAFT → ISSUED without changing totals; read them back
  // for the TPA cap re-check and the INVOICE_ISSUE ledger post.
  const readIssueMeta = () => tx.$queryRawUnsafe(
    `SELECT admission_id, patient_uid, tenant_id, total_amount,
            id, invoice_number, patient_name, patient_phone, doctor_uid,
            department, invoice_type, subtotal, cgst_amount, sgst_amount,
            igst_amount, discount_amount, credit_note_amount, amount_paid,
            amount_due, status, issued_at,
            GREATEST(total_amount - COALESCE(credit_note_amount, 0), 0) AS ledger_issue_amount,
            (COALESCE(cgst_amount,0) + COALESCE(sgst_amount,0) + COALESCE(igst_amount,0)) AS tax_amount
       FROM billing_invoices WHERE id = $1::int
        AND tenant_id = $2::uuid`,
    Number(invoiceId), tenant,
  );
  const locked = await lockBillingInvoice(
    tx,
    invoiceId,
    tenant,
    'id, status, tenant_id, admission_id, patient_uid',
  );
  if (!locked) throw AppError.notFound('Invoice not found');
  if (locked.status !== 'DRAFT') {
    throw AppError.badRequest(`Invoice is already ${locked.status}`);
  }
  await assertAdmissionBillingOpen(locked.admission_id, tx, {
    tenantId: tenant,
    lock: true,
    patientUid: locked.patient_uid,
    requireAdmission: locked.admission_id != null,
  });
  const items = await tx.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM billing_invoice_items
      WHERE invoice_id = $1::int
        AND tenant_id = $2::uuid`,
    Number(invoiceId),
    tenant,
  );
  if (items[0].c === 0) throw AppError.badRequest('Cannot issue an invoice with no items');

  const number = await nextInvoiceNumber(tenant, tx);
  await doIssueUpdate(number);
  const issuedMeta = await readIssueMeta();
  if (!issuedMeta.length) throw AppError.notFound('Invoice not found');
  const issued = {
    ...issuedMeta[0],
    id: issuedMeta[0].id ?? Number(invoiceId),
  };
  if (wiring.sameTx && issued.patient_uid) {
    await postInvoiceIssueEntry({
      invoice: {
        id: issued.id,
        patient_uid: issued.patient_uid,
        total_amount: issued.ledger_issue_amount,
        tax_amount: issued.tax_amount,
      },
      tenantId: issued.tenant_id,
      tx,
    });
  }
  return issued;
}

export async function issueInvoice(invoiceId, { tenantId } = {}) {
  const inv = await findBillingInvoice(
    invoiceId,
    tenantId,
    'id, status, tenant_id',
  );
  if (!inv) throw AppError.notFound('Invoice not found');
  if (inv.status !== 'DRAFT') {
    throw AppError.badRequest(`Invoice is already ${inv.status}`);
  }
  const tenant = requireTenantId(inv.tenant_id);
  const wiring = await resolveLedgerWiring(tenant);
  const meta = await setTenantTx(tenant, (tx) => issueInvoiceTx(tx, {
    invoiceId,
    tenantId: tenant,
    wiring,
  }));

  // Re-check the TPA cap so a draft that's already over cap surfaces an alert at
  // issuance (best-effort, both modes). recomputeInvoiceTotals only fires on
  // item / discount mutations.
  if (meta.admission_id && meta.patient_uid) {
    try {
      await maybeEmitTpaCapAlerts({
        admissionId: meta.admission_id,
        patientUid: meta.patient_uid,
        tenantId: meta.tenant_id,
        totalAmount: meta.total_amount,
      });
    } catch (alertErr) {
      logger.error('Failed to emit TPA cap proximity alert on issue', {
        invoice_id: invoiceId,
        error: alertErr.message,
      });
    }
  }

  // Shadow: post-commit best-effort INVOICE_ISSUE (debit PATIENT_AR / credit
  // REVENUE) — the legacy invoice is already ISSUED, a ledger failure is logged
  // and dropped, reconciliation (Phase 2b) catches drift. Off: skip.
  if (wiring.postCommit && meta.patient_uid) {
    try {
      await postInvoiceIssueEntry({
        invoice: {
          id: meta.id,
          patient_uid: meta.patient_uid,
          total_amount: meta.ledger_issue_amount,
          tax_amount: meta.tax_amount,
        },
        tenantId: meta.tenant_id,
      });
    } catch (ledgerErr) {
      logger.error('Ledger INVOICE_ISSUE post failed (non-blocking)', { invoice_id: invoiceId, error: ledgerErr.message });
    }
  }

  return getInvoice(invoiceId, { tenantId });
}

export async function voidInvoice(invoiceId, { reason, voided_by, tenantId }) {
  if (!reason) throw AppError.badRequest('reason is required for voiding');
  const inv = await findBillingInvoice(
    invoiceId,
    tenantId,
    'status, tenant_id',
  );
  if (!inv) throw AppError.notFound('Invoice not found');
  if (inv.status === 'VOID') throw AppError.badRequest('Already void');
  if (inv.status !== 'DRAFT') {
    throw AppError.conflict(
      'Only a draft invoice can be voided; finalized invoices require an auditable reversal workflow',
      'BILLING_INVOICE_REVERSAL_WORKFLOW_REQUIRED',
    );
  }

  const tenant = requireTenantId(inv.tenant_id);
  await setTenantTx(tenant, async (tx) => {
    const locked = await lockBillingInvoice(tx, invoiceId, tenant, 'status');
    if (!locked) throw AppError.notFound('Invoice not found');
    if (locked.status === 'VOID') throw AppError.badRequest('Already void');
    if (locked.status !== 'DRAFT') {
      throw AppError.conflict(
        'Only a draft invoice can be voided; finalized invoices require an auditable reversal workflow',
        'BILLING_INVOICE_REVERSAL_WORKFLOW_REQUIRED',
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE billing_invoices
          SET status = 'VOID', voided_at = NOW(), voided_by = $1::uuid,
              void_reason = $2, updated_at = NOW()
        WHERE id = $3::int
          AND tenant_id = $4::uuid`,
      voided_by ? String(voided_by) : null,
      reason,
      Number(invoiceId),
      tenant,
    );
    await tx.$executeRawUnsafe(
      `UPDATE billing_invoice_items
          SET source_ref_active = FALSE
        WHERE invoice_id = $1::int
          AND tenant_id = $2::uuid
          AND source_ref_active = TRUE`,
      Number(invoiceId),
      tenant,
    );
  });
  return getInvoice(invoiceId, { tenantId });
}

// TPA cap-proximity alert thresholds. The 80% rung is the "tell the
// patient" line — billing should warn the cashier before they swipe
// another room charge that pushes the bill close to the sanctioned
// cap. The 100% rung is the "stop billing without confirmation" line.
// See finding
// 2026-05-09-tpa-insurance-claim-billing-no-cap-proximity-alert.
const TPA_CAP_WARN_PCT = 80;
const TPA_CAP_CRITICAL_PCT = 100;

/**
 * Emit clinical_alerts when an admission's bill crosses TPA cap
 * thresholds. Idempotent per (admission, severity) pair — we never
 * emit a second WARNING for the same admission while the previous
 * one is unacknowledged. Safe to call after every invoice mutation
 * (recompute / issue / payment) — duplicate suppression lives in
 * the query itself.
 *
 * Returns the array of alert rows actually inserted, or [] when no
 * threshold was crossed.
 *
 * Fire-and-forget callers should still `.catch` — we throw on
 * unexpected DB errors so unit tests can assert the failure path.
 */
async function maybeEmitTpaCapAlerts({ admissionId, patientUid, tenantId, totalAmount }) {
  if (!admissionId || !patientUid) return [];
  const cap = await resolveAdmissionTpaCap(admissionId, tenantId);
  if (!cap || cap.cumulative_approved <= 0) return [];

  const total = Number(totalAmount ?? 0);
  if (total <= 0) return [];
  const pct = (total / cap.cumulative_approved) * 100;

  // Translate the threshold ladder into the (alert_type, severity)
  // tuples we want to emit. Critical fires only when the bill has
  // crossed the cap; warning fires from 80% upward (and stays put if
  // the bill later crosses 100% — the critical row adds to it rather
  // than replacing it).
  const toEmit = [];
  if (pct >= TPA_CAP_CRITICAL_PCT) toEmit.push('CRITICAL');
  if (pct >= TPA_CAP_WARN_PCT) toEmit.push('WARNING');
  if (toEmit.length === 0) return [];

  // patient_id is an INT FK on clinical_alerts but admissions/invoices
  // key by patient_uid. Resolve once.
  const userRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`,
    String(patientUid),
  );
  if (!userRows.length) return [];
  const patientId = userRows[0].id;

  const inserted = [];
  for (const severity of toEmit) {
    // Idempotency probe: don't double-emit while an alert at the same
    // (admission, severity) is unacknowledged. `admission ${id}` in
    // the message is the join key — no separate column on
    // clinical_alerts for admission_id.
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_alerts
        WHERE patient_id = $1::int
          AND alert_type = 'TPA_CAP_PROXIMITY'
          AND severity = $2
          AND acknowledged = false
          AND message LIKE $3
        LIMIT 1`,
      Number(patientId),
      severity,
      `%admission ${admissionId}%`,
    );
    if (existing.length) continue;

    const remaining = Math.max(0, cap.cumulative_approved - total);
    const utilisationPct = Math.round(pct * 10) / 10;
    const message =
      severity === 'CRITICAL'
        ? `IPD bill for admission ${admissionId} (${cap.root_preauth_number}) ` +
          `at INR ${total.toFixed(2)} has exceeded the TPA approved cap of ` +
          `INR ${Number(cap.cumulative_approved).toFixed(2)} (${utilisationPct}%). ` +
          `Halt non-essential charges; raise enhancement preauth or collect ` +
          `patient liability before continuing.`
        : `IPD bill for admission ${admissionId} (${cap.root_preauth_number}) ` +
          `at INR ${total.toFixed(2)} of INR ${Number(cap.cumulative_approved).toFixed(2)} ` +
          `approved (${utilisationPct}%, INR ${remaining.toFixed(2)} remaining). ` +
          `Warn patient + consider enhancement preauth before further charges.`;

    const inserted_rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_alerts
         (patient_id, alert_type, severity, message, acknowledged, created_at)
       VALUES ($1::int, 'TPA_CAP_PROXIMITY', $2, $3, false, NOW())
       RETURNING id, severity, message`,
      Number(patientId), severity, message,
    );
    inserted.push(inserted_rows[0]);
    logger.warn('TPA cap proximity alert emitted', {
      admission_id: admissionId,
      patient_uid: patientUid,
      severity,
      utilisation_pct: utilisationPct,
      cap: cap.cumulative_approved,
      total,
    });
  }
  return inserted;
}

/**
 * Resolve the live TPA approval cap for an admission by walking its
 * preauth chain. Returns null if the admission has no preauth (cash
 * invoice or pre-TPA). Lifted out so getInvoice + the cap-proximity
 * alert path (recomputeInvoicePaymentState) can share it.
 *
 * The cap = sum(sanctioned_amount) across the parent preauth + every
 * approved/partially_approved enhancement child. See finding
 * 2026-05-10-tpa-insurance-claim-billing-cumulative-approval-not-projected
 * — the cashier needs the cumulative number, not the parent's
 * original sanction.
 */
export async function resolveAdmissionTpaCap(admissionId, tenantId) {
  if (!admissionId) return null;
  const tenant = requireTenantId(tenantId);
  // Stage-4-C — also expose the root preauth's status, denial_reason,
  // sanctioned_amount, and policy_id so the cashier screen can show
  // "TPA: denied" / "approved ₹50,000" / "pending insurer response"
  // directly on the invoice, without a separate insurance lookup.
  // Finding: 2026-05-10-inpatient-admission-billing-tpa-status-not-on-invoice
  const rows = await prisma.$queryRawUnsafe(
    `WITH active_root AS (
       SELECT id, preauth_number, status, denial_reason, sanctioned_amount, policy_id
         FROM insurance_preauth
        WHERE tenant_id = $2::uuid
          AND admission_id = $1::int
          AND parent_preauth_id IS NULL
          AND status NOT IN ('cancelled','lapsed')
        ORDER BY created_at DESC
        LIMIT 1
     )
     SELECT
        (SELECT id FROM active_root) AS root_preauth_id,
        (SELECT preauth_number FROM active_root) AS root_preauth_number,
        (SELECT status FROM active_root) AS root_preauth_status,
        (SELECT denial_reason FROM active_root) AS root_preauth_denial_reason,
        (SELECT sanctioned_amount FROM active_root) AS root_preauth_sanctioned_amount,
        (SELECT policy_id FROM active_root) AS policy_id,
        COALESCE((
          SELECT SUM(CASE WHEN status IN ('approved','partially_approved')
                          THEN COALESCE(sanctioned_amount, 0) ELSE 0 END)::numeric
            FROM insurance_preauth
           WHERE tenant_id = $2::uuid
             AND (id = (SELECT id FROM active_root)
                  OR parent_preauth_id = (SELECT id FROM active_root))
        ), 0)::numeric AS cumulative_approved`,
    Number(admissionId), tenant,
  );
  const row = rows[0] || {};
  if (!row.root_preauth_id) return null;
  return {
    root_preauth_id: row.root_preauth_id,
    root_preauth_number: row.root_preauth_number,
    root_preauth_status: row.root_preauth_status,
    root_preauth_denial_reason: row.root_preauth_denial_reason,
    root_preauth_sanctioned_amount: row.root_preauth_sanctioned_amount != null ? Number(row.root_preauth_sanctioned_amount) : null,
    policy_id: row.policy_id,
    cumulative_approved: Number(row.cumulative_approved ?? 0),
  };
}

export async function getInvoice(invoiceId, { tenantId } = {}) {
  const invoice = await findBillingInvoice(invoiceId, tenantId, INVOICE_DETAIL_COLUMNS);
  if (!invoice) throw AppError.notFound('Invoice not found');
  const items = await prisma.$queryRawUnsafe(
    `SELECT * FROM billing_invoice_items WHERE invoice_id = $1::int ORDER BY id`,
    Number(invoiceId),
  );
  const payments = await prisma.$queryRawUnsafe(
    `SELECT * FROM billing_payments WHERE invoice_id = $1::int ORDER BY collected_at DESC`,
    Number(invoiceId),
  );
  const settlements = await prisma.$queryRawUnsafe(
    `SELECT s.*, a.mode AS advance_mode
       FROM billing_advance_settlements s
       JOIN billing_advances a ON a.id = s.advance_id
      WHERE s.invoice_id = $1::int`,
    Number(invoiceId),
  );

  // Project the live TPA cap so the cashier sees "₹79,000 of ₹80,000
  // approved (98.8%)" on the invoice screen — not just the row's
  // total_amount in isolation. Returns null when the admission has
  // no preauth (cash invoice).
  const tpaCap = await resolveAdmissionTpaCap(invoice.admission_id, invoice.tenant_id);
  let tpaUtilisation = null;
  let tpaPreauth = null;
  if (tpaCap) {
    // Stage-4-C — surface preauth identity + status on every invoice for
    // an admission that has one, even if cumulative_approved is 0
    // (denied / pending / queried). The cashier needs to see the TPA
    // state on the bill screen to know whether to collect cash, wait,
    // or submit a claim — separate insurance lookup was an extra step
    // that delayed discharge.
    // Finding: 2026-05-10-inpatient-admission-billing-tpa-status-not-on-invoice
    tpaPreauth = {
      preauth_id: tpaCap.root_preauth_id,
      preauth_number: tpaCap.root_preauth_number,
      tpa_status: tpaCap.root_preauth_status,
      denial_reason: tpaCap.root_preauth_denial_reason,
      sanctioned_amount: tpaCap.root_preauth_sanctioned_amount,
      policy_id: tpaCap.policy_id,
    };

    if (tpaCap.cumulative_approved > 0) {
      const total = Number(invoice.total_amount ?? 0);
      const utilisationPct = (total / tpaCap.cumulative_approved) * 100;
      let status = 'within_cap';
      if (utilisationPct >= 100) status = 'over_cap';
      else if (utilisationPct >= 90) status = 'near_limit';
      else if (utilisationPct >= 80) status = 'approaching_limit';
      tpaUtilisation = {
        root_preauth_id: tpaCap.root_preauth_id,
        root_preauth_number: tpaCap.root_preauth_number,
        cumulative_approved: tpaCap.cumulative_approved,
        total_charged: total,
        remaining: Math.max(0, tpaCap.cumulative_approved - total),
        utilisation_pct: Math.round(utilisationPct * 10) / 10,
        status,
      };
    }
  }

  return {
    ...invoice,
    items: items.map(normalizeBillingItemForResponse),
    payments,
    advance_settlements: settlements,
    tpa_utilisation: tpaUtilisation,
    tpa_preauth: tpaPreauth,
  };
}

export async function listInvoices({
  tenantId, patient_uid, patient_id, admission_id, status, invoice_type, date_from, date_to, page = 1, limit = 20,
} = {}) {
  const params = [];
  const where = [];
  pushTenantWhere(where, params, tenantId);
  if (patient_uid) { params.push(String(patient_uid)); where.push(`patient_uid = $${params.length}::uuid`); }
  if (patient_id) {
    params.push(Number(patient_id));
    where.push(`patient_uid = (SELECT uid FROM users WHERE id = $${params.length}::int)`);
  }
  if (admission_id) { params.push(Number(admission_id)); where.push(`admission_id = $${params.length}::int`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (invoice_type) { params.push(invoice_type); where.push(`invoice_type = $${params.length}`); }
  if (date_from) { params.push(date_from); where.push(`COALESCE(issued_at, created_at) >= $${params.length}::timestamptz`); }
  if (date_to) { params.push(date_to); where.push(`COALESCE(issued_at, created_at) <= $${params.length}::timestamptz`); }

  const safeLimit = boundedInteger(limit, { fallback: 20, min: 1, max: 200 });
  const safePage = boundedInteger(page, { fallback: 1, min: 1, max: 501 });
  const offset = Math.min((safePage - 1) * safeLimit, 10_000);
  const sql = `SELECT id, invoice_number, patient_uid, patient_name, invoice_type,
                       total_amount, credit_note_amount, amount_paid, amount_due,
                       status, admission_id,
                      tenant_id, issued_at, created_at
                 FROM billing_invoices
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY COALESCE(issued_at, created_at) DESC
                 LIMIT $${params.length + 1}::int OFFSET $${params.length + 2}::int`;
  const rows = await prisma.$queryRawUnsafe(sql, ...params, safeLimit, offset);

  const enrichRow = async (row) => {
    if (!row.admission_id) return { ...row, tpa_utilisation: null };
    try {
      const cap = await resolveAdmissionTpaCap(row.admission_id, row.tenant_id);
      if (!cap || cap.cumulative_approved <= 0) return { ...row, tpa_utilisation: null };
      const total = Math.max(
        0,
        Number(row.total_amount ?? 0) - Number(row.credit_note_amount ?? 0),
      );
      const utilisationPct = (total / cap.cumulative_approved) * 100;
      let utilisationStatus = 'within_cap';
      if (utilisationPct >= 100) utilisationStatus = 'over_cap';
      else if (utilisationPct >= 90) utilisationStatus = 'near_limit';
      else if (utilisationPct >= 80) utilisationStatus = 'approaching_limit';
      return {
        ...row,
        tpa_utilisation: {
          root_preauth_id: cap.root_preauth_id,
          root_preauth_number: cap.root_preauth_number,
          cumulative_approved: cap.cumulative_approved,
          total_charged: total,
          remaining: Math.max(0, cap.cumulative_approved - total),
          utilisation_pct: Math.round(utilisationPct * 10) / 10,
          status: utilisationStatus,
        },
      };
    } catch (err) {
      logger.warn('Billing invoice list TPA utilisation projection failed', {
        invoice_id: row.id,
        admission_id: row.admission_id,
        err: err?.message,
      });
      return { ...row, tpa_utilisation: null };
    }
  };

  const enriched = [];
  for (let index = 0; index < rows.length; index += 8) {
    const batch = await Promise.all(rows.slice(index, index + 8).map(enrichRow));
    enriched.push(...batch);
  }
  return enriched;
}

// ───────────────────────────────────────────────────────────────────────
// Payments
// ───────────────────────────────────────────────────────────────────────

async function assertInsurancePaymentHasClaimAnchor(invoiceId, tenantId = null, db = prisma) {
  if (!invoiceId) {
    throw AppError.badRequest(
      'INSURANCE payments must be recorded against an invoice linked to a submitted cashless TPA claim.',
      'INSURANCE_PAYMENT_REQUIRES_INVOICE',
    );
  }

  const params = [Number(invoiceId)];
  const tenantSql = appendTenantPredicate(params, tenantId);
  const rows = await db.$queryRawUnsafe(
    `SELECT id, claim_number, preauth_id, status
       FROM tpa_claims
      WHERE invoice_id = $1::int
        ${tenantSql}
        AND claim_type = 'cashless'
        AND COALESCE(stage, 'final') = 'final'
        AND status IN ('submitted', 'approved', 'partially_approved', 'paid', 'settled_partial')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    ...params,
  );

  if (!rows.length) {
    throw AppError.badRequest(
      'INSURANCE payments require a submitted/approved final cashless TPA claim linked to this invoice. Record the insurer settlement through the TPA claim workflow first.',
      'INSURANCE_PAYMENT_REQUIRES_TPA_CLAIM',
      { invoice_id: Number(invoiceId) },
    );
  }

  if (!rows[0].preauth_id) {
    throw AppError.badRequest(
      `INSURANCE payment cannot be collected for claim ${rows[0].claim_number || rows[0].id}: the claim is not linked to a preauth.`,
      'INSURANCE_PAYMENT_REQUIRES_TPA_PREAUTH',
      { invoice_id: Number(invoiceId), claim_id: Number(rows[0].id) },
    );
  }
}

// SQLSTATE 23505 = unique_violation. Surfaced when migration 317's partial
// unique index (tenant_id, reference, mode) rejects a duplicate payment row —
// the durable double-charge backstop for a gateway/webhook replay that re-
// presents the same reference. Translate to a clean 409 instead of a 500.
function isUniqueViolation(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  return code === '23505';
}

/**
 * Atomic core of collectPayment. Runs entirely inside the caller's open
 * transaction (`tx`): when invoice-linked, the invoice row is FOR UPDATE-locked
 * BEFORE the amount-due check so two concurrent payments can't both read a stale
 * due and both succeed (overpayment). The payment INSERT + recompute + advance
 * sync all use `tx`, so they commit or roll back as a unit.
 */
async function collectPaymentTx(tx, {
  invoice_id, patient_uid, amount, mode, reference,
  denominations, collected_by, shift, notes, tenantId, normalizedMode,
}, { mergeStabilityLease = null } = {}) {
  const tenant = requireTenantId(normalizeTenantId(tenantId));
  if (mergeStabilityLease) {
    assertTenantPatientMergeStabilityLease(mergeStabilityLease, { tx, tenantId: tenant });
  } else {
    await lockTenantPatientMergeStability(tx, tenant);
  }
  let resolvedPatientUid = patient_uid;
  if (invoice_id) {
    const invoiceCandidate = await findBillingInvoice(
      invoice_id,
      tenant,
      'id, patient_uid',
      tx,
    );
    if (!invoiceCandidate) throw AppError.notFound('Invoice not found');
    await lockBillingPatientFundingAfterMergeTx(tx, {
      tenantId: tenant,
      patientUid: invoiceCandidate.patient_uid,
    });
    const inv = await lockBillingInvoice(
      tx,
      invoice_id,
      tenant,
      'patient_uid, status, total_amount, amount_paid, amount_due',
    );
    if (!inv) throw AppError.notFound('Invoice not found');
    if (String(inv.patient_uid).toLowerCase()
        !== String(invoiceCandidate.patient_uid).toLowerCase()) {
      throw AppError.conflict(
        'Invoice patient identity changed after funding serialization',
        'BILLING_PAYMENT_INVOICE_AUTHORITY_CHANGED',
      );
    }
    if (inv.status === 'VOID' || inv.status === 'DRAFT') {
      throw AppError.badRequest(`Cannot collect against ${inv.status} invoice`);
    }
    resolvedPatientUid = inv.patient_uid;
    if (toPaise(amount) > toPaise(inv.amount_due)) {
      throw AppError.badRequest(
        `Amount ${amount} exceeds outstanding due ${inv.amount_due}`,
      );
    }
    if (normalizedMode === 'INSURANCE') {
      await assertInsurancePaymentHasClaimAnchor(invoice_id, tenant, tx);
    }
  }
  if (!resolvedPatientUid) throw AppError.badRequest('patient_uid is required when invoice_id is omitted');
  if (!invoice_id) {
    const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
      tenantId: tenant,
      patientUid: resolvedPatientUid,
    });
    await lockPharmacyFundingAuthorityTx(tx, { tenantId: tenant, patientUid });
    resolvedPatientUid = patientUid;
  }

  let rows;
  try {
    rows = await tx.$queryRawUnsafe(
      `INSERT INTO billing_payments
        (invoice_id, patient_uid, amount, mode, reference, denominations,
         collected_by, shift, notes, tenant_id)
       VALUES ($1, $2::uuid, $3::numeric, $4, $5, $6::jsonb, $7::uuid, $8, $9, $10::uuid)
       RETURNING *`,
      invoice_id ? Number(invoice_id) : null,
      String(resolvedPatientUid),
      Number(amount),
      mode,
      reference || null,
      denominations ? JSON.stringify(denominations) : null,
      collected_by ? String(collected_by) : null,
      shift || null,
      notes || null,
      tenant,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(
        'A payment with this reference and mode already exists for this tenant — '
          + 'duplicate suppressed to prevent a double charge.',
        'DUPLICATE_PAYMENT_REFERENCE',
      );
    }
    throw err;
  }

  if (invoice_id) {
    const paymentState = await recomputeInvoicePaymentStateTx(tx, invoice_id);
    await syncUnusedAdmissionAdvancesForInvoice(invoice_id, paymentState, tx);
  }
  return rows[0];
}

export async function collectPayment({
  invoice_id, patient_uid, amount, mode, reference,
  denominations, collected_by, shift, notes, tenantId,
}, { tx = null, mergeStabilityLease = null } = {}) {
  if (tx) {
    assertTenantPatientMergeStabilityLease(mergeStabilityLease, { tx, tenantId });
  }
  // ── Phase 0 — preflight (no row mutation; safe outside the tx) ──────────
  if (!VALID_PAYMENT_MODES.includes(mode)) {
    throw AppError.badRequest(`Invalid mode. Allowed: ${VALID_PAYMENT_MODES.join(', ')}`);
  }
  requireValidAmount(amount);
  const normalizedMode = String(mode).toUpperCase();

  // CASH payments must be tied to a cashier shift so the daily zero-
  // variance drawer-close control can reconcile them. Without `shift`,
  // a discharge cash payment lands in `daily-collection` but
  // `cash-drawer/sessions` close ignores it (it filters by exact non-
  // null shift), creating an off-the-books bypass around the drawer
  // control. Non-cash modes (UPI, card, online, bank_transfer, cheque,
  // insurance, etc.) don't move physical cash and don't need a drawer
  // session, so the guard only fires for CASH.
  // Finding: 2026-05-22-inpatient-admission-billing-8f3634b2.
  if (normalizedMode === 'CASH' && (shift == null || shift === '')) {
    throw AppError.badRequest(
      'CASH payments require a cashier shift so daily drawer reconciliation can include them. Open / select a cash-drawer session first.',
      'CASH_PAYMENT_REQUIRES_SHIFT',
    );
  }

  if (normalizedMode === 'INSURANCE' && !invoice_id) {
    await assertInsurancePaymentHasClaimAnchor(null, tenantId);
  }

  const args = {
    invoice_id, patient_uid, amount, mode, reference,
    denominations, collected_by, shift, notes, tenantId, normalizedMode,
  };
  // Reuse a caller transaction only with the opaque lease returned when that
  // exact transaction acquired tenant merge stability before any domain lock.
  // This preserves the global lock order without a forgeable "already held"
  // flag. The caller remains responsible for its own ledger posting.
  if (tx) return collectPaymentTx(tx, args, { mergeStabilityLease });
  // Phase 4: the per-tenant ledger mode decides HOW we post.
  //  - enforce (sameTx):  post INSIDE the payment tx so a ledger failure rolls
  //    back the payment (authoritative).
  //  - shadow (postCommit): post AFTER commit, best-effort (CLAUDE.md "Phase 1.5")
  //    so a ledger problem can never roll back the real payment (= today's default).
  //  - off (skip): do not post.
  const wiring = await resolveLedgerWiring(requireTenantId(tenantId));
  const payment = await setTenantTx(requireTenantId(tenantId), async (innerTx) => {
    const row = await collectPaymentTx(innerTx, args);
    if (wiring.sameTx) {
      await postPaymentEntry({ payment: row, tenantId: requireTenantId(tenantId), tx: innerTx });
      // Phase 4-3: the post above moved PATIENT_AR; derive the invoice cache
      // columns from the ledger (overwrites the legacy recompute inside collectPaymentTx).
      if (invoice_id) await deriveInvoicePaymentStateFromLedgerTx(innerTx, invoice_id);
    }
    return row;
  });
  if (wiring.postCommit) {
    try {
      await postPaymentEntry({ payment, tenantId: requireTenantId(tenantId) });
    } catch (ledgerErr) {
      logger.error('Ledger PAYMENT post failed (non-blocking)', { payment_id: payment?.id, error: ledgerErr.message });
    }
  }
  return payment;
}

function paymentFundingAdvisoryTuple(row) {
  return [
    Number(row.pharmacy_order_id),
    Number(row.source_authority_version),
    String(row.source_authority_sha256 || ''),
  ];
}

function paymentFundingAdvisoryKey(row) {
  return paymentFundingAdvisoryTuple(row).join(':');
}

async function discoverPaymentFundingEventAdvisoriesTx(tx, { tenantId, paymentId }) {
  const tenant = requireTenantId(tenantId);
  const rows = await tx.$queryRawUnsafe(
    `SELECT DISTINCT allocation.pharmacy_order_id,
                     allocation.source_authority_version,
                     allocation.source_authority_sha256
       FROM pharmacy_payment_allocations allocation
      WHERE allocation.tenant_id = $1::uuid
        AND allocation.billing_payment_id = $2::int
      ORDER BY allocation.pharmacy_order_id,
               allocation.source_authority_version,
               allocation.source_authority_sha256`,
    tenant,
    Number(paymentId),
  );
  for (const row of rows) {
    const [orderId, orderVersion, orderItemsSha256] = paymentFundingAdvisoryTuple(row);
    if (!Number.isInteger(orderId) || orderId <= 0
        || !Number.isInteger(orderVersion) || orderVersion <= 0
        || !SHA256_PATTERN.test(orderItemsSha256)) {
      throw AppError.conflict(
        'Payment allocation funding identity is incomplete',
        'PHARMACY_PAYMENT_ALLOCATION_AUTHORITY_INVALID',
      );
    }
  }
  return rows;
}

async function lockPaymentFundingEventAdvisoriesTx(tx, { tenantId, fundingAuthorities }) {
  const tenant = requireTenantId(tenantId);
  for (const row of fundingAuthorities) {
    const [orderId, orderVersion, orderItemsSha256] = paymentFundingAdvisoryTuple(row);
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'vh:pharmacy_funding_event_chain:' || $1::uuid::text || ':'
           || $2::int::text || ':' || $3::int::text || ':' || $4,
         753
       ))::text AS lock_acquired`,
      tenant,
      orderId,
      orderVersion,
      orderItemsSha256,
    );
  }
}

export async function reversePayment(paymentId, {
  reversed_by,
  reason,
  tenantId,
  commandKeySha256,
}) {
  if (!reason) throw AppError.badRequest('reason is required');
  const tenant = requireTenantId(tenantId);
  const reversalCommand = String(commandKeySha256 || '').trim().toLowerCase();
  const wiring = await resolveLedgerWiring(tenant);
  let reversed;
  try {
    reversed = await setTenantTx(tenant, async (tx) => {
      await lockTenantPatientMergeStability(tx, tenant);
      const paymentPreRead = await tx.$queryRawUnsafe(
        `SELECT payment.patient_uid, payment.invoice_id,
                EXISTS (
                  SELECT 1 FROM pharmacy_payment_allocations allocation
                   WHERE allocation.tenant_id=payment.tenant_id
                     AND allocation.billing_payment_id=payment.id
                ) AS has_pharmacy_allocations
           FROM billing_payments payment
          WHERE payment.tenant_id=$1::uuid AND payment.id=$2::int`,
        tenant, Number(paymentId),
      );
      if (!paymentPreRead.length) throw AppError.notFound('Payment not found');
      const invoiceLinked = paymentPreRead[0].invoice_id != null;
      const fundingSensitive = invoiceLinked || paymentPreRead[0].has_pharmacy_allocations;
      const paymentFundingIdentity = await lockBillingPatientFundingAfterMergeTx(tx, {
        tenantId: tenant,
        patientUid: paymentPreRead[0].patient_uid,
      });
      const fundingAdvisories = fundingSensitive
        ? await discoverPaymentFundingEventAdvisoriesTx(tx, {
          tenantId: tenant,
          paymentId,
        })
        : [];
      const fundedOrderIds = [...new Set(fundingAdvisories
        .map((fundingAuthority) => Number(fundingAuthority.pharmacy_order_id)))]
        .sort((left, right) => left - right);
      for (const fundedOrderId of fundedOrderIds) {
        await assertNoSubstitutionFundingAuthorityTx(tx, {
          tenantId: tenant,
          orderId: fundedOrderId,
          patientUid: paymentFundingIdentity.fundingPatientUid,
        });
      }
      await lockPaymentFundingEventAdvisoriesTx(tx, {
        tenantId: tenant,
        fundingAuthorities: fundingAdvisories,
      });
      const fundedOrderRows = await tx.$queryRawUnsafe(
        `SELECT pharmacy_order.id,pharmacy_order.status,
                EXISTS (
                  SELECT 1 FROM pharmacy_stock_movements movement
                   WHERE movement.tenant_id=pharmacy_order.tenant_id
                     AND movement.metadata->>'order_id'=pharmacy_order.id::text
                ) AS has_stock_movement
           FROM pharmacy_orders pharmacy_order
          WHERE pharmacy_order.tenant_id=$1::uuid
             AND pharmacy_order.id IN (
               SELECT net.pharmacy_order_id
                 FROM (
                   SELECT allocation.id,allocation.pharmacy_order_id,
                          allocation.allocated_amount
                            - COALESCE(SUM(reversal.reversed_amount),0) AS remaining_amount
                     FROM pharmacy_payment_allocations allocation
                     LEFT JOIN pharmacy_payment_allocation_reversals reversal
                       ON reversal.tenant_id=allocation.tenant_id
                      AND reversal.allocation_id=allocation.id
                    WHERE allocation.tenant_id=$1::uuid
                      AND allocation.billing_payment_id=$2::int
                    GROUP BY allocation.id,allocation.pharmacy_order_id,
                             allocation.allocated_amount
                 ) net
                GROUP BY net.pharmacy_order_id
               HAVING SUM(net.remaining_amount) > 0.001
             )
          ORDER BY pharmacy_order.id
          FOR UPDATE OF pharmacy_order`,
        tenant, Number(paymentId),
      );
      const preIssueStatuses = new Set([
        'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED', 'PARTIALLY_DISPENSED',
      ]);
      const unsafeOrder = fundedOrderRows.find((row) => row.has_stock_movement
        || !preIssueStatuses.has(String(row.status).toUpperCase()));
      if (unsafeOrder) {
        throw AppError.conflict(
          'An allocated pharmacy payment cannot be reversed after stock issue or a terminal order transition',
          'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_ORDER_NOT_ACTIONABLE',
          { pharmacy_order_id: Number(unsafeOrder.id), order_status: unsafeOrder.status },
        );
      }
      if (invoiceLinked) {
        const invoice = await lockBillingInvoice(
          tx,
          paymentPreRead[0].invoice_id,
          tenant,
          'id, patient_uid, status',
        );
        if (!invoice) throw AppError.notFound('Invoice not found');
        if (String(invoice.patient_uid).toLowerCase()
            !== String(paymentPreRead[0].patient_uid).toLowerCase()) {
          throw AppError.conflict(
            'Payment and invoice no longer share the exact stored patient identity',
            'BILLING_PAYMENT_REVERSAL_AUTHORITY_CHANGED',
          );
        }
      }
      const paymentRows = await tx.$queryRawUnsafe(
        `SELECT payment.id,payment.invoice_id,payment.patient_uid,payment.amount,
                payment.reversed,payment.mode,
                EXISTS (
                  SELECT 1
                    FROM cash_drawer_sessions drawer
                   WHERE drawer.tenant_id = payment.tenant_id
                     AND drawer.cashier_uid = payment.collected_by
                     AND drawer.shift = payment.shift
                     AND drawer.status IN ('closed', 'reviewed')
                     AND drawer.closed_at IS NOT NULL
                     AND payment.collected_at >= drawer.opened_at
                     AND payment.collected_at <= drawer.closed_at
                ) AS immutable_drawer_close
           FROM billing_payments payment
          WHERE payment.id = $1::int
            AND payment.tenant_id = $2::uuid
          FOR UPDATE OF payment`,
        Number(paymentId),
        tenant,
      );
      if (!paymentRows.length || paymentRows[0].reversed) {
        throw AppError.notFound('Payment not found or already reversed');
      }
      if (String(paymentRows[0].patient_uid).toLowerCase()
          !== String(paymentPreRead[0].patient_uid).toLowerCase()
          || (paymentRows[0].invoice_id == null ? null : Number(paymentRows[0].invoice_id))
            !== (paymentPreRead[0].invoice_id == null
              ? null : Number(paymentPreRead[0].invoice_id))) {
        throw AppError.conflict(
          'Payment funding authority changed concurrently',
          'BILLING_PAYMENT_REVERSAL_AUTHORITY_CHANGED',
        );
      }
      if (String(paymentRows[0].mode || '').trim().toUpperCase() === 'CASH'
          && paymentRows[0].immutable_drawer_close === true) {
        throw AppError.conflict(
          'Cash receipt belongs to an immutable closed drawer; post a governed refund through the current open drawer instead',
          'BILLING_CASH_PAYMENT_CLOSED_DRAWER_REVERSAL_FORBIDDEN',
        );
      }
      const allocationRows = await tx.$queryRawUnsafe(
        `SELECT allocation.id, allocation.tenant_id,
                allocation.pharmacy_order_id, allocation.invoice_id,
                allocation.invoice_item_id, allocation.billing_payment_id,
                allocation.source_authority_version,
                allocation.source_authority_sha256,
                allocation.allocated_amount,
                (allocation.allocated_amount
                  - COALESCE((
                    SELECT SUM(reversal.reversed_amount)
                      FROM pharmacy_payment_allocation_reversals reversal
                     WHERE reversal.tenant_id=allocation.tenant_id
                       AND reversal.allocation_id=allocation.id
                  ),0))::numeric AS remaining_amount
           FROM pharmacy_payment_allocations allocation
          WHERE allocation.tenant_id=$1::uuid
            AND allocation.billing_payment_id=$2::int
          ORDER BY allocation.pharmacy_order_id,allocation.id
          FOR UPDATE OF allocation`,
        tenant, Number(paymentId),
      );
      if (fundingSensitive) {
        const advisoryKeys = new Set(fundingAdvisories.map(paymentFundingAdvisoryKey));
        const lockedKeys = new Set(allocationRows.map(paymentFundingAdvisoryKey));
        if (advisoryKeys.size !== lockedKeys.size
            || [...lockedKeys].some((key) => !advisoryKeys.has(key))) {
          throw AppError.conflict(
            'Payment allocation authority changed after funding serialization',
            'BILLING_PAYMENT_REVERSAL_AUTHORITY_CHANGED',
          );
        }
      }
      const allocations = allocationRows.filter(
        (allocation) => Number(allocation.remaining_amount) > 0.001,
      );
      if (allocations.length && !SHA256_PATTERN.test(reversalCommand)) {
        throw AppError.badRequest(
          'A durable payment reversal command identity is required for allocated pharmacy funding',
          'BILLING_PAYMENT_REVERSAL_COMMAND_REQUIRED',
        );
      }
      for (const allocation of allocations) {
        const allocationCommand = pharmacyFundingHash('PAYMENT_ALLOCATION_REVERSAL', {
          parent_command_sha256: reversalCommand,
          allocation_id: Number(allocation.id),
          payment_id: Number(paymentId),
        });
        await reversePharmacyPaymentAllocationTx(tx, {
          tenantId: tenant,
          allocationId: Number(allocation.id),
          pharmacyOrderId: Number(allocation.pharmacy_order_id),
          invoiceId: Number(allocation.invoice_id),
          invoiceItemId: Number(allocation.invoice_item_id),
          billingPaymentId: Number(paymentId),
          orderVersion: Number(allocation.source_authority_version),
          orderItemsSha256: String(allocation.source_authority_sha256),
          reversedAmount: Number(allocation.remaining_amount),
          actorUid: String(reversed_by),
          reason,
          commandKeySha256: allocationCommand,
          storedPaymentPatientUid: String(paymentRows[0].patient_uid),
          fundingPaymentPatientUid: paymentFundingIdentity.fundingPatientUid,
        });
      }
      if (paymentRows[0].invoice_id != null) {
        const residualHeadroom = await calculateInvoiceRefundHeadroomTx(
          tx,
          paymentRows[0].invoice_id,
        );
        if (toPaise(paymentRows[0].amount) > toPaise(residualHeadroom.refundable)) {
          throw AppError.conflict(
            'Payment reversal would leave active refund or pharmacy funding above residual receipts',
            'BILLING_PAYMENT_REVERSAL_FUNDING_COMMITMENT_CONFLICT',
            {
              payment_amount: Number(paymentRows[0].amount),
              gross_paid: residualHeadroom.gross_paid,
              active_refunds: residualHeadroom.active_refunds,
              active_pharmacy_allocations: residualHeadroom.active_pharmacy_allocations,
              residual_headroom: residualHeadroom.refundable,
            },
          );
        }
      }
      // Flip the reversal flag first (guarded by reversed = false so a double
      // reverse is a no-op), then recompute the parent invoice under a FOR UPDATE
      // lock so a concurrent collectPayment can't interleave with the recompute.
      const params = [
        reversed_by ? String(reversed_by) : null,
        reason,
        Number(paymentId),
      ];
      const tenantSql = appendTenantPredicate(params, tenant);
      const rows = await tx.$queryRawUnsafe(
        `UPDATE billing_payments
            SET reversed = true, reversed_at = NOW(),
                reversed_by = $1::uuid, reversal_reason = $2
          WHERE id = $3::int AND reversed = false${tenantSql}
          RETURNING *`,
        ...params,
      );
      if (!rows.length) throw AppError.notFound('Payment not found or already reversed');
      // Recompute parent invoice if attached.
      if (rows[0].invoice_id) {
        await lockBillingInvoice(tx, rows[0].invoice_id, tenant, 'id');
        const paymentState = await recomputeInvoicePaymentStateTx(tx, rows[0].invoice_id);
        await syncUnusedAdmissionAdvancesForInvoice(rows[0].invoice_id, paymentState, tx);
      }
      const allocationByOrder = new Map();
      for (const allocation of allocations) {
        allocationByOrder.set(Number(allocation.pharmacy_order_id), allocation);
      }
      for (const allocation of allocationByOrder.values()) {
        const authorityRows = await tx.$queryRawUnsafe(
          `SELECT pharmacy_order.id,pharmacy_order.facility_id,pharmacy_order.patient_id,
                  pharmacy_order.total_amount,pharmacy_order.inventory_authority_version,
                  pharmacy_order.items_list,pharmacy_order.payment_mode,
                  pharmacy_order.payment_metadata,patient.uid AS patient_uid,
                  item.id AS invoice_item_id,item.invoice_id,item.source_authority_version,
                  item.source_authority_sha256,invoice.admission_id
             FROM pharmacy_orders pharmacy_order
             JOIN users patient
               ON patient.tenant_id=pharmacy_order.tenant_id
              AND patient.id=pharmacy_order.patient_id
              AND patient.role='PATIENT' AND patient.is_active=TRUE
              AND patient.status='active' AND patient.is_deleted=FALSE
              AND patient.merged_into_uid IS NULL
             JOIN billing_invoice_items item
               ON item.tenant_id=pharmacy_order.tenant_id
              AND item.id=$3::int AND item.source_ref_type='pharmacy_order'
              AND item.source_ref_id=pharmacy_order.id::bigint
              AND item.source_ref_active=TRUE
             JOIN billing_invoices invoice
               ON invoice.tenant_id=item.tenant_id AND invoice.id=item.invoice_id
            WHERE pharmacy_order.tenant_id=$1::uuid AND pharmacy_order.id=$2::int`,
          tenant, Number(allocation.pharmacy_order_id), Number(allocation.invoice_item_id),
        );
        if (!authorityRows.length) {
          throw AppError.conflict(
            'The reversed allocation no longer owns an active pharmacy invoice line',
            'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_TARGET_MISMATCH',
          );
        }
        const order = authorityRows[0];
        const canonicalItemsSha256 = clinicalOrderItemsSha256(order.items_list);
        if (Number(order.inventory_authority_version) !== Number(allocation.source_authority_version)
            || canonicalItemsSha256 !== String(allocation.source_authority_sha256)
            || Number(order.source_authority_version) !== Number(allocation.source_authority_version)
            || String(order.source_authority_sha256) !== String(allocation.source_authority_sha256)) {
          throw AppError.conflict(
            'The reversed allocation is stale relative to the current order and line',
            'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
          );
        }
        const authority = normalizePharmacyFundingAuthority({
          tenantId: tenant,
          facilityId: Number(order.facility_id),
          orderId: Number(order.id),
          patientId: Number(order.patient_id),
          patientUid: String(order.patient_uid),
          authoritativeAmount: Number(order.total_amount),
          orderVersion: Number(order.inventory_authority_version),
          orderItemsSha256: canonicalItemsSha256,
          paymentMode: String(
            order.payment_mode || order.payment_metadata?.payment_mode || '',
          ).trim().toLowerCase(),
          tpaReference: order.payment_metadata?.tpa_reference,
          actorUid: String(reversed_by),
        });
        const decisionRows = PHARMACY_TPA_PAYMENT_MODES.has(authority.paymentMode)
          ? await tx.$queryRawUnsafe(
            `SELECT decision.*,claim.status AS claim_status
               FROM tpa_claim_line_decisions decision
               JOIN tpa_claims claim
                 ON claim.tenant_id=decision.tenant_id AND claim.id=decision.claim_id
              WHERE decision.tenant_id=$1::uuid AND decision.invoice_item_id=$2::int
                AND decision.source_authority_version=$3::int
                AND decision.source_authority_sha256=$4
                AND decision.invalidated_at IS NULL
                AND claim.status IN ('approved','partially_approved','paid')
              FOR UPDATE OF decision,claim`,
            tenant, Number(order.invoice_item_id), authority.orderVersion,
            authority.orderItemsSha256,
          )
          : [];
        if (decisionRows.length > 1) {
          throw AppError.conflict(
            'More than one current TPA decision owns the reversed pharmacy line',
            'PHARMACY_TPA_CLAIM_AMBIGUOUS',
          );
        }
        authority.tpaClaimId = decisionRows[0]?.claim_id == null
          ? null : Number(decisionRows[0].claim_id);
        const remainingAllocations = await loadPharmacyPaymentAllocationsTx(tx, {
          tenantId: tenant,
          invoiceId: Number(order.invoice_id),
          invoiceItemId: Number(order.invoice_item_id),
          orderId: authority.orderId,
          orderVersion: authority.orderVersion,
          orderItemsSha256: authority.orderItemsSha256,
          patientUid: authority.patientUid,
        });
        const approvedTpaAmount = Number(decisionRows[0]?.approved_amount || 0);
        const outstanding = Math.max(0, toFixed2(
          authority.authoritativeAmount - approvedTpaAmount - remainingAllocations.amount,
        ));
        if (outstanding > 0.001) {
          await invalidateCurrentPharmacyFundingAuthorityStateTx(tx, {
            authority,
            reason: 'billing_payment_allocation_reversed',
            actorRole: null,
            billingPaymentId: Number(paymentId),
            commandKeySha256: reversalCommand,
          });
          await upsertPharmacyFundingTaskTx(tx, {
            authority,
            invoiceId: Number(order.invoice_id),
            invoiceItemId: Number(order.invoice_item_id),
            admissionId: order.admission_id == null ? null : Number(order.admission_id),
            taskType: PHARMACY_TPA_PAYMENT_MODES.has(authority.paymentMode)
              && !decisionRows.length ? 'tpa_line_decision' : 'posted_payment',
            stage: PHARMACY_TPA_PAYMENT_MODES.has(authority.paymentMode)
              && !decisionRows.length ? 'line_decision' : 'payment_reversal_recovery',
            assignedRole: PHARMACY_TPA_PAYMENT_MODES.has(authority.paymentMode)
              && !decisionRows.length ? 'INSURANCE_COORDINATOR' : 'FINANCE_INCHARGE',
            tpaClaimId: decisionRows[0]?.claim_id == null
              ? null : Number(decisionRows[0].claim_id),
            amountOutstanding: outstanding,
          });
        } else {
          await resolvePostedPharmacyFundingTx(tx, authority);
        }
      }
      // Phase 4 enforce: post the reversal INSIDE the tx so a ledger failure rolls back.
      if (wiring.sameTx) {
        await postPaymentReversalEntry({ payment: rows[0], tenantId: tenant, tx });
        // Phase 4-3: the reversal restored PATIENT_AR; derive the invoice cache columns.
        if (rows[0].invoice_id) await deriveInvoicePaymentStateFromLedgerTx(tx, rows[0].invoice_id);
      }
      return rows[0];
    });
  } catch (err) {
    const sqlState = err?.meta?.code
      || err?.meta?.driverAdapterError?.cause?.originalCode
      || err?.code;
    const constraint = String(err?.meta?.constraint || err?.constraint || '');
    const message = `${String(err?.message || '')} ${String(err?.meta?.message || '')}`;
    if (String(sqlState || '') === '23514'
        && (constraint === 'billing_cash_payment_reversal_guard_747'
          || message.includes('immutable closed drawer'))) {
      throw AppError.conflict(
        'Cash receipt belongs to an immutable closed drawer; post a governed refund through the current open drawer instead',
        'BILLING_CASH_PAYMENT_CLOSED_DRAWER_REVERSAL_FORBIDDEN',
      );
    }
    throw err;
  }
  // Shadow: post-commit best-effort PAYMENT_REVERSAL (credit CASH|BANK / debit
  // PATIENT_AR — the inverse of the original receipt). Off: skip.
  if (wiring.postCommit) {
    try {
      await postPaymentReversalEntry({ payment: reversed, tenantId: tenant });
    } catch (ledgerErr) {
      logger.error('Ledger PAYMENT_REVERSAL post failed (non-blocking)', { payment_id: reversed?.id, error: ledgerErr.message });
    }
  }
  return reversed;
}

// ───────────────────────────────────────────────────────────────────────
// Advance / Deposit
// ───────────────────────────────────────────────────────────────────────

export async function collectAdvance({ patient_uid, admission_id, amount, mode, reference, collected_by, notes, tenantId }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid required');
  if (!VALID_PAYMENT_MODES.includes(mode)) {
    throw AppError.badRequest(`Invalid mode. Allowed: ${VALID_PAYMENT_MODES.join(', ')}`);
  }
  requireValidAmount(amount);
  const tenant = requireTenantId(normalizeTenantId(tenantId));
  const wiring = await resolveLedgerWiring(tenant);
  const insertAdvance = (tx) => tx.$queryRawUnsafe(
    `INSERT INTO billing_advances
      (patient_uid, admission_id, amount, balance, mode, reference, collected_by, notes, tenant_id)
     VALUES ($1::uuid, $2, $3::numeric, $3::numeric, $4, $5, $6::uuid, $7, $8::uuid)
     RETURNING *`,
    String(patient_uid),
    admission_id ? Number(admission_id) : null,
    Number(amount), mode, reference || null,
    collected_by ? String(collected_by) : null, notes || null, tenant,
  );
  const advance = await setTenantTx(tenant, async (tx) => {
    await lockTenantPatientMergeStability(tx, tenant);
    const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
      tenantId: tenant,
      patientUid: patient_uid,
    });
    await lockPharmacyFundingAuthorityTx(tx, { tenantId: tenant, patientUid });
    const rows = await insertAdvance(tx);
    if (wiring.sameTx) {
      // Enforce: INSERT + ledger post in one tx so a ledger failure rolls back the advance.
      const [row] = rows;
      await postAdvanceCollectEntry({ advance: row, tenantId: tenant, tx });
      // Phase 4-3: derive the advance balance from the ledger (PATIENT_ADVANCE).
      await deriveAdvanceBalanceFromLedgerTx(tx, Number(row.id));
    }
    return rows[0];
  });
  // Shadow: post-commit best-effort ADVANCE_COLLECT (debit CASH|BANK / credit
  // PATIENT_ADVANCE) — the advance is already recorded. Off: skip.
  if (wiring.postCommit) {
    try {
      await postAdvanceCollectEntry({ advance, tenantId: tenant });
    } catch (ledgerErr) {
      logger.error('Ledger ADVANCE_COLLECT post failed (non-blocking)', { advance_id: advance?.id, error: ledgerErr.message });
    }
  }
  return advance;
}

export async function listAdvances({ tenantId, patient_uid, admission_id, status = 'ACTIVE' } = {}) {
  const params = [];
  const where = [];
  pushTenantWhere(where, params, tenantId);
  if (patient_uid) { params.push(String(patient_uid)); where.push(`patient_uid = $${params.length}::uuid`); }
  if (admission_id) { params.push(Number(admission_id)); where.push(`admission_id = $${params.length}::int`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  const sql = `SELECT * FROM billing_advances
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY collected_at DESC LIMIT 100`;
  return prisma.$queryRawUnsafe(sql, ...params);
}

export async function settleAdvance({ tenantId, advance_id, invoice_id, amount, settled_by }) {
  requireValidAmount(amount);
  const tenant = requireTenantId(tenantId);
  const wiring = await resolveLedgerWiring(tenant);
  let settledPatientUid = null;
  const settlement = await setTenantTx(tenant, async (tx) => {
    await lockTenantPatientMergeStability(tx, tenant);
    // These are discovery reads only. The canonical funding advisory below is
    // acquired before either parent row is locked, and both rows are then
    // re-read authoritatively in invoice-before-advance order.
    const advanceCandidates = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, admission_id
         FROM billing_advances
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        LIMIT 1`,
      tenant,
      Number(advance_id),
    );
    if (!advanceCandidates[0]) throw AppError.notFound('Advance not found');
    const invoiceCandidates = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, admission_id
         FROM billing_invoices
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        LIMIT 1`,
      tenant,
      Number(invoice_id),
    );
    if (!invoiceCandidates[0]) throw AppError.notFound('Invoice not found');
    const discoveredInvoiceAdmissionId = invoiceCandidates[0].admission_id == null
      ? null
      : Number(invoiceCandidates[0].admission_id);
    const admissionCandidates = discoveredInvoiceAdmissionId == null
      ? []
      : await tx.$queryRawUnsafe(
        `SELECT id,patient_uid,status
           FROM admissions
          WHERE tenant_id=$1::uuid AND id=$2::int
          LIMIT 2`,
        tenant,
        discoveredInvoiceAdmissionId,
      );
    if (discoveredInvoiceAdmissionId != null && admissionCandidates.length !== 1) {
      throw AppError.conflict(
        'Advance settlement admission authority is missing or ambiguous',
        'BILLING_ADVANCE_SETTLEMENT_AUTHORITY_CHANGED',
      );
    }
    const advanceIdentity = await resolveBillingFundingPatientIdentityTx(tx, {
      tenantId: tenant,
      patientUid: advanceCandidates[0].patient_uid,
    });
    const invoiceIdentity = await resolveBillingFundingPatientIdentityTx(tx, {
      tenantId: tenant,
      patientUid: invoiceCandidates[0].patient_uid,
    });
    if (invoiceIdentity.fundingPatientUid !== advanceIdentity.fundingPatientUid) {
      throw AppError.forbidden(
        'Advance and invoice must belong to the same patient',
        'BILLING_ADVANCE_INVOICE_PATIENT_MISMATCH',
      );
    }
    await lockPharmacyFundingAuthorityTx(tx, {
      tenantId: tenant,
      patientUid: invoiceIdentity.fundingPatientUid,
    });
    const inv = await lockBillingInvoice(
      tx,
      invoice_id,
      tenant,
      'id, amount_due, patient_uid, admission_id, status',
    );
    if (!inv) throw AppError.notFound('Invoice not found');
    if (String(inv.patient_uid).toLowerCase() !== invoiceIdentity.storedPatientUid) {
      throw AppError.forbidden(
        'Advance and invoice must belong to the same patient',
        'BILLING_ADVANCE_INVOICE_PATIENT_MISMATCH',
      );
    }
    const lockedInvoiceAdmissionId = inv.admission_id == null
      ? null
      : Number(inv.admission_id);
    if (lockedInvoiceAdmissionId !== discoveredInvoiceAdmissionId) {
      throw AppError.conflict(
        'Advance settlement invoice authority changed before lock',
        'BILLING_ADVANCE_SETTLEMENT_AUTHORITY_CHANGED',
      );
    }
    if (['DRAFT', 'VOID'].includes(String(inv.status).toUpperCase())) {
      throw AppError.conflict(
        `Cannot settle an advance against a ${inv.status} invoice`,
        'BILLING_ADVANCE_INVOICE_NOT_SETTLEABLE',
      );
    }
    if (lockedInvoiceAdmissionId != null) {
      const lockedAdmission = await lockPharmacyFundingAdmissionTx(tx, {
        tenantId: tenant,
        admissionId: lockedInvoiceAdmissionId,
        patientUid: invoiceIdentity.fundingPatientUid,
      });
      const discoveredAdmission = admissionCandidates[0];
      if (Number(lockedAdmission.id) !== Number(discoveredAdmission.id)
          || String(lockedAdmission.patient_uid).toLowerCase()
            !== String(discoveredAdmission.patient_uid).toLowerCase()
          || String(lockedAdmission.status) !== String(discoveredAdmission.status)) {
        throw AppError.conflict(
          'Advance settlement admission authority changed before lock',
          'BILLING_ADVANCE_SETTLEMENT_AUTHORITY_CHANGED',
        );
      }
    }

    const adv = await lockBillingAdvance(tx, advance_id, tenant);
    if (!adv) throw AppError.notFound('Advance not found');
    if (String(adv.patient_uid).toLowerCase() !== advanceIdentity.storedPatientUid) {
      throw AppError.forbidden(
        'Advance and invoice must belong to the same patient',
        'BILLING_ADVANCE_INVOICE_PATIENT_MISMATCH',
      );
    }
    const discoveredAdvanceAdmissionId = advanceCandidates[0].admission_id == null
      ? null
      : Number(advanceCandidates[0].admission_id);
    const lockedAdvanceAdmissionId = adv.admission_id == null
      ? null
      : Number(adv.admission_id);
    if (lockedAdvanceAdmissionId !== discoveredAdvanceAdmissionId) {
      throw AppError.conflict(
        'Advance settlement source authority changed before lock',
        'BILLING_ADVANCE_SETTLEMENT_AUTHORITY_CHANGED',
      );
    }
    if (adv.status !== 'ACTIVE') throw AppError.badRequest(`Advance is ${adv.status}`);
    const fundingHeadroom = await calculateAdvanceFundingHeadroomTx(tx, advance_id);
    if (toPaise(amount) > toPaise(fundingHeadroom.available)) {
      throw AppError.badRequest(
        `Amount exceeds uncommitted advance funding ${fundingHeadroom.available}`,
        'BILLING_ADVANCE_INSUFFICIENT_BALANCE',
        {
          advance_balance: fundingHeadroom.currentBalance,
          settlements: fundingHeadroom.settlements,
          active_refunds: fundingHeadroom.activeRefunds,
          active_pharmacy_allocations: fundingHeadroom.pharmacyAllocations,
          available: fundingHeadroom.available,
        },
      );
    }
    settledPatientUid = inv.patient_uid; // captured for the post-commit ledger entry
    if (toPaise(amount) > toPaise(inv.amount_due)) {
      throw AppError.badRequest(`Amount exceeds invoice due ${inv.amount_due}`);
    }

    const settlementRow = await tx.$queryRawUnsafe(
      `INSERT INTO billing_advance_settlements (advance_id, invoice_id, amount, settled_by)
       VALUES ($1::int, $2::int, $3::numeric, $4::uuid)
       RETURNING *`,
      Number(advance_id), Number(invoice_id), Number(amount),
      settled_by ? String(settled_by) : null,
    );

    // Atomic balance decrement — `balance = balance - $amt WHERE balance >= $amt`
    // is the conditional update that makes the debit safe even if the FOR UPDATE
    // lock were somehow skipped: a settlement that would overdraw affects zero
    // rows and we reject. Belt-and-braces with the lock above.
    const dec = await tx.$queryRawUnsafe(
      `UPDATE billing_advances
          SET balance = balance - $1::numeric,
              status = CASE WHEN balance - $1::numeric <= 0.005 THEN 'EXHAUSTED' ELSE 'ACTIVE' END,
              updated_at = NOW()
        WHERE id = $2::int
          AND balance >= $1::numeric - 0.005
        RETURNING id`,
      Number(amount), Number(advance_id),
    );
    if (!dec.length) {
      throw AppError.badRequest(
        `Amount exceeds advance balance ${adv.balance}`,
        'BILLING_ADVANCE_INSUFFICIENT_BALANCE',
      );
    }

    // Recompute invoice totals (treats advance settlement as paid amount).
    await tx.$executeRawUnsafe(
      `UPDATE billing_invoices
          SET amount_paid = amount_paid + $1::numeric,
              amount_due = amount_due - $1::numeric,
              status = CASE WHEN amount_due - $1::numeric <= 0.005 THEN 'PAID' ELSE 'PARTIAL' END,
              updated_at = NOW()
        WHERE id = $2::int`,
      Number(amount), Number(invoice_id),
    );
    // Phase 4 enforce: post ADVANCE_SETTLE INSIDE the tx so a ledger failure rolls back.
    if (wiring.sameTx) {
      await postAdvanceSettleEntry({ settlement: settlementRow[0], patientUid: settledPatientUid, tenantId: tenant, tx });
      // Phase 4-3: the post moved PATIENT_ADVANCE and PATIENT_AR; derive both
      // cache columns from the ledger.
      await deriveAdvanceBalanceFromLedgerTx(tx, Number(advance_id));
      await deriveInvoicePaymentStateFromLedgerTx(tx, Number(invoice_id));
    }
    return settlementRow[0];
  });
  // Shadow: post-commit best-effort ADVANCE_SETTLE (debit PATIENT_ADVANCE /
  // credit PATIENT_AR). Off: skip.
  if (wiring.postCommit) {
    try {
      await postAdvanceSettleEntry({ settlement, patientUid: settledPatientUid, tenantId: tenant });
    } catch (ledgerErr) {
      logger.error('Ledger ADVANCE_SETTLE post failed (non-blocking)', { settlement_id: settlement?.id, error: ledgerErr.message });
    }
  }
  return settlement;
}

// ───────────────────────────────────────────────────────────────────────
// Refunds
// ───────────────────────────────────────────────────────────────────────

async function calculateNetBillingFundingCapacityTx(tx, {
  invoiceId = null,
  advanceId = null,
  excludeRefundId = null,
}) {
  const isInvoice = invoiceId != null;
  if (isInvoice === (advanceId != null)) {
    throw new TypeError('Exactly one billing funding source is required');
  }
  const sourceId = Number(isInvoice ? invoiceId : advanceId);
  const excludedRefund = excludeRefundId == null ? null : Number(excludeRefundId);
  const rows = isInvoice
    ? await tx.$queryRawUnsafe(
      `SELECT (
                SELECT COALESCE(SUM(payment.amount),0)::numeric
                  FROM billing_payments payment
                 WHERE payment.invoice_id=$1::int AND payment.reversed=FALSE
              ) + (
                SELECT COALESCE(SUM(settlement.amount),0)::numeric
                  FROM billing_advance_settlements settlement
                 WHERE settlement.invoice_id=$1::int
              ) AS source_amount,
              (
                SELECT COALESCE(SUM(refund.amount),0)::numeric
                  FROM billing_refunds refund
                 WHERE refund.invoice_id=$1::int
                   AND refund.approval_status<>'REJECTED'
                   AND ($2::int IS NULL OR refund.id<>$2::int)
              ) AS active_refunds,
              (
                SELECT COALESCE(SUM(
                  GREATEST(allocation.allocated_amount
                    - COALESCE(reversal.reversed_amount,0),0)
                ),0)::numeric
                  FROM pharmacy_payment_allocations allocation
                  LEFT JOIN (
                    SELECT allocation_id,SUM(reversed_amount)::numeric AS reversed_amount
                      FROM pharmacy_payment_allocation_reversals
                     GROUP BY allocation_id
                  ) reversal ON reversal.allocation_id=allocation.id
                 WHERE allocation.invoice_id=$1::int
              ) + (
                SELECT COALESCE(SUM(
                  GREATEST(allocation.allocated_amount
                    - COALESCE(reversal.reversed_amount,0),0)
                ),0)::numeric
                  FROM pharmacy_advance_allocations allocation
                  LEFT JOIN (
                    SELECT allocation_id,SUM(reversed_amount)::numeric AS reversed_amount
                      FROM pharmacy_advance_allocation_reversals
                     GROUP BY allocation_id
                  ) reversal ON reversal.allocation_id=allocation.id
                 WHERE allocation.invoice_id=$1::int
              ) AS pharmacy_allocations`,
      sourceId,
      excludedRefund,
    )
    : await tx.$queryRawUnsafe(
      `SELECT advance.amount::numeric AS source_amount,
              advance.balance::numeric AS current_balance,
              (
                SELECT COALESCE(SUM(settlement.amount),0)::numeric
                  FROM billing_advance_settlements settlement
                 WHERE settlement.advance_id=$1::int
              ) AS settlements,
              (
                SELECT COALESCE(SUM(refund.amount),0)::numeric
                  FROM billing_refunds refund
                 WHERE refund.advance_id=$1::int
                   AND refund.approval_status<>'REJECTED'
                   AND ($2::int IS NULL OR refund.id<>$2::int)
              ) AS active_refunds,
              (
                SELECT COALESCE(SUM(
                  GREATEST(allocation.allocated_amount
                    - COALESCE(reversal.reversed_amount,0),0)
                ),0)::numeric
                  FROM pharmacy_advance_allocations allocation
                  LEFT JOIN (
                    SELECT allocation_id,SUM(reversed_amount)::numeric AS reversed_amount
                      FROM pharmacy_advance_allocation_reversals
                     GROUP BY allocation_id
                  ) reversal ON reversal.allocation_id=allocation.id
                 WHERE allocation.billing_advance_id=$1::int
              ) AS pharmacy_allocations
         FROM billing_advances advance
        WHERE advance.id=$1::int`,
      sourceId,
      excludedRefund,
    );
  const sourceAmount = toFixed2(Number(rows[0]?.source_amount || 0));
  const currentBalance = isInvoice
    ? sourceAmount
    : toFixed2(Number(rows[0]?.current_balance || 0));
  const settlements = toFixed2(Number(rows[0]?.settlements || 0));
  const activeRefunds = toFixed2(Number(rows[0]?.active_refunds || 0));
  const pharmacyAllocations = toFixed2(Number(rows[0]?.pharmacy_allocations || 0));
  const nonPharmacyAvailable = isInvoice
    ? toFixed2(Math.max(0, sourceAmount - activeRefunds))
    : toFixed2(Math.max(
      0,
      Math.min(currentBalance, sourceAmount - settlements - activeRefunds),
    ));
  return {
    sourceAmount,
    currentBalance,
    settlements,
    activeRefunds,
    pharmacyAllocations,
    available: toFixed2(Math.max(0, nonPharmacyAvailable - pharmacyAllocations)),
  };
}

export async function calculateInvoiceRefundHeadroomTx(
  tx,
  invoiceId,
  { excludeRefundId = null } = {},
) {
  const capacity = await calculateNetBillingFundingCapacityTx(tx, {
    invoiceId,
    excludeRefundId,
  });
  return {
    gross_paid: capacity.sourceAmount,
    active_refunds: capacity.activeRefunds,
    active_pharmacy_allocations: capacity.pharmacyAllocations,
    refundable: capacity.available,
  };
}

async function calculateAdvanceFundingHeadroomTx(
  tx,
  advanceId,
  { excludeRefundId = null } = {},
) {
  return calculateNetBillingFundingCapacityTx(tx, {
    advanceId,
    excludeRefundId,
  });
}

async function loadAppliedCreditNoteForRefundTx(tx, refundId, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT note.*, financial.ward_indent_id, financial.ward_indent_item_id,
            financial.ward_indent_state_version,
            indent.indent_number, indent.status AS ward_indent_status,
            indent.state_version AS current_ward_indent_state_version,
            indent.encounter_id
       FROM billing_credit_notes note
       JOIN ward_indent_financial_events financial
         ON financial.tenant_id = note.tenant_id
        AND financial.id = note.source_financial_event_id
       JOIN ward_indents indent
         ON indent.tenant_id = financial.tenant_id
        AND indent.id = financial.ward_indent_id
      WHERE note.tenant_id = $1::uuid
        AND note.refund_id = $2::int
        AND note.status = 'applied'
      LIMIT 1`,
    requireTenantId(tenantId),
    normalizeRefundId(refundId),
  );
  return rows[0] || null;
}

export async function raiseRefund({
  patient_uid, invoice_id, advance_id, amount, reason, mode, raised_by, tenantId,
  commandKey, requestFingerprint, httpIdempotencyClaimId, requestId, auditContext,
  expectedIdempotencyBody = null,
  idempotencyPath = REFUND_RAISE_IDEMPOTENCY_PATH,
  validateParentSourceTx = null,
}) {
  if (!reason) throw AppError.badRequest('reason is required');
  if (!VALID_REFUND_MODES.includes(mode)) {
    throw AppError.badRequest(`Invalid refund mode. Allowed: ${VALID_REFUND_MODES.join(', ')}`);
  }
  requireValidAmount(amount);
  if ((!invoice_id && !advance_id) || (invoice_id && advance_id)) {
    throw AppError.badRequest('Refund must reference exactly one of invoice_id or advance_id');
  }
  if (validateParentSourceTx != null && typeof validateParentSourceTx !== 'function') {
    throw new TypeError('validateParentSourceTx must be a function');
  }
  if (validateParentSourceTx && !advance_id) {
    throw new TypeError('validateParentSourceTx requires an advance refund parent');
  }
  const tenant = requireTenantId(normalizeTenantId(tenantId));
  const refundAmount = toFixed2(amount);
  const command = normalizeRefundMutationCommand({
    actorUid: raised_by,
    commandKey,
    requestFingerprint,
    httpIdempotencyClaimId,
    requestId,
    expectedBody: expectedIdempotencyBody ?? refundRaiseIdempotencyBody({
      patient_uid,
      invoice_id,
      advance_id,
      amount,
      reason,
      mode,
    }),
    path: String(idempotencyPath || REFUND_RAISE_IDEMPOTENCY_PATH),
    invalidCode: 'BILLING_REFUND_RAISE_IDEMPOTENCY_INVALID',
    mismatchCode: 'BILLING_REFUND_RAISE_COMMAND_MISMATCH',
    label: 'Refund creation',
  });
  const normalizedAuditContext = normalizeRefundMutationAuditContext(auditContext, {
    actorUid: raised_by,
    command,
    invalidCode: 'BILLING_REFUND_RAISE_AUDIT_CONTEXT_INVALID',
    missingCode: 'BILLING_REFUND_RAISE_AUDIT_CONTEXT_MISSING',
    label: 'Refund creation',
  });
  return setTenantTx(requireTenantId(tenantId), async (tx) => {
    await lockTenantPatientMergeStability(tx, tenant);
    let resolvedPatientUid = patient_uid;
    if (invoice_id) {
      const invoiceCandidate = await findBillingInvoice(
        invoice_id,
        tenant,
        'id, patient_uid',
        tx,
      );
      if (!invoiceCandidate) throw AppError.notFound('Invoice not found');
      const invoiceIdentity = await lockBillingPatientFundingAfterMergeTx(tx, {
        tenantId: tenant,
        patientUid: invoiceCandidate.patient_uid,
      });
      await assertBillingFundingPatientMatchTx(tx, {
        tenantId: tenant,
        requestedPatientUid: resolvedPatientUid,
        parentIdentity: invoiceIdentity,
        message: 'Refund patient_uid must resolve to the invoice funding patient',
        code: 'BILLING_REFUND_PATIENT_MISMATCH',
      });
      resolvedPatientUid = String(invoiceCandidate.patient_uid);
      // Parent-before-refund is the global money-mutation order. The funding
      // advisory above also serializes this reservation against pharmacy use.
      const invoice = await lockBillingInvoice(
        tx,
        invoice_id,
        tenant,
        'id, patient_uid, amount_paid',
      );
      if (!invoice) throw AppError.notFound('Invoice not found');
      if (String(invoice.patient_uid).toLowerCase() !== resolvedPatientUid.toLowerCase()) {
        throw AppError.conflict(
          'Invoice funding authority changed concurrently',
          'BILLING_REFUND_PARENT_AUTHORITY_MISMATCH',
        );
      }
      // Gross receipts are immutable payment evidence. Using them avoids
      // subtracting prior refunds twice after the invoice cache is reduced.
      const headroom = await calculateInvoiceRefundHeadroomTx(tx, invoice_id);
      const refundable = headroom.refundable;
      if (refundAmount > refundable + 0.005) {
        throw AppError.badRequest(
          `Refund amount ${refundAmount} exceeds refundable balance ${Math.max(0, refundable)} `
            + `(gross receipts ${headroom.gross_paid} less active refunds `
            + `${headroom.active_refunds} and pharmacy allocations `
            + `${headroom.active_pharmacy_allocations}).`,
          'BILLING_REFUND_EXCEEDS_PAID',
          {
            amount_paid: Number(invoice.amount_paid || 0),
            gross_paid: headroom.gross_paid,
            prior_refunds: headroom.active_refunds,
            active_pharmacy_allocations: headroom.active_pharmacy_allocations,
            refundable: Math.max(0, refundable),
          },
        );
      }
    }
    if (advance_id) {
      const advanceCandidates = await tx.$queryRawUnsafe(
        `SELECT id, patient_uid
           FROM billing_advances
          WHERE tenant_id = $1::uuid
            AND id = $2::int
          LIMIT 1`,
        tenant,
        Number(advance_id),
      );
      if (!advanceCandidates[0]) throw AppError.notFound('Advance not found');
      const advanceIdentity = await lockBillingPatientFundingAfterMergeTx(tx, {
        tenantId: tenant,
        patientUid: advanceCandidates[0].patient_uid,
      });
      await assertBillingFundingPatientMatchTx(tx, {
        tenantId: tenant,
        requestedPatientUid: resolvedPatientUid,
        parentIdentity: advanceIdentity,
        message: 'Refund patient_uid must resolve to the advance funding patient',
        code: 'BILLING_REFUND_PATIENT_MISMATCH',
      });
      resolvedPatientUid = String(advanceCandidates[0].patient_uid);
      const advance = await lockBillingAdvance(tx, advance_id, tenant);
      if (!advance) throw AppError.notFound('Advance not found');
      if (String(advance.patient_uid).toLowerCase() !== resolvedPatientUid.toLowerCase()) {
        throw AppError.conflict(
          'Advance funding authority changed concurrently',
          'BILLING_REFUND_PARENT_AUTHORITY_MISMATCH',
        );
      }
      if (validateParentSourceTx) {
        await validateParentSourceTx({
          tx,
          tenantId: tenant,
          advance,
          storedPatientUid: resolvedPatientUid,
          fundingPatientUid: advanceIdentity.fundingPatientUid,
        });
      }
      const headroom = await calculateAdvanceFundingHeadroomTx(tx, advance_id);
      const refundable = headroom.available;
      if (refundAmount > refundable + 0.005) {
        throw AppError.badRequest(
          `Refund amount ${refundAmount} exceeds refundable advance balance ${refundable}.`,
          'BILLING_REFUND_EXCEEDS_ADVANCE_BALANCE',
          {
            advance_balance: headroom.currentBalance,
            settlements: headroom.settlements,
            reserved_refunds: headroom.activeRefunds,
            active_pharmacy_allocations: headroom.pharmacyAllocations,
            refundable,
          },
        );
      }
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO billing_refunds
        (patient_uid, invoice_id, advance_id, amount, reason, mode, raised_by, tenant_id)
       VALUES ($1::uuid, $2, $3, $4::numeric, $5, $6, $7::uuid, $8::uuid)
       RETURNING *`,
      String(resolvedPatientUid),
      invoice_id ? Number(invoice_id) : null,
      advance_id ? Number(advance_id) : null,
      refundAmount, reason, mode,
      raised_by ? String(raised_by) : null,
      tenant,
    );
    await insertRefundMutationAuditTx(tx, {
      tenantId: tenant,
      refund: rows[0],
      auditContext: normalizedAuditContext,
      action: 'FRONT_OFFICE_BILLING_REFUND_RAISED',
      missingCode: 'BILLING_REFUND_RAISE_AUDIT_MISSING',
    });
    await finaliseRefundMutationIdempotencyTx(tx, {
      tenantId: tenant,
      command,
      refund: rows[0],
      changedCode: 'BILLING_REFUND_RAISE_IDEMPOTENCY_CHANGED',
      label: 'Refund creation',
    });
    return rows[0];
  });
}

export async function approveRefund(refundId, {
  approved_by,
  tenantId,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId,
  auditContext,
} = {}) {
  const id = normalizeRefundId(refundId);
  const tenant = requireTenantId(tenantId);
  const command = normalizeRefundApprovalCommand(id, {
    approved_by,
    commandKey,
    requestFingerprint,
    httpIdempotencyClaimId,
    requestId,
  });
  const normalizedAuditContext = normalizeRefundApprovalAuditContext(auditContext, {
    approvedBy: approved_by,
    command,
  });
  const wiring = await resolveLedgerWiring(tenant);
  let linkedCreditNote = null;
  const refund = await setTenantTx(tenant, async (tx) => {
    const locked = await lockBillingRefundFundingAuthorityTx(tx, {
      tenantId: tenant,
      refundId: id,
    });
    if (locked.refund.approval_status !== 'PENDING') {
      throw AppError.notFound('Refund not found or not pending');
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE billing_refunds
          SET approval_status = 'APPROVED', approved_by = $1::uuid,
              approved_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $2::uuid
          AND id = $3::int
          AND patient_uid = $4::uuid
          AND approval_status = 'PENDING'
        RETURNING ${REFUND_PUBLIC_COLUMNS}`,
      approved_by ? String(approved_by) : null,
      tenant,
      id,
      locked.storedPatientUid,
    );
    if (!rows.length) throw AppError.notFound('Refund not found or not pending');
    linkedCreditNote = await loadAppliedCreditNoteForRefundTx(tx, rows[0].id, tenant);
    if (linkedCreditNote) {
      await advanceBillingCreditNoteRefundPayoutObligationTx(tx, {
        creditNote: linkedCreditNote,
        refund: rows[0],
        actorUid: approved_by,
      });
    } else if (wiring.sameTx) {
      // Enforce: UPDATE + ledger post share one transaction so a posting
      // failure cannot leave an approved refund without its accounting entry.
      await postRefundApproveEntry({ refund: rows[0], tenantId: tenant, tx });
      // Phase 4-3: refund-approve restored PATIENT_AR (invoice) / reduced
      // PATIENT_ADVANCE (advance) — ledger timing puts the refund's column
      // effect HERE (at approve), not at payout.
      if (rows[0].advance_id) {
        await deriveAdvanceBalanceFromLedgerTx(tx, rows[0].advance_id, {
          exhaustedStatus: 'REFUNDED',
        });
      } else if (rows[0].invoice_id) {
        await deriveInvoicePaymentStateFromLedgerTx(tx, rows[0].invoice_id);
      }
    }
    await insertRefundApprovalAuditTx(tx, {
      tenantId: tenant,
      refund: rows[0],
      auditContext: normalizedAuditContext,
    });
    await finaliseRefundApprovalIdempotencyTx(tx, {
      tenantId: tenant,
      command,
      refund: rows[0],
    });
    return rows[0];
  });
  // Shadow: post-commit best-effort REFUND_APPROVE (credit REFUNDS_PAYABLE /
  // debit PATIENT_AR|PATIENT_ADVANCE). Off: skip.
  if (wiring.postCommit && !linkedCreditNote) {
    try {
      await postRefundApproveEntry({ refund, tenantId: tenant });
    } catch (ledgerErr) {
      logger.error('Ledger REFUND_APPROVE post failed (non-blocking)', { refund_id: refund?.id, error: ledgerErr.message });
    }
  }
  return refund;
}

export async function rejectRefund(refundId, {
  rejected_by,
  rejection_reason,
  tenantId,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId,
  auditContext,
} = {}) {
  const id = normalizeRefundId(refundId);
  const reason = String(rejection_reason || '').trim();
  if (!reason) throw AppError.badRequest('rejection_reason is required');
  if (reason.length > 255) {
    throw AppError.badRequest(
      'rejection_reason must be at most 255 characters',
      'BILLING_REFUND_REJECTION_REASON_INVALID',
    );
  }
  const tenant = requireTenantId(tenantId);
  const command = normalizeRefundMutationCommand({
    actorUid: rejected_by,
    commandKey,
    requestFingerprint,
    httpIdempotencyClaimId,
    requestId,
    expectedBody: refundRejectionIdempotencyBody(id, {
      rejection_reason: reason,
    }),
    path: REFUND_REJECTION_IDEMPOTENCY_PATH,
    invalidCode: 'BILLING_REFUND_REJECTION_IDEMPOTENCY_INVALID',
    mismatchCode: 'BILLING_REFUND_REJECTION_COMMAND_MISMATCH',
    label: 'Refund rejection',
  });
  const normalizedAuditContext = normalizeRefundMutationAuditContext(auditContext, {
    actorUid: rejected_by,
    command,
    invalidCode: 'BILLING_REFUND_REJECTION_AUDIT_CONTEXT_INVALID',
    missingCode: 'BILLING_REFUND_REJECTION_AUDIT_CONTEXT_MISSING',
    label: 'Refund rejection',
  });
  return setTenantTx(tenant, async (tx) => {
    const locked = await lockBillingRefundFundingAuthorityTx(tx, {
      tenantId: tenant,
      refundId: id,
    });
    if (locked.refund.approval_status !== 'PENDING') {
      throw AppError.notFound('Refund not found or not pending');
    }
    if (await loadAppliedCreditNoteForRefundTx(tx, id, tenant)) {
      throw AppError.conflict(
        'An applied medication credit refund is an owed patient balance and cannot be rejected',
        'BILLING_CREDIT_NOTE_REFUND_REJECTION_FORBIDDEN',
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE billing_refunds
          SET approval_status = 'REJECTED', rejected_by = $1::uuid,
              rejected_at = NOW(), rejection_reason = $2, updated_at = NOW()
        WHERE tenant_id = $3::uuid
          AND id = $4::int
          AND patient_uid = $5::uuid
          AND approval_status = 'PENDING'
        RETURNING ${REFUND_PUBLIC_COLUMNS}`,
      rejected_by ? String(rejected_by) : null,
      reason,
      tenant,
      id,
      locked.storedPatientUid,
    );
    if (!rows.length) throw AppError.notFound('Refund not found or not pending');
    await insertRefundMutationAuditTx(tx, {
      tenantId: tenant,
      refund: rows[0],
      auditContext: normalizedAuditContext,
      action: 'FRONT_OFFICE_BILLING_REFUND_REJECTED',
      missingCode: 'BILLING_REFUND_REJECTION_AUDIT_MISSING',
    });
    await finaliseRefundMutationIdempotencyTx(tx, {
      tenantId: tenant,
      command,
      refund: rows[0],
      changedCode: 'BILLING_REFUND_REJECTION_IDEMPOTENCY_CHANGED',
      label: 'Refund rejection',
    });
    return rows[0];
  });
}

function normalizeRefundPayoutReference(value, {
  label = 'reference',
  requiredCode = 'BILLING_REFUND_PAYOUT_REFERENCE_REQUIRED',
  maxLength = 255,
} = {}) {
  const text = String(value || '').trim();
  const hasControl = Array.from(text).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 32 || codePoint === 127;
  });
  if (!text || text.length > maxLength || hasControl) {
    throw AppError.badRequest(
      `${label} must be a nonempty value of at most ${maxLength} characters`,
      requiredCode,
    );
  }
  return text;
}

function normalizePositiveBigIntId(value, label, code) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    throw AppError.badRequest(`${label} must be a positive integer`, code);
  }
  const parsed = BigInt(text);
  if (parsed < 1n || parsed > 9_223_372_036_854_775_807n) {
    throw AppError.badRequest(`${label} must be a positive integer`, code);
  }
  return parsed.toString();
}

function normalizeProviderRefundedAt(value) {
  const raw = String(value || '').trim();
  const timestamp = Date.parse(raw);
  if (!raw || raw.length > 80 || !Number.isFinite(timestamp)) {
    throw AppError.badRequest(
      'provider_refunded_at must be a valid ISO-8601 timestamp',
      'BILLING_REFUND_PROVIDER_REFUNDED_AT_INVALID',
    );
  }
  if (timestamp > Date.now() + 5 * 60 * 1000) {
    throw AppError.unprocessable(
      'provider_refunded_at cannot be in the future',
      'BILLING_REFUND_PROVIDER_REFUNDED_AT_FUTURE',
    );
  }
  return new Date(timestamp).toISOString();
}

function translateRefundPayoutConstraintError(err) {
  const sqlState = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  if (String(sqlState || '') !== '23505') return err;
  const constraint = `${String(err?.constraint || '')} ${String(err?.meta?.constraint || '')} ${String(err?.message || '')} ${String(err?.meta?.message || '')}`.toLowerCase();
  if (constraint.includes('provider_refund')) {
    return AppError.conflict(
      'provider_refund_reference has already been used',
      'BILLING_REFUND_PROVIDER_REFUND_REFERENCE_DUPLICATE',
    );
  }
  if (constraint.includes('manual') || constraint.includes('payout_reference')) {
    return AppError.conflict(
      'Refund payout reference has already been used',
      'BILLING_REFUND_PAYOUT_REFERENCE_DUPLICATE',
    );
  }
  return err;
}

async function discoverOfflineElectronicRefundSourceBeforeFundingTx(tx, {
  tenant,
  refund,
  evidence,
}) {
  const mode = String(refund.mode || '').trim().toUpperCase();
  if (!OFFLINE_ELECTRONIC_REFUND_MODES.includes(mode)) {
    throw AppError.conflict(
      'Offline-electronic evidence is only valid for electronic refund modes',
      'BILLING_REFUND_OFFLINE_ELECTRONIC_MODE_MISMATCH',
    );
  }
  const originalReference = normalizeRefundPayoutReference(
    evidence?.original_payment_reference,
    {
      label: 'original_payment_reference',
      requiredCode: 'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_REQUIRED',
    },
  );
  const providerName = normalizeRefundPayoutReference(evidence?.provider_name, {
    label: 'provider_name',
    requiredCode: 'BILLING_REFUND_PROVIDER_REQUIRED',
    maxLength: 120,
  });
  const providerRefundReference = normalizeRefundPayoutReference(
    evidence?.provider_refund_reference,
    {
      label: 'provider_refund_reference',
      requiredCode: 'BILLING_REFUND_PROVIDER_REFUND_REFERENCE_REQUIRED',
    },
  );
  const providerRefundedAt = normalizeProviderRefundedAt(evidence?.provider_refunded_at);
  let paymentCandidate = null;
  if (refund.invoice_id != null) {
    const paymentRows = await tx.$queryRawUnsafe(
      `SELECT id,invoice_id,patient_uid,amount,mode,reference,reversed
         FROM billing_payments
        WHERE tenant_id=$1::uuid AND invoice_id=$2::int AND patient_uid=$3::uuid
          AND UPPER(mode)=$4 AND reference=$5 AND reversed=FALSE
          AND amount >= $6::numeric - 0.005
        ORDER BY id
        LIMIT 2`,
      tenant,
      Number(refund.invoice_id),
      String(refund.patient_uid),
      mode,
      originalReference,
      Number(refund.amount),
    );
    if (paymentRows.length !== 1) {
      throw AppError.unprocessable(
        'original_payment_reference does not identify one exact eligible payment',
        'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_MISMATCH',
      );
    }
    [paymentCandidate] = paymentRows;
    const gatewayOrders = await tx.$queryRawUnsafe(
      `SELECT id,provider
         FROM payment_gateway_orders
        WHERE tenant_id=$1::uuid AND billing_payment_id=$2::int AND status='paid'
        ORDER BY id
        FOR UPDATE`,
      tenant,
      Number(paymentCandidate.id),
    );
    if (gatewayOrders.length) {
      throw AppError.conflict(
        'This collection has integrated gateway evidence; use the gateway refund rail',
        'BILLING_REFUND_GATEWAY_CAPTURE_AUTHORITATIVE',
      );
    }
  }
  return {
    refundSnapshot: refund,
    mode,
    originalReference,
    providerName,
    providerRefundReference,
    providerRefundedAt,
    paymentCandidate,
  };
}

async function lockOfflineElectronicPaymentAfterFundingTx(tx, {
  tenant,
  refund,
  paymentCandidate,
  originalReference,
}) {
  const paymentRows = await tx.$queryRawUnsafe(
    `SELECT id,invoice_id,patient_uid,amount,mode,reference,reversed
       FROM billing_payments
      WHERE tenant_id=$1::uuid AND id=$2::int
        AND invoice_id=$3::int AND patient_uid=$4::uuid
        AND UPPER(mode)=$5 AND reference=$6 AND reversed=FALSE
        AND amount >= $7::numeric - 0.005
      FOR UPDATE`,
    tenant,
    Number(paymentCandidate?.id),
    Number(refund.invoice_id),
    String(refund.patient_uid),
    String(refund.mode).trim().toUpperCase(),
    originalReference,
    Number(refund.amount),
  );
  const payment = paymentRows[0];
  if (paymentRows.length !== 1
      || !paymentCandidate
      || Number(payment.id) !== Number(paymentCandidate.id)
      || Number(payment.invoice_id) !== Number(paymentCandidate.invoice_id)
      || String(payment.patient_uid).toLowerCase()
        !== String(paymentCandidate.patient_uid).toLowerCase()
      || String(payment.mode).trim().toUpperCase()
        !== String(paymentCandidate.mode).trim().toUpperCase()
      || String(payment.reference) !== String(paymentCandidate.reference)
      || payment.reversed !== false
      || toPaise(payment.amount) !== toPaise(paymentCandidate.amount)) {
    throw AppError.conflict(
      'Offline-electronic payment authority changed during funding serialization',
      'BILLING_REFUND_FUNDING_AUTHORITY_CHANGED',
    );
  }
  return payment;
}

async function lockOfflineElectronicAdvanceSourceTx(tx, {
  tenant,
  refund,
  advance,
  originalReference,
}) {
  if (!advance
      || Number(advance.id) !== Number(refund.advance_id)
      || String(advance.patient_uid).toLowerCase() !== String(refund.patient_uid).toLowerCase()
      || String(advance.mode).trim().toUpperCase()
        !== String(refund.mode).trim().toUpperCase()
      || toPaise(advance.amount) < toPaise(refund.amount)) {
    throw AppError.unprocessable(
      'original_payment_reference does not match the refund advance collection',
      'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_MISMATCH',
    );
  }
  if (advance.ipd_advance_deposit_id == null) {
    if (String(advance.reference || '') !== originalReference) {
      throw AppError.unprocessable(
        'original_payment_reference does not match the refund advance collection',
        'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_MISMATCH',
      );
    }
    return Number(advance.id);
  }
  const sourceRows = await tx.$queryRawUnsafe(
    `SELECT deposit.id,deposit.payment_reference
       FROM advance_deposits deposit
      WHERE deposit.tenant_id=$1::uuid
        AND deposit.id=$2::int
        AND deposit.patient_uid=$3::uuid
        AND deposit.admission_id IS NOT DISTINCT FROM $4::int
        AND deposit.amount=$5::numeric
        AND LOWER(BTRIM(deposit.payment_method))=LOWER(BTRIM($6))
        AND deposit.payment_method=$7
        AND deposit.collected_by IS NOT DISTINCT FROM $8::uuid
        AND deposit.collected_at=$9::timestamptz
        AND deposit.is_refund=FALSE
        AND deposit.parent_deposit_id IS NULL
      FOR UPDATE`,
    tenant,
    Number(advance.ipd_advance_deposit_id),
    String(advance.patient_uid),
    advance.admission_id == null ? null : Number(advance.admission_id),
    Number(advance.amount),
    String(advance.mode),
    String(advance.ipd_advance_deposit_payment_method),
    advance.collected_by == null ? null : String(advance.collected_by),
    advance.ipd_advance_deposit_collected_at,
  );
  if (sourceRows.length !== 1
      || String(sourceRows[0].payment_reference || '') !== originalReference) {
    throw AppError.unprocessable(
      'original_payment_reference does not match the bound IPD advance deposit',
      'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_MISMATCH',
    );
  }
  return Number(advance.id);
}

async function settleRefundPaid(refundId, {
  paid_by, reference, tenantId, payoutRail, gatewayRefundId = null,
  providerRefundId = null, cashDrawerSessionId = null,
  offlineElectronicEvidence = null, command = null, auditContext = null,
  recoveryClaimToken = null,
}) {
  const id = normalizeRefundId(refundId);
  const tenant = requireTenantId(tenantId);
  const wiring = await resolveLedgerWiring(tenant);
  let refund;
  try {
    refund = await setTenantTx(tenant, async (tx) => {
      await lockTenantPatientMergeStability(tx, tenant);
      let lockedGatewayEvidence = null;
      let lockedOfflineSource = null;
      if (payoutRail === 'offline_electronic') {
        const refundRows = await tx.$queryRawUnsafe(
          `SELECT ${REFUND_PUBLIC_COLUMNS}
             FROM billing_refunds
            WHERE tenant_id=$1::uuid AND id=$2::int
            LIMIT 1`,
          tenant,
          id,
        );
        if (!refundRows.length || refundRows[0].approval_status !== 'APPROVED') {
          throw AppError.notFound('Refund not found or not approved');
        }
        lockedOfflineSource = await discoverOfflineElectronicRefundSourceBeforeFundingTx(tx, {
          tenant,
          refund: refundRows[0],
          evidence: offlineElectronicEvidence || {},
        });
      }
      if (payoutRail === 'gateway') {
        const refundExists = await tx.$queryRawUnsafe(
          `SELECT id
             FROM billing_refunds
            WHERE tenant_id = $1::uuid
              AND id = $2::int
            LIMIT 1`,
          tenant,
          id,
        );
        if (!refundExists.length) throw AppError.notFound('Refund not found or not approved');
        // The recovery lease fence is asserted here, under FOR UPDATE: a
        // recovery worker may only settle a leg that is still leased to its
        // exact claim token. The row stays locked for the remainder of this
        // transaction, so the writes below inherit that fence without needing
        // to re-check the token.
        const evidenceRows = await tx.$queryRawUnsafe(
          `SELECT id, initiated_by, initiated_at, status,
                  provider_refund_id, processed_at
             FROM payment_gateway_refunds
            WHERE id = $1::int
              AND tenant_id = $2::uuid
              AND billing_refund_id = $3::int
              AND status IN (
                'initiated', 'pending', 'processed', 'failed', 'requires_reconciliation'
              )
              AND (provider_refund_id IS NULL OR provider_refund_id = $4)
              AND ($5::uuid IS NULL OR (
                recovery_claim_token = $5::uuid AND recovery_state = 'claimed'
              ))
            FOR UPDATE`,
          gatewayRefundId,
          tenant,
          id,
          providerRefundId,
          recoveryClaimToken,
        );
        if (!evidenceRows.length) {
          throw AppError.conflict(
            'Gateway refund execution evidence is not settlement-authoritative',
            'BILLING_REFUND_GATEWAY_EVIDENCE_INVALID',
          );
        }
        [lockedGatewayEvidence] = evidenceRows;
      }
      const fundingContext = await lockBillingRefundFundingAuthorityTx(tx, {
        tenantId: tenant,
        refundId: id,
        mergeStabilityHeld: true,
      });
      const lockedRefund = fundingContext.refund;
      if (lockedRefund.approval_status !== 'APPROVED') {
        throw AppError.notFound('Refund not found or not approved');
      }

      const mode = String(lockedRefund.mode || '').trim().toUpperCase();
      if (mode === 'INSURANCE') {
        throw AppError.conflict(
          'Insurance refunds require attributable insurer settlement evidence',
          'BILLING_INSURANCE_REFUND_SETTLEMENT_EVIDENCE_REQUIRED',
        );
      }
      if (lockedRefund.payout_rail && lockedRefund.payout_rail !== payoutRail) {
        throw AppError.conflict(
          `Refund payout is already owned by the ${lockedRefund.payout_rail} rail`,
          'BILLING_REFUND_PAYOUT_RAIL_CONFLICT',
        );
      }

      const normalizedPaidBy = paid_by ? String(paid_by).trim() : null;
      if (payoutRail !== 'gateway') {
        if (!UUID_PATTERN.test(normalizedPaidBy || '')) {
          throw AppError.badRequest(
            'Authenticated refund payout actor is required',
            'BILLING_REFUND_PAYOUT_ACTOR_REQUIRED',
          );
        }
        if (String(lockedRefund.approved_by || '').toLowerCase()
            === normalizedPaidBy.toLowerCase()) {
          throw AppError.conflict(
            'Refund payout actor must differ from the approval actor',
            'BILLING_REFUND_PAYER_MUST_DIFFER_FROM_APPROVER',
          );
        }
      }

      let normalizedReference = reference;
      let normalizedDrawerId = null;
      let offlineEvidenceId = null;

      if (payoutRail === 'manual') {
        if (!MANUAL_REFUND_MODES.includes(mode)) {
          throw AppError.conflict(
            'Electronic refunds require integrated gateway or governed offline-electronic evidence',
            'BILLING_REFUND_MANUAL_ELECTRONIC_FORBIDDEN',
          );
        }
        normalizedReference = normalizeRefundPayoutReference(reference);
        if (mode === 'CASH') {
          if (cashDrawerSessionId == null || cashDrawerSessionId === '') {
            throw AppError.badRequest(
              'cash_drawer_session_id is required for CASH refunds',
              'BILLING_REFUND_CASH_DRAWER_REQUIRED',
            );
          }
          normalizedDrawerId = normalizePositiveBigIntId(
            cashDrawerSessionId,
            'cash_drawer_session_id',
            'BILLING_REFUND_CASH_DRAWER_INVALID',
          );
          const drawerRows = await tx.$queryRawUnsafe(
            `SELECT id, cashier_uid, shift, opened_at, opening_float, status
               FROM cash_drawer_sessions
              WHERE tenant_id = $1::uuid
                AND id = $2::bigint
              FOR UPDATE`,
            tenant,
            normalizedDrawerId,
          );
          const drawer = drawerRows[0];
          if (!drawer || drawer.status !== 'open') {
            throw AppError.conflict(
              'Cash-drawer session is not open for this tenant',
              'BILLING_REFUND_CASH_DRAWER_NOT_OPEN',
            );
          }
          if (String(drawer.cashier_uid).toLowerCase() !== normalizedPaidBy.toLowerCase()) {
            throw AppError.forbidden(
              'Cash-drawer session is owned by a different cashier',
              'BILLING_REFUND_CASH_DRAWER_OWNER_MISMATCH',
            );
          }
          const availabilityRows = await tx.$queryRawUnsafe(
            `SELECT
               COALESCE((
                 SELECT SUM(payment.amount)
                   FROM billing_payments payment
                  WHERE payment.tenant_id = $1::uuid
                    AND payment.mode = 'CASH'
                    AND payment.reversed = FALSE
                    AND payment.collected_by = $2::uuid
                    AND payment.shift = $3
                    AND payment.collected_at >= $4::timestamptz
               ), 0)::numeric AS cash_inflow_total,
               COALESCE((
                 SELECT SUM(existing.amount)
                   FROM billing_refunds existing
                  WHERE existing.tenant_id = $1::uuid
                    AND existing.cash_drawer_session_id = $5::bigint
                    AND existing.mode = 'CASH'
                    AND existing.approval_status = 'PAID'
                    AND existing.payout_rail = 'manual'
               ), 0)::numeric AS cash_refund_total`,
            tenant,
            normalizedPaidBy,
            drawer.shift,
            drawer.opened_at,
            normalizedDrawerId,
          );
          const cashInflow = Number(availabilityRows[0]?.cash_inflow_total || 0);
          const cashRefunds = Number(availabilityRows[0]?.cash_refund_total || 0);
          const available = toFixed2(Number(drawer.opening_float || 0) + cashInflow - cashRefunds);
          if (available + 0.005 < Number(lockedRefund.amount)) {
            throw AppError.conflict(
              'Cash-drawer session does not contain enough accountable cash for this refund',
              'BILLING_REFUND_CASH_DRAWER_INSUFFICIENT_FUNDS',
              { available, refund_amount: Number(lockedRefund.amount) },
            );
          }
        } else if (cashDrawerSessionId != null && cashDrawerSessionId !== '') {
          throw AppError.badRequest(
            'cash_drawer_session_id is only valid for CASH refunds',
            'BILLING_REFUND_CASH_DRAWER_MODE_MISMATCH',
          );
        }
      } else if (payoutRail === 'offline_electronic') {
        const snapshot = lockedOfflineSource?.refundSnapshot;
        if (!snapshot
            || Number(snapshot.id) !== Number(lockedRefund.id)
            || (snapshot.invoice_id == null ? null : Number(snapshot.invoice_id))
              !== (lockedRefund.invoice_id == null ? null : Number(lockedRefund.invoice_id))
            || (snapshot.advance_id == null ? null : Number(snapshot.advance_id))
              !== (lockedRefund.advance_id == null ? null : Number(lockedRefund.advance_id))
            || String(snapshot.patient_uid).toLowerCase()
              !== String(lockedRefund.patient_uid).toLowerCase()
            || String(snapshot.mode).toUpperCase() !== mode
            || toPaise(snapshot.amount) !== toPaise(lockedRefund.amount)) {
          throw AppError.conflict(
            'Offline-electronic source authority changed during settlement',
            'BILLING_REFUND_FUNDING_AUTHORITY_CHANGED',
          );
        }
        const {
          originalReference,
          providerName,
          providerRefundReference,
          providerRefundedAt,
          paymentCandidate,
        } = lockedOfflineSource;
        let originalPaymentId = null;
        let originalAdvanceId = null;
        if (lockedRefund.invoice_id) {
          const originalPayment = await lockOfflineElectronicPaymentAfterFundingTx(tx, {
            tenant,
            refund: lockedRefund,
            paymentCandidate,
            originalReference,
          });
          originalPaymentId = Number(originalPayment.id);
        } else {
          originalAdvanceId = await lockOfflineElectronicAdvanceSourceTx(tx, {
            tenant,
            refund: lockedRefund,
            advance: fundingContext.parent,
            originalReference,
          });
        }
        const evidenceRows = await tx.$queryRawUnsafe(
          `INSERT INTO billing_refund_offline_electronic_evidence
             (tenant_id, refund_id, original_payment_id, original_advance_id,
              mode, amount, provider_name, original_payment_reference,
              provider_refund_reference, provider_refunded_at, recorded_by)
           VALUES ($1::uuid, $2::int, $3::int, $4::int,
                   $5, $6::numeric, $7, $8, $9, $10::timestamptz, $11::uuid)
           RETURNING id`,
          tenant,
          id,
          originalPaymentId,
          originalAdvanceId,
          mode,
          Number(lockedRefund.amount),
          providerName,
          originalReference,
          providerRefundReference,
          providerRefundedAt,
          normalizedPaidBy,
        );
        offlineEvidenceId = String(evidenceRows[0].id);
        normalizedReference = providerRefundReference;
      } else if (payoutRail === 'gateway') {
        if (!OFFLINE_ELECTRONIC_REFUND_MODES.includes(mode)) {
          throw AppError.conflict(
            'Gateway evidence is only valid for electronic refund modes',
            'BILLING_REFUND_GATEWAY_MODE_MISMATCH',
          );
        }
        if (String(lockedGatewayEvidence.initiated_by || '').toLowerCase()
            === String(lockedRefund.approved_by || '').toLowerCase()) {
          throw AppError.conflict(
            'Refund payout actor must differ from the approval actor',
            'BILLING_REFUND_PAYER_MUST_DIFFER_FROM_APPROVER',
          );
        }
        if (new Date(lockedGatewayEvidence.initiated_at).getTime()
            < new Date(lockedRefund.approved_at).getTime()) {
          throw AppError.conflict(
            'Gateway refund execution predates billing approval',
            'BILLING_REFUND_GATEWAY_EVIDENCE_INVALID',
          );
        }
        // Exact provider `processed` evidence outranks any operator
        // reconciliation already recorded against this leg: the prior
        // disposition is preserved in metadata (append-only history) and every
        // reconciliation column is cleared together, because
        // chk_pg_refund_reconciliation_review only admits an all-NULL or a
        // fully populated review tuple.
        const processedRows = await tx.$queryRawUnsafe(
          `UPDATE payment_gateway_refunds
              SET status = 'processed',
                  provider_refund_id = COALESCE(provider_refund_id, $1),
                  processed_at = COALESCE(processed_at, NOW()),
                  failed_at = NULL,
                  failure_code = NULL,
                  failure_reason = NULL,
                  metadata = CASE
                    WHEN reconciliation_disposition IS NULL AND reconciled_at IS NULL
                      THEN metadata
                    ELSE jsonb_set(
                      COALESCE(metadata, '{}'::jsonb),
                      '{provider_evidence_superseded_reconciliations}',
                      (
                        CASE
                          WHEN jsonb_typeof(metadata->'provider_evidence_superseded_reconciliations') = 'array'
                            THEN metadata->'provider_evidence_superseded_reconciliations'
                          ELSE '[]'::jsonb
                        END
                      ) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                        'reconciled_at', reconciled_at,
                        'reconciled_by', reconciled_by,
                        'disposition', reconciliation_disposition,
                        'evidence', reconciliation_evidence,
                        'reviewed_by', reconciliation_reviewed_by,
                        'reviewed_at', reconciliation_reviewed_at,
                        'superseded_by', 'exact_provider_processed_evidence'
                      ))),
                      true
                    )
                  END,
                  reconciled_at = NULL,
                  reconciliation_note = NULL,
                  reconciled_by = NULL,
                  reconciliation_disposition = NULL,
                  reconciliation_evidence = NULL,
                  reconciliation_reviewed_by = NULL,
                  reconciliation_reviewed_at = NULL,
                  updated_at = NOW()
            WHERE id = $2::int
              AND tenant_id = $3::uuid
              AND billing_refund_id = $4::int
              AND status IN (
                'initiated', 'pending', 'processed', 'failed', 'requires_reconciliation'
              )
              AND (provider_refund_id IS NULL OR provider_refund_id = $1)
            RETURNING id, status, provider_refund_id, processed_at`,
          providerRefundId, gatewayRefundId, tenant, id,
        );
        if (!processedRows.length
            || processedRows[0].status !== 'processed'
            || String(processedRows[0].provider_refund_id) !== String(providerRefundId)
            || !processedRows[0].processed_at) {
          throw AppError.conflict(
            'Gateway refund execution could not be atomically finalized',
            'BILLING_REFUND_GATEWAY_EVIDENCE_INVALID',
          );
        }
        normalizedReference = providerRefundId;
      }

      const rows = await tx.$queryRawUnsafe(
        `UPDATE billing_refunds
            SET approval_status = 'PAID',
                paid_by = $1::uuid,
                paid_at = NOW(),
                reference = $2,
                payout_rail = $3,
                payout_rail_claimed_at = COALESCE(payout_rail_claimed_at, NOW()),
                gateway_refund_id = CASE WHEN $3 = 'gateway' THEN $4::int ELSE NULL END,
                cash_drawer_session_id = $5::bigint,
                offline_electronic_evidence_id = $6::bigint,
                updated_at = NOW()
          WHERE tenant_id = $7::uuid
            AND id = $8::int
            AND patient_uid = $9::uuid
            AND approval_status = 'APPROVED'
            AND (
              ($3 = 'gateway' AND payout_rail = 'gateway' AND gateway_refund_id = $4::int)
              OR ($3 <> 'gateway' AND (payout_rail IS NULL OR payout_rail = $3))
            )
          RETURNING ${REFUND_PUBLIC_COLUMNS}`,
        payoutRail === 'gateway' ? null : normalizedPaidBy,
        normalizedReference,
        payoutRail,
        gatewayRefundId,
        normalizedDrawerId,
        offlineEvidenceId,
        tenant,
        id,
        fundingContext.storedPatientUid,
      );
      if (!rows.length) {
        throw AppError.conflict(
          'Refund payout authority changed concurrently',
          'BILLING_REFUND_PAYOUT_RAIL_CONFLICT',
        );
      }
      let paidRefund = rows[0];

      if (!wiring.sameTx && paidRefund.advance_id) {
        const dec = await tx.$queryRawUnsafe(
          `UPDATE billing_advances
              SET balance = balance - $1::numeric,
                  status = CASE WHEN balance - $1::numeric <= 0.005 THEN 'REFUNDED' ELSE status END,
                  updated_at = NOW()
            WHERE id = $2::int
              AND balance >= $1::numeric - 0.005
            RETURNING id`,
          Number(paidRefund.amount), Number(paidRefund.advance_id),
        );
        if (!dec.length) {
          throw AppError.badRequest(
            'Refund payout exceeds the advance balance available at payout time.',
            'BILLING_REFUND_EXCEEDS_ADVANCE_BALANCE',
          );
        }
      }

      if (!wiring.sameTx && paidRefund.invoice_id) {
        const inv = fundingContext.parent;
        if (inv) {
          await tx.$executeRawUnsafe(
            `UPDATE billing_invoices
                SET amount_paid = GREATEST(amount_paid - $1::numeric, 0),
                    amount_due = GREATEST(
                      total_amount - credit_note_amount - GREATEST(amount_paid - $1::numeric, 0),
                      0
                    ),
                    status = CASE
                               WHEN total_amount - credit_note_amount
                                    - GREATEST(amount_paid - $1::numeric, 0) <= 0.005 THEN 'PAID'
                               WHEN GREATEST(amount_paid - $1::numeric, 0) <= 0.005 THEN 'ISSUED'
                               ELSE 'PARTIAL'
                             END,
                    updated_at = NOW()
              WHERE id = $2::int`,
            Number(paidRefund.amount), Number(paidRefund.invoice_id),
          );
        }
      }
      if (wiring.sameTx) {
        await postRefundPaidEntry({ refund: paidRefund, tenantId: tenant, tx });
        if (paidRefund.advance_id) {
          await deriveAdvanceBalanceFromLedgerTx(tx, paidRefund.advance_id, {
            exhaustedStatus: 'REFUNDED',
          });
        }
        if (paidRefund.invoice_id) {
          await deriveInvoicePaymentStateFromLedgerTx(tx, paidRefund.invoice_id);
        }
      }
      const linkedCreditNote = await loadAppliedCreditNoteForRefundTx(
        tx,
        paidRefund.id,
        tenant,
      );
      if (linkedCreditNote) {
        let completionActor = normalizedPaidBy;
        if (!completionActor && gatewayRefundId) {
          const actorRows = await tx.$queryRawUnsafe(
            `SELECT initiated_by
               FROM payment_gateway_refunds
              WHERE tenant_id = $1::uuid
                AND id = $2::int
                AND billing_refund_id = $3::int
              LIMIT 1`,
            tenant,
            gatewayRefundId,
            Number(paidRefund.id),
          );
          completionActor = actorRows[0]?.initiated_by
            ? String(actorRows[0].initiated_by)
            : null;
        }
        if (!completionActor) {
          throw AppError.conflict(
            'Medication credit refund payout has no authenticated completion actor',
            'BILLING_CREDIT_NOTE_REFUND_COMPLETION_ACTOR_MISSING',
          );
        }
        await completeBillingCreditNoteRefundObligationTx(tx, {
          creditNote: linkedCreditNote,
          refund: paidRefund,
          actorUid: completionActor,
        });
      }
      if (normalizedDrawerId) {
        const totalRows = await tx.$queryRawUnsafe(
          `SELECT
             COALESCE((
               SELECT SUM(payment.amount)
                 FROM billing_payments payment
                 JOIN cash_drawer_sessions drawer
                   ON drawer.tenant_id = payment.tenant_id
                  AND drawer.id = $2::bigint
                WHERE payment.tenant_id = $1::uuid
                  AND payment.mode = 'CASH'
                  AND payment.reversed = FALSE
                  AND payment.collected_by = drawer.cashier_uid
                  AND payment.shift = drawer.shift
                  AND payment.collected_at >= drawer.opened_at
             ), 0)::numeric AS cash_inflow_total,
             COALESCE((
               SELECT SUM(existing.amount)
                 FROM billing_refunds existing
                WHERE existing.tenant_id = $1::uuid
                  AND existing.cash_drawer_session_id = $2::bigint
                  AND existing.mode = 'CASH'
                  AND existing.approval_status = 'PAID'
                  AND existing.payout_rail = 'manual'
             ), 0)::numeric AS cash_refund_total`,
          tenant,
          normalizedDrawerId,
        );
        const cashInflowTotal = toFixed2(Number(totalRows[0]?.cash_inflow_total || 0));
        const cashRefundTotal = toFixed2(Number(totalRows[0]?.cash_refund_total || 0));
        paidRefund = {
          ...paidRefund,
          cash_inflow_total: cashInflowTotal,
          cash_refund_total: cashRefundTotal,
          system_total: toFixed2(cashInflowTotal - cashRefundTotal),
        };
      }
      await insertRefundMutationAuditTx(tx, {
        tenantId: tenant,
        refund: paidRefund,
        auditContext,
        action: 'FRONT_OFFICE_BILLING_REFUND_PAID',
        missingCode: 'BILLING_REFUND_PAYOUT_AUDIT_MISSING',
      });
      await finaliseRefundMutationIdempotencyTx(tx, {
        tenantId: tenant,
        command,
        refund: paidRefund,
        changedCode: 'BILLING_REFUND_PAYOUT_IDEMPOTENCY_CHANGED',
        label: 'Refund payout',
      });
      if (payoutRail === 'gateway') {
        paidRefund = { ...paidRefund, gateway_authority_transitioned: true };
      }
      return paidRefund;
    });
  } catch (err) {
    throw translateRefundPayoutConstraintError(err);
  }
  // Shadow: post-commit best-effort REFUND_PAID (debit REFUNDS_PAYABLE /
  // credit CASH|BANK). Off: skip.
  if (wiring.postCommit) {
    try {
      await postRefundPaidEntry({ refund, tenantId: tenant });
    } catch (ledgerErr) {
      logger.error('Ledger REFUND_PAID post failed (non-blocking)', { refund_id: refund?.id, error: ledgerErr.message });
    }
  }
  return refund;
}

export async function markRefundPaid(refundId, {
  paid_by,
  reference,
  cash_drawer_session_id,
  tenantId,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId,
  auditContext,
} = {}) {
  const id = normalizeRefundId(refundId);
  const command = normalizeRefundMutationCommand({
    actorUid: paid_by,
    commandKey,
    requestFingerprint,
    httpIdempotencyClaimId,
    requestId,
    expectedBody: refundManualPayoutIdempotencyBody(id, {
      reference,
      cash_drawer_session_id,
    }),
    path: REFUND_MANUAL_PAYOUT_IDEMPOTENCY_PATH,
    invalidCode: 'BILLING_REFUND_PAYOUT_IDEMPOTENCY_INVALID',
    mismatchCode: 'BILLING_REFUND_PAYOUT_COMMAND_MISMATCH',
    label: 'Refund payout',
  });
  const normalizedAuditContext = normalizeRefundMutationAuditContext(auditContext, {
    actorUid: paid_by,
    command,
    invalidCode: 'BILLING_REFUND_PAYOUT_AUDIT_CONTEXT_INVALID',
    missingCode: 'BILLING_REFUND_PAYOUT_AUDIT_CONTEXT_MISSING',
    label: 'Refund payout',
  });
  return settleRefundPaid(id, {
    paid_by,
    reference,
    cashDrawerSessionId: cash_drawer_session_id,
    tenantId,
    payoutRail: 'manual',
    gatewayRefundId: null,
    command,
    auditContext: normalizedAuditContext,
  });
}

export async function markOfflineElectronicRefundPaid(refundId, {
  paid_by,
  tenantId,
  original_payment_reference,
  provider_name,
  provider_refund_reference,
  provider_refunded_at,
  commandKey,
  requestFingerprint,
  httpIdempotencyClaimId,
  requestId,
  auditContext,
} = {}) {
  const id = normalizeRefundId(refundId);
  const commandBody = {
    original_payment_reference,
    provider_name,
    provider_refund_reference,
    provider_refunded_at,
  };
  const command = normalizeRefundMutationCommand({
    actorUid: paid_by,
    commandKey,
    requestFingerprint,
    httpIdempotencyClaimId,
    requestId,
    expectedBody: refundOfflineElectronicPayoutIdempotencyBody(id, commandBody),
    path: REFUND_OFFLINE_ELECTRONIC_PAYOUT_IDEMPOTENCY_PATH,
    invalidCode: 'BILLING_REFUND_PAYOUT_IDEMPOTENCY_INVALID',
    mismatchCode: 'BILLING_REFUND_PAYOUT_COMMAND_MISMATCH',
    label: 'Refund payout',
  });
  const normalizedAuditContext = normalizeRefundMutationAuditContext(auditContext, {
    actorUid: paid_by,
    command,
    invalidCode: 'BILLING_REFUND_PAYOUT_AUDIT_CONTEXT_INVALID',
    missingCode: 'BILLING_REFUND_PAYOUT_AUDIT_CONTEXT_MISSING',
    label: 'Refund payout',
  });
  return settleRefundPaid(id, {
    paid_by,
    reference: provider_refund_reference,
    tenantId,
    payoutRail: 'offline_electronic',
    offlineElectronicEvidence: commandBody,
    command,
    auditContext: normalizedAuditContext,
  });
}

export async function markGatewayRefundPaid(refundId, {
  tenantId, gateway_refund_id, provider_refund_id, recovery_claim_token = null,
} = {}) {
  const id = normalizeRefundId(refundId);
  const gatewayRefundId = Number(gateway_refund_id);
  const providerRefundId = String(provider_refund_id || '').trim();
  if (!Number.isInteger(gatewayRefundId) || gatewayRefundId <= 0
      || !providerRefundId || providerRefundId.length > 120) {
    throw AppError.badRequest(
      'Exact gateway refund execution evidence is required for gateway payout',
      'BILLING_REFUND_GATEWAY_EXECUTION_REQUIRED',
    );
  }
  return settleRefundPaid(id, {
    paid_by: null,
    reference: providerRefundId,
    tenantId,
    payoutRail: 'gateway',
    gatewayRefundId,
    providerRefundId,
    recoveryClaimToken: recovery_claim_token,
  });
}

function normalizeRefundId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw AppError.badRequest(
      'refund id must be a canonical positive PostgreSQL integer',
      'BILLING_REFUND_ID_INVALID',
    );
  }
  const raw = String(value ?? '');
  const text = raw.trim();
  if (raw !== text || !/^[1-9][0-9]*$/.test(text)) {
    throw AppError.badRequest(
      'refund id must be a canonical positive PostgreSQL integer',
      'BILLING_REFUND_ID_INVALID',
    );
  }
  const parsed = BigInt(text);
  if (parsed > 2_147_483_647n) {
    throw AppError.badRequest(
      'refund id exceeds the PostgreSQL integer range',
      'BILLING_REFUND_ID_INVALID',
    );
  }
  return Number(parsed);
}

function normalizeOptionalPositiveBigIntFilter(value, label) {
  if (value == null || value === '') return null;
  return normalizePositiveBigIntId(value, label, 'BILLING_REFUND_FILTER_INVALID');
}

function refundWorkflowStatus(refund, voidRequest) {
  if (voidRequest?.status === 'REFUND_REJECTED_REVIEW') return 'refund_rejected_review';
  if (voidRequest?.status === 'RECONCILIATION_REQUIRED') return 'reconciliation_required';
  if (voidRequest?.status === 'COMPLETED') return 'counter_sale_void_completed';
  if (refund.approval_status === 'PAID') return 'paid';
  if (refund.approval_status === 'REJECTED') return 'rejected';
  if (refund.approval_status === 'APPROVED') return 'ready_for_payout';
  return 'awaiting_approval';
}

export async function getRefund(refundId, { tenantId } = {}) {
  const tenant = requireTenantId(tenantId);
  const id = normalizeRefundId(refundId);
  return setTenantTx(tenant, async (tx) => {
    const refundRows = await tx.$queryRawUnsafe(
      `SELECT ${REFUND_PUBLIC_COLUMNS}
         FROM billing_refunds
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        LIMIT 1`,
      tenant,
      id,
    );
    const refund = refundRows[0];
    if (!refund) throw AppError.notFound('Refund not found', 'BILLING_REFUND_NOT_FOUND');

    let voidRequest = null;
    if (refund.counter_sale_void_request_id != null) {
      const requestRows = await tx.$queryRawUnsafe(
        `SELECT id::text, counter_sale_id::text, invoice_id, refund_id,
                amount, refund_mode, disposition, reason, status,
                requested_at, last_checked_at, reconciled_at, reconciliation_source
           FROM pharmacy_counter_sale_void_requests
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
          LIMIT 1`,
        tenant,
        String(refund.counter_sale_void_request_id),
      );
      voidRequest = requestRows[0] || null;
    }

    let offlineEvidence = null;
    if (refund.offline_electronic_evidence_id != null) {
      const evidenceRows = await tx.$queryRawUnsafe(
        `SELECT id::text, tenant_id, refund_id, original_payment_id,
                original_advance_id, mode, amount, provider_name,
                original_payment_reference, provider_refund_reference,
                provider_refunded_at, recorded_by, recorded_at
           FROM billing_refund_offline_electronic_evidence
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
            AND refund_id = $3::int
          LIMIT 1`,
        tenant,
        String(refund.offline_electronic_evidence_id),
        id,
      );
      offlineEvidence = evidenceRows[0] || null;
    }

    const allowedPayoutRails = [];
    let originalPayment = null;
    if (refund.approval_status === 'APPROVED') {
      const mode = String(refund.mode || '').trim().toUpperCase();
      if (MANUAL_REFUND_MODES.includes(mode)) {
        allowedPayoutRails.push('manual');
      } else if (OFFLINE_ELECTRONIC_REFUND_MODES.includes(mode)) {
        if (refund.invoice_id) {
          const candidates = await tx.$queryRawUnsafe(
            `SELECT payment.id, UPPER(payment.mode) AS mode, payment.reference,
                    gateway.provider AS provider_name,
                    gateway.id AS gateway_order_id
               FROM billing_payments payment
               LEFT JOIN LATERAL (
                 SELECT orders.id, orders.provider
                   FROM payment_gateway_orders orders
                  WHERE orders.tenant_id = payment.tenant_id
                    AND orders.billing_payment_id = payment.id
                    AND orders.status = 'paid'
                  ORDER BY orders.id DESC
                  LIMIT 1
               ) gateway ON TRUE
              WHERE payment.tenant_id = $1::uuid
                AND payment.invoice_id = $2::int
                AND payment.patient_uid = $3::uuid
                AND UPPER(payment.mode) = $4
                AND payment.reversed = FALSE
                AND payment.amount >= $5::numeric - 0.005
                AND length(btrim(COALESCE(payment.reference, ''))) > 0
              ORDER BY payment.id`,
            tenant,
            Number(refund.invoice_id),
            String(refund.patient_uid),
            mode,
            Number(refund.amount),
          );
          if (candidates.some((candidate) => candidate.gateway_order_id != null)) {
            allowedPayoutRails.push('gateway');
          }
          if (candidates.some((candidate) => candidate.gateway_order_id == null)) {
            allowedPayoutRails.push('offline_electronic');
          }
          if (candidates.length === 1) {
            originalPayment = {
              id: Number(candidates[0].id),
              mode: candidates[0].mode,
              reference: candidates[0].reference,
              provider_name: candidates[0].provider_name || null,
            };
          }
        } else {
          const advanceRows = await tx.$queryRawUnsafe(
            `SELECT id, UPPER(mode) AS mode, reference
               FROM billing_advances
              WHERE tenant_id = $1::uuid
                AND id = $2::int
                AND patient_uid = $3::uuid
                AND UPPER(mode) = $4
                AND amount >= $5::numeric - 0.005
                AND length(btrim(COALESCE(reference, ''))) > 0
              LIMIT 1`,
            tenant,
            Number(refund.advance_id),
            String(refund.patient_uid),
            mode,
            Number(refund.amount),
          );
          if (advanceRows[0]) {
            allowedPayoutRails.push('offline_electronic');
            originalPayment = {
              id: Number(advanceRows[0].id),
              mode: advanceRows[0].mode,
              reference: advanceRows[0].reference,
              provider_name: null,
            };
          }
        }
      }
    } else if (offlineEvidence) {
      originalPayment = {
        id: Number(offlineEvidence.original_payment_id || offlineEvidence.original_advance_id),
        mode: offlineEvidence.mode,
        reference: offlineEvidence.original_payment_reference,
        provider_name: offlineEvidence.provider_name,
      };
    }

    return {
      refund,
      void_request: voidRequest,
      offline_electronic_evidence: offlineEvidence,
      original_payment: originalPayment,
      workflow_status: refundWorkflowStatus(refund, voidRequest),
      allowed_payout_rails: allowedPayoutRails,
    };
  });
}

export async function listRefunds({
  tenantId,
  approval_status,
  patient_uid,
  id,
  counter_sale_void_request_id,
} = {}) {
  const params = [];
  const where = [];
  pushTenantWhere(where, params, tenantId);
  if (approval_status) {
    const status = String(approval_status).trim().toUpperCase();
    if (!VALID_REFUND_STATUSES.includes(status)) {
      throw AppError.badRequest(
        `approval_status must be one of ${VALID_REFUND_STATUSES.join(', ')}`,
        'BILLING_REFUND_STATUS_FILTER_INVALID',
      );
    }
    params.push(status);
    where.push(`approval_status = $${params.length}`);
  }
  if (patient_uid) { params.push(String(patient_uid)); where.push(`patient_uid = $${params.length}::uuid`); }
  if (id != null && id !== '') {
    params.push(normalizeRefundId(id));
    where.push(`id = $${params.length}::int`);
  }
  const voidRequestId = normalizeOptionalPositiveBigIntFilter(
    counter_sale_void_request_id,
    'counter_sale_void_request_id',
  );
  if (voidRequestId) {
    params.push(voidRequestId);
    where.push(`counter_sale_void_request_id = $${params.length}::bigint`);
  }
  const sql = `SELECT ${REFUND_PUBLIC_COLUMNS} FROM billing_refunds
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY raised_at DESC LIMIT 200`;
  return prisma.$queryRawUnsafe(sql, ...params);
}

// ───────────────────────────────────────────────────────────────────────
// Reports
// ───────────────────────────────────────────────────────────────────────

export async function dailyCollection({ date, mode, shift, collected_by } = {}) {
  const target = date || istDateString();
  const params = [target];
  const where = [`DATE(collected_at AT TIME ZONE 'Asia/Kolkata') = $1::date`];
  // bpWhere mirrors `where` with a `bp.` table alias for the insurer
  // breakdown query below (which joins billing_payments to the claim
  // tables). Same param positions — the two share `params`.
  const bpWhere = [`DATE(bp.collected_at AT TIME ZONE 'Asia/Kolkata') = $1::date`];
  if (mode) {
    params.push(mode);
    where.push(`mode = $${params.length}`);
    bpWhere.push(`bp.mode = $${params.length}`);
  }
  if (shift) {
    params.push(shift);
    where.push(`shift = $${params.length}`);
    bpWhere.push(`bp.shift = $${params.length}`);
  }
  if (collected_by) {
    params.push(String(collected_by));
    where.push(`collected_by = $${params.length}::uuid`);
    bpWhere.push(`bp.collected_by = $${params.length}::uuid`);
  }

  const items = await prisma.$queryRawUnsafe(
    `SELECT id, invoice_id, patient_uid, amount, mode, reference, denominations,
            collected_by, shift, collected_at, reversed
       FROM billing_payments
      WHERE ${where.join(' AND ')}
      ORDER BY collected_at DESC`,
    ...params,
  );
  const summary = await prisma.$queryRawUnsafe(
    `SELECT mode, COUNT(*)::int AS payment_count,
            SUM(CASE WHEN reversed THEN 0 ELSE amount END)::numeric AS net_amount,
            SUM(amount)::numeric AS gross_amount
       FROM billing_payments
      WHERE ${where.join(' AND ')}
      GROUP BY mode
      ORDER BY net_amount DESC`,
    ...params,
  );

  // Per-insurer breakdown for INSURANCE-mode payments. Finance reconciles
  // end-of-day TPA credits against bank advice per insurer — the mode-only
  // summary lumps every insurer into one bucket, which is unusable for
  // that. Resolve the insurer per payment through the invoice, preferring
  // the Sprint-5 tpa_claims surface and falling back to the legacy
  // insurance_claims row. Finding:
  // 2026-05-09-tpa-insurance-claim-billing-collection-no-insurer-breakdown
  const insurer_breakdown = await prisma.$queryRawUnsafe(
    `SELECT
        COALESCE(ins.insurer, 'Unattributed') AS insurer,
        ins.policy_number,
        ins.claim_number,
        COUNT(*)::int AS payment_count,
        SUM(CASE WHEN bp.reversed THEN 0 ELSE bp.amount END)::numeric AS net_amount,
        SUM(bp.amount)::numeric AS gross_amount
       FROM billing_payments bp
       LEFT JOIN LATERAL (
         SELECT insurer, policy_number, claim_number
           FROM (
             SELECT 1 AS pri,
                    COALESCE(py.display_name, t.display_name, 'Unknown insurer') AS insurer,
                    ip.policy_number,
                    tc.claim_number,
                    tc.created_at AS ts
               FROM tpa_claims tc
               JOIN insurance_policies ip ON ip.id = tc.policy_id
               LEFT JOIN payers py ON py.id = ip.payer_id
               LEFT JOIN tpas t ON t.id = ip.tpa_id
              WHERE tc.invoice_id = bp.invoice_id
             UNION ALL
             SELECT 2 AS pri,
                    ic.insurance_provider AS insurer,
                    ic.policy_number,
                    ic.claim_number,
                    ic.created_at AS ts
               FROM insurance_claims ic
              WHERE ic.invoice_id = bp.invoice_id
           ) cand
          ORDER BY pri, ts DESC
          LIMIT 1
       ) ins ON true
      WHERE ${bpWhere.join(' AND ')}
        AND bp.mode = 'INSURANCE'
      GROUP BY COALESCE(ins.insurer, 'Unattributed'),
               ins.policy_number, ins.claim_number
      ORDER BY net_amount DESC`,
    ...params,
  );

  return { date: target, summary, insurer_breakdown, items };
}

// ─── Wave-5 batch-3 — admission invoice auto-itemizer ─────────────────
//
// Closes the deferral from Wave 2.1 (commit 5f4f0db6's migration 199
// added the source-ref columns as the unblock). Walks the events that
// happened during an admission and emits one billing_invoice_items
// row per source record. Items carry source_ref_type +
// source_ref_id so the bill stays auditable, plus a default
// tpa_decision so the patient portal can preview the non-payable
// component as it accumulates instead of only at discharge.
//
// Findings:
//   2026-05-10-surgical-day-care-billing-package-not-itemised-iol-delta-opaque
//   2026-05-09-tpa-insurance-claim-discharge-nonpayable-not-disclosed-proactively
//
// Idempotency. Each candidate emission is keyed on
// (source_ref_type, source_ref_id). The function reads the invoice's
// existing items first and skips any source that already has a line.
// Calling itemizeAdmissionInvoice() multiple times during a stay is
// safe — only new events surface.
//
// Scope. The function itemises:
//   * Package line (one)                — `admission_package`
//   * Pharmacy orders (one per order)   — `pharmacy_order`
//   * Issued ward indents (one per indent) — `ward_indent`
//   * Investigations (one per test)     — `lab_order`
//   * Discharge consults (one per row)  — `discharge_consult`
//   * OT schedules (one per case)       — `theatre_case`
//
// Skipped intentionally: individual room-day breakdown. Room-days need
// a separate room-cost catalogue that doesn't exist yet, so the cashier
// adds them manually until that catalogue is seeded.
//
// TPA decision defaults are conservative — 'pending' for orders, and
// 'payable' for the package line. Room-upgrade-delta detection is
// inline: if the admission's bed category exceeds the package's
// bedded category, an extra non-payable 'room_upgrade_delta' line is
// added with quantity equal to length-of-stay (so the patient can
// see "Room upgrade × 3 nights — non-payable" on the portal).

const ITEMIZER_DEFAULT_GST = 0; // healthcare services exempt from GST in India

async function fetchExistingSourceLines(invoiceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, source_ref_type, source_ref_id, description, category, quantity,
            unit_price, gst_rate, line_subtotal, line_total, notes, tenant_id
       FROM billing_invoice_items
      WHERE invoice_id = $1::int
        AND source_ref_type IS NOT NULL
        AND source_ref_active = TRUE`,
    Number(invoiceId),
  );
  const lines = new Map();
  for (const r of rows) {
    lines.set(`${r.source_ref_type}:${r.source_ref_id ?? 'NULL'}`, r);
  }
  return lines;
}

async function fetchAdmissionForItemizing(admissionId, tenantId = null) {
  const params = [Number(admissionId)];
  const tenantSql = appendTenantPredicate(params, tenantId, 'a.tenant_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.tenant_id, a.patient_uid, a.encounter_id, a.admitted_at, a.discharged_at,
            a.ward, a.bed_id, a.package_id, a.package_code,
            a.package_estimated_cost_minor,
            p.fixed_price_minor AS package_price_minor,
            p.display_name      AS package_name
       FROM admissions a
       LEFT JOIN packages p ON p.id = a.package_id
      WHERE a.id = $1::int${tenantSql}
      LIMIT 1`,
    ...params,
  );
  return rows[0] || null;
}

export async function itemizeAdmissionInvoice(invoiceId, {
  tenantId = null,
  decided_by = null,
  emit_package = true,
  emit_pharmacy = true,
  emit_ward_indents = true,
  emit_lab = true,
  emit_consults = true,
  emit_theatre = true,
} = {}) {
  const invId = Number(invoiceId);
  if (!Number.isInteger(invId) || invId <= 0) {
    throw AppError.badRequest('invoiceId must be a positive integer');
  }

  // Phase 0 — pre-flight: invoice exists, is DRAFT, and has an admission.
  const inv = await findBillingInvoice(
    invId,
    tenantId,
    'id, status, admission_id, patient_uid, tenant_id',
  );
  if (!inv) throw AppError.notFound('Invoice not found');
  if (inv.status !== 'DRAFT') {
    throw AppError.badRequest('Auto-itemize can only run on a DRAFT invoice');
  }
  if (!inv.admission_id) {
    throw AppError.badRequest('Invoice has no admission_id — auto-itemize only supports admission-scoped invoices');
  }
  const admission = await fetchAdmissionForItemizing(inv.admission_id, tenantId);
  if (!admission) throw AppError.notFound('Admission not found');
  if (String(inv.tenant_id) !== String(admission.tenant_id)
      || String(inv.patient_uid) !== String(admission.patient_uid)) {
    throw AppError.conflict(
      'The invoice does not belong to the exact admission patient and tenant',
      'BILLING_ADMISSION_PATIENT_MISMATCH',
    );
  }

  const startTs = admission.admitted_at || admission.created_at;
  const endTs = admission.discharged_at || null;
  const startDate = new Date(startTs).toISOString().slice(0, 10);
  const endDate = endTs ? new Date(endTs).toISOString().slice(0, 10) : null;
  const existingLines = await fetchExistingSourceLines(invId);
  const itemizerTenantId = requireTenantId(admission.tenant_id);

  const summary = {
    package: 0,
    pharmacy: 0,
    ward_indents: 0,
    ward_indents_updated: 0,
    lab: 0,
    consults: 0,
    theatre: 0,
    room_upgrade: 0,
    skipped_existing: 0,
  };

  const addLine = async ({
    description, category, unit_price, quantity = 1, notes,
    source_ref_type, source_ref_id, tpa_decision, tpa_non_payable_reason,
    sync_existing = false,
  }) => {
    const key = `${source_ref_type}:${source_ref_id ?? 'NULL'}`;
    const existing = existingLines.get(key);
    if (existing && !sync_existing) {
      summary.skipped_existing += 1;
      return null;
    }
    if (existing) {
      const desiredQuantity = Number(quantity) || 1;
      const desiredPrice = Number(unit_price);
      const desiredRate = Number(ITEMIZER_DEFAULT_GST);
      const desiredSubtotal = toFixed2(desiredQuantity * desiredPrice);
      const desiredNotes = notes || null;
      const unchanged = (
        existing.description === description
        && (existing.category || null) === (category || null)
        && Number(existing.quantity) === desiredQuantity
        && Number(existing.unit_price) === desiredPrice
        && Number(existing.gst_rate || 0) === desiredRate
        && Number(existing.line_subtotal) === desiredSubtotal
        && Number(existing.line_total) === desiredSubtotal
        && (existing.notes || null) === desiredNotes
      );
      if (unchanged) {
        summary.skipped_existing += 1;
        return null;
      }
      const updated = await setTenantTx(itemizerTenantId, async (tx) => {
        const invoice = await lockBillingInvoice(
          tx,
          invId,
          itemizerTenantId,
          'status, admission_id',
        );
        if (!invoice) throw AppError.notFound('Invoice not found');
        if (invoice.status !== 'DRAFT') {
          throw AppError.conflict(
            'Ward-indent charges can only be synchronized on a DRAFT invoice',
            'WARD_INDENT_BILLING_INVOICE_NOT_DRAFT',
          );
        }
        await assertAdmissionBillingOpen(invoice.admission_id, tx, {
          tenantId: itemizerTenantId,
          lock: true,
        });
        const rows = await tx.$queryRawUnsafe(
          `UPDATE billing_invoice_items
              SET description = $1,
                  category = $2,
                  quantity = $3::numeric,
                  unit_price = $4::numeric,
                  gst_rate = $5::numeric,
                  line_subtotal = $6::numeric,
                  cgst_amount = 0,
                  sgst_amount = 0,
                  igst_amount = 0,
                  line_total = $6::numeric,
                  notes = $7
            WHERE id = $8::int
              AND invoice_id = $9::int
              AND tenant_id = $10::uuid
              AND source_ref_type = $11
              AND source_ref_id = $12::bigint
              AND source_ref_active = TRUE
          RETURNING *`,
          description,
          category || null,
          desiredQuantity,
          desiredPrice,
          desiredRate,
          desiredSubtotal,
          desiredNotes,
          Number(existing.id),
          invId,
          itemizerTenantId,
          source_ref_type,
          normalizeSourceRefId(source_ref_id),
        );
        if (!rows[0]) {
          throw AppError.conflict(
            'Ward-indent billing line changed before it could be synchronized',
            'WARD_INDENT_BILLING_LINE_CHANGED',
          );
        }
        await recomputeInvoiceTotals(invId, tx, { emitTpaAlert: false });
        return normalizeBillingItemForResponse(rows[0]);
      });
      existingLines.set(key, updated);
      return { action: 'updated', row: updated };
    }
    const row = await addInvoiceItem(invId, {
      description,
      category,
      unit_price,
      quantity,
      gst_rate: ITEMIZER_DEFAULT_GST,
      notes,
      source_ref_type,
      source_ref_id,
      tenantId: itemizerTenantId,
    });
    existingLines.set(key, row);
    // Stamp the TPA decision on the newly-created line. addInvoiceItem
    // returns the row; we patch the four migration-213 columns in a
    // single UPDATE that the cashier can later override via the
    // TPA-desk surface.
    if (tpa_decision) {
      await prisma.$executeRawUnsafe(
        `UPDATE billing_invoice_items
            SET tpa_decision = $1,
                tpa_non_payable_reason = $2,
                tpa_decided_at = NOW(),
                tpa_decided_by = $3::uuid
          WHERE id = $4::int
            AND tenant_id = $5::uuid`,
        tpa_decision,
        tpa_non_payable_reason || null,
        decided_by ? String(decided_by) : null,
        Number(row.id),
        itemizerTenantId,
      );
    }
    return { action: 'created', row };
  };

  // 1. Package line (if admission is package-bundled).
  if (emit_package && admission.package_id) {
    const fixed = admission.package_estimated_cost_minor ?? admission.package_price_minor ?? null;
    if (fixed != null) {
      const price = Math.round(Number(fixed)) / 100; // paise → rupees
      const created = await addLine({
        description: `Package: ${admission.package_name || admission.package_code}`,
        unit_price: price,
        quantity: 1,
        notes: `Package ${admission.package_code || admission.package_id}`,
        source_ref_type: 'admission_package',
        source_ref_id: admission.id,
        tpa_decision: 'payable',
      });
      if (created?.action === 'created') summary.package += 1;
    }
  }

  // 2. Pharmacy orders dispensed during the stay.
  if (emit_pharmacy) {
    const orders = await prisma.$queryRawUnsafe(
      `SELECT pharmacy_order.id,pharmacy_order.order_number,
              pharmacy_order.medication,pharmacy_order.total_amount,
              COALESCE(pharmacy_order.dispensed_at,pharmacy_order.delivered_at) AS dispensed_at
         FROM pharmacy_orders pharmacy_order
         JOIN users patient
           ON patient.tenant_id=pharmacy_order.tenant_id
          AND patient.id=pharmacy_order.patient_id
          AND patient.uid=$1::uuid AND patient.role='PATIENT'
          AND patient.is_active=TRUE AND patient.status='active'
          AND patient.is_deleted=FALSE AND patient.merged_into_uid IS NULL
        WHERE pharmacy_order.tenant_id=$2::uuid
          AND pharmacy_order.funding_admission_id=$5::int
          AND (pharmacy_order.uid IS NULL OR pharmacy_order.uid=patient.uid)
          AND pharmacy_order.status IN ('DISPENSED','DELIVERED')
          AND COALESCE(pharmacy_order.dispensed_at,pharmacy_order.delivered_at)
              >= $3::timestamptz
          AND COALESCE(pharmacy_order.dispensed_at,pharmacy_order.delivered_at)
              <= COALESCE($4::timestamptz,NOW())
          AND EXISTS (
            SELECT 1 FROM pharmacy_stock_movements movement
             WHERE movement.tenant_id=pharmacy_order.tenant_id
               AND movement.metadata->>'order_id'=pharmacy_order.id::text
               AND movement.movement_kind='issue'
               AND movement.quantity_delta < 0
               AND movement.metadata->>'contract' IN (
                 'pharmacy_order_inventory_allocation_v1',
                 'pharmacy_dispense_substitution_v1'
               )
          )
        ORDER BY COALESCE(pharmacy_order.dispensed_at,pharmacy_order.delivered_at),
                 pharmacy_order.id`,
      String(admission.patient_uid), itemizerTenantId,
      startTs, endTs, Number(admission.id),
    );
    for (const o of orders) {
      const price = Number(o.total_amount ?? 0);
      if (price <= 0) continue; // no charge to bill
      const created = await addLine({
        description: `Pharmacy: ${(o.medication || o.order_number || '').slice(0, 200)}`,
        unit_price: price,
        notes: o.order_number || null,
        source_ref_type: 'pharmacy_order',
        source_ref_id: o.id,
        tpa_decision: 'pending',
      });
      if (created?.action === 'created') summary.pharmacy += 1;
    }
  }

  // 3. IPD ward pharmacy indents issued during the stay. These are the
  // inpatient counterpart to pharmacy_orders: once stores issue stock to
  // the ward, the patient/admission needs a traceable pharmacy charge.
  // Finding: 2026-05-23-swarm D58 / f9007a9c.
  if (emit_ward_indents) {
    const indents = await prisma.$queryRawUnsafe(
      `SELECT wi.id,
              wi.indent_number,
              wi.ward_name,
              COALESCE(wi.issued_at, wi.updated_at, wi.requested_at) AS billable_at,
              COALESCE(SUM(
                GREATEST(
                  COALESCE(wii.quantity_issued, wii.quantity_requested, 0)
                    - COALESCE(wii.quantity_returned, 0),
                  0
                )
                * COALESCE(wii.unit_price, pc.unit_price, pc.price, 0)
              ), 0)::numeric AS total_amount,
              STRING_AGG(
                CONCAT(
                  wii.item_name,
                  ' x ',
                  GREATEST(
                    COALESCE(wii.quantity_issued, wii.quantity_requested, 0)
                      - COALESCE(wii.quantity_returned, 0),
                    0
                  )::text
                ),
                ', ' ORDER BY wii.id
              ) AS item_summary
         FROM ward_indents wi
         JOIN ward_indent_items wii
           ON wii.tenant_id = wi.tenant_id
          AND wii.ward_indent_id = wi.id
         LEFT JOIN pharmacy_catalog pc
           ON pc.tenant_id = wii.tenant_id
          AND pc.id = wii.pharmacy_catalog_id
        WHERE wi.status IN (
          'issued', 'partially_received', 'received', 'return_pending',
          'reconciliation_required', 'reconciled', 'closed'
        )
          AND COALESCE(wi.issued_at, wi.updated_at, wi.requested_at) >= $2::timestamptz
          AND COALESCE(wi.issued_at, wi.updated_at, wi.requested_at) <= COALESCE($3::timestamptz, NOW())
          AND (
            wi.admission_id = $1::int
            OR (
              wi.admission_id IS NULL
              AND wi.patient_uid = $4::uuid
              AND ($5::uuid IS NULL OR wi.encounter_id = $5::uuid)
            )
          )
          AND wi.tenant_id = $6::uuid
        GROUP BY wi.id, wi.indent_number, wi.ward_name, billable_at
        ORDER BY billable_at, wi.id`,
      Number(admission.id),
      startTs, endTs,
      String(admission.patient_uid),
      admission.encounter_id ?? null,
      itemizerTenantId,
    );
    for (const wi of indents) {
      const price = Number(wi.total_amount ?? 0);
      if (!Number.isFinite(price) || price < 0) continue;
      const created = await addLine({
        description: `Pharmacy ward indent: ${wi.indent_number || wi.id}`,
        category: 'pharmacy',
        unit_price: price,
        quantity: 1,
        notes: [wi.ward_name, wi.item_summary].filter(Boolean).join(' - ').slice(0, 255) || null,
        source_ref_type: 'ward_indent',
        source_ref_id: wi.id,
        tpa_decision: 'pending',
        sync_existing: true,
      });
      if (created?.action === 'created') summary.ward_indents += 1;
      if (created?.action === 'updated') summary.ward_indents_updated += 1;
    }
  }

  // 4. Investigations completed during the stay.
  if (emit_lab) {
    const tests = await prisma.$queryRawUnsafe(
      `SELECT id, test_name, cost, completed_at
         FROM investigations
        WHERE patient_uid = $1::uuid
          AND status = 'COMPLETED'
          AND COALESCE(completed_at, requested_at) >= $2::timestamptz
          AND COALESCE(completed_at, requested_at) <= COALESCE($3::timestamptz, NOW())
        ORDER BY completed_at NULLS LAST, id`,
      String(admission.patient_uid),
      startTs, endTs,
    );
    for (const t of tests) {
      const price = Number(t.cost ?? 0);
      if (price <= 0) continue;
      const created = await addLine({
        description: `Lab: ${t.test_name}`,
        unit_price: price,
        notes: null,
        source_ref_type: 'lab_order',
        source_ref_id: t.id,
        tpa_decision: 'pending',
      });
      if (created?.action === 'created') summary.lab += 1;
    }
  }

  // 5. Discharge consults — pre-discharge speciality reviews requested
  //    during the stay. Most have no cost catalogue yet, so they're
  //    informational lines at unit_price=0 unless the operator
  //    overrides. The audit value is the source-ref trail.
  if (emit_consults) {
    const consults = await prisma.$queryRawUnsafe(
      `SELECT id, consult_type, completed_at
         FROM discharge_consults
        WHERE admission_id = $1::int
          AND completed_at IS NOT NULL
        ORDER BY completed_at`,
      Number(admission.id),
    );
    for (const c of consults) {
      const created = await addLine({
        description: `Discharge consult: ${c.consult_type}`,
        unit_price: 0,
        notes: 'Cost catalogue pending — line is audit-only',
        source_ref_type: 'discharge_consult',
        source_ref_id: c.id,
        tpa_decision: 'pending',
      });
      if (created?.action === 'created') summary.consults += 1;
    }
  }

  // 6. OT schedules (theatre cases) completed during the stay. Cost
  //    catalogue not yet seeded — the package line covers the
  //    surgical fee for package-bundled admissions; for non-package
  //    admissions the cashier still has to enter the theatre fee
  //    manually. The line carries the procedure_code so the future
  //    catalogue lookup is straightforward.
  if (emit_theatre) {
    const cases = await prisma.$queryRawUnsafe(
      `SELECT id, procedure_name, procedure_code, scheduled_date
         FROM ot_schedules
        WHERE patient_uid = $1::uuid
          AND status = 'completed'
          AND scheduled_date >= $2::date
          AND scheduled_date <= COALESCE($3::date, CURRENT_DATE)
        ORDER BY scheduled_date, id`,
      String(admission.patient_uid),
      startDate,
      endDate,
    );
    for (const cs of cases) {
      const created = await addLine({
        description: `Theatre case: ${cs.procedure_name}${cs.procedure_code ? ` (${cs.procedure_code})` : ''}`,
        unit_price: 0,
        notes: 'Cost catalogue pending — line is audit-only',
        source_ref_type: 'theatre_case',
        source_ref_id: cs.id,
        tpa_decision: 'pending',
      });
      if (created?.action === 'created') summary.theatre += 1;
    }
  }

  return {
    invoice_id: invId,
    admission_id: admission.id,
    package_id: admission.package_id ?? null,
    summary,
  };
}

const PHARMACY_TPA_PAYMENT_MODES = new Set(['insurance', 'corporate_tpa', 'tpa']);
const PHARMACY_PATIENT_PAYMENT_RAILS = Object.freeze([
  'CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET',
]);
const PHARMACY_TPA_DECISION_ROLES = new Set([
  'INSURANCE_COORDINATOR', 'CLAIMS_MANAGER',
  // Existing claim-update policy explicitly permits this operational fallback.
  'FINANCE_INCHARGE', 'ADMIN', 'SUPER_ADMIN',
]);
const PHARMACY_FUNDING_MATERIALIZE_ROLES = new Set([
  'PHARMACY_STAFF', 'PHARMACIST', 'PHARMACY_INCHARGE', 'DELIVERY_STAFF',
  'BILLING_INCHARGE', 'FINANCE_INCHARGE',
  'INSURANCE_COORDINATOR', 'CLAIMS_MANAGER', 'ADMIN', 'SUPER_ADMIN',
]);
const PHARMACY_FUNDING_FACILITY_GRANT_ROLES = new Set([
  'PHARMACY_STAFF', 'PHARMACIST', 'PHARMACY_INCHARGE', 'DELIVERY_STAFF',
]);
const PHARMACY_TPA_REASON_CODES = new Set([
  'room_upgrade', 'over_cap_pharmacy', 'over_cap_consumables', 'non_listed',
  'partial_approval', 'co_pay', 'sub_limit', 'pre_existing_waiting', 'other',
]);
const PHARMACY_RECONCILIATION_ROLES = new Set(['FINANCE_INCHARGE', 'SUPER_ADMIN']);
const PHARMACY_RECONCILIATION_PATHS = new Set([
  'SAFE_DEACTIVATE_DUPLICATES', 'KEEP_CURRENT_AUTHORITY', 'CANCEL_ORDER', 'REBILL',
]);
const ACTIVE_TASK_STATUSES = "'open','in_progress','blocked','overdue'";
const PHARMACY_FUNDING_TASK_CONTRACT = 'pharmacy_funding_task_v1';
const PHARMACY_SUBSTITUTION_FUNDING_TASK_CONTRACT =
  'pharmacy_substitution_funding_task_v1';
const PHARMACY_SUBSTITUTION_FUNDING_APPROVAL_CONTRACT =
  'pharmacy_substitution_funding_reauthorisation_v1';
const PHARMACY_FUNDING_TASK_RESOURCE_TYPES = Object.freeze([
  'pharmacy_tpa_line_decision',
  'pharmacy_posted_payment',
  'pharmacy_patient_advance',
]);

function pharmacyFundingHash(eventType, values) {
  return createHash('sha256')
    .update(JSON.stringify({ event_type: eventType, ...values }))
    .digest('hex');
}

async function currentPharmacyFundingAuthorityEventTx(tx, authority) {
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       'vh:pharmacy_funding_event_chain:' || $1::uuid::text || ':'
         || $2::int::text || ':' || $3::int::text || ':' || $4,
       753
     ))::text AS lock_acquired`,
    authority.tenantId,
    authority.orderId,
    authority.orderVersion,
    authority.orderItemsSha256,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT event.*
       FROM pharmacy_funding_decision_events event
      WHERE event.tenant_id=$1::uuid AND event.pharmacy_order_id=$2::int
        AND event.source_authority_version=$3::int
        AND event.source_authority_sha256=$4
        AND event.authority_generation IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pharmacy_funding_decision_events successor
           WHERE successor.tenant_id=event.tenant_id
             AND successor.supersedes_event_id=event.id
        )
      ORDER BY event.authority_generation DESC,event.id DESC
      LIMIT 2
      FOR UPDATE OF event`,
    authority.tenantId,
    authority.orderId,
    authority.orderVersion,
    authority.orderItemsSha256,
  );
  if (rows.length > 1) {
    throw AppError.conflict(
      'The pharmacy funding event chain has more than one current authority',
      'PHARMACY_FUNDING_CURRENT_EVENT_AMBIGUOUS',
    );
  }
  return rows[0] || null;
}

export async function appendPharmacyFundingAuthorityStateTx(tx, {
  authority,
  eventType,
  admissionId,
  invoiceId,
  invoiceItemId,
  tpaClaimId = null,
  billingPaymentId = null,
  taskId = null,
  amount,
  evidence,
}) {
  if (!['FUNDING_RESOLVED', 'AUTHORITY_INVALIDATED'].includes(eventType)) {
    throw AppError.internal(
      'Unsupported pharmacy funding authority state transition',
      'PHARMACY_FUNDING_EVENT_TYPE_INVALID',
    );
  }
  let current = await currentPharmacyFundingAuthorityEventTx(tx, authority);
  const authorityFingerprintSha256 = pharmacyFundingHash(eventType, evidence);
  if (current?.event_type === eventType
      && current.evidence?.authority_fingerprint_sha256 === authorityFingerprintSha256) {
    return { ...current, replayed: true };
  }
  if (eventType === 'FUNDING_RESOLVED' && current?.event_type === 'FUNDING_RESOLVED') {
    await appendPharmacyFundingAuthorityStateTx(tx, {
      authority,
      eventType: 'AUTHORITY_INVALIDATED',
      admissionId: current.admission_id,
      invoiceId: current.invoice_id,
      invoiceItemId: current.invoice_item_id,
      tpaClaimId: current.tpa_claim_id,
      billingPaymentId: current.billing_payment_id,
      taskId: current.task_id,
      amount: current.amount,
      evidence: {
        contract: 'pharmacy_funding_authority_state_v1',
        pharmacy_order_id: authority.orderId,
        invalidation_reason: 'funding_evidence_replaced',
        prior_funding_event_id: Number(current.id),
      },
    });
    current = await currentPharmacyFundingAuthorityEventTx(tx, authority);
  }
  const authorityGeneration = Number(current?.authority_generation || 0) + 1;
  const supersedesEventId = current == null ? null : Number(current.id);
  const durableEvidence = {
    ...evidence,
    authority_generation: authorityGeneration,
    supersedes_event_id: supersedesEventId,
    authority_fingerprint_sha256: authorityFingerprintSha256,
  };
  const command = pharmacyFundingHash(eventType, {
    authority_fingerprint_sha256: authorityFingerprintSha256,
    authority_generation: authorityGeneration,
    supersedes_event_id: supersedesEventId,
  });
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_funding_decision_events
      (tenant_id,facility_id,pharmacy_order_id,admission_id,event_type,
       source_authority_version,source_authority_sha256,invoice_id,invoice_item_id,
       tpa_claim_id,billing_payment_id,task_id,amount,command_key_sha256,evidence,
       recorded_by,authority_generation,supersedes_event_id)
     VALUES ($1::uuid,$2::int,$3::int,$4::int,$5,$6::int,$7,$8::int,$9::int,
             $10::int,$11::int,$12::int,$13::numeric,$14,$15::jsonb,$16::uuid,
             $17::bigint,$18::bigint)
     RETURNING *`,
    authority.tenantId,
    authority.facilityId,
    authority.orderId,
    admissionId == null ? null : Number(admissionId),
    eventType,
    authority.orderVersion,
    authority.orderItemsSha256,
    Number(invoiceId),
    Number(invoiceItemId),
    tpaClaimId == null ? null : Number(tpaClaimId),
    billingPaymentId == null ? null : Number(billingPaymentId),
    taskId == null ? null : Number(taskId),
    Number(amount || 0),
    command,
    JSON.stringify(durableEvidence),
    authority.actorUid,
    authorityGeneration,
    supersedesEventId,
  );
  return { ...rows[0], replayed: false };
}

async function invalidateCurrentPharmacyFundingAuthorityStateTx(tx, {
  authority,
  reason,
  actorRole,
  billingPaymentId = null,
  commandKeySha256 = null,
}) {
  const current = await currentPharmacyFundingAuthorityEventTx(tx, authority);
  if (current == null || current.event_type !== 'FUNDING_RESOLVED') return current;
  return appendPharmacyFundingAuthorityStateTx(tx, {
    authority,
    eventType: 'AUTHORITY_INVALIDATED',
    admissionId: current.admission_id,
    invoiceId: current.invoice_id,
    invoiceItemId: current.invoice_item_id,
    tpaClaimId: current.tpa_claim_id,
    billingPaymentId,
    taskId: current.task_id,
    amount: current.amount,
    evidence: {
      contract: 'pharmacy_funding_authority_state_v1',
      pharmacy_order_id: authority.orderId,
      invalidation_reason: String(reason),
      invalidation_command_key_sha256: commandKeySha256,
      actor_role: actorRole,
      prior_funding_event_id: Number(current.id),
    },
  });
}

function normalizePharmacyFundingAuthority(args) {
  const authority = {
    tenantId: requireTenantId(args.tenantId),
    facilityId: Number(args.facilityId),
    orderId: Number(args.orderId),
    patientId: args.patientId == null ? null : Number(args.patientId),
    patientUid: args.patientUid == null ? null : String(args.patientUid),
    authoritativeAmount: Number(args.authoritativeAmount),
    orderVersion: Number(args.orderVersion),
    orderItemsSha256: String(args.orderItemsSha256 || '').trim().toLowerCase(),
    paymentMode: String(args.paymentMode || '').trim().toLowerCase(),
    tpaClaimId: args.tpaClaimId == null ? null : Number(args.tpaClaimId),
    tpaReference: String(args.tpaReference || '').trim() || null,
    paymentId: args.paymentId == null ? null : Number(args.paymentId),
    actorUid: String(args.actorUid || '').trim(),
    actorRole: String(args.actorRole || '').trim().toUpperCase() || null,
  };
  if (!Number.isInteger(authority.facilityId) || authority.facilityId <= 0
      || !Number.isInteger(authority.orderId) || authority.orderId <= 0
      || !Number.isInteger(authority.orderVersion) || authority.orderVersion <= 0
      || !Number.isFinite(authority.authoritativeAmount) || authority.authoritativeAmount < 0
      || !SHA256_PATTERN.test(authority.orderItemsSha256)
      || (!authority.patientId && !authority.patientUid)
      || !authority.actorUid) {
    throw AppError.badRequest(
      'Exact order, patient, facility, amount, version, item hash, and actor authority are required',
      'PHARMACY_FUNDING_AUTHORITY_REQUIRED',
    );
  }
  return authority;
}

async function assertPharmacyFundingActorTx(tx, authority, permittedRoles = null) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, UPPER(role) AS role
       FROM users
      WHERE tenant_id=$1::uuid AND uid=$2::uuid
        AND is_active=TRUE AND status='active' AND is_deleted=FALSE
        AND merged_into_uid IS NULL
      FOR KEY SHARE`,
    authority.tenantId,
    authority.actorUid,
  );
  if (!rows.length
      || (authority.actorRole != null && authority.actorRole !== rows[0].role)
      || (permittedRoles && !permittedRoles.has(rows[0].role))) {
    throw AppError.forbidden(
      'The funding actor is not an active permitted tenant identity',
      'PHARMACY_FUNDING_ACTOR_FORBIDDEN',
    );
  }
  return rows[0];
}

function pharmacyFundingDeepLink({ orderId, invoiceItemId, tpaClaimId }) {
  const query = new URLSearchParams({
    pharmacy_order_id: String(orderId),
    invoice_item_id: String(invoiceItemId),
  });
  if (tpaClaimId) query.set('tpa_claim_id', String(tpaClaimId));
  return `/billing-desk?${query.toString()}`;
}

async function assertNoSubstitutionFundingAuthorityTx(tx, {
  tenantId,
  orderId,
  patientUid = null,
  lock = true,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = Number(orderId);
  if (lock) {
    await lockCounterFundingSubstitutionAuthorityTx(tx, {
      tenantId: tid,
      orderId: exactOrderId,
      patientUid,
    });
    return;
  }
  const commandRows = await tx.$queryRawUnsafe(
    `SELECT id::text AS id,status,task_id,approval_receipt_id
       FROM pharmacy_funding_commands
      WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
        AND command_type='SUBSTITUTION_FUNDING_APPROVAL'
        AND status IN ('IN_PROGRESS','COMPLETE')
      ORDER BY id
      ${lock ? 'FOR UPDATE' : ''}`,
    tid,
    exactOrderId,
  );
  const approvalRows = await tx.$queryRawUnsafe(
    `SELECT id,status,task_id,metadata
       FROM approvals
      WHERE tenant_id=$1::uuid
        AND approval_kind='pharmacy_substitution_funding_reauthorisation'
        AND metadata->>'contract'=$3
        AND metadata->>'pharmacy_order_id'=$2
        AND status IN ('pending','approved')
      ORDER BY id
      ${lock ? 'FOR UPDATE' : ''}`,
    tid,
    String(exactOrderId),
    PHARMACY_SUBSTITUTION_FUNDING_APPROVAL_CONTRACT,
  );
  const taskRows = await tx.$queryRawUnsafe(
    `SELECT id,related_resource_type,status,metadata
       FROM tasks
      WHERE tenant_id=$1::uuid AND related_resource_id=$2
        AND related_resource_type=ANY($3::text[])
        AND status IN (${ACTIVE_TASK_STATUSES})
        AND metadata->>'contract'=$4
      ORDER BY id
      ${lock ? 'FOR UPDATE' : ''}`,
    tid,
    String(exactOrderId),
    PHARMACY_FUNDING_TASK_RESOURCE_TYPES,
    PHARMACY_SUBSTITUTION_FUNDING_TASK_CONTRACT,
  );
  if (!taskRows.length && !approvalRows.length && !commandRows.length) return;
  throw AppError.conflict(
    'A governed substitution funding workflow already owns this pharmacy order',
    'PHARMACY_SUBSTITUTION_FUNDING_AUTHORITY_CONFLICT',
    {
      pharmacy_order_id: exactOrderId,
      task_ids: taskRows.map((row) => Number(row.id)),
      approval_ids: approvalRows.map((row) => Number(row.id)),
      command_receipt_ids: commandRows.map((row) => String(row.id)),
      next_action: 'complete_or_govern_release_of_substitution_funding_authority',
    },
  );
}

async function upsertPharmacyFundingTaskTx(tx, {
  authority,
  invoiceId,
  invoiceItemId,
  admissionId,
  taskType,
  stage,
  assignedRole,
  tpaClaimId = null,
  amountOutstanding,
}) {
  const resourceType = taskType === 'tpa_line_decision'
    ? 'pharmacy_tpa_line_decision'
    : 'pharmacy_posted_payment';
  const title = taskType === 'tpa_line_decision'
    ? `Review exact TPA pharmacy line for order ${authority.orderId}`
    : `Post pharmacy payment for order ${authority.orderId}`;
  const actionUrl = pharmacyFundingDeepLink({
    orderId: authority.orderId,
    invoiceItemId,
    tpaClaimId,
  });
  const metadata = {
    contract: 'pharmacy_funding_task_v1',
    task_type: taskType,
    stage,
    pharmacy_order_id: authority.orderId,
    admission_id: admissionId == null ? null : Number(admissionId),
    invoice_id: Number(invoiceId),
    invoice_item_id: Number(invoiceItemId),
    tpa_claim_id: tpaClaimId == null ? null : Number(tpaClaimId),
    order_version: authority.orderVersion,
    order_items_sha256: authority.orderItemsSha256,
    authoritative_amount: authority.authoritativeAmount,
    amount_outstanding: Number(amountOutstanding),
    action_url: actionUrl,
    permitted_roles: taskType === 'tpa_line_decision'
      ? [...PHARMACY_TPA_DECISION_ROLES]
      : ['FINANCE_INCHARGE', 'BILLING_INCHARGE', 'ADMIN', 'SUPER_ADMIN'],
  };
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO tasks
      (tenant_id,task_kind,title,description,patient_uid,related_resource_type,
       related_resource_id,priority,status,assigned_to_role,created_by,metadata,
       sla_completion_semantics)
     VALUES ($1::uuid,'review',$2,$3,$4::uuid,$5,$6,'high','open',$7,$8::uuid,
             $9::jsonb,'none')
     ON CONFLICT (tenant_id, related_resource_type, related_resource_id)
       WHERE status IN (${ACTIVE_TASK_STATUSES})
         AND related_resource_type IS NOT NULL AND related_resource_id IS NOT NULL
     DO UPDATE SET assigned_to_role=EXCLUDED.assigned_to_role,
                   title=EXCLUDED.title, description=EXCLUDED.description,
                   metadata=EXCLUDED.metadata, updated_at=NOW()
            WHERE tasks.metadata->>'contract'=$10
              AND tasks.metadata->>'task_type'=$11
     RETURNING id,status,assigned_to_role,related_resource_type,related_resource_id,
               metadata,created_at,updated_at`,
    authority.tenantId,
    title,
    `Resolve ${stage.replaceAll('_', ' ')} before stock issue. The task is bound to the exact order version and billing line.`,
    authority.patientUid,
    resourceType,
    String(authority.orderId),
    assignedRole,
    authority.actorUid,
    JSON.stringify(metadata),
    PHARMACY_FUNDING_TASK_CONTRACT,
    taskType,
  );
  if (!rows.length) {
    throw AppError.conflict(
      'An active task with a different funding contract already owns this order',
      'PHARMACY_FUNDING_TASK_CONTRACT_CONFLICT',
    );
  }
  return rows[0];
}

async function completePharmacyFundingTaskTx(tx, {
  tenantId,
  taskType,
  orderId,
  evidence,
  taskId = null,
}) {
  const resourceType = taskType === 'tpa_line_decision'
    ? 'pharmacy_tpa_line_decision'
    : 'pharmacy_posted_payment';
  const permittedStages = taskType === 'tpa_line_decision'
    ? ['claim_selection', 'claim_approval', 'line_decision']
    : ['payment_posting', 'patient_responsibility_payment', 'payment_reversal_recovery'];
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET status='completed', completed_at=NOW(), updated_at=NOW(),
            metadata=metadata || $4::jsonb
      WHERE tenant_id=$1::uuid AND related_resource_type=$2
        AND related_resource_id=$3 AND status IN (${ACTIVE_TASK_STATUSES})
        AND ($5::int IS NULL OR id=$5::int)
        AND metadata->>'contract'=$6 AND metadata->>'task_type'=$7
        AND (metadata->>'invoice_id')::int=$8::int
        AND (metadata->>'invoice_item_id')::int=$9::int
        AND (metadata->>'tpa_claim_id')::int IS NOT DISTINCT FROM $10::int
        AND (metadata->>'order_version')::int=$11::int
        AND metadata->>'order_items_sha256'=$12
        AND metadata->>'stage'=ANY($13::text[])
      RETURNING id,status,assigned_to_role,metadata,completed_at`,
    requireTenantId(tenantId),
    resourceType,
    String(orderId),
    JSON.stringify({ domain_evidence: evidence }),
    taskId == null ? null : Number(taskId),
    PHARMACY_FUNDING_TASK_CONTRACT,
    taskType,
    Number(evidence.invoice_id),
    Number(evidence.invoice_item_id),
    evidence.tpa_claim_id == null ? null : Number(evidence.tpa_claim_id),
    Number(evidence.order_version),
    String(evidence.order_items_sha256),
    permittedStages,
  );
  return rows[0] || null;
}

async function resolveExactPharmacyClaimTx(tx, authority, admissionId, { lock = true } = {}) {
  if (!PHARMACY_TPA_PAYMENT_MODES.has(authority.paymentMode)) return null;
  const params = [authority.tenantId, Number(admissionId), authority.patientUid];
  const predicates = [
    'claim.tenant_id=$1::uuid',
    'claim.admission_id=$2::int',
    'claim.patient_uid=$3::uuid',
  ];
  if (authority.tpaClaimId) {
    params.push(authority.tpaClaimId);
    predicates.push(`claim.id=$${params.length}::int`);
  } else if (authority.tpaReference) {
    params.push(authority.tpaReference);
    predicates.push(`(claim.claim_number=$${params.length} OR claim.tpa_reference_id=$${params.length})`);
  } else {
    predicates.push("claim.status IN ('approved','partially_approved','paid')");
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT claim.id,claim.claim_number,claim.tpa_reference_id,claim.status,
            claim.approved_amount,claim.invoice_id,claim.preauth_id
       FROM tpa_claims claim
      WHERE ${predicates.join(' AND ')}
      ORDER BY claim.updated_at DESC,claim.id DESC
      ${lock ? 'FOR UPDATE' : ''}`,
    ...params,
  );
  if (rows.length > 1) {
    throw AppError.conflict(
      'More than one claim matches the supplied pharmacy funding authority',
      'PHARMACY_TPA_CLAIM_AMBIGUOUS',
      { candidate_claim_ids: rows.map((row) => Number(row.id)) },
    );
  }
  if (!rows.length) return null;
  if (authority.tpaReference
      && authority.tpaClaimId
      && ![rows[0].claim_number, rows[0].tpa_reference_id].includes(authority.tpaReference)) {
    throw AppError.conflict(
      'The claim id and TPA reference identify different authority',
      'PHARMACY_TPA_CLAIM_IDENTITY_MISMATCH',
    );
  }
  return rows[0];
}

async function lockPharmacyFundingInvoicesTx(tx, { tenantId, invoiceIds }) {
  const ids = [...new Set(invoiceIds.map(Number))].sort((left, right) => left - right);
  if (!ids.length) return [];
  return tx.$queryRawUnsafe(
    `SELECT id,status,patient_uid,admission_id,tenant_id,subtotal,cgst_amount,
            sgst_amount,igst_amount,total_amount,amount_paid,amount_due
       FROM billing_invoices
      WHERE tenant_id=$1::uuid AND id=ANY($2::int[])
      ORDER BY id
      FOR UPDATE`,
    requireTenantId(tenantId),
    ids,
  );
}

async function lockPharmacyFundingInvoiceItemsTx(tx, { tenantId, invoiceItemIds }) {
  const ids = [...new Set(invoiceItemIds.map(Number))].sort((left, right) => left - right);
  if (!ids.length) return [];
  return tx.$queryRawUnsafe(
    `SELECT id,invoice_id,description,category,quantity,unit_price,gst_rate,
            line_subtotal,cgst_amount,sgst_amount,igst_amount,line_total,notes,
            source_ref_type,source_ref_id,source_ref_active,tpa_decision,
            tpa_non_payable_reason,tpa_decided_at,tpa_decided_by,
            source_authority_version,source_authority_sha256
       FROM billing_invoice_items
      WHERE tenant_id=$1::uuid AND id=ANY($2::int[])
      ORDER BY id
      FOR UPDATE`,
    requireTenantId(tenantId),
    ids,
  );
}

async function lockPharmacyFundingInvoiceChildrenTx(tx, { tenantId, invoiceIds }) {
  const tid = requireTenantId(tenantId);
  const ids = [...new Set(invoiceIds.map(Number))].sort((left, right) => left - right);
  if (!ids.length) return;
  await tx.$queryRawUnsafe(
    `SELECT id
       FROM billing_payments
      WHERE tenant_id=$1::uuid AND invoice_id=ANY($2::int[])
      ORDER BY id
      FOR UPDATE`,
    tid,
    ids,
  );
  await tx.$queryRawUnsafe(
    `SELECT id
       FROM billing_refunds
      WHERE tenant_id=$1::uuid AND invoice_id=ANY($2::int[])
      ORDER BY id
      FOR UPDATE`,
    tid,
    ids,
  );
  await tx.$queryRawUnsafe(
    `SELECT id
       FROM billing_advance_settlements
      WHERE tenant_id=$1::uuid AND invoice_id=ANY($2::int[])
      ORDER BY id
      FOR UPDATE`,
    tid,
    ids,
  );
}

function exactLockedPharmacyFundingLines({ discoveredLines, invoices, items }) {
  const invoiceById = new Map(invoices.map((invoice) => [Number(invoice.id), invoice]));
  const itemById = new Map(items.map((item) => [Number(item.id), item]));
  const exactInvoiceIds = new Set(discoveredLines.map((line) => Number(line.invoice_id)));
  if (invoiceById.size !== exactInvoiceIds.size || itemById.size !== discoveredLines.length) {
    return null;
  }
  const lines = [];
  for (const discovered of discoveredLines) {
    const item = itemById.get(Number(discovered.id));
    const invoice = invoiceById.get(Number(discovered.invoice_id));
    if (!item || !invoice || Number(item.invoice_id) !== Number(invoice.id)) return null;
    lines.push({
      ...item,
      invoice_status: invoice.status,
      patient_uid: invoice.patient_uid,
      admission_id: invoice.admission_id,
      invoice_tenant_id: invoice.tenant_id,
      invoice_subtotal: invoice.subtotal,
      invoice_cgst_amount: invoice.cgst_amount,
      invoice_sgst_amount: invoice.sgst_amount,
      invoice_igst_amount: invoice.igst_amount,
      invoice_total_amount: invoice.total_amount,
      invoice_amount_paid: invoice.amount_paid,
      invoice_amount_due: invoice.amount_due,
    });
  }
  return lines;
}

async function loadPharmacyPaymentAllocationsTx(tx, {
  tenantId,
  invoiceId,
  invoiceItemId,
  orderId,
  orderVersion,
  orderItemsSha256,
  patientUid,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT allocation.id AS allocation_id,
            (allocation.allocated_amount
              - COALESCE(SUM(reversal.reversed_amount),0))::numeric AS allocated_amount,
            payment.id AS payment_id,payment.mode,payment.reference,payment.collected_at
       FROM pharmacy_payment_allocations allocation
       JOIN billing_payments payment
         ON payment.tenant_id=allocation.tenant_id
        AND payment.id=allocation.billing_payment_id
        AND payment.invoice_id=allocation.invoice_id
        AND payment.patient_uid=$7::uuid
        AND payment.reversed=FALSE
       LEFT JOIN pharmacy_payment_allocation_reversals reversal
         ON reversal.tenant_id=allocation.tenant_id
        AND reversal.allocation_id=allocation.id
      WHERE allocation.tenant_id=$1::uuid AND allocation.invoice_id=$2::int
        AND allocation.invoice_item_id=$3::int
        AND allocation.pharmacy_order_id=$4::int
        AND allocation.source_authority_version=$5::int
        AND allocation.source_authority_sha256=$6
      GROUP BY allocation.id,allocation.allocated_amount,payment.id,payment.mode,
               payment.reference,payment.collected_at
      HAVING allocation.allocated_amount
             - COALESCE(SUM(reversal.reversed_amount),0) > 0.001
      ORDER BY allocation.id`,
    requireTenantId(tenantId),
    Number(invoiceId),
    Number(invoiceItemId),
    Number(orderId),
    Number(orderVersion),
    String(orderItemsSha256),
    String(patientUid),
  );
  return {
    amount: toFixed2(rows.reduce((sum, row) => sum + Number(row.allocated_amount || 0), 0)),
    rows,
  };
}

export async function reversePharmacyPaymentAllocationTx(tx, {
  tenantId,
  allocationId,
  pharmacyOrderId,
  invoiceId,
  invoiceItemId,
  billingPaymentId,
  orderVersion,
  orderItemsSha256,
  reversedAmount,
  actorUid,
  reason,
  commandKeySha256,
  storedPaymentPatientUid = null,
  fundingPaymentPatientUid = null,
}) {
  const tid = requireTenantId(tenantId);
  const command = String(commandKeySha256 || '').trim().toLowerCase();
  const amount = toFixed2(Number(reversedAmount));
  const reversalReason = String(reason || '').trim().slice(0, 255);
  if (!Number.isInteger(Number(allocationId)) || Number(allocationId) <= 0
      || !Number.isInteger(Number(pharmacyOrderId)) || Number(pharmacyOrderId) <= 0
      || !Number.isInteger(Number(invoiceId)) || Number(invoiceId) <= 0
      || !Number.isInteger(Number(invoiceItemId)) || Number(invoiceItemId) <= 0
      || !Number.isInteger(Number(billingPaymentId)) || Number(billingPaymentId) <= 0
      || !Number.isInteger(Number(orderVersion)) || Number(orderVersion) <= 0
      || !SHA256_PATTERN.test(String(orderItemsSha256 || ''))
      || !Number.isFinite(amount) || amount <= 0
      || !SHA256_PATTERN.test(command) || !String(actorUid || '').trim()
      || !reversalReason) {
    throw AppError.badRequest(
      'An exact allocation target, positive amount, actor, reason, and command are required',
      'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_INVALID',
    );
  }
  const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId: tid,
    orderId: Number(pharmacyOrderId),
  });
  await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
  const exactPaymentPatientUid = storedPaymentPatientUid == null
    ? patientUid
    : String(storedPaymentPatientUid).trim().toLowerCase();
  if (!UUID_PATTERN.test(exactPaymentPatientUid)) {
    throw AppError.conflict(
      'The allocation reversal payment patient identity is invalid',
      'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_TARGET_MISMATCH',
    );
  }
  if (storedPaymentPatientUid != null) {
    const exactFundingPaymentPatientUid = String(
      fundingPaymentPatientUid || '',
    ).trim().toLowerCase();
    if (!UUID_PATTERN.test(exactFundingPaymentPatientUid)
        || exactFundingPaymentPatientUid !== patientUid) {
      throw AppError.conflict(
        'The allocation payment and pharmacy order no longer share funding authority',
        'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_TARGET_MISMATCH',
      );
    }
  }
  const orderRows = await tx.$queryRawUnsafe(
    `SELECT id,status FROM pharmacy_orders
      WHERE tenant_id=$1::uuid AND id=$2::int
      FOR UPDATE`,
    tid, Number(pharmacyOrderId),
  );
  if (!orderRows.length) throw AppError.notFound('Pharmacy order not found');
  const permittedRoles = new Set([
    'FINANCE_INCHARGE', 'BILLING_INCHARGE', 'ADMIN', 'SUPER_ADMIN',
  ]);
  if (['CANCELLED', 'UNAVAILABLE', 'REJECTED'].includes(String(orderRows[0].status).toUpperCase())
      && reversalReason.startsWith('terminal_order_')) {
    permittedRoles.add('PHARMACY_INCHARGE');
    permittedRoles.add('PHARMACIST');
    permittedRoles.add('PHARMACY_STAFF');
    permittedRoles.add('INSURANCE_COORDINATOR');
    permittedRoles.add('CLAIMS_MANAGER');
  }
  const actor = await assertPharmacyFundingActorTx(tx, {
    tenantId: tid,
    actorUid: String(actorUid),
  }, permittedRoles);
  const allocationRows = await tx.$queryRawUnsafe(
    `SELECT allocation.*
       FROM pharmacy_payment_allocations allocation
       JOIN billing_payments payment
         ON payment.tenant_id=allocation.tenant_id
        AND payment.id=allocation.billing_payment_id
        AND payment.invoice_id=allocation.invoice_id
        AND payment.patient_uid=$9::uuid
      WHERE allocation.tenant_id=$1::uuid AND allocation.id=$2::bigint
        AND allocation.pharmacy_order_id=$3::int AND allocation.invoice_id=$4::int
        AND allocation.invoice_item_id=$5::int AND allocation.billing_payment_id=$6::int
        AND allocation.source_authority_version=$7::int
        AND allocation.source_authority_sha256=$8
      FOR UPDATE OF allocation`,
    tid, Number(allocationId), Number(pharmacyOrderId), Number(invoiceId),
    Number(invoiceItemId), Number(billingPaymentId), Number(orderVersion),
    String(orderItemsSha256), exactPaymentPatientUid,
  );
  if (!allocationRows.length) {
    throw AppError.conflict(
      'The allocation reversal target does not match the exact payment/order/line authority',
      'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_TARGET_MISMATCH',
    );
  }
  const existingCommandRows = await tx.$queryRawUnsafe(
    `SELECT * FROM pharmacy_payment_allocation_reversals
      WHERE tenant_id=$1::uuid AND reversal_command_sha256=$2
      FOR KEY SHARE`,
    tid, command,
  );
  if (existingCommandRows.length) {
    const existing = existingCommandRows[0];
    const matches = Number(existing.allocation_id) === Number(allocationId)
      && Number(existing.pharmacy_order_id) === Number(pharmacyOrderId)
      && Number(existing.invoice_id) === Number(invoiceId)
      && Number(existing.invoice_item_id) === Number(invoiceItemId)
      && Number(existing.billing_payment_id) === Number(billingPaymentId)
      && Number(existing.source_authority_version) === Number(orderVersion)
      && existing.source_authority_sha256 === String(orderItemsSha256)
      && Math.abs(Number(existing.reversed_amount) - amount) <= 0.001
      && existing.reason === reversalReason
      && String(existing.reversed_by) === String(actor.uid);
    if (!matches) {
      throw AppError.unprocessable(
        'The allocation reversal command is already bound to different authority',
        'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_COMMAND_MISMATCH',
      );
    }
    return { ...existing, replayed: true };
  }
  const totals = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(reversed_amount),0)::numeric AS reversed_amount
       FROM pharmacy_payment_allocation_reversals
      WHERE tenant_id=$1::uuid AND allocation_id=$2::bigint`,
    tid, Number(allocationId),
  );
  const remaining = toFixed2(
    Number(allocationRows[0].allocated_amount) - Number(totals[0]?.reversed_amount || 0),
  );
  if (amount > remaining + 0.001) {
    throw AppError.conflict(
      'The requested reversal exceeds the allocation balance',
      'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_EXCEEDS_BALANCE',
      { remaining_amount: remaining },
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO pharmacy_payment_allocation_reversals
      (tenant_id,allocation_id,pharmacy_order_id,invoice_id,invoice_item_id,
       billing_payment_id,source_authority_version,source_authority_sha256,
       reversed_amount,reversal_command_sha256,reason,reversed_by,evidence)
     VALUES ($1::uuid,$2::bigint,$3::int,$4::int,$5::int,$6::int,$7::int,$8,
             $9::numeric,$10,$11,$12::uuid,$13::jsonb)
     ON CONFLICT (tenant_id,reversal_command_sha256) DO NOTHING
     RETURNING *`,
    tid, Number(allocationId), Number(pharmacyOrderId), Number(invoiceId),
    Number(invoiceItemId), Number(billingPaymentId), Number(orderVersion),
    String(orderItemsSha256), amount, command, reversalReason, actor.uid,
    JSON.stringify({
      contract: 'pharmacy_payment_allocation_reversal_v1',
      prior_unreversed_amount: remaining,
      resulting_unreversed_amount: toFixed2(remaining - amount),
    }),
  );
  if (!rows.length) {
    const racedRows = await tx.$queryRawUnsafe(
      `SELECT * FROM pharmacy_payment_allocation_reversals
        WHERE tenant_id=$1::uuid AND reversal_command_sha256=$2
        FOR KEY SHARE`,
      tid, command,
    );
    const raced = racedRows[0];
    if (!raced
        || Number(raced.allocation_id) !== Number(allocationId)
        || Number(raced.pharmacy_order_id) !== Number(pharmacyOrderId)
        || Number(raced.invoice_id) !== Number(invoiceId)
        || Number(raced.invoice_item_id) !== Number(invoiceItemId)
        || Number(raced.billing_payment_id) !== Number(billingPaymentId)
        || Number(raced.source_authority_version) !== Number(orderVersion)
        || raced.source_authority_sha256 !== String(orderItemsSha256)
        || Math.abs(Number(raced.reversed_amount) - amount) > 0.001
        || raced.reason !== reversalReason
        || String(raced.reversed_by) !== String(actor.uid)) {
      throw AppError.unprocessable(
        'The allocation reversal command is already bound to different authority',
        'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_COMMAND_MISMATCH',
      );
    }
    return { ...raced, replayed: true };
  }
  return { ...rows[0], replayed: false };
}

// Reads (and locks) the physical stock evidence for an order. Split out from
// the assertion below so a caller that must express the same precondition as a
// GOVERNED OUTCOME rather than a throw — the duplicate-line reconciliation
// CANCEL_ORDER path, where a throw would roll back the case status, the BLOCKED
// evidence row, and the task stamp along with it — can read the identical
// locked evidence BEFORE it mutates anything. Both callers therefore fail
// closed on exactly the same rows, under exactly the same locks.
async function lockPharmacyStockMovementEvidenceTx(tx, { tenantId, orderId }) {
  const stockRows = await tx.$queryRawUnsafe(
    `SELECT id FROM pharmacy_stock_movements
      WHERE tenant_id=$1::uuid AND metadata->>'order_id'=$2
      ORDER BY id FOR UPDATE`,
    tenantId,
    String(orderId),
  );
  return stockRows.map((row) => Number(row.id));
}

// Terminal funding compensation is forbidden once physical stock evidence
// exists for the order: the money plane may not be unwound behind a movement
// that already left the shelf. The guard lives here — not only in
// compensateTerminalPharmacyFundingAuthorityTx — so that every entry point that
// invalidates terminal funding authority (funding materialize, TPA decision,
// reconciliation, and the compensation command itself) fails closed on the same
// evidence with the same error code.
async function assertNoPharmacyStockMovementEvidenceTx(tx, { tenantId, orderId }) {
  const movementIds = await lockPharmacyStockMovementEvidenceTx(tx, { tenantId, orderId });
  if (movementIds.length) {
    throw AppError.conflict(
      'Terminal funding compensation is forbidden after stock movement evidence exists',
      'PHARMACY_TERMINAL_FUNDING_STOCK_EXISTS',
    );
  }
}

async function lockNetLivePharmacyAdvanceAllocationsTx(tx, { tenantId, orderId }) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = Number(orderId);
  const allocations = await tx.$queryRawUnsafe(
    `SELECT allocation.id::text AS id,allocation.allocated_amount,
            allocation.billing_advance_id,allocation.invoice_id,
            allocation.invoice_item_id,allocation.funding_task_id,
            allocation.funding_approval_receipt_id::text
       FROM pharmacy_advance_allocations allocation
      WHERE allocation.tenant_id=$1::uuid
        AND allocation.pharmacy_order_id=$2::int
      ORDER BY allocation.id
      FOR UPDATE OF allocation`,
    tid,
    exactOrderId,
  );
  if (!allocations.length) return [];
  const reversals = await tx.$queryRawUnsafe(
    `SELECT id::text AS id,allocation_id::text AS allocation_id,reversed_amount
       FROM pharmacy_advance_allocation_reversals
      WHERE tenant_id=$1::uuid AND allocation_id=ANY($2::bigint[])
      ORDER BY allocation_id,id
      FOR UPDATE`,
    tid,
    allocations.map((allocation) => String(allocation.id)),
  );
  const reversedByAllocation = new Map();
  for (const reversal of reversals) {
    const allocationId = String(reversal.allocation_id);
    reversedByAllocation.set(
      allocationId,
      Number(reversedByAllocation.get(allocationId) || 0) + Number(reversal.reversed_amount || 0),
    );
  }
  return allocations
    .map((allocation) => ({
      ...allocation,
      remaining_amount: toFixed2(
        Number(allocation.allocated_amount || 0)
          - Number(reversedByAllocation.get(String(allocation.id)) || 0),
      ),
    }))
    .filter((allocation) => allocation.remaining_amount > 0.001);
}

async function assertNoLivePharmacyAdvanceAllocationsTx(tx, { tenantId, orderId }) {
  const liveAllocations = await lockNetLivePharmacyAdvanceAllocationsTx(tx, {
    tenantId,
    orderId,
  });
  if (!liveAllocations.length) return [];
  throw AppError.conflict(
    'Live patient-advance funding reservations require a governed release or conversion',
    'PHARMACY_TERMINAL_FUNDING_ADVANCE_RELEASE_REQUIRED',
    {
      pharmacy_order_id: Number(orderId),
      live_advance_allocation_ids: liveAllocations.map((row) => String(row.id)),
      next_action: 'complete_governed_advance_allocation_release_or_conversion',
    },
  );
}

// Fail-closed probe for the ONE state in which terminal funding compensation is
// structurally unreachable: an order with no active resolvable patient.
// compensateTerminalPharmacyFundingAuthorityTx resolves the order's funding
// patient first (resolvePharmacyFundingPatientUidTx) and throws when none
// resolves, and its own order lookup JOINs users on pharmacy_orders.patient_id,
// so no caller can ever compensate such an order. Migration 753 manufactures
// exactly that state — an order filed ORDER_PATIENT_TENANT_MISMATCH has its
// patient_id set to NULL (753:1610-1631). This proves the money plane is
// already empty so the caller may close its governed recovery instead of
// deadlocking on a compensation that can never succeed. It is NOT a bypass:
// any surviving live funding authority still refuses, and an order that DOES
// resolve a patient must go through the full compensation command.
export async function assertNoLivePharmacyOrderFundingAuthorityTx(tx, {
  tenantId,
  orderId,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = Number(orderId);
  if (!Number.isInteger(exactOrderId) || exactOrderId <= 0) {
    throw AppError.badRequest(
      'A live-funding-authority probe requires an exact pharmacy order',
      'PHARMACY_TERMINAL_FUNDING_AUTHORITY_REQUIRED',
    );
  }
  // The caller already owns the otherwise-unresolvable order row. A read-only
  // probe avoids inverting substitution's command-receipt-before-order order.
  await assertNoSubstitutionFundingAuthorityTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
    lock: false,
  });
  const activeLines = await tx.$queryRawUnsafe(
    `SELECT item.id
       FROM billing_invoice_items item
      WHERE item.tenant_id=$1::uuid AND item.source_ref_type='pharmacy_order'
        AND item.source_ref_id=$2::bigint AND item.source_ref_active=TRUE
      ORDER BY item.id
      FOR UPDATE OF item`,
    tid,
    exactOrderId,
  );
  const activeReservations = await tx.$queryRawUnsafe(
    `SELECT id FROM pharmacy_cap_reservations
      WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int AND status='ACTIVE'
      ORDER BY id FOR UPDATE`,
    tid,
    exactOrderId,
  );
  const openAllocations = await tx.$queryRawUnsafe(
    `SELECT allocation.id
       FROM pharmacy_payment_allocations allocation
       LEFT JOIN pharmacy_payment_allocation_reversals reversal
         ON reversal.tenant_id=allocation.tenant_id
        AND reversal.allocation_id=allocation.id
      WHERE allocation.tenant_id=$1::uuid AND allocation.pharmacy_order_id=$2::int
      GROUP BY allocation.id
     HAVING allocation.allocated_amount
            - COALESCE(SUM(reversal.reversed_amount),0) > 0.001
      ORDER BY allocation.id`,
    tid,
    exactOrderId,
  );
  const openAdvanceAllocations = await lockNetLivePharmacyAdvanceAllocationsTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
  });
  if (activeLines.length || activeReservations.length || openAllocations.length
      || openAdvanceAllocations.length) {
    throw AppError.conflict(
      'The order carries live funding authority that only terminal compensation may unwind, and compensation needs the order patient repaired first',
      'PHARMACY_TERMINAL_FUNDING_PATIENT_AUTHORITY_UNRESOLVED',
      {
        pharmacy_order_id: exactOrderId,
        active_invoice_item_ids: activeLines.map((line) => Number(line.id)),
        active_cap_reservation_ids: activeReservations.map((row) => Number(row.id)),
        open_allocation_ids: openAllocations.map((row) => Number(row.id)),
        open_advance_allocation_ids: openAdvanceAllocations.map((row) => String(row.id)),
        next_action: 'resolve_order_patient_tenant_mismatch_recovery_then_retry',
      },
    );
  }
  return {
    pharmacyOrderId: exactOrderId,
    liveFundingAuthority: false,
  };
}

async function invalidateTerminalPharmacyFundingAuthorityTx(tx, {
  authority,
  order,
  actorRole,
}) {
  const terminalStatus = String(order.status || '').toUpperCase();
  if (!['CANCELLED', 'UNAVAILABLE', 'REJECTED'].includes(terminalStatus)) {
    return { releasedCapReservation: null, reversedAllocationIds: [] };
  }
  await assertNoPharmacyStockMovementEvidenceTx(tx, {
    tenantId: authority.tenantId,
    orderId: authority.orderId,
  });
  await assertNoLivePharmacyAdvanceAllocationsTx(tx, {
    tenantId: authority.tenantId,
    orderId: authority.orderId,
  });
  const reservationRows = await tx.$queryRawUnsafe(
    `SELECT admission_id FROM pharmacy_cap_reservations
      WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int AND status='ACTIVE'
      FOR UPDATE`,
    authority.tenantId,
    authority.orderId,
  );
  const releaseCommand = pharmacyFundingHash('TERMINAL_CAP_RELEASE', {
    tenant_id: authority.tenantId,
    pharmacy_order_id: authority.orderId,
    terminal_status: terminalStatus,
  });
  const releasedCapReservation = reservationRows.length
    ? await releasePharmacyCapReservationTx(tx, {
      tenantId: authority.tenantId,
      facilityId: authority.facilityId,
      admissionId: Number(reservationRows[0].admission_id),
      orderId: authority.orderId,
      actorUid: authority.actorUid,
      actorRole,
      commandKeySha256: releaseCommand,
      reason: `terminal_order_${terminalStatus.toLowerCase()}`,
    })
    : null;
  const allocations = await tx.$queryRawUnsafe(
    `SELECT allocation.*,
            (allocation.allocated_amount
             - COALESCE(SUM(reversal.reversed_amount),0))::numeric AS remaining_amount
       FROM pharmacy_payment_allocations allocation
       LEFT JOIN pharmacy_payment_allocation_reversals reversal
         ON reversal.tenant_id=allocation.tenant_id
        AND reversal.allocation_id=allocation.id
      WHERE allocation.tenant_id=$1::uuid
        AND allocation.pharmacy_order_id=$2::int
      GROUP BY allocation.id
     HAVING allocation.allocated_amount
            - COALESCE(SUM(reversal.reversed_amount),0) > 0.001
      ORDER BY allocation.id`,
    authority.tenantId,
    authority.orderId,
  );
  const reversedAllocationIds = [];
  for (const allocation of allocations) {
    const reversalCommand = pharmacyFundingHash('TERMINAL_ALLOCATION_REVERSAL', {
      tenant_id: authority.tenantId,
      pharmacy_order_id: authority.orderId,
      allocation_id: Number(allocation.id),
      terminal_status: terminalStatus,
    });
    const reversal = await reversePharmacyPaymentAllocationTx(tx, {
      tenantId: authority.tenantId,
      allocationId: Number(allocation.id),
      pharmacyOrderId: authority.orderId,
      invoiceId: Number(allocation.invoice_id),
      invoiceItemId: Number(allocation.invoice_item_id),
      billingPaymentId: Number(allocation.billing_payment_id),
      orderVersion: Number(allocation.source_authority_version),
      orderItemsSha256: String(allocation.source_authority_sha256),
      reversedAmount: Number(allocation.remaining_amount),
      actorUid: authority.actorUid,
      reason: `terminal_order_${terminalStatus.toLowerCase()}`,
      commandKeySha256: reversalCommand,
    });
    reversedAllocationIds.push(Number(reversal.allocation_id));
  }
  const invalidatedFundingEvent = await invalidateCurrentPharmacyFundingAuthorityStateTx(tx, {
    authority: {
      ...authority,
      orderVersion: Number(order.inventory_authority_version),
      orderItemsSha256: clinicalOrderItemsSha256(order.items_list),
    },
    reason: `terminal_order_${terminalStatus.toLowerCase()}`,
    actorRole,
  });
  return {
    releasedCapReservation,
    reversedAllocationIds,
    invalidatedFundingEventId: invalidatedFundingEvent == null
      ? null : Number(invalidatedFundingEvent.id),
  };
}

export async function compensateTerminalPharmacyFundingAuthorityTx(tx, {
  tenantId,
  orderId,
  actorUid,
  actorRole = null,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = Number(orderId);
  const actor = String(actorUid || '').trim();
  if (!Number.isInteger(exactOrderId) || exactOrderId <= 0 || !actor) {
    throw AppError.badRequest(
      'Terminal funding compensation requires an exact order and actor',
      'PHARMACY_TERMINAL_FUNDING_AUTHORITY_REQUIRED',
    );
  }
  const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
  });
  await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
  await assertNoSubstitutionFundingAuthorityTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
  });
  const durableActor = await assertPharmacyFundingActorTx(tx, {
    tenantId: tid,
    actorUid: actor,
  }, new Set([
    'PHARMACY_STAFF', 'PHARMACIST', 'PHARMACY_INCHARGE',
    'FINANCE_INCHARGE', 'BILLING_INCHARGE', 'INSURANCE_COORDINATOR',
    'ADMIN', 'SUPER_ADMIN',
  ]));
  if (actorRole && durableActor.role !== String(actorRole).trim().toUpperCase()) {
    throw AppError.forbidden(
      'The supplied terminal actor role is stale relative to the tenant identity',
      'PHARMACY_FUNDING_ACTOR_FORBIDDEN',
    );
  }
  const orderRows = await tx.$queryRawUnsafe(
    `SELECT pharmacy_order.id,pharmacy_order.facility_id,pharmacy_order.status,
            pharmacy_order.total_amount,pharmacy_order.inventory_authority_version,
            pharmacy_order.items_list,pharmacy_order.funding_admission_id,
            patient.uid AS patient_uid
       FROM pharmacy_orders pharmacy_order
       JOIN users patient
         ON patient.tenant_id=pharmacy_order.tenant_id
        AND patient.id=pharmacy_order.patient_id AND patient.uid=$3::uuid
        AND patient.role='PATIENT' AND patient.is_active=TRUE
        AND patient.status='active' AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
      WHERE pharmacy_order.tenant_id=$1::uuid AND pharmacy_order.id=$2::int
      FOR UPDATE OF pharmacy_order`,
    tid,
    exactOrderId,
    patientUid,
  );
  if (orderRows.length !== 1) throw AppError.notFound('Pharmacy order not found');
  const order = orderRows[0];
  const terminalStatus = String(order.status || '').toUpperCase();
  if (!['CANCELLED', 'UNAVAILABLE', 'REJECTED'].includes(terminalStatus)) {
    throw AppError.conflict(
      'Funding compensation must run after the exact order enters a cancellative terminal state',
      'PHARMACY_TERMINAL_FUNDING_ORDER_NOT_TERMINAL',
    );
  }
  // Re-asserted here (invalidateTerminalPharmacyFundingAuthorityTx below runs the
  // same guard) so the stock-evidence conflict keeps precedence over the line and
  // finance-reversal conflicts raised in between.
  await assertNoPharmacyStockMovementEvidenceTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
  });
  const discoveredLineRows = await tx.$queryRawUnsafe(
    `SELECT item.id,item.invoice_id
       FROM billing_invoice_items item
      WHERE item.tenant_id=$1::uuid AND item.source_ref_type='pharmacy_order'
        AND item.source_ref_id=$2::bigint AND item.source_ref_active=TRUE
      ORDER BY item.id`,
    tid,
    exactOrderId,
  );
  const invoiceIds = [...new Set(discoveredLineRows.map(
    (line) => Number(line.invoice_id),
  ))];
  const lockedInvoices = await lockPharmacyFundingInvoicesTx(tx, {
    tenantId: tid,
    invoiceIds,
  });
  const lockedItems = await lockPharmacyFundingInvoiceItemsTx(tx, {
    tenantId: tid,
    invoiceItemIds: discoveredLineRows.map((line) => Number(line.id)),
  });
  const lineRows = exactLockedPharmacyFundingLines({
    discoveredLines: discoveredLineRows,
    invoices: lockedInvoices,
    items: lockedItems,
  });
  if (lineRows == null || lineRows.some((line) => (
    line.source_ref_type !== 'pharmacy_order'
      || Number(line.source_ref_id) !== exactOrderId
      || line.source_ref_active !== true
  ))) {
    throw AppError.conflict(
      'The terminal pharmacy invoice line set changed while it was locked',
      'PHARMACY_TERMINAL_FUNDING_LINE_AUTHORITY_STALE',
    );
  }
  if (order.funding_admission_id != null) {
    await lockPharmacyFundingAdmissionTx(tx, {
      tenantId: tid,
      admissionId: Number(order.funding_admission_id),
      patientUid,
    });
  }
  await lockPharmacyFundingInvoiceChildrenTx(tx, { tenantId: tid, invoiceIds });
  await assertNoLivePharmacyAdvanceAllocationsTx(tx, {
    tenantId: tid,
    orderId: exactOrderId,
  });
  if (lineRows.length > 1) {
    throw AppError.conflict(
      'Terminal funding compensation requires duplicate-line reconciliation first',
      'PHARMACY_FUNDING_LINE_AMBIGUOUS',
    );
  }
  if (lineRows.length === 1) {
    const line = lineRows[0];
    const orderItemsSha256 = clinicalOrderItemsSha256(order.items_list);
    if (String(line.patient_uid) !== String(order.patient_uid)
        || (line.admission_id == null ? null : Number(line.admission_id))
          !== (order.funding_admission_id == null ? null : Number(order.funding_admission_id))
        || Number(line.source_authority_version) !== Number(order.inventory_authority_version)
        || String(line.source_authority_sha256 || '') !== orderItemsSha256
        || Math.abs(Number(line.line_total || 0) - Number(order.total_amount || 0)) > 0.001) {
      throw AppError.conflict(
        'Terminal funding compensation requires the one active line to match the current patient, admission, order version, item hash, and amount',
        'PHARMACY_TERMINAL_FUNDING_LINE_AUTHORITY_STALE',
      );
    }
    const paymentRows = await tx.$queryRawUnsafe(
      `SELECT id FROM billing_payments
        WHERE tenant_id=$1::uuid AND invoice_id=$2::int AND reversed=FALSE
        ORDER BY id FOR UPDATE`,
      tid,
      Number(line.invoice_id),
    );
    if (line.invoice_status !== 'DRAFT' || paymentRows.length) {
      throw AppError.conflict(
        'Finalized, paid, or shared invoices require governed credit/refund completion before terminal order compensation',
        'PHARMACY_TERMINAL_FUNDING_FINANCE_REVERSAL_REQUIRED',
        {
          invoice_id: Number(line.invoice_id),
          invoice_item_id: Number(line.id),
          next_action: 'complete_governed_credit_refund_then_retry_terminal_order',
        },
      );
    }
  }
  const invalidatedAuthority = await invalidateTerminalPharmacyFundingAuthorityTx(tx, {
    authority: {
      tenantId: tid,
      facilityId: Number(order.facility_id),
      orderId: exactOrderId,
      actorUid: actor,
    },
    order,
    actorRole: durableActor.role,
  });
  await tx.$executeRawUnsafe(
    `UPDATE tpa_claim_line_decisions decision
        SET invalidated_at=NOW(),invalidated_by=$3::uuid
       FROM billing_invoice_items item
      WHERE decision.tenant_id=$1::uuid AND item.tenant_id=decision.tenant_id
        AND item.id=decision.invoice_item_id
        AND item.source_ref_type='pharmacy_order'
        AND item.source_ref_id=$2::bigint AND decision.invalidated_at IS NULL`,
    tid,
    exactOrderId,
    actor,
  );
  const closedTasks = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET status='cancelled',cancelled_at=NOW(),updated_at=NOW(),
            cancellation_reason='Pharmacy order terminal funding compensation',
            metadata=metadata || $3::jsonb
      WHERE tenant_id=$1::uuid AND related_resource_id=$2
        AND related_resource_type IN ('pharmacy_tpa_line_decision','pharmacy_posted_payment')
        AND status IN (${ACTIVE_TASK_STATUSES})
        AND metadata->>'contract'=$4
        AND metadata->>'pharmacy_order_id'=$2
        AND (
          (related_resource_type='pharmacy_tpa_line_decision'
            AND metadata->>'task_type'='tpa_line_decision')
          OR
          (related_resource_type='pharmacy_posted_payment'
            AND metadata->>'task_type'='posted_payment')
        )
      RETURNING id`,
    tid,
    String(exactOrderId),
    JSON.stringify({
      domain_evidence: {
        contract: 'pharmacy_terminal_funding_compensation_v1',
        terminal_order_status: terminalStatus,
        actor_uid: actor,
        actor_role: durableActor.role,
      },
    }),
    PHARMACY_FUNDING_TASK_CONTRACT,
  );
  let voidedInvoiceId = null;
  let deactivatedInvoiceItemId = null;
  let recomputedInvoice = null;
  let monetaryCompensation = null;
  if (lineRows.length === 1) {
    const line = lineRows[0];
    const deactivatedRows = await tx.$queryRawUnsafe(
      `UPDATE billing_invoice_items
          SET source_ref_active=FALSE,source_ref_deactivated_at=NOW(),
              source_ref_deactivated_by=$3::uuid,
              unit_price=0,line_subtotal=0,cgst_amount=0,sgst_amount=0,
              igst_amount=0,line_total=0,
              notes=CONCAT_WS(E'\n',NULLIF(notes,''),$4)
        WHERE tenant_id=$1::uuid AND id=$2::int AND source_ref_active=TRUE
        RETURNING id`,
      tid,
      Number(line.id),
      actor,
      `Terminal pharmacy funding compensation for ${terminalStatus} order ${exactOrderId}`,
    );
    if (deactivatedRows.length !== 1) {
      throw AppError.conflict(
        'The exact pharmacy invoice line changed before terminal monetary compensation',
        'PHARMACY_TERMINAL_FUNDING_LINE_AUTHORITY_STALE',
      );
    }
    monetaryCompensation = {
      invoiceItemId: Number(line.id),
      invoiceId: Number(line.invoice_id),
      priorQuantity: Number(line.quantity),
      priorUnitPrice: Number(line.unit_price),
      priorLineSubtotal: Number(line.line_subtotal),
      priorCgstAmount: Number(line.cgst_amount),
      priorSgstAmount: Number(line.sgst_amount),
      priorIgstAmount: Number(line.igst_amount),
      priorLineTotal: Number(line.line_total),
      priorInvoiceSubtotal: Number(line.invoice_subtotal),
      priorInvoiceCgstAmount: Number(line.invoice_cgst_amount),
      priorInvoiceSgstAmount: Number(line.invoice_sgst_amount),
      priorInvoiceIgstAmount: Number(line.invoice_igst_amount),
      priorInvoiceTotalAmount: Number(line.invoice_total_amount),
      priorInvoiceAmountPaid: Number(line.invoice_amount_paid),
      priorInvoiceAmountDue: Number(line.invoice_amount_due),
      resultingLineTotal: 0,
    };
    recomputedInvoice = {
      invoiceId: Number(line.invoice_id),
      ...await recomputeInvoiceTotals(Number(line.invoice_id), tx, { emitTpaAlert: false }),
    };
    const remainingRows = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS active_count FROM billing_invoice_items
        WHERE tenant_id=$1::uuid AND invoice_id=$2::int AND source_ref_active=TRUE`,
      tid,
      Number(line.invoice_id),
    );
    if (Number(remainingRows[0]?.active_count || 0) === 0) {
      const voided = await tx.$queryRawUnsafe(
        `UPDATE billing_invoices
            SET status='VOID',voided_at=NOW(),voided_by=$3::uuid,
                void_reason=$4,updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int AND status='DRAFT'
          RETURNING id`,
        tid,
        Number(line.invoice_id),
        actor,
        `Pharmacy order ${exactOrderId} ${terminalStatus.toLowerCase()}`,
      );
      if (voided.length !== 1) {
        throw AppError.conflict(
          'The exact draft pharmacy invoice could not be voided atomically',
          'PHARMACY_TERMINAL_FUNDING_INVOICE_STALE',
        );
      }
      voidedInvoiceId = Number(voided[0].id);
    }
    deactivatedInvoiceItemId = Number(line.id);
  }
  return {
    status: 'compensated',
    pharmacyOrderId: exactOrderId,
    terminalOrderStatus: terminalStatus,
    closedTaskIds: closedTasks.map((task) => Number(task.id)),
    deactivatedInvoiceItemId,
    voidedInvoiceId,
    recomputedInvoice,
    monetaryCompensation,
    ...invalidatedAuthority,
  };
}

async function allocatePostedPharmacyPaymentsTx(tx, {
  authority,
  invoiceId,
  invoiceItemId,
  amountRequired,
  paymentId = null,
  commandKeySha256,
}) {
  await tx.$queryRawUnsafe(
    `SELECT id FROM billing_invoices
      WHERE tenant_id=$1::uuid AND id=$2::int
      FOR UPDATE`,
    authority.tenantId,
    Number(invoiceId),
  );
  const payments = await tx.$queryRawUnsafe(
    `SELECT payment.id,payment.amount,payment.mode,payment.reference,payment.collected_at
       FROM billing_payments payment
      WHERE payment.tenant_id=$1::uuid AND payment.invoice_id=$2::int
        AND payment.patient_uid=$3::uuid AND payment.reversed=FALSE
        AND ($4::int IS NULL OR payment.id=$4::int)
        AND UPPER(payment.mode)=ANY($5::text[])
      ORDER BY payment.collected_at,payment.id
      FOR UPDATE`,
    authority.tenantId,
    Number(invoiceId),
    authority.patientUid,
    paymentId == null ? null : Number(paymentId),
    PHARMACY_PATIENT_PAYMENT_RAILS,
  );
  if (paymentId != null && payments.length !== 1) {
    throw AppError.conflict(
      'The supplied payment id is not a posted, unreversed payment for the exact invoice and patient',
      'PHARMACY_PAYMENT_AUTHORITY_MISMATCH',
    );
  }
  const allocatedRows = payments.length
    ? await tx.$queryRawUnsafe(
      `SELECT allocation.billing_payment_id,
              COALESCE(SUM(
                allocation.allocated_amount
                - COALESCE(reversed.reversed_amount,0)
              ),0)::numeric AS allocated_amount
         FROM pharmacy_payment_allocations allocation
         LEFT JOIN (
           SELECT tenant_id,allocation_id,SUM(reversed_amount)::numeric AS reversed_amount
             FROM pharmacy_payment_allocation_reversals
            WHERE tenant_id=$1::uuid
            GROUP BY tenant_id,allocation_id
         ) reversed
           ON reversed.tenant_id=allocation.tenant_id
          AND reversed.allocation_id=allocation.id
        WHERE allocation.tenant_id=$1::uuid
          AND allocation.billing_payment_id=ANY($2::int[])
        GROUP BY allocation.billing_payment_id`,
      authority.tenantId,
      payments.map((payment) => Number(payment.id)),
    )
    : [];
  const allocatedByPayment = new Map(allocatedRows.map((row) => [
    Number(row.billing_payment_id), Number(row.allocated_amount || 0),
  ]));
  const existing = await loadPharmacyPaymentAllocationsTx(tx, {
    tenantId: authority.tenantId,
    invoiceId,
    invoiceItemId,
    orderId: authority.orderId,
    orderVersion: authority.orderVersion,
    orderItemsSha256: authority.orderItemsSha256,
    patientUid: authority.patientUid,
  });
  const exactPaymentIds = new Set(existing.rows.map((row) => Number(row.payment_id)));
  const sharedFundingHeadroom = await calculateInvoiceRefundHeadroomTx(tx, invoiceId);
  let uncommittedInvoiceFunding = sharedFundingHeadroom.refundable;
  let remaining = Math.max(0, toFixed2(Number(amountRequired) - existing.amount));
  for (const payment of payments) {
    if (remaining <= 0.001 || uncommittedInvoiceFunding <= 0.001) break;
    if (exactPaymentIds.has(Number(payment.id))) continue;
    const available = Math.max(
      0,
      toFixed2(Number(payment.amount || 0) - (allocatedByPayment.get(Number(payment.id)) || 0)),
    );
    const amount = Math.min(remaining, available, uncommittedInvoiceFunding);
    if (amount <= 0.001) continue;
    await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_payment_allocations
        (tenant_id,pharmacy_order_id,invoice_id,invoice_item_id,billing_payment_id,
         source_authority_version,source_authority_sha256,allocated_amount,
         allocation_command_sha256,allocated_by,evidence)
       VALUES ($1::uuid,$2::int,$3::int,$4::int,$5::int,$6::int,$7,$8::numeric,
               $9,$10::uuid,$11::jsonb)
       RETURNING id`,
      authority.tenantId, authority.orderId, Number(invoiceId), Number(invoiceItemId),
      Number(payment.id), authority.orderVersion, authority.orderItemsSha256, amount,
      String(commandKeySha256), authority.actorUid,
      JSON.stringify({
        contract: 'pharmacy_payment_allocation_v1',
        payment_amount: Number(payment.amount),
        payment_previously_allocated: allocatedByPayment.get(Number(payment.id)) || 0,
      }),
    );
    remaining = Math.max(0, toFixed2(remaining - amount));
    uncommittedInvoiceFunding = Math.max(
      0,
      toFixed2(uncommittedInvoiceFunding - amount),
    );
  }
  return loadPharmacyPaymentAllocationsTx(tx, {
    tenantId: authority.tenantId,
    invoiceId,
    invoiceItemId,
    orderId: authority.orderId,
    orderVersion: authority.orderVersion,
    orderItemsSha256: authority.orderItemsSha256,
    patientUid: authority.patientUid,
  });
}

async function claimPharmacyFundingCommandTx(tx, {
  authority,
  commandKeySha256,
  commandType,
  task,
  invoiceItemId,
  tpaClaimId = null,
  requestSha256,
}) {
  const taskResourceType = String(task.related_resource_type || '');
  const taskResourceId = String(task.related_resource_id || '');
  await tx.$executeRawUnsafe(
    `INSERT INTO pharmacy_funding_commands
      (tenant_id,command_key_sha256,command_type,task_id,task_resource_type,
       task_resource_id,pharmacy_order_id,invoice_item_id,tpa_claim_id,
       request_sha256,created_by)
     VALUES ($1::uuid,$2,$3,$4::int,$5,$6,$7::int,$8::int,$9::int,$10,
             $11::uuid)
     ON CONFLICT (tenant_id,command_key_sha256) DO NOTHING`,
    authority.tenantId,
    String(commandKeySha256),
    String(commandType),
    Number(task.id),
    taskResourceType,
    taskResourceId,
    authority.orderId,
    Number(invoiceItemId),
    tpaClaimId == null ? null : Number(tpaClaimId),
    String(requestSha256),
    authority.actorUid,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT * FROM pharmacy_funding_commands
      WHERE tenant_id=$1::uuid AND command_key_sha256=$2
      FOR UPDATE`,
    authority.tenantId,
    String(commandKeySha256),
  );
  const receipt = rows[0];
  const mismatched = !receipt
    || receipt.command_type !== String(commandType)
    || Number(receipt.task_id) !== Number(task.id)
    || receipt.task_resource_type !== taskResourceType
    || receipt.task_resource_id !== taskResourceId
    || Number(receipt.pharmacy_order_id) !== authority.orderId
    || Number(receipt.invoice_item_id) !== Number(invoiceItemId)
    || (receipt.tpa_claim_id == null ? null : Number(receipt.tpa_claim_id))
      !== (tpaClaimId == null ? null : Number(tpaClaimId))
    || receipt.request_sha256 !== String(requestSha256);
  if (mismatched) {
    throw AppError.unprocessable(
      'The idempotency key is already bound to a different funding request or target',
      'PHARMACY_FUNDING_COMMAND_MISMATCH',
    );
  }
  return receipt;
}

async function completePharmacyFundingCommandTx(tx, {
  tenantId,
  commandKeySha256,
  responseBody,
}) {
  const rows = await tx.$queryRawUnsafe(
    `UPDATE pharmacy_funding_commands
        SET status='COMPLETE',response_body=$3::jsonb
      WHERE tenant_id=$1::uuid AND command_key_sha256=$2
        AND status='IN_PROGRESS'
      RETURNING *`,
    requireTenantId(tenantId),
    String(commandKeySha256),
    JSON.stringify(responseBody),
  );
  if (!rows.length) {
    throw AppError.conflict(
      'The funding command could not be completed from its claimed state',
      'PHARMACY_FUNDING_COMMAND_STATE_CONFLICT',
    );
  }
  return rows[0];
}

export async function materializePharmacyFundingTaskTx(tx, rawArgs) {
  const authority = normalizePharmacyFundingAuthority(rawArgs);
  const canonicalPatientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId: authority.tenantId,
    orderId: authority.orderId,
    patientId: authority.patientId,
    patientUid: authority.patientUid,
  });
  await lockPharmacyFundingAuthorityTx(tx, {
    tenantId: authority.tenantId,
    patientUid: canonicalPatientUid,
  });
  await assertNoSubstitutionFundingAuthorityTx(tx, {
    tenantId: authority.tenantId,
    orderId: authority.orderId,
  });
  const actor = await assertPharmacyFundingActorTx(
    tx,
    authority,
    PHARMACY_FUNDING_MATERIALIZE_ROLES,
  );
  const orderRows = await tx.$queryRawUnsafe(
    `SELECT po.id,po.patient_id,po.uid,po.patient_name,po.patient_phone,po.order_number,
            po.facility_id,po.total_amount,po.inventory_authority_version,po.status,
            po.items_list,po.payment_mode,po.payment_metadata,
            po.funding_admission_id,po.funding_admission_order_version,
            po.funding_admission_items_sha256,
            patient.uid AS patient_uid
       FROM pharmacy_orders po
       JOIN users patient
         ON patient.tenant_id=po.tenant_id AND patient.id=po.patient_id
        AND patient.role='PATIENT' AND patient.is_active=TRUE
        AND patient.status='active' AND patient.is_deleted=FALSE
        AND patient.merged_into_uid IS NULL
      WHERE po.tenant_id=$1::uuid AND po.id=$2::int AND po.facility_id=$3::int
        AND ($4::int IS NULL OR patient.id=$4::int)
        AND ($5::uuid IS NULL OR patient.uid=$5::uuid)
        AND (po.uid IS NULL OR po.uid=patient.uid)
      FOR UPDATE`,
    authority.tenantId,
    authority.orderId,
    authority.facilityId,
    authority.patientId,
    authority.patientUid,
  );
  if (!orderRows.length) {
    throw AppError.conflict(
      'The pharmacy order does not belong to the exact patient, tenant, and facility',
      'PHARMACY_FUNDING_ORDER_SCOPE_MISMATCH',
    );
  }
  const order = orderRows[0];
  if (authority.tpaClaimId != null && !PHARMACY_TPA_DECISION_ROLES.has(actor.role)) {
    throw AppError.forbidden(
      'Only an insurance or finance authority may select an exact TPA claim',
      'PHARMACY_FUNDING_TPA_SELECTION_FORBIDDEN',
    );
  }
  if (PHARMACY_FUNDING_FACILITY_GRANT_ROLES.has(actor.role)) {
    const facilityGrantRows = await tx.$queryRawUnsafe(
      `SELECT id,authority_version
         FROM pharmacy_staff_facility_grants
        WHERE tenant_id=$1::uuid AND staff_uid=$2::uuid AND facility_id=$3::int
          AND status='active' AND revoked_at IS NULL
        FOR KEY SHARE`,
      authority.tenantId,
      authority.actorUid,
      authority.facilityId,
    );
    if (facilityGrantRows.length !== 1) {
      throw AppError.forbidden(
        'The funding actor has no active grant for the order facility',
        'PHARMACY_FUNDING_FACILITY_GRANT_REQUIRED',
      );
    }
  }
  authority.patientId = Number(order.patient_id);
  authority.patientUid = String(order.patient_uid);
  if (authority.patientUid !== canonicalPatientUid) {
    throw AppError.conflict(
      'The pharmacy order patient changed while funding authority was acquired',
      'PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH',
    );
  }
  const canonicalItemsSha256 = clinicalOrderItemsSha256(order.items_list);
  const durablePaymentMode = String(
    order.payment_mode || order.payment_metadata?.payment_mode || '',
  ).trim().toLowerCase();
  if (Number(order.inventory_authority_version) !== authority.orderVersion
      || Math.abs(Number(order.total_amount || 0) - authority.authoritativeAmount) > 0.001
      || canonicalItemsSha256 !== authority.orderItemsSha256
      || !durablePaymentMode
      || durablePaymentMode !== authority.paymentMode) {
    throw AppError.conflict(
      'The pharmacy funding tuple is stale relative to the authoritative order',
      'PHARMACY_FUNDING_ORDER_AUTHORITY_STALE',
      {
        current_order_version: Number(order.inventory_authority_version),
        current_total_amount: Number(order.total_amount || 0),
        current_order_items_sha256: canonicalItemsSha256,
        current_payment_mode: durablePaymentMode || null,
      },
    );
  }
  const tpaMode = PHARMACY_TPA_PAYMENT_MODES.has(authority.paymentMode);
  const preIssueStatuses = new Set([
    'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED', 'PARTIALLY_DISPENSED',
  ]);
  const orderStatus = String(order.status).toUpperCase();
  if (!preIssueStatuses.has(orderStatus)) {
    if (!['CANCELLED', 'UNAVAILABLE', 'REJECTED', 'DISPENSED', 'DELIVERED'].includes(orderStatus)) {
      throw AppError.conflict(
        `Pharmacy funding cannot mutate an order in ${orderStatus} state`,
        'PHARMACY_FUNDING_ORDER_NOT_ACTIONABLE',
      );
    }
    const authorityCancelled = ['CANCELLED', 'UNAVAILABLE', 'REJECTED'].includes(orderStatus);
    await assertNoLivePharmacyAdvanceAllocationsTx(tx, {
      tenantId: authority.tenantId,
      orderId: authority.orderId,
    });
    await tx.$executeRawUnsafe(
      `UPDATE tasks
          SET status=CASE WHEN $4::boolean THEN 'cancelled' ELSE 'completed' END,
              cancelled_at=CASE WHEN $4::boolean THEN NOW() ELSE cancelled_at END,
              completed_at=CASE WHEN $4::boolean THEN completed_at ELSE NOW() END,
              updated_at=NOW(),
              cancellation_reason=CASE WHEN $4::boolean
                THEN 'Pharmacy order left pre-issue funding states'
                ELSE cancellation_reason END,
              metadata=metadata || $3::jsonb
        WHERE tenant_id=$1::uuid AND related_resource_id=$2
          AND related_resource_type IN ('pharmacy_tpa_line_decision','pharmacy_posted_payment')
          AND status IN (${ACTIVE_TASK_STATUSES})
          AND metadata->>'contract'=$5
          AND metadata->>'pharmacy_order_id'=$2
          AND (
            (related_resource_type='pharmacy_tpa_line_decision'
              AND metadata->>'task_type'='tpa_line_decision')
            OR
            (related_resource_type='pharmacy_posted_payment'
              AND metadata->>'task_type'='posted_payment')
          )`,
      authority.tenantId,
      String(authority.orderId),
      JSON.stringify({
        domain_evidence: {
          terminal_order_status: orderStatus,
          invalidated_by: authority.actorUid,
        },
      }),
      authorityCancelled,
      PHARMACY_FUNDING_TASK_CONTRACT,
    );
    if (authorityCancelled) {
      await tx.$executeRawUnsafe(
        `UPDATE tpa_claim_line_decisions decision
            SET invalidated_at=NOW(),invalidated_by=$3::uuid
           FROM billing_invoice_items item
          WHERE decision.tenant_id=$1::uuid AND item.tenant_id=decision.tenant_id
            AND item.id=decision.invoice_item_id
            AND item.source_ref_type='pharmacy_order' AND item.source_ref_id=$2::bigint
            AND decision.invalidated_at IS NULL`,
        authority.tenantId,
        authority.orderId,
        authority.actorUid,
      );
    }
    const invalidatedAuthority = authorityCancelled
      ? await invalidateTerminalPharmacyFundingAuthorityTx(tx, {
        authority,
        order,
        actorRole: actor.role,
      })
      : { releasedCapReservation: null, reversedAllocationIds: [] };
    return {
      status: authorityCancelled ? 'invalidated' : 'closed',
      admissionId: null,
      invoiceId: null,
      invoiceItemId: null,
      tpaClaimId: null,
      task: null,
      decision: null,
      postedPayments: [],
      fundingRecovery: null,
      invalidatedAuthority,
      authority,
    };
  }
  const admissionRows = await tx.$queryRawUnsafe(
    `SELECT id,patient_uid,status
       FROM admissions
       WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid AND status='admitted'
         AND ($3::int IS NULL OR id=$3::int)
         AND $4::boolean
       ORDER BY admitted_at DESC NULLS LAST,id DESC`,
    authority.tenantId,
    authority.patientUid,
    order.funding_admission_id == null ? null : Number(order.funding_admission_id),
    tpaMode || order.funding_admission_id != null,
  );
  if (admissionRows.length > 1 || (tpaMode && admissionRows.length !== 1)) {
    throw AppError.conflict(
      admissionRows.length > 1
        ? 'More than one active admission exists for the pharmacy patient'
        : 'No active admission owns this pharmacy funding workflow',
      admissionRows.length > 1
        ? 'PHARMACY_FUNDING_ADMISSION_AMBIGUOUS'
        : 'PHARMACY_FUNDING_ADMISSION_REQUIRED',
    );
  }
  const admissionId = admissionRows.length ? Number(admissionRows[0].id) : null;
  if (order.funding_admission_id != null && admissionId == null) {
    throw AppError.conflict(
      'The order funding admission binding is no longer active for the patient',
      'PHARMACY_FUNDING_ADMISSION_AUTHORITY_STALE',
    );
  }
  if (order.funding_admission_id != null
      && (Number(order.funding_admission_order_version) !== authority.orderVersion
        || String(order.funding_admission_items_sha256) !== authority.orderItemsSha256)) {
    throw AppError.conflict(
      'The order admission binding belongs to a different order authority version',
      'PHARMACY_FUNDING_ADMISSION_AUTHORITY_STALE',
    );
  }
  const claimDiscovery = await resolveExactPharmacyClaimTx(
    tx,
    authority,
    admissionId,
    { lock: false },
  );
  if (claimDiscovery != null && claimDiscovery.invoice_id == null) {
    throw AppError.conflict(
      'The exact TPA claim must already own its patient/admission invoice before pharmacy funding can materialize a line',
      'PHARMACY_TPA_CLAIM_INVOICE_REQUIRED',
      {
        tpa_claim_id: Number(claimDiscovery.id),
        next_action: 'bind_claim_to_exact_invoice',
      },
    );
  }

  const discoveredSourceLines = await tx.$queryRawUnsafe(
    `SELECT item.id,item.invoice_id
       FROM billing_invoice_items item
      WHERE item.tenant_id=$1::uuid AND item.source_ref_type='pharmacy_order'
        AND item.source_ref_id=$2::bigint AND item.source_ref_active=TRUE
      ORDER BY item.id`,
    authority.tenantId,
    authority.orderId,
  );
  const invoiceIds = [...new Set([
    ...discoveredSourceLines.map((line) => Number(line.invoice_id)),
    ...(claimDiscovery?.invoice_id == null ? [] : [Number(claimDiscovery.invoice_id)]),
  ])].sort((left, right) => left - right);
  const lockedInvoices = await lockPharmacyFundingInvoicesTx(tx, {
    tenantId: authority.tenantId,
    invoiceIds,
  });
  const lockedItems = await lockPharmacyFundingInvoiceItemsTx(tx, {
    tenantId: authority.tenantId,
    invoiceItemIds: discoveredSourceLines.map((line) => Number(line.id)),
  });
  if (lockedInvoices.length !== invoiceIds.length) {
    throw AppError.conflict(
      'The pharmacy invoice set changed before funding authority was locked',
      'PHARMACY_FUNDING_LINE_AUTHORITY_STALE',
    );
  }
  const sourceLines = exactLockedPharmacyFundingLines({
    discoveredLines: discoveredSourceLines,
    invoices: lockedInvoices.filter((invoice) => discoveredSourceLines.some(
      (line) => Number(line.invoice_id) === Number(invoice.id),
    )),
    items: lockedItems,
  });
  if (sourceLines == null || sourceLines.some((line) => (
    line.source_ref_type !== 'pharmacy_order'
      || Number(line.source_ref_id) !== authority.orderId
      || line.source_ref_active !== true
  ))) {
    throw AppError.conflict(
      'The pharmacy invoice line set changed before funding authority was locked',
      'PHARMACY_FUNDING_LINE_AUTHORITY_STALE',
    );
  }
  if (admissionId != null) {
    const lockedAdmission = await lockPharmacyFundingAdmissionTx(tx, {
      tenantId: authority.tenantId,
      admissionId,
      patientUid: authority.patientUid,
    });
    if (lockedAdmission.status !== 'admitted') {
      throw AppError.conflict(
        'The order funding admission is no longer admitted',
        'PHARMACY_FUNDING_ADMISSION_AUTHORITY_STALE',
      );
    }
  }
  await lockPharmacyFundingInvoiceChildrenTx(tx, {
    tenantId: authority.tenantId,
    invoiceIds,
  });
  const claim = await resolveExactPharmacyClaimTx(tx, authority, admissionId);
  if ((claimDiscovery?.id == null ? null : Number(claimDiscovery.id))
        !== (claim?.id == null ? null : Number(claim.id))
      || (claimDiscovery?.invoice_id == null ? null : Number(claimDiscovery.invoice_id))
        !== (claim?.invoice_id == null ? null : Number(claim.invoice_id))) {
    throw AppError.conflict(
      'The exact TPA claim changed while invoice authority was locked',
      'PHARMACY_TPA_CLAIM_AUTHORITY_STALE',
    );
  }
  await assertNoLivePharmacyAdvanceAllocationsTx(tx, {
    tenantId: authority.tenantId,
    orderId: authority.orderId,
  });
  if (admissionId != null && order.funding_admission_id == null) {
    await tx.$executeRawUnsafe(
      `UPDATE pharmacy_orders
          SET funding_admission_id=$3::int,
              funding_admission_order_version=$4::int,
              funding_admission_items_sha256=$5,
              updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND funding_admission_id IS NULL`,
      authority.tenantId,
      authority.orderId,
      admissionId,
      authority.orderVersion,
      authority.orderItemsSha256,
    );
  }
  if (sourceLines.length > 1) {
    const reconciliationRows = await tx.$queryRawUnsafe(
      `SELECT reconciliation.id AS case_id,reconciliation.status,
              reconciliation.snapshot_sha256,reconciliation.task_id,
              task.assigned_to_role
         FROM pharmacy_funding_reconciliation_cases reconciliation
         JOIN tasks task
           ON task.tenant_id=reconciliation.tenant_id
          AND task.id=reconciliation.task_id
          AND task.related_resource_type=reconciliation.task_resource_type
          AND task.related_resource_id=reconciliation.task_resource_id
        WHERE reconciliation.tenant_id=$1::uuid
          AND reconciliation.pharmacy_order_id=$2::int
          AND reconciliation.status<>'RESOLVED'
        FOR UPDATE OF reconciliation,task`,
      authority.tenantId,
      authority.orderId,
    );
    throw AppError.conflict(
      'More than one active billing line exists; finance reconciliation must resolve exact evidence first',
      'PHARMACY_FUNDING_LINE_AMBIGUOUS',
      {
        funding_reconciliation: reconciliationRows.length ? {
          ...reconciliationRows[0],
          deep_link: `/billing-desk?funding_reconciliation_case_id=${Number(reconciliationRows[0].case_id)}`,
        } : null,
        next_action: reconciliationRows.length
          ? 'open_exact_pharmacy_funding_reconciliation'
          : 'run_migration_753_duplicate_worklist_backfill',
        funding_recovery: reconciliationRows.length ? {
          task_id: String(reconciliationRows[0].task_id),
          status: String(reconciliationRows[0].status).toLowerCase(),
          owner_role: reconciliationRows[0].assigned_to_role,
          deep_link: `/billing-desk?funding_reconciliation_case_id=${Number(reconciliationRows[0].case_id)}`,
        } : null,
      },
    );
  }
  let line = sourceLines[0] || null;
  let invoice;
  if (line) {
    if (String(line.patient_uid) !== authority.patientUid
        || (line.admission_id == null ? null : Number(line.admission_id)) !== admissionId
        || line.invoice_status !== 'DRAFT'
        || (claim?.invoice_id && Number(line.invoice_id) !== Number(claim.invoice_id))) {
      throw AppError.conflict(
        'The active pharmacy billing line is not an editable invoice owned by the exact patient/admission/claim',
        'PHARMACY_FUNDING_LINE_OWNERSHIP_MISMATCH',
      );
    }
    invoice = { id: Number(line.invoice_id), status: line.invoice_status };
  } else {
    const invoiceRows = claim?.invoice_id
      ? lockedInvoices.filter((candidate) => (
        Number(candidate.id) === Number(claim.invoice_id)
          && String(candidate.patient_uid) === authority.patientUid
          && Number(candidate.admission_id) === admissionId
      ))
      : [];
    invoice = invoiceRows[0] || await createDraftInvoice({
      patient_uid: authority.patientUid,
      patient_name: order.patient_name,
      patient_phone: order.patient_phone,
      admission_id: admissionId,
      invoice_type: 'PHARMACY',
      department: 'Pharmacy',
      notes: `Funding authority for pharmacy order ${authority.orderId}`,
      created_by: authority.actorUid,
      tenantId: authority.tenantId,
    }, { db: tx });
    if (invoice.status !== 'DRAFT') {
      throw AppError.conflict(
        'The TPA claim invoice is no longer editable',
        'PHARMACY_FUNDING_INVOICE_NOT_DRAFT',
      );
    }
  }

  const authorityChanged = line && (
    Number(line.source_authority_version || 0) !== authority.orderVersion
    || String(line.source_authority_sha256 || '') !== authority.orderItemsSha256
    || Math.abs(Number(line.line_total || 0) - authority.authoritativeAmount) > 0.001
  );
  if (authorityChanged) {
    await tx.$executeRawUnsafe(
      `UPDATE tpa_claim_line_decisions
          SET invalidated_at=NOW(), invalidated_by=$3::uuid
        WHERE tenant_id=$1::uuid AND invoice_item_id=$2::int
          AND invalidated_at IS NULL`,
      authority.tenantId,
      Number(line.id),
      authority.actorUid,
    );
  }
  if (line) {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE billing_invoice_items
          SET description=$3,quantity=1,unit_price=$4::numeric,gst_rate=0,
              line_subtotal=$4::numeric,cgst_amount=0,sgst_amount=0,igst_amount=0,
              line_total=$4::numeric,source_authority_version=$5::int,
              source_authority_sha256=$6,
              tpa_decision=CASE WHEN $7::boolean THEN 'pending' ELSE tpa_decision END,
              tpa_non_payable_reason=CASE WHEN $7::boolean THEN NULL ELSE tpa_non_payable_reason END,
              tpa_decided_at=CASE WHEN $7::boolean THEN NULL ELSE tpa_decided_at END,
              tpa_decided_by=CASE WHEN $7::boolean THEN NULL ELSE tpa_decided_by END
        WHERE tenant_id=$1::uuid AND id=$2::int
        RETURNING *`,
      authority.tenantId, Number(line.id),
      `Pharmacy order ${authority.orderId}`, authority.authoritativeAmount,
      authority.orderVersion, authority.orderItemsSha256, Boolean(authorityChanged),
    );
    line = rows[0];
  } else {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO billing_invoice_items
        (invoice_id,description,category,quantity,unit_price,gst_rate,line_subtotal,
         cgst_amount,sgst_amount,igst_amount,line_total,notes,source_ref_type,
         source_ref_id,tenant_id,source_ref_active,tpa_decision,
         source_authority_version,source_authority_sha256)
       VALUES ($1::int,$2,'pharmacy',1,$3::numeric,0,$3::numeric,0,0,0,$3::numeric,
               $4,'pharmacy_order',$5::bigint,$6::uuid,TRUE,'pending',$7::int,$8)
       RETURNING *`,
      Number(invoice.id), `Pharmacy order ${authority.orderId}`,
      authority.authoritativeAmount, order.order_number || null,
      authority.orderId, authority.tenantId, authority.orderVersion,
      authority.orderItemsSha256,
    );
    line = rows[0];
  }
  await recomputeInvoiceTotals(Number(invoice.id), tx, { emitTpaAlert: false });

  const lineEventCommand = pharmacyFundingHash('LINE_MATERIALIZED', {
    tenant_id: authority.tenantId,
    order_id: authority.orderId,
    order_version: authority.orderVersion,
    order_items_sha256: authority.orderItemsSha256,
    invoice_item_id: Number(line.id),
  });
  await tx.$executeRawUnsafe(
    `INSERT INTO pharmacy_funding_decision_events
      (tenant_id,facility_id,pharmacy_order_id,admission_id,event_type,
       source_authority_version,source_authority_sha256,invoice_id,invoice_item_id,
       tpa_claim_id,amount,command_key_sha256,evidence,recorded_by)
     VALUES ($1::uuid,$2::int,$3::int,$4::int,'LINE_MATERIALIZED',$5::int,$6,
             $7::int,$8::int,$9::int,$10::numeric,$11,$12::jsonb,$13::uuid)
     ON CONFLICT (tenant_id,event_type,command_key_sha256) DO NOTHING`,
    authority.tenantId, authority.facilityId, authority.orderId, admissionId,
    authority.orderVersion, authority.orderItemsSha256, Number(invoice.id), Number(line.id),
    claim == null ? null : Number(claim.id), authority.authoritativeAmount,
    lineEventCommand, JSON.stringify({ authority_changed: Boolean(authorityChanged) }),
    authority.actorUid,
  );

  const allocations = await loadPharmacyPaymentAllocationsTx(tx, {
    tenantId: authority.tenantId,
    invoiceId: Number(invoice.id),
    invoiceItemId: Number(line.id),
    orderId: authority.orderId,
    orderVersion: authority.orderVersion,
    orderItemsSha256: authority.orderItemsSha256,
    patientUid: authority.patientUid,
  });
  let decision = null;
  if (claim) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM tpa_claim_line_decisions
        WHERE tenant_id=$1::uuid AND claim_id=$2::int AND invoice_item_id=$3::int
          AND invalidated_at IS NULL AND source_authority_version=$4::int
          AND source_authority_sha256=$5
        FOR UPDATE`,
      authority.tenantId, Number(claim.id), Number(line.id),
      authority.orderVersion, authority.orderItemsSha256,
    );
    decision = rows[0] || null;
  }
  const decisionRecorded = tpaMode && claim
    && ['approved', 'partially_approved', 'paid'].includes(claim.status)
    && decision;
  const approvedTpaAmount = decisionRecorded
    ? Math.max(0, toFixed2(Number(decision.approved_amount || 0)))
    : 0;
  const totalAuthority = toFixed2(approvedTpaAmount + allocations.amount);
  const outstanding = Math.max(
    0,
    toFixed2(authority.authoritativeAmount - totalAuthority),
  );
  let task = null;
  if (tpaMode && !decisionRecorded) {
    const stage = !claim
      ? 'claim_selection'
      : !['approved', 'partially_approved', 'paid'].includes(claim.status)
        ? 'claim_approval'
        : 'line_decision';
    task = await upsertPharmacyFundingTaskTx(tx, {
      authority, invoiceId: Number(invoice.id), invoiceItemId: Number(line.id),
      admissionId, taskType: 'tpa_line_decision', stage,
      assignedRole: 'INSURANCE_COORDINATOR',
      tpaClaimId: claim == null ? null : Number(claim.id),
      amountOutstanding: authority.authoritativeAmount,
    });
  } else if (outstanding > 0.001) {
    task = await upsertPharmacyFundingTaskTx(tx, {
      authority, invoiceId: Number(invoice.id), invoiceItemId: Number(line.id),
      admissionId, taskType: 'posted_payment',
      stage: tpaMode ? 'patient_responsibility_payment' : 'payment_posting',
      assignedRole: 'FINANCE_INCHARGE',
      tpaClaimId: claim == null ? null : Number(claim.id),
      amountOutstanding: outstanding,
    });
  }
  const status = (tpaMode ? decisionRecorded : true) && outstanding <= 0.001
    ? 'ready'
    : 'blocked';
  return {
    status,
    admissionId,
    invoiceId: Number(invoice.id),
    invoiceItemId: Number(line.id),
    tpaClaimId: claim == null ? null : Number(claim.id),
    task,
    decision,
    claimStatus: claim?.status ?? null,
    approvedTpaAmount,
    allocatedPaymentAmount: allocations.amount,
    paymentAllocations: allocations.rows,
    postedPayments: allocations.rows,
    fundingRecovery: status === 'blocked' ? {
      task_id: task?.id == null ? null : String(task.id),
      status: String(task?.status || 'open').toLowerCase(),
      task_type: task?.metadata?.task_type ?? (tpaMode ? 'tpa_line_decision' : 'posted_payment'),
      owner_role: task?.assigned_to_role ?? (tpaMode ? 'INSURANCE_COORDINATOR' : 'FINANCE_INCHARGE'),
      pharmacy_order_id: authority.orderId,
      invoice_id: Number(invoice.id),
      invoice_item_id: Number(line.id),
      tpa_claim_id: claim == null ? null : Number(claim.id),
      order_version: authority.orderVersion,
      order_items_sha256: authority.orderItemsSha256,
      amount_outstanding: outstanding,
      deep_link: pharmacyFundingDeepLink({
        orderId: authority.orderId,
        invoiceItemId: Number(line.id),
        tpaClaimId: claim == null ? null : Number(claim.id),
      }),
    } : null,
    authority,
  };
}

export async function materializePharmacyFundingAuthority({
  tenantId,
  orderId,
  actorUid,
  actorRole = null,
  tpaClaimId = null,
}) {
  const tid = requireTenantId(tenantId);
  const exactOrderId = Number(orderId);
  if (!Number.isInteger(exactOrderId) || exactOrderId <= 0 || !String(actorUid || '').trim()) {
    throw AppError.badRequest(
      'An exact pharmacy order and authenticated actor are required',
      'PHARMACY_FUNDING_MATERIALIZATION_AUTHORITY_REQUIRED',
    );
  }
  return setTenantTx(tid, async (tx) => {
    await lockTenantPatientMergeStability(tx, tid);
    const orderRows = await tx.$queryRawUnsafe(
      `SELECT pharmacy_order.id,pharmacy_order.patient_id,pharmacy_order.facility_id,
              pharmacy_order.total_amount,pharmacy_order.inventory_authority_version,
              pharmacy_order.items_list,pharmacy_order.payment_mode,
              pharmacy_order.payment_metadata,patient.uid AS patient_uid
         FROM pharmacy_orders pharmacy_order
         JOIN users patient
           ON patient.tenant_id=pharmacy_order.tenant_id
          AND patient.id=pharmacy_order.patient_id
          AND patient.role='PATIENT' AND patient.is_active=TRUE
          AND patient.status='active' AND patient.is_deleted=FALSE
          AND patient.merged_into_uid IS NULL
        WHERE pharmacy_order.tenant_id=$1::uuid AND pharmacy_order.id=$2::int
          AND (pharmacy_order.uid IS NULL OR pharmacy_order.uid=patient.uid)`,
      tid,
      exactOrderId,
    );
    if (orderRows.length !== 1) throw AppError.notFound('Pharmacy order not found');
    const order = orderRows[0];
    const paymentMode = String(
      order.payment_mode || order.payment_metadata?.payment_mode || '',
    ).trim().toLowerCase();
    return resolvePostedPharmacyFundingTx(tx, {
      tenantId: tid,
      facilityId: Number(order.facility_id),
      orderId: exactOrderId,
      patientId: Number(order.patient_id),
      patientUid: String(order.patient_uid),
      authoritativeAmount: Number(order.total_amount || 0),
      orderVersion: Number(order.inventory_authority_version),
      orderItemsSha256: clinicalOrderItemsSha256(order.items_list),
      paymentMode,
      tpaClaimId,
      tpaReference: order.payment_metadata?.tpa_reference,
      actorUid: String(actorUid),
      actorRole,
    });
  });
}

export async function resolvePostedPharmacyFundingTx(tx, rawArgs) {
  const result = await materializePharmacyFundingTaskTx(tx, rawArgs);
  const authority = result.authority;
  if (['invalidated', 'closed'].includes(result.status)) {
    return {
      status: result.status,
      collectedAmount: 0,
      fundedAmount: 0,
      fundingSource: null,
      fundingReference: null,
      fundingTpaClaimId: null,
      invoiceId: null,
      invoiceItemId: null,
      paymentIds: [],
      task: null,
      fundingRecovery: null,
      authorityEvidence: null,
    };
  }
  const allocations = await loadPharmacyPaymentAllocationsTx(tx, {
    tenantId: authority.tenantId,
    invoiceId: result.invoiceId,
    invoiceItemId: result.invoiceItemId,
    orderId: authority.orderId,
    orderVersion: authority.orderVersion,
    orderItemsSha256: authority.orderItemsSha256,
    patientUid: authority.patientUid,
  });
  const tpaMode = PHARMACY_TPA_PAYMENT_MODES.has(authority.paymentMode);
  const decisionAmount = tpaMode ? Number(result.approvedTpaAmount || 0) : 0;
  const totalAuthority = toFixed2(decisionAmount + allocations.amount);
  const funded = result.status === 'ready'
    && totalAuthority + 0.001 >= authority.authoritativeAmount;
  if (!funded) {
    return {
      status: 'blocked',
      collectedAmount: allocations.amount,
      fundedAmount: 0,
      fundingSource: null,
      fundingReference: null,
      fundingTpaClaimId: result.tpaClaimId,
      invoiceId: result.invoiceId,
      invoiceItemId: result.invoiceItemId,
      paymentIds: allocations.rows.map((row) => Number(row.payment_id)),
      task: result.task,
      fundingRecovery: result.fundingRecovery,
      authorityEvidence: null,
    };
  }
  const paymentIds = allocations.rows.map((row) => Number(row.payment_id));
  const fundingSource = tpaMode && allocations.amount > 0.001
    ? 'mixed'
    : tpaMode ? 'tpa_claim' : 'billing_payment';
  const fundingReference = [
    tpaMode ? `tpa:${result.tpaClaimId}` : null,
    paymentIds.length ? `payments:${paymentIds.join(',')}` : null,
  ].filter(Boolean).join(';');
  const evidence = {
    contract: 'pharmacy_funding_authority_v1',
    pharmacy_order_id: authority.orderId,
    invoice_id: result.invoiceId,
    invoice_item_id: result.invoiceItemId,
    tpa_claim_id: result.tpaClaimId,
    payment_ids: paymentIds,
    payment_allocation_ids: allocations.rows.map((row) => Number(row.allocation_id)),
    order_version: authority.orderVersion,
    order_items_sha256: authority.orderItemsSha256,
    authoritative_amount: authority.authoritativeAmount,
    allocated_payment_amount: allocations.amount,
    approved_tpa_amount: tpaMode ? decisionAmount : 0,
    combined_authority_amount: totalAuthority,
  };
  const task = await completePharmacyFundingTaskTx(tx, {
    tenantId: authority.tenantId,
    taskType: 'posted_payment',
    orderId: authority.orderId,
    evidence,
  });
  const authorityEvent = await appendPharmacyFundingAuthorityStateTx(tx, {
    authority,
    eventType: 'FUNDING_RESOLVED',
    admissionId: result.admissionId,
    invoiceId: result.invoiceId,
    invoiceItemId: result.invoiceItemId,
    tpaClaimId: result.tpaClaimId,
    billingPaymentId: allocations.rows.length === 1
      ? Number(allocations.rows[0].payment_id) : null,
    taskId: task?.id ?? null,
    amount: authority.authoritativeAmount,
    evidence,
  });
  return {
    status: 'funded',
    collectedAmount: allocations.amount,
    fundedAmount: authority.authoritativeAmount,
    fundingSource,
    fundingReference,
    fundingTpaClaimId: result.tpaClaimId,
    invoiceId: result.invoiceId,
    invoiceItemId: result.invoiceItemId,
    paymentIds,
    task,
    fundingRecovery: null,
    authorityEvidence: authorityEvent.evidence,
  };
}

export async function retryPharmacyFundingTask({
  tenantId,
  taskId,
  actorUid,
  paymentId = null,
  commandKeySha256,
}) {
  const tid = requireTenantId(tenantId);
  const command = String(commandKeySha256 || '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(command)) {
    throw AppError.badRequest(
      'A durable retry command identity is required',
      'PHARMACY_FUNDING_RETRY_COMMAND_REQUIRED',
    );
  }
  return setTenantTx(tid, async (tx) => {
    await lockTenantPatientMergeStability(tx, tid);
    const taskPreRead = await tx.$queryRawUnsafe(
      `SELECT *
         FROM tasks
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND related_resource_type='pharmacy_posted_payment'
          AND metadata->>'contract'=$3`,
      tid, Number(taskId), PHARMACY_FUNDING_TASK_CONTRACT,
    );
    if (!taskPreRead.length) throw AppError.notFound('Posted-payment recovery task not found');
    const orderId = Number(taskPreRead[0].related_resource_id);
    const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
      tenantId: tid,
      orderId,
    });
    await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
    await assertNoSubstitutionFundingAuthorityTx(tx, { tenantId: tid, orderId });
    const orderRows = await tx.$queryRawUnsafe(
      `SELECT po.id,po.patient_id,po.facility_id,po.payment_mode,po.payment_metadata,
              po.total_amount,po.inventory_authority_version,po.items_list,po.status,
              po.funding_admission_id,po.funding_admission_order_version,
              po.funding_admission_items_sha256,
              patient.uid AS patient_uid
         FROM pharmacy_orders po
         JOIN users patient
           ON patient.tenant_id=po.tenant_id AND patient.id=po.patient_id
          AND patient.role='PATIENT' AND patient.is_active=TRUE
          AND patient.status='active' AND patient.is_deleted=FALSE
          AND patient.merged_into_uid IS NULL
        WHERE po.tenant_id=$1::uuid AND po.id=$2::int
        FOR UPDATE OF po`,
      tid,
      orderId,
    );
    if (!orderRows.length) throw AppError.notFound('Pharmacy order not found');
    const order = orderRows[0];
    if (String(order.patient_uid) !== patientUid) {
      throw AppError.conflict(
        'The pharmacy order patient changed while retry authority was acquired',
        'PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH',
      );
    }
    const taskSnapshot = taskPreRead[0];
    if (taskSnapshot.assigned_to_role !== 'FINANCE_INCHARGE'
        || taskSnapshot.metadata?.contract !== 'pharmacy_funding_task_v1'
        || taskSnapshot.metadata?.task_type !== 'posted_payment') {
      throw AppError.conflict(
        'The task is not an exact finance-owned posted-payment recovery',
        'PHARMACY_PAYMENT_TASK_AUTHORITY_MISMATCH',
      );
    }
    const durablePaymentMode = String(
      order.payment_mode || order.payment_metadata?.payment_mode || '',
    ).trim().toLowerCase();
    const canonicalItemsSha256 = clinicalOrderItemsSha256(order.items_list);
    if (Number(taskSnapshot.metadata?.pharmacy_order_id) !== Number(order.id)
        || Number(taskSnapshot.metadata?.authoritative_amount) !== Number(order.total_amount)
        || Number(taskSnapshot.metadata?.order_version) !== Number(order.inventory_authority_version)
        || String(taskSnapshot.metadata?.order_items_sha256) !== canonicalItemsSha256
        || !durablePaymentMode) {
      throw AppError.conflict(
        'The payment recovery task is stale relative to the authoritative order',
        'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
      );
    }
    const authority = normalizePharmacyFundingAuthority({
      tenantId: tid,
      facilityId: Number(order.facility_id),
      orderId: Number(order.id),
      patientId: Number(order.patient_id),
      patientUid: String(order.patient_uid),
      authoritativeAmount: Number(taskSnapshot.metadata.authoritative_amount),
      orderVersion: Number(taskSnapshot.metadata.order_version),
      orderItemsSha256: String(taskSnapshot.metadata.order_items_sha256),
      paymentMode: durablePaymentMode,
      tpaClaimId: taskSnapshot.metadata.tpa_claim_id,
      paymentId,
      actorUid: String(actorUid),
    });
    const taskAdmissionId = taskSnapshot.metadata.admission_id == null
      ? null
      : Number(taskSnapshot.metadata.admission_id);
    const boundAdmissionId = order.funding_admission_id == null
      ? null
      : Number(order.funding_admission_id);
    if (taskAdmissionId !== boundAdmissionId
        || (boundAdmissionId != null
          && (Number(order.funding_admission_order_version) !== authority.orderVersion
            || String(order.funding_admission_items_sha256) !== authority.orderItemsSha256))) {
      throw AppError.conflict(
        'The payment recovery task no longer matches the governed order admission binding',
        'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
      );
    }
    const admissionDiscovery = taskAdmissionId == null
      ? null
      : (await tx.$queryRawUnsafe(
        `SELECT id,patient_uid,status
           FROM admissions
          WHERE tenant_id=$1::uuid AND id=$2::int AND patient_uid=$3::uuid`,
        tid,
        taskAdmissionId,
        patientUid,
      ))[0] || null;
    const claimDiscovery = taskSnapshot.metadata.tpa_claim_id == null
      ? null
      : (await tx.$queryRawUnsafe(
        `SELECT id,invoice_id,admission_id,patient_uid,status
           FROM tpa_claims
          WHERE tenant_id=$1::uuid AND id=$2::int`,
        tid,
        Number(taskSnapshot.metadata.tpa_claim_id),
      ))[0] || null;
    const invoiceRows = await lockPharmacyFundingInvoicesTx(tx, {
      tenantId: tid,
      invoiceIds: [Number(taskSnapshot.metadata.invoice_id)],
    });
    const itemRows = await lockPharmacyFundingInvoiceItemsTx(tx, {
      tenantId: tid,
      invoiceItemIds: [Number(taskSnapshot.metadata.invoice_item_id)],
    });
    const invoice = invoiceRows[0];
    const item = itemRows[0];
    if (invoiceRows.length !== 1 || itemRows.length !== 1
        || Number(item.invoice_id) !== Number(invoice.id)
        || String(invoice.patient_uid) !== patientUid
        || (invoice.admission_id == null ? null : Number(invoice.admission_id)) !== taskAdmissionId
        || invoice.status !== 'DRAFT'
        || item.source_ref_type !== 'pharmacy_order'
        || Number(item.source_ref_id) !== orderId
        || item.source_ref_active !== true
        || Number(item.source_authority_version) !== authority.orderVersion
        || String(item.source_authority_sha256) !== authority.orderItemsSha256
        || Math.abs(Number(item.line_total) - authority.authoritativeAmount) > 0.001) {
      throw AppError.conflict(
        'The payment recovery task no longer owns the exact editable pharmacy invoice line',
        'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
      );
    }
    if (taskAdmissionId != null) {
      const lockedAdmission = await lockPharmacyFundingAdmissionTx(tx, {
        tenantId: tid,
        admissionId: taskAdmissionId,
        patientUid,
      });
      if (!admissionDiscovery || lockedAdmission.status !== admissionDiscovery.status
          || lockedAdmission.status !== 'admitted') {
        throw AppError.conflict(
          'The payment recovery admission changed while invoice authority was locked',
          'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
        );
      }
    }
    await lockPharmacyFundingInvoiceChildrenTx(tx, {
      tenantId: tid,
      invoiceIds: [Number(invoice.id)],
    });
    if (taskSnapshot.metadata.tpa_claim_id != null) {
      const claimRows = await tx.$queryRawUnsafe(
        `SELECT id,invoice_id,admission_id,patient_uid,status FROM tpa_claims
          WHERE tenant_id=$1::uuid AND id=$2::int AND patient_uid=$3::uuid
            AND admission_id=$4::int AND invoice_id=$5::int
          FOR UPDATE`,
        tid,
        Number(taskSnapshot.metadata.tpa_claim_id),
        patientUid,
        taskAdmissionId,
        Number(taskSnapshot.metadata.invoice_id),
      );
      if (claimRows.length !== 1 || !claimDiscovery
          || Number(claimRows[0].invoice_id) !== Number(claimDiscovery.invoice_id)
          || Number(claimRows[0].admission_id) !== Number(claimDiscovery.admission_id)
          || String(claimRows[0].patient_uid) !== String(claimDiscovery.patient_uid)
          || String(claimRows[0].status) !== String(claimDiscovery.status)) {
        throw AppError.conflict(
          'The payment recovery task no longer matches the exact TPA claim authority',
          'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
        );
      }
    }
    await assertNoLivePharmacyAdvanceAllocationsTx(tx, { tenantId: tid, orderId });
    const taskRows = await tx.$queryRawUnsafe(
      `SELECT * FROM tasks
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND related_resource_type='pharmacy_posted_payment'
          AND related_resource_id=$3
          AND metadata->>'contract'=$4
        FOR UPDATE`,
      tid, Number(taskId), String(orderId), PHARMACY_FUNDING_TASK_CONTRACT,
    );
    if (!taskRows.length) throw AppError.notFound('Posted-payment recovery task not found');
    const task = taskRows[0];
    if (task.assigned_to_role !== 'FINANCE_INCHARGE'
        || task.metadata?.contract !== 'pharmacy_funding_task_v1'
        || task.metadata?.task_type !== 'posted_payment'
        || Number(task.metadata?.invoice_id) !== Number(taskSnapshot.metadata.invoice_id)
        || Number(task.metadata?.invoice_item_id) !== Number(taskSnapshot.metadata.invoice_item_id)
        || (task.metadata?.tpa_claim_id == null ? null : Number(task.metadata.tpa_claim_id))
          !== (taskSnapshot.metadata.tpa_claim_id == null
            ? null
            : Number(taskSnapshot.metadata.tpa_claim_id))
        || Number(task.metadata?.order_version) !== authority.orderVersion
        || String(task.metadata?.order_items_sha256) !== authority.orderItemsSha256) {
      throw AppError.conflict(
        'The task is not the exact finance-owned posted-payment recovery authority',
        'PHARMACY_PAYMENT_TASK_AUTHORITY_MISMATCH',
      );
    }
    await assertPharmacyFundingActorTx(tx, authority, new Set([
      'FINANCE_INCHARGE', 'BILLING_INCHARGE', 'ADMIN', 'SUPER_ADMIN',
    ]));
    const requestSha256 = pharmacyFundingHash('POSTED_PAYMENT_RETRY_REQUEST', {
      task_id: Number(taskId),
      order_id: authority.orderId,
      invoice_item_id: Number(task.metadata.invoice_item_id),
      payment_id: paymentId == null ? null : Number(paymentId),
      order_version: authority.orderVersion,
      order_items_sha256: authority.orderItemsSha256,
      actor_uid: authority.actorUid,
    });
    const receipt = await claimPharmacyFundingCommandTx(tx, {
      authority,
      commandKeySha256: command,
      commandType: 'POSTED_PAYMENT_RETRY',
      task,
      invoiceItemId: Number(task.metadata.invoice_item_id),
      tpaClaimId: task.metadata.tpa_claim_id,
      requestSha256,
    });
    if (receipt.status === 'COMPLETE') {
      return { ...receipt.response_body, replayed: true };
    }
    if (!['open', 'in_progress', 'blocked', 'overdue'].includes(task.status)) {
      throw AppError.conflict(
        'The posted-payment recovery task is no longer actionable',
        'PHARMACY_PAYMENT_TASK_ALREADY_COMPLETED',
      );
    }
    const materialized = await materializePharmacyFundingTaskTx(tx, authority);
    if (['invalidated', 'closed'].includes(materialized.status)) {
      const response = {
        status: materialized.status,
        collectedAmount: 0,
        fundedAmount: 0,
        fundingSource: null,
        fundingReference: null,
        fundingTpaClaimId: null,
        invoiceId: null,
        invoiceItemId: null,
        paymentIds: [],
        task: null,
        fundingRecovery: null,
        authorityEvidence: null,
        invalidatedAuthority: materialized.invalidatedAuthority,
        replayed: false,
        retryCommandSha256: command,
        requestSha256,
      };
      await completePharmacyFundingCommandTx(tx, {
        tenantId: tid,
        commandKeySha256: command,
        responseBody: response,
      });
      return response;
    }
    if (Number(materialized.invoiceItemId) !== Number(task.metadata.invoice_item_id)
        || (materialized.task && Number(materialized.task.id) !== Number(task.id))) {
      throw AppError.conflict(
        'The retry task no longer owns the exact draft invoice line',
        'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
      );
    }
    const amountRequired = PHARMACY_TPA_PAYMENT_MODES.has(authority.paymentMode)
      ? Math.max(0, toFixed2(authority.authoritativeAmount - materialized.approvedTpaAmount))
      : authority.authoritativeAmount;
    await allocatePostedPharmacyPaymentsTx(tx, {
      authority,
      invoiceId: materialized.invoiceId,
      invoiceItemId: materialized.invoiceItemId,
      amountRequired,
      paymentId,
      commandKeySha256: command,
    });
    const result = await resolvePostedPharmacyFundingTx(tx, authority);
    const response = {
      ...result,
      replayed: false,
      retryCommandSha256: command,
      requestSha256,
    };
    await completePharmacyFundingCommandTx(tx, {
      tenantId: tid,
      commandKeySha256: command,
      responseBody: response,
    });
    return response;
  });
}

export async function getPharmacyFundingRecovery({
  tenantId,
  orderId,
  invoiceItemId,
  tpaClaimId = null,
}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT task.id AS task_id,task.status AS task_status,
              task.assigned_to_role,task.related_resource_type,task.metadata,
              item.id AS invoice_item_id,item.invoice_id,item.line_total,
              invoice.patient_uid,invoice.status AS invoice_status,
              item.source_authority_version,item.source_authority_sha256,
              pharmacy_order.inventory_authority_version AS order_version,
              pharmacy_order.items_list AS order_items_list,
              pharmacy_order.funding_admission_id,
              claim.id AS authoritative_claim_id,
              decision.id AS decision_id,decision.claim_id,
              decision.approved_amount,decision.non_payable_amount,
              decision.reason_code,decision.reason_text,decision.recorded_at
         FROM billing_invoice_items item
         JOIN billing_invoices invoice
           ON invoice.tenant_id=item.tenant_id AND invoice.id=item.invoice_id
         JOIN pharmacy_orders pharmacy_order
           ON pharmacy_order.tenant_id=item.tenant_id
          AND pharmacy_order.id=$2::int
          AND item.source_ref_id=pharmacy_order.id::bigint
         JOIN users patient
           ON patient.tenant_id=invoice.tenant_id AND patient.uid=invoice.patient_uid
          AND patient.id=pharmacy_order.patient_id
          AND (pharmacy_order.uid IS NULL OR pharmacy_order.uid=patient.uid)
          AND patient.role='PATIENT' AND patient.is_active=TRUE
          AND patient.status='active' AND patient.is_deleted=FALSE
          AND patient.merged_into_uid IS NULL
         LEFT JOIN tpa_claims claim
           ON claim.tenant_id=item.tenant_id AND claim.id=$4::int
          AND claim.invoice_id=invoice.id
          AND claim.patient_uid=invoice.patient_uid
          AND claim.admission_id=invoice.admission_id
         LEFT JOIN tasks task
           ON task.tenant_id=item.tenant_id
          AND task.related_resource_id=$2
          AND task.related_resource_type IN ('pharmacy_tpa_line_decision','pharmacy_posted_payment')
          AND task.status IN (${ACTIVE_TASK_STATUSES})
          AND task.metadata->>'contract'=$5
          AND task.metadata->>'pharmacy_order_id'=$2
          AND (
            (task.related_resource_type='pharmacy_tpa_line_decision'
              AND task.metadata->>'task_type'='tpa_line_decision')
            OR
            (task.related_resource_type='pharmacy_posted_payment'
              AND task.metadata->>'task_type'='posted_payment')
          )
         LEFT JOIN tpa_claim_line_decisions decision
           ON decision.tenant_id=item.tenant_id AND decision.invoice_item_id=item.id
          AND decision.invalidated_at IS NULL
          AND ($4::int IS NULL OR decision.claim_id=$4::int)
        WHERE item.tenant_id=$1::uuid AND item.id=$3::int
          AND item.source_ref_type='pharmacy_order' AND item.source_ref_id=$2::bigint
          AND item.source_ref_active=TRUE
          AND item.source_authority_version=pharmacy_order.inventory_authority_version
          AND (
            (pharmacy_order.funding_admission_id IS NULL AND invoice.admission_id IS NULL
             AND $4::int IS NULL)
            OR
            (pharmacy_order.funding_admission_id=invoice.admission_id
             AND pharmacy_order.funding_admission_order_version=pharmacy_order.inventory_authority_version
             AND pharmacy_order.funding_admission_items_sha256=item.source_authority_sha256)
          )
          AND ($4::int IS NULL OR claim.id IS NOT NULL)
        ORDER BY task.id DESC NULLS LAST
        LIMIT 1`,
      tid,
      String(Number(orderId)),
      Number(invoiceItemId),
      tpaClaimId == null ? null : Number(tpaClaimId),
      PHARMACY_FUNDING_TASK_CONTRACT,
    );
    if (!rows.length
        || String(rows[0].source_authority_sha256 || '')
          !== clinicalOrderItemsSha256(rows[0].order_items_list)) {
      throw AppError.notFound('Pharmacy funding recovery not found');
    }
    return rows[0];
  });
}

export async function getPharmacyFundingReconciliationCase({ tenantId, caseId }) {
  const tid = requireTenantId(tenantId);
  const reconciliationId = Number(caseId);
  if (!Number.isInteger(reconciliationId) || reconciliationId <= 0) {
    throw AppError.badRequest(
      'A positive pharmacy funding reconciliation case id is required',
      'PHARMACY_FUNDING_RECONCILIATION_CASE_REQUIRED',
    );
  }
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT reconciliation.*,task.status AS task_status,
              task.assigned_to_role,task.metadata AS task_metadata,
              current_snapshot.snapshot AS current_snapshot,
              current_snapshot.snapshot_sha256 AS current_snapshot_sha256,
              current_snapshot.active_line_count
         FROM pharmacy_funding_reconciliation_cases reconciliation
         JOIN tasks task
           ON task.tenant_id=reconciliation.tenant_id
          AND task.id=reconciliation.task_id
          AND task.related_resource_type=reconciliation.task_resource_type
          AND task.related_resource_id=reconciliation.task_resource_id
         CROSS JOIN LATERAL public.pharmacy_funding_duplicate_line_snapshot_753(
           reconciliation.tenant_id,reconciliation.pharmacy_order_id
         ) current_snapshot
        WHERE reconciliation.tenant_id=$1::uuid AND reconciliation.id=$2::bigint`,
      tid,
      reconciliationId,
    );
    if (!rows.length) throw AppError.notFound('Pharmacy funding reconciliation case not found');
    return rows[0];
  });
}

function exactDuplicateLineResolutionState(snapshot, keeperInvoiceItemId) {
  const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
  const activeLines = lines.filter((line) => line.source_ref_active === true);
  const keeper = activeLines.find(
    (line) => Number(line.invoice_item_id) === Number(keeperInvoiceItemId),
  );
  const hasPostedPayments = lines.some(
    (line) => Array.isArray(line.payments) && line.payments.some(
      (payment) => payment.reversed !== true && Number(payment.amount || 0) > 0.001,
    ),
  );
  const hasAllocations = lines.some(
    (line) => Array.isArray(line.allocations) && line.allocations.some(
      (allocation) => (
        Number(allocation.allocated_amount || 0) - Number(allocation.reversed_amount || 0) > 0.001
      )),
  );
  const allDraft = lines.every((line) => line.invoice_status === 'DRAFT');
  const sameInvoice = new Set(activeLines.map((line) => Number(line.invoice_id))).size === 1;
  const comparable = (line) => JSON.stringify({
    description: line.description,
    category: line.category,
    quantity: String(line.quantity),
    unit_price: String(line.unit_price),
    line_total: String(line.line_total),
    source_authority_version: line.source_authority_version == null
      ? null : Number(line.source_authority_version),
    source_authority_sha256: line.source_authority_sha256 || null,
  });
  const identical = activeLines.length > 1
    && new Set(activeLines.map(comparable)).size === 1;
  return {
    lines,
    activeLines,
    keeper,
    hasPostedPayments,
    hasAllocations,
    allDraft,
    sameInvoice,
    identical,
  };
}

async function claimPharmacyFundingReconciliationEventTx(tx, {
  tenantId,
  caseId,
  pharmacyOrderId,
  eventType,
  snapshotSha256,
  proposalSha256,
  commandKeySha256,
  requestSha256,
  actorUid,
  evidence,
}) {
  await tx.$executeRawUnsafe(
    `INSERT INTO pharmacy_funding_reconciliation_events
      (tenant_id,case_id,pharmacy_order_id,event_type,snapshot_sha256,
       proposal_sha256,command_key_sha256,request_sha256,actor_uid,evidence)
     VALUES ($1::uuid,$2::bigint,$3::int,$4,$5,$6,$7,$8,$9::uuid,$10::jsonb)
     ON CONFLICT (tenant_id,command_key_sha256) DO NOTHING`,
    tenantId, Number(caseId), Number(pharmacyOrderId), eventType,
    snapshotSha256, proposalSha256, commandKeySha256, requestSha256,
    actorUid, JSON.stringify(evidence),
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT * FROM pharmacy_funding_reconciliation_events
      WHERE tenant_id=$1::uuid AND command_key_sha256=$2
      FOR UPDATE`,
    tenantId,
    commandKeySha256,
  );
  const receipt = rows[0];
  if (!receipt
      || Number(receipt.case_id) !== Number(caseId)
      || Number(receipt.pharmacy_order_id) !== Number(pharmacyOrderId)
      || receipt.event_type !== eventType
      || String(receipt.snapshot_sha256) !== snapshotSha256
      || (receipt.proposal_sha256 == null ? null : String(receipt.proposal_sha256))
        !== (proposalSha256 == null ? null : proposalSha256)
      || receipt.request_sha256 !== requestSha256
      || String(receipt.actor_uid) !== actorUid) {
    throw AppError.unprocessable(
      'The reconciliation command is already bound to different evidence or actor',
      'PHARMACY_FUNDING_RECONCILIATION_COMMAND_MISMATCH',
    );
  }
  return receipt;
}

export async function recordPharmacyFundingReconciliationDecision({
  tenantId,
  caseId,
  keeperInvoiceItemId,
  resolutionPath,
  expectedSnapshotSha256,
  actorUid,
  commandKeySha256,
}) {
  const tid = requireTenantId(tenantId);
  const reconciliationId = Number(caseId);
  const keeperId = Number(keeperInvoiceItemId);
  const path = String(resolutionPath || '').trim().toUpperCase();
  const expectedHash = String(expectedSnapshotSha256 || '').trim().toLowerCase();
  const command = String(commandKeySha256 || '').trim().toLowerCase();
  const actor = String(actorUid || '').trim();
  if (!Number.isInteger(reconciliationId) || reconciliationId <= 0
      || !Number.isInteger(keeperId) || keeperId <= 0
      || !PHARMACY_RECONCILIATION_PATHS.has(path)
      || !SHA256_PATTERN.test(expectedHash) || !SHA256_PATTERN.test(command) || !actor) {
    throw AppError.badRequest(
      'Exact reconciliation case, keeper, path, snapshot, actor, and command are required',
      'PHARMACY_FUNDING_RECONCILIATION_DECISION_INVALID',
    );
  }
  return setTenantTx(tid, async (tx) => {
    await lockTenantPatientMergeStability(tx, tid);
    const preRead = await tx.$queryRawUnsafe(
      `SELECT reconciliation.pharmacy_order_id,reconciliation.patient_uid
         FROM pharmacy_funding_reconciliation_cases reconciliation
        WHERE reconciliation.tenant_id=$1::uuid AND reconciliation.id=$2::bigint`,
      tid,
      reconciliationId,
    );
    if (!preRead.length) throw AppError.notFound('Pharmacy funding reconciliation case not found');
    const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
      tenantId: tid,
      orderId: Number(preRead[0].pharmacy_order_id),
      patientUid: String(preRead[0].patient_uid),
    });
    await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
    await assertNoSubstitutionFundingAuthorityTx(tx, {
      tenantId: tid,
      orderId: Number(preRead[0].pharmacy_order_id),
    });
    const orderRows = await tx.$queryRawUnsafe(
      `SELECT pharmacy_order.*
         FROM pharmacy_orders pharmacy_order
         JOIN users patient
           ON patient.tenant_id=pharmacy_order.tenant_id
          AND patient.id=pharmacy_order.patient_id AND patient.uid=$3::uuid
          AND patient.role='PATIENT' AND patient.is_active=TRUE
          AND patient.status='active' AND patient.is_deleted=FALSE
          AND patient.merged_into_uid IS NULL
        WHERE pharmacy_order.tenant_id=$1::uuid AND pharmacy_order.id=$2::int
        FOR UPDATE OF pharmacy_order`,
      tid,
      Number(preRead[0].pharmacy_order_id),
      patientUid,
    );
    if (!orderRows.length) {
      throw AppError.conflict(
        'The reconciliation order no longer belongs to its active tenant patient',
        'PHARMACY_FUNDING_RECONCILIATION_AUTHORITY_STALE',
      );
    }
    const order = orderRows[0];
    const admissionDiscovery = order.funding_admission_id == null
      ? null
      : (await tx.$queryRawUnsafe(
        `SELECT id,patient_uid,status
           FROM admissions
          WHERE tenant_id=$1::uuid AND id=$2::int AND patient_uid=$3::uuid`,
        tid,
        Number(order.funding_admission_id),
        patientUid,
      ))[0] || null;
    const discoveredLineRows = await tx.$queryRawUnsafe(
      `SELECT item.id,item.invoice_id
         FROM billing_invoice_items item
        WHERE item.tenant_id=$1::uuid AND item.source_ref_type='pharmacy_order'
          AND item.source_ref_id=$2::bigint
        ORDER BY item.id`,
      tid,
      Number(order.id),
    );
    const invoiceIds = [...new Set(discoveredLineRows.map(
      (line) => Number(line.invoice_id),
    ))].sort((left, right) => left - right);
    const lockedInvoices = await lockPharmacyFundingInvoicesTx(tx, {
      tenantId: tid,
      invoiceIds,
    });
    const lockedItems = await lockPharmacyFundingInvoiceItemsTx(tx, {
      tenantId: tid,
      invoiceItemIds: discoveredLineRows.map((line) => Number(line.id)),
    });
    const lineRows = exactLockedPharmacyFundingLines({
      discoveredLines: discoveredLineRows,
      invoices: lockedInvoices,
      items: lockedItems,
    });
    if (lineRows == null || lineRows.some((line) => (
      line.source_ref_type !== 'pharmacy_order'
        || Number(line.source_ref_id) !== Number(order.id)
    ))) {
      throw AppError.conflict(
        'The duplicate pharmacy invoice line set changed while it was locked',
        'PHARMACY_FUNDING_RECONCILIATION_AUTHORITY_STALE',
      );
    }
    if (order.funding_admission_id != null) {
      const lockedAdmission = await lockPharmacyFundingAdmissionTx(tx, {
        tenantId: tid,
        admissionId: Number(order.funding_admission_id),
        patientUid,
      });
      if (!admissionDiscovery || lockedAdmission.status !== admissionDiscovery.status) {
        throw AppError.conflict(
          'The reconciliation admission changed while invoice authority was locked',
          'PHARMACY_FUNDING_RECONCILIATION_AUTHORITY_STALE',
        );
      }
    }
    await lockPharmacyFundingInvoiceChildrenTx(tx, { tenantId: tid, invoiceIds });
    await tx.$queryRawUnsafe(
      `SELECT claim.id,decision.id AS decision_id
         FROM tpa_claims claim
         JOIN tpa_claim_line_decisions decision
           ON decision.tenant_id=claim.tenant_id AND decision.claim_id=claim.id
        WHERE claim.tenant_id=$1::uuid
          AND decision.invoice_item_id=ANY($2::int[])
        ORDER BY claim.id,decision.id
        FOR UPDATE OF claim,decision`,
      tid,
      lineRows.map((line) => Number(line.id)),
    );
    const paymentAllocationRows = await tx.$queryRawUnsafe(
      `SELECT id
         FROM pharmacy_payment_allocations
        WHERE tenant_id=$1::uuid AND invoice_item_id=ANY($2::int[])
        ORDER BY id
        FOR UPDATE`,
      tid,
      lineRows.map((line) => Number(line.id)),
    );
    if (paymentAllocationRows.length) {
      await tx.$queryRawUnsafe(
        `SELECT id
           FROM pharmacy_payment_allocation_reversals
          WHERE tenant_id=$1::uuid AND allocation_id=ANY($2::bigint[])
          ORDER BY allocation_id,id
          FOR UPDATE`,
        tid,
        paymentAllocationRows.map((allocation) => Number(allocation.id)),
      );
    }
    const liveAdvanceAllocations = await lockNetLivePharmacyAdvanceAllocationsTx(tx, {
      tenantId: tid,
      orderId: Number(order.id),
    });
    const caseRows = await tx.$queryRawUnsafe(
      `SELECT reconciliation.*,task.status AS task_status,
              task.assigned_to_role,task.metadata AS task_metadata
         FROM pharmacy_funding_reconciliation_cases reconciliation
         JOIN tasks task
           ON task.tenant_id=reconciliation.tenant_id
          AND task.id=reconciliation.task_id
          AND task.related_resource_type=reconciliation.task_resource_type
          AND task.related_resource_id=reconciliation.task_resource_id
        WHERE reconciliation.tenant_id=$1::uuid AND reconciliation.id=$2::bigint
          AND reconciliation.pharmacy_order_id=$3::int
        FOR UPDATE OF task,reconciliation`,
      tid,
      reconciliationId,
      Number(order.id),
    );
    if (!caseRows.length) throw AppError.notFound('Pharmacy funding reconciliation case not found');
    const reconciliation = caseRows[0];
    const actorRows = await tx.$queryRawUnsafe(
      `SELECT uid,UPPER(role) AS role FROM users
        WHERE tenant_id=$1::uuid AND uid=$2::uuid
          AND is_active=TRUE AND status='active' AND is_deleted=FALSE
          AND merged_into_uid IS NULL
        FOR KEY SHARE`,
      tid,
      actor,
    );
    if (!actorRows.length || !PHARMACY_RECONCILIATION_ROLES.has(actorRows[0].role)
        || reconciliation.assigned_to_role !== 'FINANCE_INCHARGE') {
      throw AppError.forbidden(
        'Duplicate pharmacy-line reconciliation requires a finance owner',
        'PHARMACY_FUNDING_RECONCILIATION_ACTOR_FORBIDDEN',
      );
    }
    const proposalSha256 = pharmacyFundingHash('PHARMACY_FUNDING_RECONCILIATION_PROPOSAL', {
      case_id: reconciliationId,
      pharmacy_order_id: Number(order.id),
      keeper_invoice_item_id: keeperId,
      resolution_path: path,
      snapshot_sha256: expectedHash,
    });
    const requestSha256 = pharmacyFundingHash('PHARMACY_FUNDING_RECONCILIATION_REQUEST', {
      proposal_sha256: proposalSha256,
      actor_uid: actor,
    });
    const existingReceipts = await tx.$queryRawUnsafe(
      `SELECT * FROM pharmacy_funding_reconciliation_events
        WHERE tenant_id=$1::uuid AND command_key_sha256=$2
        FOR UPDATE`,
      tid,
      command,
    );
    if (existingReceipts.length) {
      const receipt = existingReceipts[0];
      if (Number(receipt.case_id) !== reconciliationId
          || Number(receipt.pharmacy_order_id) !== Number(order.id)
          || String(receipt.snapshot_sha256) !== expectedHash
          || String(receipt.proposal_sha256 || '') !== proposalSha256
          || receipt.request_sha256 !== requestSha256
          || String(receipt.actor_uid) !== actor) {
        throw AppError.unprocessable(
          'The reconciliation command is already bound to a different request',
          'PHARMACY_FUNDING_RECONCILIATION_COMMAND_MISMATCH',
        );
      }
      const replayBody = reconciliation.status === 'RESOLVED' && reconciliation.outcome
        ? reconciliation.outcome
        : receipt.evidence?.response || reconciliation.outcome;
      return { ...replayBody, replayed: true };
    }
    if (reconciliation.status === 'RESOLVED') {
      return { ...(reconciliation.outcome || {}), status: 'resolved', replayed: true };
    }
    const snapshots = await tx.$queryRawUnsafe(
      `SELECT * FROM public.pharmacy_funding_duplicate_line_snapshot_753($1::uuid,$2::int)`,
      tid,
      Number(order.id),
    );
    const current = snapshots[0];
    if (!current || String(current.snapshot_sha256) !== expectedHash) {
      throw AppError.conflict(
        'Duplicate line, invoice, payment, allocation, or stock evidence changed',
        'PHARMACY_FUNDING_RECONCILIATION_SNAPSHOT_STALE',
        { current_snapshot_sha256: current?.snapshot_sha256 || null },
      );
    }
    if (['OPEN', 'BLOCKED'].includes(reconciliation.status)) {
      const response = {
        status: 'pending_second_approval',
        replayed: false,
        caseId: reconciliationId,
        taskId: Number(reconciliation.task_id),
        proposalSha256,
        snapshotSha256: expectedHash,
        resolutionPath: path,
        keeperInvoiceItemId: keeperId,
      };
      const receipt = await claimPharmacyFundingReconciliationEventTx(tx, {
        tenantId: tid,
        caseId: reconciliationId,
        pharmacyOrderId: Number(order.id),
        eventType: 'PROPOSED',
        snapshotSha256: expectedHash,
        proposalSha256,
        commandKeySha256: command,
        requestSha256,
        actorUid: actor,
        evidence: { contract: 'pharmacy_funding_reconciliation_proposal_v1', response },
      });
      if (receipt.evidence?.response?.proposalSha256 === proposalSha256
          && String(reconciliation.proposal_sha256 || '') === proposalSha256) {
        return { ...receipt.evidence.response, replayed: true };
      }
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_funding_reconciliation_cases
            SET status='PENDING_APPROVAL',snapshot_sha256=$3,snapshot=$4::jsonb,
                resolution_path=$5,keeper_invoice_item_id=$6::int,
                proposal_sha256=$7,proposed_by=$8::uuid,proposed_at=NOW(),
                approved_by=NULL,resolved_at=NULL,outcome=NULL,updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::bigint`,
        tid, reconciliationId, expectedHash, JSON.stringify(current.snapshot), path,
        keeperId, proposalSha256, actor,
      );
      return response;
    }
    if (reconciliation.status !== 'PENDING_APPROVAL'
        || String(reconciliation.proposal_sha256) !== proposalSha256
        || reconciliation.resolution_path !== path
        || Number(reconciliation.keeper_invoice_item_id) !== keeperId) {
      throw AppError.conflict(
        'The second approval does not match the exact pending proposal',
        'PHARMACY_FUNDING_RECONCILIATION_PROPOSAL_MISMATCH',
      );
    }
    if (String(reconciliation.proposed_by) === actor) {
      throw AppError.forbidden(
        'A distinct finance owner must approve this reconciliation proposal',
        'PHARMACY_FUNDING_RECONCILIATION_SECOND_ACTOR_REQUIRED',
      );
    }
    const state = exactDuplicateLineResolutionState(current.snapshot, keeperId);
    const terminalStatus = String(order.status || '').toUpperCase();
    const currentItemsSha256 = clinicalOrderItemsSha256(order.items_list);
    const exactAdmissionId = order.funding_admission_id == null
      ? null : Number(order.funding_admission_id);
    const keeperMatchesCurrentAuthority = state.keeper != null
      && String(state.keeper.patient_uid) === patientUid
      && (state.keeper.admission_id == null ? null : Number(state.keeper.admission_id))
        === exactAdmissionId
      && Number(state.keeper.source_authority_version)
        === Number(order.inventory_authority_version)
      && String(state.keeper.source_authority_sha256 || '') === currentItemsSha256
      && Math.abs(Number(state.keeper.line_total || 0) - Number(order.total_amount || 0)) <= 0.001
      && Number(current.snapshot.order_version) === Number(order.inventory_authority_version)
      && (current.snapshot.funding_admission_id == null
        ? null : Number(current.snapshot.funding_admission_id)) === exactAdmissionId
      && (exactAdmissionId == null
        ? current.snapshot.funding_admission_order_version == null
          && current.snapshot.funding_admission_items_sha256 == null
        : Number(current.snapshot.funding_admission_order_version)
            === Number(order.inventory_authority_version)
          && String(current.snapshot.funding_admission_items_sha256 || '')
            === currentItemsSha256);
    let blockReason = null;
    let deactivatedIds = [];
    let voidedInvoiceIds = [];
    let monetaryCompensations = [];
    const recomputedInvoices = [];
    let invalidatedTpaDecisionIds = [];
    let terminalCompensation = null;
    if (liveAdvanceAllocations.length) {
      blockReason = 'LIVE_ADVANCE_ALLOCATION_REQUIRES_GOVERNED_RELEASE_OR_CONVERSION';
    }
    if (!state.keeper) blockReason = 'KEEPER_NOT_ACTIVE';
    if (state.keeper && !keeperMatchesCurrentAuthority) {
      blockReason = 'KEEPER_DOES_NOT_MATCH_CURRENT_ORDER_AUTHORITY';
    }
    if (path === 'SAFE_DEACTIVATE_DUPLICATES'
        && (!state.sameInvoice || !state.identical)) {
      blockReason = 'SAFE_RECONCILIATION_REQUIRES_IDENTICAL_SAME_INVOICE_LINES';
    }
    if (['SAFE_DEACTIVATE_DUPLICATES', 'KEEP_CURRENT_AUTHORITY'].includes(path)
        && (!state.allDraft || state.hasPostedPayments || state.hasAllocations)) {
      blockReason = 'ISSUED_PAYMENT_OR_ALLOCATION_LINKED_LINES_REQUIRE_REBILL_OR_CANCEL';
    }
    if (path === 'REBILL'
        && (state.activeLines.length !== 1 || !state.allDraft
          || state.hasPostedPayments || state.hasAllocations)) {
      blockReason = 'REBILL_CORRECTION_IS_NOT_ONE_UNPAID_DRAFT_AUTHORITY';
    }
    if (path === 'CANCEL_ORDER'
        && !['CANCELLED', 'UNAVAILABLE', 'REJECTED'].includes(terminalStatus)) {
      blockReason = 'ORDER_IS_NOT_TERMINAL_CANCELLED';
    }
    if (path === 'CANCEL_ORDER' && !blockReason) {
      // Every precondition on this path is evaluated BEFORE the mutation and
      // recorded as a governed outcome, never thrown: a throw rolls the
      // transaction back, so the case keeps its prior status with no BLOCKED
      // evidence row and no task metadata, and the operator gets a bare 409
      // with nothing to act on. Stock evidence is read first because
      // compensateTerminalPharmacyFundingAuthorityTx gives it precedence over
      // the line and finance-reversal conflicts, and because it is the one
      // condition here that no later finance action can clear.
      const stockMovementIds = await lockPharmacyStockMovementEvidenceTx(tx, {
        tenantId: tid,
        orderId: Number(order.id),
      });
      if (stockMovementIds.length) {
        blockReason = 'STOCK_MOVEMENT_EVIDENCE_FORBIDS_TERMINAL_FUNDING_COMPENSATION';
      } else if (!state.allDraft || state.hasPostedPayments) {
        blockReason = 'FINALIZED_OR_PAID_INVOICE_REQUIRES_GOVERNED_REVERSAL';
      } else if (invoiceIds.length) {
        const lockedInvoices = await tx.$queryRawUnsafe(
          `SELECT id,status
             FROM billing_invoices
            WHERE tenant_id=$1::uuid AND id=ANY($2::int[])
            ORDER BY id
            FOR UPDATE`,
          tid,
          invoiceIds,
        );
        const invoiceSafetyRows = await tx.$queryRawUnsafe(
          `SELECT invoice.id,invoice.status,
                  COUNT(item.id) FILTER (
                    WHERE item.source_ref_active=TRUE
                      AND NOT (item.source_ref_type='pharmacy_order'
                               AND item.source_ref_id=$3::bigint)
                  )::int AS unrelated_active_items
             FROM billing_invoices invoice
             LEFT JOIN billing_invoice_items item
               ON item.tenant_id=invoice.tenant_id AND item.invoice_id=invoice.id
            WHERE invoice.tenant_id=$1::uuid AND invoice.id=ANY($2::int[])
            GROUP BY invoice.id,invoice.status
            ORDER BY invoice.id`,
          tid,
          invoiceIds,
          Number(order.id),
        );
        if (lockedInvoices.length !== invoiceIds.length
            || lockedInvoices.some((invoice) => invoice.status !== 'DRAFT')
            || invoiceSafetyRows.length !== lockedInvoices.length
            || invoiceSafetyRows.some((invoice) => invoice.status !== 'DRAFT'
              || Number(invoice.unrelated_active_items) > 0)) {
          blockReason = 'INVOICE_CONTAINS_FINALIZED_OR_UNRELATED_ACTIVE_AUTHORITY';
        }
      }
      if (!blockReason) {
        terminalCompensation = await invalidateTerminalPharmacyFundingAuthorityTx(tx, {
          authority: {
            tenantId: tid, facilityId: Number(order.facility_id), orderId: Number(order.id),
            actorUid: actor,
          },
          order,
          actorRole: actorRows[0].role,
        });
      }
    }
    if (blockReason) {
      const response = {
        status: 'blocked', replayed: false, caseId: reconciliationId,
        taskId: Number(reconciliation.task_id), proposalSha256,
        snapshotSha256: expectedHash, blockReason,
        terminalCompensation,
      };
      await claimPharmacyFundingReconciliationEventTx(tx, {
        tenantId: tid, caseId: reconciliationId, pharmacyOrderId: Number(order.id),
        eventType: 'BLOCKED', snapshotSha256: expectedHash, proposalSha256,
        commandKeySha256: command, requestSha256, actorUid: actor,
        evidence: { contract: 'pharmacy_funding_reconciliation_blocked_v1', response },
      });
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_funding_reconciliation_cases
            SET status='BLOCKED',outcome=$3::jsonb,updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::bigint`,
        tid, reconciliationId, JSON.stringify(response),
      );
      await tx.$executeRawUnsafe(
        `UPDATE tasks SET status='blocked',metadata=metadata || $3::jsonb,updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=$2::int`,
        tid, Number(reconciliation.task_id),
        JSON.stringify({ reconciliation_block_reason: blockReason }),
      );
      return response;
    }
    const response = {
      status: 'resolved', replayed: false, caseId: reconciliationId,
      taskId: Number(reconciliation.task_id), proposalSha256,
      snapshotSha256: expectedHash, resolutionPath: path,
      keeperInvoiceItemId: keeperId,
    };
    const approvalReceipt = await claimPharmacyFundingReconciliationEventTx(tx, {
      tenantId: tid, caseId: reconciliationId, pharmacyOrderId: Number(order.id),
      eventType: 'APPROVED', snapshotSha256: expectedHash, proposalSha256,
      commandKeySha256: command, requestSha256, actorUid: actor,
      evidence: { contract: 'pharmacy_funding_reconciliation_approval_v1', response },
    });
    if (approvalReceipt.evidence?.response?.status === 'resolved'
        && reconciliation.status === 'RESOLVED') {
      return { ...approvalReceipt.evidence.response, replayed: true };
    }
    if (['SAFE_DEACTIVATE_DUPLICATES', 'KEEP_CURRENT_AUTHORITY', 'CANCEL_ORDER', 'REBILL']
      .includes(path)) {
      const retainKeeper = path !== 'CANCEL_ORDER';
      const rebillCompensableLines = path === 'REBILL'
        ? lineRows.filter((line) => !line.source_ref_active
          && Number(line.id) !== keeperId
          && [line.unit_price, line.line_subtotal, line.cgst_amount, line.sgst_amount,
            line.igst_amount, line.line_total].some((amount) => Math.abs(Number(amount || 0)) > 0.001))
        : [];
      const rows = path === 'REBILL'
        ? await tx.$queryRawUnsafe(
          `UPDATE billing_invoice_items
              SET source_ref_reconciliation_case_id=COALESCE(source_ref_reconciliation_case_id,$3::bigint),
                  unit_price=0,line_subtotal=0,cgst_amount=0,sgst_amount=0,
                  igst_amount=0,line_total=0,
                  notes=CONCAT_WS(E'\n',NULLIF(notes,''),$5)
            WHERE tenant_id=$1::uuid AND source_ref_type='pharmacy_order'
              AND source_ref_id=$2::bigint AND source_ref_active=FALSE
              AND id<>$4::int
              AND (unit_price<>0 OR line_subtotal<>0 OR cgst_amount<>0
                   OR sgst_amount<>0 OR igst_amount<>0 OR line_total<>0)
            RETURNING id,invoice_id,line_total`,
          tid,
          Number(order.id),
          reconciliationId,
          keeperId,
          `Governed rebill monetary compensation; reconciliation case ${reconciliationId}`,
        )
        : await tx.$queryRawUnsafe(
          `UPDATE billing_invoice_items
              SET source_ref_active=FALSE,
                  source_ref_reconciliation_case_id=$3::bigint,
                  source_ref_deactivated_at=NOW(),source_ref_deactivated_by=$4::uuid,
                  unit_price=0,line_subtotal=0,cgst_amount=0,sgst_amount=0,
                  igst_amount=0,line_total=0,
                  notes=CONCAT_WS(E'\n',NULLIF(notes,''),$7)
            WHERE tenant_id=$1::uuid AND source_ref_type='pharmacy_order'
              AND source_ref_id=$2::bigint AND source_ref_active=TRUE
              AND ($5::boolean=FALSE OR id<>$6::int)
            RETURNING id,invoice_id,line_total`,
          tid, Number(order.id), reconciliationId, actor, retainKeeper, keeperId,
          `Governed duplicate-line monetary compensation; reconciliation case ${reconciliationId}`,
        );
      deactivatedIds = rows.map((row) => Number(row.id));
      const deactivatedSet = new Set(deactivatedIds);
      monetaryCompensations = lineRows
        .filter((line) => deactivatedSet.has(Number(line.id)))
        .map((line) => ({
          invoiceItemId: Number(line.id),
          invoiceId: Number(line.invoice_id),
          priorQuantity: Number(line.quantity),
          priorUnitPrice: Number(line.unit_price),
          priorLineSubtotal: Number(line.line_subtotal),
          priorCgstAmount: Number(line.cgst_amount),
          priorSgstAmount: Number(line.sgst_amount),
          priorIgstAmount: Number(line.igst_amount),
          priorLineTotal: Number(line.line_total),
          resultingLineTotal: 0,
        }));
      const expectedDeactivated = path === 'REBILL'
        ? rebillCompensableLines.length
        : retainKeeper ? state.activeLines.length - 1 : state.activeLines.length;
      if (deactivatedIds.length !== expectedDeactivated) {
        throw AppError.conflict(
          'The duplicate line set changed before governed deactivation',
          'PHARMACY_FUNDING_RECONCILIATION_AUTHORITY_STALE',
        );
      }
      const zeroRows = await tx.$queryRawUnsafe(
        `SELECT id FROM billing_invoice_items
          WHERE tenant_id=$1::uuid AND id=ANY($2::int[])
            AND source_ref_active=FALSE
            AND unit_price=0 AND line_subtotal=0 AND cgst_amount=0
            AND sgst_amount=0 AND igst_amount=0 AND line_total=0
          ORDER BY id`,
        tid,
        deactivatedIds,
      );
      if (zeroRows.length !== deactivatedIds.length) {
        throw AppError.conflict(
          'Governed duplicate lines did not reach a zero-billable monetary state',
          'PHARMACY_FUNDING_RECONCILIATION_MONETARY_COMPENSATION_FAILED',
        );
      }
      if (deactivatedIds.length) {
        const invalidatedDecisionRows = await tx.$queryRawUnsafe(
          `UPDATE tpa_claim_line_decisions
              SET invalidated_at=NOW(),invalidated_by=$3::uuid
            WHERE tenant_id=$1::uuid AND invoice_item_id=ANY($2::int[])
              AND invalidated_at IS NULL
            RETURNING id`,
          tid,
          deactivatedIds,
          actor,
        );
        invalidatedTpaDecisionIds = invalidatedDecisionRows
          .map((decision) => Number(decision.id));
      }
      for (const invoiceId of invoiceIds) {
        const totals = await recomputeInvoiceTotals(invoiceId, tx, { emitTpaAlert: false });
        recomputedInvoices.push({ invoiceId, ...totals });
      }
    }
    if (path === 'CANCEL_ORDER') {
      const voidRows = await tx.$queryRawUnsafe(
        `UPDATE billing_invoices
            SET status='VOID',voided_at=NOW(),voided_by=$3::uuid,
                void_reason=$4,updated_at=NOW()
          WHERE tenant_id=$1::uuid AND id=ANY($2::int[]) AND status='DRAFT'
          RETURNING id`,
        tid,
        invoiceIds,
        actor,
        `Terminal pharmacy order ${Number(order.id)} duplicate-line reconciliation`,
      );
      voidedInvoiceIds = voidRows.map((invoice) => Number(invoice.id));
      if (voidedInvoiceIds.length !== invoiceIds.length) {
        throw AppError.conflict(
          'The exact draft invoice set changed before terminal void compensation',
          'PHARMACY_FUNDING_RECONCILIATION_AUTHORITY_STALE',
        );
      }
    } else if (invoiceIds.length) {
      const voidRows = await tx.$queryRawUnsafe(
        `UPDATE billing_invoices invoice
            SET status='VOID',voided_at=NOW(),voided_by=$3::uuid,
                void_reason=$4,updated_at=NOW()
          WHERE invoice.tenant_id=$1::uuid AND invoice.id=ANY($2::int[])
            AND invoice.status='DRAFT'
            AND NOT EXISTS (
              SELECT 1 FROM billing_invoice_items item
               WHERE item.tenant_id=invoice.tenant_id AND item.invoice_id=invoice.id
                 AND item.source_ref_active=TRUE
            )
          RETURNING invoice.id`,
        tid,
        invoiceIds,
        actor,
        `Empty draft after pharmacy funding reconciliation case ${reconciliationId}`,
      );
      voidedInvoiceIds = voidRows.map((invoice) => Number(invoice.id));
    }
    const activeAfterRows = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS active_count
         FROM billing_invoice_items
        WHERE tenant_id=$1::uuid AND source_ref_type='pharmacy_order'
          AND source_ref_id=$2::bigint AND source_ref_active=TRUE`,
      tid,
      Number(order.id),
    );
    const expectedActiveAfter = path === 'CANCEL_ORDER' ? 0 : 1;
    if (['SAFE_DEACTIVATE_DUPLICATES', 'KEEP_CURRENT_AUTHORITY', 'CANCEL_ORDER', 'REBILL']
      .includes(path)
        && Number(activeAfterRows[0]?.active_count) !== expectedActiveAfter) {
      throw AppError.conflict(
        'The governed duplicate-line disposition did not leave the required active authority count',
        'PHARMACY_FUNDING_RECONCILIATION_AUTHORITY_STALE',
      );
    }
    const outcome = {
      ...response,
      deactivatedInvoiceItemIds: deactivatedIds,
      voidedInvoiceIds,
      monetaryCompensations,
      recomputedInvoices,
      invalidatedTpaDecisionIds,
      terminalCompensation,
    };
    await tx.$executeRawUnsafe(
      `UPDATE pharmacy_funding_reconciliation_cases
          SET status='RESOLVED',approved_by=$3::uuid,resolved_at=NOW(),
              outcome=$4::jsonb,updated_at=NOW()
        WHERE tenant_id=$1::uuid AND id=$2::bigint`,
      tid, reconciliationId, actor, JSON.stringify(outcome),
    );
    await tx.$executeRawUnsafe(
      `UPDATE tasks SET status='completed',completed_at=NOW(),updated_at=NOW(),
              metadata=metadata || $3::jsonb
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND related_resource_type='pharmacy_funding_reconciliation'`,
      tid, Number(reconciliation.task_id),
      JSON.stringify({ reconciliation_outcome: outcome }),
    );
    const resolvedCommand = pharmacyFundingHash('PHARMACY_FUNDING_RECONCILIATION_RESOLVED', {
      command_key_sha256: command,
      proposal_sha256: proposalSha256,
    });
    await tx.$executeRawUnsafe(
      `INSERT INTO pharmacy_funding_reconciliation_events
        (tenant_id,case_id,pharmacy_order_id,event_type,snapshot_sha256,
         proposal_sha256,command_key_sha256,request_sha256,actor_uid,evidence)
       VALUES ($1::uuid,$2::bigint,$3::int,'RESOLVED',$4,$5,$6,$7,$8::uuid,$9::jsonb)`,
      tid, reconciliationId, Number(order.id), expectedHash, proposalSha256,
      resolvedCommand, requestSha256, actor,
      JSON.stringify({ contract: 'pharmacy_funding_reconciliation_resolved_v1', outcome }),
    );
    return outcome;
  });
}

export async function recordPharmacyFundingLineDecision({
  tenantId,
  taskId,
  orderId,
  invoiceItemId,
  tpaClaimId,
  orderVersion,
  orderItemsSha256,
  approvedAmount,
  nonPayableAmount,
  reasonCode,
  reasonText = null,
  actorUid,
  commandKeySha256,
}) {
  const tid = requireTenantId(tenantId);
  const parsedApproved = Number(approvedAmount);
  const parsedNonPayable = Number(nonPayableAmount);
  const command = String(commandKeySha256 || '').trim().toLowerCase();
  let amountsHaveExactPaisePrecision = true;
  let approvedPaise;
  let nonPayablePaise;
  try {
    if (parsedApproved > 0) requireValidAmount(approvedAmount, 'approvedAmount');
    if (parsedNonPayable > 0) requireValidAmount(nonPayableAmount, 'nonPayableAmount');
    approvedPaise = toPaise(
      typeof approvedAmount === 'number' ? approvedAmount : String(approvedAmount).trim(),
    );
    nonPayablePaise = toPaise(
      typeof nonPayableAmount === 'number' ? nonPayableAmount : String(nonPayableAmount).trim(),
    );
  } catch {
    amountsHaveExactPaisePrecision = false;
  }
  if (!amountsHaveExactPaisePrecision
      || !Number.isFinite(parsedApproved) || parsedApproved < 0
      || !Number.isFinite(parsedNonPayable) || parsedNonPayable < 0
      || (parsedApproved !== 0 && approvedPaise === 0)
      || (parsedNonPayable !== 0 && nonPayablePaise === 0)
      || !Number.isInteger(Number(taskId)) || Number(taskId) <= 0
      || !Number.isInteger(Number(orderId)) || Number(orderId) <= 0
      || !Number.isInteger(Number(invoiceItemId)) || Number(invoiceItemId) <= 0
      || !Number.isInteger(Number(tpaClaimId)) || Number(tpaClaimId) <= 0
      || !Number.isInteger(Number(orderVersion)) || Number(orderVersion) <= 0
      || !SHA256_PATTERN.test(String(orderItemsSha256 || '').trim().toLowerCase())
      || !SHA256_PATTERN.test(command) || !PHARMACY_TPA_REASON_CODES.has(String(reasonCode))) {
    throw AppError.badRequest(
      'Valid approved/non-payable amounts and idempotency hash are required',
      'PHARMACY_TPA_LINE_DECISION_INVALID',
    );
  }
  const approved = approvedPaise / 100;
  const nonPayable = nonPayablePaise / 100;
  return setTenantTx(tid, async (tx) => {
    await lockTenantPatientMergeStability(tx, tid);
    const canonicalPatientUid = await resolvePharmacyFundingPatientUidTx(tx, {
      tenantId: tid,
      orderId: Number(orderId),
    });
    await lockPharmacyFundingAuthorityTx(tx, {
      tenantId: tid,
      patientUid: canonicalPatientUid,
    });
    await assertNoSubstitutionFundingAuthorityTx(tx, {
      tenantId: tid,
      orderId: Number(orderId),
    });
    const orderRows = await tx.$queryRawUnsafe(
      `SELECT pharmacy_order.*,patient.uid AS patient_uid
         FROM pharmacy_orders pharmacy_order
         JOIN users patient
           ON patient.tenant_id=pharmacy_order.tenant_id
          AND patient.id=pharmacy_order.patient_id
          AND patient.role='PATIENT' AND patient.is_active=TRUE
          AND patient.status='active' AND patient.is_deleted=FALSE
          AND patient.merged_into_uid IS NULL
        WHERE pharmacy_order.tenant_id=$1::uuid AND pharmacy_order.id=$2::int
        FOR UPDATE OF pharmacy_order`,
      tid, Number(orderId),
    );
    if (!orderRows.length || String(orderRows[0].patient_uid) !== canonicalPatientUid) {
      throw AppError.conflict(
        'The pharmacy order no longer belongs to one active tenant patient',
        'PHARMACY_FUNDING_ORDER_SCOPE_MISMATCH',
      );
    }
    const order = orderRows[0];
    const durablePaymentMode = String(
      order.payment_mode || order.payment_metadata?.payment_mode || '',
    ).trim().toLowerCase();
    const canonicalItemsSha256 = clinicalOrderItemsSha256(order.items_list);
    const authority = normalizePharmacyFundingAuthority({
      tenantId: tid,
      facilityId: Number(order.facility_id),
      orderId: Number(order.id),
      patientId: Number(order.patient_id),
      patientUid: canonicalPatientUid,
      authoritativeAmount: Number(order.total_amount),
      orderVersion: Number(orderVersion),
      orderItemsSha256: String(orderItemsSha256).trim().toLowerCase(),
      paymentMode: durablePaymentMode,
      tpaClaimId: Number(tpaClaimId),
      tpaReference: order.payment_metadata?.tpa_reference,
      actorUid: String(actorUid),
    });
    if (!PHARMACY_TPA_PAYMENT_MODES.has(durablePaymentMode)
        || Number(order.inventory_authority_version) !== authority.orderVersion
        || canonicalItemsSha256 !== authority.orderItemsSha256) {
      throw AppError.conflict(
        'The line decision does not match the current TPA order authority',
        'PHARMACY_TPA_LINE_AUTHORITY_STALE',
      );
    }
    const actor = await assertPharmacyFundingActorTx(
      tx,
      authority,
      PHARMACY_TPA_DECISION_ROLES,
    );
    const preIssueStatuses = new Set([
      'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED', 'PARTIALLY_DISPENSED',
    ]);
    const orderStatus = String(order.status).toUpperCase();
    const orderActionable = preIssueStatuses.has(orderStatus);
    if (!orderActionable
        && !['CANCELLED', 'UNAVAILABLE', 'REJECTED', 'DISPENSED', 'DELIVERED'].includes(orderStatus)) {
      throw AppError.conflict(
        `Pharmacy funding cannot mutate an order in ${orderStatus} state`,
        'PHARMACY_FUNDING_ORDER_NOT_ACTIONABLE',
      );
    }
    if (order.funding_admission_id == null) {
      throw AppError.conflict(
        'TPA line decisions require an exact governed order-to-admission binding',
        'PHARMACY_FUNDING_ADMISSION_REQUIRED',
      );
    }
    const admissionDiscovery = (await tx.$queryRawUnsafe(
      `SELECT id,patient_uid,status
         FROM admissions
        WHERE tenant_id=$1::uuid AND id=$2::int AND patient_uid=$3::uuid`,
      tid,
      Number(order.funding_admission_id),
      canonicalPatientUid,
    ))[0] || null;
    const lineDiscovery = (await tx.$queryRawUnsafe(
      `SELECT id,invoice_id
         FROM billing_invoice_items
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND source_ref_type='pharmacy_order' AND source_ref_id=$3::bigint
          AND source_ref_active=TRUE`,
      tid,
      Number(invoiceItemId),
      Number(orderId),
    ))[0] || null;
    if (!lineDiscovery) throw AppError.notFound('Pharmacy invoice item not found');
    const claimDiscovery = (await tx.$queryRawUnsafe(
      `SELECT id,invoice_id,admission_id,patient_uid,status
         FROM tpa_claims
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      tid,
      Number(tpaClaimId),
    ))[0] || null;
    const invoiceRows = await lockPharmacyFundingInvoicesTx(tx, {
      tenantId: tid,
      invoiceIds: [Number(lineDiscovery.invoice_id)],
    });
    const itemRows = await lockPharmacyFundingInvoiceItemsTx(tx, {
      tenantId: tid,
      invoiceItemIds: [Number(lineDiscovery.id)],
    });
    const lineRows = exactLockedPharmacyFundingLines({
      discoveredLines: [lineDiscovery],
      invoices: invoiceRows,
      items: itemRows,
    });
    if (lineRows == null) {
      throw AppError.conflict(
        'The line decision invoice authority changed while it was locked',
        'PHARMACY_TPA_LINE_AUTHORITY_STALE',
      );
    }
    const line = lineRows[0];
    if (line.invoice_status !== 'DRAFT'
        || String(line.patient_uid) !== canonicalPatientUid
        || Number(line.admission_id) !== Number(order.funding_admission_id)
        || line.source_ref_type !== 'pharmacy_order'
        || Number(line.source_ref_id) !== Number(orderId)
        || line.source_ref_active !== true
        || Number(line.source_authority_version) !== Number(orderVersion)
        || String(line.source_authority_sha256) !== authority.orderItemsSha256
        || Math.abs(Number(line.line_total) - approved - nonPayable) > 0.001) {
      throw AppError.conflict(
        'The line decision is not balanced to the current draft order authority',
        'PHARMACY_TPA_LINE_AUTHORITY_STALE',
      );
    }
    const lockedAdmission = await lockPharmacyFundingAdmissionTx(tx, {
      tenantId: tid,
      admissionId: Number(order.funding_admission_id),
      patientUid: canonicalPatientUid,
    });
    if (!admissionDiscovery || lockedAdmission.status !== admissionDiscovery.status) {
      throw AppError.conflict(
        'The line decision admission changed while invoice authority was locked',
        'PHARMACY_TPA_LINE_AUTHORITY_STALE',
      );
    }
    await lockPharmacyFundingInvoiceChildrenTx(tx, {
      tenantId: tid,
      invoiceIds: [Number(line.invoice_id)],
    });
    const claimRows = await tx.$queryRawUnsafe(
      `SELECT id,invoice_id,admission_id,patient_uid,status,approved_amount
         FROM tpa_claims
        WHERE tenant_id=$1::uuid AND id=$2::int AND invoice_id=$3::int
          AND admission_id=$4::int AND patient_uid=$5::uuid
          AND status IN ('approved','partially_approved','paid')
        FOR UPDATE`,
      tid, Number(tpaClaimId), Number(line.invoice_id),
      Number(line.admission_id), String(line.patient_uid),
    );
    if (claimRows.length !== 1 || !claimDiscovery
        || Number(claimRows[0].invoice_id) !== Number(claimDiscovery.invoice_id)
        || Number(claimRows[0].admission_id) !== Number(claimDiscovery.admission_id)
        || String(claimRows[0].patient_uid) !== String(claimDiscovery.patient_uid)
        || String(claimRows[0].status) !== String(claimDiscovery.status)) {
      throw AppError.conflict(
        'The exact approved claim no longer owns this invoice and admission',
        'PHARMACY_TPA_CLAIM_AUTHORITY_STALE',
      );
    }
    await assertNoLivePharmacyAdvanceAllocationsTx(tx, {
      tenantId: tid,
      orderId: Number(orderId),
    });
    const taskRows = await tx.$queryRawUnsafe(
      `SELECT * FROM tasks
        WHERE tenant_id=$1::uuid AND id=$2::int
          AND related_resource_type='pharmacy_tpa_line_decision'
          AND related_resource_id=$3
          AND metadata->>'contract'=$4
        FOR UPDATE`,
      tid, Number(taskId), String(Number(orderId)), PHARMACY_FUNDING_TASK_CONTRACT,
    );
    if (!taskRows.length) {
      throw AppError.notFound('Exact pharmacy TPA line-decision task not found');
    }
    const task = taskRows[0];
    if (task.assigned_to_role !== 'INSURANCE_COORDINATOR'
        || task.metadata?.contract !== 'pharmacy_funding_task_v1'
        || task.metadata?.task_type !== 'tpa_line_decision'
        || Number(task.metadata?.invoice_id) !== Number(line.invoice_id)
        || Number(task.metadata?.invoice_item_id) !== Number(invoiceItemId)
        || Number(task.metadata?.tpa_claim_id) !== Number(tpaClaimId)
        || Number(task.metadata?.order_version) !== Number(orderVersion)
        || String(task.metadata?.order_items_sha256) !== authority.orderItemsSha256) {
      throw AppError.conflict(
        'Task ownership or exact line authority changed; reload the funding recovery task',
        'PHARMACY_TPA_TASK_AUTHORITY_STALE',
      );
    }
    const requestSha256 = pharmacyFundingHash('TPA_LINE_DECISION_REQUEST', {
      task_id: Number(taskId),
      pharmacy_order_id: Number(orderId),
      invoice_item_id: Number(invoiceItemId),
      tpa_claim_id: Number(tpaClaimId),
      order_version: Number(orderVersion),
      order_items_sha256: authority.orderItemsSha256,
      approved_amount: toFixed2(approved),
      non_payable_amount: toFixed2(nonPayable),
      reason_code: String(reasonCode),
      reason_text: reasonText == null ? null : String(reasonText),
      actor_uid: authority.actorUid,
    });
    const receipt = await claimPharmacyFundingCommandTx(tx, {
      authority,
      commandKeySha256: command,
      commandType: 'TPA_LINE_DECISION',
      task,
      invoiceItemId: Number(invoiceItemId),
      tpaClaimId: Number(tpaClaimId),
      requestSha256,
    });
    if (receipt.status === 'COMPLETE') {
      return { ...receipt.response_body, replayed: true };
    }
    if (!['open', 'in_progress', 'blocked', 'overdue'].includes(task.status)) {
      throw AppError.conflict(
        'The TPA task was completed or cancelled by a different command',
        'PHARMACY_TPA_TASK_ALREADY_COMPLETED',
      );
    }
    if (!orderActionable) {
      const authorityCancelled = ['CANCELLED', 'UNAVAILABLE', 'REJECTED'].includes(orderStatus);
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET status=CASE WHEN $3::boolean THEN 'cancelled' ELSE 'completed' END,
                cancelled_at=CASE WHEN $3::boolean THEN NOW() ELSE cancelled_at END,
                completed_at=CASE WHEN $3::boolean THEN completed_at ELSE NOW() END,
                updated_at=NOW(),
                cancellation_reason=CASE WHEN $3::boolean
                  THEN 'Pharmacy order left pre-issue funding states'
                  ELSE cancellation_reason END
          WHERE tenant_id=$1::uuid AND related_resource_id=$2
            AND related_resource_type IN ('pharmacy_tpa_line_decision','pharmacy_posted_payment')
            AND status IN (${ACTIVE_TASK_STATUSES})
            AND metadata->>'contract'=$4
            AND metadata->>'pharmacy_order_id'=$2
            AND (
              (related_resource_type='pharmacy_tpa_line_decision'
                AND metadata->>'task_type'='tpa_line_decision')
              OR
              (related_resource_type='pharmacy_posted_payment'
                AND metadata->>'task_type'='posted_payment')
            )`,
        tid, String(Number(orderId)), authorityCancelled,
        PHARMACY_FUNDING_TASK_CONTRACT,
      );
      if (authorityCancelled) {
        await tx.$executeRawUnsafe(
          `UPDATE tpa_claim_line_decisions decision
              SET invalidated_at=NOW(),invalidated_by=$3::uuid
             FROM billing_invoice_items item
            WHERE decision.tenant_id=$1::uuid AND item.tenant_id=decision.tenant_id
              AND item.id=decision.invoice_item_id
              AND item.source_ref_type='pharmacy_order'
              AND item.source_ref_id=$2::bigint AND decision.invalidated_at IS NULL`,
          tid, Number(orderId), authority.actorUid,
        );
      }
      const invalidatedAuthority = authorityCancelled
        ? await invalidateTerminalPharmacyFundingAuthorityTx(tx, {
          authority,
          order,
          actorRole: actor.role,
        })
        : { releasedCapReservation: null, reversedAllocationIds: [] };
      const response = {
        replayed: false,
        status: authorityCancelled ? 'invalidated' : 'closed',
        decision: null,
        task: null,
        invalidatedAuthority,
      };
      await completePharmacyFundingCommandTx(tx, {
        tenantId: tid,
        commandKeySha256: command,
        responseBody: response,
      });
      return response;
    }
    await tx.$executeRawUnsafe(
      `UPDATE tpa_claim_line_decisions
          SET invalidated_at=NOW(),invalidated_by=$4::uuid
        WHERE tenant_id=$1::uuid AND invoice_item_id=$2::int
          AND claim_id<>$3::int AND invalidated_at IS NULL`,
      tid,
      Number(invoiceItemId),
      Number(tpaClaimId),
      authority.actorUid,
    );
    const totals = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(approved_amount),0)::numeric AS approved
         FROM tpa_claim_line_decisions
        WHERE tenant_id=$1::uuid AND claim_id=$2::int AND invoice_item_id<>$3::int
          AND invalidated_at IS NULL`,
      tid, Number(tpaClaimId), Number(invoiceItemId),
    );
    if (Number(totals[0].approved) + approved > Number(claimRows[0].approved_amount || 0) + 0.001) {
      throw AppError.conflict(
        'Line approvals would exceed the authoritative claim approval',
        'PHARMACY_TPA_APPROVAL_INCONSISTENT',
      );
    }
    const decisions = await tx.$queryRawUnsafe(
      `INSERT INTO tpa_claim_line_decisions
        (tenant_id,claim_id,invoice_item_id,reason_code,reason_text,approved_amount,
         non_payable_amount,recorded_by,recorded_at,source_authority_version,
         source_authority_sha256,invalidated_at,invalidated_by)
       VALUES ($1::uuid,$2::int,$3::int,$4,$5,$6::numeric,$7::numeric,$8::uuid,
               NOW(),$9::int,$10,NULL,NULL)
       ON CONFLICT (claim_id,invoice_item_id)
       DO UPDATE SET reason_code=EXCLUDED.reason_code,reason_text=EXCLUDED.reason_text,
                     approved_amount=EXCLUDED.approved_amount,
                     non_payable_amount=EXCLUDED.non_payable_amount,
                     recorded_by=EXCLUDED.recorded_by,recorded_at=NOW(),
                     source_authority_version=EXCLUDED.source_authority_version,
                     source_authority_sha256=EXCLUDED.source_authority_sha256,
                     invalidated_at=NULL,invalidated_by=NULL
       RETURNING *`,
      tid, Number(tpaClaimId), Number(invoiceItemId), String(reasonCode),
      reasonText == null ? null : String(reasonText), approved, nonPayable,
      authority.actorUid, Number(orderVersion), authority.orderItemsSha256,
    );
    const billingDecision = nonPayable <= 0.001
      ? 'payable'
      : approved <= 0.001 ? 'non_payable' : 'partial';
    await tx.$executeRawUnsafe(
      `UPDATE billing_invoice_items
          SET tpa_decision=$3,tpa_non_payable_reason=$4,
              tpa_decided_at=NOW(),tpa_decided_by=$5::uuid
        WHERE tenant_id=$1::uuid AND id=$2::int`,
      tid, Number(invoiceItemId), billingDecision,
      nonPayable > 0.001 ? String(reasonCode) : null, authority.actorUid,
    );
    const allocations = await loadPharmacyPaymentAllocationsTx(tx, {
      tenantId: tid,
      invoiceId: Number(line.invoice_id),
      invoiceItemId: Number(invoiceItemId),
      orderId: Number(orderId),
      orderVersion: Number(orderVersion),
      orderItemsSha256: authority.orderItemsSha256,
      patientUid: canonicalPatientUid,
    });
    const outstanding = Math.max(
      0,
      toFixed2(Number(line.line_total) - approved - allocations.amount),
    );
    const evidence = {
      contract: 'pharmacy_tpa_line_decision_v1', task_id: Number(taskId),
      pharmacy_order_id: Number(orderId), invoice_item_id: Number(invoiceItemId),
      tpa_claim_id: Number(tpaClaimId), order_version: Number(orderVersion),
      order_items_sha256: authority.orderItemsSha256, approved_amount: approved,
      non_payable_amount: nonPayable, decision_id: Number(decisions[0].id),
      command_key_sha256: command,
      request_sha256: requestSha256,
      actor_uid: authority.actorUid,
      actor_role: actor.role,
      assigned_role: task.assigned_to_role,
      payment_allocation_ids: allocations.rows.map((row) => Number(row.allocation_id)),
      allocated_payment_amount: allocations.amount,
      amount_outstanding: outstanding,
    };
    const completedTask = await completePharmacyFundingTaskTx(tx, {
      tenantId: tid,
      taskType: 'tpa_line_decision',
      orderId,
      taskId: Number(taskId),
      evidence,
    });
    if (!completedTask) {
      throw AppError.conflict(
        'The exact insurance task could not be completed',
        'PHARMACY_TPA_TASK_AUTHORITY_STALE',
      );
    }
    const nextTask = outstanding > 0.001
      ? await upsertPharmacyFundingTaskTx(tx, {
        authority,
        invoiceId: Number(line.invoice_id),
        invoiceItemId: Number(invoiceItemId),
        admissionId: Number(line.admission_id),
        taskType: 'posted_payment',
        stage: 'patient_responsibility_payment',
        assignedRole: 'FINANCE_INCHARGE',
        tpaClaimId: Number(tpaClaimId),
        amountOutstanding: outstanding,
      })
      : null;
    await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_funding_decision_events
        (tenant_id,facility_id,pharmacy_order_id,admission_id,event_type,
         source_authority_version,source_authority_sha256,invoice_id,invoice_item_id,
         tpa_claim_id,task_id,amount,command_key_sha256,evidence,recorded_by)
       VALUES ($1::uuid,$2::int,$3::int,$4::int,'TPA_DECISION_RECORDED',$5::int,$6,
               $7::int,$8::int,$9::int,$10::int,$11::numeric,$12,$13::jsonb,$14::uuid)
       RETURNING id`,
      tid, Number(order.facility_id), Number(orderId), Number(line.admission_id),
      Number(orderVersion), authority.orderItemsSha256, Number(line.invoice_id),
      Number(invoiceItemId), Number(tpaClaimId), Number(taskId), approved,
      command, JSON.stringify(evidence), authority.actorUid,
    );
    const fundingAuthorityResult = outstanding > 0.001
      ? await invalidateCurrentPharmacyFundingAuthorityStateTx(tx, {
        authority,
        reason: 'tpa_line_decision_changed',
        actorRole: actor.role,
        commandKeySha256: command,
      })
      : await resolvePostedPharmacyFundingTx(tx, authority);
    const fundingAuthority = outstanding > 0.001
      ? {
        status: 'invalidated',
        eventId: fundingAuthorityResult == null ? null : Number(fundingAuthorityResult.id),
        authorityEvidence: fundingAuthorityResult?.evidence || null,
      }
      : fundingAuthorityResult;
    const response = {
      replayed: false,
      status: outstanding > 0.001 ? 'patient_responsibility_pending' : 'funded',
      decision: decisions[0],
      task: completedTask,
      nextTask,
      evidence,
      fundingAuthority,
    };
    await completePharmacyFundingCommandTx(tx, {
      tenantId: tid,
      commandKeySha256: command,
      responseBody: response,
    });
    return response;
  });
}

// ─── Wave-5 batch-3 — TPA decision UI helpers ────────────────────────
//
// The TPA desk operator marks individual invoice items as
// 'non_payable' once they've reviewed the cap exclusions. The patient
// portal subscribes to the running total so the patient learns about
// non-payable charges as they accumulate, not only at discharge.

const VALID_TPA_DECISIONS = new Set(['payable', 'non_payable', 'partial', 'pending']);
const VALID_NON_PAYABLE_REASONS = new Set([
  'room_upgrade_delta', 'over_cap_pharmacy', 'attendant_charges',
  'cosmetic', 'package_addon', 'food_charges', 'consumables',
  'transport', 'medical_records_copy', 'discharge_summary_fee',
  'duplicate_charge', 'other',
]);

export async function recordInvoiceItemTpaDecision({
  tenantId, invoice_id, item_id, decision, non_payable_reason, decided_by,
}) {
  if (!VALID_TPA_DECISIONS.has(decision)) {
    throw AppError.badRequest(
      `decision must be one of: ${[...VALID_TPA_DECISIONS].join(', ')}`,
    );
  }
  if (decision === 'non_payable' || decision === 'partial') {
    if (!non_payable_reason || !VALID_NON_PAYABLE_REASONS.has(non_payable_reason)) {
      throw AppError.badRequest(
        `non_payable_reason required for ${decision} and must be one of: ${[...VALID_NON_PAYABLE_REASONS].join(', ')}`,
      );
    }
  }
  const invoice = await findBillingInvoice(invoice_id, tenantId, 'id');
  if (!invoice) throw AppError.notFound('Invoice not found');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE billing_invoice_items
        SET tpa_decision = $1,
            tpa_non_payable_reason = $2,
            tpa_decided_at = NOW(),
            tpa_decided_by = $3::uuid
      WHERE id = $4::int AND invoice_id = $5::int
      RETURNING id, invoice_id, description, line_total,
                tpa_decision, tpa_non_payable_reason,
                tpa_decided_at, tpa_decided_by`,
    decision,
    decision === 'payable' || decision === 'pending' ? null : non_payable_reason,
    decided_by ? String(decided_by) : null,
    Number(item_id), Number(invoice_id),
  );
  if (!rows.length) throw AppError.notFound('Invoice item not found');
  return rows[0];
}

export async function getInvoiceNonPayableBreakdown(invoiceId, { tenantId } = {}) {
  const invoice = await findBillingInvoice(invoiceId, tenantId, 'id');
  if (!invoice) throw AppError.notFound('Invoice not found');
  const items = await prisma.$queryRawUnsafe(
    `SELECT id, description, source_ref_type, source_ref_id,
            line_total, tpa_decision, tpa_non_payable_reason,
            tpa_decided_at
       FROM billing_invoice_items
      WHERE invoice_id = $1::int
        AND tpa_decision IN ('non_payable', 'partial')
      ORDER BY tpa_decided_at DESC NULLS LAST, id`,
    Number(invoiceId),
  );
  const total = items.reduce((acc, r) => acc + Number(r.line_total || 0), 0);
  return {
    invoice_id: Number(invoiceId),
    non_payable_total: Math.round(total * 100) / 100,
    line_count: items.length,
    lines: items.map(normalizeBillingItemForResponse),
  };
}

export async function outstandingBills({ days_old, department, limit = 100 } = {}) {
  const params = [];
  const where = ['status IN (\'ISSUED\', \'PARTIAL\')', 'amount_due > 0'];
  if (days_old) {
    params.push(Number(days_old));
    where.push(`COALESCE(issued_at, created_at) <= NOW() - ($${params.length}::int || ' days')::interval`);
  }
  if (department) { params.push(department); where.push(`department = $${params.length}`); }
  params.push(boundedInteger(limit, { fallback: 100, min: 1, max: 200 }));
  return prisma.$queryRawUnsafe(
    `SELECT id, invoice_number, patient_uid, patient_name, patient_phone,
            department, total_amount, credit_note_amount, amount_paid, amount_due,
            status, issued_at,
            EXTRACT(DAY FROM NOW() - COALESCE(issued_at, created_at))::int AS days_outstanding
       FROM billing_invoices
      WHERE ${where.join(' AND ')}
      ORDER BY issued_at ASC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export {
  VALID_INVOICE_TYPES,
  VALID_PAYMENT_MODES,
  VALID_INVOICE_STATUSES,
  VALID_REFUND_STATUSES,
};

logger.debug('billingV2Service loaded');
