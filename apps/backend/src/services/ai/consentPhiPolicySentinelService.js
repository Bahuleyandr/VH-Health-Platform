/**
 * Consent & PHI Policy Sentinel.
 *
 * Deterministic governance scanner for AI generations. It flags consent,
 * provider-boundary, PHI, citation, safety, and stale-review risks without
 * changing clinical state or provider configuration.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';

const MODULE_KEY = 'consent_phi_policy_sentinel';
const NON_EXTERNAL_PROVIDERS = new Set([
  '',
  'template',
  'rule',
  'rules',
  'local',
  'ollama',
  'mock',
  'none',
  'local_whisper',
  'whisper_local',
]);
const PATIENT_SURFACES = new Set([
  'clinical',
  'medical_records',
  'patient',
  'billing',
  'pharmacy',
  'radiology',
  'virtual_ward',
]);
const SEVERITY_WEIGHTS = {
  critical: 35,
  high: 20,
  medium: 10,
  low: 4,
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

function safeJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanText(value) {
  return String(value || '').trim();
}

function optionalInt(value, fieldName = 'id') {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function normalizeProvider(provider) {
  return cleanText(provider).toLowerCase().replace(/\s+/g, '_');
}

function isExternalProvider(provider) {
  return !NON_EXTERNAL_PROVIDERS.has(normalizeProvider(provider));
}

function activeConsent(consent) {
  const status = cleanText(consent?.status).toLowerCase();
  const revoked = Boolean(consent?.revoked_at);
  const expired = consent?.expires_at ? new Date(consent.expires_at).getTime() < Date.now() : false;
  return !revoked && !expired && consent?.granted !== false && ['active', 'granted', 'approved'].includes(status);
}

function summarizeConsents(consents = []) {
  const active = asArray(consents).filter(activeConsent);
  const types = active.map((consent) => cleanText(consent.consent_type).toLowerCase()).filter(Boolean);
  const hasAny = types.length > 0;
  const hasTreatment = types.includes('treatment');
  const hasDataAccess = types.includes('data_access') || types.includes('data-sharing') || types.includes('data_sharing');
  const hasAiProcessing = types.includes('ai_processing') || types.includes('ai-processing') || types.includes('clinical_ai');
  const hasResearch = types.includes('research');
  return {
    available: true,
    active_count: active.length,
    active_types: [...new Set(types)].sort(),
    has_any_consent: hasAny,
    has_treatment_consent: hasTreatment,
    has_data_access_consent: hasDataAccess,
    has_ai_processing_consent: hasAiProcessing,
    has_research_consent: hasResearch,
    latest_granted_at: active
      .map((consent) => consent.granted_at || consent.created_at || null)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || null,
  };
}

function moduleRequiresPatient(moduleSettings = {}) {
  return PATIENT_SURFACES.has(cleanText(moduleSettings.surface).toLowerCase());
}

function moduleRequiresCitations(moduleSettings = {}) {
  return moduleSettings.requiresCitations === true;
}

function moduleRequiresSignoff(moduleSettings = {}) {
  return moduleSettings.requiresClinicianSignoff === true;
}

function moduleRisk(moduleSettings = {}) {
  return cleanText(moduleSettings.risk).toLowerCase() || 'medium';
}

function hasCriticalSafetyFlag(flags = []) {
  return asArray(flags).some((flag) => cleanText(flag?.severity).toLowerCase() === 'critical');
}

function rawIdentifierHits(generation = {}) {
  const text = JSON.stringify(safeJson(generation.draft, generation.draft || {}));
  const hits = [];
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) hits.push('email');
  if (/(?:\+?91[-\s]?)?[6-9]\d{9}\b/.test(text)) hits.push('phone');
  if (/\b\d{12}\b/.test(text)) hits.push('long_numeric_identifier');
  return [...new Set(hits)];
}

function makeFinding({ severity, code, title, recommendation, evidence = [] }) {
  return {
    severity,
    code,
    title,
    recommendation,
    evidence: asArray(evidence).filter(Boolean).slice(0, 6),
  };
}

function riskBandFor(score, findings) {
  if (findings.some((finding) => finding.severity === 'critical') || score >= 70) return 'critical';
  if (findings.some((finding) => finding.severity === 'high') || score >= 45) return 'high';
  if (findings.some((finding) => finding.severity === 'medium') || score >= 20) return 'medium';
  return 'low';
}

function addFinding(findings, finding) {
  findings.push(makeFinding(finding));
}

export function evaluateConsentPhiPolicy({
  generation = {},
  module = {},
  consents = [],
  now = new Date(),
} = {}) {
  const findings = [];
  const moduleSettings = safeJson(module.settings, module.settings || {});
  const consentSnapshot = summarizeConsents(consents);
  const provider = generation.provider || 'template';
  const external = isExternalProvider(provider);
  const externalAllowed = module.external_allowed === true || moduleSettings.externalAllowed === true;
  const patientUid = generation.patient_uid || null;
  const reviewDecision = cleanText(generation.review_decision).toLowerCase();
  const safetyFlags = asArray(safeJson(generation.safety_flags, []));
  const citations = asArray(safeJson(generation.citations, []));
  const createdAt = generation.created_at ? new Date(generation.created_at) : null;
  const ageDays = createdAt ? Math.floor((now.getTime() - createdAt.getTime()) / 86400000) : 0;
  const identifiers = rawIdentifierHits(generation);

  if (moduleRequiresPatient(moduleSettings) && !patientUid) {
    addFinding(findings, {
      severity: 'medium',
      code: 'PATIENT_CONTEXT_MISSING',
      title: 'Patient-scoped AI generation has no patient UID.',
      recommendation: 'Review source workflow and require patient_uid before running patient-facing AI modules.',
    });
  }

  if (patientUid && !consentSnapshot.has_treatment_consent) {
    addFinding(findings, {
      severity: 'high',
      code: 'NO_ACTIVE_TREATMENT_CONSENT',
      title: 'No active treatment consent was found for the patient.',
      recommendation: 'Verify consent status before accepting, exporting, or reusing this AI output.',
      evidence: [{ patient_uid: patientUid }],
    });
  }

  if (external && !externalAllowed) {
    addFinding(findings, {
      severity: 'critical',
      code: 'EXTERNAL_PROVIDER_NOT_ALLOWED',
      title: 'Generation used an external provider while the module boundary is local-only.',
      recommendation: 'Escalate to Admin/IT, verify module settings, and rotate or disable provider credentials if needed.',
      evidence: [{ provider, module_key: generation.module_key || generation.task_type || null }],
    });
  }

  if (external && patientUid && !(consentSnapshot.has_ai_processing_consent || consentSnapshot.has_data_access_consent)) {
    addFinding(findings, {
      severity: 'critical',
      code: 'EXTERNAL_AI_WITHOUT_AI_CONSENT',
      title: 'External AI was used without active AI-processing or data-access consent.',
      recommendation: 'Escalate for privacy review before any clinical or patient-facing reuse.',
      evidence: [{ provider, patient_uid: patientUid }],
    });
  }

  if (hasCriticalSafetyFlag(safetyFlags)) {
    addFinding(findings, {
      severity: 'critical',
      code: 'CRITICAL_SAFETY_FLAG_PRESENT',
      title: 'The AI generation contains a critical safety flag.',
      recommendation: 'Keep the output blocked until a qualified reviewer resolves the critical flag.',
      evidence: safetyFlags.filter((flag) => cleanText(flag?.severity).toLowerCase() === 'critical').slice(0, 4),
    });
  }

  if (moduleRequiresCitations(moduleSettings) && citations.length === 0) {
    addFinding(findings, {
      severity: 'high',
      code: 'REQUIRED_CITATIONS_MISSING',
      title: 'Module requires citations but the generation has none.',
      recommendation: 'Regenerate with cited source evidence or reject the draft.',
    });
  }

  if (moduleRequiresSignoff(moduleSettings) && reviewDecision !== 'accepted') {
    addFinding(findings, {
      severity: moduleRisk(moduleSettings) === 'critical' || moduleRisk(moduleSettings) === 'high' ? 'high' : 'medium',
      code: 'SIGNOFF_PENDING',
      title: 'Human review is still pending for a signoff-required module.',
      recommendation: 'Route the draft to the configured human review queue before downstream use.',
      evidence: [{ decision: reviewDecision || 'none' }],
    });
  }

  if (ageDays >= 7 && reviewDecision !== 'accepted' && ['draft', 'pending', 'failed'].includes(cleanText(generation.status).toLowerCase())) {
    addFinding(findings, {
      severity: 'medium',
      code: 'STALE_UNREVIEWED_DRAFT',
      title: 'The AI generation has remained unreviewed for at least seven days.',
      recommendation: 'Reject stale drafts or assign them to the appropriate reviewer.',
      evidence: [{ age_days: ageDays }],
    });
  }

  if (identifiers.length && external) {
    addFinding(findings, {
      severity: 'high',
      code: 'RAW_IDENTIFIER_IN_EXTERNAL_DRAFT',
      title: 'Potential direct identifiers appear in an externally processed draft.',
      recommendation: 'Review PHI minimization and external provider logs before accepting the output.',
      evidence: identifiers.map((kind) => ({ kind })),
    });
  } else if (identifiers.length) {
    addFinding(findings, {
      severity: 'low',
      code: 'RAW_IDENTIFIER_IN_DRAFT',
      title: 'Potential direct identifiers appear in the draft.',
      recommendation: 'Confirm the identifiers are necessary and covered by the workflow consent.',
      evidence: identifiers.map((kind) => ({ kind })),
    });
  }

  const riskScore = Math.min(
    100,
    findings.reduce((sum, finding) => sum + (SEVERITY_WEIGHTS[finding.severity] || 0), 0)
  );

  return {
    risk_score: riskScore,
    risk_band: riskBandFor(riskScore, findings),
    findings,
    consent_snapshot: consentSnapshot,
    generation: {
      id: generation.id || null,
      module_key: generation.module_key || generation.task_type || null,
      provider,
      external_provider: external,
      created_at: generation.created_at || null,
      review_decision: reviewDecision || null,
    },
  };
}

async function getPatientConsents(patientUid) {
  if (!patientUid) return [];
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT consent_type, granted, status, granted_at, revoked_at, expires_at,
              source, purpose, data_categories, created_at
       FROM patient_consents
       WHERE patient_uid = $1::uuid
       ORDER BY created_at DESC
       LIMIT 30`,
      patientUid
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function fetchGenerations({ tenantId, generationId = null, windowDays = 7, limit = 100 }) {
  const safeGenerationId = optionalInt(generationId, 'generation_id');
  const safeWindowDays = Math.min(Math.max(Number.parseInt(windowDays, 10) || 7, 1), 365);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  return prisma.$queryRawUnsafe(
    `SELECT g.id, g.tenant_id, g.patient_uid, g.admission_id, g.task_type,
            COALESCE(g.module_key, g.task_type) AS module_key,
            g.provider, g.model, g.status, g.used_ai, g.safety_flags, g.citations,
            g.draft, g.metadata, g.created_at,
            r.decision AS review_decision,
            r.reviewer_uid AS latest_reviewer_uid,
            r.updated_at AS review_updated_at,
            m.display_name AS module_display_name,
            m.enabled AS module_enabled,
            m.external_allowed,
            m.settings AS module_settings
     FROM clinical_ai_generations g
     LEFT JOIN clinical_ai_modules m
       ON m.module_key = COALESCE(g.module_key, g.task_type)
     LEFT JOIN LATERAL (
       SELECT decision, reviewer_uid, updated_at
       FROM clinical_ai_reviews
       WHERE generation_id = g.id
       ORDER BY updated_at DESC NULLS LAST, created_at DESC
       LIMIT 1
     ) r ON TRUE
     WHERE g.tenant_id = $1::uuid
       AND COALESCE(g.module_key, g.task_type) <> $2
       AND ($3::int IS NULL OR g.id = $3)
       AND ($3::int IS NOT NULL OR g.created_at >= NOW() - ($4::int * INTERVAL '1 day'))
     ORDER BY g.created_at DESC
     LIMIT $5`,
    tenantId,
    MODULE_KEY,
    safeGenerationId,
    safeWindowDays,
    safeLimit
  );
}

async function upsertAudit({ tenantId, generation, evaluation, scannedBy = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_privacy_sentinel_audits
       (tenant_id, generation_id, patient_uid, module_key, provider, risk_band,
        risk_score, findings, consent_snapshot, reviewer_decision, metadata,
        created_at, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
             'pending', $10::jsonb, NOW(), NOW())
     ON CONFLICT (tenant_id, generation_id)
     DO UPDATE SET
       patient_uid = EXCLUDED.patient_uid,
       module_key = EXCLUDED.module_key,
       provider = EXCLUDED.provider,
       risk_band = EXCLUDED.risk_band,
       risk_score = EXCLUDED.risk_score,
       findings = EXCLUDED.findings,
       consent_snapshot = EXCLUDED.consent_snapshot,
       metadata = clinical_ai_privacy_sentinel_audits.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, tenant_id, generation_id, patient_uid, module_key, provider,
               risk_band, risk_score, findings, consent_snapshot,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
               metadata, created_at, updated_at`,
    tenantId,
    generation.id,
    generation.patient_uid || null,
    generation.module_key || generation.task_type || null,
    generation.provider || 'template',
    evaluation.risk_band,
    evaluation.risk_score,
    JSON.stringify(evaluation.findings),
    JSON.stringify(evaluation.consent_snapshot),
    JSON.stringify({
      scanned_by: scannedBy,
      scanned_at: new Date().toISOString(),
      source_generation_created_at: generation.created_at || null,
      module_display_name: generation.module_display_name || null,
      external_provider: evaluation.generation.external_provider,
    })
  );
  return rows[0] || null;
}

function summarizeAudits(audits) {
  const summary = {
    scanned: audits.length,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    findings: 0,
  };
  for (const audit of audits) {
    if (summary[audit.risk_band] !== undefined) summary[audit.risk_band] += 1;
    summary.findings += asArray(audit.findings).length;
  }
  return summary;
}

export async function runConsentPhiPolicyScan({
  req = null,
  tenantId = null,
  generationId = null,
  windowDays = 7,
  limit = 100,
} = {}) {
  const tid = resolveTenantId({ tenantId: tenantId || req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY);
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  let generations = [];
  try {
    generations = await fetchGenerations({ tenantId: tid, generationId, windowDays, limit });
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        audits: [],
        count: 0,
        summary: summarizeAudits([]),
        reason: 'clinical_ai_generations_unavailable',
        decision_support_only: true,
      };
    }
    throw err;
  }

  const audits = [];
  try {
    for (const generation of generations) {
      const consents = await getPatientConsents(generation.patient_uid);
      const evaluation = evaluateConsentPhiPolicy({
        generation: {
          ...generation,
          safety_flags: safeJson(generation.safety_flags, []),
          citations: safeJson(generation.citations, []),
          draft: safeJson(generation.draft, {}),
        },
        module: {
          module_key: generation.module_key,
          external_allowed: generation.external_allowed,
          settings: safeJson(generation.module_settings, {}),
        },
        consents,
      });
      const audit = await upsertAudit({
        tenantId: tid,
        generation,
        evaluation,
        scannedBy: req?.user?.uid || null,
      });
      if (audit) audits.push(audit);
    }
  } catch (err) {
    if (isMissingSchemaError(err)) {
      logger.warn('Privacy sentinel audit table unavailable', { error: err.message });
      return {
        audits: [],
        count: 0,
        summary: summarizeAudits([]),
        reason: 'clinical_ai_privacy_sentinel_audits_unavailable',
        decision_support_only: true,
      };
    }
    throw err;
  }

  const summary = summarizeAudits(audits);
  await publishEvent({
    eventType: 'clinical_ai.privacy_sentinel_scan_completed',
    aggregateType: 'clinical_ai_privacy_sentinel',
    aggregateId: tid,
    payload: {
      tenant_id: tid,
      generation_id: generationId || null,
      window_days: windowDays,
      summary,
    },
  });

  return {
    audits,
    count: audits.length,
    summary,
    module_key: MODULE_KEY,
    decision_support_only: true,
  };
}

export async function listConsentPhiPolicyAudits({
  tenantId = null,
  riskBand = null,
  decision = null,
  moduleKey = null,
  patientUid = null,
  limit = 100,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.generation_id, a.patient_uid, u.name AS patient_name,
              a.module_key, a.provider, a.risk_band, a.risk_score, a.findings,
              a.consent_snapshot, a.reviewer_decision, a.reviewed_by, a.reviewed_at,
              a.reviewer_note, a.metadata, a.created_at, a.updated_at,
              g.status AS generation_status, g.created_at AS generation_created_at,
              g.total_tokens, g.estimated_cost_minor
       FROM clinical_ai_privacy_sentinel_audits a
       LEFT JOIN users u ON u.uid = a.patient_uid
       LEFT JOIN clinical_ai_generations g ON g.id = a.generation_id
       WHERE a.tenant_id = $1::uuid
         AND ($2::text IS NULL OR a.risk_band = $2)
         AND ($3::text IS NULL OR a.reviewer_decision = $3)
         AND ($4::text IS NULL OR a.module_key = $4)
         AND ($5::uuid IS NULL OR a.patient_uid = $5::uuid)
       ORDER BY a.risk_score DESC, a.created_at DESC
       LIMIT $6`,
      tid,
      riskBand || null,
      decision || null,
      moduleKey || null,
      patientUid || null,
      safeLimit
    );
    return { audits: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { audits: [], count: 0 };
    throw err;
  }
}

export async function decideConsentPhiPolicyAudit({
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
    `UPDATE clinical_ai_privacy_sentinel_audits
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, generation_id, patient_uid, module_key, provider, risk_band,
               risk_score, findings, consent_snapshot, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata, created_at, updated_at`,
    optionalInt(auditId, 'audit_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Privacy sentinel audit not found');
  return rows[0];
}

export default {
  decideConsentPhiPolicyAudit,
  evaluateConsentPhiPolicy,
  listConsentPhiPolicyAudits,
  runConsentPhiPolicyScan,
};
