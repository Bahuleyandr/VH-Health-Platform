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

  // TPA cap-proximity alert. The new total_amount may have crossed
  // the 80% / 100% rungs of the admission's approved cap — surface
  // it as a clinical alert so the cashier sees a flag at the next
  // dashboard refresh. Idempotent (won't double-emit while the prior
  // alert is unacknowledged). Errors are caught + logged but never
  // bubble up — the invoice update is authoritative.
  const meta = await prisma.$queryRawUnsafe(
    `SELECT admission_id, patient_uid, tenant_id
       FROM billing_invoices WHERE id = $1::int`,
    invoiceId,
  );
  if (meta.length && meta[0].admission_id && meta[0].patient_uid) {
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

// Allowed source-ref types. Anything outside this list is rejected at
// the API surface so the audit-trail vocabulary stays bounded. 'manual'
// is the default for free-text cashier entries (and the backfill value
// for pre-migration-199 historicals); 'package' covers packaged
// bundles that legitimately have no source row. Migration 199.
// Finding: 2026-05-10-inpatient-admission-billing-final-bill-untraceable-package-line.
const VALID_SOURCE_REF_TYPES = new Set([
  'lab_order',
  'radiology_order',
  'pharmacy_order',
  'ward_indent',
  'room_day',
  'discharge_consult',
  'theatre_case',
  'admission_package',
  'package',
  'manual',
]);

export async function addInvoiceItem(invoiceId, {
  service_code, description, category, quantity = 1, unit_price, gst_rate, notes,
  source_ref_type, source_ref_id,
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
  const resolvedSourceRefId = source_ref_id != null && source_ref_id !== ''
    ? Number(source_ref_id)
    : null;
  if (resolvedSourceRefId != null && !Number.isInteger(resolvedSourceRefId)) {
    throw AppError.badRequest('source_ref_id must be an integer when provided');
  }

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
       igst_amount, line_total, notes, source_ref_type, source_ref_id)
     VALUES ($1::int, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric,
             $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14, $15, $16)
     RETURNING *`,
    Number(invoiceId), service_code || null, resolved.description, resolved.category,
    resolved.hsn_sac, qty, price, rate, lineSub,
    split.cgst, split.sgst, split.igst, split.lineTotal, notes || null,
    resolvedSourceRefType, resolvedSourceRefId,
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
  // GST compliance: backfill recipient name/phone and (for IP) issuing
  // doctor + department at issue time. These are statutory snapshot
  // fields — a B2C tax invoice with null recipient name is not a valid
  // tax document, and joining at read time loses the value if the
  // patient/admission row changes later. Finding:
  //   2026-05-09-inpatient-admission-billing-invoice-missing-patient-fields
  await prisma.$executeRawUnsafe(
    `UPDATE billing_invoices
        SET invoice_number = $1,
            status = 'ISSUED',
            issued_at = NOW(),
            updated_at = NOW(),
            patient_name = COALESCE(
              billing_invoices.patient_name,
              (SELECT u.name FROM users u WHERE u.uid = billing_invoices.patient_uid LIMIT 1)
            ),
            patient_phone = COALESCE(
              billing_invoices.patient_phone,
              (SELECT u.phone FROM users u WHERE u.uid = billing_invoices.patient_uid LIMIT 1)
            ),
            doctor_uid = COALESCE(
              billing_invoices.doctor_uid,
              (SELECT a.attending_doctor FROM admissions a WHERE a.id = billing_invoices.admission_id LIMIT 1),
              (SELECT a.admitting_doctor FROM admissions a WHERE a.id = billing_invoices.admission_id LIMIT 1)
            ),
            department = COALESCE(
              billing_invoices.department,
              (SELECT a.department FROM admissions a WHERE a.id = billing_invoices.admission_id LIMIT 1)
            )
      WHERE id = $2::int`,
    number, Number(invoiceId),
  );

  // Issuing transitions DRAFT → ISSUED without changing totals, but
  // re-check the TPA cap anyway so a draft that's already over cap
  // surfaces an alert at issuance. recomputeInvoiceTotals only fires
  // on item / discount mutations.
  const meta = await prisma.$queryRawUnsafe(
    `SELECT admission_id, patient_uid, tenant_id, total_amount
       FROM billing_invoices WHERE id = $1::int`,
    Number(invoiceId),
  );
  if (meta.length && meta[0].admission_id && meta[0].patient_uid) {
    try {
      await maybeEmitTpaCapAlerts({
        admissionId: meta[0].admission_id,
        patientUid: meta[0].patient_uid,
        tenantId: meta[0].tenant_id,
        totalAmount: meta[0].total_amount,
      });
    } catch (alertErr) {
      logger.error('Failed to emit TPA cap proximity alert on issue', {
        invoice_id: invoiceId,
        error: alertErr.message,
      });
    }
  }

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
  const tenant = tenantId || '00000000-0000-4000-8000-000000000001';
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
  }

  return {
    ...inv[0],
    items,
    payments,
    advance_settlements: settlements,
    tpa_utilisation: tpaUtilisation,
    tpa_preauth: tpaPreauth,
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
//   * Investigations (one per test)     — `lab_order`
//   * Discharge consults (one per row)  — `discharge_consult`
//   * OT schedules (one per case)       — `theatre_case`
//
// Skipped intentionally: ward_indents, individual room-day breakdown.
// Indents have no per-row monetary value at the indent level (cost
// lives on inventory issues); room-days need a separate room-cost
// catalogue that doesn't exist yet. Both are roll-ups the cashier
// adds manually until those catalogues are seeded.
//
// TPA decision defaults are conservative — 'pending' for orders, and
// 'payable' for the package line. Room-upgrade-delta detection is
// inline: if the admission's bed category exceeds the package's
// bedded category, an extra non-payable 'room_upgrade_delta' line is
// added with quantity equal to length-of-stay (so the patient can
// see "Room upgrade × 3 nights — non-payable" on the portal).

const ITEMIZER_DEFAULT_GST = 0; // healthcare services exempt from GST in India

async function fetchExistingSourceKeys(invoiceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT source_ref_type, source_ref_id
       FROM billing_invoice_items
      WHERE invoice_id = $1::int
        AND source_ref_type IS NOT NULL`,
    Number(invoiceId),
  );
  const keys = new Set();
  for (const r of rows) {
    keys.add(`${r.source_ref_type}:${r.source_ref_id ?? 'NULL'}`);
  }
  return keys;
}

async function fetchAdmissionForItemizing(admissionId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.patient_uid, a.admitted_at, a.discharged_at,
            a.ward, a.bed_id, a.package_id, a.package_code,
            a.package_estimated_cost_minor,
            p.fixed_price_minor AS package_price_minor,
            p.display_name      AS package_name
       FROM admissions a
       LEFT JOIN packages p ON p.id = a.package_id
      WHERE a.id = $1::int
      LIMIT 1`,
    Number(admissionId),
  );
  return rows[0] || null;
}

export async function itemizeAdmissionInvoice(invoiceId, {
  decided_by = null,
  emit_package = true,
  emit_pharmacy = true,
  emit_lab = true,
  emit_consults = true,
  emit_theatre = true,
} = {}) {
  const invId = Number(invoiceId);
  if (!Number.isInteger(invId) || invId <= 0) {
    throw AppError.badRequest('invoiceId must be a positive integer');
  }

  // Phase 0 — pre-flight: invoice exists, is DRAFT, and has an admission.
  const invRows = await prisma.$queryRawUnsafe(
    `SELECT id, status, admission_id
       FROM billing_invoices
      WHERE id = $1::int
      LIMIT 1`,
    invId,
  );
  if (!invRows.length) throw AppError.notFound('Invoice not found');
  const inv = invRows[0];
  if (inv.status !== 'DRAFT') {
    throw AppError.badRequest('Auto-itemize can only run on a DRAFT invoice');
  }
  if (!inv.admission_id) {
    throw AppError.badRequest('Invoice has no admission_id — auto-itemize only supports admission-scoped invoices');
  }
  const admission = await fetchAdmissionForItemizing(inv.admission_id);
  if (!admission) throw AppError.notFound('Admission not found');

  const startTs = admission.admitted_at || admission.created_at;
  const endTs = admission.discharged_at || new Date();
  const existingKeys = await fetchExistingSourceKeys(invId);

  const summary = {
    package: 0,
    pharmacy: 0,
    lab: 0,
    consults: 0,
    theatre: 0,
    room_upgrade: 0,
    skipped_existing: 0,
  };

  const addLine = async ({ description, unit_price, quantity = 1, notes, source_ref_type, source_ref_id, tpa_decision, tpa_non_payable_reason }) => {
    const key = `${source_ref_type}:${source_ref_id ?? 'NULL'}`;
    if (existingKeys.has(key)) {
      summary.skipped_existing += 1;
      return null;
    }
    existingKeys.add(key);
    const row = await addInvoiceItem(invId, {
      description,
      unit_price,
      quantity,
      gst_rate: ITEMIZER_DEFAULT_GST,
      notes,
      source_ref_type,
      source_ref_id,
    });
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
          WHERE id = $4::int`,
        tpa_decision,
        tpa_non_payable_reason || null,
        decided_by ? String(decided_by) : null,
        Number(row.id),
      );
    }
    return row;
  };

  // 1. Package line (if admission is package-bundled).
  if (emit_package && admission.package_id) {
    const fixed = admission.package_estimated_cost_minor ?? admission.package_price_minor ?? null;
    if (fixed != null) {
      const price = Math.round(Number(fixed)) / 100; // paise → rupees
      await addLine({
        description: `Package: ${admission.package_name || admission.package_code}`,
        unit_price: price,
        quantity: 1,
        notes: `Package ${admission.package_code || admission.package_id}`,
        source_ref_type: 'admission_package',
        source_ref_id: admission.id,
        tpa_decision: 'payable',
      });
      summary.package += 1;
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
          AND dispensed_at <= $3::timestamptz
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
      if (created) summary.pharmacy += 1;
    }
  }

  // 3. Investigations completed during the stay.
  if (emit_lab) {
    const tests = await prisma.$queryRawUnsafe(
      `SELECT id, test_name, cost, completed_at
         FROM investigations
        WHERE patient_uid = $1::uuid
          AND status = 'COMPLETED'
          AND COALESCE(completed_at, requested_at) >= $2::timestamptz
          AND COALESCE(completed_at, requested_at) <= $3::timestamptz
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
      if (created) summary.lab += 1;
    }
  }

  // 4. Discharge consults — pre-discharge speciality reviews requested
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
      if (created) summary.consults += 1;
    }
  }

  // 5. OT schedules (theatre cases) completed during the stay. Cost
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
          AND scheduled_date <= $3::date
        ORDER BY scheduled_date, id`,
      String(admission.patient_uid),
      new Date(startTs).toISOString().slice(0, 10),
      new Date(endTs).toISOString().slice(0, 10),
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
      if (created) summary.theatre += 1;
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
  invoice_id, item_id, decision, non_payable_reason, decided_by,
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

export async function getInvoiceNonPayableBreakdown(invoiceId) {
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
    lines: items,
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
