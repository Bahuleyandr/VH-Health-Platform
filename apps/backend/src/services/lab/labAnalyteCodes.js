// src/services/lab/labAnalyteCodes.js
//
// The one map between orderable investigation catalogue codes
// (investigation_test_catalog.code: CBC, PLT, CREATININE, KFT, ELECTROLYTES,
// HIV, HBSAG, HCV — migration 102) and the analyte codes that arrive on
// lab_results.test_code (HGB, PLT, CREA, K — migration 175; serology arrives
// under the catalogue code). There is no join key between the two tables, so
// every consumer (cath lab readiness, blood-borne marker hook) reads this map
// and nothing else.
//
// Extending it: add aliases in NORMALISED form only (uppercase, digits,
// underscore — the unit test refuses anything else) and never claim one code
// under two items (also tested). Serology items are alias-only by design: the
// catalogue seeds no LOINC for them, so an unknown serology code resolves to
// null, which every consumer treats as "no result on record" (fail-safe:
// the reuse resolver answers "unknown", never "clear"). `unit` follows the
// migration-151 threshold vocabulary (mmol/L, 10^3/uL); migration 175 uses
// mEq/L and x10^9/L for the same quantities, so never string-compare
// `unit` against lab_results.unit. Slash and ampersand forms such as
// "HIV 1/2" are deliberately not normalised; add an alias when real traffic
// shows one.

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

export function analyteItemForResult(result) {
  const { test_code = null, loinc_code = null } = result || {};
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

export function markerForResult(result) {
  const key = analyteItemForResult(result || {});
  return key ? LAB_ANALYTE_ITEMS[key].marker : null;
}

// Which orderable codes cover a set of missing items, in the order the
// pre-cath checklist places them: CBC (covers hb and platelets at once),
// ELECTROLYTES, CREATININE, then the three serology tests. Codes come from
// each item's own orderCodes[0] so the table stays the single source of truth.
const ORDER_PLACEMENT_SEQUENCE = Object.freeze([
  Object.freeze(['hb', 'platelets']),
  Object.freeze(['potassium']),
  Object.freeze(['creatinine']),
  Object.freeze(['hiv']),
  Object.freeze(['hbsag']),
  Object.freeze(['hcv']),
]);

export function orderCodesCovering(items = []) {
  const wanted = new Set(items || []);
  const codes = [];
  for (const group of ORDER_PLACEMENT_SEQUENCE) {
    const hit = group.find((key) => wanted.has(key));
    if (!hit) continue;
    const [primary] = LAB_ANALYTE_ITEMS[hit].orderCodes;
    if (!codes.includes(primary)) codes.push(primary);
  }
  return codes;
}
