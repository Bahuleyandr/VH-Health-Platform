// src/services/ipd/ipdSupportService.js
//
// IPD support subsystem (architectural item A4):
//   - advance_deposits: money collected against admission's eventual bill
//   - attendant_passes: 2 per admission, auto-issued at admit
//   - ward_indents: pharmacy/stores → ward consumables flow
//
// Migration 174. Per project decision 2026-05-09.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_PAYMENT_METHODS = new Set(['cash', 'card', 'upi', 'cheque', 'online', 'bank_transfer']);
const VALID_DEPOSIT_PURPOSES = new Set(['admission_advance', 'package_advance', 'attendant_deposit', 'security_deposit']);

const VALID_INDENT_TYPES = new Set(['pharmacy', 'consumables', 'linen', 'sterile_supplies']);
const VALID_INDENT_TRANSITIONS = {
  requested: new Set(['approved', 'rejected']),
  approved:  new Set(['issued', 'rejected']),
  issued:    new Set(['received']),
  received:  new Set([]),
  rejected:  new Set([]),
};

const ATTENDANT_PASS_COUNT_PER_ADMISSION = 2;

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

async function nextPassNumber(tx, admissionId, passIndex) {
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

async function nextIndentNumber(tx) {
  const now = new Date();
  const ymd = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}`;
  const prefix = `WI-${ymd}-`;
  const last = await tx.ward_indents.findFirst({
    where: { indent_number: { startsWith: prefix } },
    orderBy: { indent_number: 'desc' },
    select: { indent_number: true },
  });
  const nextSeq = last ? Number.parseInt(last.indent_number.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${pad(nextSeq, 4)}`;
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
  purpose = 'admission_advance', notes = null, collectedBy,
}) {
  if (!admissionId) throw AppError.badRequest('admissionId is required');
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) {
    throw AppError.badRequest('amount must be a positive number');
  }
  if (!VALID_PAYMENT_METHODS.has(paymentMethod)) {
    throw AppError.badRequest(`Invalid payment_method: ${paymentMethod}. Must be one of: ${[...VALID_PAYMENT_METHODS].join(', ')}`);
  }
  if (!VALID_DEPOSIT_PURPOSES.has(purpose)) {
    throw AppError.badRequest(`Invalid purpose: ${purpose}. Must be one of: ${[...VALID_DEPOSIT_PURPOSES].join(', ')}`);
  }
  if (!collectedBy) throw AppError.badRequest('collectedBy is required');

  return prisma.$transaction(async (tx) => {
    const admission = await tx.admissions.findUnique({
      where: { id: admissionId },
      select: { id: true, patient_uid: true, status: true, billing_closed_at: true },
    });
    if (!admission) throw AppError.notFound('Admission not found');
    if (admission.billing_closed_at) {
      throw AppError.badRequest(
        `Admission billing is closed (since ${admission.billing_closed_at.toISOString()}). Cannot collect new advance deposit.`,
      );
    }

    const receiptNumber = await nextReceiptNumber(tx);
    const deposit = await tx.advance_deposits.create({
      data: {
        admission_id: admissionId,
        patient_uid: admission.patient_uid,
        receipt_number: receiptNumber,
        amount: num,
        payment_method: paymentMethod,
        payment_reference: paymentReference ?? null,
        purpose,
        notes,
        collected_by: collectedBy,
      },
    });
    return deposit;
  });
}

/**
 * Refund (full or partial) an existing deposit. Models the refund as a
 * sibling negative-amount row pointing at the parent — keeps the audit
 * trail clean and supports multiple partial refunds.
 */
export async function refundAdvanceDeposit({
  parentDepositId, refundAmount, paymentMethod, paymentReference,
  notes = null, refundedBy,
}) {
  if (!parentDepositId) throw AppError.badRequest('parentDepositId is required');
  const num = Number(refundAmount);
  if (!Number.isFinite(num) || num <= 0) {
    throw AppError.badRequest('refundAmount must be a positive number');
  }
  if (!VALID_PAYMENT_METHODS.has(paymentMethod)) {
    throw AppError.badRequest(`Invalid payment_method: ${paymentMethod}`);
  }
  if (!refundedBy) throw AppError.badRequest('refundedBy is required');

  return prisma.$transaction(async (tx) => {
    const parent = await tx.advance_deposits.findUnique({
      where: { id: parentDepositId },
      select: {
        id: true, amount: true, admission_id: true, patient_uid: true,
        is_refund: true, purpose: true,
      },
    });
    if (!parent) throw AppError.notFound('Parent deposit not found');
    if (parent.is_refund) {
      throw AppError.badRequest('Cannot refund a refund row — refund the original deposit');
    }
    // Sum existing refunds against this parent.
    const existingRefunds = await tx.advance_deposits.aggregate({
      where: { parent_deposit_id: parentDepositId, is_refund: true },
      _sum: { amount: true },
    });
    const alreadyRefunded = Math.abs(Number(existingRefunds._sum.amount ?? 0));
    const parentAmount = Number(parent.amount);
    if (alreadyRefunded + num > parentAmount) {
      throw AppError.badRequest(
        `Refund total would exceed deposit (${parentAmount}; already refunded ${alreadyRefunded}; this refund ${num})`,
      );
    }

    const receiptNumber = await nextReceiptNumber(tx);
    const refund = await tx.advance_deposits.create({
      data: {
        admission_id: parent.admission_id,
        patient_uid: parent.patient_uid,
        receipt_number: receiptNumber,
        amount: -num,                       // negative for the refund row
        parent_deposit_id: parent.id,
        payment_method: paymentMethod,
        payment_reference: paymentReference ?? null,
        purpose: parent.purpose,
        is_refund: true,
        notes,
        collected_by: refundedBy,
      },
    });
    return refund;
  });
}

/**
 * Sum all deposits + refunds against an admission. Used by the discharge
 * cascade / final bill to compute net advance available.
 */
export async function getAdmissionDepositBalance(admissionId) {
  const agg = await prisma.advance_deposits.aggregate({
    where: { admission_id: admissionId },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}

export async function listAdmissionDeposits(admissionId) {
  return prisma.advance_deposits.findMany({
    where: { admission_id: admissionId },
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
  admissionId, patientUid, patientName, wardId, wardName, issuedBy,
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
      },
    });
    passes.push(created);
  }
  return passes;
}

/**
 * Revoke an attendant pass (lost / replaced / disciplinary).
 */
export async function revokeAttendantPass({ passId, revokedBy, reason = null }) {
  if (!passId) throw AppError.badRequest('passId is required');
  if (!revokedBy) throw AppError.badRequest('revokedBy is required');

  return prisma.attendant_passes.update({
    where: { id: passId },
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
  admissionId, patientUid, patientName, wardId, wardName, issuedBy, notes = null,
}) {
  return prisma.$transaction(async (tx) => {
    const lastIndex = await tx.attendant_passes.aggregate({
      where: { admission_id: admissionId },
      _max: { pass_index: true },
    });
    const nextIndex = (lastIndex._max.pass_index ?? 0) + 1;
    const [pass] = await issueDefaultAttendantPasses(tx, {
      admissionId, patientUid, patientName, wardId, wardName, issuedBy,
    }).then(() => []) // can't reuse — write a custom one
      .catch(() => []);
    // Direct create rather than the bulk helper above so we can pass
    // explicit pass_index = nextIndex.
    const passNumber = await nextPassNumber(tx, admissionId, nextIndex);
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
        admission_id: admissionId,
        patient_uid: patientUid,
        pass_number: passNumber,
        pass_index: nextIndex,
        patient_name_snapshot: patientName ?? null,
        pass_color: passColor,
        ward_at_issue: wardName ?? null,
        screening_level: screeningLevel,
        issued_by: issuedBy,
        notes,
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

export async function listAdmissionPasses(admissionId) {
  return prisma.attendant_passes.findMany({
    where: { admission_id: admissionId },
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
  wardId, indentType = 'pharmacy', items, notes = null, requestedBy,
}) {
  if (!VALID_INDENT_TYPES.has(indentType)) {
    throw AppError.badRequest(`Invalid indent_type: ${indentType}`);
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('items must be a non-empty array');
  }
  if (!requestedBy) throw AppError.badRequest('requestedBy is required');
  for (const it of items) {
    if (!it.item_name) throw AppError.badRequest('Each item requires item_name');
    const q = Number(it.quantity_requested);
    if (!Number.isFinite(q) || q <= 0) {
      throw AppError.badRequest(`item ${it.item_name}: quantity_requested must be positive`);
    }
  }

  return prisma.$transaction(async (tx) => {
    let wardName = null;
    if (wardId) {
      const ward = await tx.wards.findUnique({ where: { id: wardId }, select: { name: true } });
      wardName = ward?.name ?? null;
    }
    const indentNumber = await nextIndentNumber(tx);
    const indent = await tx.ward_indents.create({
      data: {
        indent_number: indentNumber,
        ward_id: wardId ?? null,
        ward_name: wardName,
        indent_type: indentType,
        status: 'requested',
        requested_by: requestedBy,
        notes,
        items: {
          create: items.map((it) => ({
            pharmacy_catalog_id: it.pharmacy_catalog_id ?? null,
            item_name: it.item_name,
            quantity_requested: Number(it.quantity_requested),
            unit: it.unit ?? null,
            unit_price: it.unit_price != null ? Number(it.unit_price) : null,
            notes: it.notes ?? null,
          })),
        },
      },
      include: { items: true },
    });
    return indent;
  });
}

async function transitionWardIndent({ indentId, fromExpected, toStatus, actorUid, extra = {} }) {
  if (!indentId) throw AppError.badRequest('indentId is required');
  if (!actorUid) throw AppError.badRequest('actorUid is required');

  return prisma.$transaction(async (tx) => {
    const current = await tx.ward_indents.findUnique({
      where: { id: indentId },
      select: { id: true, status: true },
    });
    if (!current) throw AppError.notFound('Ward indent not found');
    const allowed = VALID_INDENT_TRANSITIONS[current.status] ?? new Set();
    if (!allowed.has(toStatus)) {
      throw AppError.badRequest(`Cannot transition ward indent from '${current.status}' to '${toStatus}'`);
    }
    if (fromExpected && current.status !== fromExpected) {
      throw AppError.badRequest(`Expected current status '${fromExpected}', got '${current.status}'`);
    }
    const data = { status: toStatus, updated_at: new Date(), ...extra };
    return tx.ward_indents.update({
      where: { id: indentId },
      data,
      include: { items: true },
    });
  });
}

export async function approveWardIndent({ indentId, approvedBy }) {
  return transitionWardIndent({
    indentId, fromExpected: 'requested', toStatus: 'approved', actorUid: approvedBy,
    extra: { approved_by: approvedBy, approved_at: new Date() },
  });
}

export async function rejectWardIndent({ indentId, rejectedBy, reason }) {
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest('rejection reason is required');
  }
  return transitionWardIndent({
    indentId, fromExpected: null, toStatus: 'rejected', actorUid: rejectedBy,
    extra: { rejection_reason: reason, approved_by: rejectedBy, approved_at: new Date() },
  });
}

/**
 * Issue an approved indent — decrements pharmacy_catalog stock for any
 * line items linked to a catalog row. Best-effort decrement: items
 * without pharmacy_catalog_id (free-text non-catalog items) are
 * recorded but skip stock decrement.
 */
export async function issueWardIndent({ indentId, issuedBy, itemQuantitiesIssued }) {
  if (!indentId) throw AppError.badRequest('indentId is required');
  if (!issuedBy) throw AppError.badRequest('issuedBy is required');

  return prisma.$transaction(async (tx) => {
    const current = await tx.ward_indents.findUnique({
      where: { id: indentId },
      select: { id: true, status: true, items: true },
      include: { items: true },
    });
    if (!current) throw AppError.notFound('Ward indent not found');
    if (current.status !== 'approved') {
      throw AppError.badRequest(`Indent must be in 'approved' state to issue (currently '${current.status}')`);
    }

    // Apply per-item quantity_issued + decrement catalog stock.
    const issuedMap = new Map(
      Array.isArray(itemQuantitiesIssued)
        ? itemQuantitiesIssued.map((x) => [x.item_id, Number(x.quantity_issued)])
        : [],
    );
    for (const item of current.items) {
      const qtyIssued = issuedMap.get(item.id) ?? Number(item.quantity_requested);
      if (!Number.isFinite(qtyIssued) || qtyIssued < 0) continue;
      await tx.ward_indent_items.update({
        where: { id: item.id },
        data: { quantity_issued: qtyIssued, updated_at: new Date() },
      });
      if (item.pharmacy_catalog_id && qtyIssued > 0) {
        await tx.$queryRawUnsafe(
          `UPDATE pharmacy_catalog
              SET stock_quantity = GREATEST(COALESCE(stock_quantity, 0) - $1, 0),
                  updated_at = NOW()
            WHERE id = $2`,
          qtyIssued, item.pharmacy_catalog_id,
        );
      }
    }

    return tx.ward_indents.update({
      where: { id: indentId },
      data: {
        status: 'issued',
        issued_by: issuedBy,
        issued_at: new Date(),
        updated_at: new Date(),
      },
      include: { items: true },
    });
  });
}

export async function receiveWardIndent({ indentId, receivedBy }) {
  return transitionWardIndent({
    indentId, fromExpected: 'issued', toStatus: 'received', actorUid: receivedBy,
    extra: { received_by: receivedBy, received_at: new Date() },
  });
}

export async function listWardIndents({ wardId = null, status = null, limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  return prisma.ward_indents.findMany({
    where: {
      ...(wardId ? { ward_id: wardId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { requested_at: 'desc' },
    take: safeLimit,
    include: { items: true },
  });
}

export async function getWardIndent(indentId) {
  return prisma.ward_indents.findUnique({
    where: { id: indentId },
    include: { items: true },
  });
}

export default {
  // deposits
  collectAdvanceDeposit,
  refundAdvanceDeposit,
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
  approveWardIndent,
  rejectWardIndent,
  issueWardIndent,
  receiveWardIndent,
  listWardIndents,
  getWardIndent,
};
