/**
 * Policy Diff / Regulation Watcher.
 *
 * Given two versions (previous + current) of a policy/regulation/payer-rule
 * document (or an explicit diff), computes a structural diff
 * (added/removed/modified sections), classifies the overall impact area
 * (clinical / billing / access / privacy / infection_control / pharmacy /
 * none / mixed) and severity (critical / high / moderate / low / unknown),
 * and produces a reviewer-friendly summary of what changed and who needs
 * to be notified.
 *
 * Review-only: compliance/legal team approves before any downstream
 * rollout. The module never auto-activates, auto-revokes, or auto-publishes
 * a policy. Rules are authoritative.
 *
 * Graceful degradation: if the policy-diff schema is missing, the service
 * returns a schema_unavailable payload rather than crashing.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'policy_regulation_watcher';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support compliance and legal review of policy, regulation, and payer-rule changes. Rules are authoritative. Return JSON only. Never auto-activate, auto-revoke, auto-publish, or otherwise enforce a policy — this is decision support only and compliance + legal review is required before any downstream rollout.',
  user_prompt_template:
    'Given the rule-based diff evaluation (impact_area, severity, added / removed / modified sections, impacted roles, signals) for a policy or regulation change, return a concise narrative summary and keys: summary, recommended_actions, source_citations, safety_flags. Do not invent diff content, do not override the rule-based impact_area or severity.',
};

// ---------- Constants (exported) ----------------------------------------

export const IMPACT_AREAS = new Set([
  'clinical',
  'billing',
  'access',
  'privacy',
  'infection_control',
  'pharmacy',
  'none',
  'mixed',
  'unknown',
]);

// Priority: higher index = higher priority (escalate towards it).
export const IMPACT_PRIORITY = [
  'unknown',
  'none',
  'access',
  'pharmacy',
  'infection_control',
  'billing',
  'privacy',
  'clinical',
  'mixed',
];

export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);

export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'Compliance + legal review required — decision support only; the module never auto-activates or revokes a policy.';

// Keyword maps for classification (case-insensitive whole-word matching).
const CLINICAL_KEYWORDS = [
  'patient', 'diagnosis', 'treatment', 'medication', 'dose', 'vitals',
  'assessment', 'triage', 'discharge', 'consent', 'nursing', 'safety',
  'allergy', 'prescription',
];
const BILLING_KEYWORDS = [
  'billing', 'claim', 'payer', 'reimburse', 'coding', 'icd10', 'cpt',
  'denial', 'appeal', 'copay', 'deductible', 'invoice', 'insurance',
  'revenue',
];
const ACCESS_KEYWORDS = [
  'role', 'permission', 'access', 'login', 'credential', 'password',
  'mfa', 'authentication', 'authorization', 'audit',
];
const PRIVACY_KEYWORDS = [
  'phi', 'hipaa', 'consent', 'disclosure', 'breach', 'gdpr',
  'confidentiality', 'retention', 'anonymize', 'de-identified',
  'deidentified', 'privacy',
];
const INFECTION_KEYWORDS = [
  'infection', 'sepsis', 'isolation', 'hand hygiene', 'outbreak',
  'contact precaution', 'airborne', 'droplet', 'ppe', 'sterile',
];
const PHARMACY_KEYWORDS = [
  'pharmacy', 'pharmacist', 'medication', 'dispense', 'inventory',
  'formulary', 'controlled substance', 'narcotic', 'antibiotic',
];

const CLINICAL_KEYWORD_SET = new Set(CLINICAL_KEYWORDS);
const BILLING_KEYWORD_SET = new Set(BILLING_KEYWORDS);
const ACCESS_KEYWORD_SET = new Set(ACCESS_KEYWORDS);
const PRIVACY_KEYWORD_SET = new Set(PRIVACY_KEYWORDS);
const INFECTION_KEYWORD_SET = new Set(INFECTION_KEYWORDS);
const PHARMACY_KEYWORD_SET = new Set(PHARMACY_KEYWORDS);

// Role maps.
const CLINICAL_ROLES = ['DOCTOR', 'NURSE'];
const BILLING_ROLES = ['BILLING', 'ADMIN'];
const ACCESS_ROLES = ['ADMIN', 'IT_ADMIN'];
const PRIVACY_ROLES = ['ADMIN', 'COMPLIANCE_LEAD', 'LEGAL'];
const INFECTION_ROLES = ['DOCTOR', 'NURSE', 'INFECTION_CONTROL'];
const PHARMACY_ROLES = ['PHARMACY_STAFF', 'PHARMACIST'];

// ---------- Small helpers -----------------------------------------------

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function toNullableDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function uniqueCitations(citations) {
  const seen = new Set();
  return asArray(citations).filter((citation) => {
    if (!citation) return false;
    const key = `${citation.source_type}:${citation.source_id}:${citation.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of asArray(list)) {
    const s = cleanText(item);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// Escape a keyword for safe inclusion in a regex. Note: '-' is placed at the
// start of the character class to avoid an eslint no-useless-escape warning
// and to avoid treating it as a range operator.
function escapeRegex(str) {
  return String(str || '').replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function previewBody(body, limit = 200) {
  const text = cleanText(body);
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

// ---------- Pure helpers (exported) -------------------------------------

/**
 * Lowercases, trims, collapses whitespace.
 */
export function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Splits policy text into sections. Rules:
 *   - Section headers matched by /^(?:section|§|\d+(?:\.\d+)*\.?)\s+/im
 *     OR a line of all-caps text followed by non-empty content.
 *   - Falls back to splitting by blank-line boundaries (/\n\s*\n/).
 *   - Returns [{ header, body }]. header may be the first line of the
 *     section.
 *   - Empty input → empty array.
 */
export function splitSections(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return [];

  const lines = raw.split(/\r?\n/);
  const headerRe = /^(?:section\b|§|\d+(?:\.\d+)*\.?)\s+/i;
  const allCapsRe = /^[A-Z0-9 _\-.,:;()'"/]+$/;

  // First try: structural section detection.
  const sections = [];
  let current = null;
  const flush = () => {
    if (current) {
      const header = cleanText(current.header);
      const body = current.body.join('\n').replace(/^\s+|\s+$/g, '');
      sections.push({ header: header || cleanText(body.split('\n')[0] || ''), body });
      current = null;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      if (current) current.body.push('');
      continue;
    }
    const headerMatch = headerRe.test(trimmed);
    // All-caps heading must have >= 2 alpha chars, not be a simple sentence,
    // and the next non-empty line must be non-empty content.
    const alphaOnly = trimmed.replace(/[^A-Za-z]/g, '');
    const isAllCapsCandidate = alphaOnly.length >= 2
      && allCapsRe.test(trimmed)
      && alphaOnly === alphaOnly.toUpperCase()
      && alphaOnly.toLowerCase() !== alphaOnly;
    let allCapsHeader = false;
    if (isAllCapsCandidate) {
      // Look ahead for non-empty content line.
      for (let j = i + 1; j < lines.length; j += 1) {
        const look = lines[j].trim();
        if (look) {
          allCapsHeader = true;
          break;
        }
      }
    }
    if (headerMatch || allCapsHeader) {
      flush();
      current = { header: trimmed, body: [] };
    } else {
      if (!current) {
        current = { header: trimmed, body: [trimmed] };
      } else {
        current.body.push(trimmed);
      }
    }
  }
  flush();

  if (sections.length > 0) {
    // Clean each section: trim body, ensure header non-empty by falling back
    // to the first body line if needed.
    return sections
      .map((s) => {
        const body = cleanText(s.body);
        const headerFromBody = body.split(/\s+/).slice(0, 10).join(' ');
        return {
          header: s.header || headerFromBody,
          body,
        };
      })
      .filter((s) => s.header || s.body);
  }

  // Fallback: blank-line split.
  const chunks = raw.split(/\n\s*\n/);
  return chunks
    .map((chunk) => {
      const clean = chunk.replace(/^\s+|\s+$/g, '');
      if (!clean) return null;
      const firstLine = clean.split(/\r?\n/)[0] || '';
      return {
        header: cleanText(firstLine),
        body: clean,
      };
    })
    .filter(Boolean);
}

/**
 * Compute structural diff between previous and current section arrays.
 * Match by normalized header equality. If no header, fall back to first-line
 * normalized match.
 *
 * Returns { added, removed, modified, unchanged_count }.
 */
export function computeSectionDiff({ previousSections = [], currentSections = [] } = {}) {
  const prev = asArray(previousSections);
  const curr = asArray(currentSections);

  const keyOf = (section) => {
    if (!section) return '';
    const header = normalizeText(section.header);
    if (header) return header;
    const firstLine = normalizeText(String(section.body || '').split(/\r?\n/)[0] || '');
    return firstLine;
  };

  const prevMap = new Map();
  for (const s of prev) {
    const k = keyOf(s);
    if (!prevMap.has(k)) prevMap.set(k, s);
  }
  const currMap = new Map();
  for (const s of curr) {
    const k = keyOf(s);
    if (!currMap.has(k)) currMap.set(k, s);
  }

  const added = [];
  const removed = [];
  const modified = [];
  let unchanged = 0;

  for (const [key, section] of currMap) {
    if (!prevMap.has(key)) {
      added.push({ header: cleanText(section.header) || key, body: String(section.body || '') });
    } else {
      const before = prevMap.get(key);
      const beforeBody = normalizeText(before.body);
      const afterBody = normalizeText(section.body);
      if (beforeBody === afterBody) {
        unchanged += 1;
      } else {
        modified.push({
          header: cleanText(section.header) || cleanText(before.header) || key,
          before: String(before.body || ''),
          after: String(section.body || ''),
        });
      }
    }
  }

  for (const [key, section] of prevMap) {
    if (!currMap.has(key)) {
      removed.push({ header: cleanText(section.header) || key, body: String(section.body || '') });
    }
  }

  return {
    added,
    removed,
    modified,
    unchanged_count: unchanged,
  };
}

/**
 * Case-insensitive whole-word/phrase matches of keywordSet in text.
 * Returns { hits, count } where hits is the deduped lowercase list of
 * keywords that matched.
 */
export function detectImpactByKeywords({ text = '', keywordSet } = {}) {
  const src = String(text || '');
  const keywords = keywordSet instanceof Set ? Array.from(keywordSet) : asArray(keywordSet);
  if (!src || !keywords.length) return { hits: [], count: 0 };
  const hits = [];
  const seen = new Set();
  for (const kwRaw of keywords) {
    const kw = String(kwRaw || '').trim();
    if (!kw) continue;
    const escaped = escapeRegex(kw);
    let re;
    try {
      re = new RegExp(`\\b${escaped}\\b`, 'i');
    } catch {
      continue;
    }
    if (re.test(src)) {
      const lower = kw.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        hits.push(lower);
      }
    }
  }
  return { hits, count: hits.length };
}

/**
 * Concatenate all diff text and classify impact area.
 *   - No hits anywhere → 'none'
 *   - 1 bucket has hits → that bucket
 *   - 2+ buckets have hits → 'mixed'
 * Ties are resolved by IMPACT_PRIORITY (highest index wins).
 *
 * Returns { impact_area, impact_area_scores } where scores is an object of
 * hit counts per bucket.
 */
export function classifyImpactArea({ addedText = '', removedText = '', modifiedText = '' } = {}) {
  const combined = `${String(addedText || '')}\n${String(removedText || '')}\n${String(modifiedText || '')}`;

  const clinical = detectImpactByKeywords({ text: combined, keywordSet: CLINICAL_KEYWORD_SET });
  const billing = detectImpactByKeywords({ text: combined, keywordSet: BILLING_KEYWORD_SET });
  const access = detectImpactByKeywords({ text: combined, keywordSet: ACCESS_KEYWORD_SET });
  const privacy = detectImpactByKeywords({ text: combined, keywordSet: PRIVACY_KEYWORD_SET });
  const infection = detectImpactByKeywords({ text: combined, keywordSet: INFECTION_KEYWORD_SET });
  const pharmacy = detectImpactByKeywords({ text: combined, keywordSet: PHARMACY_KEYWORD_SET });

  const impact_area_scores = {
    clinical: clinical.count,
    billing: billing.count,
    access: access.count,
    privacy: privacy.count,
    infection_control: infection.count,
    pharmacy: pharmacy.count,
  };

  const active = Object.entries(impact_area_scores).filter(([, n]) => n > 0);

  let impact_area = 'none';
  if (!active.length) {
    impact_area = 'none';
  } else if (active.length === 1) {
    impact_area = active[0][0];
  } else {
    impact_area = 'mixed';
  }

  return { impact_area, impact_area_scores };
}

/**
 * Severity classification rules:
 *   impactArea 'privacy' AND privacyHits >= 2 → 'critical'
 *   impactArea 'clinical' AND clinicalHits >= 3 → 'critical'
 *   (added+removed+modified) >= 10 → 'high'
 *   (added+removed+modified) >= 5 OR impactArea in ['privacy','clinical','mixed'] → 'moderate'
 *   (added+removed+modified) >= 1 → 'low'
 *   else → 'unknown'
 *
 * Returns { severity, signals } where signals is a list of reason codes.
 */
export function classifySeverity({
  addedCount = 0,
  removedCount = 0,
  modifiedCount = 0,
  impactArea = 'none',
  privacyHits = 0,
  clinicalHits = 0,
} = {}) {
  const added = toNumber(addedCount, 0);
  const removed = toNumber(removedCount, 0);
  const modified = toNumber(modifiedCount, 0);
  const total = added + removed + modified;
  const pHits = toNumber(privacyHits, 0);
  const cHits = toNumber(clinicalHits, 0);
  const area = IMPACT_AREAS.has(impactArea) ? impactArea : 'unknown';

  const signals = [];

  if (area === 'privacy' && pHits >= 2) {
    signals.push({
      code: 'PRIVACY_CRITICAL',
      detail: `Privacy-impacting diff with ${pHits} privacy keyword hits.`,
    });
    return { severity: 'critical', signals };
  }
  if (area === 'clinical' && cHits >= 3) {
    signals.push({
      code: 'CLINICAL_CRITICAL',
      detail: `Clinical-impacting diff with ${cHits} clinical keyword hits.`,
    });
    return { severity: 'critical', signals };
  }
  if (total >= 10) {
    signals.push({
      code: 'LARGE_DIFF',
      detail: `Diff touches ${total} sections (>= 10).`,
    });
    return { severity: 'high', signals };
  }
  if (total >= 5) {
    signals.push({
      code: 'MEDIUM_DIFF',
      detail: `Diff touches ${total} sections (>= 5).`,
    });
    return { severity: 'moderate', signals };
  }
  if (area === 'privacy' || area === 'clinical' || area === 'mixed') {
    signals.push({
      code: 'SENSITIVE_IMPACT_AREA',
      detail: `Impact area '${area}' requires closer review even on a small diff.`,
    });
    return { severity: 'moderate', signals };
  }
  if (total >= 1) {
    signals.push({
      code: 'SMALL_DIFF',
      detail: `Diff touches ${total} section(s).`,
    });
    return { severity: 'low', signals };
  }

  signals.push({
    code: 'NO_DIFF',
    detail: 'No added, removed, or modified sections detected.',
  });
  return { severity: 'unknown', signals };
}

/**
 * Returns a deduped array of role strings based on which keyword buckets
 * got hits. For 'mixed' the union of all roles for buckets with hits is
 * returned.
 */
export function deriveImpactedRoles({ impactArea = 'none', bucketHits = {} } = {}) {
  const area = IMPACT_AREAS.has(impactArea) ? impactArea : 'unknown';
  const hits = bucketHits && typeof bucketHits === 'object' ? bucketHits : {};
  const roles = [];

  const bucketHasHits = (bucket) => {
    const raw = hits[bucket];
    if (Array.isArray(raw)) return raw.length > 0;
    if (typeof raw === 'number') return raw > 0;
    return false;
  };

  const push = (list) => {
    for (const role of asArray(list)) roles.push(role);
  };

  if (area === 'mixed') {
    if (bucketHasHits('clinical')) push(CLINICAL_ROLES);
    if (bucketHasHits('billing')) push(BILLING_ROLES);
    if (bucketHasHits('access')) push(ACCESS_ROLES);
    if (bucketHasHits('privacy')) push(PRIVACY_ROLES);
    if (bucketHasHits('infection_control')) push(INFECTION_ROLES);
    if (bucketHasHits('pharmacy')) push(PHARMACY_ROLES);
  } else if (area === 'clinical') {
    push(CLINICAL_ROLES);
  } else if (area === 'billing') {
    push(BILLING_ROLES);
  } else if (area === 'access') {
    push(ACCESS_ROLES);
  } else if (area === 'privacy') {
    push(PRIVACY_ROLES);
  } else if (area === 'infection_control') {
    push(INFECTION_ROLES);
  } else if (area === 'pharmacy') {
    push(PHARMACY_ROLES);
  }

  // Dedupe.
  const seen = new Set();
  const out = [];
  for (const r of roles) {
    const val = String(r || '').trim();
    if (!val || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
  }
  return out;
}

/**
 * Escalate a list of impact_area strings to the highest per IMPACT_PRIORITY.
 */
export function escalateImpactArea(list) {
  const arr = asArray(list);
  if (!arr.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = IMPACT_PRIORITY.indexOf('unknown');
  for (const area of arr) {
    const normalized = IMPACT_AREAS.has(area) ? area : 'unknown';
    const idx = IMPACT_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Escalate a list of severity strings to the highest per SEVERITY_PRIORITY.
 */
export function escalateSeverity(list) {
  const arr = asArray(list);
  if (!arr.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = SEVERITY_PRIORITY.indexOf('unknown');
  for (const sev of arr) {
    const normalized = SEVERITIES.has(sev) ? sev : 'unknown';
    const idx = SEVERITY_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Build reviewer-facing action list. Always ends with the compliance/legal
 * disclaimer. Specific sentences per impact_area. When impactedRoles is
 * non-empty, includes a "Notify {role1, role2} before effective date."
 * line.
 */
export function buildPolicyActions({
  impactArea = 'none',
  severity = 'low',
  impactedRoles = [],
  signals = [],
} = {}) {
  const area = IMPACT_AREAS.has(impactArea) ? impactArea : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const roles = uniqueStrings(impactedRoles);
  const actions = [];
  const seen = new Set();
  const push = (line) => {
    const text = cleanText(line);
    if (!text || seen.has(text)) return;
    seen.add(text);
    actions.push(text);
  };

  switch (area) {
    case 'clinical':
      push('Flag clinical policy change for medical director and nursing leadership review.');
      push('Align affected clinical protocols (triage, consent, medication) with the new policy before go-live.');
      break;
    case 'billing':
      push('Notify all billing staff of claim/appeal changes.');
      push('Coordinate with revenue cycle to update coding maps and payer rule references.');
      break;
    case 'access':
      push('Review role/permission configuration in the admin console against the updated access policy.');
      push('Coordinate with IT admin to stage credential or authentication workflow changes.');
      break;
    case 'privacy':
      push('Escalate privacy policy change to the compliance lead and legal team immediately.');
      push('Audit data retention, disclosure, and consent flows for alignment with the revised privacy rules.');
      break;
    case 'infection_control':
      push('Alert the infection control committee and nursing leadership of the updated precaution rules.');
      push('Refresh isolation, hand hygiene, and PPE signage before the effective date.');
      break;
    case 'pharmacy':
      push('Notify pharmacy leadership of formulary or controlled-substance policy updates.');
      push('Review dispense and inventory workflows for alignment with the revised pharmacy policy.');
      break;
    case 'mixed':
      push('Multiple impact areas detected — coordinate a cross-functional review with compliance, clinical, billing, and IT leads.');
      push('Assign owners per affected area to track alignment before the effective date.');
      break;
    case 'none':
      push('No material policy change detected; file for audit trail and continue monitoring.');
      break;
    case 'unknown':
    default:
      push('Impact could not be determined from the diff; route to compliance for manual triage.');
      break;
  }

  if (sev === 'critical') {
    push('Severity is critical — do not defer; schedule compliance + legal review same day.');
  } else if (sev === 'high') {
    push('Severity is high — schedule compliance review before the policy effective date.');
  }

  if (roles.length) {
    push(`Notify ${roles.join(', ')} before effective date.`);
  }

  for (const signal of asArray(signals)) {
    const code = signal?.code;
    if (!code) continue;
    if (code === 'PRIVACY_CRITICAL') {
      push('Privacy-related change detected — trigger the breach-notification readiness checklist.');
    } else if (code === 'CLINICAL_CRITICAL') {
      push('Clinical-safety change detected — ensure affected care pathways are revalidated.');
    } else if (code === 'LARGE_DIFF') {
      push('Large diff — request a line-by-line legal review rather than a spot check.');
    }
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-line human summary for the diff row.
 */
export function summarizePolicyDiff({
  policyKey,
  impactArea,
  severity,
  addedCount,
  removedCount,
  modifiedCount,
} = {}) {
  const key = cleanText(policyKey) || 'policy';
  const area = IMPACT_AREAS.has(impactArea) ? impactArea : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const added = toNumber(addedCount, 0);
  const removed = toNumber(removedCount, 0);
  const modified = toNumber(modifiedCount, 0);
  return `Policy ${key}: impact=${area} severity=${sev} (+${added}/-${removed}/~${modified} sections).`;
}

/**
 * Compose the full evaluation: split sections, compute diff, classify
 * impact + severity, derive impacted roles, and return structured output
 * suitable for persistence.
 *
 * If `explicitDiff` is provided (`{ added, removed, modified }` arrays of
 * `{ header?, body }`), it is used directly. Otherwise both texts are
 * split into sections and diffed.
 */
export function evaluatePolicyDiff({ previousText = '', currentText = '', explicitDiff = null } = {}) {
  let added = [];
  let removed = [];
  let modified = [];
  let unchanged_count = 0;

  if (explicitDiff && typeof explicitDiff === 'object') {
    added = asArray(explicitDiff.added).map((s) => ({
      header: cleanText(s?.header) || cleanText(String(s?.body || '').split('\n')[0] || ''),
      body: String(s?.body || ''),
    }));
    removed = asArray(explicitDiff.removed).map((s) => ({
      header: cleanText(s?.header) || cleanText(String(s?.body || '').split('\n')[0] || ''),
      body: String(s?.body || ''),
    }));
    modified = asArray(explicitDiff.modified).map((s) => ({
      header: cleanText(s?.header) || cleanText(String(s?.after || s?.body || '').split('\n')[0] || ''),
      before: String(s?.before || ''),
      after: String(s?.after || s?.body || ''),
    }));
  } else {
    const previousSections = splitSections(previousText);
    const currentSections = splitSections(currentText);
    const diff = computeSectionDiff({ previousSections, currentSections });
    added = diff.added;
    removed = diff.removed;
    modified = diff.modified;
    unchanged_count = diff.unchanged_count;
  }

  const addedText = added.map((s) => `${s.header || ''}\n${s.body || ''}`).join('\n\n');
  const removedText = removed.map((s) => `${s.header || ''}\n${s.body || ''}`).join('\n\n');
  const modifiedText = modified
    .map((s) => `${s.header || ''}\n${s.before || ''}\n${s.after || s.body || ''}`)
    .join('\n\n');

  const combinedText = `${addedText}\n${removedText}\n${modifiedText}`;

  const classification = classifyImpactArea({ addedText, removedText, modifiedText });

  // Gather per-bucket hit lists (not just counts) for role derivation.
  const bucket_hits = {
    clinical: detectImpactByKeywords({ text: combinedText, keywordSet: CLINICAL_KEYWORD_SET }).hits,
    billing: detectImpactByKeywords({ text: combinedText, keywordSet: BILLING_KEYWORD_SET }).hits,
    access: detectImpactByKeywords({ text: combinedText, keywordSet: ACCESS_KEYWORD_SET }).hits,
    privacy: detectImpactByKeywords({ text: combinedText, keywordSet: PRIVACY_KEYWORD_SET }).hits,
    infection_control: detectImpactByKeywords({ text: combinedText, keywordSet: INFECTION_KEYWORD_SET }).hits,
    pharmacy: detectImpactByKeywords({ text: combinedText, keywordSet: PHARMACY_KEYWORD_SET }).hits,
  };

  const severityResult = classifySeverity({
    addedCount: added.length,
    removedCount: removed.length,
    modifiedCount: modified.length,
    impactArea: classification.impact_area,
    privacyHits: bucket_hits.privacy.length,
    clinicalHits: bucket_hits.clinical.length,
  });

  const impactedRoles = deriveImpactedRoles({
    impactArea: classification.impact_area,
    bucketHits: bucket_hits,
  });

  const diff_sections = [
    ...added.map((s) => ({
      change_type: 'added',
      header: s.header || '',
      preview: previewBody(s.body, 200),
    })),
    ...removed.map((s) => ({
      change_type: 'removed',
      header: s.header || '',
      preview: previewBody(s.body, 200),
    })),
    ...modified.map((s) => ({
      change_type: 'modified',
      header: s.header || '',
      preview: previewBody(s.after || s.before, 200),
    })),
  ];

  return {
    impact_area: classification.impact_area,
    severity: severityResult.severity,
    added_section_count: added.length,
    removed_section_count: removed.length,
    modified_section_count: modified.length,
    unchanged_section_count: unchanged_count,
    diff_sections,
    impacted_roles: impactedRoles,
    signals: severityResult.signals,
    bucket_hits,
  };
}

// ---------- DB helpers --------------------------------------------------

async function getActivePrompt(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT version, system_prompt, user_prompt_template
       FROM clinical_ai_prompts
       WHERE tenant_id = $1::uuid
         AND module_key = $2
       ORDER BY active DESC, activated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      tenantId,
      MODULE_KEY
    );
    return (rows && rows[0]) || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  prompt,
  metadata,
}) {
  const usage = aiResult?.usage || {};
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, metadata, created_at, updated_at)
       VALUES ($1::uuid, NULL, NULL, $2, $2, $3, $4,
               $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
               $12::uuid, $13, $14, $15, $16, $17::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt?.version || 'v1',
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      Boolean(aiResult?.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      requestedBy,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? 0,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Policy diff generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, policyKey, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, NULL, NULL, 'pending', $4::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'COMPLIANCE_LEAD', 'LEGAL'],
        source: 'policy_regulation_watcher',
        policy_key: policyKey || null,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Policy diff review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizeDiffRow(row) {
  if (!row) return row;
  return {
    ...row,
    added_section_count: toNumber(row.added_section_count, 0),
    removed_section_count: toNumber(row.removed_section_count, 0),
    modified_section_count: toNumber(row.modified_section_count, 0),
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

async function insertDiffRow({
  tenantId,
  policyKey,
  policyTitle,
  source,
  previousVersion,
  currentVersion,
  effectiveDate,
  generationId,
  impactArea,
  severity,
  addedCount,
  removedCount,
  modifiedCount,
  diffSections,
  impactedRoles,
  signals,
  summary,
  recommendedActions,
  sourceCitations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_policy_diffs
         (tenant_id, policy_key, policy_title, source, previous_version, current_version,
          effective_date, generation_id, impact_area, severity,
          added_section_count, removed_section_count, modified_section_count,
          diff_sections, impacted_roles, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6,
               $7::date, $8, $9, $10,
               $11, $12, $13,
               $14::jsonb, $15::jsonb, $16::jsonb, $17, $18::jsonb,
               $19::jsonb, $20::jsonb, 'pending', $21::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, policy_key, policy_title, source,
                 previous_version, current_version, effective_date,
                 generation_id, impact_area, severity,
                 added_section_count, removed_section_count, modified_section_count,
                 diff_sections, impacted_roles, signals, summary, recommended_actions,
                 source_citations, safety_flags, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, metadata,
                 created_at, updated_at`,
      tenantId,
      policyKey,
      policyTitle,
      source,
      previousVersion,
      currentVersion,
      effectiveDate,
      generationId,
      IMPACT_AREAS.has(impactArea) ? impactArea : 'unknown',
      SEVERITIES.has(severity) ? severity : 'unknown',
      toNumber(addedCount, 0),
      toNumber(removedCount, 0),
      toNumber(modifiedCount, 0),
      JSON.stringify(asArray(diffSections)),
      JSON.stringify(asArray(impactedRoles)),
      JSON.stringify(asArray(signals)),
      summary,
      JSON.stringify(asArray(recommendedActions)),
      JSON.stringify(asArray(sourceCitations)),
      JSON.stringify(asArray(safetyFlags)),
      JSON.stringify(metadata || {})
    );
    return normalizeDiffRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------- Public API --------------------------------------------------

export async function generatePolicyDiff({
  req = null,
  policyKey,
  policyTitle = null,
  source = null,
  previousVersion = null,
  currentVersion = null,
  effectiveDate = null,
  previousText = '',
  currentText = '',
  explicitDiff = null,
  metadata = {},
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const key = cleanText(policyKey);
  if (!key) throw AppError.badRequest('policy_key is required');
  const title = policyTitle ? cleanText(policyTitle) : null;
  const safeSource = source ? cleanText(source) : null;
  const prevVer = previousVersion ? cleanText(previousVersion) : null;
  const currVer = currentVersion ? cleanText(currentVersion) : null;
  const effDate = toNullableDate(effectiveDate);

  // Pure evaluation.
  const evaluation = evaluatePolicyDiff({ previousText, currentText, explicitDiff });

  const summary = summarizePolicyDiff({
    policyKey: key,
    impactArea: evaluation.impact_area,
    severity: evaluation.severity,
    addedCount: evaluation.added_section_count,
    removedCount: evaluation.removed_section_count,
    modifiedCount: evaluation.modified_section_count,
  });

  const recommendedActions = buildPolicyActions({
    impactArea: evaluation.impact_area,
    severity: evaluation.severity,
    impactedRoles: evaluation.impacted_roles,
    signals: evaluation.signals,
  });

  // Citations: one per source (policy source, previous/current version
  // refs), and the policy_diff_rules reference.
  const citations = [
    {
      source_type: 'policy',
      source_id: key,
      label: title ? `Policy — ${title} (${key})` : `Policy — ${key}`,
      timestamp: null,
    },
  ];
  if (safeSource) {
    citations.push({
      source_type: 'policy_source',
      source_id: safeSource,
      label: `Source — ${safeSource}`,
      timestamp: null,
    });
  }
  if (prevVer) {
    citations.push({
      source_type: 'policy_version',
      source_id: `${key}:${prevVer}`,
      label: `Previous version — ${prevVer}`,
      timestamp: null,
    });
  }
  if (currVer) {
    citations.push({
      source_type: 'policy_version',
      source_id: `${key}:${currVer}`,
      label: `Current version — ${currVer}`,
      timestamp: null,
    });
  }
  citations.push({
    source_type: 'policy_diff_rules',
    source_id: MODULE_KEY,
    label: 'Policy diff rule reference',
    timestamp: null,
  });
  const finalCitations = uniqueCitations(citations);

  // Safety flags.
  const totalChanged = evaluation.added_section_count
    + evaluation.removed_section_count
    + evaluation.modified_section_count;
  const safetyFlags = [];
  if (evaluation.severity === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'POLICY_DIFF_CRITICAL',
      message: 'Critical policy diff — notify compliance + legal leadership immediately.',
    });
  }
  if (!finalCitations.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Policy diff has no source citations.',
    });
  }
  if (totalChanged === 0) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_DIFF_CONTENT',
      message: 'No added, removed, or modified sections were detected in the supplied inputs.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'POLICY_DIFF_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only — compliance + legal review approves before rollout; the module never auto-activates or revokes a policy.',
  });

  const fallbackDraft = {
    module_key: MODULE_KEY,
    policy_key: key,
    policy_title: title,
    source: safeSource,
    previous_version: prevVer,
    current_version: currVer,
    effective_date: effDate,
    impact_area: evaluation.impact_area,
    severity: evaluation.severity,
    added_section_count: evaluation.added_section_count,
    removed_section_count: evaluation.removed_section_count,
    modified_section_count: evaluation.modified_section_count,
    diff_sections: evaluation.diff_sections,
    impacted_roles: evaluation.impacted_roles,
    signals: evaluation.signals,
    summary,
    recommended_actions: recommendedActions,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  // Optional AI narrative (decorative).
  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        policy: {
          policy_key: key,
          policy_title: title,
          source: safeSource,
          previous_version: prevVer,
          current_version: currVer,
          effective_date: effDate,
        },
        rule_based_evaluation: {
          impact_area: evaluation.impact_area,
          severity: evaluation.severity,
          added_section_count: evaluation.added_section_count,
          removed_section_count: evaluation.removed_section_count,
          modified_section_count: evaluation.modified_section_count,
          impacted_roles: evaluation.impacted_roles,
          signals: evaluation.signals,
          diff_sections: evaluation.diff_sections,
        },
      })}`,
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
    const parsed = safeJsonParse(aiResult?.text, {});
    if (parsed && typeof parsed === 'object') {
      draft = {
        ...fallbackDraft,
        summary: cleanText(parsed.summary) || fallbackDraft.summary,
        source_citations: uniqueCitations([
          ...asArray(fallbackDraft.source_citations),
          ...asArray(parsed.source_citations),
        ]),
        // Never let the AI override rule-based fields.
      };
    }
  } catch (err) {
    logger.debug('Policy diff AI narrative unavailable; using template fallback', {
      error: err?.message,
    });
  }

  // Merge with output defenses.
  const combinedFlags = [
    ...safetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        policy: {
          key,
          title,
          source: safeSource,
          previous_version: prevVer,
          current_version: currVer,
        },
      },
      citations: draft.source_citations,
    }),
  ];
  draft.safety_flags = combinedFlags;
  draft.source_citations = uniqueCitations(asArray(draft.source_citations));

  // Persist generation.
  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      policy_key: key,
      previous_version: prevVer,
      current_version: currVer,
      impact_area: evaluation.impact_area,
      added_count: evaluation.added_section_count,
      removed_count: evaluation.removed_section_count,
      modified_count: evaluation.modified_section_count,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      policy_key: key,
      source: safeSource,
      previous_version: prevVer,
      current_version: currVer,
      impact_area: evaluation.impact_area,
      severity: evaluation.severity,
      signal_codes: evaluation.signals.map((s) => s.code),
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  // Persist diff row.
  const diffRow = await insertDiffRow({
    tenantId,
    policyKey: key,
    policyTitle: title,
    source: safeSource,
    previousVersion: prevVer,
    currentVersion: currVer,
    effectiveDate: effDate,
    generationId: generation?.id || null,
    impactArea: evaluation.impact_area,
    severity: evaluation.severity,
    addedCount: evaluation.added_section_count,
    removedCount: evaluation.removed_section_count,
    modifiedCount: evaluation.modified_section_count,
    diffSections: evaluation.diff_sections,
    impactedRoles: evaluation.impacted_roles,
    signals: evaluation.signals,
    summary: draft.summary,
    recommendedActions,
    sourceCitations: draft.source_citations,
    safetyFlags: combinedFlags,
    metadata: {
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      bucket_hit_counts: {
        clinical: asArray(evaluation.bucket_hits?.clinical).length,
        billing: asArray(evaluation.bucket_hits?.billing).length,
        access: asArray(evaluation.bucket_hits?.access).length,
        privacy: asArray(evaluation.bucket_hits?.privacy).length,
        infection_control: asArray(evaluation.bucket_hits?.infection_control).length,
        pharmacy: asArray(evaluation.bucket_hits?.pharmacy).length,
      },
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  if (!diffRow) {
    return {
      diff_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: draft.source_citations,
      safety_flags: combinedFlags,
      impact_area: evaluation.impact_area,
      severity: evaluation.severity,
      added_section_count: evaluation.added_section_count,
      removed_section_count: evaluation.removed_section_count,
      modified_section_count: evaluation.modified_section_count,
      impacted_roles: evaluation.impacted_roles,
      signals: evaluation.signals,
      module_key: MODULE_KEY,
      prompt_version: prompt?.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_policy_diffs_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  // Review placeholder.
  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    policyKey: key,
    module,
  });

  // Event publish.
  try {
    await publishEvent({
      eventType: 'clinical_ai.policy_diff_generated',
      aggregateType: 'clinical_ai_policy_diff',
      aggregateId: diffRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        diff_id: diffRow.id,
        generation_id: generation?.id || null,
        policy_key: key,
        policy_title: title,
        source: safeSource,
        previous_version: prevVer,
        current_version: currVer,
        impact_area: evaluation.impact_area,
        severity: evaluation.severity,
        added_section_count: evaluation.added_section_count,
        removed_section_count: evaluation.removed_section_count,
        modified_section_count: evaluation.modified_section_count,
        impacted_roles: evaluation.impacted_roles,
        signal_codes: evaluation.signals.map((s) => s.code),
      },
    });
  } catch (err) {
    logger.warn('Policy diff event publish failed', { error: err?.message });
  }

  return {
    diff_id: diffRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    diff: diffRow,
    impact_area: evaluation.impact_area,
    severity: evaluation.severity,
    added_section_count: evaluation.added_section_count,
    removed_section_count: evaluation.removed_section_count,
    modified_section_count: evaluation.modified_section_count,
    impacted_roles: evaluation.impacted_roles,
    signals: evaluation.signals,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || diffRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
      usage: aiResult?.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listPolicyDiffs({
  tenantId = null,
  policyKey = null,
  impactArea = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedPolicyKey = policyKey ? cleanText(policyKey) : null;
  const normalizedImpactArea = impactArea
    && IMPACT_AREAS.has(cleanText(impactArea).toLowerCase())
    ? cleanText(impactArea).toLowerCase()
    : null;
  const normalizedSeverity = severity
    && SEVERITIES.has(cleanText(severity).toLowerCase())
    ? cleanText(severity).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision
    && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT d.id, d.tenant_id, d.policy_key, d.policy_title, d.source,
              d.previous_version, d.current_version, d.effective_date,
              d.generation_id, d.impact_area, d.severity,
              d.added_section_count, d.removed_section_count, d.modified_section_count,
              d.diff_sections, d.impacted_roles, d.signals, d.summary,
              d.recommended_actions, d.source_citations, d.safety_flags,
              d.reviewer_decision, d.reviewed_by, d.reviewed_at, d.reviewer_note,
              d.metadata, d.created_at, d.updated_at
       FROM clinical_ai_policy_diffs d
       WHERE d.tenant_id = $1::uuid
         AND ($2::text IS NULL OR d.policy_key = $2)
         AND ($3::text IS NULL OR d.impact_area = $3)
         AND ($4::text IS NULL OR d.severity = $4)
         AND ($5::text IS NULL OR d.reviewer_decision = $5)
       ORDER BY
         CASE d.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         d.created_at DESC
       LIMIT $6`,
      tid,
      normalizedPolicyKey,
      normalizedImpactArea,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeDiffRow);
    return { diffs: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { diffs: [], count: 0 };
    throw err;
  }
}

export async function decidePolicyDiff({
  tenantId = null,
  diffId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_policy_diffs
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, policy_key, policy_title, source,
               previous_version, current_version, effective_date,
               generation_id, impact_area, severity,
               added_section_count, removed_section_count, modified_section_count,
               diff_sections, impacted_roles, signals, summary, recommended_actions,
               source_citations, safety_flags, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata,
               created_at, updated_at`,
    optionalInt(diffId, 'diff_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Policy diff not found');
  return normalizeDiffRow(rows[0]);
}

export default {
  IMPACT_AREAS,
  IMPACT_PRIORITY,
  SEVERITIES,
  SEVERITY_PRIORITY,
  normalizeText,
  splitSections,
  computeSectionDiff,
  detectImpactByKeywords,
  classifyImpactArea,
  classifySeverity,
  deriveImpactedRoles,
  escalateImpactArea,
  escalateSeverity,
  buildPolicyActions,
  summarizePolicyDiff,
  evaluatePolicyDiff,
  generatePolicyDiff,
  listPolicyDiffs,
  decidePolicyDiff,
};
