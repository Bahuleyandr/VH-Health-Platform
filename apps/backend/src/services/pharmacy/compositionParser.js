// Pure composition/strength/form parser for the pharmacy catalog. No DB, no IO.

// Minimal, extensible alias map for the top Indian-formulary combos. Keys are
// lowercased tokens; values are the canonical molecule. Extend as curation finds
// gaps (a missing alias only lowers confidence — it never produces a wrong merge).
const MOLECULE_ALIASES = {
  clav: 'clavulanic_acid',
  'clavulanic acid': 'clavulanic_acid',
  clavulanate: 'clavulanic_acid',
  d3: 'cholecalciferol',
  b12: 'cyanocobalamin',
};

function canonMolecule(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return '';
  const aliased = MOLECULE_ALIASES[t] || t;
  return aliased.replace(/\s+/g, '_');
}

export function compositionKey(genericName) {
  const text = String(genericName || '').trim();
  if (!text) return { key: '', activeIngredients: [], displayLabel: '', confidence: 'low', notes: 'empty' };
  const parts = text
    .split(/\s*(?:\+|&|\/|,|\band\b|-)\s*/i)
    .map(canonMolecule)
    .filter(Boolean);
  if (parts.length === 0) return { key: '', activeIngredients: [], displayLabel: text, confidence: 'low', notes: 'no-molecules' };
  const ingredients = [...new Set(parts)].sort();
  const key = ingredients.join('+');
  const displayLabel = ingredients.map((m) => m.replace(/_/g, ' ')).join(' + ');
  // A molecule we had to keep verbatim (no alias, multi-word) is slightly riskier.
  const confidence = ingredients.length > 0 ? 'high' : 'low';
  return { key, activeIngredients: ingredients, displayLabel, confidence, notes: '' };
}

const UNIT = '(mg|mcg|µg|g|ml|iu|%)';
const NUM = '(\\d+(?:\\.\\d+)?)';
const STRENGTH_RE = new RegExp(`${NUM}\\s*${UNIT}(?:\\s*/\\s*${NUM}\\s*${UNIT})?`, 'i');
const ALL_STRENGTHS_RE = new RegExp(`${NUM}\\s*${UNIT}`, 'gi');

function normUnit(u) {
  const x = String(u || '').toLowerCase();
  return x === 'µg' ? 'mcg' : x;
}

export function parseStrength(name) {
  const text = String(name || '');
  const m = STRENGTH_RE.exec(text);
  if (!m) return { display: null, key: null, components: null, confidence: 'low' };
  const a = m[1];
  const ua = normUnit(m[2]);
  let display = `${a} ${ua}`;
  let key = `${a}${ua}`;
  if (m[3]) { // ratio form NN unit / NN unit
    const ub = normUnit(m[4]);
    display = `${a}${ua}/${m[3]}${ub}`;
    key = `${a}${ua}/${m[3]}${ub}`;
  }
  // Per-ingredient components: only when ≥2 explicit "NN unit" tokens appear.
  const tokens = [...text.matchAll(ALL_STRENGTHS_RE)].map((t) => ({
    amount: Number(t[1]), unit: normUnit(t[2]),
  }));
  const components = tokens.length >= 2 ? tokens : null;
  return { display, key: key.toLowerCase().replace(/\s+/g, ''), components, confidence: 'high' };
}

const FORM_KEYWORDS = [
  ['injection', /\b(inj|injection|vial|iv|im)\b/i],
  ['syrup', /\bsyrup\b/i],
  ['suspension', /\bsuspension\b/i],
  ['drops', /\bdrops?\b/i],
  ['capsule', /\b(cap|capsule)\b/i],
  ['cream', /\bcream\b/i],
  ['ointment', /\boint(ment)?\b/i],
  ['gel', /\bgel\b/i],
  ['spray', /\bspray\b/i],
  ['inhaler', /\b(inhaler|mdi|rotacap)\b/i],
  ['tablet', /\b(tab|tablet)\b/i],
];
const RELEASE_RE = /\b(sr|er|xr|cr|mr)\b/i;

export function parseForm(name) {
  const text = String(name || '');
  let formKey = null;
  for (const [key, re] of FORM_KEYWORDS) { if (re.test(text)) { formKey = key; break; } }
  if (!formKey) formKey = 'tablet'; // oral-solid default for a bare "Name NNmg"
  const rel = RELEASE_RE.exec(text);
  const releaseKey = rel ? rel[1].toLowerCase() : null;
  const route = formKey === 'injection' ? 'parenteral' : null;
  return { form: formKey, formKey, releaseKey, route, confidence: formKey === 'tablet' ? 'medium' : 'high' };
}

export function parseCatalogRow(row) {
  const composition = compositionKey(row.generic_name || '');
  const strength = parseStrength(row.name || '');
  const form = parseForm(row.name || '');
  const isCombo = composition.activeIngredients.length >= 2;
  let curationReason = null;
  if (!composition.key) curationReason = 'unresolved';
  else if (isCombo && !strength.components) curationReason = 'partial_strength';
  else if (!strength.key) curationReason = 'partial_strength';
  const confidence = curationReason ? (composition.key ? 'medium' : 'low') : 'high';
  return { composition, strength, form, confidence, curationReason };
}
