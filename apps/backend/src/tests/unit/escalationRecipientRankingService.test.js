import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const transactionMock = jest.fn(async (_tenantId, fn) => fn({
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: transactionMock,
}));

const {
  getEscalationRecipientRankings,
  replaceEscalationRecipientRankings,
  validateEscalationRecipientRankingInput,
  normalizeEscalationRankLabel,
} = await import('../../services/workflow/escalationRecipientRankingService.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryRawMock.mockReset();
  executeRawMock.mockReset().mockResolvedValue(1);
  transactionMock.mockClear();
});

describe('escalationRecipientRankingService validation', () => {
  test('normalizes whitespace/case and accepts bounded ranks/window', () => {
    expect(normalizeEscalationRankLabel('  Senior   Consultant ')).toBe('senior consultant');
    expect(validateEscalationRecipientRankingInput({
      presenceWindowMinutes: 600,
      mappings: [{ sourceKind: 'POSITION', sourceValue: ' Senior   Consultant ', priorityRank: 1 }],
    })).toEqual({
      presenceWindowMinutes: 600,
      mappings: [{
        sourceKind: 'position',
        sourceValue: 'Senior Consultant',
        normalizedSourceValue: 'senior consultant',
        priorityRank: 1,
      }],
    });
    expect(validateEscalationRecipientRankingInput({ mappings: [] }).presenceWindowMinutes)
      .toBe(720);
  });

  test('rejects normalization-equivalent duplicates and out-of-range input', () => {
    expect(() => validateEscalationRecipientRankingInput({
      mappings: [
        { sourceKind: 'position', sourceValue: 'Duty Doctor', priorityRank: 1 },
        { sourceKind: 'position', sourceValue: ' duty   doctor ', priorityRank: 2 },
      ],
    })).toThrow(/duplicate/i);
    expect(() => validateEscalationRecipientRankingInput({ mappings: [], presenceWindowMinutes: 14 }))
      .toThrow(/15 through 2880/i);
    expect(() => validateEscalationRecipientRankingInput({
      mappings: [{ sourceKind: 'grade', sourceValue: 'A', priorityRank: 1 }],
    })).toThrow(/position or designation/i);
  });
});

describe('escalationRecipientRankingService persistence contract', () => {
  test('invalid duplicate input opens no transaction and writes no audit', async () => {
    await expect(replaceEscalationRecipientRankings({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      mappings: [
        { sourceKind: 'position', sourceValue: 'Duty Doctor', priorityRank: 1 },
        { sourceKind: 'position', sourceValue: ' duty   doctor ', priorityRank: 2 },
      ],
    })).rejects.toThrow(/duplicate/i);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
  });

  test('GET distinguishes never configured from an explicit empty replacement', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ settings: {} }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        settings: {
          escalation_recipient_ranking: {
            configured: true,
            revision: 2,
            presence_window_minutes: 720,
            expected_mapping_count: 0,
            last_replaced_at: '2026-08-04T10:00:00.000Z',
            last_replaced_by: ACTOR,
          },
        },
      }])
      .mockResolvedValueOnce([]);

    await expect(getEscalationRecipientRankings(TENANT)).resolves.toMatchObject({
      configured: false, explicitEmpty: false, revision: 0, mappings: [],
    });
    await expect(getEscalationRecipientRankings(TENANT)).resolves.toMatchObject({
      configured: true, explicitEmpty: true, revision: 2, mappings: [],
    });
  });

  test('full replacement writes mappings, independent control count, and audit in one tenant tx', async () => {
    const beforeSettings = {};
    const afterSettings = {
      escalation_recipient_ranking: {
        configured: true,
        revision: 1,
        presence_window_minutes: 480,
        expected_mapping_count: 2,
        last_replaced_at: '2026-08-04T10:00:00.000Z',
        last_replaced_by: ACTOR,
      },
    };
    queryRawMock
      .mockResolvedValueOnce([{ settings: beforeSettings }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ settings: afterSettings }])
      .mockResolvedValueOnce([
        { id: 'a', source_kind: 'position', source_value: 'Consultant', priority_rank: 1 },
        { id: 'b', source_kind: 'designation', source_value: 'Duty Doctor', priority_rank: 2 },
      ]);

    const result = await replaceEscalationRecipientRankings({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      presenceWindowMinutes: 480,
      mappings: [
        { sourceKind: 'position', sourceValue: 'Consultant', priorityRank: 1 },
        { sourceKind: 'designation', sourceValue: 'Duty Doctor', priorityRank: 2 },
      ],
    });

    expect(transactionMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(result).toMatchObject({ configured: true, explicitEmpty: false, expectedMappingCount: 2 });
    expect(executeRawMock).toHaveBeenCalledTimes(4);
    expect(executeRawMock.mock.calls[0][0]).toMatch(/DELETE FROM escalation_recipient_rank_mappings/i);
    expect(executeRawMock.mock.calls[1][0]).toMatch(/INSERT INTO escalation_recipient_rank_mappings/i);
    expect(queryRawMock.mock.calls[2][0]).toMatch(/jsonb_set/i);
    expect(JSON.parse(queryRawMock.mock.calls[2][2])).toMatchObject({
      configured: true,
      expected_mapping_count: 2,
      presence_window_minutes: 480,
    });
    const auditCall = executeRawMock.mock.calls.at(-1);
    expect(auditCall[0]).toMatch(/ESCALATION_RECIPIENT_RANKINGS_REPLACED/);
    expect(auditCall[0]).toMatch(/jsonb_build_object\([\s\S]+\$2::uuid[\s\S]+\$3::text/i);
  });

  test('an audit failure rejects the same transaction rather than returning success', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ settings: {} }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        settings: {
          escalation_recipient_ranking: {
            configured: true, revision: 1, presence_window_minutes: 720,
            expected_mapping_count: 0,
          },
        },
      }])
      .mockResolvedValueOnce([]);
    executeRawMock
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(replaceEscalationRecipientRankings({
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      mappings: [],
    })).rejects.toThrow('audit unavailable');
  });
});
