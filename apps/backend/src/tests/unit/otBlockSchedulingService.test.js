import {
  computeUtilizationPct,
  computePrimeTimeUtilization,
  computeDurationVariance,
  classifyUtilizationBand,
  classifyOverrunBand,
  classifyTurnoverBand,
  classifyAddonVolume,
  classifyBlockRecommendation,
  escalateSeverity,
  escalateRecommendation,
  buildBlockActions,
  summarizeBlock,
} from '../../services/ai/otBlockSchedulingService.js';

describe('otBlockScheduling pure helpers', () => {
  describe('computeUtilizationPct', () => {
    it('returns 75.00 for scheduled 300 / allocated 400', () => {
      expect(computeUtilizationPct({ scheduledMinutes: 300, allocatedMinutes: 400 })).toBe(75);
    });

    it('returns 0 when allocated is 0', () => {
      expect(computeUtilizationPct({ scheduledMinutes: 120, allocatedMinutes: 0 })).toBe(0);
    });
  });

  describe('computePrimeTimeUtilization', () => {
    it('clamps primeUsed/primeAllocated at 200', () => {
      expect(computePrimeTimeUtilization({ primeUsedMinutes: 600, primeAllocatedMinutes: 200 })).toBe(200);
    });
  });

  describe('computeDurationVariance', () => {
    it('returns 50.00 for scheduled 60, actual 90', () => {
      expect(computeDurationVariance({ scheduledMinutes: 60, actualMinutes: 90 })).toBe(50);
    });

    it('returns 0 when scheduled is 0', () => {
      expect(computeDurationVariance({ scheduledMinutes: 0, actualMinutes: 40 })).toBe(0);
    });
  });

  describe('classifyUtilizationBand', () => {
    it('bands utilization % correctly', () => {
      expect(classifyUtilizationBand(40)).toBe('under');
      expect(classifyUtilizationBand(65)).toBe('low');
      expect(classifyUtilizationBand(80)).toBe('target');
      expect(classifyUtilizationBand(95)).toBe('high');
      expect(classifyUtilizationBand(110)).toBe('over');
    });
  });

  describe('classifyOverrunBand', () => {
    it('bands overrun counts correctly', () => {
      expect(classifyOverrunBand(0)).toBe('none');
      expect(classifyOverrunBand(2)).toBe('occasional');
      expect(classifyOverrunBand(4)).toBe('frequent');
      expect(classifyOverrunBand(7)).toBe('chronic');
    });
  });

  describe('classifyTurnoverBand', () => {
    it('bands turnover minutes correctly', () => {
      expect(classifyTurnoverBand(15)).toBe('fast');
      expect(classifyTurnoverBand(25)).toBe('typical');
      expect(classifyTurnoverBand(40)).toBe('slow');
      expect(classifyTurnoverBand(60)).toBe('severe');
      expect(classifyTurnoverBand(null)).toBe('unknown');
    });
  });

  describe('classifyAddonVolume', () => {
    it('returns low for ratio 0.05 (1 of 20)', () => {
      expect(classifyAddonVolume({ addonCount: 1, totalCases: 20 })).toBe('low');
    });

    it('returns excessive for ratio 0.5 (10 of 20)', () => {
      expect(classifyAddonVolume({ addonCount: 10, totalCases: 20 })).toBe('excessive');
    });
  });

  describe('classifyBlockRecommendation', () => {
    it('returns reallocate + high severity when utilization is under and prime is low', () => {
      const result = classifyBlockRecommendation({
        scheduledMinutes: 200,
        allocatedMinutes: 500,
        primeUsedMinutes: 50,
        primeAllocatedMinutes: 200,
        overrunCount: 0,
        addonCount: 0,
        totalCases: 4,
        avgTurnoverMinutes: 25,
      });
      expect(result.recommendation).toBe('reallocate');
      expect(result.severity).toBe('high');
      expect(result.signals.some((s) => s.code === 'LOW_UTILIZATION')).toBe(true);
      expect(result.signals.some((s) => s.code === 'LOW_PRIME_TIME')).toBe(true);
    });

    it('returns expand + critical severity when over-utilized with chronic overruns + addon pressure', () => {
      const result = classifyBlockRecommendation({
        scheduledMinutes: 520,
        allocatedMinutes: 500,
        primeUsedMinutes: 180,
        primeAllocatedMinutes: 200,
        overrunCount: 8,
        addonCount: 7,
        totalCases: 20,
        avgTurnoverMinutes: 30,
      });
      expect(result.recommendation).toBe('expand');
      expect(result.severity).toBe('critical');
      expect(result.signals.some((s) => s.code === 'ADDON_PRESSURE')).toBe(true);
    });

    it('returns keep + low severity for a healthy block', () => {
      const result = classifyBlockRecommendation({
        scheduledMinutes: 380,
        allocatedMinutes: 500,
        primeUsedMinutes: 170,
        primeAllocatedMinutes: 200,
        overrunCount: 1,
        addonCount: 1,
        totalCases: 12,
        avgTurnoverMinutes: 28,
      });
      expect(result.recommendation).toBe('keep');
      expect(result.severity).toBe('low');
    });
  });

  describe('escalateSeverity', () => {
    it('picks the highest-priority severity', () => {
      expect(escalateSeverity(['low', 'critical', 'moderate'])).toBe('critical');
    });
  });

  describe('escalateRecommendation', () => {
    it('picks the highest-priority recommendation', () => {
      expect(escalateRecommendation(['keep', 'reallocate', 'expand'])).toBe('reallocate');
    });
  });

  describe('buildBlockActions', () => {
    it('includes a reallocation sentence and the disclaimer for reallocate', () => {
      const actions = buildBlockActions({
        recommendation: 'reallocate',
        signals: [{ code: 'LOW_UTILIZATION' }, { code: 'LOW_PRIME_TIME' }],
      });
      expect(actions.some((line) => /reallocat/i.test(line))).toBe(true);
      expect(actions[actions.length - 1]).toMatch(/decision support only/i);
      expect(actions[actions.length - 1]).toMatch(/OR director/i);
    });
  });

  describe('summarizeBlock', () => {
    it('returns a string containing surgeon name and recommendation', () => {
      const summary = summarizeBlock({
        surgeonName: 'Dr. Rao',
        serviceLine: 'Orthopaedics',
        blockLabel: 'MON-A',
        recommendation: 'reallocate',
        severity: 'high',
        utilizationPct: 42,
        primeTimeUtilizationPct: 30,
        overrunCount: 0,
        addonCount: 1,
      });
      expect(typeof summary).toBe('string');
      expect(summary).toContain('Dr. Rao');
      expect(summary).toContain('reallocate');
    });
  });
});
