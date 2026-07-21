import { readFileSync } from 'node:fs';

import {
  evaluateEvidence,
  parseArgs,
} from '../../../scripts/care-pathway-reconciliation-evidence.mjs';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATHWAY_KEY = 'diagnostics_order_to_action';
const REGISTRY_CHECKSUM = 'a'.repeat(64);
const GOVERNANCE_CHECKSUM = 'b'.repeat(64);

function validArgs() {
  return [
    `--tenant-id=${TENANT_ID}`,
    `--pathway-key=${PATHWAY_KEY}`,
    '--min-clean-sweeps=3',
    '--min-clean-span-seconds=120',
    '--min-sweep-separation-seconds=60',
    '--max-gap-seconds=180',
    '--max-age-seconds=90',
  ];
}

function evidence(id, completedAt, overrides = {}) {
  return {
    id: String(id),
    registry_checksum: REGISTRY_CHECKSUM,
    governance_checksum: GOVERNANCE_CHECKSUM,
    registry_complete: true,
    passed: true,
    finding_count: 0,
    repair_count: 0,
    error_count: 0,
    completed_at: new Date(completedAt),
    ...overrides,
  };
}

function evaluate(overrides = {}) {
  return evaluateEvidence({
    rows: [
      evidence(3, '2026-07-21T10:03:00.000Z'),
      evidence(2, '2026-07-21T10:02:00.000Z'),
      evidence(1, '2026-07-21T10:01:00.000Z'),
    ],
    mode: 'shadow',
    registryChecksum: REGISTRY_CHECKSUM,
    governanceChecksum: GOVERNANCE_CHECKSUM,
    registryComplete: true,
    projectorDebt: 0,
    databaseNow: new Date('2026-07-21T10:03:30.000Z'),
    thresholds: parseArgs(validArgs()),
    ...overrides,
  });
}

describe('care pathway reconciliation evidence command', () => {
  test('requires every owner-approved threshold with no zero or default value', () => {
    expect(parseArgs(validArgs())).toMatchObject({
      tenantId: TENANT_ID,
      pathwayKey: PATHWAY_KEY,
      minCleanSweeps: 3,
      minCleanSpanSeconds: 120,
      minSweepSeparationSeconds: 60,
      maxGapSeconds: 180,
      maxAgeSeconds: 90,
    });
    for (let index = 2; index < validArgs().length; index += 1) {
      const missing = validArgs().filter((_value, candidate) => candidate !== index);
      expect(() => parseArgs(missing)).toThrow(/missing required argument/i);
    }
    expect(() => parseArgs(validArgs().map((value) => (
      value.startsWith('--max-age-seconds=') ? '--max-age-seconds=0' : value
    )))).toThrow(/positive integer/i);
  });

  test('returns flip-ready only for a fresh, spaced, contiguous exact-checksum cohort', () => {
    expect(evaluate()).toEqual(expect.objectContaining({
      ready: true,
      verdict: 'FLIP-READY FOR OWNER REVIEW',
      reasons: [],
      counted_evidence_ids: ['3', '2', '1'],
      counted_clean_sweeps: 3,
      clean_span_seconds: 120,
      latest_evidence_age_seconds: 30,
    }));
  });

  test('deduplicates too-close observations without inflating the clean streak', () => {
    const report = evaluate({
      rows: [
        evidence(4, '2026-07-21T10:03:00.000Z'),
        evidence(3, '2026-07-21T10:02:30.000Z'),
        evidence(2, '2026-07-21T10:02:00.000Z'),
        evidence(1, '2026-07-21T10:01:00.000Z'),
      ],
    });
    expect(report.counted_evidence_ids).toEqual(['4', '2', '1']);
    expect(report.ready).toBe(true);
  });

  test('fails closed on cohort changes, drift, gaps, staleness, mode, registry, or projector debt', () => {
    expect(evaluate({ mode: 'active' }).reasons).toContain('CURRENT_MODE_NOT_SHADOW');
    expect(evaluate({ registryComplete: false }).reasons)
      .toContain('CURRENT_REGISTRY_INCOMPLETE');
    expect(evaluate({ projectorDebt: 1 }).reasons).toContain('PROJECTOR_GENERATION_DEBT');
    expect(evaluate({
      rows: [evidence(3, '2026-07-21T10:03:00.000Z', {
        registry_checksum: 'c'.repeat(64),
      })],
    }).reasons).toContain('LATEST_CHECKSUM_COHORT_STALE');
    expect(evaluate({
      rows: [
        evidence(3, '2026-07-21T10:03:00.000Z'),
        evidence(2, '2026-07-21T10:02:00.000Z', { repair_count: 1, passed: false }),
      ],
    }).reasons).toContain('CLEAN_COHORT_INTERRUPTED');
    expect(evaluate({
      rows: [
        evidence(3, '2026-07-21T10:03:00.000Z'),
        evidence(2, '2026-07-21T09:59:00.000Z'),
      ],
    }).reasons).toContain('CLEAN_COHORT_GAP_EXCEEDED');
    expect(evaluate({ databaseNow: new Date('2026-07-21T10:10:00.000Z') }).reasons)
      .toContain('LATEST_EVIDENCE_NOT_FRESH');
  });

  test('is statically read-only and cannot import activation authority', () => {
    const source = readFileSync(
      new URL('../../../scripts/care-pathway-reconciliation-evidence.mjs', import.meta.url),
      'utf8',
    );
    expect(source).toContain('READ ONLY');
    expect(source).not.toMatch(/\bUPDATE\b/i);
    expect(source).not.toContain('createPathwayActivationCapability');
    expect(source).not.toContain('settingsService');
  });
});
