/**
 * Fixture fidelity for absolute-instant twins.
 *
 * Services read `<col>_epoch_ms` — selected as
 * `(EXTRACT(EPOCH FROM <col>) * 1000)::bigint` — instead of the
 * driver-materialised timestamp (PR #881; see
 * scripts/check-timestamptz-clock-comparisons.mjs). Postgres therefore ALWAYS
 * returns the twin beside the base column. A mocked fixture that supplies the
 * base column without its twin describes a row shape the database can no
 * longer produce, and the service reads `undefined` → null → "no timestamp":
 * an 11-minute-old SOS alert aged 0 (PR #885) and a 2-hour-old report showed
 * 496,000 hours open with both SLA breaches flipped (PR #886) — while every
 * assertion stayed green.
 *
 * This is a SOURCE-shape sweep, not a behavioural test: CI runs a UTC
 * database, and a vacuously-green fixture is by definition behaviourally
 * invisible. Limits (deliberate, mirrored from the #881 guard): twins must be
 * named exactly `<column>_epoch_ms`; linkage is producer-module basename;
 * twin proximity is judged within 12 lines of each base-column line, so a
 * twin in one fixture cannot mask its absence in another; files that mock the
 * producer module itself are skipped (the twin-reading code never runs there).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TESTS_ROOT = fileURLToPath(new URL('./', import.meta.url));
const PROXIMITY_LINES = 12;

// Reviewed exceptions. Each names the ONE (file, twin) pair it excuses and the
// reason the base column there is not a row from the twin-selecting query.
// A stale entry (no longer matching anything) fails the suite.
const ALLOWLIST = [
  {
    file: 'sharedValidatorsWiring.test.js',
    twin: 'expires_at_epoch_ms',
    reason: 'expires_at is a REQUEST-BODY field fed to consentValidator; no DB row exists in this test',
  },
  {
    file: 'paymentGatewayService.test.js',
    twin: 'expires_at_epoch_ms',
    reason: 'expires_at sits on billing_payment_gateway_orders INSERT echoes; the twin is selected from billing_payment_links, which this file never fixtures',
  },
  {
    file: 'fhirVitalsEffectRecovery.test.js',
    twin: 'recorded_at_epoch_ms',
    reason: 'recorded_at feeds the recordVitals write path; the twin is selected only by correctVitals, which this file never calls',
  },
  {
    file: 'vitalsChartServiceVitalsWriteGuards.test.js',
    twin: 'recorded_at_epoch_ms',
    reason: 'flagged occurrences are recordVitals INPUT payloads (future/backdated plausibility checks); DB-row fixtures flow through the buildVitals helper, which derives the twin',
  },
  {
    file: 'vitalsCorrectionRescore.test.js',
    twin: 'recorded_at_epoch_ms',
    reason: 'overrides flow through setExisting, which derives recorded_at_epoch_ms centrally via epoch(); proximity cannot see a helper 200 lines away',
  },
  {
    file: 'vitalsCorrectionRescore.test.js',
    twin: 'created_at_epoch_ms',
    reason: 'same setExisting helper derives created_at_epoch_ms (the coalesce fallback anchor) 15 lines from the base fixture — just outside the proximity window',
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === 'tests') continue;
      walk(p, out);
    } else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

function producerMap() {
  const map = new Map(); // basename -> { file, twins:Set }
  for (const dir of ['services', 'routes', 'controllers']) {
    for (const f of walk(path.join(SRC_ROOT, dir))) {
      const src = readFileSync(f, 'utf8');
      const twins = [...src.matchAll(/AS ([a-z][a-z0-9_]*_epoch_ms)/g)].map((m) => m[1]);
      if (!twins.length) continue;
      const base = path.basename(f, '.js');
      const entry = map.get(base) ?? { file: f, twins: new Set() };
      twins.forEach((t) => entry.twins.add(t));
      map.set(base, entry);
    }
  }
  return map;
}

// Built without backslash escapes in constructed patterns on purpose: this
// file's helpers were twice mangled by a shell layer that eats one escaping
// level, silently turning a word boundary into a backspace character — which
// produced a vacuously green audit. `[^A-Za-z0-9_]` against a space-padded
// line is an escape-free word boundary.
const NEWLINES = /\r?\n/;
const baseColRegex = (col) => new RegExp('[^A-Za-z0-9_]' + col + ' *:');
const suppliesBase = (src, col) =>
  src.split(NEWLINES).some((l) => baseColRegex(col).test(' ' + l));
const mocksProducer = (src, producerBase) =>
  new RegExp('unstable_mockModule[(][^)]*' + producerBase + '[.]js').test(src);

// Line comments must count for NEITHER side of the match: a base column named
// in prose is not a fixture field (this flagged a `// hours_pending comes off
// created_at: ~96h` comment as an orphan), and a twin named in a docblock
// must not satisfy proximity for a real orphan next to it. The '//' is
// treated as a comment start only when not immediately preceded by ':' so
// URLs (https://…) survive. The #881 script guard does this properly with a
// parser; a line-level strip is enough for fixture files.
function stripLineComment(line) {
  for (let i = 0; i < line.length - 1; i += 1) {
    if (line[i] === '/' && line[i + 1] === '/' && line[i - 1] !== ':') {
      return line.slice(0, i);
    }
  }
  return line;
}

// True when some base-column line has no twin line within PROXIMITY_LINES —
// i.e., at least one fixture supplies the column without its twin.
function hasOrphanBase(src, col, twin) {
  const lines = src.split(NEWLINES).map(stripLineComment);
  const re = baseColRegex(col);
  const twinLines = [];
  lines.forEach((l, i) => { if (l.includes(twin)) twinLines.push(i); });
  return lines.some((l, i) => {
    if (!re.test(' ' + l) || l.includes(twin)) return false;
    return !twinLines.some((t) => Math.abs(t - i) <= PROXIMITY_LINES);
  });
}

function collectGaps() {
  const producers = producerMap();
  const gaps = [];
  const allowHits = new Set();
  for (const testPath of readdirSync(TESTS_ROOT).filter((n) => n.endsWith('.test.js'))) {
    if (testPath === 'epochTwinFixtureFidelity.test.js') continue;
    const src = readFileSync(path.join(TESTS_ROOT, testPath), 'utf8');
    // Doubles that derive twins centrally in dispatch() (the sanctioned
    // EPOCH_TWIN_COLUMNS pattern from abdmHiuFetch/abhaEnrolment) attach the
    // twin to every routed row; per-fixture proximity would misread them.
    if (src.includes('EPOCH_TWIN_COLUMNS')) continue;
    for (const [base, { twins }] of producers) {
      if (!src.includes(base)) continue;
      if (mocksProducer(src, base)) continue;
      for (const twin of twins) {
        const col = twin.slice(0, -'_epoch_ms'.length);
        if (!suppliesBase(src, col)) continue;
        if (!hasOrphanBase(src, col, twin)) continue;
        const allowed = ALLOWLIST.find((a) => a.file === testPath && a.twin === twin);
        if (allowed) { allowHits.add(allowed); continue; }
        gaps.push(`${testPath}: supplies ${col} without ${twin} within ${PROXIMITY_LINES} lines (read by ${base})`);
      }
    }
  }
  return { gaps: [...new Set(gaps)], allowHits };
}

describe('epoch-twin fixture fidelity', () => {
  it('self-test: detects an orphan base column and accepts an adjacent twin', () => {
    const orphan = 'x({\n  raised_at: new Date(),\n  other: 1,\n});\n'
      + '\n'.repeat(2 * PROXIMITY_LINES)
      + 'raised_at_epoch_ms: BigInt(1)\n';
    expect(hasOrphanBase(orphan, 'raised_at', 'raised_at_epoch_ms')).toBe(true);
    const adjacent = 'x({\n  raised_at: new Date(),\n  raised_at_epoch_ms: BigInt(1),\n});\n';
    expect(hasOrphanBase(adjacent, 'raised_at', 'raised_at_epoch_ms')).toBe(false);
    // the twin's own line must never count as a base-column occurrence
    expect(suppliesBase('  raised_at_epoch_ms: BigInt(1),', 'raised_at')).toBe(false);
    // comments count for NEITHER side: prose naming the column is not a
    // fixture field, and a twin in a docblock must not satisfy proximity
    const prose = 'x({\n  raised_at: new Date(),\n  other: 1,\n});\n// raised_at_epoch_ms is read by the sweep\n';
    expect(hasOrphanBase(prose, 'raised_at', 'raised_at_epoch_ms')).toBe(true);
    const commentBase = '// hours_pending comes off created_at: ~96h, must not read as ~1970.\n';
    expect(hasOrphanBase(commentBase, 'created_at', 'created_at_epoch_ms')).toBe(false);
    expect(stripLineComment('const u = "https://x.test/a"; // note')).toBe('const u = "https://x.test/a"; ');
    expect(mocksProducer("jest.unstable_mockModule('../../services/emr/vitalsChartService.js', () => ({", 'vitalsChartService')).toBe(true);
  });

  it('finds a real producer corpus, so the sweep cannot pass by scanning nothing', () => {
    const producers = producerMap();
    expect(producers.size).toBeGreaterThanOrEqual(10);
    const allTwins = new Set([...producers.values()].flatMap((p) => [...p.twins]));
    expect(allTwins.has('raised_at_epoch_ms')).toBe(true);
    expect(allTwins.has('expiry_date_epoch_ms')).toBe(true);
  });

  it('every mocked fixture that supplies a twinned column also supplies the twin nearby', () => {
    const { gaps } = collectGaps();
    expect(gaps).toEqual([]);
  });

  it('the allowlist carries no stale entries', () => {
    const { allowHits } = collectGaps();
    const stale = ALLOWLIST.filter((a) => !allowHits.has(a));
    expect(stale.map((a) => `${a.file} :: ${a.twin}`)).toEqual([]);
  });
});
