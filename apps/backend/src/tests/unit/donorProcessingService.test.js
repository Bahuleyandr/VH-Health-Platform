import { deriveComponentExpiry, evaluateTtiPanel } from '../../services/bloodbank/donorProcessingService.js';

describe('blood-bank donor processing helpers', () => {
  test('classifies a fully non-reactive TTI panel as approved/non-reactive', () => {
    expect(evaluateTtiPanel({
      hiv: 'non_reactive',
      hbsag: 'non_reactive',
      hcv: 'non_reactive',
      syphilis: 'non_reactive',
      malaria: 'non_reactive',
    })).toMatchObject({
      overallResult: 'non_reactive',
      status: 'approved',
      reactiveMarkers: [],
      indeterminateMarkers: [],
    });
  });

  test('reactive markers dominate indeterminate and trigger a reactive panel', () => {
    expect(evaluateTtiPanel({
      hiv: 'non_reactive',
      hbsag: 'reactive',
      hcv: 'indeterminate',
      syphilis: 'non_reactive',
      malaria: 'non_reactive',
    })).toMatchObject({
      overallResult: 'reactive',
      status: 'approved',
      reactiveMarkers: ['hbsag'],
      indeterminateMarkers: ['hcv'],
    });
  });

  test('indeterminate panels require repeat testing', () => {
    expect(evaluateTtiPanel({
      hiv: 'non_reactive',
      hbsag: 'non_reactive',
      hcv: 'indeterminate',
      syphilis: 'non_reactive',
      malaria: 'non_reactive',
    })).toMatchObject({
      overallResult: 'indeterminate',
      status: 'repeat_required',
      indeterminateMarkers: ['hcv'],
    });
  });

  test('derives component expiry windows from collection date', () => {
    expect(deriveComponentExpiry('2026-07-07', 'prbc')).toBe('2026-08-18');
    expect(deriveComponentExpiry('2026-07-07', 'platelets')).toBe('2026-07-12');
    expect(deriveComponentExpiry('2026-07-07', 'ffp')).toBe('2027-07-07');
    expect(deriveComponentExpiry('2026-07-07', 'cryoprecipitate')).toBe('2027-07-07');
  });
});
