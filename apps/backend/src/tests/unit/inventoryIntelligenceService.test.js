import {
  computeDaysOnHand,
  computeDaysToExpiry,
  computeConsumptionDeviationPct,
  classifyStockBand,
  classifyDaysOnHandBand,
  classifyExpiryBand,
  classifyConsumptionAnomaly,
  classifyInventoryAlert,
  escalateSeverity,
  escalateCategory,
  buildInventoryActions,
} from '../../services/ai/inventoryIntelligenceService.js';

describe('inventory intelligence helpers', () => {
  describe('computeDaysOnHand', () => {
    it('divides stock by usage and rounds to 2 decimals', () => {
      expect(computeDaysOnHand({ currentStock: 100, avgDailyUsage: 10 })).toBe(10);
    });

    it('returns null when avgDailyUsage is zero (effectively infinite)', () => {
      expect(computeDaysOnHand({ currentStock: 50, avgDailyUsage: 0 })).toBeNull();
    });
  });

  describe('computeDaysToExpiry', () => {
    it('returns positive whole days for a future expiry', () => {
      expect(
        computeDaysToExpiry({ nextExpiryDate: '2026-01-15', today: '2026-01-01' })
      ).toBe(14);
    });

    it('returns null when no expiry date is supplied', () => {
      expect(computeDaysToExpiry({ nextExpiryDate: null, today: '2026-01-01' })).toBeNull();
    });
  });

  describe('computeConsumptionDeviationPct', () => {
    it('returns positive % when usage exceeds baseline', () => {
      expect(computeConsumptionDeviationPct({ avgDailyUsage: 150, baselineDailyUsage: 100 })).toBe(50);
    });

    it('returns 0 when baseline is zero (cannot compute % of zero)', () => {
      expect(computeConsumptionDeviationPct({ avgDailyUsage: 150, baselineDailyUsage: 0 })).toBe(0);
    });
  });

  describe('classifyStockBand', () => {
    it('returns out when stock is zero', () => {
      expect(classifyStockBand({ currentStock: 0, reorderPoint: 10 })).toBe('out');
    });

    it('returns below_reorder when stock below reorder point', () => {
      expect(classifyStockBand({ currentStock: 5, reorderPoint: 10 })).toBe('below_reorder');
    });

    it('returns over_max when stock > maxStock * 1.2', () => {
      expect(classifyStockBand({ currentStock: 100, reorderPoint: 10, maxStock: 50 })).toBe('over_max');
    });

    it('returns ok when within bands', () => {
      expect(classifyStockBand({ currentStock: 30, reorderPoint: 10, maxStock: 50 })).toBe('ok');
    });
  });

  describe('classifyDaysOnHandBand', () => {
    it('classifies < 2 as critical', () => {
      expect(classifyDaysOnHandBand(1)).toBe('critical');
    });

    it('classifies 2..<5 as warning', () => {
      expect(classifyDaysOnHandBand(4)).toBe('warning');
    });

    it('classifies 5..<14 as watch', () => {
      expect(classifyDaysOnHandBand(10)).toBe('watch');
    });

    it('classifies 14..60 as ok', () => {
      expect(classifyDaysOnHandBand(30)).toBe('ok');
    });

    it('classifies > 60 as excess', () => {
      expect(classifyDaysOnHandBand(90)).toBe('excess');
    });

    it('returns unknown when null', () => {
      expect(classifyDaysOnHandBand(null)).toBe('unknown');
    });
  });

  describe('classifyExpiryBand', () => {
    it('classifies negative days as expired', () => {
      expect(classifyExpiryBand(-1)).toBe('expired');
    });

    it('classifies 0..14 as imminent', () => {
      expect(classifyExpiryBand(7)).toBe('imminent');
    });

    it('classifies 15..30 as warning', () => {
      expect(classifyExpiryBand(25)).toBe('warning');
    });

    it('classifies 31..90 as watch', () => {
      expect(classifyExpiryBand(60)).toBe('watch');
    });

    it('classifies > 90 as ok', () => {
      expect(classifyExpiryBand(200)).toBe('ok');
    });

    it('returns unknown when null', () => {
      expect(classifyExpiryBand(null)).toBe('unknown');
    });
  });

  describe('classifyConsumptionAnomaly', () => {
    it('returns normal for small deviations', () => {
      expect(classifyConsumptionAnomaly(5)).toBe('normal');
    });

    it('returns elevated for 20..<40', () => {
      expect(classifyConsumptionAnomaly(25)).toBe('elevated');
    });

    it('returns surge for >= 40', () => {
      expect(classifyConsumptionAnomaly(60)).toBe('surge');
    });

    it('returns drop for <= -40', () => {
      expect(classifyConsumptionAnomaly(-60)).toBe('drop');
    });
  });

  describe('classifyInventoryAlert', () => {
    it('classifies zero stock as stockout_risk / critical', () => {
      const result = classifyInventoryAlert({
        currentStock: 0,
        reorderPoint: 10,
        maxStock: 100,
        daysOnHand: null,
        daysToExpiry: 365,
        deviationPct: 0,
      });
      expect(result.alert_category).toBe('stockout_risk');
      expect(result.severity).toBe('critical');
    });

    it('classifies a healthy item as healthy / low', () => {
      // Stock 100, reorder 50, maxStock 200 (so stock <= 240 = not over_max),
      // usage == baseline = 10 (no anomaly), DOH = 10 (watch band, but not
      // warning so no reorder_point_breach); expiry 365 days (ok).
      // Note: DOH=10 is in 'watch' band — but 'watch' does not trigger an
      // alert, so the item is healthy.
      const result = classifyInventoryAlert({
        currentStock: 100,
        reorderPoint: 50,
        maxStock: 200,
        daysOnHand: 10,
        daysToExpiry: 365,
        deviationPct: 0,
      });
      expect(result.alert_category).toBe('healthy');
      expect(result.severity).toBe('low');
    });

    it('classifies excess DOH with usable stock as overstock / moderate', () => {
      // Stock 60, reorder 50, maxStock 200 (not over_max), usage 0.5 → DOH 120 (excess).
      const result = classifyInventoryAlert({
        currentStock: 60,
        reorderPoint: 50,
        maxStock: 200,
        daysOnHand: 120,
        daysToExpiry: 365,
        deviationPct: 0,
      });
      expect(result.alert_category).toBe('overstock');
      expect(result.severity).toBe('moderate');
    });

    it('classifies imminent expiry (3 days) as expiry_risk / high', () => {
      const result = classifyInventoryAlert({
        currentStock: 100,
        reorderPoint: 50,
        maxStock: 200,
        daysOnHand: 10,
        daysToExpiry: 3,
        deviationPct: 0,
      });
      expect(result.alert_category).toBe('expiry_risk');
      expect(result.severity).toBe('high');
    });
  });

  describe('escalateSeverity', () => {
    it('returns the highest severity in the list', () => {
      expect(escalateSeverity(['low', 'critical', 'moderate'])).toBe('critical');
    });
  });

  describe('escalateCategory', () => {
    it('returns the highest-priority category in the list', () => {
      expect(escalateCategory(['healthy', 'stockout_risk', 'expiry_risk'])).toBe('stockout_risk');
    });
  });

  describe('buildInventoryActions', () => {
    it('stockout_risk includes disclaimer and reorder action with item name embedded', () => {
      const actions = buildInventoryActions({
        alertCategory: 'stockout_risk',
        signals: [{ code: 'STOCKOUT_ZERO' }],
        itemName: 'N95 Respirator',
      });
      const joined = actions.join('\n');
      expect(joined).toMatch(/N95 Respirator/);
      expect(joined).toMatch(/reorder/i);
      expect(actions[actions.length - 1]).toMatch(/Materials manager review required/);
      expect(actions[actions.length - 1]).toMatch(/decision support only/i);
    });
  });
});
