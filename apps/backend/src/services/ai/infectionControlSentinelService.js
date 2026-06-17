/**
 * Infection Control Sentinel.
 *
 * Finds likely HAI, isolation, culture, and antimicrobial-stewardship risks
 * from cited chart evidence. It is decision support only: it never places
 * isolation orders, changes medications, or mutates clinical state.
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

const MODULE_KEY = 'infection_control_sentinel';
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You support infection-control review. Use only supplied chart evidence and return JSON only.',
  user_prompt_template: 'Summarize infection-control risks without inventing evidence or issuing orders.',
};
const ANTIBIOTIC_TERMS = [
  'amoxicillin',
  'ampicillin',
  'azithromycin',
  'cefazolin',
  'cefepime',
  'cefixime',
  'cefoperazone',
  'cefotaxime',
  'ceftazidime',
  'ceftriaxone',
  'ciprofloxacin',
  'clarithromycin',
  'clindamycin',
  'colistin',
  'doxycycline',
  'ertapenem',
  'gentamicin',
  'imipenem',
  'levofloxacin',
  'linezolid',
  'meropenem',
  'metronidazole',
  'piperacillin',
  'polymyxin',
  'teicoplanin',
  'tigecycline',
  'tazobactam',
  'vancomycin',
];
const BROAD_SPECTRUM_TERMS = [
  'cefepime',
  'ceftazidime',
  'cefoperazone',
  'colistin',
  'imipenem',
  'linezolid',
  'meropenem',
  'piperacillin',
  'polymyxin',
  'tazobactam',
  'tigecycline',
  'vancomycin',
];
const CULTURE_TERMS = ['culture', 'blood culture', 'urine culture', 'sputum culture', 'wound culture', 'microbiology'];
const POSITIVE_TERMS = ['positive', 'growth', 'detected', 'isolated', 'organism', 'colonies', 'cfu'];
const MDRO_TERMS = ['mrsa', 'vre', 'cre', 'esbl', 'mdro', 'xdr', 'carbapenem', 'clostridioides', 'c. diff', 'c difficile'];
const ISOLATION_TERMS = ['isolation', 'contact precaution', 'droplet precaution', 'airborne precaution', 'barrier nursing'];
const DEVICE_TERMS = ['central line', 'picc', 'urinary catheter', 'foley', 'ventilator', 'endotracheal', 'dialysis catheter'];

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

function hasAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function severityWeight(severity) {
  if (severity === 'critical') return 35;
  if (severity === 'high') return 22;
  if (severity === 'medium') return 10;
  return 4;
}

function riskBandFor(score, signals) {
  if (signals.some((signal) => signal.severity === 'critical') || score >= 70) return 'critical';
  if (signals.some((signal) => signal.severity === 'high') || score >= 45) return 'high';
  if (signals.some((signal) => signal.severity === 'medium') || score >= 20) return 'medium';
  return 'low';
}

function makeSignal({ severity, code, category, title, recommendation, evidence = [] }) {
  return {
    severity,
    code,
    category,
    title,
    recommendation,
    evidence: asArray(evidence).filter(Boolean).slice(0, 8),
  };
}

function addSignal(signals, signal) {
  signals.push(makeSignal(signal));
}

function medicationName(event) {
  return cleanText(event?.payload?.medication_name || event?.payload?.name || event?.summary);
}

function recentSummary(events, limit = 8) {
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
      status: context.admission?.status || null,
      ward: context.admission?.ward || null,
      bed_number: context.admission?.bed_number || null,
      admitted_at: context.admission?.admitted_at || context.admission?.created_at || null,
      discharged_at: context.admission?.discharged_at || null,
    },
    counts: {
      vitals: asArray(context.vitals).length,
      medications: asArray(context.medications).length,
      investigations: asArray(context.investigations).length,
      notes: asArray(context.notes).length,
      orders: asArray(context.orders).length,
    },
    recent: {
      vitals: recentSummary(context.vitals),
      medications: recentSummary(context.medications),
      investigations: recentSummary(context.investigations),
      notes: recentSummary(context.notes, 5),
      orders: recentSummary(context.orders, 5),
    },
  };
}

export function evaluateInfectionControlRisk(context = {}) {
  const signals = [];
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
    ...asArray(context.handovers),
  ];
  const add = (signal) => {
    addSignal(signals, signal);
    for (const item of asArray(signal.evidence)) {
      if (item?.citation) citations.push(item.citation);
    }
  };

  const feverVitals = vitals.filter((event) => {
    const temp = payloadNumber(event, 'temperature');
    return temp !== null && temp >= 38;
  });
  const severeTempVitals = vitals.filter((event) => {
    const temp = payloadNumber(event, 'temperature');
    return temp !== null && (temp >= 39 || temp <= 35.5);
  });
  const antibioticEvents = medications.filter((event) => hasAny(eventText(event), ANTIBIOTIC_TERMS));
  const broadSpectrumEvents = antibioticEvents.filter((event) => hasAny(eventText(event), BROAD_SPECTRUM_TERMS));
  const cultureEvents = investigations.filter((event) => hasAny(eventText(event), CULTURE_TERMS));
  const positiveCultureEvents = cultureEvents.filter((event) => hasAny(eventText(event), POSITIVE_TERMS));
  const mdroEvents = timeline.filter((event) => hasAny(eventText(event), MDRO_TERMS));
  const isolationOrders = orders.filter((event) => hasAny(eventText(event), ISOLATION_TERMS));
  const deviceEvents = timeline.filter((event) => hasAny(eventText(event), DEVICE_TERMS));
  const diarrheaEvents = timeline.filter((event) => /diarrh?ea|loose stool|c\.?\s*diff|clostridioides/.test(eventText(event)));
  const pendingCultures = cultureEvents.filter((event) => {
    const status = normalizedText(event?.payload?.status || event?.sub_type);
    return status && !['completed', 'reported', 'resulted', 'cancelled', 'canceled'].includes(status);
  });

  if (severeTempVitals.length) {
    add({
      severity: 'high',
      code: 'SEVERE_TEMPERATURE_DERANGEMENT',
      category: 'clinical_signal',
      title: 'Severe fever or hypothermia is documented.',
      recommendation: 'Review sepsis, culture, antimicrobial, and isolation status with the treating team.',
      evidence: severeTempVitals.slice(0, 4).map((event) => ({
        summary: event.summary,
        temperature: payloadNumber(event, 'temperature'),
        citation: eventCitation(event, 'Temperature derangement'),
      })),
    });
  } else if (feverVitals.length) {
    add({
      severity: 'medium',
      code: 'FEVER_SIGNAL',
      category: 'clinical_signal',
      title: 'Fever is documented in recent vitals.',
      recommendation: 'Confirm whether fever workup, cultures, and source-control documentation are complete.',
      evidence: feverVitals.slice(0, 4).map((event) => ({
        summary: event.summary,
        temperature: payloadNumber(event, 'temperature'),
        citation: eventCitation(event, 'Fever vital'),
      })),
    });
  }

  if (positiveCultureEvents.length) {
    add({
      severity: 'high',
      code: 'POSITIVE_MICROBIOLOGY_RESULT',
      category: 'microbiology',
      title: 'Positive microbiology or culture language is present.',
      recommendation: 'Verify organism, sensitivities, source, treatment fit, and whether infection-control precautions are needed.',
      evidence: positiveCultureEvents.slice(0, 5).map((event) => ({
        summary: event.summary,
        result: event.payload?.result_summary || event.payload?.interpretation || event.payload?.conclusion || null,
        citation: eventCitation(event, 'Positive microbiology'),
      })),
    });
  } else if (pendingCultures.length) {
    add({
      severity: 'medium',
      code: 'PENDING_CULTURES',
      category: 'microbiology',
      title: 'Culture or microbiology investigations are still pending.',
      recommendation: 'Track pending culture results and reconcile antimicrobials after reporting.',
      evidence: pendingCultures.slice(0, 5).map((event) => ({
        summary: event.summary,
        status: event.payload?.status || event.sub_type || null,
        citation: eventCitation(event, 'Pending microbiology'),
      })),
    });
  }

  if (mdroEvents.length) {
    add({
      severity: 'critical',
      code: 'MDRO_OR_CDIFF_SIGNAL',
      category: 'isolation',
      title: 'MDRO or C. difficile terminology appears in the chart.',
      recommendation: 'Escalate to infection-control review and verify active isolation/precaution orders.',
      evidence: mdroEvents.slice(0, 5).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, 'MDRO or C. difficile signal'),
      })),
    });
  }

  if ((mdroEvents.length || diarrheaEvents.length) && isolationOrders.length === 0) {
    add({
      severity: 'critical',
      code: 'ISOLATION_PRECAUTIONS_NOT_FOUND',
      category: 'isolation',
      title: 'Isolation or precaution order was not found despite isolation-risk signals.',
      recommendation: 'Do not auto-order. Ask the responsible clinician or infection-control team to verify precautions immediately.',
      evidence: [...mdroEvents, ...diarrheaEvents].slice(0, 5).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, 'Isolation-risk signal'),
      })),
    });
  }

  if (broadSpectrumEvents.length && cultureEvents.length === 0) {
    add({
      severity: 'high',
      code: 'BROAD_SPECTRUM_WITHOUT_CULTURE_EVIDENCE',
      category: 'stewardship',
      title: 'Broad-spectrum antibiotic use has no culture evidence in the chart packet.',
      recommendation: 'Review whether cultures were ordered before antimicrobial start and document rationale if cultures are not appropriate.',
      evidence: broadSpectrumEvents.slice(0, 5).map((event) => ({
        medication: medicationName(event),
        citation: eventCitation(event, 'Broad-spectrum antimicrobial'),
      })),
    });
  } else if (antibioticEvents.length && cultureEvents.length === 0) {
    add({
      severity: 'medium',
      code: 'ANTIBIOTIC_WITHOUT_CULTURE_EVIDENCE',
      category: 'stewardship',
      title: 'Antibiotic administration is present without culture evidence in the chart packet.',
      recommendation: 'Confirm infection diagnosis, culture status, start date, stop/review date, and de-escalation plan.',
      evidence: antibioticEvents.slice(0, 5).map((event) => ({
        medication: medicationName(event),
        citation: eventCitation(event, 'Antimicrobial administration'),
      })),
    });
  }

  if (diarrheaEvents.length && antibioticEvents.length) {
    add({
      severity: 'high',
      code: 'CDIFF_RISK_AFTER_ANTIBIOTICS',
      category: 'hai_risk',
      title: 'Diarrhea/C. difficile language appears with antibiotic exposure.',
      recommendation: 'Review stool testing, hydration, isolation status, and antibiotic necessity.',
      evidence: diarrheaEvents.slice(0, 4).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, 'Diarrhea or C. difficile signal'),
      })),
    });
  }

  if (deviceEvents.length && feverVitals.length) {
    add({
      severity: 'high',
      code: 'DEVICE_ASSOCIATED_INFECTION_RISK',
      category: 'hai_risk',
      title: 'Device-related terminology appears with fever.',
      recommendation: 'Review line/catheter/ventilator necessity, device days, insertion-site documentation, and culture plan.',
      evidence: deviceEvents.slice(0, 5).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, 'Device-associated infection risk'),
      })),
    });
  }

  if (!signals.length) {
    add({
      severity: 'low',
      code: 'NO_INFECTION_CONTROL_SIGNAL',
      category: 'baseline',
      title: 'No high-signal infection-control risk was detected in the available chart packet.',
      recommendation: 'Continue routine infection-prevention surveillance and human review.',
    });
  }

  const riskScore = Math.min(100, signals.reduce((sum, signal) => sum + severityWeight(signal.severity), 0));
  const riskBand = riskBandFor(riskScore, signals);
  const stewardshipFlags = signals.filter((signal) => signal.category === 'stewardship');
  const isolationFlags = signals.filter((signal) => signal.category === 'isolation');
  const recommendations = signals.map((signal) => ({
    code: signal.code,
    severity: signal.severity,
    recommendation: signal.recommendation,
  }));

  return {
    risk_score: riskScore,
    risk_band: riskBand,
    signals,
    signal_counts: {
      critical: signals.filter((signal) => signal.severity === 'critical').length,
      high: signals.filter((signal) => signal.severity === 'high').length,
      medium: signals.filter((signal) => signal.severity === 'medium').length,
      low: signals.filter((signal) => signal.severity === 'low').length,
    },
    stewardship_flags: stewardshipFlags,
    isolation_flags: isolationFlags,
    recommendations,
    summary: `${signals.length} infection-control signal(s), ${stewardshipFlags.length} stewardship flag(s), ${isolationFlags.length} isolation flag(s).`,
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
        review_roles: module.settings?.reviewRoles || ['INFECTION_CONTROL', 'DOCTOR'],
        source: 'infection_control_sentinel',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Infection-control review placeholder failed', { error: err.message });
    }
    return null;
  }
}

export async function generateInfectionControlAudit({
  req = null,
  admissionId,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const safeAdmissionId = optionalInt(admissionId, 'admission_id');
  const module = await getClinicalAiModule(MODULE_KEY);
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const context = await collectAdmissionClinicalContext(safeAdmissionId, tenantId);
  const packet = buildChartPacket(context);
  const fallbackDraft = evaluateInfectionControlRisk(context);
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
    signals: asArray(draft?.signals).length ? draft.signals : fallbackDraft.signals,
    recommendations: asArray(draft?.recommendations).length ? draft.recommendations : fallbackDraft.recommendations,
    stewardship_flags: asArray(draft?.stewardship_flags).length ? draft.stewardship_flags : fallbackDraft.stewardship_flags,
    isolation_flags: asArray(draft?.isolation_flags).length ? draft.isolation_flags : fallbackDraft.isolation_flags,
  };
  const citations = uniqueCitations(
    asArray(normalizedDraft.source_citations).length
      ? normalizedDraft.source_citations
      : fallbackDraft.source_citations
  );
  const safetyFlags = [
    ...(citations.length ? [] : [{
      severity: 'high',
      code: 'NO_INFECTION_CONTROL_CITATIONS',
      message: 'Infection-control sentinel output has no source citations.',
    }]),
    ...(normalizedDraft.risk_band === 'critical' ? [{
      severity: 'critical',
      code: 'CRITICAL_INFECTION_CONTROL_SIGNAL',
      message: 'Critical infection-control signal requires human infection-control review.',
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
      signal_codes: normalizedDraft.signals.map((signal) => signal.code),
      fallback_reason: aiResult.usedAi ? null : aiResult.reason || 'template_or_rule_output',
    },
  });

  let audit = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_infection_control_audits
         (tenant_id, admission_id, patient_uid, generation_id, risk_score,
          risk_band, signals, recommendations, stewardship_flags, isolation_flags,
          source_citations, safety_flags, reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb,
               $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, 'pending',
               $13::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, admission_id, patient_uid, generation_id,
                 risk_score, risk_band, signals, recommendations,
                 stewardship_flags, isolation_flags, source_citations,
                 safety_flags, reviewer_decision, created_at, updated_at`,
      tenantId,
      safeAdmissionId,
      context.admission?.patient_uid || null,
      generation?.id || null,
      normalizedDraft.risk_score,
      normalizedDraft.risk_band,
      JSON.stringify(normalizedDraft.signals),
      JSON.stringify(normalizedDraft.recommendations),
      JSON.stringify(normalizedDraft.stewardship_flags),
      JSON.stringify(normalizedDraft.isolation_flags),
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
        reason: 'clinical_ai_infection_control_audits_unavailable',
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
    eventType: 'clinical_ai.infection_control_audit_generated',
    aggregateType: 'clinical_ai_infection_control_audit',
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

  // Surface to the CDS dashboard on high/critical infection-control risk so an
  // outbreak / isolation / device-infection signal reaches the clinician's cards,
  // not just the infection-control queue. Best-effort; the audit row stays authoritative.
  const icPatientUid = context.admission?.patient_uid || null;
  if (icPatientUid && (normalizedDraft.risk_band === 'critical' || normalizedDraft.risk_band === 'high')) {
    try {
      const { raiseCdsAlert } = await import('../cds/cdsAlertSurfacing.js');
      const topSignal = Array.isArray(normalizedDraft.signals) ? normalizedDraft.signals[0] : null;
      await raiseCdsAlert({
        patientUid: icPatientUid,
        encounterId: safeAdmissionId,
        alertType: 'INFECTION_CONTROL_RISK',
        severity: normalizedDraft.risk_band === 'critical' ? 'critical' : 'warning',
        title: `Infection control — ${normalizedDraft.risk_band} risk`,
        description: topSignal?.title || topSignal?.message || topSignal?.label
          || 'Infection control sentinel flagged high/critical risk — review isolation / device / stewardship signals.',
        sourceData: {
          risk_band: normalizedDraft.risk_band,
          risk_score: normalizedDraft.risk_score,
          audit_id: audit?.id || null,
          source: 'infectionControlSentinelService.generateInfectionControlAudit',
        },
      });
    } catch (err) {
      logger.warn(`Infection control CDS surfacing failed: ${err.message}`);
    }
  }

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

export async function listInfectionControlAudits({
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
              a.generation_id, a.risk_score, a.risk_band, a.signals,
              a.recommendations, a.stewardship_flags, a.isolation_flags,
              a.source_citations, a.safety_flags, a.reviewer_decision,
              a.reviewed_by, a.reviewed_at, a.reviewer_note, a.metadata,
              a.created_at, a.updated_at
       FROM clinical_ai_infection_control_audits a
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

export async function decideInfectionControlAudit({
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
    `UPDATE clinical_ai_infection_control_audits
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
  if (!rows[0]) throw AppError.notFound('Infection-control audit not found');
  return rows[0];
}

export default {
  decideInfectionControlAudit,
  evaluateInfectionControlRisk,
  generateInfectionControlAudit,
  listInfectionControlAudits,
};
