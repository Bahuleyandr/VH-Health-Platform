import {
  normalizeEventKind,
  parseEventTime,
  classifyVitalEvent,
  classifyLabEvent,
  classifyImagingEvent,
  classifyMessageEvent,
  classifyPrescriptionEvent,
  escalateRelevance,
  sortTimeline,
  buildTimelineActions,
  summarizeTimeline,
  evaluateTimeline,
} from '../../services/ai/multimodalPatientTimelineService.js';

describe('multimodal patient timeline helpers', () => {
  describe('normalizeEventKind', () => {
    it('normalizes casing to a known kind', () => {
      expect(normalizeEventKind('Imaging')).toBe('imaging');
    });

    it('falls back to "other" for unknown kinds', () => {
      expect(normalizeEventKind('unknown_thing')).toBe('other');
    });
  });

  describe('parseEventTime', () => {
    it('returns a Date for an ISO string', () => {
      const result = parseEventTime('2026-04-23T10:00:00Z');
      expect(result).toBeInstanceOf(Date);
    });

    it('returns null for null input', () => {
      expect(parseEventTime(null)).toBeNull();
    });
  });

  describe('classifyVitalEvent', () => {
    it('flags low spo2 as critical with RED_FLAG_VITAL', () => {
      const result = classifyVitalEvent({ payload: { spo2: 80 } });
      expect(result.relevance).toBe('critical');
      expect(result.signals.some((s) => s.code === 'RED_FLAG_VITAL')).toBe(true);
    });

    it('returns low relevance for normal vitals', () => {
      const result = classifyVitalEvent({ payload: { spo2: 98, hr: 72, sbp: 120 } });
      expect(result.relevance).toBe('low');
    });
  });

  describe('classifyLabEvent', () => {
    it('flags critical_high abnormal flag as critical', () => {
      const result = classifyLabEvent({
        payload: { name: 'K', value: 7.2, abnormal_flag: 'critical_high' },
      });
      expect(result.relevance).toBe('critical');
    });

    it('returns low relevance for a normal lab', () => {
      const result = classifyLabEvent({
        payload: { name: 'Hb', value: 13, abnormal_flag: 'normal' },
      });
      expect(result.relevance).toBe('low');
    });
  });

  describe('classifyImagingEvent', () => {
    it('flags an intracranial hemorrhage impression as high', () => {
      const result = classifyImagingEvent({
        payload: {
          modality: 'CT',
          impression: 'Acute intracranial hemorrhage',
          flagged_critical: false,
        },
      });
      expect(result.relevance).toBe('high');
    });

    it('flags explicit flagged_critical as critical', () => {
      const result = classifyImagingEvent({ payload: { flagged_critical: true } });
      expect(result.relevance).toBe('critical');
    });
  });

  describe('classifyMessageEvent', () => {
    it('flags PHI-like content (10-digit phone) as high MESSAGE_PHI_RISK', () => {
      const result = classifyMessageEvent({
        payload: { text: 'Call me at 9876543210', channel: 'sms' },
      });
      expect(result.relevance).toBe('high');
      expect(result.signals.some((s) => s.code === 'MESSAGE_PHI_RISK')).toBe(true);
    });

    it('flags concern keywords as moderate', () => {
      const result = classifyMessageEvent({
        payload: { text: 'Chronic worsening chest pain urgent please', channel: 'chat' },
      });
      expect(result.relevance).toBe('moderate');
    });
  });

  describe('classifyPrescriptionEvent', () => {
    it('flags a missed critical medication as critical', () => {
      const result = classifyPrescriptionEvent({
        payload: { medication_name: 'insulin', missed: true },
      });
      expect(result.relevance).toBe('critical');
    });

    it('returns low relevance for an administered non-critical med', () => {
      const result = classifyPrescriptionEvent({
        payload: { medication_name: 'paracetamol', missed: false },
      });
      expect(result.relevance).toBe('low');
    });
  });

  describe('sortTimeline', () => {
    it('orders by occurred_at ASC (earliest first)', () => {
      const sorted = sortTimeline([
        { occurred_at: new Date('2026-04-23T10:00:00Z'), relevance: 'low' },
        { occurred_at: new Date('2026-04-23T09:00:00Z'), relevance: 'critical' },
      ]);
      expect(sorted[0].occurred_at.getTime()).toBe(new Date('2026-04-23T09:00:00Z').getTime());
    });
  });

  describe('escalateRelevance', () => {
    it('returns the highest-priority band', () => {
      expect(escalateRelevance(['low', 'critical', 'moderate'])).toBe('critical');
    });
  });

  describe('evaluateTimeline', () => {
    it('rolls up counts and overall severity across multiple kinds', () => {
      const result = evaluateTimeline({
        events: [
          {
            kind: 'vital',
            occurred_at: '2026-04-23T10:00:00Z',
            payload: { spo2: 80 },
          },
          {
            kind: 'lab',
            occurred_at: '2026-04-23T11:00:00Z',
            payload: { abnormal_flag: 'normal' },
          },
        ],
      });
      expect(result.event_count).toBe(2);
      expect(result.critical_count).toBe(1);
      expect(result.overall_severity).toBe('critical');
      expect(result.source_breakdown.vital).toBe(1);
      expect(result.source_breakdown.lab).toBe(1);
    });
  });

  describe('buildTimelineActions', () => {
    it('includes the disclaimer and a critical-signal action', () => {
      const actions = buildTimelineActions({
        overallSeverity: 'critical',
        criticalCount: 2,
        highCount: 0,
        signals: [{ code: 'CRITICAL_VITAL_EVENT' }],
      });
      const hasDisclaimer = actions.some((line) =>
        /decision support only|never modifies source events/i.test(line)
      );
      expect(hasDisclaimer).toBe(true);
      const mentionsCritical = actions.some((line) =>
        /critical|CRITICAL_/i.test(line)
      );
      expect(mentionsCritical).toBe(true);
    });
  });

  describe('summarizeTimeline', () => {
    it('starts with [timeline] and mentions patient and severity', () => {
      const summary = summarizeTimeline({
        patientUid: 'p1',
        eventCount: 10,
        overallSeverity: 'high',
        criticalCount: 0,
      });
      expect(summary.startsWith('[timeline]')).toBe(true);
      expect(summary).toContain('p1');
      expect(summary).toContain('high');
    });
  });
});
