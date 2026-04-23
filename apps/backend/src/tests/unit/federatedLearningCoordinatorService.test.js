import {
  computeEpsilonUtilization,
  classifyEpsilonBand,
  classifyParticipantBand,
  classifyCohortBand,
  classifyDriftBand,
  classifyFederationRound,
  escalateSeverity,
  escalateRecommendation,
  buildFederationActions,
  summarizeFederationRound,
} from '../../services/ai/federatedLearningCoordinatorService.js';

describe('federated learning coordinator helpers', () => {
  describe('computeEpsilonUtilization', () => {
    it('returns 50 when spent is half of budget', () => {
      expect(computeEpsilonUtilization({ spent: 5, budget: 10 })).toBe(50);
    });

    it('clamps to 200 when spent exceeds budget significantly', () => {
      // spent=15, budget=10 → 150 (no clamp needed here; still <=200)
      expect(computeEpsilonUtilization({ spent: 15, budget: 10 })).toBe(150);
    });

    it('clamps to 200 when spent is wildly over budget', () => {
      expect(computeEpsilonUtilization({ spent: 100, budget: 10 })).toBe(200);
    });

    it('returns a finite clamped value when budget is zero (no divide-by-zero)', () => {
      const value = computeEpsilonUtilization({ spent: 1, budget: 0 });
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(200);
    });
  });

  describe('classifyEpsilonBand', () => {
    it('classifies 30 as ok', () => {
      expect(classifyEpsilonBand(30)).toBe('ok');
    });

    it('classifies 70 as watch', () => {
      expect(classifyEpsilonBand(70)).toBe('watch');
    });

    it('classifies 90 as warning', () => {
      expect(classifyEpsilonBand(90)).toBe('warning');
    });

    it('classifies 120 as breach', () => {
      expect(classifyEpsilonBand(120)).toBe('breach');
    });

    it('classifies null as unknown', () => {
      expect(classifyEpsilonBand(null)).toBe('unknown');
    });
  });

  describe('classifyParticipantBand', () => {
    it('returns critical when participant count is below half of minimum', () => {
      expect(classifyParticipantBand({ participantCount: 1, minParticipants: 3 })).toBe('critical');
    });

    it('returns below_min when count is under the minimum but above half', () => {
      expect(classifyParticipantBand({ participantCount: 2, minParticipants: 3 })).toBe('below_min');
    });

    it('returns ok when count is between min and 2*min', () => {
      expect(classifyParticipantBand({ participantCount: 5, minParticipants: 3 })).toBe('ok');
    });

    it('returns strong when count is at least 2*min', () => {
      expect(classifyParticipantBand({ participantCount: 10, minParticipants: 3 })).toBe('strong');
    });
  });

  describe('classifyCohortBand', () => {
    it('returns unknown when cohort min site size is null', () => {
      expect(classifyCohortBand({ cohortMinSiteSize: null })).toBe('unknown');
    });

    it('returns unsafe when cohort size is below half the floor', () => {
      expect(classifyCohortBand({ cohortMinSiteSize: 40, siteMinFloor: 100 })).toBe('unsafe');
    });

    it('returns below_floor when cohort size is under the floor', () => {
      expect(classifyCohortBand({ cohortMinSiteSize: 75, siteMinFloor: 100 })).toBe('below_floor');
    });

    it('returns ok when cohort size is between floor and 2*floor', () => {
      expect(classifyCohortBand({ cohortMinSiteSize: 150, siteMinFloor: 100 })).toBe('ok');
    });

    it('returns strong when cohort size is at least 2*floor', () => {
      expect(classifyCohortBand({ cohortMinSiteSize: 300, siteMinFloor: 100 })).toBe('strong');
    });
  });

  describe('classifyDriftBand', () => {
    it('classifies 0.05 as stable', () => {
      expect(classifyDriftBand(0.05)).toBe('stable');
    });

    it('classifies 0.2 as watch', () => {
      expect(classifyDriftBand(0.2)).toBe('watch');
    });

    it('classifies 0.4 as warning', () => {
      expect(classifyDriftBand(0.4)).toBe('warning');
    });

    it('classifies 0.7 as breach', () => {
      expect(classifyDriftBand(0.7)).toBe('breach');
    });
  });

  describe('classifyFederationRound', () => {
    it('returns ready / low when all bands are healthy', () => {
      const result = classifyFederationRound({
        participantCount: 5,
        minParticipants: 3,
        epsilonSpent: 2,
        epsilonBudget: 10,
        cohortMinSiteSize: 200,
        siteMinFloor: 100,
        dataDriftScore: 0.05,
      });
      expect(result.recommendation).toBe('ready');
      expect(result.severity).toBe('low');
    });

    it('returns abort / critical with PRIVACY_BUDGET_EXCEEDED when epsilon breaches', () => {
      const result = classifyFederationRound({
        participantCount: 5,
        minParticipants: 3,
        epsilonSpent: 11,
        epsilonBudget: 10,
        cohortMinSiteSize: 200,
        siteMinFloor: 100,
      });
      expect(result.recommendation).toBe('abort');
      expect(result.severity).toBe('critical');
      expect(result.signals.some((s) => s.code === 'PRIVACY_BUDGET_EXCEEDED')).toBe(true);
    });

    it('returns abort / critical with PARTICIPANT_CRITICAL when participants are well below min', () => {
      const result = classifyFederationRound({
        participantCount: 1,
        minParticipants: 3,
        epsilonSpent: 1,
        epsilonBudget: 10,
        cohortMinSiteSize: 200,
        siteMinFloor: 100,
      });
      expect(result.recommendation).toBe('abort');
      expect(result.severity).toBe('critical');
      expect(result.signals.some((s) => s.code === 'PARTICIPANT_CRITICAL')).toBe(true);
    });

    it('returns critical via COHORT_UNSAFE when min site cohort is below half floor', () => {
      const result = classifyFederationRound({
        participantCount: 5,
        minParticipants: 3,
        epsilonSpent: 2,
        epsilonBudget: 10,
        cohortMinSiteSize: 50,
        siteMinFloor: 100,
      });
      expect(result.severity).toBe('critical');
      expect(result.signals.some((s) => s.code === 'COHORT_UNSAFE')).toBe(true);
    });

    it('returns hold / high with PARTICIPANT_BELOW_MIN when participants are just under min', () => {
      const result = classifyFederationRound({
        participantCount: 2,
        minParticipants: 3,
        epsilonSpent: 1,
        epsilonBudget: 10,
        cohortMinSiteSize: 200,
        siteMinFloor: 100,
      });
      expect(result.recommendation).toBe('hold');
      expect(result.severity).toBe('high');
      expect(result.signals.some((s) => s.code === 'PARTICIPANT_BELOW_MIN')).toBe(true);
    });
  });

  describe('escalateSeverity', () => {
    it('returns the highest severity in the list', () => {
      expect(escalateSeverity(['low', 'critical', 'moderate'])).toBe('critical');
    });
  });

  describe('escalateRecommendation', () => {
    it('returns the highest-priority recommendation', () => {
      expect(escalateRecommendation(['no_action', 'ready', 'abort'])).toBe('abort');
    });
  });

  describe('buildFederationActions', () => {
    it('includes the disclaimer and at least one action referencing the abort context', () => {
      const actions = buildFederationActions({
        recommendation: 'abort',
        signals: [{ code: 'PRIVACY_BUDGET_EXCEEDED' }],
        roundKey: 'r1',
        modelKey: 'm1',
      });
      expect(actions.some((line) => /never triggers training/i.test(line))).toBe(true);
      const actionText = actions.join(' ');
      expect(
        /abort/i.test(actionText)
        || /r1/.test(actionText)
        || /m1/.test(actionText)
      ).toBe(true);
    });
  });

  describe('summarizeFederationRound', () => {
    it('mentions the round key and recommendation', () => {
      const summary = summarizeFederationRound({
        roundKey: 'r1',
        modelKey: 'm1',
        recommendation: 'ready',
        severity: 'low',
        participantCount: 5,
        epsilonSpent: 2,
      });
      expect(summary).toContain('r1');
      expect(summary).toContain('ready');
    });
  });
});
