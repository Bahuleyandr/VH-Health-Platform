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

// Wave-4B-1 — 'deferred' is the IRDAI/MCI emergency-care payment mode for
// unidentified patients and brought-in-dead RTA victims. The hospital must
// admit first and reconcile the deposit within 24 hours; rejecting a
// zero-amount deposit at admit closes off any structured record. The
// deposit row carries amount=0 with payment_method='deferred' and the
// purpose discriminates further. Finding:
//   2026-05-09-emergency-walk-in-admission-advance-deposit-no-deferred-mode
//
// Stage-4-C — 'corporate_tpa' is the IRDAI cashless-advance mode for
// corporate-policy IPD patients. Without it the clerk had to record TPA
// pre-authorised advances as `bank_transfer`, corrupting reconciliation
// against the TPA's settlement file (the same `corporate_tpa` value is
// already accepted by the pharmacy counter, see pharmacyOrderController).
// Finding:
//   2026-05-09-dynamic-acute-abdomen-admission-no-tpa-payment-method
const VALID_PAYMENT_METHODS = new Set(['cash', 'card', 'upi', 'cheque', 'online', 'bank_transfer', 'deferred', 'corporate_tpa']);
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

const VALID_INDENT_TYPES = new Set(['pharmacy', 'consumables', 'linen', 'sterile_supplies']);
const VALID_INDENT_TRANSITIONS = {
  requested: new Set(['approved', 'rejected']),
  approved:  new Set(['issued', 'rejected']),
  issued:    new Set(['received']),
  received:  new Set([]),
  rejected:  new Set([]),
};
const CLINICAL_ORDER_REF_RE = /clinical_order_id:(\d+)/g;

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

function quantityFromMedicationDetails(details) {
  const qty = Number(details.quantity_requested ?? details.quantity ?? details.qty ?? details.units);
  return Number.isFinite(qty) && qty > 0 ? qty : 1;
}

function linkedClinicalOrderIds(items = []) {
  const ids = new Set();
  for (const item of items) {
    for (const match of String(item.notes ?? '').matchAll(CLINICAL_ORDER_REF_RE)) {
      ids.add(Number(match[1]));
    }
  }
  return [...ids].filter(Number.isInteger);
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
  if (!VALID_PAYMENT_METHODS.has(paymentMethod)) {
    throw AppError.badRequest(`Invalid payment_method: ${paymentMethod}. Must be one of: ${[...VALID_PAYMENT_METHODS].join(', ')}`);
  }
  if (!VALID_DEPOSIT_PURPOSES.has(purpose)) {
    throw AppError.badRequest(`Invalid purpose: ${purpose}. Must be one of: ${[...VALID_DEPOSIT_PURPOSES].join(', ')}`);
  }

  // Wave-4B-1 — deferred admits (unidentified patient, RTA brought in by
  // traffic police, mass-casualty events) record amount=0. Cashless
  // collection happens in the next 24h via a sibling deposit row. Any
  // non-deferred mode still requires a positive amount.
  const isDeferred = paymentMethod === 'deferred' || purpose === 'emergency_deferred';
  const num = Number(amount);
  if (!Number.isFinite(num)) {
    throw AppError.badRequest('amount must be a number');
  }
  if (!isDeferred && num <= 0) {
    throw AppError.badRequest('amount must be a positive number');
  }
  if (isDeferred && num < 0) {
    throw AppError.badRequest('deferred deposits cannot carry a negative amount');
  }

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
  const admission = await prisma.admissions.findUnique({
    where: { id: admissionId },
    select: { id: true, patient_uid: true, status: true, billing_closed_at: true },
  });
  if (!admission) throw AppError.notFound('Admission not found');
  if (admission.billing_closed_at) {
    throw AppError.badRequest(
      `Admission billing is closed (since ${admission.billing_closed_at.toISOString()}). Cannot collect new advance deposit.`,
    );
  }

  // Retry once on receipt_number unique-conflict — `nextReceiptNumber`
  // picks max+1 inside a tx but two concurrent collectors can both pick
  // the same value before either has COMMITted. A single retry is enough
  // for typical throughput.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
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

        // F-2 — bridge the IPD deposit to billing_advances so the cashier
        // can settle it against the eventual invoice via billingV2's
        // settleAdvance flow. Reference column carries `IPD/<receipt>` so
        // the refund path can find this row again. Finding:
        //   2026-05-10-inpatient-admission-billing-advance-deposit-not-netted
        // Deferred-mode (amount=0) rows skip the mirror — there's nothing
        // to settle yet; the deferred row will be reconciled when the
        // real payment comes in via a sibling deposit.
        if (num > 0) {
          await tx.$executeRawUnsafe(
            `INSERT INTO billing_advances
               (patient_uid, admission_id, amount, balance, mode, reference, collected_by, notes)
             VALUES ($1::uuid, $2::int, $3::numeric, $3::numeric, $4, $5, $6::uuid, $7)`,
            admission.patient_uid, admissionId, num, paymentMethod,
            `IPD/${receiptNumber}`, collectedBy, notes ?? null,
          );
        }

        return deposit;
      });
    } catch (err) {
      // Prisma P2002 = unique constraint violation. Retry once for receipt_number.
      if (err?.code === 'P2002' && attempt === 0) {
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

    // F-2 — propagate the refund debit to the mirrored billing_advances
    // row (linked via reference `IPD/<parent receipt>`). Caps at 0 so
    // billing_advances.balance never goes negative — a refund against
    // an already-settled advance won't reverse the settlement here;
    // that needs an explicit billingV2 raiseRefund call.
    const parentRows = await tx.$queryRawUnsafe(
      `SELECT receipt_number FROM advance_deposits WHERE id = $1::int`,
      parent.id,
    );
    const parentReceipt = parentRows[0]?.receipt_number;
    if (parentReceipt) {
      await tx.$executeRawUnsafe(
        `UPDATE billing_advances
            SET balance = GREATEST(balance - $1::numeric, 0::numeric),
                status = CASE WHEN GREATEST(balance - $1::numeric, 0::numeric) <= 0.005
                              THEN 'EXHAUSTED' ELSE status END,
                updated_at = NOW()
          WHERE reference = $2`,
        num, `IPD/${parentReceipt}`,
      );
    }

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
    // Dead destructure left over from a previous refactor — the `.then(() => [])`
    // chain means the destructured `_pass` is always undefined. Kept the
    // side-effect call out of an abundance of caution.
    const [_pass] = await issueDefaultAttendantPasses(tx, {
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
  wardId, admissionId = null, encounterId = null, patientUid = null,
  indentType = 'pharmacy', items, notes = null, requestedBy,
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
  if (encounterId != null && !isUuid(encounterId)) {
    throw AppError.badRequest('encounter_id must be a UUID');
  }
  if (patientUid != null && !isUuid(patientUid)) {
    throw AppError.badRequest('patient_uid must be a UUID');
  }

  // Closes finding 2026-05-17-inpatient-admission-pharmacy-05748c99.
  // When admissionId is supplied, look the admission up out of band so a
  // missing FK surfaces a 404 instead of a generic 500, and snapshot
  // ward_id / patient_uid / encounter_id from the admission so the
  // pharmacy queue can filter by patient without trusting the caller.
  let resolvedWardId = wardId ?? null;
  let resolvedWardName = null;
  let resolvedPatientUid = patientUid;
  let resolvedEncounterId = encounterId;
  let resolvedAdmissionId = null;
  if (admissionId != null) {
    const admissionInt = Number.parseInt(admissionId, 10);
    if (!Number.isInteger(admissionInt) || admissionInt <= 0) {
      throw AppError.badRequest('admission_id must be a positive integer');
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.patient_uid, a.encounter_id, b.ward_id, COALESCE(w.name, b.ward_name, a.ward) AS ward_name
         FROM admissions a
         LEFT JOIN beds  b ON b.id = a.bed_id
         LEFT JOIN wards w ON w.id = b.ward_id
        WHERE a.id = $1::int`,
      admissionInt,
    );
    const admission = rows[0];
    if (!admission) throw AppError.notFound('Admission not found');
    resolvedAdmissionId = admissionInt;
    if (resolvedWardId == null) resolvedWardId = admission.ward_id ?? null;
    if (resolvedWardName == null) resolvedWardName = admission.ward_name ?? null;
    if (resolvedPatientUid == null) resolvedPatientUid = admission.patient_uid ?? null;
    if (resolvedEncounterId == null) resolvedEncounterId = admission.encounter_id ?? null;
  }

  return prisma.$transaction(async (tx) => {
    if (resolvedWardId && resolvedWardName == null) {
      const ward = await tx.wards.findUnique({ where: { id: resolvedWardId }, select: { name: true } });
      resolvedWardName = ward?.name ?? null;
    }
    const indentNumber = await nextIndentNumber(tx);
    const indent = await tx.ward_indents.create({
      data: {
        indent_number: indentNumber,
        ward_id: resolvedWardId,
        ward_name: resolvedWardName,
        admission_id: resolvedAdmissionId,
        encounter_id: resolvedEncounterId,
        patient_uid: resolvedPatientUid,
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

export async function createWardIndentForClinicalMedicationOrder(order) {
  if (!order || order.order_type !== 'medication' || !order.encounter_id) return null;

  const details = parseClinicalOrderDetails(order.details);
  const medicationName = details.medication_name || details.medication || details.name;
  if (!medicationName || !order.ordered_by) return null;

  return prisma.$transaction(async (tx) => {
    const existing = await tx.$queryRawUnsafe(
      `SELECT wi.id
         FROM ward_indents wi
         JOIN ward_indent_items wii ON wii.ward_indent_id = wi.id
        WHERE wii.notes LIKE $1
        ORDER BY wi.created_at DESC
        LIMIT 1`,
      `%clinical_order_id:${order.id}%`,
    );
    if (existing.length) {
      return tx.ward_indents.findUnique({
        where: { id: existing[0].id },
        include: { items: true },
      });
    }

    const admissions = await tx.$queryRawUnsafe(
      `SELECT a.id, a.ward AS admission_ward, a.encounter_id, a.patient_uid, b.ward_id, COALESCE(w.name, b.ward_name, a.ward) AS ward_name
         FROM admissions a
         LEFT JOIN beds b ON b.id = a.bed_id
         LEFT JOIN wards w ON w.id = b.ward_id
        WHERE a.encounter_id = $1::uuid
          AND a.patient_uid = $2::uuid
          AND COALESCE(a.status, 'admitted') NOT IN ('discharged', 'cancelled')
        ORDER BY a.admitted_at DESC NULLS LAST, a.id DESC
        LIMIT 1`,
      order.encounter_id,
      order.patient_uid,
    );
    const admission = admissions[0];
    if (!admission) return null;

    const catalogMatches = await tx.$queryRawUnsafe(
      `SELECT id, COALESCE(unit_price, price) AS unit_price
         FROM pharmacy_catalog
        WHERE COALESCE(is_active, TRUE) = TRUE
          AND (
            name ILIKE $1
            OR generic_name ILIKE $1
            OR $2 ILIKE '%' || name || '%'
            OR (generic_name IS NOT NULL AND $2 ILIKE '%' || generic_name || '%')
          )
        ORDER BY
          CASE
            WHEN name ILIKE $1 THEN 0
            WHEN generic_name ILIKE $1 THEN 1
            WHEN $2 ILIKE '%' || name || '%' THEN 2
            ELSE 3
          END,
          COALESCE(is_available, TRUE) DESC,
          id ASC
        LIMIT 1`,
      `%${medicationName}%`,
      medicationName,
    );
    const catalog = catalogMatches[0] ?? null;
    const indentNumber = await nextIndentNumber(tx);

    return tx.ward_indents.create({
      data: {
        indent_number: indentNumber,
        ward_id: admission.ward_id ?? null,
        ward_name: admission.ward_name ?? admission.admission_ward ?? null,
        admission_id: admission.id ?? null,
        encounter_id: admission.encounter_id ?? order.encounter_id ?? null,
        patient_uid: admission.patient_uid ?? order.patient_uid ?? null,
        indent_type: 'pharmacy',
        status: 'requested',
        requested_by: order.ordered_by,
        notes: `Generated from inpatient medication order ${order.order_number}`,
        items: {
          create: [{
            pharmacy_catalog_id: catalog?.id ?? null,
            item_name: medicationName,
            quantity_requested: quantityFromMedicationDetails(details),
            unit: details.unit ?? null,
            unit_price: catalog?.unit_price != null ? Number(catalog.unit_price) : null,
            notes: `clinical_order_id:${order.id}; order_number:${order.order_number}`,
          }],
        },
      },
      include: { items: true },
    });
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
    const clinicalOrderIds = linkedClinicalOrderIds(current.items);
    if (clinicalOrderIds.length) {
      await tx.clinical_orders.updateMany({
        where: {
          id: { in: clinicalOrderIds },
          order_type: 'medication',
          status: { in: ['ordered', 'verified', 'in_progress'] },
        },
        data: {
          status: 'completed',
          completed_by: issuedBy,
          completed_at: new Date(),
          updated_at: new Date(),
        },
      });
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

export async function listWardIndents({
  wardId = null, status = null, admissionId = null, patientUid = null, limit = 50,
} = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  if (patientUid != null && !isUuid(patientUid)) {
    throw AppError.badRequest('patient_uid must be a UUID');
  }
  return prisma.ward_indents.findMany({
    where: {
      ...(wardId ? { ward_id: wardId } : {}),
      ...(status ? { status } : {}),
      ...(admissionId ? { admission_id: admissionId } : {}),
      ...(patientUid ? { patient_uid: patientUid } : {}),
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
  createWardIndentForClinicalMedicationOrder,
  approveWardIndent,
  rejectWardIndent,
  issueWardIndent,
  receiveWardIndent,
  listWardIndents,
  getWardIndent,
};
