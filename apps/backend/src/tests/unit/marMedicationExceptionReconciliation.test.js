import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const db = { $queryRawUnsafe: queryRawUnsafe };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: db,
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: jest.fn() },
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
  startWorkflowSla: jest.fn(),
}));

const { reconcileMarMedicationExceptions } = await import(
  '../../services/clinical/marMedicationExceptionService.js'
);

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryRawUnsafe.mockReset();
});

describe('MAR medication exception reconciliation readiness', () => {
  test.each([
    [
      'unattributed held state',
      {
        blocked_count: 1,
        missing_attribution_count: 1,
        missing_order_count: 0,
        blocked_rows: [{
          medication_administration_id: 42,
          exception_kind: 'held',
          missing_attribution: true,
          missing_clinical_order: false,
        }],
      },
    ],
    [
      'unlinked missed state',
      {
        blocked_count: 1,
        missing_attribution_count: 0,
        missing_order_count: 1,
        blocked_rows: [{
          medication_administration_id: 43,
          exception_kind: 'missed',
          missing_attribution: false,
          missing_clinical_order: true,
        }],
      },
    ],
  ])('fails closed on %s instead of silently skipping it', async (_label, readiness) => {
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([readiness]);

    await expect(reconcileMarMedicationExceptions({
      tenantId: TENANT_ID,
      createTaskTx: jest.fn(),
      db,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'MAR_EXCEPTION_RECONCILIATION_READINESS_FAILED',
      details: expect.objectContaining({
        blocked_count: 1,
        blocked_rows: readiness.blocked_rows,
      }),
    });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  test('returns a bounded empty sweep only after the readiness preflight is clean', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        blocked_count: 0,
        missing_attribution_count: 0,
        missing_order_count: 0,
        blocked_rows: [],
      }])
      .mockResolvedValueOnce([]);

    await expect(reconcileMarMedicationExceptions({
      tenantId: TENANT_ID,
      limit: 250,
      createTaskTx: jest.fn(),
      db,
    })).resolves.toEqual({
      scanned: 0,
      materialized: 0,
      coverage_gaps: 0,
      skipped_changed: 0,
      failures: [],
      escalation: {
        scanned: 0,
        escalated: 0,
        awaiting_recipients: 0,
        skipped_changed: 0,
        failures: [],
      },
    });
    expect(queryRawUnsafe.mock.calls[2][2]).toBe(100);
  });

  test('keeps tenant-wide readiness counts while bounding legacy evidence to 25 rows', async () => {
    const blockedRows = Array.from({ length: 25 }, (_, index) => ({
      medication_administration_id: index + 1,
      exception_kind: index % 2 === 0 ? 'held' : 'missed',
      missing_attribution: true,
      missing_clinical_order: false,
    }));
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        blocked_count: 250_000,
        missing_attribution_count: 250_000,
        missing_order_count: 0,
        blocked_rows: blockedRows,
        sample_truncated: true,
      }]);

    await expect(reconcileMarMedicationExceptions({
      tenantId: TENANT_ID,
      createTaskTx: jest.fn(),
      db,
    })).rejects.toMatchObject({
      statusCode: 503,
      code: 'MAR_EXCEPTION_RECONCILIATION_READINESS_FAILED',
      details: expect.objectContaining({
        blocked_count: 250_000,
        blocked_rows: blockedRows,
        sample_truncated: true,
      }),
    });
    expect(queryRawUnsafe.mock.calls[1][0]).toMatch(/ORDER BY id\s+LIMIT 25/);
  });
});
