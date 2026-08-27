// src/services/billing/tallyExportService.js — G2 part (a) (reaudit 2026-08-25)
//
// Self-contained Tally / GL accounting export for a set of billing invoices
// over a date range. NO external credentials — this is a pure read projection
// of billing_invoices (migration 149) into two flat-file formats every Indian
// hospital finance office asks for on day one:
//
//   * Tally XML  — the classic Tally.ERP `IMPORTDATA` voucher envelope: one
//     Sales voucher per issued invoice, split into a sales ledger credit, the
//     CGST/SGST/IGST output-tax ledger credits, and a party (debtor) debit.
//   * GL CSV     — a flat double-entry general-ledger extract: one row per
//     ledger posting (date, voucher, ledger, debit, credit), balanced per
//     invoice, for import into any other accounting package.
//
// Rides the same tenant gate as the IRN service (gstEInvoiceService) so a
// hospital turns the whole GST-compliance surface on together.

import prisma from '../../lib/prisma.js';
import { escapeCsvField } from '../../utils/csv.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { requireGstEInvoiceEnabled } from './gstEInvoiceService.js';

function tenantOr(t) { return requireTenantId(t); }
function n2(v) { return Math.round(Number(v || 0) * 100) / 100; }

// XML-escape a text value for safe embedding in the Tally envelope.
function xe(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// CSV cell escape — the shared helper both RFC-4180-quotes AND neutralizes
// spreadsheet formula injection (leading = + - @ tab/CR), since the GL CSV is
// built for manual opening in Excel by the finance office.
const ce = escapeCsvField;

function tallyDate(d) {
  const dt = d ? new Date(d) : new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}${m}${day}`; // Tally wants YYYYMMDD
}

async function loadInvoices({ tenantId, from, to, invoiceIds }) {
  const conds = ['tenant_id = $1::uuid', "status IN ('ISSUED', 'PARTIAL', 'PAID')"];
  const args = [tenantOr(tenantId)];
  if (from) { args.push(from); conds.push(`issued_at >= $${args.length}::timestamptz`); }
  if (to) { args.push(to); conds.push(`issued_at <= $${args.length}::timestamptz`); }
  if (Array.isArray(invoiceIds) && invoiceIds.length) {
    args.push(invoiceIds.map((n) => Number.parseInt(n, 10)).filter(Number.isInteger));
    conds.push(`id = ANY($${args.length}::int[])`);
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, invoice_number, patient_name, patient_state, hospital_state,
            subtotal, cgst_amount, sgst_amount, igst_amount, discount_amount,
            total_amount, invoice_type, issued_at
       FROM billing_invoices
      WHERE ${conds.join(' AND ')}
      ORDER BY issued_at ASC, id ASC`,
    ...args);
}

// Ledger postings for one invoice — the balanced double-entry set.
// Party (debtor) is debited the gross; sales + each output-tax ledger are
// credited; a discount reduces the sales credit (recorded as its own line).
function postingsFor(inv) {
  const postings = [];
  const party = inv.patient_name || `Invoice ${inv.invoice_number || inv.id}`;
  postings.push({ ledger: `Debtors - ${party}`, debit: n2(inv.total_amount), credit: 0, kind: 'party' });
  postings.push({ ledger: 'Hospital Services Income', debit: 0, credit: n2(inv.subtotal), kind: 'sales' });
  if (n2(inv.discount_amount) > 0) {
    postings.push({ ledger: 'Discounts Allowed', debit: n2(inv.discount_amount), credit: 0, kind: 'discount' });
  }
  if (n2(inv.cgst_amount) > 0) postings.push({ ledger: 'Output CGST', debit: 0, credit: n2(inv.cgst_amount), kind: 'tax' });
  if (n2(inv.sgst_amount) > 0) postings.push({ ledger: 'Output SGST', debit: 0, credit: n2(inv.sgst_amount), kind: 'tax' });
  if (n2(inv.igst_amount) > 0) postings.push({ ledger: 'Output IGST', debit: 0, credit: n2(inv.igst_amount), kind: 'tax' });
  return postings;
}

/* ─── Tally XML ──────────────────────────────────────────────────────────── */

export async function exportTallyXml({ tenantId, from = null, to = null, invoiceIds = null }) {
  await requireGstEInvoiceEnabled(tenantId);
  const invoices = await loadInvoices({ tenantId, from, to, invoiceIds });

  const vouchers = invoices.map((inv) => {
    const party = inv.patient_name || `Invoice ${inv.invoice_number || inv.id}`;
    const dt = tallyDate(inv.issued_at);
    const entries = postingsFor(inv).map((p) => {
      const isDeemedPositive = p.debit > 0 ? 'Yes' : 'No';
      const amount = p.debit > 0 ? -p.debit : p.credit; // Tally sign convention: debit negative
      return `        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${xe(p.ledger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${isDeemedPositive}</ISDEEMEDPOSITIVE>
          <AMOUNT>${amount.toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }).join('\n');
    return `      <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="Sales" ACTION="Create">
        <DATE>${dt}</DATE>
        <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${xe(inv.invoice_number || inv.id)}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>${xe(`Debtors - ${party}`)}</PARTYLEDGERNAME>
        <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
${entries}
      </VOUCHER>
      </TALLYMESSAGE>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
${vouchers}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

  return {
    format: 'tally_xml',
    content_type: 'application/xml',
    filename: `tally-vouchers-${from || 'all'}-${to || 'all'}.xml`.replace(/[^a-zA-Z0-9._-]/g, '_'),
    invoice_count: invoices.length,
    content: xml,
  };
}

/* ─── GL CSV ─────────────────────────────────────────────────────────────── */

export async function exportGlCsv({ tenantId, from = null, to = null, invoiceIds = null }) {
  await requireGstEInvoiceEnabled(tenantId);
  const invoices = await loadInvoices({ tenantId, from, to, invoiceIds });

  const header = ['date', 'voucher_no', 'invoice_type', 'ledger', 'debit', 'credit', 'narration'];
  const lines = [header.join(',')];
  for (const inv of invoices) {
    const dt = inv.issued_at ? new Date(inv.issued_at).toISOString().slice(0, 10) : '';
    const voucher = inv.invoice_number || `INV-${inv.id}`;
    const narration = `Sales - ${inv.patient_name || 'Patient'}`;
    for (const p of postingsFor(inv)) {
      lines.push([
        ce(dt), ce(voucher), ce(inv.invoice_type), ce(p.ledger),
        p.debit ? n2(p.debit).toFixed(2) : '',
        p.credit ? n2(p.credit).toFixed(2) : '',
        ce(narration),
      ].join(','));
    }
  }

  return {
    format: 'gl_csv',
    content_type: 'text/csv',
    filename: `gl-export-${from || 'all'}-${to || 'all'}.csv`.replace(/[^a-zA-Z0-9._-]/g, '_'),
    invoice_count: invoices.length,
    content: `${lines.join('\n')}\n`,
  };
}

export const _internal = { postingsFor, tallyDate, xe, ce };
