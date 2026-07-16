// src/routes/billing/billingV2Routes.js
//
// Billing v2 — line-item invoices + GST + advance + refund + receipts.
// Mounted at /api/v1/billing/v2/*. The original /billing/* surface
// stays for backwards compat; new screens use this.
//
// Auth: JWT required. Roles allowed: ADMIN, SUPER_ADMIN, HR_STAFF (for
// reads), and "billing" generally requires admin/staff write power.
// Refund approval requires ADMIN.

import { Router } from 'express';
import * as billing from '../../services/billing/billingV2Service.js';
import * as cashDrawer from '../../services/billing/cashDrawerService.js';
import * as payLinks from '../../services/billing/paymentLinkService.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = Router();
const BILLING_V2_EXTRA_STAFF_ROLES = [
  'SUPER_ADMIN',
  'FINANCE_INCHARGE',
  'BILLING_INCHARGE',
  'ADMISSION_OFFICER',
  'INSURANCE_COORDINATOR',
  'IPD_COUNSELLOR',
  'RECEPTIONIST',
  'RECEPTION_INCHARGE',
];
const CASH_DRAWER_REVIEWER_ROLES = ['ADMIN', 'SUPER_ADMIN', 'FINANCE_INCHARGE'];
// Segregation of duties (audit §3 "cash-out paths reachable by non-finance
// staff"): the actual money-OUT steps — paying a refund, settling an advance
// against an invoice — are restricted to finance/cashier roles + admin. The
// broader BILLING_V2_EXTRA_STAFF_ROLES (receptionists, admission officers, etc.)
// may raise/approve but not perform the payout/settle disbursement.
const BILLING_CASH_OUT_ROLES = [
  'ADMIN', 'SUPER_ADMIN',
  'FINANCE_INCHARGE', 'BILLING_INCHARGE', 'BILLING_STAFF', 'CASHIER',
];

// Wrap each handler with try/catch + AppError → response so route
// definitions stay terse.
function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Billing error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  const role = String(req.user?.role || '').trim().toUpperCase();
  if (!isStaff(role) && !isAdmin(role) && !BILLING_V2_EXTRA_STAFF_ROLES.includes(role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) return error(res, 'Admin role required', 403);
  next();
}

function requireCashDrawerReviewer(req, res, next) {
  const role = String(req.user?.role || '').trim().toUpperCase();
  if (!CASH_DRAWER_REVIEWER_ROLES.includes(role)) {
    return error(res, 'Cash-drawer review requires FINANCE_INCHARGE or admin', 403);
  }
  next();
}

// Restrict money-OUT (refund payout, advance settlement) to finance/cashier
// roles — segregation of duties from generic billing-staff write access.
function requireCashOut(req, res, next) {
  const role = String(req.user?.role || '').trim().toUpperCase();
  if (!BILLING_CASH_OUT_ROLES.includes(role)) {
    return error(res, 'Refund payout / advance settlement requires a finance, cashier, or admin role', 403);
  }
  next();
}

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function pickBillingContext(row = {}) {
  return {
    ...(row.invoice_id != null ? { invoice_id: Number(row.invoice_id) } : {}),
    ...(row.item_id != null ? { item_id: Number(row.item_id) } : {}),
    ...(row.advance_id != null ? { advance_id: Number(row.advance_id) } : {}),
    ...(row.settlement_id != null ? { settlement_id: Number(row.settlement_id) } : {}),
    ...(row.refund_id != null ? { refund_id: Number(row.refund_id) } : {}),
    ...(row.payment_id != null ? { payment_id: Number(row.payment_id) } : {}),
    ...(row.payment_link_id != null ? { payment_link_id: Number(row.payment_link_id) } : {}),
    ...(row.cash_drawer_session_id != null ? { cash_drawer_session_id: Number(row.cash_drawer_session_id) } : {}),
    ...(row.patient_uid ? { patient_uid: String(row.patient_uid) } : {}),
    ...(row.admission_id != null ? { admission_id: Number(row.admission_id) } : {}),
    ...(row.invoice_number ? { invoice_number: String(row.invoice_number) } : {}),
    ...(row.invoice_type ? { invoice_type: String(row.invoice_type) } : {}),
    ...(row.shift ? { shift: String(row.shift) } : {}),
    ...(row.approval_status ? { approval_status: String(row.approval_status) } : {}),
    ...(row.status ? { status: String(row.status) } : {}),
  };
}

async function logBillingAudit(req, action, row = {}, metadata = {}, options = {}) {
  await logAudit(req, action, {
    ...pickBillingContext(row),
    ...metadata,
    source: 'billing_v2',
  }, {
    resource: options.resource || 'billing_invoice',
    resourceId: options.resourceId ?? row.invoice_id ?? row.id ?? null,
  });
}

// ── Service master ────────────────────────────────────────────────────
router.get('/services', wrap(async (req) => billing.listServiceMaster({
  category: req.query.category,
  search: req.query.q,
  includeInactive: req.query.includeInactive === 'true',
})));

router.post('/services', requireAdmin, wrap(async (req) => billing.createServiceMaster(req.body)));
router.patch('/services/:id', requireAdmin, wrap(async (req) =>
  billing.updateServiceMaster(req.params.id, req.body),
));

// ── Invoices ──────────────────────────────────────────────────────────
router.post('/invoices', requireStaffOrAdmin, wrap(async (req) => {
  const invoice = await billing.createDraftInvoice({
    ...req.body,
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_INVOICE_CREATED', {
    ...invoice,
    invoice_id: invoice?.id,
  }, {
    requested_invoice_type: req.body?.invoice_type ?? null,
    department: req.body?.department ?? invoice.department ?? null,
  });
  return invoice;
}));

router.get('/invoices', requireStaffOrAdmin, wrap(async (req) => billing.listInvoices({
  tenantId: tenantOf(req),
  patient_uid: req.query.patient_uid,
  patient_id: req.query.patient_id,
  admission_id: req.query.admission_id,
  status: req.query.status,
  invoice_type: req.query.invoice_type,
  date_from: req.query.date_from,
  date_to: req.query.date_to,
  page: req.query.page || 1,
  limit: req.query.limit || 20,
})));

router.get('/invoices/:id', requireStaffOrAdmin, wrap(async (req) =>
  billing.getInvoice(req.params.id, { tenantId: tenantOf(req) }),
));

router.post('/invoices/:id/items', requireStaffOrAdmin, wrap(async (req) => {
  const item = await billing.addInvoiceItem(req.params.id, {
    ...req.body,
    tenantId: tenantOf(req),
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_ITEM_ADDED', {
    ...item,
    invoice_id: item?.invoice_id ?? req.params.id,
    item_id: item?.id,
  }, {
    category: item?.category ?? req.body?.category ?? null,
    service_code: item?.service_code ?? req.body?.service_code ?? null,
    source_ref_type: item?.source_ref_type ?? req.body?.source_ref_type ?? null,
    source_ref_id: item?.source_ref_id ?? req.body?.source_ref_id ?? null,
    line_total: item?.line_total ?? null,
  }, {
    resource: 'billing_invoice_item',
    resourceId: item?.id ?? null,
  });
  return item;
}));

router.delete('/invoices/:id/items/:itemId', requireStaffOrAdmin, wrap(async (req) => {
  const totals = await billing.removeInvoiceItem(req.params.id, req.params.itemId, {
    tenantId: tenantOf(req),
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_ITEM_REMOVED', {
    invoice_id: Number(req.params.id),
    item_id: Number(req.params.itemId),
  }, {
    totals,
  }, {
    resource: 'billing_invoice_item',
    resourceId: req.params.itemId,
  });
  return totals;
}));

// ── Wave-5 batch-3 — auto-itemize admission invoice ──────────────────
// Walks the admission's completed events (package, pharmacy orders,
// ward indents, lab, consults, theatre) and emits one billing_invoice_items row per
// source record. Idempotent — safe to call repeatedly during the
// stay. Closes the Wave-2.1 deferral. Findings:
//   2026-05-10-surgical-day-care-billing-package-not-itemised-iol-delta-opaque
//   2026-05-09-tpa-insurance-claim-discharge-nonpayable-not-disclosed-proactively
router.post('/invoices/:id/itemize', requireStaffOrAdmin, wrap(async (req) => {
  const result = await billing.itemizeAdmissionInvoice(req.params.id, {
    tenantId: tenantOf(req),
    decided_by: req.user?.uid,
    emit_package: req.body?.emit_package !== false,
    emit_pharmacy: req.body?.emit_pharmacy !== false,
    emit_ward_indents: req.body?.emit_ward_indents !== false,
    emit_lab: req.body?.emit_lab !== false,
    emit_consults: req.body?.emit_consults !== false,
    emit_theatre: req.body?.emit_theatre !== false,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_INVOICE_ITEMIZED', result, {
    emit_package: req.body?.emit_package !== false,
    emit_pharmacy: req.body?.emit_pharmacy !== false,
    emit_ward_indents: req.body?.emit_ward_indents !== false,
    emit_lab: req.body?.emit_lab !== false,
    emit_consults: req.body?.emit_consults !== false,
    emit_theatre: req.body?.emit_theatre !== false,
  });
  return result;
}));

// TPA-desk decision recording — per-line payable/non-payable verdict
// that the patient portal subscribes to.
router.post('/invoices/:id/items/:itemId/tpa-decision', requireStaffOrAdmin, wrap(async (req) => {
  const item = await billing.recordInvoiceItemTpaDecision({
    tenantId: tenantOf(req),
    invoice_id: req.params.id,
    item_id: req.params.itemId,
    decision: req.body?.decision,
    non_payable_reason: req.body?.non_payable_reason,
    decided_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_TPA_DECISION_RECORDED', {
    ...item,
    item_id: item?.id ?? req.params.itemId,
    invoice_id: item?.invoice_id ?? req.params.id,
  }, {
    decision: item?.tpa_decision ?? req.body?.decision ?? null,
    non_payable_reason: item?.tpa_non_payable_reason ?? req.body?.non_payable_reason ?? null,
  }, {
    resource: 'billing_invoice_item',
    resourceId: item?.id ?? req.params.itemId,
  });
  return item;
}));

// Patient-portal-facing read: running total of non-payable items on
// this invoice with the reason breakdown.
router.get('/invoices/:id/non-payable', requireStaffOrAdmin, wrap(async (req) =>
  billing.getInvoiceNonPayableBreakdown(req.params.id, { tenantId: tenantOf(req) }),
));

router.post('/invoices/:id/discount', requireStaffOrAdmin, wrap(async (req) => {
  const totals = await billing.applyDiscount(req.params.id, {
    ...req.body,
    tenantId: tenantOf(req),
    approved_by: req.user?.uid,
    approved_by_role: req.user?.role,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_DISCOUNT_APPLIED', {
    invoice_id: Number(req.params.id),
  }, {
    amount: req.body?.amount ?? null,
    reason_present: Boolean(req.body?.reason),
    totals,
  });
  return totals;
}));

router.post('/invoices/:id/issue', requireStaffOrAdmin, wrap(async (req) => {
  const invoice = await billing.issueInvoice(req.params.id, { tenantId: tenantOf(req) });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_INVOICE_ISSUED', {
    ...invoice,
    invoice_id: Number(req.params.id),
  });
  return invoice;
}));

router.post('/invoices/:id/void', requireAdmin, wrap(async (req) => {
  const invoice = await billing.voidInvoice(req.params.id, {
    ...req.body,
    tenantId: tenantOf(req),
    voided_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_INVOICE_VOIDED', {
    ...invoice,
    invoice_id: invoice?.id ?? req.params.id,
  }, {
    reason_present: Boolean(req.body?.reason),
  });
  return invoice;
}));

// Wave-4B-1 — cashier-side PDF reprints. Both endpoints stream a binary
// PDF rather than going through `wrap`/`success` which assume a JSON
// envelope. The tax invoice is the GST-breakup billing document; the
// receipt is a payment-confirmation summary. See finding:
//   2026-05-10-surgical-day-care-billing-no-receipt-tax-invoice-reprint
router.get('/invoices/:id/tax-invoice-pdf', requireStaffOrAdmin, async (req, res) => {
  try {
    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
      return error(res, 'invoice id must be a positive integer', 400);
    }
    const { generateInvoicePDF } = await import('../../services/documents/clinicalPdfGenerator.js');
    const buffer = await generateInvoicePDF(invoiceId);
    const filename = `TaxInvoice_${invoiceId}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    return relayAppError(res, err, 'billingV2 tax-invoice PDF error');
  }
});

router.get('/invoices/:id/receipt-pdf', requireStaffOrAdmin, async (req, res) => {
  try {
    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
      return error(res, 'invoice id must be a positive integer', 400);
    }
    const { generateReceiptPDF } = await import('../../services/documents/clinicalPdfGenerator.js');
    const buffer = await generateReceiptPDF(invoiceId);
    const filename = `Receipt_${invoiceId}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    return relayAppError(res, err, 'billingV2 receipt PDF error');
  }
});

// ── Payments ──────────────────────────────────────────────────────────
router.post('/payments', requireStaffOrAdmin, requireIdempotencyKey({ required: true, scope: 'billing_payment' }), wrap(async (req) => {
  const payment = await billing.collectPayment({
    ...req.body,
    tenantId: tenantOf(req),
    collected_by: req.user?.uid,
  });
  await logBillingAudit(
    req,
    'FRONT_OFFICE_BILLING_PAYMENT_COLLECTED',
    {
      ...payment,
      payment_id: payment?.id,
      invoice_id: payment?.invoice_id ?? req.body?.invoice_id,
      patient_uid: payment?.patient_uid ?? req.body?.patient_uid,
    },
    {
      amount: payment?.amount ?? req.body?.amount ?? null,
      mode: payment?.mode ?? req.body?.mode ?? null,
      shift: payment?.shift ?? req.body?.shift ?? null,
      reference_present: Boolean(payment?.reference ?? req.body?.reference),
    },
    {
      resource: 'billing_payment',
      resourceId: payment?.id ?? null,
    },
  );
  return payment;
}));

router.post('/payments/:id/reverse', requireAdmin, wrap(async (req) => {
  const payment = await billing.reversePayment(req.params.id, {
    ...req.body,
    tenantId: tenantOf(req),
    reversed_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_PAYMENT_REVERSED', {
    ...payment,
    payment_id: payment?.id ?? req.params.id,
  }, {
    reason_present: Boolean(req.body?.reason),
  }, {
    resource: 'billing_payment',
    resourceId: payment?.id ?? req.params.id,
  });
  return payment;
}));

// ── Advances ──────────────────────────────────────────────────────────
router.post('/advances', requireStaffOrAdmin, requireIdempotencyKey({ required: true, scope: 'billing_advance' }), wrap(async (req) => {
  const advance = await billing.collectAdvance({
    ...req.body,
    tenantId: tenantOf(req),
    collected_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_ADVANCE_COLLECTED', {
    ...advance,
    advance_id: advance?.id,
  }, {
    amount: advance?.amount ?? req.body?.amount ?? null,
    mode: advance?.mode ?? req.body?.mode ?? null,
    reference_present: Boolean(advance?.reference ?? req.body?.reference),
  }, {
    resource: 'billing_advance',
    resourceId: advance?.id ?? null,
  });
  return advance;
}));

router.get('/advances', requireStaffOrAdmin, wrap(async (req) => billing.listAdvances({
  tenantId: tenantOf(req),
  patient_uid: req.query.patient_uid,
  admission_id: req.query.admission_id,
  status: req.query.status,
})));

router.post('/advances/:id/settle', requireCashOut, requireIdempotencyKey({ required: true, scope: 'billing_advance_settle' }), wrap(async (req) => {
  const settlement = await billing.settleAdvance({
    tenantId: tenantOf(req),
    advance_id: req.params.id,
    invoice_id: req.body.invoice_id,
    amount: req.body.amount,
    settled_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_ADVANCE_SETTLED', {
    ...settlement,
    settlement_id: settlement?.id,
    advance_id: settlement?.advance_id ?? req.params.id,
    invoice_id: settlement?.invoice_id ?? req.body?.invoice_id,
  }, {
    amount: settlement?.amount ?? req.body?.amount ?? null,
  }, {
    resource: 'billing_advance_settlement',
    resourceId: settlement?.id ?? null,
  });
  return settlement;
}));

// ── Refunds ───────────────────────────────────────────────────────────
router.post('/refunds', requireStaffOrAdmin, wrap(async (req) => {
  const refund = await billing.raiseRefund({
    ...req.body,
    tenantId: tenantOf(req),
    raised_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_REFUND_RAISED', {
    ...refund,
    refund_id: refund?.id,
  }, {
    amount: refund?.amount ?? req.body?.amount ?? null,
    mode: refund?.mode ?? req.body?.mode ?? null,
    reason_present: Boolean(refund?.reason ?? req.body?.reason),
  }, {
    resource: 'billing_refund',
    resourceId: refund?.id ?? null,
  });
  return refund;
}));

router.get('/refunds', requireStaffOrAdmin, wrap(async (req) => billing.listRefunds({
  tenantId: tenantOf(req),
  approval_status: req.query.approval_status,
  patient_uid: req.query.patient_uid,
})));

router.post('/refunds/:id/approve', requireAdmin, wrap(async (req) => {
  const refund = await billing.approveRefund(req.params.id, {
    tenantId: tenantOf(req),
    approved_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_REFUND_APPROVED', {
    ...refund,
    refund_id: refund?.id ?? req.params.id,
  }, {}, {
    resource: 'billing_refund',
    resourceId: refund?.id ?? req.params.id,
  });
  return refund;
}));

router.post('/refunds/:id/reject', requireAdmin, wrap(async (req) => {
  const refund = await billing.rejectRefund(req.params.id, {
    ...req.body,
    tenantId: tenantOf(req),
    rejected_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_REFUND_REJECTED', {
    ...refund,
    refund_id: refund?.id ?? req.params.id,
  }, {
    rejection_reason_present: Boolean(req.body?.rejection_reason),
  }, {
    resource: 'billing_refund',
    resourceId: refund?.id ?? req.params.id,
  });
  return refund;
}));

router.post('/refunds/:id/pay', requireCashOut, requireIdempotencyKey({ required: true, scope: 'billing_refund_pay' }), wrap(async (req) => {
  const refund = await billing.markRefundPaid(req.params.id, {
    ...req.body,
    tenantId: tenantOf(req),
    paid_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_BILLING_REFUND_PAID', {
    ...refund,
    refund_id: refund?.id ?? req.params.id,
  }, {
    reference_present: Boolean(refund?.reference ?? req.body?.reference),
  }, {
    resource: 'billing_refund',
    resourceId: refund?.id ?? req.params.id,
  });
  return refund;
}));

// ── Reports ───────────────────────────────────────────────────────────
router.get('/reports/daily-collection', requireStaffOrAdmin, wrap(async (req) =>
  billing.dailyCollection({
    date: req.query.date,
    mode: req.query.mode,
    shift: req.query.shift,
    collected_by: req.query.collected_by,
  }),
));

router.get('/reports/outstanding', requireStaffOrAdmin, wrap(async (req) =>
  billing.outstandingBills({
    days_old: req.query.days_old,
    department: req.query.department,
    limit: req.query.limit || 100,
  }),
));

// ── Cash-drawer sessions (cashier shift-close + reconciliation) ───────
// Closes findings:
//   2026-05-09-inpatient-admission-billing-no-cashier-shift-reconciliation
//   2026-05-10-inpatient-admission-billing-cash-drawer-reconciliation-missing

router.post('/cash-drawer/sessions/open', requireStaffOrAdmin, wrap(async (req) => {
  const session = await cashDrawer.openSession({
    tenantId: tenantOf(req),
    cashier_uid: req.body.cashier_uid || req.user?.uid,
    shift: req.body.shift,
    opening_float: req.body.opening_float,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_CASH_DRAWER_OPENED', {
    cash_drawer_session_id: session?.id,
    shift: session?.shift ?? req.body?.shift ?? null,
    status: session?.status ?? null,
  }, {
    cashier_uid: session?.cashier_uid ?? req.body?.cashier_uid ?? req.user?.uid ?? null,
    opening_float: session?.opening_float ?? req.body?.opening_float ?? null,
  }, {
    resource: 'cash_drawer_session',
    resourceId: session?.id ?? null,
  });
  return session;
}));

router.post('/cash-drawer/sessions/:id/close', requireStaffOrAdmin, wrap(async (req) => {
  const session = await cashDrawer.closeSession({
    tenantId: tenantOf(req),
    id: req.params.id,
    cashier_uid: req.user?.uid,
    counted_denominations: req.body.counted_denominations,
    variance_reason: req.body.variance_reason,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_CASH_DRAWER_CLOSED', {
    cash_drawer_session_id: session?.id ?? req.params.id,
    shift: session?.shift ?? null,
    status: session?.status ?? null,
  }, {
    system_total: session?.system_total ?? null,
    counted_total: session?.counted_total ?? null,
    variance: session?.variance ?? null,
    requires_review: session?.requires_review ?? null,
    variance_reason_present: Boolean(req.body?.variance_reason),
  }, {
    resource: 'cash_drawer_session',
    resourceId: session?.id ?? req.params.id,
  });
  return session;
}));

router.post('/cash-drawer/sessions/:id/review', requireCashDrawerReviewer, wrap(async (req) => {
  const session = await cashDrawer.reviewSession({
    tenantId: tenantOf(req),
    id: req.params.id,
    reviewer_uid: req.user?.uid,
    review_notes: req.body.review_notes,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_CASH_DRAWER_REVIEWED', {
    cash_drawer_session_id: session?.id ?? req.params.id,
    shift: session?.shift ?? null,
    status: session?.status ?? null,
  }, {
    variance: session?.variance ?? null,
    review_notes_present: Boolean(req.body?.review_notes),
  }, {
    resource: 'cash_drawer_session',
    resourceId: session?.id ?? req.params.id,
  });
  return session;
}));

router.get('/cash-drawer/sessions', requireStaffOrAdmin, wrap(async (req) =>
  cashDrawer.listSessions({
    tenantId: tenantOf(req),
    cashier_uid: req.query.cashier_uid,
    shift: req.query.shift,
    status: req.query.status,
    requires_review: req.query.requires_review,
    limit: req.query.limit,
  }),
));

router.get('/cash-drawer/sessions/:id', requireStaffOrAdmin, wrap(async (req) =>
  cashDrawer.getSession({
    tenantId: tenantOf(req),
    id: req.params.id,
  }),
));

// ── Payment links (UPI / gateway) ─────────────────────────────────────
// Sprint 4. Cashier creates a link, fans it out via WhatsApp/email,
// then either marks paid manually (UPI) or the gateway webhook flips
// status (when wired). Existing collectPayment is reused so invoice
// totals and daily-collection rollups stay consistent.

router.post('/payment-links', requireStaffOrAdmin, wrap(async (req) => {
  const link = await payLinks.createPaymentLink({
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    invoice_id: req.body.invoice_id,
    patient_uid: req.body.patient_uid,
    amount: req.body.amount,
    currency: req.body.currency,
    provider: req.body.provider,
    expires_in_hours: req.body.expires_in_hours,
    notes: req.body.notes,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_PAYMENT_LINK_CREATED', {
    payment_link_id: link?.id,
    invoice_id: link?.invoice_id ?? req.body?.invoice_id ?? null,
    patient_uid: link?.patient_uid ?? req.body?.patient_uid ?? null,
    status: link?.status ?? null,
  }, {
    amount: link?.amount ?? req.body?.amount ?? null,
    provider: link?.provider ?? req.body?.provider ?? null,
  }, {
    resource: 'billing_payment_link',
    resourceId: link?.id ?? null,
  });
  return link;
}));

router.post('/payment-links/teleconsult-post-consult', requireStaffOrAdmin, wrap(async (req) => {
  const result = await payLinks.createTeleconsultPostConsultPaymentLink({
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    teleconsultation_id: req.body.teleconsultation_id,
    invoice_id: req.body.invoice_id,
    channels: req.body.channels,
    patient_phone: req.body.patient_phone,
    patient_email: req.body.patient_email,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_TELECONSULT_PAYMENT_LINK_HOOK', {
    payment_link_id: result?.payment_link_id ?? result?.link?.id ?? null,
    invoice_id: result?.invoice_id ?? req.body?.invoice_id ?? null,
    patient_uid: result?.patient_uid ?? null,
    status: result?.status ?? null,
  }, {
    teleconsultation_id: result?.teleconsultation_id ?? req.body?.teleconsultation_id ?? null,
    appointment_id: result?.appointment_id ?? null,
    configured: result?.configured === true,
    skipped_reason: result?.reason ?? null,
    reused: result?.reused === true,
    channels: result?.channels ?? [],
    patient_phone_present: Boolean(req.body?.patient_phone),
    patient_email_present: Boolean(req.body?.patient_email),
  }, {
    resource: result?.payment_link_id ? 'billing_payment_link' : 'teleconsultation',
    resourceId: result?.payment_link_id ?? result?.teleconsultation_id ?? req.body?.teleconsultation_id ?? null,
  });
  return result;
}));

router.get('/payment-links', requireStaffOrAdmin, wrap(async (req) =>
  payLinks.listPaymentLinks({
    tenantId: tenantOf(req),
    patient_uid: req.query.patient_uid,
    status: req.query.status,
    invoice_id: req.query.invoice_id,
    limit: req.query.limit || 100,
  }),
));

router.get('/payment-links/:token', requireStaffOrAdmin, wrap(async (req) =>
  payLinks.getPaymentLink({
    tenantId: tenantOf(req),
    link_token: req.params.token,
  }),
));

router.post('/payment-links/:token/send', requireStaffOrAdmin, wrap(async (req) => {
  const link = await payLinks.sendPaymentLink({
    tenantId: tenantOf(req),
    link_token: req.params.token,
    channels: req.body.channels,
    patient_phone: req.body.patient_phone,
    patient_email: req.body.patient_email,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_PAYMENT_LINK_SENT', {
    payment_link_id: link?.id,
    invoice_id: link?.invoice_id ?? null,
    patient_uid: link?.patient_uid ?? null,
    status: link?.status ?? null,
  }, {
    channels: Array.isArray(req.body?.channels) ? req.body.channels : ['whatsapp'],
    patient_phone_present: Boolean(req.body?.patient_phone),
    patient_email_present: Boolean(req.body?.patient_email),
  }, {
    resource: 'billing_payment_link',
    resourceId: link?.id ?? null,
  });
  return link;
}));

router.post('/payment-links/:token/mark-paid', requireStaffOrAdmin, requireIdempotencyKey({ required: true, scope: 'billing_payment_link_mark_paid' }), wrap(async (req) => {
  const result = await payLinks.markPaymentLinkPaid({
    tenantId: tenantOf(req),
    link_token: req.params.token,
    paid_via: req.body.paid_via,
    paid_reference: req.body.paid_reference,
    performed_by: req.user?.uid,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_PAYMENT_LINK_MARKED_PAID', {
    payment_link_id: result?.link?.id,
    invoice_id: result?.link?.invoice_id ?? result?.payment?.invoice_id ?? null,
    patient_uid: result?.link?.patient_uid ?? result?.payment?.patient_uid ?? null,
    payment_id: result?.payment?.id ?? null,
    status: result?.link?.status ?? null,
  }, {
    paid_via: result?.link?.paid_via ?? req.body?.paid_via ?? null,
    paid_reference_present: Boolean(result?.link?.paid_reference ?? req.body?.paid_reference),
  }, {
    resource: 'billing_payment_link',
    resourceId: result?.link?.id ?? null,
  });
  return result;
}));

router.post('/payment-links/:token/cancel', requireStaffOrAdmin, wrap(async (req) => {
  const link = await payLinks.cancelPaymentLink({
    tenantId: tenantOf(req),
    link_token: req.params.token,
    reason: req.body.reason,
  });
  await logBillingAudit(req, 'FRONT_OFFICE_PAYMENT_LINK_CANCELLED', {
    payment_link_id: link?.id,
    invoice_id: link?.invoice_id ?? null,
    patient_uid: link?.patient_uid ?? null,
    status: link?.status ?? null,
  }, {
    reason_present: Boolean(req.body?.reason),
  }, {
    resource: 'billing_payment_link',
    resourceId: link?.id ?? null,
  });
  return link;
}));

router.post('/payment-links/run-expire-stale', requireAdmin, wrap(async () =>
  payLinks.expireStaleLinks(),
));

export default router;
