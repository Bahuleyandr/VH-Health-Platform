/**
 * Mortality / RCA draft generator.
 *
 * Takes an admission + case_type and produces a candidate RCA packet for
 * the quality committee: timeline, candidate contributing factors,
 * process gaps, recommended actions. Never auto-accepted — committee
 * signs off.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { collectAdmissionClinicalContext } from '../emr/clinicalTimelineService.js';
import { generateClinicalText } from './localLlmClient.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';

const MODULE_KEY = 'rca_draft_generator';
const CASE_TYPES = new Set(['mortality', 'readmission', 'infection', 'never_event', 'complaint']);

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
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

function summariseTimeline(context) {
  const events = [];
  for (const note of (context.notes || []).slice(-10)) {
    events.push({ timestamp: note.timestamp, event: note.summary });
  }
  for (const order of (context.orders || []).slice(-10)) {
    events.push({ timestamp: order.timestamp, event: order.summary });
  }
  for (const vital of (context.vitals || []).slice(-6)) {
    events.push({ timestamp: vital.timestamp, event: vital.summary });
  }
  return events
    .filter((e) => e.timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function fallbackDraft(context, caseType) {
  return {
    case_type: caseType,
    timeline: summariseTimeline(context),
    candidate_findings: [],
    contributing_factors: [],
    process_gaps: [],
    recommended_actions: [
      'Committee to review timeline and confirm contributing factors.',
      'Identify process gaps and corrective actions within 30 days.',
    ],
    source: 'fallback_from_chart',
  };
}

export async function generateRcaDraft({ req, admissionId, caseType = 'mortality' } = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const normalisedType = String(caseType).toLowerCase();
  if (!CASE_TYPES.has(normalisedType)) {
    throw AppError.badRequest(`case_type must be one of: ${[...CASE_TYPES].join(', ')}`);
  }

  const admissionRows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid FROM admissions WHERE id = $1 LIMIT 1`,
    Number.parseInt(admissionId, 10)
  );
  const admission = admissionRows[0];
  if (!admission) throw AppError.notFound('Admission not found');

  const context = await collectAdmissionClinicalContext(admission.id);
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });

  const systemPrompt = [
    'You are a hospital quality committee drafting assistant.',
    'Produce a DRAFT RCA packet from the supplied chart context — never accept it as final.',
    'Output JSON with: timeline (array of {timestamp,event}), candidate_findings, contributing_factors, process_gaps, recommended_actions.',
    'Stay strictly anchored to the chart. Do not invent events, lab values, or conversations.',
    'Frame findings as "candidate" — committee will confirm or reject.',
    'Return JSON only.',
  ].join('\n');
  const userPrompt = `Case type: ${normalisedType}\n\nChart context:\n${JSON.stringify({
    admission: context.admission,
    notes: (context.notes || []).slice(-15),
    orders: (context.orders || []).slice(-15),
    vitals: (context.vitals || []).slice(-10),
    diagnoses: context.diagnoses,
    allergies: context.allergies,
  })}`;

  const aiResult = await generateClinicalText({
    systemPrompt,
    userPrompt,
    taskType: MODULE_KEY,
    tenantRegion: req?.tenant?.region || null,
    tenantId,
  });

  const fallback = fallbackDraft(context, normalisedType);
  const draft = safeJsonParse(aiResult.text, fallback);
  draft.case_type = normalisedType;
  if (!Array.isArray(draft.timeline) || draft.timeline.length === 0) {
    draft.timeline = fallback.timeline;
  }

  const citations = [
    ...(context.notes || []).slice(-10).map((note) => ({
      source_type: 'clinical_note',
      source_id: String(note.id),
      label: note.summary || 'clinical note',
      timestamp: note.timestamp,
    })),
    ...(context.diagnoses || []).slice(0, 10).map((d) => ({
      source_type: 'diagnosis',
      source_id: String(d.id),
      label: d.summary || d.description || 'diagnosis',
      timestamp: d.timestamp,
    })),
  ];

  const defenseFlags = runOutputDefenses({
    draft,
    module,
    context: { admission: context.admission, diagnoses: context.diagnoses },
    citations,
  });

  let savedId = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_rca_drafts
         (tenant_id, admission_id, patient_uid, case_type, draft, citations, reviewer_decision, created_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5::jsonb, $6::jsonb, 'pending', NOW())
       RETURNING id, case_type, reviewer_decision, created_at`,
      tenantId,
      admission.id,
      admission.patient_uid,
      normalisedType,
      JSON.stringify(draft),
      JSON.stringify(citations)
    );
    savedId = rows[0]?.id || null;
  } catch (err) {
    if (!/does not exist|relation/i.test(String(err?.message || ''))) {
      logger.warn('RCA draft persist failed', { error: err.message });
    }
  }

  return {
    rca_id: savedId,
    admission_id: admission.id,
    case_type: normalisedType,
    draft,
    citations,
    safety_flags: defenseFlags,
    used_ai: Boolean(aiResult.usedAi),
    provider: aiResult.provider || 'template',
    reviewer_decision: 'pending',
    module_key: MODULE_KEY,
    decision_support_only: true,
  };
}

export async function listRcaDrafts({ tenantId = null, decision = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, admission_id, patient_uid, case_type, reviewer_decision, reviewer_note,
              reviewed_by, reviewed_at, created_at
       FROM clinical_ai_rca_drafts
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR reviewer_decision = $2)
       ORDER BY created_at DESC
       LIMIT $3`,
      tid,
      decision,
      safeLimit
    );
    return { drafts: rows, count: rows.length };
  } catch (err) {
    if (/does not exist/i.test(String(err?.message || ''))) return { drafts: [], count: 0 };
    throw err;
  }
}

export async function decideRcaDraft({ rcaId, decision, reviewerUid = null, note = null, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = String(decision || '').toLowerCase();
  if (!['accepted', 'revised', 'rejected'].includes(normalized)) {
    throw AppError.badRequest('decision must be accepted, revised, or rejected');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_rca_drafts
     SET reviewer_decision = $2,
         reviewer_note = $3,
         reviewed_by = $4::uuid,
         reviewed_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
       AND reviewer_decision = 'pending'
     RETURNING id, case_type, reviewer_decision, reviewer_note, reviewed_by, reviewed_at`,
    Number.parseInt(rcaId, 10),
    normalized,
    note,
    reviewerUid,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Pending RCA draft not found');
  return rows[0];
}

export default {
  decideRcaDraft,
  generateRcaDraft,
  listRcaDrafts,
};
