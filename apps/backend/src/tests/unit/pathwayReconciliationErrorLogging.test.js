/**
 * F-L5 — reconciliation error logging regression.
 *
 * Two catch blocks in pathwayReconciliationService.js swallowed the caught
 * error's identity:
 *   1. runCarePathwayReconciliationForTenantPathway's catch logged
 *      "Care pathway reconciliation observation failed" with tenant/pathway/
 *      code only — no error.message, no error.stack — so every technical
 *      failure was undiagnosable from logs.
 *   2. The sweep loop's catch was a bare `catch {}` that recorded
 *      { failed: true } with zero logging.
 *
 * This test forces both paths to fail and asserts the log meta now carries
 * the error message and stack. Pure unit test: prisma + logger fully mocked,
 * no DB.
 */

import { jest } from '@jest/globals';

const errorMock = jest.fn();
const setTenantTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    $transaction: jest.fn(),
  },
  setTenant: jest.fn(),
  setTenantTx: setTenantTxMock,
  isTenantTransactionClient: () => true,
  circuitBreakerStatus: () => ({}),
  prismaReadOnly: {},
  tenantRlsRuntimeRole: () => null,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: errorMock,
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  runCarePathwayReconciliationForTenantPathway,
  runCarePathwayReconciliationSweep,
} = await import('../../services/pathways/pathwayReconciliationService.js');
const { CANONICAL_PATHWAY_KEYS } = await import('../../services/pathways/pathwayMode.js');

const TENANT = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  errorMock.mockClear();
  setTenantTxMock.mockReset();
});

describe('pathway reconciliation error logging (F-L5)', () => {
  it('logs error.message and error.stack when an observation fails', async () => {
    setTenantTxMock.mockRejectedValue(new Error('synthetic observation failure'));

    await expect(runCarePathwayReconciliationForTenantPathway({
      tenantId: TENANT,
      pathwayKey: CANONICAL_PATHWAY_KEYS[0],
    })).rejects.toThrow('synthetic observation failure');

    const call = errorMock.mock.calls.find(
      ([message]) => message === 'Care pathway reconciliation observation failed',
    );
    expect(call).toBeDefined();
    expect(call[1]).toMatchObject({
      tenantId: TENANT,
      pathwayKey: CANONICAL_PATHWAY_KEYS[0],
      code: 'RECONCILIATION_TECHNICAL_ERROR',
      error: 'synthetic observation failure',
    });
    expect(typeof call[1].stack).toBe('string');
    expect(call[1].stack).toContain('synthetic observation failure');
  });

  it('logs the bound error (message + stack) from the sweep-loop catch', async () => {
    setTenantTxMock.mockImplementation(async (tenantIdArg, fn, options) => {
      if (options?.superAdmin) return [{ id: TENANT }];
      throw new Error('synthetic sweep failure');
    });

    const sweep = await runCarePathwayReconciliationSweep();

    // Every tenant/pathway observation failed and was recorded as such.
    expect(sweep.observations).toHaveLength(CANONICAL_PATHWAY_KEYS.length);
    expect(sweep.observations.every((entry) => entry.failed === true)).toBe(true);

    const sweepCalls = errorMock.mock.calls.filter(
      ([message]) => message === 'Care pathway reconciliation sweep observation failed',
    );
    expect(sweepCalls).toHaveLength(CANONICAL_PATHWAY_KEYS.length);
    for (const [, meta] of sweepCalls) {
      expect(meta).toMatchObject({
        tenantId: TENANT,
        sweepId: sweep.sweep_id,
        error: 'synthetic sweep failure',
      });
      expect(CANONICAL_PATHWAY_KEYS).toContain(meta.pathwayKey);
      expect(typeof meta.stack).toBe('string');
      expect(meta.stack).toContain('synthetic sweep failure');
    }
  });
});
