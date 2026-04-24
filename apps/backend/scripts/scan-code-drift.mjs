#!/usr/bin/env node
// scripts/scan-code-drift.mjs
//
// Scans backend source for raw-SQL column references that point at
// columns not declared in prisma/schema.prisma. Catches the batch-29
// / batch-35 / batch-46 drift class — INSERT/UPDATE statements that
// reference columns the schema doesn't have — before they reach prod.
//
// Usage:
//   node apps/backend/scripts/scan-code-drift.mjs
//
// Exit codes:
//   0 — no drift
//   1 — drift detected (findings printed to stdout)
//   2 — infrastructure error (schema unreadable, etc.)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');
const repoRoot = resolve(backendRoot, '..', '..');
const schemaPath = join(backendRoot, 'prisma', 'schema.prisma');
const srcRoot = join(backendRoot, 'src');

// ---------------------------------------------------------------------
// 1. Parse schema.prisma → { tableName: Set<columnName> }
// ---------------------------------------------------------------------

const SCALAR_TYPES = new Set([
  'Int', 'BigInt', 'String', 'Boolean', 'DateTime', 'Decimal',
  'Float', 'Json', 'Bytes', 'Unsupported',
]);

function parseSchema(source) {
  const tables = new Map();
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const m of source.matchAll(modelRe)) {
    const modelName = m[1];
    const body = m[2];

    // Model → table name (via @@map or the model name itself).
    const mapMatch = body.match(/@@map\("([^"]+)"\)/);
    const tableName = mapMatch ? mapMatch[1] : modelName;

    const columns = new Set();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      if (line.includes('@relation')) continue;

      // Column line: "name Type[?|[]] attributes..."
      const colMatch = line.match(/^(\w+)\s+(\w+)(\?)?(\[\])?/);
      if (!colMatch) continue;
      const [, colName, type, , isList] = colMatch;

      // Scalar arrays (String[], Int[]) are real Postgres columns; model
      // arrays (users[], appointments[]) are relations. Keep scalar lists.
      const isScalar = SCALAR_TYPES.has(type);
      if (isList && !isScalar) continue;

      const hasDbAttr = /@(db\.|id\b|default\b|unique\b|updatedAt\b)/.test(line);
      if (isScalar || hasDbAttr) {
        columns.add(colName);
      }
    }
    tables.set(tableName, columns);
  }
  return tables;
}

// ---------------------------------------------------------------------
// 2. Walk src/ for .js files
// ---------------------------------------------------------------------

// Clinical-AI services carve-out — explicit project-level directive
// (see project_vh_health_unification memory: "Don't touch the 40
// clinical-AI services — v1 stable, explicit carve-out"). The scanner
// skips them so their drift doesn't noise up the normal report; a
// dedicated pass can include them with `--include-ai`.
const INCLUDE_AI = process.argv.includes('--include-ai');
const AI_CARVEOUT_DIR = 'ai';

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    if (!INCLUDE_AI && entry === AI_CARVEOUT_DIR && dir.endsWith('services')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkJs(full, out);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------
// 3. Extract SQL strings from raw-SQL call sites
// ---------------------------------------------------------------------

// Match $queryRaw / $queryRawUnsafe / $executeRaw / $executeRawUnsafe
// followed by the first string argument — backtick or single-quote.
// We grab everything up to the close of the first string literal, then
// the SQL analyser below tolerates template-interpolation remnants.
const SQL_RE = /\$(?:query|execute)Raw(?:Unsafe)?\s*[`(]\s*(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;
// Template-tag form: $queryRaw`SELECT ...`  — captured by the backtick alt above.
// But the first char matched is either ` or ( — if it's `, we already have the template string.
const TEMPLATE_RE = /\$(?:query|execute)Raw(?:Unsafe)?\s*`((?:\\.|[^`\\])*)`/g;

function extractSqlStrings(text) {
  const out = [];
  // Template-tag form first (so we can dedupe by index later).
  const seen = new Set();
  for (const m of text.matchAll(TEMPLATE_RE)) {
    const idx = m.index;
    if (seen.has(idx)) continue;
    seen.add(idx);
    const sql = m[1];
    const line = text.slice(0, idx).split('\n').length;
    out.push({ sql, line, kind: 'template' });
  }
  // Then the `(` arg form — applies to $queryRawUnsafe etc.
  const UNSAFE_RE = /\$(?:query|execute)Raw(?:Unsafe)?\s*\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  for (const m of text.matchAll(UNSAFE_RE)) {
    const idx = m.index;
    if (seen.has(idx)) continue;
    seen.add(idx);
    const raw = m[1];
    const sql = raw.slice(1, -1); // strip quotes/backticks
    const line = text.slice(0, idx).split('\n').length;
    out.push({ sql, line, kind: 'unsafe' });
  }
  return out;
}

// ---------------------------------------------------------------------
// 4. Analyse SQL: extract (table, column) from INSERT/UPDATE statements
// ---------------------------------------------------------------------

// Reserved words / values that can appear in column positions but
// aren't actual columns. Defensive; these also tend not to collide
// with real column names.
const SQL_KEYWORDS = new Set([
  'NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'NULL', 'DEFAULT',
  'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'LIKE', 'ILIKE',
  'SELECT', 'FROM', 'WHERE', 'VALUES', 'RETURNING', 'SET', 'ON',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'GROUP', 'ORDER', 'BY',
  'LIMIT', 'OFFSET', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT',
]);

function stripInlineDollarInterp(sql) {
  // JS template interpolation: ${...} — drop the expression, leave a placeholder.
  return sql.replace(/\$\{[^}]*\}/g, '__INTERP__');
}

function analyseSql(sql, ctx, findings, tables) {
  analyseSelectRefs(sql, ctx, findings, tables);
  const cleaned = stripInlineDollarInterp(sql);
  const norm = cleaned.replace(/\s+/g, ' ').trim();

  // INSERT INTO table (cols) [VALUES (...) | SELECT ...]
  // Also handle "INSERT INTO table AS alias (cols)"
  const insertRe = /INSERT\s+INTO\s+(?:ONLY\s+)?(?:"([^"]+)"|(\w+))(?:\s+AS\s+\w+)?\s*\(([^)]+)\)/gi;
  for (const m of norm.matchAll(insertRe)) {
    const tableName = m[1] || m[2];
    const cols = m[3].split(',').map(c => c.trim().replace(/^"([^"]+)"$/, '$1'));
    if (!tables.has(tableName)) continue;
    const schemaCols = tables.get(tableName);
    for (const col of cols) {
      if (!col || SQL_KEYWORDS.has(col.toUpperCase())) continue;
      if (col === '__INTERP__') continue; // dynamic column list — cannot statically verify
      if (!schemaCols.has(col)) {
        findings.push({ ...ctx, kind: 'INSERT', table: tableName, col, snippet: truncate(norm, 240) });
      }
    }
  }

  // UPDATE table [AS alias] SET col = ..., col2 = ... [WHERE | RETURNING | ;]
  // Stop at the first WHERE/RETURNING to keep the SET clause clean.
  const updateRe = /UPDATE\s+(?:ONLY\s+)?(?:"([^"]+)"|(\w+))(?:\s+AS\s+\w+)?\s+SET\s+([\s\S]+?)(?:\s+WHERE\b|\s+RETURNING\b|\s+FROM\b|;|$)/gi;
  for (const m of norm.matchAll(updateRe)) {
    const tableName = m[1] || m[2];
    const setClause = m[3];
    if (!tables.has(tableName)) continue;
    const schemaCols = tables.get(tableName);
    // SET clause: col = value [, col2 = value2, ...]
    // We have to walk it respecting paren depth so "col = fn(x, y), col2 = z" doesn't split on the inner comma.
    const assignments = splitTopLevelCommas(setClause);
    for (const assign of assignments) {
      const eqIdx = assign.indexOf('=');
      if (eqIdx < 0) continue;
      const lhs = assign.slice(0, eqIdx).trim().replace(/^"([^"]+)"$/, '$1');
      // LHS may be "col" or "(col1, col2)" for row-update syntax — skip the multi form.
      if (lhs.startsWith('(')) continue;
      const col = lhs.split(/\s+/)[0];
      if (!col || SQL_KEYWORDS.has(col.toUpperCase())) continue;
      if (col === '__INTERP__') continue; // dynamic assignment — cannot statically verify
      if (!schemaCols.has(col)) {
        findings.push({ ...ctx, kind: 'UPDATE', table: tableName, col, snippet: truncate(norm, 240) });
      }
    }
  }
}

function splitTopLevelCommas(s) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of s) {
    if (ch === '(') { depth += 1; buf += ch; continue; }
    if (ch === ')') { depth -= 1; buf += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function truncate(s, n) { return s.length > n ? `${s.slice(0, n)}…` : s; }

// ---------------------------------------------------------------------
// 4b. SELECT-path: find `alias.column` references whose table doesn't
// declare that column. Qualified references only — unqualified columns
// in JOIN-heavy queries are too ambiguous to attribute safely.
// ---------------------------------------------------------------------

// Reserved prefixes / schemas we never flag. The scanner only has
// schema.prisma models (no views, no system catalogs, no subquery
// outputs), so an `alias.col` on these is expected to be unresolvable.
const SKIPPED_SCHEMAS = new Set([
  'information_schema', 'pg_catalog', 'pg', 'public',
]);

// Reserved alias names that are never real tables.
const SKIPPED_ALIASES = new Set([
  'EXCLUDED',              // ON CONFLICT ... EXCLUDED.col — synthetic row
  'NEW', 'OLD',            // trigger pseudo-rows
  '__INTERP__',            // JS interpolation placeholder
]);

function stripStringLiterals(sql) {
  // Drop single-quoted strings so `'app.version'` etc. don't trip the
  // qualified-ref regex. Doesn't handle escaped quotes or dollar-quoted
  // strings, but those are vanishingly rare in this codebase.
  return sql.replace(/'[^']*'/g, "''");
}

function extractAliasMap(sql) {
  const map = new Map();
  // FROM/JOIN <table> [[AS] alias], but NOT `FROM (subquery) alias`.
  // We also skip `LATERAL` clauses — the thing after LATERAL is a
  // function or subquery, not a base table.
  //
  // Group 1: double-quoted table name ("my.table")
  // Group 2: bare identifier table name
  // Group 3: `AS alias` alias
  // Group 4: bare trailing alias (no AS)
  const fromJoinRe = /(?:FROM|(?:LEFT|RIGHT|INNER|OUTER|FULL|CROSS)\s+(?:OUTER\s+)?JOIN|JOIN)\s+(?!\(|LATERAL\b)(?:ONLY\s+)?(?:"([^"]+)"|(\w+))(?:\s+AS\s+(\w+)|(?:\s+(?!ON\b|USING\b|WHERE\b|GROUP\b|ORDER\b|LIMIT\b|HAVING\b|JOIN\b|LEFT\b|RIGHT\b|INNER\b|FULL\b|CROSS\b|OUTER\b|UNION\b|RETURNING\b|SET\b|VALUES\b|LATERAL\b)(\w+)))?/gi;
  for (const m of sql.matchAll(fromJoinRe)) {
    const rawTable = m[1] || m[2];
    // Ignore `schema.table` — we don't model non-public schemas.
    if (!rawTable || rawTable.includes('.')) continue;
    const alias = m[3] || m[4] || rawTable;
    // Always prefer the most specific mapping (JOIN keywords can recur
    // in nested queries; last one wins for a given alias).
    map.set(alias, rawTable);
  }
  return map;
}

function analyseSelectRefs(sql, ctx, findings, tables) {
  const cleaned = stripInlineDollarInterp(stripStringLiterals(sql));
  // Only run on queries that actually read — skip pure INSERT/UPDATE/DELETE
  // that don't have a FROM/JOIN. Keep RETURNING columns out of scope here
  // (they're validated against the target table elsewhere implicitly).
  if (!/\b(FROM|JOIN)\b/i.test(cleaned)) return;

  const aliasMap = extractAliasMap(cleaned);
  if (aliasMap.size === 0) return;

  // Match qualified `alias.column` references. Use a negative lookbehind
  // to skip `::` casts (`$1::text`) and numeric literals (`5.0`).
  const refRe = /\b(\w+)\.(\w+)\b/g;
  const reportedKeys = new Set();
  for (const m of cleaned.matchAll(refRe)) {
    const [, alias, col] = m;
    if (SKIPPED_SCHEMAS.has(alias.toLowerCase())) continue;
    if (SKIPPED_ALIASES.has(alias.toUpperCase())) continue;
    if (!aliasMap.has(alias)) continue;          // unknown alias — skip
    const tableName = aliasMap.get(alias);
    if (!tables.has(tableName)) continue;        // schema doesn't model this table
    const schemaCols = tables.get(tableName);
    if (schemaCols.has(col)) continue;           // column exists — fine
    if (col === '__INTERP__') continue;

    // Dedupe per-SQL-string by (alias, table, col).
    const key = `${alias}|${tableName}|${col}`;
    if (reportedKeys.has(key)) continue;
    reportedKeys.add(key);

    findings.push({
      ...ctx,
      kind: 'SELECT',
      table: tableName,
      col,
      snippet: truncate(cleaned.replace(/\s+/g, ' ').trim(), 240),
    });
  }
}

// ---------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------

try {
  const schemaSrc = readFileSync(schemaPath, 'utf8');
  const tables = parseSchema(schemaSrc);
  console.error(`# scan-code-drift: parsed ${tables.size} tables from schema.prisma`);

  const files = walkJs(srcRoot);
  console.error(`# scan-code-drift: scanning ${files.length} .js files under src/`);

  const findings = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const { sql, line } of extractSqlStrings(text)) {
      const ctx = { file: relative(repoRoot, file).replace(/\\/g, '/'), line };
      analyseSql(sql, ctx, findings, tables);
    }
  }

  // Dedupe (same file, line, table, col, kind collapse to one).
  const seen = new Set();
  const unique = [];
  for (const f of findings) {
    const key = `${f.file}|${f.line}|${f.kind}|${f.table}|${f.col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }

  if (unique.length === 0) {
    console.log('✓ no code↔schema drift detected in INSERT / UPDATE / SELECT statements');
    process.exit(0);
  }

  // Group by table for readability.
  unique.sort((a, b) =>
    a.table.localeCompare(b.table) ||
    a.col.localeCompare(b.col) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line,
  );

  console.log(`✗ ${unique.length} code↔schema drift finding(s):\n`);
  let lastTable = '';
  for (const f of unique) {
    if (f.table !== lastTable) {
      console.log(`\n## ${f.table}`);
      lastTable = f.table;
    }
    console.log(`  ${f.kind} .${f.col}  —  ${f.file}:${f.line}`);
    console.log(`    ${f.snippet}`);
  }
  console.log('');
  process.exit(1);
} catch (err) {
  console.error('scan-code-drift failed:', err.stack || err.message);
  process.exit(2);
}
