import {
  buildVoiceActions,
  classifyConsent,
  classifyIntentSupport,
  classifyVoiceSession,
  detectPhiInResponse,
  detectUrgentSignals,
  escalateRecommendation,
  escalateSeverity,
  normalizeChannel,
  normalizeIntent,
  normalizeLanguage,
  sanitizeResponse,
  summarizeVoiceSession,
} from '../../services/ai/voicePatientAssistantIvrService.js';

describe('voice patient assistant / IVR helpers', () => {
  describe('normalizeIntent', () => {
    it('lowercases + trims a known intent', () => {
      expect(normalizeIntent('Prep')).toBe('prep');
    });

    it('maps unknown intent to "other"', () => {
      expect(normalizeIntent('bogus')).toBe('other');
    });
  });

  describe('normalizeChannel', () => {
    it('lowercases a known channel', () => {
      expect(normalizeChannel('SMS')).toBe('sms');
    });

    it('maps unknown channel to "unknown"', () => {
      expect(normalizeChannel('tcp')).toBe('unknown');
    });
  });

  describe('normalizeLanguage', () => {
    it('lowercases a supported language code', () => {
      expect(normalizeLanguage('HI')).toBe('hi');
    });

    it('maps unsupported language to the literal "unsupported"', () => {
      expect(normalizeLanguage('xx')).toBe('unsupported');
    });
  });

  describe('detectUrgentSignals', () => {
    it('detects multiple urgent phrases in a transcript', () => {
      const res = detectUrgentSignals('I have severe chest pain and difficulty breathing');
      expect(res.count).toBeGreaterThanOrEqual(2);
      expect(res.signals.every((s) => s.code === 'URGENT_TERM')).toBe(true);
    });

    it('returns count 0 for a routine transcript', () => {
      const res = detectUrgentSignals('Routine follow-up call');
      expect(res.count).toBe(0);
      expect(res.signals).toEqual([]);
    });
  });

  describe('detectPhiInResponse', () => {
    it('detects a phone-number leak', () => {
      const res = detectPhiInResponse('Please call 9876543210');
      expect(res.count).toBeGreaterThanOrEqual(1);
      expect(res.leaks.some((l) => l.code === 'PHONE_LEAK')).toBe(true);
    });

    it('returns count 0 for a benign reminder', () => {
      const res = detectPhiInResponse('Your follow-up is scheduled');
      expect(res.count).toBe(0);
      expect(res.leaks).toEqual([]);
    });
  });

  describe('sanitizeResponse', () => {
    it('redacts MRN + VH- identifiers', () => {
      const out = sanitizeResponse('MRN: VH-00123 follow-up');
      expect(out).toContain('[REDACTED]');
      expect(out).not.toContain('VH-00123');
    });
  });

  describe('classifyConsent', () => {
    it('returns "missing" when consentRef is null', () => {
      expect(classifyConsent({ consentRef: null, consentFresh: true })).toBe('missing');
    });

    it('returns "stale" when consentFresh is false', () => {
      expect(classifyConsent({ consentRef: 'c:1', consentFresh: false })).toBe('stale');
    });

    it('returns "fresh" when consentRef + consentFresh=true', () => {
      expect(classifyConsent({ consentRef: 'c:1', consentFresh: true })).toBe('fresh');
    });
  });

  describe('classifyIntentSupport', () => {
    it('returns "supported" for a normalized intent + script_key', () => {
      expect(classifyIntentSupport({ intent: 'meds', scriptKey: 'meds_reminder_v1' })).toBe('supported');
    });

    it('returns "unsupported_intent" for "other" even with a script', () => {
      expect(classifyIntentSupport({ intent: 'other', scriptKey: 'x' })).toBe('unsupported_intent');
    });

    it('returns "no_script" for a supported intent with no script_key', () => {
      expect(classifyIntentSupport({ intent: 'prep', scriptKey: null })).toBe('no_script');
    });
  });

  describe('classifyVoiceSession', () => {
    it('allows a safe meds reminder session', () => {
      const res = classifyVoiceSession({
        intent: 'meds',
        channel: 'ivr',
        language: 'en',
        scriptKey: 's1',
        consentRef: 'c:1',
        consentFresh: true,
        transcriptText: 'remind me about meds',
        candidateResponse: 'Take your tablet at 9 am.',
      });
      expect(res.recommendation).toBe('allow');
      expect(res.severity).toBe('low');
      expect(res.signals.some((s) => s.code === 'SAFE_TO_DELIVER')).toBe(true);
    });

    it('blocks critical when consent is missing', () => {
      const res = classifyVoiceSession({
        intent: 'meds',
        channel: 'ivr',
        language: 'en',
        scriptKey: 's1',
        consentRef: null,
        consentFresh: false,
        transcriptText: 'x',
        candidateResponse: 'x',
      });
      expect(res.recommendation).toBe('block');
      expect(res.severity).toBe('critical');
      expect(res.signals.some((s) => s.code === 'CONSENT_MISSING')).toBe(true);
    });

    it('escalates to clinician on urgent patient signal', () => {
      const res = classifyVoiceSession({
        intent: 'prep',
        channel: 'ivr',
        language: 'en',
        scriptKey: 's1',
        consentRef: 'c:1',
        consentFresh: true,
        transcriptText: 'I have severe chest pain',
        candidateResponse: 'Take paracetamol.',
      });
      expect(res.recommendation).toBe('escalate_to_clinician');
      expect(res.severity).toBe('high');
      expect(res.signals.some((s) => s.code === 'URGENT_PATIENT_SIGNAL')).toBe(true);
    });

    it('blocks critical on PHI leak in the candidate response', () => {
      const res = classifyVoiceSession({
        intent: 'prep',
        channel: 'ivr',
        language: 'en',
        scriptKey: 's1',
        consentRef: 'c:1',
        consentFresh: true,
        transcriptText: 'ok',
        candidateResponse: 'Call patient at 9876543210.',
      });
      expect(res.recommendation).toBe('block');
      expect(res.severity).toBe('critical');
      expect(res.signals.some((s) => s.code === 'RESPONSE_PHI_LEAK')).toBe(true);
      expect(res.phi_leak_count).toBeGreaterThanOrEqual(1);
    });

    it('falls back to human on unsupported language', () => {
      const res = classifyVoiceSession({
        intent: 'prep',
        channel: 'ivr',
        language: 'xx',
        scriptKey: 's1',
        consentRef: 'c:1',
        consentFresh: true,
        transcriptText: 'ok',
        candidateResponse: 'ok',
      });
      expect(res.recommendation).toBe('fallback_to_human');
      expect(res.signals.some((s) => s.code === 'UNSUPPORTED_LANGUAGE')).toBe(true);
    });
  });

  describe('escalateSeverity', () => {
    it('picks the highest-priority severity', () => {
      expect(escalateSeverity(['low', 'critical', 'moderate'])).toBe('critical');
    });
  });

  describe('escalateRecommendation', () => {
    it('picks the highest-priority recommendation', () => {
      expect(escalateRecommendation(['allow', 'block', 'escalate_to_clinician'])).toBe('block');
    });
  });

  describe('buildVoiceActions', () => {
    it('includes a disclaimer and a block/PHI-specific action', () => {
      const actions = buildVoiceActions({
        recommendation: 'block',
        signals: [{ code: 'RESPONSE_PHI_LEAK' }],
        patientUid: 'p1',
      });
      expect(Array.isArray(actions)).toBe(true);
      expect(actions.some((a) => /decision support only/i.test(a))).toBe(true);
      expect(actions.some((a) => /block/i.test(a) || /phi/i.test(a))).toBe(true);
    });
  });

  describe('summarizeVoiceSession', () => {
    it('mentions the patient UID and recommendation', () => {
      const out = summarizeVoiceSession({
        patientUid: 'p1',
        intent: 'prep',
        recommendation: 'allow',
        severity: 'low',
      });
      expect(out).toContain('p1');
      expect(out).toContain('allow');
    });
  });
});
