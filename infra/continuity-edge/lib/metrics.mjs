import { access } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-files.mjs';
import { readProtectedJson } from './json-files.mjs';
import { withDirectoryLock } from './lock.mjs';

const FORMAT = 'vhhealth_continuity_edge_metrics_state/v1';
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;

// Every rendered series carries facility_id. The continuity-edge alert rules
// aggregate `by (facility_id)`, so an unlabelled sample lands in a phantom
// group where one facility's max()/min() masks another facility's failure.
// The edge already knows its own identity (config.scope.facilityId), so the
// label costs nothing and is bounded by the facility count. tenant_id stays out
// of the label set on purpose — unbounded in a multi-tenant deployment, and the
// audit log already carries it.
function facilityLabel(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 'unknown';
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) return 'unknown';
  return String(normalized);
}

function initialState() {
  return {
    format: FORMAT,
    coverageComplete: 0,
    coverageIncompleteTotal: 0,
    edgeLastSyncSuccessTimestampSeconds: 0,
    edgeReplicationLagSeconds: 0,
    packFreshUntilTimestampSeconds: 0,
    verificationFailures: {},
  };
}

// coverageIncompleteTotal was added after v1 shipped. It stays inside v1 rather
// than bumping the format: loadState rejects an unknown format outright, so a
// bump would make every already-deployed edge fail its next metrics write. An
// older state file simply resumes the counter from zero.
function normalizeCoverageIncompleteTotal(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : 0;
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
    state.coverageIncompleteTotal = normalizeCoverageIncompleteTotal(
      state.coverageIncompleteTotal,
    );
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') return initialState();
    throw error;
  }
}

function renderPrometheus(state, facilityId) {
  const facility = `facility_id="${facilityLabel(facilityId)}"`;
  const lines = [
    '# HELP vhhealth_continuity_pack_fresh_until_timestamp_seconds Unix timestamp through which the selected continuity pack remains valid.',
    '# TYPE vhhealth_continuity_pack_fresh_until_timestamp_seconds gauge',
    `vhhealth_continuity_pack_fresh_until_timestamp_seconds{${facility}} ${state.packFreshUntilTimestampSeconds}`,
    '# HELP vhhealth_continuity_verification_failures_total Continuity verification failures by stable reason.',
    '# TYPE vhhealth_continuity_verification_failures_total counter',
  ];
  for (const [reason, value] of Object.entries(state.verificationFailures).sort()) {
    lines.push(
      `vhhealth_continuity_verification_failures_total{${facility},reason="${reason}"} ${value}`,
    );
  }
  lines.push(
    '# HELP vhhealth_continuity_coverage_complete Whether the selected publication has exact required coverage.',
    '# TYPE vhhealth_continuity_coverage_complete gauge',
    `vhhealth_continuity_coverage_complete{${facility}} ${state.coverageComplete}`,
    '# HELP vhhealth_continuity_coverage_incomplete_total Continuity publications rejected because required coverage was not exact.',
    '# TYPE vhhealth_continuity_coverage_incomplete_total counter',
    `vhhealth_continuity_coverage_incomplete_total{${facility}} ${state.coverageIncompleteTotal}`,
    '# HELP vhhealth_continuity_edge_last_sync_success_timestamp_seconds Unix timestamp of the latest successful edge sync.',
    '# TYPE vhhealth_continuity_edge_last_sync_success_timestamp_seconds gauge',
    `vhhealth_continuity_edge_last_sync_success_timestamp_seconds{${facility}} ${state.edgeLastSyncSuccessTimestampSeconds}`,
    '# HELP vhhealth_continuity_edge_replication_lag_seconds Observed continuity-edge replication lag.',
    '# TYPE vhhealth_continuity_edge_replication_lag_seconds gauge',
    `vhhealth_continuity_edge_replication_lag_seconds{${facility}} ${state.edgeReplicationLagSeconds}`,
    '',
  );
  return lines.join('\n');
}

async function updateMetrics({ statePath, prometheusPath, facilityId }, mutate) {
  const lockPath = `${statePath}.lock`;
  return withDirectoryLock(lockPath, async () => {
    const state = await loadState(statePath);
    await mutate(state);
    await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await atomicWriteFile(prometheusPath, renderPrometheus(state, facilityId), {
      mode: 0o644,
    });
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
    // Only a real coverage judgement moves the counter. A verification failure
    // also zeroes the gauge, but it has its own counter and its own alert —
    // counting it here too would page twice for one event.
    if (!coverageComplete) {
      state.coverageIncompleteTotal =
        normalizeCoverageIncompleteTotal(state.coverageIncompleteTotal) + 1;
    }
    state.coverageComplete = coverageComplete ? 1 : 0;
    state.edgeLastSyncSuccessTimestampSeconds = successMs / 1000;
    state.edgeReplicationLagSeconds = Math.max(0, (successMs - generatedMs) / 1000);
    state.packFreshUntilTimestampSeconds = freshUntilMs / 1000;
  });
}

export function defaultMetricPaths(dataRoot, prometheusPath, facilityId) {
  return {
    statePath: path.join(dataRoot, 'state', 'metrics.json'),
    prometheusPath,
    facilityId,
  };
}
