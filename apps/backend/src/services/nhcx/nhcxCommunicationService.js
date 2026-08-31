// src/services/nhcx/nhcxCommunicationService.js
//
// NL-2 P3 NHCX CommunicationRequest/Communication support.
//
// Version-lock banner: this is still a design-target, mock-first seam. Confirm
// live NHCX/NRCeS Communication payload, attachment packaging, MIME, and size
// requirements before enabling NHCX_ENABLED in any live tenant.

import crypto from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  lockPharmacyFundingAdmissionTx,
  lockPharmacyFundingAuthorityTx,
  resolvePharmacyFundingPatientUidTx,
} from '../pharmacy/pharmacyCapService.js';

const DEFAULT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_ATTACHMENT_TOTAL_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'text/plain',
];

const CLAIM_QUERY_ALLOWED_FROM = ['submitted', 'queried', 'approved', 'partially_approved'];
const PREAUTH_QUERY_ALLOWED_FROM = ['submitted', 'queried', 'approved', 'partially_approved'];

function clean(value) {
  return String(value ?? '').trim();
}

function safeText(value, max = 1_000) {
  const text = clean(value);
  return text ? text.slice(0, max) : null;
}

function positiveInt(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function parsePositiveIds(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value > 0))];
}

function envPositiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function communicationAttachmentPolicy() {
  const allowed = clean(process.env.NHCX_COMM_ATTACHMENT_ALLOWED_MIME_TYPES)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return {
    maxBytes: envPositiveInt('NHCX_COMM_ATTACHMENT_MAX_BYTES', DEFAULT_ATTACHMENT_MAX_BYTES),
    totalMaxBytes: envPositiveInt('NHCX_COMM_ATTACHMENT_TOTAL_MAX_BYTES', DEFAULT_ATTACHMENT_TOTAL_MAX_BYTES),
    allowedMimeTypes: allowed.length ? allowed : DEFAULT_ALLOWED_MIME_TYPES,
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function nhcxMetadataFromAttachments(attachments) {
  return parseJsonArray(attachments).find((item) => item && typeof item === 'object' && item.nhcx)?.nhcx || {};
}

function documentIdsFromAttachments(attachments) {
  const item = parseJsonArray(attachments).find((entry) => entry && typeof entry === 'object' && Array.isArray(entry.document_ids));
  return parsePositiveIds(item?.document_ids || []);
}

function assertSupportedAttachment({ mimeType, sizeBytes, title = null }) {
  const policy = communicationAttachmentPolicy();
  const normalizedMime = clean(mimeType).toLowerCase();
  if (normalizedMime && !policy.allowedMimeTypes.includes(normalizedMime)) {
    throw AppError.badRequest(
      `NHCX Communication attachment type ${normalizedMime} is not supported`,
      'NHCX_ATTACHMENT_TYPE_UNSUPPORTED',
      { mime_type: normalizedMime, allowed: policy.allowedMimeTypes, title },
    );
  }
  const size = Number(sizeBytes || 0);
  if (Number.isFinite(size) && size > policy.maxBytes) {
    throw AppError.badRequest(
      `NHCX Communication attachment exceeds ${policy.maxBytes} bytes`,
      'NHCX_ATTACHMENT_TOO_LARGE',
      { size_bytes: size, max_bytes: policy.maxBytes, title },
    );
  }
}

function assertCommunicationRequestAttachmentsSupported(resource) {
  for (const payload of resource?.payload || []) {
    const attachment = payload?.contentAttachment || payload?.content?.attachment || null;
    if (!attachment) continue;
    assertSupportedAttachment({
      mimeType: attachment.contentType,
      sizeBytes: attachment.size,
      title: attachment.title || attachment.url || null,
    });
  }
}

function communicationPayloadText(resource) {
  const payloadText = (resource?.payload || [])
    .map((payload) => (
      payload?.contentString
      || payload?.contentMarkdown
      || payload?.contentCodeableConcept?.text
      || payload?.contentAttachment?.title
      || payload?.contentReference?.display
    ))
    .map((value) => clean(value))
    .filter(Boolean);
  const notes = (resource?.note || [])
    .map((note) => clean(note.text))
    .filter(Boolean);
  const reasons = (resource?.reasonCode || [])
    .map((reason) => clean(reason.text || reason.coding?.[0]?.display || reason.coding?.[0]?.code))
    .filter(Boolean);
  const text = [...payloadText, ...notes, ...reasons].join('\n\n');
  return safeText(text, 10_000) || 'NHCX payor requested additional information.';
}

function communicationSubject(resource) {
  return safeText(
    resource?.reasonCode?.[0]?.text
      || resource?.category?.[0]?.text
      || resource?.topic?.text
      || resource?.code?.text
      || resource?.id
      || 'NHCX information request',
    255,
  );
}

function hcxIdsFromContext(context = {}) {
  return {
    apiCallId: safeText(context.hcxApiCallId, 120),
    correlationId: safeText(context.hcxCorrelationId, 120),
    workflowId: safeText(context.hcxWorkflowId, 120),
  };
}

function targetFromOutboundContext(outboundContext) {
  const claimId = outboundContext?.claim_id ? Number(outboundContext.claim_id) : null;
  const preauthId = outboundContext?.preauth_id ? Number(outboundContext.preauth_id) : null;
  if (claimId) return { claimId, preauthId: null };
  if (preauthId) return { claimId: null, preauthId };
  throw AppError.badRequest(
    'NHCX CommunicationRequest could not be linked by correlation ids',
    'NHCX_COMMUNICATION_CONTEXT_MISSING',
  );
}

function correspondenceAuditAttachment({
  kind,
  endpoint,
  envelope = null,
  context = {},
  inbound = null,
  documents = [],
} = {}) {
  const hcx = hcxIdsFromContext(context);
  return [{
    kind,
    document_ids: documents.map((doc) => Number(doc.id)),
    documents: documents.map((doc) => ({
      id: Number(doc.id),
      doc_type: doc.doc_type,
      file_name: doc.file_name,
      file_size_bytes: doc.file_size_bytes ? Number(doc.file_size_bytes) : null,
      mime_type: doc.mime_type || null,
    })),
    nhcx: {
      endpoint,
      api_call_id: hcx.apiCallId,
      correlation_id: hcx.correlationId,
      workflow_id: hcx.workflowId,
      message_id: envelope?.id ? String(envelope.id) : null,
      in_response_to_api_call_id: inbound?.apiCallId || null,
      in_response_to_correspondence_id: inbound?.correspondenceId || null,
      version_lock: 'NRCeS 7.0.0 design target; confirm live NHCX Communication attachment contract before enablement',
    },
  }];
}

async function fetchDocumentsByIds({ tenantId, documentIds }) {
  const ids = parsePositiveIds(documentIds);
  if (!ids.length) return [];
  const placeholders = ids.map((_, index) => `$${index + 2}::int`).join(', ');
  return prisma.$queryRawUnsafe(
    `SELECT id, claim_id, preauth_id, tenant_id::text AS tenant_id,
            doc_type, file_name, file_url, file_size_bytes, mime_type,
            uploaded_at, notes
       FROM tpa_claim_documents
      WHERE tenant_id = $1::uuid
        AND id IN (${placeholders})
      ORDER BY uploaded_at DESC, id DESC`,
    tenantId,
    ...ids,
  );
}

export async function validateCommunicationDocuments({
  tenantId,
  claimId = null,
  preauthId = null,
  documentIds = [],
} = {}) {
  const tid = requireTenantId(tenantId);
  const ids = parsePositiveIds(documentIds);
  if (!ids.length) return [];

  const docs = await fetchDocumentsByIds({ tenantId: tid, documentIds: ids });
  if (docs.length !== ids.length) {
    throw AppError.badRequest(
      'Selected NHCX communication attachments must belong to this tenant and target',
      'NHCX_ATTACHMENT_OWNERSHIP_INVALID',
    );
  }

  let totalBytes = 0;
  for (const doc of docs) {
    if (claimId && Number(doc.claim_id) !== Number(claimId)) {
      throw AppError.badRequest(
        'Selected NHCX communication attachment belongs to a different claim',
        'NHCX_ATTACHMENT_OWNERSHIP_INVALID',
        { document_id: Number(doc.id), claim_id: doc.claim_id },
      );
    }
    if (preauthId && Number(doc.preauth_id) !== Number(preauthId)) {
      throw AppError.badRequest(
        'Selected NHCX communication attachment belongs to a different preauth',
        'NHCX_ATTACHMENT_OWNERSHIP_INVALID',
        { document_id: Number(doc.id), preauth_id: doc.preauth_id },
      );
    }
    assertSupportedAttachment({
      mimeType: doc.mime_type,
      sizeBytes: doc.file_size_bytes,
      title: doc.file_name,
    });
    const size = Number(doc.file_size_bytes || 0);
    if (Number.isFinite(size) && size > 0) totalBytes += size;
  }
  const policy = communicationAttachmentPolicy();
  if (totalBytes > policy.totalMaxBytes) {
    throw AppError.badRequest(
      `NHCX Communication attachments exceed ${policy.totalMaxBytes} bytes in total`,
      'NHCX_ATTACHMENT_TOTAL_TOO_LARGE',
      { total_bytes: totalBytes, max_bytes: policy.totalMaxBytes },
    );
  }
  return docs;
}

export async function recordInboundCommunicationRequest({
  tenantId,
  bundle,
  context = {},
  outboundContext = null,
  envelope = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const resource = (bundle?.entry || []).map((entry) => entry.resource)
    .find((entry) => entry?.resourceType === 'CommunicationRequest');
  if (!resource) {
    throw AppError.badRequest(
      'NHCX communication callback must contain CommunicationRequest',
      'NHCX_COMMUNICATION_REQUEST_REQUIRED',
    );
  }
  assertCommunicationRequestAttachmentsSupported(resource);

  const { claimId, preauthId } = targetFromOutboundContext(outboundContext);
  const subject = communicationSubject(resource);
  const body = communicationPayloadText(resource);
  const attachments = correspondenceAuditAttachment({
    kind: 'nhcx_communication_request',
    endpoint: 'communication/request',
    envelope,
    context,
  });

  let inserted = null;
  await setTenantTx(tid, async (tx) => {
    if (claimId) {
      const identityRows = await tx.$queryRawUnsafe(
        `SELECT patient_uid,admission_id
           FROM tpa_claims
          WHERE tenant_id=$1::uuid AND id=$2::int`,
        tid,
        claimId,
      );
      if (!identityRows.length) throw AppError.notFound('TPA claim not found', 'NHCX_TPA_CLAIM_NOT_FOUND');
      const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
        tenantId: tid,
        patientUid: String(identityRows[0].patient_uid),
        admissionId: identityRows[0].admission_id == null
          ? null
          : Number(identityRows[0].admission_id),
      });
      await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
      if (identityRows[0].admission_id != null) {
        await lockPharmacyFundingAdmissionTx(tx, {
          tenantId: tid,
          patientUid,
          admissionId: Number(identityRows[0].admission_id),
        });
      }
      const rows = await tx.$queryRawUnsafe(
        `SELECT id,status,patient_uid,admission_id
           FROM tpa_claims
          WHERE tenant_id = $1::uuid
            AND id = $2::int
          LIMIT 1
          FOR UPDATE`,
        tid,
        claimId,
      );
      const claim = rows[0];
      if (!claim) throw AppError.notFound('TPA claim not found', 'NHCX_TPA_CLAIM_NOT_FOUND');
      if (String(claim.patient_uid) !== patientUid
          || (claim.admission_id == null ? null : Number(claim.admission_id))
            !== (identityRows[0].admission_id == null
              ? null
              : Number(identityRows[0].admission_id))) {
        throw AppError.conflict(
          'The TPA claim patient/admission changed while funding authority was acquired',
          'PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH',
        );
      }
      if (!CLAIM_QUERY_ALLOWED_FROM.includes(claim.status)) {
        throw AppError.invalidTransition(claim.status, 'queried', CLAIM_QUERY_ALLOWED_FROM);
      }
      if (claim.status !== 'queried') {
        await tx.$executeRawUnsafe(
          `UPDATE tpa_claims
              SET status = 'queried',
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND id = $2::int`,
          tid,
          claimId,
        );
      }
    } else {
      const identityRows = await tx.$queryRawUnsafe(
        `SELECT patient_uid,admission_id
           FROM insurance_preauth
          WHERE tenant_id=$1::uuid AND id=$2::int`,
        tid,
        preauthId,
      );
      if (!identityRows.length) throw AppError.notFound('Pre-auth not found', 'NHCX_PREAUTH_NOT_FOUND');
      const patientUid = await resolvePharmacyFundingPatientUidTx(tx, {
        tenantId: tid,
        patientUid: String(identityRows[0].patient_uid),
        admissionId: identityRows[0].admission_id == null
          ? null
          : Number(identityRows[0].admission_id),
      });
      await lockPharmacyFundingAuthorityTx(tx, { tenantId: tid, patientUid });
      if (identityRows[0].admission_id != null) {
        await lockPharmacyFundingAdmissionTx(tx, {
          tenantId: tid,
          patientUid,
          admissionId: Number(identityRows[0].admission_id),
        });
      }
      const rows = await tx.$queryRawUnsafe(
        `SELECT id,status,patient_uid,admission_id
           FROM insurance_preauth
          WHERE tenant_id = $1::uuid
            AND id = $2::int
          LIMIT 1
          FOR UPDATE`,
        tid,
        preauthId,
      );
      const preauth = rows[0];
      if (!preauth) throw AppError.notFound('Pre-auth not found', 'NHCX_PREAUTH_NOT_FOUND');
      if (String(preauth.patient_uid) !== patientUid
          || (preauth.admission_id == null ? null : Number(preauth.admission_id))
            !== (identityRows[0].admission_id == null
              ? null
              : Number(identityRows[0].admission_id))) {
        throw AppError.conflict(
          'The pre-auth patient/admission changed while funding authority was acquired',
          'PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH',
        );
      }
      if (!PREAUTH_QUERY_ALLOWED_FROM.includes(preauth.status)) {
        throw AppError.invalidTransition(preauth.status, 'queried', PREAUTH_QUERY_ALLOWED_FROM);
      }
      await tx.$executeRawUnsafe(
        `UPDATE insurance_preauth
            SET status = 'queried',
                query_text = COALESCE($3::text, query_text),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::int`,
        tid,
        preauthId,
        body,
      );
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO tpa_claim_correspondence
         (tenant_id, claim_id, preauth_id, direction, channel, subject, body,
          attachments, recorded_by)
       VALUES ($1::uuid, $2::int, $3::int, 'inbound', 'nhcx', $4, $5,
               $6::jsonb, NULL)
       RETURNING *`,
      tid,
      claimId,
      preauthId,
      subject,
      body,
      JSON.stringify(attachments),
    );
    inserted = rows[0] || null;
  });

  return {
    correspondence: inserted,
    claimId,
    preauthId,
    status: 'queried',
  };
}

async function loadInboundCorrespondence({ tenantId, correspondenceId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id::text AS tenant_id, claim_id, preauth_id,
            subject, body, attachments, recorded_at
       FROM tpa_claim_correspondence
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND direction = 'inbound'
        AND channel = 'nhcx'
      LIMIT 1`,
    tenantId,
    positiveInt(correspondenceId, 'correspondenceId'),
  );
  if (!rows[0]) {
    throw AppError.notFound('Inbound NHCX correspondence not found', 'NHCX_CORRESPONDENCE_NOT_FOUND');
  }
  return rows[0];
}

export async function createOutboundCommunicationResponse({
  tenantId,
  inboundCorrespondenceId,
  responseText,
  documentIds = [],
  recordedBy = null,
  hcxApiCallId = null,
  hcxCorrelationId = null,
  hcxWorkflowId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const text = safeText(responseText, 10_000);
  if (!text) {
    throw AppError.badRequest('NHCX communication response text is required', 'NHCX_COMMUNICATION_RESPONSE_TEXT_REQUIRED');
  }

  const inbound = await loadInboundCorrespondence({ tenantId: tid, correspondenceId: inboundCorrespondenceId });
  const inboundNHCX = nhcxMetadataFromAttachments(inbound.attachments);
  const claimId = inbound.claim_id ? Number(inbound.claim_id) : null;
  const preauthId = inbound.preauth_id ? Number(inbound.preauth_id) : null;
  const docs = await validateCommunicationDocuments({
    tenantId: tid,
    claimId,
    preauthId,
    documentIds,
  });
  const apiCallId = safeText(hcxApiCallId, 120) || `communication-${crypto.randomUUID()}`;
  const correlationId = safeText(hcxCorrelationId, 120)
    || safeText(inboundNHCX.correlation_id, 120)
    || `corr-${crypto.randomUUID()}`;
  const workflowId = safeText(hcxWorkflowId, 120) || safeText(inboundNHCX.workflow_id, 120);
  const attachments = correspondenceAuditAttachment({
    kind: 'nhcx_communication_response',
    endpoint: 'communication/request',
    context: { hcxApiCallId: apiCallId, hcxCorrelationId: correlationId, hcxWorkflowId: workflowId },
    inbound: {
      apiCallId: inboundNHCX.api_call_id || null,
      correspondenceId: inbound.id,
    },
    documents: docs,
  });
  const subject = safeText(
    inbound.subject ? `NHCX query response: ${inbound.subject}` : 'NHCX query response',
    255,
  );

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claim_correspondence
       (tenant_id, claim_id, preauth_id, direction, channel, subject, body,
        attachments, recorded_by)
     VALUES ($1::uuid, $2::int, $3::int, 'outbound', 'nhcx', $4, $5,
             $6::jsonb, $7::uuid)
     RETURNING *`,
    tid,
    claimId,
    preauthId,
    subject,
    text,
    JSON.stringify(attachments),
    recordedBy ? String(recordedBy) : null,
  );

  return {
    correspondence: rows[0],
    documents: docs,
    claimId,
    preauthId,
    hcx: {
      apiCallId,
      correlationId,
      workflowId,
    },
  };
}

export async function loadCommunicationResponseContext({
  tenantId,
  hcxApiCallId,
} = {}) {
  const tid = requireTenantId(tenantId);
  const apiCallId = safeText(hcxApiCallId, 120);
  if (!apiCallId) throw AppError.badRequest('hcxApiCallId is required', 'NHCX_API_CALL_ID_REQUIRED');

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id::text AS tenant_id, claim_id, preauth_id,
            subject, body, attachments, recorded_at
       FROM tpa_claim_correspondence
      WHERE tenant_id = $1::uuid
        AND direction = 'outbound'
        AND channel = 'nhcx'
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements(COALESCE(attachments, '[]'::jsonb)) AS item
           WHERE item->'nhcx'->>'api_call_id' = $2
        )
      ORDER BY recorded_at DESC, id DESC
      LIMIT 1`,
    tid,
    apiCallId,
  );
  const correspondence = rows[0];
  if (!correspondence) {
    throw AppError.notFound('Outbound NHCX communication correspondence not found', 'NHCX_CORRESPONDENCE_NOT_FOUND');
  }

  const docs = await validateCommunicationDocuments({
    tenantId: tid,
    claimId: correspondence.claim_id ? Number(correspondence.claim_id) : null,
    preauthId: correspondence.preauth_id ? Number(correspondence.preauth_id) : null,
    documentIds: documentIdsFromAttachments(correspondence.attachments),
  });
  return {
    correspondence,
    documents: docs,
    claimId: correspondence.claim_id ? Number(correspondence.claim_id) : null,
    preauthId: correspondence.preauth_id ? Number(correspondence.preauth_id) : null,
    nhcx: nhcxMetadataFromAttachments(correspondence.attachments),
  };
}

export async function getCommunicationWorkbench({
  tenantId,
  claimId = null,
  preauthId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeClaimId = claimId ? positiveInt(claimId, 'claimId') : null;
  const safePreauthId = preauthId ? positiveInt(preauthId, 'preauthId') : null;
  if (!safeClaimId && !safePreauthId) {
    throw AppError.badRequest('claim_id or preauth_id is required', 'NHCX_COMMUNICATION_TARGET_REQUIRED');
  }
  if (safeClaimId && safePreauthId) {
    throw AppError.badRequest('Provide only one communication target', 'NHCX_COMMUNICATION_TARGET_AMBIGUOUS');
  }

  const targetRows = safeClaimId
    ? await prisma.$queryRawUnsafe(
      `SELECT id, claim_number, patient_uid::text AS patient_uid, status,
              policy_id, preauth_id, admission_id
         FROM tpa_claims
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        LIMIT 1`,
      tid,
      safeClaimId,
    )
    : await prisma.$queryRawUnsafe(
      `SELECT id, preauth_number, patient_uid::text AS patient_uid, status,
              policy_id, admission_id
         FROM insurance_preauth
        WHERE tenant_id = $1::uuid
          AND id = $2::int
        LIMIT 1`,
      tid,
      safePreauthId,
    );
  if (!targetRows[0]) throw AppError.notFound('NHCX communication target not found', 'NHCX_COMMUNICATION_TARGET_NOT_FOUND');

  const docs = await prisma.$queryRawUnsafe(
    `SELECT id, claim_id, preauth_id, doc_type, file_name, file_size_bytes,
            mime_type, uploaded_at, notes
       FROM tpa_claim_documents
      WHERE tenant_id = $1::uuid
        AND ${safeClaimId ? 'claim_id = $2::int' : 'preauth_id = $2::int'}
      ORDER BY uploaded_at DESC, id DESC`,
    tid,
    safeClaimId || safePreauthId,
  );
  const correspondence = await prisma.$queryRawUnsafe(
    `SELECT id, claim_id, preauth_id, direction, channel, subject, body,
            attachments, recorded_at, recorded_by
       FROM tpa_claim_correspondence
      WHERE tenant_id = $1::uuid
        AND ${safeClaimId ? 'claim_id = $2::int' : 'preauth_id = $2::int'}
      ORDER BY recorded_at DESC, id DESC`,
    tid,
    safeClaimId || safePreauthId,
  );
  return {
    targetType: safeClaimId ? 'claim' : 'preauth',
    target: targetRows[0],
    documents: docs,
    correspondence,
    attachmentPolicy: communicationAttachmentPolicy(),
  };
}

export default {
  communicationAttachmentPolicy,
  createOutboundCommunicationResponse,
  getCommunicationWorkbench,
  loadCommunicationResponseContext,
  recordInboundCommunicationRequest,
  validateCommunicationDocuments,
};
