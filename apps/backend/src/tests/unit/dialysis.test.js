// src/tests/unit/dialysis.test.js — Sprint 22

import { _internal } from '../../services/clinical/dialysisService.js';

const {
  SESSION_TRANSITIONS, computeUrr, computeKtv,
  VALID_MODALITIES, VALID_ACCESS_TYPES,
} = _internal;

describe('Dialysis session status walk', () => {
  it('scheduled has three exits', () => {
    expect(SESSION_TRANSITIONS.scheduled).toEqual(
      expect.arrayContaining(['in_progress', 'cancelled', 'no_show']),
    );
  });

  it('in_progress can complete or cancel only', () => {
    expect(SESSION_TRANSITIONS.in_progress).toEqual(
      expect.arrayContaining(['completed', 'cancelled']),
    );
    expect(SESSION_TRANSITIONS.in_progress).not.toContain('no_show');
  });

  it('completed/cancelled/no_show are terminal', () => {
    expect(SESSION_TRANSITIONS.completed).toEqual([]);
    expect(SESSION_TRANSITIONS.cancelled).toEqual([]);
    expect(SESSION_TRANSITIONS.no_show).toEqual([]);
  });

  it('cannot revert in_progress to scheduled', () => {
    expect(SESSION_TRANSITIONS.in_progress).not.toContain('scheduled');
  });
});

describe('URR (urea reduction ratio)', () => {
  it('typical good adequacy: 70%', () => {
    expect(computeUrr({ urea_pre_mg_dl: 100, urea_post_mg_dl: 30 })).toBe(70);
  });

  it('returns null when pre is missing or zero', () => {
    expect(computeUrr({ urea_post_mg_dl: 30 })).toBeNull();
    expect(computeUrr({ urea_pre_mg_dl: 0, urea_post_mg_dl: 30 })).toBeNull();
  });

  it('returns null when post is missing', () => {
    expect(computeUrr({ urea_pre_mg_dl: 100 })).toBeNull();
  });

  it('handles equal pre and post (no clearance) → 0%', () => {
    expect(computeUrr({ urea_pre_mg_dl: 100, urea_post_mg_dl: 100 })).toBe(0);
  });
});

describe('Kt/V (Daugirdas single-pool)', () => {
  it('returns null when missing required input', () => {
    expect(computeKtv({})).toBeNull();
    // Missing duration
    expect(computeKtv({
      urea_pre_mg_dl: 100, urea_post_mg_dl: 30,
      post_weight_kg: 70,
    })).toBeNull();
    // Missing post_weight_kg
    expect(computeKtv({
      urea_pre_mg_dl: 100, urea_post_mg_dl: 30,
      duration_min: 240,
    })).toBeNull();
  });

  it('typical 4h thrice-weekly run hits >1.2 target', () => {
    const ktv = computeKtv({
      urea_pre_mg_dl: 100, urea_post_mg_dl: 30,
      duration_min: 240, actual_uf_l: 2.5, post_weight_kg: 65,
    });
    expect(ktv).not.toBeNull();
    expect(ktv).toBeGreaterThan(1.2);
  });

  it('inadequate dialysis (small reduction, short run) yields low Kt/V', () => {
    const ktv = computeKtv({
      urea_pre_mg_dl: 100, urea_post_mg_dl: 60,
      duration_min: 120, actual_uf_l: 1.0, post_weight_kg: 70,
    });
    expect(ktv).toBeLessThan(0.9);
  });

  it('Kt/V is rounded to 2 decimals', () => {
    const ktv = computeKtv({
      urea_pre_mg_dl: 100, urea_post_mg_dl: 30,
      duration_min: 240, actual_uf_l: 2.5, post_weight_kg: 65,
    });
    expect(Math.round(ktv * 100) / 100).toBe(ktv);
  });
});

describe('Modality + access allowlists', () => {
  it('modality covers all real Indian unit options', () => {
    expect(VALID_MODALITIES).toEqual(expect.arrayContaining([
      'hd', 'hdf', 'pd_capd', 'pd_apd', 'crrt', 'sled',
    ]));
  });

  it('access types cover AVF / AVG / CVC / PD', () => {
    expect(VALID_ACCESS_TYPES).toEqual(expect.arrayContaining([
      'avf_radiocephalic', 'avf_brachiocephalic',
      'avg_forearm', 'avg_upper_arm',
      'cvc_temporary_femoral', 'cvc_tunneled_ij',
      'pd_catheter',
    ]));
  });

  it('rejects nonsense access types', () => {
    expect(VALID_ACCESS_TYPES).not.toContain('peripheral_iv_line');
  });
});
