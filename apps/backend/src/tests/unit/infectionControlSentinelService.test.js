import { evaluateInfectionControlRisk } from '../../services/ai/infectionControlSentinelService.js';

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

describe('infection control sentinel helpers', () => {
  it('returns low risk when no infection-control signal is present', () => {
    const result = evaluateInfectionControlRisk({
      vitals: [event({ payload: { temperature: 36.8 }, summary: 'Afebrile vitals' })],
      medications: [],
      investigations: [],
      notes: [event({ event_type: 'clinical_note', summary: 'Patient comfortable' })],
      orders: [],
    });

    expect(result.risk_band).toBe('low');
    expect(result.signals.map((signal) => signal.code)).toEqual(['NO_INFECTION_CONTROL_SIGNAL']);
  });

  it('flags broad-spectrum antibiotics without culture evidence', () => {
    const result = evaluateInfectionControlRisk({
      vitals: [event({ payload: { temperature: 38.4 }, summary: 'Fever documented' })],
      medications: [
        event({
          event_type: 'medication',
          summary: 'Meropenem 1g administered',
          payload: { medication_name: 'Meropenem', status: 'administered' },
        }),
      ],
      investigations: [],
      notes: [],
      orders: [],
    });

    expect(result.risk_band).toBe('high');
    expect(result.signals.map((signal) => signal.code)).toEqual(
      expect.arrayContaining(['FEVER_SIGNAL', 'BROAD_SPECTRUM_WITHOUT_CULTURE_EVIDENCE'])
    );
    expect(result.stewardship_flags).toHaveLength(1);
    expect(result.source_citations.length).toBeGreaterThan(0);
  });

  it('marks MDRO signals without isolation order as critical', () => {
    const result = evaluateInfectionControlRisk({
      vitals: [event({ payload: { temperature: 39.2 }, summary: 'High fever' })],
      medications: [],
      investigations: [
        event({
          event_type: 'investigation',
          summary: 'Wound culture positive MRSA growth',
          payload: {
            test_name: 'Wound culture',
            status: 'reported',
            result_summary: 'MRSA growth detected',
          },
        }),
      ],
      notes: [],
      orders: [],
    });

    expect(result.risk_band).toBe('critical');
    expect(result.signals.map((signal) => signal.code)).toEqual(
      expect.arrayContaining(['MDRO_OR_CDIFF_SIGNAL', 'ISOLATION_PRECAUTIONS_NOT_FOUND'])
    );
    expect(result.isolation_flags.length).toBeGreaterThanOrEqual(2);
  });
});
