// Selection logic for scripts/qa-scratch-db.mjs — which QA-cluster databases
// are safe to prune. Pure so src/tests/unit/qaScratchDbPrune.test.js can pin
// the policy without a live cluster.
//
// Context (2026-07-28): sessions build isolated throwaway DBs on the QA
// cluster (the ci-setup-db recipe) and historically never dropped them; the
// cluster reached 155 databases and post-crash fsync recovery took 10-20+
// minutes. This module is the standing remedy's brain.

export const PROTECTED_DATABASES = ['postgres', 'vhhealth_test'];

const DEFAULT_MAX_AGE_DAYS = 3;

/**
 * Decide which databases a prune run may drop.
 *
 * @param {Array<{datname: string, isTemplate: boolean, numbackends: number,
 *                ageDays: number|null}>} databases
 *   One row per database. `ageDays` is the age of the newest write to the
 *   database's directory (null when unknown).
 * @param {{maxAgeDays?: number, keep?: string[], includeActive?: boolean}} options
 *   Databases strictly older than `maxAgeDays` qualify; `keep` names are
 *   always skipped; `includeActive` allows dropping databases that currently
 *   have connections (DROP ... WITH (FORCE) terminates them).
 * @returns {{targets: string[], skipped: Array<{datname: string, reason: string}>}}
 *   `targets` is name-sorted and deduplicated. `skipped` explains every
 *   non-target with one of: protected | template | kept | active |
 *   too-recent | unknown-age.
 */
export function selectPruneTargets(databases, options = {}) {
  const {
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    keep = [],
    includeActive = false,
  } = options;

  const keepSet = new Set(keep);
  const targets = new Set();
  const skipped = [];
  const seen = new Set();

  for (const row of databases) {
    if (seen.has(row.datname)) continue;
    seen.add(row.datname);

    if (row.isTemplate) {
      skipped.push({ datname: row.datname, reason: 'template' });
      continue;
    }
    if (PROTECTED_DATABASES.includes(row.datname)) {
      skipped.push({ datname: row.datname, reason: 'protected' });
      continue;
    }
    if (keepSet.has(row.datname)) {
      skipped.push({ datname: row.datname, reason: 'kept' });
      continue;
    }
    if (row.numbackends > 0 && !includeActive) {
      skipped.push({ datname: row.datname, reason: 'active' });
      continue;
    }
    if (row.ageDays == null || Number.isNaN(row.ageDays)) {
      skipped.push({ datname: row.datname, reason: 'unknown-age' });
      continue;
    }
    if (row.ageDays <= maxAgeDays) {
      skipped.push({ datname: row.datname, reason: 'too-recent' });
      continue;
    }
    targets.add(row.datname);
  }

  return { targets: [...targets].sort(), skipped };
}
