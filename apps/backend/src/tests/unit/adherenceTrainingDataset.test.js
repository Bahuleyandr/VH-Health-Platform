import {
  adherenceTrainingRowsToCsv,
  defaultAdherenceSnapshotDate,
  normalizeAdherenceTrainingRow,
  summarizeAdherenceTrainingWindow,
} from '../../services/gamification/adherenceTrainingDatasetService.js';

describe('adherence training dataset helpers', () => {
  it('defaults the snapshot date to 30 days before now', () => {
    expect(defaultAdherenceSnapshotDate(new Date('2026-04-22T00:00:00Z'))).toBe('2026-03-23');
  });

  it('summarizes feature windows and future default labels', () => {
    const row = summarizeAdherenceTrainingWindow({
      snapshotDate: '2026-04-01',
      marEvents: [
        { status: 'missed', scheduled_time: '2026-03-10T10:00:00Z' },
        { status: 'missed', scheduled_time: '2026-02-15T10:00:00Z' },
        { status: 'given', override_reason: 'patient refused initially', administered_at: '2026-03-20T10:00:00Z' },
        { status: 'missed', scheduled_time: '2026-04-05T10:00:00Z' },
        { status: 'missed', scheduled_time: '2026-04-15T10:00:00Z' },
      ],
      refillEvents: [
        { status: 'late', created_at: '2026-03-01T10:00:00Z' },
        { days_late: 12, created_at: '2026-01-20T10:00:00Z' },
        { days_late: 12, created_at: '2025-12-01T10:00:00Z' },
      ],
      vitalEvents: [
        { recorded_at: '2026-03-12T00:00:00Z' },
        { recorded_at: '2026-02-01T00:00:00Z' },
      ],
    });
    expect(row).toEqual({
      missed_30: 1,
      overrides_30: 1,
      late_refills_90: 2,
      days_silent: 20,
      defaulted_within_30: 1,
    });
  });

  it('normalizes row values into the training schema', () => {
    expect(normalizeAdherenceTrainingRow({
      missed_30: '3',
      overrides_30: -1,
      late_refills_90: '2',
      days_silent: 9000,
      defaulted_within_30: 4,
    })).toEqual({
      missed_30: 3,
      overrides_30: 0,
      late_refills_90: 2,
      days_silent: 3650,
      defaulted_within_30: 1,
    });
  });

  it('renders exactly the CSV columns consumed by the trainer', () => {
    const csv = adherenceTrainingRowsToCsv([
      { missed_30: 3, overrides_30: 0, late_refills_90: 1, days_silent: 12, defaulted_within_30: 0 },
      { missed_30: 8, overrides_30: 2, late_refills_90: 3, days_silent: 45, defaulted_within_30: 1 },
    ]);
    expect(csv).toBe([
      'missed_30,overrides_30,late_refills_90,days_silent,defaulted_within_30',
      '3,0,1,12,0',
      '8,2,3,45,1',
      '',
    ].join('\n'));
  });
});
