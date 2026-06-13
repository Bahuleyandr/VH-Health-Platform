// Roadmap B6 — med-rec pure helpers.

import {
  normalizeMedicationEntry,
  mergeMedicationLists,
  buildChangeDetail,
  REC_TYPES,
  ITEM_DECISIONS,
} from '../../services/clinical/medicationReconciliationService.js';

describe('med-rec normalizeMedicationEntry', () => {
  test('normalizes string entries', () => {
    expect(normalizeMedicationEntry('  Metformin 500mg ', 'home', 'users.chronic_medications'))
      .toEqual({
        medication_name: 'Metformin 500mg', dose: null, frequency: null, route: null,
        source: 'home', source_ref: 'users.chronic_medications',
      });
  });
  test('normalizes object entries with field aliases', () => {
    expect(normalizeMedicationEntry(
      { name: 'Amlodipine', dosage: '5mg', freq: 'OD', route: 'oral' }, 'inpatient', 'mar:1',
    )).toMatchObject({ medication_name: 'Amlodipine', dose: '5mg', frequency: 'OD', route: 'oral' });
  });
  test('drops empty/null entries', () => {
    expect(normalizeMedicationEntry('', 'home')).toBeNull();
    expect(normalizeMedicationEntry({ dose: '5mg' }, 'home')).toBeNull();
    expect(normalizeMedicationEntry(null, 'home')).toBeNull();
  });
});

describe('med-rec mergeMedicationLists', () => {
  test('dedupes case-insensitively keeping first occurrence (source priority)', () => {
    const home = [{ medication_name: 'Metformin 500mg', source: 'home' }];
    const inpatient = [
      { medication_name: 'metformin  500mg', source: 'inpatient' },
      { medication_name: 'Pantoprazole 40mg', source: 'inpatient' },
    ];
    const merged = mergeMedicationLists(home, inpatient);
    expect(merged).toHaveLength(2);
    expect(merged[0].source).toBe('home'); // first list wins
    expect(merged[1].medication_name).toBe('Pantoprazole 40mg');
  });
  test('tolerates empty/missing lists', () => {
    expect(mergeMedicationLists(undefined, [], null)).toEqual([]);
  });
});

describe('med-rec constants', () => {
  test('three reconciliation points; five decisions', () => {
    expect(REC_TYPES).toEqual(['admission', 'transfer', 'discharge']);
    expect(ITEM_DECISIONS).toEqual(['continue', 'stop', 'change', 'new', 'hold']);
  });
});

describe('med-rec buildChangeDetail (B4.3 structured change detail)', () => {
  const item = { dose: '500mg', route: 'oral', frequency: 'BD' };

  test('captures from/to per changed field only', () => {
    expect(buildChangeDetail(item, { changedDose: '500mg', changedFrequency: 'OD' }))
      .toEqual({
        dose: { from: '500mg', to: '500mg' },
        frequency: { from: 'BD', to: 'OD' },
      });
  });

  test('omits fields with no new value and trims', () => {
    expect(buildChangeDetail(item, { changedRoute: '  IV ' }))
      .toEqual({ route: { from: 'oral', to: 'IV' } });
  });

  test('returns empty object when nothing changed', () => {
    expect(buildChangeDetail(item, {})).toEqual({});
    expect(buildChangeDetail(item, { changedDose: '', changedRoute: null })).toEqual({});
  });

  test('from side falls back to null when source field absent', () => {
    expect(buildChangeDetail({}, { changedDose: '250mg' }))
      .toEqual({ dose: { from: null, to: '250mg' } });
  });
});
