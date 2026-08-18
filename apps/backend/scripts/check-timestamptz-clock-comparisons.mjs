#!/usr/bin/env node
/**
 * Fail when a database timestamp is compared against the process clock through a
 * driver-materialised JS Date.
 *
 * WHY THIS EXISTS
 * The pg driver materialises a Postgres `timestamptz` as a JS Date in the
 * DATABASE SESSION timezone — for `$queryRaw*` and for the typed model delegates
 * alike. So `new Date(row.expires_at) < Date.now()` is correct only when that
 * session happens to be UTC. Several real defects shipped this way, two of them
 * FAIL-OPEN on a positive offset such as Asia/Kolkata (an expired HIU key and an
 * expired ABHA enrolment OTP were both accepted for up to 5h30m).
 *
 * Sessions are now pinned to UTC at the connection (`pinSessionTimeZoneToUrl` in
 * src/lib/prisma.js), which makes every such comparison correct today. This guard
 * is the second layer: it keeps the fragile shape from creeping back, so the
 * codebase does not silently depend on that pin.
 *
 * THE FIX this guard steers you towards: select an absolute-instant twin beside
 * the column and read it with `epochMsOrNull` from src/utils/dbInstant.js.
 *
 *     (EXTRACT(EPOCH FROM some_at) * 1000)::bigint AS some_at_epoch_ms
 *
 *     const expiry = epochMsOrNull(row.some_at_epoch_ms);
 *
 * THEN CHOOSE THE NULL BRANCH DELIBERATELY. No single idiom is right for every
 * column, and the docblock on src/utils/dbInstant.js is the arbiter. Two cases,
 * opposite answers:
 *
 *   1. AUTHORIZATION / EXPIRY GATE (consent, credential, approval, token) —
 *      absence must DENY, because you cannot establish the grant is still live:
 *
 *          if (expiry == null || expiry < Date.now()) { ... }   // treat as expired
 *
 *      as in the two ABDM consent gates in src/services/abdm/abdmService.js.
 *
 *   2. CAPABILITY / TTL FIELD, where NULL legitimately means "no expiry was
 *      configured" — absence is permissive:
 *
 *          if (expiry != null && expiry < Date.now()) { ... }
 *
 *      as in the key-material expiry in src/services/abdm/abdmHiuService.js.
 *
 * READING THE LEGACY LINE YOU ARE REPLACING (the practical tell): if it carried
 * an explicit truthiness guard, e.g.
 *
 *     if (row.expires_at && new Date(row.expires_at) < new Date())
 *
 * it was ALREADY permissive, and `!= null &&` preserves it faithfully. If it was
 * UNGUARDED it was fail-CLOSED, and only `== null ||` preserves it. That is the
 * exact line PR #881 crossed: every site it converted that had the guard stayed
 * faithful; the two UNGUARDED ABDM consent gates are the ones that flipped open.
 *
 * Never a bare `Number.isFinite`: `Number(null)` is 0 — finite, and reading as
 * 1970, i.e. "long ago". That fact cuts BOTH ways, which is exactly what makes
 * this easy to get wrong. It is why an unguarded legacy comparison such as
 * `new Date(row.expiry_date) < new Date()` was accidentally FAIL-CLOSED (a NULL
 * arrived as the epoch and compared as already expired, so the gate denied) —
 * and therefore why rewriting one to `expiry != null && ...` silently INVERTS it
 * into a fail-open. Preserving a gate's behaviour means `== null ||`, never
 * `!= null &&`. PR #881 made that slip on the nullable
 * `abdm_consents.expiry_date`, letting a consent with no expiry authorise a HIP
 * data export forever; PR #882 restored the deny branch.
 *
 * WHY IT IS CI-ONLY-DETECTABLE AS A *SHAPE*
 * CI runs a UTC database, so every one of these defects is behaviourally
 * invisible there — a relapse would ship green. Only the source shape can be
 * checked. That is also why this is a script rather than a jest assertion on
 * behaviour.
 *
 * KNOWN RECALL LIMITS (documented, not accidental)
 * The detector is tuned for zero false positives and therefore misses:
 *   - variable-mediated comparisons (`const t = row.x_at;` … `new Date(t) < …`),
 *   - bare model-delegate Dates (`session.expires_at < new Date()`, no wrapper),
 *   - `Date.parse(row.x_at)` and non-snake_case single-word timestamp columns.
 * It is a ratchet against the common shape, not a proof of absence.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

// TIMESTAMPTZ_GUARD_SRC exists so the guard's own test can run it against
// fixtures. Unset in CI, where it scans the real tree.
const backendRoot = process.env.TIMESTAMPTZ_GUARD_SRC
  ? path.resolve(process.env.TIMESTAMPTZ_GUARD_SRC)
  : path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = path.join(backendRoot, 'src');

// ── the detector ────────────────────────────────────────────────────────────
// An identifier chain (a, a.b, a?.b, a['b']) whose FINAL property looks like a
// database timestamp column: snake_case, or camelCase ending At/Date/Time/…
const OBJ = String.raw`[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\?\.|\.)[A-Za-z_$][A-Za-z0-9_$]*|\[\s*['"\`][^'"\`]*['"\`]\s*\]|\[\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\])*`;
const COL = String.raw`(?:(?:\?\.|\.)(?:[A-Za-z_$][A-Za-z0-9_$]*_[A-Za-z0-9_$]+|[A-Za-z_$][A-Za-z0-9$]*(?:At|Date|Time|Timestamp|Ts))|\[\s*['"\`][A-Za-z0-9_$]*_[A-Za-z0-9_$]+['"\`]\s*\])`;
const DBDATE = String.raw`new\s+Date\(\s*${OBJ}${COL}\s*\)(?:\.(?:getTime|valueOf)\(\))?`;
const CLOCK = String.raw`(?:Date\.now\(\)|new\s+Date\(\s*\)(?:\.(?:getTime|valueOf)\(\))?)`;
const OP = String.raw`(?:<=|>=|<|>|-|===|!==|==|!=)`;
const DETECTOR = new RegExp(
  String.raw`${DBDATE}\s*${OP}\s*${CLOCK}|${CLOCK}\s*${OP}\s*${DBDATE}`,
  'g',
);

// ── reviewed exceptions ─────────────────────────────────────────────────────
// Matched on file + a substring of the offending expression, NOT on line number,
// so ordinary edits above them do not silently invalidate an entry.
const ALLOWLIST = [
  {
    file: 'src/services/auth/otpService.js',
    match: 'session.expires_at',
    reason:
      'Prisma model delegate (otp_sessions.findFirst with select:) — a computed '
      + 'epoch column cannot be attached to a delegate read. Correct via the UTC session pin.',
  },
  {
    file: 'src/services/otpService.js',
    match: 'last.created_at',
    reason:
      'Prisma model delegate (findFirst with select: { created_at: true }) — same '
      + 'constraint as above. Correct via the UTC session pin.',
  },
  {
    file: 'src/services/emr/cdsEngine.js',
    match: 'admission.admitted_at',
    reason:
      'Prisma model delegate read — cannot carry a computed column. Correct via the '
      + 'UTC session pin. Used for a daysAdmitted display metric, not an authorisation gate.',
  },
  {
    file: 'src/services/staff/hr/onboardingService.js',
    match: 'staff.hire_date',
    reason:
      'staff.hire_date is a DATE column, not timestamptz (verified against '
      + 'information_schema), so it carries no session-timezone offset.',
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === 'tests' || name === '__tests__') continue;
      walk(p, out);
    } else if (/\.(?:js|mjs|cjs)$/.test(name) && !/\.(?:test|spec)\.[cm]?js$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

// Blank comments and string/template bodies so prose and SQL text cannot match,
// preserving byte offsets (and therefore line numbers) exactly.
function blankNonCode(source) {
  const comments = [];
  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      onComment: comments,
    });
  } catch (err) {
    // A parse failure must be an error, never a silent skip — otherwise the
    // guard degrades to zero coverage without anyone noticing.
    const e = new Error(`parse failed: ${err.message}`);
    e.parseFailure = true;
    throw e;
  }

  const chars = [...source];
  const blank = (start, end) => {
    for (let i = start; i < end && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  for (const c of comments) blank(c.start, c.end);

  // Blank string bodies, but keep bare-identifier strings so row['expires_at']
  // stays matchable.
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && typeof node.value === 'string') {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(node.value)) blank(node.start + 1, node.end - 1);
    } else if (node.type === 'TemplateElement') {
      blank(node.start, node.end);
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast);
  return chars.join('');
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

function isAllowed(rel, text) {
  return ALLOWLIST.find((a) => a.file === rel && text.includes(a.match));
}

/**
 * Find every clock comparison in one source string. Exported so the guard's own
 * test can pin both what it catches and what it deliberately ignores, without
 * needing fixture files on disk.
 */
export function scanSource(source) {
  const code = blankNonCode(source);
  const hits = [];
  DETECTOR.lastIndex = 0;
  let m;
  while ((m = DETECTOR.exec(code)) !== null) {
    hits.push({
      line: lineOf(source, m.index),
      text: source.slice(m.index, m.index + m[0].length).replace(/\s+/g, ' ').trim(),
    });
  }
  return hits;
}

export { DETECTOR, ALLOWLIST };

// Executed as a script: scan the tree and report. Importing this module (the
// guard's own test does) runs nothing, so the helpers above stay testable.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const files = walk(SRC);
  const violations = [];
  const parseFailures = [];
  const allowedHits = new Set();

  for (const abs of files) {
    const rel = path.relative(backendRoot, abs).split(path.sep).join('/');
    const source = readFileSync(abs, 'utf8');
    let hits;
    try {
      hits = scanSource(source);
    } catch (err) {
      parseFailures.push({ rel, message: err.message });
      continue;
    }
    for (const hit of hits) {
      const entry = isAllowed(rel, hit.text);
      if (entry) { allowedHits.add(`${rel}::${entry.match}`); continue; }
      violations.push({ rel, line: hit.line, text: hit.text });
    }
  }

  // A stale allowlist entry is itself a defect: it means the site was fixed (good)
  // or moved (bad) and the exception is now silently covering nothing.
  const staleAllowlist = ALLOWLIST.filter((a) => !allowedHits.has(`${a.file}::${a.match}`));

  if (parseFailures.length) {
    console.error('timestamptz clock-comparison guard: could not parse:');
    for (const f of parseFailures) console.error(`  ${f.rel}: ${f.message}`);
    process.exit(1);
  }

  if (violations.length) {
    console.error(
      `timestamptz clock-comparison guard: ${violations.length} site(s) compare a `
      + 'driver-materialised database timestamp against the process clock.\n',
    );
    for (const v of violations) console.error(`  ${v.rel}:${v.line}\n      ${v.text}`);
    console.error(
      '\nA timestamptz read back through the pg driver is shifted by the DATABASE'
      + '\nSESSION timezone, so this comparison is only correct on a UTC session.'
      + '\nSelect an absolute-instant twin and read it with epochMsOrNull:'
      + '\n    (EXTRACT(EPOCH FROM <col>) * 1000)::bigint AS <col>_epoch_ms'
      + '\n    const t = epochMsOrNull(row.<col>_epoch_ms);'
      + '\n'
      + '\nThen pick the NULL branch on purpose. src/utils/dbInstant.js is the'
      + '\narbiter; there is no one right idiom:'
      + '\n  * AUTHORIZATION / EXPIRY GATE (consent, credential, approval, token)'
      + '\n    -- absence must DENY:'
      + '\n        if (t == null || t < Date.now()) { /* treat as expired */ }'
      + '\n  * CAPABILITY / TTL field, where NULL means "no expiry configured"'
      + '\n    -- absence is permissive:'
      + '\n        if (t != null && t < Date.now()) { ... }'
      + '\n'
      + '\nTell, when converting a legacy line: if it had a truthiness guard, as in'
      + '\n"if (row.col && new Date(row.col) < ...)", it was already permissive, so'
      + '\n"!= null &&" is faithful. If it was UNGUARDED it was fail-CLOSED, and only'
      + '\n"== null ||" preserves that.'
      + '\n'
      + '\nNever a bare isFinite: Number(null) is 0, which reads as 1970. That cuts'
      + '\nBOTH ways -- it is why the unguarded legacy comparison you are replacing'
      + '\nwas accidentally FAIL-CLOSED, and so why a naive rewrite to "!= null &&"'
      + '\nsilently flips a gate OPEN. That was PR #881 on the nullable'
      + '\nabdm_consents.expiry_date; PR #882 restored the deny branch.'
      + '\n'
      + '\nIf the row comes from a Prisma model delegate a twin is impossible — add a'
      + '\nreviewed entry to ALLOWLIST in this script explaining why.\n',
    );
    process.exit(1);
  }

  if (staleAllowlist.length) {
    console.error('timestamptz clock-comparison guard: stale ALLOWLIST entries (no longer match anything):');
    for (const a of staleAllowlist) console.error(`  ${a.file} :: ${a.match}`);
    console.error('\nRemove them, or fix the path if the code moved.\n');
    process.exit(1);
  }

  console.log(
    `timestamptz clock-comparison guard passed (${files.length} files scanned, `
    + `${ALLOWLIST.length} reviewed exceptions).`,
  );

}
