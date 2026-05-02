// One-off contrast-ratio calculator. Not part of the app build.
// Hex values lifted from `apps/staff/lib/core/theme/app_theme.dart`.
//
// WCAG 2.2 thresholds:
//   AA  normal text: 4.5:1   large text (>= 18pt or >= 14pt bold): 3:1
//   AAA normal text: 7:1     large text: 4.5:1
//   UI components / graphical objects: 3:1
//
// Run: node apps/staff/docs/_contrast_calc.mjs

function hexToRgb(hex) {
  const v = hex.replace('#', '').replace('0xFF', '').replace('0xff', '');
  const x = v.length === 8 ? v.slice(2) : v;
  const n = parseInt(x, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function lum(rgb) {
  const lin = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(fgHex, bgHex) {
  const a = lum(hexToRgb(fgHex));
  const b = lum(hexToRgb(bgHex));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const palette = {
  // Light
  lightSurface: '0xFFFFFFFF',
  lightBackground: '0xFFF5F7FA',
  lightCard: '0xFFFFFFFF',
  lightTextPrimary: '0xFF1A237E',
  lightTextSecondary: '0xFF546E7A',
  lightDivider: '0xFFECEFF1',
  lightInputBorder: '0xFFB0BEC5',
  lightHint: '0xFF90A4AE',
  lightChipBg: '0xFFE3F2FD',
  // Dark
  darkSurface: '0xFF1E1E2C',
  darkBackground: '0xFF141420',
  darkCard: '0xFF252536',
  darkTextPrimary: '0xFFE0E0E8',
  darkTextSecondary: '0xFF9E9EAE',
  darkDivider: '0xFF2E2E42',
  darkInputBorder: '0xFF3A3A50',
  darkHint: '0xFF6E6E82',
  darkPrimary: '0xFF90CAF9',
  darkSecondary: '0xFF80CBC4',
  darkTertiary: '0xFF80DEEA',
  darkError: '0xFFEF5350',
  darkButtonFg: '0xFF0D1B2A',
  darkChipBg: '0xFF1A2744',
  // Brand
  primaryBlue: '0xFF1565C0',
  primaryTeal: '0xFF00796B',
  accentCyan: '0xFF0097A7',
  successGreen: '0xFF2E7D32',
  warningAmber: '0xFFF57F17',
  errorRed: '0xFFC62828',
  white: '0xFFFFFFFF',
  black: '0xFF000000',
};

function tag(r, isLarge) {
  const aa = isLarge ? 3 : 4.5;
  const aaa = isLarge ? 4.5 : 7;
  if (r >= aaa) return 'AAA';
  if (r >= aa) return 'AA';
  if (r >= 3) return 'AA-large only';
  return 'FAIL';
}

const pairs = [
  // ── Light ───────────────────────────────────────────────────────
  { name: 'Light · primary text on bg', fg: 'lightTextPrimary', bg: 'lightBackground', kind: 'normal' },
  { name: 'Light · primary text on card', fg: 'lightTextPrimary', bg: 'lightCard', kind: 'normal' },
  { name: 'Light · secondary text on bg', fg: 'lightTextSecondary', bg: 'lightBackground', kind: 'normal' },
  { name: 'Light · secondary text on card', fg: 'lightTextSecondary', bg: 'lightCard', kind: 'normal' },
  { name: 'Light · hint on input', fg: 'lightHint', bg: 'lightSurface', kind: 'normal' },
  { name: 'Light · primaryBlue link on card', fg: 'primaryBlue', bg: 'lightCard', kind: 'normal' },
  { name: 'Light · successGreen on card', fg: 'successGreen', bg: 'lightCard', kind: 'normal' },
  { name: 'Light · errorRed on card', fg: 'errorRed', bg: 'lightCard', kind: 'normal' },
  { name: 'Light · warningAmber on card', fg: 'warningAmber', bg: 'lightCard', kind: 'normal' },
  { name: 'Light · primaryTeal on card', fg: 'primaryTeal', bg: 'lightCard', kind: 'normal' },
  { name: 'Light · accentCyan on card', fg: 'accentCyan', bg: 'lightCard', kind: 'normal' },
  { name: 'Light · white on primaryBlue (button)', fg: 'white', bg: 'primaryBlue', kind: 'normal' },
  { name: 'Light · white on successGreen', fg: 'white', bg: 'successGreen', kind: 'normal' },
  { name: 'Light · white on errorRed', fg: 'white', bg: 'errorRed', kind: 'normal' },
  { name: 'Light · white on warningAmber', fg: 'white', bg: 'warningAmber', kind: 'normal' },
  { name: 'Light · primaryBlue on lightChipBg', fg: 'primaryBlue', bg: 'lightChipBg', kind: 'normal' },
  { name: 'Light · divider visibility', fg: 'lightDivider', bg: 'lightCard', kind: 'ui' },
  { name: 'Light · input border visibility', fg: 'lightInputBorder', bg: 'lightSurface', kind: 'ui' },
  // ── Dark ────────────────────────────────────────────────────────
  { name: 'Dark · primary text on bg', fg: 'darkTextPrimary', bg: 'darkBackground', kind: 'normal' },
  { name: 'Dark · primary text on card', fg: 'darkTextPrimary', bg: 'darkCard', kind: 'normal' },
  { name: 'Dark · primary text on surface', fg: 'darkTextPrimary', bg: 'darkSurface', kind: 'normal' },
  { name: 'Dark · secondary text on bg', fg: 'darkTextSecondary', bg: 'darkBackground', kind: 'normal' },
  { name: 'Dark · secondary text on card', fg: 'darkTextSecondary', bg: 'darkCard', kind: 'normal' },
  { name: 'Dark · hint on input', fg: 'darkHint', bg: 'darkCard', kind: 'normal' },
  { name: 'Dark · darkPrimary link on card', fg: 'darkPrimary', bg: 'darkCard', kind: 'normal' },
  { name: 'Dark · darkPrimary on bg', fg: 'darkPrimary', bg: 'darkBackground', kind: 'normal' },
  { name: 'Dark · successGreen on card', fg: 'successGreen', bg: 'darkCard', kind: 'normal' },
  { name: 'Dark · errorRed on card', fg: 'errorRed', bg: 'darkCard', kind: 'normal' },
  { name: 'Dark · darkError on card', fg: 'darkError', bg: 'darkCard', kind: 'normal' },
  { name: 'Dark · warningAmber on card', fg: 'warningAmber', bg: 'darkCard', kind: 'normal' },
  { name: 'Dark · primaryBlue on card (legacy)', fg: 'primaryBlue', bg: 'darkCard', kind: 'normal' },
  { name: 'Dark · darkButtonFg on darkPrimary (btn)', fg: 'darkButtonFg', bg: 'darkPrimary', kind: 'normal' },
  { name: 'Dark · darkPrimary on darkChipBg', fg: 'darkPrimary', bg: 'darkChipBg', kind: 'normal' },
  { name: 'Dark · divider visibility', fg: 'darkDivider', bg: 'darkCard', kind: 'ui' },
  { name: 'Dark · input border visibility', fg: 'darkInputBorder', bg: 'darkCard', kind: 'ui' },
];

const rows = pairs.map((p) => {
  const r = ratio(palette[p.fg], palette[p.bg]);
  const isLarge = p.kind === 'large' || p.kind === 'ui';
  return {
    name: p.name,
    fg: p.fg,
    bg: p.bg,
    ratio: r.toFixed(2),
    kind: p.kind,
    grade: p.kind === 'ui' ? (r >= 3 ? 'OK' : 'FAIL') : tag(r, p.kind === 'large'),
  };
});

console.log('| Pair | Ratio | Kind | Grade |');
console.log('|---|---:|---|---|');
for (const r of rows) {
  console.log(`| ${r.name} | ${r.ratio}:1 | ${r.kind} | ${r.grade} |`);
}

const fails = rows.filter((r) => r.grade === 'FAIL' || r.grade === 'AA-large only');
console.log('');
console.log(`Failures + borderline: ${fails.length}`);
for (const f of fails) {
  console.log(`  ✗ ${f.name} — ${f.ratio}:1 (${f.grade})`);
}
