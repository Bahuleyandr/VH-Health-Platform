import { evaluateSepsisBundleRisk } from '../../services/ai/sepsisBundleSentinelService.js';

function event(overrides = {}) {
  return {
    event_type: overrides.event_type || 'vitals',
    sub_type: overrides.sub_type || null,
    id: overrides.id || 1,
    summary: overrides.summary || 'Chart event',
    timestamp: overrides.timestamp || '2026-04-22T08:00:00.000Z',
    payload: overrides.payload || {},
  };
}

describe('sepsis bundle sentinel helpers', () => {
  it('returns low risk when no suspected sepsis signal is present', () => {
    const result = evaluateSepsisBundleRisk({
      vitals: [event({ summary: 'Stable vitals', payload: { temperature: 36.8, heart_rate: 78, systolic_bp: 122 } })],
      medications: [],
      investigations: [],
      notes: [],
      orders: [],
    });

    expect(result.risk_band).toBe('low');
    expect(result.criteria.map((item) => item.code)).toEqual(['NO_SEPSIS_BUNDLE_SIGNAL']);
  });

  it('flags suspected sepsis with missing culture and lactate evidence', () => {
    const result = evaluateSepsisBundleRisk({
      vitals: [
        event({ summary: 'Fever and tachycardia', payload: { temperature: 38.9, heart_rate: 124, respiratory_rate: 24 } }),
      ],
      medications: [
        event({
          event_type: 'medication',
          summary: 'Ceftriaxone administered',
          payload: { medication_name: 'Ceftriaxone', status: 'administered' },
        }),
      ],
      investigations: [],
      notes: [event({ event_type: 'clinical_note', summary: 'Suspected pneumonia with infection' })],
      orders: [],
    });

    expect(result.risk_band).toBe('high');
    expect(result.suspected_sepsis).toBe(true);
    expect(result.bundle_gaps.map((gap) => gap.code)).toEqual(
      expect.arrayContaining(['BLOOD_CULTURE_EVIDENCE_MISSING', 'LACTATE_EVIDENCE_MISSING'])
    );
  });

  it('marks shock bundle gaps as critical', () => {
    const result = evaluateSepsisBundleRisk({
      vitals: [
        event({ summary: 'Hypotension and hypoxia', payload: { temperature: 39.4, heart_rate: 132, systolic_bp: 84, spo2: 88 } }),
      ],
      medications: [],
      investigations: [
        event({
          event_type: 'investigation',
          summary: 'Blood culture requested',
          payload: { test_name: 'Blood culture', status: 'pending' },
        }),
        event({
          event_type: 'investigation',
          summary: 'Lactate 4.8 mmol/L',
          payload: { test_name: 'Lactate', result_summary: 'Lactate 4.8 mmol/L' },
        }),
      ],
      notes: [event({ event_type: 'clinical_note', summary: 'Possible sepsis from UTI' })],
      orders: [],
    });

    expect(result.risk_band).toBe('critical');
    expect(result.shock_signal).toBe(true);
    expect(result.bundle_gaps.map((gap) => gap.code)).toEqual(
      expect.arrayContaining(['ANTIBIOTIC_EVIDENCE_MISSING', 'SHOCK_RESUSCITATION_EVIDENCE_MISSING'])
    );
  });
});
