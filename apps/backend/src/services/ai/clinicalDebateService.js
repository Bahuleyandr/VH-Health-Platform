/**
 * Clinical differential debate.
 *
 * Adapted from the bullish-vs-bearish researcher debate in
 * TauricResearch/TradingAgents — for healthcare. Two opposing researchers
 * inspect the same chart packet and the same AI draft:
 *
 *   * pursueAgent: argues for the leading hypothesis embedded in the
 *     draft. Lists supporting evidence and recommended next steps.
 *   * challengeAgent: argues for top alternative differentials, must-not-
 *     miss diagnoses, and the evidence that would refute the leading
 *     hypothesis.
 *
 * An adjudicator combines both sides into a structured evidence_balance
 * block — never a verdict — that the workflow service surfaces alongside
 * the draft. Reviewers see "the case for and the case against" before
 * deciding. Rules remain authoritative; nothing here changes the draft
 * or the review outcome.
 *
 * This first cut is rule-based (no extra LLM call), so the wiring is
 * deterministic and testable. The interface is shaped so the bodies of
 * runPursueAgent / runChallengeAgent / runAdjudicator can be swapped
 * later for LLM-backed implementations without touching the caller.
 *
 * Gating: a module opts in via settings.enableDifferentialDebate = true.
 * If the module is opted out, runDifferentialDebate returns a no-op shape
 * with debate_skipped=true and no flags. This is intentional — debate is
 * only useful for diagnostic/prognostic modules; operational modules
 * (housekeeping, OT block, bed turnover) get nothing useful from it.
 */

import logger from '../../logging/logger.js';

const DEFAULT_MAX_ROUNDS = 1;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function extractLeadingHypothesis(draft) {
  if (!draft || typeof draft !== 'object') return null;
  return cleanText(
    draft.discharge_diagnosis
      || draft.admission_diagnosis
      || draft.primary_diagnosis
      || draft.leading_hypothesis
      || (asArray(draft.urgent_items)[0]?.source)
      || draft.recommendation
      || ''
  ) || null;
}

function citationsAreSparse(citations) {
  return asArray(citations).length < 2;
}

// ---------- Pursue agent ------------------------------------------------

/**
 * Build the case FOR the leading hypothesis. Returns:
 *   { hypothesis, supporting_evidence[], recommended_next_steps[], confidence }
 *
 * Rule-based first cut: pulls direct chart references that name-match the
 * hypothesis and surfaces them as supporting evidence. An LLM-backed
 * version of this function is a drop-in replacement.
 */
export function runPursueAgent({ chartPacket = {}, draft = {} } = {}) {
  const hypothesis = extractLeadingHypothesis(draft);
  if (!hypothesis) {
    return {
      hypothesis: null,
      supporting_evidence: [],
      recommended_next_steps: [],
      confidence: 'unknown',
    };
  }

  const needle = hypothesis.toLowerCase();
  const supporting = [];
  const stream = [
    ...asArray(chartPacket.active_diagnoses),
    ...asArray(chartPacket.recent_notes),
    ...asArray(chartPacket.investigations),
  ];
  for (const event of stream) {
    const summary = cleanText(event?.summary);
    if (summary && summary.toLowerCase().includes(needle)) {
      supporting.push(summary);
    }
    if (supporting.length >= 6) break;
  }

  const confidence = supporting.length >= 3
    ? 'high'
    : supporting.length >= 1
      ? 'moderate'
      : 'low';

  const recommended = supporting.length
    ? ['Continue current diagnostic workup', 'Document evidence for primary hypothesis']
    : ['Confirm primary hypothesis with directed history/exam', 'Order targeted investigations to anchor the diagnosis'];

  return {
    hypothesis,
    supporting_evidence: supporting,
    recommended_next_steps: recommended,
    confidence,
  };
}

// ---------- Challenge agent ---------------------------------------------

// Shortlist of "must-not-miss" alternative diagnoses by chief-complaint
// class. Deliberately small + Indian-care-system biased; the LLM-backed
// replacement will produce richer differentials, but the wiring is
// validated against this rule path in tests.
const MUST_NOT_MISS = [
  { trigger: /chest pain|angina/i, alternatives: ['acute coronary syndrome', 'pulmonary embolism', 'aortic dissection', 'tension pneumothorax'] },
  { trigger: /shortness of breath|sob|breathless|dyspn/i, alternatives: ['pulmonary embolism', 'heart failure', 'covid pneumonia', 'asthma exacerbation', 'pneumothorax'] },
  { trigger: /headache/i, alternatives: ['subarachnoid haemorrhage', 'meningitis', 'temporal arteritis', 'cerebral venous thrombosis'] },
  { trigger: /abdominal pain|abdomen/i, alternatives: ['appendicitis', 'ectopic pregnancy', 'mesenteric ischaemia', 'diabetic ketoacidosis', 'aortic aneurysm'] },
  { trigger: /altered (mental|sensorium)|drowsy|confusion/i, alternatives: ['hypoglycaemia', 'meningitis', 'stroke', 'sepsis', 'overdose'] },
  { trigger: /fever/i, alternatives: ['malaria', 'enteric fever', 'dengue', 'covid', 'tuberculosis', 'sepsis'] },
  { trigger: /pregnan|antenatal|labour|labor/i, alternatives: ['preeclampsia', 'eclampsia', 'placental abruption', 'amniotic fluid embolism', 'uterine rupture'] },
];

/**
 * Build the case AGAINST the leading hypothesis. Returns:
 *   { alternatives[], refuting_signals[], must_not_miss[], evidence_gaps[] }
 *
 * Rule-based first cut. The LLM-backed version of this function will read
 * the chart packet much more deeply; this version flags structural gaps
 * (missing investigations, sparse citations, contradictory vitals) that a
 * reviewer should triage before accepting the draft.
 */
export function runChallengeAgent({ chartPacket = {}, draft = {}, citations = [] } = {}) {
  const hypothesis = extractLeadingHypothesis(draft);
  const chiefComplaint = cleanText(
    chartPacket.admission?.chief_complaint || chartPacket.admission?.admitting_diagnosis || ''
  );

  const mustNotMiss = [];
  for (const entry of MUST_NOT_MISS) {
    if (entry.trigger.test(chiefComplaint)) {
      for (const alt of entry.alternatives) {
        if (!hypothesis || !hypothesis.toLowerCase().includes(alt.toLowerCase())) {
          mustNotMiss.push(alt);
        }
      }
    }
  }

  const refuting = [];
  for (const event of asArray(chartPacket.recent_vitals)) {
    const v = event?.payload || {};
    if (Number(v.spo2) && Number(v.spo2) < 92) refuting.push(`SpO2 ${v.spo2}% — consider PE/pneumothorax/pneumonia`);
    if (Number(v.temperature) && Number(v.temperature) >= 39) refuting.push(`Temp ${v.temperature}°C — consider sepsis source`);
    if (Number(v.heart_rate) && Number(v.heart_rate) >= 130) refuting.push(`HR ${v.heart_rate} — re-evaluate volume / sepsis / arrhythmia`);
  }

  const evidenceGaps = [];
  if (citationsAreSparse(citations)) {
    evidenceGaps.push('Draft cites fewer than 2 chart sources — primary hypothesis is poorly anchored.');
  }
  if (!asArray(chartPacket.investigations).length) {
    evidenceGaps.push('No investigations in chart packet — directed workup not documented.');
  }
  if (!asArray(chartPacket.recent_notes).length) {
    evidenceGaps.push('No recent clinical notes available — narrative course is missing.');
  }

  return {
    alternatives: [...new Set(mustNotMiss)].slice(0, 6),
    refuting_signals: refuting.slice(0, 6),
    must_not_miss: mustNotMiss.length ? `Must-not-miss conditions for "${chiefComplaint}"` : null,
    evidence_gaps: evidenceGaps,
  };
}

// ---------- Adjudicator -------------------------------------------------

/**
 * Combine pursue + challenge into a single evidence_balance object that
 * the reviewer can scan at a glance. Adjudicator does NOT pick a winner;
 * the goal is calibrated transparency, not autonomy.
 */
export function runAdjudicator({ pursue, challenge }) {
  const supportCount = asArray(pursue?.supporting_evidence).length;
  const challengeCount =
    asArray(challenge?.alternatives).length
    + asArray(challenge?.refuting_signals).length
    + asArray(challenge?.evidence_gaps).length;

  const balance = supportCount === 0 && challengeCount === 0
    ? 'insufficient_evidence'
    : supportCount > challengeCount * 2
      ? 'supports_leading_hypothesis'
      : challengeCount > supportCount * 2
        ? 'challenges_leading_hypothesis'
        : 'mixed';

  return {
    balance,
    pursue: pursue || null,
    challenge: challenge || null,
    adjudication_note:
      'Decision support only. The reviewing clinician adjudicates the leading vs alternative hypotheses; this balance sheet does not select an answer.',
  };
}

// ---------- Top-level entry point ---------------------------------------

/**
 * Run the differential debate over a draft. Returns:
 *   {
 *     debate_enabled: boolean,
 *     debate_skipped: boolean,
 *     evidence_balance: { ... } | null,
 *     safety_flags: [ ... ],   // appended to the draft's safety_flags
 *   }
 *
 * Module-gated: settings.enableDifferentialDebate must be true to run.
 *
 * Caller contract (from clinicalAiWorkflowService): call AFTER the LLM
 * draft is produced and AFTER runOutputDefenses, but BEFORE saveGeneration
 * persists the safety_flags. Append this call's safety_flags to the
 * pre-existing list and stash evidence_balance on draft.evidence_balance
 * so it appears in the standard response shape.
 */
export function runDifferentialDebate({
  chartPacket = {},
  draft = {},
  module = null,
  citations = [],
  maxRounds = DEFAULT_MAX_ROUNDS,
} = {}) {
  const debateEnabled = Boolean(module?.settings?.enableDifferentialDebate);
  if (!debateEnabled) {
    return {
      debate_enabled: false,
      debate_skipped: true,
      evidence_balance: null,
      safety_flags: [],
    };
  }

  const rounds = Math.min(Math.max(parseInt(maxRounds, 10) || DEFAULT_MAX_ROUNDS, 1), 3);
  let pursue = null;
  let challenge = null;

  try {
    for (let i = 0; i < rounds; i++) {
      pursue = runPursueAgent({ chartPacket, draft });
      challenge = runChallengeAgent({ chartPacket, draft, citations });
      // Future LLM-driven version: each round can be conditioned on the
      // previous round's findings. For the rule-based first cut, both
      // agents are pure functions of the input, so additional rounds add
      // no information — break early.
      if (i === 0) break;
    }
  } catch (err) {
    logger.warn('Differential debate failed; returning empty balance', {
      moduleKey: module?.module_key,
      error: err.message,
    });
    return {
      debate_enabled: true,
      debate_skipped: false,
      evidence_balance: null,
      safety_flags: [{
        severity: 'medium',
        code: 'DEBATE_FAILED',
        message: 'Differential debate could not be completed; reviewer should not rely on the balance sheet.',
      }],
    };
  }

  const evidenceBalance = runAdjudicator({ pursue, challenge });
  const safetyFlags = [];

  if (evidenceBalance.balance === 'challenges_leading_hypothesis') {
    safetyFlags.push({
      severity: 'high',
      code: 'DEBATE_CHALLENGES_LEADING_HYPOTHESIS',
      message: 'Differential debate found more refuting evidence than supporting; reviewer must reconcile before acceptance.',
    });
  } else if (evidenceBalance.balance === 'mixed') {
    safetyFlags.push({
      severity: 'medium',
      code: 'DEBATE_MIXED_BALANCE',
      message: 'Differential debate found comparable evidence on both sides; reviewer should weigh alternatives.',
    });
  } else if (evidenceBalance.balance === 'insufficient_evidence') {
    safetyFlags.push({
      severity: 'medium',
      code: 'DEBATE_INSUFFICIENT_EVIDENCE',
      message: 'Differential debate could not anchor evidence on either side — chart packet may be too thin.',
    });
  }

  if (asArray(challenge?.alternatives).length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'DEBATE_MUST_NOT_MISS',
      message: `Must-not-miss alternatives surfaced: ${challenge.alternatives.join(', ')}.`,
    });
  }

  return {
    debate_enabled: true,
    debate_skipped: false,
    evidence_balance: evidenceBalance,
    safety_flags: safetyFlags,
  };
}

export default {
  runDifferentialDebate,
  runPursueAgent,
  runChallengeAgent,
  runAdjudicator,
};
