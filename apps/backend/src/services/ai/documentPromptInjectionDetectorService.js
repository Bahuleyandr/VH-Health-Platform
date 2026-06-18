/**
 * Prompt-injection detector for content ingested into LLM prompts.
 *
 * The clinical-AI substrate reads external documents (uploaded PDFs, OCR'd
 * images, FHIR DocumentReferences, ABDM care contexts) into prompts via
 * documentIntelligenceService and ragService. Without a gate, a hostile
 * actor could embed instructions in a lab report PDF that try to override
 * the system prompt or exfiltrate data through the model.
 *
 * Defense posture:
 *   - Pure heuristic (regex). No LLM call inside the detector — that would
 *     re-introduce the very risk we are trying to prevent and could expose
 *     PHI to an external provider.
 *   - Two-tier verdict: 'block' for high-confidence injection (chat-template
 *     tokens, direct override directives); 'flag' for softer signals
 *     (role-flips, system-prompt leaks, AI-direct-address, obfuscation).
 *     'pass' when nothing matched.
 *   - Score is informational; verdict is the contract.
 *   - Returns hits + reasons + a sample so reviewers can see why a document
 *     was held without re-running the regex themselves.
 *
 * Callers decide what to do with the verdict:
 *   - documentIntelligenceService blocks AI extraction on 'block', adds a
 *     CRITICAL safety flag, and warns the LLM about untrusted content on 'flag'.
 *   - ragService refuses to index 'block' content into the corpus.
 */

const MAX_SCAN_CHARS = 100_000;
const SAMPLE_CHARS = 240;

const HIGH_CONFIDENCE_PATTERNS = [
  {
    code: 'CHAT_TEMPLATE_TOKEN',
    severity: 'critical',
    weight: 100,
    pattern:
      /(<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|user\|>|<\|assistant\|>|<\|endoftext\|>|\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>|<\/?\s*system\s*>)/i,
    reason: 'Content includes raw chat-template tokens used by LLM serialization formats.',
  },
  {
    code: 'DIRECT_INSTRUCTION_OVERRIDE',
    severity: 'critical',
    weight: 100,
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|the\s+|every\s+|each\s+|previous\s+|prior\s+|above\s+|earlier\s+|preceding\s+|your\s+)+(instructions?|prompts?|rules?|directives?|guidance|guidelines?|context|messages?|orders?|policies)\b/i,
    reason: 'Content directly tells the model to ignore its existing instructions.',
  },
  {
    code: 'SYSTEM_PROMPT_OVERRIDE',
    severity: 'critical',
    weight: 100,
    pattern:
      /\b(begin|start|new)\s+(system|developer|admin|root)\s+(prompt|instruction|directive|message)\b|\bsystem\s+prompt\s*[:=]/i,
    reason: 'Content attempts to start a fresh system prompt or root directive block.',
  },
];

const MEDIUM_CONFIDENCE_PATTERNS = [
  {
    code: 'ROLE_FLIP_ATTEMPT',
    severity: 'high',
    weight: 60,
    pattern:
      /\byou\s+are\s+now\s+(a|an|the|no\s+longer)\b|\bfrom\s+now\s+on,?\s*you\s+(are|will\s+be|must|should|shall)\b|\b(act|behave|respond|reply)\s+as\s+(if\s+you\s+(are|were)\s+)?(a|an|the)\s+\w+/i,
    reason: 'Content tries to redefine the model\'s role.',
  },
  {
    code: 'SYSTEM_PROMPT_LEAK_REQUEST',
    severity: 'high',
    weight: 55,
    // Verb + run of {1,4} AI-flavoured qualifiers + target. Requiring at
    // least one qualifier from the AI-context list keeps clinical phrasing
    // like "print discharge instructions" or "show the patient's notes" out.
    pattern:
      /\b(print|show|reveal|repeat|output|display|expose|leak|dump|share|disclose)\s+(?:(?:your|the|my|its|original|hidden|raw|full|complete|entire|system|developer|admin|initial)\s+){1,4}(prompt|instructions?|rules?|directives?|configuration|persona|character|setup|guidelines)\b/i,
    reason: 'Content asks the model to disclose its instructions or configuration.',
  },
  {
    code: 'PERSONA_HIJACK',
    severity: 'high',
    weight: 55,
    pattern:
      /\b(pretend|imagine|simulate|roleplay|role-play)\s+(to\s+be|that\s+you\s+are|you\s+are|being)\b|\bjailbreak\b|\b(?:respond|reply|act|behave|talk|speak)\s+as\s+DAN\b|\bDAN\s+(?:mode|jailbreak|persona|character)\b|\bpretend\s+to\s+be\s+DAN\b|\b(?:enable|enter|activate|switch\s+to|engage)\s+(?:developer|dev|admin|root|debug|god)\s+mode\b|\bdeveloper\s+mode\s+(enabled|on|active|engaged)\b/i,
    reason: 'Content invokes a persona-hijack pattern (jailbreak / DAN-mode / developer-mode).',
  },
  {
    code: 'INSTRUCTION_BLOCK_INJECTION',
    severity: 'high',
    weight: 50,
    // Structural, NEWLINE-ANCHORED rule (markdown/bracket instruction headers).
    // Must scan the RAW text: normalizeForMatching collapses runs of whitespace
    // (incl. newlines) to single spaces, which strips the (^|\n) anchor and made
    // this rule silently stop matching after the NFKC/zero-width normalization
    // was added. rawText keeps the line structure this rule depends on.
    rawText: true,
    pattern:
      /(^|\n)\s*(###\s*(instruction|system|rules?|directives?)|---\s*(instruction|system)|\[(instruction|system|rules?)\])/i,
    reason: 'Content includes markdown / bracket-style instruction headers commonly used in prompt-injection payloads.',
  },
];

const LOW_CONFIDENCE_PATTERNS = [
  {
    code: 'AI_DIRECT_ADDRESS',
    severity: 'medium',
    weight: 25,
    pattern:
      /\b(hey|dear|hi|hello|attention)\s+(chatgpt|claude|gpt-?\d?|ai|assistant|copilot|gemini|bard|llama|mistral|the\s+model)\b/i,
    reason: 'Content addresses the AI model directly, suggesting authored-for-the-model text inside a clinical document.',
  },
  {
    code: 'AS_AN_AI',
    severity: 'medium',
    weight: 20,
    pattern:
      /\bas\s+an?\s+(ai|assistant|language\s+model)\b/i,
    reason: 'Phrasing typical of model self-reference appearing in supposedly human-authored clinical content.',
  },
];

// Obfuscation rules run against the RAW (un-normalized) text. Normalization
// strips zero-width / bidi / format characters and collapses spacing before the
// content rules match — so if these read normalized text the obfuscation signal
// itself would vanish. Thresholds were lowered (audit 2026-06-18 §4): a 2-char
// zero-width run and a 4-char combining-diacritic run are already abnormal in a
// clinical document and worth a flag, especially now that the content rules see
// through the obfuscation.
const OBFUSCATION_PATTERNS = [
  {
    code: 'ZERO_WIDTH_OBFUSCATION',
    severity: 'medium',
    weight: 30,
    // Two or more zero-width / bidi / format characters in a row:
    // U+200B–U+200F (zero-width), U+202A–U+202E (LRE/RLE/PDF/LRO/RLO),
    // U+2066–U+2069 (LRI/RLI/FSI/PDI), U+FEFF (BOM).
    pattern: new RegExp('[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]{2,}', 'g'),
    rawText: true,
    reason: 'Content contains runs of zero-width or bidirectional control characters used to hide instructions.',
  },
  {
    code: 'COMBINING_DIACRITIC_FLOOD',
    severity: 'medium',
    weight: 25,
    // U+0300–U+036F: Combining Diacritical Marks block (zalgo).
    pattern: new RegExp('[\\u0300-\\u036f]{4,}', 'g'),
    rawText: true,
    reason: 'Content contains a flood of combining diacritics (zalgo-style obfuscation).',
  },
  {
    code: 'BASE64_PAYLOAD',
    severity: 'medium',
    weight: 20,
    // Long unbroken base64-style run. Some lab reports include short base64
    // tokens; this only fires past 320 chars. Reads raw text because base64
    // alphabet survives normalization unchanged but spacing-collapse could
    // splice two unrelated runs together.
    pattern: /[A-Za-z0-9+/]{320,}={0,2}/g,
    rawText: true,
    reason: 'Content contains a long base64-style payload that may carry encoded instructions.',
  },
];

const ALL_PATTERNS = [
  ...HIGH_CONFIDENCE_PATTERNS,
  ...MEDIUM_CONFIDENCE_PATTERNS,
  ...LOW_CONFIDENCE_PATTERNS,
  ...OBFUSCATION_PATTERNS,
];

const BLOCK_THRESHOLD = 80;
const FLAG_THRESHOLD = 30;

// Per-rule cumulative-weight cap. A single rule that matches many times (e.g. a
// document that repeats "ignore previous instructions" 50×) should escalate,
// but not run away with the score — cap each rule's contribution so the verdict
// stays driven by the DIVERSITY + severity of signals, not sheer repetition.
const MAX_RULE_HITS_COUNTED = 5;

// Characters stripped before content matching: zero-width spaces/joiners
// (U+200B–U+200D), bidi/LTR/RTL marks + embeddings/overrides (U+200E–U+200F,
// U+202A–U+202E), isolates (U+2066–U+2069), word-joiner (U+2060), and BOM/ZWNBSP
// (U+FEFF). These are the splitter characters an attacker inserts mid-token to
// defeat a literal regex; none of them carry clinical meaning.
const ZERO_WIDTH_STRIP_RE = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Normalize content before matching the textual injection rules.
 *
 *   1. Unicode NFKC — folds full-width / compatibility homoglyphs
 *      (ｉｇｎｏｒｅ → ignore, ﬁ → fi) to their canonical ASCII form so a
 *      homoglyph payload can't slip past a literal regex.
 *   2. Strip zero-width / bidi / format characters that are used purely to
 *      split a token (ig<U+200B>nore → ignore).
 *   3. Collapse runs of whitespace (incl. tabs/newlines) to a single space so
 *      "ig nore   all" and inter-character spacing splits ("< | im _ start | >")
 *      reduce toward the literal token the rules look for.
 *
 * The OBFUSCATION rules deliberately run on the RAW text (rawText:true) so the
 * stripping here doesn't hide the very signal they detect. Fail-closed posture
 * is unchanged: normalization only makes MORE payloads match, never fewer.
 */
function normalizeForMatching(text) {
  let normalized;
  try {
    normalized = text.normalize('NFKC');
  } catch {
    normalized = text;
  }
  return normalized
    .replace(ZERO_WIDTH_STRIP_RE, '')
    .replace(/\s+/g, ' ');
}

/**
 * Compile a rule's pattern with the global flag so we can count cumulative
 * matches (matchAll) instead of stopping at the first hit. Cached on the rule.
 */
function globalPattern(rule) {
  if (rule.__globalPattern) return rule.__globalPattern;
  const flags = rule.pattern.flags.includes('g')
    ? rule.pattern.flags
    : `${rule.pattern.flags}g`;
  const compiled = new RegExp(rule.pattern.source, flags);
  Object.defineProperty(rule, '__globalPattern', {
    value: compiled,
    enumerable: false,
    writable: false,
  });
  return compiled;
}

function sampleAround(text, index, length) {
  if (index < 0) return '';
  const start = Math.max(0, index - Math.floor(SAMPLE_CHARS / 4));
  const end = Math.min(text.length, index + length + Math.floor((SAMPLE_CHARS * 3) / 4));
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Scan content for prompt-injection patterns.
 *
 * @param {object} options
 * @param {string} options.text - The content to scan (caller is responsible
 *   for OCR / text extraction; we operate on the same text the LLM will see).
 * @param {string} [options.source] - Free-form source label for telemetry
 *   (e.g. 'document_intake', 'rag_corpus:discharge_summary').
 * @param {object} [options.metadata] - Forwarded to caller-side telemetry.
 *
 * @returns {{
 *   verdict: 'pass' | 'flag' | 'block',
 *   score: number,
 *   hits: Array<{ code: string, severity: string, sample: string }>,
 *   reasons: string[],
 *   sample: string | null,
 *   scanned_chars: number,
 *   metadata: object,
 * }}
 */
export function detectPromptInjection({ text = '', source = 'unknown', metadata = {} } = {}) {
  const body = String(text || '');
  const scanned = body.length > MAX_SCAN_CHARS ? body.slice(0, MAX_SCAN_CHARS) : body;
  // Normalized view for the textual rules (homoglyph fold + zero-width strip +
  // spacing collapse). Obfuscation rules read `scanned` (raw) instead.
  const normalized = normalizeForMatching(scanned);
  const empty = {
    verdict: 'pass',
    score: 0,
    hits: [],
    reasons: [],
    sample: null,
    scanned_chars: scanned.length,
    metadata: { source, ...metadata },
  };

  // Skip very short content — too little signal, high false-positive risk.
  // Measure against the normalized text so a doc padded only with zero-width
  // characters can't sneak under the floor.
  if (normalized.trim().length < 20) {
    return empty;
  }

  const hits = [];
  const reasons = [];
  let totalScore = 0;
  // Track the location of the strongest signal so reviewers get a useful
  // sample. Critical hits win; among equals, the first seen. Index is relative
  // to whichever text (raw vs normalized) the winning rule matched against.
  let bestSample = null; // { text, index, length, weight, critical }

  for (const rule of ALL_PATTERNS) {
    const haystack = rule.rawText ? scanned : normalized;
    const re = globalPattern(rule);
    re.lastIndex = 0;
    let count = 0;
    let firstMatch = null;
    for (const match of haystack.matchAll(re)) {
      if (!firstMatch) firstMatch = match;
      count += 1;
      if (count >= MAX_RULE_HITS_COUNTED) break;
      // Guard against a zero-length match looping forever (defensive; all
      // current patterns consume ≥1 char).
      if (match[0] === '') break;
    }
    if (!firstMatch) continue;

    const matched = firstMatch[0];
    const matchIndex = firstMatch.index ?? haystack.indexOf(matched);
    // Cumulative weight, capped per rule so repetition can escalate but not
    // dominate the verdict.
    totalScore += rule.weight * count;
    hits.push({
      code: rule.code,
      severity: rule.severity,
      weight: rule.weight,
      count,
      sample: matched.slice(0, 120),
    });
    reasons.push(rule.reason);

    const critical = rule.severity === 'critical';
    if (
      !bestSample
      || (critical && !bestSample.critical)
      || (critical === bestSample.critical && rule.weight > bestSample.weight)
    ) {
      bestSample = { text: haystack, index: matchIndex, length: matched.length, weight: rule.weight, critical };
    }
  }

  if (!hits.length) return empty;

  const score = Math.min(100, totalScore);
  const hasCritical = hits.some((hit) => hit.severity === 'critical');
  // We've already returned 'pass' for the no-hits case above. Any hit at all
  // yields at least 'flag'; critical hits or accumulated weight ≥ BLOCK_THRESHOLD
  // escalates to 'block'. FLAG_THRESHOLD is kept for future weight tuning.
  const verdict = hasCritical || score >= BLOCK_THRESHOLD ? 'block' : 'flag';

  return {
    verdict,
    score,
    hits,
    reasons: [...new Set(reasons)],
    sample: bestSample
      ? sampleAround(bestSample.text, bestSample.index, bestSample.length)
      : null,
    scanned_chars: scanned.length,
    metadata: { source, ...metadata },
  };
}

/**
 * Build a safety_flag entry from a detection result, matching the shape used
 * across the rest of the clinical-AI substrate (severity / code / message /
 * metadata). Returns null if the verdict is 'pass'.
 */
export function injectionSafetyFlag(result) {
  if (!result || result.verdict === 'pass') return null;
  const blocked = result.verdict === 'block';
  return {
    severity: blocked ? 'critical' : 'high',
    code: blocked ? 'PROMPT_INJECTION_BLOCKED' : 'PROMPT_INJECTION_SUSPECTED',
    message: blocked
      ? 'Document content matches high-confidence prompt-injection patterns; AI extraction was skipped.'
      : 'Document contains content that may attempt to override AI instructions; treat as untrusted.',
    metadata: {
      score: result.score,
      hit_count: result.hits.length,
      hits: result.hits.slice(0, 8).map((hit) => ({
        code: hit.code,
        severity: hit.severity,
        sample: hit.sample,
      })),
      reasons: result.reasons.slice(0, 6),
      sample: result.sample,
      source: result.metadata?.source || null,
    },
  };
}

/**
 * Convenience wrapper: detect + return the safety flag. Useful for callers
 * that want a single call site.
 */
export function evaluateContentForIngestion({ text, source, metadata } = {}) {
  const result = detectPromptInjection({ text, source, metadata });
  return { result, safetyFlag: injectionSafetyFlag(result) };
}

export const __testing__ = {
  HIGH_CONFIDENCE_PATTERNS,
  MEDIUM_CONFIDENCE_PATTERNS,
  LOW_CONFIDENCE_PATTERNS,
  OBFUSCATION_PATTERNS,
  BLOCK_THRESHOLD,
  FLAG_THRESHOLD,
  MAX_SCAN_CHARS,
  MAX_RULE_HITS_COUNTED,
  normalizeForMatching,
};

export default {
  detectPromptInjection,
  injectionSafetyFlag,
  evaluateContentForIngestion,
};
