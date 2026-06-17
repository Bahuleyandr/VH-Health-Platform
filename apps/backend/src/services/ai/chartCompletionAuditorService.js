/**
 * Chart Completion Auditor.
 *
 * Scores admission documentation completeness and produces a review-gated
 * medical-records audit. It never signs notes, closes orders, imports facts,
 * or mutates clinical state.
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

const MODULE_KEY = 'chart_completion_auditor';
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You audit hospital chart completeness. Use only supplied chart evidence and return JSON only.',
  user_prompt_template: 'Summarize chart-completion gaps and recommendations without inventing evidence.',
};

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

function statusOf(event) {
  return cleanText(event?.payload?.status || event?.sub_type).toLowerCase();
}

function isUnsignedNote(event) {
  return event?.payload?.is_signed === false;
}

function isSignedNote(event) {
  return event?.payload?.is_signed === true;
}

function isPendingInvestigation(event) {
  const status = statusOf(event);
  return status && !['completed', 'reported', 'cancelled', 'canceled', 'resulted', 'done'].includes(status);
}

function isActiveOrder(event) {
  const status = statusOf(event);
  return ['ordered', 'active', 'pending', 'in_progress', 'verified'].includes(status);
}

function severityWeight(severity) {
  if (severity === 'critical') return 24;
  if (severity === 'high') return 14;
  if (severity === 'medium') return 8;
  return 3;
}

function riskBandFor(score, gaps) {
  if (gaps.some((gap) => gap.severity === 'critical') || score < 50) return 'critical';
  if (gaps.some((gap) => gap.severity === 'high') || score < 70) return 'high';
  if (gaps.some((gap) => gap.severity === 'medium') || score < 85) return 'medium';
  return 'low';
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

function makeGap({ severity, code, label, ownerRole, suggestedAction, evidence = [] }) {
  return {
    severity,
    code,
    label,
    owner_role: ownerRole,
    suggested_action: suggestedAction,
    evidence: asArray(evidence).filter(Boolean).slice(0, 8),
  };
}

function latestSummary(events, limit = 5) {
  return asArray(events)
    .slice(-limit)
    .map((event) => ({
      id: event.id,
      type: event.event_type,
      status: event.payload?.status || event.sub_type || null,
      summary: event.summary,
      timestamp: event.timestamp,
    }));
}

function buildChartPacket(context) {
  return {
    patient: {
      uid: context.patient?.uid || context.admission?.patient_uid || null,
      name: context.patient?.name || null,
      phone: context.patient?.phone || null,
      email: context.patient?.email || null,
    },
    admission: {
      id: context.admission?.id || null,
      status: context.admission?.status || null,
      ward: context.admission?.ward || null,
      bed_number: context.admission?.bed_number || null,
      chief_complaint: context.admission?.chief_complaint || null,
      admitting_diagnosis: context.admission?.admitting_diagnosis || null,
      admitted_at: context.admission?.admitted_at || context.admission?.created_at || null,
      discharged_at: context.admission?.discharged_at || null,
      discharge_type: context.admission?.discharge_type || null,
      discharge_summary: context.admission?.discharge_summary || null,
    },
    counts: {
      notes: asArray(context.notes).length,
      signed_notes: asArray(context.notes).filter(isSignedNote).length,
      unsigned_notes: asArray(context.notes).filter(isUnsignedNote).length,
      diagnoses: asArray(context.diagnoses).length,
      vitals: asArray(context.vitals).length,
      medications: asArray(context.medications).length,
      allergies: asArray(context.allergies).length,
      investigations: asArray(context.investigations).length,
      pending_investigations: asArray(context.investigations).filter(isPendingInvestigation).length,
      active_orders: asArray(context.orders).filter(isActiveOrder).length,
      handovers: asArray(context.handovers).length,
    },
    recent: {
      notes: latestSummary(context.notes, 8),
      investigations: latestSummary(context.investigations, 8),
      orders: latestSummary(context.orders, 8),
      vitals: latestSummary(context.vitals, 5),
      handovers: latestSummary(context.handovers, 5),
    },
  };
}

export function evaluateChartCompletion(context = {}) {
  const gaps = [];
  const citations = [];
  const patient = context.patient || {};
  const admission = context.admission || {};
  const notes = asArray(context.notes);
  const investigations = asArray(context.investigations);
  const orders = asArray(context.orders);
  const diagnoses = asArray(context.diagnoses);
  const vitals = asArray(context.vitals);
  const allergies = asArray(context.allergies);
  const medications = asArray(context.medications);
  const handovers = asArray(context.handovers);
  const pendingInvestigations = investigations.filter(isPendingInvestigation);
  const activeOrders = orders.filter(isActiveOrder);
  const signedNotes = notes.filter(isSignedNote);
  const unsignedNotes = notes.filter(isUnsignedNote);
  const dischargeSummary = admission.discharge_summary || {};
  const admittedOrDischarged = cleanText(admission.status).toLowerCase();
  const dischargeLike = admittedOrDischarged === 'discharged' || Boolean(admission.discharged_at);

  const addGap = (gap) => {
    gaps.push(gap);
    for (const evidence of gap.evidence) {
      if (evidence?.citation) citations.push(evidence.citation);
    }
  };

  if (!patient.uid && !admission.patient_uid) {
    addGap(makeGap({
      severity: 'critical',
      code: 'MISSING_PATIENT_UID',
      label: 'No patient UID is linked to the admission context.',
      ownerRole: 'MEDICAL_RECORDS',
      suggestedAction: 'Link the admission to a verified patient identity before downstream AI or billing review.',
    }));
  }

  if (!cleanText(patient.name)) {
    addGap(makeGap({
      severity: 'medium',
      code: 'MISSING_PATIENT_NAME',
      label: 'Patient name is not available in the chart packet.',
      ownerRole: 'FRONT_DESK',
      suggestedAction: 'Verify demographic registration and patient identity fields.',
    }));
  }

  if (!cleanText(admission.chief_complaint) && !cleanText(admission.admitting_diagnosis) && diagnoses.length === 0) {
    addGap(makeGap({
      severity: 'high',
      code: 'MISSING_ADMISSION_DIAGNOSIS',
      label: 'No chief complaint, admitting diagnosis, or diagnosis event is documented.',
      ownerRole: 'DOCTOR',
      suggestedAction: 'Add or sign admission assessment and problem-list documentation.',
    }));
  }

  if (!notes.length) {
    addGap(makeGap({
      severity: 'high',
      code: 'NO_CLINICAL_NOTES',
      label: 'No clinical notes were found for this admission window.',
      ownerRole: 'DOCTOR',
      suggestedAction: 'Create admission/progress documentation before coding, discharge, or audit use.',
    }));
  } else if (!signedNotes.length) {
    addGap(makeGap({
      severity: 'high',
      code: 'NO_SIGNED_NOTES',
      label: 'Clinical notes exist but none are signed.',
      ownerRole: 'DOCTOR',
      suggestedAction: 'Sign or countersign the relevant clinical notes before accepting AI-generated summaries.',
      evidence: unsignedNotes.slice(0, 5).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, 'Unsigned note'),
      })),
    }));
  } else if (unsignedNotes.length) {
    addGap(makeGap({
      severity: 'medium',
      code: 'UNSIGNED_NOTES',
      label: `${unsignedNotes.length} unsigned clinical note(s) need review.`,
      ownerRole: 'DOCTOR',
      suggestedAction: 'Review, sign, or explicitly void unsigned notes.',
      evidence: unsignedNotes.slice(0, 5).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, 'Unsigned note'),
      })),
    }));
  }

  if (!allergies.length) {
    addGap(makeGap({
      severity: 'medium',
      code: 'ALLERGY_STATUS_UNKNOWN',
      label: 'No allergy status is documented in the chart packet.',
      ownerRole: 'NURSING_STAFF',
      suggestedAction: 'Document allergies or no-known-allergy status before medication reconciliation.',
    }));
  }

  if (!vitals.length) {
    addGap(makeGap({
      severity: 'medium',
      code: 'NO_RECENT_VITALS',
      label: 'No vitals were found in the admission chart packet.',
      ownerRole: 'NURSING_STAFF',
      suggestedAction: 'Record current vitals or confirm why vitals are not applicable.',
    }));
  }

  if (!medications.length && admittedOrDischarged !== 'planned') {
    addGap(makeGap({
      severity: 'low',
      code: 'NO_MEDICATION_ACTIVITY',
      label: 'No medication administration events were found in the admission packet.',
      ownerRole: 'NURSING_STAFF',
      suggestedAction: 'Confirm whether medication activity is absent or documented in another source.',
    }));
  }

  if (pendingInvestigations.length) {
    addGap(makeGap({
      severity: 'high',
      code: 'PENDING_INVESTIGATIONS',
      label: `${pendingInvestigations.length} investigation(s) are still pending or not resulted.`,
      ownerRole: 'LAB_STAFF',
      suggestedAction: 'Result, cancel, or explicitly defer pending investigations before discharge/coding closure.',
      evidence: pendingInvestigations.slice(0, 8).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, 'Pending investigation'),
      })),
    }));
  }

  if (activeOrders.length) {
    addGap(makeGap({
      severity: 'high',
      code: 'ACTIVE_ORDERS',
      label: `${activeOrders.length} active/pending order(s) remain open.`,
      ownerRole: 'DOCTOR',
      suggestedAction: 'Complete, discontinue, or document handoff for open orders.',
      evidence: activeOrders.slice(0, 8).map((event) => ({
        summary: event.summary,
        citation: eventCitation(event, 'Active order'),
      })),
    }));
  }

  if (!handovers.length && admittedOrDischarged === 'admitted') {
    addGap(makeGap({
      severity: 'low',
      code: 'NO_HANDOVER',
      label: 'No nursing handover was found for the active admission packet.',
      ownerRole: 'NURSING_STAFF',
      suggestedAction: 'Confirm current shift handover exists before ward-round or transfer workflows.',
    }));
  }

  if (dischargeLike && !dischargeSummary.is_signed) {
    addGap(makeGap({
      severity: 'high',
      code: 'DISCHARGE_SUMMARY_UNSIGNED',
      label: 'Admission appears discharged but the discharge summary is not signed.',
      ownerRole: 'DOCTOR',
      suggestedAction: 'Sign the final discharge summary or mark why it is not required.',
    }));
  }

  if (dischargeLike && !cleanText(dischargeSummary.follow_up_instructions)) {
    addGap(makeGap({
      severity: 'medium',
      code: 'FOLLOW_UP_NOT_DOCUMENTED',
      label: 'Follow-up instructions are missing from the discharge artefact.',
      ownerRole: 'DOCTOR',
      suggestedAction: 'Document follow-up plan, warning signs, medication plan, and return precautions.',
    }));
  }

  const penalty = gaps.reduce((sum, gap) => sum + severityWeight(gap.severity), 0);
  const completionScore = Math.max(0, Math.min(100, 100 - penalty));
  const riskBand = riskBandFor(completionScore, gaps);
  const checklist = {
    patient_identity_present: Boolean(patient.uid || admission.patient_uid),
    diagnosis_documented: Boolean(cleanText(admission.chief_complaint) || cleanText(admission.admitting_diagnosis) || diagnoses.length),
    signed_note_present: signedNotes.length > 0,
    allergy_status_documented: allergies.length > 0,
    vitals_present: vitals.length > 0,
    pending_investigations_clear: pendingInvestigations.length === 0,
    active_orders_clear: activeOrders.length === 0,
    discharge_summary_signed_or_not_applicable: !dischargeLike || Boolean(dischargeSummary.is_signed),
    follow_up_documented_or_not_applicable: !dischargeLike || Boolean(cleanText(dischargeSummary.follow_up_instructions)),
  };
  const recommendations = gaps.map((gap) => ({
    code: gap.code,
    owner_role: gap.owner_role,
    action: gap.suggested_action,
    priority: gap.severity,
  }));

  return {
    completion_score: completionScore,
    risk_band: riskBand,
    gaps,
    checklist,
    recommendations,
    gap_counts: {
      critical: gaps.filter((gap) => gap.severity === 'critical').length,
      high: gaps.filter((gap) => gap.severity === 'high').length,
      medium: gaps.filter((gap) => gap.severity === 'medium').length,
      low: gaps.filter((gap) => gap.severity === 'low').length,
      total: gaps.length,
    },
    source_citations: uniqueCitations([...asArray(context.citations), ...citations]).slice(0, 40),
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
    aiResult?.estimatedCostMinor ?? null,
    usage.latency_ms || null,
    usage.provider_request_id || null,
    usage.finish_reason || null,
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
        review_roles: module.settings?.reviewRoles || ['MEDICAL_RECORDS', 'DOCTOR'],
        source: 'chart_completion_audit',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Chart completion review placeholder failed', { error: err.message });
    }
    return null;
  }
}

export async function generateChartCompletionAudit({
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
  const fallbackDraft = evaluateChartCompletion(context);
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
    completion_score: Number.isFinite(Number(draft?.completion_score))
      ? Math.max(0, Math.min(100, Number.parseInt(draft.completion_score, 10)))
      : fallbackDraft.completion_score,
    risk_band: ['low', 'medium', 'high', 'critical'].includes(String(draft?.risk_band))
      ? String(draft.risk_band)
      : fallbackDraft.risk_band,
  };
  const citations = uniqueCitations(
    asArray(normalizedDraft.source_citations).length
      ? normalizedDraft.source_citations
      : fallbackDraft.source_citations
  );
  const safetyFlags = [
    ...(citations.length ? [] : [{
      severity: 'high',
      code: 'NO_CHART_CITATIONS',
      message: 'Chart completion audit has no source citations.',
    }]),
    ...(fallbackDraft.gap_counts.critical > 0 ? [{
      severity: 'critical',
      code: 'CRITICAL_CHART_GAPS',
      message: 'Critical chart-completion gaps must be resolved before acceptance.',
    }] : []),
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
      gap_codes: fallbackDraft.gaps.map((gap) => gap.code),
      fallback_reason: aiResult.usedAi ? null : aiResult.reason || 'template_or_rule_output',
    },
  });

  let audit = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_chart_gap_audits
         (tenant_id, admission_id, patient_uid, generation_id, completion_score,
          risk_band, gap_summary, blockers, recommendations, source_citations,
          safety_flags, reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb,
               $9::jsonb, $10::jsonb, $11::jsonb, 'pending', $12::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, admission_id, patient_uid, generation_id,
                 completion_score, risk_band, gap_summary, blockers,
                 recommendations, source_citations, safety_flags,
                 reviewer_decision, created_at, updated_at`,
      tenantId,
      safeAdmissionId,
      context.admission?.patient_uid || null,
      generation?.id || null,
      normalizedDraft.completion_score,
      normalizedDraft.risk_band,
      JSON.stringify({
        checklist: normalizedDraft.checklist || fallbackDraft.checklist,
        gap_counts: normalizedDraft.gap_counts || fallbackDraft.gap_counts,
        summary: normalizedDraft.summary || null,
      }),
      JSON.stringify(normalizedDraft.gaps || fallbackDraft.gaps),
      JSON.stringify(normalizedDraft.recommendations || fallbackDraft.recommendations),
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
        reason: 'clinical_ai_chart_gap_audits_unavailable',
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
    eventType: 'clinical_ai.chart_completion_audit_generated',
    aggregateType: 'clinical_ai_chart_gap_audit',
    aggregateId: audit?.id || generation?.id || safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    payload: {
      tenant_id: tenantId,
      admission_id: safeAdmissionId,
      audit_id: audit?.id || null,
      generation_id: generation?.id || null,
      risk_band: normalizedDraft.risk_band,
      completion_score: normalizedDraft.completion_score,
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

export async function listChartCompletionAudits({
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
              a.generation_id, a.completion_score, a.risk_band, a.gap_summary,
              a.blockers, a.recommendations, a.source_citations, a.safety_flags,
              a.reviewer_decision, a.reviewed_by, a.reviewed_at, a.reviewer_note,
              a.metadata, a.created_at, a.updated_at
       FROM clinical_ai_chart_gap_audits a
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

export async function decideChartCompletionAudit({
  tenantId = null,
  auditId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!['accepted', 'deferred', 'rejected'].includes(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, or rejected');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_chart_gap_audits
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, admission_id, patient_uid, completion_score, risk_band,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(auditId, 'audit_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Chart completion audit not found');
  return rows[0];
}

export default {
  decideChartCompletionAudit,
  evaluateChartCompletion,
  generateChartCompletionAudit,
  listChartCompletionAudits,
};
