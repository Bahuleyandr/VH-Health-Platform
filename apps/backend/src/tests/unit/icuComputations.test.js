// src/tests/unit/icuComputations.test.js — Sprint 19
// Pure-compute unit tests for ICU service helpers.

import {
  gcsTotal, netBalance, camPositive, bundleComplete, bundlePct,
} from '../../services/clinical/icuComputations.js';

describe('ICU pure-compute helpers', () => {
  describe('gcsTotal', () => {
    it('returns null when all components null', () => {
      expect(gcsTotal(null, null, null)).toBeNull();
    });
    it('sums non-null components', () => {
      expect(gcsTotal(4, 5, 6)).toBe(15);
    });
    it('treats null as zero when at least one is set', () => {
      expect(gcsTotal(4, null, 6)).toBe(10);
    });
    it('lowest possible coma score', () => {
      expect(gcsTotal(1, 1, 1)).toBe(3);
    });
  });

  describe('netBalance', () => {
    it('intake minus output', () => {
      expect(netBalance({
        iv_fluids_ml: 1000, oral_intake_ml: 200, blood_products_ml: 0,
        urine_output_ml: 800, drain_output_ml: 50, ng_aspirate_ml: 100,
      })).toBe(250);
    });
    it('handles all undefined as zero', () => {
      expect(netBalance({})).toBe(0);
    });
    it('negative balance allowed (more out than in)', () => {
      expect(netBalance({
        iv_fluids_ml: 100, urine_output_ml: 1000,
      })).toBe(-900);
    });
  });

  describe('camPositive (CAM-ICU)', () => {
    it('returns null when feature1 or feature2 missing', () => {
      expect(camPositive(null, true, true, true)).toBeNull();
      expect(camPositive(true, null, true, true)).toBeNull();
    });
    it('false when feature1 false', () => {
      expect(camPositive(false, true, true, true)).toBe(false);
    });
    it('false when feature2 false', () => {
      expect(camPositive(true, false, true, true)).toBe(false);
    });
    it('false when both 3 and 4 false', () => {
      expect(camPositive(true, true, false, false)).toBe(false);
    });
    it('true when 1+2+3', () => {
      expect(camPositive(true, true, true, false)).toBe(true);
    });
    it('true when 1+2+4', () => {
      expect(camPositive(true, true, false, true)).toBe(true);
    });
    it('true when all four', () => {
      expect(camPositive(true, true, true, true)).toBe(true);
    });
  });

  describe('bundleComplete (ABCDEF)', () => {
    const allDone = {
      a_awakening_done: true, b_breathing_done: true, c_choice_done: true,
      d_delirium_assessed: true, e_mobility_done: true, f_family_done: true,
    };
    it('all-or-nothing: true only if every flag set', () => {
      expect(bundleComplete(allDone)).toBe(true);
    });
    it('one missing → false', () => {
      expect(bundleComplete({ ...allDone, e_mobility_done: false })).toBe(false);
    });
    it('all false → false', () => {
      expect(bundleComplete({})).toBe(false);
    });
  });

  describe('bundlePct', () => {
    it('0 when nothing done', () => {
      expect(bundlePct({})).toBe(0);
    });
    it('100 when all done', () => {
      expect(bundlePct({
        a_awakening_done: true, b_breathing_done: true, c_choice_done: true,
        d_delirium_assessed: true, e_mobility_done: true, f_family_done: true,
      })).toBe(100);
    });
    it('rounds half done to 50', () => {
      expect(bundlePct({
        a_awakening_done: true, b_breathing_done: true, c_choice_done: true,
      })).toBe(50);
    });
    it('one done = 17 (1/6 rounded)', () => {
      expect(bundlePct({ a_awakening_done: true })).toBe(17);
    });
  });
});
