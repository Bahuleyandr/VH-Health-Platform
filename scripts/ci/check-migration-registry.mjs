#!/usr/bin/env node
/**
 * The playbook's migration-number registry must cover every migration on disk.
 *
 * WHY THIS EXISTS
 *
 * `docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md` §5 is "the only allocation
 * authority" for migration numbers, and `build-prompts/_worker-common.md` points
 * every worker at it ("never ls-and-take"). Nothing enforced that. By 2026-09-08
 * the registry still ended at `579+ UNASSIGNED` while
 * `apps/backend/src/migrations` had reached 790: 182 files (580–790) had been
 * allocated in PR bodies, design specs and chat, and the live blocks
 * 769–779 / 780–789 / 790–799 / 800–803 existed only in one spec, one plan and
 * a ruling file. A registry nobody has to update is not an authority.
 *
 * THE RULE
 *
 * Every numeric-prefixed migration file must fall inside a number or range that
 * a §5 table row lists — a shipped row or a live block. Gaps (numbers with no
 * file) are fine: they are released reservations and the registry says so.
 * An open-ended row such as `804+ UNASSIGNED` covers nothing; if it did, the
 * gate would be vacuous. Landing a migration therefore means adding or
 * extending a §5 row in the same PR, which is what the playbook already asks
 * for in prose.
 *
 * WHAT IT DOES NOT DO
 *
 * It cannot tell that a "next free" note inside a live block has gone stale
 * (e.g. 771 lands while the block row still says "next 771") — the block still
 * covers the number. It does not check the reverse direction (a row with no
 * file), because gaps are legitimate.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
export const PLAYBOOK_PATH = path.join(REPO_ROOT, 'docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'apps/backend/src/migrations');

/**
 * Same predicate as apps/backend/scripts/check-migration-number-collisions.mjs:
 * a run of digits, an underscore, anything, `.sql`. `126b_create_data_breaches.sql`
 * has a letter before its underscore and is outside the numbering scheme for both
 * gates.
 */
export const MIGRATION_FILE = /^(\d+)_.+\.sql$/;

const SECTION_START = /^## 5\. Migration number registry/;
const SECTION_END = /^## /;

// en dash (the registry's house style), em dash, or a plain hyphen.
const DASH = '[\\u2013\\u2014-]';
const FLOOR_CELL = new RegExp(`^(?:\\u2026|\\.\\.\\.)\\s*${DASH}\\s*(\\d+)\\b`);
const RANGE_CELL = new RegExp(`^(\\d+)\\s*${DASH}\\s*(\\d+)\\b`);
const OPEN_CELL = /^(\d+)\s*\+/;
const SINGLE_CELL = /^(\d+)\b/;

/**
 * Interpret one comma-separated token of a registry row's first cell.
 *
 *   `…–367`                    → { from: 0, to: 367 }        (everything up to N)
 *   `369–370`                  → { from: 369, to: 370 }
 *   `368`, `574 (two files)`   → { from: 368, to: 368 }
 *   `579+`                     → { openEnded: true }          (covers NOTHING)
 *   `—`, `Block`, `**Wave E…**` → null                        (not a number token)
 *
 * A range whose end precedes its start is a parse error, not a token: a header
 * cell that starts with a date (`2026-09 …`) would otherwise read as a range and
 * silently cover 9..2026.
 */
function parseNumberToken(rawToken) {
  const token = rawToken.trim();
  let m;
  if ((m = FLOOR_CELL.exec(token))) return { from: 0, to: Number(m[1]), openEnded: false };
  if ((m = RANGE_CELL.exec(token))) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (to < from) {
      throw new Error(`registry cell reads as a descending range (${from}–${to}): "${rawToken.trim()}"`);
    }
    return { from, to, openEnded: false };
  }
  if ((m = OPEN_CELL.exec(token))) return { from: Number(m[1]), to: Infinity, openEnded: true };
  if ((m = SINGLE_CELL.exec(token))) return { from: Number(m[1]), to: Number(m[1]), openEnded: false };
  return null;
}

/**
 * Interpret the first cell of a registry row as a list of number specs.
 * `693–695, 697, 699–708` yields three specs; parsing stops at the first token
 * that is not a number, so trailing prose (`574 (two full filenames)`) is
 * harmless. A cell that starts with prose yields an empty list: not a number row.
 */
export function parseNumberCell(rawCell) {
  const cell = rawCell.replace(/[*`]/g, '').trim();
  const specs = [];
  for (const piece of cell.split(',')) {
    const spec = parseNumberToken(piece);
    if (!spec) break;
    specs.push(spec);
  }
  return specs;
}

/**
 * Every number row of every markdown table inside §5 and nothing outside it.
 * Table header and separator rows have no numeric first cell and fall out
 * naturally. Rows are returned with their 1-based line number for diagnostics.
 */
export function parseRegistry(markdown) {
  const lines = markdown.split(/\r?\n/);
  const rows = [];
  let inSection = false;
  let sectionFound = false;
  lines.forEach((line, index) => {
    if (SECTION_START.test(line)) {
      inSection = true;
      sectionFound = true;
      return;
    }
    if (inSection && SECTION_END.test(line)) {
      inSection = false;
      return;
    }
    if (!inSection) return;
    if (!line.startsWith('|')) return;
    const cells = line.split('|');
    // cells[0] is the empty string before the leading pipe.
    const first = cells[1] ?? '';
    if (/^\s*-+\s*$/.test(first)) return; // `|---|` separator
    let specs;
    try {
      specs = parseNumberCell(first);
    } catch (error) {
      throw new Error(`${error.message} (line ${index + 1})`);
    }
    for (const spec of specs) {
      rows.push({ ...spec, cell: first.trim(), line: index + 1 });
    }
  });
  return { rows, sectionFound };
}

/** Map of numeric prefix → the file names that carry it. */
export function migrationNumbers(fileNames) {
  const byNumber = new Map();
  for (const name of fileNames) {
    const m = MIGRATION_FILE.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (!byNumber.has(n)) byNumber.set(n, []);
    byNumber.get(n).push(name);
  }
  return byNumber;
}

export function isCovered(number, rows) {
  return rows.some((r) => !r.openEnded && number >= r.from && number <= r.to);
}

export function evaluate({ markdown, fileNames }) {
  const { rows, sectionFound } = parseRegistry(markdown);
  const numbers = migrationNumbers(fileNames);
  const uncovered = [...numbers.entries()]
    .filter(([n]) => !isCovered(n, rows))
    .sort((a, b) => a[0] - b[0])
    .map(([number, files]) => ({ number, files }));
  const highestCovered = rows
    .filter((r) => !r.openEnded)
    .reduce((max, r) => Math.max(max, r.to), -1);
  return { rows, numbers, uncovered, sectionFound, highestCovered };
}

export function readMigrationFileNames(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

function parseArgs(argv) {
  const opts = { playbook: PLAYBOOK_PATH, migrations: MIGRATIONS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--playbook') opts.playbook = path.resolve(argv[++i]);
    else if (arg === '--migrations') opts.migrations = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const markdown = readFileSync(opts.playbook, 'utf8');
  const fileNames = readMigrationFileNames(opts.migrations);
  const relPlaybook = path.relative(REPO_ROOT, opts.playbook) || opts.playbook;

  const { rows, numbers, uncovered, sectionFound, highestCovered } = evaluate({ markdown, fileNames });

  if (!sectionFound) {
    console.error(`${relPlaybook}: could not find the "## 5. Migration number registry" heading.`);
    process.exit(1);
  }
  if (rows.length === 0) {
    console.error(`${relPlaybook} §5: no number rows parsed — the registry table is missing or its format changed.`);
    process.exit(1);
  }
  if (numbers.size === 0) {
    // A guard that finds nothing to guard must say so rather than pass.
    console.error(`${opts.migrations}: no migration files matched ${MIGRATION_FILE}.`);
    process.exit(1);
  }

  if (uncovered.length > 0) {
    console.error(
      `Migration numbers on disk that ${relPlaybook} §5 does not cover (${uncovered.length}):\n`
      + uncovered.map(({ number, files }) => `  ${String(number).padStart(4)}  ${files.join(', ')}`).join('\n')
      + '\n\nAdd a §5 row for each (or extend the owning live block) in the same PR.\n'
      + 'The registry is the only allocation authority: a number assigned in chat,\n'
      + 'a spec, a plan or a PR body alone is not allocated. Gaps with no file are\n'
      + 'fine (released reservations); an open-ended `N+ UNASSIGNED` row covers nothing.\n',
    );
    process.exit(1);
  }

  console.log(
    `Migration registry check passed: ${numbers.size} distinct numbers across `
    + `${fileNames.length} migration files, all covered by ${rows.length} §5 rows `
    + `(highest covered number ${highestCovered}).`,
  );
}

// pathToFileURL rather than string-building: on Windows a drive path yields
// file:///D:/... (three slashes), so a hand-rolled `file://${argv[1]}` never
// matches and the gate silently no-ops when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
