/**
 * Radiology AI interpretation.
 *
 * The pipeline here is provider-agnostic: DICOM pixel data lives in the
 * hospital's PACS (Orthanc, dcm4chee, commercial) and the inference
 * model runs there or in a GPU-backed sidecar. We accept the study
 * metadata + a structured inference result (labels + confidences +
 * optional heatmap URL) and produce a radiologist-facing draft.
 *
 * This design lets the hospital pick their model provider (TorchXRay
 * Vision on-prem, MONAI inference server, cloud PACS AI) without the
 * backend reimplementing the ML layer. Radiologist always signs off
 * before a finding becomes part of the chart.
 *
 * Critical findings (pneumothorax, mass, hemorrhage) jump to the top
 * of the queue via the `overall_severity` ordering + a CRITICAL safety
 * flag on the accompanying clinical_ai_generation.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import {
  describePacsConfig,
  fetchPacsStudyMetadata,
} from './imagingPacsAdapterService.js';

const MODULE_KEY = 'radiology_ai_interpretation';

const CRITICAL_LABELS = new Set([
  'pneumothorax',
  'tension pneumothorax',
  'hemorrhage',
  'intracranial hemorrhage',
  'subdural hemorrhage',
  'subarachnoid hemorrhage',
  'aortic dissection',
  'pulmonary embolism',
  'mass',
  'mass effect',
  'midline shift',
  'free air',
  'bowel perforation',
]);

const ACTIONABLE_LABELS = new Set([
  'pneumonia', 'pleural effusion', 'cardiomegaly', 'pulmonary edema',
  'consolidation', 'opacity', 'atelectasis', 'fracture', 'nodule',
  'pneumonitis', 'infiltrate', 'pleural thickening',
]);

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function clean(text) {
  return String(text || '').trim();
}

/**
 * Pure function: turn an array of { label, confidence } inference results
 * into a triage-ordered finding list + an overall severity.
 *
 * - severity='critical' if any CRITICAL label has confidence >= 0.5
 * - severity='actionable' if any ACTIONABLE label has confidence >= 0.6
 * - severity='incidental' if there's at least one label above 0.3
 * - severity='normal' otherwise
 */
export function classifyInferenceResults(results) {
  const findings = [];
  let topConfidence = 0;
  let severity = 'normal';

  for (const row of Array.isArray(results) ? results : []) {
    const label = clean(row?.label).toLowerCase();
    const confidence = Math.min(Math.max(Number(row?.confidence || 0), 0), 1);
    if (!label) continue;
    topConfidence = Math.max(topConfidence, confidence);

    if (CRITICAL_LABELS.has(label) && confidence >= 0.5) {
      severity = 'critical';
      findings.push({ label, confidence, severity: 'critical', actionable: true });
    } else if (ACTIONABLE_LABELS.has(label) && confidence >= 0.6) {
      if (severity !== 'critical') severity = 'actionable';
      findings.push({ label, confidence, severity: 'actionable', actionable: true });
    } else if (confidence >= 0.3) {
      if (severity === 'normal') severity = 'incidental';
      findings.push({ label, confidence, severity: 'incidental', actionable: false });
    }
  }

  findings.sort((a, b) => {
    const sevOrder = { critical: 0, actionable: 1, incidental: 2 };
    if (sevOrder[a.severity] !== sevOrder[b.severity]) {
      return sevOrder[a.severity] - sevOrder[b.severity];
    }
    return b.confidence - a.confidence;
  });

  return {
    findings,
    overall_severity: severity,
    confidence_pct: Math.round(topConfidence * 100),
  };
}

function buildNarrativeDraft({ study, findings, overall_severity }) {
  if (findings.length === 0) {
    return `No actionable findings detected on ${study.modality} of ${study.body_part || 'exam'} dated ${study.study_date || 'unknown'}. Radiologist review required.`;
  }
  const lines = [
    `${study.modality} of ${study.body_part || 'exam'} dated ${study.study_date || 'unknown'}.`,
    'AI-flagged findings (draft; radiologist must confirm):',
    ...findings.map((f) => `  • ${f.label} — severity ${f.severity}, confidence ${(f.confidence * 100).toFixed(0)}%`),
  ];
  if (overall_severity === 'critical') {
    lines.push('CRITICAL finding flagged. Notify ordering clinician.');
  }
  return lines.join('\n');
}

export async function registerImagingStudy({
  tenantId = null,
  patientUid,
  admissionId = null,
  studyInstanceUid,
  modality,
  bodyPart = null,
  studyDate = null,
  seriesCount = 1,
  instanceCount = 1,
  pacsUrl = null,
  storageKey = null,
  sourceSystem = null,
  orderedBy = null,
  metadata = {},
} = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  if (!studyInstanceUid) throw AppError.badRequest('studyInstanceUid is required');
  if (!modality) throw AppError.badRequest('modality is required');
  const tid = resolveTenantId({ tenantId });

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_imaging_studies
       (tenant_id, patient_uid, admission_id, study_instance_uid, modality, body_part,
        study_date, series_count, instance_count, pacs_url, storage_key, source_system,
        ordered_by, metadata, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid,
             $14::jsonb, NOW())
     ON CONFLICT (tenant_id, study_instance_uid)
     DO UPDATE SET
       series_count = GREATEST(clinical_ai_imaging_studies.series_count, EXCLUDED.series_count),
       instance_count = GREATEST(clinical_ai_imaging_studies.instance_count, EXCLUDED.instance_count),
       pacs_url = COALESCE(EXCLUDED.pacs_url, clinical_ai_imaging_studies.pacs_url),
       storage_key = COALESCE(EXCLUDED.storage_key, clinical_ai_imaging_studies.storage_key),
       metadata = clinical_ai_imaging_studies.metadata || EXCLUDED.metadata
     RETURNING id, tenant_id, patient_uid, study_instance_uid, modality, body_part,
               study_date, pacs_url, created_at`,
    tid,
    patientUid,
    admissionId ? Number.parseInt(admissionId, 10) : null,
    String(studyInstanceUid),
    String(modality).toUpperCase(),
    bodyPart || null,
    studyDate || null,
    Math.max(Number.parseInt(seriesCount, 10) || 1, 1),
    Math.max(Number.parseInt(instanceCount, 10) || 1, 1),
    pacsUrl,
    storageKey,
    sourceSystem || null,
    orderedBy,
    JSON.stringify(metadata || {})
  );
  return rows[0];
}

export function getImagingPacsStatus({ tenantRegion = null } = {}) {
  return describePacsConfig({ tenantRegion });
}

export async function importImagingStudyFromPacs({
  req,
  patientUid,
  admissionId = null,
  studyInstanceUid = null,
  accessionNumber = null,
  provider = null,
  orderedBy = null,
  metadata = {},
} = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  if (!studyInstanceUid && !accessionNumber) {
    throw AppError.badRequest('studyInstanceUid or accessionNumber is required');
  }
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const lookup = await fetchPacsStudyMetadata({
    studyInstanceUid,
    accessionNumber,
    provider,
    tenantRegion: req?.tenant?.region || null,
  });

  if (lookup.status !== 'found') {
    return {
      imported: false,
      pacs_status: lookup.status,
      reason: lookup.reason,
      provider: lookup.provider || provider || null,
      api_mode: lookup.api_mode || null,
      config: lookup.config || null,
      module_key: MODULE_KEY,
      decision_support_only: true,
    };
  }

  const study = lookup.study;
  const saved = await registerImagingStudy({
    tenantId,
    patientUid,
    admissionId,
    studyInstanceUid: study.study_instance_uid,
    modality: study.modality,
    bodyPart: study.body_part,
    studyDate: study.study_date,
    seriesCount: study.series_count,
    instanceCount: study.instance_count,
    pacsUrl: lookup.query_url || null,
    sourceSystem: lookup.provider,
    orderedBy: orderedBy || req?.user?.uid || null,
    metadata: {
      ...(metadata || {}),
      pacs_lookup: {
        status: lookup.status,
        provider: lookup.provider,
        api_mode: lookup.api_mode,
        accession_number: study.accession_number,
        study_description: study.study_description,
        dicom_patient_identifier: study.dicom_patient_identifier,
        dicom_patient_name_present: study.dicom_patient_name_present,
        source_format: study.source_format,
        pacs_study_id: study.pacs_study_id || null,
      },
    },
  });

  return {
    imported: true,
    pacs_status: lookup.status,
    provider: lookup.provider,
    api_mode: lookup.api_mode,
    study: saved,
    pacs_metadata: {
      accession_number: study.accession_number,
      study_description: study.study_description,
      dicom_patient_identifier: study.dicom_patient_identifier,
      dicom_patient_name_present: study.dicom_patient_name_present,
      source_format: study.source_format,
    },
    module_key: MODULE_KEY,
    decision_support_only: true,
  };
}

/**
 * Ingest an external inference result (from TorchXRayVision, MONAI,
 * cloud PACS AI, etc.) and persist a finding row + a standard clinical
 * AI generation. Radiologist must confirm before it counts as a report.
 */
export async function ingestInferenceResult({
  req,
  studyInstanceUid,
  provider,
  model = null,
  modelVersion = null,
  results = [],
  heatmapUrl = null,
  rawProviderPayload = null,
} = {}) {
  if (!studyInstanceUid) throw AppError.badRequest('studyInstanceUid is required');
  if (!provider) throw AppError.badRequest('provider is required');
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });

  const studyRows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, admission_id, modality, body_part, study_date
     FROM clinical_ai_imaging_studies
     WHERE tenant_id = $1::uuid AND study_instance_uid = $2
     LIMIT 1`,
    tenantId,
    studyInstanceUid
  );
  const study = studyRows[0];
  if (!study) throw AppError.notFound('Imaging study not found — register it first');

  const classified = classifyInferenceResults(results);
  const narrative = buildNarrativeDraft({ study, ...classified });
  const module = await getClinicalAiModule(MODULE_KEY);

  const citations = [{
    source_type: 'imaging_study',
    source_id: String(study.id),
    label: `${study.modality} ${study.body_part || ''} (${study.study_instance_uid})`,
    timestamp: study.study_date,
  }];
  const defenseFlags = runOutputDefenses({
    draft: {
      findings: classified.findings,
      overall_severity: classified.overall_severity,
      narrative_draft: narrative,
    },
    module,
    context: { study, results },
    citations,
  });
  if (classified.overall_severity === 'critical') {
    defenseFlags.unshift({
      severity: 'critical',
      code: 'IMAGING_CRITICAL_FINDING',
      message: 'AI flagged a critical finding. Radiologist must review within the critical-read SLA.',
    });
  }

  // Save a clinical_ai_generation so imaging flows through the same
  // review + audit trail as text drafts.
  let generationId = null;
  try {
    const genRows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, 'v1', $7, $8, true,
               $9::jsonb, $10::jsonb, $11::jsonb, $12::uuid, 0, 0, 0, $13::jsonb, NOW(), NOW())
       RETURNING id`,
      tenantId,
      study.patient_uid,
      study.admission_id,
      MODULE_KEY,
      provider,
      model,
      String(study.study_instance_uid).slice(0, 64),
      classified.overall_severity === 'critical' ? 'draft' : 'draft',
      JSON.stringify(defenseFlags),
      JSON.stringify(citations),
      JSON.stringify({
        findings: classified.findings,
        overall_severity: classified.overall_severity,
        narrative_draft: narrative,
        confidence_pct: classified.confidence_pct,
        heatmap_url: heatmapUrl,
      }),
      req?.user?.uid || null,
      JSON.stringify({
        imaging_study_id: study.id,
        provider,
        model_version: modelVersion,
        raw_provider_payload: rawProviderPayload || null,
        tenant_region: req?.tenant?.region || null,
      })
    );
    generationId = genRows[0]?.id || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Imaging generation persist failed', { studyInstanceUid, error: err.message });
    }
  }

  // Save the finding row keyed (tenant, study, provider, model) so reruns
  // from the same model are upserted rather than duplicated.
  const findingRows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_imaging_findings
       (tenant_id, study_id, provider, model, model_version, findings,
        overall_severity, confidence_pct, heatmap_url, narrative_draft,
        citations, safety_flags, generation_id, created_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb,
             $12::jsonb, $13, NOW())
     ON CONFLICT (tenant_id, study_id, provider, model)
     DO UPDATE SET
       model_version = EXCLUDED.model_version,
       findings = EXCLUDED.findings,
       overall_severity = EXCLUDED.overall_severity,
       confidence_pct = EXCLUDED.confidence_pct,
       heatmap_url = EXCLUDED.heatmap_url,
       narrative_draft = EXCLUDED.narrative_draft,
       citations = EXCLUDED.citations,
       safety_flags = EXCLUDED.safety_flags,
       generation_id = EXCLUDED.generation_id,
       radiologist_decision = 'pending'
     RETURNING id, overall_severity, confidence_pct, radiologist_decision, created_at`,
    tenantId,
    study.id,
    provider,
    model,
    modelVersion,
    JSON.stringify(classified.findings),
    classified.overall_severity,
    classified.confidence_pct,
    heatmapUrl,
    narrative,
    JSON.stringify(citations),
    JSON.stringify(defenseFlags),
    generationId
  );

  return {
    finding_id: findingRows[0]?.id || null,
    study_id: study.id,
    study_instance_uid: studyInstanceUid,
    generation_id: generationId,
    findings: classified.findings,
    overall_severity: classified.overall_severity,
    confidence_pct: classified.confidence_pct,
    narrative_draft: narrative,
    heatmap_url: heatmapUrl,
    safety_flags: defenseFlags,
    radiologist_decision: 'pending',
    module_key: MODULE_KEY,
    decision_support_only: true,
  };
}

export async function decideImagingFinding({ findingId, decision, radiologistUid = null, note = null, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = String(decision || '').toLowerCase();
  if (!['confirmed', 'revised', 'rejected', 'escalated'].includes(normalized)) {
    throw AppError.badRequest('decision must be confirmed, revised, rejected, or escalated');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_imaging_findings
     SET radiologist_decision = $2,
         radiologist_uid = $3::uuid,
         radiologist_note = $4,
         reviewed_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
       AND radiologist_decision = 'pending'
     RETURNING id, study_id, generation_id, radiologist_decision, radiologist_note, reviewed_at`,
    Number.parseInt(findingId, 10),
    normalized,
    radiologistUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Pending imaging finding not found');
  return rows[0];
}

export async function listImagingFindings({ tenantId = null, decision = null, severity = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT f.id, f.study_id, f.provider, f.model, f.overall_severity, f.confidence_pct,
              f.findings, f.narrative_draft, f.radiologist_decision, f.reviewed_at,
              f.created_at, f.heatmap_url,
              s.patient_uid, s.modality, s.body_part, s.study_date, s.study_instance_uid,
              u.name AS patient_name
       FROM clinical_ai_imaging_findings f
       JOIN clinical_ai_imaging_studies s ON s.id = f.study_id
       LEFT JOIN users u ON u.uid = s.patient_uid
       WHERE f.tenant_id = $1::uuid
         AND ($2::text IS NULL OR f.radiologist_decision = $2)
         AND ($3::text IS NULL OR f.overall_severity = $3)
       ORDER BY
         CASE f.overall_severity
           WHEN 'critical' THEN 0
           WHEN 'actionable' THEN 1
           WHEN 'incidental' THEN 2
           ELSE 3
         END,
         f.created_at DESC
       LIMIT $4`,
      tid,
      decision,
      severity,
      safeLimit
    );
    return { findings: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { findings: [], count: 0 };
    throw err;
  }
}

export default {
  classifyInferenceResults,
  decideImagingFinding,
  getImagingPacsStatus,
  importImagingStudyFromPacs,
  ingestInferenceResult,
  listImagingFindings,
  registerImagingStudy,
};
