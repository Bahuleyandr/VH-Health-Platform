// apps/backend/src/services/documents/cathDeviceLabelPdfService.js
//
// The physical CSSD label for one reprocessable cath device: a 100 x 50 mm
// sticker carrying the device tag as large monospace text and as a Code 39
// barcode, the catalogue item, the cycle counter and the facility.
//
// Symbology is Code 39 because that is what the CSSD instrument-set label
// already prints (cssdService.getInstrumentSetLabel -> utils/barcode/code39.js)
// and what the wards' commodity scanners and the staff app's camera scanner
// already read. That module is dependency-free and exposes the bar RUNS, so
// the bars are drawn straight into the PDF as rectangles — no new dependency,
// and no SVG rasteriser in the middle.
//
// NOTHING PATIENT-SHAPED IS ON THIS LABEL. See DEVICE_LABEL_FIELDS in
// services/clinical/cathDeviceReuseService.js: the register's exposure_flag /
// exposure_markers name a blood-borne marker a previous patient tested
// reactive for, and this artefact leaves the department stuck to the device
// with no role gate in front of it. The renderer takes the seven label fields
// and has no access to anything else.

import PDFDocument from 'pdfkit';

import { code39Runs, isCode39Encodable } from '../../utils/barcode/code39.js';

/** PostScript points per millimetre (72 pt = 1 inch = 25.4 mm). */
const MM = 72 / 25.4;
export const LABEL_SIZE_MM = Object.freeze({ width: 100, height: 50 });
const PAGE = [LABEL_SIZE_MM.width * MM, LABEL_SIZE_MM.height * MM];
const MARGIN = 4 * MM;
const CONTENT_WIDTH = PAGE[0] - MARGIN * 2;

/**
 * Draw a Code 39 barcode into `width` x `height` at (x, y).
 *
 * The module width is DERIVED from the available width rather than fixed, so
 * the barcode always fits the sticker: a tag past 10^8 mints a longer
 * device_tag (the generated column keeps every digit) and a fixed module would
 * run it off the edge.
 */
function drawCode39(doc, text, { x, y, width, height }) {
  const runs = code39Runs(text);
  const units = runs.reduce((total, run) => total + run.width, 0);
  const module = width / units;
  let cursor = x;
  for (const run of runs) {
    const runWidth = run.width * module;
    if (run.bar) doc.rect(cursor, y, runWidth, height).fill('#000000');
    cursor += runWidth;
  }
}

function line(doc, text, { size = 7, font = 'Helvetica', y }) {
  doc.font(font).fontSize(size).fillColor('#000000')
    .text(text, MARGIN, y, { width: CONTENT_WIDTH, align: 'center', lineBreak: false });
}

/**
 * Render the label. `label` is exactly the object
 * cathDeviceReuseService.deviceLabel() returns.
 */
export async function renderCathDeviceLabelPdf(label = {}) {
  const tag = String(label.device_tag ?? '').toUpperCase();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: PAGE, margin: 0 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, PAGE[0], PAGE[1]).fill('#ffffff');

    // The tag, big enough to read across a bench, in a monospace face so 0/O
    // and 1/I cannot be confused when it is keyed in by hand.
    doc.font('Courier-Bold').fontSize(22).fillColor('#000000')
      .text(tag, MARGIN, MARGIN, { width: CONTENT_WIDTH, align: 'center', lineBreak: false });

    // A tag the DB minted is always RP + digits, which Code 39 encodes; the
    // guard is for a caller that hand-built one. A label with no barcode still
    // beats no label at all, so this degrades rather than throwing.
    if (isCode39Encodable(tag)) {
      drawCode39(doc, tag, {
        x: MARGIN, y: MARGIN + 24, width: CONTENT_WIDTH, height: 13 * MM,
      });
    }

    let y = MARGIN + 24 + 13 * MM + 4;
    line(doc, String(label.catalogue_item ?? ''), { size: 9, font: 'Helvetica-Bold', y });
    y += 12;
    line(doc, `${String(label.category ?? '').replace(/_/g, ' ')} · cycle ${label.reuse_cycle} of ${label.max_cycles}`, { y });
    y += 10;
    line(doc, String(label.facility_name ?? ''), { y });
    y += 10;
    line(doc, `Printed ${String(label.printed_at ?? '')}`, { size: 6, y });

    doc.end();
  });
}

export default { renderCathDeviceLabelPdf, LABEL_SIZE_MM };
