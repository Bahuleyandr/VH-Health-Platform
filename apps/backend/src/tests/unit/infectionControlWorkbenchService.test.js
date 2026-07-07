import {
  computeDeviceDaysFromIntervals,
  computeHandHygieneCompliance,
  groupOutbreakClusterRows,
} from '../../services/quality/infectionControlWorkbenchService.js';

describe('infectionControlWorkbenchService pure helpers', () => {
  test('computes clipped device-day denominators by device type', () => {
    const result = computeDeviceDaysFromIntervals([
      {
        device_type: 'urinary_catheter',
        started_at: '2026-04-01T06:00:00.000Z',
        stopped_at: '2026-04-03T06:00:00.000Z',
      },
      {
        device_type: 'central_line',
        started_at: '2026-03-31T00:00:00.000Z',
        stopped_at: '2026-04-02T12:00:00.000Z',
      },
      {
        device_type: 'ventilator',
        started_at: '2026-04-05T00:00:00.000Z',
        stopped_at: '2026-04-06T00:00:00.000Z',
      },
    ], { from: '2026-04-01', to: '2026-04-03' });

    expect(result.by_device_type.urinary_catheter).toBe(2);
    expect(result.by_device_type.central_line).toBe(1.5);
    expect(result.by_device_type.ventilator).toBe(0);
    expect(result.total_device_days).toBe(3.5);
  });

  test('computes hand-hygiene compliance from moment rows', () => {
    expect(computeHandHygieneCompliance([
      { opportunity_count: 10, compliant_count: 8 },
      { opportunities: 5, compliant: 5 },
    ])).toEqual({
      total_moments: 15,
      compliant_moments: 13,
      compliance_pct: 86.67,
    });
  });

  test('groups outbreak cluster candidates and suppresses singletons', () => {
    const clusters = groupOutbreakClusterRows([
      {
        id: 1,
        organism: 'D5TEST E. coli',
        ward: 'D5TEST Ward',
        patient_uid: '00000000-0000-4000-8000-000000000101',
        detection_date: '2026-04-01',
      },
      {
        id: 2,
        organism: 'D5TEST E. coli',
        ward: 'D5TEST Ward',
        patient_uid: '00000000-0000-4000-8000-000000000102',
        detection_date: '2026-04-04',
      },
      {
        id: 3,
        organism: 'D5TEST Singleton',
        ward: 'D5TEST Ward',
        patient_uid: '00000000-0000-4000-8000-000000000103',
        detection_date: '2026-04-05',
      },
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      organism: 'D5TEST E. coli',
      ward: 'D5TEST Ward',
      case_count: 2,
      patient_count: 2,
    });
  });
});
