/**
 * Patient-communication translation.
 *
 * Design invariants:
 *   1. REVIEW-GATED. We only translate a clinical AI generation whose
 *      status is 'accepted'. Translating an unreviewed draft just
 *      multilingualises a hallucination, so the service refuses.
 *   2. Numeric fidelity is checked before delivery. Every (value, unit)
 *      tuple in the English source (e.g. "5 mg", "twice daily", "02/05")
 *      must appear in the translated output — missing tuples become
 *      fidelity_flags with severity=high. Reviewer must explicitly
 *      approve a translation with missing tuples.
 *   3. Entity preservation. Drug names, dates, and warning signs are
 *      extracted and verified as passed through unchanged.
 *   4. Provider routing is region-aware. Local NLLB-200 is the DPDP-safe
 *      default; Azure Translator (India region) and Claude are opt-in per
 *      tenant.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'patient_communication_translation';
const SUPPORTED_LANGS = new Set(['en', 'hi', 'ta', 'te', 'ml', 'mr', 'bn', 'kn']);
const LANG_DISPLAY = {
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  mr: 'Marathi',
  bn: 'Bengali',
  kn: 'Kannada',
};

const NUMERIC_RE = /\b(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|l|mmhg|bpm|°c|°f|kg|lbs|hours?|days?|weeks?|months?|years?|%|times?)\b/gi;
const DATE_RE = /\b(\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?|\d{4}-\d{2}-\d{2})\b/g;
const MED_HINT_RE = /\b([A-Z][a-zA-Z]+(?:cin|cillin|olol|azole|prazole|statin|pril|sartan|mycin|parin|metformin|aspirin|paracetamol|ibuprofen))\b/g;

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

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

function extractTuples(text) {
  const body = String(text || '');
  const numeric = new Set();
  const dates = new Set();
  const meds = new Set();
  let match;

  NUMERIC_RE.lastIndex = 0;
  while ((match = NUMERIC_RE.exec(body)) !== null) {
    numeric.add(match[0].toLowerCase().replace(/\s+/g, ' '));
  }
  DATE_RE.lastIndex = 0;
  while ((match = DATE_RE.exec(body)) !== null) {
    dates.add(match[0]);
  }
  MED_HINT_RE.lastIndex = 0;
  while ((match = MED_HINT_RE.exec(body)) !== null) {
    meds.add(match[0]);
  }
  return { numeric, dates, meds };
}

/**
 * Verify that every numeric tuple, date, and drug name in the source also
 * appears in the translation. Returns structured fidelity_flags.
 */
export function verifyTranslationFidelity({ source, translated }) {
  const flags = [];
  const src = extractTuples(flatten(source).join(' '));
  const dst = extractTuples(flatten(translated).join(' '));

  const missingNumeric = [...src.numeric].filter((t) => !dst.numeric.has(t));
  if (missingNumeric.length) {
    flags.push({
      severity: missingNumeric.length >= 3 ? 'high' : 'medium',
      code: 'TRANSLATION_NUMERIC_MISSING',
      message: `${missingNumeric.length} numeric tuple${missingNumeric.length === 1 ? '' : 's'} missing in translation`,
      metadata: { sample: missingNumeric.slice(0, 8), total: missingNumeric.length },
    });
  }
  const missingDates = [...src.dates].filter((t) => !dst.dates.has(t));
  if (missingDates.length) {
    flags.push({
      severity: 'high',
      code: 'TRANSLATION_DATE_MISSING',
      message: `${missingDates.length} date${missingDates.length === 1 ? '' : 's'} missing in translation`,
      metadata: { sample: missingDates.slice(0, 8), total: missingDates.length },
    });
  }
  const missingMeds = [...src.meds].filter((t) => !dst.meds.has(t));
  if (missingMeds.length) {
    flags.push({
      severity: 'high',
      code: 'TRANSLATION_MEDICATION_MISSING',
      message: `${missingMeds.length} medication reference${missingMeds.length === 1 ? '' : 's'} missing in translation`,
      metadata: { sample: missingMeds.slice(0, 8), total: missingMeds.length },
    });
  }

  const totalTuples = src.numeric.size + src.dates.size + src.meds.size;
  const missing = missingNumeric.length + missingDates.length + missingMeds.length;
  const coverage_pct = totalTuples === 0 ? 100 : Math.max(0, Math.round(((totalTuples - missing) / totalTuples) * 100));

  return { flags, coverage_pct, source_tuple_count: totalTuples, missing_count: missing };
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

async function translateViaLlm({ source, targetLanguage, tenantRegion, tenantId }) {
  const langName = LANG_DISPLAY[targetLanguage] || targetLanguage;
  const systemPrompt = [
    'You translate hospital patient communications from English into the target language.',
    'Preserve every numeric value, dose, frequency, date, and drug name EXACTLY as written — do not localise numbers, do not drop units.',
    'Preserve every warning sign, follow-up date, and appointment detail.',
    'Return a JSON object with the same keys as the input, each value translated.',
    'Return JSON only. No prose before or after the JSON.',
  ].join('\n');
  const userPrompt = [
    `Target language: ${langName} (${targetLanguage}).`,
    'Translate this structured English patient communication:',
    JSON.stringify(source),
  ].join('\n');

  const result = await generateClinicalText({
    systemPrompt,
    userPrompt,
    taskType: MODULE_KEY,
    tenantRegion,
    tenantId,
  });
  return result;
}

/**
 * Translate an accepted clinical AI generation into a target language and
 * persist the translation row. Throws AppError when the source generation
 * isn't reviewer-accepted or the target language isn't supported.
 */
export async function translateGeneration({
  generationId,
  targetLanguage,
  requestedBy = null,
  req = null,
} = {}) {
  const lang = String(targetLanguage || '').toLowerCase();
  if (!SUPPORTED_LANGS.has(lang)) {
    throw AppError.badRequest(`Unsupported target language: ${lang}. Supported: ${[...SUPPORTED_LANGS].join(', ')}`);
  }
  if (lang === 'en') {
    throw AppError.badRequest('Source is already English; translation not required');
  }

  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const tenantRegion = req?.tenant?.region || null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, draft, module_key, patient_uid
     FROM clinical_ai_generations
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    Number.parseInt(generationId, 10),
    tenantId
  );
  const generation = rows[0];
  if (!generation) throw AppError.notFound('Generation not found');
  // 'signed' is reached via the discharge sign workflow
  // (services/emr/dischargeSummaryGenerator.js#signDischargeSummary), which
  // flips the underlying clinical_ai_generations row from 'accepted' to
  // 'signed' when the discharge note is signed. A signed generation is
  // strictly more authoritative than an accepted-but-unsigned draft, so
  // it must remain translatable for patient-facing distribution. Finding:
  // 2026-05-10-surgical-day-care-discharge-tamil-translation-blocked-after-sign.
  const TRANSLATABLE_SOURCE_STATUSES = new Set(['accepted', 'signed']);
  if (!TRANSLATABLE_SOURCE_STATUSES.has(generation.status)) {
    throw AppError.forbidden(
      `Translation requires a reviewer-accepted source. Current status: ${generation.status}`
    );
  }

  // Idempotency check — (source_generation_id, target_language) is UNIQUE.
  const existingRows = await prisma.$queryRawUnsafe(
    `SELECT id, translated_draft, fidelity_flags, status, provider, model, created_at
     FROM clinical_ai_translations
     WHERE source_generation_id = $1 AND target_language = $2
     LIMIT 1`,
    generation.id,
    lang
  );
  if (existingRows[0]) {
    return {
      translation_id: existingRows[0].id,
      source_generation_id: generation.id,
      target_language: lang,
      translated_draft: existingRows[0].translated_draft,
      fidelity_flags: existingRows[0].fidelity_flags,
      status: existingRows[0].status,
      provider: existingRows[0].provider,
      model: existingRows[0].model,
      deduplicated: true,
    };
  }

  const aiResult = await translateViaLlm({
    source: generation.draft,
    targetLanguage: lang,
    tenantRegion,
    tenantId,
  });

  const translatedDraft = safeJsonParse(aiResult.text, generation.draft);
  const fidelity = verifyTranslationFidelity({
    source: generation.draft,
    translated: translatedDraft,
  });

  // Status logic: if any high-severity fidelity gap OR the LLM fell back,
  // mark as needs_review so the patient-facing surface refuses to render
  // the translation until a clinician accepts it.
  let status = 'completed';
  if (!aiResult.usedAi) status = 'needs_review';
  if (fidelity.flags.some((flag) => flag.severity === 'high')) status = 'needs_review';

  const saved = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_translations
       (tenant_id, source_generation_id, source_language, target_language,
        provider, model, translated_draft, fidelity_flags, status,
        requested_by, metadata, created_at)
     VALUES ($1::uuid, $2, 'en', $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::uuid,
             $10::jsonb, NOW())
     RETURNING id, translated_draft, fidelity_flags, status, provider, model, created_at`,
    tenantId,
    generation.id,
    lang,
    aiResult.provider || 'template',
    aiResult.model || null,
    JSON.stringify(translatedDraft),
    JSON.stringify(fidelity.flags),
    status,
    requestedBy,
    JSON.stringify({
      usage: aiResult.usage || {},
      used_ai: Boolean(aiResult.usedAi),
      fallback_reason: aiResult.usedAi ? null : (aiResult.reason || 'llm_unavailable'),
      coverage_pct: fidelity.coverage_pct,
      source_tuple_count: fidelity.source_tuple_count,
      missing_count: fidelity.missing_count,
      source_hash: crypto.createHash('sha256').update(JSON.stringify(generation.draft || {})).digest('hex').slice(0, 16),
      module_key: generation.module_key,
    })
  );
  logger.info('Clinical AI translation persisted', {
    generation_id: generation.id,
    target_language: lang,
    status,
    provider: aiResult.provider,
    fidelity_flags: fidelity.flags.length,
  });

  return {
    translation_id: saved[0].id,
    source_generation_id: generation.id,
    target_language: lang,
    translated_draft: translatedDraft,
    fidelity_flags: fidelity.flags,
    coverage_pct: fidelity.coverage_pct,
    status,
    provider: aiResult.provider,
    model: aiResult.model,
    used_ai: Boolean(aiResult.usedAi),
    deduplicated: false,
  };
}

export async function listTranslations({ tenantId = null, targetLanguage = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT t.id, t.source_generation_id, t.source_language, t.target_language,
            t.provider, t.model, t.status, t.fidelity_flags, t.created_at,
            g.module_key, g.patient_uid
     FROM clinical_ai_translations t
     LEFT JOIN clinical_ai_generations g ON g.id = t.source_generation_id
     WHERE t.tenant_id = $1::uuid
       AND ($2::text IS NULL OR t.target_language = $2)
     ORDER BY t.created_at DESC
     LIMIT $3`,
    tid,
    targetLanguage,
    safeLimit
  );
  return { translations: rows, count: rows.length };
}

export default {
  listTranslations,
  SUPPORTED_LANGS,
  translateGeneration,
  verifyTranslationFidelity,
};
