// apps/backend/src/tests/unit/labAnalyteCodes.test.js
import {
  BLOODBORNE_MARKER_ITEM_CODES,
  LAB_ANALYTE_ITEMS,
  LAB_ANALYTE_ITEM_CODES,
  analyteItemForResult,
  markerForResult,
  orderCodesCovering,
} from '../../services/lab/labAnalyteCodes.js';

describe('labAnalyteCodes', () => {
  test('exposes exactly the seven readiness items in a stable order', () => {
    expect(LAB_ANALYTE_ITEM_CODES).toEqual([
      'hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv',
    ]);
    expect(BLOODBORNE_MARKER_ITEM_CODES).toEqual(['hiv', 'hbsag', 'hcv']);
  });

  test.each([
    ['HGB', 'hb'], ['hb', 'hb'], ['Haemoglobin', 'hb'], ['HEMOGLOBIN', 'hb'],
    ['PLT', 'platelets'], ['Platelet', 'platelets'], ['PLATELETS', 'platelets'],
    ['CREA', 'creatinine'], ['CREATININE', 'creatinine'], ['CREAT', 'creatinine'],
    ['K', 'potassium'], ['potassium', 'potassium'],
    ['HIV', 'hiv'], ['HIV1_2', 'hiv'], ['HIV-AB', 'hiv'],
    ['HBSAG', 'hbsag'], ['HBs Ag', 'hbsag'],
    ['HCV', 'hcv'], ['ANTI_HCV', 'hcv'], ['Anti-HCV', 'hcv'], ['HCV AB', 'hcv'],
  ])('maps analyte code %s to item %s', (code, item) => {
    expect(analyteItemForResult({ test_code: code })).toBe(item);
  });

  test.each([
    ['718-7', 'hb'], ['777-3', 'platelets'], ['2160-0', 'creatinine'], ['2823-3', 'potassium'],
  ])('falls back to LOINC %s when the local code is unknown', (loinc, item) => {
    expect(analyteItemForResult({ test_code: 'LOCAL-XYZ', loinc_code: loinc })).toBe(item);
  });

  test('prefers the local code over LOINC when both match', () => {
    expect(analyteItemForResult({ test_code: 'K', loinc_code: '718-7' })).toBe('potassium');
  });

  test('returns null for unknown codes and empty input', () => {
    expect(analyteItemForResult({ test_code: 'NA' })).toBeNull();
    expect(analyteItemForResult({})).toBeNull();
    expect(analyteItemForResult({ test_code: '', loinc_code: '' })).toBeNull();
    expect(analyteItemForResult(null)).toBeNull();
    expect(markerForResult(null)).toBeNull();
    expect(analyteItemForResult()).toBeNull();
  });

  test('markerForResult returns a marker only for the serology items', () => {
    expect(markerForResult({ test_code: 'HBSAG' })).toBe('hbsag');
    expect(markerForResult({ test_code: 'hiv' })).toBe('hiv');
    expect(markerForResult({ test_code: 'HCV' })).toBe('hcv');
    expect(markerForResult({ test_code: 'HGB' })).toBeNull();
    expect(markerForResult({ test_code: 'ZZZ' })).toBeNull();
  });

  test('every item names a canonical analyte code contained in its own alias list', () => {
    for (const item of LAB_ANALYTE_ITEM_CODES) {
      const def = LAB_ANALYTE_ITEMS[item];
      expect(def.analyteCodes).toContain(def.canonicalAnalyteCode);
      expect(def.orderCodes.length).toBeGreaterThan(0);
      expect(['quantitative', 'qualitative']).toContain(def.kind);
    }
  });

  test('every alias is already in normalised form (uppercase, digits, underscore)', () => {
    for (const key of LAB_ANALYTE_ITEM_CODES) {
      for (const code of LAB_ANALYTE_ITEMS[key].analyteCodes) {
        expect(code).toMatch(/^[A-Z0-9_]+$/);
      }
    }
  });

  test('no analyte alias or LOINC code is claimed by two items', () => {
    const seen = new Map();
    for (const key of LAB_ANALYTE_ITEM_CODES) {
      const def = LAB_ANALYTE_ITEMS[key];
      for (const code of [...def.analyteCodes, ...def.loincCodes]) {
        expect(seen.get(code) ?? key).toBe(key);
        seen.set(code, key);
      }
    }
  });

  test('orderCodesCovering orders CBC once for hb and platelets together', () => {
    expect(orderCodesCovering(['hb', 'platelets'])).toEqual(['CBC']);
    expect(orderCodesCovering(['potassium', 'creatinine'])).toEqual(['ELECTROLYTES', 'CREATININE']);
    expect(orderCodesCovering(['hcv', 'hiv', 'hbsag'])).toEqual(['HIV', 'HBSAG', 'HCV']);
    expect(orderCodesCovering([])).toEqual([]);
    expect(orderCodesCovering(['not-an-item'])).toEqual([]);
  });

  test('orderCodesCovering emits each item\'s primary catalogue code', () => {
    for (const key of LAB_ANALYTE_ITEM_CODES) {
      expect(orderCodesCovering([key])).toEqual([LAB_ANALYTE_ITEMS[key].orderCodes[0]]);
    }
    expect(orderCodesCovering(['hb', 'platelets', 'creatinine', 'potassium', 'hiv', 'hbsag', 'hcv']))
      .toEqual(['CBC', 'ELECTROLYTES', 'CREATININE', 'HIV', 'HBSAG', 'HCV']);
    expect(orderCodesCovering(null)).toEqual([]);
  });

  test('the codes ordered for all items cover every item', () => {
    const codes = orderCodesCovering(LAB_ANALYTE_ITEM_CODES);
    for (const key of LAB_ANALYTE_ITEM_CODES) {
      expect(codes.some((c) => LAB_ANALYTE_ITEMS[key].orderCodes.includes(c))).toBe(true);
    }
  });
});
