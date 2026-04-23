import { evaluateAntimicrobialStewardship } from '../../services/ai/antimicrobialStewardshipService.js';

function event(overrides = {}) {
  return {
    event_type: overrides.event_type || 'clinical_order',
    sub_type: overrides.sub_type || null,
    id: overrides.id || 1,
    summary: overrides.summary || 'Chart event',
    timestamp: overrides.timestamp || '2026-04-22T08:00:00.000Z',
    payload: overrides.payload || {},
  };
}

describe('antimicrobial stewardship helpers', () => {
  it('flags broad-spectrum therapy with pending cultures and missing duration', () => {
    const result = evaluateAntimicrobialStewardship({
      vitals: [event({ event_type: 'vitals', summary: 'Fever', payload: { temperature: 38.6 } })],
      medications: [],
      investigations: [
        event({
          event_type: 'investigation',
          summary: 'Blood culture - PENDING',
          payload: { test_name: 'Blood culture', status: 'PENDING', result_summary: 'Report pending' },
        }),
      ],
      notes: [],
      orders: [
        event({
          summary: 'urgent medication order ORD-1 - ordered',
          payload: {
            order_type: 'medication',
            status: 'ordered',
            details: { medication_name: 'Meropenem', dose: '1 g', route: 'IV' },
          },
        }),
      ],
    });

    expect(result.risk_band).toBe('high');
    expect(result.stewardship_score).toBeLessThan(100);
    expect(result.flags.map((flag) => flag.code)).toEqual(
      expect.arrayContaining(['PENDING_CULTURE_REVIEW', 'MISSING_ANTIBIOTIC_DURATION'])
    );
    expect(result.antibiotic_summary[0].broad_spectrum).toBe(true);
    expect(result.culture_summary[0].status).toBe('pending');
    expect(result.source_citations.length).toBeGreaterThan(0);
  });

  it('marks beta-lactam allergy conflict as critical', () => {
    const result = evaluateAntimicrobialStewardship({
      allergies: [{ id: 44, allergen: 'Penicillin', severity: 'severe', reaction: 'anaphylaxis' }],
      vitals: [],
      medications: [
        event({
          event_type: 'medication',
          summary: 'Amoxicillin clavulanate oral - administered',
          payload: { medication_name: 'Amoxicillin clavulanate', route: 'oral', status: 'administered', duration: '5 days' },
        }),
      ],
      investigations: [
        event({
          event_type: 'investigation',
          summary: 'Sputum culture - reported',
          payload: { test_name: 'Sputum culture', status: 'reported', result_summary: 'No growth' },
        }),
      ],
      notes: [],
      orders: [],
    });

    expect(result.risk_band).toBe('critical');
    expect(result.flags.map((flag) => flag.code)).toContain('ALLERGY_CONFLICT');
    expect(result.flags.find((flag) => flag.code === 'ALLERGY_CONFLICT').evidence).toHaveLength(2);
  });
});
