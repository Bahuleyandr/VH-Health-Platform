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
 * only what FOLLOWS it — specifically a `::text` cast or `IS NULL` is safe;
 * so is a wrapped call whose outer SELECT projects only 1 or COUNT(*). Casts
 * INSIDE the argument list (hashtextextended($1::text, ...)) must not count —
 * matching them is exactly the bug that let the bare form pass this guard's
 * first draft. pg_try_advisory_lock returns boolean and is out of scope.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SQL_TRIVIA = String.raw`(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*`;
const SQL_TRIVIA_REQUIRED = String.raw`(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+`;
const SQL_IDENTIFIER = String.raw`[A-Za-z_][A-Za-z0-9_$]*`;
const SQL_TYPE_NAME = String.raw`(?:${SQL_IDENTIFIER}${SQL_TRIVIA}\.${SQL_TRIVIA})?${SQL_IDENTIFIER}`;
const LOCK_FUNCTION = String.raw`pg_advisory(?:_xact)?_lock(?:_shared)?`;
const LOCK_CALL = String.raw`(?:pg_catalog${SQL_TRIVIA}\.${SQL_TRIVIA})?${LOCK_FUNCTION}${SQL_TRIVIA}\(`;
const LOCK_NAME = new RegExp(String.raw`\b${LOCK_CALL}`, 'gi');
const LOCK_NAME_PRESENT = new RegExp(String.raw`\b${LOCK_FUNCTION}\b`, 'i');
const PROJECTED_LOCK = new RegExp(String.raw`\bSELECT${SQL_TRIVIA}$`, 'i');
const SAFE_OUTER_PROJECTION = new RegExp(
  String.raw`\bSELECT${SQL_TRIVIA}(?:1|COUNT${SQL_TRIVIA}\(${SQL_TRIVIA}\*${SQL_TRIVIA}\))` +
    String.raw`(?:${SQL_TRIVIA}::${SQL_TRIVIA}${SQL_TYPE_NAME})?` +
    String.raw`(?:${SQL_TRIVIA}(?:AS${SQL_TRIVIA_REQUIRED})?${SQL_IDENTIFIER})?` +
    String.raw`${SQL_TRIVIA}FROM${SQL_TRIVIA}\(${SQL_TRIVIA}$`,
  'i',
);
const SAFE_TEXT_CAST =
  String.raw`::${SQL_TRIVIA}(?:pg_catalog${SQL_TRIVIA}\.${SQL_TRIVIA})?` +
  String.raw`text(?![A-Za-z0-9_$.[\]])`;
const SAFE_IS_NULL = String.raw`IS${SQL_TRIVIA_REQUIRED}NULL(?![A-Za-z0-9_$])`;
const SAFE_RESULT = new RegExp(
  String.raw`^${SQL_TRIVIA}(?:${SAFE_TEXT_CAST}|${SAFE_IS_NULL})`,
  'i',
);

function matchingCloseParen(text, open) {
  let depth = 0;
  let state = 'code';
  let dollarTag = null;
  let blockDepth = 0;

  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (state === 'single-quote') {
      if (char === "'" && next === "'") i += 1;
      else if (char === '\\') i += 1;
      else if (char === "'") state = 'code';
      continue;
    }
    if (state === 'double-quote') {
      if (char === '"' && next === '"') i += 1;
      else if (char === '"') state = 'code';
      continue;
    }
    if (state === 'dollar-quote') {
      if (text.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '/' && next === '*') {
        blockDepth += 1;
        i += 1;
      } else if (char === '*' && next === '/') {
        blockDepth -= 1;
        i += 1;
        if (blockDepth === 0) state = 'code';
      }
      continue;
    }

    if (char === "'") {
      state = 'single-quote';
    } else if (char === '"') {
      state = 'double-quote';
    } else if (char === '-' && next === '-') {
      state = 'line-comment';
      i += 1;
    } else if (char === '/' && next === '*') {
      state = 'block-comment';
      blockDepth = 1;
      i += 1;
    } else if (char === '$') {
      const dollarMatch = text.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (dollarMatch) {
        dollarTag = dollarMatch[0];
        state = 'dollar-quote';
        i += dollarTag.length - 1;
      }
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function callOpenParen(text, callIndex) {
  const callAtIndex = new RegExp(String.raw`^(?:${LOCK_CALL})`, 'i').exec(text.slice(callIndex));
  if (!callAtIndex) return -1;
  return callIndex + callAtIndex[0].lastIndexOf('(');
}

function knownSafeWrappedProjection(text, innerSelectStart) {
  return SAFE_OUTER_PROJECTION.test(text.slice(Math.max(0, innerSelectStart - 1000), innerSelectStart));
}

// True when this occurrence is the bare-void shape: the projection is the
// lock call itself and nothing after its matching ')' rescues the type.
export function occurrenceViolates(text, callIndex) {
  const beforeStart = Math.max(0, callIndex - 2000);
  const before = text.slice(beforeStart, callIndex);
  // Only the projection-position form can put a void column in the result
  // set: "SELECT <call>". Wrapped subqueries are safe only when the outer
  // projection is a known constant/count shape; SELECT * still exposes void.
  const projected = PROJECTED_LOCK.exec(before);
  if (!projected) return false;
  const innerSelectStart = beforeStart + projected.index + projected[0].search(/SELECT/i);
  if (knownSafeWrappedProjection(text, innerSelectStart)) return false;

  const open = callOpenParen(text, callIndex);
  if (open < 0) return true;
  const close = matchingCloseParen(text, open);
  if (close < 0) return true;
  return !SAFE_RESULT.test(text.slice(close + 1));
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
    if (!LOCK_NAME_PRESENT.test(src)) continue;
    LOCK_NAME.lastIndex = 0;
    let m;
    while ((m = LOCK_NAME.exec(src)) !== null) {
      if (occurrenceViolates(src, m.index)) {
        const line = src.slice(0, m.index).split(/\r?\n/).length;
        violations.push(`${rel}:${line} bare void advisory-lock SELECT (append ::text AS lock_acquired or wrap it)`);
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

    const nestedBare = `SELECT pg_advisory_xact_lock(
      hashtextextended(
        'vh:pharmacy_funding_authority:' || $1::uuid::text
          || ':' || $2::uuid::text,
        753
      )
    )`;
    i = nestedBare.search(/pg_advisory/);
    expect(occurrenceViolates(nestedBare, i)).toBe(true);

    const qualifiedBare = 'SELECT pg_catalog.pg_advisory_xact_lock(42::bigint)';
    i = qualifiedBare.search(/pg_catalog/);
    expect(occurrenceViolates(qualifiedBare, i)).toBe(true);

    for (const sharedBare of [
      'SELECT pg_advisory_lock_shared(42::bigint)',
      'SELECT pg_advisory_xact_lock_shared(42::bigint)',
    ]) {
      i = sharedBare.search(/pg_advisory/);
      expect(occurrenceViolates(sharedBare, i)).toBe(true);
    }

    const cast = "'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired',";
    i = cast.search(/pg_advisory/);
    expect(occurrenceViolates(cast, i)).toBe(false);

    const voidCast = 'SELECT pg_advisory_xact_lock(42::bigint)::void';
    i = voidCast.search(/pg_advisory/);
    expect(occurrenceViolates(voidCast, i)).toBe(true);

    const quotedClose = "SELECT pg_advisory_xact_lock(hashtextextended('vh:key)', 0))::text AS lock_acquired";
    i = quotedClose.search(/pg_advisory/);
    expect(occurrenceViolates(quotedClose, i)).toBe(false);

    const commentTrivia = `SELECT pg_advisory_xact_lock(
      /* a misleading close paren: ) */ hashtextextended($1::text, 0)
    ) /* preserve the safe cast across comment trivia: ( ) */ ::pg_catalog.text AS lock_acquired`;
    i = commentTrivia.search(/pg_advisory/);
    expect(occurrenceViolates(commentTrivia, i)).toBe(false);

    const isNull = '`SELECT pg_advisory_xact_lock(\n  hashtextextended($1::text, 0)\n) IS NULL AS lock_acquired`,';
    i = isNull.search(/pg_advisory/);
    expect(occurrenceViolates(isNull, i)).toBe(false);

    const wrapped = '`SELECT 1::int AS locked\n  FROM (SELECT pg_advisory_xact_lock($1::bigint)) AS seed_lock`,';
    i = wrapped.search(/pg_advisory/);
    expect(occurrenceViolates(wrapped, i)).toBe(false);

    const counted = 'SELECT COUNT(*) FROM (SELECT pg_advisory_xact_lock($1::bigint)) AS seed_lock';
    i = counted.search(/pg_advisory/);
    expect(occurrenceViolates(counted, i)).toBe(false);

    const unsafeWrapped = 'SELECT * FROM (SELECT pg_advisory_xact_lock($1::bigint)) AS seed_lock';
    i = unsafeWrapped.search(/pg_advisory/);
    expect(occurrenceViolates(unsafeWrapped, i)).toBe(true);
  });

  it('no production file SELECTs a bare void advisory lock', () => {
    expect(collectViolations()).toEqual([]);
  });
});
