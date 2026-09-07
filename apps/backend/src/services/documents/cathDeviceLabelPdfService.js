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
import { istDateString } from '../../utils/dateUtils.js';

/** PostScript points per millimetre (72 pt = 1 inch = 25.4 mm). */
const MM = 72 / 25.4;
export const LABEL_SIZE_MM = Object.freeze({ width: 100, height: 50 });
const PAGE = [LABEL_SIZE_MM.width * MM, LABEL_SIZE_MM.height * MM];
const MARGIN = 4 * MM;
const CONTENT_WIDTH = PAGE[0] - MARGIN * 2;

/**
 * Blank paper either side of the barcode, in narrow modules. Code 39's own
 * minimum. A symbol printed edge to edge is a symbol a scanner cannot start
 * reading: it needs the quiet zone to find the leading `*`, so a label without
 * one is not a dimmer barcode, it is a barcode that does not read at all.
 */
export const CODE39_QUIET_ZONE_MODULES = 10;

/**
 * The smallest point size a sticker line may shrink to. Below this the text is
 * on the label but not readable off it across a bench, which is the same as
 * not being there — so the fitter stops here and truncates instead.
 */
export const LABEL_MIN_FONT_SIZE = 7;
const FONT_SIZE_STEP = 0.5;
const ELLIPSIS = '…';

/** Asia/Kolkata is a fixed UTC+05:30 with no DST — the platform's one zone. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Where the bars of `text` sit inside `width`, quiet zones included.
 *
 * The module width is DERIVED from the available width rather than fixed, so
 * the barcode always fits the sticker: a tag past 10^8 mints a longer
 * device_tag (the generated column keeps every digit) and a fixed module would
 * run it off the edge. The two quiet zones are part of that budget, not extra
 * — reserving them by widening the symbol would put the ink back over the
 * paper's edge, which is the problem they exist to solve.
 *
 * Exported so the geometry is unit-testable without opening a PDF.
 */
export function code39BarLayout(text, { width, quietZoneModules = CODE39_QUIET_ZONE_MODULES } = {}) {
  const runs = code39Runs(text);
  const units = runs.reduce((total, run) => total + run.width, 0);
  const module = width / (units + quietZoneModules * 2);
  return {
    runs,
    units,
    module,
    quietZone: module * quietZoneModules,
    barsWidth: module * units,
  };
}

/** Draw a Code 39 barcode into `width` x `height` at (x, y). */
function drawCode39(doc, text, { x, y, width, height }) {
  const { runs, module, quietZone } = code39BarLayout(text, { width });
  let cursor = x + quietZone;
  for (const run of runs) {
    const runWidth = run.width * module;
    if (run.bar) doc.rect(cursor, y, runWidth, height).fill('#000000');
    cursor += runWidth;
  }
}

/**
 * Seat `text` inside `width`, first by shrinking, then by truncating.
 *
 * `catalogue_item` and `facility_name` are free tenant text and the sticker
 * draws every line with `lineBreak: false`, which does NOT clip: a string
 * wider than the box is simply printed over the edge of the paper, so the
 * operator reads a name that stops mid-word with no sign anything is missing.
 *
 * Order matters. Shrinking first keeps the whole name whenever it can be kept
 * — a smaller but complete "…hydrophilic coated 6F" is worth more on a bench
 * than a larger truncated one — and only a line that will not fit at
 * LABEL_MIN_FONT_SIZE loses characters, with an ellipsis saying so.
 *
 * `measure(text, size)` is injected rather than reaching for the document, so
 * the policy is testable without pdfkit's metrics and the caller decides which
 * font it is measuring in.
 */
export function fitLabelText({ text, size, width, measure, minSize = LABEL_MIN_FONT_SIZE }) {
  const full = String(text ?? '');
  if (full === '') return { text: full, size };

  let fitted = size;
  while (fitted > minSize && measure(full, fitted) > width) {
    fitted = Math.max(minSize, Number((fitted - FONT_SIZE_STEP).toFixed(2)));
  }
  if (measure(full, fitted) <= width) return { text: full, size: fitted };

  // Still over at the floor: drop characters from the end until the name plus
  // its ellipsis fits. A box too narrow for even one character keeps the
  // ellipsis alone, which at least reads as "there was something here".
  let kept = full.length;
  while (kept > 0 && measure(full.slice(0, kept) + ELLIPSIS, fitted) > width) kept -= 1;
  return { text: full.slice(0, kept) + ELLIPSIS, size: fitted };
}

/**
 * `printed_at` as the bench reads a clock: `YYYY-MM-DD HH:mm IST`.
 *
 * The wire value is an ISO-8601 UTC instant (the JSON label publishes exactly
 * that), which is the right thing on the wire and the wrong thing on a
 * sticker: a device printed at 10:00 in Chennai would read "04:30" to the
 * person holding it. The date half comes from `istDateString`, the platform's
 * canonical Asia/Kolkata day key, so the sticker and the day-keyed records
 * cannot disagree about which day a print happened on.
 */
function istStamp(value) {
  const at = new Date(String(value ?? ''));
  if (Number.isNaN(at.getTime())) return String(value ?? '');
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return `${istDateString(at)} ${shifted.toISOString().slice(11, 16)} IST`;
}

function line(doc, text, { size = 7, font = 'Helvetica', y }) {
  const fitted = fitLabelText({
    text,
    size,
    width: CONTENT_WIDTH,
    measure: (value, at) => doc.font(font).fontSize(at).widthOfString(value),
  });
  doc.font(font).fontSize(fitted.size).fillColor('#000000')
    .text(fitted.text, MARGIN, y, { width: CONTENT_WIDTH, align: 'center', lineBreak: false });
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
    // At LABEL_MIN_FONT_SIZE, not under it: a line drawn below the floor the
    // fitter refuses to shrink past would be a line the floor does not govern.
    line(doc, `Printed ${istStamp(label.printed_at)}`, { size: LABEL_MIN_FONT_SIZE, y });

    doc.end();
  });
}

export default { renderCathDeviceLabelPdf, LABEL_SIZE_MM };
