// src/services/nhcx/nhcxFhirProfileService.js
//
// NHCX/NRCeS profile seam. The profile URLs and version below are design
// targets from the NL-2 design spec and must be re-verified against live NHCX
// docs when operators lock the sandbox/OpenAPI/certificate version.

import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { toFhirPatient } from '../fhir/fhirAdapter.js';
import { validateBundle } from '../fhir/fhirValidator.js';
import { AppError } from '../../utils/AppError.js';

export const NRCES_NHCX_PROFILE_VERSION = '7.0.0-design-target';
export const NHCX_PROFILE_URLS = Object.freeze({
  coverageEligibilityRequestBundle:
    'https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/CoverageEligibilityRequestBundle',
  preauthClaimRequestBundle:
    'https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimBundle',
  claimRequestBundle:
    'https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimBundle',
  taskBundle:
    'https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/TaskBundle',
});

const REQUIRED_BY_TYPE = {
  Bundle: ['id', 'type', 'entry'],
  CoverageEligibilityRequest: ['id', 'status', 'purpose', 'patient', 'created', 'insurer', 'insurance'],
  Claim: ['id', 'status', 'type', 'use', 'patient', 'created', 'provider', 'insurer', 'insurance', 'item'],
  ClaimResponse: ['id', 'status', 'outcome'],
  Coverage: ['id', 'status', 'beneficiary', 'payor', 'identifier'],
  DocumentReference: ['id', 'status', 'type', 'content'],
  Organization: ['id', 'identifier', 'name'],
  Encounter: ['id', 'status', 'class', 'subject'],
  Task: ['id', 'status', 'intent', 'code', 'for', 'authoredOn'],
};

function clean(value) {
  return String(value ?? '').trim();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function payloadHash(payload) {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function hashText(...parts) {
  return crypto.createHash('sha256').update(parts.map((part) => clean(part)).join('|')).digest();
}

function stableUuid(...parts) {
  const bytes = Buffer.from(hashText(...parts).subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableId(prefix, ...parts) {
  return `${prefix}-${payloadHash(parts).slice(0, 24)}`;
}

function instantFrom(snapshotTime) {
  const d = snapshotTime ? new Date(snapshotTime) : new Date(0);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function money(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function ref(resource) {
  return `${resource.resourceType}/${resource.id}`;
}

function fullUrl(resource) {
  return `urn:uuid:${stableUuid(resource.resourceType, resource.id)}`;
}

function entry(resource) {
  return { fullUrl: fullUrl(resource), resource };
}

function participantIdentifier(code) {
  return {
    system: 'https://hcxprotocol.io/participant-code',
    value: clean(code) || 'operator-version-lock-required',
  };
}

function ensurePresent(resource, path, issues) {
  const required = REQUIRED_BY_TYPE[resource?.resourceType] || [];
  for (const field of required) {
    const value = resource[field];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      issues.push({
        severity: 'error',
        code: 'required',
        path: `${path}.${field}`,
        message: `${resource.resourceType}.${field} is required for NHCX outbound profile`,
      });
    }
  }
}

function validateRequiredResources(bundle, expectedMainResourceType, { expectedClaimUse = null } = {}) {
  const issues = [];
  if (!bundle || bundle.resourceType !== 'Bundle') {
    return [{ severity: 'error', code: 'structure', path: 'Bundle', message: 'NHCX payload must be a FHIR Bundle' }];
  }
  ensurePresent(bundle, 'Bundle', issues);
  if (!bundle.meta?.profile?.length) {
    issues.push({ severity: 'error', code: 'required', path: 'Bundle.meta.profile', message: 'Bundle.meta.profile is required' });
  }
  const resources = (bundle.entry || []).map((item) => item.resource).filter(Boolean);
  const main = resources.find((resource) => resource.resourceType === expectedMainResourceType);
  if (!main) {
    issues.push({
      severity: 'error',
      code: 'required',
      path: 'Bundle.entry',
      message: `Bundle must contain ${expectedMainResourceType}`,
    });
  }
  for (const resource of resources) {
    ensurePresent(resource, resource.resourceType, issues);
    if (resource.resourceType === 'Claim' && expectedClaimUse && resource.use !== expectedClaimUse) {
      issues.push({
        severity: 'error',
        code: 'code-invalid',
        path: 'Claim.use',
        message: `NHCX Claim Request must use Claim.use=${expectedClaimUse}`,
      });
    }
  }
  return issues;
}

export function validateNHCXOutboundBundle(bundle, { expectedMainResourceType, expectedClaimUse = null } = {}) {
  const generic = validateBundle(bundle);
  const claimUse = expectedClaimUse ?? (expectedMainResourceType === 'Claim' ? 'preauthorization' : null);
  const issues = [
    ...(generic.issues || []),
    ...validateRequiredResources(bundle, expectedMainResourceType, { expectedClaimUse: claimUse }),
  ];
  const valid = issues.length === 0;
  return { valid, issues, entryCount: generic.entryCount || 0 };
}

export function assertNHCXOutboundBundle(bundle, options = {}) {
  const result = validateNHCXOutboundBundle(bundle, options);
  if (!result.valid) {
    throw AppError.badRequest('Invalid NHCX outbound FHIR bundle', 'NHCX_FHIR_PROFILE_INVALID', {
      issues: result.issues,
    });
  }
  return result;
}

export function validateNHCXInboundBundle(bundle, { expectedMainResourceType } = {}) {
  const result = validateNHCXOutboundBundle(bundle, { expectedMainResourceType });
  const issues = result.issues.map((issue) => ({
    ...issue,
    severity: issue.severity === 'error' ? 'warning' : issue.severity,
  }));
  return {
    valid: issues.every((issue) => issue.severity !== 'error'),
    issues,
    entryCount: result.entryCount,
  };
}

async function fetchEligibilitySnapshot({ tenantId, policyId, admissionId = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id AS policy_id,
            p.policy_number,
            p.insurer_name,
            p.tpa_name AS policy_tpa_name,
            p.member_id,
            p.group_number,
            p.policy_type,
            p.valid_from,
            p.valid_to,
            p.status AS policy_status,
            p.updated_at AS policy_updated_at,
            p.patient_uid::text AS patient_uid,
            p.tenant_id::text AS tenant_id,
            payer.display_name AS payer_name,
            payer.payer_code,
            tpa.display_name AS tpa_name,
            tpa.tpa_code,
            u.uid::text AS uid,
            u.id AS patient_id,
            u.name,
            u.phone,
            u.email,
            u.gender,
            u.birthday,
            u.address,
            a.id AS admission_id,
            a.status AS admission_status,
            a.admitted_at,
            a.room_category
       FROM insurance_policies p
       JOIN users u ON u.uid = p.patient_uid AND u.tenant_id = p.tenant_id
       LEFT JOIN payers payer ON payer.id = p.payer_id
       LEFT JOIN tpas tpa ON tpa.id = p.tpa_id
       LEFT JOIN admissions a ON a.id = $3::int AND a.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1::uuid
        AND p.id = $2::int
      LIMIT 1`,
    tenantId,
    Number(policyId),
    admissionId ? Number(admissionId) : null,
  );
  if (!rows[0]) throw AppError.notFound('Insurance policy not found', 'NHCX_POLICY_NOT_FOUND');
  return rows[0];
}

async function fetchPreauthSnapshot({ tenantId, preauthId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT pre.*,
            pre.id AS preauth_id,
            pre.tenant_id::text AS tenant_id,
            pre.patient_uid::text AS patient_uid,
            pre.updated_at AS preauth_updated_at,
            p.policy_number,
            p.member_id,
            p.group_number,
            p.insurer_name,
            p.policy_type,
            p.valid_from,
            p.valid_to,
            payer.display_name AS payer_name,
            payer.payer_code,
            tpa.display_name AS tpa_name,
            tpa.tpa_code,
            u.uid::text AS uid,
            u.id AS patient_id,
            u.name,
            u.phone,
            u.email,
            u.gender,
            u.birthday,
            u.address,
            a.status AS admission_status,
            a.admitted_at,
            a.room_category
       FROM insurance_preauth pre
       JOIN insurance_policies p ON p.id = pre.policy_id AND p.tenant_id = pre.tenant_id
       JOIN users u ON u.uid = pre.patient_uid AND u.tenant_id = pre.tenant_id
       LEFT JOIN payers payer ON payer.id = p.payer_id
       LEFT JOIN tpas tpa ON tpa.id = p.tpa_id
       LEFT JOIN admissions a ON a.id = pre.admission_id AND a.tenant_id = pre.tenant_id
      WHERE pre.tenant_id = $1::uuid
        AND pre.id = $2::int
      LIMIT 1`,
    tenantId,
    Number(preauthId),
  );
  if (!rows[0]) throw AppError.notFound('Pre-auth not found', 'NHCX_PREAUTH_NOT_FOUND');
  return rows[0];
}

async function fetchClaimSnapshot({ tenantId, claimId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.id AS claim_id,
            c.claim_number,
            c.policy_id,
            c.preauth_id,
            c.invoice_id,
            c.patient_uid::text AS patient_uid,
            c.admission_id,
            c.claim_type,
            c.status AS claim_status,
            c.total_billed,
            c.patient_copay,
            c.non_payable_amount,
            c.claimed_amount,
            c.approved_amount,
            c.disallowed_amount,
            c.denial_reason,
            c.submitted_at,
            c.submission_channel,
            c.notes AS claim_notes,
            c.tenant_id::text AS tenant_id,
            c.created_at AS claim_created_at,
            c.updated_at AS claim_updated_at,
            c.stage,
            c.parent_claim_id,
            p.policy_number,
            p.member_id,
            p.group_number,
            p.insurer_name,
            p.policy_type,
            p.status AS policy_status,
            p.valid_from,
            p.valid_to,
            payer.display_name AS payer_name,
            payer.payer_code,
            tpa.display_name AS tpa_name,
            tpa.tpa_code,
            u.uid::text AS uid,
            u.id AS patient_id,
            u.name,
            u.phone,
            u.email,
            u.gender,
            u.birthday,
            u.address,
            a.status AS admission_status,
            a.admitted_at,
            a.room_category
       FROM tpa_claims c
       JOIN insurance_policies p ON p.id = c.policy_id AND p.tenant_id = c.tenant_id
       JOIN users u ON u.uid = c.patient_uid AND u.tenant_id = c.tenant_id
       LEFT JOIN payers payer ON payer.id = p.payer_id
       LEFT JOIN tpas tpa ON tpa.id = p.tpa_id
       LEFT JOIN admissions a ON a.id = c.admission_id AND a.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1::uuid
        AND c.id = $2::int
      LIMIT 1`,
    tenantId,
    Number(claimId),
  );
  if (!rows[0]) throw AppError.notFound('TPA claim not found', 'NHCX_TPA_CLAIM_NOT_FOUND');
  return rows[0];
}

async function fetchClaimDocuments({ claimId, documentIds = null }) {
  const ids = Array.isArray(documentIds)
    ? documentIds.map((id) => Number.parseInt(id, 10)).filter((id) => Number.isFinite(id) && id > 0)
    : [];
  const idFilter = ids.length
    ? ` AND id IN (${ids.map((_, index) => `$${index + 2}::int`).join(', ')})`
    : '';
  return prisma.$queryRawUnsafe(
    `SELECT id, claim_id, doc_type, file_name, file_size_bytes, mime_type,
            uploaded_at, notes
       FROM tpa_claim_documents
      WHERE claim_id = $1::int${idFilter}
      ORDER BY uploaded_at DESC, id DESC`,
    Number(claimId),
    ...ids,
  );
}

function organization({ id, name, participantCode }) {
  return {
    resourceType: 'Organization',
    id,
    identifier: [participantIdentifier(participantCode || id)],
    name: name || participantCode || id,
  };
}

function patientFromSnapshot(row) {
  return {
    ...toFhirPatient({
      uid: row.uid || row.patient_uid,
      id: row.patient_id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      gender: row.gender,
      birthday: row.birthday,
      address: row.address,
    }),
    id: String(row.patient_uid),
  };
}

function encounterFromSnapshot(row) {
  if (!row.admission_id) return null;
  return {
    resourceType: 'Encounter',
    id: `admission-${row.admission_id}`,
    status: row.admission_status === 'discharged' ? 'finished' : 'in-progress',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: 'IMP',
      display: 'inpatient encounter',
    },
    subject: { reference: `Patient/${row.patient_uid}` },
    period: row.admitted_at ? { start: instantFrom(row.admitted_at) } : undefined,
    serviceType: row.room_category
      ? { text: `Room category: ${row.room_category}` }
      : undefined,
  };
}

function coverageFromPolicy(row, patient) {
  const payorDisplay = row.payer_name || row.insurer_name || row.tpa_name || row.policy_tpa_name || 'NHCX payor';
  return {
    resourceType: 'Coverage',
    id: `policy-${row.policy_id}`,
    status: row.policy_status === 'expired' ? 'cancelled' : 'active',
    identifier: [
      { system: 'urn:vhhealth:insurance-policy-number', value: clean(row.policy_number) },
      ...(row.member_id ? [{ system: 'urn:vhhealth:insurance-member-id', value: clean(row.member_id) }] : []),
      ...(row.group_number ? [{ system: 'urn:vhhealth:insurance-group-number', value: clean(row.group_number) }] : []),
    ],
    type: row.policy_type ? { text: row.policy_type } : undefined,
    beneficiary: { reference: ref(patient) },
    payor: [{ display: payorDisplay }],
    period: {
      ...(row.valid_from ? { start: String(row.valid_from).slice(0, 10) } : {}),
      ...(row.valid_to ? { end: String(row.valid_to).slice(0, 10) } : {}),
    },
  };
}

function documentReferenceFromRow(row, patient, encounter) {
  return {
    resourceType: 'DocumentReference',
    id: `claim-document-${row.id}`,
    status: 'current',
    type: {
      coding: [{ system: 'urn:vhhealth:tpa-claim-document-type', code: clean(row.doc_type) || 'other' }],
      text: row.doc_type || 'supporting document',
    },
    subject: { reference: ref(patient) },
    context: encounter ? { encounter: [{ reference: ref(encounter) }] } : undefined,
    date: instantFrom(row.uploaded_at),
    description: row.notes || row.file_name || null,
    content: [{
      attachment: {
        contentType: row.mime_type || 'application/octet-stream',
        title: row.file_name || `claim-document-${row.id}`,
        size: row.file_size_bytes ? Number(row.file_size_bytes) : undefined,
        url: `urn:vhhealth:tpa-claim-document:${row.id}`,
      },
    }],
  };
}

function bundle({ id, profileUrl, mainResourceType, resources, timestamp }) {
  return {
    resourceType: 'Bundle',
    id,
    meta: {
      profile: [profileUrl],
      versionId: NRCES_NHCX_PROFILE_VERSION,
    },
    type: 'collection',
    timestamp: instantFrom(timestamp),
    entry: resources.filter(Boolean).map(entry),
    extension: [
      {
        url: 'https://vhhealth.app/fhir/StructureDefinition/nhcx-main-resource',
        valueCode: mainResourceType,
      },
    ],
  };
}

export async function buildCoverageEligibilityRequestBundle({
  tenantId,
  policyId,
  admissionId = null,
  participantCodeSelf,
  participantCodeCounterparty,
}) {
  const row = await fetchEligibilitySnapshot({ tenantId, policyId, admissionId });
  const patient = patientFromSnapshot(row);
  const encounter = encounterFromSnapshot(row);
  const provider = organization({
    id: 'vhhealth-provider',
    name: 'VH Health',
    participantCode: participantCodeSelf,
  });
  const insurer = organization({
    id: stableId('payor', participantCodeCounterparty || row.payer_code || row.tpa_code || row.payer_name),
    name: row.payer_name || row.tpa_name || row.insurer_name || 'NHCX counterparty',
    participantCode: participantCodeCounterparty || row.payer_code || row.tpa_code,
  });
  const coverage = coverageFromPolicy(row, patient);
  const request = {
    resourceType: 'CoverageEligibilityRequest',
    id: stableId('eligibility', tenantId, policyId, admissionId || ''),
    status: 'active',
    purpose: ['benefits', 'validation'],
    patient: { reference: ref(patient) },
    created: instantFrom(row.policy_updated_at),
    enterer: { identifier: participantIdentifier(participantCodeSelf) },
    provider: { reference: ref(provider) },
    insurer: { reference: ref(insurer) },
    facility: encounter ? { reference: ref(encounter) } : undefined,
    insurance: [{ focal: true, coverage: { reference: ref(coverage) } }],
  };
  const out = bundle({
    id: stableId('nhcx-eligibility-bundle', tenantId, policyId, admissionId || ''),
    profileUrl: NHCX_PROFILE_URLS.coverageEligibilityRequestBundle,
    mainResourceType: 'CoverageEligibilityRequest',
    resources: [patient, encounter, provider, insurer, coverage, request],
    timestamp: row.policy_updated_at,
  });
  assertNHCXOutboundBundle(out, { expectedMainResourceType: 'CoverageEligibilityRequest' });
  return {
    bundle: out,
    payloadHash: payloadHash(out),
    profileUrl: NHCX_PROFILE_URLS.coverageEligibilityRequestBundle,
    profileVersion: NRCES_NHCX_PROFILE_VERSION,
    domainResourceType: 'CoverageEligibilityRequest',
    patientUid: row.patient_uid,
    admissionId: row.admission_id || null,
    policyId: row.policy_id,
  };
}

function diagnosisItems(row) {
  const codes = Array.isArray(row.icd10_codes) ? row.icd10_codes.filter(Boolean) : [];
  if (!codes.length) {
    return [{
      sequence: 1,
      diagnosisCodeableConcept: { text: row.primary_diagnosis },
    }];
  }
  return codes.map((code, index) => ({
    sequence: index + 1,
    diagnosisCodeableConcept: {
      coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code }],
      text: index === 0 ? row.primary_diagnosis : undefined,
    },
  }));
}

function procedureItems(row) {
  const codes = Array.isArray(row.procedure_codes) ? row.procedure_codes.filter(Boolean) : [];
  if (!codes.length && !row.proposed_procedure) return undefined;
  if (!codes.length) {
    return [{
      sequence: 1,
      procedureCodeableConcept: { text: row.proposed_procedure },
    }];
  }
  return codes.map((code, index) => ({
    sequence: index + 1,
    procedureCodeableConcept: {
      coding: [{ system: 'urn:vhhealth:procedure-code', code }],
      text: index === 0 ? row.proposed_procedure : undefined,
    },
  }));
}

function claimRequestResourceFromSnapshot({
  row,
  patient,
  provider,
  insurer,
  coverage,
  encounter,
  documentReferences = [],
}) {
  return {
    resourceType: 'Claim',
    id: `claim-${row.claim_id}`,
    identifier: [
      { system: 'urn:vhhealth:tpa-claim-id', value: String(row.claim_id) },
      ...(row.claim_number ? [{ system: 'urn:vhhealth:tpa-claim-number', value: row.claim_number }] : []),
    ],
    status: 'active',
    type: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }],
      text: row.claim_type || 'claim',
    },
    subType: row.stage ? { text: row.stage } : undefined,
    use: 'claim',
    patient: { reference: ref(patient) },
    created: instantFrom(row.claim_updated_at || row.claim_created_at),
    provider: { reference: ref(provider) },
    insurer: { reference: ref(insurer) },
    priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: 'normal' }] },
    related: row.parent_claim_id
      ? [{ claim: { identifier: { system: 'urn:vhhealth:tpa-claim-id', value: String(row.parent_claim_id) } } }]
      : undefined,
    insurance: [{
      sequence: 1,
      focal: true,
      coverage: { reference: ref(coverage) },
    }],
    item: [{
      sequence: 1,
      productOrService: {
        coding: [{ system: 'urn:vhhealth:tpa-claim-kind', code: row.claim_type || 'cashless' }],
        text: `${row.stage || 'final'} ${row.claim_type || 'cashless'} claim`,
      },
      unitPrice: { value: money(row.claimed_amount), currency: 'INR' },
      net: { value: money(row.claimed_amount), currency: 'INR' },
    }],
    supportingInfo: [
      ...(row.admission_id && encounter
        ? [{
          sequence: 1,
          category: { text: 'admission' },
          valueReference: { reference: ref(encounter) },
        }]
        : []),
      {
        sequence: 2,
        category: { text: 'x-hcx-workflow_id' },
        valueString: row.admission_id ? String(row.admission_id) : `claim-${row.claim_id}`,
      },
      ...documentReferences.map((documentReference, index) => ({
        sequence: index + 3,
        category: { text: 'supporting-document' },
        valueReference: { reference: ref(documentReference) },
      })),
    ],
    total: { value: money(row.claimed_amount), currency: 'INR' },
  };
}

function buildClaimResources({ row, participantCodeSelf, participantCodeCounterparty, documents = [] }) {
  const patient = patientFromSnapshot(row);
  const encounter = encounterFromSnapshot(row);
  const provider = organization({
    id: 'vhhealth-provider',
    name: 'VH Health',
    participantCode: participantCodeSelf,
  });
  const insurer = organization({
    id: stableId('payor', participantCodeCounterparty || row.payer_code || row.tpa_code || row.payer_name),
    name: row.payer_name || row.tpa_name || row.insurer_name || 'NHCX counterparty',
    participantCode: participantCodeCounterparty || row.payer_code || row.tpa_code,
  });
  const coverage = coverageFromPolicy(row, patient);
  const documentReferences = documents.map((document) => documentReferenceFromRow(document, patient, encounter));
  const claim = claimRequestResourceFromSnapshot({
    row,
    patient,
    provider,
    insurer,
    coverage,
    encounter,
    documentReferences,
  });
  return {
    patient,
    encounter,
    provider,
    insurer,
    coverage,
    documentReferences,
    claim,
  };
}

export async function buildPreauthClaimRequestBundle({
  tenantId,
  preauthId,
  participantCodeSelf,
  participantCodeCounterparty,
}) {
  const row = await fetchPreauthSnapshot({ tenantId, preauthId });
  const patient = patientFromSnapshot(row);
  const encounter = encounterFromSnapshot(row);
  const provider = organization({
    id: 'vhhealth-provider',
    name: 'VH Health',
    participantCode: participantCodeSelf,
  });
  const insurer = organization({
    id: stableId('payor', participantCodeCounterparty || row.payer_code || row.tpa_code || row.payer_name),
    name: row.payer_name || row.tpa_name || row.insurer_name || 'NHCX counterparty',
    participantCode: participantCodeCounterparty || row.payer_code || row.tpa_code,
  });
  const coverage = coverageFromPolicy(row, patient);
  const claim = {
    resourceType: 'Claim',
    id: `preauth-${row.preauth_id}`,
    identifier: [
      { system: 'urn:vhhealth:insurance-preauth-id', value: String(row.preauth_id) },
      { system: 'urn:vhhealth:insurance-preauth-number', value: row.preauth_number },
    ],
    status: 'active',
    type: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }],
      text: row.request_type || 'preauthorization',
    },
    use: 'preauthorization',
    patient: { reference: ref(patient) },
    created: instantFrom(row.preauth_updated_at),
    provider: { reference: ref(provider) },
    insurer: { reference: ref(insurer) },
    priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: 'normal' }] },
    related: row.parent_preauth_id
      ? [{ claim: { identifier: { system: 'urn:vhhealth:insurance-preauth-id', value: String(row.parent_preauth_id) } } }]
      : undefined,
    diagnosis: diagnosisItems(row),
    procedure: procedureItems(row),
    insurance: [{
      sequence: 1,
      focal: true,
      coverage: { reference: ref(coverage) },
    }],
    item: [{
      sequence: 1,
      productOrService: {
        coding: row.procedure_codes?.[0]
          ? [{ system: 'urn:vhhealth:procedure-code', code: row.procedure_codes[0] }]
          : undefined,
        text: row.proposed_procedure || row.primary_diagnosis,
      },
      unitPrice: { value: money(row.expected_cost), currency: 'INR' },
      net: { value: money(row.expected_cost), currency: 'INR' },
    }],
    total: { value: money(row.expected_cost), currency: 'INR' },
    supportingInfo: [
      ...(row.admission_id
        ? [{
          sequence: 1,
          category: { text: 'admission' },
          valueReference: { reference: ref(encounter) },
        }]
        : []),
      {
        sequence: 2,
        category: { text: 'x-hcx-workflow_id' },
        valueString: row.admission_id ? String(row.admission_id) : `preauth-${row.preauth_id}`,
      },
    ],
  };
  const out = bundle({
    id: stableId('nhcx-preauth-bundle', tenantId, preauthId),
    profileUrl: NHCX_PROFILE_URLS.preauthClaimRequestBundle,
    mainResourceType: 'Claim',
    resources: [patient, encounter, provider, insurer, coverage, claim],
    timestamp: row.preauth_updated_at,
  });
  assertNHCXOutboundBundle(out, { expectedMainResourceType: 'Claim' });
  return {
    bundle: out,
    payloadHash: payloadHash(out),
    profileUrl: NHCX_PROFILE_URLS.preauthClaimRequestBundle,
    profileVersion: NRCES_NHCX_PROFILE_VERSION,
    domainResourceType: 'Claim',
    patientUid: row.patient_uid,
    admissionId: row.admission_id || null,
    policyId: row.policy_id,
    preauthId: row.preauth_id,
    workflowId: row.admission_id ? String(row.admission_id) : `preauth-${row.preauth_id}`,
  };
}

export async function buildClaimRequestBundle({
  tenantId,
  claimId,
  documentIds = null,
  participantCodeSelf,
  participantCodeCounterparty,
}) {
  const row = await fetchClaimSnapshot({ tenantId, claimId });
  const documents = await fetchClaimDocuments({ claimId: row.claim_id, documentIds });
  const built = buildClaimResources({
    row,
    participantCodeSelf,
    participantCodeCounterparty,
    documents,
  });
  const out = bundle({
    id: stableId('nhcx-claim-bundle', tenantId, claimId, documents.map((doc) => doc.id).join(',')),
    profileUrl: NHCX_PROFILE_URLS.claimRequestBundle,
    mainResourceType: 'Claim',
    resources: [
      built.patient,
      built.encounter,
      built.provider,
      built.insurer,
      built.coverage,
      ...built.documentReferences,
      built.claim,
    ],
    timestamp: row.claim_updated_at,
  });
  assertNHCXOutboundBundle(out, { expectedMainResourceType: 'Claim', expectedClaimUse: 'claim' });
  return {
    bundle: out,
    payloadHash: payloadHash(out),
    profileUrl: NHCX_PROFILE_URLS.claimRequestBundle,
    profileVersion: NRCES_NHCX_PROFILE_VERSION,
    domainResourceType: 'Claim',
    patientUid: row.patient_uid,
    admissionId: row.admission_id || null,
    policyId: row.policy_id,
    preauthId: row.preauth_id || null,
    claimId: row.claim_id,
    workflowId: row.admission_id ? String(row.admission_id) : `claim-${row.claim_id}`,
    documentIds: documents.map((doc) => Number(doc.id)),
  };
}

export async function buildClaimStatusTaskBundle({
  tenantId,
  claimId,
  participantCodeSelf,
  participantCodeCounterparty,
}) {
  const row = await fetchClaimSnapshot({ tenantId, claimId });
  const built = buildClaimResources({
    row,
    participantCodeSelf,
    participantCodeCounterparty,
    documents: [],
  });
  const task = {
    resourceType: 'Task',
    id: `claim-status-${row.claim_id}`,
    status: 'requested',
    intent: 'order',
    code: {
      coding: [{ system: 'https://hcxprotocol.io/task-code', code: 'status-check' }],
      text: 'NHCX claim status check',
    },
    for: { reference: ref(built.patient) },
    focus: { reference: ref(built.claim) },
    authoredOn: instantFrom(row.claim_updated_at),
    requester: { reference: ref(built.provider) },
    owner: { reference: ref(built.insurer) },
    input: [{
      type: { text: 'x-hcx-workflow_id' },
      valueString: row.admission_id ? String(row.admission_id) : `claim-${row.claim_id}`,
    }],
  };
  const out = bundle({
    id: stableId('nhcx-claim-status-task-bundle', tenantId, claimId),
    profileUrl: NHCX_PROFILE_URLS.taskBundle,
    mainResourceType: 'Task',
    resources: [
      built.patient,
      built.encounter,
      built.provider,
      built.insurer,
      built.coverage,
      built.claim,
      task,
    ],
    timestamp: row.claim_updated_at,
  });
  assertNHCXOutboundBundle(out, { expectedMainResourceType: 'Task', expectedClaimUse: 'claim' });
  return {
    bundle: out,
    payloadHash: payloadHash(out),
    profileUrl: NHCX_PROFILE_URLS.taskBundle,
    profileVersion: NRCES_NHCX_PROFILE_VERSION,
    domainResourceType: 'Task',
    patientUid: row.patient_uid,
    admissionId: row.admission_id || null,
    policyId: row.policy_id,
    preauthId: row.preauth_id || null,
    claimId: row.claim_id,
    workflowId: row.admission_id ? String(row.admission_id) : `claim-${row.claim_id}`,
  };
}

export async function persistOutboundNHCXEnvelope({
  tenantId,
  environment,
  cycle,
  endpoint,
  participantCodeSelf,
  participantCodeCounterparty,
  hcxApiCallId,
  hcxCorrelationId,
  hcxWorkflowId = null,
  claimId = null,
  preauthId = null,
  policyId = null,
  patientUid = null,
  admissionId = null,
  domainResourceType,
  profileUrl,
  profileVersion,
  bundle,
}) {
  const expectedMainResourceType = domainResourceType === 'CoverageEligibilityRequest'
    ? 'CoverageEligibilityRequest'
    : domainResourceType;
  const expectedClaimUse = domainResourceType === 'Claim' && cycle === 'claim' ? 'claim' : null;
  assertNHCXOutboundBundle(bundle, { expectedMainResourceType, expectedClaimUse });
  const hash = payloadHash(bundle);
  const protectedHeaders = {
    'x-hcx-api_call_id': hcxApiCallId,
    'x-hcx-correlation_id': hcxCorrelationId,
    'x-hcx-workflow_id': hcxWorkflowId,
    sender_code: participantCodeSelf,
    recipient_code: participantCodeCounterparty,
  };
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO nhcx_messages
       (tenant_id, environment, direction, cycle, endpoint,
        participant_code_self, participant_code_counterparty,
        hcx_api_call_id, hcx_correlation_id, hcx_workflow_id,
        claim_id, preauth_id, policy_id, patient_uid, admission_id,
        domain_resource_type, profile_url, profile_version, payload_hash,
        protected_headers, signature_verified, status, created_at, updated_at)
     VALUES ($1::uuid, $2, 'outbound', $3, $4,
             $5, $6,
             $7, $8, $9,
             $10::int, $11::int, $12::int, $13::uuid, $14::int,
             $15, $16, $17, $18,
             $19::jsonb, false, 'pending', NOW(), NOW())
     ON CONFLICT (tenant_id, hcx_api_call_id, environment) DO UPDATE SET
       updated_at = nhcx_messages.updated_at
     RETURNING *`,
    tenantId,
    environment,
    cycle,
    endpoint,
    participantCodeSelf,
    participantCodeCounterparty || null,
    hcxApiCallId || null,
    hcxCorrelationId || null,
    hcxWorkflowId || null,
    claimId ? Number(claimId) : null,
    preauthId ? Number(preauthId) : null,
    policyId ? Number(policyId) : null,
    patientUid || null,
    admissionId ? Number(admissionId) : null,
    domainResourceType,
    profileUrl,
    profileVersion,
    hash,
    JSON.stringify(protectedHeaders),
  );
  return { envelope: rows[0], payloadHash: hash };
}

export default {
  assertNHCXOutboundBundle,
  buildClaimRequestBundle,
  buildClaimStatusTaskBundle,
  buildCoverageEligibilityRequestBundle,
  buildPreauthClaimRequestBundle,
  payloadHash,
  persistOutboundNHCXEnvelope,
  validateNHCXInboundBundle,
  validateNHCXOutboundBundle,
  NHCX_PROFILE_URLS,
  NRCES_NHCX_PROFILE_VERSION,
};
