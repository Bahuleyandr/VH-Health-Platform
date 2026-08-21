/**
 * pg_advisory_xact_lock / pg_advisory_lock return VOID, and Prisma 7's driver
 * adapter cannot deserialize a void column (P2010 UnsupportedNativeDataType).
 * A bare `SELECT pg_advisory_xact_lock(...)` through $queryRaw* therefore
 * 500s at runtime — and only on code paths CI never drives end-to-end
 * (staffAuthService register-device, first seen on dalekdefender 2026-08-21:
 * every staff login crashed while every gate stayed green, because the unit
 * tests mock prisma and no deep test hits /register-device).
 *
 * House-safe idioms, all in use today:
 *   ...pg_advisory_xact_lock(...)::text AS lock_acquired   -- cast the void
 *   ...pg_advisory_xact_lock(...) IS NULL AS lock_acquired -- boolean wrap
 *   SELECT 1 / COUNT(*) FROM (SELECT pg_advisory_xact_lock(...)) AS t
 *
 * Detector: find each lock call, walk to its MATCHING close paren, and judge
 * only what FOLLOWS it — a `::` cast or `IS NULL` is safe; so is a call whose
 * SELECT projects something else (wrapped-subquery form). Casts INSIDE the
 * argument list (hashtextextended($1::text, ...)) must not count — matching
 * them is exactly the bug that let the bare form pass this guard's first
 * draft. pg_try_advisory_lock returns boolean and is out of scope.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WINDOW_LINES = 8;
const LOCK_NAME = /\bpg_advisory(?:_xact)?_lock\s*\(/gi;

// True when this occurrence is the bare-void shape: the projection is the
// lock call itself and nothing after its matching ')' rescues the type.
export function occurrenceViolates(text, callIndex) {
  const before = text.slice(Math.max(0, callIndex - 160), callIndex);
  // Only the projection-position form can put a void column in the result
  // set: "SELECT <call>". A call wrapped as a FROM-subquery is projected
  // away by the OUTER select; a call preceded by other projected exprs is
  // that outer select.
  const trimmed = before.replace(/[\s`'"]+$/g, '');
  if (!/SELECT$/i.test(trimmed)) return false;
  if (/FROM\s*\(\s*SELECT$/i.test(trimmed)) return false; // wrapped form

  const open = text.indexOf('(', callIndex);
  if (open < 0) return true;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) return true; // unbalanced within window — treat as bare
  const after = text.slice(close + 1, close + 40);
  return !/^\s*(::\w+|IS\s+NULL)/i.test(after);
}

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

function collectViolations() {
  const violations = [];
  for (const f of walk(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, f).replace(/\\/g, '/');
    const src = readFileSync(f, 'utf8');
    if (!/pg_advisory(?:_xact)?_lock/i.test(src)) continue;
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/pg_advisory(?:_xact)?_lock\s*\(/i.test(lines[i])) continue;
      const start = Math.max(0, i - 1);
      const windowText = lines.slice(start, i + WINDOW_LINES).join('\n');
      // Judge only occurrences that BEGIN on the scan line — a window can
      // also contain the NEXT statement's call whose close paren lies past
      // the window's end, which would misread as unbalanced/bare.
      const lineStart = lines.slice(start, i).reduce((n, l) => n + l.length + 1, 0);
      const lineEnd = lineStart + lines[i].length;
      LOCK_NAME.lastIndex = 0;
      let m;
      while ((m = LOCK_NAME.exec(windowText)) !== null) {
        if (m.index < lineStart || m.index > lineEnd) continue;
        if (occurrenceViolates(windowText, m.index)) {
          violations.push(`${rel}:${i + 1} bare void advisory-lock SELECT (append ::text AS lock_acquired or wrap it)`);
          break;
        }
      }
    }
  }
  return [...new Set(violations)];
}

describe('advisory-lock void guard', () => {
  it('self-test: flags the bare form (inner $1::text cast must NOT rescue it) and accepts every house-safe idiom', () => {
    const bare = "'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',";
    let i = bare.search(/pg_advisory/);
    expect(occurrenceViolates(bare, i)).toBe(true);

    const cast = "'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired',";
    i = cast.search(/pg_advisory/);
    expect(occurrenceViolates(cast, i)).toBe(false);

    const isNull = '`SELECT pg_advisory_xact_lock(\n  hashtextextended($1::text, 0)\n) IS NULL AS lock_acquired`,';
    i = isNull.search(/pg_advisory/);
    expect(occurrenceViolates(isNull, i)).toBe(false);

    const wrapped = '`SELECT 1::int AS locked\n  FROM (SELECT pg_advisory_xact_lock($1::bigint)) AS seed_lock`,';
    i = wrapped.search(/pg_advisory/);
    expect(occurrenceViolates(wrapped, i)).toBe(false);
  });

  it('no production file SELECTs a bare void advisory lock', () => {
    expect(collectViolations()).toEqual([]);
  });
});
