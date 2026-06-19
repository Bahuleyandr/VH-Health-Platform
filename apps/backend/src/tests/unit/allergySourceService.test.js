/**
 * Unit tests for allergySourceService (roadmap A10) — the unified
 * four-store allergy reader behind validatePrescriptionSafety, the
 * encounter-start CDS card, and the pharmacy dispense label.
 */

import { jest } from '@jest/globals';
import {
  getUnifiedActiveAllergies,
  mergeAllergyRows,
} from '../../services/clinical/allergySourceService.js';

describe('mergeAllergyRows', () => {
  it('dedupes case-insensitively and accumulates sources', () => {
    const merged = mergeAllergyRows([
      { allergen: 'Penicillin', severity: 'MILD', source: 'patient_allergies' },
      { allergen: 'penicillin', severity: null, source: 'users.allergies' },
      { allergen: 'Sulfa', severity: 'MODERATE', source: 'allergies' },
    ]);
    expect(merged).toHaveLength(2);
    const pen = merged.find((m) => m.allergen.toLowerCase() === 'penicillin');
    expect(pen.sources.sort()).toEqual(['patient_allergies', 'users.allergies']);
  });

  it('keeps the highest-ranked severity across duplicates', () => {
    const merged = mergeAllergyRows([
      { allergen: 'Penicillin', severity: 'MILD', source: 'a' },
      { allergen: 'PENICILLIN', severity: 'LIFE_THREATENING', source: 'b' },
      { allergen: 'penicillin', severity: 'MODERATE', source: 'c' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].severity).toBe('LIFE_THREATENING');
  });

  it('drops blank allergens and tolerates junk rows', () => {
    const merged = mergeAllergyRows([
      { allergen: '   ', severity: 'SEVERE', source: 'a' },
      null,
      { allergen: 'Latex', source: 'b' },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].allergen).toBe('Latex');
  });
});

describe('getUnifiedActiveAllergies', () => {
  it('returns [] without touching the db when no identifier is usable', async () => {
    const db = { $queryRawUnsafe: jest.fn() };
    expect(await getUnifiedActiveAllergies(db, {})).toEqual([]);
    expect(await getUnifiedActiveAllergies(db, { patientId: 'abc', patientUid: 'nope' })).toEqual([]);
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('passes id + uid through and merges the result rows', async () => {
    const db = {
      $queryRawUnsafe: jest.fn(async () => [
        { allergen: 'Penicillin', severity: 'SEVERE', source: 'patient_allergies' },
        { allergen: 'penicillin', severity: null, source: 'allergies' },
        { allergen: 'Peanut', severity: null, source: 'admission_intake' },
      ]),
    };
    const out = await getUnifiedActiveAllergies(db, {
      patientId: 42,
      patientUid: '5054d4be-801f-4a40-8abc-d658ef86f6c8',
    });
    // Now resilient: a patient-resolution query followed by independent
    // per-source queries (so one source's fault can't zero the rest). The
    // first call is the resolution query and still receives id + uid.
    expect(db.$queryRawUnsafe).toHaveBeenCalled();
    const [, idArg, uidArg] = db.$queryRawUnsafe.mock.calls[0];
    expect(idArg).toBe(42);
    expect(uidArg).toBe('5054d4be-801f-4a40-8abc-d658ef86f6c8');
    expect(out).toHaveLength(2);
    expect(out.find((a) => a.allergen.toLowerCase() === 'penicillin').severity).toBe('SEVERE');
  });

  it('never throws — db failure degrades to []', async () => {
    const db = { $queryRawUnsafe: jest.fn(async () => { throw new Error('boom'); }) };
    expect(await getUnifiedActiveAllergies(db, { patientId: 7 })).toEqual([]);
  });
});
