// src/services/pharmacy/counterSaleService.js
//
// Walk-in pharmacy point-of-sale (migration 684).
//
// The pharmacy already runs patient-app orders (orderService) and ward
// indents; this module adds the counter-sale flow for a walk-in customer
// buying OTC/prescription items and paying at the counter. It composes the
// EXISTING mechanisms rather than duplicating them:
//
//   * stock       — FEFO (earliest-expiry-first) allocation, decremented
//                   per-batch through inventoryV2's recordMovementTx (batch
//                   FOR UPDATE lock + insufficient-stock + expired/quarantined
//                   guards), all inside ONE finalize transaction.
//   * schedule    — OTC sells freely; Schedule H/H1 require a prescription
//                   reference (doctor + Rx number/upload) captured on the
//                   sale; Schedule X / narcotics go through inventoryV2's
//                   dispenseControlledTx witnessed statutory-register path in
//                   the same transaction. No parallel controlled mechanism.
//   * billing     — the invoice is a billingV2 invoice_type='PHARMACY'
//                   invoice built through billingV2's draft/item APIs, then
//                   issued inside the stock/payment finalize transaction. The
//                   counter payment is collectPayment reusing that transaction.
//                   CASH requires the seller's open cash_drawer_session; the
//                   payment carries its shift so drawer close reconciles POS
//                   takings.
//   * void        — same-day initiation creates one dedicated refund
//                   obligation. Billing independently approves and pays it;
//                   only exact paid evidence permits allocation-by-allocation
//                   restock and controlled-register return entries.
//   * timeline    — a sale to a REGISTERED patient writes the canonical
//                   clinical timeline + audit pair in the finalize tx
//                   (CANONICAL_CLINICAL_TIMELINE.md). Anonymous walk-ins have
//                   no patient chart, so no patient-timeline row exists for
//                   them — the sale header + invoice are the record.
//
// Anonymous walk-ins vs billing_invoices.patient_uid NOT NULL: anonymous
// sales anchor their invoice on one per-tenant system user (role
// 'PHARMACY_WALKIN' — no phone/password/firebase identity, so it can never
// log in and never matches patient-role queries). The invoice's
// patient_name/patient_phone snapshots carry the REAL captured customer
// identity; pharmacy_counter_sales stays the source of truth for who bought.
//
// Concurrency model (plan → commit): the FEFO plan is computed without locks,
// priced into a draft invoice, and then re-validated under recordMovementTx's
// batch FOR UPDATE lock in the finalize tx. A concurrent sale that consumed the
// planned stock makes finalize fail cleanly before invoice issuance; the draft
// invoice is voided and the caller retries against fresh stock.

import { createHash } from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { boundedInteger } from '../../utils/pagination.js';
import { istDateString } from '../../utils/dateUtils.js';
import {
  recordMovementTx, dispenseControlledTx, lockControlledRegisterItemTx,
} from './inventoryV2Service.js';
import {
  CONTROLLED_DISPENSE_APPROVAL_SCOPES,
  approveControlledDispenseWitnessApproval,
  assertApprovedControlledDispenseWitness,
  consumeControlledDispenseWitnessApproval,
  createControlledDispenseWitnessApproval,
} from './controlledDispenseWitnessService.js';
import {
  createDraftInvoice, addInvoiceItem, issueInvoiceTx, voidInvoice,
  collectPayment, getInvoice,
  deriveInvoicePaymentStateFromLedgerTx,
} from '../billing/billingV2Service.js';
import { resolveLedgerWiring } from '../billing/ledger/ledgerAuthoritativeMode.js';
import { postInvoiceIssueEntry, postPaymentEntry } from '../billing/ledger/ledgerPostings.js';
import {
  recordCanonicalClinicalEvent,
  startWorkflowSla,
} from '../clinical/canonicalClinicalPlatformService.js';
import { evaluateDrugKb } from '../clinical/drugKnowledgeBaseService.js';
import { isDrugKbDeterministicEnvEnabled } from '../clinical/drugKbLinkService.js';
// Dynamic import on purpose (labCodeMappingService precedent): keeps
// tenantSettingsService (and its tenantService import) out of this module's
// static graph so partial jest mocks across the pharmacy/prescription suites
// keep loading. The only caller is inside try/catch and degrades to null.
async function getDrugKbSettingsLazy(tenantId) {
  const mod = await import('../tenant/tenantSettingsService.js');
  return mod.getDrugKbSettings(tenantId);
}

// POS is pay-at-counter: every billingV2 mode except INSURANCE (which requires
// a TPA claim anchor no walk-in sale has).
export const COUNTER_SALE_PAYMENT_MODES = [
  'CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET',
];

// GST fallback when the tenant's billing_service_master has no row for the
// item's HSN code. 12% is the majority slab for medicaments (HSN 3004);
// tenants override per item by maintaining billing_service_master rows
// keyed on hsn_sac.
export const DEFAULT_PHARMACY_GST_RATE = 12;

const SCHEDULED_CLASSES = ['H', 'H1', 'X'];

function toFixed2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function requireTenant(tenantId) {
  if (!tenantId) throw AppError.badRequest('tenantId is required');
  return String(tenantId);
}

const MAX_SIGNED_BIGINT_ID = 9_223_372_036_854_775_807n;

export function canonicalCounterSaleBigIntId(value, label = 'sale id') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw AppError.badRequest(
      `${label} must be a canonical positive signed 64-bit decimal string`,
      'COUNTER_SALE_VOID_BAD_ID',
    );
  }
  const raw = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(raw)) {
    throw AppError.badRequest(
      `${label} must be a canonical positive signed 64-bit decimal string`,
      'COUNTER_SALE_VOID_BAD_ID',
    );
  }
  const parsed = BigInt(raw);
  if (parsed <= 0n || parsed > MAX_SIGNED_BIGINT_ID) {
    throw AppError.badRequest(
      `${label} must be a canonical positive signed 64-bit decimal string`,
      'COUNTER_SALE_VOID_BAD_ID',
    );
  }
  return parsed.toString();
}

function isControlled(item) {
  return SCHEDULED_CLASSES.includes(item.schedule_class) || item.is_narcotic === true;
}

function isWitnessed(item) {
  return item.schedule_class === 'X' || item.is_narcotic === true;
}

// ── Walk-in anchor user ───────────────────────────────────────────────
//
// billing_invoices.patient_uid is NOT NULL, so anonymous sales need a uid to
// anchor the invoice on. One system user per tenant, created on first use.
// Not loginable: no phone, no password, no firebase identity.

export async function ensureWalkInAnchorUid(tenantId, db = prisma) {
  const tenant = requireTenant(tenantId);
  const existing = await db.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid AND role = 'PHARMACY_WALKIN'
      ORDER BY id ASC
      LIMIT 1`,
    tenant,
  );
  if (existing.length) return existing[0].uid;
  // WHERE NOT EXISTS keeps the common race harmless; ORDER BY id above makes
  // every caller converge on the first row even if two ever get created.
  await db.$executeRawUnsafe(
    `INSERT INTO users (name, role, tenant_id, is_active, is_unidentified, updated_at)
     SELECT 'Pharmacy Walk-In Counter', 'PHARMACY_WALKIN', $1::uuid, false, true, NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM users WHERE tenant_id = $1::uuid AND role = 'PHARMACY_WALKIN'
      )`,
    tenant,
  );
  const rows = await db.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid AND role = 'PHARMACY_WALKIN'
      ORDER BY id ASC
      LIMIT 1`,
    tenant,
  );
  if (!rows.length) throw AppError.internal('Failed to provision walk-in anchor user');
  return rows[0].uid;
}

// ── Item search (POS pick list) ───────────────────────────────────────

/**
 * Sellable-item search for the POS screen: active drug-master rows with their
 * total usable stock and the FEFO head batch (the batch the next unit will
 * actually come from — its number, expiry and MRP-derived price are what the
 * counter shows before the sale).
 */
export async function searchSellableItems({ tenantId, search, limit = 30 }) {
  const tenant = requireTenant(tenantId);
  const params = [tenant];
  let searchSql = '';
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    searchSql = ` AND (LOWER(i.display_name) LIKE $2 OR LOWER(i.generic_name) LIKE $2
      OR LOWER(i.brand_name) LIKE $2 OR LOWER(i.sku_code) LIKE $2)`;
  }
  params.push(boundedInteger(limit, { fallback: 30, min: 1, max: 100 }));
  return prisma.$queryRawUnsafe(
    `SELECT i.id, i.sku_code, i.display_name, i.generic_name, i.brand_name,
            i.form, i.strength, i.unit_label, i.schedule_class, i.is_narcotic,
            i.hsn_code,
            COALESCE(s.in_stock_quantity, 0)::numeric AS in_stock_quantity,
            head.id            AS fefo_batch_id,
            head.batch_number  AS fefo_batch_number,
            head.expiry_date   AS fefo_expiry_date,
            head.mrp_minor     AS fefo_mrp_minor,
            CASE WHEN head.mrp_minor IS NULL THEN NULL
                 ELSE ROUND(head.mrp_minor / 100.0, 2) END AS fefo_unit_price
       FROM pharmacy_inventory_items i
       LEFT JOIN LATERAL (
         SELECT SUM(b.remaining_quantity) AS in_stock_quantity
           FROM pharmacy_inventory_batches b
          WHERE b.tenant_id = i.tenant_id AND b.inventory_item_id = i.id
            AND b.status = 'in_stock' AND b.remaining_quantity > 0
            AND b.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
       ) s ON TRUE
       LEFT JOIN LATERAL (
         SELECT b.id, b.batch_number, b.expiry_date, b.mrp_minor
           FROM pharmacy_inventory_batches b
          WHERE b.tenant_id = i.tenant_id AND b.inventory_item_id = i.id
            AND b.status = 'in_stock' AND b.remaining_quantity > 0
            AND b.expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          ORDER BY b.expiry_date ASC, b.id ASC
          LIMIT 1
       ) head ON TRUE
      WHERE i.tenant_id = $1::uuid AND i.status = 'active'${searchSql}
      ORDER BY (COALESCE(s.in_stock_quantity, 0) > 0) DESC, i.display_name
      LIMIT $${params.length}::int`,
    ...params,
  );
}

// ── FEFO planning ─────────────────────────────────────────────────────

/**
 * Plan the FEFO allocation for one line without taking locks: usable batches
 * (in_stock, non-expired IST, remaining > 0) in earliest-expiry-first order —
 * the same predicate + ordering pharmacySupplyService.reserveStock and the
 * dispensable-batches picker use. Prices each slice at its batch MRP
 * (mrp_minor, paise → rupees); a usable batch without an MRP makes the item
 * unsellable at the counter rather than silently free.
 */
async function planFefoAllocation(db, { tenantId, inventoryItemId, quantity }) {
  const batches = await db.$queryRawUnsafe(
    `SELECT id, batch_number, expiry_date, remaining_quantity, mrp_minor
       FROM pharmacy_inventory_batches
      WHERE tenant_id = $1::uuid AND inventory_item_id = $2::int
        AND status = 'in_stock' AND remaining_quantity > 0
        AND expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY expiry_date ASC, id ASC`,
    tenantId, Number(inventoryItemId),
  );
  let need = Number(quantity);
  const plan = [];
  for (const batch of batches) {
    if (need <= 0) break;
    const take = Math.min(Number(batch.remaining_quantity), need);
    if (take <= 0) continue;
    if (batch.mrp_minor == null) {
      throw AppError.badRequest(
        `Batch ${batch.batch_number} has no MRP recorded — item cannot be sold at the counter until priced`,
        'COUNTER_SALE_BATCH_UNPRICED',
        { inventory_batch_id: batch.id },
      );
    }
    plan.push({
      inventory_batch_id: batch.id,
      batch_number: batch.batch_number,
      expiry_date: batch.expiry_date,
      quantity: take,
      unit_price: toFixed2(Number(batch.mrp_minor) / 100),
    });
    need -= take;
  }
  if (need > 0) {
    throw AppError.badRequest(
      `Insufficient usable stock for item ${inventoryItemId}: short by ${need}`,
      'COUNTER_SALE_INSUFFICIENT_STOCK',
      { inventory_item_id: Number(inventoryItemId), short_by: need },
    );
  }
  return plan;
}

/** GST rate for an item: tenant master data by HSN, else the default slab. */
async function resolveGstRate(db, { tenantId, hsnCode }) {
  if (hsnCode) {
    const rows = await db.$queryRawUnsafe(
      `SELECT gst_rate FROM billing_service_master
        WHERE tenant_id = $1::uuid AND hsn_sac = $2 AND is_active = true
        ORDER BY id ASC
        LIMIT 1`,
      tenantId, String(hsnCode),
    );
    if (rows.length && rows[0].gst_rate != null) return Number(rows[0].gst_rate);
  }
  return DEFAULT_PHARMACY_GST_RATE;
}

// ── Sale creation ─────────────────────────────────────────────────────

function validateSaleInput({
  tenantId, lines, patient_uid, customer_name, payment_mode, payment_reference,
  sold_by,
}) {
  requireTenant(tenantId);
  if (!Array.isArray(lines) || lines.length === 0) {
    throw AppError.badRequest('At least one sale line is required');
  }
  if (lines.length > 50) throw AppError.badRequest('Too many lines (max 50)');
  for (const line of lines) {
    if (!line || !line.inventory_item_id) {
      throw AppError.badRequest('Each line requires inventory_item_id');
    }
    const qty = Number(line.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw AppError.badRequest('Each line requires quantity > 0');
    }
  }
  if (!patient_uid && !(customer_name && String(customer_name).trim())) {
    throw AppError.badRequest(
      'Customer identity required: pass patient_uid (registered patient) or customer_name (walk-in)',
      'COUNTER_SALE_IDENTITY_REQUIRED',
    );
  }
  if (!COUNTER_SALE_PAYMENT_MODES.includes(payment_mode)) {
    throw AppError.badRequest(
      `Invalid payment_mode. Allowed: ${COUNTER_SALE_PAYMENT_MODES.join(', ')}`,
    );
  }
  const normalizedPaymentReference = payment_reference == null
    ? ''
    : String(payment_reference).trim();
  if (normalizedPaymentReference.length > 200) {
    throw AppError.badRequest(
      'payment_reference must be at most 200 characters',
      'COUNTER_SALE_PAYMENT_REFERENCE_TOO_LONG',
    );
  }
  if (/\p{Cc}/u.test(normalizedPaymentReference)) {
    throw AppError.badRequest(
      'payment_reference cannot contain control characters',
      'COUNTER_SALE_PAYMENT_REFERENCE_INVALID',
    );
  }
  if (payment_mode !== 'CASH' && !normalizedPaymentReference) {
    throw AppError.badRequest(
      `${payment_mode} counter sales require the original external payment reference`,
      'COUNTER_SALE_PAYMENT_REFERENCE_REQUIRED',
    );
  }
  if (!sold_by) throw AppError.badRequest('sold_by is required');
  return normalizedPaymentReference || null;
}

async function loadSaleItems(db, tenantId, lines) {
  const ids = [...new Set(lines.map((l) => Number(l.inventory_item_id)))];
  const rows = await db.$queryRawUnsafe(
    `SELECT id, sku_code, display_name, unit_label, schedule_class, is_narcotic,
            hsn_code, status
       FROM pharmacy_inventory_items
      WHERE tenant_id = $1::uuid
        AND id = ANY(ARRAY(SELECT (jsonb_array_elements_text($2::jsonb))::int))`,
    tenantId, JSON.stringify(ids),
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) throw AppError.notFound(`Inventory item ${id} not found`);
    if (item.status !== 'active') {
      throw AppError.badRequest(`Inventory item ${id} is not active`, 'COUNTER_SALE_ITEM_INACTIVE');
    }
  }
  return byId;
}

function enforceScheduleRules({
  itemsById, lines, rx, witnessApprovalId, patient_uid, customer_phone,
  requireWitnessApproval = true,
}) {
  const scheduled = [];
  const registerStrict = [];
  let needsWitness = false;
  for (const line of lines) {
    const item = itemsById.get(Number(line.inventory_item_id));
    if (isControlled(item)) scheduled.push(item);
    // H1/X/narcotic: the statutory register entry must name the patient
    // (H1 register + Schedule X account both record who received the drug).
    if (item.schedule_class === 'H1' || isWitnessed(item)) registerStrict.push(item);
    if (isWitnessed(item)) needsWitness = true;
  }
  if (scheduled.length) {
    const hasDoctor = Boolean(rx?.doctor_name && String(rx.doctor_name).trim());
    const hasRef = Boolean(
      (rx?.reference && String(rx.reference).trim()) || rx?.upload_id,
    );
    if (!hasDoctor || !hasRef) {
      throw AppError.badRequest(
        'Schedule H/H1/X items require a prescription reference: rx.doctor_name plus rx.reference or rx.upload_id',
        'COUNTER_SALE_RX_REQUIRED',
        { scheduled_items: scheduled.map((i) => i.display_name) },
      );
    }
  }
  if (needsWitness && requireWitnessApproval && !witnessApprovalId) {
    throw AppError.badRequest(
      'Schedule X / narcotic items require an independently approved witness request',
      'COUNTER_SALE_WITNESS_REQUIRED',
    );
  }
  // Anonymous H1/X/narcotic sale: the walk-in identity must be complete
  // (name is already mandatory for every anonymous sale; the register entry
  // additionally needs a contact). A registered patient linkage satisfies
  // this by itself. Plain Schedule H and OTC anonymous sales are unchanged.
  if (registerStrict.length && !patient_uid
      && !(customer_phone && String(customer_phone).trim())) {
    throw AppError.badRequest(
      'Schedule H1/X items require the patient identity on the statutory register: pass patient_uid (registered patient) or customer_name plus customer_phone',
      'COUNTER_SALE_SCHEDULED_IDENTITY_REQUIRED',
      { scheduled_items: registerStrict.map((i) => i.display_name) },
    );
  }
  return { hasScheduled: scheduled.length > 0, needsWitness };
}

function counterSaleWitnessPayload({
  lines, patient_uid, customer_name, customer_phone, rx,
  payment_mode, payment_reference, notes,
}) {
  return {
    lines: lines
      .map((line) => ({
        inventory_item_id: Number(line.inventory_item_id),
        quantity: Number(line.quantity),
      })),
    patient_uid: patient_uid ? String(patient_uid) : null,
    customer_name: customer_name ? String(customer_name).trim() : null,
    customer_phone: customer_phone ? String(customer_phone).trim() : null,
    prescription: {
      doctor_name: rx?.doctor_name ? String(rx.doctor_name).trim() : null,
      reference: rx?.reference ? String(rx.reference).trim() : null,
      upload_id: rx?.upload_id == null ? null : Number(rx.upload_id),
      id_proof_type: rx?.id_proof_type || null,
      id_proof_last4: rx?.id_proof_last4 ? String(rx.id_proof_last4).slice(-4) : null,
    },
    payment_mode: payment_mode ? String(payment_mode).trim().toUpperCase() : null,
    payment_reference: payment_reference ? String(payment_reference).trim() : null,
    notes: notes ? String(notes).trim() : null,
  };
}

async function prepareCounterSaleWitnessPayload(params) {
  if (Object.hasOwn(params || {}, 'witness_approval_id')) {
    throw AppError.badRequest(
      'witness_approval_id is not accepted before witness approval',
      'CONTROLLED_DISPENSE_WITNESS_APPROVAL_PRESELECTED',
    );
  }
  validateSaleInput({
    ...params,
    sold_by: params.requested_by || 'authenticated-seller',
  });
  const tenant = String(params.tenantId);
  const itemsById = await loadSaleItems(prisma, tenant, params.lines);
  const rules = enforceScheduleRules({
    itemsById,
    lines: params.lines,
    rx: params.rx,
    witnessApprovalId: null,
    patient_uid: params.patient_uid,
    customer_phone: params.customer_phone,
    requireWitnessApproval: false,
  });
  if (!rules.needsWitness) {
    throw AppError.badRequest(
      'A witness approval is only available for a sale containing Schedule X / narcotic items',
      'CONTROLLED_DISPENSE_WITNESS_NOT_REQUIRED',
    );
  }
  return counterSaleWitnessPayload({ itemsById, ...params });
}

export async function requestCounterSaleWitnessApproval(params) {
  const payload = await prepareCounterSaleWitnessPayload(params);
  return createControlledDispenseWitnessApproval({
    tenantId: params.tenantId,
    scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.counterSale,
    payload,
    requestedBy: params.requested_by,
  });
}

export async function approveCounterSaleWitnessApproval(params) {
  const payload = await prepareCounterSaleWitnessPayload(params.sale);
  return approveControlledDispenseWitnessApproval({
    tenantId: params.sale.tenantId,
    approvalId: params.approvalId,
    actorUid: params.actorUid,
    payload,
    requesterUid: params.requesterUid,
  });
}

/**
 * The open cash-drawer session gate for CASH sales. Billing's cashier flow
 * reconciles CASH by (cashier, shift, collected_at >= session open); a CASH
 * POS payment outside any open session would be invisible to drawer close, so
 * we require one and stamp its shift on the payment.
 */
async function requireOpenDrawerSession(db, { tenantId, cashierUid }) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, shift FROM cash_drawer_sessions
      WHERE tenant_id = $1::uuid AND cashier_uid = $2::uuid AND status = 'open'
      ORDER BY opened_at DESC
      LIMIT 1`,
    tenantId, String(cashierUid),
  );
  if (!rows.length) {
    throw AppError.conflict(
      'CASH counter sales require an open cash-drawer session for this cashier. Open a session first.',
      'COUNTER_SALE_CASH_DRAWER_REQUIRED',
    );
  }
  return rows[0];
}

/**
 * Create a walk-in counter sale end-to-end:
 *
 *   Phase 0  validate + load items + schedule enforcement + FEFO plan +
 *            pricing + (CASH) drawer-session gate — reads only.
 *   Phase 1  sale header + lines (small tx) — the evidence row invoice items
 *            back-reference (source_ref_type='pharmacy_counter_sale').
 *   Phase 2  billingV2: draft invoice with per-allocation items carrying
 *            batch-stamped prices + master-data GST.
 *   Phase 3  finalize tx: per-allocation stock decrement under batch locks
 *            (controlled lines through dispenseControlledTx's statutory
 *            register), invoice issue, collectPayment, header → COMPLETED,
 *            and canonical timeline+audit for registered patients. Any
 *            failure rolls the whole phase back; the still-draft invoice is
 *            voided and the sale parks FAILED.
 */
// ── OTC drug-KB advisory (terminology slate C1/WP4, dark by default) ──
//
// Fail-OPEN advisory screen of the items in one counter sale against the
// drug-KB DDI engine. There is no clinician in the loop on a walk-in sale, so
// this surface is ADVISORY ONLY by design decision: it can never block, fail,
// or delay-with-error the sale path — every failure (settings read, engine,
// audit write) is swallowed and logged, and the sale response simply carries
// advisory: null. Double-gated: env DRUG_KB_DETERMINISTIC_MATCHING AND tenant
// settings.drugKb.counterSaleAdvisory, both default off. The fail-CLOSED
// posture of CPOE/prescription saves (validatePrescriptionSafety) is a
// different surface and is untouched.
//
// Exported for unit tests; not part of the route contract.
export async function counterSaleDrugKbAdvisory({
  tenantId, itemsById, saleId = null, soldBy = null,
}) {
  try {
    if (!isDrugKbDeterministicEnvEnabled()) return null;
    const settings = await getDrugKbSettingsLazy(tenantId);
    if (settings.counterSaleAdvisory !== true) return null;
    const medications = [...(itemsById?.values?.() || [])]
      .map((item) => ({ name: item?.display_name }))
      .filter((m) => m.name);
    if (medications.length === 0) return null;
    const result = await evaluateDrugKb({ medications, tenantId });
    const findings = Array.isArray(result?.findings) ? result.findings : [];
    const advisory = {
      kb_available: result?.kbAvailable === true,
      findings,
      count: findings.length,
    };
    if (findings.length > 0) {
      // Advisory evidence row — best-effort, never blocks the sale.
      await prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs (uid, role, action, resource, resource_id, metadata, tenant_id)
         VALUES ($1::uuid, 'PHARMACY_STAFF', 'COUNTER_SALE_DRUG_KB_ADVISORY',
                 'pharmacy_counter_sales', $2, $3::jsonb, $4::uuid)`,
        soldBy || null,
        saleId != null ? String(saleId) : null,
        JSON.stringify({
          finding_count: findings.length,
          findings: findings.map((f) => ({
            check: f.check,
            severity: f.severity,
            drug_keys: f.drug_keys,
            medications: f.medications,
          })),
        }),
        String(tenantId),
      ).catch((auditErr) => {
        logger.warn('Counter-sale drug-KB advisory audit write failed (non-blocking)', {
          sale_id: saleId, error: auditErr?.message,
        });
      });
    }
    return advisory;
  } catch (err) {
    logger.warn('Counter-sale drug-KB advisory failed (non-blocking)', {
      sale_id: saleId, error: err?.message,
    });
    return null;
  }
}

export async function createCounterSale({
  tenantId, lines, patient_uid, customer_name, customer_phone,
  rx, witness_approval_id, payment_mode, payment_reference, notes,
  sold_by, sold_by_name, request_id,
}) {
  // ── Phase 0: pre-flight (reads only) ──────────────────────────────────
  const normalizedPaymentReference = validateSaleInput({
    tenantId,
    lines,
    patient_uid,
    customer_name,
    payment_mode,
    payment_reference,
    sold_by,
  });
  const tenant = String(tenantId);

  let registeredPatient = null;
  if (patient_uid) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT uid, name, phone FROM users
        WHERE uid = $1::uuid AND tenant_id = $2::uuid AND COALESCE(is_deleted, false) = false
        LIMIT 1`,
      String(patient_uid), tenant,
    );
    if (!rows.length) throw AppError.notFound('Patient not found');
    registeredPatient = rows[0];
  }

  const itemsById = await loadSaleItems(prisma, tenant, lines);
  const scheduleRules = enforceScheduleRules({
    itemsById,
    lines,
    rx,
    witnessApprovalId: witness_approval_id,
    patient_uid,
    customer_phone,
  });

  const witnessPayload = scheduleRules.needsWitness
    ? counterSaleWitnessPayload({
      lines,
      patient_uid,
      customer_name,
      customer_phone,
      rx,
      payment_mode,
      payment_reference: normalizedPaymentReference,
      notes,
    })
    : null;
  if (scheduleRules.needsWitness) {
    await assertApprovedControlledDispenseWitness({
      db: prisma,
      tenantId: tenant,
      approvalId: witness_approval_id,
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.counterSale,
      payload: witnessPayload,
      requestedBy: sold_by,
    });
  }

  // Identity snapshot for statutory register rows (H1/X/narcotic lines):
  // the registered patient's name/phone, or the captured walk-in identity.
  const registerPatientName = registeredPatient
    ? registeredPatient.name
    : (customer_name ? String(customer_name).trim() : null);
  const registerPatientPhone = registeredPatient
    ? (registeredPatient.phone || null)
    : (customer_phone ? String(customer_phone).trim() : null);

  let drawer = null;
  if (payment_mode === 'CASH') {
    drawer = await requireOpenDrawerSession(prisma, { tenantId: tenant, cashierUid: sold_by });
  }

  // FEFO plan + pricing per line.
  const plannedLines = [];
  for (const line of lines) {
    const item = itemsById.get(Number(line.inventory_item_id));
    const plan = await planFefoAllocation(prisma, {
      tenantId: tenant,
      inventoryItemId: item.id,
      quantity: line.quantity,
    });
    const gstRate = await resolveGstRate(prisma, { tenantId: tenant, hsnCode: item.hsn_code });
    const lineSubtotal = toFixed2(
      plan.reduce((sum, a) => sum + a.quantity * a.unit_price, 0),
    );
    plannedLines.push({
      item,
      quantity: Number(line.quantity),
      plan,
      gstRate,
      lineSubtotal,
      // Weighted average for the line snapshot; invoice items are
      // per-allocation so each batch keeps its exact price.
      unitPrice: toFixed2(lineSubtotal / Number(line.quantity)),
    });
  }

  const anchorUid = registeredPatient
    ? registeredPatient.uid
    : await ensureWalkInAnchorUid(tenant);
  const invoicePatientName = registeredPatient
    ? registeredPatient.name
    : String(customer_name).trim();
  const invoicePatientPhone = registeredPatient
    ? registeredPatient.phone
    : (customer_phone ? String(customer_phone).trim() : null);

  // ── Phase 1: sale header + lines ──────────────────────────────────────
  const { sale, lineRows } = await setTenantTx(tenant, async (tx) => {
    const saleRows = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_counter_sales
         (tenant_id, patient_uid, customer_name, customer_phone,
          rx_doctor_name, rx_reference, rx_upload_id,
          status, payment_mode, cash_shift, sold_by, sold_by_name, notes)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'IN_PROGRESS', $8, $9, $10::uuid, $11, $12)
       RETURNING id::text AS id, tenant_id, patient_uid, customer_name, customer_phone, status, created_at`,
      tenant,
      registeredPatient ? registeredPatient.uid : null,
      registeredPatient ? null : String(customer_name).trim(),
      registeredPatient ? null : (customer_phone ? String(customer_phone).trim() : null),
      rx?.doctor_name ? String(rx.doctor_name).trim() : null,
      rx?.reference ? String(rx.reference).trim() : null,
      rx?.upload_id != null ? Number(rx.upload_id) : null,
      payment_mode,
      drawer ? drawer.shift : null,
      String(sold_by),
      sold_by_name || null,
      notes || null,
    );
    const saleRow = saleRows[0];
    const inserted = [];
    for (const planned of plannedLines) {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_counter_sale_lines
           (tenant_id, counter_sale_id, inventory_item_id, item_name,
            schedule_class, is_narcotic, quantity, unit_price, gst_rate, line_total)
         VALUES ($1::uuid, $2::bigint, $3::int, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10::numeric)
         RETURNING id::text AS id`,
        tenant, saleRow.id, planned.item.id, planned.item.display_name,
        planned.item.schedule_class || null, planned.item.is_narcotic === true,
        planned.quantity, planned.unitPrice, planned.gstRate, planned.lineSubtotal,
      );
      inserted.push({ planned, lineId: rows[0].id });
    }
    return { sale: saleRow, lineRows: inserted };
  });

  // ★ Only an IN_PROGRESS sale may be demoted. Migration 684's contract is
  // "FAILED rows hold no stock and no money"; without the status predicate a
  // compensation path could overwrite a COMPLETED, paid, stock-decremented
  // sale — leaving cash in the drawer against a row that reads as failed, and
  // one that voidCounterSale then refuses to refund because it is not
  // COMPLETED. The predicate makes the compensation a no-op once the sale is
  // real, which is the only safe direction.
  const markSale = async (status) => {
    const changed = await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_counter_sales SET status = $1, updated_at = NOW()
        WHERE id = $2::bigint AND tenant_id = $3::uuid
          AND status = 'IN_PROGRESS'`,
      status, sale.id, tenant,
    ).catch((err) => {
      logger.error('counter sale status update failed', {
        sale_id: sale.id, status, error: err.message,
      });
      return 0;
    });
    if (!changed) {
      logger.warn('counter sale status update skipped — sale is no longer IN_PROGRESS', {
        sale_id: sale.id, attempted_status: status,
      });
    }
  };

  // ── Phase 2: billingV2 invoice (draft + items) ────────────────────────
  let invoice;
  try {
    invoice = await createDraftInvoice({
      patient_uid: anchorUid,
      patient_name: invoicePatientName,
      patient_phone: invoicePatientPhone,
      department: 'PHARMACY',
      invoice_type: 'PHARMACY',
      notes: `Pharmacy counter sale #${sale.id}`,
      created_by: sold_by,
      tenantId: tenant,
    });
    for (const { planned } of lineRows) {
      for (const alloc of planned.plan) {
        await addInvoiceItem(invoice.id, {
          description:
            `${planned.item.display_name} (batch ${alloc.batch_number}, exp ${istDateString(new Date(alloc.expiry_date))})`,
          category: 'pharmacy',
          quantity: alloc.quantity,
          unit_price: alloc.unit_price,
          gst_rate: planned.gstRate,
          source_ref_type: 'pharmacy_counter_sale',
          source_ref_id: sale.id,
          tenantId: tenant,
        });
      }
    }
    invoice = await getInvoice(invoice.id, { tenantId: tenant });
  } catch (err) {
    await markSale('FAILED');
    if (invoice?.id) {
      await voidInvoice(invoice.id, {
        reason: `Counter sale #${sale.id} failed before completion`,
        voided_by: sold_by,
        tenantId: tenant,
      }).catch((voidErr) => logger.error('counter sale invoice compensation failed', {
        sale_id: sale.id, invoice_id: invoice.id, error: voidErr.message,
      }));
    }
    throw err;
  }

  // ── Phase 3: finalize (stock + issue + payment + COMPLETED), atomic ───
  //
  // Ledger wiring: collectPayment SKIPS its own ledger posting when handed a
  // caller tx ("that caller is responsible for its own ledger posting"), so
  // this path must post the PAYMENT leg itself exactly like billing's cashier
  // flow — otherwise every counter sale leaves PATIENT_AR debited by the
  // INVOICE_ISSUE leg and never credited. Same per-tenant mode contract:
  // enforce → post inside the finalize tx (a ledger failure rolls the sale
  // back) + derive the invoice cache columns from the ledger; shadow → post
  // after commit, best-effort; off → skip.
  try {
    const wiring = await resolveLedgerWiring(tenant);
    const result = await setTenantTx(tenant, async (tx) => {
      const witnessEvidence = scheduleRules.needsWitness
        ? await consumeControlledDispenseWitnessApproval({
          tx,
          tenantId: tenant,
          approvalId: witness_approval_id,
          scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.counterSale,
          payload: witnessPayload,
          requestedBy: sold_by,
        })
        : null;
      for (const { planned, lineId } of lineRows) {
        const controlled = isControlled(planned.item);
        for (const alloc of planned.plan) {
          let movementId;
          if (controlled) {
            const { movement } = await dispenseControlledTx(tx, {
              tenantId: tenant,
              inventory_item_id: planned.item.id,
              inventory_batch_id: alloc.inventory_batch_id,
              quantity: alloc.quantity,
              patient_uid: registeredPatient ? registeredPatient.uid : null,
              patient_name: registerPatientName,
              patient_phone: registerPatientPhone,
              prescription_number: rx?.reference || null,
              prescriber_name: rx?.doctor_name || null,
              patient_id_proof_type: rx?.id_proof_type || null,
              patient_id_proof_last4: rx?.id_proof_last4 || null,
              performed_by: sold_by,
              performed_by_name: sold_by_name || 'Pharmacy counter',
              witness_evidence: witnessEvidence,
              notes: `Counter sale #${sale.id}`,
              reference_id: `counter-sale-${sale.id}`,
              require_usable_batch: true,
            });
            movementId = movement.id;
          } else {
            const { movement } = await recordMovementTx(tx, {
              tenantId: tenant,
              inventory_item_id: planned.item.id,
              inventory_batch_id: alloc.inventory_batch_id,
              movement_kind: 'issue',
              quantity: alloc.quantity,
              reference_type: 'pharmacy_counter_sale',
              reference_id: String(sale.id),
              performed_by: sold_by,
              notes: `Counter sale #${sale.id}`,
              require_usable_batch: true,
              expected_batch_number: alloc.batch_number,
            });
            movementId = movement.id;
          }
          await tx.$executeRawUnsafe(
            `INSERT INTO pharmacy_counter_sale_allocations
               (tenant_id, counter_sale_line_id, inventory_batch_id, batch_number,
                expiry_date, quantity, unit_price, movement_id)
             VALUES ($1::uuid, $2::bigint, $3::int, $4, $5::date, $6::numeric, $7::numeric, $8::int)`,
            tenant, lineId, alloc.inventory_batch_id, alloc.batch_number,
            alloc.expiry_date, alloc.quantity, alloc.unit_price, movementId,
          );
        }
      }

      const issuedInvoice = await issueInvoiceTx(tx, {
        invoiceId: invoice.id,
        tenantId: tenant,
        wiring,
      });
      const totalAmount = Number(issuedInvoice.total_amount);

      const payment = await collectPayment({
        invoice_id: invoice.id,
        amount: totalAmount,
        mode: payment_mode,
        reference: normalizedPaymentReference,
        collected_by: sold_by,
        shift: drawer ? drawer.shift : null,
        notes: `Pharmacy counter sale #${sale.id}`,
        tenantId: tenant,
      }, { tx });

      if (wiring.sameTx) {
        await postPaymentEntry({ payment, tenantId: tenant, tx });
        await deriveInvoicePaymentStateFromLedgerTx(tx, Number(invoice.id));
      }

      const updated = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_counter_sales
            SET status = 'COMPLETED', invoice_id = $1::int, total_amount = $2::numeric,
                payment_reference = $3, updated_at = NOW()
          WHERE id = $4::bigint AND tenant_id = $5::uuid AND status = 'IN_PROGRESS'
          RETURNING id::text AS id, status, invoice_id, total_amount, payment_mode,
                    cash_shift, patient_uid, customer_name, customer_phone, created_at`,
        invoice.id, totalAmount, normalizedPaymentReference, sale.id, tenant,
      );
      if (!updated.length) {
        throw AppError.conflict('Counter sale state changed during finalize', 'COUNTER_SALE_STATE_CONFLICT');
      }

      if (registeredPatient) {
        await recordCanonicalClinicalEvent({
          tenantId: tenant,
          patientUid: registeredPatient.uid,
          eventType: 'pharmacy.counter_sale.dispensed',
          eventStatus: 'completed',
          sourceTable: 'pharmacy_counter_sales',
          sourceId: String(sale.id),
          actorUid: sold_by,
          actorRole: 'PHARMACY_STAFF',
          requestId: request_id || null,
          summary: `Pharmacy counter sale: ${lineRows.length} item(s), INR ${totalAmount.toFixed(2)}`,
          payload: {
            counter_sale_id: sale.id,
            invoice_id: invoice.id,
            invoice_number: issuedInvoice.invoice_number,
            items: lineRows.map(({ planned }) => ({
              inventory_item_id: planned.item.id,
              name: planned.item.display_name,
              schedule_class: planned.item.schedule_class,
              quantity: planned.quantity,
            })),
          },
        }, { db: tx });
      }

      return { sale: updated[0], payment, issuedInvoice };
    });

    invoice = { ...invoice, ...result.issuedInvoice };

    // Shadow mode: post the invoice and payment legs after commit, best-effort
    // — identical to billingV2's own postCommit branches.
    if (wiring.postCommit) {
      try {
        await postInvoiceIssueEntry({
          invoice: {
            id: result.issuedInvoice.id,
            patient_uid: result.issuedInvoice.patient_uid,
            total_amount: result.issuedInvoice.ledger_issue_amount,
            tax_amount: result.issuedInvoice.tax_amount,
          },
          tenantId: tenant,
        });
      } catch (ledgerErr) {
        logger.error('Ledger INVOICE_ISSUE post failed (non-blocking)', {
          invoice_id: invoice.id, counter_sale_id: sale.id, error: ledgerErr.message,
        });
      }
      try {
        await postPaymentEntry({ payment: result.payment, tenantId: tenant });
      } catch (ledgerErr) {
        logger.error('Ledger PAYMENT post failed (non-blocking)', {
          payment_id: result.payment?.id, counter_sale_id: sale.id, error: ledgerErr.message,
        });
      }
    }

    // ★ Response assembly is OUTSIDE the compensating try.
    //
    // Everything above has COMMITTED: stock is decremented, money is recorded,
    // the statutory register is written. getInvoice makes five further
    // round-trips purely to enrich the response. Leaving it inside the catch
    // below meant a transient read error flipped a COMPLETED, paid,
    // stock-decremented sale to FAILED and returned a 500 — the cashier then
    // rings it up again (double dispense, double charge), and the original can
    // never be voided because voidCounterSale only accepts COMPLETED.
    //
    // A read failure here costs the caller a richer invoice object, nothing
    // more. The sale is already real, so we degrade to the invoice we already
    // hold rather than failing a transaction that succeeded.
    let invoiceView = invoice;
    try {
      invoiceView = await getInvoice(invoice.id, { tenantId: tenant });
    } catch (readErr) {
      logger.warn('Counter sale committed; invoice re-read failed — returning the issued invoice', {
        counter_sale_id: sale.id, invoice_id: invoice.id, error: readErr.message,
      });
    }
    // Fail-open OTC drug-KB advisory (dark by default; see the helper). The
    // sale is already committed — this can only ever enrich the response.
    // Gates off / advisory unavailable ⇒ the response shape is byte-identical
    // to today (no advisory key at all).
    const advisory = await counterSaleDrugKbAdvisory({
      tenantId: tenant, itemsById, saleId: result.sale.id, soldBy: sold_by,
    });
    const response = { sale: result.sale, invoice: invoiceView, payment: result.payment };
    if (advisory != null) response.advisory = advisory;
    return response;
  } catch (err) {
    // Invoice issue participates in the rolled-back finalize transaction, so
    // the billing compensation only ever targets a DRAFT invoice.
    await markSale('FAILED');
    await voidInvoice(invoice.id, {
      reason: `Counter sale #${sale.id} finalize failed`,
      voided_by: sold_by,
      tenantId: tenant,
    }).catch((voidErr) => logger.error('counter sale invoice compensation failed', {
      sale_id: sale.id, invoice_id: invoice.id, error: voidErr.message,
    }));
    throw err;
  }
}

// ── Reads ─────────────────────────────────────────────────────────────

const SALE_COLUMNS = `
  s.id::text AS id, s.tenant_id, s.patient_uid, s.customer_name, s.customer_phone,
  s.rx_doctor_name, s.rx_reference, s.rx_upload_id, s.status, s.invoice_id,
  s.payment_mode, s.payment_reference, s.cash_shift, s.total_amount,
  s.sold_by, s.sold_by_name, s.notes, s.voided_at, s.voided_by, s.void_reason,
  s.void_refund_id, s.created_at, s.updated_at,
  CASE
    WHEN s.status = 'VOID_PENDING_REFUND' THEN 'PENDING_REFUND'
    WHEN s.status = 'VOIDED' THEN 'VOIDED'
    WHEN s.status <> 'COMPLETED' THEN 'NOT_COMPLETED'
    WHEN (s.created_at AT TIME ZONE 'Asia/Kolkata')::date <>
         (NOW() AT TIME ZONE 'Asia/Kolkata')::date THEN 'OUTSIDE_SAME_DAY_WINDOW'
    WHEN UPPER(s.payment_mode) <> 'CASH'
         AND length(btrim(COALESCE(s.payment_reference, ''))) = 0
      THEN 'ORIGINAL_PAYMENT_REFERENCE_MISSING'
    ELSE 'READY'
  END AS void_readiness,
  (SELECT request.id::text
     FROM pharmacy_counter_sale_void_requests request
    WHERE request.tenant_id = s.tenant_id
      AND request.counter_sale_id = s.id
    ORDER BY request.created_at DESC, request.id DESC
    LIMIT 1) AS void_request_id,
  (SELECT request.status
     FROM pharmacy_counter_sale_void_requests request
    WHERE request.tenant_id = s.tenant_id
      AND request.counter_sale_id = s.id
    ORDER BY request.created_at DESC, request.id DESC
    LIMIT 1) AS void_request_status,
  (SELECT refund.approval_status
     FROM pharmacy_counter_sale_void_requests request
     JOIN billing_refunds refund
       ON refund.tenant_id = request.tenant_id
      AND refund.id = request.refund_id
      AND refund.counter_sale_void_request_id = request.id
    WHERE request.tenant_id = s.tenant_id
      AND request.counter_sale_id = s.id
    ORDER BY request.created_at DESC, request.id DESC
    LIMIT 1) AS void_refund_status
`;

export async function getCounterSale({ tenantId, id }) {
  const tenant = requireTenant(tenantId);
  const saleId = positiveSaleId(id);
  const sales = await prisma.$queryRawUnsafe(
    `SELECT ${SALE_COLUMNS}, b.invoice_number
       FROM pharmacy_counter_sales s
       LEFT JOIN billing_invoices b ON b.id = s.invoice_id
      WHERE s.id = $1::bigint AND s.tenant_id = $2::uuid
      LIMIT 1`,
    saleId, tenant,
  );
  if (!sales.length) throw AppError.notFound('Counter sale not found');
  const lines = await prisma.$queryRawUnsafe(
    `SELECT l.id::text AS id, l.inventory_item_id, l.item_name, l.schedule_class,
            l.is_narcotic, l.quantity, l.unit_price, l.gst_rate, l.line_total
       FROM pharmacy_counter_sale_lines l
      WHERE l.counter_sale_id = $1::bigint AND l.tenant_id = $2::uuid
      ORDER BY l.id`,
    saleId, tenant,
  );
  const allocations = await prisma.$queryRawUnsafe(
    `SELECT a.id::text AS id, a.counter_sale_line_id::text AS counter_sale_line_id,
            a.inventory_batch_id, a.batch_number, a.expiry_date, a.quantity,
            a.unit_price, a.movement_id, a.return_movement_id
       FROM pharmacy_counter_sale_allocations a
       JOIN pharmacy_counter_sale_lines l ON l.id = a.counter_sale_line_id
      WHERE l.counter_sale_id = $1::bigint AND a.tenant_id = $2::uuid
      ORDER BY a.id`,
    saleId, tenant,
  );
  const byLine = new Map();
  for (const alloc of allocations) {
    if (!byLine.has(alloc.counter_sale_line_id)) byLine.set(alloc.counter_sale_line_id, []);
    byLine.get(alloc.counter_sale_line_id).push(alloc);
  }
  return {
    ...sales[0],
    lines: lines.map((line) => ({ ...line, allocations: byLine.get(line.id) || [] })),
  };
}

export async function listCounterSales({ tenantId, status, date, limit = 50 }) {
  const tenant = requireTenant(tenantId);
  const params = [tenant];
  const where = ['s.tenant_id = $1::uuid'];
  if (status) {
    params.push(String(status).toUpperCase());
    where.push(`s.status = $${params.length}`);
  }
  if (date) {
    params.push(String(date));
    where.push(`(s.created_at AT TIME ZONE 'Asia/Kolkata')::date = $${params.length}::date`);
  }
  params.push(boundedInteger(limit, { fallback: 50, min: 1, max: 200 }));
  return prisma.$queryRawUnsafe(
    `SELECT ${SALE_COLUMNS}, b.invoice_number,
            (SELECT COUNT(*)::int FROM pharmacy_counter_sale_lines l
              WHERE l.counter_sale_id = s.id) AS line_count
       FROM pharmacy_counter_sales s
       LEFT JOIN billing_invoices b ON b.id = s.invoice_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

// ── Void request / finance-owned refund / return reconciliation ───────

const VOID_COMMAND_KEY = /^[A-Za-z0-9_\-:.]{1,200}$/;
const VOID_APPROVAL_ROLES = ['ADMIN', 'SUPER_ADMIN'];
const VOID_PAYOUT_ROLES = [
  'FINANCE_INCHARGE', 'BILLING_INCHARGE', 'BILLING_STAFF', 'CASHIER',
];
const VOID_REJECTION_REVIEW_ROLES = ['ADMIN', 'SUPER_ADMIN', 'PHARMACY_INCHARGE'];
const VOID_DISPOSITION = 'NEVER_HANDED_OVER';
const VOID_FINANCE_ACTION_LABEL_KEY = 's4.lib.counter_sale.open_finance_workflow';
const VOID_RECONCILIATION_ACTION_LABEL_KEY = 's4.lib.counter_sale.open_reconciliation';

function positiveSaleId(id) {
  return canonicalCounterSaleBigIntId(id, 'sale id');
}

function normalizedVoidReason(reason) {
  const value = String(reason || '').trim();
  if (!value) {
    throw AppError.badRequest(
      'reason is required to void a counter sale',
      'COUNTER_SALE_VOID_REASON_REQUIRED',
    );
  }
  return value.slice(0, 255);
}

function normalizedVoidDisposition(disposition) {
  const value = String(disposition || '').trim().toUpperCase();
  if (!value) {
    throw AppError.badRequest(
      'disposition is required to void a counter sale',
      'COUNTER_SALE_VOID_DISPOSITION_REQUIRED',
    );
  }
  if (value === 'PATIENT_RETURNED') {
    throw AppError.unprocessable(
      'Patient-returned medication must use the governed return and quarantine workflow',
      'COUNTER_SALE_PATIENT_RETURN_QUARANTINE_REQUIRED',
    );
  }
  if (value !== VOID_DISPOSITION) {
    throw AppError.unprocessable(
      'Only medicine that was never handed over can use counter-sale void restock',
      'COUNTER_SALE_VOID_DISPOSITION_INVALID',
    );
  }
  return value;
}

function normalizedVoidCommandKey(commandKey) {
  const value = String(commandKey || '').trim();
  if (!VOID_COMMAND_KEY.test(value)) {
    throw AppError.badRequest(
      'A stable void command key is required',
      'COUNTER_SALE_VOID_COMMAND_KEY_REQUIRED',
    );
  }
  return value;
}

export function counterSaleVoidCommandFingerprint({
  tenantId, saleId, reason, disposition, requestedBy,
}) {
  return createHash('sha256').update(JSON.stringify([
    String(tenantId).toLowerCase(),
    String(saleId),
    String(reason),
    String(disposition),
    String(requestedBy).toLowerCase(),
  ])).digest('hex');
}

function moneyMatches(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 0.005;
}

function financeDeepLink(refundId, requestId) {
  return `/billing/refunds?refund_id=${encodeURIComponent(String(refundId))}`
    + `&void_request_id=${encodeURIComponent(String(requestId))}`;
}

function pharmacyDeepLink(saleId) {
  return `/pharmacy?tab=counter-sales&sale_id=${encodeURIComponent(String(saleId))}`;
}

function voidActionContract({ saleId, invoiceId, refundId, requestId }) {
  return {
    finance_review: {
      action_key: 'billing.counter_sale_void_refund.review',
      deep_link: financeDeepLink(refundId, requestId),
      resource_type: 'billing_refund',
      resource_id: Number(refundId),
      invoice_id: Number(invoiceId),
      counter_sale_void_request_id: String(requestId),
    },
    pharmacy_reconciliation: {
      action_key: 'pharmacy.counter_sale_void.reconcile',
      deep_link: pharmacyDeepLink(saleId),
      resource_type: 'pharmacy_counter_sale',
      resource_id: String(saleId),
      counter_sale_void_request_id: String(requestId),
    },
  };
}

function publicVoidRequest(row) {
  if (!row) return null;
  return {
    id: String(row.request_id ?? row.id),
    counter_sale_id: String(row.counter_sale_id),
    invoice_id: Number(row.invoice_id),
    refund_id: Number(row.refund_id),
    amount: Number(row.amount),
    refund_mode: row.refund_mode,
    disposition: row.disposition,
    reason: row.reason,
    status: row.request_status ?? row.status,
    task_stage: row.task_stage ?? null,
    task_id: row.task_id == null ? null : Number(row.task_id),
    task_status: row.task_status ?? null,
    task_due_at: row.task_due_at ?? null,
    workflow_sla_instance_id: row.workflow_sla_instance_id ?? null,
    requested_at: row.requested_at,
    last_checked_at: row.last_checked_at ?? null,
    reconciled_at: row.reconciled_at ?? null,
    reconciliation_source: row.reconciliation_source ?? null,
  };
}

function publicVoidRefund(row) {
  if (!row) return null;
  return {
    id: Number(row.refund_id),
    invoice_id: Number(row.invoice_id),
    patient_uid: row.refund_patient_uid ?? row.patient_uid,
    amount: Number(row.refund_amount ?? row.amount),
    mode: row.refund_mode_value ?? row.refund_mode,
    approval_status: row.approval_status,
    payout_rail: row.payout_rail ?? null,
    reference: row.refund_reference ?? null,
    raised_at: row.raised_at ?? null,
    approved_at: row.approved_at ?? null,
    paid_at: row.paid_at ?? null,
    gateway_execution_status: row.gateway_execution_status ?? null,
  };
}

async function loadVoidCommandTx(tx, {
  tenant, requestedBy, commandKey,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT request.id::text AS request_id,
            request.counter_sale_id::text,
            request.invoice_id,
            request.patient_uid AS refund_patient_uid,
            request.refund_id,
            request.amount,
            request.refund_mode,
            request.disposition,
            request.reason,
            request.request_fingerprint,
            request.status AS request_status,
            request.task_stage,
            request.task_id,
            request.workflow_sla_instance_id,
            request.requested_at,
            request.last_checked_at,
            request.reconciled_at,
            request.reconciliation_source,
            task.status AS task_status,
            task.due_at AS task_due_at,
            refund.amount AS refund_amount,
            refund.mode AS refund_mode_value,
            refund.approval_status,
            refund.payout_rail,
            refund.reference AS refund_reference,
            refund.raised_at,
            refund.approved_at,
            refund.paid_at,
            execution.status AS gateway_execution_status,
            sale.status AS sale_status,
            sale.patient_uid
       FROM pharmacy_counter_sale_void_requests request
       JOIN billing_refunds refund
         ON refund.tenant_id = request.tenant_id
        AND refund.id = request.refund_id
        AND refund.counter_sale_void_request_id = request.id
       JOIN pharmacy_counter_sales sale
         ON sale.tenant_id = request.tenant_id
        AND sale.id = request.counter_sale_id
       LEFT JOIN tasks task
         ON task.tenant_id = request.tenant_id
        AND task.id = request.task_id
       LEFT JOIN payment_gateway_refunds execution
         ON execution.tenant_id = refund.tenant_id
        AND execution.id = refund.gateway_refund_id
        AND execution.billing_refund_id = refund.id
      WHERE request.tenant_id = $1::uuid
        AND request.requested_by = $2::uuid
        AND request.command_key = $3
      LIMIT 1
      FOR UPDATE OF request`,
    tenant, String(requestedBy), commandKey,
  );
  return rows[0] || null;
}

async function insertFinanceVoidNotificationsTx(tx, {
  tenant, sale, request, refund,
}) {
  const actions = voidActionContract({
    saleId: sale.id,
    invoiceId: sale.invoice_id,
    refundId: refund.id,
    requestId: request.id,
  });
  const inserted = await tx.$executeRawUnsafe(
    `INSERT INTO notifications
       (tenant_id, uid, user_id, phone, title, body, type, priority,
        data, is_read, created_at, updated_at, related_id, recipient_role)
     SELECT $1::uuid,
            user_row.uid,
            user_row.id,
            COALESCE(NULLIF(btrim(user_row.phone), ''), 'unknown'),
            'Counter-sale refund approval required',
            $2,
            'COUNTER_SALE_VOID_REFUND_REQUIRED',
            'HIGH',
            $3::jsonb,
            false,
            NOW(),
            NOW(),
            $4::int,
            user_row.role
       FROM users user_row
      WHERE user_row.tenant_id = $1::uuid
        AND UPPER(user_row.role) = ANY($5::text[])
        AND COALESCE(user_row.is_active, true) = true
        AND user_row.uid <> $6::uuid`,
    tenant,
    `Review the dedicated full refund for counter sale #${sale.id}. Stock remains held from restock until billing payout is complete.`,
    JSON.stringify({
      event_type: 'counter_sale_void_refund_required',
      counter_sale_id: String(sale.id),
      counter_sale_void_request_id: String(request.id),
      billing_refund_id: Number(refund.id),
      invoice_id: Number(sale.invoice_id),
      amount: Number(request.amount),
      refund_mode: request.refund_mode,
      action_label_key: VOID_FINANCE_ACTION_LABEL_KEY,
      ...actions.finance_review,
    }),
    Number(refund.id),
    VOID_APPROVAL_ROLES,
    String(request.requested_by),
  );
  if (Number(inserted) < 1) {
    throw AppError.conflict(
      'No active independent refund approver can receive this obligation',
      'COUNTER_SALE_VOID_FINANCE_RECIPIENT_REQUIRED',
    );
  }
}

async function insertVoidStageNotificationsTx(tx, {
  tenant, request, stage,
}) {
  const isPayout = stage === 'payout';
  const roles = isPayout ? VOID_PAYOUT_ROLES : VOID_REJECTION_REVIEW_ROLES;
  const inserted = await tx.$executeRawUnsafe(
    `INSERT INTO notifications
       (tenant_id, uid, user_id, phone, title, body, type, priority,
        data, is_read, created_at, updated_at, related_id, recipient_role)
     SELECT $1::uuid,
            user_row.uid,
            user_row.id,
            COALESCE(NULLIF(btrim(user_row.phone), ''), 'unknown'),
            $2, $3, $4, 'HIGH', $5::jsonb,
            false, NOW(), NOW(), $6::int, user_row.role
       FROM users user_row
      WHERE user_row.tenant_id = $1::uuid
        AND UPPER(user_row.role) = ANY($7::text[])
        AND COALESCE(user_row.is_active, true) = true`,
    tenant,
    isPayout
      ? 'Counter-sale refund payout required'
      : 'Rejected counter-sale void requires custody resolution',
    isPayout
      ? `Settle approved refund #${request.refund_id} through its exact governed payout rail.`
      : `Counter sale #${request.counter_sale_id} remains unavailable after refund rejection. Resolve customer handover explicitly.`,
    isPayout
      ? 'COUNTER_SALE_VOID_REFUND_PAYOUT_REQUIRED'
      : 'COUNTER_SALE_VOID_REJECTED_REVIEW_REQUIRED',
    JSON.stringify({
      event_type: isPayout
        ? 'counter_sale_void_refund_payout_required'
        : 'counter_sale_void_rejected_review_required',
      counter_sale_id: String(request.counter_sale_id),
      counter_sale_void_request_id: String(request.id),
      billing_refund_id: Number(request.refund_id),
      task_id: Number(request.task_id),
      task_stage: stage,
      action_label_key: isPayout
        ? VOID_FINANCE_ACTION_LABEL_KEY
        : VOID_RECONCILIATION_ACTION_LABEL_KEY,
      ...(isPayout
        ? voidActionContract({
          saleId: request.counter_sale_id,
          invoiceId: request.invoice_id,
          refundId: request.refund_id,
          requestId: request.id,
        }).finance_review
        : {
          action_key: 'pharmacy.counter_sale_void.resolve_rejection',
          deep_link: pharmacyDeepLink(request.counter_sale_id),
        }),
    }),
    Number(request.refund_id),
    roles,
  );
  if (Number(inserted) < 1) {
    throw AppError.conflict(
      `No active operator can receive counter-sale void ${stage} ownership`,
      'COUNTER_SALE_VOID_STAGE_RECIPIENT_REQUIRED',
    );
  }
}

async function insertCounterSaleVoidAuditTx(tx, {
  tenant, request, actorUid, actorRole, action, metadata = {},
}) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (uid, role, action, resource, resource_id, metadata, tenant_id)
     VALUES ($1::uuid, $2, $3, 'pharmacy_counter_sale_void_requests',
             $4, $5::jsonb, $6::uuid)`,
    String(actorUid),
    String(actorRole || 'PHARMACY_INCHARGE').trim().toUpperCase(),
    action,
    String(request.id),
    JSON.stringify({
      counter_sale_id: String(request.counter_sale_id),
      billing_refund_id: Number(request.refund_id),
      invoice_id: Number(request.invoice_id),
      amount: Number(request.amount),
      refund_mode: request.refund_mode,
      disposition: request.disposition,
      ...metadata,
    }),
    tenant,
  );
}

function voidTaskOccurrenceKey(tenant, requestId) {
  const digest = createHash('sha256')
    .update(`${tenant}:counter-sale-void:${requestId}`, 'utf8')
    .digest('hex');
  return `counter-sale-void:${digest}`;
}

async function materializeCounterSaleVoidTaskTx(tx, {
  tenant, sale, request,
}) {
  const sla = await startWorkflowSla({
    tenantId: tenant,
    ruleCode: 'counter_sale_void_refund',
    patientUid: sale.patient_uid || null,
    encounterId: null,
    sourceTable: 'pharmacy_counter_sale_void_requests',
    sourceId: String(request.id),
    priority: 'high',
    assignedRoleCodes: VOID_APPROVAL_ROLES,
    metadata: {
      med_03: true,
      counter_sale_void_request_id: String(request.id),
      counter_sale_id: String(request.counter_sale_id),
      refund_id: Number(request.refund_id),
      task_stage: 'approval',
    },
  }, { db: tx, strict: true });
  if (!sla?.id) {
    throw AppError.internal(
      'Counter-sale void SLA could not be materialized',
      'COUNTER_SALE_VOID_SLA_MISSING',
    );
  }

  let taskRows = await tx.$queryRawUnsafe(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, description, patient_uid, encounter_id,
        related_resource_type, related_resource_id, priority, status,
        assigned_to_uid, assigned_to_role, created_by, due_at,
        workflow_sla_instance_id, sla_completion_semantics,
        stage_occurrence_key, metadata)
     SELECT $1::uuid, 'review',
            'Authorize counter-sale void refund',
            'Approve the exact dedicated full refund. Pharmacy stock remains unavailable until payout evidence and reconciliation complete.',
            $2::uuid, NULL, 'pharmacy_counter_sale_void_requests', $3,
            'high', 'open', NULL, 'ADMIN', $4::uuid, sla.due_at,
            sla.id, 'domain_evidence', $5, $6::jsonb
       FROM workflow_sla_instances sla
      WHERE sla.tenant_id = $1::uuid
        AND sla.id = $7::uuid
     ON CONFLICT (tenant_id, related_resource_type, related_resource_id)
       WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
         AND related_resource_type IS NOT NULL
         AND related_resource_id IS NOT NULL
     DO NOTHING
     RETURNING id, workflow_sla_instance_id, status, due_at, metadata`,
    tenant,
    sale.patient_uid || null,
    String(request.id),
    String(request.requested_by),
    voidTaskOccurrenceKey(tenant, request.id),
    JSON.stringify({
      task_contract: 'counter_sale_void_refund_v1',
      evidence_kind: 'counter_sale_void_completed',
      counter_sale_void_request_id: String(request.id),
      counter_sale_id: String(request.counter_sale_id),
      refund_id: Number(request.refund_id),
      invoice_id: Number(request.invoice_id),
      task_stage: 'approval',
      owner_role_codes: VOID_APPROVAL_ROLES,
      finance_deep_link: financeDeepLink(request.refund_id, request.id),
      pharmacy_deep_link: pharmacyDeepLink(request.counter_sale_id),
    }),
    String(sla.id),
  );
  if (!taskRows.length) {
    taskRows = await tx.$queryRawUnsafe(
      `SELECT id, workflow_sla_instance_id, status, due_at, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'pharmacy_counter_sale_void_requests'
          AND related_resource_id = $2
          AND status IN ('open', 'in_progress', 'blocked', 'overdue')
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE`,
      tenant,
      String(request.id),
    );
  }
  const task = taskRows[0];
  if (!task || String(task.workflow_sla_instance_id) !== String(sla.id)) {
    throw AppError.conflict(
      'Counter-sale void task could not be bound to its exact SLA',
      'COUNTER_SALE_VOID_TASK_BINDING_CONFLICT',
    );
  }
  const boundRows = await tx.$queryRawUnsafe(
    `UPDATE pharmacy_counter_sale_void_requests
        SET task_id = $1::int,
            workflow_sla_instance_id = $2::uuid,
            updated_at = NOW()
      WHERE tenant_id = $3::uuid
        AND id = $4::bigint
        AND status = 'PENDING_REFUND'
        AND task_id IS NULL
        AND workflow_sla_instance_id IS NULL
      RETURNING *`,
    Number(task.id),
    String(sla.id),
    tenant,
    canonicalCounterSaleBigIntId(request.id, 'void request id'),
  );
  if (!boundRows.length) {
    throw AppError.conflict(
      'Counter-sale void task binding changed concurrently',
      'COUNTER_SALE_VOID_TASK_BINDING_CONFLICT',
    );
  }
  return { request: boundRows[0], task, sla };
}

const VOID_TASK_STAGE_PRESENTATION = Object.freeze({
  payout: {
    title: 'Settle approved counter-sale void refund',
    description: 'Complete the exact approved refund through its governed payout rail and retain settlement evidence.',
    assignedRole: 'BILLING_INCHARGE',
    ownerRoles: VOID_PAYOUT_ROLES,
  },
  reconciliation: {
    title: 'Reconcile paid counter-sale void',
    description: 'Verify exact paid-refund evidence and return only the never-handed-over allocations.',
    assignedRole: 'PHARMACY_INCHARGE',
    ownerRoles: ['ADMIN', 'PHARMACY_INCHARGE'],
  },
  rejected_review: {
    title: 'Resolve rejected counter-sale void custody',
    description: 'Stock remains unavailable. Confirm customer handover explicitly or resolve the refund before closing this obligation.',
    assignedRole: 'ADMIN',
    ownerRoles: VOID_REJECTION_REVIEW_ROLES,
  },
});

async function advanceCounterSaleVoidTaskStageTx(tx, {
  tenant, request, stage,
}) {
  if (request.task_stage === stage) return request;
  const presentation = VOID_TASK_STAGE_PRESENTATION[stage];
  if (!presentation) {
    throw AppError.internal('Unknown counter-sale void task stage');
  }
  const requestRows = await tx.$queryRawUnsafe(
    `UPDATE pharmacy_counter_sale_void_requests
        SET task_stage = $1,
            updated_at = NOW()
      WHERE tenant_id = $2::uuid
        AND id = $3::bigint
        AND task_stage = $4
      RETURNING *`,
    stage,
    tenant,
    canonicalCounterSaleBigIntId(request.id, 'void request id'),
    request.task_stage,
  );
  if (!requestRows.length) {
    throw AppError.conflict(
      'Counter-sale void task stage changed concurrently',
      'COUNTER_SALE_VOID_TASK_STAGE_CONFLICT',
    );
  }
  const taskRows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET title = $1,
            description = $2,
            assigned_to_uid = NULL,
            assigned_to_role = $3,
            metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $5::uuid
        AND id = $6::int
        AND status IN ('open', 'in_progress', 'blocked', 'overdue')
      RETURNING id`,
    presentation.title,
    presentation.description,
    presentation.assignedRole,
    JSON.stringify({
      task_stage: stage,
      owner_role_codes: presentation.ownerRoles,
    }),
    tenant,
    Number(request.task_id),
  );
  if (!taskRows.length) {
    throw AppError.conflict(
      'Counter-sale void task is no longer actionable',
      'COUNTER_SALE_VOID_TASK_STAGE_CONFLICT',
    );
  }
  if (stage === 'payout' || stage === 'rejected_review') {
    await insertVoidStageNotificationsTx(tx, {
      tenant,
      request: requestRows[0],
      stage,
    });
  }
  return requestRows[0];
}

async function completeCounterSaleVoidTaskSlaTx(tx, {
  tenant, request, actorUid, evidenceKind,
}) {
  const instants = await tx.$queryRawUnsafe('SELECT clock_timestamp() AS completed_at');
  const completedAt = instants[0].completed_at;
  const taskRows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET status = 'completed',
            completed_at = $1::timestamptz,
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $3::uuid
        AND id = $4::int
        AND status IN ('open', 'in_progress', 'blocked', 'overdue')
      RETURNING id, workflow_sla_instance_id, completed_at`,
    completedAt,
    JSON.stringify({
      completion_via: 'domain_evidence',
      completion_evidence: {
        kind: evidenceKind,
        resource_type: 'pharmacy_counter_sale_void_requests',
        resource_id: String(request.id),
        recorded_at: new Date(completedAt).toISOString(),
      },
    }),
    tenant,
    Number(request.task_id),
  );
  if (!taskRows.length) {
    throw AppError.conflict(
      'Counter-sale void task completion changed concurrently',
      'COUNTER_SALE_VOID_TASK_COMPLETION_CONFLICT',
    );
  }
  const evidence = {
    kind: evidenceKind,
    resource_type: 'pharmacy_counter_sale_void_requests',
    resource_id: String(request.id),
    occurred_at: new Date(completedAt).toISOString(),
    recorded_at: new Date(completedAt).toISOString(),
  };
  const slaRows = await tx.$queryRawUnsafe(
    `UPDATE workflow_sla_instances
        SET status = CASE
              WHEN due_at < $1::timestamptz
                THEN CASE WHEN status = 'escalated' THEN 'escalated' ELSE 'breached' END
              ELSE 'completed'
            END,
            completed_at = $1::timestamptz,
            breached_at = CASE WHEN due_at < $1::timestamptz THEN due_at ELSE NULL END,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'completed_via', 'domain_evidence',
                   'completed_by_task', $2::int,
                   'completed_by', $3::text,
                   'completion_evidence', $4::jsonb
                 ),
            updated_at = NOW()
      WHERE tenant_id = $5::uuid
        AND id = $6::uuid
        AND completed_at IS NULL
        AND status <> 'cancelled'
      RETURNING id, completed_at`,
    completedAt,
    Number(request.task_id),
    String(actorUid),
    JSON.stringify(evidence),
    tenant,
    String(request.workflow_sla_instance_id),
  );
  if (!slaRows.length) {
    throw AppError.conflict(
      'Counter-sale void SLA completion changed concurrently',
      'COUNTER_SALE_VOID_SLA_COMPLETION_CONFLICT',
    );
  }
  return { completedAt, task: taskRows[0], sla: slaRows[0] };
}

async function insertVoidOutcomeNotificationTx(tx, {
  tenant, saleId, request, outcome,
}) {
  const completed = outcome === 'voided';
  await tx.$executeRawUnsafe(
    `INSERT INTO notifications
       (tenant_id, uid, user_id, phone, title, body, type, priority,
        data, is_read, created_at, updated_at, related_id, recipient_role)
     SELECT $1::uuid,
            user_row.uid,
            user_row.id,
            COALESCE(NULLIF(btrim(user_row.phone), ''), 'unknown'),
            $2,
            $3,
            $4,
            'HIGH',
            $5::jsonb,
            false,
            NOW(),
            NOW(),
            $6::int,
            user_row.role
       FROM users user_row
      WHERE user_row.tenant_id = $1::uuid
        AND user_row.uid = $7::uuid`,
    tenant,
    completed ? 'Counter sale void completed' : 'Counter sale void refund rejected',
    completed
      ? `Counter sale #${saleId} was restocked after its exact refund completed.`
      : `The refund for counter sale #${saleId} was rejected. The sale and stock remain locked pending explicit custody resolution.`,
    completed ? 'COUNTER_SALE_VOID_COMPLETED' : 'COUNTER_SALE_VOID_REFUND_REJECTED',
    JSON.stringify({
      event_type: completed
        ? 'counter_sale_void_completed'
        : 'counter_sale_void_refund_rejected',
      action_key: 'pharmacy.counter_sale_void.view',
      action_label_key: VOID_RECONCILIATION_ACTION_LABEL_KEY,
      deep_link: pharmacyDeepLink(saleId),
      counter_sale_id: String(saleId),
      counter_sale_void_request_id: String(request.id),
      billing_refund_id: Number(request.refund_id),
    }),
    Number(request.refund_id),
    String(request.requested_by),
  );
}

/**
 * Same-day initiation only. This creates one dedicated PENDING billing refund
 * and parks the sale in VOID_PENDING_REFUND. It never approves, pays, or
 * restocks; those remain separately authorized billing and reconciliation
 * actions.
 */
export async function voidCounterSale({
  tenantId, id, reason, disposition, voided_by, voided_by_name,
  voided_by_role, command_key,
}) {
  const tenant = requireTenant(tenantId);
  const saleId = positiveSaleId(id);
  const normalizedReason = normalizedVoidReason(reason);
  const normalizedDisposition = normalizedVoidDisposition(disposition);
  if (!voided_by) {
    throw AppError.badRequest('voided_by is required', 'COUNTER_SALE_VOID_ACTOR_REQUIRED');
  }
  const commandKey = normalizedVoidCommandKey(command_key);
  const fingerprint = counterSaleVoidCommandFingerprint({
    tenantId: tenant,
    saleId,
    reason: normalizedReason,
    disposition: normalizedDisposition,
    requestedBy: voided_by,
  });

  const result = await setTenantTx(tenant, async (tx) => {
    const replay = await loadVoidCommandTx(tx, {
      tenant, requestedBy: voided_by, commandKey,
    });
    if (replay) {
      if (replay.request_fingerprint !== fingerprint
          || canonicalCounterSaleBigIntId(replay.counter_sale_id) !== saleId) {
        throw AppError.unprocessable(
          'Void command key was reused with different intent',
          'COUNTER_SALE_VOID_COMMAND_MISMATCH',
        );
      }
      return { replay: true, row: replay };
    }

    const saleRows = await tx.$queryRawUnsafe(
      `SELECT sale.id::text,
              sale.tenant_id,
              sale.patient_uid,
              sale.customer_name,
              sale.customer_phone,
              sale.rx_doctor_name,
              sale.rx_reference,
              sale.status,
              sale.invoice_id,
              sale.payment_mode,
              sale.payment_reference,
              sale.total_amount,
              sale.void_refund_id,
              sale.created_at,
              invoice.patient_uid AS refund_patient_uid,
              invoice.invoice_type,
              invoice.status AS invoice_status,
              invoice.total_amount AS invoice_total_amount,
              invoice.amount_paid AS invoice_amount_paid,
              ((sale.created_at AT TIME ZONE 'Asia/Kolkata')::date =
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS is_same_day
         FROM pharmacy_counter_sales sale
         JOIN billing_invoices invoice
           ON invoice.tenant_id = sale.tenant_id
          AND invoice.id = sale.invoice_id
        WHERE sale.tenant_id = $1::uuid
          AND sale.id = $2::bigint
        LIMIT 1
        FOR UPDATE OF sale, invoice`,
      tenant, saleId,
    );
    const sale = saleRows[0];
    if (!sale) throw AppError.notFound('Counter sale not found');
    if (sale.status === 'VOIDED') {
      throw AppError.badRequest(
        'Counter sale is already voided',
        'COUNTER_SALE_ALREADY_VOIDED',
      );
    }
    if (sale.status !== 'COMPLETED') {
      const concurrentReplay = await loadVoidCommandTx(tx, {
        tenant, requestedBy: voided_by, commandKey,
      });
      if (concurrentReplay
          && concurrentReplay.request_fingerprint === fingerprint
          && canonicalCounterSaleBigIntId(concurrentReplay.counter_sale_id) === saleId) {
        return { replay: true, row: concurrentReplay };
      }
      throw AppError.conflict(
        `Only completed sales can start a void (status: ${sale.status})`,
        'COUNTER_SALE_NOT_COMPLETED',
      );
    }
    if (!sale.is_same_day) {
      throw AppError.badRequest(
        'Counter sales can only start a void on the day of sale; use the billing return workflow for later returns',
        'COUNTER_SALE_VOID_SAME_DAY_ONLY',
      );
    }
    if (sale.invoice_type !== 'PHARMACY'
        || !moneyMatches(sale.total_amount, sale.invoice_total_amount)
        || !moneyMatches(sale.total_amount, sale.invoice_amount_paid)) {
      throw AppError.conflict(
        'Counter sale invoice identity or paid amount is not refund-ready',
        'COUNTER_SALE_VOID_INVOICE_MISMATCH',
      );
    }

    const paymentRows = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS payment_count,
              COALESCE(SUM(payment.amount), 0)::numeric AS gross_paid,
              MIN(UPPER(payment.mode)) AS min_mode,
              MAX(UPPER(payment.mode)) AS max_mode,
              MIN(payment.reference) AS min_reference,
              MAX(payment.reference) AS max_reference
         FROM billing_payments payment
        WHERE payment.tenant_id = $1::uuid
          AND payment.invoice_id = $2::int
          AND payment.reversed = false`,
      tenant, Number(sale.invoice_id),
    );
    const paymentEvidence = paymentRows[0];
    const originalReference = String(sale.payment_reference || '').trim();
    if (String(sale.payment_mode).toUpperCase() !== 'CASH' && !originalReference) {
      throw AppError.conflict(
        'Legacy electronic or instrument counter sale has no original payment reference; refund payout evidence cannot be bound safely',
        'COUNTER_SALE_VOID_ORIGINAL_PAYMENT_REFERENCE_MISSING',
      );
    }
    if (Number(paymentEvidence.payment_count) !== 1
        || !moneyMatches(paymentEvidence.gross_paid, sale.total_amount)
        || paymentEvidence.min_mode !== String(sale.payment_mode).toUpperCase()
        || paymentEvidence.max_mode !== String(sale.payment_mode).toUpperCase()
        || paymentEvidence.min_reference !== sale.payment_reference
        || paymentEvidence.max_reference !== sale.payment_reference) {
      throw AppError.conflict(
        'Counter sale does not have one exact unreversed payment for its invoice, amount, and mode',
        'COUNTER_SALE_VOID_PAYMENT_EVIDENCE_MISMATCH',
      );
    }

    const activeRefunds = await tx.$queryRawUnsafe(
      `SELECT id
         FROM billing_refunds
        WHERE tenant_id = $1::uuid
          AND invoice_id = $2::int
          AND approval_status <> 'REJECTED'
        FOR UPDATE`,
      tenant, Number(sale.invoice_id),
    );
    if (activeRefunds.length) {
      throw AppError.conflict(
        'The invoice already has a refund obligation; it cannot be selected for this counter-sale void',
        'COUNTER_SALE_VOID_REFUND_CONFLICT',
      );
    }

    const requestRows = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_counter_sale_void_requests
         (tenant_id, counter_sale_id, invoice_id, patient_uid, amount,
           refund_mode, disposition, reason, requested_by, requested_by_name,
           requested_by_role, command_key, request_fingerprint, status)
        VALUES ($1::uuid, $2::bigint, $3::int, $4::uuid, $5::numeric,
                $6, $7, $8, $9::uuid, $10, $11, $12, $13, 'CREATING')
        RETURNING *`,
      tenant,
      saleId,
      Number(sale.invoice_id),
      String(sale.refund_patient_uid),
      Number(sale.total_amount),
      String(sale.payment_mode).toUpperCase(),
      normalizedDisposition,
      normalizedReason,
      String(voided_by),
      voided_by_name || null,
      String(voided_by_role || 'PHARMACY_INCHARGE').trim().toUpperCase(),
      commandKey,
      fingerprint,
    );
    const request = requestRows[0];
    const refundRows = await tx.$queryRawUnsafe(
      `INSERT INTO billing_refunds
         (patient_uid, invoice_id, advance_id, amount, reason, mode,
          raised_by, tenant_id, counter_sale_void_request_id)
       VALUES ($1::uuid, $2::int, NULL, $3::numeric, $4, $5,
               $6::uuid, $7::uuid, $8::bigint)
       RETURNING id, invoice_id, patient_uid, amount, mode, approval_status,
                 payout_rail, reference, raised_at, approved_at, paid_at`,
      String(sale.refund_patient_uid),
      Number(sale.invoice_id),
      Number(sale.total_amount),
      `Counter sale #${saleId} void request #${request.id}: ${normalizedReason}`,
      String(sale.payment_mode).toUpperCase(),
      String(voided_by),
      tenant,
      canonicalCounterSaleBigIntId(request.id, 'void request id'),
    );
    const refund = refundRows[0];
    const boundRequests = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_counter_sale_void_requests
          SET refund_id = $1::int,
              status = 'PENDING_REFUND',
              updated_at = NOW()
        WHERE tenant_id = $2::uuid
          AND id = $3::bigint
          AND status = 'CREATING'
          AND refund_id IS NULL
        RETURNING *`,
      Number(refund.id), tenant,
      canonicalCounterSaleBigIntId(request.id, 'void request id'),
    );
    if (!boundRequests.length) {
      throw AppError.conflict(
        'Counter-sale void request binding changed concurrently',
        'COUNTER_SALE_VOID_BINDING_CONFLICT',
      );
    }
    let boundRequest = boundRequests[0];
    const taskBinding = await materializeCounterSaleVoidTaskTx(tx, {
      tenant,
      sale,
      request: boundRequest,
    });
    boundRequest = taskBinding.request;
    const pendingSales = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_counter_sales
          SET status = 'VOID_PENDING_REFUND',
              void_refund_id = $1::int,
              updated_at = NOW()
        WHERE tenant_id = $2::uuid
          AND id = $3::bigint
          AND status = 'COMPLETED'
          AND void_refund_id IS NULL
        RETURNING id::text, status, invoice_id, patient_uid, total_amount,
                  payment_mode, void_refund_id, created_at, updated_at`,
      Number(refund.id), tenant, saleId,
    );
    if (!pendingSales.length) {
      throw AppError.conflict(
        'Counter sale state changed before the void request was parked',
        'COUNTER_SALE_STATE_CONFLICT',
      );
    }

    await insertFinanceVoidNotificationsTx(tx, {
      tenant,
      sale,
      request: boundRequest,
      refund,
    });
    await insertCounterSaleVoidAuditTx(tx, {
      tenant,
      request: boundRequest,
      actorUid: voided_by,
      actorRole: boundRequest.requested_by_role,
      action: 'COUNTER_SALE_VOID_REQUESTED',
      metadata: {
        command_key: commandKey,
        finance_deep_link: financeDeepLink(refund.id, boundRequest.id),
      },
    });

    return {
      replay: false,
      row: {
        ...boundRequest,
        request_id: String(boundRequest.id),
        counter_sale_id: String(boundRequest.counter_sale_id),
        request_status: boundRequest.status,
        refund_patient_uid: boundRequest.patient_uid,
        refund_amount: refund.amount,
        refund_mode_value: refund.mode,
        approval_status: refund.approval_status,
        payout_rail: refund.payout_rail,
        refund_reference: refund.reference,
        raised_at: refund.raised_at,
        approved_at: refund.approved_at,
        paid_at: refund.paid_at,
        task_status: taskBinding.task.status,
        task_due_at: taskBinding.task.due_at,
        sale_status: pendingSales[0].status,
        patient_uid: sale.patient_uid,
      },
    };
  });

  const row = result.row;
  const request = publicVoidRequest(row);
  const refund = publicVoidRefund(row);
  return {
    outcome: result.replay ? 'replay' : 'pending_refund',
    workflow_status: workflowStatusForVoid(row),
    sale: {
      id: String(row.counter_sale_id),
      status: row.sale_status,
      invoice_id: Number(row.invoice_id),
      total_amount: Number(row.amount),
      payment_mode: row.refund_mode,
      void_refund_id: Number(row.refund_id),
    },
    void_request: request,
    refund,
    actions: voidActionContract({
      saleId: row.counter_sale_id,
      invoiceId: row.invoice_id,
      refundId: row.refund_id,
      requestId: row.request_id,
    }),
  };
}

function workflowStatusForVoid(row) {
  if (!row) return 'NOT_REQUESTED';
  if (row.request_status === 'COMPLETED') return 'VOIDED';
  if (row.request_status === 'CANCELLED_HANDOVER_CONFIRMED') {
    return 'CANCELLED_HANDOVER_CONFIRMED';
  }
  if (row.request_status === 'REFUND_REJECTED_REVIEW'
      || row.approval_status === 'REJECTED') return 'REFUND_REJECTED_REVIEW';
  if (row.approval_status === 'PENDING') return 'AWAITING_FINANCE_APPROVAL';
  if (row.approval_status === 'APPROVED') {
    return row.payout_rail === 'gateway'
      ? 'AWAITING_GATEWAY_PAYOUT'
      : 'AWAITING_FINANCE_PAYOUT';
  }
  if (row.approval_status === 'PAID' && row.payout_rail === 'gateway'
      && row.gateway_execution_status !== 'processed') {
    return 'AWAITING_GATEWAY_EVIDENCE';
  }
  if (row.approval_status === 'PAID' && row.paid_evidence_accepted !== true) {
    return 'AWAITING_PAYOUT_EVIDENCE';
  }
  if (row.approval_status === 'PAID') return 'READY_TO_RECONCILE';
  return 'PENDING_REVIEW';
}

export async function getCounterSaleVoidStatus({ tenantId, id }) {
  const tenant = requireTenant(tenantId);
  const saleId = positiveSaleId(id);
  const sale = await getCounterSale({ tenantId: tenant, id: saleId });
  const rows = await setTenantTx(tenant, (tx) => tx.$queryRawUnsafe(
    `SELECT request.id::text AS request_id,
            request.counter_sale_id::text,
            request.invoice_id,
            request.patient_uid AS refund_patient_uid,
            request.refund_id,
            request.amount,
            request.refund_mode,
            request.disposition,
            request.reason,
            request.status AS request_status,
            request.task_stage,
            request.task_id,
            request.workflow_sla_instance_id,
            request.requested_at,
            request.last_checked_at,
            request.reconciled_at,
            request.reconciliation_source,
            refund.amount AS refund_amount,
            refund.mode AS refund_mode_value,
            refund.approval_status,
            refund.payout_rail,
            refund.reference AS refund_reference,
            refund.raised_at,
            refund.approved_at,
            refund.paid_at,
            execution.status AS gateway_execution_status,
            counter_sale_void_has_paid_evidence(request.id) AS paid_evidence_accepted,
            task.status AS task_status,
            task.due_at AS task_due_at
       FROM pharmacy_counter_sale_void_requests request
       JOIN billing_refunds refund
         ON refund.tenant_id = request.tenant_id
        AND refund.id = request.refund_id
        AND refund.counter_sale_void_request_id = request.id
       LEFT JOIN payment_gateway_refunds execution
         ON execution.tenant_id = refund.tenant_id
        AND execution.id = refund.gateway_refund_id
        AND execution.billing_refund_id = refund.id
       LEFT JOIN tasks task
         ON task.tenant_id = request.tenant_id
        AND task.id = request.task_id
      WHERE request.tenant_id = $1::uuid
        AND request.counter_sale_id = $2::bigint
      ORDER BY request.created_at DESC, request.id DESC
      LIMIT 1`,
    tenant, saleId,
  ), { readOnly: true });
  const row = rows[0] || null;
  return {
    workflow_status: workflowStatusForVoid(row),
    sale,
    void_request: publicVoidRequest(row),
    refund: publicVoidRefund(row),
    actions: row ? voidActionContract({
      saleId,
      invoiceId: row.invoice_id,
      refundId: row.refund_id,
      requestId: row.request_id,
    }) : null,
  };
}

async function loadVoidReconciliationTx(tx, { tenant, saleId }) {
  const saleRows = await tx.$queryRawUnsafe(
    `SELECT sale.id::text,
            sale.tenant_id,
            sale.patient_uid,
            sale.customer_name,
            sale.customer_phone,
            sale.rx_doctor_name,
            sale.rx_reference,
            sale.status,
            sale.invoice_id,
            sale.payment_mode,
            sale.total_amount,
            sale.void_refund_id
       FROM pharmacy_counter_sales sale
      WHERE sale.tenant_id = $1::uuid
        AND sale.id = $2::bigint
      LIMIT 1
      FOR UPDATE`,
    tenant, saleId,
  );
  const sale = saleRows[0];
  if (!sale) throw AppError.notFound('Counter sale not found');

  const requestRows = await tx.$queryRawUnsafe(
    `SELECT request.*,
            refund.patient_uid AS refund_patient_uid,
            refund.invoice_id AS refund_invoice_id,
            refund.amount AS refund_amount,
            refund.mode AS refund_mode_value,
            refund.approval_status,
            refund.approved_by,
            refund.approved_at,
            refund.paid_by,
            refund.paid_at,
            refund.payout_rail,
            refund.payout_rail_claimed_at,
            refund.gateway_refund_id,
            refund.cash_drawer_session_id,
            refund.reference AS refund_reference,
            task.status AS task_status,
            task.due_at AS task_due_at,
            NULL::text AS gateway_execution_status,
            NULL::text AS provider_refund_id,
            NULL::timestamptz AS processed_at
       FROM pharmacy_counter_sale_void_requests request
       JOIN billing_refunds refund
         ON refund.tenant_id = request.tenant_id
        AND refund.id = request.refund_id
        AND refund.counter_sale_void_request_id = request.id
       LEFT JOIN tasks task
         ON task.tenant_id = request.tenant_id
        AND task.id = request.task_id
      WHERE request.tenant_id = $1::uuid
        AND request.counter_sale_id = $2::bigint
      ORDER BY request.created_at DESC, request.id DESC
      LIMIT 1
      FOR UPDATE OF request, refund`,
    tenant, saleId,
  );
  const request = requestRows[0] || null;
  if (request?.gateway_refund_id != null) {
    const executionRows = await tx.$queryRawUnsafe(
      `SELECT execution.status AS gateway_execution_status,
              execution.provider_refund_id,
              execution.processed_at
         FROM payment_gateway_refunds execution
        WHERE execution.tenant_id = $1::uuid
          AND execution.id = $2::bigint
          AND execution.billing_refund_id = $3::int
        LIMIT 1
        FOR UPDATE`,
      tenant,
      Number(request.gateway_refund_id),
      Number(request.refund_id),
    );
    Object.assign(request, executionRows[0] || {});
  }
  return { sale, request };
}

/**
 * Idempotent, crash-safe close: only an exact PAID bound refund can enter this
 * transaction. Every allocation return, controlled-register row, request
 * completion, sale VOIDED state, and canonical event commits together.
 */
export async function reconcileCounterSaleVoid({
  tenantId, id, reconciled_by = null, reconciled_by_role = null,
  request_id = null,
}) {
  const tenant = requireTenant(tenantId);
  const saleId = positiveSaleId(id);
  return setTenantTx(tenant, async (tx) => {
    const loaded = await loadVoidReconciliationTx(tx, { tenant, saleId });
    const { sale } = loaded;
    let { request } = loaded;
    if (!request) {
      throw AppError.notFound('Counter-sale void request not found');
    }
    const source = reconciled_by ? 'manual' : 'system';

    if (request.status === 'COMPLETED') {
      return {
        outcome: 'replay',
        workflow_status: 'VOIDED',
        sale: { id: sale.id, status: sale.status, void_refund_id: sale.void_refund_id },
        void_request: publicVoidRequest({ ...request, request_id: request.id, request_status: request.status }),
        refund: publicVoidRefund(request),
        actions: voidActionContract({
          saleId, invoiceId: request.invoice_id, refundId: request.refund_id, requestId: request.id,
        }),
      };
    }
    if (request.status === 'CANCELLED_HANDOVER_CONFIRMED') {
      return {
        outcome: 'replay',
        workflow_status: 'CANCELLED_HANDOVER_CONFIRMED',
        sale: { id: sale.id, status: sale.status, void_refund_id: sale.void_refund_id },
        void_request: publicVoidRequest({
          ...request,
          request_id: request.id,
          request_status: request.status,
        }),
        refund: publicVoidRefund(request),
        actions: voidActionContract({
          saleId, invoiceId: request.invoice_id, refundId: request.refund_id, requestId: request.id,
        }),
      };
    }
    if (request.status === 'REFUND_REJECTED_REVIEW') {
      return {
        outcome: 'refund_rejected_review',
        workflow_status: 'REFUND_REJECTED_REVIEW',
        sale: { id: sale.id, status: sale.status, void_refund_id: sale.void_refund_id },
        void_request: publicVoidRequest({ ...request, request_id: request.id, request_status: request.status }),
        refund: publicVoidRefund(request),
        actions: voidActionContract({
          saleId, invoiceId: request.invoice_id, refundId: request.refund_id, requestId: request.id,
        }),
      };
    }

    if (request.approval_status === 'REJECTED') {
      if (request.task_stage !== 'rejected_review') {
        request = {
          ...request,
          ...await advanceCounterSaleVoidTaskStageTx(tx, {
          tenant,
          request,
          stage: 'rejected_review',
          }),
        };
      }
      const reviewRows = await tx.$executeRawUnsafe(
        `UPDATE pharmacy_counter_sale_void_requests
            SET status = 'REFUND_REJECTED_REVIEW',
                last_checked_at = NOW(),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
            AND status = 'PENDING_REFUND'`,
        tenant,
        canonicalCounterSaleBigIntId(request.id, 'void request id'),
      );
      if (Number(reviewRows) !== 1) {
        throw AppError.conflict(
          'Rejected counter-sale void changed before review could be opened',
          'COUNTER_SALE_VOID_REQUEST_CONFLICT',
        );
      }
      await insertVoidOutcomeNotificationTx(tx, {
        tenant, saleId, request, outcome: 'refund_rejected',
      });
      await insertCounterSaleVoidAuditTx(tx, {
        tenant,
        request,
        actorUid: reconciled_by || request.requested_by,
        actorRole: reconciled_by_role || request.requested_by_role,
        action: 'COUNTER_SALE_VOID_REFUND_REJECTED',
        metadata: { reconciliation_source: source },
      });
      return {
        outcome: 'refund_rejected_review',
        workflow_status: 'REFUND_REJECTED_REVIEW',
        sale: {
          id: sale.id,
          status: sale.status,
          invoice_id: sale.invoice_id,
          total_amount: sale.total_amount,
          void_refund_id: sale.void_refund_id,
        },
        void_request: {
          ...publicVoidRequest({
            ...request,
            request_id: request.id,
            request_status: 'REFUND_REJECTED_REVIEW',
          }),
        },
        refund: publicVoidRefund(request),
        actions: voidActionContract({
          saleId, invoiceId: request.invoice_id, refundId: request.refund_id, requestId: request.id,
        }),
      };
    }

    if (request.approval_status !== 'PAID') {
      if (request.approval_status === 'APPROVED' && request.task_stage === 'approval') {
        request = {
          ...request,
          ...await advanceCounterSaleVoidTaskStageTx(tx, {
          tenant,
          request,
          stage: 'payout',
          }),
        };
      }
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_counter_sale_void_requests
            SET last_checked_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
            AND status = 'PENDING_REFUND'`,
        tenant, canonicalCounterSaleBigIntId(request.id, 'void request id'),
      );
      return {
        outcome: 'pending_refund',
        workflow_status: workflowStatusForVoid({
          ...request,
          request_status: request.status,
        }),
        sale: { id: sale.id, status: sale.status, void_refund_id: sale.void_refund_id },
        void_request: publicVoidRequest({ ...request, request_id: request.id, request_status: request.status }),
        refund: publicVoidRefund(request),
        actions: voidActionContract({
          saleId, invoiceId: request.invoice_id, refundId: request.refund_id, requestId: request.id,
        }),
      };
    }

    const evidence = await tx.$queryRawUnsafe(
      `SELECT counter_sale_void_has_paid_evidence($1::bigint) AS accepted`,
      canonicalCounterSaleBigIntId(request.id, 'void request id'),
    );
    if (evidence[0]?.accepted !== true) {
      await tx.$executeRawUnsafe(
        `UPDATE pharmacy_counter_sale_void_requests
            SET last_checked_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::bigint
            AND status = 'PENDING_REFUND'`,
        tenant,
        canonicalCounterSaleBigIntId(request.id, 'void request id'),
      );
      return {
        outcome: 'pending_refund',
        workflow_status: request.payout_rail === 'gateway'
          ? 'AWAITING_GATEWAY_EVIDENCE'
          : 'AWAITING_PAYOUT_EVIDENCE',
        sale: { id: sale.id, status: sale.status, void_refund_id: sale.void_refund_id },
        void_request: publicVoidRequest({
          ...request,
          request_id: request.id,
          request_status: request.status,
        }),
        refund: publicVoidRefund(request),
        actions: voidActionContract({
          saleId, invoiceId: request.invoice_id, refundId: request.refund_id, requestId: request.id,
        }),
      };
    }
    if (sale.status !== 'VOID_PENDING_REFUND'
        || Number(sale.void_refund_id) !== Number(request.refund_id)
        || Number(request.refund_invoice_id) !== Number(sale.invoice_id)
        || !moneyMatches(request.refund_amount, sale.total_amount)
        || String(request.refund_mode_value).toUpperCase() !== String(sale.payment_mode).toUpperCase()) {
      throw AppError.conflict(
        'Paid refund is not the exact active counter-sale void obligation',
        'COUNTER_SALE_VOID_BINDING_CONFLICT',
      );
    }

    if (request.task_stage !== 'reconciliation') {
      request = {
        ...request,
        ...await advanceCounterSaleVoidTaskStageTx(tx, {
        tenant,
        request,
        stage: 'reconciliation',
        }),
      };
    }

    const allocations = await tx.$queryRawUnsafe(
      `SELECT allocation.id::text,
              allocation.inventory_batch_id,
              allocation.batch_number,
              allocation.quantity,
              allocation.return_movement_id,
              line.inventory_item_id,
              line.schedule_class,
              line.is_narcotic
         FROM pharmacy_counter_sale_allocations allocation
         JOIN pharmacy_counter_sale_lines line
           ON line.tenant_id = allocation.tenant_id
          AND line.id = allocation.counter_sale_line_id
        WHERE allocation.tenant_id = $1::uuid
          AND line.counter_sale_id = $2::bigint
        ORDER BY line.id, allocation.id
        FOR UPDATE OF allocation`,
      tenant, saleId,
    );
    if (!allocations.length) {
      throw AppError.conflict(
        'Counter sale has no allocation evidence to restock',
        'COUNTER_SALE_VOID_ALLOCATION_EVIDENCE_MISSING',
      );
    }

    for (const allocation of allocations) {
      if (allocation.return_movement_id) continue;
      const { movement } = await recordMovementTx(tx, {
        tenantId: tenant,
        inventory_item_id: allocation.inventory_item_id,
        inventory_batch_id: allocation.inventory_batch_id,
        movement_kind: 'return',
        quantity: allocation.quantity,
        reference_type: 'pharmacy_counter_sale_void',
        reference_id: String(saleId),
        performed_by: request.requested_by,
        notes: `Counter sale #${saleId} void: ${request.reason}`,
        expected_batch_number: allocation.batch_number,
      });
      const linked = await tx.$queryRawUnsafe(
        `UPDATE pharmacy_counter_sale_allocations
            SET return_movement_id = $1::int
          WHERE tenant_id = $2::uuid
            AND id = $3::bigint
            AND return_movement_id IS NULL
          RETURNING id`,
        Number(movement.id), tenant,
        canonicalCounterSaleBigIntId(allocation.id, 'allocation id'),
      );
      if (!linked.length) {
        throw AppError.conflict(
          'Counter-sale allocation return was linked concurrently',
          'COUNTER_SALE_VOID_ALLOCATION_CONFLICT',
        );
      }

      const controlled = SCHEDULED_CLASSES.includes(allocation.schedule_class)
        || allocation.is_narcotic === true;
      if (controlled) {
        await lockControlledRegisterItemTx(tx, tenant, allocation.inventory_item_id);
        const balance = await tx.$queryRawUnsafe(
          `SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS balance
             FROM pharmacy_inventory_batches
            WHERE tenant_id = $1::uuid
              AND inventory_item_id = $2::int
              AND status = 'in_stock'`,
          tenant, Number(allocation.inventory_item_id),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO pharmacy_schedule_register
             (tenant_id, inventory_item_id, inventory_batch_id, schedule_class,
              movement_kind, quantity, unit_label, running_balance,
              patient_uid, patient_name, patient_phone,
              prescription_number, prescriber_name,
              performed_by, performed_by_name, reference_movement_id, notes)
           SELECT $1::uuid, $2::int, $3::int,
                  COALESCE($4, CASE WHEN $5 THEN 'X' ELSE 'H1' END),
                  'return', $6::numeric, item.unit_label, $7::numeric,
                  $8::uuid, $9, $10, $11, $12, $13::uuid, $14, $15::int, $16
             FROM pharmacy_inventory_items item
            WHERE item.tenant_id = $1::uuid
              AND item.id = $2::int`,
          tenant,
          Number(allocation.inventory_item_id),
          Number(allocation.inventory_batch_id),
          allocation.schedule_class || null,
          allocation.is_narcotic === true,
          Number(allocation.quantity),
          Number(balance[0].balance),
          sale.patient_uid || null,
          sale.customer_name || null,
          sale.customer_phone || null,
          sale.rx_reference || null,
          sale.rx_doctor_name || null,
          String(request.requested_by),
          request.requested_by_name || 'Pharmacy counter',
          Number(movement.id),
          `Counter sale #${saleId} void restock`,
        );
      }
    }

    const completedRequests = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_counter_sale_void_requests
          SET status = 'COMPLETED',
              task_stage = 'completed',
              last_checked_at = NOW(),
              reconciled_at = NOW(),
              reconciled_by = $1::uuid,
              reconciliation_source = $2,
              updated_at = NOW()
        WHERE tenant_id = $3::uuid
          AND id = $4::bigint
          AND status = 'PENDING_REFUND'
        RETURNING *`,
      reconciled_by ? String(reconciled_by) : null,
      source,
      tenant,
      canonicalCounterSaleBigIntId(request.id, 'void request id'),
    );
    if (!completedRequests.length) {
      throw AppError.conflict(
        'Counter-sale void request state changed during reconciliation',
        'COUNTER_SALE_VOID_REQUEST_CONFLICT',
      );
    }

    const updatedSales = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_counter_sales
          SET status = 'VOIDED',
              voided_at = NOW(),
              voided_by = $1::uuid,
              void_reason = $2,
              updated_at = NOW()
        WHERE tenant_id = $3::uuid
          AND id = $4::bigint
          AND status = 'VOID_PENDING_REFUND'
          AND void_refund_id = $5::int
        RETURNING id::text, status, invoice_id, total_amount, voided_at,
                  voided_by, void_reason, void_refund_id`,
      String(request.requested_by),
      request.reason,
      tenant,
      saleId,
      Number(request.refund_id),
    );
    if (!updatedSales.length) {
      throw AppError.conflict(
        'Counter sale state changed during void reconciliation',
        'COUNTER_SALE_STATE_CONFLICT',
      );
    }

    await completeCounterSaleVoidTaskSlaTx(tx, {
      tenant,
      request: completedRequests[0],
      actorUid: reconciled_by || request.requested_by,
      evidenceKind: 'counter_sale_void_completed',
    });

    if (sale.patient_uid) {
      await recordCanonicalClinicalEvent({
        tenantId: tenant,
        patientUid: sale.patient_uid,
        eventType: 'pharmacy.counter_sale.voided',
        eventStatus: 'voided',
        sourceTable: 'pharmacy_counter_sales',
        sourceId: String(saleId),
        actorUid: request.requested_by,
        actorRole: request.requested_by_role,
        requestId: request_id || null,
        summary: `Pharmacy counter sale voided after exact refund INR ${Number(request.amount).toFixed(2)}: ${request.reason}`,
        payload: {
          counter_sale_id: String(saleId),
          invoice_id: Number(sale.invoice_id),
          refund_id: Number(request.refund_id),
          counter_sale_void_request_id: String(request.id),
          reconciliation_source: source,
        },
      }, { db: tx });
    }

    await insertVoidOutcomeNotificationTx(tx, {
      tenant, saleId, request, outcome: 'voided',
    });
    await insertCounterSaleVoidAuditTx(tx, {
      tenant,
      request,
      actorUid: reconciled_by || request.requested_by,
      actorRole: reconciled_by_role || request.requested_by_role,
      action: 'COUNTER_SALE_VOID_COMPLETED',
      metadata: { reconciliation_source: source },
    });

    return {
      outcome: 'voided',
      workflow_status: 'VOIDED',
      sale: updatedSales[0],
      void_request: publicVoidRequest({
        ...completedRequests[0],
        request_id: completedRequests[0].id,
        request_status: completedRequests[0].status,
      }),
      refund: publicVoidRefund(request),
      actions: voidActionContract({
        saleId, invoiceId: request.invoice_id, refundId: request.refund_id, requestId: request.id,
      }),
    };
  });
}

export async function resolveRejectedCounterSaleVoid({
  tenantId,
  id,
  resolution,
  reason,
  resolved_by,
  resolved_by_role,
  request_id = null,
}) {
  const tenant = requireTenant(tenantId);
  const saleId = positiveSaleId(id);
  if (String(resolution || '').trim().toUpperCase() !== 'CUSTOMER_HANDOVER_CONFIRMED') {
    throw AppError.unprocessable(
      'Rejected voids can close only after explicit customer handover confirmation',
      'COUNTER_SALE_VOID_REJECTION_RESOLUTION_INVALID',
    );
  }
  const normalizedReason = normalizedVoidReason(reason);
  if (!resolved_by) {
    throw AppError.badRequest(
      'resolved_by is required',
      'COUNTER_SALE_VOID_RESOLUTION_ACTOR_REQUIRED',
    );
  }

  return setTenantTx(tenant, async (tx) => {
    const { sale, request } = await loadVoidReconciliationTx(tx, { tenant, saleId });
    if (!request) throw AppError.notFound('Counter-sale void request not found');
    if (request.status === 'CANCELLED_HANDOVER_CONFIRMED') {
      return {
        outcome: 'replay',
        workflow_status: 'CANCELLED_HANDOVER_CONFIRMED',
        sale: { id: sale.id, status: sale.status, void_refund_id: sale.void_refund_id },
        void_request: publicVoidRequest({
          ...request,
          request_id: request.id,
          request_status: request.status,
        }),
        refund: publicVoidRefund(request),
        actions: voidActionContract({
          saleId, invoiceId: request.invoice_id, refundId: request.refund_id, requestId: request.id,
        }),
      };
    }
    if (request.status !== 'REFUND_REJECTED_REVIEW'
        || request.approval_status !== 'REJECTED'
        || sale.status !== 'VOID_PENDING_REFUND'
        || Number(sale.void_refund_id) !== Number(request.refund_id)) {
      throw AppError.conflict(
        'Counter-sale void is not awaiting rejected-refund custody resolution',
        'COUNTER_SALE_VOID_REJECTION_NOT_ACTIONABLE',
      );
    }
    const returned = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS returned_count
         FROM pharmacy_counter_sale_allocations allocation
         JOIN pharmacy_counter_sale_lines line
           ON line.tenant_id = allocation.tenant_id
          AND line.id = allocation.counter_sale_line_id
        WHERE allocation.tenant_id = $1::uuid
          AND line.counter_sale_id = $2::bigint
          AND allocation.return_movement_id IS NOT NULL`,
      tenant,
      saleId,
    );
    if (Number(returned[0]?.returned_count) !== 0) {
      throw AppError.conflict(
        'Customer handover cannot close after any stock return movement',
        'COUNTER_SALE_VOID_HANDOVER_STOCK_CONFLICT',
      );
    }

    const requestRows = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_counter_sale_void_requests
          SET status = 'CANCELLED_HANDOVER_CONFIRMED',
              task_stage = 'cancelled',
              last_checked_at = NOW(),
              reconciled_at = NOW(),
              reconciled_by = $1::uuid,
              reconciliation_source = 'manual',
              rejection_resolved_at = NOW(),
              rejection_resolved_by = $1::uuid,
              rejection_resolution = 'CUSTOMER_HANDOVER_CONFIRMED',
              rejection_resolution_reason = $2,
              updated_at = NOW()
        WHERE tenant_id = $3::uuid
          AND id = $4::bigint
          AND status = 'REFUND_REJECTED_REVIEW'
          AND task_stage = 'rejected_review'
        RETURNING *`,
      String(resolved_by),
      normalizedReason,
      tenant,
      canonicalCounterSaleBigIntId(request.id, 'void request id'),
    );
    if (!requestRows.length) {
      throw AppError.conflict(
        'Rejected-refund review changed concurrently',
        'COUNTER_SALE_VOID_REQUEST_CONFLICT',
      );
    }
    const reopened = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_counter_sales
          SET status = 'COMPLETED',
              void_refund_id = NULL,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'VOID_PENDING_REFUND'
          AND void_refund_id = $3::int
        RETURNING id::text, status, invoice_id, total_amount, void_refund_id`,
      tenant,
      saleId,
      Number(request.refund_id),
    );
    if (!reopened.length) {
      throw AppError.conflict(
        'Counter sale changed before custody resolution',
        'COUNTER_SALE_STATE_CONFLICT',
      );
    }
    await completeCounterSaleVoidTaskSlaTx(tx, {
      tenant,
      request: requestRows[0],
      actorUid: resolved_by,
      evidenceKind: 'counter_sale_void_handover_confirmed',
    });
    await insertCounterSaleVoidAuditTx(tx, {
      tenant,
      request: requestRows[0],
      actorUid: resolved_by,
      actorRole: resolved_by_role,
      action: 'COUNTER_SALE_VOID_HANDOVER_CONFIRMED',
      metadata: { resolution_reason: normalizedReason },
    });
    if (sale.patient_uid) {
      await recordCanonicalClinicalEvent({
        tenantId: tenant,
        patientUid: sale.patient_uid,
        eventType: 'pharmacy.counter_sale.void_cancelled',
        eventStatus: 'completed',
        sourceTable: 'pharmacy_counter_sales',
        sourceId: String(saleId),
        actorUid: resolved_by,
        actorRole: resolved_by_role,
        requestId: request_id || null,
        summary: `Counter-sale void cancelled after refund rejection and customer handover confirmation: ${normalizedReason}`,
        payload: {
          counter_sale_id: String(saleId),
          counter_sale_void_request_id: String(request.id),
          billing_refund_id: Number(request.refund_id),
          resolution: 'CUSTOMER_HANDOVER_CONFIRMED',
        },
      }, { db: tx });
    }
    return {
      outcome: 'handover_confirmed',
      workflow_status: 'CANCELLED_HANDOVER_CONFIRMED',
      sale: reopened[0],
      void_request: publicVoidRequest({
        ...requestRows[0],
        request_id: requestRows[0].id,
        request_status: requestRows[0].status,
      }),
      refund: publicVoidRefund(request),
      actions: voidActionContract({
        saleId, invoiceId: request.invoice_id, refundId: request.refund_id, requestId: request.id,
      }),
    };
  });
}

export async function reconcileCounterSaleVoidsForTenant({
  tenantId, limit = 25,
}) {
  const tenant = requireTenant(tenantId);
  const boundedLimit = boundedInteger(limit, { fallback: 25, min: 1, max: 100 });
  const candidates = await setTenantTx(tenant, (tx) => tx.$queryRawUnsafe(
    `SELECT request.counter_sale_id::text
       FROM pharmacy_counter_sale_void_requests request
       JOIN billing_refunds refund
         ON refund.tenant_id = request.tenant_id
        AND refund.id = request.refund_id
        AND refund.counter_sale_void_request_id = request.id
      WHERE request.tenant_id = $1::uuid
        AND request.status = 'PENDING_REFUND'
        AND refund.approval_status IN ('APPROVED', 'PAID', 'REJECTED')
      ORDER BY request.requested_at, request.id
      LIMIT $2::int`,
    tenant, boundedLimit,
  ), { readOnly: true });

  const results = [];
  for (const candidate of candidates) {
    try {
      results.push(await reconcileCounterSaleVoid({
        tenantId: tenant,
        id: candidate.counter_sale_id,
        reconciled_by: null,
      }));
    } catch (err) {
      logger.error('Counter-sale void reconciliation failed', {
        tenant_id: tenant,
        counter_sale_id: candidate.counter_sale_id,
        code: err?.code,
        error: err?.message,
      });
      results.push({
        outcome: 'failed',
        counter_sale_id: String(candidate.counter_sale_id),
        code: err?.code || 'COUNTER_SALE_VOID_RECONCILIATION_FAILED',
      });
    }
  }
  return {
    tenant_id: tenant,
    scanned: candidates.length,
    reconciled: results.filter((item) => item.outcome === 'voided').length,
    advanced_to_payout: results.filter((item) => (
      item.outcome === 'pending_refund' && item.workflow_status === 'AWAITING_FINANCE_PAYOUT'
    )).length,
    rejected_review: results.filter((item) => item.outcome === 'refund_rejected_review').length,
    failed: results.filter((item) => item.outcome === 'failed').length,
    results,
  };
}

export const reconcilePaidCounterSaleVoidsForTenant = reconcileCounterSaleVoidsForTenant;
