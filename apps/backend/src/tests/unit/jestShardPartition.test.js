// Shard-assignment math for the CI jest runner (scripts/lib/jestShard.mjs).
//
// The GitHub-hosted lint-and-test job outgrew its wall-clock cap twice (#595 /
// #599 at 45m, then 46m1s against the raised 60m on #604's PR run), because the
// full chunked suite runs in ONE job and grows with every merged suite. The
// durable fix shards the chunk list across a workflow matrix. The assignment
// must be deterministic (every shard independently discovers the same sorted
// file list), complete (every chunk runs somewhere), and disjoint (no chunk
// runs twice) — those three properties are exactly what this file pins.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseShardSpec, chunkBelongsToShard } from '../../../scripts/lib/jestShard.mjs';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const runnerPath = path.join(backendRoot, 'scripts', 'run-ci-jest.mjs');

function runRunner(env, args = []) {
  // These paths exit during env validation, BEFORE the expensive --listTests
  // call, so spawning the real script is fast (<1s).
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: backendRoot,
    env: {
      ...process.env,
      JEST_CI_SHARD: '',
      JEST_CI_START_CHUNK: '',
      JEST_CI_END_CHUNK: '',
      ...env,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('parseShardSpec', () => {
  test('parses k/N', () => {
    expect(parseShardSpec('2/3')).toEqual({ shardIndex: 2, shardCount: 3 });
    expect(parseShardSpec('1/1')).toEqual({ shardIndex: 1, shardCount: 1 });
    expect(parseShardSpec(' 3/3 ')).toEqual({ shardIndex: 3, shardCount: 3 });
  });

  test('returns null for unset/empty', () => {
    expect(parseShardSpec(undefined)).toBeNull();
    expect(parseShardSpec('')).toBeNull();
    expect(parseShardSpec('   ')).toBeNull();
  });

  test('throws on malformed or out-of-range specs', () => {
    for (const bad of ['0/3', '4/3', '-1/3', '1/0', 'x/y', '3', '1/3/5', '1.5/3', '1/ 3x']) {
      expect(() => parseShardSpec(bad)).toThrow(/JEST_CI_SHARD/);
    }
  });
});

describe('chunkBelongsToShard', () => {
  test('interleaves: chunk c goes to shard ((c-1) % N) + 1', () => {
    expect(chunkBelongsToShard(1, 1, 3)).toBe(true);
    expect(chunkBelongsToShard(2, 2, 3)).toBe(true);
    expect(chunkBelongsToShard(3, 3, 3)).toBe(true);
    expect(chunkBelongsToShard(4, 1, 3)).toBe(true);
    expect(chunkBelongsToShard(4, 2, 3)).toBe(false);
  });

  test('N=1 assigns every chunk to the only shard', () => {
    for (let c = 1; c <= 20; c += 1) expect(chunkBelongsToShard(c, 1, 1)).toBe(true);
  });

  test('COMPLETE and DISJOINT over a realistic chunk count', () => {
    // 138 chunks (the suite's size when this landed), 3 shards.
    const chunkCount = 138;
    const shardCount = 3;
    const seen = new Map();
    for (let c = 1; c <= chunkCount; c += 1) {
      const owners = [];
      for (let k = 1; k <= shardCount; k += 1) {
        if (chunkBelongsToShard(c, k, shardCount)) owners.push(k);
      }
      seen.set(c, owners);
    }
    // Every chunk owned by exactly one shard.
    for (const [, owners] of seen) expect(owners).toHaveLength(1);
    // Balanced within 1.
    const sizes = [1, 2, 3].map((k) => [...seen.values()].filter((o) => o[0] === k).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(chunkCount);
  });

  test('a shard beyond the chunk count simply owns nothing (suite shrink safety)', () => {
    // 5 chunks, 8 shards: shards 6-8 own zero chunks and must be able to
    // report success rather than fail the matrix.
    for (let k = 6; k <= 8; k += 1) {
      for (let c = 1; c <= 5; c += 1) expect(chunkBelongsToShard(c, k, 8)).toBe(false);
    }
  });
});

describe('run-ci-jest.mjs shard wiring (integration, instant-exit paths)', () => {
  // The pure-function tests above cannot catch a wiring regression in the
  // runner itself (adversarial-review finding: a refactor could keep the
  // modulo green while breaking the env plumbing). These spawn the REAL
  // script and pin its refusal paths, which exit before test discovery.

  test('malformed JEST_CI_SHARD exits 1 with the validator message', () => {
    const res = runRunner({ JEST_CI_SHARD: '4/3' });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toMatch(/JEST_CI_SHARD index must be within 1\.\.3/);
  });

  test('keeps the memory-heavy FHIR server suite in mandatory isolation', () => {
    const runnerSource = readFileSync(runnerPath, 'utf8');
    const mandatoryBlock = runnerSource.match(
      /const mandatoryIsolatedTestPatterns = \[([\s\S]*?)\];/,
    )?.[1];

    expect(mandatoryBlock).toContain("'fhir-server.deep.test.js'");
  });

  test('caps the default Jest process group below the observed seven-suite 4 GB OOM boundary', () => {
    const runnerSource = readFileSync(runnerPath, 'utf8');
    const defaultChunkSize = Number(
      runnerSource.match(/JEST_CI_CHUNK_SIZE \|\| (\d+)/)?.[1],
    );

    expect(defaultChunkSize).toBe(6);
  });

  test('JEST_CI_SHARD combined with the chunk window exits 1 (silent chunk loss refused)', () => {
    const res = runRunner({ JEST_CI_SHARD: '1/3', JEST_CI_START_CHUNK: '5' });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toMatch(/cannot be combined with JEST_CI_START_CHUNK/);
  });

  test('a partial non-sharded chunk window does not print the full-suite success marker', () => {
    const res = runRunner(
      { JEST_CI_CHUNK_SIZE: '1', JEST_CI_START_CHUNK: '1', JEST_CI_END_CHUNK: '1' },
      [
        '--listTests',
        'src/tests/unit/abdmEnvGate.test.js',
        'src/tests/unit/adherenceHeuristic.test.js',
      ],
    );
    const output = `${res.stdout}${res.stderr}`;

    expect(res.status).toBe(0);
    expect(output).toMatch(/Partial chunk window passed: 1 of 2 discovered chunk\(s\) ran/);
    expect(output).not.toContain('[Jest CI] All chunks passed.');
  });

  test('the full-suite success marker is retained when every discovered chunk ran', () => {
    const res = runRunner(
      { JEST_CI_CHUNK_SIZE: '1' },
      [
        '--listTests',
        'src/tests/unit/abdmEnvGate.test.js',
        'src/tests/unit/adherenceHeuristic.test.js',
      ],
    );
    const output = `${res.stdout}${res.stderr}`;

    expect(res.status).toBe(0);
    expect(output).toContain('[Jest CI] All chunks passed.');
    expect(output).not.toContain('[Jest CI] Partial chunk window passed:');
  });
});
