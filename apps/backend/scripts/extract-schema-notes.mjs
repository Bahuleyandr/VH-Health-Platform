#!/usr/bin/env node
// scripts/extract-schema-notes.mjs
//
// Walk prisma/schema.prisma, group every `//` (NOT `///`) comment by its
// enclosing `model X {` (or `enum X {`), and emit prisma/SCHEMA_NOTES.md.
// `///` doc-comments are preserved by `prisma db pull`; plain `//` comments
// are stripped, so we capture them here before regenerating the schema.
//
// Use case: before running `prisma db pull` to regenerate schema.prisma,
// run this script to lift any newly-added `//` design comments into
// SCHEMA_NOTES.md so the rationale survives the pull.
//
// Safety: refuses to overwrite a non-empty SCHEMA_NOTES.md unless --force
// is passed. The notes file accumulates across regenerations; running this
// on a freshly-pulled (comment-less) schema would otherwise wipe history.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');
const schemaPath = join(backendRoot, 'prisma', 'schema.prisma');
const notesPath = join(backendRoot, 'prisma', 'SCHEMA_NOTES.md');

const force = process.argv.includes('--force');

const src = readFileSync(schemaPath, 'utf8').split(/\r?\n/);

const TOP_LEVEL = '__top_level__';
let currentBlock = TOP_LEVEL;
let braceDepth = 0;

const buckets = new Map();
function push(key, line, lineNo) {
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push({ line, lineNo });
}

const modelOrder = [];

for (let i = 0; i < src.length; i++) {
  const raw = src[i];
  const trimmed = raw.trim();

  if (braceDepth === 0) {
    const m = trimmed.match(/^(model|enum|view)\s+(\w+)\s*\{/);
    if (m) {
      currentBlock = `${m[1]}:${m[2]}`;
      if (!modelOrder.includes(currentBlock)) modelOrder.push(currentBlock);
      braceDepth = 1;
      continue;
    }
  }

  if (braceDepth > 0) {
    for (const ch of raw) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          currentBlock = TOP_LEVEL;
        }
      }
    }
  }

  // Single-line `//` comments only — exclude `///` (Prisma doc comments,
  // already preserved by `prisma db pull`).
  if (/^\s*\/\/(?!\/)/.test(raw)) {
    push(currentBlock, raw, i + 1);
  }
}

let md = '';
md += '# schema.prisma — design notes\n\n';
md += 'Comments captured from `prisma/schema.prisma` before regenerating it with\n';
md += '`prisma db pull`. Prisma strips `//` lines on pull (it preserves only `///`\n';
md += 'doc comments). This file holds the rationale behind columns, migrations,\n';
md += 'and design decisions that would otherwise be lost.\n\n';
md += '_Keyed by Prisma model name. `__top_level__` holds comments outside any model._\n\n';

const topLevel = buckets.get(TOP_LEVEL);
if (topLevel?.length) {
  md += '## Top-level\n\n';
  for (const { line, lineNo } of topLevel) {
    md += `- L${lineNo}: \`${line.trim()}\`\n`;
  }
  md += '\n';
}

for (const key of modelOrder) {
  const entries = buckets.get(key);
  if (!entries?.length) continue;
  md += `## ${key}\n\n`;
  let group = [];
  let lastLineNo = -10;
  for (const { line, lineNo } of entries) {
    if (lineNo - lastLineNo > 1 && group.length) {
      md += '> ' + group.map((g) => g.line.trim().replace(/^\/\/\s?/, '')).join('\n> ') + '\n\n';
      group = [];
    }
    group.push({ line, lineNo });
    lastLineNo = lineNo;
  }
  if (group.length) {
    md += '> ' + group.map((g) => g.line.trim().replace(/^\/\/\s?/, '')).join('\n> ') + '\n\n';
  }
}

const totalComments = [...buckets.values()].reduce((a, b) => a + b.length, 0);

if (existsSync(notesPath) && !force) {
  const existing = readFileSync(notesPath, 'utf8');
  const existingComments = (existing.match(/^> /gm) || []).length;
  if (existingComments > totalComments) {
    console.error(
      `Refusing to overwrite ${notesPath}: existing file has ${existingComments} comment lines, ` +
      `but the current schema.prisma only yields ${totalComments}. ` +
      `This usually means the schema was already regenerated via prisma db pull (which strips // comments). ` +
      `Pass --force to overwrite anyway.`,
    );
    process.exit(1);
  }
}

writeFileSync(notesPath, md);
console.log(`Wrote ${notesPath} — ${buckets.size} block(s), ${totalComments} comment line(s).`);
