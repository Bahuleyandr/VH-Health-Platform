#!/usr/bin/env node
import logger from '../src/logging/logger.js';
// scripts/lint-raw-params.mjs
//
// Grep for the `prisma.$queryRawUnsafe(sql, [array])` bug pattern across src/.
// Raw Prisma methods take spread args (...params) — an array as the second
// positional arg is interpreted as a SINGLE value, not unpacked, so every
// placeholder after $1 goes unbound. This was broken across ~70 sites before
// the 2026-04-14 drift-fix pass. Fail CI if it reappears.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

const files = walk('src');

// Match: `.$queryRawUnsafe(anything, [`  or `.$executeRawUnsafe(anything, [`
// The `[` must start the second positional arg — we approximate with a look
// for `(...),\s*\[` on the same logical line. Template-literal `...\``
// variants are safe; only `$queryRawUnsafe`/`$executeRawUnsafe` are risky.
const BAD = /\.\$(queryRawUnsafe|executeRawUnsafe)\([\s\S]*?,\s*\[/;

let offenders = 0;
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
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
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
    }
  }
}

if (offenders > 0) {
  console.error(`\nFAIL: ${offenders} site(s) using the broken array-param form.`);
  console.error('Fix: change `prisma.$queryRawUnsafe(sql, [a, b])` to `prisma.$queryRawUnsafe(sql, a, b)`.\n');
  process.exit(1);
}
logger.info(`✓ 0 offending sites across ${files.length} files. Raw-param spread form is consistent.`);
