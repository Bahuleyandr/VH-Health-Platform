import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const { recordEntry } = await import('../../services/theatre/anesthesiaChartService.js');

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('anesthesiaChartService.recordEntry', () => {
  it('creates the chart row and syncs drug/totals into the case anesthesia record', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 11, ot_schedule_id: 42 }])
      .mockResolvedValueOnce([]);

    const row = await recordEntry({
      tenantId: '00000000-0000-4000-8000-000000000001',
      ot_schedule_id: 42,
      recorded_at: '2026-05-15T10:30:00.000Z',
      recorded_by: '22222222-2222-4222-8222-222222222222',
      hr: 78,
      sbp: 120,
      dbp: 72,
      drugs_given: [{ name: 'midazolam', dose: '2 mg', route: 'IV' }],
      iv_fluids_ml: 100,
      blood_loss_ml: 5,
      event_note: 'MAC started',
    });

    expect(row.id).toBe(11);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/INSERT INTO anesthesia_chart_entries/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO anesthesia_records/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/ON CONFLICT \(tenant_id, ot_schedule_id\) DO UPDATE/);
    expect(JSON.parse(queryUnsafeMock.mock.calls[1][4])).toEqual([
      { name: 'midazolam', dose: '2 mg', route: 'IV' },
    ]);
  });
});
