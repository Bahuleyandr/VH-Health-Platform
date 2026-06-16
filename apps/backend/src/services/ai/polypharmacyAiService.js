/**
 * Polypharmacy AI review.
 *
 * Stacks on top of the existing rules-based `validatePrescriptionSafety`
 * (which catches allergy conflicts + duplicate actives). The AI layer
 * surfaces cross-class and pharmacokinetic interactions that pure rules
 * miss — QT-prolongation stacks, serotonin syndrome risk, CYP3A4
 * inhibitor + substrate pairs, nephrotoxic stacks.
 *
 * Rules are ALWAYS authoritative. The AI layer produces findings tagged
 * as advisory; severity is combined (max of rules + AI) and surfaced to
 * the reviewer.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import { generateClinicalText } from './localLlmClient.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function clean(text) {
  return String(text || '').trim();
}

function highestSeverity(findings) {
  const order = ['critical', 'high', 'medium', 'low'];
  for (const level of order) {
    if (findings.some((f) => String(f.severity || '').toLowerCase() === level)) return level;
  }
  return 'low';
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

export async function reviewPolypharmacy({ patientId, patientUid, medications, admissionId = null, req = null } = {}) {
  if (!Array.isArray(medications) || medications.length === 0) {
    throw AppError.badRequest('medications array is required');
  }
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });

  const module = await getClinicalAiModule('polypharmacy_ai_review', { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  // 1. Rule layer — existing, authoritative.
  const rules = await validatePrescriptionSafety(patientId || null, medications);
  const ruleFindings = [
    ...(rules.blockers || []).map((item) => ({
      severity: 'critical',
      source: 'rules',
      code: item.code || 'RULE_BLOCKER',
      message: item.message || String(item),
    })),
    ...(rules.warnings || []).map((item) => ({
      severity: 'high',
      source: 'rules',
      code: item.code || 'RULE_WARNING',
      message: item.message || String(item),
    })),
  ];

  // 2. AI layer — advisory.
  const medicationSummary = medications
    .map((med) => clean(`${med.name || med.medication_name || 'unknown'} ${med.dose || ''} ${med.route || ''} ${med.frequency || ''}`))
    .filter(Boolean);

  const systemPrompt = [
    'You are a hospital clinical pharmacist.',
    'Identify drug-drug interactions across the listed medications.',
    'Focus on cross-class risks: QT prolongation stacks, serotonin syndrome, CYP3A4 inhibitor + substrate, nephrotoxic stacks, bleeding risk stacks.',
    'Return JSON with a top-level array `findings`. Each finding: { severity (low|medium|high|critical), code, message, medications }.',
    'Do NOT invent medications that are not in the list. If no risk, return { "findings": [] }.',
    'Rules-based allergy + duplicate detection runs separately — do not duplicate those findings here.',
    'Return JSON only.',
  ].join('\n');
  const userPrompt = `Medication list:\n${medicationSummary.map((line, idx) => `${idx + 1}. ${line}`).join('\n')}`;

  const aiResult = await generateClinicalText({
    systemPrompt,
    userPrompt,
    taskType: 'polypharmacy_ai_review',
    tenantRegion: req?.tenant?.region || null,
    tenantId,
  });
  const parsed = safeJsonParse(aiResult.text, { findings: [] });
  const aiFindings = Array.isArray(parsed.findings) ? parsed.findings.map((f) => ({
    severity: String(f.severity || 'medium').toLowerCase(),
    source: 'ai',
    code: f.code || 'AI_INTERACTION',
    message: f.message || String(f),
    medications: Array.isArray(f.medications) ? f.medications : [],
  })) : [];

  // Defense layer — flag any AI-fabricated medication names.
  const allowedMeds = medicationSummary.map((m) => m.toLowerCase());
  const hallucinatedMeds = [];
  for (const finding of aiFindings) {
    for (const med of finding.medications) {
      if (med && !allowedMeds.some((allowed) => allowed.includes(String(med).toLowerCase()))) {
        hallucinatedMeds.push(med);
      }
    }
  }
  if (hallucinatedMeds.length > 0) {
    aiFindings.push({
      severity: 'high',
      source: 'defense',
      code: 'HALLUCINATED_MEDICATION_REFERENCE',
      message: `AI referenced medication(s) not in the supplied list: ${[...new Set(hallucinatedMeds)].join(', ')}`,
    });
  }

  // Also run the standard output defenses against the AI output.
  const defenseFlags = runOutputDefenses({
    draft: parsed,
    module,
    context: { medications: medicationSummary },
    citations: [],
  });
  for (const flag of defenseFlags) {
    aiFindings.push({ ...flag, source: 'defense' });
  }

  const combinedSeverity = highestSeverity([...ruleFindings, ...aiFindings]);

  let reviewId = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_polypharmacy_reviews
         (tenant_id, patient_uid, admission_id, medications, rule_findings, ai_findings,
          combined_severity, provider, model, reviewer_decision, scored_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, 'pending', NOW())
       RETURNING id`,
      tenantId,
      patientUid || null,
      admissionId ? Number.parseInt(admissionId, 10) : null,
      JSON.stringify(medications),
      JSON.stringify(ruleFindings),
      JSON.stringify(aiFindings),
      combinedSeverity,
      aiResult.provider || 'rules_only',
      aiResult.model || null
    );
    reviewId = rows[0]?.id || null;
  } catch (err) {
    if (!/does not exist|relation/i.test(String(err?.message || ''))) {
      logger.warn('Polypharmacy review persist failed', { error: err.message });
    }
  }

  return {
    review_id: reviewId,
    tenant_id: tenantId,
    patient_uid: patientUid || null,
    admission_id: admissionId || null,
    medications,
    rule_findings: ruleFindings,
    ai_findings: aiFindings,
    combined_severity: combinedSeverity,
    provider: aiResult.provider || 'rules_only',
    used_ai: Boolean(aiResult.usedAi),
    reviewer_decision: 'pending',
    module_key: 'polypharmacy_ai_review',
  };
}

export async function listPolypharmacyReviews({ tenantId = null, decision = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, admission_id, medications, rule_findings, ai_findings,
              combined_severity, provider, model, reviewer_decision, reviewer_note,
              reviewed_by, reviewed_at, scored_at
       FROM clinical_ai_polypharmacy_reviews
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR reviewer_decision = $2)
       ORDER BY scored_at DESC
       LIMIT $3`,
      tid,
      decision,
      safeLimit
    );
    return { reviews: rows, count: rows.length };
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) {
      return { reviews: [], count: 0 };
    }
    throw err;
  }
}

export async function decidePolypharmacyReview({ reviewId, decision, reviewerUid = null, reviewerNote = null, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = String(decision || '').toLowerCase();
  if (!['acknowledged', 'overridden', 'prescription_changed'].includes(normalized)) {
    throw AppError.badRequest('decision must be acknowledged, overridden, or prescription_changed');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_polypharmacy_reviews
     SET reviewer_decision = $2,
         reviewer_note = $3,
         reviewed_by = $4::uuid,
         reviewed_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
       AND reviewer_decision = 'pending'
     RETURNING id, combined_severity, reviewer_decision, reviewer_note, reviewed_by, reviewed_at`,
    Number.parseInt(reviewId, 10),
    normalized,
    reviewerNote,
    reviewerUid,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Pending polypharmacy review not found');
  return rows[0];
}

export default {
  decidePolypharmacyReview,
  listPolypharmacyReviews,
  reviewPolypharmacy,
};
