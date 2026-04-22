import { summarizeAbnormalTriageDraft } from '../../services/ai/abnormalResultTriageAdminService.js';

describe('abnormal result triage admin helpers', () => {
  it('marks empty triage as routine', () => {
    const summary = summarizeAbnormalTriageDraft({
      urgent_items: [],
      watch_items: [],
    });

    expect(summary.urgency_band).toBe('routine');
    expect(summary.urgency_score).toBe(0);
  });

  it('marks one urgent signal as urgent', () => {
    const summary = summarizeAbnormalTriageDraft({
      urgent_items: [{ source: 'Vitals', abnormalities: ['SpO2 88%'] }],
      watch_items: [{ source: 'CBC', note: 'pending result' }],
    });

    expect(summary.urgency_band).toBe('urgent');
    expect(summary.urgency_score).toBe(45);
    expect(summary.urgent_count).toBe(1);
    expect(summary.watch_count).toBe(1);
  });

  it('marks multiple urgent signals as critical', () => {
    const summary = summarizeAbnormalTriageDraft({
      urgent_items: [
        { source: 'Vitals', abnormalities: ['SpO2 88%'] },
        { source: 'Lab', abnormalities: ['critical potassium'] },
      ],
      watch_items: [],
    });

    expect(summary.urgency_band).toBe('critical');
    expect(summary.urgency_score).toBe(70);
  });
});
