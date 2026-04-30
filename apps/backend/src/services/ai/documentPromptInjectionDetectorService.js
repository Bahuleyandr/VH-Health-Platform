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

const OBFUSCATION_PATTERNS = [
  {
    code: 'ZERO_WIDTH_OBFUSCATION',
    severity: 'medium',
    weight: 30,
    // Three or more zero-width / bidi / format characters in a row:
    // U+200B–U+200F (zero-width), U+202A–U+202E (LRE/RLE/PDF/LRO/RLO),
    // U+2066–U+2069 (LRI/RLI/FSI/PDI), U+FEFF (BOM).
    pattern: new RegExp('[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]{3,}'),
    reason: 'Content contains runs of zero-width or bidirectional control characters used to hide instructions.',
  },
  {
    code: 'COMBINING_DIACRITIC_FLOOD',
    severity: 'medium',
    weight: 25,
    // U+0300–U+036F: Combining Diacritical Marks block (zalgo).
    pattern: new RegExp('[\\u0300-\\u036f]{8,}'),
    reason: 'Content contains a flood of combining diacritics (zalgo-style obfuscation).',
  },
  {
    code: 'BASE64_PAYLOAD',
    severity: 'medium',
    weight: 20,
    // Long unbroken base64-style run. Some lab reports include short base64
    // tokens; this only fires past 320 chars.
    pattern: /[A-Za-z0-9+/]{320,}={0,2}/,
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
  if (scanned.trim().length < 20) {
    return empty;
  }

  const hits = [];
  const reasons = [];
  let totalScore = 0;
  let highestSeverityIndex = -1;
  let highestSeverityLength = 0;

  for (const rule of ALL_PATTERNS) {
    const match = rule.pattern.exec(scanned);
    if (!match) continue;
    const matchIndex = match.index ?? scanned.indexOf(match[0]);
    const matched = match[0];
    hits.push({
      code: rule.code,
      severity: rule.severity,
      weight: rule.weight,
      sample: matched.slice(0, 120),
    });
    reasons.push(rule.reason);
    totalScore += rule.weight;
    if (rule.severity === 'critical' && (highestSeverityIndex < 0 || rule.weight >= 100)) {
      highestSeverityIndex = matchIndex;
      highestSeverityLength = matched.length;
    } else if (highestSeverityIndex < 0) {
      highestSeverityIndex = matchIndex;
      highestSeverityLength = matched.length;
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
    sample: highestSeverityIndex >= 0
      ? sampleAround(scanned, highestSeverityIndex, highestSeverityLength)
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
};

export default {
  detectPromptInjection,
  injectionSafetyFlag,
  evaluateContentForIngestion,
};
