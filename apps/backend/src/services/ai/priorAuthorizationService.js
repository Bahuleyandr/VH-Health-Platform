/**
 * Prior authorization generator.
 *
 * Builds a pre-auth packet from the chart: medical necessity narrative,
 * clinical evidence bundle, citation set. Billing coordinator reviews,
 * edits, and submits through the provider-neutral payer adapter.
 *
 * Decision-support only. The request sits at reviewer_decision='pending'
 * until a human submits it; even after submission, payer outcomes are
 * tracked as status transitions without automatic claim write-off.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { collectAdmissionClinicalContext } from '../emr/clinicalTimelineService.js';
import { generateClinicalText } from './localLlmClient.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { submitPriorAuthToPayer } from './priorAuthorizationPayerAdapterService.js';
import { publishEvent } from '../events/eventOutboxService.js';

const MODULE_KEY = 'prior_authorization_generator';

// Payer-decision state machine (audit §C-1). `status` is a bare varchar with no
// DB CHECK; before this guard a payer decision could be recorded from any state
// (e.g. flip an already-`approved` PA to `denied`, which re-arms the appeal
// workflow). A payer decision is only recordable on a SUBMITTED request; the
// decision IS the target status. Re-recording the SAME decision is idempotent.
const PRIOR_AUTH_DECISION_FROM_STATES = ['submitted'];

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
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

function buildEvidenceBundle(context) {
  return {
    diagnoses: (context.diagnoses || []).slice(0, 10).map((d) => ({
      icd10: d.icd10_code,
      description: d.description,
      diagnosed_at: d.timestamp,
    })),
    vitals_snapshot: (context.vitals || []).slice(-5).map((v) => ({
      recorded_at: v.timestamp,
      summary: v.summary,
    })),
    medications_on_chart: (context.medications || []).slice(-10).map((m) => ({
      summary: m.summary,
      ordered_at: m.timestamp,
    })),
    notes_reviewed: (context.notes || []).slice(-8).map((n) => ({
      type: n.sub_type,
      summary: n.summary,
      signed: Boolean(n.payload?.is_signed),
    })),
    investigations: (context.investigations || []).slice(-8).map((i) => ({
      summary: i.summary,
      status: i.payload?.status || i.sub_type,
    })),
  };
}

function fallbackPacket({ payerName, procedureCode, procedureDescription, admission, evidence }) {
  return {
    payer_name: payerName,
    procedure_code: procedureCode,
    procedure_description: procedureDescription,
    patient_summary: `Admission for ${admission?.chief_complaint || admission?.admitting_diagnosis || 'inpatient management'}.`,
    medical_necessity: `${procedureDescription || procedureCode} is medically necessary based on the patient's active diagnoses and chart findings. Reviewer must confirm supporting evidence before submission.`,
    clinical_evidence: evidence,
    requested_service_type: 'inpatient_procedure',
    attached_documentation: [
      'Admission history and physical',
      'Recent investigation results',
      'Active medication list',
      'Signed clinical notes',
    ],
    source: 'fallback_template',
  };
}

export async function generatePriorAuthorization({
  req,
  admissionId,
  payerName,
  policyNumber = null,
  procedureCode,
  procedureDescription = null,
  requestedServiceType = 'inpatient_procedure',
} = {}) {
  if (!payerName) throw AppError.badRequest('payer_name is required');
  if (!procedureCode) throw AppError.badRequest('procedure_code is required');
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });

  const admissionRows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, chief_complaint, admitting_diagnosis, admitted_at
     FROM admissions
     WHERE id = $1
     LIMIT 1`,
    Number.parseInt(admissionId, 10)
  );
  const admission = admissionRows[0];
  if (!admission) throw AppError.notFound('Admission not found');

  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden('prior_authorization_generator module is disabled', 'PRIOR_AUTH_MODULE_DISABLED');
  }

  const context = await collectAdmissionClinicalContext(admission.id, tenantId);
  const evidence = buildEvidenceBundle(context);

  const systemPrompt = [
    'You are a hospital revenue-cycle assistant drafting a prior-authorization packet for a payer.',
    'Produce a JSON object with keys: payer_name, procedure_code, procedure_description, patient_summary, medical_necessity, clinical_evidence, requested_service_type, attached_documentation.',
    'Anchor medical_necessity narrative STRICTLY to the supplied evidence. Quote specific diagnoses, vitals, and prior failed treatments — do not invent evidence.',
    'Keep medical_necessity <= 400 words. Use payer-appropriate formal tone.',
    'attached_documentation should list the documents that support the claim (admission H&P, specific investigation reports, etc.).',
    'Return JSON only.',
  ].join('\n');
  const userPrompt = `Payer: ${payerName}${policyNumber ? ` (policy ${policyNumber})` : ''}
Procedure: ${procedureCode}${procedureDescription ? ` — ${procedureDescription}` : ''}
Admission context:
${JSON.stringify({ admission: context.admission, allergies: context.allergies, evidence })}`;

  const aiResult = await generateClinicalText({
    systemPrompt,
    userPrompt,
    taskType: MODULE_KEY,
    tenantRegion: req?.tenant?.region || null,
    tenantId,
  });
  const fallback = fallbackPacket({
    payerName,
    procedureCode,
    procedureDescription,
    admission: context.admission,
    evidence,
  });
  const packet = safeJsonParse(aiResult.text, fallback);
  // Keep the factual fields pinned regardless of what the LLM returns.
  packet.payer_name = payerName;
  packet.procedure_code = procedureCode;
  packet.procedure_description = procedureDescription || packet.procedure_description;
  packet.clinical_evidence = evidence;
  packet.requested_service_type = requestedServiceType;
  if (!packet.medical_necessity) packet.medical_necessity = fallback.medical_necessity;

  const citations = [
    ...(context.diagnoses || []).slice(0, 8).map((d) => ({
      source_type: 'diagnosis',
      source_id: String(d.id),
      label: d.summary || d.description,
      timestamp: d.timestamp,
    })),
    ...(context.notes || []).filter((n) => n.payload?.is_signed).slice(0, 5).map((n) => ({
      source_type: 'clinical_note',
      source_id: String(n.id),
      label: n.summary,
      timestamp: n.timestamp,
    })),
  ];

  const defenseFlags = runOutputDefenses({
    draft: packet,
    module,
    context: { admission: context.admission, evidence },
    citations,
  });

  let savedId = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_prior_auth_requests
         (tenant_id, admission_id, patient_uid, payer_name, policy_number, procedure_code,
          procedure_description, requested_service_type, medical_necessity,
          clinical_evidence, packet_draft, citations, status, reviewer_decision,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
               $12::jsonb, 'draft', 'pending', $13::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      admission.id,
      admission.patient_uid,
      payerName,
      policyNumber,
      procedureCode,
      procedureDescription || null,
      requestedServiceType,
      String(packet.medical_necessity || fallback.medical_necessity).slice(0, 4000),
      JSON.stringify(evidence),
      JSON.stringify(packet),
      JSON.stringify(citations),
      JSON.stringify({
        defense_flag_codes: defenseFlags.map((flag) => flag.code),
        provider: aiResult.provider || 'template',
        used_ai: Boolean(aiResult.usedAi),
      })
    );
    savedId = rows[0]?.id || null;
  } catch (err) {
    if (!/does not exist|relation/i.test(String(err?.message || ''))) {
      logger.warn('Prior auth persist failed', { error: err.message });
    }
  }

  return {
    prior_auth_id: savedId,
    tenant_id: tenantId,
    admission_id: admission.id,
    patient_uid: admission.patient_uid,
    packet,
    citations,
    safety_flags: defenseFlags,
    used_ai: Boolean(aiResult.usedAi),
    provider: aiResult.provider || 'template',
    status: 'draft',
    reviewer_decision: 'pending',
    module_key: MODULE_KEY,
    decision_support_only: true,
  };
}

export async function submitPriorAuthorization({
  priorAuthId,
  submittedBy = null,
  payerReferenceId = null,
  tenantId = null,
  tenantRegion = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const id = Number.parseInt(priorAuthId, 10);
  const existingRows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, admission_id, patient_uid, payer_name, policy_number,
            procedure_code, procedure_description, requested_service_type,
            medical_necessity, clinical_evidence, packet_draft, citations, metadata
     FROM clinical_ai_prior_auth_requests
     WHERE id = $1
       AND tenant_id = $2::uuid
       AND status = 'draft'
     LIMIT 1`,
    id,
    tid
  );
  const priorAuth = existingRows[0];
  if (!priorAuth) throw AppError.notFound('Draft prior auth not found (already submitted or deleted?)');

  const payerSubmission = await submitPriorAuthToPayer({
    priorAuth,
    payerReferenceId,
    tenantRegion,
  });
  if (payerSubmission.blocking) {
    throw new AppError('Payer adapter submission failed', 502, 'PAYER_SUBMISSION_FAILED', payerSubmission);
  }

  const finalPayerReferenceId = payerSubmission.reference_id || null;
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_prior_auth_requests
     SET status = 'submitted',
         reviewer_decision = 'submitted',
         submitted_at = NOW(),
         submitted_by = $2::uuid,
         payer_reference_id = $3,
         metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $4::uuid
       AND status = 'draft'
     RETURNING id, status, reviewer_decision, submitted_at, submitted_by, payer_reference_id, metadata`,
    id,
    submittedBy,
    finalPayerReferenceId,
    tid,
    JSON.stringify({ payer_submission: payerSubmission })
  );
  if (!rows[0]) throw AppError.notFound('Draft prior auth not found (already submitted or deleted?)');
  return {
    ...rows[0],
    payer_submission: payerSubmission,
  };
}

export async function recordPayerDecision({ priorAuthId, decision, reason = null, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = String(decision || '').toLowerCase();
  if (!['approved', 'denied', 'withdrawn'].includes(normalized)) {
    throw AppError.badRequest('decision must be approved, denied, or withdrawn');
  }
  const paId = Number.parseInt(priorAuthId, 10);

  // Read current state (tenant-scoped) so the transition can be checked. A
  // payer decision is only valid on a submitted request; re-recording the same
  // decision is idempotent (safe retry); any other from→to is rejected so an
  // already-approved PA can't be silently flipped to denied (which re-arms the
  // appeal workflow downstream).
  const currentRows = await prisma.$queryRawUnsafe(
    `SELECT id, status, payer_decided_at, payer_decision_reason, patient_uid
       FROM clinical_ai_prior_auth_requests
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    paId,
    tid,
  );
  if (!currentRows[0]) throw AppError.notFound('Prior auth not found');
  const current = currentRows[0];
  if (current.status === normalized) {
    // Already in the requested decision state — idempotent no-op.
    return current;
  }
  if (!PRIOR_AUTH_DECISION_FROM_STATES.includes(current.status)) {
    throw AppError.invalidTransition(current.status, normalized, PRIOR_AUTH_DECISION_FROM_STATES);
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_prior_auth_requests
     SET status = $2,
         payer_decided_at = NOW(),
         payer_decision_reason = $3,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $4::uuid
       AND status = $5
     RETURNING id, status, payer_decided_at, payer_decision_reason, patient_uid`,
    paId,
    normalized,
    reason,
    tid,
    current.status,
  );
  if (!rows[0]) throw AppError.notFound('Prior auth not found');
  const updated = rows[0];

  // Phase 1.5 — post-commit best-effort event (never throws).
  if (normalized === 'denied') {
    try {
      await publishEvent({
        eventType: 'clinical_ai.prior_auth_denied',
        aggregateType: 'prior_auth',
        aggregateId: String(priorAuthId),
        patientUid: updated.patient_uid || null,
        payload: { tenant_id: tid || null, payer_decision_reason: reason || null },
      });
    } catch (err) {
      logger.warn('Failed to publish prior_auth_denied event', { priorAuthId, error: err.message });
    }
  }

  return updated;
}

export async function listPriorAuthorizations({ tenantId = null, status = null, reviewerDecision = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, admission_id, patient_uid, payer_name, policy_number, procedure_code,
              procedure_description, requested_service_type, status, reviewer_decision,
              payer_reference_id, submitted_at, payer_decided_at, payer_decision_reason,
              metadata, created_at, updated_at
       FROM clinical_ai_prior_auth_requests
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR reviewer_decision = $3)
       ORDER BY created_at DESC
       LIMIT $4`,
      tid,
      status,
      reviewerDecision,
      safeLimit
    );
    return { prior_auths: rows, count: rows.length };
  } catch (err) {
    if (/does not exist/i.test(String(err?.message || ''))) return { prior_auths: [], count: 0 };
    throw err;
  }
}

export default {
  generatePriorAuthorization,
  listPriorAuthorizations,
  recordPayerDecision,
  submitPriorAuthorization,
};
