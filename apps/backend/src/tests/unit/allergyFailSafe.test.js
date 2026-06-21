/**
 * Allergy safety hardening (audit §3 Clinical core & safety):
 *   1. SEVERITY DOWNGRADE — rankSeverity() returned 0 for any non-canonical
 *      severity label, so a documented-but-oddly-labelled allergy was silently
 *      ranked below MILD and downgraded from blocker to warning. A present-but-
 *      unrecognized severity must fail SAFE (rank >= SEVERE).
 *   2. FAIL-OPEN UNION — getUnifiedActiveAllergies ran all four sources as ONE
 *      statement; a single source's schema fault threw and the catch returned []
 *      => every allergy vanished from the prescription gate. Each source must be
 *      resilient so one fault degrades only that source.
 */
import { jest } from '@jest/globals';
import { rankSeverity, getUnifiedActiveAllergies } from '../../services/clinical/allergySourceService.js';

describe('rankSeverity — fail-safe on unknown labels', () => {
  it('ranks the canonical severities', () => {
    expect(rankSeverity('SEVERE')).toBe(4);
    expect(rankSeverity('anaphylaxis')).toBe(5);
    expect(rankSeverity('MILD')).toBe(1);
  });

  it('treats a present-but-unrecognized severity as SEVERE (no silent downgrade)', () => {
    expect(rankSeverity('critical')).toBeGreaterThanOrEqual(4);
    expect(rankSeverity('grade IV')).toBeGreaterThanOrEqual(4);
  });

  it('ranks an absent or explicit-no-claim severity as 0 (not a downgrade)', () => {
    expect(rankSeverity(null)).toBe(0);
    expect(rankSeverity('')).toBe(0);
    expect(rankSeverity('   ')).toBe(0);
    // explicit "we don't know" sentinels stay 0 — distinct from an unparseable label
    expect(rankSeverity('UNKNOWN')).toBe(0);
    expect(rankSeverity('none')).toBe(0);
  });
});

describe('getUnifiedActiveAllergies — per-source resilience (no fail-open)', () => {
  it('still returns healthy sources when one source query throws', async () => {
    const uid = '00000000-0000-4000-8000-000000000abc';
    const db = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        // One faulty source (missing table) must NOT zero the others.
        if (/patient_allergies/i.test(sql)) {
          throw new Error('relation "patient_allergies" does not exist');
        }
        if (/FROM users/i.test(sql)) {
          return [{ id: 7, uid, allergies: '' }]; // patient resolution
        }
        if (/FROM allergies/i.test(sql)) {
          return [{ allergen: 'Penicillin', severity: 'SEVERE' }]; // healthy legacy source
        }
        if (/admissions/i.test(sql)) return [];
        return [];
      }),
    };

    const result = await getUnifiedActiveAllergies(db, { patientUid: uid });
    const names = result.map((r) => String(r.allergen).toLowerCase());
    expect(names).toContain('penicillin');
  });
});
