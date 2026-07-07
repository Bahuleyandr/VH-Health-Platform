import {
  computeRadiologyTatMetric,
  pickDeterministicSignedReportSample,
  renderRadiologyStructuredReport,
} from '../../services/radiology/radiologyService.js';

describe('radiology structured report, peer-review sampling, and TAT helpers', () => {
  it('renders structured sections into the legacy report blob in template order', () => {
    const rendered = renderRadiologyStructuredReport({
      template_id: '375',
      structured_report: {
        sections: {
          impression: 'Right lower lobe pneumonia',
          findings: 'Patchy opacity in the right lower lobe',
        },
        coded_fields: { view: 'pa' },
      },
      report: 'Recommend follow-up radiograph.',
    }, {
      template: {
        id: 375n,
        template_code: 'XRAY_CHEST_STANDARD_V1',
        name: 'Chest X-ray standard report',
        sections: [
          { key: 'findings', title: 'Findings', order: 1 },
          { key: 'impression', title: 'Impression', order: 2 },
        ],
      },
    });

    expect(rendered.templateId).toBe(375);
    expect(rendered.text).toBe([
      'Findings:\nPatchy opacity in the right lower lobe',
      'Impression:\nRight lower lobe pneumonia',
      'Recommend follow-up radiograph.',
    ].join('\n\n'));
    expect(rendered.structuredReport).toMatchObject({
      template_id: 375,
      template_code: 'XRAY_CHEST_STANDARD_V1',
      coded_fields: { view: 'pa' },
    });
  });

  it('computes current TAT breach severity from report timestamps and thresholds', () => {
    const metric = computeRadiologyTatMetric({
      ordered_at: '2026-07-07T00:00:00.000Z',
      acquired_at: '2026-07-07T00:30:00.000Z',
      reported_at: '2026-07-07T01:10:00.000Z',
      signed_at: '2026-07-07T05:30:00.000Z',
      warning_minutes: 240,
      critical_minutes: 300,
    }, new Date('2026-07-07T06:00:00.000Z'));

    expect(metric.ordered_to_acquired_minutes).toBe(30);
    expect(metric.acquired_to_reported_minutes).toBe(40);
    expect(metric.reported_to_signed_minutes).toBe(260);
    expect(metric.ordered_to_signed_minutes).toBe(330);
    expect(metric.threshold_breached).toBe(true);
    expect(metric.alert_severity).toBe('CRITICAL');
  });

  it('returns deterministic peer-review samples for the same seed', () => {
    const rows = [
      { id: 11, patient_uid: 'p1' },
      { id: 12, patient_uid: 'p2' },
      { id: 13, patient_uid: 'p3' },
    ];
    const first = pickDeterministicSignedReportSample(rows, {
      seed: 'n6-1',
      samplingRate: 1,
      limit: 2,
    });
    const second = pickDeterministicSignedReportSample(rows, {
      seed: 'n6-1',
      samplingRate: 1,
      limit: 2,
    });

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0].sample_score).toBeLessThanOrEqual(first[1].sample_score);
  });
});
