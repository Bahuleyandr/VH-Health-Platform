import {
  splitSentences,
  extractNumbers,
  computeCitationCoverage,
  detectUnsupportedClaims,
  checkNumericCoherence,
  detectPhiLeakage,
  detectBiasMarkers,
  classifyTrustBand,
  escalateTrustBand,
  buildExplainabilityActions,
  summarizeExplainability,
} from '../../services/ai/aiExplainabilityDashboardService.js';

describe('ai explainability dashboard helpers', () => {
  describe('splitSentences', () => {
    it('splits on sentence terminators and drops blanks', () => {
      const sentences = splitSentences('First sentence. Second one! Third? ');
      expect(sentences.length).toBe(3);
    });
  });

  describe('extractNumbers', () => {
    it('extracts vitals-style numeric tokens with units', () => {
      const results = extractNumbers('Blood pressure 120/80 mmHg, HR 85, temp 37.5 C');
      const values = results.map((r) => r.value);
      expect(values).toEqual(expect.arrayContaining([120, 85, 37.5]));
    });

    it('excludes a pure 4-digit year with no trailing unit', () => {
      const results = extractNumbers('Admitted in 2024 without complications');
      const values = results.map((r) => r.value);
      expect(values).not.toContain(2024);
    });
  });

  describe('computeCitationCoverage', () => {
    it('matches citation substrings against sentences', () => {
      const result = computeCitationCoverage({
        draftText: 'Patient has pneumonia. Started antibiotics.',
        citations: [{ label: 'CXR shows pneumonia', source_id: 'imaging:1' }],
      });
      expect(result.coverage_pct).toBeGreaterThan(0);
      expect(result.evidence_map.length).toBe(2);
      expect(result.evidence_map[0].matched_citation_ids.length).toBeGreaterThan(0);
    });

    it('returns 0 coverage with empty citations', () => {
      const result = computeCitationCoverage({
        draftText: 'Patient stable.',
        citations: [],
      });
      expect(result.coverage_pct).toBe(0);
    });
  });

  describe('detectUnsupportedClaims', () => {
    it('flags a clinical sentence without any matching citation', () => {
      const result = detectUnsupportedClaims({
        draftText: 'Patient has new severe pneumonia. Weather is nice today.',
        citations: [],
      });
      expect(result.claims.some((claim) => /severe pneumonia/i.test(claim))).toBe(true);
    });
  });

  describe('checkNumericCoherence', () => {
    it('returns 100% coherence when all numbers appear in citations', () => {
      const result = checkNumericCoherence({
        draftText: 'Temp 37.5 C, HR 85',
        citations: [{ label: 'Vitals: 37.5 C, HR 85', source_id: 'v1' }],
      });
      expect(result.coherence_pct).toBe(100);
    });

    it('returns 0% coherence and records a mismatch when nothing supports the number', () => {
      const result = checkNumericCoherence({
        draftText: 'Temp 37.5 C',
        citations: [{ label: 'No vitals recorded', source_id: 'n1' }],
      });
      expect(result.coherence_pct).toBe(0);
      expect(result.mismatches.length).toBe(1);
    });
  });

  describe('detectPhiLeakage', () => {
    it('flags phone and email indicators', () => {
      const result = detectPhiLeakage('Call patient at 9876543210 or email j@doe.com');
      expect(result.count).toBeGreaterThanOrEqual(2);
      const codes = result.leaks.map((l) => l.code);
      expect(codes).toEqual(expect.arrayContaining(['PHONE_LEAK', 'EMAIL_LEAK']));
    });

    it('returns zero leaks for benign text', () => {
      const result = detectPhiLeakage('Routine follow-up in 3 days.');
      expect(result.count).toBe(0);
    });
  });

  describe('detectBiasMarkers', () => {
    it('flags gendered + age terms that are not supported by the context', () => {
      const result = detectBiasMarkers({
        draftText: 'The elderly male patient is improving.',
        contextText: 'Patient improving.',
      });
      expect(result.count).toBeGreaterThanOrEqual(2);
      const codes = result.markers.map((m) => m.code);
      expect(codes).toEqual(expect.arrayContaining([
        'UNSUPPORTED_GENDER_TERM',
        'UNSUPPORTED_AGE_TERM',
      ]));
    });

    it('skips markers when the context supports the same term', () => {
      const result = detectBiasMarkers({
        draftText: 'The male patient is improving.',
        contextText: 'Male patient, age 72.',
      });
      expect(result.count).toBe(0);
    });
  });

  describe('classifyTrustBand', () => {
    it('returns trusted/low for clean input', () => {
      const result = classifyTrustBand({
        citationCoveragePct: 90,
        unsupportedClaimCount: 0,
        numericCoherencePct: 100,
        phiLeakageCount: 0,
        biasMarkerCount: 0,
      });
      expect(result.trust_band).toBe('trusted');
      expect(result.severity).toBe('low');
    });

    it('rejects critical when PHI leakage is present', () => {
      const result = classifyTrustBand({
        citationCoveragePct: 90,
        unsupportedClaimCount: 0,
        numericCoherencePct: 100,
        phiLeakageCount: 1,
        biasMarkerCount: 0,
      });
      expect(result.trust_band).toBe('reject');
      expect(result.severity).toBe('critical');
      expect(result.signals[0].code).toBe('PHI_LEAKAGE');
    });

    it('rejects/high for many unsupported claims', () => {
      const result = classifyTrustBand({
        citationCoveragePct: 40,
        unsupportedClaimCount: 4,
        numericCoherencePct: 100,
        phiLeakageCount: 0,
        biasMarkerCount: 0,
      });
      expect(result.trust_band).toBe('reject');
      expect(result.severity).toBe('high');
      expect(result.signals[0].code).toBe('HIGH_UNSUPPORTED_CONTENT');
    });

    it('flags partial coverage as review/low when coverage is below 70', () => {
      const result = classifyTrustBand({
        citationCoveragePct: 60,
        unsupportedClaimCount: 0,
        numericCoherencePct: 85,
        phiLeakageCount: 0,
        biasMarkerCount: 1,
      });
      expect(result.trust_band).toBe('review');
      expect(result.severity).toBe('low');
      expect(result.signals[0].code).toBe('PARTIAL_COVERAGE');
    });
  });

  describe('escalateTrustBand', () => {
    it('returns the most-restrictive band in the list', () => {
      expect(escalateTrustBand(['trusted', 'review', 'reject'])).toBe('reject');
    });
  });

  describe('buildExplainabilityActions', () => {
    it('produces reject-specific guidance and ends with the governance disclaimer', () => {
      const actions = buildExplainabilityActions({
        trustBand: 'reject',
        signals: [{ code: 'PHI_LEAKAGE' }],
      });
      expect(actions.some((line) => /AI governance review required/i.test(line))).toBe(true);
      expect(actions.some((line) => /PHI|reject/i.test(line))).toBe(true);
    });
  });

  describe('summarizeExplainability', () => {
    it('mentions the module key and trust band in the summary', () => {
      const summary = summarizeExplainability({
        moduleKey: 'discharge_summary',
        trustBand: 'trusted',
        severity: 'low',
        citationCoveragePct: 95,
        unsupportedClaimCount: 0,
        phiLeakageCount: 0,
      });
      expect(summary).toMatch(/discharge_summary/);
      expect(summary).toMatch(/trusted/);
    });
  });
});
