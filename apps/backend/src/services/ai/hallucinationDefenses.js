/**
 * Hallucination + error defenses applied to every clinical AI draft.
 *
 * The workflow service calls `runOutputDefenses(draft, context)` after AI
 * generation and merges the returned safety flags before persisting. Defenses
 * are structured so each has a single code, severity, and message — downstream
 * review queues, audit logs, and the admin dashboard can filter by code.
 *
 * Defenses applied here are additive and non-destructive: they flag but do
 * not rewrite the draft. A blocking defense (CRITICAL severity) causes the
 * generation to be marked status='failed' in the workflow path; a HIGH
 * severity creates a mandatory review queue entry. MEDIUM+ is merged into
 * safetyFlags so reviewers see them inline.
 *
 * IMPORTANT — these defenses are HEURISTIC, not a proof of safety. An empty
 * flag list means "no heuristic flag fired", NOT "verified correct". A human
 * reviewer remains authoritative. Metadata producers must reflect that framing
 * (see `no_heuristic_flags` in clinicalAiWorkflowService) — never label a draft
 * "defenses passed" / "verified safe" on the basis of an empty flag list.
 */

import crypto from 'crypto';
import Ajv from 'ajv';
import logger from '../../logging/logger.js';

const UID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const PHONE_RE = /\b(?:\+?\d{1,3}[-\s]?)?(?:\d{10}|\d{5}[-\s]?\d{5})\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const MRN_RE = /\bMRN[\s:-]*([A-Z0-9-]{4,20})\b/gi;
const NUMERIC_RE = /\b(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|g|kg|ml|mL|l|L|mmHg|bpm|°C|°F|kg|lbs|hours?|days?|weeks?|months?|years?|%)\b/gi;

// Unit-normalization tables (AI-4a). Each known unit maps to a canonical
// dimension + a multiplier into that dimension's base unit. Two numeric
// claims are "the same" only when they share a dimension AND their
// base-unit magnitudes match (within a small epsilon for float dust).
// "120 mg" → mass 0.12 (base g); "0.12 g" → mass 0.12 (base g) ⇒ equal.
const UNIT_DIMENSIONS = {
  // mass — base gram
  mcg: { dim: 'mass', factor: 1e-6 },
  µg: { dim: 'mass', factor: 1e-6 },
  ug: { dim: 'mass', factor: 1e-6 },
  mg: { dim: 'mass', factor: 1e-3 },
  g: { dim: 'mass', factor: 1 },
  kg: { dim: 'mass', factor: 1e3 },
  // volume — base millilitre
  ml: { dim: 'volume', factor: 1 },
  l: { dim: 'volume', factor: 1e3 },
  // weight (separate from drug mass: body weight in kg/lbs)
  lbs: { dim: 'bodyweight', factor: 0.45359237 },
};

function flatten(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
  else if (Array.isArray(value)) value.forEach((item) => flatten(item, out));
  else if (typeof value === 'object') {
    for (const v of Object.values(value)) flatten(v, out);
  }
  return out;
}

function citationText(citations) {
  return flatten(citations).join(' \n ');
}

function draftText(draft) {
  return flatten(draft).join(' \n ');
}

function matchesInText(text, regex) {
  const out = new Set();
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    out.add(match[0]);
  }
  return [...out];
}

/**
 * Extract structured (value, unit) tuples from text, with a canonical key
 * that collapses unit-equivalent quantities. The canonical key is:
 *   - `${dim}:${baseMagnitude}` when the unit is dimension-mapped (so
 *     "120 mg" and "0.12 g" share a key), or
 *   - `${value}:${unit}` for units with no conversion (e.g. %, bpm, mmHg,
 *     days) — those are still compared, just without cross-unit folding.
 * `display` retains the original text for human-readable flag messages.
 */
function extractNumericTuples(text) {
  const tuples = [];
  const re = new RegExp(NUMERIC_RE.source, 'gi');
  let match;
  while ((match = re.exec(text)) !== null) {
    const rawValue = Number.parseFloat(match[1]);
    if (!Number.isFinite(rawValue)) continue;
    const rawUnit = String(match[2] || '').trim();
    const unitKey = rawUnit.toLowerCase();
    const mapping = UNIT_DIMENSIONS[unitKey];
    let canonical;
    if (mapping) {
      const base = rawValue * mapping.factor;
      // Round to a stable precision so float noise doesn't split keys.
      canonical = `${mapping.dim}:${base.toPrecision(12)}`;
    } else {
      canonical = `${rawValue}:${unitKey}`;
    }
    tuples.push({
      canonical,
      value: rawValue,
      unit: rawUnit,
      dim: mapping?.dim || null,
      base: mapping ? rawValue * mapping.factor : null,
      display: match[0].trim().toLowerCase(),
    });
  }
  return tuples;
}

function canonicalSet(text) {
  return new Set(extractNumericTuples(text).map((tuple) => tuple.canonical));
}

/**
 * Flag anything that looks like PII/PHI in the draft that isn't clearly
 * anchored by a citation. If the AI hallucinated a UID, phone, or email
 * that isn't in the chart packet, that's a leak risk — human review must
 * confirm before acceptance.
 */
export function detectPhiLeaks({ draft, citations = [], context = {} } = {}) {
  const flags = [];
  const body = draftText(draft);
  const citationsBody = citationText(citations);
  const allowedIdentifiers = new Set(
    flatten(context)
      .concat(flatten(citations))
      .flatMap((text) => (
        [
          ...matchesInText(text, UID_RE),
          ...matchesInText(text, PHONE_RE),
          ...matchesInText(text, EMAIL_RE),
          ...matchesInText(text, MRN_RE),
        ]
      ))
  );

  const leakedUids = matchesInText(body, UID_RE).filter((item) => !allowedIdentifiers.has(item));
  const leakedPhones = matchesInText(body, PHONE_RE).filter((item) => !allowedIdentifiers.has(item));
  const leakedEmails = matchesInText(body, EMAIL_RE).filter((item) => !allowedIdentifiers.has(item));
  const leakedMrns = matchesInText(body, MRN_RE).filter((item) => !allowedIdentifiers.has(item));

  if (leakedUids.length) {
    flags.push({
      severity: 'critical',
      code: 'PHI_LEAK_SUSPECTED',
      message: `Draft contains ${leakedUids.length} UID${leakedUids.length === 1 ? '' : 's'} not found in source citations`,
      metadata: { kind: 'uid', count: leakedUids.length },
    });
  }
  if (leakedPhones.length) {
    flags.push({
      severity: 'high',
      code: 'PHI_LEAK_SUSPECTED',
      message: `Draft contains ${leakedPhones.length} phone-like pattern${leakedPhones.length === 1 ? '' : 's'} not in citations`,
      metadata: { kind: 'phone', count: leakedPhones.length },
    });
  }
  if (leakedEmails.length) {
    flags.push({
      severity: 'high',
      code: 'PHI_LEAK_SUSPECTED',
      message: `Draft contains ${leakedEmails.length} email-like pattern${leakedEmails.length === 1 ? '' : 's'} not in citations`,
      metadata: { kind: 'email', count: leakedEmails.length },
    });
  }
  if (leakedMrns.length) {
    flags.push({
      severity: 'high',
      code: 'PHI_LEAK_SUSPECTED',
      message: `Draft contains ${leakedMrns.length} MRN reference${leakedMrns.length === 1 ? '' : 's'} not in citations`,
      metadata: { kind: 'mrn', count: leakedMrns.length },
    });
  }

  // Bonus: if the citation body mentions no UID but the draft mentions one
  // that's in the allowed set, that's still worth noting — the model at
  // least referenced a legitimate identifier.
  if (!citationsBody && body.length > 0) {
    flags.push({
      severity: 'medium',
      code: 'CITATIONS_EMPTY',
      message: 'Draft was produced without any source_citations',
    });
  }

  return flags;
}

/**
 * Extract (value, unit) tuples from a body of text and compare the draft's
 * numeric claims against what's verifiable in the chart context. Numbers
 * appearing in the draft that are not in the chart are flagged.
 *
 * AI-4a: comparison is unit-normalized. "120 mg" in the draft is treated as
 * present when the chart says "0.12 g" (and vice versa) — mass, volume, and
 * body-weight units are folded into a canonical base magnitude before
 * comparison, so a benign unit reformat no longer reads as a hallucinated
 * number, and a genuine value drift ("60 mg" → "120 mg") still surfaces.
 *
 * This is heuristic, not symbolic — a reviewer still has to confirm.
 */
export function extractNumericMismatches({ draft, context = {} } = {}) {
  const chartText = flatten(context).join(' ');
  const draftBody = draftText(draft);

  const chartCanonical = canonicalSet(chartText);
  const draftTuples = extractNumericTuples(draftBody);

  // Dedupe mismatches by canonical key but keep a human-readable sample.
  const seen = new Set();
  const mismatches = [];
  for (const tuple of draftTuples) {
    if (chartCanonical.has(tuple.canonical)) continue;
    if (seen.has(tuple.canonical)) continue;
    seen.add(tuple.canonical);
    mismatches.push(tuple.display);
  }
  if (!mismatches.length) return [];

  // Cap at 10 to avoid overflowing safety_flags column; the count is still
  // exposed in metadata.
  return [{
    severity: mismatches.length >= 3 ? 'high' : 'medium',
    code: 'UNVERIFIED_NUMERIC',
    message: `${mismatches.length} numeric value${mismatches.length === 1 ? '' : 's'} in draft not found in chart context`,
    metadata: { sample: mismatches.slice(0, 10), total: mismatches.length },
  }];
}

// AJV instance + compiled-validator cache (AI-4b). Compiling a JSON schema
// is non-trivial, and module output schemas are static per module_key, so we
// memoise compiled validators keyed by a hash of the schema. `coerceTypes`
// is OFF (we must not silently massage a draft into validity) and
// `allErrors` is ON so the flag can name every violation, not just the first.
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  allowUnionTypes: true,
});
const validatorCache = new Map();

function schemaCacheKey(schema) {
  try {
    return crypto.createHash('sha1').update(JSON.stringify(schema)).digest('hex');
  } catch {
    return null;
  }
}

function getCompiledValidator(schema) {
  const key = schemaCacheKey(schema);
  if (key && validatorCache.has(key)) return validatorCache.get(key);
  let validate = null;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    logger.warn('Clinical AI output schema failed to compile; using shallow key check', {
      error: err.message,
    });
    validate = null;
  }
  if (key) validatorCache.set(key, validate);
  return validate;
}

// Shallow required-top-level-keys check. Retained as a fallback for when a
// module schema can't be compiled by AJV, and as the floor when a schema
// only declares `required` with no property types.
function shallowRequiredCheck(draft, schema) {
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!required.length) return [];
  const draftKeys = draft && typeof draft === 'object' ? Object.keys(draft) : [];
  const missing = required.filter((field) => !draftKeys.includes(field));
  if (!missing.length) return [];
  return [{
    severity: 'high',
    code: 'SCHEMA_VIOLATION',
    message: `Draft missing required fields: ${missing.join(', ')}`,
    metadata: { missing, expected_required: required },
  }];
}

function describeAjvError(error) {
  const path = error.instancePath || error.schemaPath || '';
  const where = path ? `${path} ` : '';
  return `${where}${error.message}`.trim();
}

/**
 * Validate the draft against the module's configured output schema.
 *
 * AI-4b: this now runs real JSON-schema validation via AJV (already in the
 * dependency tree) instead of only checking that required top-level keys are
 * present. That catches wrong types, missing nested-required fields, enum
 * violations, and (when the schema declares it) extra/unexpected keys — the
 * shallow check passed all of those. AJV is configured NOT to coerce or
 * mutate the draft. If a schema can't be compiled, we degrade to the legacy
 * shallow required-keys check rather than failing open.
 */
export function validateOutputSchema({ draft, module } = {}) {
  const schema = module?.settings?.outputSchema;
  if (!schema || typeof schema !== 'object') return [];

  const validate = getCompiledValidator(schema);
  if (!validate) {
    // Compilation failed — fall back to the shallow required-keys floor.
    return shallowRequiredCheck(draft, schema);
  }

  const valid = validate(draft);
  if (valid) return [];

  const errors = Array.isArray(validate.errors) ? validate.errors : [];
  const messages = errors.map(describeAjvError).filter(Boolean);
  // Surface missing-required fields explicitly in metadata so existing
  // consumers/tests that look for `metadata.missing` keep working.
  const missing = errors
    .filter((error) => error.keyword === 'required')
    .map((error) => error.params?.missingProperty)
    .filter(Boolean);

  return [{
    severity: 'high',
    code: 'SCHEMA_VIOLATION',
    message: `Draft failed schema validation: ${(messages.length ? messages : ['invalid structure']).slice(0, 10).join('; ')}`,
    metadata: {
      missing,
      errors: messages.slice(0, 10),
      error_count: errors.length,
      expected_required: Array.isArray(schema.required) ? schema.required : [],
    },
  }];
}

/**
 * Per-risk-tier temperature. High-risk modules must not be creative; the
 * workflow service should pass this into the provider call so we don't
 * leave it to env defaults.
 */
export function temperatureForRisk(riskTier) {
  switch (String(riskTier || '').toLowerCase()) {
    case 'critical': return 0.0;
    case 'high': return 0.15;
    case 'medium': return 0.3;
    case 'low': return 0.5;
    default: return 0.15;
  }
}

/**
 * Run the full defense matrix and return an aggregated flag list. Callers
 * merge this into their existing safetyFlags.
 *
 * NOTE: an empty return means "no heuristic flag fired", not "verified
 * safe". Callers must not treat an empty list as a safety guarantee.
 */
export function runOutputDefenses({ draft, module, context = {}, citations = [] } = {}) {
  const flags = [];
  try {
    flags.push(...detectPhiLeaks({ draft, citations, context }));
    flags.push(...extractNumericMismatches({ draft, context }));
    flags.push(...validateOutputSchema({ draft, module }));
  } catch (err) {
    // Defenses failing must not break generation; log and continue.
    logger.warn('Hallucination defense matrix failed', { error: err.message });
  }
  return flags;
}

/**
 * Stable fingerprint of a draft for duplicate-detection and dead-letter
 * tracing. Not cryptographic — just a 64-bit prefix of SHA-256.
 */
export function draftFingerprint(draft) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(draft || {}))
    .digest('hex')
    .slice(0, 16);
}
