import PDFDocument from 'pdfkit';
import { AppError } from '../../utils/AppError.js';

function displayLabel(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return 'N/A';
  if (Array.isArray(value)) {
    return value.length ? value.map(displayValue).join('; ') : 'None';
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => `${displayLabel(key)}: ${displayValue(entry)}`)
      .join('; ');
  }
  return String(value);
}

function drawRule(doc) {
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#94a3b8').stroke();
}

function drawHeading(doc, title) {
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(title);
  doc.moveDown(0.25);
}

function drawKeyValueRows(doc, rows) {
  for (const [label, value] of rows) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#334155').text(`${label}:`, 50, y, {
      width: 145,
      continued: false,
    });
    doc.font('Helvetica').fontSize(9).fillColor('#0f172a').text(displayValue(value), 200, y, {
      width: 345,
    });
    doc.moveDown(0.2);
  }
}

function sectionText(section) {
  return section?.text ?? section?.value ?? section?.content ?? section?.narrative ?? '';
}

export async function renderCathReportPdf(report = {}) {
  if (report.status !== 'signed') {
    throw AppError.conflict(
      'Only signed cath reports can be rendered as PDF',
      'CATH_REPORT_PDF_REQUIRES_SIGNED',
    );
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(18).fillColor('#0f172a')
      .text('Venkataeswara Hospitals', { align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#475569')
      .text('Nandanam, Chennai', { align: 'center' });
    doc.moveDown(0.5);
    drawRule(doc);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a')
      .text(`${displayLabel(report.report_type)} Cath Lab Report`, { align: 'center' });

    drawHeading(doc, 'Patient and Procedure');
    drawKeyValueRows(doc, [
      ['Patient', report.patient_name || report.patient_uid],
      ['Patient UID', report.patient_uid],
      ['Cath case', report.case_id],
      ['Requested procedure', report.requested_procedure],
      ['Procedure', report.procedure_type || report.procedure_log_id],
      ['Procedure date', report.procedure_ended_at || report.procedure_started_at
        ? new Date(report.procedure_ended_at || report.procedure_started_at).toLocaleString('en-IN')
        : null],
      ['Operators', report.procedure_operators],
      ['Encounter', report.encounter_id],
      ['Report type', displayLabel(report.report_type)],
      ['Template version', report.template_version],
    ]);

    drawHeading(doc, 'Report Sections');
    const sections = Array.isArray(report.narrative_sections) ? report.narrative_sections : [];
    if (!sections.length) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#64748b').text('No narrative sections recorded.');
    }
    for (const section of sections) {
      const title = section?.title || displayLabel(section?.key || 'Section');
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1e293b').text(title);
      doc.moveDown(0.15);
      doc.font('Helvetica').fontSize(9).fillColor('#0f172a')
        .text(displayValue(sectionText(section)), { lineGap: 2 });
      doc.moveDown(0.45);
    }

    drawHeading(doc, 'Structured Fields');
    const codedFields = report.coded_fields && typeof report.coded_fields === 'object'
      ? Object.entries(report.coded_fields)
      : [];
    if (!codedFields.length) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#64748b').text('No structured fields recorded.');
    } else {
      drawKeyValueRows(doc, codedFields.map(([key, value]) => [displayLabel(key), value]));
    }

    drawHeading(doc, 'Sign-off');
    drawKeyValueRows(doc, [
      ['Signer', report.signed_by_name || report.signed_by],
      ['Signer role', report.signed_by_role],
      ['Signed at', report.signed_at ? new Date(report.signed_at).toLocaleString('en-IN') : null],
    ]);

    const addenda = Array.isArray(report.addenda) ? report.addenda : [];
    if (addenda.length) {
      drawHeading(doc, 'Addenda');
      for (const addendum of addenda) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#1e293b').text(
          `${new Date(addendum.created_at).toLocaleString('en-IN')} · ${addendum.author_name || addendum.author_uid}`,
        );
        doc.font('Helvetica').fontSize(9).fillColor('#334155').text(`Reason: ${addendum.reason}`);
        doc.font('Helvetica').fontSize(9).fillColor('#0f172a')
          .text(addendum.narrative, { lineGap: 2 });
        doc.moveDown(0.5);
      }
    }

    doc.moveDown(1.5);
    drawRule(doc);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(
      `Generated by VH Health EMR on ${new Date().toLocaleString('en-IN')} · Signed report with append-only addenda.`,
      { align: 'center' },
    );

    doc.end();
  });
}

export default { renderCathReportPdf };
