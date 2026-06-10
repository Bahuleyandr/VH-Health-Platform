// src/utils/barcode/code39.js
//
// Roadmap B1 — dependency-free Code 39 barcode rendering for wristbands and
// printable labels. Code 39 is chosen deliberately: trivially printable
// (binary bar widths, no checksum mandatory), readable by every commodity
// 1D laser scanner and by the staff app's camera scanner, and its charset
// (0-9 A-Z - . space $ / + %) covers uppercased UUIDs and VHMP pack codes.
//
// Pure functions — unit-tested without a browser or canvas.

// Each pattern is 9 elements (bars+spaces alternating, starting with a bar);
// '1' = wide, '0' = narrow. Standard Code 39 table.
const CODE39_PATTERNS = Object.freeze({
  '0': '000110100', 1: '100100001', 2: '001100001', 3: '101100000',
  4: '000110001', 5: '100110000', 6: '001110000', 7: '000100101',
  8: '100100100', 9: '001100100',
  A: '100001001', B: '001001001', C: '101001000', D: '000011001',
  E: '100011000', F: '001011000', G: '000001101', H: '100001100',
  I: '001001100', J: '000011100', K: '100000011', L: '001000011',
  M: '101000010', N: '000010011', O: '100010010', P: '001010010',
  Q: '000000111', R: '100000110', S: '001000110', T: '000010110',
  U: '110000001', V: '011000001', W: '111000000', X: '010010001',
  Y: '110010000', Z: '011010000',
  '-': '010000101', '.': '110000100', ' ': '011000100',
  '$': '010101000', '/': '010100010', '+': '010001010', '%': '000101010',
  '*': '010010100', // start/stop
});

export function isCode39Encodable(text) {
  if (text == null || text === '') return false;
  return [...String(text).toUpperCase()].every((ch) => ch !== '*' && CODE39_PATTERNS[ch] != null);
}

/**
 * Encode text to a sequence of {width, bar} runs (bar=true → ink).
 * Wide:narrow ratio 3:1; one narrow space between characters.
 */
export function code39Runs(text) {
  const upper = String(text ?? '').toUpperCase();
  if (!isCode39Encodable(upper)) {
    throw new Error(`Text is not Code 39 encodable: "${text}"`);
  }
  const full = `*${upper}*`;
  const runs = [];
  for (let c = 0; c < full.length; c += 1) {
    const pattern = CODE39_PATTERNS[full[c]];
    for (let i = 0; i < 9; i += 1) {
      runs.push({ width: pattern[i] === '1' ? 3 : 1, bar: i % 2 === 0 });
    }
    if (c < full.length - 1) runs.push({ width: 1, bar: false }); // inter-char gap
  }
  return runs;
}

/**
 * Render a self-contained SVG barcode. Module = narrow bar width in px.
 */
export function code39Svg(text, { module = 2, height = 56, quietZone = 10, label = true } = {}) {
  const runs = code39Runs(text);
  const barsWidth = runs.reduce((sum, run) => sum + run.width * module, 0);
  const width = barsWidth + quietZone * 2;
  const labelHeight = label ? 16 : 0;
  let x = quietZone;
  const rects = [];
  for (const run of runs) {
    const w = run.width * module;
    if (run.bar) {
      rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}" fill="#000"/>`);
    }
    x += w;
  }
  const labelText = label
    ? `<text x="${width / 2}" y="${height + 13}" text-anchor="middle" font-family="monospace" font-size="11" fill="#000">${String(text).toUpperCase()}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + labelHeight}" viewBox="0 0 ${width} ${height + labelHeight}" role="img" aria-label="barcode ${String(text).toUpperCase()}">`
    + `<rect width="${width}" height="${height + labelHeight}" fill="#fff"/>`
    + rects.join('')
    + labelText
    + '</svg>';
}

export default { code39Svg, code39Runs, isCode39Encodable };
