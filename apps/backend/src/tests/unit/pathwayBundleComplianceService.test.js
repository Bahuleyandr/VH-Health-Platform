import {
  buildPathwayActions,
  classifyItemStatus,
  classifySeverityAndRecommendation,
  escalateRecommendation,
  escalateSeverity,
  evaluateBundle,
  getPathwaySpec,
  summarizePathwayAudit,
} from '../../services/ai/pathwayBundleComplianceService.js';

describe('pathway bundle compliance helpers', () => {
  describe('getPathwaySpec', () => {
    it('returns a preset spec for stroke_gwg with >= 4 items', () => {
      const spec = getPathwaySpec({ pathwayKey: 'stroke_gwg' });
      expect(spec).toBeTruthy();
      expect(Array.isArray(spec.items)).toBe(true);
      expect(spec.items.length).toBeGreaterThanOrEqual(4);
    });

    it('throws for an unknown pathway key', () => {
      expect(() => getPathwaySpec({ pathwayKey: 'bogus_pathway_xyz' })).toThrow();
    });
  });

  describe('classifyItemStatus', () => {
    it('returns compliant with delta 30 when action is within deadline', () => {
      const res = classifyItemStatus({
        item: { item_key: 'x', deadline_minutes: 60 },
        actionAt: '2026-04-23T10:30:00Z',
        t0: '2026-04-23T10:00:00Z',
      });
      expect(res.status).toBe('compliant');
      expect(res.delta_minutes).toBe(30);
    });

    it('returns late with delta 90 when action is past deadline', () => {
      const res = classifyItemStatus({
        item: { item_key: 'x', deadline_minutes: 60 },
        actionAt: '2026-04-23T11:30:00Z',
        t0: '2026-04-23T10:00:00Z',
      });
      expect(res.status).toBe('late');
      expect(res.delta_minutes).toBe(90);
    });

    it('returns missed when no action and t0 is provided', () => {
      const res = classifyItemStatus({
        item: { item_key: 'x', deadline_minutes: 60 },
        actionAt: null,
        t0: '2026-04-23T10:00:00Z',
      });
      expect(res.status).toBe('missed');
    });

    it('returns not_applicable when na_when_absent matches a context flag', () => {
      const res = classifyItemStatus({
        item: {
          item_key: 'tpa',
          deadline_minutes: 60,
          na_when_absent: true,
          na_context_key: 'tpa_candidate',
          na_context_value: false,
        },
        actionAt: null,
        t0: '2026-04-23T10:00:00Z',
        context: { tpa_candidate: false },
      });
      expect(res.status).toBe('not_applicable');
    });
  });

  describe('evaluateBundle', () => {
    it('evaluates ACS MONA with two compliant actions', () => {
      const res = evaluateBundle({
        pathwayKey: 'acs_mona',
        t0Reference: '2026-04-23T10:00:00Z',
        actions: [
          { item_key: 'aspirin', occurred_at: '2026-04-23T10:05:00Z' },
          { item_key: 'ecg_12_lead', occurred_at: '2026-04-23T10:08:00Z' },
        ],
        context: { pci_candidate: false, beta_blocker_contraindicated: false },
      });
      expect(res.compliance_pct).toBeGreaterThanOrEqual(0);
      expect(res.compliance_pct).toBeLessThanOrEqual(100);
      expect(res.compliant_count).toBeGreaterThanOrEqual(2);
    });

    it('evaluates stroke_gwg with no actions — zero compliant, some missed', () => {
      const res = evaluateBundle({
        pathwayKey: 'stroke_gwg',
        t0Reference: '2026-04-23T10:00:00Z',
        actions: [],
        context: { tpa_candidate: false },
      });
      expect(res.compliant_count).toBe(0);
      expect(res.missed_count).toBeGreaterThan(0);
    });
  });

  describe('classifySeverityAndRecommendation', () => {
    it('flags critical missed items as critical / critical_miss', () => {
      const res = classifySeverityAndRecommendation({
        itemResults: [
          { critical: true, status: 'missed' },
          { critical: false, status: 'compliant' },
        ],
      });
      expect(res.severity).toBe('critical');
      expect(res.recommendation).toBe('critical_miss');
    });

    it('flags critical late items as high / escalate', () => {
      const res = classifySeverityAndRecommendation({
        itemResults: [
          { critical: true, status: 'late' },
          { critical: false, status: 'compliant' },
        ],
      });
      expect(res.severity).toBe('high');
      expect(res.recommendation).toBe('escalate');
    });

    it('returns low / no_action for all-compliant items', () => {
      const res = classifySeverityAndRecommendation({
        itemResults: [
          { critical: false, status: 'compliant' },
          { critical: false, status: 'compliant' },
        ],
      });
      expect(res.severity).toBe('low');
      expect(res.recommendation).toBe('no_action');
    });

    it('escalates on mixed lates/misses (non-critical) to at-least moderate', () => {
      const res = classifySeverityAndRecommendation({
        itemResults: [
          { critical: false, status: 'compliant' },
          { critical: false, status: 'late' },
          { critical: false, status: 'late' },
          { critical: false, status: 'missed' },
        ],
      });
      expect(['moderate', 'high', 'critical']).toContain(res.severity);
      expect(['catch_up', 'review_pathway', 'escalate']).toContain(res.recommendation);
    });
  });

  describe('escalateSeverity / escalateRecommendation', () => {
    it('escalateSeverity picks the highest severity', () => {
      expect(escalateSeverity(['low', 'critical', 'moderate'])).toBe('critical');
    });

    it('escalateRecommendation picks the highest recommendation', () => {
      expect(escalateRecommendation(['no_action', 'escalate', 'catch_up'])).toBe('escalate');
    });
  });

  describe('buildPathwayActions', () => {
    it('includes the disclaimer and a sentence about the critical missed item', () => {
      const actions = buildPathwayActions({
        recommendation: 'critical_miss',
        severity: 'critical',
        itemResults: [
          {
            item_key: 'aspirin',
            critical: true,
            status: 'missed',
            display: 'Aspirin 325 mg within 10 min',
          },
        ],
      });
      expect(Array.isArray(actions)).toBe(true);
      const joined = actions.join(' \n ').toLowerCase();
      expect(joined).toContain('decision support only');
      expect(joined.includes('aspirin') || joined.includes('critical')).toBe(true);
    });
  });

  describe('summarizePathwayAudit', () => {
    it('mentions the pathway key and recommendation', () => {
      const s = summarizePathwayAudit({
        pathwayKey: 'acs_mona',
        compliancePct: 50,
        severity: 'high',
        recommendation: 'escalate',
      });
      expect(typeof s).toBe('string');
      expect(s).toContain('acs_mona');
      expect(s).toContain('escalate');
    });
  });
});
