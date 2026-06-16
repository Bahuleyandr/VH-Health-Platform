/**
 * Sepsis Bundle Sentinel.
 *
 * Checks suspected-sepsis criteria and bundle completion from cited chart
 * evidence. Decision support only: clinicians remain the source of truth.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { collectAdmissionClinicalContext } from '../emr/clinicalTimelineService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'sepsis_bundle_sentinel';
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You support sepsis bundle review. Use only supplied chart evidence and return JSON only.',
  user_prompt_template: 'Summarize suspected sepsis criteria and bundle gaps without issuing orders.',
};
const ANTIBIOTIC_TERMS = [
  'amoxicillin',
  'ampicillin',
  'azithromycin',
  'cefepime',
  'cefixime',
  'cefoperazone',
  'cefotaxime',
  'ceftazidime',
  'ceftriaxone',
  'ciprofloxacin',
  'clindamycin',
  'colistin',
  'doxycycline',
  'gentamicin',
  'imipenem',
  'levofloxacin',
  'linezolid',
  'meropenem',
  'metronidazole',
  'piperacillin',
  'tazobactam',
  'teicoplanin',
  'tigecycline',
  'vancomycin',
];
const INFECTION_TERMS = [
  'sepsis',
  'septic',
  'infection',
  'pneumonia',
  'uti',
  'pyelonephritis',
  'cellulitis',
  'abscess',
  'wound infection',
  'culture positive',
  'bacteremia',
];
const CULTURE_TERMS = ['culture', 'blood culture', 'urine culture', 'sputum culture', 'wound culture', 'microbiology'];
const FLUID_TERMS = ['fluid bolus', 'normal saline', 'ringer', 'rl bolus', 'iv fluids', 'resuscitation'];
const VASOPRESSOR_TERMS = ['noradrenaline', 'norepinephrine', 'vasopressin', 'adrenaline', 'epinephrine', 'dopamine', 'vasopressor'];

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').trim();
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

function eventText(event) {
  return normalizedText(`${event?.summary || ''} ${JSON.stringify(event?.payload || {})}`);
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function payloadNumber(event, key) {
  const value = event?.payload?.[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventCitation(event, label = null) {
  if (!event) return null;
  return {
    source_type: event.event_type || 'chart',
    source_id: event.id === null || event.id === undefined ? null : String(event.id),
    label: label || event.summary || event.event_type || 'Chart evidence',
    timestamp: event.timestamp || event.payload?.created_at || null,
  };
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

function makeFinding({ severity, code, category, title, recommendation, evidence = [] }) {
  return {
    severity,
    code,
    category,
    title,
    recommendation,
    evidence: asArray(evidence).filter(Boolean).slice(0, 8),
  };
}

function severityWeight(severity) {
  if (severity === 'critical') return 35;
  if (severity === 'high') return 22;
  if (severity === 'medium') return 10;
  return 4;
}

function riskBandFor(score, findings) {
  if (findings.some((finding) => finding.severity === 'critical') || score >= 90) return 'critical';
  if (findings.some((finding) => finding.severity === 'high') || score >= 50) return 'high';
  if (findings.some((finding) => finding.severity === 'medium') || score >= 25) return 'medium';
  return 'low';
}

function extractLactate(text) {
  const match = /lactate[^0-9]{0,16}(\d+(?:\.\d+)?)/i.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function latestSummary(events, limit = 8) {
  return asArray(events)
    .slice(-limit)
    .map((event) => ({
      id: event.id,
      type: event.event_type,
      summary: event.summary,
      timestamp: event.timestamp,
    }));
}

function buildChartPacket(context) {
  return {
    patient: {
      uid: context.patient?.uid || context.admission?.patient_uid || null,
      name: context.patient?.name || null,
    },
    admission: {
      id: context.admission?.id || null,
      ward: context.admission?.ward || null,
      status: context.admission?.status || null,
      admitted_at: context.admission?.admitted_at || context.admission?.created_at || null,
    },
    recent: {
      vitals: latestSummary(context.vitals),
      medications: latestSummary(context.medications),
      investigations: latestSummary(context.investigations),
      notes: latestSummary(context.notes, 5),
      orders: latestSummary(context.orders, 5),
    },
  };
}

export function evaluateSepsisBundleRisk(context = {}) {
  const criteria = [];
  const bundleGaps = [];
  const citations = [];
  const vitals = asArray(context.vitals);
  const medications = asArray(context.medications);
  const investigations = asArray(context.investigations);
  const notes = asArray(context.notes);
  const orders = asArray(context.orders);
  const timeline = [
    ...vitals,
    ...medications,
    ...investigations,
    ...notes,
    ...orders,
    ...asArray(context.diagnoses),
  ];
  const add = (target, finding) => {
    target.push(makeFinding(finding));
    for (const item of asArray(finding.evidence)) {
      if (item?.citation) citations.push(item.citation);
    }
  };

  const infectionEvents = timeline.filter((event) => hasAny(eventText(event), INFECTION_TERMS));
  const antibioticEvents = medications.filter((event) => hasAny(eventText(event), ANTIBIOTIC_TERMS));
  const cultureEvents = investigations.filter((event) => hasAny(eventText(event), CULTURE_TERMS));
  const lactateEvents = investigations
    .map((event) => ({ event, lactate: extractLactate(eventText(event)) }))
    .filter((item) => item.lactate !== null);
  const fluidEvents = [...orders, ...medications, ...notes].filter((event) => hasAny(eventText(event), FLUID_TERMS));
  const vasopressorEvents = [...orders, ...medications, ...notes].filter((event) => hasAny(eventText(event), VASOPRESSOR_TERMS));
  const feverEvents = vitals.filter((event) => {
    const temp = payloadNumber(event, 'temperature');
    return temp !== null && (temp >= 38 || temp <= 36);
  });
  const hypotensionEvents = vitals.filter((event) => {
    const sbp = payloadNumber(event, 'systolic_bp');
    return sbp !== null && sbp <= 90;
  });
  const tachyEvents = vitals.filter((event) => {
    const hr = payloadNumber(event, 'heart_rate');
    return hr !== null && hr >= 100;
  });
  const tachypneaEvents = vitals.filter((event) => {
    const rr = payloadNumber(event, 'respiratory_rate');
    return rr !== null && rr >= 22;
  });
  const hypoxiaEvents = vitals.filter((event) => {
    const spo2 = payloadNumber(event, 'spo2');
    return spo2 !== null && spo2 < 92;
  });

  if (infectionEvents.length || antibioticEvents.length || cultureEvents.length) {
    add(criteria, {
      severity: 'medium',
      code: 'INFECTION_SUSPECTED',
      category: 'sepsis_criteria',
      title: 'Chart evidence suggests possible infection or antimicrobial treatment.',
      recommendation: 'Review source, culture status, and antimicrobial rationale.',
      evidence: [...infectionEvents, ...antibioticEvents, ...cultureEvents].slice(0, 5).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, 'Possible infection evidence'),
      })),
    });
  }

  const physiologySignals = [
    { events: feverEvents, code: 'TEMP_DERANGEMENT', title: 'Fever or hypothermia is documented.', label: 'Temperature criterion' },
    { events: hypotensionEvents, code: 'HYPOTENSION', title: 'Systolic blood pressure is <= 90.', label: 'Hypotension criterion' },
    { events: tachyEvents, code: 'TACHYCARDIA', title: 'Tachycardia is documented.', label: 'Tachycardia criterion' },
    { events: tachypneaEvents, code: 'TACHYPNEA', title: 'Tachypnea is documented.', label: 'Tachypnea criterion' },
    { events: hypoxiaEvents, code: 'HYPOXIA', title: 'Hypoxia is documented.', label: 'Hypoxia criterion' },
  ];

  for (const signal of physiologySignals) {
    if (!signal.events.length) continue;
    add(criteria, {
      severity: signal.code === 'HYPOTENSION' || signal.code === 'HYPOXIA' ? 'high' : 'medium',
      code: signal.code,
      category: 'sepsis_criteria',
      title: signal.title,
      recommendation: 'Correlate with current bedside assessment and repeat vitals per escalation policy.',
      evidence: signal.events.slice(0, 4).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, signal.label),
      })),
    });
  }

  const severeLactate = lactateEvents.filter((item) => item.lactate >= 4);
  const elevatedLactate = lactateEvents.filter((item) => item.lactate >= 2 && item.lactate < 4);
  if (severeLactate.length) {
    add(criteria, {
      severity: 'critical',
      code: 'LACTATE_GE_4',
      category: 'sepsis_criteria',
      title: 'Lactate appears >= 4 mmol/L in chart text.',
      recommendation: 'Escalate urgently for septic shock review and resuscitation status.',
      evidence: severeLactate.slice(0, 3).map((item) => ({
        lactate: item.lactate,
        citation: eventCitation(item.event, 'Severe lactate signal'),
      })),
    });
  } else if (elevatedLactate.length) {
    add(criteria, {
      severity: 'high',
      code: 'LACTATE_ELEVATED',
      category: 'sepsis_criteria',
      title: 'Lactate appears >= 2 mmol/L in chart text.',
      recommendation: 'Review repeat lactate and sepsis bundle timing.',
      evidence: elevatedLactate.slice(0, 3).map((item) => ({
        lactate: item.lactate,
        citation: eventCitation(item.event, 'Elevated lactate signal'),
      })),
    });
  }

  const suspectedSepsis = (infectionEvents.length || antibioticEvents.length || cultureEvents.length)
    && criteria.filter((item) => item.category === 'sepsis_criteria').length >= 3;
  const shockSignal = hypotensionEvents.length > 0 || severeLactate.length > 0 || vasopressorEvents.length > 0;

  if (suspectedSepsis && cultureEvents.length === 0) {
    add(bundleGaps, {
      severity: 'high',
      code: 'BLOOD_CULTURE_EVIDENCE_MISSING',
      category: 'bundle_gap',
      title: 'Culture evidence is missing from the chart packet.',
      recommendation: 'Verify cultures were ordered before antibiotics where clinically appropriate.',
    });
  }
  if (suspectedSepsis && lactateEvents.length === 0) {
    add(bundleGaps, {
      severity: 'high',
      code: 'LACTATE_EVIDENCE_MISSING',
      category: 'bundle_gap',
      title: 'Lactate evidence is missing from the chart packet.',
      recommendation: 'Verify lactate measurement and repeat timing per local sepsis policy.',
    });
  }
  if (suspectedSepsis && antibioticEvents.length === 0) {
    add(bundleGaps, {
      severity: 'critical',
      code: 'ANTIBIOTIC_EVIDENCE_MISSING',
      category: 'bundle_gap',
      title: 'Antibiotic administration is missing despite suspected sepsis signals.',
      recommendation: 'Escalate immediately to the treating clinician for antibiotic review. Do not auto-order.',
    });
  }
  if (shockSignal && fluidEvents.length === 0 && vasopressorEvents.length === 0) {
    add(bundleGaps, {
      severity: 'critical',
      code: 'SHOCK_RESUSCITATION_EVIDENCE_MISSING',
      category: 'bundle_gap',
      title: 'Shock physiology is present without fluid or vasopressor evidence in the packet.',
      recommendation: 'Escalate urgently for bedside shock/resuscitation review. Do not auto-order.',
      evidence: [...hypotensionEvents, ...severeLactate.map((item) => item.event)].slice(0, 5).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, 'Shock signal'),
      })),
    });
  }

  if (!criteria.length && !bundleGaps.length) {
    add(criteria, {
      severity: 'low',
      code: 'NO_SEPSIS_BUNDLE_SIGNAL',
      category: 'baseline',
      title: 'No suspected sepsis bundle signal was detected in the available packet.',
      recommendation: 'Continue routine deterioration surveillance and repeat review if new vitals/labs arrive.',
    });
  }

  const findings = [...criteria, ...bundleGaps];
  const riskScore = Math.min(100, findings.reduce((sum, item) => sum + severityWeight(item.severity), 0));
  const riskBand = riskBandFor(riskScore, findings);
  return {
    risk_score: riskScore,
    risk_band: riskBand,
    criteria,
    bundle_gaps: bundleGaps,
    recommendations: findings.map((item) => ({
      code: item.code,
      severity: item.severity,
      recommendation: item.recommendation,
    })),
    summary: `${criteria.length} criteria signal(s), ${bundleGaps.length} bundle gap(s).`,
    suspected_sepsis: suspectedSepsis,
    shock_signal: shockSignal,
    source_citations: uniqueCitations(citations.length ? citations : asArray(context.citations).slice(0, 10)),
    safety_flags: [],
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
    usage.estimated_cost_minor || 0,
    aiResult?.latencyMs || null,
    aiResult?.requestId || null,
    aiResult?.finishReason || null,
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
        review_roles: module.settings?.reviewRoles || ['DOCTOR', 'NURSING_STAFF', 'ICU_TEAM'],
        source: 'sepsis_bundle_sentinel',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Sepsis bundle review placeholder failed', { error: err.message });
    }
    return null;
  }
}

export async function generateSepsisBundleAudit({ req = null, admissionId } = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const safeAdmissionId = optionalInt(admissionId, 'admission_id');
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const context = await collectAdmissionClinicalContext(safeAdmissionId);
  const packet = buildChartPacket(context);
  const fallbackDraft = evaluateSepsisBundleRisk(context);
  const prompt = await getActivePrompt(tenantId);
  const aiResult = await generateClinicalText({
    taskType: MODULE_KEY,
    systemPrompt: prompt.system_prompt,
    userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
      chart_packet: packet,
      rule_based_audit: fallbackDraft,
    })}`,
    tenantRegion: req?.tenant?.region || null,
    tenantId,
  });
  const draft = safeJsonParse(aiResult.text, fallbackDraft);
  const normalizedDraft = {
    ...fallbackDraft,
    ...(draft && typeof draft === 'object' ? draft : {}),
    risk_score: Number.isFinite(Number(draft?.risk_score))
      ? Math.max(0, Math.min(100, Number.parseInt(draft.risk_score, 10)))
      : fallbackDraft.risk_score,
    risk_band: ['low', 'medium', 'high', 'critical'].includes(String(draft?.risk_band))
      ? String(draft.risk_band)
      : fallbackDraft.risk_band,
    criteria: asArray(draft?.criteria).length ? draft.criteria : fallbackDraft.criteria,
    bundle_gaps: asArray(draft?.bundle_gaps).length ? draft.bundle_gaps : fallbackDraft.bundle_gaps,
    recommendations: asArray(draft?.recommendations).length ? draft.recommendations : fallbackDraft.recommendations,
  };
  const citations = uniqueCitations(
    asArray(normalizedDraft.source_citations).length
      ? normalizedDraft.source_citations
      : fallbackDraft.source_citations
  );
  const safetyFlags = [
    ...(citations.length ? [] : [{
      severity: 'high',
      code: 'NO_SEPSIS_BUNDLE_CITATIONS',
      message: 'Sepsis bundle sentinel output has no source citations.',
    }]),
    ...(normalizedDraft.risk_band === 'critical' ? [{
      severity: 'critical',
      code: 'CRITICAL_SEPSIS_BUNDLE_SIGNAL',
      message: 'Critical sepsis bundle signal requires immediate human review.',
    }] : []),
    ...asArray(normalizedDraft.safety_flags),
    ...runOutputDefenses({
      draft: normalizedDraft,
      module,
      context: packet,
      citations,
    }),
  ];
  const sourceHashValue = sourceHash({ admission_id: safeAdmissionId, packet, fallbackDraft });
  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    prompt,
    sourceHashValue,
    draft: normalizedDraft,
    citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    metadata: {
      admission_id: safeAdmissionId,
      tenant_region: req?.tenant?.region || null,
      suspected_sepsis: normalizedDraft.suspected_sepsis,
      shock_signal: normalizedDraft.shock_signal,
      fallback_reason: aiResult.usedAi ? null : aiResult.reason || 'template_or_rule_output',
    },
  });

  let audit = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_sepsis_bundle_audits
         (tenant_id, admission_id, patient_uid, generation_id, risk_score,
          risk_band, criteria, bundle_gaps, recommendations, source_citations,
          safety_flags, reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb,
               $9::jsonb, $10::jsonb, $11::jsonb, 'pending', $12::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, admission_id, patient_uid, generation_id,
                 risk_score, risk_band, criteria, bundle_gaps,
                 recommendations, source_citations, safety_flags,
                 reviewer_decision, created_at, updated_at`,
      tenantId,
      safeAdmissionId,
      context.admission?.patient_uid || null,
      generation?.id || null,
      normalizedDraft.risk_score,
      normalizedDraft.risk_band,
      JSON.stringify(normalizedDraft.criteria),
      JSON.stringify(normalizedDraft.bundle_gaps),
      JSON.stringify(normalizedDraft.recommendations),
      JSON.stringify(citations),
      JSON.stringify(safetyFlags),
      JSON.stringify({
        used_ai: Boolean(aiResult.usedAi),
        provider: aiResult.provider || 'template',
        model: aiResult.model || null,
      })
    );
    audit = rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        audit_id: null,
        generation_id: generation?.id || null,
        draft: normalizedDraft,
        source_citations: citations,
        safety_flags: safetyFlags,
        module_key: MODULE_KEY,
        review_status: 'schema_unavailable',
        reason: 'clinical_ai_sepsis_bundle_audits_unavailable',
        decision_support_only: true,
      };
    }
    throw err;
  }

  const review = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    admissionId: safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.sepsis_bundle_audit_generated',
    aggregateType: 'clinical_ai_sepsis_bundle_audit',
    aggregateId: audit?.id || generation?.id || safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    payload: {
      tenant_id: tenantId,
      admission_id: safeAdmissionId,
      audit_id: audit?.id || null,
      generation_id: generation?.id || null,
      risk_band: normalizedDraft.risk_band,
      risk_score: normalizedDraft.risk_score,
    },
  });

  return {
    audit_id: audit?.id || null,
    generation_id: generation?.id || null,
    review_id: review?.id || null,
    draft: normalizedDraft,
    audit,
    source_citations: citations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: review?.decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      used_ai: Boolean(aiResult.usedAi),
      usage: aiResult.usage || {},
    },
    decision_support_only: true,
  };
}

export async function listSepsisBundleAudits({
  tenantId = null,
  admissionId = null,
  patientUid = null,
  decision = null,
  riskBand = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const aid = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.admission_id, a.patient_uid, u.name AS patient_name,
              a.generation_id, a.risk_score, a.risk_band, a.criteria,
              a.bundle_gaps, a.recommendations, a.source_citations,
              a.safety_flags, a.reviewer_decision, a.reviewed_by,
              a.reviewed_at, a.reviewer_note, a.metadata, a.created_at, a.updated_at
       FROM clinical_ai_sepsis_bundle_audits a
       LEFT JOIN users u ON u.uid = a.patient_uid
       WHERE a.tenant_id = $1::uuid
         AND ($2::int IS NULL OR a.admission_id = $2)
         AND ($3::uuid IS NULL OR a.patient_uid = $3::uuid)
         AND ($4::text IS NULL OR a.reviewer_decision = $4)
         AND ($5::text IS NULL OR a.risk_band = $5)
       ORDER BY a.created_at DESC
       LIMIT $6`,
      tid,
      aid,
      patientUid || null,
      decision || null,
      riskBand || null,
      safeLimit
    );
    return { audits: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { audits: [], count: 0 };
    throw err;
  }
}

export async function decideSepsisBundleAudit({
  tenantId = null,
  auditId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!['acknowledged', 'escalated', 'dismissed'].includes(normalized)) {
    throw AppError.badRequest('decision must be acknowledged, escalated, or dismissed');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_sepsis_bundle_audits
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, admission_id, patient_uid, risk_score, risk_band,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(auditId, 'audit_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Sepsis bundle audit not found');
  return rows[0];
}

export default {
  decideSepsisBundleAudit,
  evaluateSepsisBundleRisk,
  generateSepsisBundleAudit,
  listSepsisBundleAudits,
};
