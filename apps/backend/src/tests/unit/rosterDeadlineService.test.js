import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const {
  checkNextWeekRosterDeadline,
  getNextRosterWeekWindow,
} = await import('../../services/staff/rosterDeadlineService.js');

describe('rosterDeadlineService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$executeRawUnsafe.mockResolvedValue(1);
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (sql.includes('WITH days AS')) {
        return [
          { roster_date: '2026-06-01', board_count: 0, assignment_count: 0 },
          { roster_date: '2026-06-02', board_count: 1, assignment_count: 0 },
        ];
      }
      if (sql.includes('data->>\'department\'')) {
        return [];
      }
      if (sql.includes('INSERT INTO notifications')) {
        return [{ id: 9001 }];
      }
      if (sql.includes('FROM users')) {
        return [{
          id: 12,
          uid: '11111111-2222-4333-8444-000000010012',
          name: 'HR Manager',
          phone: '9000001012',
          role: 'HR_STAFF',
        }];
      }
      throw new Error(`Unhandled SQL in test: ${sql.slice(0, 80)}`);
    });
  });

  it('computes the following Monday-Sunday roster week', () => {
    expect(getNextRosterWeekWindow(new Date('2026-05-29T12:00:00.000Z'))).toEqual({
      weekStart: '2026-06-01',
      weekEnd: '2026-06-07',
    });
  });

  it('notifies HR when next week roster is missing after the deadline', async () => {
    const result = await checkNextWeekRosterDeadline({
      now: new Date('2026-05-29T12:00:00.000Z'),
      force: true,
      departments: ['housekeeping'],
    });

    expect(result.checked).toBe(true);
    expect(result.escalations).toEqual([
      expect.objectContaining({
        department: 'housekeeping',
        status: 'missing',
        missing_days: ['2026-06-01', '2026-06-02'],
        notification_count: 1,
      }),
    ]);

    const notificationInsert = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO notifications')
    );
    expect(notificationInsert).toBeTruthy();
    expect(notificationInsert[3]).toBe('ROSTER_DEADLINE');
    expect(notificationInsert[4]).toContain('"department":"housekeeping"');
  });
});
