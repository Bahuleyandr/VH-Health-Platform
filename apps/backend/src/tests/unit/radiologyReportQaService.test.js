import {
  normalizeLaterality,
  detectLateralityMismatch,
  hasImpressionSection,
  hasCriticalCommunicationNote,
  extractFollowUpRecommendations,
  detectIndicationAddressed,
  detectMeasurementCompleteness,
  detectFindingsImpressionConsistency,
  classifyReportQaDiscrepancies,
  computeOverallSeverity,
  buildReportQaActions,
} from '../../services/ai/radiologyReportQaService.js';

describe('radiology report QA helpers', () => {
  describe('normalizeLaterality', () => {
    it('detects "left" from a plain word', () => {
      expect(normalizeLaterality('left knee pain')).toBe('left');
    });

    it('detects "right" from a plain word', () => {
      expect(normalizeLaterality('evaluate right shoulder')).toBe('right');
    });

    it('detects "bilateral" when present', () => {
      expect(normalizeLaterality('bilateral lower limb swelling')).toBe('bilateral');
    });

    it('detects "left" from LT abbreviation', () => {
      expect(normalizeLaterality('LT wrist fracture')).toBe('left');
    });

    it('detects "right" from RT abbreviation', () => {
      expect(normalizeLaterality('RT knee effusion')).toBe('right');
    });

    it('recognizes "both sides" as bilateral', () => {
      expect(normalizeLaterality('pain on both sides')).toBe('bilateral');
    });

    it('returns unspecified when no side is mentioned', () => {
      expect(normalizeLaterality('abdominal pain, generalised')).toBe('unspecified');
    });

    it('returns null for empty input', () => {
      expect(normalizeLaterality('')).toBeNull();
    });
  });

  describe('detectLateralityMismatch', () => {
    it('flags mismatch when indication is left and report is right', () => {
      const result = detectLateralityMismatch({
        indication: 'evaluate left knee pain',
        reportText: 'Right knee shows joint effusion.',
      });
      expect(result.mismatch).toBe(true);
      expect(result.indication_side).toBe('left');
      expect(result.report_side).toBe('right');
    });

    it('does not flag mismatch when both sides agree', () => {
      const result = detectLateralityMismatch({
        indication: 'evaluate left knee pain',
        reportText: 'Left knee shows joint effusion.',
      });
      expect(result.mismatch).toBe(false);
    });

    it('does not flag mismatch when one side is null', () => {
      const result = detectLateralityMismatch({
        indication: '',
        reportText: 'Right knee shows joint effusion.',
      });
      expect(result.mismatch).toBe(false);
    });
  });

  describe('hasImpressionSection', () => {
    it('returns true when "IMPRESSION:" header present', () => {
      const text = 'FINDINGS: No acute abnormality.\nIMPRESSION: Normal chest radiograph.';
      expect(hasImpressionSection(text)).toBe(true);
    });

    it('returns false when report has no impression header', () => {
      const text = 'The chest radiograph is unremarkable. Lungs are clear.';
      expect(hasImpressionSection(text)).toBe(false);
    });
  });

  describe('hasCriticalCommunicationNote', () => {
    it('returns true when report notes communication to a clinician', () => {
      const text = 'Critical finding of pneumothorax communicated to Dr. Patel at 14:30.';
      expect(hasCriticalCommunicationNote(text)).toBe(true);
    });

    it('returns false when no communication language is present', () => {
      const text = 'Findings include small left pneumothorax. Impression: small pneumothorax.';
      expect(hasCriticalCommunicationNote(text)).toBe(false);
    });
  });

  describe('extractFollowUpRecommendations', () => {
    it('extracts a non-empty list when follow-up is mentioned', () => {
      const text = 'Recommend follow-up MRI in 3 months to reassess.';
      const result = extractFollowUpRecommendations(text);
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns an empty list for a plain normal report', () => {
      const text = 'Lungs are clear. No pleural effusion. Heart size normal.';
      expect(extractFollowUpRecommendations(text)).toEqual([]);
    });
  });

  describe('detectIndicationAddressed', () => {
    it('returns addressed:true when indication keywords appear in report', () => {
      const result = detectIndicationAddressed({
        indication: 'evaluate for pneumonia',
        reportText: 'Findings consistent with right lower lobe pneumonia.',
      });
      expect(result.addressed).toBe(true);
    });

    it('returns addressed:false when indication is not addressed in a mismatched report', () => {
      const result = detectIndicationAddressed({
        indication: 'evaluate for appendicitis right lower quadrant tenderness',
        reportText: 'Chest radiograph shows clear lungs with no consolidation.',
      });
      expect(result.addressed).toBe(false);
    });
  });

  describe('detectMeasurementCompleteness', () => {
    it('recognises a numeric measurement as non-vague', () => {
      const result = detectMeasurementCompleteness('There is a 2.3 cm nodule in the right upper lobe.');
      expect(result.hasMeasurements).toBe(true);
      expect(result.vague).toBe(false);
    });

    it('flags "enlarged" without a number as vague', () => {
      const result = detectMeasurementCompleteness('The liver is enlarged with no focal lesion.');
      expect(result.vague).toBe(true);
    });
  });

  describe('detectFindingsImpressionConsistency', () => {
    it('returns consistent:true when both sections mention pneumonia', () => {
      const text = 'FINDINGS: Right lower lobe findings compatible with pneumonia.\nIMPRESSION: Right lower lobe pneumonia.';
      const result = detectFindingsImpressionConsistency({ reportText: text });
      expect(result.consistent).toBe(true);
    });

    it('flags inconsistency when pneumonia is in findings but missing in impression', () => {
      const text = 'FINDINGS: Right lower lobe findings compatible with pneumonia.\nIMPRESSION: No acute abnormality.';
      const result = detectFindingsImpressionConsistency({ reportText: text });
      expect(result.consistent).toBe(false);
      expect(result.flaggedTerms).toContain('pneumonia');
    });
  });

  describe('classifyReportQaDiscrepancies', () => {
    it('returns expected codes for laterality mismatch + missing impression + vague measurements on a final report', () => {
      const result = classifyReportQaDiscrepancies({
        indication: 'evaluate left knee pain',
        reportText: 'Right knee shows an enlarged effusion and soft tissue swelling.',
        priorsAvailable: false,
        isCritical: false,
        reportStatus: 'final',
      });
      const codes = result.map((d) => d.code);
      expect(codes).toContain('LATERALITY_MISMATCH');
      expect(codes).toContain('MISSING_IMPRESSION');
      expect(codes).toContain('VAGUE_MEASUREMENTS');
    });

    it('returns an empty array for a clean draft report with no priors and non-critical', () => {
      const result = classifyReportQaDiscrepancies({
        indication: 'routine screening chest radiograph',
        reportText: 'FINDINGS: Lungs are clear. Heart size is normal.\nIMPRESSION: Normal chest radiograph for routine screening.',
        priorsAvailable: false,
        isCritical: false,
        reportStatus: 'draft',
      });
      expect(result).toEqual([]);
    });
  });

  describe('computeOverallSeverity', () => {
    it('returns critical when any discrepancy is critical', () => {
      const discrepancies = [
        { code: 'A', severity: 'low' },
        { code: 'B', severity: 'high' },
        { code: 'C', severity: 'critical' },
      ];
      expect(computeOverallSeverity(discrepancies)).toBe('critical');
    });

    it('returns low for an empty array', () => {
      expect(computeOverallSeverity([])).toBe('low');
    });
  });

  describe('buildReportQaActions', () => {
    it('always appends the radiologist-review disclaimer', () => {
      const actions = buildReportQaActions([]);
      expect(actions[actions.length - 1]).toBe('Radiologist review required before finalization — decision support only.');
    });

    it('produces specific action strings for each discrepancy code passed', () => {
      const actions = buildReportQaActions([
        { code: 'LATERALITY_MISMATCH', severity: 'critical', message: 'x' },
        { code: 'MISSING_IMPRESSION', severity: 'high', message: 'x' },
        { code: 'VAGUE_MEASUREMENTS', severity: 'low', message: 'x' },
      ]);
      expect(actions.some((a) => /laterality/i.test(a))).toBe(true);
      expect(actions.some((a) => /impression/i.test(a))).toBe(true);
      expect(actions.some((a) => /vague|numeric/i.test(a))).toBe(true);
    });
  });
});
