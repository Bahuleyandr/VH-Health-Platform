import {
  computeApTatMetric,
  deriveApBlockCode,
  deriveApSlideCode,
  transitionApReportStatus,
} from '../../services/pathology/pathologyService.js';

describe('pathology service workflow helpers', () => {
  it('derives stable block and slide identifiers', () => {
    expect(deriveApBlockCode('AP-20260707-000123', 1)).toBe('AP-20260707-000123-B01');
    expect(deriveApBlockCode('cy 20260707 9', 12)).toBe('CY-20260707-9-B12');
    expect(deriveApSlideCode('AP-20260707-000123-B01', 2, 'h&e')).toBe('AP-20260707-000123-B01-S02-HE');
    expect(deriveApSlideCode('CY-20260707-9-B12', 3, 'cytology')).toBe('CY-20260707-9-B12-S03-CY');
  });

  it('enforces the report status machine', () => {
    expect(transitionApReportStatus('draft', 'preliminary')).toBe('preliminary');
    expect(transitionApReportStatus('preliminary', 'final')).toBe('final');
    expect(transitionApReportStatus('final', 'amended')).toBe('amended');
    expect(() => transitionApReportStatus('final', 'draft')).toThrow(/Invalid state transition/);
    expect(() => transitionApReportStatus('amended', 'final')).toThrow(/Invalid state transition/);
  });

  it('computes AP turnaround breach state', () => {
    const metric = computeApTatMetric({
      accessioned_at: '2026-07-07T00:00:00.000Z',
      signed_at: '2026-07-08T06:00:00.000Z',
      target_hours: 24,
      current_tat_stage: 'signed',
    });
    expect(metric).toEqual({
      elapsed_hours: 30,
      target_hours: 24,
      breached: true,
      current_tat_stage: 'signed',
    });
  });
});
