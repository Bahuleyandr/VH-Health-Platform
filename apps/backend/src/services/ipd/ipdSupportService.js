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
import { postAdvanceRefundEntry } from '../billing/ledger/ledgerPostings.js';
import { deriveAdvanceBalanceFromLedgerTx } from '../billing/billingV2Service.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

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
const PHARMACY_WARD_INDENT_ROLES = ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'];

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

function normalizeOrderRoute(value) {
  if (value === null || value === undefined || value === '') return null;
  const route = String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (!route) return null;
  if (/\b(iv|intravenous|infusion|injectable|injection|inj|vial|ampoule)\b/.test(route)) return 'iv';
  if (/\b(im|intramuscular)\b/.test(route)) return 'im';
  if (/\b(sc|subcutaneous|subcut)\b/.test(route)) return 'sc';
  if (/\b(po|oral|mouth|tablet|tab|capsule|cap|syrup|sachet)\b/.test(route)) return 'oral';
  return route;
}

function inferMedicationRoute(order, details) {
  return normalizeOrderRoute(
    order?.route
      ?? details.route
      ?? details.medication_route
      ?? details.prescribed_route
      ?? details.administration_route
      ?? details.form
      ?? details.dosage_form
  );
}

function inferVolumeMl(details, medicationName) {
  const explicit = Number(
    details.volume_ml
      ?? details.volumeMl
      ?? details.iv_fluid_ml
      ?? details.ivFluidsMl
      ?? details.fluid_ml
  );
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);

  const text = [
    medicationName,
    details.dose,
    details.dosage,
    details.strength,
    details.quantity_label,
    details.unit,
  ].filter(Boolean).join(' ');
  const match = text.match(/\b(\d{2,4})\s*(ml|mL|ML)\b/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function catalogSearchTerms(medicationName, details) {
  const terms = new Set();
  const add = (value) => {
    const text = value == null ? '' : String(value).trim();
    if (text) terms.add(text);
  };

  add(medicationName);
  add(details.generic_name);
  add(details.generic);
  add(details.drug);

  const text = [
    medicationName,
    details.generic_name,
    details.generic,
    details.drug,
    details.dose,
    details.dosage,
    details.strength,
  ].filter(Boolean).join(' ').toLowerCase();

  if (/\b(ns|normal saline|saline|sodium chloride|nacl)\b/.test(text)) {
    add('Normal Saline');
    add('Sodium Chloride');
    add('Sodium Chloride 0.9%');
  }
  if (/\b(rl|ringer|ringer lactate|compound sodium lactate|hartmann)\b/.test(text)) {
    add('Ringer Lactate');
    add('Compound Sodium Lactate');
  }
  if (/\b(dns|dextrose normal saline)\b/.test(text)) {
    add('DNS');
    add('Dextrose-Normal Saline');
  }

  return [...terms];
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
  purpose = 'admission_advance', notes = null, collectedBy, tenantId = null,
}) {
  const tid = tenantOr(tenantId);
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
  const admission = await findAdmissionForTenant(prisma, admissionId, tid);
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
      return await setTenantTx(tid, async (tx) => {
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
            tenant_id: tid,
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
               (patient_uid, admission_id, amount, balance, mode, reference, collected_by, notes, tenant_id)
             VALUES ($1::uuid, $2::int, $3::numeric, $3::numeric, $4, $5, $6::uuid, $7, $8::uuid)`,
            admission.patient_uid, admissionId, num, paymentMethod,
            `IPD/${receiptNumber}`, collectedBy, notes ?? null, tid,
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
  notes = null, refundedBy, tenantId = null,
}) {
  const tid = tenantOr(tenantId);
  if (!parentDepositId) throw AppError.badRequest('parentDepositId is required');
  const num = Number(refundAmount);
  if (!Number.isFinite(num) || num <= 0) {
    throw AppError.badRequest('refundAmount must be a positive number');
  }
  if (!VALID_PAYMENT_METHODS.has(paymentMethod)) {
    throw AppError.badRequest(`Invalid payment_method: ${paymentMethod}`);
  }
  if (!refundedBy) throw AppError.badRequest('refundedBy is required');

  const wiring = await resolveLedgerWiring(tid);
  // Retry once on receipt_number unique-conflict — mirrors
  // collectAdvanceDeposit: `nextReceiptNumber` picks max+1 inside the tx,
  // so a refund racing a concurrent collector (different parent rows, no
  // shared lock) can still collide on the monthly counter. Without the
  // retry that accidental collision surfaced as an opaque 500.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await setTenantTx(tid, async (tx) => {
        // B-M3 — lock the parent deposit row FOR UPDATE before reading the
        // refunded total. Without the lock, two concurrent refunds both read
        // the same "already refunded" sum, both pass the over-refund check,
        // and both pay out (the deposit balance check was purely
        // read-then-write). Same row-lock discipline as billingV2Service's
        // debitAdvance (`SELECT … FROM billing_advances … FOR UPDATE`): every
        // refund against a parent serializes on the parent row, so the
        // in-tx recompute below always sees the winner's committed refund.
        const parentRows = await tx.$queryRawUnsafe(
          `SELECT id, amount, admission_id, patient_uid, is_refund, purpose, receipt_number
             FROM advance_deposits
            WHERE id = $1::int AND tenant_id = $2::uuid
              FOR UPDATE`,
          parentDepositId, tid,
        );
        const parent = parentRows[0];
        if (!parent) throw AppError.notFound('Parent deposit not found');
        if (parent.is_refund) {
          throw AppError.badRequest('Cannot refund a refund row — refund the original deposit');
        }
        // Recompute existing refunds against this parent AFTER the lock —
        // this sum is now serialized against every other refund of the same
        // parent deposit.
        const existingRefunds = await tx.advance_deposits.aggregate({
          where: { parent_deposit_id: parentDepositId, is_refund: true, tenant_id: tid },
          _sum: { amount: true },
        });
        const alreadyRefunded = Math.abs(Number(existingRefunds._sum.amount ?? 0));
        const parentAmount = Number(parent.amount);
        if (alreadyRefunded + num > parentAmount) {
          // 409, not 400: the request may have been valid when the client
          // composed it — a concurrent refund consumed the balance first.
          // Conflict semantics tell the client to re-read the deposit state
          // and retry with an adjusted amount (same convention as the MAR
          // state-conflict guard).
          throw AppError.conflict(
            `Refund total would exceed deposit (${parentAmount}; already refunded ${alreadyRefunded}; this refund ${num})`,
            'DEPOSIT_REFUND_EXCEEDS_BALANCE',
            {
              parent_deposit_id: parent.id,
              deposit_amount: parentAmount,
              already_refunded: alreadyRefunded,
              requested_refund: num,
              refundable_remaining: Math.max(parentAmount - alreadyRefunded, 0),
            },
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
            tenant_id: tid,
          },
        });

        // F-2 — propagate the refund debit to the mirrored billing_advances
        // row (linked via reference `IPD/<parent receipt>`). Caps at 0 so
        // billing_advances.balance never goes negative — a refund against
        // an already-settled advance won't reverse the settlement here;
        // that needs an explicit billingV2 raiseRefund call.
        // (parent.receipt_number comes from the FOR UPDATE lock read above.)
        const parentReceipt = parent.receipt_number;
        if (parentReceipt) {
          const ref = `IPD/${parentReceipt}`;
          if (wiring.sameTx) {
            // Phase 4-6 (enforce): post the advance refund to the ledger and DERIVE the
            // mirrored billing_advances balance from it — no rogue direct write. Capped
            // at the (ledger-derived) balance, mirroring the legacy GREATEST(...,0), so
            // the no-negative constraint can't reject a partial over-refund. (Shadow
            // keeps the byte-identical legacy decrement below; flipping a tenant to
            // enforce backfills pre-flip IPD-refund deltas like the opening cutover.)
            const advRows = await tx.$queryRawUnsafe(
              `SELECT id, patient_uid, balance FROM billing_advances WHERE reference = $1 AND tenant_id = $2::uuid`,
              ref, tid,
            );
            const adv = advRows[0];
            const refundable = adv ? Math.min(num, Number(adv.balance)) : 0;
            if (adv && refundable > 0) {
              await postAdvanceRefundEntry({
                advance: { id: adv.id, patient_uid: adv.patient_uid },
                amount: refundable, mode: paymentMethod,
                idempotencyKey: `ipd-advance-refund-${refund.id}`,
                tenantId: tid, tx,
              });
              await deriveAdvanceBalanceFromLedgerTx(tx, adv.id, { exhaustedStatus: 'EXHAUSTED' });
            }
          } else {
            // Shadow/off: legacy direct decrement of the mirrored row (capped at 0) —
            // unchanged from before this phase.
            await tx.$executeRawUnsafe(
              `UPDATE billing_advances
                  SET balance = GREATEST(balance - $1::numeric, 0::numeric),
                      status = CASE WHEN GREATEST(balance - $1::numeric, 0::numeric) <= 0.005
                                    THEN 'EXHAUSTED' ELSE status END,
                      updated_at = NOW()
                WHERE reference = $2 AND tenant_id = $3::uuid`,
              num, ref, tid,
            );
          }
        }

        return refund;
      });
    } catch (err) {
      // Prisma P2002 = unique constraint violation. Retry once for receipt_number.
      if (err?.code === 'P2002' && attempt === 0) {
        logger.warn(`refundAdvanceDeposit: receipt_number conflict on parent deposit ${parentDepositId}, retrying`);
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop either returns or rethrows.
  throw AppError.badRequest('Failed to allocate receipt number after retry');
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
 * Sum surfaces both:
 *   (a) `advance_deposits` rows linked to this admission.
 *   (b) `billing_advances` rows linked to this admission directly OR
 *       to the same patient but unlinked (admission_id IS NULL),
 *       collected on/before the admitted_at timestamp.
 * Finding 2026-05-22-..._ac0e6a1e.
 */
export async function getAdmissionDepositBalance(admissionId, { tenantId = null } = {}) {
  if (!admissionId) return 0;
  const tid = tenantOr(tenantId);

  // Advance-deposits is the canonical admission-linked surface
  // (receipt_number + parent_deposit_id chains for refunds).
  const adAgg = await prisma.advance_deposits.aggregate({
    where: { admission_id: admissionId, tenant_id: tid },
    _sum: { amount: true },
  });
  const advanceDepositsTotal = Number(adAgg._sum.amount ?? 0);

  // billing_advances may carry a deferred (pre-admission) deposit on
  // the same patient. Mirror it in if the deposit window precedes the
  // admit. Falls back to a 0 contribution if the admission row or the
  // table is missing — net of (admission-linked + pre-admit-deferred).
  let billingAdvancesTotal = 0;
  try {
    const baRows = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(ba.amount), 0)::numeric AS total
         FROM billing_advances ba
         JOIN admissions a ON a.id = $1::int
                           AND a.tenant_id = $2::uuid
        WHERE COALESCE(ba.status, 'ACTIVE') <> 'CANCELLED'
          AND ba.tenant_id = $2::uuid
          AND (
            ba.admission_id = $1::int
            OR (
              ba.admission_id IS NULL
              AND ba.patient_uid = a.patient_uid
              AND ba.collected_at <= COALESCE(a.admitted_at, a.created_at)
            )
          )`,
      Number(admissionId), tid,
    );
    billingAdvancesTotal = Number(baRows[0]?.total ?? 0);
  } catch (err) {
    // Under-migrated tenants or transient query failure — log and fall
    // back to the canonical advance_deposits-only total. Never fail
    // closed on a balance lookup; the cashier needs a number even if
    // the deferred-mirror table is missing.
    logger.warn(`getAdmissionDepositBalance: billing_advances mirror lookup failed for admission=${admissionId}: ${err.message}`);
  }

  return advanceDepositsTotal + billingAdvancesTotal;
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
}) {
  const tid = tenantOr(tenantId);
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
        WHERE a.id = $1::int
          AND a.tenant_id = $2::uuid`,
      admissionInt, tid,
    );
    const admission = rows[0];
    if (!admission) throw AppError.notFound('Admission not found');
    resolvedAdmissionId = admissionInt;
    if (resolvedWardId == null) resolvedWardId = admission.ward_id ?? null;
    if (resolvedWardName == null) resolvedWardName = admission.ward_name ?? null;
    if (resolvedPatientUid == null) resolvedPatientUid = admission.patient_uid ?? null;
    if (resolvedEncounterId == null) resolvedEncounterId = admission.encounter_id ?? null;
  }
  if (resolvedPatientUid != null) {
    const patientRows = await prisma.$queryRawUnsafe(
      `SELECT uid FROM users WHERE uid = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
      resolvedPatientUid, tid,
    );
    if (!patientRows.length) throw AppError.notFound('Patient not found');
  }

  return setTenantTx(tid, async (tx) => {
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
        tenant_id: tid,
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
  const medicationRoute = inferMedicationRoute(order, details);
  const volumeMl = inferVolumeMl(details, medicationName);
  const searchTerms = catalogSearchTerms(medicationName, details);
  const wildcardTerms = searchTerms.map((term) => `%${term}%`);

  const result = await setTenantTx(requireTenantId(order.tenant_id), async (tx) => {
    const existing = await tx.$queryRawUnsafe(
      `SELECT wi.id
         FROM ward_indents wi
         JOIN ward_indent_items wii ON wii.ward_indent_id = wi.id
        WHERE wii.notes LIKE $1
          -- Explicit tenant_id filter: when the order carries a tenant, the
          -- dedup match is hard-scoped to it (no cross-tenant fall-through).
          -- A null tenant (legacy tenant-less clinical order) still matches
          -- any tenant, preserving the prior COALESCE($2, wi.tenant_id) intent.
          AND ($2::uuid IS NULL OR wi.tenant_id = $2::uuid)
        ORDER BY wi.created_at DESC
        LIMIT 1`,
      `%clinical_order_id:${order.id}%`, order.tenant_id || null,
    );
    if (existing.length) {
      const indent = await tx.ward_indents.findUnique({
        where: { id: existing[0].id },
        include: { items: true },
      });
      return { indent, created: false, admission: null };
    }

    const admissions = await tx.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.ward AS admission_ward, a.encounter_id, a.patient_uid, b.ward_id, COALESCE(w.name, b.ward_name, a.ward) AS ward_name
         FROM admissions a
         LEFT JOIN beds b ON b.id = a.bed_id
         LEFT JOIN wards w ON w.id = b.ward_id
        WHERE a.encounter_id = $1::uuid
          AND a.patient_uid = $2::uuid
          -- Explicit tenant_id filter (defense-in-depth): a non-null order
          -- tenant hard-scopes the admission match so a cross-tenant
          -- encounter/patient collision cannot resolve the indent's tenant
          -- to another hospital. Null tenant preserves the prior
          -- COALESCE($3, a.tenant_id) any-tenant behaviour.
          AND ($3::uuid IS NULL OR a.tenant_id = $3::uuid)
          AND COALESCE(a.status, 'admitted') NOT IN ('discharged', 'cancelled')
        ORDER BY a.admitted_at DESC NULLS LAST, a.id DESC
        LIMIT 1`,
      order.encounter_id,
      order.patient_uid,
      order.tenant_id || null,
    );
    const admission = admissions[0];
    if (!admission) return null;

    const catalogMatches = await tx.$queryRawUnsafe(
      `SELECT id, name, COALESCE(unit_price, price) AS unit_price
         FROM pharmacy_catalog
        WHERE COALESCE(is_active, TRUE) = TRUE
          AND (
            name ILIKE ANY($1::text[])
            OR generic_name ILIKE ANY($1::text[])
            OR EXISTS (
              SELECT 1
                FROM unnest($2::text[]) AS term(value)
               WHERE term.value ILIKE '%' || name || '%'
                  OR (generic_name IS NOT NULL AND term.value ILIKE '%' || generic_name || '%')
            )
          )
        ORDER BY
          CASE
            WHEN $3::text = 'iv' AND LOWER(COALESCE(category, '')) = 'iv_fluid' THEN 0
            WHEN $3::text = 'iv'
              AND LOWER(CONCAT_WS(' ', name, generic_name, category, pack_size, description))
                ~ '(injection|injectable|inj|vial|ampoule|intravenous|\\biv\\b|infusion)' THEN 1
            WHEN $3::text = 'iv'
              AND LOWER(CONCAT_WS(' ', name, generic_name, category, pack_size, description))
                ~ '(tablet|\\btab\\b|capsule|\\bcap\\b|syrup|sachet|oral)' THEN 50
            WHEN $3::text = 'oral'
              AND LOWER(CONCAT_WS(' ', name, generic_name, category, pack_size, description))
                ~ '(tablet|\\btab\\b|capsule|\\bcap\\b|syrup|sachet|oral)' THEN 0
            WHEN $3::text = 'oral'
              AND LOWER(CONCAT_WS(' ', name, generic_name, category, pack_size, description))
                ~ '(injection|injectable|inj|vial|ampoule|intravenous|\\biv\\b|infusion)' THEN 50
            ELSE 10
          END,
          CASE
            WHEN $4::int IS NULL THEN 5
            WHEN name ILIKE '%' || $4::text || 'ml%' THEN 0
            WHEN pack_size ILIKE '%' || $4::text || 'ml%' THEN 1
            ELSE 5
          END,
          CASE
            WHEN name ILIKE ANY($1::text[]) THEN 0
            WHEN generic_name ILIKE ANY($1::text[]) THEN 1
            ELSE 2
          END,
          COALESCE(is_available, TRUE) DESC,
          id ASC
        LIMIT 1`,
      wildcardTerms,
      searchTerms,
      medicationRoute,
      volumeMl,
    );
    const catalog = catalogMatches[0] ?? null;
    const indentNumber = await nextIndentNumber(tx);

    const indent = await tx.ward_indents.create({
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
        tenant_id: requireTenantId(admission.tenant_id || order.tenant_id),
        items: {
          create: [{
            pharmacy_catalog_id: catalog?.id ?? null,
            item_name: catalog?.name ?? medicationName,
            quantity_requested: quantityFromMedicationDetails(details),
            unit: details.unit ?? null,
            unit_price: catalog?.unit_price != null ? Number(catalog.unit_price) : null,
            notes: `clinical_order_id:${order.id}; order_number:${order.order_number}`,
          }],
        },
      },
      include: { items: true },
    });
    return { indent, created: true, admission };
  });

  if (result?.created && result.indent) {
    await notifyPharmacyStaffOfWardIndent({
      indent: result.indent,
      order,
      medicationName,
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
  return sendStaffNotifications({
    tenantId: order.tenant_id || indent.tenant_id || admission?.tenant_id || undefined,
    recipientRoles: PHARMACY_WARD_INDENT_ROLES,
    title: 'Ward drug indent requested',
    body: `${medicationName} requested from ${wardName} drug chart. Please review the pharmacy ward indent for dispensing.`,
    type: 'WARD_PHARMACY_INDENT',
    priority: 'HIGH',
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
    },
  });
}

async function transitionWardIndent({
  indentId, fromExpected, toStatus, actorUid, tenantId = null, extra = {},
}) {
  if (!indentId) throw AppError.badRequest('indentId is required');
  if (!actorUid) throw AppError.badRequest('actorUid is required');
  const tid = tenantOr(tenantId);

  return setTenantTx(tid, async (tx) => {
    const current = await tx.ward_indents.findFirst({
      where: { id: indentId, tenant_id: tid },
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

export async function approveWardIndent({ indentId, approvedBy, tenantId = null }) {
  return transitionWardIndent({
    indentId, fromExpected: 'requested', toStatus: 'approved', actorUid: approvedBy, tenantId,
    extra: { approved_by: approvedBy, approved_at: new Date() },
  });
}

export async function rejectWardIndent({ indentId, rejectedBy, reason, tenantId = null }) {
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest('rejection reason is required');
  }
  return transitionWardIndent({
    indentId, fromExpected: null, toStatus: 'rejected', actorUid: rejectedBy, tenantId,
    extra: { rejection_reason: reason, approved_by: rejectedBy, approved_at: new Date() },
  });
}

/**
 * Issue an approved indent — decrements pharmacy_catalog stock for any
 * line items linked to a catalog row. Best-effort decrement: items
 * without pharmacy_catalog_id (free-text non-catalog items) are
 * recorded but skip stock decrement.
 */
export async function issueWardIndent({ indentId, issuedBy, itemQuantitiesIssued, tenantId = null }) {
  if (!indentId) throw AppError.badRequest('indentId is required');
  if (!issuedBy) throw AppError.badRequest('issuedBy is required');
  const tid = tenantOr(tenantId);

  return setTenantTx(tid, async (tx) => {
    const current = await tx.ward_indents.findFirst({
      where: { id: indentId, tenant_id: tid },
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
          tenant_id: tid,
          order_type: 'medication',
          status: { in: ['ordered', 'verified', 'in_progress'] },
        },
        data: {
          status: 'verified',
          verified_by: issuedBy,
          verified_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    const issued = await tx.ward_indents.update({
      where: { id: indentId },
      data: {
        status: 'issued',
        issued_by: issuedBy,
        issued_at: new Date(),
        updated_at: new Date(),
      },
      include: { items: true },
    });

    // Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
    // issuing a patient-linked ward indent is a patient-facing clinical write —
    // it dispenses stock against the patient and flips the linked medication
    // clinical_orders to 'verified'. Persist exactly one clinical_timeline_events
    // row + one clinical_audit_events row IN THE SAME TRANSACTION as the state
    // flip; a failed canonical write rolls the issue back (strict). Fixed
    // insert-once keys are safe here: the 'approved' → 'issued' transition is
    // one-way (guarded above), so this emit runs at most once per indent.
    // Ward-stock indents with no linked patient are operational, not
    // patient-facing — the canonical layer keys on patient_uid, so they skip.
    if (issued.patient_uid) {
      await recordCanonicalClinicalEvent({
        tenantId: tid,
        patientUid: String(issued.patient_uid),
        encounterId: issued.encounter_id || null,
        eventType: 'ward_indent.issued',
        eventStatus: 'issued',
        sourceTable: 'ward_indents',
        sourceId: String(issued.id),
        resourceType: 'ward_indent',
        resourceId: String(issued.id),
        actorUid: issuedBy,
        occurredAt: issued.issued_at,
        visibleToPatient: false,
        summary: `Ward indent ${issued.indent_number} issued`,
        payload: {
          indent_id: issued.id,
          indent_number: issued.indent_number,
          indent_type: issued.indent_type,
          ward_id: issued.ward_id,
          ward_name: issued.ward_name,
          admission_id: issued.admission_id,
          item_count: issued.items?.length ?? 0,
          verified_clinical_order_ids: clinicalOrderIds,
        },
        beforeState: { status: 'approved' },
        afterState: {
          status: 'issued',
          verified_clinical_order_ids: clinicalOrderIds,
        },
        timelineIdempotencyKey: `ward_indents:${issued.id}:issued`,
        auditIdempotencyKey: `ward_indents:${issued.id}:audit:issued`,
      }, { db: tx, strict: true });
    }

    return issued;
  });
}

export async function receiveWardIndent({ indentId, receivedBy, tenantId = null }) {
  return transitionWardIndent({
    indentId, fromExpected: 'issued', toStatus: 'received', actorUid: receivedBy, tenantId,
    extra: { received_by: receivedBy, received_at: new Date() },
  });
}

export async function listWardIndents({
  wardId = null, status = null, admissionId = null, patientUid = null, limit = 50, tenantId = null,
} = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  if (patientUid != null && !isUuid(patientUid)) {
    throw AppError.badRequest('patient_uid must be a UUID');
  }
  return prisma.ward_indents.findMany({
    where: {
      ...(wardId ? { ward_id: wardId } : {}),
      tenant_id: tenantOr(tenantId),
      ...(status ? { status } : {}),
      ...(admissionId ? { admission_id: admissionId } : {}),
      ...(patientUid ? { patient_uid: patientUid } : {}),
    },
    orderBy: { requested_at: 'desc' },
    take: safeLimit,
    include: { items: true },
  });
}

export async function getWardIndent(indentId, { tenantId = null } = {}) {
  return prisma.ward_indents.findFirst({
    where: { id: indentId, tenant_id: tenantOr(tenantId) },
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
