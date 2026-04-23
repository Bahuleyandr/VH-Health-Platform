import {
  computePriceDeltaPct,
  computeAlternativeSavingsPct,
  computeAnnualSavings,
  computeDaysToContractEnd,
  classifyPriceBand,
  classifyVendorFragmentation,
  classifyTenureBand,
  classifyExpiryBand,
  classifyAlternativeBand,
  classifyProcurementOpportunity,
  escalateSeverity,
  escalateCategory,
  buildProcurementActions,
  summarizeProcurement,
} from '../../services/ai/procurementNegotiationService.js';

describe('procurement negotiation helpers', () => {
  describe('computePriceDeltaPct', () => {
    it('returns signed pct when baseline is positive', () => {
      expect(computePriceDeltaPct({ currentUnitPrice: 110, historicalAvgPrice: 100 })).toBe(10.00);
    });

    it('returns 0 when baseline is zero', () => {
      expect(computePriceDeltaPct({ currentUnitPrice: 110, historicalAvgPrice: 0 })).toBe(0);
    });
  });

  describe('computeAlternativeSavingsPct', () => {
    it('returns savings pct when alternative is cheaper', () => {
      expect(computeAlternativeSavingsPct({ currentUnitPrice: 100, quotedAlternativePrice: 80 })).toBe(20.00);
    });

    it('returns 0 when no alternative is quoted', () => {
      expect(computeAlternativeSavingsPct({ currentUnitPrice: 100, quotedAlternativePrice: null })).toBe(0);
    });
  });

  describe('computeAnnualSavings', () => {
    it('multiplies savings per unit by annual volume', () => {
      expect(
        computeAnnualSavings({ currentUnitPrice: 100, quotedAlternativePrice: 80, annualVolume: 500 })
      ).toBe(10000.00);
    });

    it('returns 0 when no alternative is quoted', () => {
      expect(
        computeAnnualSavings({ currentUnitPrice: 100, quotedAlternativePrice: null, annualVolume: 500 })
      ).toBe(0);
    });
  });

  describe('computeDaysToContractEnd', () => {
    it('returns whole UTC days to a future contract end', () => {
      expect(
        computeDaysToContractEnd({ contractEndDate: '2026-04-01', today: '2026-01-01' })
      ).toBe(90);
    });

    it('returns null when no contract end date is supplied', () => {
      expect(
        computeDaysToContractEnd({ contractEndDate: null, today: '2026-01-01' })
      ).toBeNull();
    });
  });

  describe('classifyPriceBand', () => {
    it('classifies sub-discount deltas as discount', () => {
      expect(classifyPriceBand(-10)).toBe('discount');
    });

    it('classifies near-zero deltas as match', () => {
      expect(classifyPriceBand(3)).toBe('match');
    });

    it('classifies 5-15% deltas as above', () => {
      expect(classifyPriceBand(10)).toBe('above');
    });

    it('classifies 15-30% deltas as anomaly', () => {
      expect(classifyPriceBand(20)).toBe('anomaly');
    });

    it('classifies >= 30% deltas as severe_anomaly', () => {
      expect(classifyPriceBand(35)).toBe('severe_anomaly');
    });
  });

  describe('classifyVendorFragmentation', () => {
    it('classifies 1 vendor as single', () => {
      expect(classifyVendorFragmentation({ vendorCountForCategory: 1 })).toBe('single');
    });

    it('classifies 2-3 vendors as dual', () => {
      expect(classifyVendorFragmentation({ vendorCountForCategory: 3 })).toBe('dual');
    });

    it('classifies 4-6 vendors as fragmented', () => {
      expect(classifyVendorFragmentation({ vendorCountForCategory: 5 })).toBe('fragmented');
    });

    it('classifies >= 7 vendors as excessive', () => {
      expect(classifyVendorFragmentation({ vendorCountForCategory: 8 })).toBe('excessive');
    });
  });

  describe('classifyTenureBand', () => {
    it('returns unknown when tenure is null', () => {
      expect(classifyTenureBand(null)).toBe('unknown');
    });

    it('classifies < 12 months as new', () => {
      expect(classifyTenureBand(6)).toBe('new');
    });

    it('classifies 12-35 months as mature', () => {
      expect(classifyTenureBand(24)).toBe('mature');
    });

    it('classifies 36-59 months as long', () => {
      expect(classifyTenureBand(48)).toBe('long');
    });

    it('classifies >= 60 months as legacy', () => {
      expect(classifyTenureBand(72)).toBe('legacy');
    });
  });

  describe('classifyExpiryBand', () => {
    it('returns unknown when days is null', () => {
      expect(classifyExpiryBand(null)).toBe('unknown');
    });

    it('classifies negative days as expired', () => {
      expect(classifyExpiryBand(-3)).toBe('expired');
    });

    it('classifies <= 30 days as imminent', () => {
      expect(classifyExpiryBand(20)).toBe('imminent');
    });

    it('classifies 31-90 days as warning', () => {
      expect(classifyExpiryBand(60)).toBe('warning');
    });

    it('classifies 91-180 days as watch', () => {
      expect(classifyExpiryBand(150)).toBe('watch');
    });

    it('classifies > 180 days as ok', () => {
      expect(classifyExpiryBand(300)).toBe('ok');
    });
  });

  describe('classifyAlternativeBand', () => {
    it('classifies < 5% savings as none', () => {
      expect(classifyAlternativeBand(3)).toBe('none');
    });

    it('classifies 5-15% savings as modest', () => {
      expect(classifyAlternativeBand(10)).toBe('modest');
    });

    it('classifies 15-25% savings as meaningful', () => {
      expect(classifyAlternativeBand(20)).toBe('meaningful');
    });

    it('classifies >= 25% savings as strong', () => {
      expect(classifyAlternativeBand(30)).toBe('strong');
    });
  });

  describe('classifyProcurementOpportunity', () => {
    it('flags price_anomaly with high severity for 40% price delta', () => {
      const result = classifyProcurementOpportunity({
        currentUnitPrice: 140,
        historicalAvgPrice: 100,
        quotedAlternativePrice: null,
        annualVolume: 10,
        vendorCountForCategory: 1,
        contractTenureMonths: 12,
        contractEndDate: null,
      });
      expect(result.opportunity_category).toBe('price_anomaly');
      expect(result.severity).toBe('high');
    });

    it('flags expiring_contract with high severity for imminent expiry', () => {
      const result = classifyProcurementOpportunity({
        currentUnitPrice: 100,
        historicalAvgPrice: 100,
        quotedAlternativePrice: null,
        annualVolume: 10,
        vendorCountForCategory: 1,
        contractTenureMonths: 12,
        contractEndDate: '2026-01-10',
        today: '2026-01-01',
      });
      expect(result.opportunity_category).toBe('expiring_contract');
      expect(result.severity).toBe('high');
    });

    it('returns no_action with low severity for a healthy deal', () => {
      const result = classifyProcurementOpportunity({
        currentUnitPrice: 100,
        historicalAvgPrice: 100,
        quotedAlternativePrice: null,
        annualVolume: 10,
        vendorCountForCategory: 3,
        contractTenureMonths: 24,
        contractEndDate: null,
      });
      expect(result.opportunity_category).toBe('no_action');
      expect(result.severity).toBe('low');
    });
  });

  describe('escalateSeverity', () => {
    it('returns the highest severity in the list', () => {
      expect(escalateSeverity(['low', 'critical', 'moderate'])).toBe('critical');
    });
  });

  describe('escalateCategory', () => {
    it('returns the highest-priority category in the list', () => {
      expect(escalateCategory(['no_action', 'price_anomaly', 'expiring_contract'])).toBe('expiring_contract');
    });
  });

  describe('buildProcurementActions', () => {
    it('mentions the item or vendor and ends with the review disclaimer', () => {
      const actions = buildProcurementActions({
        opportunityCategory: 'price_anomaly',
        signals: [],
        itemName: 'Gauze rolls',
        vendorName: 'Acme',
      });
      expect(Array.isArray(actions)).toBe(true);
      const hasDisclaimer = actions.some((line) =>
        /procurement lead review required/i.test(line)
        && /never contacts vendors, places orders, or modifies contracts/i.test(line));
      expect(hasDisclaimer).toBe(true);
      const mentionsTarget = actions.some((line) => /Gauze rolls|Acme/.test(line));
      expect(mentionsTarget).toBe(true);
    });
  });

  describe('summarizeProcurement', () => {
    it('includes the item name and opportunity category in the summary', () => {
      const summary = summarizeProcurement({
        itemName: 'Gauze',
        vendorName: 'Acme',
        opportunityCategory: 'price_anomaly',
        severity: 'high',
        priceDeltaPct: 40,
        annualSavings: 1200,
      });
      expect(typeof summary).toBe('string');
      expect(summary).toContain('Gauze');
      expect(summary).toContain('price_anomaly');
    });
  });
});
