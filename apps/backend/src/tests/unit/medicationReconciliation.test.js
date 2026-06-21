// Roadmap B6 — med-rec pure helpers.

import {
  normalizeMedicationEntry,
  mergeMedicationLists,
  buildChangeDetail,
  normalizeMedicationIngredient,
  classifyHighAlertIngredient,
  classifyDiscrepancies,
  REC_TYPES,
  ITEM_DECISIONS,
  DISCREPANCY_TYPES,
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
  test('three reconciliation points; five decisions; five discrepancy types', () => {
    expect(REC_TYPES).toEqual(['admission', 'transfer', 'discharge']);
    expect(ITEM_DECISIONS).toEqual(['continue', 'stop', 'change', 'new', 'hold']);
    expect(DISCREPANCY_TYPES).toEqual(['added', 'omitted', 'dose_changed', 'duplicate', 'unchanged']);
  });
});

describe('med-rec normalizeMedicationIngredient (audit §C-2 ingredient alignment)', () => {
  test('brand and generic of the same drug collapse to one ingredient', () => {
    expect(normalizeMedicationIngredient('Eliquis 5mg tablet'))
      .toBe(normalizeMedicationIngredient('Apixaban 5mg'));
    expect(normalizeMedicationIngredient('Lipitor 20mg'))
      .toBe(normalizeMedicationIngredient('Atorvastatin 40mg HS'));
    expect(normalizeMedicationIngredient('Lantus 20u'))
      .toBe(normalizeMedicationIngredient('Insulin Glargine'));
  });
  test('strength / form / route / frequency are not part of identity', () => {
    expect(normalizeMedicationIngredient('Metformin 500mg BD tablet'))
      .toBe(normalizeMedicationIngredient('metformin 1g oral OD'));
  });
  test('unknown drug falls back to a stable stripped key', () => {
    expect(normalizeMedicationIngredient('Frobozzine 250mg cap'))
      .toBe(normalizeMedicationIngredient('frobozzine 500 mg'));
  });
  test('empty/nullish → empty string', () => {
    expect(normalizeMedicationIngredient('')).toBe('');
    expect(normalizeMedicationIngredient(null)).toBe('');
  });
});

describe('med-rec classifyHighAlertIngredient', () => {
  test('catches each high-alert class by generic and brand', () => {
    expect(classifyHighAlertIngredient('Warfarin 5mg')).toBe('anticoagulant');
    expect(classifyHighAlertIngredient('Clexane 40mg')).toBe('anticoagulant'); // enoxaparin brand
    expect(classifyHighAlertIngredient('Lantus')).toBe('insulin');
    expect(classifyHighAlertIngredient('Keppra 500mg')).toBe('antiepileptic'); // levetiracetam brand
    expect(classifyHighAlertIngredient('Fentanyl patch')).toBe('opioid');
    expect(classifyHighAlertIngredient('Xeloda')).toBe('chemotherapy'); // capecitabine brand
  });
  test('non-high-alert chronic meds return null', () => {
    expect(classifyHighAlertIngredient('Paracetamol 500mg')).toBeNull();
    expect(classifyHighAlertIngredient('Atorvastatin 20mg')).toBeNull();
    expect(classifyHighAlertIngredient('')).toBeNull();
  });
});

describe('med-rec classifyDiscrepancies (ingredient-aligned engine)', () => {
  const sources = {
    home: [
      { medication_name: 'Warfarin 5mg', dose: '5mg' },          // dropped → omitted
      { medication_name: 'Atorvastatin 20mg', dose: '20mg' },    // continued (brand on other side)
      { medication_name: 'Metformin 500mg', dose: '500mg', frequency: 'BD' }, // dose change
    ],
    active_prescriptions: [
      { medication_name: 'Lipitor 20mg', dose: '20mg' },         // == atorvastatin → unchanged
      { medication_name: 'Metformin 500mg', dose: '500mg', frequency: 'OD' }, // freq differs → dose_changed
      { medication_name: 'Pantoprazole 40mg', dose: '40mg' },    // new → added
    ],
    inpatient_mar: [],
  };

  test('classifies omitted / unchanged(brand==generic) / dose_changed / added', () => {
    const items = [
      { id: 1, medication_name: 'Warfarin 5mg', dose: '5mg' },
      { id: 2, medication_name: 'Atorvastatin 20mg', dose: '20mg' },
      { id: 3, medication_name: 'Metformin 500mg', dose: '500mg', frequency: 'BD' },
      { id: 4, medication_name: 'Pantoprazole 40mg', dose: '40mg' },
    ];
    const { byKey, counts } = classifyDiscrepancies(items, sources);
    expect(byKey.get(1)).toBe('omitted');       // anticoagulant dropped
    expect(byKey.get(2)).toBe('unchanged');     // brand==generic, same dose → NOT a discrepancy
    expect(byKey.get(3)).toBe('dose_changed');  // BD → OD
    expect(byKey.get(4)).toBe('added');         // started this episode
    expect(counts).toMatchObject({ omitted: 1, unchanged: 1, dose_changed: 1, added: 1 });
  });

  test('missing structured dose on one side is NOT a false dose_changed', () => {
    // Home med captured as free text (no dose field) vs active order with a dose.
    const s = {
      home: [{ medication_name: 'Telmisartan 40mg' }],          // no structured dose
      active_prescriptions: [{ medication_name: 'Telma 40mg', dose: '40mg', frequency: 'OD' }],
      inpatient_mar: [],
    };
    const { byKey } = classifyDiscrepancies([{ id: 9, medication_name: 'Telmisartan 40mg' }], s);
    expect(byKey.get(9)).toBe('unchanged');
  });

  test('second occurrence of the same ingredient is a duplicate', () => {
    const s = { home: [{ medication_name: 'Amlodipine 5mg' }], active_prescriptions: [{ medication_name: 'Amlong 5mg' }], inpatient_mar: [] };
    const items = [
      { id: 1, medication_name: 'Amlodipine 5mg' },
      { id: 2, medication_name: 'Amlong 5mg' }, // same ingredient as #1 → duplicate
    ];
    const { byKey } = classifyDiscrepancies(items, s);
    expect(byKey.get(1)).toBe('unchanged');
    expect(byKey.get(2)).toBe('duplicate');
  });

  test('keyFn can file verdicts by array index (start-time, pre-insert)', () => {
    const items = [{ medication_name: 'Warfarin 5mg' }];
    const { byKey } = classifyDiscrepancies(items, sources, (_i, idx) => idx);
    expect(byKey.get(0)).toBe('omitted');
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
