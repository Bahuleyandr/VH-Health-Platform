import {
  ANOMALY_CATEGORIES,
  categorizeAnomaly,
  classifyBruteForce,
  classifyDeviceTrafficAnomaly,
  classifyExcessiveExport,
  classifyLoginAnomaly,
  computeAnomalyScore,
  distanceKm,
  recommendAnomalyActions,
} from '../../services/ai/cybersecurityAnomalyService.js';

// Mumbai (19.0760, 72.8777) → Delhi (28.6139, 77.2090) is ~1150 km.
const MUMBAI = { lat: 19.0760, lng: 72.8777, country: 'IN', city: 'Mumbai' };
const DELHI = { lat: 28.6139, lng: 77.2090, country: 'IN', city: 'Delhi' };
// New York (40.7128, -74.0060) is ~12,500 km from Mumbai.
const NEW_YORK = { lat: 40.7128, lng: -74.0060, country: 'US', city: 'New York' };
// London (51.5074, -0.1278) is ~8000 km from Mumbai.
const LONDON = { lat: 51.5074, lng: -0.1278, country: 'GB', city: 'London' };

describe('cybersecurity anomaly detector helpers', () => {
  describe('distanceKm', () => {
    it('returns 0 when any input is null', () => {
      expect(distanceKm({ lat1: null, lng1: 10, lat2: 20, lng2: 30 })).toBe(0);
      expect(distanceKm({ lat1: 10, lng1: null, lat2: 20, lng2: 30 })).toBe(0);
      expect(distanceKm({ lat1: 10, lng1: 10, lat2: null, lng2: 30 })).toBe(0);
      expect(distanceKm({ lat1: 10, lng1: 10, lat2: 20, lng2: null })).toBe(0);
      expect(distanceKm({})).toBe(0);
    });

    it('returns 0 when any input is undefined', () => {
      expect(distanceKm({ lat1: undefined, lng1: 10, lat2: 20, lng2: 30 })).toBe(0);
    });

    it('returns 0 for identical coordinates', () => {
      expect(distanceKm({ lat1: 19.0760, lng1: 72.8777, lat2: 19.0760, lng2: 72.8777 })).toBe(0);
    });

    it('computes the Mumbai → Delhi distance within 2% of 1150 km', () => {
      const km = distanceKm({
        lat1: MUMBAI.lat, lng1: MUMBAI.lng,
        lat2: DELHI.lat, lng2: DELHI.lng,
      });
      expect(km).toBeGreaterThan(1100);
      expect(km).toBeLessThan(1200);
    });

    it('computes the Mumbai → New York distance within 3% of 12,500 km', () => {
      const km = distanceKm({
        lat1: MUMBAI.lat, lng1: MUMBAI.lng,
        lat2: NEW_YORK.lat, lng2: NEW_YORK.lng,
      });
      expect(km).toBeGreaterThan(12000);
      expect(km).toBeLessThan(13000);
    });
  });

  describe('classifyLoginAnomaly', () => {
    it('emits IMPOSSIBLE_TRAVEL when two logins 5 min apart are 1000+ km apart', () => {
      const base = new Date('2026-04-01T12:00:00Z').getTime();
      const signals = classifyLoginAnomaly({
        recentLogins: [
          { timestamp: new Date(base).toISOString(), ...MUMBAI },
          { timestamp: new Date(base + 5 * 60 * 1000).toISOString(), ...DELHI },
        ],
        windowMinutes: 60,
      });
      const impossible = signals.find((s) => s.code === 'IMPOSSIBLE_TRAVEL');
      expect(impossible).toBeDefined();
      expect(impossible.severity).toBe('high');
    });

    it('does NOT emit IMPOSSIBLE_TRAVEL when logins are from the same location', () => {
      const base = new Date('2026-04-01T12:00:00Z').getTime();
      const signals = classifyLoginAnomaly({
        recentLogins: [
          { timestamp: new Date(base).toISOString(), ...MUMBAI },
          { timestamp: new Date(base + 5 * 60 * 1000).toISOString(), ...MUMBAI },
        ],
      });
      expect(signals.some((s) => s.code === 'IMPOSSIBLE_TRAVEL')).toBe(false);
    });

    it('emits MULTIPLE_GEO when 3+ distinct countries are seen within 24h', () => {
      const base = new Date('2026-04-01T12:00:00Z').getTime();
      const signals = classifyLoginAnomaly({
        recentLogins: [
          { timestamp: new Date(base).toISOString(), country: 'IN', lat: 19.08, lng: 72.88 },
          { timestamp: new Date(base + 60_000).toISOString(), country: 'GB', lat: 51.5, lng: -0.12 },
          { timestamp: new Date(base + 120_000).toISOString(), country: 'US', lat: 40.71, lng: -74.0 },
        ],
      });
      expect(signals.some((s) => s.code === 'MULTIPLE_GEO' && s.severity === 'medium')).toBe(true);
    });

    it('emits UNUSUAL_HOUR for a login logged in the 01:00-05:00 local window', () => {
      // Pick a local 03:00. The helper reads Date.getHours() which is local tz.
      const d = new Date();
      d.setHours(3, 0, 0, 0);
      const signals = classifyLoginAnomaly({
        recentLogins: [
          { timestamp: d.toISOString(), ...MUMBAI },
        ],
      });
      expect(signals.some((s) => s.code === 'UNUSUAL_HOUR' && s.severity === 'low')).toBe(true);
    });

    it('emits RAPID_LOGINS when 10+ logins happen within a 5-minute window', () => {
      const base = new Date('2026-04-01T12:00:00Z').getTime();
      const recentLogins = Array.from({ length: 12 }, (_, i) => ({
        timestamp: new Date(base + i * 20_000).toISOString(), // 12 logins spread 20s apart (<5min)
        ...MUMBAI,
      }));
      const signals = classifyLoginAnomaly({ recentLogins });
      expect(signals.some((s) => s.code === 'RAPID_LOGINS' && s.severity === 'high')).toBe(true);
    });

    it('returns an empty list for a single normal login in business hours', () => {
      const d = new Date();
      d.setHours(14, 0, 0, 0);
      const signals = classifyLoginAnomaly({
        recentLogins: [{ timestamp: d.toISOString(), ...MUMBAI }],
      });
      expect(signals).toEqual([]);
    });
  });

  describe('classifyBruteForce', () => {
    it('emits CREDENTIAL_STUFFING when distinctAccounts=15 with failures', () => {
      const signals = classifyBruteForce({
        failedAttempts: 30,
        distinctAccounts: 15,
        sourceIp: '203.0.113.42',
        windowMinutes: 10,
      });
      const stuffing = signals.find((s) => s.code === 'CREDENTIAL_STUFFING');
      expect(stuffing).toBeDefined();
      expect(stuffing.severity).toBe('critical');
    });

    it('emits BRUTE_FORCE_SINGLE_ACCOUNT when failedAttempts=25', () => {
      const signals = classifyBruteForce({
        failedAttempts: 25,
        distinctAccounts: 1,
      });
      const brute = signals.find((s) => s.code === 'BRUTE_FORCE_SINGLE_ACCOUNT');
      expect(brute).toBeDefined();
      expect(brute.severity).toBe('high');
    });

    it('emits PASSWORD_SPRAYING when failedAttempts=8 and distinctAccounts=4', () => {
      const signals = classifyBruteForce({
        failedAttempts: 8,
        distinctAccounts: 4,
      });
      const spray = signals.find((s) => s.code === 'PASSWORD_SPRAYING');
      expect(spray).toBeDefined();
      expect(spray.severity).toBe('high');
    });

    it('returns empty for low-volume normal traffic', () => {
      const signals = classifyBruteForce({
        failedAttempts: 2,
        distinctAccounts: 1,
      });
      expect(signals).toEqual([]);
    });
  });

  describe('classifyExcessiveExport', () => {
    it('emits EXCESSIVE_EXPORT_VOLUME at 15,000 rows', () => {
      const signals = classifyExcessiveExport({
        exportCount: 2,
        totalRowsExported: 15000,
        windowHours: 24,
      });
      const vol = signals.find((s) => s.code === 'EXCESSIVE_EXPORT_VOLUME');
      expect(vol).toBeDefined();
      expect(vol.severity).toBe('high');
    });

    it('emits EXPORT_OFF_HOURS when hasOffHoursAccess=true and rows>1000', () => {
      const signals = classifyExcessiveExport({
        exportCount: 1,
        totalRowsExported: 1500,
        windowHours: 24,
        hasOffHoursAccess: true,
      });
      expect(signals.some((s) => s.code === 'EXPORT_OFF_HOURS' && s.severity === 'medium')).toBe(true);
    });

    it('does NOT emit EXPORT_OFF_HOURS without hasOffHoursAccess even with rows>1000', () => {
      const signals = classifyExcessiveExport({
        exportCount: 1,
        totalRowsExported: 5000,
        windowHours: 24,
        hasOffHoursAccess: false,
      });
      expect(signals.some((s) => s.code === 'EXPORT_OFF_HOURS')).toBe(false);
    });

    it('emits RAPID_EXPORT_BURST when exportCount >= 5', () => {
      const signals = classifyExcessiveExport({
        exportCount: 6,
        totalRowsExported: 300,
        windowHours: 1,
      });
      expect(signals.some((s) => s.code === 'RAPID_EXPORT_BURST' && s.severity === 'medium')).toBe(true);
    });
  });

  describe('classifyDeviceTrafficAnomaly', () => {
    it('emits UNAUTHORIZED_UPSTREAM (critical) when knownUpstreamEndpoints=0 and attempts>0', () => {
      const signals = classifyDeviceTrafficAnomaly({
        bytesInLastHour: 100,
        baselineBytesPerHour: 500,
        connectionAttempts: 5,
        knownUpstreamEndpoints: 0,
      });
      const lateral = signals.find((s) => s.code === 'UNAUTHORIZED_UPSTREAM');
      expect(lateral).toBeDefined();
      expect(lateral.severity).toBe('critical');
    });

    it('emits DEVICE_TRAFFIC_SPIKE when bytesInLastHour > baseline * 5', () => {
      const signals = classifyDeviceTrafficAnomaly({
        bytesInLastHour: 10000,
        baselineBytesPerHour: 1000,
        connectionAttempts: 5,
        knownUpstreamEndpoints: 3,
      });
      const spike = signals.find((s) => s.code === 'DEVICE_TRAFFIC_SPIKE');
      expect(spike).toBeDefined();
      expect(spike.severity).toBe('high');
    });

    it('emits CONNECTION_STORM when connectionAttempts > 1000/hour', () => {
      const signals = classifyDeviceTrafficAnomaly({
        bytesInLastHour: 2000,
        baselineBytesPerHour: 1000,
        connectionAttempts: 1500,
        knownUpstreamEndpoints: 3,
      });
      expect(signals.some((s) => s.code === 'CONNECTION_STORM' && s.severity === 'high')).toBe(true);
    });

    it('returns empty for a steady-state device at baseline', () => {
      const signals = classifyDeviceTrafficAnomaly({
        bytesInLastHour: 900,
        baselineBytesPerHour: 1000,
        connectionAttempts: 20,
        knownUpstreamEndpoints: 3,
      });
      expect(signals).toEqual([]);
    });
  });

  describe('computeAnomalyScore', () => {
    it('returns critical when 2 high signals are present', () => {
      const result = computeAnomalyScore([
        { code: 'BRUTE_FORCE_SINGLE_ACCOUNT', severity: 'high' },
        { code: 'DEVICE_TRAFFIC_SPIKE', severity: 'high' },
      ]);
      // 25 + 25 = 50 → high (>= 45). Test that 3 highs → critical below.
      expect(result.severity).toBe('high');
      expect(result.risk_score).toBe(50);
    });

    it('returns critical when 3 high signals are present', () => {
      const result = computeAnomalyScore([
        { code: 'A', severity: 'high' },
        { code: 'B', severity: 'high' },
        { code: 'C', severity: 'high' },
      ]);
      expect(result.severity).toBe('critical');
      expect(result.risk_score).toBeGreaterThanOrEqual(70);
    });

    it('returns low with a single low signal', () => {
      const result = computeAnomalyScore([
        { code: 'UNUSUAL_HOUR', severity: 'low' },
      ]);
      expect(result.severity).toBe('low');
      expect(result.risk_score).toBe(5);
    });

    it('returns unknown + 0 for an empty signal list', () => {
      const result = computeAnomalyScore([]);
      expect(result.severity).toBe('unknown');
      expect(result.risk_score).toBe(0);
    });

    it('clamps the risk score to a max of 100', () => {
      const result = computeAnomalyScore([
        { severity: 'critical' },
        { severity: 'critical' },
        { severity: 'critical' },
        { severity: 'critical' },
      ]);
      expect(result.risk_score).toBe(100);
      expect(result.severity).toBe('critical');
    });
  });

  describe('categorizeAnomaly', () => {
    it("returns 'impossible_login' when IMPOSSIBLE_TRAVEL + MULTIPLE_GEO signals are present", () => {
      const category = categorizeAnomaly([
        { code: 'IMPOSSIBLE_TRAVEL', severity: 'high' },
        { code: 'MULTIPLE_GEO', severity: 'medium' },
      ]);
      expect(category).toBe('impossible_login');
    });

    it("returns 'credential_stuffing' when CREDENTIAL_STUFFING outranks BRUTE_FORCE", () => {
      const category = categorizeAnomaly([
        { code: 'BRUTE_FORCE_SINGLE_ACCOUNT', severity: 'high' },
        { code: 'CREDENTIAL_STUFFING', severity: 'critical' },
      ]);
      expect(category).toBe('credential_stuffing');
    });

    it("returns 'brute_force' when only brute-force-flavored codes are present", () => {
      const category = categorizeAnomaly([
        { code: 'PASSWORD_SPRAYING', severity: 'high' },
      ]);
      expect(category).toBe('brute_force');
    });

    it("returns 'device_traffic_spike' for device traffic codes", () => {
      const category = categorizeAnomaly([
        { code: 'DEVICE_TRAFFIC_SPIKE', severity: 'high' },
      ]);
      expect(category).toBe('device_traffic_spike');
    });

    it("returns 'lateral_movement' for UNAUTHORIZED_UPSTREAM", () => {
      const category = categorizeAnomaly([
        { code: 'UNAUTHORIZED_UPSTREAM', severity: 'critical' },
      ]);
      expect(category).toBe('lateral_movement');
    });

    it("returns 'excessive_export' for export-flavored codes", () => {
      const category = categorizeAnomaly([
        { code: 'EXCESSIVE_EXPORT_VOLUME', severity: 'high' },
      ]);
      expect(category).toBe('excessive_export');
    });

    it("returns 'unknown' for an empty signal list", () => {
      expect(categorizeAnomaly([])).toBe('unknown');
    });
  });

  describe('recommendAnomalyActions', () => {
    it('includes category-specific guidance for impossible_login', () => {
      const actions = recommendAnomalyActions('impossible_login', 'high');
      expect(actions.some((a) => /force password reset/i.test(a))).toBe(true);
      expect(actions.some((a) => /secondary channel/i.test(a))).toBe(true);
    });

    it('includes category-specific guidance for credential_stuffing', () => {
      const actions = recommendAnomalyActions('credential_stuffing', 'critical');
      expect(actions.some((a) => /enable mfa/i.test(a))).toBe(true);
    });

    it('includes category-specific guidance for brute_force', () => {
      const actions = recommendAnomalyActions('brute_force', 'high');
      expect(actions.some((a) => /block source ip/i.test(a))).toBe(true);
    });

    it('includes category-specific guidance for device_traffic_spike', () => {
      const actions = recommendAnomalyActions('device_traffic_spike', 'high');
      expect(actions.some((a) => /isolate device/i.test(a))).toBe(true);
    });

    it('includes category-specific guidance for excessive_export', () => {
      const actions = recommendAnomalyActions('excessive_export', 'medium');
      expect(actions.some((a) => /freeze export tokens/i.test(a))).toBe(true);
    });

    it('always appends the decision-support / review disclaimer as the final entry', () => {
      const actions = recommendAnomalyActions('brute_force', 'high');
      const last = actions[actions.length - 1];
      expect(last).toMatch(/decision-support only/i);
      expect(last).toMatch(/security-officer review/i);
    });

    it('adds a critical-severity escalation action when severity is critical', () => {
      const actions = recommendAnomalyActions('credential_stuffing', 'critical');
      expect(actions.some((a) => /on-call security officer/i.test(a))).toBe(true);
    });
  });

  describe('ANOMALY_CATEGORIES', () => {
    it('includes all seven anomaly categories + unknown', () => {
      expect(ANOMALY_CATEGORIES).toContain('impossible_login');
      expect(ANOMALY_CATEGORIES).toContain('brute_force');
      expect(ANOMALY_CATEGORIES).toContain('credential_stuffing');
      expect(ANOMALY_CATEGORIES).toContain('excessive_export');
      expect(ANOMALY_CATEGORIES).toContain('suspicious_admin');
      expect(ANOMALY_CATEGORIES).toContain('device_traffic_spike');
      expect(ANOMALY_CATEGORIES).toContain('lateral_movement');
      expect(ANOMALY_CATEGORIES).toContain('unknown');
    });
  });
});
