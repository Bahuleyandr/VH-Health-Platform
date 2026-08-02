import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  defaultMetricPaths,
  recordSyncSuccess,
  recordVerificationFailure,
} from '../lib/metrics.mjs';

const roots = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function edge(facilityId) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'vh-edge-metrics-'));
  roots.push(dataRoot);
  await mkdir(path.join(dataRoot, 'state'), { recursive: true });
  await mkdir(path.join(dataRoot, 'metrics'), { recursive: true });
  const prometheusPath = path.join(dataRoot, 'metrics', 'continuity-edge.prom');
  return {
    prometheusPath,
    paths: defaultMetricPaths(dataRoot, prometheusPath, facilityId),
  };
}

function samples(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('vhhealth_continuity_'));
}

test('every rendered edge series carries its facility_id', async () => {
  const { paths, prometheusPath } = await edge(7);

  await recordSyncSuccess(paths, {
    freshUntil: '2026-07-30T06:30:00.000Z',
    manifestGeneratedAt: '2026-07-30T06:19:43.000Z',
    coverageComplete: true,
    succeededAt: new Date('2026-07-30T06:20:00.000Z'),
  });
  await recordVerificationFailure(paths, 'ACCESS_REVISION_ROLLBACK');

  const rendered = await readFile(prometheusPath, 'utf8');

  assert.match(
    rendered,
    /^vhhealth_continuity_pack_fresh_until_timestamp_seconds\{facility_id="7"\} 1785393000$/m,
  );
  assert.match(
    rendered,
    /^vhhealth_continuity_verification_failures_total\{facility_id="7",reason="ACCESS_REVISION_ROLLBACK"\} 1$/m,
  );
  assert.match(
    rendered,
    /^vhhealth_continuity_coverage_complete\{facility_id="7"\} 0$/m,
  );
  assert.match(
    rendered,
    /^vhhealth_continuity_edge_last_sync_success_timestamp_seconds\{facility_id="7"\} 1785392400$/m,
  );
  assert.match(
    rendered,
    /^vhhealth_continuity_edge_replication_lag_seconds\{facility_id="7"\} 17$/m,
  );
});

// ContinuityCoverageIncomplete alerts on this counter rather than joining two
// gauges (#710). The edge must therefore publish it as a real counter: present
// and zero when healthy, so `increase()` has a baseline and a fresh box never
// pages, and monotonic across restarts because it lives in the durable state
// file.
test('the coverage-failure counter is a zero baseline until coverage actually fails', async () => {
  const { paths, prometheusPath } = await edge(7);

  await recordSyncSuccess(paths, {
    freshUntil: '2026-07-30T06:30:00.000Z',
    manifestGeneratedAt: '2026-07-30T06:19:43.000Z',
    coverageComplete: true,
    succeededAt: new Date('2026-07-30T06:20:00.000Z'),
  });

  assert.match(
    await readFile(prometheusPath, 'utf8'),
    /^vhhealth_continuity_coverage_incomplete_total\{facility_id="7"\} 0$/m,
  );

  await recordSyncSuccess(paths, {
    freshUntil: '2026-07-30T07:30:00.000Z',
    manifestGeneratedAt: '2026-07-30T07:19:43.000Z',
    coverageComplete: false,
    succeededAt: new Date('2026-07-30T07:20:00.000Z'),
  });
  await recordSyncSuccess(paths, {
    freshUntil: '2026-07-30T08:30:00.000Z',
    manifestGeneratedAt: '2026-07-30T08:19:43.000Z',
    coverageComplete: false,
    succeededAt: new Date('2026-07-30T08:20:00.000Z'),
  });

  const rendered = await readFile(prometheusPath, 'utf8');
  assert.match(
    rendered,
    /^vhhealth_continuity_coverage_incomplete_total\{facility_id="7"\} 2$/m,
  );
  assert.match(
    rendered,
    /^vhhealth_continuity_coverage_complete\{facility_id="7"\} 0$/m,
  );
});

// Verification failures have their own counter and their own alert. Counting
// them here too would double-page for one event.
test('a verification failure does not increment the coverage-failure counter', async () => {
  const { paths, prometheusPath } = await edge(7);

  await recordVerificationFailure(paths, 'ACCESS_REVISION_ROLLBACK');

  const rendered = await readFile(prometheusPath, 'utf8');
  assert.match(
    rendered,
    /^vhhealth_continuity_coverage_incomplete_total\{facility_id="7"\} 0$/m,
  );
  assert.match(
    rendered,
    /^vhhealth_continuity_verification_failures_total\{facility_id="7",reason="ACCESS_REVISION_ROLLBACK"\} 1$/m,
  );
  // The gauge still records the state; only the alert source moved.
  assert.match(
    rendered,
    /^vhhealth_continuity_coverage_complete\{facility_id="7"\} 0$/m,
  );
});

// A state file written before the counter existed must keep loading — bumping
// the format would make every already-deployed edge fail its next write.
test('a pre-counter v1 state file still loads and starts the counter at zero', async () => {
  const { paths, prometheusPath } = await edge(7);

  await writeFile(
    paths.statePath,
    `${JSON.stringify(
      {
        format: 'vhhealth_continuity_edge_metrics_state/v1',
        coverageComplete: 1,
        edgeLastSyncSuccessTimestampSeconds: 1785392400,
        edgeReplicationLagSeconds: 17,
        packFreshUntilTimestampSeconds: 1785393000,
        verificationFailures: {},
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  await recordVerificationFailure(paths, 'MANIFEST_HASH_MISMATCH');

  assert.match(
    await readFile(prometheusPath, 'utf8'),
    /^vhhealth_continuity_coverage_incomplete_total\{facility_id="7"\} 0$/m,
  );
});

// An unlabelled sample would aggregate into a phantom group that a healthy
// facility can then mask, which is the exact defect facility_id exists to stop.
test('no rendered edge series is emitted without a facility_id', async () => {
  const { paths, prometheusPath } = await edge(7);

  await recordSyncSuccess(paths, {
    freshUntil: '2026-07-30T06:30:00.000Z',
    manifestGeneratedAt: '2026-07-30T06:19:43.000Z',
    coverageComplete: true,
    succeededAt: new Date('2026-07-30T06:20:00.000Z'),
  });

  const rendered = samples(await readFile(prometheusPath, 'utf8'));
  assert.ok(rendered.length > 0, 'expected rendered continuity samples');
  for (const sample of rendered) {
    assert.match(sample, /^vhhealth_continuity_[a-z_]+\{facility_id="[^"]+"/);
  }
});

test('two facilities render independent, individually labelled series', async () => {
  const stale = await edge(41);
  const healthy = await edge(42);

  await recordSyncSuccess(stale.paths, {
    freshUntil: '2026-07-30T00:00:00.000Z',
    manifestGeneratedAt: '2026-07-29T23:00:00.000Z',
    coverageComplete: false,
    succeededAt: new Date('2026-07-30T00:00:00.000Z'),
  });
  await recordSyncSuccess(healthy.paths, {
    freshUntil: '2026-07-30T12:00:00.000Z',
    manifestGeneratedAt: '2026-07-30T11:59:55.000Z',
    coverageComplete: true,
    succeededAt: new Date('2026-07-30T12:00:00.000Z'),
  });

  const staleText = await readFile(stale.prometheusPath, 'utf8');
  const healthyText = await readFile(healthy.prometheusPath, 'utf8');

  assert.match(
    staleText,
    /^vhhealth_continuity_edge_replication_lag_seconds\{facility_id="41"\} 3600$/m,
  );
  assert.match(
    staleText,
    /^vhhealth_continuity_coverage_complete\{facility_id="41"\} 0$/m,
  );
  assert.ok(!staleText.includes('facility_id="42"'));

  assert.match(
    healthyText,
    /^vhhealth_continuity_edge_replication_lag_seconds\{facility_id="42"\} 5$/m,
  );
  assert.match(
    healthyText,
    /^vhhealth_continuity_coverage_complete\{facility_id="42"\} 1$/m,
  );
  assert.ok(!healthyText.includes('facility_id="41"'));
});

// A dropped or unlabelled sample would be invisible to a `by (facility_id)`
// rule, so an unusable identity must still surface under a bounded label.
test('an unusable facility id renders as a bounded unknown label', async () => {
  const { paths, prometheusPath } = await edge(undefined);

  await recordVerificationFailure(paths, 'MANIFEST_HASH_MISMATCH');

  const rendered = await readFile(prometheusPath, 'utf8');
  assert.match(
    rendered,
    /^vhhealth_continuity_verification_failures_total\{facility_id="unknown",reason="MANIFEST_HASH_MISMATCH"\} 1$/m,
  );
  for (const sample of samples(rendered)) {
    assert.match(sample, /^vhhealth_continuity_[a-z_]+\{facility_id="[^"]+"/);
  }
});
