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

function quantityFromMedicationDetails(details, projectedQuantity = null) {
  const qty = Number(details.quantity_requested ?? details.quantity ?? details.qty ?? details.units);
  if (Number.isFinite(qty) && qty > 0) return qty;
  const projected = Number(projectedQuantity);
  return Number.isFinite(projected) && projected > 0 ? projected : 1;
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
      if (!admission) throw AppError.notFound('Admission not found');
      if (['discharged', 'cancelled'].includes(String(admission.status || '').toLowerCase())) {
        throw AppError.conflict(
          'Ward indent cannot be created for an inactive admission',
          'WARD_INDENT_ADMISSION_INACTIVE',
        );
      }
      if (wardId != null && admission.ward_id != null
        && Number(wardId) !== Number(admission.ward_id)) {
        throw AppError.badRequest('ward_id does not match the admission ward');
      }
      if (patientUid != null && admission.patient_uid != null
        && String(patientUid) !== String(admission.patient_uid)) {
        throw AppError.badRequest('patient_uid does not match the admission patient');
      }
      if (encounterId != null && admission.encounter_id != null
        && String(encounterId) !== String(admission.encounter_id)) {
        throw AppError.badRequest('encounter_id does not match the admission encounter');
      }
      resolvedWardId = admission.ward_id ?? resolvedWardId;
      resolvedWardName = admission.ward_name ?? resolvedWardName;
      resolvedFacilityId = admission.facility_id == null
        ? null
        : Number(admission.facility_id);
      resolvedPatientUid = admission.patient_uid ?? resolvedPatientUid;
      resolvedEncounterId = admission.encounter_id ?? resolvedEncounterId;
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
    const clinicalOrderIds = normalizedItems
      .map((item) => item.clinicalOrderId)
      .filter((id) => id != null);
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
                clinical_order.encounter_id, clinical_order.order_type
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
        if (String(order.patient_uid) !== String(resolvedPatientUid)) {
          throw AppError.badRequest(
            `Clinical order ${clinicalOrderId} does not belong to the indent patient`,
            'WARD_INDENT_CLINICAL_ORDER_PATIENT_MISMATCH',
          );
        }
        if (order.encounter_id != null
          && String(order.encounter_id) !== String(resolvedEncounterId)) {
          throw AppError.badRequest(
            `Clinical order ${clinicalOrderId} does not belong to the indent encounter`,
            'WARD_INDENT_CLINICAL_ORDER_ENCOUNTER_MISMATCH',
          );
        }
      }
      const existingLinks = await tx.$queryRawUnsafe(
        `SELECT clinical_order_id
           FROM ward_indent_items
          WHERE tenant_id = $1::uuid
            AND clinical_order_id = ANY($2::int[])
          LIMIT 1`,
        tid,
        clinicalOrderIds,
      );
      if (existingLinks.length) {
        throw AppError.conflict(
          `Clinical order ${existingLinks[0].clinical_order_id} already has a ward indent`,
          'WARD_INDENT_CLINICAL_ORDER_ALREADY_LINKED',
        );
      }
    }
    const catalogIds = [...new Set(normalizedItems
      .map((item) => item.catalogId)
      .filter((id) => id != null))];
    const catalogs = catalogIds.length
      ? await tx.pharmacy_catalog.findMany({
          where: { tenant_id: tid, id: { in: catalogIds }, is_active: { not: false } },
          select: { id: true, name: true, unit_price: true, price: true },
        })
      : [];
    const catalogById = new Map(catalogs.map((catalog) => [Number(catalog.id), catalog]));
    const missingCatalogIds = catalogIds.filter((id) => !catalogById.has(id));
    if (missingCatalogIds.length) {
      throw AppError.notFound(`Active catalog item ${missingCatalogIds[0]} not found`);
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
        indent_type: indentType,
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
  });
}

export async function createWardIndentForClinicalMedicationOrder(order, {
  projectedSupplyQuantity = null,
} = {}) {
  if (!order || order.order_type !== 'medication' || !order.encounter_id) return null;

  const details = parseClinicalOrderDetails(order.details);
  const medicationName = details.medication_name || details.medication || details.name;
  if (!medicationName || !order.ordered_by) return null;
  const medicationRoute = inferMedicationRoute(order, details);
  const volumeMl = inferVolumeMl(details, medicationName);
  const searchTerms = catalogSearchTerms(medicationName, details);
  const wildcardTerms = searchTerms.map((term) => `%${term}%`);

  const result = await setTenantTx(requireTenantId(order.tenant_id), async (tx) => {
    const replay = await findWardIndentCreateReplayTx(tx, {
      tenantId: order.tenant_id,
      commandKey: `clinical-order:${order.id}`,
      actorUid: order.ordered_by,
    });
    if (replay) return { indent: replay, created: false, admission: null };
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
      order.patient_uid,
      order.encounter_id,
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
              a.patient_uid, b.ward_id,
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
          AND COALESCE(a.status, 'admitted') NOT IN ('discharged', 'cancelled')
        ORDER BY a.admitted_at DESC NULLS LAST, a.id DESC
        LIMIT 1
        FOR SHARE OF a, facility`,
      order.encounter_id,
      order.patient_uid,
      order.tenant_id || null,
    );
    const admission = admissions[0];
    if (!admission) return null;
    if (admission.ward_id == null || admission.facility_id == null) {
      throw AppError.conflict(
        'Clinical medication order requires an active facility-bound ward before pharmacy indent creation',
        'WARD_INDENT_FACILITY_REQUIRED',
      );
    }

    const catalogMatches = await tx.$queryRawUnsafe(
      `SELECT id, name, COALESCE(unit_price, price) AS unit_price
         FROM pharmacy_catalog
        WHERE tenant_id = $5::uuid
          AND COALESCE(is_active, TRUE) = TRUE
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
      order.tenant_id,
    );
    const catalog = catalogMatches[0] ?? null;
    const indentNumber = await nextIndentNumber(tx, order.tenant_id);

    const indent = await tx.ward_indents.create({
      data: {
        indent_number: indentNumber,
        ward_id: admission.ward_id ?? null,
        ward_name: admission.ward_name ?? admission.admission_ward ?? null,
        facility_id: Number(admission.facility_id),
        facility_authority_version: 1,
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
            original_pharmacy_catalog_id: catalog?.id ?? null,
            clinical_order_id: Number(order.id),
            item_name: catalog?.name ?? medicationName,
            original_item_name: catalog?.name ?? medicationName,
            quantity_requested: quantityFromMedicationDetails(details, projectedSupplyQuantity),
            unit: details.unit ?? null,
            unit_price: catalog?.unit_price != null ? Number(catalog.unit_price) : null,
            notes: `clinical_order_id:${order.id}; order_number:${order.order_number}`,
          }],
        },
      },
      include: { items: true },
    });
    const initialized = await initializeWardIndentWorkflowTx(tx, {
      indent,
      actorUid: order.ordered_by,
      commandKey: `clinical-order:${order.id}`,
      source: 'clinical_medication_order',
    });
    return { indent: initialized, created: true, admission };
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
