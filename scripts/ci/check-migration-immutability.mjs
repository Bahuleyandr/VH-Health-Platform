#!/usr/bin/env node
/**
 * Applied-migration immutability gate.
 *
 * Raw SQL migrations under apps/backend/src/migrations are APPLY-ONCE. Once a
 * file has run against a database, that database holds the effect of the bytes
 * it ran — editing the file afterwards cannot change what already happened, it
 * only desynchronises the file from the `_migrations` tracker row that recorded
 * it. `reconcileMigrationChecksums` in
 * apps/backend/src/utils/migrations/runMigrations.js treats a recorded-vs-on-disk
 * sha256 difference as fatal (`MIGRATION_CHECKSUM_DRIFT`) with no escape hatch,
 * which is correct: continuing would boot against schema state the image cannot
 * prove.
 *
 * ★ WHY THIS GATE HAS TO BE GIT-LEVEL, AND WHY NOTHING ELSE CATCHES IT.
 * CI provisions a FRESH database for every run, so every `_migrations` row is
 * created (or seeded) from whatever bytes are on disk at that moment. Drift is
 * structurally impossible in a fresh database — the runtime check can only ever
 * fire against a long-lived one. That is why an in-place edit passes every
 * existing gate, green all the way to main, and then detonates on the first
 * deploy to a database that recorded the old checksum. The only place the
 * evidence exists at PR time is the git history, so that is where we look:
 * compare each migration blob against its blob at the merge-base with main.
 *
 * The incident this closes: 566_cath_consumables_billing_hook.sql shipped
 * 2026-07-12 in #558, then was edited in place on 2026-08-30 by 03db4c44f to
 * wrap an unconditional ALTER COLUMN in an idempotency guard. Semantically
 * harmless for a database where 566 had already run — and still fatal, because
 * it moved the checksum from 0a074114… to a39dc0ac…. The dalekdefender rig
 * refused to boot (deploy run 33480653253). Every database that applied 566
 * before 2026-08-30 carries the same latent failure.
 *
 *   node scripts/ci/check-migration-immutability.mjs
 *   node scripts/ci/check-migration-immutability.mjs --json
 *   node scripts/ci/check-migration-immutability.mjs --base <ref>
 *   node scripts/ci/check-migration-immutability.mjs --repo <path>   # tests
 *
 * Design notes:
 *
 * - Checksums are computed with the RUNTIME's own migrationChecksum(), not a
 *   git blob hash. The number this gate prints is therefore the exact number
 *   the operator sees in a MIGRATION_CHECKSUM_DRIFT error, and the allowlist
 *   speaks the same language as the failure it authorises. It also inherits
 *   that function's CRLF normalisation, so a Windows checkout cannot produce a
 *   phantom finding.
 *
 * - The comparison base is `git merge-base HEAD <main>`, never HEAD~1. A branch
 *   that adds a migration and then fixes it before merge is editing a file that
 *   does not exist at the merge-base, which is an ADD, and adds are always fine.
 *   Only a file that already exists on main is immutable.
 *
 * - The gate FAILS CLOSED. An unresolvable base ref (a shallow clone with no
 *   origin/main) is an error, not a skip: a guard that silently no-ops is worth
 *   less than no guard, because it reads as coverage.
 *
 * - Deletions and type changes are violations too. A file that stops existing
 *   still has a tracker row pointing at it, and `evaluateMigrationState` in
 *   runMigrations.js treats an executed-but-absent migration as its own fault.
 *
 * - The escape hatch is scripts/ci/migration-amendment-allowlist.json, and it
 *   authorises ONE transition (fromChecksum → toChecksum) for ONE file, not the
 *   file forever. See that file's header for the full rationale.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { migrationChecksum } from '../../apps/backend/scripts/lib/migrationChecksum.mjs';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MIGRATIONS_DIR = 'apps/backend/src/migrations';
export const ALLOWLIST_PATH = 'scripts/ci/migration-amendment-allowlist.json';

const REQUIRED_FIELDS = ['file', 'fromChecksum', 'toChecksum', 'reason', 'approvedBy', 'approvedOn', 'runtimeRemediation'];
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, 'incident']);
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_REASON_LENGTH = 40;
const MIN_REMEDIATION_LENGTH = 40;

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Validate the raw parsed allowlist. Returns {entries, errors}; a non-empty
 * errors array is a hard failure of the gate itself, never a silent downgrade
 * to "no entries" — a malformed opt-out must not read as an absent opt-out.
 */
export function parseAllowlist(raw) {
  const errors = [];
  const entries = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entries, errors: [`${ALLOWLIST_PATH}: expected a JSON object at the top level.`] };
  }
  if (!Array.isArray(raw.amendments)) {
    return { entries, errors: [`${ALLOWLIST_PATH}: expected an "amendments" array.`] };
  }

  const seen = new Set();
  raw.amendments.forEach((entry, index) => {
    const at = `${ALLOWLIST_PATH} amendments[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at}: expected an object.`);
      return;
    }

    for (const key of Object.keys(entry)) {
      if (!ALLOWED_FIELDS.has(key)) {
        errors.push(`${at}: unknown field "${key}". Allowed: ${[...ALLOWED_FIELDS].join(', ')}.`);
      }
    }
    for (const field of REQUIRED_FIELDS) {
      if (!(field in entry)) errors.push(`${at}: missing required field "${field}".`);
    }

    const file = typeof entry.file === 'string' ? entry.file.replace(/\\/g, '/') : null;
    if (file !== null && !file.startsWith(`${MIGRATIONS_DIR}/`)) {
      errors.push(`${at}: "file" must be a path under ${MIGRATIONS_DIR}/ (got ${JSON.stringify(entry.file)}).`);
    }
    if (file !== null && !file.endsWith('.sql')) {
      errors.push(`${at}: "file" must be a .sql migration (got ${JSON.stringify(entry.file)}).`);
    }

    if (typeof entry.fromChecksum !== 'string' || !SHA256.test(entry.fromChecksum)) {
      errors.push(`${at}: "fromChecksum" must be a 64-character lowercase sha256 hex digest.`);
    }
    // null is the explicit encoding for "this file is removed"; anything else
    // must be a digest. A missing key was already reported above.
    if (!(entry.toChecksum === null || (typeof entry.toChecksum === 'string' && SHA256.test(entry.toChecksum)))) {
      errors.push(`${at}: "toChecksum" must be a 64-character lowercase sha256 hex digest, or null for a deletion.`);
    }
    if (entry.fromChecksum === entry.toChecksum) {
      errors.push(`${at}: "fromChecksum" and "toChecksum" are identical — that authorises nothing.`);
    }

    // A justification is the whole point of the opt-out. An empty or one-word
    // string turns a reviewable decision back into a rubber stamp, so both
    // prose fields carry a length floor.
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
      errors.push(`${at}: "reason" must be at least ${MIN_REASON_LENGTH} characters explaining why a new migration cannot do this.`);
    }
    if (typeof entry.runtimeRemediation !== 'string' || entry.runtimeRemediation.trim().length < MIN_REMEDIATION_LENGTH) {
      errors.push(`${at}: "runtimeRemediation" must be at least ${MIN_REMEDIATION_LENGTH} characters naming what every already-migrated database has to do.`);
    }
    if (typeof entry.approvedBy !== 'string' || entry.approvedBy.trim() === '') {
      errors.push(`${at}: "approvedBy" must name the human who approved this.`);
    }
    if (typeof entry.approvedOn !== 'string' || !ISO_DATE.test(entry.approvedOn)) {
      errors.push(`${at}: "approvedOn" must be a YYYY-MM-DD date.`);
    }

    const key = `${file}|${entry.fromChecksum}`;
    if (seen.has(key)) {
      errors.push(`${at}: duplicate entry for ${file} from ${entry.fromChecksum}.`);
    }
    seen.add(key);

    entries.push({ ...entry, file });
  });

  return { entries, errors };
}

export function loadAllowlist(repoRoot) {
  const absolute = join(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(absolute)) {
    // Absent behaves as empty, which is the STRICTEST reading: nothing is
    // authorised. A missing allowlist can only ever make the gate harder.
    return { entries: [], errors: [], present: false };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    return { entries: [], errors: [`${ALLOWLIST_PATH}: invalid JSON — ${error.message}`], present: true };
  }
  return { ...parseAllowlist(raw), present: true };
}

// ---------------------------------------------------------------------------
// Evaluation (pure — the git layer feeds it)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{file: string, status: string, fromChecksum: string|null, toChecksum: string|null}>} changes
 * @param {Array<object>} allowlist
 */
export function evaluateMigrationChanges(changes, allowlist = []) {
  const added = [];
  const violations = [];
  const amended = [];
  const unchanged = [];
  const matchedKeys = new Set();

  for (const change of changes) {
    if (change.status === 'A') {
      added.push(change);
      continue;
    }

    // The blob moved but the CHECKSUM did not, so the runtime is indifferent:
    // a file-mode change, or - the one that would actually bite here - a
    // line-ending rewrite. Migrations are LF-pinned at checkout, but a
    // historical blob or an editor that bypasses attributes can still commit
    // CRLF; migrationChecksum() normalises CRLF before hashing, so that file
    // still matches every _migrations row on every database. Failing it would
    // be a pure false positive against a gate whose whole authority is that it
    // mirrors the runtime check exactly.
    if (change.fromChecksum !== null && change.fromChecksum === change.toChecksum) {
      unchanged.push(change);
      continue;
    }

    const match = allowlist.find(
      (entry) =>
        entry.file === change.file &&
        entry.fromChecksum === change.fromChecksum &&
        entry.toChecksum === change.toChecksum,
    );

    if (match) {
      matchedKeys.add(`${match.file}|${match.fromChecksum}`);
      amended.push({ ...change, allowlist: match });
    } else {
      violations.push(change);
    }
  }

  // Entries that authorise a transition this diff does not contain. They are
  // NOT an error: once an amendment merges, its entry stays behind as the
  // permanent audit record and is inert on every later branch. It can only ever
  // re-authorise producing content that is already on main.
  const inert = allowlist.filter((entry) => !matchedKeys.has(`${entry.file}|${entry.fromChecksum}`));

  return { added, amended, violations, unchanged, inert };
}

// ---------------------------------------------------------------------------
// Git layer
// ---------------------------------------------------------------------------

function git(repoRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')} failed: ${error.stderr || error.message}`);
  }
}

function refExists(repoRoot, ref) {
  return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true }) !== null;
}

/**
 * Candidate base refs, most specific first. GITHUB_BASE_REF is set on
 * pull_request events; the canonical gate is push-triggered, so origin/main is
 * the workhorse.
 */
export function baseRefCandidates(env = process.env) {
  const candidates = [];
  if (env.VH_MIGRATION_BASE_REF) candidates.push(env.VH_MIGRATION_BASE_REF);
  if (env.GITHUB_BASE_REF) {
    candidates.push(`origin/${env.GITHUB_BASE_REF}`, `github/${env.GITHUB_BASE_REF}`, env.GITHUB_BASE_REF);
  }
  candidates.push('origin/main', 'github/main', 'main');
  return [...new Set(candidates)];
}

/**
 * ★ Pick the MOST RECENT merge-base across every candidate ref, not the first
 * candidate that happens to exist.
 *
 * This repository has two remotes and they are not equivalent: `github` is the
 * CI authority, `origin` is a Forgejo mirror that lags. A first-match rule
 * resolves `origin/main` on the dev box, which is often weeks behind — and a
 * stale base attributes every migration MAIN has landed since then to the
 * branch under test. That is not a theoretical concern: it fired on the very
 * first run of this gate, reporting migration 566's own edit as a violation of
 * a branch that had never touched it.
 *
 * Taking the newest common ancestor is the accurate reading of "where did this
 * branch leave main", and it is safe in the other direction too — a candidate
 * ref cannot contain the branch's own edits unless the branch is already
 * merged, in which case an empty diff is the right answer. In CI the question
 * does not arise: actions/checkout creates exactly one remote, `origin`, and
 * fetch-depth 0 puts main under it.
 */
export function resolveMergeBase(repoRoot, { env = process.env, explicitBase = null } = {}) {
  const candidates = explicitBase ? [explicitBase] : baseRefCandidates(env);
  const tried = [];
  const resolved = [];

  for (const ref of candidates) {
    tried.push(ref);
    if (!refExists(repoRoot, ref)) continue;
    const base = git(repoRoot, ['merge-base', 'HEAD', ref], { allowFailure: true });
    if (base && base.trim()) resolved.push({ ref, base: base.trim() });
  }

  if (resolved.length > 0) {
    const best = resolved.reduce((winner, candidate) => {
      if (winner.base === candidate.base) return winner;
      // Keep whichever base is NOT an ancestor of the other, i.e. the newer one.
      const winnerIsAncestor = git(
        repoRoot,
        ['merge-base', '--is-ancestor', winner.base, candidate.base],
        { allowFailure: true },
      );
      return winnerIsAncestor !== null ? candidate : winner;
    });
    return { ...best, tried, considered: resolved.map((entry) => entry.ref) };
  }

  // Fail closed. A shallow clone is the usual cause and has a one-line fix, so
  // say so rather than leaving the reader to guess.
  throw new Error(
    `Unable to resolve a merge-base for HEAD against any of: ${tried.join(', ')}.\n` +
      'This gate compares migrations against the branch point with main and cannot run without it.\n' +
      'In GitHub Actions this almost always means a shallow checkout — set `fetch-depth: 0` on actions/checkout.\n' +
      'Locally: `git fetch origin main` (or pass --base <ref>).',
  );
}

function blobChecksum(repoRoot, blobSha) {
  if (!blobSha || /^0+$/.test(blobSha)) return null;
  const content = execFileSync('git', ['cat-file', 'blob', blobSha], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return migrationChecksum(content);
}

/**
 * `git diff --raw` gives us both blob shas per changed path in one call, so the
 * checksums come from the object store rather than the working tree — immune to
 * autocrlf, and it is the merge-base blob that no longer exists on disk anyway.
 */
export function collectMigrationChanges(repoRoot, base) {
  const raw = git(repoRoot, [
    'diff',
    '--raw',
    '--no-renames',
    '--abbrev=40',
    base,
    'HEAD',
    '--',
    MIGRATIONS_DIR,
  ]);

  const changes = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>
    const match = /^:(\S+) (\S+) (\S+) (\S+) (\S+)\t(.+)$/.exec(line);
    if (!match) throw new Error(`Unparsable git diff --raw line: ${JSON.stringify(line)}`);
    const [, , , srcSha, dstSha, rawStatus, rawPath] = match;
    const file = rawPath.replace(/\\/g, '/');
    if (!file.endsWith('.sql')) continue;

    const status = rawStatus[0];
    changes.push({
      file,
      status,
      fromChecksum: blobChecksum(repoRoot, srcSha),
      toChecksum: blobChecksum(repoRoot, dstSha),
    });
  }
  return changes.sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const STATUS_LABEL = {
  M: 'edited in place',
  D: 'deleted',
  T: 'type changed',
};

export function formatViolation(change) {
  const label = STATUS_LABEL[change.status] || `changed (${change.status})`;
  const lines = [
    `  ✗ ${change.file} — ${label}`,
    `      merge-base checksum: ${change.fromChecksum ?? '(absent)'}`,
    `      this branch:         ${change.toChecksum ?? '(file removed)'}`,
  ];
  return lines.join('\n');
}

function suggestedEntry(change) {
  return JSON.stringify(
    {
      file: change.file,
      fromChecksum: change.fromChecksum,
      toChecksum: change.toChecksum,
      reason: 'REQUIRED: why a NEW migration cannot achieve this. At least 40 characters.',
      runtimeRemediation:
        'REQUIRED: what every database that already applied this file must do before the next deploy. At least 40 characters.',
      approvedBy: 'REQUIRED: the human who approved this',
      approvedOn: 'YYYY-MM-DD',
      incident: 'optional: link to the incident or PR',
    },
    null,
    2,
  )
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
}

export function buildReport(result, { ref, base, considered = [] }) {
  const lines = [];
  const alternatives = considered.filter((candidate) => candidate !== ref);
  lines.push(
    `Applied-migration immutability gate (base ${ref} @ ${base.slice(0, 12)}` +
      `${alternatives.length > 0 ? `; newer than ${alternatives.join(', ')}` : ''})`,
  );
  lines.push(
    `  ${result.added.length} migration(s) added, ` +
      `${result.amended.length} allowlisted amendment(s), ` +
      `${result.violations.length} violation(s).`,
  );

  if (result.unchanged.length > 0) {
    lines.push(
      `  ${result.unchanged.length} migration(s) touched with no checksum change (line endings or file mode) — not drift.`,
    );
  }

  for (const amendment of result.amended) {
    lines.push(
      `  ⚠ ALLOWLISTED AMENDMENT ${amendment.file} — approved by ${amendment.allowlist.approvedBy} on ${amendment.allowlist.approvedOn}.`,
    );
    lines.push(`      remediation: ${amendment.allowlist.runtimeRemediation}`);
  }
  if (result.amended.length > 0) {
    lines.push(
      '  ⚠ The runtime checksum guard is NOT bypassed by this allowlist. Every database that already',
      '    applied these files will fail to boot with MIGRATION_CHECKSUM_DRIFT until an operator',
      '    reconciles its _migrations row. Do not merge without that plan.',
    );
  }
  if (result.inert.length > 0) {
    lines.push(`  ${result.inert.length} allowlist entry/entries are inert on this branch (historical record).`);
  }

  if (result.violations.length === 0) return lines.join('\n');

  lines.push('');
  lines.push('An already-applied migration was modified. This is fatal at runtime, not in CI:');
  lines.push('');
  for (const violation of result.violations) lines.push(formatViolation(violation));
  lines.push('');
  lines.push('Why CI cannot catch this any other way: every CI database is fresh, so its _migrations');
  lines.push('rows are seeded from whatever bytes are on disk and the checksums always agree. Only a');
  lines.push('long-lived database — the dalekdefender rig, staging, production — recorded the OLD');
  lines.push('checksum, and reconcileMigrationChecksums() in');
  lines.push('apps/backend/src/utils/migrations/runMigrations.js refuses to boot when it disagrees');
  lines.push('(MIGRATION_CHECKSUM_DRIFT). That check is deliberately not bypassable.');
  lines.push('');
  lines.push('Fix: add a NEW migration with the next free number. It is the only change that reaches a');
  lines.push('database which already ran the original. Editing the old file changes nothing that has');
  lines.push('already happened — it only desynchronises the tracker.');
  lines.push('');
  lines.push(`If this genuinely must be an in-place amendment, add an entry to ${ALLOWLIST_PATH}:`);
  lines.push('');
  for (const violation of result.violations) lines.push(suggestedEntry(violation));
  lines.push('');
  lines.push('An entry authorises exactly one fromChecksum → toChecksum transition for one file, so a');
  lines.push('later edit to the same file fails again. Read that file\'s header before adding one.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = { json: false, repoRoot: defaultRepoRoot, base: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--base') options.base = argv[++index];
    else if (arg === '--repo') options.repoRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2), { env = process.env, log = console.log, error = console.error } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (parseError) {
    error(parseError.message);
    return 2;
  }

  let baseInfo;
  try {
    baseInfo = resolveMergeBase(options.repoRoot, { env, explicitBase: options.base });
  } catch (resolveError) {
    error(`Applied-migration immutability gate could not run:\n${resolveError.message}`);
    return 1;
  }

  const allowlist = loadAllowlist(options.repoRoot);
  if (allowlist.errors.length > 0) {
    error(`Applied-migration amendment allowlist is invalid — refusing to run the gate against it:`);
    for (const message of allowlist.errors) error(`  ✗ ${message}`);
    return 1;
  }

  const changes = collectMigrationChanges(options.repoRoot, baseInfo.base);
  const result = evaluateMigrationChanges(changes, allowlist.entries);

  if (options.json) {
    log(JSON.stringify({ baseRef: baseInfo.ref, base: baseInfo.base, considered: baseInfo.considered ?? [], ...result }, null, 2));
  } else {
    const report = buildReport(result, baseInfo);
    if (result.violations.length > 0) error(report);
    else log(report);
  }

  return result.violations.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
