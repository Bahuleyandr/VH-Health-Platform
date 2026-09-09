#!/usr/bin/env node
// Guards docs/security/teardown-tx-census.json against CLASS REGRESSIONS, and
// only against those. Count movement is reported, never failed: the conversion
// programme and every new test file move counts, and a gate that failed on
// drift would tax every test-adding PR with a regeneration and be routed around
// within a week.
//
// TWO MODES, because the two halves have different dependencies and therefore
// belong in different CI stages.
//
//   --classes    Regenerates the census in memory and compares it with the
//                committed artifact. Needs the parser (acorn), so it runs in
//                the BACKEND stage, after that job's `npm ci`. This is the
//                #1055 shape: the gate runs where its subject lands.
//
//   --integrity  Checks the committed artifact against ITSELF and against the
//                artifact at the merge base. No parser, no walk, so it runs in
//                the unconditional `security` stage together with this file's
//                mutation proof.
//
// WHY THE SPLIT IS SOUND, and it is a stronger claim than the collision gate
// makes for itself: the census reads exactly one input, apps/backend/src/tests,
// and `backendPatterns` in stage-selection.mjs is /^apps\/backend\//. So every
// change that can alter a classification selects the backend stage by
// construction. The one path that does not is an edit to the artifact itself
// with no corpus change - which is precisely what --integrity covers, F5 in
// particular, and it needs no parser to do it.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The census's OWN count expressions. Not a second copy: on today's corpus only
// two of the four delete kinds occur, so competing rules produce identical
// numbers and a hand-written duplicate "matches" while being wrong. This module
// imports no parser, so it is safe in the dependency-free security stage.
import {
  ALL_COUNTS,
  DERIVED_COUNTS,
  FLOOR_ONLY_COUNTS,
  deriveCountsFromArtifact,
} from '../../apps/backend/scripts/lib/teardown-census-counts.mjs';

export { ALL_COUNTS, DERIVED_COUNTS, FLOOR_ONLY_COUNTS, deriveCountsFromArtifact };

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const ARTIFACT_PATH = 'docs/security/teardown-tx-census.json';
export const CENSUS_MODULE = '../../apps/backend/scripts/teardown-tx-census.mjs';

// ---------------------------------------------------------------------------
// Predicates. Every failure and every report line names the one that produced
// it; these strings are the single source of that text.
// ---------------------------------------------------------------------------

export const PREDICATES = {
  F1: 'FAIL - a file classified (a), (b) or both in the regenerated census is '
    + 'absent from the committed artifact. A new row in a defect class.',
  F2: 'FAIL - a file present in both, whose regenerated defect set is a strict '
    + 'superset of its committed one. Covers none->(a), none->(b), (a)->both '
    + 'and (b)->both.',
  F3: 'FAIL - the regenerated census has classUnknown > 0. The arm could not '
    + 'read what some delete targets, and silence is not evidence of safety.',
  F4: 'FAIL - the regenerated census has parseFailures > 0.',
  F5: 'FAIL - the committed artifact adds a defect row, or grows a row\'s '
    + 'defect set, relative to the artifact at the merge base. This is the arm '
    + 'that catches "introduce a defect AND regenerate", which the --classes '
    + 'comparison cannot see because regenerated == committed by construction.',
  I1: 'FAIL - a counts field that is derivable from files[] disagrees with the '
    + 'value re-derived arithmetically from files[].',
  I2: 'FAIL - the committed artifact records classUnknown > 0.',
  I3: 'FAIL - the committed artifact records parseFailures > 0, or its '
    + 'parseFailures count disagrees with the length of its parseFailures list.',
  I4: 'FAIL - a file listed in the committed artifact no longer exists on disk.',
  I5: 'FAIL - a row\'s `classification` disagrees with the class implied by its '
    + 'own a/b/unresolved fields. Makes a hand-edit of the label alone visible.',
  I6: 'FAIL - a `counts` key classified as neither DERIVED nor FLOOR-ONLY, or a '
    + 'classified counter missing from `counts`. The partition is by explicit '
    + 'name list so a counter added later cannot land in an unchecked bucket.',
  I7: 'FAIL - a walk-scoped counter below its floor. filesWalked and '
    + 'filesUsingTenantTeardownHelper are measured over the whole walk, not over '
    + 'files[], so equality is not assertable from a committed artifact and only '
    + 'floors are checked. Deriving the helper counter from files[] yields 1 on a '
    + 'correct artifact whose recorded value is 12.',
  F6: 'FAIL - the regenerated census\'s own `counts` disagree, on the DERIVED '
    + 'subset, with computeCounts re-applied to its own `files[]`. The two '
    + 'walk-scoped counters are excluded by definition: files[] cannot '
    + 'reproduce them. Runs on the real corpus in both backend tiers on every '
    + 'run.',
  R: 'REPORT only, never a failure - count movement (filesWalked, arm totals, '
    + 'every differing counts field), rows added with an empty defect set '
    + '(a new test file that tears down correctly), rows removed (a suite '
    + 'converted onto tenantTeardown.js leaves the population outright), and '
    + 'rows whose defect set shrank.',
};

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/** The defect classes a row carries, as a sorted array of 'a' | 'b'. */
export function defectSet(record) {
  const set = [];
  if (record?.a?.users || record?.a?.tenants) set.push('a');
  if (record?.b?.users || record?.b?.tenants) set.push('b');
  return set;
}

/** The classification a row's own fields imply, independent of its label. */
export function impliedClassification(record) {
  const defects = defectSet(record);
  if (defects.length === 2) return 'both';
  if (defects.includes('a')) return 'a';
  if (defects.includes('b')) return 'b';
  const unread = (record?.unresolvedDynamicDeletes ?? 0)
    + (record?.partiallyResolvedDynamicDeletes ?? 0);
  return unread > 0 ? 'unknown' : 'none';
}

function indexByFile(census) {
  return new Map((census?.files ?? []).map((record) => [record.file, record]));
}

// ---------------------------------------------------------------------------
// The three comparisons
// ---------------------------------------------------------------------------

/**
 * F1-F4. Compare a freshly regenerated census with the committed artifact.
 * @returns {{failures: object[], drift: object[]}}
 */
export function compareCensus(committed, regenerated) {
  const failures = [];
  const drift = [];

  if ((regenerated.counts?.classUnknown ?? 0) > 0) {
    failures.push({
      code: 'F3',
      detail: `regenerated classUnknown = ${regenerated.counts.classUnknown}`,
      files: (regenerated.files ?? []).filter((r) => r.classification === 'unknown').map((r) => r.file),
    });
  }
  if ((regenerated.counts?.parseFailures ?? 0) > 0) {
    failures.push({
      code: 'F4',
      detail: `regenerated parseFailures = ${regenerated.counts.parseFailures}`,
      files: (regenerated.parseFailures ?? []).map((entry) => entry.file),
    });
  }

  // F6. The census's emitted counts against computeCounts re-applied to the
  // records it emitted, on the real corpus, every run.
  //
  // WHAT THIS PROVES AND WHAT IT NO LONGER PROVES. It was specified as a
  // divergence guard between two implementations of the expressions. There is
  // only one now - lib/teardown-census-counts.mjs, which census() and this gate
  // both call - so on the DERIVED subset it is a self-consistency check, not a
  // divergence check. It still earns its place: it fires if census() ever
  // post-processes `counts` after computing them, or emits a counter that
  // computeCounts did not produce. What it CANNOT catch is a wrong rule inside
  // computeCounts, because both sides would then be wrong together. Only the
  // planted dynamic-partial / empty-relations fixtures catch that, and on this
  // corpus nothing else can: 609 literal and 16 dynamic deletes, zero
  // dynamic-partial, zero unresolved.
  const selfDerived = deriveCountsFromArtifact(regenerated);
  for (const key of DERIVED_COUNTS) {
    if (regenerated.counts?.[key] !== selfDerived[key]) {
      failures.push({ code: 'F6', key, emitted: regenerated.counts?.[key], derived: selfDerived[key] });
    }
  }

  const before = indexByFile(committed);
  const after = indexByFile(regenerated);

  for (const [file, record] of after) {
    const now = defectSet(record);
    if (!before.has(file)) {
      if (now.length > 0) failures.push({ code: 'F1', file, now });
      else drift.push({ code: 'R-row-added', file, classification: record.classification });
      continue;
    }
    const was = defectSet(before.get(file));
    const gained = now.filter((defect) => !was.includes(defect));
    if (gained.length > 0) failures.push({ code: 'F2', file, was, now, gained });
    else if (now.length < was.length) drift.push({ code: 'R-row-improved', file, was, now });
  }
  for (const [file, record] of before) {
    if (!after.has(file)) drift.push({ code: 'R-row-removed', file, was: defectSet(record) });
  }

  for (const key of Object.keys(regenerated.counts ?? {})) {
    const from = committed.counts?.[key];
    const to = regenerated.counts[key];
    if (from !== to) drift.push({ code: 'R-count', key, from, to });
  }

  return { failures, drift };
}

/**
 * I1-I5. The committed artifact against itself. No parser, no walk.
 * @param {(file: string) => boolean} [exists] injected for the probes
 */
export function checkArtifactIntegrity(committed, { exists = null, repoRoot = REPO_ROOT } = {}) {
  const failures = [];
  const drift = [];
  const files = committed.files ?? [];

  // I6 FIRST. Every counter must be classified as DERIVED or FLOOR-ONLY by
  // name, in both directions: an unlisted key would otherwise land in an
  // unchecked bucket the day someone adds a counter, and a listed key that has
  // vanished would silently stop being checked at all.
  const recorded = committed.counts ?? {};
  for (const key of Object.keys(recorded)) {
    if (!ALL_COUNTS.includes(key)) {
      failures.push({ code: 'I6', key, detail: 'counts key is in neither DERIVED_COUNTS nor FLOOR_ONLY_COUNTS' });
    }
  }
  for (const key of ALL_COUNTS) {
    if (!(key in recorded)) {
      failures.push({ code: 'I6', key, detail: 'a classified counter is missing from counts' });
    }
  }

  // I1. Recomputed with the census's OWN expressions, never a second copy.
  const derived = deriveCountsFromArtifact(committed);
  for (const key of DERIVED_COUNTS) {
    if (recorded[key] !== derived[key]) {
      failures.push({ code: 'I1', key, recorded: recorded[key], derived: derived[key] });
    }
  }

  // I7. The two walk-scoped counters cannot be reproduced from files[], so only
  // floors are assertable. filesUsingTenantTeardownHelper counts helper users
  // across every walked file (12 today) while files[] holds only the files with
  // a users/tenants delete (403 of 2042); deriving it from files[] gives 1 - and
  // that 1 is tenantTeardown.js itself - so an equality check reddens a correct
  // artifact. Its record-scoped sibling is derivable and is checked above.
  const walked = recorded.filesWalked ?? 0;
  if (!(walked > 1500)) {
    failures.push({ code: 'I7', key: 'filesWalked', detail: `floor is >1500, recorded ${walked}` });
  }
  if (walked < files.length) {
    failures.push({ code: 'I7', key: 'filesWalked', detail: `filesWalked ${walked} is below the ${files.length} rows it must contain` });
  }
  const helperRows = files.filter((record) => record.usesTenantTeardownHelper === true).length;
  const helperTotal = recorded.filesUsingTenantTeardownHelper ?? 0;
  if (helperTotal < helperRows || !(helperTotal > 0)) {
    failures.push({
      code: 'I7',
      key: 'filesUsingTenantTeardownHelper',
      detail: `floor is >=${helperRows} and >0, recorded ${helperTotal}`,
    });
  }
  if ((committed.counts?.classUnknown ?? 0) > 0) {
    failures.push({ code: 'I2', detail: `committed classUnknown = ${committed.counts.classUnknown}` });
  }
  const parseFailureList = committed.parseFailures ?? [];
  if ((committed.counts?.parseFailures ?? 0) !== parseFailureList.length) {
    failures.push({
      code: 'I3',
      detail: `counts.parseFailures = ${committed.counts?.parseFailures} but the list has ${parseFailureList.length} entries`,
    });
  } else if (parseFailureList.length > 0) {
    failures.push({ code: 'I3', detail: `committed parseFailures = ${parseFailureList.length}` });
  }

  const onDisk = exists ?? ((file) => existsSync(join(repoRoot, file)));
  for (const record of files) {
    if (!onDisk(record.file)) failures.push({ code: 'I4', file: record.file });
  }

  for (const record of files) {
    const implied = impliedClassification(record);
    if (record.classification !== implied) {
      failures.push({ code: 'I5', file: record.file, label: record.classification, implied });
    }
  }

  return { failures, drift };
}

/**
 * F5. The committed artifact against the artifact at the merge base. A null
 * base means the artifact does not exist there - the first landing - which is
 * reported and passes.
 */
export function compareAgainstBase(committed, base) {
  const failures = [];
  const drift = [];
  if (base === null || base === undefined) {
    drift.push({ code: 'R-no-base-artifact', detail: 'the base carries no census artifact; nothing to compare' });
    return { failures, drift };
  }

  const before = indexByFile(base);
  const after = indexByFile(committed);

  for (const [file, record] of after) {
    const now = defectSet(record);
    if (!before.has(file)) {
      if (now.length > 0) failures.push({ code: 'F5', file, now, detail: 'defect row added relative to the base artifact' });
      else drift.push({ code: 'R-row-added', file, classification: record.classification });
      continue;
    }
    const was = defectSet(before.get(file));
    const gained = now.filter((defect) => !was.includes(defect));
    if (gained.length > 0) {
      failures.push({ code: 'F5', file, was, now, gained, detail: 'defect set grew relative to the base artifact' });
    } else if (now.length < was.length) {
      drift.push({ code: 'R-row-improved', file, was, now });
    }
  }
  for (const [file, record] of before) {
    if (!after.has(file)) drift.push({ code: 'R-row-removed', file, was: defectSet(record) });
  }

  return { failures, drift };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatReport({ failures, drift }, { mode }) {
  const lines = [];
  lines.push(`teardown census gate (${mode}): ${failures.length} failure(s), ${drift.length} report line(s).`);
  if (drift.length > 0) {
    lines.push('');
    lines.push(`REPORT - not failures. ${PREDICATES.R}`);
    for (const item of drift) {
      if (item.code === 'R-count') lines.push(`  ${item.code}  ${item.key}: ${item.from} -> ${item.to}`);
      else if (item.file) lines.push(`  ${item.code}  ${item.file}${item.was?.length ? ` [${item.was.join(',')}]` : ''}`);
      else lines.push(`  ${item.code}  ${item.detail ?? ''}`);
    }
  }
  if (failures.length > 0) {
    lines.push('');
    lines.push('FAILURES:');
    const seen = new Set();
    for (const item of failures) {
      const where = item.file ? ` ${item.file}` : '';
      const extra = item.gained ? ` gained [${item.gained.join(',')}] (was [${item.was.join(',')}], now [${item.now.join(',')}])`
        : item.now ? ` now [${item.now.join(',')}]`
          : item.key ? ` ${item.key}: recorded ${item.recorded}, derived ${item.derived}`
            : item.detail ? ` ${item.detail}` : '';
      lines.push(`  ${item.code}${where}${extra}`);
      if (item.files?.length) for (const file of item.files) lines.push(`        ${file}`);
      if (!seen.has(item.code)) {
        seen.add(item.code);
        lines.push(`        predicate: ${PREDICATES[item.code]}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

export function readCommitted(repoRoot = REPO_ROOT) {
  return JSON.parse(readFileSync(join(repoRoot, ARTIFACT_PATH), 'utf8'));
}

/**
 * The artifact as of the merge base, or null when the base does not carry one.
 *
 * REQUIRES `fetch-depth: 0` on the security job's checkout. The merge base is
 * resolved from real history, so a shallow clone makes this arm fail closed on
 * every PR rather than pass vacuously. Shared dependency and precedent:
 * check-migration-immutability.mjs, whose resolver this reuses. The failure
 * path states it too, which is the copy that actually reaches a reader - a
 * constraint expressed where it fires beats one expressed in a comment,
 * because a reader of the comment has to already be in the right file.
 *
 * The resolver is imported LAZILY for two reasons that do not depend on
 * anything being broken elsewhere: this module stays safe to import as a
 * library, and there is one resolver rather than a second subtly different
 * one. That import-safety is asserted rather than assumed -
 * scripts/ci/main-module-guard.test.mjs sweeps the
 * `pathToFileURL(process.argv[1])` idiom and imports each hit in a child
 * process with argv[1] undefined - so if a guard is ever removed a test fails,
 * instead of this comment quietly becoming true again.
 */
export async function readBaseArtifact({ env = process.env } = {}) {
  const { resolveMergeBase } = await import('./check-migration-immutability.mjs');
  const { base, ref } = resolveMergeBase(REPO_ROOT, { env });
  const raw = git(['show', `${base}:${ARTIFACT_PATH}`], { allowFailure: true });
  return { base, ref, artifact: raw === null ? null : JSON.parse(raw) };
}

function merge(...results) {
  return {
    failures: results.flatMap((result) => result.failures),
    drift: results.flatMap((result) => result.drift),
  };
}

async function main(argv) {
  const mode = argv.includes('--integrity') ? 'integrity' : argv.includes('--classes') ? 'classes' : null;
  if (!mode) {
    process.stderr.write('usage: check-teardown-census.mjs --classes | --integrity\n');
    return 2;
  }
  const committed = readCommitted();

  if (mode === 'classes') {
    // Dynamic, not a top-level import: this module is loaded by the security
    // stage, which has no node_modules, and a static import of the parser would
    // redden that stage on every PR.
    const { census } = await import(CENSUS_MODULE);
    const regenerated = census({ revision: committed.revision });
    const result = compareCensus(committed, regenerated);
    process.stdout.write(`${formatReport(result, { mode })}\n`);
    return result.failures.length > 0 ? 1 : 0;
  }

  const { base, ref, artifact } = await readBaseArtifact();
  const result = merge(
    checkArtifactIntegrity(committed),
    compareAgainstBase(committed, artifact),
  );
  process.stdout.write(`base: ${base} (via ${ref})\n`);
  process.stdout.write(`${formatReport(result, { mode })}\n`);
  return result.failures.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      // Explicit, not left to Node's unhandled-rejection default. A gate that
      // cannot run must say so and fail closed; the one way this realistically
      // happens is --classes invoked where the parser is not installed, which
      // is every stage except the two backend tiers.
      process.exitCode = 1;
      const missingParser = String(error?.code) === 'ERR_MODULE_NOT_FOUND';
      process.stderr.write(
        `teardown census gate: FAILED TO RUN - ${error?.message ?? error}\n`
        + (missingParser
          ? '--classes regenerates the census and needs apps/backend/node_modules (acorn).\n'
            + 'Run it from a job that has done `npm ci` in apps/backend - the two backend\n'
            + 'tiers do. The parser-free half is `--integrity`, which is what the security\n'
            + 'stage runs. This is a failure, never a skip.\n'
          : ''),
      );
    },
  );
}
