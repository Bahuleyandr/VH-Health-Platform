#!/usr/bin/env node
import logger from '../src/logging/logger.js';
// scripts/fix-raw-params.mjs
//
// Codemod: rewrite `prisma.$queryRawUnsafe(sql, [a, b, c])` and
// `$executeRawUnsafe(sql, [a, b, c])` into spread form `(sql, a, b, c)`.
// Parses balanced brackets so multi-line arrays + nested calls are handled.
//
// Idempotent — if no match is found in a file it's left alone. Skips tests
// and scripts. Prints a summary at the end. Exit 0 regardless.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

function findMatchingBracket(src, openIdx, openCh, closeCh) {
  let depth = 1;
  let inStr = null; // track ' " ` to ignore brackets inside strings
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
    } else {
      if (c === '\'' || c === '"' || c === '`') inStr = c;
      else if (c === openCh) depth++;
      else if (c === closeCh) {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }
  return -1;
}

function rewriteFile(src) {
  const re = /\.\$(queryRawUnsafe|executeRawUnsafe)\(/g;
  const patches = []; // { replaceStart, replaceEnd, newText }
  let m;
  while ((m = re.exec(src))) {
    const callOpen = m.index + m[0].length - 1; // index of '('
    const callClose = findMatchingBracket(src, callOpen, '(', ')');
    if (callClose === -1) continue;

    // Walk args from the first comma at depth-1 inside the call.
    let depth = 0;
    let inStr = null;
    let firstCommaEnd = -1;
    for (let i = callOpen + 1; i < callClose; i++) {
      const c = src[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === inStr) inStr = null;
      } else {
        if (c === '\'' || c === '"' || c === '`') inStr = c;
        else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) { firstCommaEnd = i; break; }
      }
    }
    if (firstCommaEnd === -1) continue;

    // Skip whitespace after the comma.
    let j = firstCommaEnd + 1;
    while (j < callClose && /\s/.test(src[j])) j++;
    if (src[j] !== '[') continue;

    const arrOpen = j;
    const arrClose = findMatchingBracket(src, arrOpen, '[', ']');
    if (arrClose === -1 || arrClose >= callClose) continue;

    // Check there's nothing after `]` before the closing `)` except whitespace.
    let k = arrClose + 1;
    while (k < callClose && /\s/.test(src[k])) k++;
    if (k !== callClose) continue; // array isn't the last arg — skip conservatively

    // Rewrite: remove the `[` and `]`, keep contents.
    patches.push({ start: arrOpen, end: arrOpen + 1, replaceWith: '' });
    patches.push({ start: arrClose, end: arrClose + 1, replaceWith: '' });
  }

  if (patches.length === 0) return { src, changed: 0 };

  // Apply patches in reverse so indexes stay valid.
  patches.sort((a, b) => b.start - a.start);
  let out = src;
  for (const p of patches) {
    out = out.slice(0, p.start) + p.replaceWith + out.slice(p.end);
  }
  return { src: out, changed: patches.length / 2 };
}

const files = walk('src');
let totalSites = 0;
let changedFiles = 0;

for (const f of files) {
  const orig = readFileSync(f, 'utf8');
  const { src: next, changed } = rewriteFile(orig);
  if (changed > 0 && next !== orig) {
    writeFileSync(f, next);
    logger.info(`  ${f} — ${changed} site(s)`);
    totalSites += changed;
    changedFiles++;
  }
}

logger.info(`\nCodemod complete: ${totalSites} sites rewritten across ${changedFiles} files.`);
