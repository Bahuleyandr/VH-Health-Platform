#!/usr/bin/env node
/**
 * Migrations must not relax `check_function_bodies` for anything but themselves.
 *
 * WHY THIS EXISTS
 *
 * `apps/backend/src/migrations/000_baseline.sql` issues a SESSION-level
 * `SET check_function_bodies = false`, and `ci-setup-db.mjs` applies every
 * migration through ONE long-lived connection. A session-level SET therefore
 * outlives the file that issued it, and body validation stayed off for every
 * migration after the baseline.
 *
 * The cost was real, not theoretical: migrations 744 and 745 shipped trigger
 * functions whose plpgsql bodies cannot compile — a bare CASE inside an IF
 * condition consumes the IF's own THEN terminator, so the condition is truncated
 * and the server raises 42601 "syntax error at end of input". Because validation
 * was off, `CREATE FUNCTION` accepted them silently. plpgsql compiles a body
 * lazily on first call, so both triggers would have raised the first time they
 * fired in production. Migration 759 repairs the two bodies.
 *
 * `ci-setup-db.mjs` now restores `check_function_bodies = on` after each
 * migration, so a relaxation can no longer outlive its file. This check stops the
 * other half of the problem: a NEW migration silently re-introducing a
 * session-scoped relaxation.
 *
 * THE RULE
 *
 * A migration may relax body checking for its own content — that is legitimate
 * and pg_dump does it for the same reason (functions that reference tables
 * created later in the same file). It must do so with `SET LOCAL`, which dies
 * with the migration's transaction, rather than a bare `SET`, which does not.
 *
 * Two historical files predate the rule and are grandfathered explicitly rather
 * than silently: amending an applied migration would drift its recorded checksum
 * in every environment that has already run it, which is a worse outcome than a
 * documented exception. The runner's per-file restore already neutralises both.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '../../apps/backend/src/migrations');

/**
 * Files that already shipped a session-level relaxation before this gate existed.
 * Editing them in place would drift the recorded checksum for every environment
 * that has applied them, so they stay as-is and are neutralised at runtime by
 * ci-setup-db.mjs restoring the GUC after each file.
 *
 * This list must never grow. A new migration uses SET LOCAL.
 */
const GRANDFATHERED = new Map([
  ['000_baseline.sql',
    'pg_dump preamble; the baseline creates functions ahead of the tables they reference.'],
  ['758_pharmacy_advance_funding_authority.sql',
    'Functions precede the table whose triggers call them and which some of them read back.'],
]);

// A bare `SET check_function_bodies ...` at the start of a line. `SET LOCAL` is
// explicitly allowed — that is the whole point of the rule.
const SESSION_SET = /^[ \t]*SET[ \t]+check_function_bodies\b/gim;
const LOCAL_SET = /^[ \t]*SET[ \t]+LOCAL[ \t]+check_function_bodies\b/i;

export function findSessionGucLeaks(files) {
  const offenders = [];
  for (const { name, sql } of files) {
    const lines = sql.split(/\r?\n/);
    lines.forEach((line, index) => {
      SESSION_SET.lastIndex = 0;
      if (!SESSION_SET.test(line)) return;
      if (LOCAL_SET.test(line)) return;
      offenders.push({ name, line: index + 1, text: line.trim() });
    });
  }
  return offenders;
}

export function evaluate(files, grandfathered = GRANDFATHERED) {
  const offenders = findSessionGucLeaks(files);
  const violations = offenders.filter((o) => !grandfathered.has(o.name));
  const staleExemptions = [...grandfathered.keys()].filter(
    (name) => !offenders.some((o) => o.name === name)
      && files.some((f) => f.name === name),
  );
  return { offenders, violations, staleExemptions };
}

function readMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

function main() {
  const files = readMigrations();
  const { offenders, violations, staleExemptions } = evaluate(files);

  if (staleExemptions.length > 0) {
    // The exemption outlived the thing it excused. Fail rather than let a stale
    // allowance sit there quietly widening what the gate permits.
    console.error(
      'Stale grandfather entries — these files no longer contain a session-level '
      + 'SET check_function_bodies, so remove them from GRANDFATHERED:\n'
      + staleExemptions.map((n) => `  - ${n}`).join('\n'),
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(
      'Migrations must not relax check_function_bodies for the whole session.\n\n'
      + violations.map((v) => `  ${v.name}:${v.line}\n    ${v.text}`).join('\n')
      + '\n\nUse `SET LOCAL check_function_bodies = false` instead. A bare SET is\n'
      + 'session-scoped, and ci-setup-db.mjs applies every migration through one\n'
      + 'connection, so it would disable body validation for every migration that\n'
      + 'follows. That is how 744 and 745 shipped plpgsql bodies that cannot\n'
      + 'compile while CI stayed green.\n',
    );
    process.exit(1);
  }

  console.log(
    `Migration session-GUC check passed (${files.length} migrations, `
    + `${offenders.length} grandfathered).`,
  );
}

// pathToFileURL rather than string-building: on Windows a drive path yields
// file:///D:/... (three slashes), so a hand-rolled `file://${argv[1]}` never
// matches and the gate silently no-ops when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { GRANDFATHERED, MIGRATIONS_DIR, readMigrations, main };
