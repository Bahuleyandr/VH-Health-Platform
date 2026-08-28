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

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { istDateString } from '../../utils/dateUtils.js';
import { boundedInteger } from '../../utils/pagination.js';
import { toPaise } from '../../utils/money.js';
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
     WHERE invoice_id = $1::int`,
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
  db = prisma,
}) {
  const ownershipSql = TENANT_PATIENT_SOURCE_REF_SQL[sourceRefType];
  if (!ownershipSql) return;
  const rows = await db.$queryRawUnsafe(
    ownershipSql,
    sourceRefId,
    invoiceTenantId,
    String(invoicePatientUid),
  );
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
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO billing_invoice_items
        (invoice_id, service_code, description, category, hsn_sac, quantity,
         unit_price, gst_rate, line_subtotal, cgst_amount, sgst_amount,
         igst_amount, line_total, notes, source_ref_type, source_ref_id, tenant_id,
         source_ref_active)
       VALUES ($1::int, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric,
               $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14, $15, $16,
               $17::uuid, TRUE)
       RETURNING *`,
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
}) {
  let resolvedPatientUid = patient_uid;
  if (invoice_id) {
    // Lock the invoice row first — the balance check below must see a state no
    // concurrent payment/settlement can change until this tx commits.
    const inv = await lockBillingInvoice(
      tx,
      invoice_id,
      tenantId,
      'patient_uid, status, total_amount, amount_paid, amount_due',
    );
    if (!inv) throw AppError.notFound('Invoice not found');
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
      await assertInsurancePaymentHasClaimAnchor(invoice_id, tenantId, tx);
    }
  }
  if (!resolvedPatientUid) throw AppError.badRequest('patient_uid is required when invoice_id is omitted');
  if (!invoice_id) await assertPatientInTenant(resolvedPatientUid, tenantId, tx);

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
      requireTenantId(normalizeTenantId(tenantId)),
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
}, { tx = null } = {}) {
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
  // Reuse the caller's transaction when given (e.g. markPaymentLinkPaid) so we
  // never nest setTenantTx — Postgres cannot nest transactions. That caller is
  // responsible for its own ledger posting (wired in a later phase).
  if (tx) return collectPaymentTx(tx, args);
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

export async function reversePayment(paymentId, { reversed_by, reason, tenantId }) {
  if (!reason) throw AppError.badRequest('reason is required');
  const tenant = requireTenantId(tenantId);
  const wiring = await resolveLedgerWiring(tenant);
  let reversed;
  try {
    reversed = await setTenantTx(tenant, async (tx) => {
      const paymentRows = await tx.$queryRawUnsafe(
        `SELECT payment.id, payment.reversed, payment.mode,
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
      if (String(paymentRows[0].mode || '').trim().toUpperCase() === 'CASH'
          && paymentRows[0].immutable_drawer_close === true) {
        throw AppError.conflict(
          'Cash receipt belongs to an immutable closed drawer; post a governed refund through the current open drawer instead',
          'BILLING_CASH_PAYMENT_CLOSED_DRAWER_REVERSAL_FORBIDDEN',
        );
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
  if (tenantId) await assertPatientInTenant(patient_uid, tenant);
  const wiring = await resolveLedgerWiring(tenant);
  // The advance INSERT, runnable on a plain client (shadow) or a tx (enforce).
  const insertAdvance = (db) => db.$queryRawUnsafe(
    `INSERT INTO billing_advances
      (patient_uid, admission_id, amount, balance, mode, reference, collected_by, notes, tenant_id)
     VALUES ($1::uuid, $2, $3::numeric, $3::numeric, $4, $5, $6::uuid, $7, $8::uuid)
     RETURNING *`,
    String(patient_uid),
    admission_id ? Number(admission_id) : null,
    Number(amount), mode, reference || null,
    collected_by ? String(collected_by) : null, notes || null, tenant,
  );
  let advance;
  if (wiring.sameTx) {
    // Enforce: INSERT + ledger post in one tx so a ledger failure rolls back the advance.
    advance = await setTenantTx(tenant, async (tx) => {
      const r = await insertAdvance(tx);
      await postAdvanceCollectEntry({ advance: r[0], tenantId: tenant, tx });
      // Phase 4-3: derive the advance balance from the ledger (PATIENT_ADVANCE).
      await deriveAdvanceBalanceFromLedgerTx(tx, Number(r[0].id));
      return r[0];
    });
  } else {
    const rows = await insertAdvance(prisma);
    advance = rows[0];
  }
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
  const wiring = await resolveLedgerWiring(requireTenantId(tenantId));
  let settledPatientUid = null;
  const settlement = await setTenantTx(requireTenantId(tenantId), async (tx) => {
    // Lock the advance row FOR UPDATE before reading its balance — without the
    // lock two concurrent settlements both read the same balance and both
    // succeed (the classic lost update that overdraws the advance).
    const advParams = [Number(advance_id)];
    const advTenantSql = appendTenantPredicate(advParams, tenantId);
    const adv = await tx.$queryRawUnsafe(
      `SELECT * FROM billing_advances WHERE id = $1::int${advTenantSql} FOR UPDATE`,
      ...advParams,
    );
    if (!adv.length) throw AppError.notFound('Advance not found');
    if (adv[0].status !== 'ACTIVE') throw AppError.badRequest(`Advance is ${adv[0].status}`);
    if (toPaise(amount) > toPaise(adv[0].balance)) {
      throw AppError.badRequest(`Amount exceeds advance balance ${adv[0].balance}`);
    }

    // Lock the invoice too so its amount_due check + bump is consistent against
    // any concurrent payment on the same invoice.
    const inv = await lockBillingInvoice(
      tx,
      invoice_id,
      tenantId,
      'amount_due, patient_uid',
    );
    if (!inv) throw AppError.notFound('Invoice not found');
    if (String(inv.patient_uid).toLowerCase() !== String(adv[0].patient_uid).toLowerCase()) {
      throw AppError.forbidden(
        'Advance and invoice must belong to the same patient',
        'BILLING_ADVANCE_INVOICE_PATIENT_MISMATCH',
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
        `Amount exceeds advance balance ${adv[0].balance}`,
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
      await postAdvanceSettleEntry({ settlement: settlementRow[0], patientUid: settledPatientUid, tenantId: requireTenantId(tenantId), tx });
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
      await postAdvanceSettleEntry({ settlement, patientUid: settledPatientUid, tenantId: requireTenantId(tenantId) });
    } catch (ledgerErr) {
      logger.error('Ledger ADVANCE_SETTLE post failed (non-blocking)', { settlement_id: settlement?.id, error: ledgerErr.message });
    }
  }
  return settlement;
}

// ───────────────────────────────────────────────────────────────────────
// Refunds
// ───────────────────────────────────────────────────────────────────────

export async function calculateInvoiceRefundHeadroomTx(
  tx,
  invoiceId,
  { excludeRefundId = null } = {},
) {
  const params = [Number(invoiceId)];
  let exclude = '';
  if (excludeRefundId != null) {
    params.push(Number(excludeRefundId));
    exclude = ` AND refund.id <> $${params.length}::int`;
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT (
              SELECT COALESCE(SUM(payment.amount), 0)::numeric
                FROM billing_payments payment
               WHERE payment.invoice_id = $1::int
                 AND payment.reversed = FALSE
            ) + (
              SELECT COALESCE(SUM(settlement.amount), 0)::numeric
                FROM billing_advance_settlements settlement
               WHERE settlement.invoice_id = $1::int
            ) AS gross_paid,
            (
              SELECT COALESCE(SUM(refund.amount), 0)::numeric
                FROM billing_refunds refund
               WHERE refund.invoice_id = $1::int
                 AND refund.approval_status <> 'REJECTED'${exclude}
            ) AS active_refunds`,
    ...params,
  );
  const grossPaid = toFixed2(Number(rows[0]?.gross_paid || 0));
  const activeRefunds = toFixed2(Number(rows[0]?.active_refunds || 0));
  return {
    gross_paid: grossPaid,
    active_refunds: activeRefunds,
    refundable: toFixed2(Math.max(0, grossPaid - activeRefunds)),
  };
}

async function sumAdvanceRefundReservationsTx(tx, advanceId, approvalStatuses) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
       FROM billing_refunds
      WHERE advance_id = $1::int
        AND approval_status = ANY($2::text[])`,
    Number(advanceId),
    approvalStatuses,
  );
  return toFixed2(Number(rows[0]?.total || 0));
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
}) {
  if (!reason) throw AppError.badRequest('reason is required');
  if (!VALID_REFUND_MODES.includes(mode)) {
    throw AppError.badRequest(`Invalid refund mode. Allowed: ${VALID_REFUND_MODES.join(', ')}`);
  }
  requireValidAmount(amount);
  if ((!invoice_id && !advance_id) || (invoice_id && advance_id)) {
    throw AppError.badRequest('Refund must reference exactly one of invoice_id or advance_id');
  }
  const tenant = requireTenantId(normalizeTenantId(tenantId));
  const refundAmount = toFixed2(amount);
  const command = normalizeRefundMutationCommand({
    actorUid: raised_by,
    commandKey,
    requestFingerprint,
    httpIdempotencyClaimId,
    requestId,
    expectedBody: refundRaiseIdempotencyBody({
      patient_uid,
      invoice_id,
      advance_id,
      amount,
      reason,
      mode,
    }),
    path: REFUND_RAISE_IDEMPOTENCY_PATH,
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
  const wiring = await resolveLedgerWiring(tenant);
  return setTenantTx(requireTenantId(tenantId), async (tx) => {
    let resolvedPatientUid = patient_uid;
    if (invoice_id) {
      // Lock the invoice + sum prior refunds so the bound check below can't be
      // raced by a second concurrent refund on the same invoice.
      const invoice = await lockBillingInvoice(tx, invoice_id, tenantId, 'patient_uid, amount_paid');
      if (!invoice) throw AppError.notFound('Invoice not found');
      if (resolvedPatientUid && String(resolvedPatientUid).toLowerCase() !== String(invoice.patient_uid).toLowerCase()) {
        throw AppError.forbidden(
          'Refund patient_uid must match the invoice patient',
          'BILLING_REFUND_PATIENT_MISMATCH',
        );
      }
      resolvedPatientUid = invoice.patient_uid;
      // Gross receipts are immutable payment evidence. Using them avoids
      // subtracting prior refunds twice after the invoice cache is reduced.
      const headroom = await calculateInvoiceRefundHeadroomTx(tx, invoice_id);
      const refundable = headroom.refundable;
      if (refundAmount > refundable + 0.005) {
        throw AppError.badRequest(
          `Refund amount ${refundAmount} exceeds refundable balance ${Math.max(0, refundable)} `
            + `(gross receipts ${headroom.gross_paid} less active refunds ${headroom.active_refunds}).`,
          'BILLING_REFUND_EXCEEDS_PAID',
          {
            amount_paid: Number(invoice.amount_paid || 0),
            gross_paid: headroom.gross_paid,
            prior_refunds: headroom.active_refunds,
            refundable: Math.max(0, refundable),
          },
        );
      }
    }
    if (advance_id) {
      const advParams = [Number(advance_id)];
      const advTenantSql = appendTenantPredicate(advParams, tenantId);
      const advances = await tx.$queryRawUnsafe(
        `SELECT patient_uid, balance FROM billing_advances WHERE id = $1::int${advTenantSql} FOR UPDATE`,
        ...advParams,
      );
      if (!advances.length) throw AppError.notFound('Advance not found');
      if (resolvedPatientUid && String(resolvedPatientUid).toLowerCase() !== String(advances[0].patient_uid).toLowerCase()) {
        throw AppError.forbidden(
          'Refund patient_uid must match the advance patient',
          'BILLING_REFUND_PATIENT_MISMATCH',
        );
      }
      resolvedPatientUid = advances[0].patient_uid;
      // In enforce mode approval has already reduced the cached balance; in
      // shadow/off it is reduced at payout. Reserve only obligations that the
      // current cache has not yet realized.
      const reservationStatuses = wiring.sameTx
        ? ['PENDING']
        : ['PENDING', 'APPROVED'];
      const reservedRefunds = await sumAdvanceRefundReservationsTx(
        tx,
        advance_id,
        reservationStatuses,
      );
      const refundable = toFixed2(
        Math.max(0, Number(advances[0].balance || 0) - reservedRefunds),
      );
      if (refundAmount > refundable + 0.005) {
        throw AppError.badRequest(
          `Refund amount ${refundAmount} exceeds refundable advance balance ${refundable}.`,
          'BILLING_REFUND_EXCEEDS_ADVANCE_BALANCE',
          {
            advance_balance: Number(advances[0].balance || 0),
            reserved_refunds: reservedRefunds,
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
  const params = [approved_by ? String(approved_by) : null, id];
  const tenantSql = appendTenantPredicate(params, tenant);
  const wiring = await resolveLedgerWiring(tenant);
  // The PENDING→APPROVED UPDATE, runnable on a plain client (shadow) or a tx (enforce).
  const doApprove = (db) => db.$queryRawUnsafe(
    `UPDATE billing_refunds
        SET approval_status = 'APPROVED', approved_by = $1::uuid, approved_at = NOW(), updated_at = NOW()
      WHERE id = $2::int AND approval_status = 'PENDING'${tenantSql}
      RETURNING *`,
    ...params,
  );
  let linkedCreditNote = null;
  const refund = await setTenantTx(tenant, async (tx) => {
    const rows = await doApprove(tx);
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
    const locked = await tx.$queryRawUnsafe(
      `SELECT id, approval_status
         FROM billing_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int
        FOR UPDATE`,
      tenant,
      id,
    );
    if (!locked[0] || locked[0].approval_status !== 'PENDING') {
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
          AND approval_status = 'PENDING'
        RETURNING *`,
      rejected_by ? String(rejected_by) : null,
      reason,
      tenant,
      id,
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

async function settleRefundPaid(refundId, {
  paid_by, reference, tenantId, payoutRail, gatewayRefundId = null,
  providerRefundId = null, cashDrawerSessionId = null,
  offlineElectronicEvidence = null, command = null, auditContext = null,
}) {
  const id = normalizeRefundId(refundId);
  const tenant = requireTenantId(tenantId);
  const wiring = await resolveLedgerWiring(tenant);
  let refund;
  try {
    refund = await setTenantTx(tenant, async (tx) => {
      let lockedGatewayEvidence = null;
      if (payoutRail === 'gateway') {
        const evidenceRows = await tx.$queryRawUnsafe(
          `SELECT id, initiated_by, initiated_at, status,
                  provider_refund_id, processed_at
             FROM payment_gateway_refunds
            WHERE id = $1::int
              AND tenant_id = $2::uuid
              AND billing_refund_id = $3::int
              AND status IN ('initiated', 'pending', 'processed', 'requires_reconciliation')
              AND (provider_refund_id IS NULL OR provider_refund_id = $4)
            FOR UPDATE`,
          gatewayRefundId,
          tenant,
          id,
          providerRefundId,
        );
        if (!evidenceRows.length) {
          throw AppError.conflict(
            'Gateway refund execution evidence is not settlement-authoritative',
            'BILLING_REFUND_GATEWAY_EVIDENCE_INVALID',
          );
        }
        [lockedGatewayEvidence] = evidenceRows;
      }
      const lockedRows = await tx.$queryRawUnsafe(
        `SELECT *
           FROM billing_refunds
          WHERE tenant_id = $1::uuid
            AND id = $2::int
          FOR UPDATE`,
        tenant,
        id,
      );
      const lockedRefund = lockedRows[0];
      if (!lockedRefund || lockedRefund.approval_status !== 'APPROVED') {
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
        if (!OFFLINE_ELECTRONIC_REFUND_MODES.includes(mode)) {
          throw AppError.conflict(
            'Offline-electronic evidence is only valid for electronic refund modes',
            'BILLING_REFUND_OFFLINE_ELECTRONIC_MODE_MISMATCH',
          );
        }
        const evidence = offlineElectronicEvidence || {};
        const originalReference = normalizeRefundPayoutReference(
          evidence.original_payment_reference,
          {
            label: 'original_payment_reference',
            requiredCode: 'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_REQUIRED',
          },
        );
        const providerName = normalizeRefundPayoutReference(evidence.provider_name, {
          label: 'provider_name',
          requiredCode: 'BILLING_REFUND_PROVIDER_REQUIRED',
          maxLength: 120,
        });
        const providerRefundReference = normalizeRefundPayoutReference(
          evidence.provider_refund_reference,
          {
            label: 'provider_refund_reference',
            requiredCode: 'BILLING_REFUND_PROVIDER_REFUND_REFERENCE_REQUIRED',
          },
        );
        const providerRefundedAt = normalizeProviderRefundedAt(evidence.provider_refunded_at);
        let originalPaymentId = null;
        let originalAdvanceId = null;
        if (lockedRefund.invoice_id) {
          const paymentRows = await tx.$queryRawUnsafe(
            `SELECT id, amount, mode, reference
               FROM billing_payments
              WHERE tenant_id = $1::uuid
                AND invoice_id = $2::int
                AND patient_uid = $3::uuid
                AND UPPER(mode) = $4
                AND reference = $5
                AND reversed = FALSE
                AND amount >= $6::numeric - 0.005
              ORDER BY id
              LIMIT 2
              FOR UPDATE`,
            tenant,
            Number(lockedRefund.invoice_id),
            String(lockedRefund.patient_uid),
            mode,
            originalReference,
            Number(lockedRefund.amount),
          );
          if (paymentRows.length !== 1) {
            throw AppError.unprocessable(
              'original_payment_reference does not identify one exact eligible payment',
              'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_MISMATCH',
            );
          }
          originalPaymentId = Number(paymentRows[0].id);
          const gatewayOrders = await tx.$queryRawUnsafe(
            `SELECT id, provider
               FROM payment_gateway_orders
              WHERE tenant_id = $1::uuid
                AND billing_payment_id = $2::int
                AND status = 'paid'
              FOR UPDATE`,
            tenant,
            originalPaymentId,
          );
          if (gatewayOrders.length) {
            throw AppError.conflict(
              'This collection has integrated gateway evidence; use the gateway refund rail',
              'BILLING_REFUND_GATEWAY_CAPTURE_AUTHORITATIVE',
            );
          }
        } else {
          const advanceRows = await tx.$queryRawUnsafe(
            `SELECT id, amount, mode, reference
               FROM billing_advances
              WHERE tenant_id = $1::uuid
                AND id = $2::int
                AND patient_uid = $3::uuid
                AND UPPER(mode) = $4
                AND reference = $5
                AND amount >= $6::numeric - 0.005
              FOR UPDATE`,
            tenant,
            Number(lockedRefund.advance_id),
            String(lockedRefund.patient_uid),
            mode,
            originalReference,
            Number(lockedRefund.amount),
          );
          if (advanceRows.length !== 1) {
            throw AppError.unprocessable(
              'original_payment_reference does not match the refund advance collection',
              'BILLING_REFUND_ORIGINAL_PAYMENT_REFERENCE_MISMATCH',
            );
          }
          originalAdvanceId = Number(advanceRows[0].id);
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
        const processedRows = await tx.$queryRawUnsafe(
          `UPDATE payment_gateway_refunds
              SET status = 'processed',
                  provider_refund_id = COALESCE(provider_refund_id, $1),
                  processed_at = COALESCE(processed_at, NOW()),
                  failed_at = NULL,
                  failure_code = NULL,
                  failure_reason = NULL,
                  reconciled_at = NULL,
                  reconciliation_note = NULL,
                  reconciled_by = NULL,
                  updated_at = NOW()
            WHERE id = $2::int
              AND tenant_id = $3::uuid
              AND billing_refund_id = $4::int
              AND status IN ('initiated', 'pending', 'processed', 'requires_reconciliation')
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
            AND approval_status = 'APPROVED'
            AND (
              ($3 = 'gateway' AND payout_rail = 'gateway' AND gateway_refund_id = $4::int)
              OR ($3 <> 'gateway' AND (payout_rail IS NULL OR payout_rail = $3))
            )
          RETURNING *`,
        payoutRail === 'gateway' ? null : normalizedPaidBy,
        normalizedReference,
        payoutRail,
        gatewayRefundId,
        normalizedDrawerId,
        offlineEvidenceId,
        tenant,
        id,
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
        const inv = await lockBillingInvoice(
          tx,
          paidRefund.invoice_id,
          tenant,
          'amount_paid, total_amount, credit_note_amount',
        );
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
  tenantId, gateway_refund_id, provider_refund_id,
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
  });
}

const REFUND_PUBLIC_COLUMNS = `
  id, patient_uid, invoice_id, advance_id, amount, reason, mode, reference,
  approval_status, raised_by, raised_at, approved_by, approved_at,
  rejected_by, rejected_at, rejection_reason, paid_at, paid_by, tenant_id,
  payout_rail, payout_rail_claimed_at, gateway_refund_id,
  cash_drawer_session_id, counter_sale_void_request_id,
  offline_electronic_evidence_id, created_at, updated_at
`;

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
    'id, status, admission_id',
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
      tenantId,
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
      `SELECT id, order_number, medication, total_amount, dispensed_at
         FROM pharmacy_orders
        WHERE uid IS NOT NULL
          AND uid = $1::uuid
          AND status = 'DELIVERED'
          AND dispensed_at >= $2::timestamptz
          AND dispensed_at <= COALESCE($3::timestamptz, NOW())
        ORDER BY dispensed_at`,
      String(admission.patient_uid),
      startTs, endTs,
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
