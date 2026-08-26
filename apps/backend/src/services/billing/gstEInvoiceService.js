// src/services/billing/gstEInvoiceService.js — G2 (reaudit 2026-08-25)
//
// GST e-invoicing (IRN / IRP) behind a swappable GSP adapter. The billing
// engine already computes cgst/sgst/igst per invoice (billingV2Service); this
// service turns an issued invoice into a GST e-invoice JSON payload, obtains an
// IRN from a GSP adapter, and stores the IRN/ack/status in
// gst_einvoice_documents (migration 738).
//
// Adapter model: the DEFAULT provider is a self-contained SANDBOX/MOCK that
// mints a deterministic IRN from the canonical payload — no external
// credentials, so unit tests and the dark default exercise the full spine. The
// 'nic'/'gsp' providers are the live seams: they require owner-side credentials
// and are intentionally NOT implemented here (they throw a clear
// GST_EINVOICE_PROVIDER_NOT_CONFIGURED so the wiring is obvious).
//
// Dark-gate: env GST_EINVOICE_ENABLED AND per-tenant
// settings.gstEInvoice.enabled, ANDed, fail-closed, default OFF. env off → 503
// GST_EINVOICE_NOT_ENABLED; tenant off → 403 GST_EINVOICE_DISABLED.

import crypto from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

function tenantOr(t) { return requireTenantId(t); }
function unwrap(rows) { return Array.isArray(rows) ? rows[0] : rows; }

/* ─── Dark-ship gate ─────────────────────────────────────────────────────── */

export function isGstEInvoiceEnvEnabled() {
  return process.env.GST_EINVOICE_ENABLED === 'true';
}

async function getGstEInvoiceSettingsLazy(tenantId) {
  const mod = await import('../tenant/tenantSettingsService.js');
  return mod.getGstEInvoiceSettings(tenantId);
}

export async function requireGstEInvoiceEnabled(tenantId) {
  if (!isGstEInvoiceEnvEnabled()) {
    throw new AppError('GST e-invoicing is not enabled', 503, 'GST_EINVOICE_NOT_ENABLED');
  }
  const settings = await getGstEInvoiceSettingsLazy(tenantId);
  if (!settings.enabled) {
    throw AppError.forbidden('GST e-invoicing is not enabled for this tenant', 'GST_EINVOICE_DISABLED');
  }
  return settings;
}

/* ─── GSP adapters (swappable) ───────────────────────────────────────────── */

// A GSP adapter takes the canonical e-invoice payload and returns
// { irn, ack_no, ack_date, signed_invoice, signed_qr_code, response }.
// The mock/sandbox adapter is deterministic and credential-free.
function mockGspAdapter(payload, { provider }) {
  const canonical = JSON.stringify(payload);
  const irn = crypto.createHash('sha256').update(canonical).digest('hex'); // 64 hex chars, IRP IRN shape
  const ackNo = String(BigInt(`0x${irn.slice(0, 12)}`)).slice(0, 12).padStart(12, '0');
  const qrSource = `${irn}.${payload.DocDtls?.No || ''}.${payload.ValDtls?.TotInvVal || 0}`;
  const signedQr = Buffer.from(qrSource).toString('base64');
  return {
    irn,
    ack_no: ackNo,
    ack_date: new Date(),
    signed_invoice: Buffer.from(canonical).toString('base64'),
    signed_qr_code: signedQr,
    response: {
      provider,
      Status: 'ACT',
      Irn: irn,
      AckNo: ackNo,
      note: 'self_contained_sandbox_mock — not a real IRP acknowledgement',
    },
  };
}

// Live seams — require owner-side credentials, intentionally unimplemented.
function liveGspAdapterSeam(_payload, { provider }) {
  throw new AppError(
    `GST e-invoice provider '${provider}' requires owner-side GSP credentials that are not configured`,
    501,
    'GST_EINVOICE_PROVIDER_NOT_CONFIGURED',
  );
}

const GSP_ADAPTERS = {
  mock: mockGspAdapter,
  sandbox: mockGspAdapter,
  nic: liveGspAdapterSeam,
  gsp: liveGspAdapterSeam,
};

export function resolveGspAdapter(provider) {
  const key = String(provider || 'mock').trim();
  const adapter = GSP_ADAPTERS[key];
  if (!adapter) throw AppError.badRequest(`Unsupported GST e-invoice provider: ${provider}`);
  return { key, adapter };
}

/* ─── Payload builder ────────────────────────────────────────────────────── */

function n2(value) { return Math.round(Number(value || 0) * 100) / 100; }

// GST state code (2-digit) lookup — a compact subset sufficient for the
// TranDtls POS / SellerDtls Stcd fields. Unknown states fall back to '99'
// (other territory) so the payload is always well-formed for the mock adapter.
const STATE_CODES = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03', 'chandigarh': '04',
  'uttarakhand': '05', 'haryana': '06', 'delhi': '07', 'rajasthan': '08', 'uttar pradesh': '09',
  'bihar': '10', 'sikkim': '11', 'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14',
  'mizoram': '15', 'tripura': '16', 'meghalaya': '17', 'assam': '18', 'west bengal': '19',
  'jharkhand': '20', 'odisha': '21', 'chhattisgarh': '22', 'madhya pradesh': '23', 'gujarat': '24',
  'maharashtra': '27', 'karnataka': '29', 'goa': '30', 'kerala': '32', 'tamil nadu': '33',
  'puducherry': '34', 'andhra pradesh': '37', 'telangana': '36', 'ladakh': '38',
};

export function stateCode(name) {
  return STATE_CODES[String(name || '').trim().toLowerCase()] || '99';
}

// Build the canonical GST e-invoice (INV schema, NIC v1.1 subset). A faithful
// but deliberately scoped subset — Version/TranDtls/DocDtls/SellerDtls/
// BuyerDtls/ItemList/ValDtls — enough for the IRP happy path and the mock
// adapter. Live-payload edge cases (export/SEZ, e-way bill, reverse charge)
// are a deferred depth per the PR body.
export function buildEInvoicePayload({ invoice, items, seller }) {
  const isInterState = n2(invoice.igst_amount) > 0;
  const buyerState = invoice.patient_state || seller.state;
  const itemList = (items || []).map((it, idx) => {
    const lineSubtotal = n2(it.line_subtotal);
    const cgst = n2(it.cgst_amount);
    const sgst = n2(it.sgst_amount);
    const igst = n2(it.igst_amount);
    return {
      SlNo: String(idx + 1),
      PrdDesc: (it.description || 'Service').slice(0, 300),
      IsServc: 'Y',
      HsnCd: it.hsn_sac || '999311', // 999311 = human health services (default)
      Qty: Number(it.quantity || 1),
      Unit: 'OTH',
      UnitPrice: n2(it.unit_price),
      TotAmt: lineSubtotal,
      AssAmt: lineSubtotal,
      GstRt: n2(it.gst_rate),
      IgstAmt: igst,
      CgstAmt: cgst,
      SgstAmt: sgst,
      TotItemVal: n2(it.line_total),
    };
  });
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N' },
    DocDtls: {
      Typ: 'INV',
      No: invoice.invoice_number || `INV-${invoice.id}`,
      Dt: invoice.issued_at
        ? new Date(invoice.issued_at).toLocaleDateString('en-GB').replace(/\//g, '/')
        : new Date().toLocaleDateString('en-GB'),
    },
    SellerDtls: {
      Gstin: seller.gstin,
      LglNm: seller.legalName || 'VH Health',
      Addr1: seller.address || 'NA',
      Loc: seller.location || 'NA',
      Pin: seller.pin || 999999,
      Stcd: stateCode(seller.state),
    },
    BuyerDtls: {
      Gstin: invoice.buyer_gstin || 'URP', // URP = unregistered person
      LglNm: invoice.patient_name || 'Patient',
      Pos: stateCode(buyerState),
      Addr1: 'NA',
      Loc: buyerState || 'NA',
      Pin: 999999,
      Stcd: stateCode(buyerState),
    },
    ItemList: itemList,
    ValDtls: {
      AssVal: n2(invoice.subtotal),
      CgstVal: n2(invoice.cgst_amount),
      SgstVal: n2(invoice.sgst_amount),
      IgstVal: n2(invoice.igst_amount),
      Discount: n2(invoice.discount_amount),
      TotInvVal: n2(invoice.total_amount),
    },
    _meta: { inter_state: isInterState },
  };
}

/* ─── DB helpers ─────────────────────────────────────────────────────────── */

async function loadInvoice(tx, tenantId, invoiceId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, invoice_number, patient_uid, patient_name, patient_phone,
            invoice_type, patient_state, hospital_state, subtotal,
            cgst_amount, sgst_amount, igst_amount, discount_amount,
            total_amount, status, issued_at, tenant_id
       FROM billing_invoices
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number.parseInt(invoiceId, 10), tenantOr(tenantId));
  return unwrap(rows) || null;
}

async function loadInvoiceItems(tx, invoiceId) {
  return tx.$queryRawUnsafe(
    `SELECT service_code, description, category, hsn_sac, quantity, unit_price,
            gst_rate, line_subtotal, cgst_amount, sgst_amount, igst_amount, line_total
       FROM billing_invoice_items
      WHERE invoice_id = $1::int
      ORDER BY id ASC`,
    Number.parseInt(invoiceId, 10));
}

/* ─── IRN generation ─────────────────────────────────────────────────────── */

export async function generateIrn({ tenantId, invoiceId, actorUid = null, buyerGstin = null }) {
  const settings = await requireGstEInvoiceEnabled(tenantId);
  const tid = tenantOr(tenantId);
  const provider = settings.provider || 'mock';
  const { key, adapter } = resolveGspAdapter(provider);

  return setTenantTx(tid, async (tx) => {
    const invoice = await loadInvoice(tx, tid, invoiceId);
    if (!invoice) throw AppError.notFound('Invoice not found');
    if (invoice.status === 'DRAFT') {
      throw AppError.badRequest('Invoice must be issued before an IRN can be generated');
    }
    if (invoice.status === 'VOID') {
      throw AppError.badRequest('Cannot generate an IRN for a voided invoice');
    }

    // Idempotence: a live (non-cancelled) document already generated wins.
    const existing = await tx.$queryRawUnsafe(
      `SELECT * FROM gst_einvoice_documents
        WHERE tenant_id = $1::uuid AND invoice_id = $2::int AND status <> 'cancelled'
        FOR UPDATE`,
      tid, Number.parseInt(invoiceId, 10));
    const existingRow = unwrap(existing);
    if (existingRow && existingRow.status === 'generated') return existingRow;

    const items = await loadInvoiceItems(tx, invoiceId);
    const sellerGstin = settings.sellerGstin || invoice.hospital_state || 'URP000000000ZZ';
    const payload = buildEInvoicePayload({
      invoice: { ...invoice, buyer_gstin: buyerGstin },
      items,
      seller: {
        gstin: settings.sellerGstin || '00AAAAA0000A1Z0',
        legalName: settings.sellerLegalName,
        state: invoice.hospital_state,
      },
    });

    let result;
    let status = 'generated';
    let errorCode = null;
    let errorMessage = null;
    try {
      result = adapter(payload, { provider: key });
    } catch (err) {
      status = 'failed';
      errorCode = err.code || 'GST_EINVOICE_ADAPTER_ERROR';
      errorMessage = err.message;
      result = { response: { error: err.message } };
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO gst_einvoice_documents
         (tenant_id, invoice_id, provider, seller_gstin, irn, ack_no, ack_date,
          signed_invoice, signed_qr_code, status, request_payload, response_payload,
          error_code, error_message, generated_at, created_by)
       VALUES ($1::uuid, $2::int, $3, $4, $5, $6, $7::timestamptz,
               $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14,
               CASE WHEN $10 = 'generated' THEN NOW() ELSE NULL END, $15::uuid)
       ON CONFLICT (tenant_id, invoice_id) WHERE status <> 'cancelled'
       DO UPDATE SET
         provider = EXCLUDED.provider,
         seller_gstin = EXCLUDED.seller_gstin,
         irn = EXCLUDED.irn,
         ack_no = EXCLUDED.ack_no,
         ack_date = EXCLUDED.ack_date,
         signed_invoice = EXCLUDED.signed_invoice,
         signed_qr_code = EXCLUDED.signed_qr_code,
         status = EXCLUDED.status,
         request_payload = EXCLUDED.request_payload,
         response_payload = EXCLUDED.response_payload,
         error_code = EXCLUDED.error_code,
         error_message = EXCLUDED.error_message,
         generated_at = EXCLUDED.generated_at,
         updated_at = NOW()
       RETURNING *`,
      tid, Number.parseInt(invoiceId, 10), key, sellerGstin,
      result.irn || null, result.ack_no || null, result.ack_date || null,
      result.signed_invoice || null, result.signed_qr_code || null,
      status, JSON.stringify(payload), JSON.stringify(result.response || {}),
      errorCode, errorMessage, actorUid || null);
    const row = unwrap(rows);
    if (status === 'failed') {
      throw new AppError(errorMessage || 'IRN generation failed', 502, errorCode || 'GST_EINVOICE_FAILED');
    }
    return row;
  });
}

export async function getEInvoice({ tenantId, invoiceId }) {
  await requireGstEInvoiceEnabled(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM gst_einvoice_documents
      WHERE tenant_id = $1::uuid AND invoice_id = $2::int
      ORDER BY (status <> 'cancelled') DESC, created_at DESC
      LIMIT 1`,
    tenantOr(tenantId), Number.parseInt(invoiceId, 10));
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('No e-invoice document for this invoice');
  return row;
}

export async function listEInvoices({ tenantId, status, from, to, limit = 100 }) {
  await requireGstEInvoiceEnabled(tenantId);
  const conds = ['tenant_id = $1::uuid'];
  const args = [tenantOr(tenantId)];
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  if (from) { args.push(from); conds.push(`created_at >= $${args.length}::timestamptz`); }
  if (to) { args.push(to); conds.push(`created_at <= $${args.length}::timestamptz`); }
  const lim = Math.min(Number.parseInt(limit, 10) || 100, 500);
  return prisma.$queryRawUnsafe(
    `SELECT id, invoice_id, provider, irn, ack_no, ack_date, status,
            error_code, generated_at, cancelled_at, created_at
       FROM gst_einvoice_documents
      WHERE ${conds.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ${lim}`,
    ...args);
}

export async function cancelIrn({ tenantId, invoiceId, reason, actorUid = null }) {
  await requireGstEInvoiceEnabled(tenantId);
  if (!reason) throw AppError.badRequest('cancel reason required');
  const tid = tenantOr(tenantId);
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE gst_einvoice_documents
          SET status = 'cancelled',
              cancelled_at = NOW(),
              cancel_reason = $1,
              cancelled_by = $2::uuid,
              updated_at = NOW()
        WHERE tenant_id = $3::uuid AND invoice_id = $4::int AND status = 'generated'
        RETURNING *`,
      String(reason).slice(0, 255), actorUid || null,
      tid, Number.parseInt(invoiceId, 10));
    const row = unwrap(rows);
    if (!row) throw AppError.notFound('No generated e-invoice to cancel for this invoice');
    return row;
  });
}

export const _internal = { buildEInvoicePayload, resolveGspAdapter, stateCode, mockGspAdapter };
