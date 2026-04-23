import {
  classifyBedStatus,
  classifyEdStatus,
  classifyOrStatus,
  classifyHousekeepingStatus,
  classifyRadiologyStatus,
  classifyPharmacyStatus,
  escalateCommandStatus,
  rollupCommandStatus,
  computeOverallScore,
  evaluateCommandCenter,
  buildCommandActions,
} from '../../services/ai/hospitalCommandCenterService.js';

describe('hospital command center helpers', () => {
  describe('classifyBedStatus', () => {
    it('classifies crisis when occupancy is at or above 98%', () => {
      const result = classifyBedStatus({
        occupancyPct: 99,
        dischargeReadyWaitMinutes: 120,
        admissionQueueCount: 5,
      });
      expect(result.tier).toBe('crisis');
      expect(result.score_delta).toBe(40);
      expect(result.signals.some((s) => s.code === 'BED_CRISIS')).toBe(true);
    });

    it('classifies normal when all signals are within healthy bands', () => {
      const result = classifyBedStatus({
        occupancyPct: 70,
        dischargeReadyWaitMinutes: 30,
        admissionQueueCount: 0,
      });
      expect(result.tier).toBe('normal');
      expect(result.score_delta).toBe(0);
      expect(result.signals.some((s) => s.code === 'BED_NORMAL')).toBe(true);
    });
  });

  describe('classifyEdStatus', () => {
    it('classifies crisis when wait time is 240 min or greater', () => {
      const result = classifyEdStatus({
        waitMinutes: 300,
        boardingCount: 8,
        lwbsPct: 2,
      });
      expect(result.tier).toBe('crisis');
      expect(result.score_delta).toBe(40);
    });

    it('classifies normal when wait, boarding, and LWBS are all low', () => {
      const result = classifyEdStatus({
        waitMinutes: 30,
        boardingCount: 1,
        lwbsPct: 0,
      });
      expect(result.tier).toBe('normal');
      expect(result.score_delta).toBe(0);
    });
  });

  describe('classifyOrStatus', () => {
    it('classifies crisis when utilization is 110% or greater', () => {
      const result = classifyOrStatus({
        utilizationPct: 115,
        overrunCount: 8,
        addonPressure: 'excessive',
      });
      expect(result.tier).toBe('crisis');
      expect(result.score_delta).toBe(30);
    });

    it('classifies normal when OR metrics are healthy', () => {
      const result = classifyOrStatus({
        utilizationPct: 80,
        overrunCount: 1,
        addonPressure: 'low',
      });
      expect(result.tier).toBe('normal');
      expect(result.score_delta).toBe(0);
    });
  });

  describe('classifyHousekeepingStatus', () => {
    it('classifies crisis when pending turnovers reach 15 or more', () => {
      const result = classifyHousekeepingStatus({
        pendingTurnovers: 20,
        avgTurnoverMinutes: 40,
      });
      expect(result.tier).toBe('crisis');
      expect(result.score_delta).toBe(25);
    });

    it('classifies normal when housekeeping backlog is light', () => {
      const result = classifyHousekeepingStatus({
        pendingTurnovers: 0,
        avgTurnoverMinutes: 20,
      });
      expect(result.tier).toBe('normal');
    });
  });

  describe('classifyRadiologyStatus', () => {
    it('classifies crisis when 40 or more studies are pending', () => {
      const result = classifyRadiologyStatus({
        pendingStudies: 50,
        statWaitMinutes: 15,
      });
      expect(result.tier).toBe('crisis');
      expect(result.score_delta).toBe(25);
    });

    it('classifies normal when radiology queue is short', () => {
      const result = classifyRadiologyStatus({
        pendingStudies: 5,
        statWaitMinutes: 5,
      });
      expect(result.tier).toBe('normal');
    });
  });

  describe('classifyPharmacyStatus', () => {
    it('classifies crisis when critical meds late reaches 3 or more', () => {
      const result = classifyPharmacyStatus({
        dispenseBacklogMinutes: 90,
        criticalMedsLate: 5,
      });
      expect(result.tier).toBe('crisis');
      expect(result.score_delta).toBe(30);
    });

    it('classifies normal when pharmacy is on top of backlog', () => {
      const result = classifyPharmacyStatus({
        dispenseBacklogMinutes: 5,
        criticalMedsLate: 0,
      });
      expect(result.tier).toBe('normal');
    });
  });

  describe('escalateCommandStatus', () => {
    it('returns the highest-severity status from the list', () => {
      expect(escalateCommandStatus(['normal', 'elevated', 'crisis'])).toBe('crisis');
    });
  });

  describe('rollupCommandStatus', () => {
    it('returns normal when every department is normal', () => {
      expect(
        rollupCommandStatus(['normal', 'normal', 'normal', 'normal', 'normal', 'normal']),
      ).toBe('normal');
    });

    it('returns crisis when any single department is in crisis', () => {
      expect(
        rollupCommandStatus(['normal', 'crisis', 'normal', 'normal', 'normal', 'normal']),
      ).toBe('crisis');
    });

    it('returns elevated when three or more departments are on watch', () => {
      expect(
        rollupCommandStatus(['watch', 'watch', 'watch', 'normal', 'normal', 'normal']),
      ).toBe('elevated');
    });

    it('returns watch when a single department is on watch', () => {
      expect(
        rollupCommandStatus(['watch', 'normal', 'normal', 'normal', 'normal', 'normal']),
      ).toBe('watch');
    });
  });

  describe('computeOverallScore', () => {
    it('sums score_delta values across department results', () => {
      expect(computeOverallScore([{ score_delta: 10 }, { score_delta: 25 }])).toBe(35);
    });
  });

  describe('evaluateCommandCenter', () => {
    it('rolls up a crisis bed + ED into command_status crisis with bed tier crisis', () => {
      const result = evaluateCommandCenter({
        bed: { occupancyPct: 99 },
        ed: { waitMinutes: 300 },
      });
      expect(result.command_status).toBe('crisis');
      expect(result.department_status.bed.tier).toBe('crisis');
    });
  });

  describe('buildCommandActions', () => {
    it('includes a crisis/bed action plus the decision-support disclaimer', () => {
      const actions = buildCommandActions({
        commandStatus: 'crisis',
        departmentStatus: { bed: { tier: 'crisis' } },
        signals: [],
      });
      expect(Array.isArray(actions)).toBe(true);
      expect(actions.some((line) => /decision support only/i.test(line))).toBe(true);
      expect(actions.some((line) => /crisis|bed/i.test(line))).toBe(true);
    });
  });
});
