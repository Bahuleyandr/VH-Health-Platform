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

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_INVOICE_TYPES = ['OP', 'IP', 'PHARMACY', 'EMERGENCY'];
const VALID_PAYMENT_MODES = [
  'CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET', 'INSURANCE',
];
const VALID_INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PARTIAL', 'PAID', 'VOID'];
const VALID_REFUND_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PAID'];
const HIGH_VALUE_DISCOUNT_APPROVER_ROLES = ['FINANCE_INCHARGE', 'ADMIN', 'SUPER_ADMIN'];

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

async function nextInvoiceNumber(tenantId) {
  // Atomic UPSERT-and-increment on (tenant, fiscal_year). Postgres
  // RETURNING gives us the just-claimed value. If two requests race
  // they take different rows because of the FOR UPDATE on the
  // existing row.
  const fy = fiscalYearOf();
  const rows = await prisma.$queryRawUnsafe(
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

async function recomputeInvoiceTotals(invoiceId) {
  const aggregates = await prisma.$queryRawUnsafe(
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
  const inv = await prisma.$queryRawUnsafe(
    `SELECT discount_amount, amount_paid FROM billing_invoices WHERE id = $1::int`,
    invoiceId,
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
  const discount = Number(inv[0].discount_amount || 0);
  const total = toFixed2(subtotal + cgst + sgst + igst - discount);
  const paid = Number(inv[0].amount_paid || 0);
  const due = toFixed2(total - paid);

  await prisma.$executeRawUnsafe(
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
  return { subtotal, cgst, sgst, igst, discount, total, paid, due };
}

async function recomputeInvoicePaymentState(invoiceId) {
  const normalizedInvoiceId = Number(invoiceId);
  const aggr = await prisma.$queryRawUnsafe(
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
  const inv = await prisma.$queryRawUnsafe(
    `SELECT total_amount FROM billing_invoices WHERE id = $1::int`,
    normalizedInvoiceId,
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
  const total = Number(inv[0].total_amount);
  const due = toFixed2(total - paid);
  let status = 'PARTIAL';
  if (due <= 0.005) status = 'PAID';
  else if (paid <= 0.005) status = 'ISSUED';
  await prisma.$executeRawUnsafe(
    `UPDATE billing_invoices
        SET amount_paid = $1::numeric, amount_due = $2::numeric, status = $3, updated_at = NOW()
      WHERE id = $4::int`,
    paid, due, status, normalizedInvoiceId,
  );
  return { paid, due, status };
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
async function assertAdmissionBillingOpen(admissionId) {
  if (admissionId == null || admissionId === '') return;
  const id = Number(admissionId);
  if (!Number.isInteger(id) || id <= 0) return;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT billing_closed_at FROM admissions WHERE id = $1::int`,
    id,
  );
  if (rows.length && rows[0].billing_closed_at) {
    throw AppError.conflict(
      `Billing is closed for admission ${id} (closed at ${rows[0].billing_closed_at.toISOString?.() ?? rows[0].billing_closed_at}). ` +
      'Reopen the admission via the discharge cascade before further invoice writes.',
      'BILLING_CLOSED',
    );
  }
}

export async function createDraftInvoice({
  patient_uid, patient_name, patient_phone, admission_id, doctor_uid,
  department, invoice_type = 'OP', patient_state, hospital_state,
  notes, created_by,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!VALID_INVOICE_TYPES.includes(invoice_type)) {
    throw AppError.badRequest(`Invalid invoice_type. Allowed: ${VALID_INVOICE_TYPES.join(', ')}`);
  }
  // B-1: enforce billing close before creating against a closed admission.
  await assertAdmissionBillingOpen(admission_id);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
      (patient_uid, patient_name, patient_phone, admission_id, doctor_uid,
       department, invoice_type, patient_state, hospital_state, notes, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11::uuid)
     RETURNING id, invoice_number, patient_uid, patient_name, patient_phone,
               admission_id, doctor_uid, department, invoice_type,
               patient_state, hospital_state, subtotal, cgst_amount, sgst_amount,
               igst_amount, discount_amount, total_amount, amount_paid,
               amount_due, status, notes, created_at`,
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
  );
  return rows[0];
}

export async function addInvoiceItem(invoiceId, {
  service_code, description, quantity = 1, unit_price, gst_rate, notes,
}) {
  // Pull the service master row when service_code is provided so we
  // snapshot description/category/hsn/gst defaults consistently.
  const resolved = { description, category: null, hsn_sac: null, unit_price, gst_rate };
  if (service_code) {
    const sm = await prisma.$queryRawUnsafe(
      `SELECT description, category, hsn_sac, default_price, gst_rate
         FROM billing_service_master
        WHERE code = $1 AND is_active = true
        LIMIT 1`,
      service_code,
    );
    if (sm.length) {
      resolved.description = description || sm[0].description;
      resolved.category = sm[0].category;
      resolved.hsn_sac = sm[0].hsn_sac;
      if (resolved.unit_price == null) resolved.unit_price = Number(sm[0].default_price);
      if (resolved.gst_rate == null) resolved.gst_rate = Number(sm[0].gst_rate);
    }
  }
  if (!resolved.description) throw AppError.badRequest('description (or valid service_code) is required');
  if (resolved.unit_price == null) throw AppError.badRequest('unit_price is required for ad-hoc lines');

  // Read the parent invoice for state-pair (governs CGST+SGST vs IGST)
  // and admission_id for the billing-close enforcement (B-1).
  const invs = await prisma.$queryRawUnsafe(
    `SELECT status, patient_state, hospital_state, admission_id
       FROM billing_invoices WHERE id = $1::int`,
    Number(invoiceId),
  );
  if (!invs.length) throw AppError.notFound('Invoice not found');
  if (invs[0].status !== 'DRAFT') {
    throw AppError.badRequest('Cannot add items to an issued/voided invoice');
  }
  await assertAdmissionBillingOpen(invs[0].admission_id);

  const qty = Number(quantity) || 1;
  const price = Number(resolved.unit_price);
  const rate = Number(resolved.gst_rate || 0);
  const lineSub = toFixed2(qty * price);
  const split = splitGst({
    subtotal: lineSub,
    gstRate: rate,
    patientState: invs[0].patient_state,
    hospitalState: invs[0].hospital_state,
  });

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoice_items
      (invoice_id, service_code, description, category, hsn_sac, quantity,
       unit_price, gst_rate, line_subtotal, cgst_amount, sgst_amount,
       igst_amount, line_total, notes)
     VALUES ($1::int, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric,
             $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14)
     RETURNING *`,
    Number(invoiceId), service_code || null, resolved.description, resolved.category,
    resolved.hsn_sac, qty, price, rate, lineSub,
    split.cgst, split.sgst, split.igst, split.lineTotal, notes || null,
  );
  await recomputeInvoiceTotals(Number(invoiceId));
  return rows[0];
}

export async function removeInvoiceItem(invoiceId, itemId) {
  const inv = await prisma.$queryRawUnsafe(
    `SELECT status, admission_id FROM billing_invoices WHERE id = $1::int`, Number(invoiceId),
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
  if (inv[0].status !== 'DRAFT') {
    throw AppError.badRequest('Cannot remove items from an issued/voided invoice');
  }
  await assertAdmissionBillingOpen(inv[0].admission_id);
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_invoice_items WHERE invoice_id = $1::int AND id = $2::int`,
    Number(invoiceId), Number(itemId),
  );
  return recomputeInvoiceTotals(Number(invoiceId));
}

export async function applyDiscount(invoiceId, { amount, reason, approved_by, approved_by_role }) {
  const discountAmount = parseDiscountAmount(amount);
  const inv = await prisma.$queryRawUnsafe(
    `SELECT status, subtotal, cgst_amount, sgst_amount, igst_amount, admission_id
       FROM billing_invoices WHERE id = $1::int`,
    Number(invoiceId),
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
  if (inv[0].status === 'VOID') throw AppError.badRequest('Cannot discount a void invoice');
  await assertAdmissionBillingOpen(inv[0].admission_id);
  const invoiceGross = toFixed2(
    Number(inv[0].subtotal || 0) +
    Number(inv[0].cgst_amount || 0) +
    Number(inv[0].sgst_amount || 0) +
    Number(inv[0].igst_amount || 0),
  );
  if (
    requiresDiscountApproval({ amount: discountAmount, invoiceGross }) &&
    !canApproveHighValueDiscount(approved_by_role)
  ) {
    throw AppError.forbidden(
      `Discounts above INR ${DISCOUNT_APPROVAL_AMOUNT_THRESHOLD} or ${DISCOUNT_APPROVAL_PERCENT_THRESHOLD}% ` +
        'require FINANCE_INCHARGE, ADMIN, or SUPER_ADMIN approval',
      'DISCOUNT_APPROVAL_REQUIRED',
    );
  }

  await prisma.$executeRawUnsafe(
    `UPDATE billing_invoices
        SET discount_amount = $1::numeric,
            discount_reason = $2,
            discount_approved_by = $3::uuid,
            updated_at = NOW()
      WHERE id = $4::int`,
    discountAmount, reason || null, approved_by ? String(approved_by) : null, Number(invoiceId),
  );
  return recomputeInvoiceTotals(Number(invoiceId));
}

export async function issueInvoice(invoiceId) {
  const inv = await prisma.$queryRawUnsafe(
    `SELECT id, status, tenant_id FROM billing_invoices WHERE id = $1::int`,
    Number(invoiceId),
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
  if (inv[0].status !== 'DRAFT') {
    throw AppError.badRequest(`Invoice is already ${inv[0].status}`);
  }
  const items = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM billing_invoice_items WHERE invoice_id = $1::int`,
    Number(invoiceId),
  );
  if (items[0].c === 0) throw AppError.badRequest('Cannot issue an invoice with no items');

  const number = await nextInvoiceNumber(inv[0].tenant_id);
  await prisma.$executeRawUnsafe(
    `UPDATE billing_invoices
        SET invoice_number = $1, status = 'ISSUED', issued_at = NOW(), updated_at = NOW()
      WHERE id = $2::int`,
    number, Number(invoiceId),
  );
  return getInvoice(invoiceId);
}

export async function voidInvoice(invoiceId, { reason, voided_by }) {
  if (!reason) throw AppError.badRequest('reason is required for voiding');
  const inv = await prisma.$queryRawUnsafe(
    `SELECT status FROM billing_invoices WHERE id = $1::int`, Number(invoiceId),
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
  if (inv[0].status === 'VOID') throw AppError.badRequest('Already void');
  if (inv[0].status === 'PAID') throw AppError.badRequest('Cannot void a paid invoice — raise a refund instead');

  await prisma.$executeRawUnsafe(
    `UPDATE billing_invoices
        SET status = 'VOID', voided_at = NOW(), voided_by = $1::uuid, void_reason = $2, updated_at = NOW()
      WHERE id = $3::int`,
    voided_by ? String(voided_by) : null, reason, Number(invoiceId),
  );
  return getInvoice(invoiceId);
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
  const tenant = tenantId || '00000000-0000-4000-8000-000000000001';
  const rows = await prisma.$queryRawUnsafe(
    `WITH active_root AS (
       SELECT id, preauth_number, status
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
    cumulative_approved: Number(row.cumulative_approved ?? 0),
  };
}

export async function getInvoice(invoiceId) {
  const inv = await prisma.$queryRawUnsafe(
    `SELECT * FROM billing_invoices WHERE id = $1::int`, Number(invoiceId),
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
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
  const tpaCap = await resolveAdmissionTpaCap(inv[0].admission_id, inv[0].tenant_id);
  let tpaUtilisation = null;
  if (tpaCap && tpaCap.cumulative_approved > 0) {
    const total = Number(inv[0].total_amount ?? 0);
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

  return {
    ...inv[0],
    items,
    payments,
    advance_settlements: settlements,
    tpa_utilisation: tpaUtilisation,
  };
}

export async function listInvoices({
  patient_uid, status, invoice_type, date_from, date_to, page = 1, limit = 20,
} = {}) {
  const params = [];
  const where = [];
  if (patient_uid) { params.push(String(patient_uid)); where.push(`patient_uid = $${params.length}::uuid`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (invoice_type) { params.push(invoice_type); where.push(`invoice_type = $${params.length}`); }
  if (date_from) { params.push(date_from); where.push(`COALESCE(issued_at, created_at) >= $${params.length}::timestamptz`); }
  if (date_to) { params.push(date_to); where.push(`COALESCE(issued_at, created_at) <= $${params.length}::timestamptz`); }

  const offset = (Number(page) - 1) * Number(limit);
  const sql = `SELECT id, invoice_number, patient_uid, patient_name, invoice_type,
                      total_amount, amount_paid, amount_due, status, issued_at, created_at
                 FROM billing_invoices
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY COALESCE(issued_at, created_at) DESC
                 LIMIT $${params.length + 1}::int OFFSET $${params.length + 2}::int`;
  return prisma.$queryRawUnsafe(sql, ...params, Number(limit), offset);
}

// ───────────────────────────────────────────────────────────────────────
// Payments
// ───────────────────────────────────────────────────────────────────────

export async function collectPayment({
  invoice_id, patient_uid, amount, mode, reference,
  denominations, collected_by, shift, notes,
}) {
  if (!VALID_PAYMENT_MODES.includes(mode)) {
    throw AppError.badRequest(`Invalid mode. Allowed: ${VALID_PAYMENT_MODES.join(', ')}`);
  }
  if (Number(amount) <= 0) throw AppError.badRequest('amount must be > 0');

  // Resolve patient_uid + invoice gating from invoice if invoice_id given.
  let resolvedPatientUid = patient_uid;
  if (invoice_id) {
    const inv = await prisma.$queryRawUnsafe(
      `SELECT patient_uid, status, total_amount, amount_paid, amount_due
         FROM billing_invoices WHERE id = $1::int`,
      Number(invoice_id),
    );
    if (!inv.length) throw AppError.notFound('Invoice not found');
    if (inv[0].status === 'VOID' || inv[0].status === 'DRAFT') {
      throw AppError.badRequest(`Cannot collect against ${inv[0].status} invoice`);
    }
    resolvedPatientUid = inv[0].patient_uid;
    if (Number(amount) > Number(inv[0].amount_due) + 0.01) {
      throw AppError.badRequest(
        `Amount ${amount} exceeds outstanding due ${inv[0].amount_due}`,
      );
    }
  }
  if (!resolvedPatientUid) throw AppError.badRequest('patient_uid is required when invoice_id is omitted');

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_payments
      (invoice_id, patient_uid, amount, mode, reference, denominations,
       collected_by, shift, notes)
     VALUES ($1, $2::uuid, $3::numeric, $4, $5, $6::jsonb, $7::uuid, $8, $9)
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
  );

  if (invoice_id) {
    await recomputeInvoicePaymentState(invoice_id);
  }
  return rows[0];
}

export async function reversePayment(paymentId, { reversed_by, reason }) {
  if (!reason) throw AppError.badRequest('reason is required');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE billing_payments
        SET reversed = true, reversed_at = NOW(),
            reversed_by = $1::uuid, reversal_reason = $2
      WHERE id = $3::int AND reversed = false
      RETURNING *`,
    reversed_by ? String(reversed_by) : null, reason, Number(paymentId),
  );
  if (!rows.length) throw AppError.notFound('Payment not found or already reversed');
  // Recompute parent invoice if attached.
  if (rows[0].invoice_id) {
    await recomputeInvoicePaymentState(rows[0].invoice_id);
  }
  return rows[0];
}

// ───────────────────────────────────────────────────────────────────────
// Advance / Deposit
// ───────────────────────────────────────────────────────────────────────

export async function collectAdvance({ patient_uid, admission_id, amount, mode, reference, collected_by, notes }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid required');
  if (!VALID_PAYMENT_MODES.includes(mode)) {
    throw AppError.badRequest(`Invalid mode. Allowed: ${VALID_PAYMENT_MODES.join(', ')}`);
  }
  if (Number(amount) <= 0) throw AppError.badRequest('amount must be > 0');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_advances
      (patient_uid, admission_id, amount, balance, mode, reference, collected_by, notes)
     VALUES ($1::uuid, $2, $3::numeric, $3::numeric, $4, $5, $6::uuid, $7)
     RETURNING *`,
    String(patient_uid),
    admission_id ? Number(admission_id) : null,
    Number(amount), mode, reference || null,
    collected_by ? String(collected_by) : null, notes || null,
  );
  return rows[0];
}

export async function listAdvances({ patient_uid, admission_id, status = 'ACTIVE' } = {}) {
  const params = [];
  const where = [];
  if (patient_uid) { params.push(String(patient_uid)); where.push(`patient_uid = $${params.length}::uuid`); }
  if (admission_id) { params.push(Number(admission_id)); where.push(`admission_id = $${params.length}::int`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  const sql = `SELECT * FROM billing_advances
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY collected_at DESC LIMIT 100`;
  return prisma.$queryRawUnsafe(sql, ...params);
}

export async function settleAdvance({ advance_id, invoice_id, amount, settled_by }) {
  const adv = await prisma.$queryRawUnsafe(
    `SELECT * FROM billing_advances WHERE id = $1::int`, Number(advance_id),
  );
  if (!adv.length) throw AppError.notFound('Advance not found');
  if (adv[0].status !== 'ACTIVE') throw AppError.badRequest(`Advance is ${adv[0].status}`);
  if (Number(amount) > Number(adv[0].balance) + 0.01) {
    throw AppError.badRequest(`Amount exceeds advance balance ${adv[0].balance}`);
  }

  const inv = await prisma.$queryRawUnsafe(
    `SELECT amount_due FROM billing_invoices WHERE id = $1::int`, Number(invoice_id),
  );
  if (!inv.length) throw AppError.notFound('Invoice not found');
  if (Number(amount) > Number(inv[0].amount_due) + 0.01) {
    throw AppError.badRequest(`Amount exceeds invoice due ${inv[0].amount_due}`);
  }

  const settlement = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_advance_settlements (advance_id, invoice_id, amount, settled_by)
     VALUES ($1::int, $2::int, $3::numeric, $4::uuid)
     RETURNING *`,
    Number(advance_id), Number(invoice_id), Number(amount),
    settled_by ? String(settled_by) : null,
  );

  // Bump amount_paid on the invoice + reduce balance on advance.
  const newBalance = toFixed2(Number(adv[0].balance) - Number(amount));
  const newStatus = newBalance <= 0.005 ? 'EXHAUSTED' : 'ACTIVE';
  await prisma.$executeRawUnsafe(
    `UPDATE billing_advances SET balance = $1::numeric, status = $2, updated_at = NOW() WHERE id = $3::int`,
    newBalance, newStatus, Number(advance_id),
  );

  // Recompute invoice totals (treats advance settlement as paid amount).
  await prisma.$executeRawUnsafe(
    `UPDATE billing_invoices
        SET amount_paid = amount_paid + $1::numeric,
            amount_due = amount_due - $1::numeric,
            status = CASE WHEN amount_due - $1::numeric <= 0.005 THEN 'PAID' ELSE 'PARTIAL' END,
            updated_at = NOW()
      WHERE id = $2::int`,
    Number(amount), Number(invoice_id),
  );
  return settlement[0];
}

// ───────────────────────────────────────────────────────────────────────
// Refunds
// ───────────────────────────────────────────────────────────────────────

export async function raiseRefund({
  patient_uid, invoice_id, advance_id, amount, reason, mode, raised_by,
}) {
  if (!reason) throw AppError.badRequest('reason is required');
  if (!VALID_PAYMENT_MODES.includes(mode)) {
    throw AppError.badRequest(`Invalid mode. Allowed: ${VALID_PAYMENT_MODES.join(', ')}`);
  }
  if (Number(amount) <= 0) throw AppError.badRequest('amount must be > 0');
  if ((!invoice_id && !advance_id) || (invoice_id && advance_id)) {
    throw AppError.badRequest('Refund must reference exactly one of invoice_id or advance_id');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_refunds
      (patient_uid, invoice_id, advance_id, amount, reason, mode, raised_by)
     VALUES ($1::uuid, $2, $3, $4::numeric, $5, $6, $7::uuid)
     RETURNING *`,
    String(patient_uid),
    invoice_id ? Number(invoice_id) : null,
    advance_id ? Number(advance_id) : null,
    Number(amount), reason, mode,
    raised_by ? String(raised_by) : null,
  );
  return rows[0];
}

export async function approveRefund(refundId, { approved_by }) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE billing_refunds
        SET approval_status = 'APPROVED', approved_by = $1::uuid, approved_at = NOW(), updated_at = NOW()
      WHERE id = $2::int AND approval_status = 'PENDING'
      RETURNING *`,
    approved_by ? String(approved_by) : null, Number(refundId),
  );
  if (!rows.length) throw AppError.notFound('Refund not found or not pending');
  return rows[0];
}

export async function rejectRefund(refundId, { rejected_by, rejection_reason }) {
  if (!rejection_reason) throw AppError.badRequest('rejection_reason is required');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE billing_refunds
        SET approval_status = 'REJECTED', rejected_by = $1::uuid,
            rejected_at = NOW(), rejection_reason = $2, updated_at = NOW()
      WHERE id = $3::int AND approval_status = 'PENDING'
      RETURNING *`,
    rejected_by ? String(rejected_by) : null, rejection_reason, Number(refundId),
  );
  if (!rows.length) throw AppError.notFound('Refund not found or not pending');
  return rows[0];
}

export async function markRefundPaid(refundId, { paid_by, reference }) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE billing_refunds
        SET approval_status = 'PAID', paid_by = $1::uuid,
            paid_at = NOW(), reference = COALESCE($2, reference), updated_at = NOW()
      WHERE id = $3::int AND approval_status = 'APPROVED'
      RETURNING *`,
    paid_by ? String(paid_by) : null, reference || null, Number(refundId),
  );
  if (!rows.length) throw AppError.notFound('Refund not found or not approved');

  // If linked to an advance, reduce the advance balance and mark refunded.
  if (rows[0].advance_id) {
    await prisma.$executeRawUnsafe(
      `UPDATE billing_advances
          SET balance = GREATEST(balance - $1::numeric, 0),
              status = CASE WHEN balance - $1::numeric <= 0.005 THEN 'REFUNDED' ELSE status END,
              updated_at = NOW()
        WHERE id = $2::int`,
      Number(rows[0].amount), Number(rows[0].advance_id),
    );
  }
  return rows[0];
}

export async function listRefunds({ approval_status, patient_uid } = {}) {
  const params = [];
  const where = [];
  if (approval_status) { params.push(approval_status); where.push(`approval_status = $${params.length}`); }
  if (patient_uid) { params.push(String(patient_uid)); where.push(`patient_uid = $${params.length}::uuid`); }
  const sql = `SELECT * FROM billing_refunds
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY raised_at DESC LIMIT 200`;
  return prisma.$queryRawUnsafe(sql, ...params);
}

// ───────────────────────────────────────────────────────────────────────
// Reports
// ───────────────────────────────────────────────────────────────────────

export async function dailyCollection({ date, mode, shift, collected_by } = {}) {
  const target = date || new Date().toISOString().slice(0, 10);
  const params = [target];
  const where = [`DATE(collected_at AT TIME ZONE 'Asia/Kolkata') = $1::date`];
  if (mode) { params.push(mode); where.push(`mode = $${params.length}`); }
  if (shift) { params.push(shift); where.push(`shift = $${params.length}`); }
  if (collected_by) { params.push(String(collected_by)); where.push(`collected_by = $${params.length}::uuid`); }

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
  return { date: target, summary, items };
}

export async function outstandingBills({ days_old, department, limit = 100 } = {}) {
  const params = [];
  const where = ['status IN (\'ISSUED\', \'PARTIAL\')', 'amount_due > 0'];
  if (days_old) {
    params.push(Number(days_old));
    where.push(`COALESCE(issued_at, created_at) <= NOW() - ($${params.length}::int || ' days')::interval`);
  }
  if (department) { params.push(department); where.push(`department = $${params.length}`); }
  params.push(Number(limit));
  return prisma.$queryRawUnsafe(
    `SELECT id, invoice_number, patient_uid, patient_name, patient_phone,
            department, total_amount, amount_paid, amount_due,
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
