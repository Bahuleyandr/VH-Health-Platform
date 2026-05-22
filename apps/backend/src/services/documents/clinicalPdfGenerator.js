// src/services/documents/clinicalPdfGenerator.js
// Generates clinical PDF documents (discharge summary, lab report) using pdfkit.

import PDFDocument from 'pdfkit';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

// =============================================================================
// DISCHARGE SUMMARY PDF
// =============================================================================

/**
 * Generate a discharge summary PDF for an admission.
 *
 * `collectAdmissionClinicalContext` returns timeline-event arrays
 * (notes / diagnoses / vitals / medications / investigations / orders)
 * where each event has shape
 *   `{ event_type, sub_type, id, timestamp, summary, payload }`
 * and the actual row data lives in `payload`. This generator normalises
 * those shapes back into the per-section views the PDF layout needs.
 *
 * Findings:
 *   2026-05-10-inpatient-admission-discharge-patient-pdf-500
 *   2026-05-10-surgical-day-care-discharge-patient-pdf-500
 *
 * @param {number|string} admissionId
 * @returns {Promise<Buffer>}
 */
export async function generateDischargeSummaryPDF(admissionId) {
  logger.info(`Generating discharge summary PDF for admission ${admissionId}`);

  const { default: dischargeSummaryGenerator } = await import('../emr/dischargeSummaryGenerator.js');
  const ctx = await dischargeSummaryGenerator.collectClinicalData(admissionId);

  const patient = ctx?.patient || {};
  const admission = ctx?.admission || {};
  const notes = Array.isArray(ctx?.notes) ? ctx.notes : [];
  const diagnoses = Array.isArray(ctx?.diagnoses) ? ctx.diagnoses : [];
  const vitalsEvents = Array.isArray(ctx?.vitals) ? ctx.vitals : [];
  const medicationEvents = Array.isArray(ctx?.medications) ? ctx.medications : [];
  const investigationEvents = Array.isArray(ctx?.investigations) ? ctx.investigations : [];
  const orderEvents = Array.isArray(ctx?.orders) ? ctx.orders : [];

  const procedureNotes = notes.filter((n) => /procedure/i.test(String(n.sub_type || '')));
  const soapNotes = notes.filter((n) => String(n.sub_type || '').toLowerCase() === 'soap');
  const lastSoap = soapNotes.length ? soapNotes[soapNotes.length - 1] : null;

  // Latest vitals reading. collectAdmissionClinicalContext returns the
  // timeline sorted ascending, so the last entry is the most recent.
  const latestVitalsEvent = vitalsEvents.length
    ? vitalsEvents[vitalsEvents.length - 1]
    : null;
  const latestVitals = latestVitalsEvent?.payload || null;

  // Active medication orders for the discharge "take home" list.
  const dischargeOrders = orderEvents.filter((event) => {
    const p = event?.payload || {};
    if (p.order_type !== 'medication') return false;
    const status = String(p.status || '').toLowerCase();
    return !['cancelled', 'discontinued', 'completed'].includes(status);
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // Hospital header
    doc.fontSize(18).font('Helvetica-Bold').text('Venkataeswara Hospitals', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text('Nandanam, Chennai', { align: 'center' });
    doc.moveDown(0.5);
    drawLine(doc);
    doc.moveDown(0.5);
    doc.fontSize(14).font('Helvetica-Bold').text('DISCHARGE SUMMARY', { align: 'center' });
    doc.moveDown();

    // Patient Information
    addSection(doc, 'Patient Information', [
      `Name: ${patient.name || 'N/A'}`,
      `Phone: ${patient.phone || 'N/A'}`,
      `Gender: ${patient.gender || 'N/A'}`,
      `Date of Birth: ${patient.birthday ? new Date(patient.birthday).toLocaleDateString() : 'N/A'}`,
      `Admitted: ${admission.admitted_at ? new Date(admission.admitted_at).toLocaleDateString() : 'N/A'}`,
      `Ward: ${admission.ward || 'N/A'}`,
      `Department: ${admission.department || 'N/A'}`,
      `Chief Complaint: ${admission.chief_complaint || 'N/A'}`,
      `Admitting Diagnosis: ${admission.admitting_diagnosis || 'N/A'}`,
    ]);

    // Diagnoses
    if (diagnoses.length > 0) {
      addSection(doc, 'Diagnoses', diagnoses.map((event) => {
        const d = event?.payload || {};
        const desc = d.description || d.icd10_description || event?.summary || 'Diagnosis';
        const status = d.status || 'status unknown';
        const type = d.diagnosis_type || 'secondary';
        return `${d.icd10_code ? `${d.icd10_code} ` : ''}${desc} (${status}, ${type})`;
      }));
    }

    // Hospital Course — from the latest SOAP note's assessment+plan.
    if (lastSoap) {
      const rawContent = lastSoap.payload?.content;
      let content = rawContent;
      if (typeof rawContent === 'string') {
        try { content = JSON.parse(rawContent); } catch { content = {}; }
      }
      addSection(doc, 'Hospital Course', [
        `Assessment: ${content?.assessment || 'See clinical notes'}`,
        `Plan: ${content?.plan || 'See clinical notes'}`,
      ]);
    }

    // Procedures
    if (procedureNotes.length > 0) {
      addSection(doc, 'Procedures Performed', procedureNotes.map((event) => {
        const p = event?.payload || {};
        const rawContent = p.content;
        let content = rawContent;
        if (typeof rawContent === 'string') {
          try { content = JSON.parse(rawContent); } catch { content = {}; }
        }
        return content?.procedure_name || p.procedure_name || p.title || event?.summary || 'Procedure';
      }));
    }

    // Latest Vitals
    if (latestVitals) {
      addSection(doc, 'Vitals at Discharge', [
        `Heart Rate: ${latestVitals.heart_rate ?? '-'} bpm`,
        `Blood Pressure: ${latestVitals.systolic_bp ?? '-'}/${latestVitals.diastolic_bp ?? '-'} mmHg`,
        `Temperature: ${latestVitals.temperature ?? '-'}`,
        `SpO2: ${latestVitals.spo2 ?? '-'}%`,
        `Respiratory Rate: ${latestVitals.respiratory_rate ?? '-'} /min`,
      ]);
    }

    // Investigations
    if (investigationEvents.length > 0) {
      addSection(doc, 'Investigations', investigationEvents.map((event) => {
        const i = event?.payload || {};
        const test = i.test_name || i.test_type || i.investigation_type || 'Investigation';
        const status = i.status || 'status unknown';
        const result = i.result_summary || i.conclusion || i.interpretation || '';
        return `${test}: ${status}${result ? ' - ' + result : ''}`;
      }));
    }

    // Medications during stay
    if (medicationEvents.length > 0) {
      addSection(doc, 'Medications During Stay', medicationEvents.map((event) => {
        const m = event?.payload || {};
        return `${m.medication_name || 'Medication'} ${m.dose || m.dosage || ''} ${m.route || ''} (${m.status || 'unknown'})`.trim();
      }));
    }

    // Discharge medications from active orders
    if (dischargeOrders.length > 0) {
      addSection(doc, 'Medications on Discharge', dischargeOrders.map((event) => {
        const o = event?.payload || {};
        const d = o.details || {};
        return `${d.medication_name || 'Unknown'} ${d.dose || ''} ${d.route || ''} ${d.frequency || ''} ${d.duration ? 'for ' + d.duration : ''}`.replace(/\s+/g, ' ').trim();
      }));
    }

    // Follow-up
    addSection(doc, 'Follow-up Instructions', [
      'Review with treating physician within 1 week.',
      'Report to emergency if symptoms worsen.',
    ]);

    // Warning signs
    addSection(doc, 'Warning Signs', [
      'Return immediately if: high fever, difficulty breathing, chest pain, severe pain, or any new concerning symptoms.',
    ]);

    // Footer
    doc.moveDown(2);
    drawLine(doc);
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica').text(
      `Generated by VH Health EMR on ${new Date().toLocaleString()} | This is a computer-generated document.`,
      { align: 'center' }
    );

    doc.end();
  });
}

// =============================================================================
// B-6 — DISCHARGE PDF PERSISTENCE
// =============================================================================
//
// generateDischargeSummaryPDF above is the live-preview path —
// regenerates from current chart state on every call. For the legal
// record we want an immutable snapshot uploaded once after signoff.
//
// getOrGenerateDischargePdfUrl:
//   - Returns the signed R2 URL if discharge_pdf_key is already set.
//   - Otherwise, refuses if the summary isn't signed yet
//     (admissions.summary_signed_at IS NULL).
//   - Generates the PDF, uploads to R2, stamps the key on the
//     admissions row, returns the signed URL.
//
// Idempotent — multiple concurrent first-time calls might race the
// upload; the last writer wins on the key column. Acceptable: the
// content is identical because both reads see the same signed
// snapshot, and R2 garbage-collection sweeps abandoned objects.

export async function getOrGenerateDischargePdfUrl(admissionId) {
  const id = Number(admissionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('admissionId must be a positive integer');
  }
  const adRows = await prisma.$queryRawUnsafe(
    `SELECT id, summary_signed_at, discharge_pdf_key
       FROM admissions WHERE id = $1`,
    id,
  );
  if (!adRows.length) {
    const e = new Error('Admission not found'); e.statusCode = 404; throw e;
  }
  const ad = adRows[0];
  if (!ad.summary_signed_at) {
    const e = new Error('Discharge summary must be signed before the PDF can be persisted');
    e.statusCode = 409; e.code = 'SUMMARY_NOT_SIGNED'; throw e;
  }

  // Lazy-import the R2 helper so a deployment without R2 envs still
  // boots — same pattern other services use.
  const { uploadFileToR2, getSignedFileUrl } = await import('../../utils/r2Storage.js');

  if (ad.discharge_pdf_key) {
    try {
      const signed = await getSignedFileUrl(ad.discharge_pdf_key, 3600);
      return { key: ad.discharge_pdf_key, url: signed, generated: false };
    } catch (e) {
      logger.warn(`Persisted discharge PDF key resolved but signed URL failed: ${e.message}; regenerating`);
    }
  }

  const buffer = await generateDischargeSummaryPDF(id);
  const key = `discharge-summaries/${id}/${Date.now()}-discharge-summary.pdf`;
  await uploadFileToR2(buffer, key, 'application/pdf');
  await prisma.$executeRawUnsafe(
    `UPDATE admissions SET discharge_pdf_key = $1, updated_at = NOW() WHERE id = $2`,
    key, id,
  );
  const url = await getSignedFileUrl(key, 3600);
  return { key, url, generated: true };
}

// =============================================================================
// LAB REPORT PDF
// =============================================================================

/**
 * Generate a lab report PDF for an investigation.
 *
 * Robust to the completed/signed-off order shape: the finalised result
 * values for a lab order live in `lab_results` (filed by the analyzer/
 * manual-entry path and frozen on pathologist sign-off), NOT in the
 * `investigations.results` column — which stays NULL for the
 * order-set/HL7 flow. We therefore merge the `lab_results` rows linked
 * by `investigation_id` into the Results section so a completed order's
 * PDF actually shows Haemoglobin/WBC/etc. with values + units, instead
 * of an empty Results block.
 *
 * The `investigationId` is coerced to a positive integer first. The
 * documents route passes `req.params.investigationId` as a *string*, and
 * a bound `$1` parameter is typed `text` by the driver — `WHERE i.id = $1`
 * against the `int` PK then errors with Postgres 42883 (`operator does
 * not exist: integer = text`), surfacing as a 500. Parse + validate up
 * front so a bad id is a clean 400 and a good id binds as an int. Mirrors
 * the discharge-summary route's guard. Finding
 * 2026-05-21-lab-walk-in-patient-2747d82d (and CBC/lipid siblings).
 *
 * @param {number|string} investigationId - Investigation ID
 * @returns {Promise<Buffer>} PDF buffer
 */
export async function generateLabReportPDF(investigationId) {
  const id = Number.parseInt(investigationId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('investigationId must be a positive integer');
    err.statusCode = 400;
    err.code = 'INVALID_INVESTIGATION_ID';
    throw err;
  }
  logger.info(`Generating lab report PDF for investigation ${id}`);

  const invRows = await prisma.$queryRawUnsafe(
    `SELECT i.id, i.patient_uid, i.test_name, i.investigation_type, i.status,
            i.result_summary, i.conclusion, i.interpretation, i.results,
            i.requested_at AS ordered_at, i.completed_at, i.created_at,
            u.name as patient_name, u.phone as patient_phone,
            u.gender as patient_gender, u.birthday as patient_birthday
     FROM investigations i
     LEFT JOIN users u ON i.patient_uid = u.uid
     WHERE i.id = $1::int LIMIT 1`,
    id
  );

  if (!invRows.length) {
    const err = new Error(`Investigation not found: ${id}`);
    err.statusCode = 404;
    err.code = 'INVESTIGATION_NOT_FOUND';
    throw err;
  }

  const inv = invRows[0];

  // Finalised, signed-off result rows for this order. A completed lab
  // order's values live here, not in investigations.results. Only
  // verified rows (status final/corrected + signed_off_at) belong on a
  // patient-facing report — a preliminary row is medico-legally
  // unverified (same gate as getResultsForPatient).
  const labResultRows = await prisma.$queryRawUnsafe(
    `SELECT test_name, value_text, value_numeric, unit, reference_range,
            abnormal_flag, status
       FROM lab_results
      WHERE investigation_id = $1::int
        AND signed_off_at IS NOT NULL
        AND status IN ('final', 'corrected')
      ORDER BY hl7_segment_index NULLS LAST, id`,
    id
  );

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // Hospital header
    doc.fontSize(18).font('Helvetica-Bold').text('Venkataeswara Hospitals', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text('Nandanam, Chennai', { align: 'center' });
    doc.moveDown(0.5);
    drawLine(doc);
    doc.moveDown(0.5);
    doc.fontSize(14).font('Helvetica-Bold').text('LABORATORY REPORT', { align: 'center' });
    doc.moveDown();

    // Patient Info
    addSection(doc, 'Patient Information', [
      `Name: ${inv.patient_name || 'N/A'}`,
      `Phone: ${inv.patient_phone || 'N/A'}`,
      `Gender: ${inv.patient_gender || 'N/A'}`,
      `Date of Birth: ${inv.patient_birthday ? new Date(inv.patient_birthday).toLocaleDateString() : 'N/A'}`,
    ]);

    // Investigation Info
    addSection(doc, 'Investigation Details', [
      `Test: ${inv.test_name || inv.investigation_type || 'N/A'}`,
      `Status: ${inv.status || 'N/A'}`,
      `Ordered: ${inv.ordered_at ? new Date(inv.ordered_at).toLocaleString() : 'N/A'}`,
      `Completed: ${inv.completed_at ? new Date(inv.completed_at).toLocaleString() : 'Pending'}`,
    ]);

    // Results — prefer the structured `lab_results` rows (the canonical
    // store for a completed order). Fall back to the legacy
    // `investigations.results` JSON blob when no lab_results rows are
    // linked (older manual-entry / imported orders).
    if (labResultRows.length > 0) {
      addSection(doc, 'Results', labResultRows.map((r) => {
        const value = r.value_text != null && String(r.value_text) !== ''
          ? r.value_text
          : (r.value_numeric != null ? r.value_numeric : 'N/A');
        const unit = r.unit ? ` ${r.unit}` : '';
        const refRange = r.reference_range ? ` (Ref: ${r.reference_range})` : '';
        const flag = r.abnormal_flag ? ` [${r.abnormal_flag}]` : '';
        return `${r.test_name || 'Test'}: ${value}${unit}${refRange}${flag}`;
      }));
    } else if (inv.results) {
      // `investigations.results` is jsonb — Prisma returns it already
      // parsed (object/array). Guard the string branch so a malformed
      // legacy value can never throw and 500 the whole report.
      let results = inv.results;
      if (typeof results === 'string') {
        try {
          results = JSON.parse(results);
        } catch {
          results = null;
        }
      }
      if (Array.isArray(results)) {
        addSection(doc, 'Results', results.map(r => {
          if (typeof r === 'string') return r;
          const refRange = r.reference_range ? ` (Ref: ${r.reference_range})` : '';
          const flag = r.abnormal_flag ? ` [${r.abnormal_flag}]` : '';
          return `${r.name || r.test || 'Test'}: ${r.value || 'N/A'} ${r.unit || ''}${refRange}${flag}`;
        }));
      } else if (results && typeof results === 'object') {
        addSection(doc, 'Results', Object.entries(results).map(
          ([key, val]) => `${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}`
        ));
      }
    }

    // Summary / Conclusion
    if (inv.result_summary || inv.conclusion || inv.interpretation) {
      addSection(doc, 'Summary', [
        inv.result_summary ? `Result: ${inv.result_summary}` : null,
        inv.conclusion ? `Conclusion: ${inv.conclusion}` : null,
        inv.interpretation ? `Interpretation: ${inv.interpretation}` : null,
      ].filter(Boolean));
    }

    // Footer
    doc.moveDown(2);
    drawLine(doc);
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica').text(
      `Generated by VH Health EMR on ${new Date().toLocaleString()} | This is a computer-generated document.`,
      { align: 'center' }
    );

    doc.end();
  });
}

// =============================================================================
// INVOICE / FINAL BILL PDF
// =============================================================================

/**
 * Generate a patient-facing invoice PDF for a `billing_invoices` row.
 *
 * Used by the patient app's "Download bill" action — TPA patients in
 * particular need a copy of the final bill for reimbursement records
 * and employer claims. The same PDF is acceptable for OPD bills too;
 * the layout collapses the payment-history section to a "Not paid"
 * line when there are no payments. Idempotency is the caller's
 * responsibility (we generate on every request — invoices are small,
 * line counts are bounded, and amount_paid may flip after partial
 * settlements).
 *
 * Finding 2026-05-10-tpa-insurance-claim-patient-final-bill-download-missing.
 *
 * @param {number|string} invoiceId
 * @returns {Promise<Buffer>}
 */
export async function generateInvoicePDF(invoiceId) {
  const id = Number(invoiceId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('invoiceId must be a positive integer');
    err.statusCode = 400;
    throw err;
  }
  logger.info(`Generating invoice PDF for invoice ${id}`);

  const invRows = await prisma.$queryRawUnsafe(
    `SELECT id, invoice_number, invoice_type, status,
            patient_uid, patient_name, patient_phone,
            patient_state, hospital_state,
            admission_id, doctor_uid, department,
            subtotal, cgst_amount, sgst_amount, igst_amount,
            discount_amount, discount_reason,
            total_amount, amount_paid, amount_due,
            issued_at, created_at, notes
       FROM billing_invoices WHERE id = $1::int`,
    id,
  );
  if (!invRows.length) {
    const err = new Error('Invoice not found');
    err.statusCode = 404;
    throw err;
  }
  const inv = invRows[0];

  const [items, payments] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT description, quantity, unit_price, gst_rate,
              line_subtotal, line_total, hsn_sac
         FROM billing_invoice_items
        WHERE invoice_id = $1::int
        ORDER BY id`,
      id,
    ),
    prisma.$queryRawUnsafe(
      `SELECT amount, mode, reference, collected_at, reversed
         FROM billing_payments
        WHERE invoice_id = $1::int AND COALESCE(reversed, false) = false
        ORDER BY collected_at`,
      id,
    ),
  ]);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // Hospital header
    doc.fontSize(18).font('Helvetica-Bold').text('Venkataeswara Hospitals', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text('Nandanam, Chennai – 600 035', { align: 'center' });
    doc.moveDown(0.5);
    drawLine(doc);
    doc.moveDown(0.5);

    const title = inv.invoice_type === 'IP' ? 'FINAL BILL' : 'TAX INVOICE';
    doc.fontSize(14).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').text(
      `Invoice #${inv.invoice_number || inv.id} | ${inv.status || 'DRAFT'}`,
      { align: 'center' },
    );
    doc.moveDown();

    addSection(doc, 'Patient Information', [
      `Name: ${inv.patient_name || 'N/A'}`,
      `Phone: ${inv.patient_phone || 'N/A'}`,
      inv.admission_id ? `Admission ID: ${inv.admission_id}` : null,
      inv.department ? `Department: ${inv.department}` : null,
      `Issued: ${(inv.issued_at || inv.created_at) ? new Date(inv.issued_at || inv.created_at).toLocaleString() : 'N/A'}`,
    ].filter(Boolean));

    // Line items
    if (items.length > 0) {
      addSection(doc, 'Charges', items.map((it) => {
        const qty = it.quantity != null ? `x${it.quantity}` : '';
        const unit = it.unit_price != null ? `@ ${Number(it.unit_price).toFixed(2)}` : '';
        const lineTotal = it.line_total != null ? `= ${Number(it.line_total).toFixed(2)}` : '';
        const gst = it.gst_rate != null ? ` (GST ${Number(it.gst_rate).toFixed(2)}%)` : '';
        return `${it.description || 'Service'} ${qty} ${unit} ${lineTotal}${gst}`.replace(/\s+/g, ' ').trim();
      }));
    } else {
      addSection(doc, 'Charges', ['No line items recorded.']);
    }

    // Totals
    addSection(doc, 'Summary', [
      `Subtotal: ${Number(inv.subtotal || 0).toFixed(2)}`,
      inv.cgst_amount && Number(inv.cgst_amount) > 0
        ? `CGST: ${Number(inv.cgst_amount).toFixed(2)}` : null,
      inv.sgst_amount && Number(inv.sgst_amount) > 0
        ? `SGST: ${Number(inv.sgst_amount).toFixed(2)}` : null,
      inv.igst_amount && Number(inv.igst_amount) > 0
        ? `IGST: ${Number(inv.igst_amount).toFixed(2)}` : null,
      inv.discount_amount && Number(inv.discount_amount) > 0
        ? `Discount${inv.discount_reason ? ' (' + inv.discount_reason + ')' : ''}: -${Number(inv.discount_amount).toFixed(2)}`
        : null,
      `Total: ${Number(inv.total_amount || 0).toFixed(2)}`,
      `Paid: ${Number(inv.amount_paid || 0).toFixed(2)}`,
      `Due: ${Number(inv.amount_due || 0).toFixed(2)}`,
    ].filter(Boolean));

    // Payment history (only non-reversed entries)
    if (payments.length > 0) {
      addSection(doc, 'Payments', payments.map((p) => {
        const when = p.collected_at ? new Date(p.collected_at).toLocaleString() : '';
        const ref = p.reference ? ` ref ${p.reference}` : '';
        return `${Number(p.amount || 0).toFixed(2)} ${p.mode || ''}${ref} ${when}`.replace(/\s+/g, ' ').trim();
      }));
    } else if (Number(inv.amount_paid || 0) === 0) {
      addSection(doc, 'Payments', ['No payments recorded yet.']);
    }

    if (inv.notes) {
      addSection(doc, 'Notes', [String(inv.notes)]);
    }

    // Footer
    doc.moveDown(2);
    drawLine(doc);
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica').text(
      `Generated by VH Health on ${new Date().toLocaleString()} | This is a computer-generated invoice.`,
      { align: 'center' },
    );

    doc.end();
  });
}

// =============================================================================
// HELPERS
// =============================================================================

function addSection(doc, title, items) {
  doc.fontSize(12).font('Helvetica-Bold').text(title);
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica');
  for (const item of items) {
    if (item) {
      doc.text(item, { indent: 10 });
    }
  }
  doc.moveDown(0.8);
}

function drawLine(doc) {
  doc.strokeColor('#999999')
    .lineWidth(0.5)
    .moveTo(50, doc.y)
    .lineTo(545, doc.y)
    .stroke();
}

// =============================================================================
// RECEIPT PDF (payment confirmation, distinct from the tax invoice)
// =============================================================================
//
// Wave-4B-1 — paid invoices need a stable reprint surface for the cashier
// counter. The tax invoice (`generateInvoicePDF` above) is the line-item +
// GST breakup document; the receipt is a payment-confirmation artifact
// listing each `billing_payments` row plus the cumulative paid/due. Both
// reference the same `billing_invoices` row, but consumers (TPA cashless
// vs patient discharge handout) expect the receipt-only format.
//
// Finding 2026-05-10-surgical-day-care-billing-no-receipt-tax-invoice-reprint.

/**
 * Generate the cashier receipt PDF for a paid invoice. Streams a single
 * buffer; caller is responsible for routing the bytes to the HTTP response.
 *
 * The "receipt number" we render is the invoice_number with an `R/` prefix
 * so the cashier can reconcile against the original bill; the underlying
 * invoice carries the canonical GST/tax-invoice number used for accounting.
 *
 * @param {number|string} invoiceId
 * @returns {Promise<Buffer>}
 */
export async function generateReceiptPDF(invoiceId) {
  const id = Number(invoiceId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('invoiceId must be a positive integer');
    err.statusCode = 400;
    throw err;
  }
  logger.info(`Generating receipt PDF for invoice ${id}`);

  const invRows = await prisma.$queryRawUnsafe(
    `SELECT id, invoice_number, invoice_type, status,
            patient_uid, patient_name, patient_phone,
            admission_id, doctor_uid, department,
            subtotal, cgst_amount, sgst_amount, igst_amount,
            discount_amount, total_amount, amount_paid, amount_due,
            issued_at, created_at, notes
       FROM billing_invoices WHERE id = $1::int`,
    id,
  );
  if (!invRows.length) {
    const err = new Error('Invoice not found');
    err.statusCode = 404;
    throw err;
  }
  const inv = invRows[0];

  const payments = await prisma.$queryRawUnsafe(
    `SELECT id, amount, mode, reference, collected_at, reversed
       FROM billing_payments
      WHERE invoice_id = $1::int AND COALESCE(reversed, false) = false
      ORDER BY collected_at, id`,
    id,
  );

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.fontSize(18).font('Helvetica-Bold').text('Venkataeswara Hospitals', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text('Nandanam, Chennai – 600 035', { align: 'center' });
    doc.moveDown(0.5);
    drawLine(doc);
    doc.moveDown(0.5);

    doc.fontSize(14).font('Helvetica-Bold').text('PAYMENT RECEIPT', { align: 'center' });
    doc.moveDown(0.3);
    const receiptNumber = inv.invoice_number ? `R/${inv.invoice_number}` : `R/INV-${inv.id}`;
    doc.fontSize(10).font('Helvetica').text(
      `Receipt #${receiptNumber}  |  Invoice #${inv.invoice_number || inv.id}  |  ${inv.status || 'DRAFT'}`,
      { align: 'center' },
    );
    doc.moveDown();

    addSection(doc, 'Received From', [
      `Name: ${inv.patient_name || 'N/A'}`,
      `Phone: ${inv.patient_phone || 'N/A'}`,
      inv.admission_id ? `Admission ID: ${inv.admission_id}` : null,
    ].filter(Boolean));

    if (payments.length > 0) {
      addSection(doc, 'Payments', payments.map((p) => {
        const when = p.collected_at ? new Date(p.collected_at).toLocaleString() : '';
        const ref = p.reference ? ` ref ${p.reference}` : '';
        return `${Number(p.amount || 0).toFixed(2)} ${p.mode || ''}${ref} ${when}`.replace(/\s+/g, ' ').trim();
      }));
    } else {
      addSection(doc, 'Payments', ['No payments recorded against this invoice.']);
    }

    addSection(doc, 'Summary', [
      `Invoice Total: ${Number(inv.total_amount || 0).toFixed(2)}`,
      `Total Paid:    ${Number(inv.amount_paid || 0).toFixed(2)}`,
      `Balance Due:   ${Number(inv.amount_due || 0).toFixed(2)}`,
    ]);

    doc.moveDown(2);
    drawLine(doc);
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica').text(
      `Generated by VH Health on ${new Date().toLocaleString()} | This is a computer-generated receipt. The tax invoice (with GST breakup) is available separately.`,
      { align: 'center' },
    );

    doc.end();
  });
}

export default {
  generateDischargeSummaryPDF,
  generateLabReportPDF,
  generateInvoicePDF,
  generateReceiptPDF,
};
