import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
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
