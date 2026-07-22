// Pure (no IO) helpers for filling/validating a catalog row's strength_key from
// Aushadhi's plausibility-verified, swap-resolved strengths during the drug-reference
// import. Kept separate from scripts/import-drug-reference.mjs (which pulls in `pg`) so
// this logic is unit-testable without a DB driver.
//
// Why this exists: a catalog row's strength_key is parsed from the PHARMACIST's own row
// name; when that name carries no strength, strength_key is null and the alternatives
// endpoint can never confirm ANY sibling substitutable (its Boolean(strength_key) gate).
// We fill that gap ONLY from Aushadhi VERIFIED strengths — never a guess — and cross-
// check when the name DOES carry a strength, queueing disagreements for human curation.

// A parseStrength-compatible strength text built from verified molecules, in a
// deterministic molecule-name order so the derived key/components match the platform
// parser's own output shape. '' when any strength is missing.
export function strengthTextFromMolecules(molecules) {
  if (!Array.isArray(molecules) || molecules.length === 0) return '';
  const parts = [];
  for (const m of [...molecules].sort((a, b) => String(a?.molecule ?? '').localeCompare(String(b?.molecule ?? '')))) {
    const v = m?.strength_value;
    const u = String(m?.strength_unit ?? '').trim();
    if (typeof v !== 'number' || !Number.isFinite(v) || !u) return '';
    parts.push(`${v} ${u}`);
  }
  // Slash form so parseStrength emits the richer ratio key (500mg/125mg) for combos,
  // matching how Indian combo catalog names are usually written; a single molecule
  // yields just "500 mg".
  return parts.join(' / ');
}

// Canonical molecule+strength signature (for ambiguity detection across a brand's aliases).
export function strengthSignature(molecules) {
  return (molecules ?? [])
    .map((m) => `${String(m?.molecule ?? '').toLowerCase().trim()}:${m?.strength_value}:${String(m?.strength_unit ?? '').toLowerCase().trim()}`)
    .sort().join('|');
}

// The actual strength CONTENT of a parseStrength result as a sorted {amount|unit}
// multiset — tolerant of the parser's slash-vs-plus key quirk, so a genuine agreement is
// never mis-flagged as a mismatch on key formatting alone.
function strengthContent(parsed) {
  if (Array.isArray(parsed?.components) && parsed.components.length >= 2) {
    return parsed.components.map((c) => `${Number(c.amount)}|${String(c.unit ?? '').toLowerCase()}`).sort();
  }
  const m = /^(\d+(?:\.\d+)?)\s*([a-z%µ]+)$/i.exec(String(parsed?.display ?? parsed?.key ?? ''));
  return m ? [`${Number(m[1])}|${m[2].toLowerCase()}`] : [];
}

// Do two parseStrength results describe the same physical strength? A null/empty content
// never agrees (cannot confirm).
export function strengthsAgree(a, b) {
  const ca = strengthContent(a);
  const cb = strengthContent(b);
  if (ca.length === 0 || cb.length === 0 || ca.length !== cb.length) return false;
  return ca.every((x, i) => x === cb[i]);
}

// Decide the strength to import for a matched catalog row + provenance/mismatch. Pure —
// deps { parseStrength, compositionKey } are injected. Only fills when the verified
// molecules match THIS row's composition (molecule-set check), so a brand collision can
// never import the wrong composition's strengths.
export function resolveImportStrength({ catalogName, compKey, verified }, deps) {
  const { parseStrength, compositionKey } = deps;
  const catStrength = parseStrength(catalogName || '');
  const out = { strength: catStrength, provenance: 'catalog_name', mismatch: false, verifiedStrength: null };
  if (!verified || verified.ambiguous || !Array.isArray(verified.molecules)) return out;
  const vCompKey = compositionKey(verified.molecules.map((m) => m.molecule).join(' + ')).key;
  if (!vCompKey || vCompKey !== compKey) return out;               // molecule set must match
  const vStrength = parseStrength(strengthTextFromMolecules(verified.molecules));
  if (!vStrength.key) return out;
  out.verifiedStrength = vStrength;
  if (!catStrength.key) { out.strength = vStrength; out.provenance = 'aushadhi_verified'; return out; }
  if (!strengthsAgree(catStrength, vStrength)) out.mismatch = true; // keep catalog value, flag curation
  return out;
}
