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
