#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
} from '../src/config/pathwayProjectorConfig.js';
import { CANONICAL_PATHWAY_KEYS } from '../src/services/pathways/pathwayMode.js';
import {
  pathwayReconciliationRegistry,
} from '../src/services/pathways/pathwayReconciliationRegistry.js';
import {
  loadGovernanceSnapshotTx,
} from '../src/services/pathways/pathwayReconciliationService.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVIDENCE_ROWS = 10_000;
export const NOT_READY_EXIT_CODE = 2;

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

export function parseArgs(argv) {
  const values = new Map();
  let help = false;
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Unknown argument: ${argument}`);
    if (values.has(match[1])) throw new Error(`Duplicate argument: --${match[1]}`);
    values.set(match[1], match[2]);
  }
  if (help) return { help: true };
  const required = [
    'tenant-id',
    'pathway-key',
    'min-clean-sweeps',
    'min-clean-span-seconds',
    'min-sweep-separation-seconds',
    'max-gap-seconds',
    'max-age-seconds',
  ];
  for (const name of required) {
    if (!values.has(name)) throw new Error(`Missing required argument: --${name}`);
  }
  for (const name of values.keys()) {
    if (!required.includes(name)) throw new Error(`Unknown argument: --${name}`);
  }
  const tenantId = values.get('tenant-id').toLowerCase();
  const pathwayKey = values.get('pathway-key');
  if (!UUID_PATTERN.test(tenantId)) throw new Error('--tenant-id must be a UUID');
  if (!CANONICAL_PATHWAY_KEYS.includes(pathwayKey)) {
    throw new Error('--pathway-key must be one of the six canonical pathway keys');
  }
  return {
    help: false,
    tenantId,
    pathwayKey,
    minCleanSweeps: positiveInteger(values.get('min-clean-sweeps'), '--min-clean-sweeps'),
    minCleanSpanSeconds: positiveInteger(
      values.get('min-clean-span-seconds'),
      '--min-clean-span-seconds',
    ),
    minSweepSeparationSeconds: positiveInteger(
      values.get('min-sweep-separation-seconds'),
      '--min-sweep-separation-seconds',
    ),
    maxGapSeconds: positiveInteger(values.get('max-gap-seconds'), '--max-gap-seconds'),
    maxAgeSeconds: positiveInteger(values.get('max-age-seconds'), '--max-age-seconds'),
  };
}

function secondsBetween(newer, older) {
  return (new Date(newer).getTime() - new Date(older).getTime()) / 1000;
}

export function evaluateEvidence({
  rows,
  mode,
  registryChecksum,
  governanceChecksum,
  registryComplete,
  projectorDebt,
  databaseNow,
  thresholds,
}) {
  const reasons = [];
  if (mode !== 'shadow') reasons.push('CURRENT_MODE_NOT_SHADOW');
  if (!registryComplete) reasons.push('CURRENT_REGISTRY_INCOMPLETE');
  if (projectorDebt !== 0) reasons.push('PROJECTOR_GENERATION_DEBT');
  if (!Array.isArray(rows) || rows.length === 0) reasons.push('NO_EVIDENCE');

  const cohort = [];
  let previous = null;
  for (const row of rows || []) {
    if (
      row.registry_checksum !== registryChecksum
      || row.governance_checksum !== governanceChecksum
    ) {
      if (cohort.length === 0) reasons.push('LATEST_CHECKSUM_COHORT_STALE');
      break;
    }
    if (previous && secondsBetween(previous.completed_at, row.completed_at) > thresholds.maxGapSeconds) {
      reasons.push('CLEAN_COHORT_GAP_EXCEEDED');
      break;
    }
    if (
      row.passed !== true
      || row.registry_complete !== true
      || Number(row.finding_count) !== 0
      || Number(row.repair_count) !== 0
      || Number(row.error_count) !== 0
    ) {
      reasons.push('CLEAN_COHORT_INTERRUPTED');
      break;
    }
    cohort.push(row);
    previous = row;
  }

  const counted = [];
  for (const row of cohort) {
    const prior = counted[counted.length - 1];
    if (
      !prior
      || secondsBetween(prior.completed_at, row.completed_at)
        >= thresholds.minSweepSeparationSeconds
    ) counted.push(row);
  }
  if (counted.length < thresholds.minCleanSweeps) reasons.push('MIN_CLEAN_SWEEPS_NOT_MET');
  const spanSeconds = counted.length > 1
    ? secondsBetween(counted[0].completed_at, counted[counted.length - 1].completed_at)
    : 0;
  if (spanSeconds < thresholds.minCleanSpanSeconds) reasons.push('MIN_CLEAN_SPAN_NOT_MET');
  const ageSeconds = counted.length > 0
    ? secondsBetween(databaseNow, counted[0].completed_at)
    : null;
  if (ageSeconds === null || ageSeconds < 0 || ageSeconds > thresholds.maxAgeSeconds) {
    reasons.push('LATEST_EVIDENCE_NOT_FRESH');
  }
  return {
    ready: reasons.length === 0,
    verdict: reasons.length === 0
      ? 'FLIP-READY FOR OWNER REVIEW'
      : 'NOT READY',
    reasons: [...new Set(reasons)],
    counted_evidence_ids: counted.map((row) => String(row.id)),
    counted_clean_sweeps: counted.length,
    clean_span_seconds: spanSeconds,
    latest_evidence_age_seconds: ageSeconds,
  };
}

function clientAdapter(client) {
  return {
    async $queryRawUnsafe(sql, ...params) {
      const response = await client.query(sql, params);
      return response.rows;
    },
  };
}

async function collectEvidence(client, options) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [
      options.tenantId,
    ]);
    const timeResult = await client.query('SELECT clock_timestamp() AS database_now');
    const databaseNow = timeResult.rows[0].database_now;
    const modeResult = await client.query(
      `SELECT CASE
                WHEN jsonb_typeof(settings) = 'object'
                 AND jsonb_typeof(settings -> 'care_pathways') = 'object'
                THEN settings #>> ARRAY['care_pathways', $2::text]
                ELSE NULL
              END AS mode
         FROM tenants
        WHERE id = $1::uuid`,
      [options.tenantId, options.pathwayKey],
    );
    const governance = await loadGovernanceSnapshotTx({
      tx: clientAdapter(client),
      tenantId: options.tenantId,
      pathwayKey: options.pathwayKey,
      capturedAt: databaseNow,
    });
    const profile = pathwayReconciliationRegistry.resolveProfile(options.pathwayKey);
    const covered = governance.tuples.filter((tuple) => (
      pathwayReconciliationRegistry.matchDomainAdapter(options.pathwayKey, {
        governanceId: tuple.governance_id,
        workflowDefinitionId: tuple.workflow_definition_id,
        definitionVersion: tuple.definition_version,
        definitionChecksum: tuple.definition_checksum,
      })
    )).length;
    const registryComplete = Boolean(
      !profile.blockingReason
      && governance.tuples.length > 0
      && governance.invalidApprovalCount === 0
      && covered === governance.tuples.length
    );
    const projectorResult = await client.query(
      `SELECT (
         CASE WHEN offsets.consumer_key IS NULL THEN 1 ELSE 0 END
         + CASE WHEN offsets.backfill_completed_at IS NULL THEN 1 ELSE 0 END
         + CASE WHEN offsets.intake_retired_at IS NOT NULL THEN 1 ELSE 0 END
         + COALESCE(inbox.debt_count, 0)
         + COALESCE(missing.debt_count, 0)
       )::integer AS debt_count
         FROM (SELECT $1::text AS consumer_key, $2::integer AS generation) AS expected
         LEFT JOIN event_consumer_offsets AS offsets
           ON offsets.consumer_key = expected.consumer_key
          AND offsets.generation = expected.generation
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::integer AS debt_count
             FROM pathway_projector_inbox
            WHERE tenant_id = $3::uuid
              AND consumer_key = expected.consumer_key
              AND generation = expected.generation
              AND (
                status = 'dead'
                OR (status = 'pending' AND lease_expires_at < $4::timestamptz)
              )
         ) AS inbox ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::integer AS debt_count
             FROM event_outbox AS event
            WHERE event.tenant_id = $3::uuid
              AND offsets.consumer_key IS NOT NULL
              AND (
                event.id <= offsets.backfill_cursor_event_id
                OR event.id > offsets.historical_cutoff_event_id
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM pathway_projector_inbox AS candidate
                 WHERE candidate.tenant_id = event.tenant_id
                   AND candidate.consumer_key = expected.consumer_key
                   AND candidate.generation = expected.generation
                   AND candidate.event_id = event.id
              )
         ) AS missing ON TRUE`,
      [
        PATHWAY_PROJECTOR_CONSUMER_KEY,
        PATHWAY_PROJECTOR_GENERATION,
        options.tenantId,
        databaseNow,
      ],
    );
    const evidenceResult = await client.query(
      `SELECT id::text, registry_checksum, governance_checksum,
              registry_complete, passed, finding_count, repair_count,
              error_count, completed_at
         FROM care_pathway_reconciliation_checks
        WHERE tenant_id = $1::uuid
          AND pathway_key = $2::text
        ORDER BY completed_at DESC, id DESC
        LIMIT $3::integer`,
      [options.tenantId, options.pathwayKey, MAX_EVIDENCE_ROWS],
    );
    const evaluation = evaluateEvidence({
      rows: evidenceResult.rows,
      mode: modeResult.rows[0]?.mode || 'off',
      registryChecksum: pathwayReconciliationRegistry.checksum,
      governanceChecksum: governance.checksum,
      registryComplete,
      projectorDebt: Number(projectorResult.rows[0]?.debt_count || 0),
      databaseNow,
      thresholds: options,
    });
    await client.query('COMMIT');
    return {
      gate: 'care_pathway_reconciliation_evidence',
      tenant_id: options.tenantId,
      pathway_key: options.pathwayKey,
      current_mode: modeResult.rows[0]?.mode || 'off',
      registry_version: pathwayReconciliationRegistry.version,
      registry_checksum: pathwayReconciliationRegistry.checksum,
      governance_checksum: governance.checksum,
      governance_count: governance.tuples.length,
      covered_governance_count: covered,
      projector_debt_count: Number(projectorResult.rows[0]?.debt_count || 0),
      thresholds: {
        min_clean_sweeps: options.minCleanSweeps,
        min_clean_span_seconds: options.minCleanSpanSeconds,
        min_sweep_separation_seconds: options.minSweepSeparationSeconds,
        max_gap_seconds: options.maxGapSeconds,
        max_age_seconds: options.maxAgeSeconds,
      },
      ...evaluation,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function usage() {
  return [
    'Usage:',
    '  node scripts/care-pathway-reconciliation-evidence.mjs',
    '    --tenant-id=<uuid> --pathway-key=<canonical-key>',
    '    --min-clean-sweeps=<positive-int>',
    '    --min-clean-span-seconds=<positive-int>',
    '    --min-sweep-separation-seconds=<positive-int>',
    '    --max-gap-seconds=<positive-int>',
    '    --max-age-seconds=<positive-int>',
    '',
    'All window values require owner sign-off. This read-only command never changes pathway mode.',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const connectionString = process.env.CARE_PATHWAY_RECONCILIATION_EVIDENCE_DATABASE_URL
    || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Evidence database URL is required');
  const client = new Client({
    connectionString,
    application_name: 'care-pathway-reconciliation-evidence',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 120_000,
  });
  try {
    await client.connect();
    const report = await collectEvidence(client, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ready ? 0 : NOT_READY_EXIT_CODE;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.stderr.write('[care-pathway-reconciliation-evidence] evidence collection failed\n');
      process.exitCode = 1;
    });
}
