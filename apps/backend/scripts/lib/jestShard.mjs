// Shard-assignment math for run-ci-jest.mjs.
//
// The chunk list is derived from a SORTED file list (run-ci-jest sorts its
// --listTests output with localeCompare), so every matrix shard independently
// computes the identical chunk numbering. Assignment interleaves — chunk c
// belongs to shard ((c - 1) % N) + 1 — which balances shard runtimes better
// than contiguous windows and stays complete/disjoint as the suite grows.
// Properties (complete, disjoint, balanced-within-1, shrink-safe) are pinned
// by src/tests/unit/jestShardPartition.test.js.

/**
 * Parse a "k/N" shard spec (the JEST_CI_SHARD env var).
 * @param {string|undefined} raw
 * @returns {{ shardIndex: number, shardCount: number } | null} null when unset
 * @throws on malformed or out-of-range specs — a misconfigured shard must fail
 *         loudly, never silently run the wrong slice.
 */
export function parseShardSpec(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  const match = /^(\d+)\/(\d+)$/.exec(text);
  if (!match) {
    throw new Error(`JEST_CI_SHARD must look like "k/N" (e.g. "2/3"); received "${raw}"`);
  }
  const shardIndex = Number(match[1]);
  const shardCount = Number(match[2]);
  if (shardCount < 1) {
    throw new Error(`JEST_CI_SHARD count must be >= 1; received "${raw}"`);
  }
  if (shardIndex < 1 || shardIndex > shardCount) {
    throw new Error(`JEST_CI_SHARD index must be within 1..${shardCount}; received "${raw}"`);
  }
  return { shardIndex, shardCount };
}

/**
 * @param {number} chunkNumber 1-based chunk number
 * @param {number} shardIndex 1-based shard index
 * @param {number} shardCount total shards
 */
export function chunkBelongsToShard(chunkNumber, shardIndex, shardCount) {
  return (chunkNumber - 1) % shardCount === shardIndex - 1;
}
