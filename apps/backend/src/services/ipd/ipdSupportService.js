// src/services/ipd/ipdSupportService.js
//
// IPD support subsystem (architectural item A4):
//   - advance_deposits: money collected against admission's eventual bill
//   - attendant_passes: 2 per admission, auto-issued at admit
//   - ward_indents: pharmacy/stores → ward consumables flow
//
// Migration 174. Per project decision 2026-05-09.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { sendStaffNotifications } from '../notification/staffNotificationService.js';
import { resolveLedgerWiring } from '../billing/ledger/ledgerAuthoritativeMode.js';
import { postAdvanceCollectEntry } from '../billing/ledger/ledgerPostings.js';
import {
  deriveAdvanceBalanceFromLedgerTx,
  raiseRefund as raiseBillingRefund,
} from '../billing/billingV2Service.js';
import { lockTenantPatientMergeStability } from '../../utils/patientMergeStabilityLock.js';
import {
  lockPharmacyFundingAuthorityTx,
  resolvePharmacyFundingPatientUidTx,
} from '../pharmacy/pharmacyCapService.js';
import {
  applyApprovedWardIndentSubstitution,
  approveWardIndentControlledWitnessApproval,
  approveWardIndent,
  approveWardIndentSubstitution,
  cancelWardIndent,
  closeWardIndent,
  findWardIndentCreateReplayTx,
  getWardIndent,
  initializeWardIndentWorkflowTx,
  issueWardIndent,
  listWardIndentPage,
  listWardIndents,
  loadMedicationCatalogAuthorityTx,
  loadWardIndentCatalogClassificationsTx,
  markWardIndentShortSupply,
  proposeWardIndentSubstitution,
  requestWardIndentControlledWitnessApproval,
  receiveWardIndent,
  reconcileWardIndent,
  recordWardIndentControlledHandoff,
  rejectWardIndent,
  rejectWardIndentSubstitution,
  reportWardIndentDiscrepancy,
  requestWardIndentReturn,
  reserveWardIndent,
} from './wardIndentWorkflowService.js';
import { listWardIndentInventoryCandidates } from './wardIndentMedicationClosureService.js';

export {
  applyApprovedWardIndentSubstitution,
  approveWardIndentControlledWitnessApproval,
  approveWardIndent,
  approveWardIndentSubstitution,
  cancelWardIndent,
  closeWardIndent,
  getWardIndent,
  issueWardIndent,
  listWardIndentPage,
  listWardIndents,
  listWardIndentInventoryCandidates,
  markWardIndentShortSupply,
  proposeWardIndentSubstitution,
  requestWardIndentControlledWitnessApproval,
  receiveWardIndent,
  reconcileWardIndent,
  recordWardIndentControlledHandoff,
  rejectWardIndent,
  rejectWardIndentSubstitution,
  reportWardIndentDiscrepancy,
  requestWardIndentReturn,
  reserveWardIndent,
};

// Wave-4B-1 — 'deferred' is the IRDAI/MCI emergency-care payment mode for
// unidentified patients and brought-in-dead RTA victims. The hospital must
// admit first and reconcile the deposit within 24 hours; rejecting a
// zero-amount deposit at admit closes off any structured record. The
// deposit row carries amount=0 with payment_method='deferred' and the
// purpose discriminates further. Finding:
//   2026-05-09-emergency-walk-in-admission-advance-deposit-no-deferred-mode
//
// `corporate_tpa` remains in the historical row vocabulary, but this patient-
// money collection path rejects it. Cashless payer authority must not create a
// patient advance or an ADVANCE_COLLECT ledger movement.
const VALID_PAYMENT_METHODS = new Set(['cash', 'card', 'upi', 'cheque', 'online', 'bank_transfer', 'deferred', 'corporate_tpa']);
const REFERENCE_REQUIRED_PAYMENT_METHODS = new Set(['card', 'upi', 'cheque', 'online', 'bank_transfer']);
const IPD_REFUND_MODE_BY_INPUT = new Map([
  ['cash', 'CASH'],
  ['cheque', 'CHEQUE'],
]);
const IPD_REFUND_RECONCILIATION_MODES = new Set([
  'card',
  'upi',
  'online',
  'bank_transfer',
]);
const VALID_DEPOSIT_PURPOSES = new Set([
  'admission_advance', 'package_advance', 'attendant_deposit', 'security_deposit',
  // Wave-4B-1 — emergency-deferred path for unidentified/RTA admits.
  'emergency_deferred',
]);

// UUID validation regex — Prisma's @db.Uuid columns reject non-UUID strings
// with a generic 500 unless we 400 at the boundary first.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

const NUMERIC_10_2_MAX_PAISE = 9_999_999_999;

function exactMoneyPaise(value, label, {
  allowZero = false,
  precision = 10,
} = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw AppError.badRequest(`${label} must be a plain decimal fitting NUMERIC(${precision},2)`);
  }
  const text = String(value).trim();
  const wholeDigits = precision - 2;
  const match = new RegExp(`^(\\d{1,${wholeDigits}})(?:\\.(\\d{1,2}))?$`).exec(text);
  if (!match) {
    throw AppError.badRequest(
      `${label} must be a plain decimal fitting NUMERIC(${precision},2) with at most 2 decimal places`,
    );
  }
  const whole = BigInt(match[1]);
  const fraction = BigInt(String(match[2] || '').padEnd(2, '0'));
  const paiseBigInt = whole * 100n + fraction;
  const paise = Number(paiseBigInt);
  if (!Number.isSafeInteger(paise) || (!allowZero && paise <= 0)) {
    throw AppError.badRequest(`${label} must be ${allowZero ? 'zero or positive' : 'positive'}`);
  }
  return {
    paise,
    amount: `${whole}.${String(fraction).padStart(2, '0')}`,
  };
}

function exactNumeric10_2(value, label, { allowZero = false } = {}) {
  const parsed = exactMoneyPaise(value, label, { allowZero, precision: 10 });
  if (parsed.paise > NUMERIC_10_2_MAX_PAISE) {
    throw AppError.badRequest(`${label} must fit NUMERIC(10,2)`);
  }
  return parsed;
}

function normalizePaymentReference(value, paymentMethod, { deferred = false } = {}) {
  if (value != null && typeof value !== 'string') {
    throw AppError.badRequest('payment_reference must be a string');
  }
  const reference = String(value ?? '').trim();
  if (reference.length > 255) {
    throw AppError.badRequest('payment_reference must not exceed 255 characters');
  }
  if (deferred && reference) {
    throw AppError.badRequest('deferred deposits cannot carry a payment_reference');
  }
  if (REFERENCE_REQUIRED_PAYMENT_METHODS.has(paymentMethod) && !reference) {
    throw AppError.badRequest(`payment_reference is required for ${paymentMethod}`);
  }
  return reference || null;
}

function normalizeAdvanceNotes(value) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw AppError.badRequest('notes must be a string');
  }
  if ([...value].length > 500) {
    throw AppError.badRequest('notes must not exceed 500 characters');
  }
  return value;
}

function sameUuid(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

const PG_INT4_MAX = 2_147_483_647;
const IPD_ADVANCE_REFUND_DEFAULT_REASON = 'IPD advance deposit refund request';

export function normalizeIpdAdvanceRefundRequest({
  parentDepositId,
  refundAmount,
  paymentMethod,
  paymentReference = null,
  notes = null,
} = {}) {
  const depositIdText = typeof parentDepositId === 'number'
    ? String(parentDepositId)
    : String(parentDepositId ?? '').trim();
  const normalizedParentDepositId = Number(depositIdText);
  if (!/^[1-9][0-9]*$/.test(depositIdText)
      || !Number.isInteger(normalizedParentDepositId)
      || normalizedParentDepositId > PG_INT4_MAX) {
    throw AppError.badRequest('parentDepositId must be a positive integer');
  }

  const normalizedAmount = exactNumeric10_2(refundAmount, 'refundAmount');
  const inputMode = typeof paymentMethod === 'string'
    ? paymentMethod.trim().toLowerCase()
    : '';
  if (IPD_REFUND_RECONCILIATION_MODES.has(inputMode)) {
    throw AppError.conflict(
      `${inputMode} IPD advance refunds require canonical electronic payout evidence reconciliation`,
      'IPD_ADVANCE_REFUND_MODE_RECONCILIATION_REQUIRED',
      { payment_method: inputMode },
    );
  }
  if (['deferred', 'corporate_tpa'].includes(inputMode)) {
    throw AppError.conflict(
      `${inputMode} is not a collected patient-money refund rail`,
      'IPD_ADVANCE_REFUND_NON_PAYOUT_MODE',
      { payment_method: inputMode },
    );
  }
  const mode = IPD_REFUND_MODE_BY_INPUT.get(inputMode);
  if (!mode) {
    throw AppError.badRequest(
      'Invalid refund payment_method. Allowed on the IPD request surface: cash, cheque',
      'IPD_ADVANCE_REFUND_MODE_INVALID',
    );
  }

  if (paymentReference != null
      && (typeof paymentReference !== 'string' || paymentReference.trim())) {
    throw AppError.badRequest(
      'payment_reference is payout evidence and must be recorded only by the governed finance payout workflow',
      'IPD_ADVANCE_REFUND_PAYOUT_REFERENCE_FORBIDDEN',
    );
  }
  const normalizedNotes = normalizeAdvanceNotes(notes);
  const reason = String(normalizedNotes ?? '').trim() || IPD_ADVANCE_REFUND_DEFAULT_REASON;
  const idempotencyPath = `/api/v1/ipd/advance-deposits/${normalizedParentDepositId}/refund`;
  const idempotencyBody = {
    action: 'raise_ipd_advance_refund',
    parent_deposit_id: String(normalizedParentDepositId),
    amount: normalizedAmount.amount,
    reason,
    mode,
  };
  return {
    parentDepositId: normalizedParentDepositId,
    amount: normalizedAmount.amount,
    amountPaise: normalizedAmount.paise,
    reason,
    mode,
    idempotencyPath,
    idempotencyBody,
  };
}

const VALID_INDENT_TYPES = new Set(['pharmacy', 'consumables', 'linen', 'sterile_supplies']);
const PHARMACY_WARD_INDENT_ROLES = ['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST'];

// Ward-indent pharmacy dispatch alert — OPERATOR-GATED, DEFAULT OFF.
//
// Every inpatient CPOE medication order and every ER order carried into an
// admission auto-creates a ward indent. The Staff workbench now supports the
// authoritative lifecycle and exact notification deep link, but availability
// in source is not release authority. Until the matching backend and Staff
// bundle is operator-activated, the notification remains LOW, carries no
// route, and directs staff to the approved manual process. This keeps an
// unavailable workflow out of the Safety Center escalation ladder and the
// server-side unread-critical escalation cron.
//
// The operator flips PHARMACY_WARD_INDENT_PUSH_ENABLED=true only in the SAME
// release that activates the workbench. That restores the HIGH actionable
// alert and exact deep link without another code change. See docs/ROADMAP.md,
// "Pharmacy ward indents".
//
// This gate is FORWARD-ONLY: it decides the priority of rows created after it
// deploys and cannot reach rows already in `notifications`. The pre-existing
// HIGH backlog is demoted once by
// src/migrations/730_ward_pharmacy_indent_notification_backlog_demotion.sql,
// which changes priority only — those rows keep the delivered "Please review
// the pharmacy ward indent for dispensing" body and carry no
// dispatch_surface_available key.
export function wardIndentDispatchSurfaceEnabled() {
  return String(process.env.PHARMACY_WARD_INDENT_PUSH_ENABLED || '').trim().toLowerCase() === 'true';
}

function tenantOr(value) {
  return requireTenantId(value);
}

async function findAdmissionForTenant(client, admissionId, tenantId) {
  const id = Number.parseInt(admissionId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('admission_id must be a positive integer');
  }
  const admission = await client.admissions.findFirst({
    where: { id, tenant_id: tenantOr(tenantId) },
    select: {
      id: true,
      patient_uid: true,
      status: true,
      billing_closed_at: true,
      tenant_id: true,
      encounter_id: true,
      bed_id: true,
      ward: true,
    },
  });
  if (!admission) throw AppError.notFound('Admission not found');
  return admission;
}

async function lockCanonicalIpdFundingAdmissionTx(tx, {
  tenantId,
  admissionId,
  patientUid,
  requireBillingOpen = false,
}) {
  const tid = tenantOr(tenantId);
  await lockTenantPatientMergeStability(tx, tid);
  const canonicalPatientUid = await resolvePharmacyFundingPatientUidTx(tx, {
    tenantId: tid,
    admissionId: Number(admissionId),
    patientUid: String(patientUid),
  });
  await lockPharmacyFundingAuthorityTx(tx, {
    tenantId: tid,
    patientUid: canonicalPatientUid,
  });
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, status, billing_closed_at, tenant_id
       FROM admissions
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND patient_uid = $3::uuid
      FOR UPDATE`,
    tid,
    Number(admissionId),
    canonicalPatientUid,
  );
  const admission = rows[0];
  if (!admission) {
    throw AppError.conflict(
      'Admission funding authority changed before the money mutation could lock it',
      'IPD_ADVANCE_ADMISSION_AUTHORITY_CHANGED',
    );
  }
  if (requireBillingOpen && admission.billing_closed_at) {
    const closedAt = admission.billing_closed_at instanceof Date
      ? admission.billing_closed_at.toISOString()
      : String(admission.billing_closed_at);
    throw AppError.conflict(
      `Admission billing is closed (since ${closedAt}). Cannot collect new advance deposit.`,
      'IPD_ADVANCE_BILLING_CLOSED',
    );
  }
  return { admission, canonicalPatientUid };
}

function storedMoneyPaise(value, label, { precision = 12 } = {}) {
  try {
    const serialized = typeof value === 'string' || typeof value === 'number'
      ? value
      : value?.toString?.();
    return exactMoneyPaise(serialized, label, { allowZero: true, precision }).paise;
  } catch {
    throw AppError.conflict(
      `${label} is not canonical two-decimal money evidence`,
      'IPD_ADVANCE_STORED_MONEY_INVALID',
    );
  }
}

function assertExactIpdAdvanceMirror(parent, mirror) {
  const mismatches = [];
  const parentAmountPaise = storedMoneyPaise(
    parent.amount,
    'parent deposit amount',
    { precision: 10 },
  );
  const mirrorAmountPaise = storedMoneyPaise(mirror.amount, 'billing advance amount');
  const mirrorBalancePaise = storedMoneyPaise(mirror.balance, 'billing advance balance');
  if (Number(parent.id) !== Number(mirror.ipd_advance_deposit_id)) {
    mismatches.push('ipd_advance_deposit_id');
  }
  if (!sameUuid(parent.patient_uid, mirror.patient_uid)) mismatches.push('patient_uid');
  if (Number(parent.admission_id) !== Number(mirror.admission_id)) mismatches.push('admission_id');
  if (parentAmountPaise !== mirrorAmountPaise) mismatches.push('amount');
  if (String(parent.payment_method) !== String(mirror.ipd_advance_deposit_payment_method)) {
    mismatches.push('ipd_advance_deposit_payment_method');
  }
  if (String(parent.payment_method).trim().toUpperCase()
      !== String(mirror.mode).trim().toUpperCase()) {
    mismatches.push('payment_method');
  }
  if (String(mirror.reference) !== `IPD/${String(parent.receipt_number)}`) {
    mismatches.push('reference');
  }
  if (!sameUuid(parent.collected_by, mirror.collected_by)) mismatches.push('collected_by');
  if (mirror.source_collected_at_matches !== true) mismatches.push('source_collected_at');
  if (mirror.mirror_collected_at_matches !== true) mismatches.push('collected_at');
  if (mirrorBalancePaise < 0 || mirrorBalancePaise > mirrorAmountPaise) mismatches.push('balance');
  if (mismatches.length) {
    throw AppError.conflict(
      'The IPD deposit and billing advance mirror no longer carry identical provenance',
      'IPD_ADVANCE_MIRROR_PROVENANCE_MISMATCH',
      { fields: mismatches },
    );
  }
  const status = String(mirror.status).toUpperCase();
  const statusMatchesBalance = mirrorBalancePaise === 0
    ? ['EXHAUSTED', 'REFUNDED'].includes(status)
    : ['ACTIVE', 'REFUND_DUE'].includes(status);
  if (!statusMatchesBalance) {
    throw AppError.conflict(
      `The billing advance mirror is ${mirror.status || 'unclassified'} and is not coherent funding evidence`,
      'IPD_ADVANCE_MIRROR_STATUS_INVALID',
    );
  }
}

async function lockExactIpdAdvanceMirrorTx(tx, {
  tenantId,
  parent,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT mirror.id, mirror.patient_uid, mirror.admission_id,
            mirror.amount, mirror.balance, mirror.mode, mirror.reference,
            mirror.collected_by, mirror.status, mirror.tenant_id,
            mirror.collected_at, mirror.ipd_advance_deposit_id,
            mirror.ipd_advance_deposit_payment_method,
            mirror.ipd_advance_deposit_collected_at, mirror.updated_at,
            mirror.ipd_advance_deposit_collected_at
              IS NOT DISTINCT FROM source.collected_at AS source_collected_at_matches,
            mirror.collected_at
              IS NOT DISTINCT FROM source.collected_at AS mirror_collected_at_matches
       FROM billing_advances mirror
       JOIN advance_deposits source
         ON source.tenant_id = mirror.tenant_id
        AND source.id = mirror.ipd_advance_deposit_id
      WHERE mirror.tenant_id = $1::uuid
        AND mirror.ipd_advance_deposit_id = $2::int
      ORDER BY mirror.id
      LIMIT 2
      FOR UPDATE OF mirror, source`,
    tenantOr(tenantId),
    Number(parent.id),
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      rows.length === 0
        ? 'The IPD deposit has no billing advance mirror'
        : 'The IPD deposit has more than one billing advance mirror',
      rows.length === 0
        ? 'IPD_ADVANCE_MIRROR_MISSING'
        : 'IPD_ADVANCE_MIRROR_AMBIGUOUS',
      { parent_deposit_id: Number(parent.id), mirror_count: rows.length },
    );
  }
  assertExactIpdAdvanceMirror(parent, rows[0]);
  return rows[0];
}

function assertRefundableIpdDepositSource(source) {
  if (source.is_refund !== false || source.parent_deposit_id != null) {
    throw AppError.badRequest('Cannot refund a refund row — request against the original deposit');
  }
  const amountPaise = storedMoneyPaise(source.amount, 'IPD deposit amount', { precision: 10 });
  if (amountPaise <= 0) {
    throw AppError.conflict(
      'The original deposit is not positive collected patient money',
      'IPD_ADVANCE_PARENT_NOT_PATIENT_MONEY',
    );
  }
  const paymentMethod = String(source.payment_method || '').trim().toLowerCase();
  if (['deferred', 'corporate_tpa'].includes(paymentMethod)) {
    throw AppError.conflict(
      'The original deposit is not proven collected patient money and requires finance reconciliation',
      'IPD_ADVANCE_PARENT_NOT_PATIENT_MONEY',
      { payment_method: paymentMethod },
    );
  }
  if (!VALID_PAYMENT_METHODS.has(paymentMethod)) {
    throw AppError.conflict(
      'The original deposit payment method is not eligible patient-money evidence',
      'IPD_ADVANCE_PARENT_NOT_PATIENT_MONEY',
      { payment_method: paymentMethod },
    );
  }
  if (!isUuid(String(source.collected_by || ''))) {
    throw AppError.conflict(
      'The original deposit has no valid collector provenance',
      'IPD_ADVANCE_PARENT_COLLECTOR_INVALID',
    );
  }
  if (!String(source.receipt_number || '').trim()) {
    throw AppError.conflict(
      'The original deposit has no receipt provenance',
      'IPD_ADVANCE_PARENT_RECEIPT_MISSING',
    );
  }
  return { amountPaise, paymentMethod };
}

async function loadIpdAdvanceRefundCandidate(parentDepositId, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT source.id, source.amount, source.admission_id, source.patient_uid,
            source.is_refund, source.parent_deposit_id, source.purpose,
            source.receipt_number, source.payment_method, source.payment_reference,
            source.collected_by, source.collected_at,
            mirror.id AS advance_id
       FROM advance_deposits source
       LEFT JOIN billing_advances mirror
         ON mirror.tenant_id = source.tenant_id
        AND mirror.ipd_advance_deposit_id = source.id
      WHERE source.tenant_id = $1::uuid
        AND source.id = $2::int
      ORDER BY mirror.id
      LIMIT 2`,
    tenantOr(tenantId),
    Number(parentDepositId),
  );
  const candidate = rows[0];
  if (!candidate) throw AppError.notFound('Parent deposit not found');
  if (rows.length !== 1) {
    throw AppError.conflict(
      'The IPD deposit has more than one billing advance mirror',
      'IPD_ADVANCE_MIRROR_AMBIGUOUS',
      { parent_deposit_id: Number(parentDepositId), mirror_count: rows.length },
    );
  }
  assertRefundableIpdDepositSource(candidate);
  if (candidate.advance_id == null) {
    throw AppError.conflict(
      'The IPD deposit is not bound to one canonical billing advance',
      'IPD_ADVANCE_MIRROR_MISSING',
      { parent_deposit_id: Number(parentDepositId) },
    );
  }
  return candidate;
}

async function validateIpdAdvanceRefundParentSourceTx({
  tx,
  tenantId,
  advance,
  storedPatientUid,
  fundingPatientUid,
}, { candidate, command }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT source.id AS source_id,
            source.amount AS source_amount,
            source.admission_id AS source_admission_id,
            source.patient_uid AS source_patient_uid,
            source.is_refund AS source_is_refund,
            source.parent_deposit_id AS source_parent_deposit_id,
            source.receipt_number AS source_receipt_number,
            source.payment_method AS source_payment_method,
            source.payment_reference AS source_payment_reference,
            source.purpose AS source_purpose,
            source.collected_by AS source_collected_by,
            source.collected_at AS source_collected_at,
            admission.patient_uid AS admission_patient_uid,
            admission.billing_closed_at,
            mirror.id AS mirror_id,
            mirror.patient_uid AS mirror_patient_uid,
            mirror.admission_id AS mirror_admission_id,
            mirror.amount AS mirror_amount,
            mirror.balance AS mirror_balance,
            mirror.mode AS mirror_mode,
            mirror.reference AS mirror_reference,
            mirror.collected_by AS mirror_collected_by,
            mirror.collected_at AS mirror_collected_at,
            mirror.status AS mirror_status,
            mirror.ipd_advance_deposit_id AS mirror_source_id,
            mirror.ipd_advance_deposit_payment_method AS mirror_source_payment_method,
            mirror.ipd_advance_deposit_collected_at AS mirror_source_collected_at,
            mirror.ipd_advance_deposit_collected_at
              IS NOT DISTINCT FROM source.collected_at AS source_collected_at_matches,
            DATE_TRUNC('milliseconds', mirror.collected_at)
              IS NOT DISTINCT FROM DATE_TRUNC('milliseconds', source.collected_at)
              AS mirror_collected_at_matches
       FROM billing_advances mirror
       JOIN advance_deposits source
         ON source.tenant_id = mirror.tenant_id
        AND source.id = mirror.ipd_advance_deposit_id
       JOIN admissions admission
         ON admission.tenant_id = source.tenant_id
        AND admission.id = source.admission_id
      WHERE mirror.tenant_id = $1::uuid
        AND mirror.id = $2::int
        AND source.id = $3::int
      FOR UPDATE OF source, admission`,
    tenantOr(tenantId),
    Number(advance.id),
    Number(candidate.id),
  );
  const source = rows[0];
  if (rows.length !== 1) {
    throw AppError.conflict(
      'The bound IPD deposit, admission, or advance changed before the refund request locked it',
      'IPD_ADVANCE_PARENT_CHANGED',
    );
  }
  const sourceEvidence = assertRefundableIpdDepositSource({
    ...source,
    id: source.source_id,
    amount: source.source_amount,
    admission_id: source.source_admission_id,
    patient_uid: source.source_patient_uid,
    is_refund: source.source_is_refund,
    parent_deposit_id: source.source_parent_deposit_id,
    receipt_number: source.source_receipt_number,
    payment_method: source.source_payment_method,
    collected_by: source.source_collected_by,
  });
  const sourceRefundMode = IPD_REFUND_MODE_BY_INPUT.get(sourceEvidence.paymentMethod);
  if (!sourceRefundMode || sourceRefundMode !== command.mode) {
    throw AppError.conflict(
      'The requested refund mode does not match the bound IPD collection rail and requires finance reconciliation',
      'IPD_ADVANCE_REFUND_MODE_RECONCILIATION_REQUIRED',
      {
        source_payment_method: sourceEvidence.paymentMethod,
        requested_mode: command.mode,
      },
    );
  }

  const sourceAmountPaise = storedMoneyPaise(
    source.source_amount,
    'bound IPD deposit amount',
    { precision: 10 },
  );
  const mirrorAmountPaise = storedMoneyPaise(source.mirror_amount, 'bound billing advance amount');
  const mirrorBalancePaise = storedMoneyPaise(source.mirror_balance, 'bound billing advance balance');
  const mismatches = [];
  if (Number(source.source_id) !== Number(candidate.id)
      || Number(source.mirror_source_id) !== Number(candidate.id)
      || Number(advance.ipd_advance_deposit_id) !== Number(candidate.id)) {
    mismatches.push('ipd_advance_deposit_id');
  }
  if (Number(source.mirror_id) !== Number(candidate.advance_id)
      || Number(advance.id) !== Number(candidate.advance_id)) {
    mismatches.push('advance_id');
  }
  if (!sameUuid(source.source_patient_uid, storedPatientUid)
      || !sameUuid(source.mirror_patient_uid, storedPatientUid)
      || !sameUuid(advance.patient_uid, storedPatientUid)
      || !sameUuid(source.source_patient_uid, candidate.patient_uid)) {
    mismatches.push('stored_patient_uid');
  }
  if (!sameUuid(source.admission_patient_uid, fundingPatientUid)) {
    mismatches.push('funding_patient_uid');
  }
  if (Number(source.source_admission_id) !== Number(source.mirror_admission_id)
      || Number(source.source_admission_id) !== Number(advance.admission_id)
      || Number(source.source_admission_id) !== Number(candidate.admission_id)) {
    mismatches.push('admission_id');
  }
  if (sourceAmountPaise !== mirrorAmountPaise
      || sourceAmountPaise !== storedMoneyPaise(candidate.amount, 'candidate IPD deposit amount', { precision: 10 })
      || mirrorAmountPaise !== storedMoneyPaise(advance.amount, 'locked billing advance amount')) {
    mismatches.push('amount');
  }
  if (String(source.source_payment_method)
        !== String(source.mirror_source_payment_method)
      || String(source.source_payment_method)
        !== String(advance.ipd_advance_deposit_payment_method)
      || String(source.source_payment_method) !== String(candidate.payment_method)
      || String(source.source_payment_method).trim().toUpperCase()
        !== String(source.mirror_mode).trim().toUpperCase()
      || String(source.source_payment_method).trim().toUpperCase()
        !== String(advance.mode).trim().toUpperCase()) {
    mismatches.push('payment_method');
  }
  if (!sameUuid(source.source_collected_by, source.mirror_collected_by)
      || !sameUuid(source.source_collected_by, advance.collected_by)
      || !sameUuid(source.source_collected_by, candidate.collected_by)) {
    mismatches.push('collected_by');
  }
  if (String(source.source_receipt_number) !== String(candidate.receipt_number)
      || String(source.mirror_reference) !== `IPD/${String(source.source_receipt_number)}`
      || String(advance.reference) !== String(source.mirror_reference)) {
    mismatches.push('reference');
  }
  if (source.source_payment_reference !== candidate.payment_reference) {
    mismatches.push('payment_reference');
  }
  if (source.source_purpose !== candidate.purpose) mismatches.push('purpose');
  if (source.source_collected_at_matches !== true) mismatches.push('source_collected_at');
  if (source.mirror_collected_at_matches !== true) mismatches.push('collected_at');
  if (source.billing_closed_at != null) {
    const closedAtMillis = source.billing_closed_at instanceof Date
      ? source.billing_closed_at.getTime()
      : Date.parse(String(source.billing_closed_at));
    if (!Number.isFinite(closedAtMillis)) mismatches.push('billing_closed_at');
  }
  if (mirrorBalancePaise < 0
      || mirrorBalancePaise > mirrorAmountPaise
      || mirrorBalancePaise !== storedMoneyPaise(
        advance.balance,
        'locked billing advance balance',
      )) {
    mismatches.push('balance');
  }
  const status = String(source.mirror_status || '').trim().toUpperCase();
  const statusMatchesBalance = mirrorBalancePaise === 0
    ? ['EXHAUSTED', 'REFUNDED'].includes(status)
    : ['ACTIVE', 'REFUND_DUE'].includes(status);
  if (!statusMatchesBalance || status !== String(advance.status || '').trim().toUpperCase()) {
    mismatches.push('status');
  }
  if (mismatches.length) {
    throw AppError.conflict(
      'The IPD deposit and billing advance no longer carry exact refund source provenance',
      'IPD_ADVANCE_MIRROR_PROVENANCE_MISMATCH',
      { fields: [...new Set(mismatches)] },
    );
  }
  // A closed bill still permits this remediation request. Approval and payout
  // remain separate governed billing actions.
}

const ATTENDANT_PASS_COUNT_PER_ADMISSION = 2;
// Default safety expiry for auto-issued attendant passes. The pass is
// also revoked when discharge fires (via revokeAttendantPass / the
// discharge cascade), but until then the pass is otherwise enforceable
// indefinitely — without `expires_at`, ward security cannot tell a stale
// pass from a current one (the entire point of `expires_at`).
// 14 days is well above the median IPD LOS but bounded enough that a
// forgotten pass becomes invalid without administrative cleanup.
// Finding: 2026-05-22-inpatient-admission-admission-c1da7281.
const ATTENDANT_PASS_DEFAULT_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000;

function defaultAttendantPassExpiry(issuedAtMs = Date.now()) {
  return new Date(issuedAtMs + ATTENDANT_PASS_DEFAULT_VALIDITY_MS);
}

// ── Receipt / pass / indent number generation ─────────────────────────
function pad(n, width) {
  return String(n).padStart(width, '0');
}

async function nextReceiptNumber(tx) {
  // RCT-YYYYMM-NNNN. Counter is per-month; race-safe via unique index.
  const now = new Date();
  const ym = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}`;
  const prefix = `RCT-${ym}-`;
  const last = await tx.advance_deposits.findFirst({
    where: { receipt_number: { startsWith: prefix } },
    orderBy: { receipt_number: 'desc' },
    select: { receipt_number: true },
  });
  const nextSeq = last ? Number.parseInt(last.receipt_number.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${pad(nextSeq, 4)}`;
}

async function nextPassNumber(tx, _admissionId, _passIndex) {
  // AP-YYYYMMDD-NNNN. Pass index distinguishes the 2-per-admission pair.
  const now = new Date();
  const ymd = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}`;
  const prefix = `AP-${ymd}-`;
  const last = await tx.attendant_passes.findFirst({
    where: { pass_number: { startsWith: prefix } },
    orderBy: { pass_number: 'desc' },
    select: { pass_number: true },
  });
  const nextSeq = last ? Number.parseInt(last.pass_number.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${pad(nextSeq, 4)}`;
}

async function nextIndentNumber(tx, tenantId) {
  const tid = tenantOr(tenantId);
  const now = new Date();
  const ymd = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}`;
  const prefix = `WI-${ymd}-`;
  await tx.$queryRawUnsafe(
    `SELECT 1::int AS locked
       FROM (SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))) AS guard`,
    `ward-indent-number:${tid}:${ymd}`,
  );
  const last = await tx.ward_indents.findFirst({
    where: { tenant_id: tid, indent_number: { startsWith: prefix } },
    orderBy: { indent_number: 'desc' },
    select: { indent_number: true },
  });
  const nextSeq = last ? Number.parseInt(last.indent_number.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${pad(nextSeq, 4)}`;
}

function parseClinicalOrderDetails(details) {
  if (!details) return {};
  if (typeof details === 'string') {
    try {
      return JSON.parse(details);
    } catch {
      return { medication_name: details };
    }
  }
  return typeof details === 'object' ? details : {};
}

function stableClinicalOrderDetails(details) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, normalize(value[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize(parseClinicalOrderDetails(details)));
}

function manualIndentQuantityFromMedicationDetails(details) {
  const raw = details.quantity_requested;
  const value = String(raw ?? '').trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isFinite(quantity)
    && quantity > 0
    && quantity <= 99999999.99
    ? quantity
    : null;
}

function manualIndentUnitFromMedicationDetails(details) {
  const raw = details.unit;
  if (typeof raw !== 'string') return null;
  const unit = raw.trim();
  return unit || null;
}

function manualIndentCatalogFromMedicationDetails(details) {
  const raw = details.catalog_id ?? details.catalogId;
  if (
    typeof raw !== 'number'
    && (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw.trim()))
  ) return null;
  const catalogId = Number(raw);
  return Number.isSafeInteger(catalogId) && catalogId > 0 ? catalogId : null;
}

function normalizedUnit(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isDatabaseUniqueConflict(err) {
  return [
    err?.code,
    err?.meta?.code,
    err?.meta?.driverAdapterError?.cause?.code,
    err?.meta?.driverAdapterError?.cause?.originalCode,
    err?.original?.code,
    err?.cause?.code,
  ].some((code) => ['P2002', '23505'].includes(String(code || '').toUpperCase()));
}

// ══════════════════════════════════════════════════════════════════════
// 1. ADVANCE DEPOSITS
// ══════════════════════════════════════════════════════════════════════

/**
 * Collect an advance deposit against an admission. Returns the new
 * deposit row + running balance against the admission.
 */
export async function collectAdvanceDeposit({
  admissionId, amount, paymentMethod, paymentReference,
  purpose = 'admission_advance', notes = null, collectedBy, tenantId = null,
}) {
  const tid = tenantOr(tenantId);
  if (!admissionId) throw AppError.badRequest('admissionId is required');
  if (!VALID_PAYMENT_METHODS.has(paymentMethod)) {
    throw AppError.badRequest(`Invalid payment_method: ${paymentMethod}. Must be one of: ${[...VALID_PAYMENT_METHODS].join(', ')}`);
  }
  if (paymentMethod === 'corporate_tpa') {
    throw AppError.conflict(
      'corporate_tpa is third-party funding authority, not collected patient advance money',
      'IPD_ADVANCE_NON_PATIENT_FUNDING_MODE',
    );
  }
  if (!VALID_DEPOSIT_PURPOSES.has(purpose)) {
    throw AppError.badRequest(`Invalid purpose: ${purpose}. Must be one of: ${[...VALID_DEPOSIT_PURPOSES].join(', ')}`);
  }

  const isDeferred = paymentMethod === 'deferred';
  if (purpose === 'emergency_deferred' && !isDeferred) {
    throw AppError.badRequest('emergency_deferred purpose requires payment_method deferred');
  }
  const normalizedAmount = exactNumeric10_2(amount, 'amount', { allowZero: isDeferred });
  if (isDeferred && normalizedAmount.paise !== 0) {
    throw AppError.badRequest('deferred deposits must carry an exact zero amount');
  }
  const normalizedPaymentReference = normalizePaymentReference(
    paymentReference,
    paymentMethod,
    { deferred: isDeferred },
  );
  const normalizedNotes = normalizeAdvanceNotes(notes);

  if (!collectedBy) throw AppError.badRequest('collectedBy is required');
  if (!isUuid(collectedBy)) {
    // advance_deposits.collected_by is @db.Uuid; without this early 400
    // Prisma surfaces a generic 500 from the .create() — opaque to the
    // counter staff. Finding:
    //   2026-05-10-inpatient-admission-admission-advance-deposit-500
    throw AppError.badRequest('collectedBy must be a UUID');
  }

  // Pre-flight admission lookup outside the transaction — a missing
  // admission used to throw P2025 from inside .create on the FK insert,
  // which the global handler dropped through as a generic 500. Pulling
  // the 404 out of the tx makes the failure mode actionable.
  const admission = await findAdmissionForTenant(prisma, admissionId, tid);
  const wiring = await resolveLedgerWiring(tid);

  // Retry once on receipt_number unique-conflict — `nextReceiptNumber`
  // picks max+1 inside a tx but two concurrent collectors can both pick
  // the same value before either has COMMITted. A single retry is enough
  // for typical throughput.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await setTenantTx(tid, async (tx) => {
        const locked = await lockCanonicalIpdFundingAdmissionTx(tx, {
          tenantId: tid,
          admissionId: admission.id,
          patientUid: admission.patient_uid,
          requireBillingOpen: true,
        });
        const receiptNumber = await nextReceiptNumber(tx);
        const deposit = await tx.advance_deposits.create({
          data: {
            admission_id: locked.admission.id,
            patient_uid: locked.canonicalPatientUid,
            receipt_number: receiptNumber,
            amount: normalizedAmount.amount,
            payment_method: paymentMethod,
            payment_reference: normalizedPaymentReference,
            purpose,
            notes: normalizedNotes,
            collected_by: collectedBy,
            tenant_id: tid,
          },
        });

        // F-2 — bridge the IPD deposit to billing_advances so the cashier
        // can settle it against the eventual invoice via billingV2's
        // settleAdvance flow. The immutable source columns carry provenance;
        // `IPD/<receipt>` is only the human-facing mirror locator. Finding:
        //   2026-05-10-inpatient-admission-billing-advance-deposit-not-netted
        // Deferred-mode (amount=0) rows skip the mirror — there's nothing
        // to settle yet; the deferred row will be reconciled when the
        // real payment comes in via a sibling deposit.
        let advance = null;
        if (normalizedAmount.paise > 0) {
          const advanceRows = await tx.$queryRawUnsafe(
            `INSERT INTO billing_advances
               (patient_uid, admission_id, amount, balance, mode, reference,
                 collected_by, notes, tenant_id, collected_at,
                 ipd_advance_deposit_id, ipd_advance_deposit_payment_method,
                 ipd_advance_deposit_collected_at)
             SELECT source.patient_uid, source.admission_id,
                    source.amount, source.amount, source.payment_method,
                    'IPD/' || source.receipt_number,
                    source.collected_by, source.notes, source.tenant_id,
                    source.collected_at, source.id, source.payment_method,
                    source.collected_at
               FROM advance_deposits source
              WHERE source.tenant_id = $1::uuid
                AND source.id = $2::int
                AND source.is_refund = FALSE
                AND source.parent_deposit_id IS NULL
                AND source.amount > 0
             RETURNING id, patient_uid, admission_id, amount, balance, mode,
                       reference, collected_by, status, tenant_id, collected_at,
                       ipd_advance_deposit_id, ipd_advance_deposit_payment_method,
                       ipd_advance_deposit_collected_at, updated_at`,
            tid,
            Number(deposit.id),
          );
          if (advanceRows.length !== 1) {
            throw AppError.internal(
              'IPD advance mirror creation did not return exactly one row',
              'IPD_ADVANCE_MIRROR_CREATE_FAILED',
            );
          }
          const insertedAdvance = advanceRows[0];
          advance = await lockExactIpdAdvanceMirrorTx(tx, {
            tenantId: tid,
            parent: deposit,
          });
          if (Number(advance.id) !== Number(insertedAdvance.id)) {
            throw AppError.conflict(
              'The created IPD billing mirror is not the unique receipt mirror',
              'IPD_ADVANCE_MIRROR_CREATE_AMBIGUOUS',
            );
          }
          if (wiring.sameTx) {
            await postAdvanceCollectEntry({ advance, tenantId: tid, tx });
            const derived = await deriveAdvanceBalanceFromLedgerTx(tx, Number(advance.id));
            if (storedMoneyPaise(derived.balance, 'derived billing advance balance')
                !== normalizedAmount.paise) {
              throw AppError.conflict(
                'The ledger did not reproduce the collected IPD advance amount',
                'IPD_ADVANCE_LEDGER_COLLECT_MISMATCH',
              );
            }
          }
        }

        return { deposit, advance };
      });
      if (wiring.postCommit && result.advance) {
        try {
          await postAdvanceCollectEntry({ advance: result.advance, tenantId: tid });
        } catch (ledgerErr) {
          logger.error('Ledger ADVANCE_COLLECT post failed (non-blocking)', {
            advance_id: result.advance.id,
            error: ledgerErr.message,
          });
        }
      }
      return result.deposit;
    } catch (err) {
      // Prisma P2002 = unique constraint violation. Retry once for receipt_number.
      if (isDatabaseUniqueConflict(err) && attempt === 0) {
        logger.warn(`collectAdvanceDeposit: receipt_number conflict on admission ${admissionId}, retrying`);
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop either returns or rethrows.
  throw AppError.badRequest('Failed to allocate receipt number after retry');
}

/**
 * Raise a PENDING billing refund request against the exact IPD advance mirror.
 * Approval and payout stay on the separately authorised billing workflows.
 */
export async function refundAdvanceDeposit({
  parentDepositId,
  refundAmount,
  paymentMethod,
  paymentReference,
  notes = null,
  refundedBy,
  tenantId = null,
  commandKey = null,
  requestFingerprint = null,
  httpIdempotencyClaimId = null,
  requestId = null,
  auditContext = null,
  idempotencyPath = null,
}) {
  const tid = tenantOr(tenantId);
  const command = normalizeIpdAdvanceRefundRequest({
    parentDepositId,
    refundAmount,
    paymentMethod,
    paymentReference,
    notes,
  });
  if (!refundedBy) throw AppError.badRequest('refundedBy is required');
  if (!isUuid(refundedBy)) throw AppError.badRequest('refundedBy must be a UUID');
  if (idempotencyPath != null && String(idempotencyPath) !== command.idempotencyPath) {
    throw AppError.badRequest(
      'IPD advance refund idempotency path does not match the deposit command',
      'IPD_ADVANCE_REFUND_IDEMPOTENCY_PATH_INVALID',
    );
  }

  const candidate = await loadIpdAdvanceRefundCandidate(command.parentDepositId, tid);
  return raiseBillingRefund({
    patient_uid: String(candidate.patient_uid),
    advance_id: Number(candidate.advance_id),
    amount: command.amount,
    reason: command.reason,
    mode: command.mode,
    raised_by: refundedBy,
    tenantId: tid,
    commandKey,
    requestFingerprint,
    httpIdempotencyClaimId,
    requestId,
    auditContext,
    expectedIdempotencyBody: command.idempotencyBody,
    idempotencyPath: command.idempotencyPath,
    validateParentSourceTx: (context) => validateIpdAdvanceRefundParentSourceTx(
      context,
      { candidate, command },
    ),
  });
}

export async function listAdmissionAdvanceRefundRequests(
  admissionId,
  { tenantId = null } = {},
) {
  const tid = tenantOr(tenantId);
  return prisma.$queryRawUnsafe(
    `SELECT refund.id,
            mirror.ipd_advance_deposit_id AS parent_deposit_id,
            refund.advance_id, refund.amount, refund.reason, refund.mode,
            refund.approval_status, refund.raised_by, refund.raised_at,
            refund.approved_by, refund.approved_at,
            refund.rejected_by, refund.rejected_at, refund.rejection_reason,
            refund.paid_by, refund.paid_at,
            refund.created_at, refund.updated_at
       FROM billing_refunds refund
       JOIN billing_advances mirror
         ON mirror.tenant_id = refund.tenant_id
        AND mirror.id = refund.advance_id
      WHERE refund.tenant_id = $1::uuid
        AND mirror.admission_id = $2::int
        AND mirror.ipd_advance_deposit_id IS NOT NULL
      ORDER BY COALESCE(refund.raised_at, refund.created_at) DESC, refund.id DESC`,
    tid,
    Number(admissionId),
  );
}

/**
 * Sum all deposits + refunds against an admission. Used by the discharge
 * cascade / final bill to compute net advance available.
 *
 * D61 — Deferred admission advances. `billing_advances` accepts rows
 * with `admission_id = NULL` so the cashier can collect an advance at
 * booking-time (before the admission row exists). Once the patient is
 * admitted, that deposit should count against the admission's balance,
 * but historically `getAdmissionDepositBalance` only summed
 * `advance_deposits` (admission-linked only) and showed zero. The
 * discharge cashier then asked the patient to pay AGAIN.
 *
 * One statement surfaces both without counting the same receipt twice:
 *   (a) an exact IPD mirror contributes its current billing advance balance,
 *       so settlements and governed refunds remain visible;
 *   (b) an unmirrored legacy IPD root contributes its net deposit/refund chain;
 *   (c) independently-created billing advances contribute their balance once.
 * Finding 2026-05-22-..._ac0e6a1e.
 */
export async function getAdmissionDepositBalance(admissionId, { tenantId = null } = {}) {
  if (!admissionId) return 0;
  const tid = tenantOr(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `WITH RECURSIVE admission_scope AS (
       SELECT id, patient_uid, admitted_at, created_at
         FROM admissions
        WHERE tenant_id = $2::uuid
          AND id = $1::int
     ),
     patient_uid_family(uid) AS (
       SELECT admission.patient_uid
         FROM admission_scope admission
       UNION
       SELECT predecessor.uid
         FROM users predecessor
         JOIN patient_uid_family family
           ON predecessor.merged_into_uid = family.uid
        WHERE predecessor.tenant_id = $2::uuid
          AND predecessor.role = 'PATIENT'
     ),
     patient_uid_family_state AS (
       SELECT COUNT(*) FILTER (
                WHERE admission.id IS NOT NULL
                  AND (
                    patient.uid IS NULL
                    OR patient.role <> 'PATIENT'
                    OR patient.merged_into_uid IS NOT NULL
                  )
              )::int AS invalid_rows
         FROM admission_scope admission
         LEFT JOIN users patient
           ON patient.tenant_id = $2::uuid
          AND patient.uid = admission.patient_uid
     ),
     ipd_roots AS (
       SELECT deposit.id, deposit.admission_id, deposit.patient_uid,
               deposit.receipt_number, deposit.amount, deposit.parent_deposit_id,
               deposit.payment_method, deposit.payment_reference,
               deposit.purpose, deposit.collected_by, deposit.collected_at,
              EXISTS (
                SELECT 1
                  FROM patient_uid_family family
                 WHERE family.uid = deposit.patient_uid
              ) AS patient_matches_admission
         FROM advance_deposits deposit
         JOIN admission_scope admission ON admission.id = deposit.admission_id
        WHERE deposit.tenant_id = $2::uuid
          AND deposit.is_refund = FALSE
     ),
     ipd_refund_summary AS (
       SELECT refund.parent_deposit_id,
              COALESCE(SUM(refund.amount), 0)::numeric AS refund_total,
              COUNT(*) FILTER (
                WHERE refund.amount >= 0
                   OR refund.admission_id IS DISTINCT FROM root.admission_id
                   OR refund.patient_uid IS DISTINCT FROM root.patient_uid
                   OR refund.purpose IS DISTINCT FROM root.purpose
              )::int AS invalid_rows
         FROM advance_deposits refund
         JOIN ipd_roots root ON root.id = refund.parent_deposit_id
        WHERE refund.tenant_id = $2::uuid
          AND refund.is_refund = TRUE
        GROUP BY refund.parent_deposit_id
     ),
     ipd_root_state AS (
       SELECT root.id,
              root.amount + COALESCE(refund.refund_total, 0) AS net_amount,
              COALESCE(refund.invalid_rows, 0)::int AS invalid_refund_rows,
              root.patient_matches_admission,
               root.parent_deposit_id,
               root.payment_method,
               root.receipt_number,
               root.payment_reference,
               root.amount,
              COUNT(mirror.id)::int AS mirror_count,
              COUNT(mirror.id) FILTER (
                WHERE mirror.ipd_advance_deposit_id = root.id
                  AND mirror.admission_id = root.admission_id
                  AND mirror.patient_uid = root.patient_uid
                  AND mirror.amount = root.amount
                  AND mirror.ipd_advance_deposit_payment_method
                    IS NOT DISTINCT FROM root.payment_method
                  AND UPPER(BTRIM(mirror.mode))
                    IS NOT DISTINCT FROM UPPER(BTRIM(root.payment_method))
                  AND mirror.reference = 'IPD/' || root.receipt_number
                  AND mirror.collected_by IS NOT DISTINCT FROM root.collected_by
                  AND mirror.ipd_advance_deposit_collected_at
                    IS NOT DISTINCT FROM root.collected_at
                  AND DATE_TRUNC('milliseconds', mirror.collected_at)
                    IS NOT DISTINCT FROM DATE_TRUNC('milliseconds', root.collected_at)
                  AND mirror.balance >= 0
                  AND mirror.balance <= mirror.amount
                  AND (
                    (mirror.balance > 0
                      AND UPPER(BTRIM(mirror.status)) IN ('ACTIVE', 'REFUND_DUE'))
                    OR
                    (mirror.balance = 0
                      AND UPPER(BTRIM(mirror.status)) IN ('EXHAUSTED', 'REFUNDED'))
                  )
              )::int AS exact_mirror_count
         FROM ipd_roots root
         LEFT JOIN ipd_refund_summary refund ON refund.parent_deposit_id = root.id
         LEFT JOIN billing_advances mirror
           ON mirror.tenant_id = $2::uuid
          AND mirror.ipd_advance_deposit_id = root.id
         GROUP BY root.id, root.admission_id, root.patient_uid, root.amount,
                  root.parent_deposit_id, root.payment_method,
                  root.receipt_number, root.payment_reference,
                  root.collected_by, root.collected_at,
                 root.patient_matches_admission,
                 refund.refund_total, refund.invalid_rows
     ),
     ipd_deposit_total AS (
       SELECT COALESCE(SUM(
                CASE WHEN root_state.mirror_count = 0
                     THEN root_state.net_amount ELSE 0 END
              ), 0)::numeric AS total,
              COUNT(*) FILTER (
                WHERE root_state.mirror_count > 1
                   OR (root_state.mirror_count = 1
                     AND root_state.exact_mirror_count <> 1)
              )::int AS invalid_mirror_roots,
              COALESCE(SUM(root_state.invalid_refund_rows), 0)::int AS invalid_refund_rows,
              COUNT(*) FILTER (WHERE root_state.net_amount < 0)::int AS negative_roots,
              COUNT(*) FILTER (
                WHERE root_state.patient_matches_admission IS NOT TRUE
              )::int AS wrong_patient_roots,
              COUNT(*) FILTER (
                 WHERE root_state.parent_deposit_id IS NOT NULL
                    OR root_state.amount < 0
                    OR NULLIF(BTRIM(root_state.receipt_number), '') IS NULL
                    OR (
                      LOWER(BTRIM(root_state.payment_method)) IN (
                        'card', 'upi', 'cheque', 'online', 'bank_transfer'
                      )
                      AND NULLIF(BTRIM(root_state.payment_reference), '') IS NULL
                    )
                    OR LOWER(BTRIM(root_state.payment_method)) = 'corporate_tpa'
                   OR (
                     root_state.amount = 0
                     AND LOWER(BTRIM(root_state.payment_method)) <> 'deferred'
                   )
                   OR (
                     root_state.amount > 0
                     AND LOWER(BTRIM(root_state.payment_method)) = 'deferred'
                   )
                   OR LOWER(BTRIM(root_state.payment_method)) NOT IN (
                     'cash', 'card', 'upi', 'cheque', 'online', 'bank_transfer', 'deferred'
                   )
              )::int AS invalid_root_shapes
         FROM ipd_root_state root_state
     ),
     orphan_refund_total AS (
       SELECT COUNT(*)::int AS invalid_rows
         FROM advance_deposits refund
         JOIN admission_scope admission ON admission.id = refund.admission_id
        WHERE refund.tenant_id = $2::uuid
          AND refund.is_refund = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM ipd_roots root
             WHERE root.id = refund.parent_deposit_id
          )
     ),
     billing_advance_total AS (
       SELECT COALESCE(SUM(advance.balance), 0)::numeric AS total,
              COUNT(*) FILTER (
                WHERE advance.balance < 0
                   OR advance.balance > advance.amount
                   OR advance.amount <= 0
                    OR (
                      advance.admission_id = admission.id
                      AND NOT EXISTS (
                        SELECT 1
                          FROM patient_uid_family family
                         WHERE family.uid = advance.patient_uid
                      )
                    )
                    OR LOWER(BTRIM(advance.mode)) IN ('deferred', 'corporate_tpa')
                    OR (
                      advance.ipd_advance_deposit_id IS NULL
                      AND UPPER(BTRIM(advance.mode)) NOT IN (
                        'CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD',
                        'WALLET', 'INSURANCE'
                      )
                    )
                   OR (
                     advance.balance > 0
                     AND UPPER(BTRIM(advance.status)) NOT IN ('ACTIVE', 'REFUND_DUE')
                   )
                   OR (
                     advance.balance = 0
                     AND UPPER(BTRIM(advance.status)) NOT IN ('EXHAUSTED', 'REFUNDED')
                   )
              )::int AS invalid_rows
         FROM billing_advances advance
         JOIN admission_scope admission
           ON advance.admission_id = admission.id
           OR (
             advance.admission_id IS NULL
             AND EXISTS (
               SELECT 1
                 FROM patient_uid_family family
                WHERE family.uid = advance.patient_uid
             )
             AND advance.collected_at <= COALESCE(admission.admitted_at, admission.created_at)
           )
        WHERE advance.tenant_id = $2::uuid
          AND COALESCE(advance.status, 'ACTIVE') <> 'CANCELLED'
     )
     SELECT (ipd.total + advance.total)::numeric AS total,
            ipd.invalid_mirror_roots,
            ipd.invalid_refund_rows,
            ipd.negative_roots,
            ipd.wrong_patient_roots,
            ipd.invalid_root_shapes,
            orphan.invalid_rows AS orphan_refund_rows,
            advance.invalid_rows AS invalid_advance_rows,
            patient_identity.invalid_rows AS invalid_patient_identity_rows
       FROM ipd_deposit_total ipd
       CROSS JOIN orphan_refund_total orphan
       CROSS JOIN billing_advance_total advance
       CROSS JOIN patient_uid_family_state patient_identity`,
    Number(admissionId),
    tid,
  );
  const evidence = rows[0] || {};
  const invalidEvidence = {
    mirror_roots: Number(evidence.invalid_mirror_roots || 0),
    refund_rows: Number(evidence.invalid_refund_rows || 0),
    negative_roots: Number(evidence.negative_roots || 0),
    wrong_patient_roots: Number(evidence.wrong_patient_roots || 0),
    root_shapes: Number(evidence.invalid_root_shapes || 0),
    orphan_refunds: Number(evidence.orphan_refund_rows || 0),
    advance_rows: Number(evidence.invalid_advance_rows || 0),
    patient_identity_rows: Number(evidence.invalid_patient_identity_rows || 0),
  };
  if (Object.values(invalidEvidence).some((count) => count !== 0)) {
    throw AppError.conflict(
      'Admission advance balance evidence is ambiguous or internally inconsistent',
      'IPD_ADVANCE_BALANCE_EVIDENCE_INVALID',
      invalidEvidence,
    );
  }
  return storedMoneyPaise(
    evidence.total ?? 0,
    'admission deposit balance',
    { precision: 14 },
  ) / 100;
}

export async function listAdmissionDeposits(admissionId, { tenantId = null } = {}) {
  return prisma.advance_deposits.findMany({
    where: { admission_id: admissionId, tenant_id: tenantOr(tenantId) },
    orderBy: { collected_at: 'asc' },
  });
}

// ══════════════════════════════════════════════════════════════════════
// 2. ATTENDANT PASSES
// ══════════════════════════════════════════════════════════════════════

/**
 * Auto-issue ATTENDANT_PASS_COUNT_PER_ADMISSION (=2) passes for an
 * admission. Called from admitPatient inside its transaction. Snapshots
 * the ward's pass color + screening level at issue time.
 *
 * @param {Object} tx prisma transaction client
 * @param {Object} args { admissionId, patientUid, patientName, wardId, wardName, issuedBy }
 * @returns {Array<Object>} the issued passes
 */
export async function issueDefaultAttendantPasses(tx, {
  admissionId, patientUid, patientName, wardId, wardName, issuedBy, tenantId = null,
}) {
  if (!admissionId) throw AppError.badRequest('admissionId is required');
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  if (!issuedBy) throw AppError.badRequest('issuedBy is required');

  // Look up ward color + screening level. Snapshot at issue so a
  // mid-stay ward color edit doesn't mutate already-printed passes.
  let passColor = null;
  let screeningLevel = 'standard';
  if (wardId) {
    const ward = await tx.wards.findUnique({
      where: { id: wardId },
      select: { attendant_pass_color: true, attendant_pass_screening_level: true },
    });
    passColor = ward?.attendant_pass_color ?? null;
    screeningLevel = ward?.attendant_pass_screening_level ?? 'standard';
  }

  const passes = [];
  const expiresAt = defaultAttendantPassExpiry();
  for (let i = 1; i <= ATTENDANT_PASS_COUNT_PER_ADMISSION; i++) {
    const passNumber = await nextPassNumber(tx, admissionId, i);
    const created = await tx.attendant_passes.create({
      data: {
        admission_id: admissionId,
        patient_uid: patientUid,
        pass_number: passNumber,
        pass_index: i,
        patient_name_snapshot: patientName ?? null,
        pass_color: passColor,
        ward_at_issue: wardName ?? null,
        screening_level: screeningLevel,
        issued_by: issuedBy,
        expires_at: expiresAt,
        tenant_id: tenantOr(tenantId),
      },
    });
    passes.push(created);
  }
  return passes;
}

/**
 * Revoke an attendant pass (lost / replaced / disciplinary).
 */
export async function revokeAttendantPass({ passId, revokedBy, reason = null, tenantId = null }) {
  if (!passId) throw AppError.badRequest('passId is required');
  if (!revokedBy) throw AppError.badRequest('revokedBy is required');
  const tid = tenantOr(tenantId);

  const pass = await prisma.attendant_passes.findFirst({
    where: { id: passId, tenant_id: tid },
    select: { id: true },
  });
  if (!pass) throw AppError.notFound('Attendant pass not found');

  return prisma.attendant_passes.update({
    where: { id: pass.id },
    data: {
      status: 'revoked',
      revoked_by: revokedBy,
      revoked_at: new Date(),
      revocation_reason: reason,
      updated_at: new Date(),
    },
  });
}

/**
 * Issue a replacement pass when one is lost / revoked. Re-uses the
 * same pass_index so the (admission_id, pass_index) UNIQUE constraint
 * stays valid — new passes get a higher pass_index past the original 2.
 */
export async function issueReplacementAttendantPass({
  admissionId, patientUid, patientName, wardId, wardName, issuedBy, notes = null, tenantId = null,
}) {
  const tid = tenantOr(tenantId);
  return setTenantTx(tid, async (tx) => {
    const admission = await findAdmissionForTenant(tx, admissionId, tid);
    if (patientUid && patientUid !== admission.patient_uid) {
      throw AppError.forbidden('Attendant pass patient does not belong to this admission', 'PASS_PATIENT_MISMATCH');
    }
    const lastIndex = await tx.attendant_passes.aggregate({
      where: { admission_id: admission.id, tenant_id: tid },
      _max: { pass_index: true },
    });
    const nextIndex = (lastIndex._max.pass_index ?? 0) + 1;
    // Direct create rather than issueDefaultAttendantPasses so we can pass
    // explicit pass_index = nextIndex. (A leftover call to the bulk helper
    // here re-issued pass_index 1+2, hit the (admission_id, pass_index)
    // unique, and left the tx aborted — every replacement then failed with
    // 25P02 even though the JS error was swallowed.)
    const passNumber = await nextPassNumber(tx, admission.id, nextIndex);
    let passColor = null;
    let screeningLevel = 'standard';
    if (wardId) {
      const ward = await tx.wards.findUnique({
        where: { id: wardId },
        select: { attendant_pass_color: true, attendant_pass_screening_level: true },
      });
      passColor = ward?.attendant_pass_color ?? null;
      screeningLevel = ward?.attendant_pass_screening_level ?? 'standard';
    }
    return tx.attendant_passes.create({
      data: {
        admission_id: admission.id,
        patient_uid: admission.patient_uid,
        pass_number: passNumber,
        pass_index: nextIndex,
        patient_name_snapshot: patientName ?? null,
        pass_color: passColor,
        ward_at_issue: wardName ?? null,
        screening_level: screeningLevel,
        issued_by: issuedBy,
        notes,
        tenant_id: tid,
        // Replacements inherit the same default validity window as
        // the original auto-issued passes — without this, security
        // can't tell a stale replacement from a current one.
        expires_at: defaultAttendantPassExpiry(),
      },
    });
  });
}

/**
 * Expire all active passes for an admission. Called from
 * dischargePatient when the patient leaves. Status flips to 'expired';
 * the row is preserved for audit.
 */
export async function expireAttendantPassesForAdmission(tx, admissionId) {
  return tx.attendant_passes.updateMany({
    where: { admission_id: admissionId, status: 'active' },
    data: { status: 'expired', updated_at: new Date() },
  });
}

export async function relocateActiveAttendantPasses(tx, {
  admissionId, wardId = null, wardName = null,
}) {
  if (!admissionId) throw AppError.badRequest('admissionId is required');

  let passColor;
  let screeningLevel;
  if (wardId) {
    const ward = await tx.wards.findUnique({
      where: { id: wardId },
      select: { attendant_pass_color: true, attendant_pass_screening_level: true, name: true },
    });
    passColor = ward?.attendant_pass_color ?? null;
    screeningLevel = ward?.attendant_pass_screening_level ?? 'standard';
    wardName = ward?.name ?? wardName;
  }

  const data = {
    ward_at_issue: wardName ?? null,
    updated_at: new Date(),
  };
  if (wardId) {
    data.pass_color = passColor;
    data.screening_level = screeningLevel;
  }

  return tx.attendant_passes.updateMany({
    where: { admission_id: admissionId, status: 'active' },
    data,
  });
}

export async function listAdmissionPasses(admissionId, { tenantId = null } = {}) {
  return prisma.attendant_passes.findMany({
    where: { admission_id: admissionId, tenant_id: tenantOr(tenantId) },
    orderBy: { pass_index: 'asc' },
  });
}

// ══════════════════════════════════════════════════════════════════════
// 3. WARD INDENTS
// ══════════════════════════════════════════════════════════════════════

/**
 * Open a new ward indent in 'requested' state.
 */
export async function createWardIndent({
  wardId, admissionId = null, encounterId = null, patientUid = null,
  indentType = 'pharmacy', items, notes = null, requestedBy, tenantId = null,
  commandKey = null,
}) {
  const tid = tenantOr(tenantId);
  if (!VALID_INDENT_TYPES.has(indentType)) {
    throw AppError.badRequest(`Invalid indent_type: ${indentType}`);
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('items must be a non-empty array');
  }
  if (!requestedBy) throw AppError.badRequest('requestedBy is required');
  if (!isUuid(requestedBy)) throw AppError.badRequest('requestedBy must be a UUID');
  const normalizedItems = items.map((it, index) => {
    const catalogId = it?.pharmacy_catalog_id == null
      ? null
      : Number(it.pharmacy_catalog_id);
    if (catalogId != null && (!Number.isSafeInteger(catalogId) || catalogId <= 0)) {
      throw AppError.badRequest(`item ${index + 1}: pharmacy_catalog_id must be a positive integer`);
    }
    const clinicalOrderId = it?.clinical_order_id == null
      ? null
      : Number(it.clinical_order_id);
    if (clinicalOrderId != null
      && (!Number.isSafeInteger(clinicalOrderId) || clinicalOrderId <= 0)) {
      throw AppError.badRequest(`item ${index + 1}: clinical_order_id must be a positive integer`);
    }
    const itemName = String(it?.item_name || '').trim();
    if (!itemName && catalogId == null) throw AppError.badRequest('Each item requires item_name or pharmacy_catalog_id');
    const q = Number(it.quantity_requested);
    const normalizedQuantity = Math.round(q * 100) / 100;
    if (
      !Number.isFinite(q)
      || q <= 0
      || normalizedQuantity > 99999999.99
      || Math.abs(q - normalizedQuantity) > Number.EPSILON
    ) {
      throw AppError.badRequest(`item ${itemName || catalogId}: quantity_requested must be positive with at most 2 places`);
    }
    const unitPrice = it?.unit_price == null ? null : Number(it.unit_price);
    if (unitPrice != null && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
      throw AppError.badRequest(`item ${itemName || catalogId}: unit_price must be non-negative`);
    }
    return {
      catalogId,
      clinicalOrderId,
      itemName,
      quantity: normalizedQuantity,
      unit: it?.unit ?? null,
      unitPrice,
      notes: it?.notes ?? null,
    };
  });
  if (encounterId != null && !isUuid(encounterId)) {
    throw AppError.badRequest('encounter_id must be a UUID');
  }
  if (patientUid != null && !isUuid(patientUid)) {
    throw AppError.badRequest('patient_uid must be a UUID');
  }
  const clinicalOrderIds = normalizedItems
    .map((item) => item.clinicalOrderId)
    .filter((id) => id != null);
  const catalogIds = [...new Set(normalizedItems
    .map((item) => item.catalogId)
    .filter((id) => id != null))];

  // Closes finding 2026-05-17-inpatient-admission-pharmacy-05748c99.
  // Snapshot ward/patient/encounter from a locked admission inside the
  // creation transaction so a concurrent discharge cannot race an indent.
  let resolvedWardId = wardId ?? null;
  let resolvedWardName = null;
  let resolvedFacilityId = null;
  let resolvedPatientUid = patientUid;
  let resolvedEncounterId = encounterId;
  let resolvedAdmissionId = null;
  if (admissionId != null) {
    const admissionInt = Number.parseInt(admissionId, 10);
    if (!Number.isInteger(admissionInt) || admissionInt <= 0) {
      throw AppError.badRequest('admission_id must be a positive integer');
    }
    resolvedAdmissionId = admissionInt;
  }

  return setTenantTx(tid, async (tx) => {
    const replay = await findWardIndentCreateReplayTx(tx, {
      tenantId: tid,
      commandKey,
      actorUid: requestedBy,
    });
    if (replay) return replay;
    let catalogById = await loadWardIndentCatalogClassificationsTx(tx, {
      tenantId: tid,
      catalogIds,
      lock: true,
    });
    const medicationItems = normalizedItems.filter((item) => (
      indentType === 'pharmacy'
      || item.clinicalOrderId != null
      || catalogById.get(item.catalogId)?.is_medication_identity === true
    ));
    if (medicationItems.length && medicationItems.length !== normalizedItems.length) {
      throw AppError.conflict(
        'Medication and non-medication ward-stock lines cannot share one indent',
        'WARD_INDENT_MIXED_CLINICAL_CLASSIFICATION',
      );
    }
    if (medicationItems.some((item) => item.clinicalOrderId == null)) {
      throw AppError.conflict(
        'Every medication ward-indent line must be bound to a clinical order',
        'WARD_INDENT_CLINICAL_ORDER_REQUIRED',
      );
    }
    const medicationWardIndent = medicationItems.length > 0;
    const resolvedIndentType = medicationWardIndent ? 'pharmacy' : indentType;
    if (medicationWardIndent && resolvedAdmissionId == null) {
      throw AppError.badRequest(
        'admission_id is required for a medication ward indent',
        'WARD_INDENT_ADMISSION_REQUIRED',
      );
    }
    if (resolvedAdmissionId != null) {
      const rows = await tx.$queryRawUnsafe(
        `SELECT a.id, a.patient_uid, a.encounter_id, a.status,
                b.ward_id, COALESCE(w.name, b.ward_name, a.ward) AS ward_name,
                w.facility_id
           FROM admissions a
           LEFT JOIN beds b
             ON b.tenant_id = a.tenant_id
            AND b.id = a.bed_id
           LEFT JOIN wards w
             ON w.tenant_id = a.tenant_id
            AND w.id = b.ward_id
          WHERE a.id = $1::int
            AND a.tenant_id = $2::uuid
          FOR SHARE OF a`,
        resolvedAdmissionId, tid,
      );
      const admission = rows[0];
      if (!admission) {
        throw AppError.notFound(
          'Admission not found',
          'WARD_INDENT_ADMISSION_NOT_FOUND',
        );
      }
      if (!['admitted', 'transferred'].includes(
        String(admission.status || '').trim().toLowerCase(),
      )) {
        throw AppError.conflict(
          'Ward indent cannot be created for an inactive admission',
          'WARD_INDENT_ADMISSION_INACTIVE',
          { admission_id: Number(admission.id), status: admission.status || null },
        );
      }
      if (wardId != null && (
        admission.ward_id == null || Number(wardId) !== Number(admission.ward_id)
      )) {
        throw AppError.badRequest(
          'ward_id does not match the admission ward',
          'WARD_INDENT_ADMISSION_WARD_MISMATCH',
        );
      }
      if (patientUid != null && String(patientUid) !== String(admission.patient_uid)) {
        throw AppError.badRequest(
          'patient_uid does not match the admission patient',
          'WARD_INDENT_ADMISSION_PATIENT_MISMATCH',
        );
      }
      if (encounterId != null && String(encounterId) !== String(admission.encounter_id)) {
        throw AppError.badRequest(
          'encounter_id does not match the admission encounter',
          'WARD_INDENT_ADMISSION_ENCOUNTER_MISMATCH',
        );
      }
      if (medicationWardIndent && admission.patient_uid == null) {
        throw AppError.conflict(
          'Medication ward-indent admission has no authoritative patient',
          'WARD_INDENT_ADMISSION_PATIENT_REQUIRED',
        );
      }
      if (medicationWardIndent && admission.encounter_id == null) {
        throw AppError.conflict(
          'Medication ward-indent admission has no authoritative encounter',
          'WARD_INDENT_ADMISSION_ENCOUNTER_REQUIRED',
        );
      }
      if (medicationWardIndent && admission.ward_id == null) {
        throw AppError.conflict(
          'Medication ward-indent admission has no authoritative ward',
          'WARD_INDENT_ADMISSION_WARD_REQUIRED',
        );
      }
      resolvedWardId = medicationWardIndent
        ? Number(admission.ward_id)
        : admission.ward_id ?? resolvedWardId;
      resolvedWardName = medicationWardIndent
        ? admission.ward_name
        : admission.ward_name ?? resolvedWardName;
      // The locked admission ward is the facility authority for this indent;
      // the ward/facility re-check below fails closed if it moved mid-create.
      resolvedFacilityId = admission.facility_id == null
        ? null
        : Number(admission.facility_id);
      resolvedPatientUid = medicationWardIndent
        ? admission.patient_uid
        : admission.patient_uid ?? resolvedPatientUid;
      resolvedEncounterId = medicationWardIndent
        ? admission.encounter_id
        : admission.encounter_id ?? resolvedEncounterId;
    }
    if (resolvedPatientUid != null) {
      const patientRows = await tx.$queryRawUnsafe(
        `SELECT uid
           FROM users
          WHERE uid = $1::uuid
            AND tenant_id = $2::uuid
            AND role = 'PATIENT'
          LIMIT 1`,
        resolvedPatientUid, tid,
      );
      if (!patientRows.length) throw AppError.notFound('Patient not found');
    }
    if (resolvedWardId) {
      const wards = await tx.$queryRawUnsafe(
        `SELECT ward.name, ward.facility_id
           FROM wards ward
           JOIN facilities facility
             ON facility.tenant_id=ward.tenant_id
            AND facility.id=ward.facility_id
            AND facility.status='active'
          WHERE ward.tenant_id=$1::uuid AND ward.id=$2::int
          FOR SHARE OF ward, facility`,
        tid,
        Number(resolvedWardId),
      );
      if (!wards.length) {
        throw AppError.conflict(
          'Pharmacy ward indent requires a ward assigned to an active facility',
          'WARD_INDENT_FACILITY_REQUIRED',
        );
      }
      if (resolvedFacilityId != null
          && resolvedFacilityId !== Number(wards[0].facility_id)) {
        throw AppError.conflict(
          'Admission ward facility changed during indent creation',
          'WARD_INDENT_FACILITY_CHANGED',
        );
      }
      resolvedWardName = wards[0].name;
      resolvedFacilityId = Number(wards[0].facility_id);
    } else if (indentType === 'pharmacy') {
      throw AppError.conflict(
        'Pharmacy ward indent requires an exact ward and active facility',
        'WARD_INDENT_FACILITY_REQUIRED',
      );
    }
    if (new Set(clinicalOrderIds).size !== clinicalOrderIds.length) {
      throw AppError.badRequest(
        'A clinical order can be linked to only one ward-indent line',
        'WARD_INDENT_DUPLICATE_CLINICAL_ORDER_LINK',
      );
    }
    if (clinicalOrderIds.length) {
      if (!resolvedPatientUid) {
        throw AppError.badRequest(
          'patient_uid or admission_id is required when linking a clinical order',
          'WARD_INDENT_CLINICAL_ORDER_PATIENT_REQUIRED',
        );
      }
      const linkedOrders = await tx.$queryRawUnsafe(
        `SELECT clinical_order.id, clinical_order.patient_uid,
                clinical_order.encounter_id, clinical_order.order_type,
                clinical_order.status, clinical_order.verified_by::text,
                clinical_order.verified_at, clinical_order.details
           FROM clinical_orders clinical_order
          WHERE clinical_order.tenant_id = $1::uuid
            AND clinical_order.id = ANY($2::int[])
          ORDER BY clinical_order.id
          FOR SHARE`,
        tid,
        clinicalOrderIds,
      );
      const linkedById = new Map(linkedOrders.map((order) => [Number(order.id), order]));
      for (const clinicalOrderId of clinicalOrderIds) {
        const order = linkedById.get(clinicalOrderId);
        if (!order || order.order_type !== 'medication') {
          throw AppError.notFound(`Medication clinical order ${clinicalOrderId} not found`);
        }
        const orderStatus = String(order.status || '').trim().toLowerCase();
        if (!['ordered', 'verified', 'in_progress'].includes(orderStatus)) {
          throw AppError.conflict(
            `Clinical order ${clinicalOrderId} is not active for a ward indent`,
            'WARD_INDENT_CLINICAL_ORDER_INACTIVE',
            { clinical_order_id: clinicalOrderId, status: order.status || null },
          );
        }
        if (
          ['verified', 'in_progress'].includes(orderStatus)
          && (!order.verified_by || !order.verified_at)
        ) {
          throw AppError.conflict(
            `Clinical order ${clinicalOrderId} is missing dedicated verification evidence`,
            'MEDICATION_ORDER_VERIFICATION_EVIDENCE_REQUIRED',
            { clinical_order_id: clinicalOrderId, status: order.status || null },
          );
        }
        if (String(order.patient_uid) !== String(resolvedPatientUid)) {
          throw AppError.badRequest(
            `Clinical order ${clinicalOrderId} does not belong to the indent patient`,
            'WARD_INDENT_CLINICAL_ORDER_PATIENT_MISMATCH',
          );
        }
        if (
          !order.encounter_id
          || String(order.encounter_id) !== String(resolvedEncounterId)
        ) {
          throw AppError.badRequest(
            `Clinical order ${clinicalOrderId} does not belong to the indent encounter`,
            'WARD_INDENT_CLINICAL_ORDER_ENCOUNTER_MISMATCH',
            {
              clinical_order_id: clinicalOrderId,
              clinical_order_encounter_id: order.encounter_id || null,
              admission_encounter_id: resolvedEncounterId || null,
            },
          );
        }
        const item = normalizedItems.find((candidate) => (
          candidate.clinicalOrderId === clinicalOrderId
        ));
        const details = parseClinicalOrderDetails(order.details);
        const expectedCatalogId = manualIndentCatalogFromMedicationDetails(details);
        if (expectedCatalogId == null) {
          throw AppError.conflict(
            `Clinical order ${clinicalOrderId} has no authoritative formulary catalog`,
            'WARD_INDENT_CLINICAL_ORDER_CATALOG_REQUIRED',
            { clinical_order_id: clinicalOrderId },
          );
        }
        if (item.catalogId != null && item.catalogId !== expectedCatalogId) {
          throw AppError.conflict(
            `Ward-indent catalog does not match clinical order ${clinicalOrderId}`,
            'WARD_INDENT_CLINICAL_ORDER_CATALOG_MISMATCH',
            {
              clinical_order_id: clinicalOrderId,
              expected_catalog_id: expectedCatalogId,
              requested_catalog_id: item.catalogId,
            },
          );
        }
        const expectedQuantity = manualIndentQuantityFromMedicationDetails(details);
        if (expectedQuantity == null) {
          throw AppError.conflict(
            `Clinical order ${clinicalOrderId} has no authoritative ward-supply quantity`,
            'WARD_INDENT_CLINICAL_ORDER_QUANTITY_REQUIRED',
            { clinical_order_id: clinicalOrderId },
          );
        }
        if (Math.abs(item.quantity - expectedQuantity) > Number.EPSILON) {
          throw AppError.conflict(
            `Ward-indent quantity does not match clinical order ${clinicalOrderId}`,
            'WARD_INDENT_CLINICAL_ORDER_QUANTITY_MISMATCH',
            {
              clinical_order_id: clinicalOrderId,
              expected_quantity: expectedQuantity,
              requested_quantity: item.quantity,
            },
          );
        }
        const expectedUnit = manualIndentUnitFromMedicationDetails(details);
        if (!expectedUnit) {
          throw AppError.conflict(
            `Clinical order ${clinicalOrderId} has no authoritative ward-supply unit`,
            'WARD_INDENT_CLINICAL_ORDER_UNIT_REQUIRED',
            { clinical_order_id: clinicalOrderId },
          );
        }
        if (item.unit != null && normalizedUnit(item.unit) !== normalizedUnit(expectedUnit)) {
          throw AppError.conflict(
            `Ward-indent unit does not match clinical order ${clinicalOrderId}`,
            'WARD_INDENT_CLINICAL_ORDER_UNIT_MISMATCH',
            {
              clinical_order_id: clinicalOrderId,
              expected_unit: expectedUnit,
              requested_unit: item.unit,
            },
          );
        }
        item.catalogId = expectedCatalogId;
        item.unit = expectedUnit;
      }
      // Caller catalog fields are optional on the recovery route, so the
      // authoritative order may have populated catalog IDs that were absent
      // from the first classification pass. Lock and classify the final union
      // before persisting any line, price snapshot, or workflow obligation.
      const resolvedCatalogIds = [...new Set(normalizedItems
        .map((item) => item.catalogId)
        .filter((id) => id != null))];
      catalogById = await loadMedicationCatalogAuthorityTx(tx, {
        tenantId: tid,
        catalogIds: resolvedCatalogIds,
        lock: true,
        unavailableCode: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_UNAVAILABLE',
        classificationCode: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_CLASSIFICATION_MISMATCH',
      });
      const existingLinks = await tx.$queryRawUnsafe(
        `SELECT item.clinical_order_id, indent.id AS ward_indent_id,
                indent.indent_number
           FROM ward_indent_items item
           JOIN ward_indents indent
             ON indent.tenant_id = item.tenant_id
            AND indent.id = item.ward_indent_id
          WHERE item.tenant_id = $1::uuid
            AND item.clinical_order_id = ANY($2::int[])
          LIMIT 1`,
        tid,
        clinicalOrderIds,
      );
      if (existingLinks.length) {
        throw AppError.conflict(
          `Clinical order ${existingLinks[0].clinical_order_id} already has a ward indent`,
          'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
          {
            clinical_order_id: Number(existingLinks[0].clinical_order_id),
            ward_indent_id: existingLinks[0].ward_indent_id == null
              ? null
              : Number(existingLinks[0].ward_indent_id),
            indent_number: existingLinks[0].indent_number || null,
          },
        );
      }
    }
    const indentNumber = await nextIndentNumber(tx, tid);
    const indent = await tx.ward_indents.create({
      data: {
        indent_number: indentNumber,
        ward_id: resolvedWardId,
        ward_name: resolvedWardName,
        facility_id: resolvedFacilityId,
        facility_authority_version: 1,
        admission_id: resolvedAdmissionId,
        encounter_id: resolvedEncounterId,
        patient_uid: resolvedPatientUid,
        indent_type: resolvedIndentType,
        status: 'requested',
        requested_by: requestedBy,
        notes,
        tenant_id: tid,
        items: {
          create: normalizedItems.map((item) => {
            const catalog = item.catalogId == null ? null : catalogById.get(item.catalogId);
            const itemName = catalog?.name ?? item.itemName;
            return {
              pharmacy_catalog_id: item.catalogId,
              original_pharmacy_catalog_id: item.catalogId,
              clinical_order_id: item.clinicalOrderId,
              item_name: itemName,
              original_item_name: itemName,
              quantity_requested: item.quantity,
              unit: item.unit,
              unit_price: catalog
                ? Number(catalog.unit_price ?? catalog.price ?? 0)
                : item.unitPrice,
              notes: item.notes,
            };
          }),
        },
      },
      include: { items: true },
    });
    return initializeWardIndentWorkflowTx(tx, {
      indent,
      actorUid: requestedBy,
      commandKey,
      source: 'manual_request',
    });
  }).catch(async (err) => {
    if (!isDatabaseUniqueConflict(err) || clinicalOrderIds.length === 0) {
      throw err;
    }
    const existingLinks = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT item.clinical_order_id, indent.id AS ward_indent_id,
              indent.indent_number
         FROM ward_indent_items item
         JOIN ward_indents indent
           ON indent.tenant_id = item.tenant_id
          AND indent.id = item.ward_indent_id
        WHERE item.tenant_id = $1::uuid
          AND item.clinical_order_id = ANY($2::int[])
        ORDER BY indent.created_at DESC, indent.id DESC
        LIMIT 1`,
      tid,
      clinicalOrderIds,
    ));
    if (!existingLinks[0]) throw err;
    throw AppError.conflict(
      `Clinical order ${existingLinks[0].clinical_order_id} already has a ward indent`,
      'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
      {
        clinical_order_id: Number(existingLinks[0].clinical_order_id),
        ward_indent_id: Number(existingLinks[0].ward_indent_id),
        indent_number: existingLinks[0].indent_number || null,
      },
    );
  });
}

export async function createWardIndentForClinicalMedicationOrder(order) {
  if (!order || order.order_type !== 'medication' || !order.id || !order.tenant_id) return null;

  const result = await setTenantTx(requireTenantId(order.tenant_id), async (tx) => {
    const orderRows = await tx.$queryRawUnsafe(
      `SELECT id, status, patient_uid::text, encounter_id::text, order_type,
              order_number, details, route, ordered_by::text, tenant_id::text
         FROM clinical_orders
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND order_type = 'medication'
        LIMIT 1
        FOR SHARE`,
      requireTenantId(order.tenant_id),
      Number(order.id),
    );
    const currentOrder = orderRows[0];
    if (!currentOrder) {
      throw AppError.conflict(
        'Medication order is unavailable for ward-indent materialization',
        'WARD_INDENT_CLINICAL_ORDER_NOT_FOUND',
      );
    }
    if (!['ordered', 'verified', 'in_progress'].includes(
      String(currentOrder.status || '').trim().toLowerCase(),
    )) {
      throw AppError.conflict(
        'Medication order is no longer active for ward-indent materialization',
        'WARD_INDENT_CLINICAL_ORDER_INACTIVE',
        { clinical_order_id: Number(order.id), status: currentOrder.status || null },
      );
    }
    if (
      String(currentOrder.patient_uid) !== String(order.patient_uid)
      || String(currentOrder.encounter_id || '') !== String(order.encounter_id || '')
      || String(currentOrder.ordered_by || '') !== String(order.ordered_by || '')
      || String(currentOrder.route || '') !== String(order.route || '')
      || stableClinicalOrderDetails(currentOrder.details)
        !== stableClinicalOrderDetails(order.details)
    ) {
      throw AppError.conflict(
        'Medication order context changed before ward-indent materialization',
        'WARD_INDENT_CLINICAL_ORDER_CONTEXT_CHANGED',
      );
    }
    const replay = await findWardIndentCreateReplayTx(tx, {
      tenantId: currentOrder.tenant_id,
      commandKey: `clinical-order:${currentOrder.id}`,
      actorUid: currentOrder.ordered_by,
    });
    if (replay) return { indent: replay, created: false, admission: null };
    if (!currentOrder.encounter_id || !currentOrder.ordered_by) return null;
    const details = parseClinicalOrderDetails(currentOrder.details);
    const medicationName = details.medication_name || details.medication || details.name;
    if (!medicationName) {
      throw AppError.conflict(
        'Medication order has no authoritative medication identity',
        'WARD_INDENT_CLINICAL_ORDER_MEDICATION_REQUIRED',
        { clinical_order_id: Number(currentOrder.id) },
      );
    }
    const catalogId = manualIndentCatalogFromMedicationDetails(details);
    if (catalogId == null) {
      throw AppError.conflict(
        'Medication order has no authoritative formulary catalog',
        'WARD_INDENT_CLINICAL_ORDER_CATALOG_REQUIRED',
        { clinical_order_id: Number(currentOrder.id) },
      );
    }
    const supplyQuantity = manualIndentQuantityFromMedicationDetails(details);
    if (supplyQuantity == null) {
      throw AppError.conflict(
        'Medication order has no authoritative ward-supply quantity',
        'WARD_INDENT_CLINICAL_ORDER_QUANTITY_REQUIRED',
        { clinical_order_id: Number(currentOrder.id) },
      );
    }
    const supplyUnit = manualIndentUnitFromMedicationDetails(details);
    if (!supplyUnit) {
      throw AppError.conflict(
        'Medication order has no authoritative ward-supply unit',
        'WARD_INDENT_CLINICAL_ORDER_UNIT_REQUIRED',
        { clinical_order_id: Number(currentOrder.id) },
      );
    }
    const existing = await tx.$queryRawUnsafe(
      `SELECT wi.id
         FROM ward_indents wi
         JOIN ward_indent_items wii
           ON wii.tenant_id = wi.tenant_id
          AND wii.ward_indent_id = wi.id
        WHERE wii.clinical_order_id = $1::int
          AND wi.tenant_id = $2::uuid
          AND wi.patient_uid = $3::uuid
          AND wi.encounter_id = $4::uuid
          AND wii.tenant_id = wi.tenant_id
        ORDER BY wi.created_at DESC
        LIMIT 1`,
      Number(order.id),
      order.tenant_id,
      currentOrder.patient_uid,
      currentOrder.encounter_id,
    );
    if (existing.length) {
      const indent = await tx.ward_indents.findUnique({
        where: { id: existing[0].id },
        include: { items: true },
      });
      return { indent, created: false, admission: null };
    }

    const admissions = await tx.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.ward AS admission_ward, a.encounter_id,
              a.patient_uid, a.status, b.ward_id,
              COALESCE(w.name, b.ward_name, a.ward) AS ward_name,
              facility.id AS facility_id
         FROM admissions a
         LEFT JOIN beds b
           ON b.tenant_id = a.tenant_id
          AND b.id = a.bed_id
         LEFT JOIN wards w
           ON w.tenant_id = a.tenant_id
          AND w.id = b.ward_id
         JOIN facilities facility
           ON facility.tenant_id=w.tenant_id
          AND facility.id=w.facility_id
          AND facility.status='active'
        WHERE a.encounter_id = $1::uuid
          AND a.patient_uid = $2::uuid
          -- Explicit tenant_id filter (defense-in-depth): a non-null order
          -- tenant hard-scopes the admission match so a cross-tenant
          -- encounter/patient collision cannot resolve the indent's tenant
          -- to another hospital. Null tenant preserves the prior
          -- COALESCE($3, a.tenant_id) any-tenant behaviour.
          AND ($3::uuid IS NULL OR a.tenant_id = $3::uuid)
        ORDER BY a.admitted_at DESC NULLS LAST, a.id DESC
        LIMIT 1
        FOR SHARE OF a, facility`,
      currentOrder.encounter_id,
      currentOrder.patient_uid,
      order.tenant_id || null,
    );
    const admission = admissions[0];
    if (!admission) return null;
    if (!['admitted', 'transferred'].includes(
      String(admission.status || '').trim().toLowerCase(),
    )) {
      throw AppError.conflict(
        'Ward indent cannot be created for an inactive admission',
        'WARD_INDENT_ADMISSION_INACTIVE',
        { admission_id: Number(admission.id), status: admission.status || null },
      );
    }
    if (admission.patient_uid == null) {
      throw AppError.conflict(
        'Medication ward-indent admission has no authoritative patient',
        'WARD_INDENT_ADMISSION_PATIENT_REQUIRED',
      );
    }
    if (admission.encounter_id == null) {
      throw AppError.conflict(
        'Medication ward-indent admission has no authoritative encounter',
        'WARD_INDENT_ADMISSION_ENCOUNTER_REQUIRED',
      );
    }
    if (admission.ward_id == null) {
      throw AppError.conflict(
        'Medication ward-indent admission has no authoritative ward',
        'WARD_INDENT_ADMISSION_WARD_REQUIRED',
      );
    }
    if (admission.facility_id == null) {
      throw AppError.conflict(
        'Clinical medication order requires an active facility-bound ward before pharmacy indent creation',
        'WARD_INDENT_FACILITY_REQUIRED',
      );
    }

    const catalogById = await loadMedicationCatalogAuthorityTx(tx, {
      tenantId: order.tenant_id,
      catalogIds: [catalogId],
      lock: true,
      unavailableCode: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_INACTIVE',
      classificationCode: 'WARD_INDENT_CLINICAL_ORDER_CATALOG_CLASSIFICATION_MISMATCH',
    });
    const catalog = catalogById.get(catalogId);
    const indentNumber = await nextIndentNumber(tx, order.tenant_id);

    const indent = await tx.ward_indents.create({
      data: {
        indent_number: indentNumber,
        ward_id: Number(admission.ward_id),
        ward_name: admission.ward_name ?? admission.admission_ward ?? null,
        facility_id: Number(admission.facility_id),
        facility_authority_version: 1,
        admission_id: admission.id,
        encounter_id: admission.encounter_id,
        patient_uid: admission.patient_uid,
        indent_type: 'pharmacy',
        status: 'requested',
        requested_by: currentOrder.ordered_by,
        notes: `Generated from inpatient medication order ${currentOrder.order_number}`,
        tenant_id: requireTenantId(admission.tenant_id || order.tenant_id),
        items: {
          create: [{
            pharmacy_catalog_id: Number(catalog.id),
            original_pharmacy_catalog_id: Number(catalog.id),
            clinical_order_id: Number(currentOrder.id),
            item_name: catalog.name,
            original_item_name: catalog.name,
            quantity_requested: supplyQuantity,
            unit: supplyUnit,
            unit_price: catalog.unit_price != null ? Number(catalog.unit_price) : null,
            notes: `clinical_order_id:${currentOrder.id}; order_number:${currentOrder.order_number}`,
          }],
        },
      },
      include: { items: true },
    });
    const initialized = await initializeWardIndentWorkflowTx(tx, {
      indent,
      actorUid: currentOrder.ordered_by,
      commandKey: `clinical-order:${order.id}`,
      source: 'clinical_medication_order',
    });
    return { indent: initialized, created: true, admission, order: currentOrder, medicationName };
  }).catch(async (err) => {
    if (!isDatabaseUniqueConflict(err)) throw err;
    const existingRows = await setTenantTx(requireTenantId(order.tenant_id), (tx) => (
      tx.$queryRawUnsafe(
        `SELECT item.clinical_order_id, indent.id AS ward_indent_id,
                indent.indent_number
           FROM ward_indent_items item
           JOIN ward_indents indent
             ON indent.tenant_id = item.tenant_id
            AND indent.id = item.ward_indent_id
          WHERE item.tenant_id = $1::uuid
            AND item.clinical_order_id = $2::integer
          ORDER BY indent.created_at DESC, indent.id DESC
          LIMIT 1`,
        requireTenantId(order.tenant_id),
        Number(order.id),
      )
    ));
    if (!existingRows[0]) throw err;
    throw AppError.conflict(
      `Clinical order ${existingRows[0].clinical_order_id} already has a ward indent`,
      'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
      {
        clinical_order_id: Number(existingRows[0].clinical_order_id),
        ward_indent_id: Number(existingRows[0].ward_indent_id),
        indent_number: existingRows[0].indent_number || null,
      },
    );
  });

  if (result?.created && result.indent) {
    await notifyPharmacyStaffOfWardIndent({
      indent: result.indent,
      order: result.order,
      medicationName: result.medicationName,
      admission: result.admission,
    }).catch((err) => {
      logger.warn(`Failed to notify pharmacy for ward indent ${result.indent?.indent_number || result.indent?.id}: ${err.message}`);
    });
  }

  return result?.indent ?? null;
}

async function notifyPharmacyStaffOfWardIndent({ indent, order, medicationName, admission }) {
  if (!indent?.id) return null;
  const wardName = indent.ward_name || admission?.ward_name || admission?.admission_ward || 'ward';
  // Reads an env var only — cannot throw, adds no statement to the clinical
  // write path this notification hangs off.
  const dispatchSurface = wardIndentDispatchSurfaceEnabled();
  const indentLabel = indent.indent_number || `#${indent.id}`;
  return sendStaffNotifications({
    tenantId: order.tenant_id || indent.tenant_id || admission?.tenant_id || undefined,
    recipientRoles: PHARMACY_WARD_INDENT_ROLES,
    title: dispatchSurface ? 'Ward drug indent requested' : 'Ward drug indent recorded',
    body: dispatchSurface
      ? `${medicationName} requested from ${wardName} drug chart. Please review the pharmacy ward indent for dispensing.`
      : `${medicationName} recorded from ${wardName} drug chart as indent ${indentLabel}. `
        + 'The ward-indent workbench is not activated for this release — continue the ward\'s approved manual supply process; '
        + 'do not treat this informational alert as dispatch authority.',
    type: 'WARD_PHARMACY_INDENT',
    // HIGH is reserved for alerts a recipient can act on: it drives the staff
    // Safety Center escalation ladder AND the server-side
    // unread-critical-notification-escalation cron. Until the workbench is
    // operator-activated this stays LOW so it informs without escalating.
    // Applies to rows written from here on; the pre-existing backlog is
    // demoted by migration 730. See wardIndentDispatchSurfaceEnabled() above.
    priority: dispatchSurface ? 'HIGH' : 'LOW',
    relatedId: indent.id,
    dedupe: true,
    data: {
      source: 'ip_drug_chart',
      indent_id: indent.id,
      indent_number: indent.indent_number || null,
      admission_id: indent.admission_id || admission?.id || null,
      encounter_id: indent.encounter_id || order.encounter_id || null,
      patient_uid: indent.patient_uid || order.patient_uid || null,
      ward_id: indent.ward_id || admission?.ward_id || null,
      ward_name: wardName,
      clinical_order_id: order.id || null,
      order_number: order.order_number || null,
      medication_name: medicationName,
      ...(dispatchSurface ? {
        route: `/pharmacy?tab=ward-indents&indent_id=${indent.id}`,
        action_label: 'Open ward indent',
      } : {}),
      // Lets a client tell "act on this" from "for your information" without
      // re-deriving the gate, and makes the suppressed state visible in the
      // stored notification row rather than only in this file.
      dispatch_surface_available: dispatchSurface,
    },
  });
}

export default {
  // deposits
  normalizeIpdAdvanceRefundRequest,
  collectAdvanceDeposit,
  refundAdvanceDeposit,
  listAdmissionAdvanceRefundRequests,
  getAdmissionDepositBalance,
  listAdmissionDeposits,
  // passes
  issueDefaultAttendantPasses,
  issueReplacementAttendantPass,
  revokeAttendantPass,
  expireAttendantPassesForAdmission,
  listAdmissionPasses,
  // indents
  createWardIndent,
  createWardIndentForClinicalMedicationOrder,
  wardIndentDispatchSurfaceEnabled,
  reserveWardIndent,
  markWardIndentShortSupply,
  proposeWardIndentSubstitution,
  approveWardIndentSubstitution,
  applyApprovedWardIndentSubstitution,
  approveWardIndentControlledWitnessApproval,
  requestWardIndentControlledWitnessApproval,
  rejectWardIndentSubstitution,
  approveWardIndent,
  rejectWardIndent,
  recordWardIndentControlledHandoff,
  issueWardIndent,
  receiveWardIndent,
  requestWardIndentReturn,
  reportWardIndentDiscrepancy,
  reconcileWardIndent,
  cancelWardIndent,
  closeWardIndent,
  listWardIndentPage,
  listWardIndents,
  listWardIndentInventoryCandidates,
  getWardIndent,
};
