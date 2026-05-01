/**
 * Tier F — interoperability AI assistants. 5 modules from
 * docs/AI_FEATURE_GAP_BACKLOG.md "Tier F". CDS Hooks adapter shipped
 * separately via Phase D2; this file covers the rest.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { runExplainerPipeline } from './patientExplainersService.js';

const TEXT_INPUT_MAX = 24_000;

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}
function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw AppError.badRequest(`${label} must be a positive integer`);
  return parsed;
}
function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}
function requireText(value, label, { min = 1, max = TEXT_INPUT_MAX } = {}) {
  const text = String(value || '').trim();
  if (text.length < min) throw AppError.badRequest(`${label} must be at least ${min} characters`);
  return text.slice(0, max);
}
function shortHash(p) { return crypto.createHash('sha256').update(JSON.stringify(p || {})).digest('hex').slice(0, 16); }
async function safeQuery(sql, params = [], fallback = []) {
  try {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return Array.isArray(rows) ? rows : fallback;
  } catch (err) {
    if (isMissingSchemaError(err)) return fallback;
    throw err;
  }
}

const FHIR_RESOURCE_TYPES = ['Patient', 'Encounter', 'Observation', 'Condition', 'MedicationRequest',
  'Procedure', 'AllergyIntolerance', 'DiagnosticReport', 'DocumentReference', 'Bundle', 'Claim'];

const BUNDLE_SCOPES = ['insurance', 'referral', 'abdm', 'medico_legal'];

// ---------------------------------------------------------------------------
// 1. FHIR validation assistant
// ---------------------------------------------------------------------------
export async function generateFhirValidation({
  tenantId = null, resourceType, resourceJson,
  generatedBy = null, req = null,
} = {}) {
  if (!FHIR_RESOURCE_TYPES.includes(resourceType)) {
    throw AppError.badRequest(`resource_type must be one of: ${FHIR_RESOURCE_TYPES.join(', ')}`);
  }
  if (!resourceJson || typeof resourceJson !== 'object') {
    throw AppError.badRequest('resource_json must be a JSON object');
  }
  const serialized = JSON.stringify(resourceJson);
  if (serialized.length > 80_000) {
    throw AppError.badRequest('resource_json exceeds 80kB cap');
  }

  return runExplainerPipeline({
    moduleKey: 'fhir_validation_assistant',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      `You are a FHIR R4 validator. Validate the supplied ${resourceType} resource for:`,
      '  1. Required-element presence',
      '  2. Bound-value-set conformance (codes that must come from a value set)',
      '  3. Slicing / cardinality issues a profile would catch',
      'Output: explanation_summary, valid: true|false, issues (array of { severity: error|warning|info, path, message, fix_suggestion }).',
      'Do NOT fabricate codes. If a code is unknown, mark severity=warning with "code not in supplied data".',
    ].join('\n'),
    userPromptPayload: { resource_type: resourceType, resource_json: resourceJson },
    contextForDefenses: { resource_json: resourceJson },
    citations: [{ source_type: 'fhir_resource', source_id: shortHash(serialized),
      label: `${resourceType} resource (${serialized.length} chars)`, timestamp: null }],
    metadata: { resource_type: resourceType, resource_chars: serialized.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 2. ABDM Care Context assistant
// ---------------------------------------------------------------------------
export async function generateAbdmCareContext({
  tenantId = null, admissionId,
  generatedBy = null, req = null,
} = {}) {
  const admId = normalizeId(admissionId, 'admission_id');
  const adm = (await safeQuery(
    `SELECT id, patient_uid, admission_date, discharge_date, primary_diagnosis,
            secondary_diagnoses
     FROM admissions WHERE id = $1 LIMIT 1`, [admId],
  ))[0];
  if (!adm) throw AppError.notFound('Admission not found');

  const labs = await safeQuery(
    `SELECT id, test_name, completed_at FROM investigations
     WHERE patient_uid = $1::uuid AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 10`, [adm.patient_uid],
  );
  const meds = await safeQuery(
    `SELECT id, medication_name FROM prescriptions WHERE patient_uid = $1::uuid
     ORDER BY prescribed_at DESC LIMIT 10`, [adm.patient_uid],
  );

  return runExplainerPipeline({
    moduleKey: 'abdm_care_context_assistant',
    tenantId, patientUid: adm.patient_uid, admissionId: admId,
    systemPrompt: [
      'You are an ABDM CareContext builder. Produce a discoverable CareContext payload for this admission.',
      'Output: explanation_summary, care_context (object with referenceNumber, display, hiTypes (array of: DiagnosticReport, OPConsultation, Prescription, etc.), discoverable: true|false), include_list (per-line rationale), exclude_list (sensitive notes / unsigned drafts that must not flow).',
      'Default-exclude unsigned clinician notes. Cite which DB row drove each include/exclude decision.',
    ].join('\n'),
    userPromptPayload: {
      admission: { primary_diagnosis: adm.primary_diagnosis,
                   secondary_diagnoses: adm.secondary_diagnoses,
                   admission_date: adm.admission_date,
                   discharge_date: adm.discharge_date },
      lab_count: labs.length, prescription_count: meds.length,
    },
    contextForDefenses: { admission: adm, labs, meds },
    citations: [{ source_type: 'admission', source_id: String(adm.id),
      label: `Admission #${adm.id}`, timestamp: adm.admission_date }],
    metadata: { admission_id: admId, lab_count: labs.length, med_count: meds.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 3. Health record reconciliation
// ---------------------------------------------------------------------------
export async function generateHealthRecordReconciliation({
  tenantId = null, recordA, recordB,
  patientUid = null,
  generatedBy = null, req = null,
} = {}) {
  if (!recordA || typeof recordA !== 'object') throw AppError.badRequest('record_a must be an object');
  if (!recordB || typeof recordB !== 'object') throw AppError.badRequest('record_b must be an object');

  return runExplainerPipeline({
    moduleKey: 'health_record_reconciliation',
    tenantId,
    patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null, admissionId: null,
    systemPrompt: [
      'You are a health-record reconciliation assistant. Compare two records of the same patient and surface conflicts.',
      'Output: explanation_summary, identity_match: high|medium|low|conflict, conflicts (array of { field, value_a, value_b, severity, recommended_resolution }), agreed_fields (array).',
      'Be conservative: identity_match=conflict any time DOB / sex / name diverge.',
      'NEVER auto-merge. Surface conflicts; clinician decides.',
    ].join('\n'),
    userPromptPayload: { record_a: recordA, record_b: recordB },
    contextForDefenses: { record_a: recordA, record_b: recordB },
    citations: [
      { source_type: 'record_a', source_id: shortHash(recordA), label: 'Record A', timestamp: null },
      { source_type: 'record_b', source_id: shortHash(recordB), label: 'Record B', timestamp: null },
    ],
    metadata: { },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 4. Document patient matching
// ---------------------------------------------------------------------------
export async function generateDocumentPatientMatching({
  tenantId = null, documentText, candidatePatients = null,
  generatedBy = null, req = null,
} = {}) {
  const docText = requireText(documentText, 'document_text', { min: 30, max: 24_000 });

  // If candidatePatients not supplied, attempt a best-effort lookup using
  // common identifiers found in the text (phone, name).
  let candidates = Array.isArray(candidatePatients) ? candidatePatients.slice(0, 25) : [];
  if (!candidates.length) {
    const phoneMatches = (docText.match(/\b\d{10}\b/g) || []).slice(0, 3);
    if (phoneMatches.length) {
      const rows = await safeQuery(
        `SELECT uid, name, phone, registered_at FROM users WHERE phone = ANY($1::text[])
         LIMIT 10`, [phoneMatches],
      );
      candidates = rows.map((r) => ({ uid: r.uid, name: r.name, phone: r.phone,
        registered_at: r.registered_at }));
    }
  }

  return runExplainerPipeline({
    moduleKey: 'document_patient_matching',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are a medical-records patient-matching assistant. Suggest which patient (if any) is the subject of the supplied document.',
      'Output: explanation_summary, candidates (array of { patient_uid, confidence: 0..1, matching_signals (array), conflicting_signals (array) }), recommended_action: link|review|reject.',
      'NEVER auto-link. Flag any DOB / name / sex conflict between document and candidate.',
      'If candidates is empty or all confidence < 0.7, recommend manual review.',
    ].join('\n'),
    userPromptPayload: { document_text: docText.slice(0, 8000), candidates },
    contextForDefenses: { document_text: docText, candidates },
    citations: [{ source_type: 'document_text', source_id: shortHash(docText),
      label: `Document (${docText.length} chars)`, timestamp: null }],
    metadata: { doc_chars: docText.length, candidate_count: candidates.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 5. Medical record bundle generator
// ---------------------------------------------------------------------------
export async function generateMedicalRecordBundle({
  tenantId = null, admissionId, scope = 'insurance',
  generatedBy = null, req = null,
} = {}) {
  if (!BUNDLE_SCOPES.includes(scope)) {
    throw AppError.badRequest(`scope must be one of: ${BUNDLE_SCOPES.join(', ')}`);
  }
  const admId = normalizeId(admissionId, 'admission_id');
  const adm = (await safeQuery(
    `SELECT id, patient_uid, admission_date, discharge_date, primary_diagnosis,
            secondary_diagnoses, discharge_summary, total_charges
     FROM admissions WHERE id = $1 LIMIT 1`, [admId],
  ))[0];
  if (!adm) throw AppError.notFound('Admission not found');

  const investigations = await safeQuery(
    `SELECT id, test_name, completed_at FROM investigations
     WHERE patient_uid = $1::uuid AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 25`, [adm.patient_uid],
  );
  const meds = await safeQuery(
    `SELECT id, medication_name FROM prescriptions WHERE patient_uid = $1::uuid
     ORDER BY prescribed_at DESC LIMIT 25`, [adm.patient_uid],
  );

  return runExplainerPipeline({
    moduleKey: 'medical_record_bundle_generator',
    tenantId, patientUid: adm.patient_uid, admissionId: admId,
    systemPrompt: [
      `You are a medical-records bundle assembler for the ${scope} use case.`,
      'Output: explanation_summary, included (array of { kind, source_id, why }), excluded (array of { kind, source_id, why }), regulatory_flags.',
      'Bundle scope rules:',
      '  insurance — clinical justification + costs; exclude unrelated chronic-care notes',
      '  referral — clinical narrative + key labs; exclude billing detail',
      '  abdm — comply with HIE consent scope; default-exclude unsigned notes',
      '  medico_legal — preserve verbatim alleged history + examination spans; do NOT summarise',
      'Cite each include/exclude with the DB row that drove the decision.',
    ].join('\n'),
    userPromptPayload: {
      scope,
      admission: { primary_diagnosis: adm.primary_diagnosis,
                   secondary_diagnoses: adm.secondary_diagnoses,
                   discharge_summary: adm.discharge_summary,
                   admission_date: adm.admission_date,
                   discharge_date: adm.discharge_date },
      investigation_count: investigations.length, medication_count: meds.length,
    },
    contextForDefenses: { admission: adm, investigations, meds, scope },
    citations: [{ source_type: 'admission', source_id: String(adm.id),
      label: `Admission #${adm.id}`, timestamp: adm.admission_date }],
    metadata: { admission_id: admId, scope,
      investigation_count: investigations.length, med_count: meds.length },
    generatedBy, req,
  });
}

export const __testing__ = { FHIR_RESOURCE_TYPES, BUNDLE_SCOPES, shortHash };

export default {
  generateFhirValidation,
  generateAbdmCareContext,
  generateHealthRecordReconciliation,
  generateDocumentPatientMatching,
  generateMedicalRecordBundle,
};
