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
 * @param {number|string} admissionId - Admission ID
 * @returns {Promise<Buffer>} PDF buffer
 */
export async function generateDischargeSummaryPDF(admissionId) {
  logger.info(`Generating discharge summary PDF for admission ${admissionId}`);

  const { default: dischargeSummaryGenerator } = await import('../emr/dischargeSummaryGenerator.js');
  const data = await dischargeSummaryGenerator.collectClinicalData(admissionId);

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
      `Name: ${data.patient.name || 'N/A'}`,
      `Phone: ${data.patient.phone || 'N/A'}`,
      `Gender: ${data.patient.gender || 'N/A'}`,
      `Date of Birth: ${data.patient.birthday ? new Date(data.patient.birthday).toLocaleDateString() : 'N/A'}`,
      `Admitted: ${data.admission.admitted_at ? new Date(data.admission.admitted_at).toLocaleDateString() : 'N/A'}`,
      `Ward: ${data.admission.ward || 'N/A'}`,
      `Department: ${data.admission.department || 'N/A'}`,
      `Chief Complaint: ${data.admission.chief_complaint || 'N/A'}`,
      `Admitting Diagnosis: ${data.admission.admitting_diagnosis || 'N/A'}`,
    ]);

    // Diagnoses
    if (data.diagnoses.length > 0) {
      addSection(doc, 'Diagnoses', data.diagnoses.map(d =>
        `${d.icd10_code || ''} ${d.description} (${d.status}, ${d.diagnosis_type || 'secondary'})`
      ));
    }

    // Hospital Course — from notes
    if (data.notes.length > 0) {
      const soapNotes = data.notes.filter(n => n.note_type === 'soap');
      if (soapNotes.length > 0) {
        const lastSoap = soapNotes[soapNotes.length - 1];
        const content = typeof lastSoap.content === 'string' ? JSON.parse(lastSoap.content) : lastSoap.content;
        addSection(doc, 'Hospital Course', [
          `Assessment: ${content?.assessment || 'See clinical notes'}`,
          `Plan: ${content?.plan || 'See clinical notes'}`,
        ]);
      }
    }

    // Procedures
    if (data.procedures.length > 0) {
      addSection(doc, 'Procedures Performed', data.procedures.map(p => {
        const content = typeof p.content === 'string' ? JSON.parse(p.content) : p.content;
        return content?.procedure_name || p.title || 'Procedure';
      }));
    }

    // Latest Vitals
    if (data.latestVitals) {
      const v = data.latestVitals;
      addSection(doc, 'Vitals at Discharge', [
        `Heart Rate: ${v.heart_rate || '-'} bpm`,
        `Blood Pressure: ${v.systolic_bp || '-'}/${v.diastolic_bp || '-'} mmHg`,
        `Temperature: ${v.temperature || '-'}`,
        `SpO2: ${v.spo2 || '-'}%`,
        `Respiratory Rate: ${v.respiratory_rate || '-'} /min`,
      ]);
    }

    // Investigations
    if (data.investigations.length > 0) {
      addSection(doc, 'Investigations', data.investigations.map(i =>
        `${i.test_name || i.type}: ${i.status} ${i.result_summary ? '- ' + i.result_summary : ''}`
      ));
    }

    // Medications
    if (data.medications.length > 0) {
      addSection(doc, 'Medications During Stay', data.medications.map(m =>
        `${m.medication_name} ${m.dose || ''} ${m.route || ''} (${m.status})`
      ));
    }

    // Discharge medications from active orders
    const dischargeMeds = data.activeOrders.filter(o => o.order_type === 'medication');
    if (dischargeMeds.length > 0) {
      addSection(doc, 'Medications on Discharge', dischargeMeds.map(o => {
        const d = o.details || {};
        return `${d.medication_name || 'Unknown'} ${d.dose || ''} ${d.route || ''} ${d.frequency || ''} ${d.duration ? 'for ' + d.duration : ''}`;
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
            i.ordered_at, i.completed_at, i.created_at,
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
