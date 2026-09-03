#!/usr/bin/env node
// Inline CHECK census gate (audit row OPEN-23, detection half).
//
// Migrations apply sorted by name and 000_baseline.sql runs first. A later
// migration that re-declares a baseline-owned table with
// `CREATE TABLE IF NOT EXISTS` is a no-op for the table, so every inline CHECK
// in that declaration is discarded silently and has never existed in any
// database. The baseline is a pg_dump of a `prisma db push` bootstrap, which
// cannot express CHECKs, so regenerating it reproduces the loss.
//
// This gate keeps a pinned census of those clauses
// (scripts/ci/inline-check-census.json) and has two halves:
//
//   static (security stage, unconditional):
//     rebuild the census from the migration files; fail when a NEW inline CHECK
//     appears in a re-declaration of a baseline-owned table (it will never
//     exist — use ALTER TABLE ... ADD CONSTRAINT in a forward migration), when
//     a declared constraint disappears or its clause changes, or when the count
//     of absent entries no longer equals `expectedAbsentCount`.
//
//   calibration (backend job, after ci-setup-db; `--verify-db`):
//     for every entry, presence in pg_constraint must equal the entry's
//     `enforced` flag, in BOTH directions. Presence is tested by the name
//     Postgres assigns (or the declared CONSTRAINT name), falling back to an
//     expression fingerprint so a constraint added under another name counts.
//
// Shrinking the census is a manifest-only edit: when a forward migration adds
// the constraint, flip the entry's `enforced` to true and decrement
// `expectedAbsentCount`; the calibration confirms it. Remediation is rewarded,
// never blocked.
//
// Design note: docs/superpowers/specs/2026-09-03-inline-check-census-gate-design.md
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './lib.mjs';
import {
  parseCheckDefinition,
  referencedColumns,
  tokenizeCheckExpression,
} from '../../apps/backend/scripts/lib/checkConstraintValues.mjs';

export const manifestPath = resolve(repoRoot, 'scripts/ci/inline-check-census.json');
export const migrationsDir = resolve(repoRoot, 'apps/backend/src/migrations');
export const BASELINE_FILE = '000_baseline.sql';

// ---------------------------------------------------------------------------
// SQL scanning: comments dropped, string and dollar-quoted literals preserved
// as opaque runs so nothing inside them is ever read as syntax.
// ---------------------------------------------------------------------------

function stripComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === "'") {
      const end = closeQuote(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close < 0 ? n : close + tag[0].length;
        out += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Index just past the closing quote of the string literal opening at `start`.
function closeQuote(text, start) {
  let j = start + 1;
  while (j < text.length) {
    if (text[j] === "'" && text[j + 1] === "'") {
      j += 2;
      continue;
    }
    if (text[j] === "'") return j + 1;
    j += 1;
  }
  return text.length;
}

// Index of the parenthesis that balances the one at `open`.
function balance(text, open) {
  let depth = 0;
  for (let k = open; k < text.length; k += 1) {
    const c = text[k];
    if (c === "'") {
      k = closeQuote(text, k) - 1;
      continue;
    }
    if (c === '$') {
      const tag = text.slice(k).match(/^\$[A-Za-z_]*\$/);
      if (tag) {
        const close = text.indexOf(tag[0], k + tag[0].length);
        k = close < 0 ? text.length : close + tag[0].length - 1;
        continue;
      }
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return text.length;
}

const CREATE_TABLE =
  /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi;

function findCreateTables(sql) {
  const text = stripComments(sql);
  const out = [];
  CREATE_TABLE.lastIndex = 0;
  let match = CREATE_TABLE.exec(text);
  while (match) {
    const open = match.index + match[0].length - 1;
    const close = balance(text, open);
    out.push({
      table: match[2].toLowerCase(),
      ifNotExists: Boolean(match[1]),
      body: text.slice(open + 1, close),
    });
    CREATE_TABLE.lastIndex = close;
    match = CREATE_TABLE.exec(text);
  }
  return out;
}

function splitTopLevel(body) {
  const items = [];
  let depth = 0;
  let current = '';
  for (let k = 0; k < body.length; k += 1) {
    const c = body[k];
    if (c === "'") {
      const end = closeQuote(body, k);
      current += body.slice(k, end);
      k = end - 1;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

const TABLE_CONSTRAINT_START = /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|LIKE)\b/i;

// Every CHECK clause in one column definition or table-constraint item.
function extractChecks(item) {
  const text = item.replace(/\s+/g, ' ').trim();
  const tableLevel = TABLE_CONSTRAINT_START.test(text);
  const column = tableLevel
    ? null
    : (text.match(/^"?([A-Za-z_][A-Za-z0-9_]*)"?/)?.[1]?.toLowerCase() ?? null);
  const results = [];
  let k = 0;
  while (k < text.length) {
    if (text[k] === "'") {
      k = closeQuote(text, k);
      continue;
    }
    const rest = text.slice(k);
    const match = rest.match(/^(?:CONSTRAINT\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+)?CHECK\s*\(/i);
    const wordBoundary = k === 0 || !/[A-Za-z0-9_]/.test(text[k - 1]);
    if (match && wordBoundary) {
      const open = k + match[0].length - 1;
      const close = balance(text, open);
      results.push({
        kind: tableLevel ? 'table' : 'column',
        column,
        declaredName: match[1] ? match[1].toLowerCase() : null,
        clause: text.slice(open + 1, close).trim(),
      });
      k = close + 1;
      continue;
    }
    k += 1;
  }
  return results;
}

// ---------------------------------------------------------------------------
// The name Postgres assigns to an unnamed CHECK: <table>_<column>_check when the
// expression references exactly one column, else <table>_check; truncated by
// makeObjectName to 63 bytes; numbered on collision within the table.
// ---------------------------------------------------------------------------

function makeObjectName(name1, name2, label) {
  const NAMEDATALEN = 64;
  let n1 = Buffer.byteLength(name1);
  let n2 = name2 ? Buffer.byteLength(name2) : 0;
  const overhead = Buffer.byteLength(label) + 1 + (name2 ? 1 : 0);
  const available = NAMEDATALEN - 1 - overhead;
  while (n1 + n2 > available) {
    if (n1 > n2) n1 -= 1;
    else n2 -= 1;
  }
  const first = name1.slice(0, n1);
  if (!name2) return `${first}_${label}`;
  return `${first}_${name2.slice(0, n2)}_${label}`;
}

function columnsOf(clause) {
  try {
    return [...referencedColumns(parseCheckDefinition(`CHECK (${clause})`))];
  } catch {
    return [];
  }
}

/** Sorted referenced columns plus sorted literals: equal for a source clause and its deparsed form. */
export function expressionFingerprint(expression) {
  let tokens;
  try {
    tokens = tokenizeCheckExpression(
      expression.replace(/\s+(NOT\s+VALID|NO\s+INHERIT)\s*$/i, '').replace(/^CHECK\s*\((.*)\)$/is, '$1'),
    );
  } catch {
    return null;
  }
  const idents = new Set();
  const literals = [];
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    if (token.type === 'ident' && !(next && next.type === 'punct' && next.value === '(')) {
      idents.add(token.value);
    }
    if (token.type === 'string' || token.type === 'number') literals.push(String(token.value));
  });
  return `${[...idents].sort().join(',')}|${literals.sort().join(',')}`;
}

export function clauseDigest(clause) {
  return createHash('sha256').update(clause.replace(/\s+/g, ' ').trim()).digest('hex');
}

// ---------------------------------------------------------------------------
// Inventory and census
// ---------------------------------------------------------------------------

function baselineTablesOf(dir) {
  const sql = readFileSync(join(dir, BASELINE_FILE), 'utf8');
  return new Set(
    [...sql.matchAll(/^CREATE TABLE public\.("?)([A-Za-z_][A-Za-z0-9_]*)\1 \(/gm)].map((m) =>
      m[2].toLowerCase(),
    ),
  );
}

export function entryId(entry) {
  return `${entry.file}#${entry.table}#${entry.constraintName}`;
}

/**
 * Scan every migration for inline CHECKs.
 * inventory: every inline CHECK in a CREATE TABLE statement.
 * census: those inside `IF NOT EXISTS` re-declarations of baseline-owned tables.
 */
export function scanInlineChecks({ migrationsDir: dir = migrationsDir } = {}) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const baselineTables = baselineTablesOf(dir);
  const inventory = [];
  for (const file of files) {
    if (file === BASELINE_FILE) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const statement of findCreateTables(sql)) {
      const collisions = new Map();
      const inCensus = statement.ifNotExists && baselineTables.has(statement.table);
      for (const item of splitTopLevel(statement.body)) {
        for (const check of extractChecks(item)) {
          let constraintName = check.declaredName;
          if (!constraintName) {
            const columns = columnsOf(check.clause);
            const base =
              columns.length === 1
                ? makeObjectName(statement.table, columns[0], 'check')
                : makeObjectName(statement.table, null, 'check');
            const ordinal = collisions.get(base) || 0;
            collisions.set(base, ordinal + 1);
            constraintName = ordinal ? `${base}${ordinal}` : base;
          }
          inventory.push({
            file,
            table: statement.table,
            kind: check.kind,
            column: check.column,
            constraintName,
            clause: check.clause,
            clauseSha256: clauseDigest(check.clause),
            inCensus,
          });
        }
      }
    }
  }
  const census = inventory.filter((entry) => entry.inCensus);
  return { inventory, census, baselineTables };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function presenceIndex(constraintRows) {
  const byName = new Set();
  const byFingerprint = new Set();
  for (const row of constraintRows) {
    byName.add(`${row.table}.${row.conname}`);
    const fingerprint = expressionFingerprint(row.definition || '');
    if (fingerprint) byFingerprint.add(`${row.table}|${fingerprint}`);
  }
  return {
    has(entry) {
      if (byName.has(`${entry.table}.${entry.constraintName}`)) return true;
      const fingerprint = expressionFingerprint(entry.clause);
      return fingerprint !== null && byFingerprint.has(`${entry.table}|${fingerprint}`);
    },
  };
}

export function buildManifest({ census, constraintRows, evidence }) {
  const present = presenceIndex(constraintRows);
  const entries = census.map((entry) => ({
    id: entryId(entry),
    file: entry.file,
    table: entry.table,
    kind: entry.kind,
    column: entry.column,
    constraintName: entry.constraintName,
    clauseSha256: entry.clauseSha256,
    clause: entry.clause,
    enforced: present.has(entry),
  }));
  return {
    schemaVersion: 1,
    evidence: {
      baseline: `apps/backend/src/migrations/${BASELINE_FILE}`,
      ledger: evidence?.ledger ?? 'docs/FULL_REPOSITORY_AUDIT_2026_08.md',
      generatedFromHead: evidence?.generatedFromHead ?? null,
    },
    expectedAbsentCount: entries.filter((entry) => !entry.enforced).length,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Static gate
// ---------------------------------------------------------------------------

export function evaluateStaticCensus({ migrationsDir: dir = migrationsDir, manifest }) {
  const violations = [];
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    return ['manifest must be a schemaVersion 1 object with an entries array'];
  }
  const { census } = scanInlineChecks({ migrationsDir: dir });
  const pinned = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const live = new Map(census.map((entry) => [entryId(entry), entry]));
  for (const [id, entry] of live) {
    if (!pinned.has(id)) {
      violations.push(
        `new inline CHECK in a re-declaration of a baseline-owned table: ${entry.file} ${entry.table} ` +
          `${entry.constraintName} (${entry.clause.slice(0, 80)}) — it will never exist; add it with ` +
          `ALTER TABLE ${entry.table} ADD CONSTRAINT ... CHECK (...) in a forward migration`,
      );
    }
  }
  for (const [id, entry] of pinned) {
    const current = live.get(id);
    if (!current) {
      violations.push(
        `declared constraint removed from an applied migration: ${entry.file} ${entry.table} ${entry.constraintName}`,
      );
    } else if (current.clauseSha256 !== entry.clauseSha256) {
      violations.push(
        `declared constraint changed in an applied migration: ${entry.file} ${entry.table} ${entry.constraintName}`,
      );
    }
  }
  const absent = manifest.entries.filter((entry) => !entry.enforced).length;
  if (absent !== manifest.expectedAbsentCount) {
    violations.push(
      `expectedAbsentCount ${manifest.expectedAbsentCount} does not match the ${absent} entries marked enforced: false` +
        ' — a real fix flips the entry AND decrements the count in the same change',
    );
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Calibration against pg_constraint (both directions)
// ---------------------------------------------------------------------------

export function evaluateDatabaseCalibration({ manifest, constraintRows }) {
  const present = presenceIndex(constraintRows);
  const discrepancies = [];
  for (const entry of manifest.entries) {
    const actual = present.has(entry);
    if (entry.enforced && !actual) {
      discrepancies.push(
        `${entry.table}.${entry.constraintName} (${entry.file}) is marked enforced but is absent from pg_constraint`,
      );
    } else if (!entry.enforced && actual) {
      discrepancies.push(
        `${entry.table}.${entry.constraintName} (${entry.file}) is marked absent but is present in pg_constraint` +
          ' — flip enforced to true and decrement expectedAbsentCount',
      );
    }
  }
  return discrepancies;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function renderTableReport(manifest) {
  const byTable = new Map();
  for (const entry of manifest.entries) {
    const group = byTable.get(entry.table) || { absent: 0, enforced: 0, files: new Set(), entries: [] };
    group[entry.enforced ? 'enforced' : 'absent'] += 1;
    group.files.add(entry.file);
    group.entries.push(entry);
    byTable.set(entry.table, group);
  }
  const lines = [];
  const ordered = [...byTable.entries()].sort((a, b) => b[1].absent - a[1].absent || a[0].localeCompare(b[0]));
  for (const [table, group] of ordered) {
    lines.push(`${table} absent=${group.absent} enforced=${group.enforced} files=${[...group.files].join(',')}`);
    for (const entry of group.entries) {
      lines.push(`  ${entry.enforced ? 'ok     ' : 'ABSENT '} ${entry.constraintName}: ${entry.clause}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function loadConstraintRows() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for --verify-db / --write-manifest');
  const require = createRequire(resolve(repoRoot, 'apps/backend/package.json'));
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT conrelid::regclass::text AS table, conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE contype = 'c'
          AND connamespace = 'public'::regnamespace`,
    );
    return result.rows.map((row) => ({
      table: String(row.table).replace(/^public\./, '').replace(/"/g, ''),
      conname: row.conname,
      definition: row.definition,
    }));
  } finally {
    await client.end();
  }
}

function summarize(manifest) {
  const tables = new Set(manifest.entries.map((entry) => entry.table));
  const absentTables = new Set(manifest.entries.filter((entry) => !entry.enforced).map((entry) => entry.table));
  const absentFiles = new Set(manifest.entries.filter((entry) => !entry.enforced).map((entry) => entry.file));
  return (
    `Inline CHECK census: ${manifest.entries.length} clauses in ${tables.size} tables; ` +
    `${manifest.expectedAbsentCount} absent in ${absentTables.size} tables and ${absentFiles.size} files; ` +
    `${manifest.entries.length - manifest.expectedAbsentCount} enforced.`
  );
}

export async function main(argv = process.argv.slice(2)) {
  const verifyDb = argv.includes('--verify-db');
  const report = argv.includes('--report');
  const write = argv.includes('--write-manifest');

  if (write) {
    const { census } = scanInlineChecks();
    const constraintRows = await loadConstraintRows();
    let head = null;
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      head = null;
    }
    const manifest = buildManifest({ census, constraintRows, evidence: { generatedFromHead: head } });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${manifestPath}`);
    console.log(summarize(manifest));
    return 0;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const violations = evaluateStaticCensus({ manifest });
  if (report) console.log(renderTableReport(manifest));
  console.log(summarize(manifest));

  let discrepancies = [];
  if (verifyDb) {
    const constraintRows = await loadConstraintRows();
    discrepancies = evaluateDatabaseCalibration({ manifest, constraintRows });
    console.log(
      `Calibration against pg_constraint (${constraintRows.length} CHECK constraints): ${discrepancies.length} discrepancies.`,
    );
  }

  const problems = [...violations, ...discrepancies];
  if (problems.length) {
    console.error('Inline CHECK census gate failed:');
    for (const problem of problems) console.error(`- ${problem}`);
    return 1;
  }
  console.log('Inline CHECK census gate passed.');
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 2;
    });
}
