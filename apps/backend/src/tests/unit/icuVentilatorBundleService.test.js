import {
  computeComplianceAndGaps,
  detectVentilatorStatus,
  evaluateSbtReadiness,
  evaluateSedationAssessment,
  evaluateVapBundle,
} from '../../services/ai/icuVentilatorBundleService.js';

function event(overrides = {}) {
  return {
    event_type: overrides.event_type || 'clinical_note',
    sub_type: overrides.sub_type || null,
    id: overrides.id ?? 1,
    summary: overrides.summary || '',
    timestamp: overrides.timestamp || '2026-04-22T08:00:00.000Z',
    payload: overrides.payload || {},
  };
}

describe('icu ventilator bundle helpers', () => {
  describe('detectVentilatorStatus', () => {
    it('returns ventilated when intubation + vent settings keywords are present', () => {
      const result = detectVentilatorStatus({
        medications: [],
        clinicalOrders: [event({ event_type: 'clinical_order', summary: 'Mechanical ventilation ordered, ventilator settings FiO2 50%' })],
        notes: [event({ summary: 'Patient intubated and stable on vent' })],
      });
      expect(result.status).toBe('ventilated');
      expect(result.evidence.length).toBeGreaterThan(0);
    });

    it('returns extubated when a recent extubation note follows intubation evidence', () => {
      const result = detectVentilatorStatus({
        medications: [],
        clinicalOrders: [],
        notes: [
          event({ id: 1, timestamp: '2026-04-20T08:00:00.000Z', summary: 'Patient intubated for resp failure' }),
          event({ id: 2, timestamp: '2026-04-22T10:00:00.000Z', summary: 'Patient extubated successfully' }),
        ],
      });
      expect(result.status).toBe('extubated');
    });

    it('returns weaning when SBT or weaning keywords are the latest signal', () => {
      const result = detectVentilatorStatus({
        medications: [],
        clinicalOrders: [],
        notes: [
          event({ id: 1, timestamp: '2026-04-20T08:00:00.000Z', summary: 'Patient intubated' }),
          event({ id: 2, timestamp: '2026-04-22T10:00:00.000Z', summary: 'Weaning from ventilator, SBT planned' }),
        ],
      });
      expect(result.status).toBe('weaning');
    });

    it('returns unknown when no ventilator-related keywords exist', () => {
      const result = detectVentilatorStatus({
        medications: [],
        clinicalOrders: [],
        notes: [event({ summary: 'Routine ward round, patient comfortable' })],
      });
      expect(result.status).toBe('unknown');
    });
  });

  describe('evaluateVapBundle', () => {
    it('detects head-of-bed elevation and oral care from nursing notes', () => {
      const result = evaluateVapBundle({
        notes: [
          event({ summary: 'HOB 30 degrees maintained, semi-fowlers position' }),
          event({ summary: 'Oral care with chlorhexidine mouthwash performed this shift' }),
        ],
        orders: [],
        vitals: [],
        medications: [],
      });
      expect(result.head_of_bed_elevated).toBe(true);
      expect(result.oral_care_performed).toBe(true);
    });

    it('detects DVT and PUD prophylaxis from medications', () => {
      const result = evaluateVapBundle({
        notes: [],
        orders: [],
        vitals: [],
        medications: [
          event({ event_type: 'medication', summary: 'Enoxaparin 40mg subcutaneous for DVT prophylaxis', payload: { medication_name: 'Enoxaparin', route: 'sc' } }),
          event({ event_type: 'medication', summary: 'Pantoprazole 40mg IV daily', payload: { medication_name: 'Pantoprazole' } }),
        ],
      });
      expect(result.dvt_prophylaxis).toBe(true);
      expect(result.peptic_ulcer_prophylaxis).toBe(true);
    });

    it('returns null for unspecified bundle components (evidence absent, not false)', () => {
      const result = evaluateVapBundle({
        notes: [],
        orders: [],
        vitals: [],
        medications: [],
      });
      expect(result.head_of_bed_elevated).toBeNull();
      expect(result.subglottic_suction).toBeNull();
      expect(result.peptic_ulcer_prophylaxis).toBeNull();
    });
  });

  describe('evaluateSedationAssessment', () => {
    it('parses RASS score and CAM-ICU positive from notes', () => {
      const result = evaluateSedationAssessment({
        notes: [event({ summary: 'Sedation assessment: RASS -4, CAM-ICU positive for delirium' })],
        vitals: [],
        medications: [],
      });
      expect(result.rass_score).toBe(-4);
      expect(result.delirium_screen_cam_icu).toBe(true);
      expect(result.delirium_positive).toBe(true);
    });

    it('captures RASS target and SAT completion separately', () => {
      const result = evaluateSedationAssessment({
        notes: [
          event({ summary: 'Target RASS -1, daily awakening (SAT done) this morning. RASS -1 on assessment.' }),
        ],
        vitals: [],
        medications: [],
      });
      expect(result.rass_target).toBe(-1);
      expect(result.rass_score).toBe(-1);
      expect(result.sedation_interruption_done).toBe(true);
    });
  });

  describe('evaluateSbtReadiness', () => {
    it('marks ready=true when FiO2 < 50, PEEP < 8, hemodynamics stable, SpO2 > 92', () => {
      const result = evaluateSbtReadiness({
        vitals: [event({ event_type: 'vitals', payload: { systolic_bp: 118, heart_rate: 82, spo2: 96 } })],
        notes: [event({ summary: 'Vent settings FiO2 40%, PEEP 5' })],
        orders: [],
      });
      expect(result.fio2_below_50).toBe(true);
      expect(result.peep_below_8).toBe(true);
      expect(result.hemodynamically_stable).toBe(true);
      expect(result.adequate_oxygenation).toBe(true);
      expect(result.ready).toBe(true);
    });

    it('marks ready=false when FiO2 >= 50 or PEEP >= 8', () => {
      const result = evaluateSbtReadiness({
        vitals: [event({ event_type: 'vitals', payload: { systolic_bp: 118, heart_rate: 82, spo2: 96 } })],
        notes: [event({ summary: 'Vent settings FiO2 60%, PEEP 10' })],
        orders: [],
      });
      expect(result.fio2_below_50).toBe(false);
      expect(result.peep_below_8).toBe(false);
      expect(result.ready).toBe(false);
    });

    it('marks ready=false when hemodynamics are unstable (SBP <= 90)', () => {
      const result = evaluateSbtReadiness({
        vitals: [event({ event_type: 'vitals', payload: { systolic_bp: 85, heart_rate: 110, spo2: 94 } })],
        notes: [event({ summary: 'FiO2 40%, PEEP 5' })],
        orders: [],
      });
      expect(result.hemodynamically_stable).toBe(false);
      expect(result.ready).toBe(false);
    });
  });

  describe('computeComplianceAndGaps', () => {
    it('returns low risk and 100% compliance for a non-ventilated patient', () => {
      const result = computeComplianceAndGaps({
        vapBundle: {},
        sedationAssessment: {},
        sbtReadiness: {},
        ventilatorStatus: 'not_ventilated',
      });
      expect(result.risk_band).toBe('low');
      expect(result.compliance_score).toBe(100);
      expect(result.bundle_gaps).toEqual([]);
    });

    it('returns low band when ventilated with all bundle items met', () => {
      const result = computeComplianceAndGaps({
        vapBundle: {
          head_of_bed_elevated: true,
          oral_care_performed: true,
          sedation_interruption: true,
          dvt_prophylaxis: true,
          peptic_ulcer_prophylaxis: true,
          subglottic_suction: true,
        },
        sedationAssessment: {
          sedation_interruption_done: true,
          delirium_screen_cam_icu: true,
          delirium_positive: false,
        },
        sbtReadiness: {
          fio2_below_50: true,
          peep_below_8: true,
          hemodynamically_stable: true,
          adequate_oxygenation: true,
        },
        ventilatorStatus: 'ventilated',
      });
      expect(result.risk_band).toBe('low');
      expect(result.compliance_score).toBe(100);
      expect(result.bundle_gaps).toEqual([]);
    });

    it('escalates to high/critical band when half the bundle items fail', () => {
      const result = computeComplianceAndGaps({
        vapBundle: {
          head_of_bed_elevated: false,
          oral_care_performed: false,
          sedation_interruption: false,
          dvt_prophylaxis: false,
          peptic_ulcer_prophylaxis: true,
          subglottic_suction: true,
        },
        sedationAssessment: {
          sedation_interruption_done: false,
          delirium_screen_cam_icu: false,
          delirium_positive: true,
        },
        sbtReadiness: {
          fio2_below_50: false,
          peep_below_8: false,
          hemodynamically_stable: true,
          adequate_oxygenation: true,
        },
        ventilatorStatus: 'ventilated',
      });
      expect(['high', 'critical']).toContain(result.risk_band);
      expect(result.compliance_score).toBeLessThan(50);
      expect(result.bundle_gaps.length).toBeGreaterThanOrEqual(6);
      expect(result.recommendations.length).toEqual(result.bundle_gaps.length);
    });

    it('returns moderate band when compliance lands between 70 and 84', () => {
      // 10 true / 13 total = 77% → moderate (70-84 band).
      const result = computeComplianceAndGaps({
        vapBundle: {
          head_of_bed_elevated: true,
          oral_care_performed: true,
          sedation_interruption: true,
          dvt_prophylaxis: true,
          peptic_ulcer_prophylaxis: false,
          subglottic_suction: false,
        },
        sedationAssessment: {
          sedation_interruption_done: true,
          delirium_screen_cam_icu: true,
          delirium_positive: false,
        },
        sbtReadiness: {
          fio2_below_50: false,
          peep_below_8: true,
          hemodynamically_stable: true,
          adequate_oxygenation: true,
        },
        ventilatorStatus: 'ventilated',
      });
      expect(result.compliance_score).toBeGreaterThanOrEqual(70);
      expect(result.compliance_score).toBeLessThan(85);
      expect(result.risk_band).toBe('moderate');
    });

    it('excludes null-valued components from the denominator', () => {
      const result = computeComplianceAndGaps({
        vapBundle: {
          head_of_bed_elevated: true,
          oral_care_performed: true,
          sedation_interruption: null,
          dvt_prophylaxis: null,
          peptic_ulcer_prophylaxis: null,
          subglottic_suction: null,
        },
        sedationAssessment: {
          sedation_interruption_done: true,
          delirium_screen_cam_icu: null,
          delirium_positive: null,
        },
        sbtReadiness: {
          fio2_below_50: null,
          peep_below_8: null,
          hemodynamically_stable: null,
          adequate_oxygenation: null,
        },
        ventilatorStatus: 'ventilated',
      });
      // 3 known components, all true → 100%.
      expect(result.compliance_score).toBe(100);
      expect(result.risk_band).toBe('low');
    });
  });
});
