import { evaluateChartCompletion } from '../../services/ai/chartCompletionAuditorService.js';

function event(overrides = {}) {
  return {
    event_type: overrides.event_type || 'clinical_note',
    sub_type: overrides.sub_type || null,
    id: overrides.id || 1,
    summary: overrides.summary || 'Progress note',
    timestamp: overrides.timestamp || '2026-04-22T08:00:00.000Z',
    payload: overrides.payload || {},
  };
}

describe('chart completion auditor helpers', () => {
  it('scores a complete chart as low risk', () => {
    const audit = evaluateChartCompletion({
      patient: { uid: '11111111-1111-4111-8111-111111111111', name: 'Asha Rao' },
      admission: {
        id: 10,
        patient_uid: '11111111-1111-4111-8111-111111111111',
        status: 'admitted',
        chief_complaint: 'Fever',
      },
      notes: [event({ payload: { is_signed: true } })],
      diagnoses: [event({ event_type: 'diagnosis', summary: 'A09 gastroenteritis', payload: { status: 'active' } })],
      vitals: [event({ event_type: 'vitals', summary: 'Vitals stable' })],
      allergies: [{ allergen: 'No known drug allergy', status: 'active' }],
      medications: [event({ event_type: 'medication', summary: 'Paracetamol administered' })],
      investigations: [event({ event_type: 'investigation', sub_type: 'reported', summary: 'CBC reported', payload: { status: 'reported' } })],
      orders: [],
      handovers: [event({ event_type: 'handover', summary: 'Night shift handover complete' })],
      citations: [{ source_type: 'clinical_note', source_id: '1', label: 'Signed note', timestamp: null }],
    });

    expect(audit.risk_band).toBe('low');
    expect(audit.completion_score).toBe(100);
    expect(audit.gaps).toEqual([]);
  });

  it('flags unsigned notes and pending investigations', () => {
    const audit = evaluateChartCompletion({
      patient: { uid: '11111111-1111-4111-8111-111111111111', name: 'Asha Rao' },
      admission: { id: 11, status: 'admitted', chief_complaint: 'Cough' },
      notes: [event({ id: 7, payload: { is_signed: false }, summary: 'Unsigned progress note' })],
      investigations: [
        event({
          event_type: 'investigation',
          id: 8,
          sub_type: 'pending',
          summary: 'Chest X-ray pending',
          payload: { status: 'pending' },
        }),
      ],
      allergies: [{ allergen: 'Penicillin', status: 'active' }],
      vitals: [event({ event_type: 'vitals', summary: 'Vitals charted' })],
      medications: [event({ event_type: 'medication', summary: 'Nebulization given' })],
      handovers: [event({ event_type: 'handover' })],
    });

    expect(audit.risk_band).toBe('high');
    expect(audit.gaps.map((gap) => gap.code)).toEqual(
      expect.arrayContaining(['NO_SIGNED_NOTES', 'PENDING_INVESTIGATIONS'])
    );
    expect(audit.source_citations.some((citation) => citation.label === 'Pending investigation')).toBe(true);
  });

  it('marks discharged charts with unsigned discharge artefacts as high risk', () => {
    const audit = evaluateChartCompletion({
      patient: { uid: '11111111-1111-4111-8111-111111111111', name: 'Asha Rao' },
      admission: {
        id: 12,
        status: 'discharged',
        chief_complaint: 'Pneumonia',
        discharged_at: '2026-04-22T09:00:00.000Z',
        discharge_summary: { is_signed: false },
      },
      notes: [event({ payload: { is_signed: true } })],
      allergies: [{ allergen: 'NKDA', status: 'active' }],
      vitals: [event({ event_type: 'vitals' })],
      medications: [event({ event_type: 'medication' })],
    });

    expect(audit.risk_band).toBe('high');
    expect(audit.gaps.map((gap) => gap.code)).toEqual(
      expect.arrayContaining(['DISCHARGE_SUMMARY_UNSIGNED', 'FOLLOW_UP_NOT_DOCUMENTED'])
    );
  });
});
