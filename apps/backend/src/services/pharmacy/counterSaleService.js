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
//                   invoice built via billingV2's service API (draft → items
//                   → issue), and the counter payment is collectPayment
//                   reusing the finalize tx. CASH requires the seller's open
//                   cash_drawer_session; the payment carries its shift so
//                   drawer close reconciles POS takings.
//   * void        — same-day void: billing refund (raise → approve → paid)
//                   plus per-allocation restock movements; controlled lines
//                   re-enter pharmacy_schedule_register in the return
//                   direction.
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
// priced, invoiced, and then re-validated under recordMovementTx's batch
// FOR UPDATE lock in the finalize tx. A concurrent sale that consumed the
// planned stock makes finalize fail cleanly; the issued invoice is voided as
// compensation and the caller retries against fresh stock.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { boundedInteger } from '../../utils/pagination.js';
import { istDateString } from '../../utils/dateUtils.js';
import { recordMovementTx, dispenseControlledTx } from './inventoryV2Service.js';
import {
  createDraftInvoice, addInvoiceItem, issueInvoice, voidInvoice,
  collectPayment, raiseRefund, approveRefund, markRefundPaid, getInvoice,
  deriveInvoicePaymentStateFromLedgerTx,
} from '../billing/billingV2Service.js';
import { resolveLedgerWiring } from '../billing/ledger/ledgerAuthoritativeMode.js';
import { postPaymentEntry } from '../billing/ledger/ledgerPostings.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

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
  tenantId, lines, patient_uid, customer_name, payment_mode, sold_by,
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
  if (!sold_by) throw AppError.badRequest('sold_by is required');
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
  itemsById, lines, rx, witness, patient_uid, customer_phone,
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
  if (needsWitness && !(witness?.uid && witness?.name)) {
    throw AppError.badRequest(
      'Schedule X / narcotic items require a witnessed dispense: witness.uid + witness.name',
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
 *   Phase 2  billingV2: draft invoice (per-allocation items with batch-stamped
 *            prices + master-data GST) → issue. Failure marks the sale FAILED.
 *   Phase 3  finalize tx: per-allocation stock decrement under batch locks
 *            (controlled lines through dispenseControlledTx's statutory
 *            register), allocation evidence rows, collectPayment (same tx),
 *            header → COMPLETED, canonical timeline+audit for registered
 *            patients. Any failure rolls the whole phase back; the issued
 *            invoice is voided as compensation and the sale parks FAILED.
 */
export async function createCounterSale({
  tenantId, lines, patient_uid, customer_name, customer_phone,
  rx, witness, payment_mode, payment_reference, notes,
  sold_by, sold_by_name, request_id,
}) {
  // ── Phase 0: pre-flight (reads only) ──────────────────────────────────
  validateSaleInput({ tenantId, lines, patient_uid, customer_name, payment_mode, sold_by });
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
  enforceScheduleRules({
    itemsById, lines, rx, witness, patient_uid, customer_phone,
  });

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

  // ── Phase 2: billingV2 invoice (draft → items → issue) ────────────────
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
    invoice = await issueInvoice(invoice.id, { tenantId: tenant });
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

  // ── Phase 3: finalize (stock + register + payment + COMPLETED), atomic ─
  //
  // Ledger wiring: collectPayment SKIPS its own ledger posting when handed a
  // caller tx ("that caller is responsible for its own ledger posting"), so
  // this path must post the PAYMENT leg itself exactly like billing's cashier
  // flow — otherwise every counter sale leaves PATIENT_AR debited by the
  // INVOICE_ISSUE leg and never credited. Same per-tenant mode contract:
  // enforce → post inside the finalize tx (a ledger failure rolls the sale
  // back) + derive the invoice cache columns from the ledger; shadow → post
  // after commit, best-effort; off → skip.
  const wiring = await resolveLedgerWiring(tenant);
  try {
    const result = await setTenantTx(tenant, async (tx) => {
      const totalAmount = Number(invoice.total_amount);
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
              witness_uid: witness?.uid || null,
              witness_name: witness?.name || null,
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

      const payment = await collectPayment({
        invoice_id: invoice.id,
        amount: totalAmount,
        mode: payment_mode,
        reference: payment_reference || null,
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
        invoice.id, totalAmount, payment_reference || null, sale.id, tenant,
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
            invoice_number: invoice.invoice_number,
            items: lineRows.map(({ planned }) => ({
              inventory_item_id: planned.item.id,
              name: planned.item.display_name,
              schedule_class: planned.item.schedule_class,
              quantity: planned.quantity,
            })),
          },
        }, { db: tx });
      }

      return { sale: updated[0], payment };
    });

    // Shadow mode: post the PAYMENT leg after commit, best-effort — identical
    // to collectPayment's own postCommit branch (a ledger problem must never
    // roll back the real sale).
    if (wiring.postCommit) {
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
    return { sale: result.sale, invoice: invoiceView, payment: result.payment };
  } catch (err) {
    // Compensation: the issued invoice holds no payment (the payment was part
    // of the rolled-back tx), so it can still be voided cleanly.
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
  s.void_refund_id, s.created_at, s.updated_at
`;

export async function getCounterSale({ tenantId, id }) {
  const tenant = requireTenant(tenantId);
  const saleId = Number(id);
  if (!Number.isInteger(saleId) || saleId <= 0) {
    throw AppError.badRequest('sale id must be a positive integer');
  }
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

// ── Void / return ─────────────────────────────────────────────────────

/**
 * Same-day void of a completed counter sale: billing refund (raise → approve
 * → paid, bounded by billingV2's refund-headroom guards) followed by an
 * atomic restock transaction that returns every allocation to its exact batch
 * and writes statutory-register return rows for controlled lines.
 *
 * Retry-safe: if a previous attempt paid the refund but failed the restock
 * tx, the existing refund is reused instead of raising a second one (which
 * billingV2's headroom bound would reject anyway).
 */
export async function voidCounterSale({
  tenantId, id, reason, voided_by, voided_by_name, request_id,
}) {
  const tenant = requireTenant(tenantId);
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest('reason is required to void a counter sale');
  }
  if (!voided_by) throw AppError.badRequest('voided_by is required');

  const sale = await getCounterSale({ tenantId: tenant, id });
  if (sale.status === 'VOIDED') {
    throw AppError.badRequest('Counter sale is already voided', 'COUNTER_SALE_ALREADY_VOIDED');
  }
  if (sale.status !== 'COMPLETED') {
    throw AppError.badRequest(
      `Only completed sales can be voided (status: ${sale.status})`,
      'COUNTER_SALE_NOT_COMPLETED',
    );
  }
  const today = istDateString();
  if (istDateString(new Date(sale.created_at)) !== today) {
    throw AppError.badRequest(
      'Counter sales can only be voided on the day of sale; use the billing refund workflow for later returns',
      'COUNTER_SALE_VOID_SAME_DAY_ONLY',
    );
  }

  const invoice = await getInvoice(sale.invoice_id, { tenantId: tenant });

  // Identity snapshot for the statutory register return rows: mirror the
  // dispense direction (registered patient's name/phone, else the captured
  // walk-in identity from the sale header).
  let registerPatientName = sale.customer_name || null;
  let registerPatientPhone = sale.customer_phone || null;
  if (sale.patient_uid) {
    const patientRows = await prisma.$queryRawUnsafe(
      `SELECT name, phone FROM users
        WHERE uid = $1::uuid AND tenant_id = $2::uuid
        LIMIT 1`,
      String(sale.patient_uid), tenant,
    );
    if (patientRows.length) {
      registerPatientName = patientRows[0].name || registerPatientName;
      registerPatientPhone = patientRows[0].phone || registerPatientPhone;
    }
  }

  // ── Refund (billing's mechanism; reuse a prior attempt's refund) ──────
  let refund = null;
  const priorRefunds = await prisma.$queryRawUnsafe(
    `SELECT id, amount, approval_status FROM billing_refunds
      WHERE invoice_id = $1::int AND tenant_id = $2::uuid
        AND approval_status <> 'REJECTED'
      ORDER BY id DESC`,
    Number(sale.invoice_id), tenant,
  );
  if (priorRefunds.length) {
    refund = priorRefunds[0];
  } else {
    refund = await raiseRefund({
      invoice_id: Number(sale.invoice_id),
      amount: Number(invoice.amount_paid),
      reason: `Counter sale #${sale.id} void: ${String(reason).trim()}`,
      mode: sale.payment_mode || 'CASH',
      raised_by: voided_by,
      tenantId: tenant,
    });
  }
  if (refund.approval_status === 'PENDING') {
    refund = await approveRefund(refund.id, { approved_by: voided_by, tenantId: tenant });
  }
  if (refund.approval_status === 'APPROVED') {
    refund = await markRefundPaid(refund.id, { paid_by: voided_by, tenantId: tenant });
  }

  // ── Restock + register returns + VOIDED, atomic ───────────────────────
  return setTenantTx(tenant, async (tx) => {
    const locked = await tx.$queryRawUnsafe(
      `SELECT id FROM pharmacy_counter_sales
        WHERE id = $1::bigint AND tenant_id = $2::uuid AND status = 'COMPLETED'
        FOR UPDATE`,
      Number(sale.id), tenant,
    );
    if (!locked.length) {
      throw AppError.conflict('Counter sale state changed; reload and retry', 'COUNTER_SALE_STATE_CONFLICT');
    }

    for (const line of sale.lines) {
      const controlled = SCHEDULED_CLASSES.includes(line.schedule_class) || line.is_narcotic;
      for (const alloc of line.allocations) {
        if (alloc.return_movement_id) continue; // already restocked (retry)
        const { movement } = await recordMovementTx(tx, {
          tenantId: tenant,
          inventory_item_id: line.inventory_item_id,
          inventory_batch_id: alloc.inventory_batch_id,
          movement_kind: 'return',
          quantity: alloc.quantity,
          reference_type: 'pharmacy_counter_sale_void',
          reference_id: String(sale.id),
          performed_by: voided_by,
          notes: `Counter sale #${sale.id} void: ${String(reason).trim()}`,
          expected_batch_number: alloc.batch_number,
        });
        await tx.$executeRawUnsafe(
          `UPDATE pharmacy_counter_sale_allocations
              SET return_movement_id = $1::int
            WHERE id = $2::bigint AND tenant_id = $3::uuid`,
          movement.id, Number(alloc.id), tenant,
        );
        // recordMovementTx flips a batch to 'depleted' at zero but never back:
        // a same-day restock into a batch the sale fully drained must revive
        // it or the returned stock stays invisible to FEFO ('in_stock'
        // predicates). Only non-expired batches come back.
        await tx.$executeRawUnsafe(
          `UPDATE pharmacy_inventory_batches
              SET status = 'in_stock', updated_at = NOW()
            WHERE id = $1::int AND tenant_id = $2::uuid
              AND status = 'depleted' AND remaining_quantity > 0
              AND expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
          Number(alloc.inventory_batch_id), tenant,
        );
        if (controlled) {
          // Controlled items restock THROUGH the statutory register: a return
          // row mirrors the dispense entry (same item/batch/actor lineage)
          // with the post-restock running balance, in the same tx as the
          // stock movement — never a bare quantity bump.
          const balance = await tx.$queryRawUnsafe(
            `SELECT COALESCE(SUM(remaining_quantity), 0)::numeric AS bal
               FROM pharmacy_inventory_batches
              WHERE inventory_item_id = $1::int AND tenant_id = $2::uuid AND status = 'in_stock'`,
            Number(line.inventory_item_id), tenant,
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
                    'return', $6::numeric, i.unit_label, $7::numeric,
                    $8::uuid, $9, $10, $11, $12, $13::uuid, $14, $15::int, $16
               FROM pharmacy_inventory_items i
              WHERE i.id = $2::int AND i.tenant_id = $1::uuid`,
            tenant, Number(line.inventory_item_id), Number(alloc.inventory_batch_id),
            line.schedule_class || null, line.is_narcotic === true,
            Number(alloc.quantity), Number(balance[0].bal),
            sale.patient_uid || null, registerPatientName, registerPatientPhone,
            sale.rx_reference || null, sale.rx_doctor_name || null,
            String(voided_by), voided_by_name || 'Pharmacy counter',
            movement.id, `Counter sale #${sale.id} void restock`,
          );
        }
      }
    }

    const updated = await tx.$queryRawUnsafe(
      `UPDATE pharmacy_counter_sales
          SET status = 'VOIDED', voided_at = NOW(), voided_by = $1::uuid,
              void_reason = $2, void_refund_id = $3::int, updated_at = NOW()
        WHERE id = $4::bigint AND tenant_id = $5::uuid
        RETURNING id::text AS id, status, invoice_id, total_amount, voided_at,
                  voided_by, void_reason, void_refund_id`,
      String(voided_by), String(reason).trim().slice(0, 255),
      refund?.id != null ? Number(refund.id) : null,
      Number(sale.id), tenant,
    );

    if (sale.patient_uid) {
      await recordCanonicalClinicalEvent({
        tenantId: tenant,
        patientUid: sale.patient_uid,
        eventType: 'pharmacy.counter_sale.voided',
        eventStatus: 'voided',
        sourceTable: 'pharmacy_counter_sales',
        sourceId: String(sale.id),
        actorUid: voided_by,
        actorRole: 'PHARMACY_INCHARGE',
        requestId: request_id || null,
        summary: `Pharmacy counter sale voided (refund INR ${Number(invoice.amount_paid).toFixed(2)}): ${String(reason).trim()}`,
        payload: {
          counter_sale_id: sale.id,
          invoice_id: sale.invoice_id,
          refund_id: refund?.id ?? null,
          reason: String(reason).trim(),
        },
      }, { db: tx });
    }

    return { sale: updated[0], refund };
  });
}
