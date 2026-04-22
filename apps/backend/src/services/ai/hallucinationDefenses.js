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
 */

import crypto from 'crypto';
import logger from '../../logging/logger.js';

const UID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const PHONE_RE = /\b(?:\+?\d{1,3}[-\s]?)?(?:\d{10}|\d{5}[-\s]?\d{5})\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const MRN_RE = /\bMRN[\s:-]*([A-Z0-9-]{4,20})\b/gi;
const NUMERIC_RE = /\b(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|L|mmHg|bpm|°C|°F|kg|lbs|hours?|days?|weeks?|months?|years?|%)\b/gi;

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
 * This is heuristic, not symbolic — a reviewer still has to confirm. But
 * when AI hallucinates e.g. "120 mg" when the chart had "60 mg", this
 * surfaces it.
 */
export function extractNumericMismatches({ draft, context = {} } = {}) {
  const chartText = flatten(context).join(' ');
  const draftBody = draftText(draft);

  const chartTuples = new Set(
    matchesInText(chartText, NUMERIC_RE).map((text) => text.toLowerCase())
  );
  const draftTuples = matchesInText(draftBody, NUMERIC_RE).map((text) => text.toLowerCase());

  const mismatches = draftTuples.filter((tuple) => !chartTuples.has(tuple));
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

/**
 * Validate the draft against the module's configured output schema. Only
 * shallow: verify required top-level keys are present. JSON-schema full
 * validation would require adding a dep; this keeps the floor free.
 */
export function validateOutputSchema({ draft, module } = {}) {
  const schema = module?.settings?.outputSchema;
  if (!schema || typeof schema !== 'object') return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!required.length) return [];

  const draftKeys = draft && typeof draft === 'object' ? Object.keys(draft) : [];
  const missing = required.filter((key) => !draftKeys.includes(key));
  if (!missing.length) return [];

  return [{
    severity: 'high',
    code: 'SCHEMA_VIOLATION',
    message: `Draft missing required fields: ${missing.join(', ')}`,
    metadata: { missing, expected_required: required },
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
