import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

import {
  isPathwayReconciliationEnabled,
  isPathwayReconciliationRepairEnabled,
  pathwayReconciliationCron,
} from '../../config/pathwayReconciliationConfig.js';
import {
  computePathwayReconciliationPass,
  executeRegisteredRepairsTx,
} from '../../services/pathways/pathwayReconciliationService.js';
import {
  createPathwayReconciliationRegistry,
} from '../../services/pathways/pathwayReconciliationRegistry.js';
import { CANONICAL_PATHWAY_KEYS } from '../../services/pathways/pathwayMode.js';

const CHECKSUM = 'a'.repeat(64);
const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const SLA_ID = '20000000-0000-4000-8000-000000000001';
const CAPTURED_AT = new Date('2026-07-21T10:00:00.000Z');

function registryWithRepair(callbacks = {}) {
  const repair = {
    ruleCode: 'test_ack',
    sourceTable: 'test_results',
    handlerVersion: 'test.repair.v1',
    enabled: true,
    findCandidates: jest.fn(async () => [{ slaId: SLA_ID }]),
    validateSource: jest.fn(async () => ({ valid: true })),
    resolveOwner: jest.fn(async () => ({ valid: true, assignedToUid: TENANT_ID })),
    materializeTask: jest.fn(async () => ({ ok: true })),
    ...callbacks,
  };
  const common = {
    id: 'common_integrity',
    handlerVersion: 'test.common.v1',
    run: jest.fn(async () => ({ code: 'COMMON_INTEGRITY', finding_count: 0 })),
  };
  const profiles = CANONICAL_PATHWAY_KEYS.map((pathwayKey, index) => ({
    pathwayKey,
    profileVersion: 1,
    commonCheckIds: [common.id],
    domainAdapters: [],
    repairDescriptors: index === 0 ? [repair] : [],
    excludedClocks: [],
    blockingReason: 'test_domain_adapter_pending',
  }));
  return {
    registry: createPathwayReconciliationRegistry({
      version: 1,
      commonChecks: [common],
      profiles,
    }),
    repair,
  };
}

function cleanPass(overrides = {}) {
  return {
    pathwayMode: 'shadow',
    registryComplete: true,
    governanceCount: 1,
    coveredGovernanceCount: 1,
    expectedCheckCount: 2,
    executedCheckCount: 2,
    findingCount: 0,
    repairCount: 0,
    errorCount: 0,
    ...overrides,
  };
}

describe('pathway reconciliation evidence', () => {
  test('accepts only the exact clean shadow contract', () => {
    expect(computePathwayReconciliationPass(cleanPass())).toBe(true);
    for (const deviation of [
      { pathwayMode: 'off' },
      { pathwayMode: 'active' },
      { registryComplete: false },
      { governanceCount: 0, coveredGovernanceCount: 0 },
      { coveredGovernanceCount: 0 },
      { expectedCheckCount: 0, executedCheckCount: 0 },
      { executedCheckCount: 1 },
      { findingCount: 1 },
      { repairCount: 1 },
      { errorCount: 1 },
    ]) {
      expect(computePathwayReconciliationPass(cleanPass(deviation))).toBe(false);
    }
  });

  test('defaults observation and repair off with an operational-only cadence', () => {
    expect(isPathwayReconciliationEnabled({})).toBe(false);
    expect(isPathwayReconciliationRepairEnabled({})).toBe(false);
    expect(isPathwayReconciliationEnabled({ CARE_PATHWAY_RECONCILIATION_ENABLED: 'true' }))
      .toBe(true);
    expect(isPathwayReconciliationRepairEnabled({
      CARE_PATHWAY_RECONCILIATION_REPAIR_ENABLED: ' TRUE ',
    })).toBe(true);
    expect(pathwayReconciliationCron({})).toBe('*/15 * * * *');
    expect(pathwayReconciliationCron({ CARE_PATHWAY_RECONCILIATION_CRON: '7 * * * *' }))
      .toBe('7 * * * *');
  });

  test('admits repair only through a branded exact descriptor and strict producer', async () => {
    const { registry, repair } = registryWithRepair();
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('SELECT sla.*')) {
          return [{
            id: SLA_ID,
            tenant_id: TENANT_ID,
            status: 'active',
            completed_at: null,
            due_at: new Date('2026-07-21T09:00:00.000Z'),
            breached_at: null,
          }];
        }
        if (sql.includes('UPDATE workflow_sla_instances')) return [{ id: SLA_ID }];
        throw new Error('unexpected query');
      }),
    };
    const results = await executeRegisteredRepairsTx({
      tx,
      tenantId: TENANT_ID,
      pathwayKey: CANONICAL_PATHWAY_KEYS[0],
      capturedAt: CAPTURED_AT,
      registry,
      repairEnabled: true,
    });
    expect(results).toEqual([{
      code: 'SLA_REPAIR_APPLIED',
      finding_count: 0,
      repair_count: 1,
      error_count: 0,
    }]);
    expect(repair.materializeTask).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      strict: true,
    }));
    await expect(executeRegisteredRepairsTx({
      tx,
      tenantId: TENANT_ID,
      pathwayKey: CANONICAL_PATHWAY_KEYS[0],
      capturedAt: CAPTURED_AT,
      registry: { ...registry },
      repairEnabled: true,
    })).rejects.toThrow(/branded registry/i);
  });

  test('does not inspect candidates or mutate when the repair gate is off', async () => {
    const { registry, repair } = registryWithRepair();
    const tx = { $queryRawUnsafe: jest.fn() };
    await expect(executeRegisteredRepairsTx({
      tx,
      tenantId: TENANT_ID,
      pathwayKey: CANONICAL_PATHWAY_KEYS[0],
      capturedAt: CAPTURED_AT,
      registry,
      repairEnabled: false,
    })).resolves.toEqual([]);
    expect(repair.findCandidates).not.toHaveBeenCalled();
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('contains no pathway activation capability or tenant-setting mutation', () => {
    const source = readFileSync(
      new URL('../../services/pathways/pathwayReconciliationService.js', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('createPathwayActivationCapability');
    expect(source).not.toContain('PATHWAY_ACTIVE_CAPABILITY');
    expect(source).not.toMatch(/UPDATE\s+tenants/i);
  });

  test('pins the exact SLA update CAS before strict task materialization', () => {
    const source = readFileSync(
      new URL('../../services/pathways/pathwayReconciliationService.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain("AND status = 'active'");
    expect(source).toContain('AND completed_at IS NULL');
    expect(source).toContain('AND due_at < $5::timestamptz');
    expect(source.indexOf('UPDATE workflow_sla_instances'))
      .toBeLessThan(source.indexOf('descriptor.materializeTask'));
  });
});
