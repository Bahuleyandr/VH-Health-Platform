/**
 * The 100 x 50 mm CSSD device sticker's GEOMETRY and TEXT FITTING — the two
 * things that decide whether the printed artefact is usable, and neither of
 * which the route-level suites can see.
 *
 * The sibling suite (cathDeviceReuseSurfaceEnforcement) reads the finished
 * page's text back out and asserts it carries the seven label fields and
 * nothing else. That is a leak test. This is the other half: a label whose
 * barcode will not scan, or whose catalogue item runs off the edge of the
 * sticker, is a correct label that no bench can use.
 *
 *   * QUIET ZONE. Code 39 needs a blank margin either side of the symbol —
 *     10 narrow modules is the symbology's own minimum. Without it the first
 *     bar starts at the paper's edge, the scanner never sees the start
 *     character, and a "printed" label simply does not read.
 *   * TEXT FIT. `catalogue_item` is free tenant text. Drawn with lineBreak
 *     false at a fixed size, a long item name silently overflows the sticker
 *     — the part that ran off is not truncated, it is printed over the edge.
 */

import zlib from 'node:zlib';

import { code39Runs } from '../../utils/barcode/code39.js';
import {
  CODE39_QUIET_ZONE_MODULES,
  LABEL_MIN_FONT_SIZE,
  code39BarLayout,
  fitLabelText,
  renderCathDeviceLabelPdf,
} from '../../services/documents/cathDeviceLabelPdfService.js';

const LABEL = Object.freeze({
  device_tag: 'RP00000077',
  category: 'catheter',
  catalogue_item: 'Diagnostic catheter',
  reuse_cycle: 1,
  max_cycles: 3,
  facility_name: 'Venkataeswara Hospitals, Nandanam',
  printed_at: '2026-09-05T04:30:00.000Z',
});

/** 85 characters — what a tenant that spells the whole thing out stores. */
const LONG_ITEM =
  'Judkins Left 4.0 diagnostic coronary angiography catheter, hydrophilic coated 6F 100c';

/**
 * The standard-14 fonts encode WinAnsi, which is Latin-1 plus the 0x80-0x9F
 * band Latin-1 leaves as controls — where the ellipsis this label truncates
 * with lives (0x85). Decoding as latin1 would turn it into a control character
 * and the truncation assertion below would pass for the wrong reason.
 */
const WIN_ANSI = new TextDecoder('windows-1252');

/** The text PDFKit actually DREW, in draw order. */
function pdfTextLines(pdf) {
  let content = '';
  for (let index = 0; ;) {
    const start = pdf.indexOf('stream', index);
    if (start < 0) break;
    const end = pdf.indexOf('endstream', start);
    if (end < 0) break;
    let from = start + 'stream'.length;
    if (pdf[from] === 0x0d) from += 1;
    if (pdf[from] === 0x0a) from += 1;
    try {
      content += zlib.inflateSync(pdf.subarray(from, end)).toString('latin1');
    } catch {
      // Not a Flate stream (an embedded font, say); carries no text.
    }
    index = end + 1;
  }
  return [...content.matchAll(/\[([^\]]*)\]\s*TJ/g)].map(([, show]) =>
    [...show.matchAll(/<([0-9A-Fa-f]*)>/g)]
      .map(([, hex]) => WIN_ANSI.decode(Buffer.from(hex, 'hex')))
      .join(''));
}

describe('Code 39 layout leaves the symbology its quiet zone', () => {
  const WIDTH = 264; // the sticker's content width, near enough

  it('reserves 10 narrow modules of blank paper on EACH side', () => {
    const layout = code39BarLayout('RP00000077', { width: WIDTH });
    const units = code39Runs('RP00000077').reduce((total, run) => total + run.width, 0);

    expect(CODE39_QUIET_ZONE_MODULES).toBe(10);
    // The quiet zone is part of the width budget, not extra: bars plus two
    // zones fill it exactly, so the symbol still fits the sticker.
    expect(layout.module).toBeCloseTo(WIDTH / (units + CODE39_QUIET_ZONE_MODULES * 2), 10);
    expect(layout.quietZone).toBeCloseTo(layout.module * CODE39_QUIET_ZONE_MODULES, 10);
    expect(layout.barsWidth + layout.quietZone * 2).toBeCloseTo(WIDTH, 10);
    // The first bar starts AFTER the left zone and the last ends before the
    // right one — the assertion the edge-to-edge layout failed.
    expect(layout.quietZone).toBeGreaterThan(0);
    expect(layout.barsWidth).toBeLessThan(WIDTH);
  });

  it('scales the module down for a longer tag rather than running off the edge', () => {
    // device_tag is 'RP' || lpad(id, GREATEST(8, len(id)), '0'), so a tag past
    // 10^8 is longer. A fixed module would print past the paper.
    const short = code39BarLayout('RP00000077', { width: WIDTH });
    const long = code39BarLayout('RP000000000000000077', { width: WIDTH });

    expect(long.module).toBeLessThan(short.module);
    expect(long.barsWidth + long.quietZone * 2).toBeCloseTo(WIDTH, 10);
  });
});

describe('label text is fitted to the sticker, never printed past its edge', () => {
  // A deterministic stand-in for pdfkit's own metrics: width proportional to
  // the character count and the font size, which is what any real metric is
  // monotone in.
  const measure = (text, size) => text.length * size * 0.5;

  it('leaves text that already fits alone', () => {
    const fitted = fitLabelText({ text: 'Diagnostic catheter', size: 9, width: 200, measure });
    expect(fitted).toEqual({ text: 'Diagnostic catheter', size: 9 });
  });

  it('steps the font size down before it truncates anything', () => {
    // 30 chars at 9pt measures 135; a 110pt box needs 7.33pt, which is above
    // the floor, so the step-down alone seats it and no character is lost.
    const fitted = fitLabelText({ text: 'x'.repeat(30), size: 9, width: 110, measure });

    expect(fitted.size).toBeLessThan(9);
    expect(fitted.size).toBeGreaterThanOrEqual(LABEL_MIN_FONT_SIZE);
    expect(fitted.text).toBe('x'.repeat(30));
    expect(measure(fitted.text, fitted.size)).toBeLessThanOrEqual(110);
  });

  it('never steps below the legibility floor — it ellipsises instead', () => {
    expect(LONG_ITEM).toHaveLength(85);
    const fitted = fitLabelText({ text: LONG_ITEM, size: 9, width: 120, measure });

    expect(fitted.size).toBe(LABEL_MIN_FONT_SIZE);
    expect(fitted.text.endsWith('…')).toBe(true);
    expect(fitted.text.length).toBeLessThan(LONG_ITEM.length);
    expect(measure(fitted.text, fitted.size)).toBeLessThanOrEqual(120);
    // What survives is the START of the name — the discriminating end of a
    // catalogue string, where the device and the size live.
    expect(LONG_ITEM.startsWith(fitted.text.slice(0, -1))).toBe(true);
  });

  it('a box too narrow for even one character degrades to the ellipsis alone', () => {
    const fitted = fitLabelText({ text: 'Diagnostic catheter', size: 9, width: 1, measure });
    expect(fitted.text).toBe('…');
    expect(fitted.size).toBe(LABEL_MIN_FONT_SIZE);
  });

  it('an empty field is not turned into an ellipsis', () => {
    expect(fitLabelText({ text: '', size: 9, width: 120, measure })).toEqual({ text: '', size: 9 });
  });
});

describe('the rendered sticker', () => {
  it('fits an 85-character catalogue item rather than printing over the edge', async () => {
    const pdf = await renderCathDeviceLabelPdf({ ...LABEL, catalogue_item: LONG_ITEM });
    const [, drawnItem] = pdfTextLines(pdf);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // Either the step-down seated it whole or it was ellipsised; what must not
    // happen is the full 85 characters going down at the untouched 9pt and
    // running off the sticker.
    expect(drawnItem.endsWith('…')).toBe(true);
    expect(LONG_ITEM.startsWith(drawnItem.slice(0, -1))).toBe(true);
  });

  it('renders printed_at as a bench-readable IST stamp, not an ISO instant', async () => {
    // 04:30Z is 10:00 IST — the +05:30 shift, which is the whole point of
    // stamping the sticker in the zone the ward reads its clocks in.
    expect(pdfTextLines(await renderCathDeviceLabelPdf(LABEL)))
      .toContain('Printed 2026-09-05 10:00 IST');
  });

  it('degrades rather than throwing when the tag cannot be Code 39 encoded', async () => {
    // A tag the DB minted is always RP + digits; the guard is for a caller
    // that hand-built one. A label with no barcode beats no label at all.
    const pdf = await renderCathDeviceLabelPdf({ ...LABEL, device_tag: 'RP-77*' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
