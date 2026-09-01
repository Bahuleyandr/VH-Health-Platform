const MEDICATION_ROUTE_SYNONYMS = Object.freeze({
  iv: 'IV',
  'i.v.': 'IV',
  intravenous: 'IV',
  po: 'PO',
  'p.o.': 'PO',
  oral: 'PO',
  'by mouth': 'PO',
  'per oral': 'PO',
  im: 'IM',
  'i.m.': 'IM',
  intramuscular: 'IM',
  sc: 'SC',
  'sub-cut': 'SC',
  subcut: 'SC',
  subcutaneous: 'SC',
  sl: 'SL',
  sublingual: 'SL',
  pr: 'PR',
  rectal: 'PR',
  'per rectum': 'PR',
  ng: 'NG',
  nasogastric: 'NG',
  'ng tube': 'NG',
  topical: 'topical',
  top: 'topical',
  inhaled: 'inhaled',
  inhalation: 'inhaled',
  nebulised: 'inhaled',
  nebulized: 'inhaled',
  neb: 'inhaled',
  transdermal: 'transdermal',
  patch: 'transdermal'
});

export function canonicalMedicationRoute(rawRoute) {
  const trimmed = String(rawRoute ?? '')
    .normalize('NFKC')
    .trim();
  if (!trimmed) return null;
  return MEDICATION_ROUTE_SYNONYMS[trimmed.toLowerCase()] || trimmed;
}

export function comparableMedicationRoute(rawRoute) {
  return String(canonicalMedicationRoute(rawRoute) || '').toLowerCase();
}
