import {
  extractNursingObservations,
  normalizeNursingTranscript,
} from '../../services/ai/nursingAmbientDocumentationService.js';

function seg(overrides = {}) {
  return {
    speaker: overrides.speaker ?? 'nurse',
    text: overrides.text ?? 'Default text',
    start_seconds: overrides.start_seconds ?? 0,
    end_seconds: overrides.end_seconds ?? 5,
  };
}

describe('nursing ambient documentation helpers', () => {
  describe('normalizeNursingTranscript', () => {
    it('assigns sequential segment indices and tallies talk time', () => {
      const result = normalizeNursingTranscript([
        seg({ speaker: 'nurse', text: 'Starting my shift.', start_seconds: 0, end_seconds: 5 }),
        seg({ speaker: 'patient', text: 'My leg hurts.', start_seconds: 5, end_seconds: 8 }),
        seg({ speaker: 'caregiver', text: 'She ate breakfast.', start_seconds: 8, end_seconds: 11 }),
      ]);
      expect(result.segments).toHaveLength(3);
      expect(result.segments[0].segment_index).toBe(1);
      expect(result.segments[2].segment_index).toBe(3);
      expect(result.speaker_count).toBe(3);
      expect(result.talk_time.nurse).toBe(5);
      expect(result.talk_time.patient).toBe(3);
      expect(result.total_duration_seconds).toBe(11);
    });

    it('rejects empty or invalid segments without crashing', () => {
      const result = normalizeNursingTranscript([
        seg({ text: '' }),
        seg({ speaker: 'alien', text: 'Greetings human.' }),
        { not_a_segment: true },
        null,
      ]);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].speaker).toBe('other');
    });

    it('handles non-array input', () => {
      const result = normalizeNursingTranscript(null);
      expect(result.segments).toHaveLength(0);
      expect(result.speaker_count).toBe(0);
    });
  });

  describe('extractNursingObservations', () => {
    it('collects wound, drain, IV line, mobility, fall, and handover observations with citations', () => {
      const normalized = normalizeNursingTranscript([
        seg({ speaker: 'nurse', text: 'Wound dressing on the right hip changed; no signs of infection.', start_seconds: 0, end_seconds: 10 }),
        seg({ speaker: 'nurse', text: 'JP drain emptied 40 mL serosanguinous fluid.', start_seconds: 10, end_seconds: 15 }),
        seg({ speaker: 'nurse', text: 'IV line in the left forearm flushed and patent.', start_seconds: 15, end_seconds: 20 }),
        seg({ speaker: 'nurse', text: 'Patient ambulated to the bathroom with walker.', start_seconds: 20, end_seconds: 25 }),
        seg({ speaker: 'nurse', text: 'Patient fell while trying to stand, complains of bruised arm.', start_seconds: 25, end_seconds: 32 }),
        seg({ speaker: 'nurse', text: 'Handover to the next shift: continue antibiotics and monitor.', start_seconds: 32, end_seconds: 40 }),
        seg({ speaker: 'patient', text: 'I feel dizzy.', start_seconds: 40, end_seconds: 42 }),
      ]);
      const observations = extractNursingObservations(normalized);
      expect(observations.wounds).toHaveLength(1);
      expect(observations.drains).toHaveLength(1);
      expect(observations.iv_lines).toHaveLength(1);
      expect(observations.mobility.length).toBeGreaterThan(0);
      expect(observations.falls).toHaveLength(1);
      expect(observations.handover_notes).toHaveLength(1);
      expect(observations.wounds[0].citation.source_type).toBe('transcript_segment');
      expect(observations.wounds[0].citation.source_id).toBe('1');
    });

    it('captures numeric intake and output with aggregated fluid balance', () => {
      const normalized = normalizeNursingTranscript([
        seg({ speaker: 'nurse', text: 'Intake 500 ml in oral fluids.', start_seconds: 0, end_seconds: 5 }),
        seg({ speaker: 'nurse', text: 'Urine output 300 ml out clear.', start_seconds: 5, end_seconds: 10 }),
      ]);
      const observations = extractNursingObservations(normalized);
      expect(observations.intake_output.entries).toHaveLength(2);
      expect(observations.intake_output.total_intake_ml).toBe(500);
      expect(observations.intake_output.total_output_ml).toBe(300);
      expect(observations.intake_output.balance_ml).toBe(200);
    });

    it('flags a fall with injury keywords as high severity', () => {
      const normalized = normalizeNursingTranscript([
        seg({ speaker: 'nurse', text: 'Patient fell from the bed, hit head; small bleeding noted.', start_seconds: 0, end_seconds: 8 }),
      ]);
      const observations = extractNursingObservations(normalized);
      expect(observations.falls).toHaveLength(1);
      expect(observations.falls[0].severity).toBe('high');
    });

    it('returns empty structures without crashing when no segments', () => {
      const observations = extractNursingObservations({ segments: [] });
      expect(observations.wounds).toHaveLength(0);
      expect(observations.intake_output.entries).toHaveLength(0);
      expect(observations.falls).toHaveLength(0);
      expect(observations.shift_summary).toContain('not documented');
    });
  });
});
