#!/usr/bin/env node
// scripts/lint-raw-params.mjs
//
// Grep for the `prisma.$queryRawUnsafe(sql, [array])` bug pattern across src/.
// Raw Prisma methods take spread args (...params) — an array as the second
// positional arg is interpreted as a SINGLE value, not unpacked, so every
// placeholder after $1 goes unbound. This was broken across ~70 sites before
// the 2026-04-14 drift-fix pass. Fail CI if it reappears.
//
// Standalone CLI — uses plain console.log instead of the Winston logger
// so the script doesn't have to spin up the full backend log subsystem
// just to print a one-line summary, and so it stays runnable from any
// CWD (the previous `walk('src')` only worked from `apps/backend/`).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name === 'scripts') continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(js|mjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

// Resolve `src/` relative to the script location so this lint can be
// invoked from any CWD (npm script in apps/backend/, root, or CI).
const scriptDir = dirname(fileURLToPath(import.meta.url));
const files = walk(join(scriptDir, '..', 'src'));

// Match: `.$queryRawUnsafe(anything, [`  or `.$executeRawUnsafe(anything, [`
// The `[` must start the second positional arg — we approximate with a look
// for `(...),\s*\[` on the same logical line. Template-literal `...\``
// variants are safe; only `$queryRawUnsafe`/`$executeRawUnsafe` are risky.
//
// We also flag the dynamic form `.$queryRawUnsafe(sql, params)` where the
// second-and-only positional arg is a bare identifier whose name implies an
// array (`params`, `values`, `args`, or any name ending in `Params`/`Values`/
// `Args` — case insensitive). The audit controller bug (auditQueryController.js
// 2026-05-07) hid behind this exact form: the named array bound as a single
// value, every $2+ placeholder went unbound, audit-explorer 500'd in CI smoke.
let offenders = 0;
const ARRAY_NAME_RE = /^(params|values|args|[a-z][a-zA-Z0-9_]*(?:Params|Values|Args))$/;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // Walk each `$queryRawUnsafe(` / `$executeRawUnsafe(` occurrence and check
  // whether the first arg is followed by `, [` before the matching `)`.
  const re = /\.\$(queryRawUnsafe|executeRawUnsafe)\(/g;
  let m;
  while ((m = re.exec(src))) {
    // Find the matching close paren from the opening (.
    let depth = 1;
    let i = m.index + m[0].length;
    let firstArgEnd = -1;
    let closeParen = -1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { closeParen = i; break; }
      } else if (c === ',' && depth === 1 && firstArgEnd === -1) {
        firstArgEnd = i;
      }
      i++;
    }
    if (firstArgEnd === -1) continue;
    // Skip whitespace + comments after the first comma; if we land on `[`, bad.
    let j = firstArgEnd + 1;
    while (j < src.length && /[\s\n]/.test(src[j])) j++;
    if (src[j] === '[') {
      const lineNumber = src.slice(0, m.index).split('\n').length;
      console.error(`✗ ${file}:${lineNumber} — prisma.${m[1]}(sql, [array]) — use spread (...args)`);
      offenders++;
      continue;
    }
    // Bare-identifier check: extract the second positional arg as the slice
    // from `j` to the next top-level comma or the close paren.
    let depth2 = 0;
    let secondArgEnd = closeParen;
    for (let k = j; k < closeParen; k++) {
      const c = src[k];
      if (c === '(' || c === '[' || c === '{') depth2++;
      else if (c === ')' || c === ']' || c === '}') depth2--;
      else if (c === ',' && depth2 === 0) { secondArgEnd = k; break; }
    }
    const secondArg = src.slice(j, secondArgEnd).trim();
    // Only flag when the second arg is the SOLE remaining arg AND a bare
    // array-shaped identifier — not a spread, not a function call, not a
    // member access (those are intentional / safe call shapes).
    if (secondArgEnd !== closeParen) continue;
    if (secondArg.startsWith('...')) continue;
    if (!ARRAY_NAME_RE.test(secondArg)) continue;
    const lineNumber = src.slice(0, m.index).split('\n').length;
    console.error(`✗ ${file}:${lineNumber} — prisma.${m[1]}(sql, ${secondArg}) — bare array-shaped identifier; use spread (...${secondArg})`);
    offenders++;
  }
}

// ── Second check: uncast params inside jsonb_build_object/jsonb_build_array ──
//
// A bare placeholder ($N) used as a VALUE inside jsonb_build_object(...) /
// jsonb_build_array(...) has no inferable type — the function signature is
// `VARIADIC "any"`, so Postgres can't decide what `$N` is and the query fails
// at PARSE time with SQLSTATE 42P08 "could not determine data type of parameter
// $N". Postgres reports the LOWEST-numbered unresolved param, so one 42P08 can
// hide several uncast params. The array-form check above never inspects SQL
// text, so it cannot see this class. When such a query sits behind a
// best-effort/swallowed try-catch the request still succeeds but the error is
// logged centrally by the Prisma error listener in src/lib/prisma.js. Reference
// fix: canonicalClinicalPlatformService.transitionEncounter (2026-06-13). See
// the raw-params section of apps/backend/CLAUDE.md.
//
// A param is EXONERATED when it carries a `$N::type` cast anywhere in the same
// SQL template (the type then resolves once for the whole statement), e.g. a
// param cast in a WHERE clause and reused bare inside the jsonb builder.

/** The backtick-delimited template literal enclosing `pos`, or null. */
function enclosingTemplate(src, pos) {
  const start = src.lastIndexOf('`', pos);
  const end = src.indexOf('`', pos);
  if (start === -1 || end === -1 || end < pos) return null;
  return src.slice(start + 1, end);
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const re = /jsonb_build_(?:object|array)\s*\(/g;
  const reported = new Set(); // absolute char index → dedupe nested builders
  let m;
  while ((m = re.exec(src))) {
    // Skip occurrences inside a `//` line comment (e.g. a SQL snippet in a doc
    // comment) — those aren't executed.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (src.slice(lineStart, m.index).includes('//')) continue;

    // Paren-match the builder body.
    let depth = 1;
    let i = m.index + m[0].length;
    let bodyEnd = -1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { bodyEnd = i; break; } }
      i++;
    }
    if (bodyEnd === -1) continue;

    const bodyStart = m.index + m[0].length;
    const body = src.slice(bodyStart, bodyEnd);
    const query = enclosingTemplate(src, m.index) || body;

    // Bare params in the body: `$N` NOT immediately followed by `::`.
    const paramRe = /\$(\d+)(?!::)/g;
    let p;
    while ((p = paramRe.exec(body))) {
      const absIdx = bodyStart + p.index;
      if (reported.has(absIdx)) continue; // same token seen via an outer builder
      const n = p[1];
      if (new RegExp('\\$' + n + '::').test(query)) continue; // cast elsewhere
      reported.add(absIdx);
      const lineNumber = src.slice(0, absIdx).split('\n').length;
      console.error(
        `✗ ${file}:${lineNumber} — uncast param $${n} inside jsonb_build_object/array; ` +
        `add an explicit ::type cast (Postgres can't infer it → 42P08 "could not determine data type of parameter $${n}")`,
      );
      offenders++;
    }
  }
}

if (offenders > 0) {
  console.error(`\nFAIL: ${offenders} raw-param hygiene issue(s).`);
  console.error('Array-form: change `prisma.$queryRawUnsafe(sql, [a, b])` to spread `(sql, a, b)`.');
  console.error('jsonb-cast: a bare `$N` inside jsonb_build_object/array needs an explicit `::type` cast.\n');
  process.exit(1);
}
console.log(`✓ 0 offending sites across ${files.length} files. Raw-param spread form + jsonb param casts are consistent.`);
