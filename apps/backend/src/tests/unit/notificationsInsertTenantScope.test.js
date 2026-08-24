// Durable source-level guard: every `INSERT INTO notifications` in backend
// source must name `tenant_id` in its column list.
//
// WHY A SOURCE ASSERTION AND NOT A BEHAVIOURAL ONE. `notifications.tenant_id`
// is UUID NOT NULL whose DEFAULT (migration 310, applied dynamically to every
// policied tenant_id column so it is invisible to a grep for "notifications")
// reads the GUC:
//
//   COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true),
//                          ''), 'bypass')::uuid,
//            '00000000-0000-4000-8000-000000000001'::uuid)
//
// So an INSERT that omits tenant_id only lands on the right tenant when that
// GUC happens to be set at statement time. It is NOT set on any of:
//   * a bare `prisma.$transaction(async tx => ...)` — `tx` calls are never
//     auto-wrapped in setTenant;
//   * a SUPER_ADMIN / bypass context (GUC = 'bypass' → default tenant);
//   * cron or bootstrap code that never entered `runInTenantContext`;
//   * dev, QA and CI, where AUTH_ENFORCE_TENANT_RLS is off so the prisma
//     wrapper issues no GUC at all.
// In every one of those the row is stamped with the LITERAL default tenant and
// becomes invisible to the recipient, because every reader filters
// `... AND tenant_id = $n` (notificationService, staffNotificationService).
// That failure is silent — the INSERT succeeds — so no integration test on a
// single tenant can see it. The regression this stops has already happened
// three times (notificationDispatcher, patientPortalService.appendMessage,
// rosterDeadlineService), so the assertion is on the source itself.
//
// The fix at every site is the house pattern from PR #684: an explicitly bound
// tenant_id parameter (or `u.tenant_id` from a tenant-filtered recipient
// sub-select), never reliance on session context.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, '..', '..');
const BACKEND_DIR = path.resolve(SRC_DIR, '..');

// Directories that are not shipped backend source.
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'coverage', 'dist']);

// Lower bound on the number of INSERT sites the scanner must find. This is the
// anti-false-green guard: a regex that silently stops matching would otherwise
// make this suite pass while covering nothing.
const MIN_EXPECTED_SITES = 15;

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Blank out `//` line comments and block comments, preserving newlines so
 * reported line numbers stay accurate. Keeps a prose mention of the statement
 * in a comment from being scanned as a real INSERT.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + ' '.repeat(match.length - lead.length));
}

/**
 * Extract the balanced parenthesised column list that follows `from`.
 * Returns null when no `(` opens before the next statement keyword.
 */
function columnListAfter(source, from) {
  let i = from;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== '(') return null;
  let depth = 0;
  for (let j = i; j < source.length; j += 1) {
    if (source[j] === '(') depth += 1;
    else if (source[j] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(i + 1, j);
    }
  }
  return null;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Extract the `data: { ... }` object of a typed-ORM write, e.g.
 * `prisma.notifications.create({ data: { ... } })`. Returns null when no
 * `data:` object is found before the call closes.
 */
function ormDataBlockAfter(source, from) {
  const window = source.slice(from, from + 4000);
  const dataAt = window.search(/\bdata\s*:\s*[{[]/);
  if (dataAt === -1) return null;
  const openAt = from + dataAt + window.slice(dataAt).search(/[{[]/);
  const open = source[openAt];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let j = openAt; j < source.length; j += 1) {
    if (source[j] === open) depth += 1;
    else if (source[j] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openAt + 1, j);
    }
  }
  return null;
}

function collectOrmWriteSites() {
  const files = walk(path.join(BACKEND_DIR, 'src'));
  const sites = [];
  // `prisma.notifications.create( / createMany( / upsert(` and the same on a
  // transaction client (`tx.notifications.create(`).
  const ormRe = /\b(?:prisma|tx|client|db)\s*\.\s*notifications\s*\.\s*(create|createMany|upsert)\s*\(/g;

  for (const file of files) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    let match;
    ormRe.lastIndex = 0;
    while ((match = ormRe.exec(source)) !== null) {
      sites.push({
        file: path.relative(BACKEND_DIR, file).replace(/\\/g, '/'),
        line: lineOf(source, match.index),
        method: match[1],
        data: ormDataBlockAfter(source, match.index + match[0].length),
      });
    }
  }
  return sites;
}

function collectInsertSites() {
  const files = [
    ...walk(path.join(BACKEND_DIR, 'src')),
    ...walk(path.join(BACKEND_DIR, 'scripts')),
  ];
  const sites = [];
  // `notifications` with a word boundary — never notification_outbox,
  // notification_events, notifications_archive, etc.
  const insertRe = /INSERT\s+INTO\s+(?:public\.)?notifications\b/gi;

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const source = stripComments(raw);
    let match;
    insertRe.lastIndex = 0;
    while ((match = insertRe.exec(source)) !== null) {
      const columns = columnListAfter(source, match.index + match[0].length);
      sites.push({
        file: path.relative(BACKEND_DIR, file).replace(/\\/g, '/'),
        line: lineOf(source, match.index),
        columns,
      });
    }
  }
  return sites;
}

describe('every INSERT INTO notifications binds tenant_id', () => {
  const sites = collectInsertSites();

  it('finds the known population of insert sites (scanner is not silently empty)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(MIN_EXPECTED_SITES);
  });

  it('parses a column list at every insert site', () => {
    const unparsed = sites
      .filter(site => site.columns === null)
      .map(site => `apps/backend/${site.file}:${site.line}`);
    expect(unparsed).toEqual([]);
  });

  it('names tenant_id in every column list', () => {
    const offenders = sites
      .filter(site => site.columns !== null && !/\btenant_id\b/.test(site.columns))
      .map(site => `apps/backend/${site.file}:${site.line}`);

    // A row written without an explicit tenant_id inherits the GUC-reading
    // column DEFAULT, which resolves to the LITERAL default tenant on every
    // path where app.current_tenant_id is unset — silently invisible to the
    // recipient. Bind it explicitly (or select u.tenant_id from a
    // tenant-filtered recipient sub-select).
    expect(offenders).toEqual([]);
  });
});

// The raw-SQL scan above cannot see the typed-ORM form, which writes the same
// table through the same GUC-reading DEFAULT. Four such sites existed
// (investigation order placed / report ready, HR performance review, HR leave
// approval request) and all four omitted the tenant, so the scan is paired
// with an equivalent assertion on `prisma.notifications.create*`.
describe('every typed-ORM notifications write binds tenant_id', () => {
  const sites = collectOrmWriteSites();

  it('finds the known population of typed-ORM write sites', () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it('parses a data block at every typed-ORM write site', () => {
    const unparsed = sites
      .filter(site => site.data === null)
      .map(site => `apps/backend/${site.file}:${site.line}`);
    expect(unparsed).toEqual([]);
  });

  it('names tenant_id in every data block', () => {
    const offenders = sites
      .filter(site => site.data !== null && !/\btenant_id\b/.test(site.data))
      .map(site => `apps/backend/${site.file}:${site.line} (${site.method})`);
    expect(offenders).toEqual([]);
  });
});

describe('notifications insert-site guard self-check', () => {
  it('ignores sibling tables whose names merely start with "notification"', () => {
    const source = `
      INSERT INTO notification_outbox (id, title) VALUES ($1, $2);
      INSERT INTO notification_events (notification_id) VALUES ($1);
    `;
    const re = /INSERT\s+INTO\s+(?:public\.)?notifications\b/gi;
    expect(re.test(source)).toBe(false);
  });

  it('does not scan statements that appear only inside comments', () => {
    const stripped = stripComments('// INSERT INTO notifications (uid)\nconst a = 1;');
    expect(/INSERT\s+INTO\s+notifications\b/i.test(stripped)).toBe(false);
  });

  it('reads a column list that spans multiple lines', () => {
    const source = 'INSERT INTO notifications\n  (tenant_id, uid,\n   user_id)\nVALUES';
    const at = source.search(/INSERT\s+INTO\s+notifications\b/i);
    const columns = columnListAfter(source, at + 'INSERT INTO notifications'.length);
    expect(columns).toMatch(/\btenant_id\b/);
    expect(columns).toMatch(/\buser_id\b/);
  });

  it('flags a column list that omits tenant_id', () => {
    const source = 'INSERT INTO notifications (uid, user_id, phone) VALUES';
    const at = source.search(/INSERT\s+INTO\s+notifications\b/i);
    const columns = columnListAfter(source, at + 'INSERT INTO notifications'.length);
    expect(/\btenant_id\b/.test(columns)).toBe(false);
  });
});
