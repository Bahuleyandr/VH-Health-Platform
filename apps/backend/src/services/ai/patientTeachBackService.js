/**
 * Patient Teach-Back / Comprehension AI.
 *
 * After aftercare/discharge instructions are generated, runs a
 * comprehension loop. Asks simple questions in the patient's language and
 * flags misunderstandings around medications, warning signs, follow-up,
 * diet/activity, wound care, and emergency escalation. Review-only: never
 * alters the care plan, medications, or instructions.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { collectAdmissionClinicalContext } from '../emr/clinicalTimelineService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'patient_teach_back_comprehension';
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You run a patient comprehension teach-back. Use only supplied discharge/aftercare evidence. Return JSON only. Do not change care plans, medications, or instructions.',
  user_prompt_template: 'Return teach-back questions and misunderstanding flags. Only check understanding; never provide new medical advice.',
};

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected']);
const STATUSES = new Set(['draft', 'in_progress', 'completed', 'needs_clinician_review']);
const SUPPORTED_LANGUAGES = new Set(['en', 'hi', 'ta', 'te', 'ml', 'mr', 'bn', 'kn']);
const CATEGORY_WEIGHTS = {
  medications: 25,
  warning_signs: 22,
  follow_up: 15,
  diet_activity: 10,
  wound_care: 12,
  emergency_escalation: 16,
};
const UNCERTAIN_PATTERNS = [
  /^i\s*(don'?t|do not)\s*know$/i,
  /^not\s*sure$/i,
  /^unsure$/i,
  /^idk$/i,
  /^maybe$/i,
  /^no idea$/i,
  /^\?+$/,
  /^skip$/i,
];
const EMERGENCY_NUMBER_PATTERNS = [
  /\b112\b/,
  /\b108\b/,
  /\b102\b/,
  /\b911\b/,
  /\bemergency\b/i,
  /\bambulance\b/i,
];

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedText(value) {
  return cleanText(value).toLowerCase();
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function optionalIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
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

function normalizeLanguage(value) {
  const normalized = normalizedText(value || 'en');
  if (SUPPORTED_LANGUAGES.has(normalized)) return normalized;
  return 'en';
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

function eventCitation(event, label = null) {
  if (!event) return null;
  return {
    source_type: event.event_type || event.source_type || 'chart',
    source_id: event.id === null || event.id === undefined ? null : String(event.id),
    label: label || event.summary || event.event_type || 'Chart evidence',
    timestamp: event.timestamp || event.payload?.created_at || event.created_at || null,
  };
}

function generationCitation(generationId, label) {
  if (!generationId) return null;
  return {
    source_type: 'clinical_ai_generation',
    source_id: String(generationId),
    label: label || 'Aftercare instruction draft',
    timestamp: null,
  };
}

function payloadValue(event, key) {
  return event?.payload?.[key] ?? event?.payload?.details?.[key] ?? event?.[key] ?? null;
}

function medicationFromMedEvent(event) {
  return cleanText(
    payloadValue(event, 'medication_name')
    || payloadValue(event, 'name')
    || payloadValue(event, 'drug_name')
    || event?.summary
  );
}

function medicationEvidenceFromContext(context) {
  const meds = new Map();
  for (const event of asArray(context.medications)) {
    const name = medicationFromMedEvent(event);
    if (!name || meds.has(name.toLowerCase())) continue;
    meds.set(name.toLowerCase(), {
      name,
      dose: cleanText(payloadValue(event, 'dose')),
      route: cleanText(payloadValue(event, 'route')),
      frequency: cleanText(payloadValue(event, 'frequency')),
      duration: cleanText(payloadValue(event, 'duration')),
      citation: eventCitation(event, name),
    });
  }
  for (const event of asArray(context.orders)) {
    if (!/medication|drug/i.test(event?.summary || '') && event?.payload?.order_type !== 'medication') continue;
    const name = medicationFromMedEvent(event);
    if (!name || meds.has(name.toLowerCase())) continue;
    meds.set(name.toLowerCase(), {
      name,
      dose: cleanText(payloadValue(event, 'dose')),
      route: cleanText(payloadValue(event, 'route')),
      frequency: cleanText(payloadValue(event, 'frequency')),
      duration: cleanText(payloadValue(event, 'duration')),
      citation: eventCitation(event, name),
    });
  }
  return [...meds.values()];
}

function allergyEvidence(context) {
  return asArray(context.allergies)
    .map((allergy) => cleanText(allergy.allergen || allergy.name || allergy.allergy_name))
    .filter(Boolean);
}

function aftercareFromSource(sourceDraft) {
  if (!sourceDraft || typeof sourceDraft !== 'object') return null;
  const medications = asArray(
    sourceDraft.medications
    || sourceDraft.discharge_medications
    || sourceDraft.continue
    || []
  ).map((entry) => {
    if (typeof entry === 'string') return { name: cleanText(entry) };
    const name = cleanText(entry?.name || entry?.medication || entry?.medication_name);
    return name ? {
      name,
      dose: cleanText(entry?.dose),
      route: cleanText(entry?.route),
      frequency: cleanText(entry?.frequency),
      duration: cleanText(entry?.duration),
    } : null;
  }).filter(Boolean);

  const warningSigns = asArray(sourceDraft.warning_signs || sourceDraft.red_flags || [])
    .map((entry) => (typeof entry === 'string' ? cleanText(entry) : cleanText(entry?.text || entry?.sign)))
    .filter(Boolean);

  const followUp = cleanText(
    sourceDraft.follow_up
    || sourceDraft.follow_up_plan
    || sourceDraft.follow_up_instructions
    || sourceDraft.follow_up_date
  );

  const diet = cleanText(sourceDraft.diet || sourceDraft.diet_instructions);
  const activity = cleanText(sourceDraft.activity || sourceDraft.activity_instructions);
  const woundCare = cleanText(sourceDraft.wound_care || sourceDraft.wound_instructions);
  const emergency = cleanText(
    sourceDraft.emergency_instructions
    || sourceDraft.emergency_escalation
    || sourceDraft.when_to_call
  );

  return {
    medications,
    warning_signs: warningSigns,
    follow_up: followUp,
    diet,
    activity,
    wound_care: woundCare,
    emergency: emergency,
  };
}

function defaultWarningSigns() {
  return [
    'fever above 38 degrees celsius',
    'chest pain or shortness of breath',
    'heavy bleeding from the wound',
    'severe vomiting or unable to keep fluids down',
    'confusion or sudden drowsiness',
  ];
}

function defaultEmergencyGuidance() {
  return 'Call the hospital emergency number or local ambulance (112 or 108) and go to the nearest emergency room.';
}

function questionId(category, index) {
  return `q-${category.replace(/_/g, '-')}-${index + 1}`;
}

function shuffledDistractors(correct, pool) {
  const unique = [];
  const seen = new Set([normalizedText(correct)]);
  for (const item of pool) {
    const key = normalizedText(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= 3) break;
  }
  return unique;
}

function medicationQuestion(index, med, allMeds) {
  const otherNames = allMeds.map((item) => item.name).filter((name) => name !== med.name);
  const distractorBank = [
    ...otherNames,
    'ibuprofen',
    'warfarin',
    'metformin',
    'atenolol',
  ];
  const distractors = shuffledDistractors(med.name, distractorBank);
  return {
    id: questionId('medications', index),
    category: 'medications',
    prompt: `Which of the following is a medicine you should continue to take after going home?`,
    expected: med.name,
    expected_keywords: [normalizedText(med.name)],
    choices: [med.name, ...distractors],
    difficulty: 'easy',
    explanation: med.dose || med.frequency
      ? `${med.name}${med.dose ? ` ${med.dose}` : ''}${med.frequency ? `, ${med.frequency}` : ''}`
      : `${med.name} is listed in your discharge medications.`,
    source_citation: med.citation || null,
  };
}

function medicationDoseQuestion(index, med) {
  if (!med.dose && !med.frequency) return null;
  const doseText = [med.dose, med.frequency].filter(Boolean).join(' ');
  return {
    id: questionId('medications-dose', index),
    category: 'medications',
    prompt: `How should you take ${med.name}?`,
    expected: doseText,
    expected_keywords: [normalizedText(med.dose || ''), normalizedText(med.frequency || '')].filter(Boolean),
    difficulty: 'medium',
    free_text: true,
    explanation: doseText,
    source_citation: med.citation || null,
  };
}

function allergyWarningQuestion(index, allergy, sourceCitation) {
  return {
    id: questionId('medications-allergy', index),
    category: 'medications',
    prompt: `You have a documented allergy to ${allergy}. What should you do if a new medicine is prescribed?`,
    expected: `tell the doctor about the ${allergy} allergy before taking a new medicine`,
    expected_keywords: ['tell', 'inform', 'allergy', normalizedText(allergy)],
    difficulty: 'medium',
    free_text: true,
    source_citation: sourceCitation,
  };
}

function warningSignQuestion(index, correctSign, signs) {
  const distractors = shuffledDistractors(correctSign, [
    ...signs.filter((item) => item !== correctSign),
    'mild hair loss',
    'slight hunger before meals',
    'minor itching that stops quickly',
  ]);
  return {
    id: questionId('warning-signs', index),
    category: 'warning_signs',
    prompt: `Which of these is a warning sign you should call the doctor about?`,
    expected: correctSign,
    expected_keywords: normalizedText(correctSign)
      .split(/\s+/)
      .filter((token) => token.length > 3)
      .slice(0, 4),
    choices: [correctSign, ...distractors],
    difficulty: 'easy',
    source_citation: null,
  };
}

function followUpQuestion(index, followUp, citation) {
  return {
    id: questionId('follow-up', index),
    category: 'follow_up',
    prompt: `When or where is your next follow-up visit?`,
    expected: followUp,
    expected_keywords: normalizedText(followUp).split(/\s+/).filter((token) => token.length > 2).slice(0, 5),
    difficulty: 'easy',
    free_text: true,
    source_citation: citation || null,
  };
}

function dietActivityQuestion(index, diet, activity, citation) {
  const text = [diet, activity].filter(Boolean).join('. ');
  const keywords = normalizedText(text).split(/\s+/).filter((token) => token.length > 3).slice(0, 6);
  return {
    id: questionId('diet-activity', index),
    category: 'diet_activity',
    prompt: 'What is one thing you should do or avoid for diet and activity at home?',
    expected: text,
    expected_keywords: keywords,
    difficulty: 'medium',
    free_text: true,
    source_citation: citation || null,
  };
}

function woundCareQuestion(index, woundInstructions, citation) {
  return {
    id: questionId('wound-care', index),
    category: 'wound_care',
    prompt: 'How should you take care of your wound or dressing at home?',
    expected: woundInstructions,
    expected_keywords: normalizedText(woundInstructions).split(/\s+/).filter((token) => token.length > 3).slice(0, 5),
    difficulty: 'medium',
    free_text: true,
    source_citation: citation || null,
  };
}

function emergencyQuestion(index, instructions, citation) {
  return {
    id: questionId('emergency', index),
    category: 'emergency_escalation',
    prompt: 'If you have a serious problem at home, what number should you call or where should you go?',
    expected: instructions,
    expected_keywords: ['112', '108', '911', 'emergency', 'ambulance', 'hospital'],
    difficulty: 'easy',
    free_text: true,
    source_citation: citation || null,
  };
}

export function buildTeachBackQuestions(context = {}) {
  const aftercare = aftercareFromSource(context.aftercare) || aftercareFromSource(context.source_draft) || {};
  const medicationEvidence = aftercare.medications?.length
    ? aftercare.medications
    : medicationEvidenceFromContext(context);
  const allergies = allergyEvidence(context);
  const warningSigns = aftercare.warning_signs?.length ? aftercare.warning_signs : defaultWarningSigns();
  const followUp = aftercare.follow_up || cleanText(context.admission?.discharge_follow_up);
  const diet = aftercare.diet;
  const activity = aftercare.activity;
  const woundCare = aftercare.wound_care;
  const emergency = aftercare.emergency || defaultEmergencyGuidance();

  const sourceCitation = context.source_generation_id
    ? generationCitation(context.source_generation_id, 'Aftercare instruction draft')
    : null;

  const questions = [];
  const citations = [];

  medicationEvidence.slice(0, 2).forEach((med, index) => {
    const question = medicationQuestion(index, med, medicationEvidence);
    questions.push(question);
    if (question.source_citation) citations.push(question.source_citation);
    const doseQuestion = medicationDoseQuestion(index, med);
    if (doseQuestion) {
      questions.push(doseQuestion);
      if (doseQuestion.source_citation) citations.push(doseQuestion.source_citation);
    }
  });

  allergies.slice(0, 1).forEach((allergy, index) => {
    const question = allergyWarningQuestion(index, allergy, sourceCitation);
    questions.push(question);
    if (question.source_citation) citations.push(question.source_citation);
  });

  warningSigns.slice(0, 2).forEach((sign, index) => {
    const question = warningSignQuestion(index, sign, warningSigns);
    if (sourceCitation) question.source_citation = sourceCitation;
    questions.push(question);
    if (question.source_citation) citations.push(question.source_citation);
  });

  if (followUp) {
    const question = followUpQuestion(0, followUp, sourceCitation);
    questions.push(question);
    if (question.source_citation) citations.push(question.source_citation);
  }

  if (diet || activity) {
    const question = dietActivityQuestion(0, diet, activity, sourceCitation);
    questions.push(question);
    if (question.source_citation) citations.push(question.source_citation);
  }

  if (woundCare) {
    const question = woundCareQuestion(0, woundCare, sourceCitation);
    questions.push(question);
    if (question.source_citation) citations.push(question.source_citation);
  }

  questions.push(emergencyQuestion(0, emergency, sourceCitation));
  if (sourceCitation) citations.push(sourceCitation);

  return {
    questions,
    citations: uniqueCitations(citations),
    coverage: {
      medications: questions.some((q) => q.category === 'medications'),
      warning_signs: questions.some((q) => q.category === 'warning_signs'),
      follow_up: questions.some((q) => q.category === 'follow_up'),
      diet_activity: questions.some((q) => q.category === 'diet_activity'),
      wound_care: questions.some((q) => q.category === 'wound_care'),
      emergency_escalation: questions.some((q) => q.category === 'emergency_escalation'),
    },
  };
}

function answerText(answer) {
  if (answer === null || answer === undefined) return '';
  if (typeof answer === 'string') return answer;
  if (typeof answer === 'object') return cleanText(answer.answer || answer.value || answer.text || '');
  return String(answer);
}

function isUncertainAnswer(text, answer) {
  if (answer && typeof answer === 'object' && (answer.uncertain === true || answer.unsure === true)) {
    return true;
  }
  const trimmed = cleanText(text);
  if (!trimmed) return true;
  return UNCERTAIN_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function matchesKeywords(text, keywords) {
  const haystack = normalizedText(text);
  if (!haystack) return false;
  const tokens = asArray(keywords).map(normalizedText).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.some((token) => haystack.includes(token));
}

function emergencyMatches(text) {
  return EMERGENCY_NUMBER_PATTERNS.some((pattern) => pattern.test(text));
}

function evaluateAnswer(question, answerEntry) {
  const answerString = answerText(answerEntry);
  const uncertain = isUncertainAnswer(answerString, answerEntry);
  const trimmed = cleanText(answerString);
  if (uncertain) {
    return { correct: false, uncertain: true, answer: trimmed };
  }

  if (Array.isArray(question.choices) && question.choices.length) {
    const matched = normalizedText(trimmed) === normalizedText(question.expected);
    return { correct: matched, uncertain: false, answer: trimmed };
  }

  if (question.category === 'emergency_escalation') {
    return {
      correct: emergencyMatches(trimmed) || matchesKeywords(trimmed, question.expected_keywords),
      uncertain: false,
      answer: trimmed,
    };
  }

  return {
    correct: matchesKeywords(trimmed, question.expected_keywords),
    uncertain: false,
    answer: trimmed,
  };
}

function answersByQuestion(answers) {
  const map = new Map();
  for (const entry of asArray(answers)) {
    if (!entry) continue;
    const id = entry.question_id || entry.id;
    if (!id) continue;
    map.set(String(id), entry);
  }
  return map;
}

export function scoreTeachBackAnswers({ questions = [], answers = [] } = {}) {
  const list = asArray(questions);
  if (!list.length) return { score: 0, evaluated: [], answered_count: 0 };

  const map = answersByQuestion(answers);
  const perCategory = new Map();
  for (const question of list) {
    const entry = perCategory.get(question.category) || { total: 0, correct: 0, uncertain: 0, answered: 0 };
    entry.total += 1;
    const answer = map.get(question.id);
    const evaluation = answer ? evaluateAnswer(question, answer) : { correct: false, uncertain: true, answer: '' };
    if (answer) entry.answered += 1;
    if (evaluation.correct) entry.correct += 1;
    if (evaluation.uncertain) entry.uncertain += 1;
    perCategory.set(question.category, entry);
  }

  let totalWeight = 0;
  let earned = 0;
  for (const [category, stats] of perCategory.entries()) {
    const weight = CATEGORY_WEIGHTS[category] ?? 10;
    totalWeight += weight;
    if (stats.total > 0) {
      earned += weight * (stats.correct / stats.total);
    }
  }
  const score = totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : 0;
  const evaluated = list.map((question) => {
    const answer = map.get(question.id);
    const evaluation = answer ? evaluateAnswer(question, answer) : { correct: false, uncertain: true, answer: '' };
    return {
      question_id: question.id,
      category: question.category,
      correct: evaluation.correct,
      uncertain: evaluation.uncertain,
      answer: evaluation.answer,
    };
  });
  const answeredCount = evaluated.filter((entry) => entry.answer).length;

  return { score: Math.max(0, Math.min(100, score)), evaluated, answered_count: answeredCount };
}

function severityForCategory(category) {
  if (category === 'emergency_escalation') return 'critical';
  if (category === 'medications' || category === 'warning_signs') return 'high';
  return 'medium';
}

function misunderstandingMessage(question, evaluation) {
  if (evaluation.uncertain) {
    return `Patient was unsure about ${question.category.replace(/_/g, ' ')}. Recommend repeat teach-back with clinician.`;
  }
  return `Patient gave an incorrect answer about ${question.category.replace(/_/g, ' ')}. Recommend clinician recap.`;
}

export function detectTeachBackMisunderstandings({ questions = [], answers = [] } = {}) {
  const list = asArray(questions);
  if (!list.length) return [];
  const map = answersByQuestion(answers);
  const flags = [];
  for (const question of list) {
    const answer = map.get(question.id);
    const evaluation = answer ? evaluateAnswer(question, answer) : { correct: false, uncertain: true, answer: '' };
    if (evaluation.correct) continue;
    flags.push({
      question_id: question.id,
      category: question.category,
      severity: severityForCategory(question.category),
      code: evaluation.uncertain ? 'TEACH_BACK_UNCERTAIN' : 'TEACH_BACK_INCORRECT',
      prompt: question.prompt,
      expected: question.expected,
      patient_answer: evaluation.answer,
      message: misunderstandingMessage(question, evaluation),
      source_citation: question.source_citation || null,
    });
  }
  return flags;
}

function buildFallbackDraft({ questions, answers, citations, language, sourceGenerationId, coverage }) {
  const scoring = scoreTeachBackAnswers({ questions, answers });
  const misunderstandings = detectTeachBackMisunderstandings({ questions, answers });
  const hasAnyAnswer = scoring.answered_count > 0;
  const status = !hasAnyAnswer
    ? 'draft'
    : misunderstandings.some((flag) => flag.severity === 'critical' || flag.severity === 'high')
      ? 'needs_clinician_review'
      : scoring.answered_count === asArray(questions).length
        ? 'completed'
        : 'in_progress';

  return {
    language,
    source_generation_id: sourceGenerationId || null,
    questions,
    patient_answers: asArray(answers),
    evaluated_answers: scoring.evaluated,
    misunderstanding_flags: misunderstandings,
    comprehension_score: scoring.score,
    status,
    coverage,
    summary: hasAnyAnswer
      ? `${misunderstandings.length} comprehension gap(s); ${scoring.score}% comprehension score.`
      : `${asArray(questions).length} teach-back question(s) drafted across ${Object.values(coverage || {}).filter(Boolean).length} categories.`,
    source_citations: uniqueCitations(citations),
    safety_flags: [],
    rules_authoritative: true,
    decision_support_only: true,
  };
}

function normalizeAiSummary(parsed, fallbackDraft) {
  return {
    ...fallbackDraft,
    summary: cleanText(parsed?.summary) || fallbackDraft.summary,
    source_citations: uniqueCitations([
      ...asArray(fallbackDraft.source_citations),
      ...asArray(parsed?.source_citations),
    ]),
    safety_flags: [
      ...asArray(fallbackDraft.safety_flags),
      ...asArray(parsed?.safety_flags),
    ],
  };
}

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
    return rows[0] || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function loadSourceGeneration(tenantId, sourceGenerationId) {
  if (!sourceGenerationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, draft, module_key, patient_uid, admission_id
       FROM clinical_ai_generations
       WHERE id = $1
         AND tenant_id = $2::uuid
       LIMIT 1`,
      sourceGenerationId,
      tenantId
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  admissionId,
  patientUid,
  prompt,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  metadata,
}) {
  const usage = aiResult?.usage || {};
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_generations
       (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
        prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
        generated_by, prompt_tokens, completion_tokens, total_tokens,
        estimated_cost_minor, latency_ms, provider_request_id, finish_reason,
        metadata, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7, $8, $9, $10,
             $11::jsonb, $12::jsonb, $13::jsonb, $14::uuid, $15, $16, $17,
             $18, $19, $20, $21, $22::jsonb, NOW(), NOW())
     RETURNING id, status, created_at`,
    tenantId,
    patientUid,
    admissionId,
    MODULE_KEY,
    aiResult?.provider || 'template',
    aiResult?.model || null,
    prompt.version || 'v1',
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
    aiResult?.estimatedCostMinor ?? usage.estimated_cost_minor ?? 0,
    usage.latency_ms || aiResult?.latencyMs || null,
    usage.provider_request_id || aiResult?.requestId || null,
    usage.finish_reason || aiResult?.finishReason || null,
    JSON.stringify(metadata || {})
  );
  return rows[0] || null;
}

async function createReviewPlaceholder({ tenantId, generationId, admissionId, patientUid, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'pending', $6::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      patientUid,
      admissionId,
      JSON.stringify({
        review_roles: module.settings?.reviewRoles || ['DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'],
        source: 'patient_teach_back_comprehension',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Patient teach-back review placeholder failed', { error: err.message });
    }
    return null;
  }
}

async function insertSessionRow({
  tenantId,
  patientUid,
  admissionId,
  generationId,
  sourceGenerationId,
  language,
  status,
  questions,
  answers,
  misunderstandings,
  comprehensionScore,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_teach_back_sessions
         (tenant_id, patient_uid, admission_id, generation_id, source_generation_id,
          language, status, questions, patient_answers, misunderstanding_flags,
          comprehension_score, source_citations, safety_flags, reviewer_decision,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7,
               $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb, $13::jsonb,
               'pending', $14::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, admission_id, generation_id, source_generation_id,
                 language, status, questions, patient_answers, misunderstanding_flags,
                 comprehension_score, source_citations, safety_flags, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, metadata, created_at, updated_at`,
      tenantId,
      patientUid,
      admissionId,
      generationId,
      sourceGenerationId,
      language,
      status,
      JSON.stringify(questions),
      JSON.stringify(answers),
      JSON.stringify(misunderstandings),
      comprehensionScore,
      JSON.stringify(citations),
      JSON.stringify(safetyFlags),
      JSON.stringify(metadata || {})
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function generateTeachBackSession({
  req = null,
  patientUid = null,
  admissionId = null,
  sourceGenerationId = null,
  language = 'en',
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const normalizedLanguage = normalizeLanguage(language);
  const safeAdmissionId = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const safeSourceGenerationId = optionalIntOrNull(sourceGenerationId);
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  let context = { aftercare: null };
  let resolvedPatientUid = patientUid || null;
  if (safeAdmissionId) {
    context = await collectAdmissionClinicalContext(safeAdmissionId, tenantId);
    resolvedPatientUid = resolvedPatientUid || context.admission?.patient_uid || null;
  }

  const sourceGeneration = await loadSourceGeneration(tenantId, safeSourceGenerationId);
  if (sourceGeneration) {
    context.source_draft = sourceGeneration.draft || null;
    context.source_generation_id = sourceGeneration.id;
    if (!resolvedPatientUid) resolvedPatientUid = sourceGeneration.patient_uid || null;
  }

  if (!resolvedPatientUid) {
    throw AppError.badRequest('patient_uid or admission_id is required to generate a teach-back session');
  }

  const built = buildTeachBackQuestions(context);
  const fallbackDraft = buildFallbackDraft({
    questions: built.questions,
    answers: [],
    citations: built.citations,
    language: normalizedLanguage,
    sourceGenerationId: safeSourceGenerationId,
    coverage: built.coverage,
  });

  const prompt = await getActivePrompt(tenantId);
  const aiResult = await generateClinicalText({
    taskType: MODULE_KEY,
    systemPrompt: prompt.system_prompt,
    userPrompt: `${prompt.user_prompt_template}\n\nLanguage: ${normalizedLanguage}\n${JSON.stringify({
      rule_based_teach_back: fallbackDraft,
      coverage: built.coverage,
    })}`,
    tenantRegion: req?.tenant?.region || null,
    tenantId,
  });
  const parsed = safeJsonParse(aiResult.text, {});
  const draft = normalizeAiSummary(parsed, fallbackDraft);
  const citations = uniqueCitations(
    asArray(draft.source_citations).length ? draft.source_citations : fallbackDraft.source_citations
  );
  const safetyFlags = [
    ...(citations.length ? [] : [{
      severity: 'high',
      code: 'NO_TEACH_BACK_CITATIONS',
      message: 'Patient teach-back output has no source citations.',
    }]),
    ...(draft.misunderstanding_flags?.some((flag) => flag.severity === 'critical') ? [{
      severity: 'critical',
      code: 'CRITICAL_TEACH_BACK_GAP',
      message: 'Critical comprehension gap requires clinician review.',
    }] : []),
    ...asArray(draft.safety_flags),
    ...runOutputDefenses({
      draft,
      module,
      context: { questions: draft.questions },
      citations,
    }),
  ];
  draft.safety_flags = safetyFlags;

  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid: resolvedPatientUid,
    prompt,
    sourceHashValue: sourceHash({
      admission_id: safeAdmissionId,
      source_generation_id: safeSourceGenerationId,
      language: normalizedLanguage,
      questions: draft.questions,
    }),
    draft,
    citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    metadata: {
      admission_id: safeAdmissionId,
      source_generation_id: safeSourceGenerationId,
      language: normalizedLanguage,
      coverage: built.coverage,
      fallback_reason: aiResult.usedAi ? null : aiResult.reason || 'template_or_rule_output',
      rules_authoritative: true,
    },
  });

  const sessionRow = await insertSessionRow({
    tenantId,
    patientUid: resolvedPatientUid,
    admissionId: safeAdmissionId,
    generationId: generation?.id || null,
    sourceGenerationId: safeSourceGenerationId,
    language: normalizedLanguage,
    status: draft.status || 'draft',
    questions: draft.questions,
    answers: [],
    misunderstandings: draft.misunderstanding_flags,
    comprehensionScore: draft.comprehension_score,
    citations,
    safetyFlags,
    metadata: {
      used_ai: Boolean(aiResult.usedAi),
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      coverage: built.coverage,
      rules_authoritative: true,
    },
  });
  if (!sessionRow) {
    return {
      session_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: citations,
      safety_flags: safetyFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      session_status: 'schema_unavailable',
      reason: 'clinical_ai_teach_back_sessions_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      decision_support_only: true,
      language: normalizedLanguage,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    admissionId: safeAdmissionId,
    patientUid: resolvedPatientUid,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.patient_teach_back_session_generated',
    aggregateType: 'clinical_ai_teach_back_session',
    aggregateId: sessionRow?.id || generation?.id || safeAdmissionId,
    patientUid: resolvedPatientUid,
    payload: {
      tenant_id: tenantId,
      admission_id: safeAdmissionId,
      session_id: sessionRow?.id || null,
      generation_id: generation?.id || null,
      language: normalizedLanguage,
      question_count: draft.questions.length,
      comprehension_score: draft.comprehension_score,
    },
  });

  return {
    session_id: sessionRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    session: sessionRow,
    source_citations: citations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    session_status: sessionRow?.status || draft.status,
    review_status: clinicalReview?.decision || sessionRow?.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      used_ai: Boolean(aiResult.usedAi),
      usage: aiResult.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
    language: normalizedLanguage,
  };
}

export async function submitTeachBackAnswers({
  req = null,
  sessionId,
  answers = [],
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const safeSessionId = optionalInt(sessionId, 'session_id');
  if (!Array.isArray(answers)) {
    throw AppError.badRequest('answers must be an array');
  }

  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, questions, source_citations, safety_flags, language, metadata
     FROM clinical_ai_teach_back_sessions
     WHERE id = $1
       AND tenant_id = $2::uuid
     LIMIT 1`,
    safeSessionId,
    tenantId
  );
  const session = existing[0];
  if (!session) throw AppError.notFound('Teach-back session not found');

  const questions = asArray(session.questions);
  const scoring = scoreTeachBackAnswers({ questions, answers });
  const misunderstandings = detectTeachBackMisunderstandings({ questions, answers });
  const criticalGap = misunderstandings.some((flag) => flag.severity === 'critical' || flag.severity === 'high');
  const newStatus = scoring.answered_count === 0
    ? 'draft'
    : criticalGap
      ? 'needs_clinician_review'
      : scoring.answered_count === questions.length
        ? 'completed'
        : 'in_progress';

  const safetyFlags = asArray(session.safety_flags).filter((flag) => flag.code !== 'CRITICAL_TEACH_BACK_GAP');
  if (criticalGap) {
    safetyFlags.push({
      severity: 'critical',
      code: 'CRITICAL_TEACH_BACK_GAP',
      message: 'Critical comprehension gap requires clinician review.',
    });
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_teach_back_sessions
     SET patient_answers = $2::jsonb,
         misunderstanding_flags = $3::jsonb,
         comprehension_score = $4,
         status = $5,
         safety_flags = $6::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $7::uuid
     RETURNING id, tenant_id, patient_uid, admission_id, generation_id, source_generation_id,
               language, status, questions, patient_answers, misunderstanding_flags,
               comprehension_score, source_citations, safety_flags, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata, created_at, updated_at`,
    safeSessionId,
    JSON.stringify(answers),
    JSON.stringify(misunderstandings),
    scoring.score,
    newStatus,
    JSON.stringify(safetyFlags),
    tenantId
  );
  if (!rows[0]) throw AppError.notFound('Teach-back session not found');

  await publishEvent({
    eventType: 'clinical_ai.patient_teach_back_answers_submitted',
    aggregateType: 'clinical_ai_teach_back_session',
    aggregateId: rows[0].id,
    patientUid: rows[0].patient_uid,
    payload: {
      tenant_id: tenantId,
      admission_id: rows[0].admission_id,
      session_id: rows[0].id,
      language: rows[0].language,
      comprehension_score: scoring.score,
      misunderstanding_count: misunderstandings.length,
      status: newStatus,
    },
  });

  return {
    ...rows[0],
    evaluated_answers: scoring.evaluated,
  };
}

export async function listTeachBackSessions({
  tenantId = null,
  patientUid = null,
  admissionId = null,
  status = null,
  decision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const aid = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const normalizedDecision = decision && DECISIONS.has(cleanText(decision).toLowerCase())
    ? cleanText(decision).toLowerCase()
    : null;
  const normalizedStatus = status && STATUSES.has(cleanText(status).toLowerCase())
    ? cleanText(status).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT s.id, s.tenant_id, s.patient_uid, u.name AS patient_name,
              s.admission_id, s.generation_id, s.source_generation_id,
              s.language, s.status, s.questions, s.patient_answers,
              s.misunderstanding_flags, s.comprehension_score,
              s.source_citations, s.safety_flags, s.reviewer_decision,
              s.reviewed_by, s.reviewed_at, s.reviewer_note, s.metadata,
              s.created_at, s.updated_at
       FROM clinical_ai_teach_back_sessions s
       LEFT JOIN users u ON u.uid = s.patient_uid
       WHERE s.tenant_id = $1::uuid
         AND ($2::int IS NULL OR s.admission_id = $2)
         AND ($3::uuid IS NULL OR s.patient_uid = $3::uuid)
         AND ($4::text IS NULL OR s.reviewer_decision = $4)
         AND ($5::text IS NULL OR s.status = $5)
       ORDER BY
         CASE s.status
           WHEN 'needs_clinician_review' THEN 0
           WHEN 'in_progress' THEN 1
           WHEN 'draft' THEN 2
           WHEN 'completed' THEN 3
           ELSE 4
         END,
         s.created_at DESC
       LIMIT $6`,
      tid,
      aid,
      patientUid || null,
      normalizedDecision,
      normalizedStatus,
      safeLimit
    );
    return { sessions: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { sessions: [], count: 0 };
    throw err;
  }
}

export async function decideTeachBackSession({
  tenantId = null,
  sessionId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, or rejected');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_teach_back_sessions
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, admission_id, patient_uid, generation_id,
               comprehension_score, status, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(sessionId, 'session_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Teach-back session not found');
  return rows[0];
}

export default {
  buildTeachBackQuestions,
  decideTeachBackSession,
  detectTeachBackMisunderstandings,
  generateTeachBackSession,
  listTeachBackSessions,
  scoreTeachBackAnswers,
  submitTeachBackAnswers,
};
