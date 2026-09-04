// apps/backend/src/services/lab/labAnalyteCodes.js
//
// The one map between orderable investigation catalogue codes
// (investigation_test_catalog.code: CBC, PLT, CREATININE, KFT, ELECTROLYTES,
// HIV, HBSAG, HCV — migration 102) and the analyte codes that arrive on
// lab_results.test_code (HGB, PLT, CREA, K — migration 175; serology arrives
// under the catalogue code). There is no join key between the two tables, so
// every consumer (cath lab readiness, blood-borne marker hook) reads this map
// and nothing else. Extend the alias lists here; the unit test pins every row.

const item = ({
  canonicalAnalyteCode,
  analyteCodes,
  loincCodes = [],
  orderCodes,
  kind,
  unit = null,
  marker = null,
}) => Object.freeze({
  canonicalAnalyteCode,
  analyteCodes: Object.freeze(analyteCodes),
  loincCodes: Object.freeze(loincCodes),
  orderCodes: Object.freeze(orderCodes),
  kind,
  unit,
  marker,
});

export const LAB_ANALYTE_ITEMS = Object.freeze({
  hb: item({
    canonicalAnalyteCode: 'HGB',
    analyteCodes: ['HGB', 'HB', 'HAEMOGLOBIN', 'HEMOGLOBIN'],
    loincCodes: ['718-7'],
    orderCodes: ['CBC'],
    kind: 'quantitative',
    unit: 'g/dL',
  }),
  platelets: item({
    canonicalAnalyteCode: 'PLT',
    analyteCodes: ['PLT', 'PLATELET', 'PLATELETS'],
    loincCodes: ['777-3'],
    orderCodes: ['CBC', 'PLT'],
    kind: 'quantitative',
    unit: '10^3/uL',
  }),
  creatinine: item({
    canonicalAnalyteCode: 'CREA',
    analyteCodes: ['CREA', 'CREATININE', 'CREAT'],
    loincCodes: ['2160-0'],
    orderCodes: ['CREATININE', 'KFT'],
    kind: 'quantitative',
    unit: 'mg/dL',
  }),
  potassium: item({
    canonicalAnalyteCode: 'K',
    analyteCodes: ['K', 'POTASSIUM'],
    loincCodes: ['2823-3'],
    orderCodes: ['ELECTROLYTES'],
    kind: 'quantitative',
    unit: 'mmol/L',
  }),
  hiv: item({
    canonicalAnalyteCode: 'HIV',
    analyteCodes: ['HIV', 'HIV1_2', 'HIV_AB'],
    orderCodes: ['HIV'],
    kind: 'qualitative',
    marker: 'hiv',
  }),
  hbsag: item({
    canonicalAnalyteCode: 'HBSAG',
    analyteCodes: ['HBSAG', 'HBS_AG'],
    orderCodes: ['HBSAG'],
    kind: 'qualitative',
    marker: 'hbsag',
  }),
  hcv: item({
    canonicalAnalyteCode: 'HCV',
    analyteCodes: ['HCV', 'ANTI_HCV', 'HCV_AB'],
    orderCodes: ['HCV'],
    kind: 'qualitative',
    marker: 'hcv',
  }),
});

export const LAB_ANALYTE_ITEM_CODES = Object.freeze(Object.keys(LAB_ANALYTE_ITEMS));
export const BLOODBORNE_MARKER_ITEM_CODES = Object.freeze(
  LAB_ANALYTE_ITEM_CODES.filter((code) => LAB_ANALYTE_ITEMS[code].marker !== null),
);

// "HBs Ag", "Anti-HCV", "hiv-ab" all normalise to the underscore form used in
// the alias lists: uppercase, runs of spaces and hyphens become one underscore.
function normalizeCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function analyteItemForResult({ test_code = null, loinc_code = null } = {}) {
  const code = normalizeCode(test_code);
  if (code) {
    for (const [key, def] of Object.entries(LAB_ANALYTE_ITEMS)) {
      if (def.analyteCodes.includes(code)) return key;
    }
  }
  const loinc = String(loinc_code ?? '').trim();
  if (loinc) {
    for (const [key, def] of Object.entries(LAB_ANALYTE_ITEMS)) {
      if (def.loincCodes.includes(loinc)) return key;
    }
  }
  return null;
}

export function markerForResult(result = {}) {
  const key = analyteItemForResult(result);
  return key ? LAB_ANALYTE_ITEMS[key].marker : null;
}

// Which orderable codes cover a set of missing items. CBC covers hb and
// platelets at once; serology items order under their own catalogue code.
export function orderCodesCovering(items = []) {
  const wanted = new Set(items);
  const codes = [];
  if (wanted.has('hb') || wanted.has('platelets')) codes.push('CBC');
  if (wanted.has('potassium')) codes.push('ELECTROLYTES');
  if (wanted.has('creatinine')) codes.push('CREATININE');
  for (const key of BLOODBORNE_MARKER_ITEM_CODES) {
    if (wanted.has(key)) codes.push(LAB_ANALYTE_ITEMS[key].canonicalAnalyteCode);
  }
  return codes;
}
