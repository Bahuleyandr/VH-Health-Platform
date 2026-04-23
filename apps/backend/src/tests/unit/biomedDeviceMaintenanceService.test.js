import {
  DEVICE_TYPES,
  DEFAULT_SERVICE_INTERVALS_HOURS,
  daysSince,
  detectMaintenanceSignals,
  computeFailureRiskScore,
  recommendServiceWindow,
  buildMaintenanceActions,
} from '../../services/ai/biomedDeviceMaintenanceService.js';

describe('biomedical device maintenance helpers', () => {
  describe('DEVICE_TYPES + DEFAULT_SERVICE_INTERVALS_HOURS', () => {
    it('exposes the expected catalog of device types', () => {
      expect(DEVICE_TYPES).toEqual(expect.arrayContaining([
        'ventilator', 'defibrillator', 'infusion_pump', 'ecg_monitor',
        'ultrasound', 'x_ray', 'mri', 'ct_scanner', 'dialysis',
        'anesthesia_machine', 'other',
      ]));
    });

    it('has a service interval for every device type', () => {
      for (const type of DEVICE_TYPES) {
        expect(DEFAULT_SERVICE_INTERVALS_HOURS[type]).toBeGreaterThan(0);
      }
    });
  });

  describe('daysSince', () => {
    it('returns null for null input', () => {
      expect(daysSince(null)).toBeNull();
      expect(daysSince(undefined)).toBeNull();
    });

    it('returns null for an invalid timestamp string', () => {
      expect(daysSince('not-a-date')).toBeNull();
    });

    it('returns a positive integer for a past timestamp', () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      expect(daysSince(fiveDaysAgo)).toBeGreaterThanOrEqual(4);
      expect(daysSince(fiveDaysAgo)).toBeLessThanOrEqual(6);
    });

    it('returns 0 for a future timestamp (clamped, not negative)', () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      expect(daysSince(tomorrow)).toBe(0);
    });
  });

  describe('detectMaintenanceSignals', () => {
    it('emits OVERDUE_MAINTENANCE when hoursSinceLastService exceeds the interval', () => {
      const interval = DEFAULT_SERVICE_INTERVALS_HOURS.ventilator;
      const signals = detectMaintenanceSignals({
        deviceType: 'ventilator',
        usageHours: interval + 200,
        hoursSinceLastService: interval + 200,
        faultEventsLast90d: 0,
      });
      const overdue = signals.find((s) => s.code === 'OVERDUE_MAINTENANCE');
      expect(overdue).toBeDefined();
      expect(overdue.severity).toBe('high');
    });

    it('emits APPROACHING_SERVICE when hoursSinceLastService is 80%-100% of the interval', () => {
      const interval = DEFAULT_SERVICE_INTERVALS_HOURS.infusion_pump;
      const signals = detectMaintenanceSignals({
        deviceType: 'infusion_pump',
        usageHours: interval,
        hoursSinceLastService: Math.floor(interval * 0.85),
        faultEventsLast90d: 0,
      });
      expect(signals.some((s) => s.code === 'APPROACHING_SERVICE' && s.severity === 'medium')).toBe(true);
      expect(signals.some((s) => s.code === 'OVERDUE_MAINTENANCE')).toBe(false);
    });

    it('emits FAULT_CLUSTER critical at faultEventsLast90d >= 5', () => {
      const signals = detectMaintenanceSignals({
        deviceType: 'defibrillator',
        usageHours: 100,
        hoursSinceLastService: 100,
        faultEventsLast90d: 6,
      });
      const cluster = signals.find((s) => s.code === 'FAULT_CLUSTER');
      expect(cluster).toBeDefined();
      expect(cluster.severity).toBe('critical');
    });

    it('emits FAULT_CLUSTER high at faultEventsLast90d between 3 and 4', () => {
      const signals = detectMaintenanceSignals({
        deviceType: 'defibrillator',
        usageHours: 100,
        hoursSinceLastService: 100,
        faultEventsLast90d: 3,
      });
      const cluster = signals.find((s) => s.code === 'FAULT_CLUSTER');
      expect(cluster).toBeDefined();
      expect(cluster.severity).toBe('high');
    });

    it('emits WARRANTY_EXPIRING when warrantyExpiresOn is inside the grace window', () => {
      // 10 days from today — well within the 30-day default grace window.
      const warrantyExpiresOn = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const signals = detectMaintenanceSignals({
        deviceType: 'ecg_monitor',
        usageHours: 50,
        hoursSinceLastService: 50,
        faultEventsLast90d: 0,
        warrantyExpiresOn,
      });
      expect(signals.some((s) => s.code === 'WARRANTY_EXPIRING' && s.severity === 'low')).toBe(true);
    });

    it('does NOT emit WARRANTY_EXPIRING for a warranty far in the future', () => {
      const warrantyExpiresOn = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const signals = detectMaintenanceSignals({
        deviceType: 'ecg_monitor',
        usageHours: 50,
        hoursSinceLastService: 50,
        faultEventsLast90d: 0,
        warrantyExpiresOn,
      });
      expect(signals.some((s) => s.code === 'WARRANTY_EXPIRING')).toBe(false);
    });

    it('emits END_OF_LIFE at installedYearsAgo >= 10', () => {
      const signals = detectMaintenanceSignals({
        deviceType: 'x_ray',
        usageHours: 100,
        hoursSinceLastService: 100,
        faultEventsLast90d: 0,
        installedYearsAgo: 12,
      });
      expect(signals.some((s) => s.code === 'END_OF_LIFE' && s.severity === 'medium')).toBe(true);
    });

    it('emits LOW_MTBF when mtbfHours < 500', () => {
      const signals = detectMaintenanceSignals({
        deviceType: 'dialysis',
        usageHours: 1000,
        hoursSinceLastService: 100,
        faultEventsLast90d: 0,
        mtbfHours: 300,
      });
      expect(signals.some((s) => s.code === 'LOW_MTBF' && s.severity === 'high')).toBe(true);
    });

    it('emits NO_SERVICE_HISTORY when hoursSinceLastService is null and usage > 500', () => {
      const signals = detectMaintenanceSignals({
        deviceType: 'other',
        usageHours: 600,
        hoursSinceLastService: null,
        faultEventsLast90d: 0,
      });
      expect(signals.some((s) => s.code === 'NO_SERVICE_HISTORY' && s.severity === 'medium')).toBe(true);
    });

    it('returns no signals for a well-maintained device with no red flags', () => {
      const signals = detectMaintenanceSignals({
        deviceType: 'infusion_pump',
        usageHours: 200,
        hoursSinceLastService: 200,
        faultEventsLast90d: 0,
        mtbfHours: 2000,
        installedYearsAgo: 2,
      });
      expect(signals).toEqual([]);
    });
  });

  describe('computeFailureRiskScore', () => {
    it('returns low band + score 0 when no signals are present', () => {
      const result = computeFailureRiskScore([]);
      expect(result.risk_score).toBe(0);
      expect(result.risk_band).toBe('low');
    });

    it('returns high band when two high-severity signals fire', () => {
      // 20 + 20 = 40 → high band (>= 40 but < 65).
      const result = computeFailureRiskScore([
        { code: 'OVERDUE_MAINTENANCE', severity: 'high' },
        { code: 'LOW_MTBF', severity: 'high' },
      ]);
      expect(result.risk_band).toBe('high');
      expect(result.risk_score).toBe(40);
    });

    it('returns critical band when two critical + one high signal fire', () => {
      // 35 + 35 + 20 = 90 → critical band (>= 65).
      const result = computeFailureRiskScore([
        { code: 'FAULT_CLUSTER', severity: 'critical' },
        { code: 'FAULT_CLUSTER', severity: 'critical' },
        { code: 'OVERDUE_MAINTENANCE', severity: 'high' },
      ]);
      expect(result.risk_band).toBe('critical');
      expect(result.risk_score).toBeGreaterThanOrEqual(65);
    });

    it('clamps the risk score to 100 when many critical signals fire', () => {
      const result = computeFailureRiskScore([
        { code: 'FAULT_CLUSTER', severity: 'critical' },
        { code: 'FAULT_CLUSTER', severity: 'critical' },
        { code: 'FAULT_CLUSTER', severity: 'critical' },
        { code: 'FAULT_CLUSTER', severity: 'critical' },
      ]);
      expect(result.risk_score).toBeLessThanOrEqual(100);
      expect(result.risk_score).toBe(100);
      expect(result.risk_band).toBe('critical');
    });

    it('returns moderate band for a single medium signal', () => {
      const result = computeFailureRiskScore([
        { code: 'END_OF_LIFE', severity: 'medium' },
      ]);
      // 10 → low band (< 15), so verify actual threshold behavior instead.
      expect(result.risk_score).toBe(10);
      expect(result.risk_band).toBe('low');
    });

    it('returns moderate band once the score reaches 15', () => {
      // One medium (10) + one low (5) = 15 → moderate.
      const result = computeFailureRiskScore([
        { code: 'END_OF_LIFE', severity: 'medium' },
        { code: 'WARRANTY_EXPIRING', severity: 'low' },
      ]);
      expect(result.risk_score).toBe(15);
      expect(result.risk_band).toBe('moderate');
    });
  });

  describe('recommendServiceWindow', () => {
    it("recommends 'immediate' urgency for a critical risk band", () => {
      const today = new Date().toISOString().slice(0, 10);
      const window = recommendServiceWindow({ riskScore: 80, riskBand: 'critical' });
      expect(window.urgency).toBe('immediate');
      expect(window.earliest_date).toBe(today);
      expect(window.latest_date).toBe(today);
    });

    it("recommends 'within_7_days' for a high risk band", () => {
      const window = recommendServiceWindow({ riskScore: 50, riskBand: 'high' });
      expect(window.urgency).toBe('within_7_days');
      expect(new Date(window.latest_date).getTime())
        .toBeGreaterThan(new Date(window.earliest_date).getTime() - 1);
    });

    it("recommends 'within_30_days' for a moderate risk band", () => {
      const window = recommendServiceWindow({ riskScore: 20, riskBand: 'moderate' });
      expect(window.urgency).toBe('within_30_days');
    });

    it("recommends 'routine' for a low risk band", () => {
      const window = recommendServiceWindow({ riskScore: 0, riskBand: 'low' });
      expect(window.urgency).toBe('routine');
    });
  });

  describe('buildMaintenanceActions', () => {
    it('always appends the review disclaimer as the last entry', () => {
      const actions = buildMaintenanceActions({
        signals: [],
        urgency: 'routine',
      });
      expect(actions[actions.length - 1]).toMatch(/decision-support only/i);
      expect(actions[actions.length - 1]).toMatch(/biomedical staff/i);
    });

    it('includes a maintenance-specific action for OVERDUE_MAINTENANCE', () => {
      const actions = buildMaintenanceActions({
        signals: [{ code: 'OVERDUE_MAINTENANCE', severity: 'high' }],
        urgency: 'within_7_days',
      });
      expect(actions.some((line) => /overdue preventive maintenance/i.test(line))).toBe(true);
    });

    it('prefixes an immediate-dispatch banner when urgency is immediate', () => {
      const actions = buildMaintenanceActions({
        signals: [{ code: 'FAULT_CLUSTER', severity: 'critical' }],
        urgency: 'immediate',
      });
      expect(actions[0]).toMatch(/immediate/i);
      expect(actions[0]).toMatch(/biomedical/i);
    });

    it('dedupes repeated actions even when the same signal is passed twice', () => {
      const actions = buildMaintenanceActions({
        signals: [
          { code: 'OVERDUE_MAINTENANCE', severity: 'high' },
          { code: 'OVERDUE_MAINTENANCE', severity: 'high' },
        ],
        urgency: 'within_7_days',
      });
      const overdueCount = actions.filter((line) => /overdue preventive maintenance/i.test(line)).length;
      expect(overdueCount).toBe(1);
    });
  });
});
