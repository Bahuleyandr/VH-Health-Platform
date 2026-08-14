import { jest } from '@jest/globals';

const queryRaw = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRaw: queryRaw },
}));

const { getWaitingQueueForDoctor } = await import(
  '../../services/appointment/waitTimeService.js'
);

describe('getWaitingQueueForDoctor realtime fan-out', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryRaw.mockResolvedValue([
      {
        id: 42,
        patient_uid: '33333333-3333-4333-8333-333333333333',
        token_number: '4',
        position: 3,
        avg_min: '12.5',
      },
    ]);
  });

  test('scopes appointments and status history to the emitting tenant', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';

    const rows = await getWaitingQueueForDoctor(9, '2026-08-13', tenantId);

    expect(rows).toEqual([
      {
        appointmentId: 42,
        patientUid: '33333333-3333-4333-8333-333333333333',
        tokenNumber: '4',
        position: 3,
        etaMinutes: 38,
      },
    ]);
    const [strings, ...values] = queryRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toContain('patient.uid AS patient_uid');
    expect(sql).toContain('patient.id = appointment.patient_id');
    expect(sql.match(/tenant_id = \?::uuid/g)).toHaveLength(3);
    expect(sql).toContain('h.tenant_id = ?::uuid');
    expect(values.filter((value) => value === tenantId)).toHaveLength(3);
  });
});
