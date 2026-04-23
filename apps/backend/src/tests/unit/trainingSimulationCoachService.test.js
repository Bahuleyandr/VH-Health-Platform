import {
  scrubPhiFromSummary,
  normalizeCaseType,
  classifyIncidentRisk,
  suggestFormat,
  suggestDuration,
  deriveTargetRoles,
  buildLearningObjectives,
  buildDecisionPoints,
  buildTrainingModule,
} from '../../services/ai/trainingSimulationCoachService.js';

describe('training simulation coach helpers', () => {
  describe('scrubPhiFromSummary', () => {
    it('replaces a 10-digit phone run with [PHONE] and flags PHONE_DETECTED', () => {
      const result = scrubPhiFromSummary('Patient phone 9876543210');
      expect(result.scrubbed).toContain('[PHONE]');
      expect(result.findings).toContain('PHONE_DETECTED');
    });

    it('replaces MRN: VH-12345 with [MRN] and flags MRN_DETECTED', () => {
      const result = scrubPhiFromSummary('MRN: VH-12345');
      expect(result.scrubbed).toContain('[MRN]');
      expect(result.findings).toContain('MRN_DETECTED');
    });

    it('returns an empty findings array for a routine summary with no PHI', () => {
      const result = scrubPhiFromSummary('Routine case summary');
      expect(result.findings).toEqual([]);
    });
  });

  describe('normalizeCaseType', () => {
    it('normalizes mixed-case input', () => {
      expect(normalizeCaseType('Mortality')).toBe('mortality');
    });

    it('falls back to other for unknown values', () => {
      expect(normalizeCaseType('bogus_thing')).toBe('other');
    });
  });

  describe('classifyIncidentRisk', () => {
    it('mortality + critical → critical band, score 70', () => {
      const result = classifyIncidentRisk({ caseType: 'mortality', severity: 'critical' });
      expect(result.risk_band).toBe('critical');
      expect(result.risk_score).toBe(70);
    });

    it('near_miss + low → low band, score 15', () => {
      const result = classifyIncidentRisk({ caseType: 'near_miss', severity: 'low' });
      expect(result.risk_band).toBe('low');
      expect(result.risk_score).toBe(15);
    });
  });

  describe('suggestFormat', () => {
    it('mortality + critical → sim_lab', () => {
      expect(suggestFormat({ caseType: 'mortality', severity: 'critical' })).toBe('sim_lab');
    });

    it('handoff_failure + moderate → tabletop', () => {
      expect(suggestFormat({ caseType: 'handoff_failure', severity: 'moderate' })).toBe('tabletop');
    });
  });

  describe('suggestDuration', () => {
    it('safety_event + critical + sim_lab → 75', () => {
      expect(suggestDuration({ caseType: 'safety_event', severity: 'critical', format: 'sim_lab' })).toBe(75);
    });

    it('near_miss + low + online → 30', () => {
      expect(suggestDuration({ caseType: 'near_miss', severity: 'low', format: 'online' })).toBe(30);
    });
  });

  describe('deriveTargetRoles', () => {
    it('medication_error includes PHARMACY_STAFF', () => {
      const roles = deriveTargetRoles({ caseType: 'medication_error' });
      expect(roles).toContain('PHARMACY_STAFF');
    });

    it('safety_event + airway adds ANESTHESIOLOGIST', () => {
      const roles = deriveTargetRoles({ caseType: 'safety_event', incidentCategory: 'airway' });
      expect(roles).toContain('ANESTHESIOLOGIST');
    });
  });

  describe('buildLearningObjectives', () => {
    it('returns between 3 and 6 objectives inclusive', () => {
      const objectives = buildLearningObjectives({ caseType: 'mortality', severity: 'high' });
      expect(objectives.length).toBeGreaterThanOrEqual(3);
      expect(objectives.length).toBeLessThanOrEqual(6);
    });
  });

  describe('buildDecisionPoints', () => {
    it('returns between 3 and 5 structured points for handoff_failure', () => {
      const points = buildDecisionPoints({ caseType: 'handoff_failure' });
      expect(points.length).toBeGreaterThanOrEqual(3);
      expect(points.length).toBeLessThanOrEqual(5);
      for (const p of points) {
        expect(typeof p.stage).toBe('string');
        expect(typeof p.prompt).toBe('string');
        expect(Array.isArray(p.key_options)).toBe(true);
        expect(typeof p.correct_path).toBe('string');
      }
    });
  });

  describe('buildTrainingModule', () => {
    it('propagates PHI findings from summary scrubbing', () => {
      const module = buildTrainingModule({
        title: 'X',
        caseType: 'safety_event',
        severity: 'high',
        summary: 'MRN: VH-99',
      });
      expect(module.phi_findings).toContain('MRN_DETECTED');
    });

    it('mortality + critical produces sim_lab format and critical risk_band', () => {
      const module = buildTrainingModule({
        title: 'Y',
        caseType: 'mortality',
        severity: 'critical',
      });
      expect(module.format).toBe('sim_lab');
      expect(module.risk_band).toBe('critical');
    });
  });
});
