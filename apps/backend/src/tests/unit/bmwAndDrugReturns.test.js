// src/tests/unit/bmwAndDrugReturns.test.js — Sprint 20

import { _internal as bmwInternal } from '../../services/compliance/bmwService.js';
import { _internal as drugInternal } from '../../services/compliance/drugReturnsService.js';

const { checkCeiling, DAILY_CEILING_KG, ALLOWED_DESTINATIONS } = bmwInternal;
const { STATUS_TRANSITIONS, ALLOWED_REASONS, ALLOWED_COUNTERPARTY } = drugInternal;

describe('BMW ceiling check', () => {
  it('within ceiling → false', () => {
    expect(checkCeiling({
      yellow_kg: 10, red_kg: 5, white_kg: 1, blue_kg: 2,
    })).toBe(false);
  });

  it('yellow over → true', () => {
    expect(checkCeiling({ yellow_kg: 51 })).toBe(true);
  });
  it('white over → true (sharps ceiling lowest)', () => {
    expect(checkCeiling({ white_kg: 6 })).toBe(true);
  });

  it('exact ceiling → false', () => {
    expect(checkCeiling({
      yellow_kg: DAILY_CEILING_KG.yellow,
      red_kg: DAILY_CEILING_KG.red,
      white_kg: DAILY_CEILING_KG.white,
      blue_kg: DAILY_CEILING_KG.blue,
    })).toBe(false);
  });

  it('ceiling values are sane (yellow > red > blue > white)', () => {
    // soft check that the constants make clinical sense
    expect(DAILY_CEILING_KG.yellow).toBeGreaterThan(DAILY_CEILING_KG.red);
    expect(DAILY_CEILING_KG.red).toBeGreaterThan(DAILY_CEILING_KG.blue);
    expect(DAILY_CEILING_KG.blue).toBeGreaterThan(DAILY_CEILING_KG.white);
  });

  it('destination allowlist includes the four real options', () => {
    expect(ALLOWED_DESTINATIONS).toContain('cssd');
    expect(ALLOWED_DESTINATIONS).toContain('cbwtf');
    expect(ALLOWED_DESTINATIONS).toContain('incinerator');
    expect(ALLOWED_DESTINATIONS).toContain('return_pharma');
  });
});

describe('Drug returns status machine', () => {
  it('draft → quarantined or cancelled', () => {
    expect(STATUS_TRANSITIONS.draft).toEqual(
      expect.arrayContaining(['quarantined', 'cancelled']),
    );
  });

  it('quarantined → approved or cancelled', () => {
    expect(STATUS_TRANSITIONS.quarantined).toEqual(
      expect.arrayContaining(['approved', 'cancelled']),
    );
  });

  it('approved → dispatched or cancelled (no skip back)', () => {
    expect(STATUS_TRANSITIONS.approved).toEqual(
      expect.arrayContaining(['dispatched', 'cancelled']),
    );
    // Cannot go back to quarantined / draft.
    expect(STATUS_TRANSITIONS.approved).not.toContain('draft');
    expect(STATUS_TRANSITIONS.approved).not.toContain('quarantined');
  });

  it('dispatched → only acknowledged (no cancel after dispatch)', () => {
    expect(STATUS_TRANSITIONS.dispatched).toEqual(['acknowledged']);
  });

  it('acknowledged + cancelled are terminal', () => {
    expect(STATUS_TRANSITIONS.acknowledged).toEqual([]);
    expect(STATUS_TRANSITIONS.cancelled).toEqual([]);
  });

  it('reason allowlist covers Indian regulatory categories', () => {
    expect(ALLOWED_REASONS).toContain('expired');
    expect(ALLOWED_REASONS).toContain('damaged');
    expect(ALLOWED_REASONS).toContain('recalled');
    expect(ALLOWED_REASONS).toContain('temp_breach');
  });

  it('counterparty kinds match Indian CDSCO + state regulator chain', () => {
    expect(ALLOWED_COUNTERPARTY).toEqual(
      expect.arrayContaining(['manufacturer', 'distributor', 'sdc']),
    );
  });
});
