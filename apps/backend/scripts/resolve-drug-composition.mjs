import pg from 'pg';

// A composition is a COMBINATION when its molecule set has >=2 members. Mirror
// the parser (compositionParser.parseCatalogRow: isCombo = activeIngredients
// .length >= 2) and the fail-safe /alternatives endpoint: derive is-combo from
// the molecule set, never from whether components happened to parse. The set is
// the explicit activeIngredients list when given, else the composition_key split.
function comboMoleculeCount(compositionKey, activeIngredients) {
  const ai = Array.isArray(activeIngredients) && activeIngredients.length
    ? activeIngredients
    : (compositionKey ? String(compositionKey).split('+') : []);
  return ai.filter((m) => String(m || '').trim()).length;
}

// A per-ingredient split is usable only when it is an array of >=2
// {ingredient, amount, unit}-shaped entries — the same >=2-component bar the
// parser applies before it will treat a combo strength as confirmable.
function hasValidComboSplit(strengthComponents) {
  if (!Array.isArray(strengthComponents) || strengthComponents.length < 2) return false;
  return strengthComponents.every((c) => c && typeof c === 'object'
    && c.ingredient != null && c.amount != null && c.unit != null);
}

export async function resolveCuration({ catalogId, compositionKey, displayLabel, activeIngredients,
  strengthComponents, confidence = 'high', reviewer, notes, connectionString } = {}) {
  const url = connectionString || process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    let compositionId = null;
    if (compositionKey) {
      const label = displayLabel || compositionKey.replace(/[_+]/g, (m) => (m === '+' ? ' + ' : ' '));
      const ai = activeIngredients || compositionKey.split('+');
      const cr = await client.query(
        `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
         VALUES ($1,$2,$3,'curated')
         ON CONFLICT (composition_key) DO UPDATE SET source='curated', updated_at=NOW() RETURNING id`,
        [compositionKey, label, ai]);
      compositionId = cr.rows[0].id;
    }
    // Combo substitutability safety gate at the point of curation: a combination
    // (>=2 molecules) cannot be marked `high` without a valid per-ingredient
    // strength split. Downgrade to `medium` (matching the parser's
    // partial_strength invariant) and leave the queue row actionable so it
    // returns to the worklist for a proper split — rather than persisting a
    // `high` that would defeat the combo substitutability gate.
    const isCombo = comboMoleculeCount(compositionKey, activeIngredients) >= 2;
    const comboSplitMissing = isCombo && confidence === 'high' && !hasValidComboSplit(strengthComponents);
    const effectiveConfidence = comboSplitMissing ? 'medium' : confidence;
    const queueStatus = comboSplitMissing ? 'open' : 'resolved';
    await client.query(
      `UPDATE pharmacy_catalog SET composition_id=$2, strength_components=$3,
         composition_source='curated', composition_confidence=$4, updated_at=NOW() WHERE id=$1`,
      [catalogId, compositionId, strengthComponents ? JSON.stringify(strengthComponents) : null, effectiveConfidence]);
    await client.query(
      `UPDATE drug_composition_curation_queue SET status=$4, reviewer=$2, notes=$3, updated_at=NOW()
       WHERE catalog_id=$1`,
      [catalogId, reviewer || null, notes || null, queueStatus]);
  } finally {
    await client.end();
  }
}
