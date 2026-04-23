import {
  BLOOD_GROUPS,
  COMPONENTS,
  aggregateDemandForecast,
  assessMtpReadiness,
  classifyStockoutRisk,
  estimatePerProcedureDemand,
  rollUpForecastRiskBand,
} from '../../services/ai/bloodBankForecastService.js';

describe('blood bank forecast helpers', () => {
  describe('constants', () => {
    it('exports the canonical 8 blood groups', () => {
      expect(BLOOD_GROUPS).toEqual(
        expect.arrayContaining(['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'])
      );
      expect(BLOOD_GROUPS.length).toBe(8);
    });

    it('exports the canonical 5 components', () => {
      expect(COMPONENTS).toEqual(
        expect.arrayContaining([
          'packed_red_cells',
          'whole_blood',
          'platelets',
          'ffp',
          'cryoprecipitate',
        ])
      );
      expect(COMPONENTS.length).toBe(5);
    });
  });

  describe('estimatePerProcedureDemand', () => {
    it('returns PRBC + FFP + platelets for cardiac surgery', () => {
      const demand = estimatePerProcedureDemand('Elective CABG — coronary artery bypass graft');
      const components = demand.map((d) => d.component);
      expect(components).toContain('packed_red_cells');
      expect(components).toContain('ffp');
      expect(components).toContain('platelets');
      const prbc = demand.find((d) => d.component === 'packed_red_cells');
      expect(prbc.units).toBeGreaterThanOrEqual(3);
    });

    it('returns PRBC + FFP for obstetric postpartum hemorrhage (PPH)', () => {
      const demand = estimatePerProcedureDemand('Postpartum hemorrhage following delivery');
      const components = demand.map((d) => d.component);
      expect(components).toContain('packed_red_cells');
      expect(components).toContain('ffp');
      // PPH should NOT typically trigger platelets in this heuristic
      expect(components).not.toContain('platelets');
    });

    it('returns a heavy product mix for major trauma', () => {
      const demand = estimatePerProcedureDemand('Major trauma — polytrauma with multiple injuries');
      const prbc = demand.find((d) => d.component === 'packed_red_cells');
      expect(prbc).toBeDefined();
      expect(prbc.units).toBeGreaterThanOrEqual(4);
    });

    it('returns empty array for unknown / non-surgical descriptions', () => {
      expect(estimatePerProcedureDemand('Patient visit for routine checkup')).toEqual([]);
      expect(estimatePerProcedureDemand('')).toEqual([]);
      expect(estimatePerProcedureDemand(null)).toEqual([]);
      expect(estimatePerProcedureDemand(undefined)).toEqual([]);
    });

    it('returns 1 PRBC for a default elective surgery', () => {
      const demand = estimatePerProcedureDemand('Elective surgery');
      expect(demand.length).toBeGreaterThanOrEqual(1);
      expect(demand[0].component).toBe('packed_red_cells');
      expect(demand[0].units).toBeGreaterThanOrEqual(1);
    });
  });

  describe('aggregateDemandForecast', () => {
    it('aggregates units across multiple procedures of the same blood group', () => {
      const procedures = [
        { procedure_description: 'Elective CABG', blood_group: 'A+' },
        { procedure_description: 'Elective CABG', blood_group: 'A+' },
      ];
      const result = aggregateDemandForecast(procedures);
      const prbc = result.find(
        (r) => r.blood_group === 'A+' && r.component === 'packed_red_cells'
      );
      expect(prbc).toBeDefined();
      // Two cardiac cases at 3 PRBC each → 6 units.
      expect(prbc.predicted_units).toBe(6);
      expect(prbc.drivers.length).toBe(2);
    });

    it('defaults to O+ and annotates driver when blood group is missing', () => {
      const procedures = [
        { procedure_description: 'Major abdominal surgery' }, // no blood_group
      ];
      const result = aggregateDemandForecast(procedures);
      const defaulted = result.find((r) => r.blood_group === 'O+');
      expect(defaulted).toBeDefined();
      expect(defaulted.drivers[0].notes).toContain('default_group');
    });

    it('groups multiple blood groups + components correctly', () => {
      const procedures = [
        { procedure_description: 'Elective CABG', blood_group: 'A+' },
        { procedure_description: 'Postpartum hemorrhage', blood_group: 'O-' },
      ];
      const result = aggregateDemandForecast(procedures);
      expect(result.some((r) => r.blood_group === 'A+' && r.component === 'packed_red_cells')).toBe(true);
      expect(result.some((r) => r.blood_group === 'O-' && r.component === 'ffp')).toBe(true);
    });

    it('skips procedures with no matching keyword demand', () => {
      const procedures = [{ procedure_description: 'Patient consultation', blood_group: 'A+' }];
      expect(aggregateDemandForecast(procedures)).toEqual([]);
    });

    it('handles empty / null inputs', () => {
      expect(aggregateDemandForecast([])).toEqual([]);
      expect(aggregateDemandForecast(null)).toEqual([]);
      expect(aggregateDemandForecast(undefined)).toEqual([]);
    });
  });

  describe('classifyStockoutRisk', () => {
    it('flags critical when shortfall would go negative', () => {
      const inventory = [
        {
          blood_group: 'O-',
          component: 'packed_red_cells',
          units_available: 2,
          units_committed: 0,
          minimum_stock_level: 3,
        },
      ];
      const predictedDemand = [
        { blood_group: 'O-', component: 'packed_red_cells', predicted_units: 5 },
      ];
      const risks = classifyStockoutRisk({ inventory, predictedDemand });
      const row = risks.find((r) => r.blood_group === 'O-' && r.component === 'packed_red_cells');
      expect(row.projected_shortfall).toBe(-3);
      expect(row.risk_band).toBe('critical');
    });

    it('flags high when projected is below minimum stock level', () => {
      const inventory = [
        {
          blood_group: 'A+',
          component: 'packed_red_cells',
          units_available: 5,
          units_committed: 0,
          minimum_stock_level: 5,
        },
      ];
      const predictedDemand = [
        { blood_group: 'A+', component: 'packed_red_cells', predicted_units: 3 },
      ];
      const risks = classifyStockoutRisk({ inventory, predictedDemand });
      const row = risks.find((r) => r.blood_group === 'A+' && r.component === 'packed_red_cells');
      // projected = 5 - 0 - 3 = 2; minimum = 5 → 2 < 5 → high
      expect(row.projected_shortfall).toBe(2);
      expect(row.risk_band).toBe('high');
    });

    it('flags moderate when projected is between minimum and 1.5x minimum', () => {
      const inventory = [
        {
          blood_group: 'B+',
          component: 'packed_red_cells',
          units_available: 12,
          units_committed: 0,
          minimum_stock_level: 10,
        },
      ];
      const predictedDemand = [
        { blood_group: 'B+', component: 'packed_red_cells', predicted_units: 1 },
      ];
      // projected = 12 - 0 - 1 = 11; 11 >= 10 (minimum), 11 < 15 (1.5 * 10) → moderate
      const risks = classifyStockoutRisk({ inventory, predictedDemand });
      const row = risks.find((r) => r.blood_group === 'B+' && r.component === 'packed_red_cells');
      expect(row.risk_band).toBe('moderate');
    });

    it('flags low when projected is well above 1.5x minimum', () => {
      const inventory = [
        {
          blood_group: 'O+',
          component: 'packed_red_cells',
          units_available: 50,
          units_committed: 0,
          minimum_stock_level: 10,
        },
      ];
      const predictedDemand = [
        { blood_group: 'O+', component: 'packed_red_cells', predicted_units: 5 },
      ];
      const risks = classifyStockoutRisk({ inventory, predictedDemand });
      const row = risks.find((r) => r.blood_group === 'O+' && r.component === 'packed_red_cells');
      expect(row.risk_band).toBe('low');
    });

    it('includes pairs appearing only in inventory (no demand)', () => {
      const inventory = [
        {
          blood_group: 'AB+',
          component: 'ffp',
          units_available: 2,
          units_committed: 0,
          minimum_stock_level: 5,
        },
      ];
      const risks = classifyStockoutRisk({ inventory, predictedDemand: [] });
      expect(risks.some((r) => r.blood_group === 'AB+' && r.component === 'ffp')).toBe(true);
    });

    it('includes pairs appearing only in demand (no inventory)', () => {
      const predictedDemand = [
        { blood_group: 'A-', component: 'platelets', predicted_units: 2 },
      ];
      const risks = classifyStockoutRisk({ inventory: [], predictedDemand });
      const row = risks.find((r) => r.blood_group === 'A-' && r.component === 'platelets');
      expect(row).toBeDefined();
      // No inventory → projected = 0 - 0 - 2 = -2 → critical
      expect(row.risk_band).toBe('critical');
    });
  });

  describe('assessMtpReadiness', () => {
    it('returns ready=true when all three criteria met', () => {
      const inventory = [
        {
          blood_group: 'O-',
          component: 'packed_red_cells',
          units_available: 8,
          units_committed: 0,
        },
        { blood_group: 'AB+', component: 'ffp', units_available: 4, units_committed: 0 },
        {
          blood_group: 'O+',
          component: 'platelets',
          units_available: 2,
          units_committed: 0,
        },
      ];
      const mtp = assessMtpReadiness(inventory);
      expect(mtp.ready).toBe(true);
      expect(mtp.prbc_ok).toBe(true);
      expect(mtp.ffp_ok).toBe(true);
      expect(mtp.platelets_ok).toBe(true);
    });

    it('returns ready=false when O- PRBC is below 6 units', () => {
      const inventory = [
        {
          blood_group: 'O-',
          component: 'packed_red_cells',
          units_available: 3,
          units_committed: 0,
        },
        { blood_group: 'AB+', component: 'ffp', units_available: 5, units_committed: 0 },
        {
          blood_group: 'O+',
          component: 'platelets',
          units_available: 2,
          units_committed: 0,
        },
      ];
      const mtp = assessMtpReadiness(inventory);
      expect(mtp.ready).toBe(false);
      expect(mtp.prbc_ok).toBe(false);
      expect(mtp.ffp_ok).toBe(true);
    });

    it('returns ready=false when AB FFP is below 4 units', () => {
      const inventory = [
        {
          blood_group: 'O-',
          component: 'packed_red_cells',
          units_available: 8,
          units_committed: 0,
        },
        { blood_group: 'AB-', component: 'ffp', units_available: 2, units_committed: 0 },
        {
          blood_group: 'O+',
          component: 'platelets',
          units_available: 2,
          units_committed: 0,
        },
      ];
      const mtp = assessMtpReadiness(inventory);
      expect(mtp.ready).toBe(false);
      expect(mtp.ffp_ok).toBe(false);
    });

    it('nets out committed units from available when computing readiness', () => {
      const inventory = [
        {
          blood_group: 'O-',
          component: 'packed_red_cells',
          units_available: 8,
          units_committed: 5, // effective = 3, below threshold
        },
        { blood_group: 'AB+', component: 'ffp', units_available: 5, units_committed: 0 },
        {
          blood_group: 'O+',
          component: 'platelets',
          units_available: 2,
          units_committed: 0,
        },
      ];
      const mtp = assessMtpReadiness(inventory);
      expect(mtp.prbc_ok).toBe(false);
      expect(mtp.ready).toBe(false);
    });
  });

  describe('rollUpForecastRiskBand', () => {
    it('returns unknown when both inputs are empty', () => {
      expect(rollUpForecastRiskBand([], {})).toBe('unknown');
      expect(rollUpForecastRiskBand(null, null)).toBe('unknown');
    });

    it('returns critical when any pair is critical', () => {
      const stockoutRisks = [
        { risk_band: 'critical' },
        { risk_band: 'low' },
      ];
      expect(rollUpForecastRiskBand(stockoutRisks, { ready: true })).toBe('critical');
    });

    it('returns critical when MTP not ready AND any high-band risk exists', () => {
      const stockoutRisks = [{ risk_band: 'high' }];
      const mtp = {
        ready: false,
        details: [{ label: 'O- PRBC', required: 6, available: 2, ok: false }],
      };
      expect(rollUpForecastRiskBand(stockoutRisks, mtp)).toBe('critical');
    });

    it('returns high when any high-band risk exists and MTP is ready', () => {
      expect(rollUpForecastRiskBand([{ risk_band: 'high' }], { ready: true })).toBe('high');
    });

    it('returns moderate when highest band is moderate', () => {
      expect(
        rollUpForecastRiskBand(
          [{ risk_band: 'moderate' }, { risk_band: 'low' }],
          { ready: true }
        )
      ).toBe('moderate');
    });

    it('returns low when all risks are low', () => {
      expect(
        rollUpForecastRiskBand([{ risk_band: 'low' }, { risk_band: 'low' }], { ready: true })
      ).toBe('low');
    });
  });
});
