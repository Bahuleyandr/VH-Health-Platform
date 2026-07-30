import { access } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-files.mjs';
import { readProtectedJson } from './json-files.mjs';
import { withDirectoryLock } from './lock.mjs';

const FORMAT = 'vhhealth_continuity_edge_metrics_state/v1';
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;

function initialState() {
  return {
    format: FORMAT,
    coverageComplete: 0,
    edgeLastSyncSuccessTimestampSeconds: 0,
    edgeReplicationLagSeconds: 0,
    packFreshUntilTimestampSeconds: 0,
    verificationFailures: {},
  };
}

async function loadState(statePath) {
  try {
    await access(statePath);
    const state = await readProtectedJson(statePath, {
      label: 'continuity metrics state',
    });
    if (
      state?.format !== FORMAT ||
      !state.verificationFailures ||
      typeof state.verificationFailures !== 'object'
    ) {
      throw new Error('continuity metrics state is invalid');
    }
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') return initialState();
    throw error;
  }
}

function renderPrometheus(state) {
  const lines = [
    '# HELP vhhealth_continuity_pack_fresh_until_timestamp_seconds Unix timestamp through which the selected continuity pack remains valid.',
    '# TYPE vhhealth_continuity_pack_fresh_until_timestamp_seconds gauge',
    `vhhealth_continuity_pack_fresh_until_timestamp_seconds ${state.packFreshUntilTimestampSeconds}`,
    '# HELP vhhealth_continuity_verification_failures_total Continuity verification failures by stable reason.',
    '# TYPE vhhealth_continuity_verification_failures_total counter',
  ];
  for (const [reason, value] of Object.entries(state.verificationFailures).sort()) {
    lines.push(
      `vhhealth_continuity_verification_failures_total{reason="${reason}"} ${value}`,
    );
  }
  lines.push(
    '# HELP vhhealth_continuity_coverage_complete Whether the selected publication has exact required coverage.',
    '# TYPE vhhealth_continuity_coverage_complete gauge',
    `vhhealth_continuity_coverage_complete ${state.coverageComplete}`,
    '# HELP vhhealth_continuity_edge_last_sync_success_timestamp_seconds Unix timestamp of the latest successful edge sync.',
    '# TYPE vhhealth_continuity_edge_last_sync_success_timestamp_seconds gauge',
    `vhhealth_continuity_edge_last_sync_success_timestamp_seconds ${state.edgeLastSyncSuccessTimestampSeconds}`,
    '# HELP vhhealth_continuity_edge_replication_lag_seconds Observed continuity-edge replication lag.',
    '# TYPE vhhealth_continuity_edge_replication_lag_seconds gauge',
    `vhhealth_continuity_edge_replication_lag_seconds ${state.edgeReplicationLagSeconds}`,
    '',
  );
  return lines.join('\n');
}

async function updateMetrics({ statePath, prometheusPath }, mutate) {
  const lockPath = `${statePath}.lock`;
  return withDirectoryLock(lockPath, async () => {
    const state = await loadState(statePath);
    await mutate(state);
    await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await atomicWriteFile(prometheusPath, renderPrometheus(state), { mode: 0o644 });
    return state;
  });
}

export async function recordVerificationFailure(paths, reason) {
  const normalized = String(reason || '');
  if (!REASON_PATTERN.test(normalized)) {
    throw new Error('verification reason is not a stable upper-snake-case code');
  }
  return updateMetrics(paths, (state) => {
    state.verificationFailures[normalized] =
      Number(state.verificationFailures[normalized] || 0) + 1;
    state.coverageComplete = 0;
  });
}

export async function recordSyncSuccess(
  paths,
  { freshUntil, manifestGeneratedAt, coverageComplete = true, succeededAt = new Date() },
) {
  const successMs = succeededAt.getTime();
  const generatedMs = Date.parse(manifestGeneratedAt);
  const freshUntilMs = Date.parse(freshUntil);
  if (![successMs, generatedMs, freshUntilMs].every(Number.isFinite)) {
    throw new Error('sync metrics require valid timestamps');
  }
  return updateMetrics(paths, (state) => {
    state.coverageComplete = coverageComplete ? 1 : 0;
    state.edgeLastSyncSuccessTimestampSeconds = successMs / 1000;
    state.edgeReplicationLagSeconds = Math.max(0, (successMs - generatedMs) / 1000);
    state.packFreshUntilTimestampSeconds = freshUntilMs / 1000;
  });
}

export function defaultMetricPaths(dataRoot, prometheusPath) {
  return {
    statePath: path.join(dataRoot, 'state', 'metrics.json'),
    prometheusPath,
  };
}
