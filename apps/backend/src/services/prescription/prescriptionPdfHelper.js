// src/services/prescription/prescriptionPdfHelper.js
//
// Pure PDF renderer for e_prescriptions rows. Extracted from
// ePrescriptionController so other services (patient portal lazy
// regenerate, batch reprint, etc.) can reuse it without pulling the
// whole controller. Layout is unchanged from the original
// generatePrescriptionPDF — Helvetica, header band, Rx column, table
// of medications, follow-up + clinical notes.

import PDFDocument from 'pdfkit';
import { normalizeTemperatureC } from '../../utils/clinical/vitalSignMonitor.js';

/**
 * Render the prescription temperature vital as a "<value>°C" string.
 *
 * The temperature snapshotted onto a prescription's `vitals` JSON is entered
 * raw by the prescriber (no unit travels with it), and since #171 the rest of
 * the platform normalizes charted temperatures to Celsius — so the prescription
 * value is, or should be, Celsius. The old renderer hardcoded a `°F` suffix,
 * which printed a Celsius reading (e.g. 38.2) as nonsense ("38.2°F").
 *
 * We defensively normalize through `normalizeTemperatureC` (which infers and
 * converts a stray Fahrenheit reading — value ≥ 60 → ÷F→C) and always label
 * the result `°C`, the platform's canonical clinical unit. Returns null for
 * absent/non-numeric input so the caller can omit the field. The value is
 * rounded to one decimal to avoid float dust (e.g. 100.4°F → 38.0°C, not
 * 37.99999°C).
 *
 * Pure + exported for unit testing.
 * @param {number|string|null|undefined} value
 * @param {string} [unit] - optional unit hint ('C' | 'F' | ...) if one is stored
 * @returns {string|null} e.g. "38.2°C", or null when not renderable
 */
export function formatTemperatureForDisplay(value, unit) {
  const celsius = normalizeTemperatureC(value, unit);
  const num = typeof celsius === 'number' ? celsius : parseFloat(celsius);
  if (celsius == null || Number.isNaN(num)) return null;
  return `${Math.round(num * 10) / 10}°C`;
}

const FREQ_LABELS = {
  OD: 'Once daily',
  BD: 'Twice daily',
  TDS: 'Three times daily',
  QID: 'Four times daily',
  SOS: 'As needed (SOS)',
  HS: 'At bedtime',
  STAT: 'Immediately'
};

function normaliseMedications(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normaliseVitals(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Render a prescription to a PDF buffer.
 *
 * @param {object} prescription - {id, prescription_number, diagnosis, clinical_notes,
 *                                  medications, vitals, follow_up_date, follow_up_notes, created_at}
 * @param {object} patient - {name, phone, gender, birthday}
 * @param {object} doctor - {name, specialization, qualification}
 * @returns {Promise<Buffer>}
 */
export async function generatePrescriptionPDFBuffer(prescription, patient = {}, doctor = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      size: 'A4'
    });
    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const leftX = 40;
    const pageWidth = 515;

    // Header band
    doc.rect(leftX, 30, pageWidth, 55).fill('#007A64');
    doc
      .fillColor('white')
      .fontSize(18)
      .font('Helvetica-Bold')
      .text('VENKATAESWARA HOSPITALS', leftX + 10, 38, { align: 'center', width: pageWidth });
    doc
      .fontSize(8)
      .font('Helvetica')
      .text('Nandanam, Chennai – 600 035 | Tel: 044-24334455', leftX + 10, 58, {
        align: 'center',
        width: pageWidth
      });

    // Rx title
    doc.fillColor('#007A64').fontSize(22).font('Helvetica-Bold').text('Rx', leftX, 100);
    doc
      .fillColor('#333')
      .fontSize(12)
      .font('Helvetica-Bold')
      .text('PRESCRIPTION', leftX + 30, 104);
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(prescription.prescription_number || `Rx-${prescription.id || ''}`, leftX + 140, 104);

    const prescDate = prescription.created_at
      ? new Date(prescription.created_at).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        })
      : '';
    if (prescDate) {
      doc.text(`Date: ${prescDate}`, leftX + pageWidth - 150, 104, { width: 150, align: 'right' });
    }

    doc
      .moveTo(leftX, 125)
      .lineTo(leftX + pageWidth, 125)
      .stroke('#007A64');

    // Patient block
    let y = 135;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#333');
    doc.text('Patient:', leftX, y);
    doc.font('Helvetica').text(patient.name || 'N/A', leftX + 55, y);
    doc.font('Helvetica-Bold').text('Age/Gender:', leftX + 250, y);
    const age = patient.birthday
      ? Math.floor(
          (Date.now() - new Date(patient.birthday).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
        )
      : '-';
    const gender = patient.gender ? String(patient.gender).charAt(0).toUpperCase() : '-';
    doc.font('Helvetica').text(`${age} / ${gender}`, leftX + 320, y);
    y += 16;
    doc.font('Helvetica-Bold').text('Phone:', leftX, y);
    doc.font('Helvetica').text(patient.phone || '-', leftX + 55, y);

    // Doctor block
    y += 16;
    doc.font('Helvetica-Bold').text('Doctor:', leftX, y);
    doc.font('Helvetica').text(doctor.name || 'N/A', leftX + 55, y);
    if (doctor.specialization) {
      doc.font('Helvetica-Bold').text('Specialization:', leftX + 250, y);
      doc.font('Helvetica').text(doctor.specialization, leftX + 340, y);
    }
    if (doctor.qualification) {
      y += 16;
      doc.font('Helvetica-Bold').text('Qualification:', leftX, y);
      doc.font('Helvetica').text(doctor.qualification, leftX + 80, y);
    }

    y += 20;
    doc
      .moveTo(leftX, y)
      .lineTo(leftX + pageWidth, y)
      .stroke('#ddd');

    // Diagnosis
    if (prescription.diagnosis) {
      y += 10;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Diagnosis:', leftX, y);
      y += 14;
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#333')
        .text(prescription.diagnosis, leftX, y, { width: pageWidth });
      y += doc.heightOfString(prescription.diagnosis, { width: pageWidth }) + 8;
    }

    // Vitals
    const vitals = normaliseVitals(prescription.vitals);
    if (vitals && Object.keys(vitals).length > 0) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Vitals:', leftX, y);
      y += 14;
      const parts = [];
      if (vitals.bp_systolic && vitals.bp_diastolic)
        parts.push(`BP: ${vitals.bp_systolic}/${vitals.bp_diastolic} mmHg`);
      if (vitals.pulse) parts.push(`Pulse: ${vitals.pulse} bpm`);
      const tempDisplay = formatTemperatureForDisplay(vitals.temperature, vitals.temperature_unit);
      if (tempDisplay) parts.push(`Temp: ${tempDisplay}`);
      if (vitals.spo2) parts.push(`SpO2: ${vitals.spo2}%`);
      if (vitals.weight) parts.push(`Weight: ${vitals.weight} kg`);
      if (vitals.blood_sugar) parts.push(`Blood Sugar: ${vitals.blood_sugar} mg/dL`);
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#333')
        .text(parts.join('  |  '), leftX, y, { width: pageWidth });
      y += 18;
    }

    // Medications table
    y += 5;
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Medications:', leftX, y);
    y += 16;

    const medications = normaliseMedications(prescription.medications);
    if (medications.length > 0) {
      const colWidths = [25, 140, 55, 70, 60, 50, 115];
      const headers = ['#', 'Medicine', 'Dosage', 'Frequency', 'Duration', 'Route', 'Instructions'];
      doc.rect(leftX, y, pageWidth, 16).fill('#007A64');
      doc.fillColor('white').fontSize(7).font('Helvetica-Bold');
      let cx = leftX + 3;
      headers.forEach((h, i) => {
        doc.text(h, cx, y + 4, { width: colWidths[i] });
        cx += colWidths[i];
      });
      y += 16;

      medications.forEach((med, idx) => {
        if (y > 720) {
          doc.addPage();
          y = 40;
        }
        const bg = idx % 2 === 0 ? '#f8f8f8' : '#ffffff';
        doc.rect(leftX, y, pageWidth, 18).fill(bg);
        doc.fillColor('#333').fontSize(7).font('Helvetica');
        cx = leftX + 3;
        const medicineName =
          med.display_name || med.displayName || med.name || med.medication_name || '';
        const row = [
          `${idx + 1}`,
          `${medicineName}${med.generic_name ? ` (${med.generic_name})` : ''}`,
          med.dosage || '-',
          FREQ_LABELS[med.frequency] || med.frequency || '-',
          med.duration || '-',
          med.route || 'Oral',
          med.instructions || '-'
        ];
        row.forEach((val, i) => {
          doc.text(String(val), cx, y + 5, { width: colWidths[i], lineBreak: false });
          cx += colWidths[i];
        });
        y += 18;
      });

      doc
        .moveTo(leftX, y)
        .lineTo(leftX + pageWidth, y)
        .stroke('#ddd');
    } else {
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#999')
        .text('No structured medications recorded.', leftX, y);
      y += 16;
    }

    // Follow-up
    if (prescription.follow_up_date) {
      y += 15;
      const fuDate = new Date(prescription.follow_up_date).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Follow-up:', leftX, y);
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#333')
        .text(fuDate, leftX + 65, y);
      if (prescription.follow_up_notes) {
        y += 14;
        doc.text(prescription.follow_up_notes, leftX, y, { width: pageWidth });
        y += doc.heightOfString(prescription.follow_up_notes, { width: pageWidth });
      }
    }

    // Clinical notes
    if (prescription.clinical_notes) {
      y += 15;
      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .fillColor('#007A64')
        .text('Clinical Notes:', leftX, y);
      y += 14;
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor('#333')
        .text(prescription.clinical_notes, leftX, y, { width: pageWidth });
      y += doc.heightOfString(prescription.clinical_notes, { width: pageWidth });
    }

    // Footer / signature
    y = Math.max(y + 40, 680);
    if (y > 750) {
      doc.addPage();
      y = 40;
    }
    doc
      .moveTo(leftX + pageWidth - 200, y)
      .lineTo(leftX + pageWidth, y)
      .stroke('#333');
    y += 5;
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor('#333')
      .text(`Dr. ${doctor.name || 'N/A'}`, leftX + pageWidth - 200, y, {
        width: 200,
        align: 'center'
      });
    y += 12;
    if (doctor.specialization) {
      doc
        .fontSize(8)
        .font('Helvetica')
        .text(doctor.specialization, leftX + pageWidth - 200, y, { width: 200, align: 'center' });
    }

    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#999')
      .text(
        "This is a computer-generated prescription. Valid only with doctor's signature.",
        leftX,
        790,
        { width: pageWidth, align: 'center' }
      );

    doc.end();
  });
}

export default { generatePrescriptionPDFBuffer };
