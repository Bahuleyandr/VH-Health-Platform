import {
  buildPriorityActions,
  classifyFragility,
  classifyIndicationSeverity,
  classifyModalityUrgency,
  classifyOrderingContext,
  classifyPatientLocationScore,
  classifyPriorsBonus,
  classifyWaitTime,
  rankWorklist,
  scorePriority,
} from '../../services/ai/radiologyWorklistPrioritizerService.js';

describe('radiology worklist prioritizer helpers', () => {
  describe('classifyPatientLocationScore', () => {
    it('returns 40 for ED', () => {
      expect(classifyPatientLocationScore('ED')).toBe(40);
    });

    it('returns 45 for ICU', () => {
      expect(classifyPatientLocationScore('ICU')).toBe(45);
    });

    it('returns 15 for ward/inpatient', () => {
      expect(classifyPatientLocationScore('ward')).toBe(15);
    });

    it('returns 0 for OPD (outpatient)', () => {
      expect(classifyPatientLocationScore('OPD')).toBe(0);
    });

    it('returns 0 for unknown locations', () => {
      expect(classifyPatientLocationScore('somewhere-else')).toBe(0);
    });
  });

  describe('classifyModalityUrgency', () => {
    it('returns 60 with STROKE_PROTOCOL marker for CT head + stroke indication', () => {
      const result = classifyModalityUrgency({
        modality: 'CT',
        bodyPart: 'head',
        indication: 'acute stroke in progress, rule out intracranial bleed',
      });
      expect(result.score).toBe(60);
      expect(result.markers).toContain('STROKE_PROTOCOL');
    });

    it('returns 0 and no markers for a routine CXR with no urgent indication', () => {
      const result = classifyModalityUrgency({
        modality: 'CXR',
        bodyPart: 'chest',
        indication: 'routine follow-up imaging',
      });
      expect(result.score).toBe(0);
      expect(result.markers).toEqual([]);
    });
  });

  describe('classifyIndicationSeverity', () => {
    it('matches multiple terms and reports critical band for "severe acute hemorrhage"', () => {
      const result = classifyIndicationSeverity('severe acute hemorrhage');
      expect(Array.isArray(result.matchedTerms)).toBe(true);
      expect(result.matchedTerms.length).toBeGreaterThan(0);
      expect(result.band).toBe('critical');
      // Score is capped at 35 per spec.
      expect(result.score).toBeLessThanOrEqual(35);
    });
  });

  describe('classifyFragility', () => {
    it('returns EXTREME_AGE + CRITICAL_VITALS factors for age 85 with critical vitals', () => {
      const result = classifyFragility({ ageYears: 85, criticalVitalsFlag: true });
      expect(result.factors).toContain('EXTREME_AGE');
      expect(result.factors).toContain('CRITICAL_VITALS');
      expect(result.score).toBeGreaterThan(0);
    });
  });

  describe('classifyWaitTime', () => {
    it('returns breach band with score 25 for 300 minutes', () => {
      const result = classifyWaitTime(300);
      expect(result.band).toBe('breach');
      expect(result.score).toBe(25);
    });

    it('returns unknown band with score 0 when minutes is null', () => {
      const result = classifyWaitTime(null);
      expect(result.band).toBe('unknown');
      expect(result.score).toBe(0);
    });
  });

  describe('classifyOrderingContext', () => {
    it('returns score 25 and matchedTags ["code_stroke"] for ["code_stroke"]', () => {
      const result = classifyOrderingContext({ contextTags: ['code_stroke'] });
      expect(result.score).toBe(25);
      expect(result.matchedTags).toEqual(['code_stroke']);
    });
  });

  describe('classifyPriorsBonus', () => {
    it('returns -5 when priorsAvailable is true', () => {
      const result = classifyPriorsBonus({ priorsAvailable: true });
      expect(result.score).toBe(-5);
    });
  });

  describe('scorePriority', () => {
    it('returns stat tier with score >= 120 for stroke CT head + ED + code_stroke', () => {
      const result = scorePriority({
        modality: 'CT',
        bodyPart: 'head',
        indication: 'acute stroke, rule out intracranial bleed',
        location: 'ED',
        waitMinutes: 30,
        fragility: {},
        contextTags: ['code_stroke'],
        priorsAvailable: false,
        isStatOverride: false,
      });
      expect(result.priority_tier).toBe('stat');
      expect(result.priority_score).toBeGreaterThanOrEqual(120);
    });

    it('returns routine or deferrable tier with a concrete numeric score for CXR outpatient with minor wait', () => {
      const result = scorePriority({
        modality: 'CXR',
        bodyPart: 'chest',
        indication: 'routine follow-up',
        location: 'outpatient',
        waitMinutes: 20,
        fragility: {},
        contextTags: ['routine'],
        priorsAvailable: false,
        isStatOverride: false,
      });
      expect(['routine', 'deferrable']).toContain(result.priority_tier);
      expect(typeof result.priority_score).toBe('number');
    });

    it('forces tier to stat and adds STAT_OVERRIDE signal when isStatOverride is true', () => {
      const result = scorePriority({
        modality: 'CXR',
        bodyPart: 'chest',
        indication: 'routine follow-up',
        location: 'outpatient',
        waitMinutes: 15,
        fragility: {},
        contextTags: [],
        priorsAvailable: false,
        isStatOverride: true,
      });
      expect(result.priority_tier).toBe('stat');
      expect(result.signals.some((s) => s && s.code === 'STAT_OVERRIDE')).toBe(true);
    });
  });

  describe('rankWorklist', () => {
    it('sorts by tier (stat > urgent > routine), then by score within same tier', () => {
      const studies = [
        { study_id: 'A', score_result: { priority_tier: 'routine', priority_score: 50 } },
        { study_id: 'B', score_result: { priority_tier: 'stat', priority_score: 130 } },
        { study_id: 'C', score_result: { priority_tier: 'urgent', priority_score: 85 } },
        { study_id: 'D', score_result: { priority_tier: 'urgent', priority_score: 100 } },
      ];
      const ranked = rankWorklist(studies);
      expect(ranked[0].study_id).toBe('B'); // stat first
      expect(ranked[1].study_id).toBe('D'); // urgent, higher score
      expect(ranked[2].study_id).toBe('C'); // urgent, lower score
      expect(ranked[3].study_id).toBe('A'); // routine last
    });
  });

  describe('buildPriorityActions', () => {
    it('always appends the review disclaimer about decision support', () => {
      const actions = buildPriorityActions({ priorityTier: 'routine', signals: [] });
      expect(actions.some((line) => /decision support only/i.test(line))).toBe(true);
      expect(actions.some((line) => /worklist is never reordered automatically/i.test(line))).toBe(true);
    });

    it('includes a STAT_OVERRIDE-specific action when signals include STAT_OVERRIDE', () => {
      const actions = buildPriorityActions({
        priorityTier: 'stat',
        signals: [{ code: 'STAT_OVERRIDE', score_delta: 0 }],
      });
      expect(actions.some((line) => /stat override/i.test(line) && /immediate|immediately/i.test(line))).toBe(true);
    });
  });
});
