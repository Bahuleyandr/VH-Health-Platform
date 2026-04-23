import {
  aggregateRoiMetrics,
  calculateAcceptanceRate,
  calculateCostPerUsefulDraft,
  calculateTimeSaved,
} from '../../services/ai/aiRoiDashboardService.js';

describe('AI ROI dashboard helpers', () => {
  describe('calculateAcceptanceRate', () => {
    it('returns 0 when total is zero', () => {
      expect(calculateAcceptanceRate({ accepted: 0, total: 0 })).toBe(0);
    });

    it('rounds to 2 decimals', () => {
      expect(calculateAcceptanceRate({ accepted: 1, total: 3 })).toBe(33.33);
      expect(calculateAcceptanceRate({ accepted: 2, total: 3 })).toBe(66.67);
    });

    it('handles non-numeric inputs', () => {
      expect(calculateAcceptanceRate({ accepted: 'abc', total: 'xyz' })).toBe(0);
    });
  });

  describe('calculateTimeSaved', () => {
    it('uses module-specific defaults when available', () => {
      expect(calculateTimeSaved({ moduleKey: 'discharge_summary', acceptedCount: 4 })).toBe(72);
      expect(calculateTimeSaved({ moduleKey: 'appeal_letter_generator', acceptedCount: 2 })).toBe(60);
    });

    it('respects module override values over defaults', () => {
      expect(
        calculateTimeSaved({
          moduleKey: 'discharge_summary',
          acceptedCount: 3,
          moduleOverrides: { discharge_summary: 20 },
        })
      ).toBe(60);
    });

    it('falls back to the generic minutes for unknown modules', () => {
      expect(calculateTimeSaved({ moduleKey: 'nonexistent_module', acceptedCount: 3 })).toBe(24);
    });

    it('treats negative accepted counts as zero', () => {
      expect(calculateTimeSaved({ moduleKey: 'discharge_summary', acceptedCount: -5 })).toBe(0);
    });
  });

  describe('calculateCostPerUsefulDraft', () => {
    it('returns 0 when accepted count is zero', () => {
      expect(calculateCostPerUsefulDraft({ totalCostMinor: 1000, acceptedCount: 0 })).toBe(0);
    });

    it('computes integer quotient rounded to 2 decimals', () => {
      expect(calculateCostPerUsefulDraft({ totalCostMinor: 1000, acceptedCount: 4 })).toBe(250);
      expect(calculateCostPerUsefulDraft({ totalCostMinor: 1001, acceptedCount: 3 })).toBe(333.67);
    });
  });

  describe('aggregateRoiMetrics', () => {
    const generations = [
      {
        module_key: 'discharge_summary',
        generation_count: 10,
        ai_generation_count: 8,
        fallback_count: 2,
        total_tokens: 5000,
        total_cost_minor: 1200,
      },
      {
        module_key: 'appeal_letter_generator',
        generation_count: 4,
        ai_generation_count: 4,
        fallback_count: 0,
        total_tokens: 3000,
        total_cost_minor: 800,
      },
      {
        module_key: 'patient_teach_back_comprehension',
        generation_count: 6,
        ai_generation_count: 5,
        fallback_count: 1,
        total_tokens: 1500,
        total_cost_minor: 400,
      },
    ];
    const reviews = [
      { module_key: 'discharge_summary', accepted_count: 6, rejected_count: 1, pending_count: 3, edited_count: 0 },
      { module_key: 'appeal_letter_generator', accepted_count: 3, rejected_count: 0, pending_count: 1, edited_count: 0 },
      { module_key: 'patient_teach_back_comprehension', accepted_count: 4, rejected_count: 0, pending_count: 2, edited_count: 0 },
    ];
    const appealApprovals = [{ approved_count: 2, claim_amount_total: '25000.50' }];
    const priorAuthApprovals = [{ approved_count: 3 }];

    it('aggregates per-module + overall metrics', () => {
      const result = aggregateRoiMetrics({ generations, reviews, appealApprovals, priorAuthApprovals });
      expect(result.generation_count).toBe(20);
      expect(result.accepted_count).toBe(13);
      expect(result.rejected_count).toBe(1);
      expect(result.pending_count).toBe(6);
      expect(result.total_tokens).toBe(9500);
      expect(result.total_cost_minor).toBe(2400);
      expect(result.acceptance_rate_pct).toBe(65);
      expect(result.cost_per_useful_draft_minor).toBeGreaterThan(0);
      expect(result.by_module).toHaveLength(3);
    });

    it('computes module-specific time saved using defaults', () => {
      const result = aggregateRoiMetrics({ generations, reviews, appealApprovals, priorAuthApprovals });
      const dischargeModule = result.by_module.find((row) => row.module_key === 'discharge_summary');
      expect(dischargeModule.time_saved_minutes).toBe(108);
      const appealModule = result.by_module.find((row) => row.module_key === 'appeal_letter_generator');
      expect(appealModule.time_saved_minutes).toBe(90);
      expect(result.time_saved_minutes).toBeGreaterThan(0);
    });

    it('converts documentation-module minutes into hours', () => {
      const result = aggregateRoiMetrics({ generations, reviews, appealApprovals, priorAuthApprovals });
      expect(result.documentation_hours_saved).toBeGreaterThan(0);
      expect(result.documentation_hours_saved).toBeCloseTo((108 + 90) / 60, 2);
    });

    it('tallies denial value prevented and approval counts', () => {
      const result = aggregateRoiMetrics({ generations, reviews, appealApprovals, priorAuthApprovals });
      expect(result.denial_value_prevented_minor).toBe(25001);
      expect(result.appeal_approved_count).toBe(2);
      expect(result.prior_auth_approved_count).toBe(3);
    });

    it('returns highlights sorted by accepted_count', () => {
      const result = aggregateRoiMetrics({ generations, reviews, appealApprovals, priorAuthApprovals });
      expect(Array.isArray(result.highlights)).toBe(true);
      expect(result.highlights.length).toBeGreaterThan(0);
      for (const highlight of result.highlights) {
        expect(highlight.accepted_count).toBeGreaterThan(0);
      }
    });

    it('handles empty inputs without crashing', () => {
      const result = aggregateRoiMetrics({});
      expect(result.generation_count).toBe(0);
      expect(result.accepted_count).toBe(0);
      expect(result.by_module).toHaveLength(0);
      expect(result.highlights).toHaveLength(0);
    });
  });
});
