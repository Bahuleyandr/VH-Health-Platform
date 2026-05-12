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
 * @param {number|string} investigationId - Investigation ID
 * @returns {Promise<Buffer>} PDF buffer
 */
export async function generateLabReportPDF(investigationId) {
  logger.info(`Generating lab report PDF for investigation ${investigationId}`);

  const invRows = await prisma.$queryRawUnsafe(
    `SELECT i.id, i.patient_uid, i.test_name, i.investigation_type, i.status,
            i.result_summary, i.conclusion, i.interpretation, i.results,
            i.requested_at AS ordered_at, i.completed_at, i.created_at,
            u.name as patient_name, u.phone as patient_phone,
            u.gender as patient_gender, u.birthday as patient_birthday
     FROM investigations i
     LEFT JOIN users u ON i.patient_uid = u.uid
     WHERE i.id = $1 LIMIT 1`,
    investigationId
  );

  if (!invRows.length) {
    throw new Error(`Investigation not found: ${investigationId}`);
  }

  const inv = invRows[0];

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

    // Results
    if (inv.results) {
      const results = typeof inv.results === 'string' ? JSON.parse(inv.results) : inv.results;
      if (Array.isArray(results)) {
        addSection(doc, 'Results', results.map(r => {
          if (typeof r === 'string') return r;
          const refRange = r.reference_range ? ` (Ref: ${r.reference_range})` : '';
          const flag = r.abnormal_flag ? ` [${r.abnormal_flag}]` : '';
          return `${r.name || r.test || 'Test'}: ${r.value || 'N/A'} ${r.unit || ''}${refRange}${flag}`;
        }));
      } else if (typeof results === 'object') {
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

export default { generateDischargeSummaryPDF, generateLabReportPDF };
