import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: prismaMock,
  isTenantTransactionClient: () => true,
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

const { createBedCleaningRequest } = await import(
  '../../services/staff/housekeepingTaskDispatchService.js'
);

const REQUESTER_UID = '11111111-2222-4333-8444-000000000001';
const STAFF_UID = '11111111-2222-4333-8444-000000000002';
const INCHARGE_UID = '11111111-2222-4333-8444-000000000003';

describe('housekeepingTaskDispatchService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let recipientInsertId = 1;
    prismaMock.$executeRawUnsafe.mockResolvedValue(1);
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (sql.includes('SELECT b.id AS bed_id')) {
        return [{
          bed_id: 42,
          bed_number: 'ICU-001',
          ward_id: 7,
          ward_name: 'ICU',
          floor: '1',
          status: 'cleaning',
        }];
      }
      if (sql.includes('WHERE uid = $1::uuid')) {
        return [{ id: 10, uid: REQUESTER_UID, name: 'Charge Nurse', phone: '9000000010', role: 'NURSING_STAFF' }];
      }
      if (sql.includes('staff_shift_roster_boards')) {
        return [{ id: 20, uid: STAFF_UID, name: 'HK Staff', phone: '9000000020', role: 'HOUSEKEEPING_STAFF', recipient_kind: 'assigned_staff', source: 'published_roster' }];
      }
      if (sql.includes('housekeeping_floor_assignments')) {
        return [];
      }
      if (sql.includes("role = 'HOUSEKEEPING_INCHARGE'")) {
        return [{ id: 30, uid: INCHARGE_UID, name: 'HK Incharge', phone: '9000000030', role: 'HOUSEKEEPING_INCHARGE', recipient_kind: 'incharge', source: 'housekeeping_incharge' }];
      }
      if (sql.includes('FROM housekeeping_zones')) {
        return [];
      }
      if (sql.includes('FROM housekeeping_requests') && sql.includes('COALESCE(status')) {
        return [];
      }
      if (sql.includes('INSERT INTO housekeeping_requests')) {
        return [{
          id: 100,
          request_number: 'HKR-100',
          assigned_to: params[6],
          assigned_to_uid: params[7],
          status: params[9],
        }];
      }
      if (sql.includes('INSERT INTO housekeeping_request_recipients')) {
        return [{
          id: recipientInsertId++,
          request_id: params[0],
          staff_id: params[1],
          staff_uid: params[2],
          recipient_kind: params[3],
          source: params[4],
        }];
      }
      if (sql.includes('SELECT DISTINCT ON (u.id)') && sql.includes('FROM users u')) {
        return [
          {
            id: 20,
            uid: STAFF_UID,
            name: 'HK Staff',
            phone: '9000000020',
            role: 'HOUSEKEEPING_STAFF',
            department: 'housekeeping',
          },
          {
            id: 30,
            uid: INCHARGE_UID,
            name: 'HK Incharge',
            phone: '9000000030',
            role: 'HOUSEKEEPING_INCHARGE',
            department: 'housekeeping',
          },
        ];
      }
      if (sql.includes('INSERT INTO notifications')) {
        return [{ id: 500 }, { id: 501 }];
      }
      throw new Error(`Unhandled SQL in test: ${sql.slice(0, 80)}`);
    });
  });

  it('creates one bed-cleaning request routed to roster staff plus housekeeping incharge', async () => {
    const result = await createBedCleaningRequest({
      bedId: 42,
      requesterUid: REQUESTER_UID,
      trigger: 'bed_transfer',
      now: new Date('2026-05-28T09:00:00.000Z'),
    });

    expect(result.created).toBe(true);
    expect(result.request).toMatchObject({
      id: 100,
      assigned_to: 20,
      assigned_to_uid: STAFF_UID,
      status: 'assigned',
    });
    expect(result.recipients.map(row => row.id)).toEqual([20, 30]);

    const requestInsert = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO housekeeping_requests')
    );
    expect(requestInsert).toBeTruthy();
    expect(requestInsert[3]).toBeNull();
    expect(requestInsert.slice(1, 11)).toEqual(expect.arrayContaining([
      10,
      REQUESTER_UID,
      'ICU / ICU-001',
      'high',
      20,
      STAFF_UID,
      'assigned',
    ]));

    const recipientInserts = prismaMock.$queryRawUnsafe.mock.calls.filter(([sql]) =>
      sql.includes('INSERT INTO housekeeping_request_recipients')
    );
    expect(recipientInserts).toHaveLength(2);

    const notificationInsert = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO notifications')
    );
    expect(notificationInsert).toBeTruthy();
    expect(notificationInsert[6]).toContain('"source":"bed_cleaning_dispatch"');
    expect(result.fanout.notification_count).toBe(2);
  });
});
