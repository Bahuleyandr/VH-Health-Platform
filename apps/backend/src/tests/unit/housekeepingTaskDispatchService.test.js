import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};
prismaMock.$transaction = jest.fn(async (fn) => fn(prismaMock));

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
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

describe('housekeepingTaskDispatchService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    let recipientInsertId = 1;
    prismaMock.$executeRawUnsafe.mockResolvedValue(1);
    prismaMock.$queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (sql.includes('pg_advisory_xact_lock')) {
        return [{ lock_result: '' }];
      }
      if (sql.includes('SELECT b.id AS bed_id')) {
        return [{
          bed_id: 42,
          tenant_id: TENANT_ID,
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
          bed_id: params[3],
          patient_uid: params[4],
          assigned_to: params[8],
          assigned_to_uid: params[9],
          status: params[11],
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

    const requesterLookup = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes('WHERE uid = $1::uuid')
    );
    expect(requesterLookup[0]).toContain('tenant_id = $2::uuid');
    expect(requesterLookup[2]).toBe(TENANT_ID);

    const rosterLookup = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes('staff_shift_roster_boards')
    );
    expect(rosterLookup[0]).toContain('b.tenant_id = $4::uuid');
    expect(rosterLookup[4]).toBe(TENANT_ID);

    const inchargeLookup = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes("role = 'HOUSEKEEPING_INCHARGE'")
    );
    expect(inchargeLookup[0]).toContain('tenant_id = $1::uuid');
    expect(inchargeLookup[1]).toBe(TENANT_ID);

    const requestInsert = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO housekeeping_requests')
    );
    expect(requestInsert).toBeTruthy();
    expect(requestInsert[3]).toBeNull(); // zone_id (no matching zone)
    expect(requestInsert[4]).toBe(42); // structured bed linkage (migration 643)
    expect(requestInsert[5]).toBeNull(); // patient_uid (none passed)
    expect(requestInsert.slice(1, 13)).toEqual(expect.arrayContaining([
      10,
      REQUESTER_UID,
      'ICU / ICU-001',
      'high',
      20,
      STAFF_UID,
      'assigned',
    ]));
    expect(requestInsert).toContain(TENANT_ID);

    const advisoryLock = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes('pg_advisory_xact_lock')
    );
    expect(advisoryLock).toEqual(expect.arrayContaining([expect.any(String), 42]));

    const dedupeLookup = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes('FROM housekeeping_requests') && sql.includes('COALESCE(status')
    );
    expect(dedupeLookup[0]).toMatch(/tenant_id = \$1::uuid/);
    // Dedupe keys on the structured bed_id column, not the spoofable
    // free-text "bed_id=N." description marker (Phase-3 B-L4).
    expect(dedupeLookup[0]).toMatch(/bed_id = \$2::int/);
    expect(dedupeLookup[1]).toBe(TENANT_ID);
    expect(dedupeLookup[2]).toBe(42);

    const recipientInserts = prismaMock.$queryRawUnsafe.mock.calls.filter(([sql]) =>
      sql.includes('INSERT INTO housekeeping_request_recipients')
    );
    expect(recipientInserts).toHaveLength(2);

    const notificationInsert = prismaMock.$queryRawUnsafe.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO notifications')
    );
    expect(notificationInsert).toBeTruthy();
    expect(notificationInsert[1]).toBe(TENANT_ID);
    expect(notificationInsert[6]).toContain('"source":"bed_cleaning_dispatch"');
    expect(result.fanout.notification_count).toBe(2);
  });
});
